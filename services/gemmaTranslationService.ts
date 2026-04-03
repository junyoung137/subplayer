import { initLlama, LlamaContext } from "llama.rn";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TranslationSegment {
  start: number;
  end: number;
  text: string;
  translated: string;
}

interface Checkpoint {
  completedSegments: TranslationSegment[];
  lastBatchIndex: number;
  properNouns: Record<string, string>;
  totalBatches: number;
  timestamp: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_PATH         = FileSystem.documentDirectory + "gemma-models/gemma-3n-e2b-q4.gguf";
const BATCH_SIZE         = 20;
const SLEEP_BETWEEN_MS   = 800;
const SLEEP_THERMAL_MS   = 3000;
const THERMAL_EVERY_N    = 5;
const CHECKPOINT_TTL_MS  = 24 * 60 * 60 * 1000;
const PROPER_NOUN_MIN_COUNT = 3;

// ── Module-level state ────────────────────────────────────────────────────────

let llamaContext: LlamaContext | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function checkpointKey(videoHash: string) { return `gemma_checkpoint_${videoHash}`; }
function properNounKey(videoHash: string) { return `proper_nouns_${videoHash}`; }

// ── Model lifecycle ───────────────────────────────────────────────────────────

export async function loadModel(
  onProgress?: (fraction: number) => void
): Promise<void> {
  if (llamaContext) return;

  const info = await FileSystem.getInfoAsync(MODEL_PATH);
  if (!info.exists) {
    throw new Error("Gemma 모델 파일을 찾을 수 없습니다. 먼저 다운로드해 주세요.");
  }

  const modelPath = MODEL_PATH.startsWith("file://")
    ? MODEL_PATH.slice(7)
    : MODEL_PATH;

  try {
    llamaContext = await initLlama(
      {
        model:        modelPath,
        n_threads:    4,
        n_gpu_layers: 0,
        n_ctx:        4096,
        use_mlock:    true,
      },
      // initLlama의 두 번째 인자: 진행률 콜백 (llama.rn 0.x API)
      onProgress
        ? (progress: number) => onProgress(progress / 100)
        : undefined
    );
    console.log("[Gemma] Model loaded via llama.rn initLlama.");
  } catch (e) {
    llamaContext = null;
    throw new Error(`Gemma 모델 로드 실패: ${(e as Error).message}`);
  }
}

export async function unloadModel(): Promise<void> {
  if (!llamaContext) return;
  try {
    await llamaContext.release();
  } catch (e) {
    console.warn("[Gemma] release error:", e);
  }
  llamaContext = null;
  console.log("[Gemma] Model unloaded.");
}

// ── Proper-noun helpers ───────────────────────────────────────────────────────

function extractProperNounCandidates(segments: TranslationSegment[]): string[] {
  const counts = new Map<string, number>();
  for (const seg of segments) {
    const words = seg.text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
    for (const w of words) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= PROPER_NOUN_MIN_COUNT)
    .map(([word]) => word);
}

async function transliterateProperNouns(
  nouns: string[]
): Promise<Record<string, string>> {
  if (!llamaContext || nouns.length === 0) return {};

  const userMsg = nouns.join("\n");

  const result = await llamaContext.completion({
    messages: [
      {
        role: "system",
        content:
          "Transliterate each English proper noun (name or place) to Korean phonetically.\n" +
          "Output ONLY lines in the format 'English=Korean'. No explanations.",
      },
      { role: "user", content: userMsg },
    ],
    n_predict:   nouns.length * 20,
    temperature: 0.1,
    top_p:       0.9,
    stop:        ["</s>", "<end_of_turn>", "<|end|>"],
  });

  const dict: Record<string, string> = {};
  for (const line of result.text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const src = line.slice(0, eq).trim();
    const tgt = line.slice(eq + 1).trim();
    if (src && tgt) dict[src] = tgt;
  }
  return dict;
}

async function buildProperNounDict(
  segments: TranslationSegment[],
  videoHash: string
): Promise<Record<string, string>> {
  const stored = await AsyncStorage.getItem(properNounKey(videoHash));
  const existing: Record<string, string> = stored ? JSON.parse(stored) : {};

  const candidates = extractProperNounCandidates(segments);
  const merged: Record<string, string> = { ...existing };
  for (const noun of candidates) {
    if (!(noun in merged)) merged[noun] = "";
  }

  const unmapped = Object.entries(merged)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (unmapped.length > 0) {
    const fresh = await transliterateProperNouns(unmapped);
    for (const [src, tgt] of Object.entries(fresh)) {
      merged[src] = tgt;
    }
  }

  await AsyncStorage.setItem(properNounKey(videoHash), JSON.stringify(merged));
  return merged;
}

function formatNounHint(dict: Record<string, string>): string {
  const pairs = Object.entries(dict)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return pairs ? `\nKnown proper nouns: ${pairs}` : "";
}

// ── Text cleaning ─────────────────────────────────────────────────────────────

function cleanWhisperText(text: string): string {
  return text
    .replace(/\b([a-zA-Z]{1,3})\s+([a-zA-Z]{1,3})\s+([a-zA-Z]{1,4})\b/g,
      (_, a, b, c) => a + b + c)
    .replace(/\b([a-zA-Z]{1,3})\s+([a-zA-Z]{2,})\b/g,
      (_, a, b) => a + b)
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildBatchMessage(batch: TranslationSegment[], batchOffset: number): string {
  return batch
    .map((seg, i) => {
      const cleaned = cleanWhisperText(seg.text);
      if (cleaned !== seg.text) {
        console.log("[TRANSLATE] cleaned:", cleaned, "← from:", seg.text);
      }
      return `${batchOffset + i + 1}. ${cleaned}`;
    })
    .join("\n");
}

function parseBatchResponse(
  response: string,
  batch: TranslationSegment[],
  batchOffset: number
): string[] {
  const translationMap = new Map<number, string>();
  for (const line of response.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+)[.)]\s*(.+)$/);
    if (!m) continue;
    translationMap.set(parseInt(m[1], 10), m[2].trim());
  }

  return batch.map((seg, i) => {
    const expectedNumber = batchOffset + i + 1;
    const translation = translationMap.get(expectedNumber);
    if (translation === undefined) {
      console.log("[TRANSLATE] missing translation for segment #", expectedNumber);
      return seg.text;
    }
    return translation;
  });
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────

