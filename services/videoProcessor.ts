import { SubtitleSegment } from "../store/usePlayerStore";
import { extractAndChunkAudio, clearChunkDir } from "./audioChunker";
import { transcribeChunkSegmented, releaseModel as releaseWhisper } from "./whisperService";
import { loadModel as loadGemma, unloadModel as unloadGemma, translateSegments } from "./gemmaTranslationService";
import { getLocalModelPath } from "./modelDownloadService";
import { getLanguageByCode } from "../constants/languages";

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
const MAX_MERGE_DURATION = 2.5;  // seconds (4.0 → 2.5)
const MAX_MERGE_CHARS    = 60;   // chars   (80 → 60)

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
    const combinedText = current.text + " " + next.text;
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
  isCancelled: () => boolean
): Promise<ProcessingResult> {
  try {
    // ── Step 1: Extract audio ─────────────────────────────────────────────
    let extractPercent = 5;
    onProgress({ step: "extracting", current: 0, total: 0, percent: extractPercent, message: "오디오 추출 중..." });

    const extractTimer = setInterval(() => {
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

    // ── Step 2: Transcribe ────────────────────────────────────────────────
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

    const sentences = mergeSegmentsIntoSentences(rawSegments);

    // ── Step 3: Translate ─────────────────────────────────────────────────
    const gemmaPath = await getLocalModelPath();
    let translationSkipped = false;

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
      onProgress({ step: "unloading", current: 0, total: 0, percent: 91, message: "Whisper 언로드 중..." });
      await releaseWhisper();

      onProgress({ step: "unloading", current: 0, total: 0, percent: 93, message: "메모리 안정화 대기 중..." });
      await sleep(2000);

      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      onProgress({ step: "translating", current: 0, total: sentences.length, percent: 94, message: "Gemma 모델 로드 중..." });
      await loadGemma();

      // 언어 코드(ko) → 언어명(Korean) 변환
      const langMeta = getLanguageByCode(targetLanguage);
      const langName = langMeta?.name ?? targetLanguage;

      console.log('[TRANSLATE] calling translation for segments:', translationInput.length);
      console.log('[TRANSLATE] target language name:', langName);

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
          videoUri,
          langName  // ← "Korean", "Japanese" 등 언어명으로 전달
        );
      } finally {
        await unloadGemma();
      }
    }

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // ── Step 4: Assemble subtitles ────────────────────────────────────────
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