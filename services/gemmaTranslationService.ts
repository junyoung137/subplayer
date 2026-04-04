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
  /** 번역된 텍스트만 저장 (원본 세그먼트는 런타임에 병합) */
  translatedTexts: string[];
  lastBatchIndex: number;
  properNouns: Record<string, string>;
  totalBatches: number;
  timestamp: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_PATH            = FileSystem.documentDirectory + "gemma-models/gemma-3n-e2b-q4.gguf";
const BATCH_SIZE            = 15;
const SLEEP_BETWEEN_MS      = 800;
const SLEEP_THERMAL_MS      = 3000;
const THERMAL_EVERY_N       = 5;
const CHECKPOINT_TTL_MS     = 24 * 60 * 60 * 1000;
const PROPER_NOUN_MIN_COUNT = 3; // 2→3: 노이즈성 후보 감소

/**
 * 문장 첫 단어로만 등장할 수 있는 일반 영어 단어 목록.
 * 대문자로 시작하지만 고유명사가 아닌 케이스를 걸러냅니다.
 */
const COMMON_WORDS = new Set([
  "The","A","An","This","That","These","Those","It","He","She","We","They",
  "I","You","My","Your","His","Her","Its","Our","Their",
  "Is","Are","Was","Were","Be","Been","Being","Do","Does","Did",
  "Have","Has","Had","Will","Would","Could","Should","May","Might","Must",
  "And","But","Or","So","Yet","For","Nor",
  "In","On","At","To","Of","By","As","Up","If",
  "Not","No","Yes","Oh","Well","Now","Just","Here","There","When",
  "What","Which","Who","How","Why","Where","All","Both","Each",
  "Some","Any","Many","Much","More","Most","Other","Another","Such",
  "One","Two","Three","First","Second","Last","Next","New","Old",
  "Good","Great","Little","Large","Small","Big","Long","High","Own",
  "After","Before","While","Although","Because","Since","Until","Though",
  "With","Without","About","Above","Below","Between","Through","During",
]);

// ── Module-level state ────────────────────────────────────────────────────────

let llamaContext: LlamaContext | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function checkpointKey(videoHash: string) { return `gemma_checkpoint_v2_${videoHash}`; }
function properNounKey(videoHash: string) { return `proper_nouns_${videoHash}`; }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

// ── 고유명사 추출 ─────────────────────────────────────────────────────────────

/**
 * 고유명사 후보 추출 (2번 코드 가중치 로직 유지)
 *
 * - 문장 첫 단어: 0.5점 페널티
 * - 문장 중간 등장: 1.5배 가중치
 * - COMMON_WORDS 완전 제외
 * - MIN_COUNT=3으로 노이즈 감소
 */
function extractProperNounCandidates(segments: TranslationSegment[]): string[] {
  const stats = new Map<string, { mid: number; first: number }>();

  const sentenceStartPattern = /(?:^|[.!?]\s+)([A-Z][a-zA-Z]{2,})/g;
  const allUpperPattern      = /\b([A-Z][a-zA-Z]{2,})\b/g;

  for (const seg of segments) {
    const text = seg.text;

    const firstWords = new Set<string>();
    let m: RegExpExecArray | null;
    sentenceStartPattern.lastIndex = 0;
    while ((m = sentenceStartPattern.exec(text)) !== null) {
      firstWords.add(m[1]);
    }

    allUpperPattern.lastIndex = 0;
    while ((m = allUpperPattern.exec(text)) !== null) {
      const word = m[1];
      if (COMMON_WORDS.has(word)) continue;

      const isFirst = firstWords.has(word);
      const entry   = stats.get(word) ?? { mid: 0, first: 0 };
      if (isFirst) entry.first += 1;
      else         entry.mid   += 1;
      stats.set(word, entry);
    }
  }

  const result: string[] = [];
  for (const [word, { mid, first }] of stats) {
    const score = mid * 1.5 + first * 0.5;
    if (score >= PROPER_NOUN_MIN_COUNT) {
      result.push(word);
    }
  }
  return result;
}

// ── 고유명사 음역 ─────────────────────────────────────────────────────────────

