import { useState, useRef, useCallback } from "react";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { processVideo, ProcessingProgress } from "../services/videoProcessor";
import { saveSubtitleCache } from "../services/subtitleCache";
import { saveSubtitles } from "../services/subtitleDB";
import { cancelFgInference } from "../services/gemmaTranslationService";
import { pendingSubtitleRef } from "../utils/pendingSubtitle";

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
// PlayerScreen은 이 함수를 인라인으로 가지고 있으므로 여기서 독립 구현
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

  const setSubtitles       = usePlayerStore((s) => s.setSubtitles);
  const clearSubtitles     = usePlayerStore((s) => s.clearSubtitles);
  const setProcessing      = usePlayerStore((s) => s.setProcessing);
  const setProcessingError = usePlayerStore((s) => s.setProcessingError);
  const setProcessingProgress = usePlayerStore((s) => s.setProcessingProgress);

  const sourceLanguage     = useSettingsStore((s) => s.sourceLanguage);
  const targetLanguage     = useSettingsStore((s) => s.targetLanguage);
  // [FIX 5] thermalProtection 설정값을 processVideo에 전달하기 위해 구독
  const thermalProtection  = useSettingsStore((s) => s.thermalProtection);

  const settingsRef = useRef({ sourceLanguage, targetLanguage, thermalProtection });
  settingsRef.current = { sourceLanguage, targetLanguage, thermalProtection };

  const process = useCallback(
    async (
      videoUri: string,
      onEarlyPlaybackReady?: (
        subtitles: import('../store/usePlayerStore').SubtitleSegment[]
      ) => void,
      onPartialUpdate?: (
        subtitles: import('../store/usePlayerStore').SubtitleSegment[]
      ) => void,
    ): Promise<ProcessResult> => {
      cancelledRef.current = false;
      clearSubtitles();
      setProcessing(true);
      setProcessingError(null);
      setProgress(IDLE);

      const { sourceLanguage: src, targetLanguage: tgt, thermalProtection: tp } = settingsRef.current;

      try {
        const { subtitles, translationSkipped } = await processVideo(
          videoUri,
          src,
          tgt,
          (p) => {
            setProgress(p);
            setProcessingProgress(p.percent, p.message);
          },
          () => cancelledRef.current,
          // [FIX 5] thermalProtection 설정값 전달
          tp,
          onEarlyPlaybackReady,
          onPartialUpdate,
        );

        if (cancelledRef.current) return { success: false, translationSkipped: false };

        // If an SRT file is pending, skip storing Whisper subtitles — SRT takes priority
        if (!pendingSubtitleRef.current) {
          setSubtitles(subtitles);

          // [FIX 2] 캐시 이중화 해소:
          //   - AsyncStorage (subtitleCache): ProcessingScreen의 캐시 확인용
          //   - SQLite (subtitleDB): PlayerScreen의 캐시 확인용
          // 둘 다 저장해서 앱 재시작 후 어느 경로로 진입해도 캐시 히트 보장
          const cacheKey = localCacheKey(videoUri);
          const srcLang = src === "auto" ? "en" : src;

          // AsyncStorage — ProcessingScreen이 getCachedSubtitles()로 확인
          saveSubtitleCache(videoUri, tgt, subtitles, srcLang);

          // SQLite — PlayerScreen이 loadSubtitles()로 확인
          // 번역 완료 자막만 저장 (translationSkipped여도 원문 자막은 저장)
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
    [clearSubtitles, setSubtitles, setProcessing, setProcessingError, setProcessingProgress]
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    // [FIX 6] 현재 실행 중인 Gemma inference를 즉시 중단 요청
    // 기존: cancelledRef=true만 설정 → 배치 하나가 끝나야 취소 반영
    // 수정: cancelFgInference()로 enqueueInference 큐에 취소 신호 전달
    //       → completion() 사이에서 isCancelled() 체크 시 즉시 종료
    // URL파이프의 BG 작업은 _bgJobProtected=true이므로 영향 없음
    cancelFgInference();
  }, []);

  return { progress, process, cancel };
}