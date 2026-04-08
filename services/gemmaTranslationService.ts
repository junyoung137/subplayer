import { initLlama, LlamaContext } from "llama.rn";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLanguageProfile } from "../constants/languageProfiles";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TranslationSegment {
  start: number;
  end: number;
  text: string;
  translated: string;
}

interface Checkpoint {
  translatedTexts: string[];
  lastBatchIndex: number;
  properNouns: Record<string, string>;
  totalBatches: number;
  timestamp: number;
}

/**
 * A group of consecutive original segments that were merged for LLM context.
 * originalIndices maps back to the input segments[] array so translations can
 * be re-expanded to original timestamps after the LLM pass.
 */
interface MergedGroup {
  start: number;
  end: number;
  text: string;
  originalIndices: number[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_PATH            = FileSystem.documentDirectory + "gemma-models/gemma-3n-e2b-q4.gguf";
const BATCH_SIZE            = 5;
const SLEEP_BETWEEN_MS      = 600;
const SLEEP_THERMAL_MS      = 2500;
const THERMAL_EVERY_N       = 5;
const CHECKPOINT_TTL_MS     = 24 * 60 * 60 * 1000;
const PROPER_NOUN_MIN_COUNT = 3;

// Fragment merge tuning
const MERGE_MAX_GAP_S       = 1.0;   // gap ≥ this → force group split
const MERGE_MAX_DURATION_S  = 4.0;   // Netflix single-screen max
const MERGE_MAX_WORDS       = 12;    // ~2 subtitle lines
const SHORT_WORD_MAX        = 2;     // "yes"/"no"/"right" threshold
const SHORT_DURATION_MAX_S  = 1.5;   // absorb short lone segments into neighbours

// Timing readability
const SECS_PER_CHAR_KO      = 0.065; // ~15 chars/sec reading speed
const MAX_TIMING_OVERLAP    = 0.1;   // allowed forward overlap (seconds)

/**
 * 장르별 페르소나 프롬프트 접두어.
 */
const GENRE_PERSONA: Record<string, string> = {
  "tech lecture":  "You specialize in technology and programming subtitles.",
  "comedy":        "You specialize in comedy, preserving humor and casual speech.",
  "news":          "You specialize in news subtitles, using formal and precise language.",
  "documentary":   "You specialize in documentary narration, using descriptive language.",
  "gaming":        "You specialize in gaming content, preserving gamer slang and terms.",
  "education":     "You specialize in educational content for learners.",
  "general":       "",
};

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

function checkpointKey(videoHash: string) { return `gemma_checkpoint_v3_${videoHash}`; }
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

// ── Fragment merging ──────────────────────────────────────────────────────────

/**
 * Returns true for segments that are pure filler: empty, single punctuation,
 * or numbers-only. These are kept as 1-element groups and never merged.
 */
function isFillerText(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || /^[\d\s.,;:!?'"()[\]-]+$/.test(t);
}

/**
 * Merges consecutive short/fragment segments from yt-dlp word-level timestamps
 * into sentence-level groups for better LLM translation context.
 *
 * Merge stops when ANY condition is violated:
 *   • gap between seg[i].end and seg[i+1].start ≥ MERGE_MAX_GAP_S (1.0 s)
 *   • projected group duration > MERGE_MAX_DURATION_S (4.0 s)
 *   • projected word count > MERGE_MAX_WORDS (12)
 *   • current group already ends with terminal punctuation (.!?)
 *   • next segment is pure filler
 */
function mergeFragments(segments: TranslationSegment[]): MergedGroup[] {
  const groups: MergedGroup[] = [];
  let i = 0;

  while (i < segments.length) {
    const seg = segments[i];

    if (isFillerText(seg.text)) {
      groups.push({ start: seg.start, end: seg.end, text: seg.text, originalIndices: [i] });
      i++;
      continue;
    }

    const group: MergedGroup = {
      start:           seg.start,
      end:             seg.end,
      text:            seg.text.trim(),
      originalIndices: [i],
    };

    let j = i + 1;
    while (j < segments.length) {
      const next = segments[j];
      if (isFillerText(next.text)) break;

      const gap               = next.start - group.end;
      const projectedDuration = next.end - group.start;
      const projectedText     = group.text + " " + next.text.trim();
      const wordCount         = projectedText.split(/\s+/).filter(Boolean).length;
      const hasTerminal       = /[.!?]$/.test(group.text);

      if (
        gap >= MERGE_MAX_GAP_S               ||
        projectedDuration > MERGE_MAX_DURATION_S ||
        wordCount > MERGE_MAX_WORDS          ||
        hasTerminal
      ) break;

      group.text = projectedText;
      group.end  = next.end;
      group.originalIndices.push(j);
      j++;
    }

    groups.push(group);
    i = j;
  }

  return groups;
}

/**
 * Second-pass merge: absorbs isolated short groups (1-2 word, < 1.5 s) into
 * their neighbour so words like "yes", "no", "right", "yeah" aren't translated
 * in isolation.  Short groups are folded into the NEXT group when one exists,
 * otherwise into the PREVIOUS group.  Duration/word-count caps are NOT enforced
 * here — the goal is correct context, not aesthetics.
 */
function absorbShortGroups(groups: MergedGroup[]): MergedGroup[] {
  if (groups.length <= 1) return groups;

  const result: MergedGroup[] = [];
  let i = 0;

  while (i < groups.length) {
    const g = groups[i];
    const words    = g.text.trim().split(/\s+/).filter(Boolean).length;
    const duration = g.end - g.start;
    const isShort  = !isFillerText(g.text) && words <= SHORT_WORD_MAX && duration < SHORT_DURATION_MAX_S;

    if (isShort && i < groups.length - 1) {
      // Absorb into next group
      const next: MergedGroup = groups[i + 1];
      result.push({
        start:           g.start,
        end:             next.end,
        text:            g.text.trim() + " " + next.text.trim(),
        originalIndices: [...g.originalIndices, ...next.originalIndices],
      });
      i += 2;
    } else if (isShort && result.length > 0) {
      // Last group is short — fold into the previous one
      const prev = result[result.length - 1];
      prev.text = prev.text.trim() + " " + g.text.trim();
      prev.end  = g.end;
      prev.originalIndices.push(...g.originalIndices);
      i++;
    } else {
      result.push({ ...g, originalIndices: [...g.originalIndices] });
      i++;
    }
  }

  return result;
}

// ── Translation re-expansion ──────────────────────────────────────────────────

/**
 * Redistributes the translated text for each merged group back to the original
 * per-segment slots, proportionally by source-text character count.
 * Each original segment retains its original start/end times.
 */
function expandGroupTranslations(
  groups: MergedGroup[],
  groupTranslations: string[],
  originalSegments: TranslationSegment[]
): string[] {
  const result: string[] = new Array(originalSegments.length).fill("");

  for (let gi = 0; gi < groups.length; gi++) {
    const group               = groups[gi];
    const translation         = groupTranslations[gi] ?? "";
    const { originalIndices } = group;

    if (originalIndices.length === 1) {
      result[originalIndices[0]] = translation;
      continue;
    }

    if (!translation) {
      for (const idx of originalIndices) result[idx] = originalSegments[idx].text;
      continue;
    }

    // Distribute translation words proportionally by source character count
    const totalSrcChars = originalIndices.reduce(
      (sum, idx) => sum + originalSegments[idx].text.trim().length, 0
    );

    if (totalSrcChars === 0) {
      result[originalIndices[0]] = translation;
      continue;
    }

    const words = translation.split(/\s+/).filter(Boolean);
    let wordOffset = 0;

    for (let k = 0; k < originalIndices.length; k++) {
      const idx    = originalIndices[k];
      const isLast = k === originalIndices.length - 1;

      if (isLast) {
        result[idx] = words.slice(wordOffset).join(" ");
      } else {
        const fraction = originalSegments[idx].text.trim().length / totalSrcChars;
        const count    = Math.max(1, Math.round(fraction * words.length));
        result[idx]    = words.slice(wordOffset, wordOffset + count).join(" ");
        wordOffset    += count;
      }
    }
  }

  return result;
}

// ── Netflix-style timing adjustment ──────────────────────────────────────────

/**
 * Post-processing pass to ensure subtitle readability:
 *   1. Extends any segment whose display time is shorter than the translated
 *      character count demands (SECS_PER_CHAR_KO * charCount).
 *   2. Trims forward overlaps with the next segment to MAX_TIMING_OVERLAP.
 */
export function adjustTimingsForReadability(
  segments: TranslationSegment[]
): TranslationSegment[] {
  const result = segments.map(seg => ({ ...seg }));

  // Pass 1: enforce minimum display duration per character count
  for (const seg of result) {
    const originalDuration = seg.end - seg.start;
    const charCount        = (seg.translated || seg.text).length;
    const minDuration      = charCount * SECS_PER_CHAR_KO;
    if (minDuration > originalDuration) {
      seg.end = seg.start + minDuration;
    }
  }

  // Pass 2: resolve forward overlaps
  for (let i = 0; i < result.length - 1; i++) {
    const overlap = result[i].end - result[i + 1].start;
    if (overlap > MAX_TIMING_OVERLAP) {
      result[i].end = result[i + 1].start + MAX_TIMING_OVERLAP;
    }
  }

  return result;
}

// ── 고유명사 추출 ─────────────────────────────────────────────────────────────

function extractProperNounCandidates(segments: TranslationSegment[]): string[] {
  const stats = new Map<string, { mid: number; first: number }>();

  const sentenceStartPattern = /(?:^|[.!?]\s+)([A-Z][a-zA-Z]{2,})/g;
  const allUpperPattern      = /\b([A-Z][a-zA-Z]{2,})\b/g;

  for (const seg of segments) {
    const text = seg.text;

    const firstWords = new Set<string>();
    let m: RegExpExecArray | null;
    sentenceStartPattern.lastIndex = 0;
    while ((m = sentenceStartPattern.exec(text)) !== null) firstWords.add(m[1]);

    allUpperPattern.lastIndex = 0;
    while ((m = allUpperPattern.exec(text)) !== null) {
      const word = m[1];
      if (COMMON_WORDS.has(word)) continue;
      const isFirst = firstWords.has(word);
      const entry   = stats.get(word) ?? { mid: 0, first: 0 };
      if (isFirst) entry.first += 1; else entry.mid += 1;
      stats.set(word, entry);
    }
  }

  const result: string[] = [];
  for (const [word, { mid, first }] of stats) {
    if (mid * 1.5 + first * 0.5 >= PROPER_NOUN_MIN_COUNT) result.push(word);
  }
  return result;
}

// ── 고유명사 음역 ─────────────────────────────────────────────────────────────

async function transliterateProperNouns(
  nouns: string[],
  targetLanguage: string
): Promise<Record<string, string>> {
  if (!llamaContext || nouns.length === 0) return {};

  const result = await llamaContext.completion({
    messages: [
      {
        role: "system",
        content:
          `Transliterate or adapt each proper noun (name or place) into ${targetLanguage} phonetically or conventionally as used in ${targetLanguage} media/subtitles.\n` +
          "Output ONLY lines in the format 'English=Transliteration'. No explanations.",
      },
      { role: "user", content: nouns.join("\n") },
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

  const unmapped = Object.entries(merged).filter(([, v]) => !v).map(([k]) => k);
  if (unmapped.length > 0) {
    const fresh = await transliterateProperNouns(unmapped, targetLanguage);
    for (const [src, tgt] of Object.entries(fresh)) merged[src] = tgt;
  }

  await AsyncStorage.setItem(properNounKey(videoHash), JSON.stringify(merged));
  return merged;
}

function formatNounHint(dict: Record<string, string>): string {
  const pairs = Object.entries(dict)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return pairs ? `\nReference translations: ${pairs}` : "";
}

// ── 고유명사 후처리 ───────────────────────────────────────────────────────────

interface CompiledNounPattern {
  src: string;
  tgt: string;
  fullRegex: RegExp;
}

let cachedPatterns: CompiledNounPattern[] | null = null;
let cachedDictKey: string = "";

function buildPatterns(dict: Record<string, string>): CompiledNounPattern[] {
  const key = JSON.stringify(dict);
  if (cachedPatterns && cachedDictKey === key) return cachedPatterns;

  const patterns: CompiledNounPattern[] = [];
  for (const [src, tgt] of Object.entries(dict)) {
    if (!tgt) continue;
    patterns.push({
      src,
      tgt,
      fullRegex: new RegExp(
        `(?<![\\wㄱ-ㅎㅏ-ㅣ가-힣])${escapeRegex(src)}(?![\\wㄱ-ㅎㅏ-ㅣ가-힣])`,
        "gi"
      ),
    });
  }

  cachedPatterns = patterns;
  cachedDictKey  = key;
  return patterns;
}

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

/**
 * Parses the LLM response into per-segment translations.
 *
 * Three-pass strategy for robustness:
 *   Pass 1 — strict "N. text" / "N) text"
 *   Pass 2 — broader "N: text" / "N- text" / "N  text" artifacts
 *   Pass 3 — positional fallback (strip leading number/punct, exact line count)
 *   Last resort — use whatever numbered matches exist, fill gaps with source text
 */
function parseBatchResponse(
  response: string,
  batch: TranslationSegment[],
  batchOffset: number,
  patterns: CompiledNounPattern[]
): string[] {
  const translationMap = new Map<number, string>();

  // Pass 1: strict "N. text" or "N) text"
  for (const line of response.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+)[.)]\s*(.+)$/);
    if (m) translationMap.set(parseInt(m[1], 10), m[2].trim());
  }

  if (translationMap.size === batch.length) {
    return batch.map((seg, i) => {
      const raw = translationMap.get(batchOffset + i + 1);
      return raw ? applyProperNounFixes(raw, patterns) : seg.text;
    });
  }

  // Pass 2: broader delimiters — "N: text", "N- text", "N  text"
  if (translationMap.size < batch.length) {
    for (const line of response.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const m =
        line.match(/^(\d+)[.):\-]\s+(.+)$/) ??
        line.match(/^(\d+)\s{2,}(.+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!translationMap.has(n)) translationMap.set(n, m[2].trim());
      }
    }
  }

  if (translationMap.size === batch.length) {
    return batch.map((seg, i) => {
      const raw = translationMap.get(batchOffset + i + 1);
      return raw ? applyProperNounFixes(raw, patterns) : seg.text;
    });
  }

  // Pass 3: positional fallback — strip leading number/punctuation artifacts
  const contentLines = response
    .split("\n")
    .map((l) => l.trim().replace(/^[\d]+[.):\-\s]+/, "").trim())
    .filter(Boolean);

  if (contentLines.length === batch.length) {
    console.warn(
      `[TRANSLATE] positional fallback: numbered=${translationMap.size} expected=${batch.length}`
    );
    return batch.map((seg, i) => applyProperNounFixes(contentLines[i], patterns));
  }

  // Last resort: use whatever numbered matches exist; fall back to source for gaps
  return batch.map((seg, i) => {
    const raw = translationMap.get(batchOffset + i + 1);
    if (!raw) {
      console.warn(`[TRANSLATE] missing translation for segment #${batchOffset + i + 1}`);
      return seg.text;
    }
    return applyProperNounFixes(raw, patterns);
  });
}

// ── Translation validation ────────────────────────────────────────────────────

/**
 * Returns true when a "translated" string looks like it was never actually
 * translated — i.e. it is >90% ASCII latin characters, which for non-Latin
 * target languages (Korean, Japanese, Chinese, …) means the model passed the
 * English through unchanged.
 */
function isLikelyUntranslated(translated: string, targetLanguage: string): boolean {
  const profile = getLanguageProfile(targetLanguage);
  const t = translated.trim();
  if (!t) return true;
  if (profile.isLatinScript) return false;
  const nonSpace   = t.replace(/\s/g, "");
  const asciiLatin = (nonSpace.match(/[a-zA-Z]/g) ?? []).length;
  return nonSpace.length > 0 && asciiLatin / nonSpace.length > 0.9;
}

/**
 * Post-translation validation pass.
 *
 * For each segment:
 *  1. Empty or >90% ASCII latin  → force single-segment retry with a direct prompt.
 *  2. Still bad after retry       → mark `[미번역]`/`[UNTRANSLATED]` so the user
 *                                    can see the failure instead of silent pass-through.
 */
async function validateTranslations(
  segments: TranslationSegment[],
  translatedTexts: string[],
  systemPrompt: string,
  targetLanguage: string,
  patterns: CompiledNounPattern[]
): Promise<string[]> {
  if (!llamaContext) return translatedTexts;

  const failMarker = targetLanguage === "Korean" || targetLanguage === "ko"
    ? "[미번역]"
    : "[UNTRANSLATED]";

  const result = [...translatedTexts];

  for (let i = 0; i < segments.length; i++) {
    const t   = result[i]?.trim() ?? "";
    const src = segments[i].text.trim();

    if (isFillerText(src)) continue; // fillers pass through as-is

    const needsRetry = t.length === 0 || isLikelyUntranslated(t, targetLanguage);
    if (!needsRetry) continue;

    console.warn(`[VALIDATE] segment ${i} untranslated: "${src}" → "${t}"`);

    try {
      const singlePrompt =
        `Translate this single English subtitle line to natural ${targetLanguage}. ` +
        `Output ONLY the ${targetLanguage} translation, nothing else:\n${src}`;

      const retryResult = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: singlePrompt },
        ],
        n_predict:   80,
        temperature: 0.1,
        top_p:       0.9,
        stop:        ["</s>", "<end_of_turn>", "<|end|>", "\n"],
      });

      const candidate = retryResult.text.trim();
      if (candidate && !isLikelyUntranslated(candidate, targetLanguage)) {
        result[i] = applyProperNounFixes(candidate, patterns);
        console.log(`[VALIDATE] fixed segment ${i}: "${src}" → "${result[i]}"`);
      } else {
        result[i] = `${failMarker} ${src}`;
        console.warn(`[VALIDATE] segment ${i} still untranslated, marking [미번역]`);
      }
    } catch (e) {
      result[i] = `${failMarker} ${src}`;
      console.warn(`[VALIDATE] segment ${i} retry error:`, e);
    }
  }

  return result;
}

