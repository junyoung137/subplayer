import * as FileSystem from "expo-file-system/legacy";
import { SubtitleSegment } from "../store/usePlayerStore";
import { AudioChunk, clearChunkDir, getVideoDuration, extractSingleChunkAt } from "./audioChunker";
import { transcribeChunkSegmented, releaseModel as releaseWhisper, loadModel as loadWhisper, getLoadedModelPath as getWhisperModelPath } from "./whisperService";
import {
  loadModel as loadGemma,
  unloadModel as unloadGemma,
  forceUnloadModel as forceUnloadGemma,           // [THERMAL-OPT-V4]
  setKeepLoaded as setGemmaKeepLoaded,            // [THERMAL-OPT-V4]
  isModelLoaded as isGemmaLoaded,                 // [THERMAL-OPT-V4]
  idleBetweenBatches,                             // [THERMAL-OPT-V4]
  reportThermalAndMaybeUnload,                    // [THERMAL-OPT-V4]
  translateSegments,
} from "./gemmaTranslationService";
import { getLocalModelPath } from "./modelDownloadService";
import { getLanguageByCode } from "../constants/languages";
import { createThermalController } from "./thermalMonitor";

export interface ProcessingProgress {
  step: "extracting" | "transcribing" | "unloading" | "translating" | "done" | "error";
  current: number;
  total: number;
  percent: number;
  message: string;
  error?: string;
}

export interface ProcessingResult {
  subtitles: SubtitleSegment[];
  translationSkipped: boolean;
}

const BAND_EXTRACT_END    = 5;
const BAND_TRANSCRIBE_END = 45;
const BAND_TRANSLATE_END  = 99;

// Chunks per transcription batch before each translation pass.
// 15 chunks × 30s ≈ 7.5 minutes of audio per batch. [OPT-4]
// Reduces model load/unload cycles from ~12 to ~8 on a 60-minute video.
const CHUNKS_PER_BATCH = 6; // [OPT-4]

// Maximum gap (seconds) between subtitles allowed inside the
// contiguous block used for early playback.
// 4s is permissive enough for natural speech pauses while
// still filtering genuine content gaps.
const EARLY_PLAYBACK_MAX_GAP_S = 4;

function getEarlyPlaybackThreshold(totalDurationSecs: number): number {
  if (totalDurationSecs <= 600) {
    return totalDurationSecs * 0.5;
  } else if (totalDurationSecs <= 1800) {
    return totalDurationSecs * 0.35;
  } else {
    return Math.max(totalDurationSecs * 0.25, 600);
  }
}

