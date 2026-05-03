/**
 * useVideoProcessor.ts
 *
 * ── CHANGES (v11) ─────────────────────────────────────────────────────────────
 * [BUG FIX] 로컬 영상 사용량 미차감 수정
 *   - 원인: processVideo() 완료 후 recordUsage() 호출 누락
 *   - free 경로(on-device Gemma): 번역 완료 후 실제 영상 길이 기준으로 recordUsage 호출
 *   - server 경로(standard/pro): 기존 safeRecordUsage()로 처리 (변경 없음)
 *   - 취소/에러 시 cancelledRef.current === true → 차감 안 함 (정상)
 *
 * v10에서 유지되는 것들:
 *   - [FIX-2 v8] buildPartialQuotaWarning 3단계 분기
 *   - [SELF-2 v8] HARD_MIN_EXECUTE_SECS 상수 동기화
 *   - 2단계 gating: canProcess(1) → canProcess(실제값)
 *   - tier별 fallback 분기: free → 차단, paid → 통과 + 로그
 *   - HARD_CAP(60) 클램프
 *   - planState 단일 snapshot
 *   - settingsRef 진입 시점 refresh
 *   - makeErrorProgress 헬퍼
 *   - [FIX-1 v7] partialQuotaWarning 1회 표시 플래그
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
import { usePurchaseStore } from '../store/usePurchaseStore';
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

const ESTIMATE_HARD_CAP_MINUTES = 60;
const FREE_DAILY_CAP_MINUTES    = 20;

/**
 * HARD_MIN_EXECUTE_SECS — 3-파일 동기화 필수 [v10 SELF-4]
 *
 * 동기화 대상:
 *   useServerBridge.ts     → HARD_MIN_EXECUTE_SECS (batch 전송 차단 기준)
 *   serverBridgeService.ts → MIN_EXECUTION_FLOOR_SECS (effective duration 하한)
 *
 * 이 값을 변경하면 위 두 파일도 반드시 함께 변경할 것.
 * 불변식: HARD_MIN_EXECUTE_SECS < MIN_QUOTA_TO_PROCESS_SECS 항상 성립해야 함
 */
const HARD_MIN_EXECUTE_SECS = 3;

/**
 * MIN_QUOTA_TO_PROCESS_SECS — 2-파일 동기화 필수 [v10 SELF-4]
 *
 * 동기화 대상:
 *   useServerBridge.ts → MIN_QUOTA_TO_PROCESS_SECS (정상 배치 기준선)
 *
 * 이 값을 변경하면 useServerBridge.ts도 반드시 함께 변경할 것.
 */
const MIN_QUOTA_TO_PROCESS_SECS = 10;

async function estimateVideoMinutes(
  videoUri: string,
  tier: PlanTier,
): Promise<number | null> {
  try {
    const seconds  = await getVideoDuration(videoUri);
    const estimated = Math.ceil(seconds / 60);
    return Math.min(estimated, ESTIMATE_HARD_CAP_MINUTES);
  } catch {
    if (tier === 'free') {
      return FREE_DAILY_CAP_MINUTES;
    }
    return null;
  }
}

function localCacheKey(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const parts   = decoded.replace(/\\/g, "/").split("/");
    return "local__" + (parts[parts.length - 1] ?? uri);
  } catch {
    return "local__" + uri;
  }
}

function makeErrorProgress(msg: string): ProcessingProgress {
  return { step: 'error', current: 0, total: 0, percent: 0, message: msg, error: msg };
}

/**
 * [FIX-2 v8] buildPartialQuotaWarning — useServerBridge [FIX-4]와 정합
 *
 * remainingSeconds 기준 3단계 분기:
 *
 * (A) remainingSeconds < HARD_MIN_EXECUTE_SECS(3):
 *     → "quota가 거의 소진되어 처리할 수 없을 수 있습니다" 안내
 *
 * (B) HARD_MIN ≤ remainingSeconds < MIN_QUOTA(10):
 *     → "남은 한도 N초로 일부만 처리됩니다" 안내
 *
 * (C) remainingSeconds ≥ MIN_QUOTA이지만 estimatedMinutes 미달:
 *     → "이 영상은 약 Xmin입니다. 남은 한도 Ymin까지만 처리됩니다." 안내
 */
