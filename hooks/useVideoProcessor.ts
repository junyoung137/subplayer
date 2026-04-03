import { useState, useRef, useCallback } from "react";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { processVideo, ProcessingProgress } from "../services/videoProcessor";
import { saveSubtitleCache } from "../services/subtitleCache";

export type ProcessResult = { success: boolean; translationSkipped: boolean };

export type { ProcessingProgress };

const IDLE: ProcessingProgress = {
  step: "extracting",
  current: 0,
  total: 0,
  percent: 0,
  message: "",
};

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
  const settingsRef = useRef({ sourceLanguage, targetLanguage });
  settingsRef.current = { sourceLanguage, targetLanguage };

  const process = useCallback(
    async (videoUri: string): Promise<ProcessResult> => {
      cancelledRef.current = false;
      clearSubtitles();
      setProcessing(true);
      setProcessingError(null);
      setProgress(IDLE);

      const { sourceLanguage: src, targetLanguage: tgt } = settingsRef.current;

      try {
        const { subtitles, translationSkipped } = await processVideo(
          videoUri,
          src,
          tgt,
          (p) => {
            setProgress(p);
            setProcessingProgress(p.percent, p.message);
          },
          () => cancelledRef.current
        );

        if (cancelledRef.current) return { success: false, translationSkipped: false };

        setSubtitles(subtitles);
        // Persist to cache in the background — non-blocking, best-effort.
        saveSubtitleCache(videoUri, tgt, subtitles, src === "auto" ? "en" : src);
        return { success: true, translationSkipped };
      } catch (e) {
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
  }, []);

  return { progress, process, cancel };
}