function makeStableSubtitleId(startSecs: number, endSecs: number): string {
  // Use time-based ID so partial and final subtitles share the same key.
  // This prevents React key mismatch when transitioning partial → full.
  return `${Math.round(startSecs * 1000)}_${Math.round(endSecs * 1000)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SENTENCE_END       = /[.?!。]$/;
const MAX_MERGE_DURATION = 2.5;
const MAX_MERGE_CHARS    = 60;

// ── BLANK 판정 패턴 ───────────────────────────────────────────────────────────
const BLANK_PATTERNS = [
  '[BLANK_AUDIO]',
  '[BLANK_VIDEO]',
  '[blank_audio]',
  '[silence]',
  '[SILENCE]',
];

// 괄호 노이즈 패턴: 텍스트 전체가 괄호인 경우만 필터링
const RE_BRACKET_NOISE = /^\s*[\(\[（【][^\)\]）】]*[\)\]）】]\s*[.!?,;]?\s*$/;

function isBlankSegment(text: string): boolean {
  if (!text || text.trim().length <= 2) return true;
  if (BLANK_PATTERNS.some(p => text.includes(p))) return true;
  if (RE_BRACKET_NOISE.test(text)) return true;
  return false;
}

function cleanSegmentText(text: string): string {
  if (!text) return text;
  text = text.replace(/^[.!?,;:\s]+/, '');
  text = text.replace(/\s+[.!?,;:]$/, match => match.trim());
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\s+([.!?,;:])/g, '$1');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.trim();
}

type RawSegment = { startTime: number; endTime: number; text: string; language: string };

function mergeSegmentsIntoSentences(segments: RawSegment[]): RawSegment[] {
  if (segments.length === 0) return [];

  const merged: RawSegment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];

    // Guard: never split a decimal clock time across segments.
    // Matches "...at 10." (current ends with \d{1,2}.) + "45." or "45" (next starts with [0-5]\d).
    if (/\b\d{1,2}\.$/.test(current.text) && /^[0-5]\d\b/.test(next.text.trimStart())) {
      current = {
        startTime: current.startTime,
        endTime:   next.endTime,
        text:      current.text + " " + next.text,
        language:  current.language,
      };
      continue;
    }

    const combinedText     = current.text + " " + next.text;
    const combinedDuration = next.endTime - current.startTime;

    const wouldExceedDuration = combinedDuration > MAX_MERGE_DURATION;
    const wouldExceedChars    = combinedText.length > MAX_MERGE_CHARS;

    // FIX 2: Dangling sentence-opener guard.
    // If a break is about to fire but current doesn't end a sentence and next
    // is a short dangling opener (≤3 words, starts lowercase or is a connector),
    // merge unconditionally to avoid orphaning fragments like "with you."
    if (wouldExceedDuration || wouldExceedChars) {
      const currentEndsWithSentence = /[.?!。]$/.test(current.text.trimEnd());
      if (!currentEndsWithSentence) {
        const nextTrimmed = next.text.trim();
        const nextWords   = nextTrimmed.split(/\s+/);
        const isDanglingOpener =
          nextWords.length <= 3 &&
          (/^[a-z]/.test(nextTrimmed) ||
           /^(with|for|and|but|or|to|in|at|of|by|the|a|an)\b/i.test(nextTrimmed));
        if (isDanglingOpener) {
          current = {
            startTime: current.startTime,
            endTime:   next.endTime,
            text:      combinedText,
            language:  current.language,
          };
          continue;
        }
      }
    }

    if (wouldExceedDuration || wouldExceedChars) {
      merged.push({ ...current, text: cleanSegmentText(current.text) });
      current = { ...next };
    } else {
      current = {
        startTime: current.startTime,
        endTime:   next.endTime,
        text:      combinedText,
        language:  current.language,
      };

      if (SENTENCE_END.test(current.text.trimEnd())) {
        merged.push({ ...current, text: cleanSegmentText(current.text) });
        if (i + 1 < segments.length) {
          current = { ...segments[++i] };
        } else {
          return merged;
        }
      }
    }
  }

  merged.push({ ...current, text: cleanSegmentText(current.text) });
  return merged;
}

// ── chunk 파일 삭제 헬퍼 ──────────────────────────────────────────────────────
// Whisper가 파일 핸들을 닫기 전에 deleteAsync를 호출하면 Android에서
// "isn't deletable" IOException 발생 → 딜레이 후 재시도, fire-and-forget
async function safeDeleteChunk(filePath: string): Promise<void> {
  await sleep(200); // [OPT-8] was 30ms; 200ms covers Android file handle release on every chunk
  try {
    await FileSystem.deleteAsync(filePath, { idempotent: true });
    return;
  } catch {
    await sleep(500);
    try {
      await FileSystem.deleteAsync(filePath, { idempotent: true });
    } catch (e) {
      console.warn("[VideoProcessor] chunk delete failed (will be cleaned by clearChunkDir):", e);
    }
  }
}

// ── [자체 개선] ExtractionOutcome 타입 ───────────────────────────────────────
// SILENT_CHUNK(VAD skip)와 EXTRACTION_ERROR를 명확히 구분.
// 기존: catch 블록에서 모든 에러를 동일하게 skippedChunks++ 처리
//       → SILENT_CHUNK도 "extraction 실패"로 카운트돼 skipRate 오경보 발생
// 개선: SILENT_CHUNK는 정상 처리(VAD가 무음 제거), extraction 실패만 카운트
type ExtractionOutcome =
  | { kind: "ok";      chunk: AudioChunk }
  | { kind: "silent"              }   // VAD → 정상 skip, 실패 아님
  | { kind: "error";   reason: unknown }; // 진짜 extraction 실패

async function tryExtractChunk(
  videoUri: string,
  offset: number,
  chunkDur: number,
  chunkIndex: number,
): Promise<ExtractionOutcome> {
  try {
    const chunk = await extractSingleChunkAt(videoUri, offset, chunkDur, chunkIndex);
    return { kind: "ok", chunk };
  } catch (e: any) {
    // SILENT_CHUNK: native 모듈이 VAD로 판단해 reject — 정상 케이스
    if (e?.code === "SILENT_CHUNK" || e?.message?.includes("SILENT_CHUNK")) {
      return { kind: "silent" };
    }
    return { kind: "error", reason: e };
  }
}

export async function processVideo(
  videoUri: string,
  sourceLanguage: string,
  targetLanguage: string,
  onProgress: (p: ProcessingProgress) => void,
  isCancelled: () => boolean,
  thermalProtection: boolean = true,
  onEarlyPlaybackReady?: (subtitles: SubtitleSegment[]) => void,
  onPartialUpdate?: (subtitles: SubtitleSegment[]) => void,
): Promise<ProcessingResult> {
  const thermal = createThermalController();
  try {
    // ── Step 1: Duration probe ──────────────────────────────────────
    onProgress({
      step: "extracting", current: 0, total: 0,
      percent: BAND_EXTRACT_END, message: "오디오 추출 중...",
    });

    const totalDuration = await getVideoDuration(videoUri);
    if (totalDuration <= 0)
      throw new Error("오디오 트랙을 찾을 수 없습니다. mp4/mkv/mov 권장");

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // Capture Whisper model path before any release
    const whisperModelPath = getWhisperModelPath();

    // ── Step 2: Detect Gemma availability ──────────────────────────
    const gemmaPath      = await getLocalModelPath();
    let   translationSkipped = !gemmaPath;

    // [THERMAL-OPT-V4] Load Gemma once and keep resident for all batches.
    if (!translationSkipped) { // [THERMAL-OPT-V4]
      setGemmaKeepLoaded(true); // [THERMAL-OPT-V4]
      try { // [THERMAL-OPT-V4]
        await loadGemma(); // [THERMAL-OPT-V4]
      } catch (loadErr) { // [THERMAL-OPT-V4]
        console.warn('[VideoProcessor] Gemma pre-load failed — disabling translation:', loadErr); // [THERMAL-OPT-V4]
        translationSkipped = true; // [THERMAL-OPT-V4]
        setGemmaKeepLoaded(false); // [THERMAL-OPT-V4]
      } // [THERMAL-OPT-V4]
    } // [THERMAL-OPT-V4]
    // [THERMAL-OPT-V4] Hint only — NOT authoritative. Always use isGemmaLoaded() for real checks.
    let llamaContextIsLoaded = !translationSkipped; // [THERMAL-OPT-V4]

    if (isCancelled()) {
      return { subtitles: [], translationSkipped: false };
    }

    const langMeta = getLanguageByCode(targetLanguage);
    const langName = langMeta?.name ?? targetLanguage;

    // ── Step 3: Batch pipeline ──────────────────────────────────────
    const SKIP_RATE_WARN_THRESHOLD = 0.3;

    const allTranslated:     SubtitleSegment[] = [];
    let   offset             = 0;
    let   chunkIndex         = 0;
    let   skippedChunks      = 0;
    let   silentChunks       = 0;
    let   batchIndex         = 0;
    let   earlyPlaybackFired = false;
    let   lastEmittedEndTime = 0;
    let   whisperLoaded      = true; // Whisper is loaded at entry

    // Pre-fetch first chunk
    let nextChunkPromise: Promise<ExtractionOutcome> = tryExtractChunk(
      videoUri, offset,
      Math.min(thermal.getTier().chunkDurationSecs, totalDuration - offset),
      0,
    );

    // Unified timeline progress state
    let fullyProcessedOffset = 0;  // video seconds where both STT+translation done
    let lastReportedPercent  = BAND_EXTRACT_END; // monotonic guard, starts at 5

    const calcPercent = (videoPos: number): number => {
      const safeTotal = totalDuration > 0 ? totalDuration : 1;
      const raw = Math.round(
        BAND_EXTRACT_END +
        Math.min(videoPos / safeTotal, 1) * (BAND_TRANSLATE_END - BAND_EXTRACT_END)
      );
      // Monotonic: never go backward, never jump more than 3% per call,
      // never exceed BAND_TRANSLATE_END
      const capped = Math.min(
        Math.min(
          Math.max(raw, lastReportedPercent),
          lastReportedPercent + 3
        ),
        BAND_TRANSLATE_END
      );
      lastReportedPercent = capped;
      return capped;
    };

    while (offset < totalDuration) {
      if (isCancelled()) {
        return { subtitles: [], translationSkipped: false };
      }

      batchIndex++;

      // ── Phase A: Reload Whisper if needed ─────────────────────────
      // Whisper was released after the previous batch's translation.
      // Reload it explicitly before transcription starts.
      if (!whisperLoaded) {
        if (whisperModelPath) await loadWhisper(whisperModelPath);
        whisperLoaded = true;
      }

      // ── Phase B: Transcribe up to CHUNKS_PER_BATCH chunks ────────
      const batchRawSegments: RawSegment[] = [];
      let   chunksThisBatch  = 0;

      while (chunksThisBatch < CHUNKS_PER_BATCH && offset < totalDuration) {
        // MUST be the FIRST line inside this loop body.
        // Do NOT hoist outside the loop — thermal tier can change between
        // chunks and must be re-read on every iteration without exception.
        const tier = thermal.getTier();

        if (isCancelled()) {
          return { subtitles: [], translationSkipped: false };
        }

        const chunkDur = Math.min(tier.chunkDurationSecs, totalDuration - offset);
        const outcome  = await nextChunkPromise;

        // Pre-fetch next chunk immediately
        const nextOffset = offset + chunkDur;
        if (nextOffset < totalDuration) {
          const nd = Math.min(
            thermal.getTier().chunkDurationSecs,
            totalDuration - nextOffset,
          );
          nextChunkPromise = tryExtractChunk(
            videoUri, nextOffset, nd, chunkIndex + 1,
          );
        }

        if (outcome.kind === "silent") {
          silentChunks++;
        } else if (outcome.kind === "error") {
          console.warn(
            `[VideoProcessor] chunk ${chunkIndex} failed:`, outcome.reason,
          );
          skippedChunks++;
        } else {
          const chunk = outcome.chunk;
          const t0    = Date.now();
          const segs  = await transcribeChunkSegmented(
            chunk.filePath, chunk.startTime, sourceLanguage,
          );
          thermal.reportTranscriptionTime(Date.now() - t0, chunkDur);

          const filtered = segs.filter(s => !isBlankSegment(s.text));
          if (filtered.length < segs.length) {
            console.log(
              `[VideoProcessor] chunk ${chunkIndex}: ` +
              `${segs.length - filtered.length} BLANK removed`,
            );
          }
          batchRawSegments.push(...filtered);
          safeDeleteChunk(chunk.filePath);
        }

        offset += chunkDur;
        chunkIndex++;
        chunksThisBatch++;

        // STT credit: fully processed up to fullyProcessedOffset,
        // plus half-credit for the current chunk's STT progress.
        // Half-credit because each video second needs both STT and
        // translation; STT alone earns 50% of that second's progress.
        const sttPos = fullyProcessedOffset + (offset - fullyProcessedOffset) * 0.5;
        onProgress({
          step:    "transcribing",
          current: chunkIndex,
          total:   Math.max(chunkIndex, Math.ceil(totalDuration / tier.chunkDurationSecs)),
          percent: calcPercent(sttPos),
          message: `음성 인식 중... (${chunkIndex}/${Math.ceil(totalDuration / tier.chunkDurationSecs)})`,
        });
      }

      const batchEndOffset = offset;

      if (batchRawSegments.length === 0 || translationSkipped) continue;

      // ── Phase C: Merge into sentences (batch-local, no cross-batch)
      // Each batch is merged independently to avoid invalidating
      // prior translations. Sentences split at batch boundaries
      // appear as short fragments — acceptable trade-off for safety.
      const batchSentences = mergeSegmentsIntoSentences(batchRawSegments);
      if (batchSentences.length === 0) continue;

      const batchInput = batchSentences.map(seg => ({
        start:      seg.startTime,
        end:        seg.endTime,
        text:       seg.text,
        translated: "",
      }));

      // ── Phase D: Release Whisper, translate ───────────────────────
      await releaseWhisper();
      whisperLoaded = false;

      // [THERMAL-OPT-V4] No per-batch reload. isGemmaLoaded() is authoritative.
      if (!translationSkipped) { // [THERMAL-OPT-V4]
        if (isCancelled()) {
          try { await forceUnloadGemma(); } catch {} // [THERMAL-OPT-V4]
          setGemmaKeepLoaded(false); // [THERMAL-OPT-V4]
          return { subtitles: [], translationSkipped: false };
        }
        if (!isGemmaLoaded() && !translationSkipped) { // [THERMAL-OPT-V4]
          setGemmaKeepLoaded(true); // [THERMAL-OPT-V4]
          try { // [THERMAL-OPT-V4]
            await loadGemma(); // [THERMAL-OPT-V4]
            llamaContextIsLoaded = true; // [THERMAL-OPT-V4]
          } catch { // [THERMAL-OPT-V4]
            translationSkipped = true; // [THERMAL-OPT-V4]
            setGemmaKeepLoaded(false); // [THERMAL-OPT-V4]
            llamaContextIsLoaded = false; // [THERMAL-OPT-V4]
          } // [THERMAL-OPT-V4]
        } // [THERMAL-OPT-V4]
      } // [THERMAL-OPT-V4]

      // Thermal cooldown before Gemma
      const cooldownMs: Record<string, number> = thermalProtection
        ? { nominal: 1000, elevated: 2200, critical: 3500 }
        : { nominal: 400,  elevated: 400,  critical: 400  };
      const cooldown = cooldownMs[thermal.getTier().name] ?? 800;
      if (cooldown > 0) await sleep(cooldown);

      if (isCancelled()) {
        try { await forceUnloadGemma(); } catch {} // [THERMAL-OPT-V4]
        setGemmaKeepLoaded(false); // [THERMAL-OPT-V4]
        return { subtitles: [], translationSkipped: false };
      }

      // [THERMAL-OPT-V4] Separate the Whisper spike from the Gemma spike.
      if (!translationSkipped) { // [THERMAL-OPT-V4]
        const preTier = thermal.getTier(); // [THERMAL-OPT-V4]
        if (preTier.name !== "nominal") { // [THERMAL-OPT-V4]
          const preIdle = preTier.name === "critical" ? 1500 : 700; // [THERMAL-OPT-V4]
          console.log(`[THERMAL-OPT-V4] Pre-translation idle ${preIdle}ms (tier: ${preTier.name})`); // [THERMAL-OPT-V4]
          await sleep(preIdle); // [THERMAL-OPT-V4]
        } // [THERMAL-OPT-V4]
      } // [THERMAL-OPT-V4]

      console.log(
        `[VideoProcessor] batch ${batchIndex}: ` +
        `translating ${batchInput.length} sentences`,
      );

      // Batch-specific checkpoint key prevents cross-batch collision
      const batchCheckpointKey = `${videoUri}__batch_${batchIndex}`;

      const batchTranslated = await translateSegments(
        batchInput,
        (completed, total) => {
          if (isCancelled()) return;

          const batchFraction = total > 0 ? completed / total : 0;

          // Translation credit: from fullyProcessedOffset, advance through
          // the batch proportionally. At batchFraction=0 this equals the
          // STT end position (no jump). At batchFraction=1 this equals
          // batchEndOffset (fully done).
          // STT already earned 50% credit for this range; translation
          // earns the remaining 50%, so we interpolate from midpoint.
          const batchMid = fullyProcessedOffset +
            (batchEndOffset - fullyProcessedOffset) * 0.5;
          const translatePos = batchMid +
            batchFraction * (batchEndOffset - batchMid);

          onProgress({
            step: 'translating',
            current: allTranslated.length + completed,
            total: Math.max(allTranslated.length + total, 1),
            percent: calcPercent(translatePos),
            message: `번역 중... (배치 ${batchIndex}, ${completed}/${total})`,
          });
        },
        batchCheckpointKey,
        langName,
      );

      fullyProcessedOffset = batchEndOffset;

      if (isCancelled()) {
        try { await forceUnloadGemma(); } catch {} // [THERMAL-OPT-V4]
        setGemmaKeepLoaded(false); // [THERMAL-OPT-V4]
        return { subtitles: [], translationSkipped: false };
      }

      const batchSubtitles: SubtitleSegment[] = batchTranslated
        .filter(seg => seg.translated && seg.translated.trim().length > 5)
        .map(seg => ({
          id:         makeStableSubtitleId(seg.start, seg.end),
          startTime:  seg.start,
          endTime:    seg.end,
          original:   seg.text,
          translated: seg.translated,
        }));

      allTranslated.push(...batchSubtitles);

      // ── Early playback: fires once after first sufficient batch ───
      if (!earlyPlaybackFired && onEarlyPlaybackReady) {
        const threshold = getEarlyPlaybackThreshold(totalDuration);
        const sorted    = [...allTranslated].sort(
          (a, b) => a.startTime - b.startTime,
        );

        // Build contiguous block from t=0.
        // Gap tolerance: EARLY_PLAYBACK_MAX_GAP_S (4s) to handle
        // natural speech pauses without breaking the block.
        // Coverage = sum of individual segment durations (not
        // wall-clock span) so gaps don't inflate the count.
        const contiguous: SubtitleSegment[] = [];
        let   totalCoverage = 0;
        for (let i = 0; i < sorted.length; i++) {
          if (i === 0) {
            contiguous.push(sorted[i]);
            totalCoverage += sorted[i].endTime - sorted[i].startTime;
          } else {
            const gap = sorted[i].startTime - sorted[i - 1].endTime;
            if (gap > EARLY_PLAYBACK_MAX_GAP_S) break;
            contiguous.push(sorted[i]);
            totalCoverage += sorted[i].endTime - sorted[i].startTime;
          }
        }

        if (totalCoverage >= threshold) {
          earlyPlaybackFired   = true;
          lastEmittedEndTime   =
            contiguous[contiguous.length - 1].endTime;
          onEarlyPlaybackReady(contiguous);
          console.log(
            `[VideoProcessor] Early playback fired: ` +
            `${contiguous.length} subs, ` +
            `coverage=${Math.round(totalCoverage)}s`,
          );
        }
      }

      // ── Streaming append for batches after early playback ─────────
      if (earlyPlaybackFired && onPartialUpdate) {
        const newSegs = batchSubtitles.filter(
          s => s.startTime >= lastEmittedEndTime,
        );
        if (newSegs.length > 0) {
          lastEmittedEndTime = newSegs[newSegs.length - 1].endTime;
          onPartialUpdate(newSegs);
          console.log(
            `[VideoProcessor] Append: ${newSegs.length} new subs`,
          );
        }
      }

      // [THERMAL-OPT-V4] Post-translation: check streak, then idle. Unload only on 3x critical.
      if (!translationSkipped) { // [THERMAL-OPT-V4]
        const postTier = thermal.getTier(); // [THERMAL-OPT-V4]
        const postTierLevel = postTier.name === "critical" ? 2 // [THERMAL-OPT-V4]
          : postTier.name === "elevated" ? 1 : 0; // [THERMAL-OPT-V4]
        const didUnload = await reportThermalAndMaybeUnload(postTierLevel); // [THERMAL-OPT-V4]
        if (didUnload) { // [THERMAL-OPT-V4]
          llamaContextIsLoaded = false; // [THERMAL-OPT-V4]
          await sleep(3000); // [THERMAL-OPT-V4]
        } else { // [THERMAL-OPT-V4]
          await idleBetweenBatches(postTier.name as "nominal" | "elevated" | "critical"); // [THERMAL-OPT-V4]
        } // [THERMAL-OPT-V4]
      } // [THERMAL-OPT-V4]
    }

    // ── Step 4: Stats and cleanup ───────────────────────────────────
    const totalChunks = chunkIndex;
    const skipRate    = totalChunks > 0 ? skippedChunks / totalChunks : 0;

    if (silentChunks > 0) {
      console.log(
        `[VideoProcessor] ${silentChunks}/${totalChunks} silent — normal`,
      );
    }
    if (skipRate >= SKIP_RATE_WARN_THRESHOLD) {
      console.warn(
        `[VideoProcessor] high skip rate: ` +
        `${skippedChunks}/${totalChunks} ` +
        `(${Math.round(skipRate * 100)}%)`,
      );
    }

    if (allTranslated.length === 0 && !translationSkipped) {
      try { await forceUnloadGemma(); } catch {} // [THERMAL-OPT-V4]
      onProgress({
        step: "done", current: 0, total: 0,
        percent: 100,
        message: "인식 결과 없음 — 파일을 확인하세요.",
      });
      return { subtitles: [], translationSkipped: true };
    }

    try { if (!translationSkipped) await forceUnloadGemma(); } catch {} // [THERMAL-OPT-V4]

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // ── Step 5: Final assembly ──────────────────────────────────────
    const subtitles = [...allTranslated].sort(
      (a, b) => a.startTime - b.startTime,
    );

    onProgress({
      step:    "done",
      current: subtitles.length,
      total:   subtitles.length,
      percent: 100,
      message: translationSkipped
        ? "번역 모델 없음 — 원문만 표시"
        : "완료! 재생을 시작합니다...",
    });

    return { subtitles, translationSkipped };

  } finally {
    setGemmaKeepLoaded(false); // [THERMAL-OPT-V4]
    try { await forceUnloadGemma(); } catch {} // [THERMAL-OPT-V4]
    thermal.dispose();
    await clearChunkDir();
  }
}