// ── 체크포인트 ────────────────────────────────────────────────────────────────

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
 * @param segments       번역할 세그먼트 배열 (원본 yt-dlp word-level timestamps)
 * @param onProgress     진행 콜백 — completed/total은 merged-group 단위
 * @param videoHash      체크포인트 키 (videoId 권장)
 * @param targetLanguage 번역 목표 언어명 (예: "Korean", "Japanese")
 * @param videoGenre     영상 장르 힌트 → 페르소나 프롬프트에 반영
 */
export async function translateSegments(
  segments: TranslationSegment[],
  onProgress?: (completed: number, total: number, partial: TranslationSegment[]) => void,
  videoHash: string = "default",
  targetLanguage: string = "Korean",
  videoGenre: string = "general"
): Promise<TranslationSegment[]> {
  console.log("[TRANSLATE] input segments count:", segments.length);
  console.log("[TRANSLATE] target language:", targetLanguage);
  console.log("[TRANSLATE] video genre:", videoGenre);

  if (!llamaContext) {
    throw new Error("모델이 로드되지 않았습니다. loadModel()을 먼저 호출하세요.");
  }

  // ── Step A: Merge yt-dlp word fragments into sentence-level groups ────────
  const mergedGroups       = absorbShortGroups(mergeFragments(segments));
  const mergedSegs: TranslationSegment[] = mergedGroups.map(g => ({
    start: g.start, end: g.end, text: g.text, translated: "",
  }));
  const mergedTotal        = mergedSegs.length;
  const mergedTotalBatches = Math.ceil(mergedTotal / BATCH_SIZE);

  console.log(
    `[TRANSLATE] merged ${segments.length} → ${mergedTotal} groups` +
    ` (${segments.length - mergedTotal} fragments combined)`
  );

  // ── Step B: 고유명사 사전 구축 (scan original segments for full coverage) ─
  const profile     = getLanguageProfile(targetLanguage);
  const properNouns = await buildProperNounDict(segments, videoHash, targetLanguage);
  const nounHint    = formatNounHint(properNouns);
  const patterns    = buildPatterns(properNouns);
  console.log(`[Gemma] Proper nouns: ${Object.keys(properNouns).length} entries`);

  // ── Step C: 장르 페르소나 + 개선된 시스템 프롬프트 ───────────────────────
  const genrePersona = GENRE_PERSONA[videoGenre] ?? GENRE_PERSONA["general"];
  const langRules    = profile.systemPromptRules.join(" ");

  const systemPrompt =
    `You are a professional subtitle translator. ` +
    (genrePersona ? genrePersona + " " : "") +
    `Translate each numbered English line into natural ${targetLanguage}. ` +
    `Translate complete thought units. If a segment is a sentence fragment, translate it as a natural fragment in context. ` +
    `Use context from surrounding lines to handle pronouns (it, they, he, she) accurately. ` +
    `Preserve natural speech rhythm and flow. ` +
    `Output ONLY numbered lines matching the input count. No explanations. ` +
    `Each input line must produce exactly one output line. Never merge two input lines into one. ` +
    `Never skip a line — every line must be translated and output. ` +
    `Never translate filler fragments (single punctuation, numbers-only) — output them as-is. ` +
    `Pay careful attention to negation words (don't, won't, can't, didn't, not, never, no). ` +
    `A missed negation completely reverses the meaning — double-check every sentence containing negation. ` +
    `Never leave English words untranslated in the output. ` +
    langRules +
    nounHint;

  // ── Step D: 체크포인트 복원 (indexed to merged groups, not original segs) ─
  const checkpoint = await loadCheckpoint(videoHash);
  let startBatch = 0;
  const mergedTranslations: string[] = new Array(mergedTotal).fill("");

  if (checkpoint && checkpoint.translatedTexts.length === mergedTotal) {
    startBatch = checkpoint.lastBatchIndex + 1;
    for (let i = 0; i < checkpoint.translatedTexts.length; i++) {
      mergedTranslations[i] = checkpoint.translatedTexts[i];
    }
    console.log(`[Gemma] Resuming from batch ${startBatch} / ${mergedTotalBatches}`);
  }

  // ── Step E: 배치 번역 (merged segments) ──────────────────────────────────
  try {
    for (let batchIdx = startBatch; batchIdx < mergedTotalBatches; batchIdx++) {
      const offset  = batchIdx * BATCH_SIZE;
      const batch   = mergedSegs.slice(offset, offset + BATCH_SIZE);
      const userMsg = buildBatchMessage(batch, 0);

      console.log(`[TRANSLATE] batch ${batchIdx + 1}/${mergedTotalBatches}, groups: ${batch.length}`);

      const result = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMsg       },
        ],
        n_predict:   batch.length * 120,
        temperature: 0.15,
        top_p:       0.9,
        stop:        ["</s>", "<end_of_turn>", "<|end|>"],
      });

      const translations = parseBatchResponse(result.text, batch, 0, patterns);
      for (let i = 0; i < batch.length; i++) {
        mergedTranslations[offset + i] = translations[i];
      }

      // Expand to original segment array for progress callback
      const expandedPartial = expandGroupTranslations(mergedGroups, mergedTranslations, segments);
      onProgress?.(
        offset + batch.length,
        mergedTotal,
        mergeWithTranslations(segments, expandedPartial)
      );

      await saveCheckpoint(videoHash, {
        translatedTexts: mergedTranslations,
        lastBatchIndex:  batchIdx,
        properNouns,
        totalBatches:    mergedTotalBatches,
      });

      const isLastBatch = batchIdx === mergedTotalBatches - 1;
      if (!isLastBatch) {
        const isThermalBoundary = (batchIdx + 1) % THERMAL_EVERY_N === 0;
        await sleep(isThermalBoundary ? SLEEP_THERMAL_MS : SLEEP_BETWEEN_MS);
      }
    }
  } catch (e) {
    console.error("[Gemma] Inference error, returning partial results:", e);
    const partialExpanded = expandGroupTranslations(mergedGroups, mergedTranslations, segments);
    return mergeWithTranslations(segments, partialExpanded);
  }

  await deleteCheckpoint(videoHash);

  // ── Step F: Re-expand merged translations → original segment slots ────────
  const translatedTexts = expandGroupTranslations(mergedGroups, mergedTranslations, segments);

  // ── Step G: 번역 실패 세그먼트 재시도 (최대 2회, original segments) ───────
  // Retries operate on original segments to fix expansion artifacts or LLM gaps.
  // 조건 1: translated 텍스트가 비어있는 경우.
  // 조건 2: translated 텍스트가 원문 영어와 동일하고 원문 길이가 15자 초과인 경우.
  // 조건 3: 모델이 번호만 출력한 경우.
  const MAX_RETRY_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    const failedIndices: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      const t   = translatedTexts[i];
      const src = segments[i].text.trim();
      if (!t || t.trim().length === 0) {
        failedIndices.push(i);
      } else if (t.trim() === src && src.length > 15) {
        failedIndices.push(i);
      } else if (/^\d+\.?$/.test(t.trim())) {
        failedIndices.push(i);
      }
    }
    if (failedIndices.length === 0) break;

    console.log(
      `[Gemma] Retry ${attempt + 1}/${MAX_RETRY_ATTEMPTS}: ${failedIndices.length} segments`
    );
    if (!llamaContext) break;

    const retryBatch = failedIndices.map((i) => segments[i]);
    const retryMsg   = buildBatchMessage(retryBatch, 0);

    try {
      const retryResult = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: retryMsg       },
        ],
        n_predict:   retryBatch.length * 120,
        temperature: 0.15,
        top_p:       0.9,
        stop:        ["</s>", "<end_of_turn>", "<|end|>"],
      });

      const retryTranslations = parseBatchResponse(retryResult.text, retryBatch, 0, patterns);
      for (let j = 0; j < failedIndices.length; j++) {
        const t = retryTranslations[j];
        if (t && t.trim().length > 0) translatedTexts[failedIndices[j]] = t;
      }
    } catch (e) {
      console.warn(`[Gemma] Retry ${attempt + 1} error:`, e);
      break;
    }

    if (attempt < MAX_RETRY_ATTEMPTS - 1) await sleep(SLEEP_BETWEEN_MS);
  }

  // ── Step H: Post-translation validation — force-retry ASCII pass-throughs ──
  const validatedTexts = await validateTranslations(
    segments, translatedTexts, systemPrompt, targetLanguage, patterns
  );

  // ── Step I: Assemble final segments + Netflix-style timing adjustment ─────
  const completed = adjustTimingsForReadability(
    mergeWithTranslations(segments, validatedTexts)
  );
  console.log(`[Gemma] Translation complete: ${completed.length} segments.`);
  return completed;
}
