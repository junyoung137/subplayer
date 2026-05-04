/**
 * useYoutubeSubtitles (v4) — overlap chunk pipeline
 *
 * v3 → v4 변경사항:
 *
 * [PIPELINE-1] timedtext 전용 사전 병합 추가
 *   - mergeSegmentsForYoutube(): YouTube fragment를 의미 단위로 병합
 *   - 3단어 이하 fragment 강제 병합, 5초/100자 상한, pause 기반 분리
 *
 * [PIPELINE-2] 분리 호출 구조 → 단일 overlap chunk 파이프라인으로 교체
 *   - 기존: translateWithContext()가 8개 단위로 독립 호출 반복
 *     → SBD가 청크 경계에서 리셋, 문장 단절 발생
 *   - 변경: createOverlappedChunks(core=8, overlap=2) + stitchChunkResults()
 *     → 청크 경계에 앞뒤 2개 컨텍스트 제공, 경계 단절 완전 제거
 *
 * [PIPELINE-3] 초기/나머지 분리 구조 제거 (옵션 2 채택)
 *   - 기존: translateWithContext(0→firstBatch) + translateWithContext(firstBatch→end)
 *     → 두 구간 경계에서 또 단절 발생, 프리페치 루프와 충돌
 *   - 변경: translateAllSegments()로 전체를 단일 overlap chunk 파이프라인 처리
 *     → UI 스트리밍은 onProgress 콜백으로만
 *
 * 유지된 구조 (변경 없음):
 * - diff patch (PERF-1), 초반 빠른 UI (UX-1)
 * - jobIdRef 패턴 (race condition 방어)
 * - videoHash(videoId) 기반 고유명사 캐싱 (translateSegments 내부)
 * - gemmaLoadedRef, cancelledRef
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  fetchYoutubeSubtitles,
  TimedTextSegment,
} from "../services/youtubeTimedText";
import {
  loadModel as loadGemma,
  unloadModel as unloadGemma,
  translateSegments,
} from "../services/gemmaTranslationService";
import { getLocalModelPath } from "../services/modelDownloadService";
import { getLanguageByCode } from "../constants/languages";
import { SubtitleSegment } from "../store/usePlayerStore";
import {
  mergeSegmentsForYoutube,
  createOverlappedChunks,
  stitchChunkResults,
  toTranslationInput,
  buildTranslationMap,
  MergedTimedSegment,
  OverlappedChunk,
  OVERLAP_SIZE,
  CHUNK_CORE_SIZE,
} from "../services/youtubeSegmentPipeline";

// ── 상수 ─────────────────────────────────────────────────────────────────────

/** [PIPELINE-2] overlap chunk 방식으로 교체되어 PREFETCH_WINDOW, 프리페치 루프 제거 */

// ── 타입 ─────────────────────────────────────────────────────────────────────

export type YoutubeSubtitlePhase =
  | "idle"
  | "fetching"
  | "translating"
  | "done"
  | "error"
  | "no_subtitles"
  | "fallback_whisper";