async function transliterateProperNouns(
  nouns: string[],
  targetLanguage: string
): Promise<Record<string, string>> {
  if (!llamaContext || nouns.length === 0) return {};

  const langLabel = targetLanguage || "the target language";
  const userMsg   = nouns.join("\n");

  const result = await llamaContext.completion({
    messages: [
      {
        role: "system",
        content:
          `Transliterate or adapt each proper noun (name or place) into ${langLabel} phonetically or conventionally as used in ${langLabel} media/subtitles.\n` +
          "Output ONLY lines in the format 'English=Transliteration'. No explanations.",
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
  videoHash: string,
  targetLanguage: string
): Promise<Record<string, string>> {
  const stored   = await AsyncStorage.getItem(properNounKey(videoHash));
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
    const fresh = await transliterateProperNouns(unmapped, targetLanguage);
    for (const [src, tgt] of Object.entries(fresh)) {
      merged[src] = tgt;
    }
  }

  await AsyncStorage.setItem(properNounKey(videoHash), JSON.stringify(merged));
  return merged;
}

/**
 * [수정] 강제 규칙 제거 → 참고 힌트로 완화.
 * 기존: "use these EXACTLY and in full; NEVER mix..."
 * 변경: 단순 참고 형식 (k=v), LLM 자율 판단 허용
 */
function formatNounHint(dict: Record<string, string>): string {
  const pairs = Object.entries(dict)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return pairs ? `\nReference translations: ${pairs}` : "";
}

// ── 고유명사 후처리 — fullRegex 매칭만 유지 ───────────────────────────────────

interface CompiledNounPattern {
  src: string;
  tgt: string;
  /** 완전 단어 매칭용 (영문 원어가 그대로 남아있을 때만 교체) */
  fullRegex: RegExp;
}

let cachedPatterns: CompiledNounPattern[] | null = null;
let cachedDictKey: string = "";

/**
 * [수정] fragment 패턴 완전 제거.
 * fullRegex(완전 단어 매칭)만 유지하여 정상 번역어 오염 방지.
 *
 * fragment regex는 오탐률이 높아 정상 번역어를 덮어쓰는 사례가 많았음.
 * "영문 원어가 그대로 남아있는 경우"에만 교체하는 보수적 전략으로 변경.
 */
function buildPatterns(dict: Record<string, string>): CompiledNounPattern[] {
  const key = JSON.stringify(dict);
  if (cachedPatterns && cachedDictKey === key) return cachedPatterns;

  const patterns: CompiledNounPattern[] = [];

  for (const [src, tgt] of Object.entries(dict)) {
    if (!tgt) continue;

    const fullRegex = new RegExp(
      `(?<![\\wㄱ-ㅎㅏ-ㅣ가-힣])${escapeRegex(src)}(?![\\wㄱ-ㅎㅏ-ㅣ가-힣])`,
      "gi"
    );

    patterns.push({ src, tgt, fullRegex });
  }

  cachedPatterns = patterns;
  cachedDictKey  = key;
  return patterns;
}

/**
 * 번역 결과 후처리: 영문 원어가 그대로 남아있을 때만 교체.
 * fragment 교체 로직 제거로 정상 번역어 오염 없음.
 */
function applyProperNounFixes(
  text: string,
  patterns: CompiledNounPattern[]
): string {
  let result = text;

  for (const { tgt, fullRegex } of patterns) {
    fullRegex.lastIndex = 0;
    if (fullRegex.test(result)) {
      fullRegex.lastIndex = 0;
      result = result.replace(fullRegex, tgt);
    }
  }

  return result;
}

// ── Text cleaning ─────────────────────────────────────────────────────────────

function cleanWhisperText(text: string): string {
  return text.replace(/\s{2,}/g, " ").trim();
}

function buildBatchMessage(batch: TranslationSegment[], batchOffset: number): string {
  return batch
    .map((seg, i) => `${batchOffset + i + 1}. ${cleanWhisperText(seg.text)}`)
    .join("\n");
}

function parseBatchResponse(
  response: string,
  batch: TranslationSegment[],
  batchOffset: number,
  patterns: CompiledNounPattern[]
): string[] {
  const translationMap = new Map<number, string>();

  for (const line of response.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+)[.)]\s*(.+)$/);
    if (!m) continue;
    translationMap.set(parseInt(m[1], 10), m[2].trim());
  }

  return batch.map((seg, i) => {
    const expectedNumber = batchOffset + i + 1;
    const raw = translationMap.get(expectedNumber);
    if (!raw) {
      console.warn(`[TRANSLATE] missing translation for segment #${expectedNumber}`);
      return seg.text;
    }
    return applyProperNounFixes(raw, patterns);
  });
}

// ── 체크포인트 — 번역 텍스트만 저장 ─────────────────────────────────────────

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

