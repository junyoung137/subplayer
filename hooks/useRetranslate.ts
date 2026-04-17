/**
 * useRetranslate (v2) — diff update + 초반 빠른 UI
 *
 * 변경사항 (v1 → v2):
 * [PERF-1] diff update: updated 전체 배열 재생성 제거
 *          → patchSubtitles로 변경된 항목만 Store에 반영
 * [UX-1]   초반 빠른 UI: completed <= 3 구간은 throttle 없이 즉시 반영
 */

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
  const cancelledRef  = useRef(false);
  const completedRef  = useRef(0); // [UX-1] 초반 빠른 UI 추적용

  const subtitles     = usePlayerStore((s) => s.subtitles);
  const videoUri      = usePlayerStore((s) => s.videoUri);
  const setSubtitles  = usePlayerStore((s) => s.setSubtitles);
  const patchSubtitles = usePlayerStore((s) => s.patchSubtitles); // [PERF-1]

  const sourceLanguage = useSettingsStore((s) => s.sourceLanguage);

  const retranslate = useCallback(
    async (newTargetLang: string) => {
      if (!videoUri || subtitles.length === 0) return;

      cancelledRef.current  = false;
      completedRef.current  = 0;
      setIsRetranslating(true);

      try {
        // ── 1. 캐시 확인: 이미 번역된 언어면 즉시 로드 ──────────────────
        const cached = await getCachedSubtitles(videoUri, newTargetLang);
        if (cached && cached.length > 0) {
          console.log(`[useRetranslate v2] Cache hit for ${newTargetLang}`);
          setSubtitles(cached);
          return;
        }

        if (cancelledRef.current) return;

        // ── 2. 캐시 없음: Gemma로 재번역 ────────────────────────────────
        console.log(`[useRetranslate v2] No cache for ${newTargetLang}, starting translation`);

        const langMeta = getLanguageByCode(newTargetLang);
        const langName = langMeta?.name ?? newTargetLang;

        const segments = subtitles.map((s) => ({
          start:      s.startTime,
          end:        s.endTime,
          text:       s.original,
          translated: "",
        }));

        await loadGemma();

        if (cancelledRef.current) {
          await unloadGemma();
          return;
        }

        // [PERF-1] id 조회용 캐시
        const idByIndex = subtitles.map((s) => s.id);
        const total     = subtitles.length;

        let translated;
        let _inferCancelled = false;
        try {
          translated = await translateSegments(
            segments,
            (completed, _total) => {
              completedRef.current = completed;

              // [UX-1] 초반 빠른 UI: completed <= 3은 즉시 반영
              // [UX-1] 이후는 % 3 throttle + 마지막은 항상
              const isEarly    = completed <= 3;
              const isThrottle = completed % 3 === 0;
              const isLast     = completed === total;

              if (isEarly || isThrottle || isLast) {
                console.log(`[useRetranslate v2] ${completed}/${total}`);
              }
            },
            videoUri,
            langName
          );
        } catch (e: any) {
          // Track cancellation so the finally below does NOT unload the model —
          // a queued BG job may still need it.  Re-throw so the outer catch handles it.
          _inferCancelled = e?.message === 'INFERENCE_CANCELLED';
          throw e;
        } finally {
          if (!_inferCancelled) await unloadGemma();
        }

        if (cancelledRef.current) return;

        // ── 3. [PERF-1] diff patch: 변경된 항목만 Store에 반영 ──────────
        //    전체 배열 재생성(map) 없이 id 기준으로 patch
        const patches = subtitles.map((s, i) => ({
          id:         idByIndex[i],
          translated: translated[i]?.translated ?? s.original,
        }));

        patchSubtitles(patches);

        // ── 4. 캐시 저장 (patch 후 최신 subtitles 기준) ──────────────────
        //    patchSubtitles는 동기 상태 업데이트이므로
        //    저장용 배열은 직접 조합
        const updatedForCache = subtitles.map((s, i) => ({
          ...s,
          translated: translated[i]?.translated ?? s.original,
        }));

        const src = sourceLanguage === "auto" ? "en" : sourceLanguage;
        saveSubtitleCache(videoUri, newTargetLang, updatedForCache, src);

      } catch (e: any) {
        if (e?.message === 'INFERENCE_CANCELLED') return; // clean exit — not an error
        console.error("[useRetranslate v2] Error:", e);
      } finally {
        setIsRetranslating(false);
      }
    },
    [videoUri, subtitles, setSubtitles, patchSubtitles, sourceLanguage]
  );

  const cancelRetranslation = useCallback(() => {
    cancelledRef.current = true;
    setIsRetranslating(false);
  }, []);

  return { isRetranslating, retranslate, cancelRetranslation };
}