export interface YoutubeSubtitleStatus {
  phase: YoutubeSubtitlePhase;
  /** 0~1 번역 진행률 */
  progress: number;
  error: string | null;
  sourceLanguage: string | null;
  /** 총 자막 세그먼트 수 */
  totalSegments: number;
  /** 번역 완료된 세그먼트 수 */
  translatedCount: number;
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function toOriginalOnly(segs: TimedTextSegment[]): SubtitleSegment[] {
  return segs.map((seg, i) => ({
    id:         `yt_${i}_${Math.round(seg.startTime * 1000)}`,
    startTime:  seg.startTime,
    endTime:    seg.endTime,
    original:   seg.text,
    translated: "",
  }));
}

// ── 훅 ───────────────────────────────────────────────────────────────────────

export function useYoutubeSubtitles() {
  const setSubtitles    = usePlayerStore((s) => s.setSubtitles);
  const patchSubtitles  = usePlayerStore((s) => s.patchSubtitles);
  const clearSubtitles  = usePlayerStore((s) => s.clearSubtitles);

  const targetLanguage  = useSettingsStore((s) => s.targetLanguage);

  const [status, setStatus] = useState<YoutubeSubtitleStatus>({
    phase: "idle",
    progress: 0,
    error: null,
    sourceLanguage: null,
    totalSegments: 0,
    translatedCount: 0,
  });

  // ── refs ──────────────────────────────────────────────────────────────────
  const cancelledRef        = useRef(false);
  const gemmaLoadedRef      = useRef(false);

  /** [PERF-1] index → translatedText */
  const translatedMapRef    = useRef<Map<number, string>>(new Map());

  /** [PERF-1] diff patch용 id 배열 캐시 */
  const segmentIdsRef       = useRef<string[]>([]);

  const allSegmentsRef      = useRef<TimedTextSegment[]>([]);

  // ── Gemma 지연 로드 ──────────────────────────────────────────────────────
  const ensureGemma = async (): Promise<boolean> => {
    if (gemmaLoadedRef.current) return true;
    const path = await getLocalModelPath();
    if (!path) {
      console.warn("[YT_SUBS v4] Gemma 없음 — 원문만 표시");
      return false;
    }
    await loadGemma();
    gemmaLoadedRef.current = true;
    return true;
  };

  // ── [PERF-1] diff patch ───────────────────────────────────────────────────
  const flushPatchToStore = useCallback(
    (newEntries: Array<{ index: number; translated: string }>) => {
      const patches: Array<{ id: string; translated: string }> = [];
      for (const { index, translated } of newEntries) {
        const id = segmentIdsRef.current[index];
        if (id) patches.push({ id, translated });
      }
      if (patches.length > 0) patchSubtitles(patches);
    },
    [patchSubtitles],
  );

  // ── [PIPELINE-2] 핵심: overlap chunk 파이프라인 번역 ─────────────────────
  /**
   * 전체 timedtext 세그먼트를 단일 overlap chunk 파이프라인으로 번역.
   *
   * 흐름:
   *   1) mergeSegmentsForYoutube()  — fragment 사전 병합
   *   2) createOverlappedChunks()   — overlap chunk 분할
   *   3) 청크별 translateSegments() — 동일 videoId로 호출 (고유명사 캐시 공유)
   *   4) stitchChunkResults()       — overlap 제거 후 최종 조립
   *   5) buildTranslationMap()      — merged → 원본 timedtext 인덱스 매핑
   *   6) patchSubtitles()           — diff patch로 UI 업데이트
   *
   * @param segs      원본 timedtext 세그먼트 전체
   * @param videoId   videoHash (고유명사 캐시 키)
   * @param langName  번역 대상 언어 이름
   * @param videoGenre 장르 힌트
   */
  const translateAllSegments = async (
    segs: TimedTextSegment[],
    videoId: string,
    langName: string,
    videoGenre: string = "general",
  ): Promise<void> => {
    if (segs.length === 0) return;

    // ── Step 1: timedtext 전용 사전 병합 ────────────────────────────────────
    // [PIPELINE-1] YouTube fragment를 의미 단위로 병합
    const merged = mergeSegmentsForYoutube(segs);
    console.log(
      `[YT_SUBS v4] merge: ${segs.length} raw → ${merged.length} merged (${
        Math.round((1 - merged.length / segs.length) * 100)
      }% reduction)`,
    );

    if (cancelledRef.current) return;

    // ── Step 2: overlap chunk 분할 ───────────────────────────────────────────
    // [PIPELINE-2] core=8, overlap=2
    const chunks = createOverlappedChunks(merged);
    const totalChunks = chunks.length;

    console.log(
      `[YT_SUBS v4] chunks: ${totalChunks} (core=${CHUNK_CORE_SIZE}, overlap=${OVERLAP_SIZE})`,
    );

    // ── Step 3: 청크별 번역 ──────────────────────────────────────────────────
    const chunkResults: Array<ReturnType<typeof translateSegments> extends Promise<infer T> ? T : never> = [];

    let completedSourceSegs = 0;
    const totalSourceSegs = segs.length;

    const partialTranslations: string[] = new Array(merged.length).fill("");

    for (let ci = 0; ci < chunks.length; ci++) {
      if (cancelledRef.current) return;

      const chunk = chunks[ci];
      const chunkInput = toTranslationInput(chunk.segments);

      console.log(
        `[YT_SUBS v4] chunk ${ci + 1}/${totalChunks}: ` +
        `segs=${chunk.segments.length}, keep=[${chunk.keepStart}~${chunk.keepEnd}]`,
      );

      let chunkTranslated: Awaited<ReturnType<typeof translateSegments>>;
      try {
        chunkTranslated = await translateSegments(
          chunkInput,
          (completed, total) => {
            if (cancelledRef.current) return;
            const chunkSourceSegs = chunk.segments
              .slice(chunk.keepStart, chunk.keepEnd + 1)
              .reduce((sum, seg) => sum + seg.sourceIndices.length, 0);
            const chunkProgress = total > 0 ? completed / total : 0;
            const approxDone = completedSourceSegs + Math.round(chunkSourceSegs * chunkProgress);
            const progress = totalSourceSegs > 0 ? approxDone / totalSourceSegs : 0;

            setStatus((s) => ({
              ...s,
              translatedCount: approxDone,
              progress: Math.min(progress, 0.99),
            }));
          },
          videoId,
          langName,
          videoGenre,
        );
      } catch (e: any) {
        console.warn(`[YT_SUBS v4] chunk ${ci + 1} 번역 실패, 원문 사용:`, e);
        chunkTranslated = chunkInput.map((seg) => ({ ...seg, translated: seg.text }));
      }

      if (cancelledRef.current) return;

      // ── Step 3.5: 중간 결과 UI 스트리밍 ────────────────────────────────────
      const newEntries: Array<{ index: number; translated: string }> = [];

      for (let li = chunk.keepStart; li <= chunk.keepEnd; li++) {
        const globalMergedIdx = chunk.globalStart + (li - chunk.keepStart);
        if (globalMergedIdx >= merged.length) break;

        const seg = chunkTranslated[li];
        if (!seg) continue;

        const translatedText = seg.translated || seg.text || chunk.segments[li]?.text || "";
        partialTranslations[globalMergedIdx] = translatedText;

        for (const srcIdx of merged[globalMergedIdx].sourceIndices) {
          if (!translatedMapRef.current.has(srcIdx)) {
            translatedMapRef.current.set(srcIdx, translatedText);
            newEntries.push({ index: srcIdx, translated: translatedText });
          }
        }
      }

      completedSourceSegs += chunk.segments
        .slice(chunk.keepStart, chunk.keepEnd + 1)
        .reduce((sum, seg) => sum + seg.sourceIndices.length, 0);

      flushPatchToStore(newEntries);

      setStatus((s) => ({
        ...s,
        translatedCount: completedSourceSegs,
        progress: totalSourceSegs > 0
          ? Math.min(completedSourceSegs / totalSourceSegs, 0.99)
          : 0,
      }));

      chunkResults.push(chunkTranslated as any);
    }

    if (cancelledRef.current) return;

    // ── Step 4: overlap 제거 후 최종 조립 ───────────────────────────────────
    const stitched = stitchChunkResults(chunks, chunkResults as any, merged.length);

    // ── Step 5: merged → 원본 timedtext 인덱스 매핑 ──────────────────────────
    // [FIX] v6 시그니처에 맞게 originalSegments(segs)와 targetLanguage(langName) 추가
    const translationMap = buildTranslationMap(merged, stitched, segs, langName);

    // ── Step 6: 최종 patch ───────────────────────────────────────────────────
    const finalEntries: Array<{ index: number; translated: string }> = [];
    translationMap.forEach((translated, srcIdx) => {
      const prev = translatedMapRef.current.get(srcIdx);
      if (prev !== translated) {
        translatedMapRef.current.set(srcIdx, translated);
        finalEntries.push({ index: srcIdx, translated });
      }
    });

    if (finalEntries.length > 0) {
      flushPatchToStore(finalEntries);
    }

    setStatus((s) => ({
      ...s,
      translatedCount: totalSourceSegs,
      progress: 1,
    }));

    console.log(
      `[YT_SUBS v4] done: ${totalSourceSegs} source segs, ` +
      `${merged.length} merged, ${totalChunks} chunks`,
    );
  };

  // ── 메인 load ─────────────────────────────────────────────────────────────
  /**
   * @param videoId     YouTube video ID
   * @param videoGenre  영상 장르 힌트 (예: "tech lecture", "comedy", "news")
   */
  const load = useCallback(async (
    videoId: string,
    videoGenre: string = "general",
    plan?: string,
  ) => {
    cancelledRef.current    = false;
    translatedMapRef.current.clear();
    segmentIdsRef.current   = [];
    allSegmentsRef.current  = [];
    clearSubtitles();

    const langName = getLanguageByCode(targetLanguage)?.name ?? targetLanguage;

    // ── 1. timedtext fetch ──────────────────────────────────────────────────
    setStatus({
      phase: "fetching",
      progress: 0,
      error: null,
      sourceLanguage: null,
      totalSegments: 0,
      translatedCount: 0,
    });

    const result = await fetchYoutubeSubtitles(videoId, "en", plan);
    if (cancelledRef.current) return;

    if (!result || result.segments.length === 0) {
      setStatus((s) => ({
        ...s,
        phase: "no_subtitles",
        error: null,
        sourceLanguage: null,
      }));
      console.log("[YT_SUBS v4] timedtext 없음 → Fallback 신호");
      return;
    }

    const { segments: rawSegs, language: sourceLang } = result;
    allSegmentsRef.current = rawSegs;

    // ── 2. 원문 먼저 Store에 적재 ───────────────────────────────────────────
    const originalOnly = toOriginalOnly(rawSegs);
    segmentIdsRef.current = originalOnly.map((s) => s.id);
    setSubtitles(originalOnly);

    setStatus({
      phase: "translating",
      progress: 0,
      error: null,
      sourceLanguage: sourceLang,
      totalSegments: rawSegs.length,
      translatedCount: 0,
    });

    // ── 3. Gemma 로드 ───────────────────────────────────────────────────────
    const hasGemma = await ensureGemma();
    if (cancelledRef.current) return;

    if (!hasGemma) {
      setStatus((s) => ({ ...s, phase: "done", progress: 1 }));
      return;
    }

    // ── 4. [PIPELINE-2] 전체를 단일 overlap chunk 파이프라인으로 번역 ────────
    try {
      await translateAllSegments(rawSegs, videoId, langName, videoGenre);
    } catch (e) {
      if (cancelledRef.current) return;
      console.error("[YT_SUBS v4] 번역 파이프라인 오류:", e);
      setStatus((s) => ({
        ...s,
        phase: "error",
        error: String(e),
      }));
      return;
    }

    if (cancelledRef.current) return;

    setStatus((s) => ({
      ...s,
      phase: "done",
      progress: 1,
      translatedCount: rawSegs.length,
    }));

    // ── 5. Gemma 해제 ───────────────────────────────────────────────────────
    if (gemmaLoadedRef.current) {
      try { await unloadGemma(); } catch {}
      gemmaLoadedRef.current = false;
    }

  }, [targetLanguage, clearSubtitles, setSubtitles, flushPatchToStore]);

  // ── cancel ────────────────────────────────────────────────────────────────
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (gemmaLoadedRef.current) {
      unloadGemma().catch(() => {});
      gemmaLoadedRef.current = false;
    }
  }, []);

  return { status, load, cancel };
}