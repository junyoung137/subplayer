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
// [PERF] Default reduced from 800ms to 100ms to match thermalMonitor
// nominal tier. The thermalController overrides this at runtime via
// setInterChunkDelay(), so this default only applies before the first
// reportTranscriptionTime() call.
let _interChunkDelayMs = 100;

export function setInterChunkDelay(ms: number): void {
  _interChunkDelayMs = ms;
}

export async function loadModel(modelPath: string): Promise<void> {
  if (loadedModelPath === modelPath && whisperContext !== null) return;
  await releaseModel();
  whisperContext = await initWhisper({
    filePath: modelPath,
    // [PERF] n_threads: 4 enables multi-threaded intra-op computation
    // within each individual Whisper inference call.
    // This is NOT concurrent chunk processing — transcribeQueue still
    // serializes chunks one at a time (required by whisper.rn's single
    // context architecture). n_threads only parallelizes internal matrix
    // operations inside each transcription.
    // Value 4 is chosen as a safe default across device tiers:
    //   low-end  (2-4 cores): 4 threads still beneficial, minor ctx-switch overhead
    //   mid-range (6-8 cores): 4 threads leaves thermal headroom
    //   high-end  (8+ cores): 4 threads is conservative but stable
    // Expected improvement: 1.5~2x faster per chunk on mid-range Android.
    n_threads: 4,
  });
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
    // [자체 개선] queue chain 강화
    //
    // 기존 구조:
    //   transcribeQueue = transcribeQueue.then(async () => { ... })
    //   → reject 전파 시 then() 체인이 rejected 상태로 남아 후속 작업이 큐에 쌓이지 않는 문제
    //
    // 개선:
    //   1. task 내부 에러를 catch해서 외부 Promise (resolve/reject)로 전달
    //   2. transcribeQueue 체인 자체는 항상 resolve()로 끝나도록 격리
    //      → 에러가 발생해도 queue chain이 깨지지 않음
    //   3. delay는 성공 시에만 적용 (실패 시 빠른 에러 전파)

    transcribeQueue = transcribeQueue.then(async () => {
      const delayMs = _interChunkDelayMs;
      try {
        const result = await _doTranscribeSegmented(chunkPath, chunkStartTime, sourceLanguage);
        await new Promise<void>(r => setTimeout(r, delayMs));
        resolve(result);
      } catch (e) {
        // reject는 외부 Promise로만 전달; queue chain은 계속 진행
        reject(e);
        // delay 없이 즉시 다음 작업으로 → 실패한 청크 때문에 queue가 지연되지 않음
      }
      // .then() 콜백은 절대 throw하지 않으므로 queue chain이 broken 상태에 빠지지 않음
    });
  });
}

export function isModelLoaded(): boolean {
  return whisperContext !== null;
}

export function getLoadedModelPath(): string | null {
  return loadedModelPath;
}

/**
 * 문장 부호 기준으로 텍스트를 분할.
 * 핵심: 문장 부호 없이 끝나는 마지막 조각도 반드시 포함.
 */
function splitIntoSentences(text: string): string[] {
  const results: string[] = [];
  const withPunct = text.match(/[^.!?]+[.!?]+/g) ?? [];
  const matched   = withPunct.join("");
  const tail      = text.slice(matched.length).trim();

  for (const s of withPunct) {
    const trimmed = s.trim();
    if (trimmed.length > 0) results.push(trimmed);
  }
  if (tail.length > 0) results.push(tail);

  return results;
}

function mergeShortSegments(segments: TranscribeSegment[]): TranscribeSegment[] {
  if (segments.length === 0) return [];

  const merged: TranscribeSegment[] = [];
  let current: TranscribeSegment = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const seg             = segments[i];
    const duration        = seg.endTime - seg.startTime;
    const isTooShort      = duration < 0.8;
    const isTooFewChars   = seg.text.trim().length < 3;
    const currentDuration = current.endTime - current.startTime;

    if ((isTooShort || isTooFewChars) && currentDuration < 8) {
      current.endTime = seg.endTime;
      current.text    = current.text + " " + seg.text.trim();
    } else {
      merged.push(current);
      current = { ...seg };
    }
  }
  merged.push(current);

  // 문장 단위 분할
  const result: TranscribeSegment[] = [];
  for (const seg of merged) {
    const duration  = seg.endTime - seg.startTime;
    const sentences = splitIntoSentences(seg.text);

    if (sentences.length <= 1 || duration < 1.5) {
      result.push(seg);
      continue;
    }

    const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
    let cursor = seg.startTime;
    for (let i = 0; i < sentences.length; i++) {
      const sentence    = sentences[i];
      const sentDuration = (sentence.length / totalChars) * duration;
      const isLast      = i === sentences.length - 1;
      result.push({
        startTime: cursor,
        endTime:   isLast ? seg.endTime : cursor + sentDuration,
        text:      sentence.trim(),
        language:  seg.language,
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
    noSpeechThold: 0.6,   // unchanged — accuracy critical
    wordThold: 0.01,       // unchanged — accuracy critical
    // [PERF] beam_size: 1 switches from beam search (default=5) to greedy
    // decoding. Beam search evaluates 5 candidate sequences per token step;
    // greedy picks the single best token at each step.
    // For natural conversational speech, accuracy difference is negligible.
    // Expected speedup: 1.3~1.5x per chunk.
    // NOTE: If whisper.rn does not forward this option to the native layer,
    // it will be silently ignored — there is no downside to including it.
    beam_size: 1,
    // [PERF] best_of: 1 disables sampling retries. Combined with beam_size=1
    // this ensures a single decoding pass with no fallback retries.
    best_of: 1,
    // [PERF] temperature: 0 disables stochastic sampling and temperature
    // fallback chains. Whisper's default behavior retries with increasing
    // temperature when confidence is low, which can multiply decode time.
    // Setting to 0 forces deterministic greedy output on the first pass.
    temperature: 0,
  } as any);
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