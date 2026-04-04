import { useCallback, useRef, useState } from "react";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { getCachedSubtitles, saveSubtitleCache } from "../services/subtitleCache";
import {
  loadModel as loadGemma,
  unloadModel as unloadGemma,
  translateSegments,
} from "../services/gemmaTranslationService";
import { getLanguageByCode } from "../constants/languages";

export function useRetranslate() {
  const [isRetranslating, setIsRetranslating] = useState(false);
  const cancelledRef = useRef(false);

  const subtitles  = usePlayerStore((s) => s.subtitles);
  const videoUri   = usePlayerStore((s) => s.videoUri);
  const setSubtitles = usePlayerStore((s) => s.setSubtitles);

  const sourceLanguage = useSettingsStore((s) => s.sourceLanguage);

  const retranslate = useCallback(
    async (newTargetLang: string) => {
      if (!videoUri || subtitles.length === 0) return;

      cancelledRef.current = false;
      setIsRetranslating(true);

      try {
        // ── 1. 캐시 확인: 이미 번역된 언어면 즉시 로드 ──────────────────
        const cached = await getCachedSubtitles(videoUri, newTargetLang);
        if (cached && cached.length > 0) {
          console.log(`[useRetranslate] Cache hit for ${newTargetLang}`);
          setSubtitles(cached);
          return;
        }

        if (cancelledRef.current) return;

        // ── 2. 캐시 없음: Gemma로 재번역 ────────────────────────────────
        console.log(`[useRetranslate] No cache for ${newTargetLang}, starting translation`);

        // 언어 코드(ko) → 언어명(Korean) 변환
        const langMeta = getLanguageByCode(newTargetLang);
        const langName = langMeta?.name ?? newTargetLang;

        // 현재 자막의 원문(original)을 번역 입력으로 사용
        const segments = subtitles.map((s) => ({
          start: s.startTime,
          end: s.endTime,
          text: s.original,
          translated: "",
        }));

        await loadGemma();

        if (cancelledRef.current) {
          await unloadGemma();
          return;
        }

        let translated;
        try {
          translated = await translateSegments(
            segments,
            (completed, total) => {
              console.log(`[useRetranslate] ${completed}/${total}`);
            },
            videoUri,
            langName
          );
        } finally {
          await unloadGemma();
        }

        if (cancelledRef.current) return;

        // ── 3. 자막 업데이트 + 캐시 저장 ─────────────────────────────────
        const updated = subtitles.map((s, i) => ({
          ...s,
          translated: translated[i]?.translated ?? s.original,
        }));

        setSubtitles(updated);

        const src = sourceLanguage === "auto" ? "en" : sourceLanguage;
        saveSubtitleCache(videoUri, newTargetLang, updated, src);
      } catch (e) {
        console.error("[useRetranslate] Error:", e);
      } finally {
        setIsRetranslating(false);
      }
    },
    [videoUri, subtitles, setSubtitles, sourceLanguage]
  );

  const cancelRetranslation = useCallback(() => {
    cancelledRef.current = true;
    setIsRetranslating(false);
  }, []);

  return { isRetranslating, retranslate, cancelRetranslation };
}