import * as FileSystem from "expo-file-system/legacy";
import { SubtitleSegment } from "../store/usePlayerStore";
import { AudioChunk, clearChunkDir, getVideoDuration, extractSingleChunkAt } from "./audioChunker";
import { transcribeChunkSegmented, releaseModel as releaseWhisper } from "./whisperService";
import { loadModel as loadGemma, unloadModel as unloadGemma, translateSegments } from "./gemmaTranslationService";
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

const BAND_EXTRACT_END    = 10;
const BAND_TRANSCRIBE_END = 90;
const BAND_TRANSLATE_END  = 99;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SENTENCE_END       = /[.?!。]$/;
const MAX_MERGE_DURATION = 2.5;
const MAX_MERGE_CHARS    = 60;

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
    const combinedText     = current.text + " " + next.text;
    const combinedDuration = next.endTime - current.startTime;

    const wouldExceedDuration = combinedDuration > MAX_MERGE_DURATION;
    const wouldExceedChars    = combinedText.length > MAX_MERGE_CHARS;

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

export async function processVideo(
  videoUri: string,
  sourceLanguage: string,
  targetLanguage: string,
  onProgress: (p: ProcessingProgress) => void,
  isCancelled: () => boolean,
): Promise<ProcessingResult> {
  // Thermal controller created OUTSIDE try so dispose() in finally always runs.
  const thermal = createThermalController();
  try {
    // ── Step 1: Duration probe ────────────────────────────────────────────────
    onProgress({
      step: "extracting", current: 0, total: 0,
      percent: 5, message: "오디오 추출 중...",
    });

    const totalDuration = await getVideoDuration(videoUri);
    if (totalDuration <= 0)
      throw new Error("오디오 트랙을 찾을 수 없습니다. mp4/mkv/mov 권장");

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // estimatedTotal fixed once from the initial tier — prevents the progress
    // counter from jumping as the tier adapts mid-run.
    const estimatedTotal = Math.ceil(
      totalDuration / thermal.getTier().chunkDurationSecs,
    );

    onProgress({
      step: "extracting", current: 0, total: estimatedTotal,
      percent: BAND_EXTRACT_END, message: "오디오 추출 중...",
    });

    // ── Step 2: Interleaved extract-then-transcribe loop ──────────────────────
    // Skip-rate threshold: if this fraction of chunks fail extraction, warn.
    const SKIP_RATE_WARN_THRESHOLD = 0.3;

    const rawSegments: RawSegment[] = [];
    let offset       = 0;
    let chunkIndex   = 0;
    let skippedChunks = 0;

    while (offset < totalDuration) {
      // ① cancel check — always before extraction
      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      // ② read tier at chunk boundary
      const tier     = thermal.getTier();
      const chunkDur = Math.min(tier.chunkDurationSecs, totalDuration - offset);

      // ③ extract one chunk — skip on failure, never abort the whole run
      let chunk: AudioChunk;
      try {
        chunk = await extractSingleChunkAt(videoUri, offset, chunkDur, chunkIndex);
      } catch (e) {
        console.warn(`[VideoProcessor] chunk ${chunkIndex} extraction failed, skipping:`, e);
        offset += chunkDur;
        chunkIndex++;
        skippedChunks++;
        onProgress({
          step: "transcribing", current: chunkIndex, total: estimatedTotal,
          percent: Math.round(
            BAND_EXTRACT_END +
            ((offset / totalDuration) * (BAND_TRANSCRIBE_END - BAND_EXTRACT_END)),
          ),
          message: `음성 인식 중... (${chunkIndex}/${estimatedTotal})`,
        });
        continue;
      }

      // ④ cancel check after extraction, before heavy inference
      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      // ⑤ transcribe — measure wall time of inference only
      const t0   = Date.now();
      const segs = await transcribeChunkSegmented(
        chunk.filePath, chunk.startTime, sourceLanguage,
      );
      thermal.reportTranscriptionTime(Date.now() - t0, chunkDur);

      rawSegments.push(...segs);
      offset += chunkDur;
      chunkIndex++;

      // ⑥ delete chunk file immediately; clearChunkDir() in finally handles stragglers
      FileSystem.deleteAsync(chunk.filePath, { idempotent: true }).catch(
        (e) => console.warn("[VideoProcessor] chunk delete failed:", e),
      );

      // ⑦ progress update
      onProgress({
        step: "transcribing", current: chunkIndex, total: estimatedTotal,
        percent: Math.round(
          BAND_EXTRACT_END +
          ((offset / totalDuration) * (BAND_TRANSCRIBE_END - BAND_EXTRACT_END)),
        ),
        message: `음성 인식 중... (${chunkIndex}/${estimatedTotal})`,
      });
    }

    // Post-loop: evaluate skip rate
    const skipRate = chunkIndex > 0 ? skippedChunks / chunkIndex : 0;
    if (skipRate >= SKIP_RATE_WARN_THRESHOLD) {
      console.warn(
        `[VideoProcessor] high skip rate: ${skippedChunks}/${chunkIndex} chunks failed` +
        ` (${Math.round(skipRate * 100)}%) — translation will be skipped`,
      );
    }

    if (rawSegments.length === 0) {
      onProgress({
        step: "done", current: 0, total: 0,
        percent: 100, message: "인식 결과 없음 — 파일을 확인하세요.",
      });
      return { subtitles: [], translationSkipped: true };
    }

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    const sentences = mergeSegmentsIntoSentences(rawSegments);

    // ── Step 3: Translate ─────────────────────────────────────────────────────
    const gemmaPath = await getLocalModelPath();
    let translationSkipped = false;

    const translationInput = sentences.map((seg) => ({
      start:      seg.startTime,
      end:        seg.endTime,
      text:       seg.text,
      translated: "",
    }));

    let translated = translationInput;

    if (!gemmaPath) {
      console.warn("[TRANSLATE] Gemma model not downloaded — skipping translation");
      translationSkipped = true;
    } else {
      onProgress({ step: "unloading", current: 0, total: 0, percent: 91, message: "Whisper 언로드 중..." });
      await releaseWhisper();

      onProgress({ step: "unloading", current: 0, total: 0, percent: 93, message: "메모리 안정화 대기 중..." });

      // Tier-aware cooldown replaces the hardcoded sleep(2000)
      const cooldownMs: Record<string, number> = {
        nominal:  1000,
        elevated: 2500,
        critical: 4000,
      };
      await sleep(cooldownMs[thermal.getTier().name] ?? 2000);

      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      onProgress({ step: "translating", current: 0, total: sentences.length, percent: 94, message: "Gemma 모델 로드 중..." });
      await loadGemma();

      const langMeta = getLanguageByCode(targetLanguage);
      const langName = langMeta?.name ?? targetLanguage;

      console.log("[TRANSLATE] calling translation for segments:", translationInput.length);
      console.log("[TRANSLATE] target language name:", langName);

      try {
        translated = await translateSegments(
          translationInput,
          (completed, total) => {
            const percent = Math.round(
              94 + ((completed / total) * (BAND_TRANSLATE_END - 94)),
            );
            onProgress({
              step: "translating", current: completed, total, percent,
              message: `번역 중... (${completed}/${total})`,
            });
          },
          videoUri,
          langName,
        );
      } finally {
        await unloadGemma();
      }
    }

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // ── Step 4: Assemble subtitles ────────────────────────────────────────────
    const subtitles: SubtitleSegment[] = sentences.map((seg, i) => ({
      id:         `sub_${i}_${Math.round(seg.startTime * 1000)}`,
      startTime:  seg.startTime,
      endTime:    seg.endTime,
      original:   seg.text,
      translated: translated[i]?.translated ?? "",
    }));

    onProgress({
      step: "done",
      current: subtitles.length,
      total:   subtitles.length,
      percent: 100,
      message: translationSkipped
        ? "번역 모델 없음 — 원문만 표시"
        : "완료! 재생을 시작합니다...",
    });

    return { subtitles, translationSkipped };
  } finally {
    thermal.dispose();
    await clearChunkDir();
  }
}
