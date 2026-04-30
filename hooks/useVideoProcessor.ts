/**
 * useVideoProcessor.ts
 *
 * ── CHANGES (v5) ─────────────────────────────────────────────────────────────
 * [FIX-1] tier별 fallback 분기 — free / paid 정책 분리
 *         기존 v4: fallback=Infinity → duration 실패 시 tier 무관 차단 (UX 파괴)
 *         변경:
 *           free  → dailyCapMinutes 전량 소비로 간주 → 차단 (비용 보호 우선)
 *           paid  → 통과 허용 + risk 로그 (UX 보호 우선, 서버 사이드 guard 전제)
 *         근거: paid 유저는 서버에서 실제 사용량 기반 정산이 이루어짐
 *               클라이언트 gating에서 막는 것보다 서버 pre-auth가 본질적 해결책
 *               현재 serverBridgeService 범위 밖이므로 클라이언트에서는 최대한 통과
 *
 * [FIX-2] duration 실패 시 에러 메시지 구분
 *         기존: plan.limitExceeded 메시지로 혼용
 *         변경: free 차단 시 'error.durationCheckFailed' 키 사용
 *               (i18n 키가 없으면 fallback 메시지 사용)
 *
 * [SELF-1] estimateVideoMinutes: tier 파라미터 추가로 분기 명확화
 *
 * v4에서 유지되는 것들:
 *   - 2단계 gating: canProcess(1) → canProcess(실제값)
 *   - HARD_CAP(60) 클램프
 *   - planState 단일 snapshot (stale closure 차단)
 *   - settingsRef 진입 시점 refresh
 *   - makeErrorProgress 헬퍼
 */

import { useState, useRef, useCallback } from "react";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { processVideo, ProcessingProgress } from "../services/videoProcessor";
import { saveSubtitleCache } from "../services/subtitleCache";
import { saveSubtitles } from "../services/subtitleDB";
import { cancelFgInference } from "../services/gemmaTranslationService";
import { pendingSubtitleRef } from "../utils/pendingSubtitle";
import { usePlanStore, PlanTier } from '../store/usePlanStore';
import { useServerBridge } from './useServerBridge';
import { useTranslation } from 'react-i18next';
import { getVideoDuration } from '../services/audioChunker';
import i18n from '../i18n';

export type ProcessResult = { success: boolean; translationSkipped: boolean };
export type { ProcessingProgress };

const IDLE: ProcessingProgress = {
  step: "extracting",
  current: 0,
  total: 0,
  percent: 0,
  message: "",
};

// 정상 estimate 상한 — 정확한 duration에서도 60분 초과 추정은 클램프
const ESTIMATE_HARD_CAP_MINUTES = 60;

// free 플랜 daily cap — duration 실패 시 fallback 기준값
// PLAN_LIMITS와 동기화 필요: free.dailyCapMinutes = 20
const FREE_DAILY_CAP_MINUTES = 20;

/**
 * [FIX-1] tier별 fallback 분기
 *
 * free:
 *   duration 실패 → FREE_DAILY_CAP_MINUTES(20) 전량 소비로 간주
 *   → canProcess(20) → 남은 한도가 없으면 차단
 *   근거: 비용 없음(로컬 처리)이지만 UX 정책상 일일 한도 내 제어 유지
 *
 * paid (standard/pro):
 *   duration 실패 → null 반환 → 호출 측에서 통과 처리 + risk 로그
 *   근거: GPU 비용은 서버 사이드 정산이 authoritative
 *         클라이언트에서 막으면 정상 유저 UX 손실
 *         → 서버 pre-auth 구조가 완성될 때까지 클라이언트는 통과 우선
 */
async function estimateVideoMinutes(
  videoUri: string,
  tier: PlanTier,
): Promise<number | null> {
  try {
    const seconds = await getVideoDuration(videoUri);
    const estimated = Math.ceil(seconds / 60);
    return Math.min(estimated, ESTIMATE_HARD_CAP_MINUTES);
  } catch {
    if (tier === 'free') {
      // free: cap 전량 소비로 간주 → 남은 한도 없으면 차단
      return FREE_DAILY_CAP_MINUTES;
    }
    // paid: null → 호출 측에서 통과 + 리스크 로그
    return null;
  }
}

function localCacheKey(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const parts = decoded.replace(/\\/g, "/").split("/");
    return "local__" + (parts[parts.length - 1] ?? uri);
  } catch {
    return "local__" + uri;
  }
}

function makeErrorProgress(msg: string): ProcessingProgress {
  return { step: 'error', current: 0, total: 0, percent: 0, message: msg, error: msg };
}

