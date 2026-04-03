import { SubtitleSegment } from "../store/usePlayerStore";
import { extractAndChunkAudio, clearChunkDir } from "./audioChunker";
import { transcribeChunkSegmented, releaseModel as releaseWhisper } from "./whisperService";
import { loadModel as loadGemma, unloadModel as unloadGemma, translateSegments } from "./gemmaTranslationService";
import { getLocalModelPath } from "./modelDownloadService";

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

const SENTENCE_END = /[.?!。]$/;
const MAX_MERGE_DURATION = 4.0;  // seconds
const MAX_MERGE_CHARS    = 80;

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

/**
 * Merge consecutive short Whisper segments into sentence-level groups so
 * subtitles display for a natural reading duration instead of flickering
 * word-by-word.
 *
 * A merge is flushed when any of these conditions is met:
 *   a) The accumulated text ends with sentence-ending punctuation (. ? ! 。)
 *   b) Adding the next segment would exceed MAX_MERGE_DURATION seconds
 *   c) Adding the next segment would exceed MAX_MERGE_CHARS characters
 */
function mergeSegmentsIntoSentences(segments: RawSegment[]): RawSegment[] {
  if (segments.length === 0) return [];

  const merged: RawSegment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const combinedText = current.text + " " + next.text;
    const combinedDuration = next.endTime - current.startTime;

    const wouldExceedDuration = combinedDuration > MAX_MERGE_DURATION;
    const wouldExceedChars    = combinedText.length > MAX_MERGE_CHARS;

    if (wouldExceedDuration || wouldExceedChars) {
      // Flush current group and start a new one.
      merged.push({ ...current, text: cleanSegmentText(current.text) });
      current = { ...next };
    } else {
      // Absorb next segment into the current group.
      current = {
        startTime: current.startTime,
        endTime:   next.endTime,
        text:      combinedText,
        language:  current.language,
      };

      // Flush after absorbing if the combined text forms a complete sentence.
      if (SENTENCE_END.test(current.text.trimEnd())) {
        merged.push({ ...current, text: cleanSegmentText(current.text) });
        // Advance to the segment after next (loop will i++ again).
        if (i + 1 < segments.length) {
          current = { ...segments[++i] };
        } else {
          // Nothing left — return early to avoid the final push below.
          return merged;
        }
      }
    }
  }

  // Push whatever is still accumulating at end of input.
  merged.push({ ...current, text: cleanSegmentText(current.text) });
  return merged;
}

/**
 * Full offline pipeline: extract audio → transcribe all chunks → translate all segments.
 *
 * @param videoUri        Local file URI of the video.
 * @param sourceLanguage  BCP-47 language code or "auto".
 * @param targetLanguage  BCP-47 language code for translation output.
 * @param onProgress      Called on every meaningful state change.
 * @param isCancelled     Return true to abort the pipeline early.
 * @returns               ProcessingResult with subtitles and translation status.
 */
