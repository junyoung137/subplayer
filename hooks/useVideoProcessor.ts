import { useState, useRef, useCallback } from "react";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { processVideo, ProcessingProgress } from "../services/videoProcessor";
import { saveSubtitleCache } from "../services/subtitleCache";
import { saveSubtitles } from "../services/subtitleDB";
import { cancelFgInference } from "../services/gemmaTranslationService";
import { pendingSubtitleRef } from "../utils/pendingSubtitle";
import { usePlanStore } from '../store/usePlanStore';
import { useServerBridge } from './useServerBridge';
import { useTranslation } from 'react-i18next';

export type ProcessResult = { success: boolean; translationSkipped: boolean };
export type { ProcessingProgress };

const IDLE: ProcessingProgress = { 
  step: "extracting", 
  current: 0, 
  total: 0, 
  percent: 0, 
  message: "", 
};

// ── cacheKey 생성 헬퍼 (PlayerScreen의 localCacheKey와 동일한 로직) ──────────
function localCacheKey(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const parts = decoded.replace(/\\/g, "/").split("/");
    return "local__" + (parts[parts.length - 1] ?? uri);
  } catch {
    return "local__" + uri;
  }
}

export function useVideoProcessor() {
  const [progress, setProgress] = useState<ProcessingProgress>(IDLE);
  const cancelledRef = useRef(false);

  const setSubtitles = usePlayerStore((s) => s.setSubtitles);
  const clearSubtitles = usePlayerStore((s) => s.clearSubtitles);
  const setProcessing = usePlayerStore((s) => s.setProcessing);
  const setProcessingError = usePlayerStore((s) => s.setProcessingError);
  const setProcessingProgress = usePlayerStore((s) => s.setProcessingProgress);

  const sourceLanguage = useSettingsStore((s) => s.sourceLanguage);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const thermalProtection = useSettingsStore((s) => s.thermalProtection);

  const { t } = useTranslation();

  // Plan 관련
  const syncFromSettings = usePlanStore((s) => s.syncFromSettings); // ← 버그1 수정
  const planTier = usePlanStore((s) => s.tier);
  const canProcess = usePlanStore((s) => s.canProcess);

  const { processVideoServer } = useServerBridge();

  const settingsRef = useRef({ sourceLanguage, targetLanguage, thermalProtection });
  settingsRef.current = { sourceLanguage, targetLanguage, thermalProtection };

  const process = useCallback(
    async (
      videoUri: string,
      onEarlyPlaybackReady?: (subtitles: import('../store/usePlayerStore').SubtitleSegment[]) => void,
      onPartialUpdate?: (subtitles: import('../store/usePlayerStore').SubtitleSegment[]) => void,
    ): Promise<ProcessResult> => {

      // ── [BUG FIX 1] 항상 최신 설정값을 AsyncStorage에서 동기화 ──
      syncFromSettings();

      // ── Plan gate ──────────────────────────────────────────────────────────
      const { allowed, reason } = canProcess(Math.ceil(30));
      if (!allowed) {
        const errMsg = reason ?? t('plan.limitExceeded');
        setProcessingError(errMsg);
        setProgress({ step: 'error', current: 0, total: 0, percent: 0, message: errMsg, error: errMsg });
        return { success: false, translationSkipped: false };
      }

      cancelledRef.current = false;
      clearSubtitles();
      setProcessing(true);
      setProcessingError(null);
      setProgress(IDLE);

      const { sourceLanguage: src, targetLanguage: tgt, thermalProtection: tp } = settingsRef.current;

      try {
        // ── Plan routing: Standard/Pro → GPU server, Free → on-device ──
        const useServer = planTier === 'standard' || planTier === 'pro';

        const { subtitles, translationSkipped } = useServer 
          ? await processVideoServer(
              videoUri,
              src,
              tgt,
              (p) => {
                setProgress(p);
                setProcessingProgress(p.percent, p.message);
              },
              () => cancelledRef.current,
              onEarlyPlaybackReady,
              onPartialUpdate,
            )
          : await processVideo(
              videoUri,
              src,
              tgt,
              (p) => {
                setProgress(p);
                setProcessingProgress(p.percent, p.message);
              },
              () => cancelledRef.current,
              tp,                    // thermalProtection
              onEarlyPlaybackReady,
              onPartialUpdate,
            );

        if (cancelledRef.current) return { success: false, translationSkipped: false };

        // If an SRT file is pending, skip storing Whisper subtitles — SRT takes priority
        if (!pendingSubtitleRef.current) {
          setSubtitles(subtitles);

          const cacheKey = localCacheKey(videoUri);
          const srcLang = src === "auto" ? "en" : src;

          // AsyncStorage 캐시
          saveSubtitleCache(videoUri, tgt, subtitles, srcLang);

          // SQLite 캐시 (번역 완료 자막만 저장)
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
        setProgress({ step: "error", current: 0, total: 0, percent: 0, message: msg, error: msg });
        return { success: false, translationSkipped: false };
      } finally {
        setProcessing(false);
      }
    },
    // ── [BUG FIX 2] 누락된 의존성 추가 ──
    [
      clearSubtitles,
      setSubtitles,
      setProcessing,
      setProcessingError,
      setProcessingProgress,
      syncFromSettings,   // ← 추가
      canProcess,         // ← 추가
      planTier,           // ← 추가
      t,                  // ← 추가
    ]
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    // Free plan: cancel Gemma inference immediately
    cancelFgInference();
    // Standard/Pro plan: cancel in-flight HTTP
    import('../services/serverBridgeService').then(m => m.cancelAllInflight()).catch(() => {});
  }, []);

  return { progress, process, cancel };
}