// @ts-ignore
import { initWhisper, WhisperContext } from "whisper.rn";

export interface TranscribeSegment {
  startTime: number;
  endTime: number;
  text: string;
  language: string;
}

let whisperContext: WhisperContext | null = null;
let loadedModelPath: string | null = null;
let transcribeQueue: Promise<void> = Promise.resolve();
let _interChunkDelayMs = 800;

export function setInterChunkDelay(ms: number): void {
  _interChunkDelayMs = ms;
}

export async function loadModel(modelPath: string): Promise<void> {
  if (loadedModelPath === modelPath && whisperContext !== null) return;
  await releaseModel();
  whisperContext = await initWhisper({ filePath: modelPath });
  loadedModelPath = modelPath;
}

export async function releaseModel(): Promise<void> {
  if (whisperContext) {
    await whisperContext.release();
    whisperContext = null;
    loadedModelPath = null;
  }
  // Always reset queue regardless of whether a context existed.
  // Prevents stale tasks from a previous session blocking the next load.
  transcribeQueue = Promise.resolve();
}

export function transcribeChunkSegmented(
  chunkPath: string,
  chunkStartTime: number,
  sourceLanguage: string = "auto"
): Promise<TranscribeSegment[]> {
  return new Promise<TranscribeSegment[]>((resolve, reject) => {
    transcribeQueue = transcribeQueue.then(async () => {
      const delayMs = _interChunkDelayMs; // snapshot at task-start time
      try {
        const result = await _doTranscribeSegmented(chunkPath, chunkStartTime, sourceLanguage);
        await new Promise<void>(r => setTimeout(r, delayMs)); // delay only on success
        resolve(result);
      } catch (e) {
        reject(e); // skip delay on failure — fast error propagation
      }
      // This .then() callback never throws — queue chain stays alive after failures.
    });
  });
}

export function isModelLoaded(): boolean {
  return whisperContext !== null;
}

/**
 * 문장 부호 기준으로 텍스트를 분할.
 * 핵심: 문장 부호 없이 끝나는 마지막 조각도 반드시 포함.
 */
function splitIntoSentences(text: string): string[] {
  const results: string[] = [];
  // 문장 부호로 끝나는 덩어리 추출
  const withPunct = text.match(/[^.!?]+[.!?]+/g) ?? [];
  // 위에서 매칭된 전체 길이
  const matched = withPunct.join("");
  // 문장 부호 없이 남은 꼬리 (예: "The Sounds of Glass had me from its")
  const tail = text.slice(matched.length).trim();

  for (const s of withPunct) {
    const trimmed = s.trim();
    if (trimmed.length > 0) results.push(trimmed);
  }
  // 꼬리 부분도 버리지 않고 추가
  if (tail.length > 0) results.push(tail);

  return results;
}

function mergeShortSegments(segments: TranscribeSegment[]): TranscribeSegment[] {
  if (segments.length === 0) return [];

  const merged: TranscribeSegment[] = [];
  let current: TranscribeSegment = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const duration = seg.endTime - seg.startTime;
    const isTooShort = duration < 0.8;
    const isTooFewChars = seg.text.trim().length < 3;
    const currentDuration = current.endTime - current.startTime;

    if ((isTooShort || isTooFewChars) && currentDuration < 8) {
      current.endTime = seg.endTime;
      current.text = current.text + " " + seg.text.trim();
    } else {
      merged.push(current);
      current = { ...seg };
    }
  }
  merged.push(current);

  // 문장 단위 분할
  const result: TranscribeSegment[] = [];
  for (const seg of merged) {
    const duration = seg.endTime - seg.startTime;
    const sentences = splitIntoSentences(seg.text);

    // 문장이 1개 이하거나 너무 짧으면 통으로
    if (sentences.length <= 1 || duration < 1.5) {
      result.push(seg);
      continue;
    }

    // 글자 수 비례로 시간 분배
    const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
    let cursor = seg.startTime;
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const sentDuration = (sentence.length / totalChars) * duration;
      const isLast = i === sentences.length - 1;
      result.push({
        startTime: cursor,
        endTime: isLast ? seg.endTime : cursor + sentDuration,
        text: sentence.trim(),
        language: seg.language,
      });
      cursor += sentDuration;
    }
  }

  return result.filter((s) => s.text.trim().length > 0);
}

async function _doTranscribeSegmented(
  chunkPath: string,
  chunkStartTime: number,
  sourceLanguage: string
): Promise<TranscribeSegment[]> {
  if (!whisperContext) {
    throw new Error("Whisper model not loaded. Please download a model first.");
  }

  const options =
    sourceLanguage === "auto"
      ? { language: undefined }
      : { language: sourceLanguage };

  const { promise } = (whisperContext as any).transcribe(chunkPath, {
    ...options,
    noSpeechThold: 0.6,
    wordThold: 0.01,
  });
  const result = await promise;

  const detectedLang: string = result?.language || sourceLanguage;

  console.log("[WHISPER] transcription result:", JSON.stringify(result));

  if (result?.segments?.length) {
    const rawSegments: TranscribeSegment[] = result.segments
      .filter((s: any) => s.text?.trim())
      .map((s: any) => ({
        startTime: chunkStartTime + s.t0 / 100,
        endTime:   chunkStartTime + s.t1 / 100,
        text:      (s.text as string).trim(),
        language:  detectedLang,
      }));

    return mergeShortSegments(rawSegments);
  }

  const text = result?.result?.trim() ?? "";
  if (!text) return [];
  return [
    {
      startTime: chunkStartTime,
      endTime:   chunkStartTime + 30,
      text,
      language:  detectedLang,
    },
  ];
}