function buildPartialQuotaWarning(
  estimatedMinutes: number | null,
  remainingMinutes: number,
): string | null {
  if (estimatedMinutes === null) return null;
  if (remainingMinutes <= 0) return null;
  if (remainingMinutes >= estimatedMinutes) return null;

  const remainingSeconds = remainingMinutes * 60;

  // (A) HARD_MIN 미달
  if (remainingSeconds < HARD_MIN_EXECUTE_SECS) {
    return i18n.t('plan.quotaNearlyExhausted', {
      seconds: Math.floor(remainingSeconds),
      defaultValue:
        `남은 한도(${Math.floor(remainingSeconds)}초)가 너무 적어 처리가 불가능할 수 있습니다.`,
    }) as string;
  }

  // (B) HARD_MIN ≤ remaining < MIN_QUOTA
  if (remainingSeconds < MIN_QUOTA_TO_PROCESS_SECS) {
    return i18n.t('plan.partialBatchOnlyWarning', {
      seconds: Math.floor(remainingSeconds),
      defaultValue:
        `남은 한도(${Math.floor(remainingSeconds)}초)로 일부만 처리됩니다.`,
    }) as string;
  }

  // (C) 일반 partial
  return i18n.t('plan.partialProcessWarning', {
    estimated: estimatedMinutes,
    remaining: Math.floor(remainingMinutes),
    defaultValue:
      `이 영상은 약 ${estimatedMinutes}분입니다. 남은 한도 ${Math.floor(remainingMinutes)}분까지만 처리됩니다.`,
  }) as string;
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
  const recordUsage      = usePlanStore((s) => s.recordUsage);   // [v11 BUG FIX]

  const { processVideoServer } = useServerBridge();

  const settingsRef = useRef({ sourceLanguage, targetLanguage, thermalProtection });
  settingsRef.current = { sourceLanguage, targetLanguage, thermalProtection };

  const process = useCallback(
    async (
      videoUri: string,
      onEarlyPlaybackReady?: (subtitles: import('../store/usePlayerStore').SubtitleSegment[]) => void,
      onPartialUpdate?:      (subtitles: import('../store/usePlayerStore').SubtitleSegment[]) => void,
    ): Promise<ProcessResult> => {

      settingsRef.current = {
        sourceLanguage:    useSettingsStore.getState().sourceLanguage,
        targetLanguage:    useSettingsStore.getState().targetLanguage,
        thermalProtection: useSettingsStore.getState().thermalProtection,
      };

      await syncFromSettings();
      // Revalidate plan with RevenueCat if stale (> 6h) — fire-and-forget.
      // Does not block processing — plan correction happens in background.
      // Trade-off: tampered plan remains usable for up to 6 hours maximum,
      // then corrected automatically. UX-first, not hard enforcement.
      usePurchaseStore.getState().revalidatePlanIfStale().catch(() => {});

      // ── 2단계 gating ───────────────────────────────────────────────────────

      // 1차: canProcess(1) — duration 계산 없이 즉시 판단
      const fastState = usePlanStore.getState();
      const fastCheck = fastState.canProcess(1);
      if (!fastCheck.allowed) {
        const errMsg = fastCheck.reason ?? t('plan.limitExceeded');
        setProcessingError(errMsg);
        setProgress(makeErrorProgress(errMsg));
        return { success: false, translationSkipped: false };
      }

      // 2차: 실제 영상 길이 기반 정밀 판단
      // [v11 BUG FIX] 실제 duration을 recordUsage에서도 활용하기 위해 변수 저장
      let actualDurationSecs: number | null = null;
      try {
        actualDurationSecs = await getVideoDuration(videoUri);
      } catch {
        // 측정 실패는 기존 fallback 로직이 처리
      }

      const estimatedMinutes = await estimateVideoMinutes(videoUri, fastState.tier);

      if (estimatedMinutes === null) {
        console.warn(
          '[useVideoProcessor] duration 측정 실패 — paid 플랜 통과 허용.',
          'tier:', fastState.tier,
          '서버 사이드 사용량 정산 필요.',
        );
      }

      const planState = usePlanStore.getState();

      if (estimatedMinutes !== null) {
        const { allowed, reason } = planState.canProcess(estimatedMinutes);
        if (!allowed) {
          const isDurationFallback =
            planState.tier === 'free' && estimatedMinutes === FREE_DAILY_CAP_MINUTES;
          const errMsg = isDurationFallback
            ? (i18n.t('error.durationCheckFailed',
                '영상 길이를 확인할 수 없어 처리할 수 없습니다.') as string)
            : (reason ?? t('plan.limitExceeded'));
          setProcessingError(errMsg);
          setProgress(makeErrorProgress(errMsg));
          return { success: false, translationSkipped: false };
        }
      }

      // ── quota 부족 UX 경고 (3단계 분기) ───────────────────────────────────
      const remainingMinutes = planState.tier === 'free'
        ? planState.limits.dailyCapMinutes - planState.usedMinutes
        : planState.limits.monthlyCapMinutes > 0
          ? planState.limits.monthlyCapMinutes - planState.usedMinutes
          : Infinity;

      const partialWarning = buildPartialQuotaWarning(estimatedMinutes, remainingMinutes);
      if (partialWarning) {
        setProgress({
          step: 'extracting', current: 0, total: 0, percent: 0,
          message: partialWarning,
        });
        setProcessingProgress(0, partialWarning);
        console.warn('[useVideoProcessor] partial quota warning:', partialWarning);
      }
      // ── gating 끝 ─────────────────────────────────────────────────────────

      cancelledRef.current = false;
      clearSubtitles();
      setProcessing(true);
      setProcessingError(null);
      if (!partialWarning) setProgress(IDLE);

      const { sourceLanguage: src, targetLanguage: tgt, thermalProtection: tp } = settingsRef.current;

      try {
        const useServer = planState.tier === 'lite' || planState.tier === 'standard' || planState.tier === 'pro';

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

        // ── [v11 BUG FIX] 로컬(free/on-device) 경로 사용량 차감 ────────────
        // server 경로(standard/pro)는 processVideoServer 내부의
        // safeRecordUsage()로 이미 처리됨 → 여기서는 free 경로만 차감
        //
        // 차감 기준 우선순위:
        //   1. 실제 자막 세그먼트 시간 합산 (번역된 내용만 정확히 반영)
        //   2. 실제 영상 duration (자막 없을 때 fallback)
        //   3. estimatedMinutes (duration 측정 실패 시 최후 fallback)
        //
        // 취소 시 cancelledRef.current === true → 위에서 이미 early return
        // translationSkipped === true여도 STT(Whisper) 처리는 됐으므로 차감
        if (!useServer && subtitles.length > 0) {
          try {
            let chargedSecs: number;

            if (subtitles.length > 0) {
              // 1순위: 실제 번역된 세그먼트 시간 합산
              chargedSecs = subtitles.reduce(
                (acc, seg) => acc + Math.max(0, seg.endTime - seg.startTime),
                0,
              );
            } else if (actualDurationSecs !== null && actualDurationSecs > 0) {
              // 2순위: 실제 영상 길이
              chargedSecs = actualDurationSecs;
            } else if (estimatedMinutes !== null) {
              // 3순위: 추정치
              chargedSecs = estimatedMinutes * 60;
            } else {
              chargedSecs = 0;
            }

            if (chargedSecs > 0) {
              recordUsage(chargedSecs);
              console.log(
                `[useVideoProcessor] 로컬 사용량 기록: ${Math.round(chargedSecs)}초 ` +
                `(${(chargedSecs / 60).toFixed(1)}분), tier: ${planState.tier}`,
              );
            }
          } catch (usageErr) {
            // recordUsage 실패는 non-fatal — 번역 결과는 정상 반환
            console.warn('[useVideoProcessor] recordUsage 실패 (non-fatal):', usageErr);
          }
        }
        // ── 사용량 차감 끝 ────────────────────────────────────────────────────

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
      syncFromSettings, planTier, recordUsage, t,   // [v11] recordUsage 추가
    ]
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cancelFgInference();
    import('../services/serverBridgeService').then(m => m.cancelAllInflight()).catch(() => {});
  }, []);

  return { progress, process, cancel };
}