// ── 세그먼트 병합 헬퍼 ────────────────────────────────────────────────────────

function mergeWithTranslations(
  segments: TranslationSegment[],
  translatedTexts: string[]
): TranslationSegment[] {
  return segments.map((seg, i) => ({
    ...seg,
    translated: translatedTexts[i] || seg.text,
  }));
}

// ── Main translation function ─────────────────────────────────────────────────

/**
 * @param segments       번역할 세그먼트 배열
 * @param onProgress     진행 콜백
 * @param videoHash      체크포인트 키
 * @param targetLanguage 번역 목표 언어 (예: "Korean", "Japanese", "French").
 *                       지정하지 않으면 "Korean" 기본값.
 */
export async function translateSegments(
  segments: TranslationSegment[],
  onProgress?: (completed: number, total: number) => void,
  videoHash: string = "default",
  targetLanguage: string = "Korean"
): Promise<TranslationSegment[]> {
  console.log("[TRANSLATE] input segments count:", segments.length);
  console.log("[TRANSLATE] first segment:", segments[0]);
  console.log("[TRANSLATE] target language:", targetLanguage);

  if (!llamaContext) {
    throw new Error("모델이 로드되지 않았습니다. loadModel()을 먼저 호출하세요.");
  }

  const totalBatches = Math.ceil(segments.length / BATCH_SIZE);

  // Step A: 고유명사 사전 구축 + 패턴 컴파일
  const properNouns = await buildProperNounDict(segments, videoHash, targetLanguage);
  const nounHint    = formatNounHint(properNouns);
  const patterns    = buildPatterns(properNouns);
  console.log(`[Gemma] Proper nouns: ${Object.keys(properNouns).length} entries, compiled patterns: ${patterns.length}`);

  /**
   * [수정] 시스템 프롬프트 간결화.
   * 기존: 강제 규칙 + "NEVER mix source and target language" 등 과도한 지시
   * 변경: 핵심 규칙만 유지, 고유명사는 참고 힌트로 격하
   * → LLM이 번역 품질에 더 많은 연산을 할당할 수 있도록
   */
  const systemPrompt =
    `You are a professional subtitle translator. ` +
    `Translate each numbered English line into natural ${targetLanguage}. ` +
    `Output ONLY numbered lines matching the input count. ` +
    `Preserve speech rhythm. No explanations.` +
    nounHint;

  // Step B: 체크포인트 복원
  const checkpoint = await loadCheckpoint(videoHash);
  let startBatch = 0;
  const translatedTexts: string[] = new Array(segments.length).fill("");

  if (checkpoint && checkpoint.translatedTexts.length === segments.length) {
    startBatch = checkpoint.lastBatchIndex + 1;
    for (let i = 0; i < checkpoint.translatedTexts.length; i++) {
      translatedTexts[i] = checkpoint.translatedTexts[i];
    }
    console.log(`[Gemma] Resuming from batch ${startBatch} / ${totalBatches}`);
  }

  // Step C: 배치 번역
  try {
    for (let batchIdx = startBatch; batchIdx < totalBatches; batchIdx++) {
      const offset  = batchIdx * BATCH_SIZE;
      const batch   = segments.slice(offset, offset + BATCH_SIZE);
      const userMsg = buildBatchMessage(batch, 0);

      console.log(`[TRANSLATE] batch ${batchIdx + 1}/${totalBatches}, segments: ${batch.length}`);

      const result = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMsg       },
        ],
        n_predict:   batch.length * 100,
        temperature: 0.1,
        top_p:       0.9,
        stop:        ["</s>", "<end_of_turn>", "<|end|>"],
      });

      const translations = parseBatchResponse(result.text, batch, 0, patterns);

      for (let i = 0; i < batch.length; i++) {
        translatedTexts[offset + i] = translations[i];
      }

      onProgress?.(offset + batch.length, segments.length);

      // 번역 텍스트만 저장 (원본 세그먼트 제외 → 저장 크기 ~50% 감소)
      await saveCheckpoint(videoHash, {
        translatedTexts,
        lastBatchIndex: batchIdx,
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
    return mergeWithTranslations(segments, translatedTexts);
  }

  await deleteCheckpoint(videoHash);

  const completed = mergeWithTranslations(segments, translatedTexts);
  console.log(`[Gemma] Translation complete: ${completed.length} segments.`);
  console.log("[TRANSLATE] first result:", JSON.stringify(completed[0]));
  return completed;
}