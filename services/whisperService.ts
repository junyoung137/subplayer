// @ts-ignore - whisper.rn does not ship TypeScript declarations in this version
import { initWhisper, WhisperContext } from "whisper.rn";

/** A single subtitle segment returned by segmented transcription. */
export interface TranscribeSegment {
  /** Absolute start time in seconds (chunk offset + whisper t0). */
  startTime: number;
  /** Absolute end time in seconds (chunk offset + whisper t1). */
  endTime: number;
  text: string;
  language: string;
}

let whisperContext: WhisperContext | null = null;
let loadedModelPath: string | null = null;
// Serialisation queue: whisper.rn throws if transcribe() is called concurrently.
let transcribeQueue: Promise<unknown> = Promise.resolve(null);

/**
 * Load Whisper model from local file. Reuses context if same model is already loaded.
 */
export async function loadModel(modelPath: string): Promise<void> {
  if (loadedModelPath === modelPath && whisperContext !== null) {
    return;
  }
  await releaseModel();
  whisperContext = await initWhisper({ filePath: modelPath });
  loadedModelPath = modelPath;
}

/**
 * Release the current Whisper model from memory.
 */
export async function releaseModel(): Promise<void> {
  if (whisperContext) {
    await whisperContext.release();
    whisperContext = null;
    loadedModelPath = null;
    transcribeQueue = Promise.resolve(null);
  }
}

/**
 * Transcribe a WAV chunk and return fine-grained segments with absolute timestamps.
 * @param chunkStartTime  The start time of this chunk within the original video (seconds).
 */
export function transcribeChunkSegmented(
  chunkPath: string,
  chunkStartTime: number,
  sourceLanguage: string = "auto"
): Promise<TranscribeSegment[]> {
  const result = transcribeQueue.then(() =>
    _doTranscribeSegmented(chunkPath, chunkStartTime, sourceLanguage)
  );
  transcribeQueue = result;
  return result as Promise<TranscribeSegment[]>;
}

export function isModelLoaded(): boolean {
  return whisperContext !== null;
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
    maxLen: 1,
    tokenTimestamps: true,
  });
  const result = await promise;

  const detectedLang: string = result?.language || sourceLanguage;

  console.log("[WHISPER] transcription result:", JSON.stringify(result));

  // whisper.rn segments use t0/t1 in centiseconds relative to the chunk.
  if (result?.segments?.length) {
    return result.segments
      .filter((s: any) => s.text?.trim())
      .map((s: any) => ({
        startTime: chunkStartTime + s.t0 / 100,
        endTime:   chunkStartTime + s.t1 / 100,
        text:      (s.text as string).trim(),
        language:  detectedLang,
      }));
  }

  // Fallback: treat whole chunk as single segment.
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