export function useVideoProcessor() {
  const [progress, setProgress] = useState<ProcessingProgress>(IDLE);
  const cancelledRef = useRef(false);

  const setSubtitles          = usePlayerStore((s) => s.setSubtitles);
  const clearSubtitles        = usePlayerStore((s) => s.clearSubtitles);
  const setProcessing         = usePlayerStore((s) => s.setProcessing);
  const setProcessingError    = usePlayerStore((s) => s.setProcessingError);
  const setProcessingProgress = usePlayerStore((s) => s.setProcessingProgress);

  const sourceLanguage    = useSettingsStore((s) => s.sourceLanguage);
  const targetLanguage    = useSettingsStore((s) => s.targetLanguage);
  const thermalProtection = useSettingsStore((s) => s.thermalProtection);

  const { t } = useTranslation();

  const syncFromSettings = usePlanStore((s) => s.syncFromSettings);
  const planTier         = usePlanStore((s) => s.tier);

  const { processVideoServer } = useServerBridge();

  const settingsRef = useRef({ sourceLanguage, targetLanguage, thermalProtection });
  settingsRef.current = { sourceLanguage, targetLanguage, thermalProtection };

  const process = useCallback(
    async (
      videoUri: string,
      onEarlyPlaybackReady?: (subtitles: import('../store/usePlayerStore').SubtitleSegment[]) => void,
      onPartialUpdate?:      (subtitles: import('../store/usePlayerStore').SubtitleSegment[]) => void,
    ): Promise<ProcessResult> => {

      // 진입 시점 settingsRef refresh
      settingsRef.current = {
        sourceLanguage:    useSettingsStore.getState().sourceLanguage,
        targetLanguage:    useSettingsStore.getState().targetLanguage,
        thermalProtection: useSettingsStore.getState().thermalProtection,
      };

      await syncFromSettings();

      // ── 2단계 gating ───────────────────────────────────────────────────────
      //
      // 1차: canProcess(1) — 즉시 판단
      //   "어떤 영상이든 최소 1분 소비" 기준
      //   남은 한도 0인 유저 → duration 계산 없이 즉시 차단
      const fastState = usePlanStore.getState();
      const fastCheck = fastState.canProcess(1);
      if (!fastCheck.allowed) {
        const errMsg = fastCheck.reason ?? t('plan.limitExceeded');
        setProcessingError(errMsg);
        setProgress(makeErrorProgress(errMsg));
        return { success: false, translationSkipped: false };
      }

      // 2차: 실제 영상 길이 기반 정밀 판단
      // [FIX-1] tier 전달 → free/paid 분기 적용
      const estimatedMinutes = await estimateVideoMinutes(videoUri, fastState.tier);

      // [FIX-1] paid + duration 실패(null): 통과 허용 + risk 로그
      // 서버 사이드 guard가 최종 안전망 역할 담당
      if (estimatedMinutes === null) {
        console.warn(
          '[useVideoProcessor] duration 측정 실패 — paid 플랜 통과 허용.',
          'tier:', fastState.tier,
          '서버 사이드 사용량 정산 필요.',
        );
        // null인 경우 gating 스킵 — 아래 planState snapshot으로 진행
      }

      // syncFromSettings 이후 단일 snapshot — canProcess + tier 동일 기준
      const planState = usePlanStore.getState();

      if (estimatedMinutes !== null) {
        const { allowed, reason } = planState.canProcess(estimatedMinutes);
        if (!allowed) {
          // [FIX-2] free + duration 실패로 cap 전량 소비 간주된 경우 구분 메시지
          const isDurationFallback =
            planState.tier === 'free' && estimatedMinutes === FREE_DAILY_CAP_MINUTES;
          const errMsg = isDurationFallback
            ? (i18n.t('error.durationCheckFailed', '영상 길이를 확인할 수 없어 처리할 수 없습니다.') as string)
            : (reason ?? t('plan.limitExceeded'));
          setProcessingError(errMsg);
          setProgress(makeErrorProgress(errMsg));
          return { success: false, translationSkipped: false };
        }
      }
      // ── gating 끝 ─────────────────────────────────────────────────────────

      cancelledRef.current = false;
      clearSubtitles();
      setProcessing(true);
      setProcessingError(null);
      setProgress(IDLE);

      const { sourceLanguage: src, targetLanguage: tgt, thermalProtection: tp } = settingsRef.current;

      try {
        const useServer = planState.tier === 'standard' || planState.tier === 'pro';

        const { subtitles, translationSkipped } = useServer
          ? await processVideoServer(
              videoUri, src, tgt,
              (p) => { setProgress(p); setProcessingProgress(p.percent, p.message); },
              () => cancelledRef.current,
              onEarlyPlaybackReady,
              onPartialUpdate,
            )
          : await processVideo(
              videoUri, src, tgt,
              (p) => { setProgress(p); setProcessingProgress(p.percent, p.message); },
              () => cancelledRef.current,
              tp,
              onEarlyPlaybackReady,
              onPartialUpdate,
            );

        if (cancelledRef.current) return { success: false, translationSkipped: false };

        if (!pendingSubtitleRef.current) {
          setSubtitles(subtitles);

          const cacheKey = localCacheKey(videoUri);
          const srcLang  = src === "auto" ? "en" : src;

          saveSubtitleCache(videoUri, tgt, subtitles, srcLang);

          if (subtitles.length > 0) {
            saveSubtitles(cacheKey, tgt, "local", subtitles).catch((e) =>
              console.warn("[useVideoProcessor] SQLite 저장 실패 (non-fatal):", e)
            );
          }
        }

        return { success: true, translationSkipped };
      } catch (e) {
        if (cancelledRef.current) return { success: false, translationSkipped: false };
        const msg = String(e);
        setProcessingError(msg);
        setProgress(makeErrorProgress(msg));
        return { success: false, translationSkipped: false };
      } finally {
        setProcessing(false);
      }
    },
    [
      clearSubtitles, setSubtitles, setProcessing,
      setProcessingError, setProcessingProgress,
      syncFromSettings, planTier, t,
    ]
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cancelFgInference();
    import('../services/serverBridgeService').then(m => m.cancelAllInflight()).catch(() => {});
  }, []);

  return { progress, process, cancel };
}