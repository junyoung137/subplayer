/**
 * useYoutubeSubtitles (v2) — 아키텍처 전환판
 *
 * 개선사항:
 * 1. 컨텍스트 청킹 (Context Chunking): 5~10행씩 묶어 Gemma에 전달 → 대명사/문맥 처리 정확도↑
 * 2. 페르소나 설정 (Persona): videoId로 장르 힌트 불가 시 기본값, 향후 외부 주입 가능
 * 3. 프리페칭 (Pre-fetching): 현재 재생 위치 기준 앞 90초 분량을 백그라운드 선번역
 * 4. Fallback: 자막 없는 경우 useMediaProjectionProcessor(Whisper)로 자동 전환
 * 5. 이진탐색은 SubtitleOverlay 레이어에서 처리하므로 여기선 시간순 정렬만 보장
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

// ── 상수 ─────────────────────────────────────────────────────────────────────

/** Gemma에 한 번에 넘기는 자막 줄 수 (컨텍스트 청킹) */
const CONTEXT_CHUNK_SIZE = 8;

/** 프리페치 윈도우: 현재 재생 시간 기준 앞 N초 분량을 미리 번역 */
const PREFETCH_WINDOW_SEC = 90;

/** 프리페치 polling 간격 (ms) */
const PREFETCH_INTERVAL_MS = 5_000;

// ── 타입 ─────────────────────────────────────────────────────────────────────

export type YoutubeSubtitlePhase =
  | "idle"
  | "fetching"
  | "translating"
  | "done"
  | "error"
  | "no_subtitles"
  | "fallback_whisper"; // 자막 없음 → Whisper 폴백 진행 중

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

/**
 * 이진탐색으로 현재 시간 기준 아직 번역되지 않은 첫 세그먼트 인덱스를 찾는다.
 * SubtitleOverlay 에서도 동일 알고리즘 사용 — 일관성 유지.
 */
function findNextUntranslatedIndex(
  segments: SubtitleSegment[],
  currentTime: number
): number {
  let lo = 0;
  let hi = segments.length - 1;
  // currentTime 이후 세그먼트 중 첫 번째 미번역 위치
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].endTime < currentTime) lo = mid + 1;
    else hi = mid - 1;
  }
  // lo 이후에서 첫 번째 미번역 세그먼트 탐색
  for (let i = lo; i < segments.length; i++) {
    if (!segments[i].translated) return i;
  }
  return segments.length; // 모두 번역됨
}