async function loadCheckpoint(videoHash: string): Promise<Checkpoint | null> {
  try {
    const raw = await AsyncStorage.getItem(checkpointKey(videoHash));
    if (!raw) return null;
    const cp: Checkpoint = JSON.parse(raw);
    if (Date.now() - cp.timestamp >= CHECKPOINT_TTL_MS) {
      await AsyncStorage.removeItem(checkpointKey(videoHash));
      return null;
    }
    return cp;
  } catch {
    return null;
  }
}

async function saveCheckpoint(
  videoHash: string,
  cp: Omit<Checkpoint, "timestamp">
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      checkpointKey(videoHash),
      JSON.stringify({ ...cp, timestamp: Date.now() })
    );
  } catch (e) {
    console.warn("[Gemma] Checkpoint save failed:", e);
  }
}

async function deleteCheckpoint(videoHash: string): Promise<void> {
  await AsyncStorage.removeItem(checkpointKey(videoHash));
}

// ── Main translation function ─────────────────────────────────────────────────

export async function translateSegments(
  segments: TranslationSegment[],
  onProgress?: (completed: number, total: number) => void,
  videoHash: string = "default"
): Promise<TranslationSegment[]> {
  console.log("[TRANSLATE] input segments count:", segments.length);
  console.log("[TRANSLATE] first segment:", segments[0]);

  if (!llamaContext) {
    throw new Error("모델이 로드되지 않았습니다. loadModel()을 먼저 호출하세요.");
  }

  const totalBatches = Math.ceil(segments.length / BATCH_SIZE);

  // Step A: 고유명사 사전 구축
  const properNouns = await buildProperNounDict(segments, videoHash);
  const nounHint    = formatNounHint(properNouns);
  console.log(`[Gemma] Proper nouns: ${Object.keys(properNouns).length} entries`);

  const systemPrompt =
    "You are a professional subtitle translator. " +
    "Translate each numbered line to Korean. " +
    "Output ONLY the translated lines with their numbers, nothing else. " +
    "Preserve timing and natural speech rhythm." +
    nounHint;

  // Step B: 체크포인트 복원
  const checkpoint = await loadCheckpoint(videoHash);
  let startBatch   = 0;
  let completed    = segments.map((seg) => ({ ...seg }));

  if (checkpoint) {
    startBatch = checkpoint.lastBatchIndex + 1;
    for (let i = 0; i < checkpoint.completedSegments.length; i++) {
      completed[i] = checkpoint.completedSegments[i];
    }
    console.log(`[Gemma] Resuming from batch ${startBatch} / ${totalBatches}`);
  }

  // Step C: 배치 번역
  try {
    for (let batchIdx = startBatch; batchIdx < totalBatches; batchIdx++) {
      const offset  = batchIdx * BATCH_SIZE;
      const batch   = segments.slice(offset, offset + BATCH_SIZE);
      const userMsg = buildBatchMessage(batch, offset);

      // ✅ 올바른 llama.rn API: context.completion()
      const result = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMsg       },
        ],
        n_predict:   batch.length * 80,
        temperature: 0.1,
        top_p:       0.9,
        stop:        ["</s>", "<end_of_turn>", "<|end|>"],
      });

      const translations = parseBatchResponse(result.text, batch, offset);

      for (let i = 0; i < batch.length; i++) {
        completed[offset + i] = { ...batch[i], translated: translations[i] };
      }

      onProgress?.(offset + batch.length, segments.length);

      await saveCheckpoint(videoHash, {
        completedSegments: completed,
        lastBatchIndex:    batchIdx,
        properNouns,
        totalBatches,
      });

      const isLastBatch = batchIdx === totalBatches - 1;
      if (!isLastBatch) {
        const isThermalBoundary = (batchIdx + 1) % THERMAL_EVERY_N === 0;
        await sleep(isThermalBoundary ? SLEEP_THERMAL_MS : SLEEP_BETWEEN_MS);
      }
    }
  } catch (e) {
    console.error("[Gemma] Inference error, returning partial results:", e);
    return completed;
  }

  await deleteCheckpoint(videoHash);
  console.log(`[Gemma] Translation complete: ${completed.length} segments.`);
  console.log("[TRANSLATE] first result:", JSON.stringify(completed[0]));
  return completed;
}