export async function processVideo(
  videoUri: string,
  sourceLanguage: string,
  targetLanguage: string,
  onProgress: (p: ProcessingProgress) => void,
  isCancelled: () => boolean
): Promise<ProcessingResult> {
  try {
    // ── Step 1: Extract audio as 30-second WAV chunks ─────────────────────
    // The native AudioChunker module has no progress callback, so we drive a
    // timer that walks the bar from 5 % up to just below BAND_EXTRACT_END
    // while the call is in flight, then snap to BAND_EXTRACT_END on completion.
    let extractPercent = 5;
    onProgress({ step: "extracting", current: 0, total: 0, percent: extractPercent, message: "오디오 추출 중..." });

    const extractTimer = setInterval(() => {
      // Creep toward (BAND_EXTRACT_END - 1) so the snap on completion is visible.
      if (extractPercent < BAND_EXTRACT_END - 1) {
        extractPercent += 1;
        onProgress({ step: "extracting", current: 0, total: 0, percent: extractPercent, message: "오디오 추출 중..." });
      }
    }, 800);

    let chunks: Awaited<ReturnType<typeof extractAndChunkAudio>>;
    try {
      chunks = await extractAndChunkAudio(videoUri, 30);
    } finally {
      clearInterval(extractTimer);
    }

    if (isCancelled()) return { subtitles: [], translationSkipped: false };
    if (chunks.length === 0) {
      throw new Error("오디오 추출에 실패했습니다. 파일 형식을 확인하세요.");
    }

    onProgress({ step: "extracting", current: chunks.length, total: chunks.length, percent: BAND_EXTRACT_END, message: "오디오 추출 중..." });

    // ── Step 2: Transcribe every chunk with Whisper ───────────────────────
    const rawSegments: Array<{ startTime: number; endTime: number; text: string; language: string }> = [];

    for (let i = 0; i < chunks.length; i++) {
      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      const percent = Math.round(
        BAND_EXTRACT_END + ((i / chunks.length) * (BAND_TRANSCRIBE_END - BAND_EXTRACT_END))
      );
      onProgress({
        step: "transcribing",
        current: i + 1,
        total: chunks.length,
        percent,
        message: `음성 인식 중... (${i + 1}/${chunks.length})`,
      });

      const segs = await transcribeChunkSegmented(chunks[i].filePath, chunks[i].startTime, sourceLanguage);
      rawSegments.push(...segs);
    }

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // ── Step 2.5: Merge short segments into sentence-level groups ─────────
    const sentences = mergeSegmentsIntoSentences(rawSegments);

    // ── Step 3: Translate segments with Gemma (on-device) ───────────────
    const gemmaPath = await getLocalModelPath();
    let translationSkipped = false;

    // Input shape expected by gemmaTranslationService
    const translationInput = sentences.map((seg) => ({
      start: seg.startTime,
      end:   seg.endTime,
      text:  seg.text,
      translated: "",
    }));

    let translated = translationInput;

    if (!gemmaPath) {
      console.warn('[TRANSLATE] Gemma model not downloaded — skipping translation');
      translationSkipped = true;
    } else {
      // Memory ordering: Whisper must be released before Gemma loads.
      onProgress({ step: "unloading", current: 0, total: 0, percent: 91, message: "Whisper 언로드 중..." });
      await releaseWhisper();

      onProgress({ step: "unloading", current: 0, total: 0, percent: 93, message: "메모리 안정화 대기 중..." });
      await sleep(2000);

      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      onProgress({ step: "translating", current: 0, total: sentences.length, percent: 94, message: "Gemma 모델 로드 중..." });
      await loadGemma();

      console.log('[TRANSLATE] calling translation for segments:', translationInput.length);

      try {
        translated = await translateSegments(
          translationInput,
          (completed, total) => {
            const percent = Math.round(
              94 + ((completed / total) * (BAND_TRANSLATE_END - 94))
            );
            onProgress({
              step: "translating",
              current: completed,
              total,
              percent,
              message: `번역 중... (${completed}/${total})`,
            });
          },
          videoUri
        );
      } finally {
        // Always unload Gemma, even on partial failure.
        await unloadGemma();
      }
    }

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // ── Step 4: Assemble final subtitle segments ──────────────────────────
    const subtitles: SubtitleSegment[] = sentences.map((seg, i) => ({
      id: `sub_${i}_${Math.round(seg.startTime * 1000)}`,
      startTime: seg.startTime,
      endTime:   seg.endTime,
      original:  seg.text,
      translated: translated[i]?.translated ?? "",
    }));

    onProgress({
      step: "done",
      current: subtitles.length,
      total: subtitles.length,
      percent: 100,
      message: translationSkipped
        ? "번역 모델 없음 — 원문만 표시"
        : "완료! 재생을 시작합니다...",
    });

    return { subtitles, translationSkipped };
  } finally {
    await clearChunkDir();
  }
}