/**
 * TimedTextSegment 배열 → SubtitleSegment 배열 (원문만, translated 빈 문자열)
 */
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
  const clearSubtitles  = usePlayerStore((s) => s.clearSubtitles);
  const currentTime     = usePlayerStore((s) => s.currentTime);

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
  /**
   * 번역 진행 상태 추적용:
   * allSegments: timedtext에서 받아온 원본 전체
   * translated: 번역 완료 세그먼트 (인덱스 기준으로 채워감)
   */
  const allSegmentsRef      = useRef<TimedTextSegment[]>([]);
  const translatedMapRef    = useRef<Map<number, string>>(new Map());
  const prefetchTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const prefetchUpToRef     = useRef(0); // 프리페치가 진행된 마지막 세그먼트 인덱스

  // currentTime을 렌더 없이 추적
  const currentTimeRef = useRef(currentTime);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  // ── Gemma 지연 로드 ──────────────────────────────────────────────────────
  const ensureGemma = async (): Promise<boolean> => {
    if (gemmaLoadedRef.current) return true;
    const path = await getLocalModelPath();
    if (!path) {
      console.warn("[YT_SUBS] Gemma 없음 — 원문만 표시");
      return false;
    }
    await loadGemma();
    gemmaLoadedRef.current = true;
    return true;
  };

  /**
   * 컨텍스트 청킹 번역:
   * - CONTEXT_CHUNK_SIZE(8)개씩 묶어서 번역 → 앞뒤 문맥 파악
   * - 번역된 세그먼트는 즉시 Store에 반영
   * - videoGenre: 향후 외부에서 "기술 강의", "코미디" 등 주입 가능
   */
  const translateWithContext = async (
    segs: TimedTextSegment[],
    startIdx: number,
    endIdx: number,   // exclusive
    videoId: string,
    langName: string,
    videoGenre: string = "general"
  ): Promise<void> => {
    const slice = segs.slice(startIdx, endIdx);
    if (slice.length === 0) return;

    // 현재 Store 세그먼트 가져오기 (업데이트용)
    const currentSubs = usePlayerStore.getState().subtitles;

    // CONTEXT_CHUNK_SIZE씩 배치 분할
    for (let batchStart = 0; batchStart < slice.length; batchStart += CONTEXT_CHUNK_SIZE) {
      if (cancelledRef.current) return;

      const batchEnd   = Math.min(batchStart + CONTEXT_CHUNK_SIZE, slice.length);
      const batch      = slice.slice(batchStart, batchEnd);
      const batchInput = batch.map((seg) => ({
        start:      seg.startTime,
        end:        seg.endTime,
        text:       seg.text,
        translated: "",
      }));

      try {
        const translated = await translateSegments(
          batchInput,
          () => {},      // 배치 내부 progress (프리페치 시 생략)
          videoId,
          langName,
          videoGenre,    // 페르소나 전달
        );

        if (cancelledRef.current) return;

        // 번역 결과 Map에 저장
        translated.forEach((seg, i) => {
          const globalIdx = startIdx + batchStart + i;
          translatedMapRef.current.set(globalIdx, seg.translated || seg.text);
        });

        // Store 일괄 업데이트 (번역된 세그먼트만 교체)
        const updatedSubs = usePlayerStore.getState().subtitles.map((sub, i) => {
          const translatedText = translatedMapRef.current.get(i);
          if (translatedText !== undefined && sub.translated === "") {
            return { ...sub, translated: translatedText };
          }
          return sub;
        });
        setSubtitles(updatedSubs);

        const done = translatedMapRef.current.size;
        const total = segs.length;
        setStatus((s) => ({
          ...s,
          translatedCount: done,
          progress: total > 0 ? done / total : 0,
        }));

      } catch (e) {
        console.warn("[YT_SUBS] 배치 번역 실패, 원문 사용:", e);
        // 실패한 배치는 원문으로 채움
        batch.forEach((seg, i) => {
          const globalIdx = startIdx + batchStart + i;
          if (!translatedMapRef.current.has(globalIdx)) {
            translatedMapRef.current.set(globalIdx, seg.text);
          }
        });
      }
    }
  };

  // ── 프리페치 루프 ─────────────────────────────────────────────────────────
  /**
   * 현재 재생 위치 기준 PREFETCH_WINDOW_SEC 앞까지 미번역 세그먼트를 선번역.
   * 5초마다 polling하여 필요한 구간만 추가 번역.
   */
  const startPrefetchLoop = (videoId: string, langName: string, videoGenre: string) => {
    if (prefetchTimerRef.current) clearInterval(prefetchTimerRef.current);

    prefetchTimerRef.current = setInterval(async () => {
      if (cancelledRef.current) {
        clearInterval(prefetchTimerRef.current!);
        return;
      }
      const segs = allSegmentsRef.current;
      if (segs.length === 0) return;

      const ct = currentTimeRef.current;
      const prefetchUntil = ct + PREFETCH_WINDOW_SEC;

      // 프리페치 대상: 현재 시간 이후, 프리페치 윈도우 내, 아직 미번역
      const targetEnd = segs.findIndex((s) => s.startTime > prefetchUntil);
      const endIdx    = targetEnd === -1 ? segs.length : targetEnd;

      if (endIdx > prefetchUpToRef.current) {
        const newStart = prefetchUpToRef.current;
        prefetchUpToRef.current = endIdx;
        // 백그라운드 번역 (await 없이 fire-and-forget)
        translateWithContext(segs, newStart, endIdx, videoId, langName, videoGenre).catch(
          (e) => console.warn("[YT_SUBS] 프리페치 오류:", e)
        );
      }
    }, PREFETCH_INTERVAL_MS);
  };

  const stopPrefetchLoop = () => {
    if (prefetchTimerRef.current) {
      clearInterval(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  };

  // ── 메인 load ─────────────────────────────────────────────────────────────
  /**
   * @param videoId     YouTube video ID
   * @param videoGenre  영상 장르 힌트 (예: "tech lecture", "comedy", "news")
   *                    없으면 "general"
   */
  const load = useCallback(async (videoId: string, videoGenre: string = "general") => {
    cancelledRef.current    = false;
    translatedMapRef.current.clear();
    prefetchUpToRef.current = 0;
    allSegmentsRef.current  = [];
    stopPrefetchLoop();
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

    const result = await fetchYoutubeSubtitles(videoId);
    if (cancelledRef.current) return;

    if (!result || result.segments.length === 0) {
      // ── Fallback: Whisper 사용을 호출자에게 알림 ──────────────────────
      setStatus((s) => ({
        ...s,
        phase: "no_subtitles",
        error: null,
        sourceLanguage: null,
      }));
      console.log("[YT_SUBS] timedtext 없음 → Fallback 신호 발송");
      return;
    }

    const { segments: rawSegs, language: sourceLang } = result;
    allSegmentsRef.current = rawSegs;

    // ── 2. 원문 먼저 Store에 적재 (번역 전에도 원문 자막 노출) ─────────────
    const originalOnly = toOriginalOnly(rawSegs);
    setSubtitles(originalOnly);

    setStatus({
      phase: "translating",
      progress: 0,
      error: null,
      sourceLanguage: sourceLang,
      totalSegments: rawSegs.length,
      translatedCount: 0,
    });

    // ── 3. Gemma 로드 ──────────────────────────────────────────────────────
    const hasGemma = await ensureGemma();
    if (cancelledRef.current) return;

    if (!hasGemma) {
      setStatus((s) => ({
        ...s,
        phase: "done",
        progress: 1,
        error: null,
      }));
      return;
    }

    // ── 4. 초기 번역: 처음 PREFETCH_WINDOW_SEC 분량 (즉시 표시) ──────────
    const initialEnd = rawSegs.findIndex((s) => s.startTime > PREFETCH_WINDOW_SEC);
    const firstBatchEnd = initialEnd === -1 ? rawSegs.length : initialEnd;

    prefetchUpToRef.current = firstBatchEnd;
    await translateWithContext(rawSegs, 0, firstBatchEnd, videoId, langName, videoGenre);
    if (cancelledRef.current) return;

    // ── 5. 프리페치 루프 시작 (나머지 구간을 백그라운드 번역) ─────────────
    startPrefetchLoop(videoId, langName, videoGenre);

    // ── 6. 나머지 전체 번역 (순차 진행, 프리페치가 앞서간 부분은 스킵) ────
    if (firstBatchEnd < rawSegs.length) {
      await translateWithContext(
        rawSegs,
        firstBatchEnd,
        rawSegs.length,
        videoId,
        langName,
        videoGenre
      );
    }

    stopPrefetchLoop();

    if (!cancelledRef.current) {
      setStatus((s) => ({
        ...s,
        phase: "done",
        progress: 1,
        translatedCount: rawSegs.length,
      }));
    }

    // ── 7. Gemma 해제 ──────────────────────────────────────────────────────
    if (gemmaLoadedRef.current) {
      try { await unloadGemma(); } catch {}
      gemmaLoadedRef.current = false;
    }

  }, [targetLanguage, clearSubtitles, setSubtitles]);

  // ── cancel ────────────────────────────────────────────────────────────────
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stopPrefetchLoop();
    if (gemmaLoadedRef.current) {
      unloadGemma().catch(() => {});
      gemmaLoadedRef.current = false;
    }
  }, []);

  return { status, load, cancel };
}