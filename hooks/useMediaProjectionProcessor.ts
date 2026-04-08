/**
 * useMediaProjectionProcessor (v4)
 *
 * 수정사항:
 * 1. [BLANK_AUDIO] 필터링 — processChunk 입구에서 제거
 * 2. loopRunningRef 추가 — 중복 루프 실행 차단 (청크 누적 방지)
 * 3. loopRunningRef finally 블록에서 반드시 해제
 */

import { useRef, useState, useCallback } from "react";
import { NativeModules, Alert, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { transcribeChunkSegmented } from "../services/whisperService";
import {
  loadModel as loadGemma,
  unloadModel as unloadGemma,
  translateSegments,
} from "../services/gemmaTranslationService";
import { getLocalModelPath } from "../services/modelDownloadService";
import { getLanguageByCode } from "../constants/languages";
import { SubtitleSegment } from "../store/usePlayerStore";

const { AudioChunker } = NativeModules;

const CHUNK_DURATION_MS = 30_000;

// ── 텍스트 정제 ───────────────────────────────────────────────────────────────
const SENTENCE_END    = /[.?!。]$/;
const MAX_MERGE_DUR   = 2.5;
const MAX_MERGE_CHARS = 60;

// ── BLANK 판정 패턴 ───────────────────────────────────────────────────────────
const BLANK_PATTERNS = [
  '[BLANK_AUDIO]',
  '[BLANK_VIDEO]',
  '[blank_audio]',
  '[silence]',
  '[SILENCE]',
];

function isBlankSegment(text: string): boolean {
  if (!text || text.trim().length <= 2) return true;
  return BLANK_PATTERNS.some(p => text.includes(p));
}

function cleanText(text: string): string {
  if (!text) return text;
  return text
    .replace(/^[.!?,;:\s]+/, "")
    .replace(/\s+[.!?,;:]$/, (m) => m.trim())
    .replace(/\s+/g, " ")
    .replace(/\s+([.!?,;:])/g, "$1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

type RawSeg = { startTime: number; endTime: number; text: string; language: string };

function mergeIntoSentences(segs: RawSeg[]): RawSeg[] {
  if (!segs.length) return [];
  const out: RawSeg[] = [];
  let cur = { ...segs[0] };
  for (let i = 1; i < segs.length; i++) {
    const nxt      = segs[i];
    const combined = cur.text + " " + nxt.text;
    const dur      = nxt.endTime - cur.startTime;
    if (dur > MAX_MERGE_DUR || combined.length > MAX_MERGE_CHARS) {
      out.push({ ...cur, text: cleanText(cur.text) });
      cur = { ...nxt };
    } else {
      cur = { startTime: cur.startTime, endTime: nxt.endTime, text: combined, language: cur.language };
      if (SENTENCE_END.test(cur.text.trimEnd())) {
        out.push({ ...cur, text: cleanText(cur.text) });
        if (i + 1 < segs.length) cur = { ...segs[++i] };
        else return out;
      }
    }
  }
  out.push({ ...cur, text: cleanText(cur.text) });
  return out;
}

// ── 공개 타입 ─────────────────────────────────────────────────────────────────
export interface UrlProcessorStatus {
  isRunning: boolean;
  chunkIndex: number;
  phase: "idle" | "capturing" | "transcribing" | "translating" | "error";
  error: string | null;
}

// ── 훅 ───────────────────────────────────────────────────────────────────────
export function useMediaProjectionProcessor() {
  const appendSubtitles = usePlayerStore((s) => s.appendSubtitles);
  const updateUrlProc   = usePlayerStore((s) => s.updateUrlProcessing);

  // ── currentTime을 렌더 없이 최신값으로 추적 ──────────────────────────────
  const currentTimeRef = useRef(0);
  usePlayerStore.subscribe((s) => { currentTimeRef.current = s.currentTime; });

  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const sourceLanguage = useSettingsStore((s) => s.sourceLanguage);

  const [status, setStatus] = useState<UrlProcessorStatus>({
    isRunning: false, chunkIndex: 0, phase: "idle", error: null,
  });

  const stopRequestedRef = useRef(false);
  const chunkIndexRef    = useRef(0);
  const gemmaLoadedRef   = useRef(false);
  // ✅ 중복 루프 방지용 ref
  const loopRunningRef   = useRef(false);

  // ── Gemma 지연 로드 ──────────────────────────────────────────────────────
  const ensureGemma = async (): Promise<boolean> => {
    if (gemmaLoadedRef.current) return true;
    const path = await getLocalModelPath();
    if (!path) {
      console.warn("[URL_PROC] Gemma 없음 — 원문만 표시");
      return false;
    }
    await loadGemma();
    gemmaLoadedRef.current = true;
    return true;
  };

  // ── 단일 청크 처리 ────────────────────────────────────────────────────────
  const processChunk = async (wavPath: string, chunkStartSec: number): Promise<void> => {
    const idx = chunkIndexRef.current;
    console.log(`[URL_PROC] 청크 #${idx} 전사 @ ytTime=${chunkStartSec.toFixed(1)}s`);

    setStatus((s) => ({ ...s, phase: "transcribing" }));

    let rawSegs: RawSeg[] = [];
    try {
      const whisperSegs = await transcribeChunkSegmented(wavPath, chunkStartSec, sourceLanguage);

      // ✅ BLANK_AUDIO 및 빈 세그먼트 필터링
      rawSegs = whisperSegs.filter(seg => !isBlankSegment(seg.text));

      if (rawSegs.length === 0) {
        console.log(`[URL_PROC] 청크 #${idx}: BLANK 또는 빈 세그먼트만 있음 — 건너뜀`);
      }
    } finally {
      try { await FileSystem.deleteAsync(wavPath, { idempotent: true }); } catch {}
    }

    if (!rawSegs.length) {
      setStatus((s) => ({ ...s, phase: "capturing" }));
      return;
    }

    const sentences = mergeIntoSentences(rawSegs);

    // ── Gemma 번역 ────────────────────────────────────────────────────────
    setStatus((s) => ({ ...s, phase: "translating" }));

    const hasGemma = await ensureGemma();
    const langName = getLanguageByCode(targetLanguage)?.name ?? targetLanguage;
    const input    = sentences.map((s) => ({
      start: s.startTime, end: s.endTime, text: s.text, translated: "",
    }));

    let translated = input;
    if (hasGemma) {
      try {
        translated = await translateSegments(input, () => {}, "", langName);
      } catch (e) {
        console.warn("[URL_PROC] 번역 실패, 원문 사용:", e);
      }
    }

    // ── Store 누적 ────────────────────────────────────────────────────────
    const segments: SubtitleSegment[] = sentences.map((seg, i) => ({
      id:         `url_${idx}_${i}_${Math.round(seg.startTime * 1000)}`,
      startTime:  seg.startTime,
      endTime:    seg.endTime,
      original:   seg.text,
      translated: translated[i]?.translated ?? "",
    }));

    appendSubtitles(segments);
    console.log(`[URL_PROC] 청크 #${idx}: ${segments.length}개 자막 (${segments[0]?.startTime.toFixed(1)}s ~ ${segments[segments.length-1]?.endTime.toFixed(1)}s)`);

    setStatus((s) => ({ ...s, phase: "capturing" }));
  };

  // ── 메인 루프 ─────────────────────────────────────────────────────────────
  const runLoop = async (): Promise<void> => {
    // ✅ 중복 루프 진입 차단
    if (loopRunningRef.current) {
      console.warn("[URL_PROC] 이전 루프 실행 중 — 중복 진입 차단");
      return;
    }
    loopRunningRef.current = true;

    try {
      // ── 최초 1회: 권한 요청 ────────────────────────────────────────────
      try {
        await AudioChunker.requestMediaProjection();
      } catch (e) {
        const msg = String(e);
        setStatus({ isRunning: false, chunkIndex: 0, phase: "error", error: msg });
        updateUrlProc({ isActive: false, error: msg });
        Alert.alert("권한 필요", "시스템 오디오 캡처 권한이 허용되지 않았습니다.");
        return;
      }

      setStatus((s) => ({ ...s, phase: "capturing" }));

      let chunkStartSec = currentTimeRef.current;
      console.log(`[URL_PROC] 첫 청크 시작 @ ytTime=${chunkStartSec.toFixed(1)}s`);

      while (!stopRequestedRef.current) {
        // ── 30초 대기 ──────────────────────────────────────────────────
        await new Promise<void>((resolve) => {
          const end  = Date.now() + CHUNK_DURATION_MS;
          const tick = setInterval(() => {
            if (stopRequestedRef.current || Date.now() >= end) {
              clearInterval(tick);
              resolve();
            }
          }, 200);
        });

        if (stopRequestedRef.current) break;

        chunkIndexRef.current += 1;
        updateUrlProc({ chunkIndex: chunkIndexRef.current });
        setStatus((s) => ({ ...s, chunkIndex: chunkIndexRef.current }));

        const nextChunkStartSec = currentTimeRef.current;

        let completedWavPath: string | null = null;
        try {
          completedWavPath = await AudioChunker.restartChunk();
        } catch (e) {
          console.warn("[URL_PROC] restartChunk 실패:", e);
        }

        const thisChunkStart = chunkStartSec;
        chunkStartSec = nextChunkStartSec;

        if (completedWavPath) {
          processChunk(completedWavPath, thisChunkStart).catch((e) => {
            console.warn("[URL_PROC] processChunk 오류:", e);
          });
        }

        updateUrlProc({ lastChunkAt: Date.now() });
      }

      // ── 루프 종료: 마지막 청크 처리 ────────────────────────────────────
      const lastStart = chunkStartSec;
      let lastPath: string | null = null;
      try {
        lastPath = await AudioChunker.stopMediaProjection();
      } catch {}

      if (lastPath) {
        try { await processChunk(lastPath, lastStart); } catch {}
      }

      if (gemmaLoadedRef.current) {
        try { await unloadGemma(); } catch {}
        gemmaLoadedRef.current = false;
      }

      setStatus({ isRunning: false, chunkIndex: chunkIndexRef.current, phase: "idle", error: null });
      updateUrlProc({ isActive: false });
      console.log("[URL_PROC] 루프 종료");

    } finally {
      // ✅ 루프 종료 시 반드시 해제 (에러 발생해도 해제됨)
      loopRunningRef.current = false;
    }
  };

  // ── 공개 API ─────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (Platform.OS !== "android") {
      Alert.alert("Android 전용", "실시간 자막은 Android에서만 지원됩니다.");
      return;
    }
    if (status.isRunning) return;
    // ✅ 루프가 이미 실행 중이면 재진입 차단
    if (loopRunningRef.current) return;

    stopRequestedRef.current = false;
    chunkIndexRef.current    = 0;

    setStatus({ isRunning: true, chunkIndex: 0, phase: "capturing", error: null });
    updateUrlProc({ isActive: true, chunkIndex: 0, error: null, lastChunkAt: Date.now() });

    runLoop().catch((e) => {
      const msg = String(e);
      console.error("[URL_PROC] 치명적 오류:", msg);
      setStatus((s) => ({ ...s, isRunning: false, phase: "error", error: msg }));
      updateUrlProc({ isActive: false, error: msg });
    });
  }, [status.isRunning]);

  const stop = useCallback(async () => {
    stopRequestedRef.current = true;
  }, []);

  return { status, start, stop };
}