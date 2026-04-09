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
const MERGE_MAX_GAP_S       = 0.5;   // gap ≥ this → force group split
const MERGE_MAX_DURATION_S  = 2.5;   // Netflix single-screen max
const MERGE_MAX_WORDS       = 8;    // ~2 subtitle lines
const SHORT_WORD_MAX        = 2;     // "yes"/"no"/"right" threshold
const SHORT_DURATION_MAX_S  = 1.5;   // absorb short lone segments into neighbours

// Timing readability
const SECS_PER_CHAR_KO      = 0.065; // ~15 chars/sec reading speed
const MAX_TIMING_OVERLAP    = 0.1;   // allowed forward overlap (seconds)

// ── sanitizeTranslationOutput regex constants ─────────────────────────────────

/** Korean stage-direction annotations the LLM sometimes hallucinates. */
const RE_STAGE_DIRECTION_KO = /\(혼잣말\)|\(독백\)|\(방백\)|\(내레이션\)/g;

/** Any parenthesised content — stripped when the source line has no parens. */
const RE_PARENS_ANY = /\([^)]*\)/g;

/** ASCII words of 3+ chars that are NOT pure numbers or timestamp tokens.
 *  Used to detect leftover untranslated English in non-Latin target output. */
const RE_ENGLISH_WORD = /\b([a-zA-Z]{3,})\b/g;

/** Timestamp / numeric tokens to exclude from the leftover-English check. */
const RE_NUMERIC_TOKEN = /^\d+([:.]\d+)*$/;

/**
 * 장르별 페르소나 프롬프트 접두어.
 */
const GENRE_PERSONA: Record<string, string> = {
  "tech lecture":  "You specialize in technology and programming subtitles.",
  "comedy":        "You specialize in comedy subtitles. Preserve humor, sarcasm, irony, and exaggeration. Use casual, natural Korean (구어체). Translate the emotional tone and comedic intent, not just the literal words. Slang and idioms should be translated by feel and meaning. Translate idioms and slang by meaning, not literally. Examples: 'surprised you didn't save Facebook' in context of listing social media apps means 'surprised you didn't include/mention Facebook' → 'Facebook은 왜 빠뜨린 거예요?'. 'ready to go at 8:00 sharp' → '아침 8시 정각에 준비 완료'. 'mental health day' → '정신건강의 날 (하루 쉬는 날)'. 'that\\'s our old people like my parents' means Facebook is what old people (like her parents) use — dismissive teen attitude → '그건 저희 부모님 같은 아저씨 아줌마들이 쓰는 거죠.'. 'you don\\'t work here' said to someone = telling them they have no authority here → '여기서 일하지도 않잖아요'. 'are you firing me' = shocked reaction → '저 해고하시는 거예요?'.",
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
 * Resolves heavily overlapping yt-dlp word-level segments into a clean,
 * non-overlapping sequence before any merge logic runs.
 *
 * yt-dlp JSON3 output often produces segments where segment[i+1].start falls
 * well inside segment[i]'s time range (negative or near-zero gap). Feeding
 * overlapping segments straight into gap-based merging causes wrong groupings,
 * duplicate words in merged text, and broken sentence boundaries.
 *
 * Algorithm (single forward pass, O(n)):
 *   1. Sort by startTime ascending so relative order is guaranteed.
 *   2. For each segment, compare its startTime against the accumulated group's
 *      endTime. If startTime < groupEnd - 0.05 s (overlap threshold), the two
 *      segments are concurrent speech variants of the same utterance.
 *      - Union-merge their words: split both texts on whitespace, append only
 *        words from the incoming segment that are not already present in the
 *        accumulated text (case-insensitive, preserves original casing of first
 *        occurrence). This avoids duplicated words while keeping word order.
 *      - Extend endTime to max(groupEnd, segment.end).
 *   3. If no overlap, flush the accumulated group as a clean segment and start
 *      a new one.
 *
 * No LLM call: pure array/string manipulation over timestamp metadata.
 *
 * @param segments - Raw TranslationSegment[] from yt-dlp (may overlap).
 * @returns A new array of non-overlapping segments sorted by startTime.
 */
function deduplicateOverlappingSegments(
  segments: TranslationSegment[]
): TranslationSegment[] {
  if (segments.length === 0) return [];

  // Step 1: sort by startTime
  const sorted = [...segments].sort((a, b) => a.start - b.start);

  const result: TranslationSegment[] = [];

  // Accumulator for the current overlap group
  let accStart  = sorted[0].start;
  let accEnd    = sorted[0].end;
  let accText   = sorted[0].text.trim();
  let accWords  = accText.toLowerCase().split(/\s+/).filter(Boolean);

  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i];
    const OVERLAP_THRESHOLD = 0.05; // seconds — treat as overlapping if within this

    if (seg.start < accEnd - OVERLAP_THRESHOLD) {
      // Overlapping: union-merge words, extend end
      const incomingWords = seg.text.trim().split(/\s+/).filter(Boolean);
      const seen = new Set(accWords);
      for (const w of incomingWords) {
        if (!seen.has(w.toLowerCase())) {
          accText  += " " + w;
          accWords.push(w.toLowerCase());
          seen.add(w.toLowerCase());
        }
      }
      accEnd = Math.max(accEnd, seg.end);
    } else {
      // No overlap: flush accumulated group
      result.push({ start: accStart, end: accEnd, text: accText.trim(), translated: "" });
      accStart = seg.start;
      accEnd   = seg.end;
      accText  = seg.text.trim();
      accWords = accText.toLowerCase().split(/\s+/).filter(Boolean);
    }
  }

  // Flush final group
  result.push({ start: accStart, end: accEnd, text: accText.trim(), translated: "" });

  return result;
}

/**
 * Returns true for segments that are pure filler: empty, single punctuation,
 * or numbers-only. These are kept as 1-element groups and never merged.
 */
function isFillerText(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || /^[\d\s.,;:!?'"()[\]-]+$/.test(t);
}

// Words that signal a clause continues from the previous segment.
// When the next segment starts with one of these AND the current group has no
// terminal punctuation, the gap threshold is relaxed to MERGE_CONTINUATION_GAP_S
// so mid-clause splits like "I don't think we're" / "gonna be a good fit" stay
// together and the LLM sees the full negated thought.
const CONTINUATION_WORDS = /^(gonna|going|been|have|just|really|so|that|the|a|an|to|be|get|even|don't|i|and|in|until|like)\b/i;
const MERGE_CONTINUATION_GAP_S = 1.5; // relaxed gap for continuation-word merges

/**
 * Merges consecutive short/fragment segments from yt-dlp word-level timestamps
 * into sentence-level groups for better LLM translation context.
 *
 * Merge stops when ANY condition is violated:
 *   • gap ≥ MERGE_MAX_GAP_S (1.0 s) — unless next segment starts with a
 *     continuation word AND current group has no terminal punctuation, in which
 *     case the gap allowance is raised to MERGE_CONTINUATION_GAP_S (2.0 s)
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

      // Sentence-boundary check: stop merging when the accumulated text already
      // contains a complete subject+verb clause AND the next segment opens a new
      // clause with a fresh subject pronoun or capitalised noun. This prevents
      // cross-sentence content bleed where two independent sentences end up in
      // the same merge group and confuse the LLM's per-line boundary tracking.
      const accHasCompleteClause = /\b(I|you|we|they|he|she|it)\b.{4,}/i.test(group.text);
      const nextStartsNewClause  = /^(I|you|we|they|he|she|it|[A-Z][a-z])\b/i.test(next.text.trim());
      if (accHasCompleteClause && nextStartsNewClause) break;

      // Continuation-word override: relax the gap cap when the current group
      // ends mid-clause (no terminal punctuation) and the next segment starts
      // with a word that grammatically continues the clause (e.g. "gonna").
      const isContinuation = !hasTerminal && CONTINUATION_WORDS.test(next.text.trim());
      const effectiveGapCap = isContinuation ? MERGE_CONTINUATION_GAP_S : MERGE_MAX_GAP_S;

      if (
        gap >= effectiveGapCap                 ||
        projectedDuration > MERGE_MAX_DURATION_S ||
        wordCount > MERGE_MAX_WORDS            ||
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

    if (originalIndices.length >= 3) {
      const charLength = translation.replace(/\s+/g, "").length;
      const charsPerSlot = charLength / originalIndices.length;

      if (charsPerSlot < 6) {
        const sentences = translation.split(/(?<=[.!?])\s+/).filter(Boolean);

        if (sentences.length >= 2) {
          const firstSentences  = sentences.slice(0, Math.ceil(sentences.length / 2)).join(" ");
          const secondSentences = sentences.slice(Math.ceil(sentences.length / 2)).join(" ");
          const firstCharRatio  = firstSentences.length /
            (firstSentences.length + secondSentences.length);
          const totalDuration =
            originalSegments[originalIndices[originalIndices.length - 1]].end -
            originalSegments[originalIndices[0]].start;
          const splitTime =
            originalSegments[originalIndices[0]].start + totalDuration * firstCharRatio;

          let splitSlot = Math.max(1, Math.floor(originalIndices.length / 2));
          for (let k = 1; k < originalIndices.length; k++) {
            if (originalSegments[originalIndices[k]].start >= splitTime) {
              splitSlot = k;
              break;
            }
          }

          result[originalIndices[0]] = firstSentences;
          for (let k = 1; k < splitSlot; k++) {
            result[originalIndices[k]] = "";
          }
          result[originalIndices[splitSlot]] = secondSentences;
          for (let k = splitSlot + 1; k < originalIndices.length; k++) {
            result[originalIndices[k]] = "";
          }

        } else {
          result[originalIndices[0]] = translation;
          for (let k = 1; k < originalIndices.length; k++) {
            result[originalIndices[k]] = "";
          }
        }

        continue; // skip word-proportional split below
      }
    }

    if (originalIndices.length === 1) {
      result[originalIndices[0]] = translation;
      continue;
    }

    if (!translation) {
      for (const idx of originalIndices) result[idx] = originalSegments[idx].text;
      continue;
    }

    // ── Multi-slot word-proportional split ──────────────────────────────
    const totalSrcChars = originalIndices.reduce(
      (sum, idx) => sum + originalSegments[idx].text.trim().length, 0
    );

    if (totalSrcChars === 0) {
      result[originalIndices[0]] = translation;
      continue;
    }

    const words      = translation.split(/\s+/).filter(Boolean);
    let   wordOffset = 0;

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

    // Backward dedup pass: clear earlier slot when identical to or
    // contained in a later slot, strip suffix/prefix overlap > 6 chars
    for (let k = originalIndices.length - 1; k > 0; k--) {
      const idxA = originalIndices[k - 1];
      const idxB = originalIndices[k];
      const a    = result[idxA].trim();
      const b    = result[idxB].trim();
      if (!a || !b) continue;
      if (a === b)        { result[idxA] = ""; continue; }
      if (a.includes(b)) { result[idxA] = ""; continue; }
      if (b.includes(a)) { result[idxB] = ""; continue; }
      const OVERLAP_MIN = 6;
      const maxCheck    = Math.min(a.length, b.length);
      for (let len = maxCheck; len >= OVERLAP_MIN; len--) {
        if (a.endsWith(b.slice(0, len))) {
          result[idxB] = b.slice(len).trimStart();
          break;
        }
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
/**
 * Cleans a single translated line of common LLM artefacts.
 *
 * Artefacts removed (no LLM call — pure regex/string operations):
 *   1. Korean stage-direction annotations the model hallucinates
 *      (혼잣말, 독백, 방백, 내레이션) — never present in yt-dlp subtitle source.
 *   2. Any parenthesised content when the source line has no parentheses —
 *      model often adds "(웃음)", "(한숨)", etc. that were not in the source.
 *   3. Does NOT strip parens when the source itself contains them, so legitimate
 *      screen-direction subtitles (e.g. "[Music]") are preserved.
 *
 * The function is pure and side-effect free: same inputs always produce the
 * same output and no external state is read or mutated.
 *
 * @param text       - Raw translated string from the LLM.
 * @param sourceText - Corresponding source English segment text.
 * @returns Cleaned translation string.
 */
export function sanitizeTranslationOutput(text: string, sourceText: string): string {
  let out = text;

  // 1. Remove hallucinated Korean stage directions unconditionally.
  out = out.replace(RE_STAGE_DIRECTION_KO, "");

  // 2. If source has no parentheses, strip all (...) from translation.
  if (!sourceText.includes("(") && !sourceText.includes(")")) {
    out = out.replace(RE_PARENS_ANY, "");
  }

  // Collapse any double-spaces left by the removals and trim.
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Returns true when the translated text contains leftover English words (3+
 * ASCII chars) that are neither in the proper-noun dictionary nor pure numeric
 * tokens. For non-Latin target languages this signals a likely untranslated
 * pass-through that should be retried.
 *
 * Pure function — no LLM call, no side effects.
 *
 * @param translated     - The translated string to inspect.
 * @param sourceText     - Source English text (words appearing in source are allowed).
 * @param patterns       - Compiled proper-noun patterns for the current video.
 * @param targetLanguage - Used to skip the check for Latin-script targets.
 * @returns true if leftover untranslated English tokens are detected.
 */
export function hasLeftoverEnglish(
  translated: string,
  sourceText: string,
  patterns: CompiledNounPattern[],
  targetLanguage: string
): boolean {
  const profile = getLanguageProfile(targetLanguage);
  if (profile.isLatinScript) return false; // not applicable for Latin targets

  const knownEnglish = new Set(
    sourceText.toLowerCase().split(/\s+/).filter(Boolean)
  );
  const knownTranslit = new Set(
    patterns.map(p => p.src.toLowerCase())
  );

  RE_ENGLISH_WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ENGLISH_WORD.exec(translated)) !== null) {
    const word = m[1];
    if (RE_NUMERIC_TOKEN.test(word)) continue;           // skip timestamps/numbers
    if (knownEnglish.has(word.toLowerCase())) continue;  // came from source — ok
    if (knownTranslit.has(word.toLowerCase())) continue; // known proper noun transliteration
    return true;
  }
  return false;
}

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
      if (!raw) return seg.text;
      return sanitizeTranslationOutput(applyProperNounFixes(raw, patterns), seg.text);
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
      if (!raw) return seg.text;
      return sanitizeTranslationOutput(applyProperNounFixes(raw, patterns), seg.text);
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
    return batch.map((seg, i) =>
      sanitizeTranslationOutput(applyProperNounFixes(contentLines[i], patterns), seg.text)
    );
  }

  // Last resort: use whatever numbered matches exist; fall back to source for gaps
  return batch.map((seg, i) => {
    const raw = translationMap.get(batchOffset + i + 1);
    if (!raw) {
      console.warn(`[TRANSLATE] missing translation for segment #${batchOffset + i + 1}`);
      return seg.text;
    }
    return sanitizeTranslationOutput(applyProperNounFixes(raw, patterns), seg.text);
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

    // Check for likely dropped negation: source has negation trigger but
    // Korean translation contains none of the expected negation markers.
    // When the current segment ends without terminal punctuation, also look at
    // the combined text of this segment + the next, so split-clause negations
    // like "I don't think we're" / "gonna be a good fit" are caught as a unit.
    const hasTerminalPunct = /[.!?]$/.test(src);
    const nextSrc = (!hasTerminalPunct && i + 1 < segments.length)
      ? segments[i + 1].text.trim()
      : "";
    const logicalSrc = nextSrc ? `${src} ${nextSrc}` : src;
    const srcHasNegation = /\bdon't think\b|\bi don't think\b|\bnot a\b|\bdoesn't work\b|\bdon't work\b|\bcan't\b|\bwon't\b/i.test(logicalSrc);
    const tgtHasNegation = /않|안|못|없|아니|모르/.test(t);
    const negationDropped = srcHasNegation && t.length > 0 && !tgtHasNegation;
    if (negationDropped) {
      console.warn(`[VALIDATE] segment ${i} likely negation dropped: "${src}" → "${t}"`);
    }

    // Check for hallucinated proper nouns: translated text contains a known
    // proper noun (Korean form) that has no corresponding source word in this
    // specific segment. Prevents context-bleed from nearby segments.
    const HALLUCINATION_GUARD: Array<[korean: string, english: RegExp]> = [
      ["시리",   /\bsiri\b/i],
      ["알렉사", /\balexa\b/i],
      ["구글",   /\bgoogle\b/i],
    ];
    // Also check translated proper nouns from the properNouns dict (English key → Korean value).
    // If the Korean translation appears in the output but the English key is absent from src,
    // it was likely bled in from context.
    const nounHallucinationFound =
      HALLUCINATION_GUARD.some(([ko, enRe]) => t.includes(ko) && !enRe.test(src)) ||
      patterns.some(p => {
        // p.tgt is the Korean translation of the proper noun (e.g. "마크 저커버그").
        // p.src is the original English form. If the Korean form appears in the
        // translated output but the English form is absent from this source line,
        // the model bled the noun in from context.
        return p.tgt && t.includes(p.tgt) && !new RegExp(`\\b${p.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(src);
      });
    if (nounHallucinationFound) {
      console.warn(`[VALIDATE] segment ${i} hallucinated proper noun: "${src}" → "${t}"`);
    }

    // Apply sanitization to the current translation before checking leftover English.
    // This removes stage-direction artefacts before the retry decision so we
    // don't retry a segment that is merely polluted with "(혼잣말)".
    result[i] = sanitizeTranslationOutput(t, src);
    const tSanitized = result[i];

    const leftoverEnglish = hasLeftoverEnglish(tSanitized, src, patterns, targetLanguage);
    if (leftoverEnglish) {
      console.warn(`[VALIDATE] segment ${i} leftover English: "${src}" → "${tSanitized}"`);
    }

    // Ellipsis-only output — model stalled and produced only filler punctuation.
    const isEllipsisOnly = /^[.…]{2,}$/.test(tSanitized.trim());

    // Split-negation structural check: source ends with a negated auxiliary
    // (the operator whose scope continues into the next segment) but the Korean
    // output contains no negation marker — the predicate was translated without
    // carrying the negation across the segment boundary.
    const srcEndsWithNegAux =
      /\b(don't|won't|can't|didn't|doesn't|haven't|hasn't|couldn't|shouldn't|wouldn't|not)\s*$/i.test(src);
    const tgtMissingNegation = !/않|안|못|없|아니|모르/.test(tSanitized);
    const splitNegationDropped = srcEndsWithNegAux && tgtMissingNegation && tSanitized.length > 0;
    if (splitNegationDropped) {
      console.warn(`[VALIDATE] segment ${i} split-negation dropped: "${src}" → "${tSanitized}"`);
    }

    const needsRetry = tSanitized.length === 0 || isEllipsisOnly || isLikelyUntranslated(tSanitized, targetLanguage) || negationDropped || splitNegationDropped || nounHallucinationFound || leftoverEnglish;
    if (!needsRetry) continue;

    console.warn(`[VALIDATE] segment ${i} queued for retry: "${src}" → "${tSanitized}"`);

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

      const rawCandidate = retryResult.text.trim();
      const candidate    = sanitizeTranslationOutput(rawCandidate, src);
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

  // ── Step 0: Deduplicate overlapping yt-dlp segments ───────────────────────
  // yt-dlp word-level output frequently has segments whose startTime falls
  // inside the previous segment's window (negative gap). This must be resolved
  // into a clean non-overlapping sequence before gap-based merge logic runs.
  const deduped = deduplicateOverlappingSegments(segments);
  console.log(
    `[TRANSLATE] dedup: ${segments.length} → ${deduped.length} segments` +
    ` (${segments.length - deduped.length} overlaps resolved)`
  );

  // ── Step 0b: Lightweight ASR noise cleanup ───────────────────────────────
  // Removes common yt-dlp artefacts from segment text before merging:
  //   • trailing ellipsis runs left by ASR continuation markers
  //   • orphaned closing brackets/parens that have no matching opener
  //     (e.g. "something)" or "something]" emitted by partial captions)
  // Timestamps and start/end are not touched — only the text field.
  const cleanedDeduped = deduped.map(seg => ({
    ...seg,
    text: seg.text
      .replace(/\.{2,}$/, "")
      .replace(/(?<!\()[^)]*\)/g, "")
      .replace(/(?<!\[)[^\]]*\]/g, "")
      .trim(),
  }));

  // ── Step A: Merge yt-dlp word fragments into sentence-level groups ────────
  const mergedGroups       = absorbShortGroups(mergeFragments(cleanedDeduped));
  const mergedSegs: TranslationSegment[] = mergedGroups.map(g => ({
    start: g.start, end: g.end, text: g.text, translated: "",
  }));
  const mergedTotal        = mergedSegs.length;
  const mergedTotalBatches = Math.ceil(mergedTotal / BATCH_SIZE);

  console.log(
    `[TRANSLATE] merged ${deduped.length} → ${mergedTotal} groups` +
    ` (${deduped.length - mergedTotal} fragments combined)`
  );

  // ── Step B: 고유명사 사전 구축 (scan deduplicated segments for full coverage) ─
  const profile     = getLanguageProfile(targetLanguage);
  const properNouns = await buildProperNounDict(deduped, videoHash, targetLanguage);
  const nounHint    = formatNounHint(properNouns);
  const patterns    = buildPatterns(properNouns);
  console.log(`[Gemma] Proper nouns: ${Object.keys(properNouns).length} entries`);

  // ── Step C: 장르 페르소나 + 개선된 시스템 프롬프트 ───────────────────────
  const genrePersona = GENRE_PERSONA[videoGenre] ?? GENRE_PERSONA["general"];
  const langRules    = profile.systemPromptRules.join(" ");

  const systemPrompt =
    `You are a professional Korean subtitle translator. ` +
    (genrePersona ? genrePersona + " " : "") +
    `Translate each numbered English line into natural conversational Korean (구어체). ` +
    `Output ONLY numbered lines. No explanations. One output line per input line. Never skip or merge lines. ` +

    `CORE RULES (follow in order): ` +

    `1. OUTPUT FORMAT ` +
    `Every input line must produce exactly one output line with the same number. ` +
    `Filler-only input (single punctuation, digits only) → output as-is. ` +
    `If the source line is a short fragment (3 words or fewer), keep the translation proportionally short and concise — do not expand into a full sentence. A fragment input should produce a fragment output. ` +
    `Each output line must cover ONLY its own input line's content. The Korean translation length must be proportional to the English source length. A 3-word English fragment must produce a short Korean fragment — not a full sentence summarizing multiple lines. If you find yourself writing more than 15 Korean characters for a source line under 4 words, you are borrowing from adjacent lines — stop. ` +

    `2. MEANING FIRST ` +
    `Translate the intended meaning, not word-for-word. ` +
    `When a word's literal meaning is physically impossible in context, use the contextually correct meaning instead. ` +
    `Do not add meaning that is not in the source line. ` +

    `2b. DEMONSTRATIVE REFERENCE DIRECTION ` +
    `When 'that', 'those', or 'it' is used to dismiss or mock a thing (object, app, service, concept) as old, uncool, or inferior, the predicate of oldness or contempt must attach to THE THING ITSELF in Korean — not to the people associated with it. ` +
    `Example: 'that's our old people like my parents' (dismissing Facebook as outdated) → '그건 우리 부모님처럼 완전 구식이잖아요' NOT '그런 건 부모님 같은 아저씨 아줌마들이나 쓰는 거죠'. ` +
    `The distinction: Korean must predicate 구식/올드함 onto the subject ('그건 구식이에요'), not onto who uses it. ` +

    `3. NEGATION ` +
    `Preserve all negation (not, don't, won't, can't, never). ` +
    `A negated thought split across two lines — where line N ends with a negated auxiliary and line N+1 completes the predicate — must produce a Korean output that contains a negation marker (않/안/못/없) in the translated predicate. ` +

    `4. AGENT DIRECTION ` +
    `For communication verbs (ask, tell, say) with a tool or service as object: the tool is receiving the action, not performing it. ` +
    `'I'll ask [tool]' → tool이 말하는 것이 아니라 화자가 tool에게 묻는 것. ` +

    `5. REGISTER ` +
    `Use 존댓말 (-요/-습니다) for workplace and interview scenes. ` +
    `Sentence-initial casual English fillers (well, look, okay, right used as softeners) → translate by function: attention-getter → '있잖아요', softener → omit if sentence is complete without it. ` +
    `Romantic address forms (자기야/여보) → only when romantic relationship is explicitly confirmed in the immediate context. ` +

    `6. SEGMENT BOUNDARY & CONTEXT READING ` +
    `Each output line translates ONLY the words in its own input line. ` +
    `Never borrow, repeat, or anticipate content from adjacent lines. ` +
    `If the same word or phrase would appear in two consecutive output lines, you have made a boundary error — remove it from the earlier line and keep it only where it appears in the source. ` +
    `For incomplete segments (no verb, or bare noun list), use the surrounding lines as context to understand meaning, but output ONLY a translation of the current line's own words: ` +
    `Bare noun/app list → translate as neutral comma-separated list, no evaluative words added. ` +
    `Incomplete clause fragment → translate as a natural fragment, do not complete it with content from the next line. ` +
    `CONTEXT RULE: Read the full batch to understand the scene and speaker relationships before translating any single line. ` +
    `Use that understanding to select the correct register, implied subject, and emotional tone — but never import specific words from other lines into the current line's translation. ` +

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
      const offset = batchIdx * BATCH_SIZE;
      const batch  = mergedSegs.slice(offset, offset + BATCH_SIZE);

      console.log(`[TRANSLATE] batch ${batchIdx + 1}/${mergedTotalBatches}, groups: ${batch.length}`);

      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemPrompt },
      ];

      // Add previous batch as context if available (sliding window of 1 batch)
      if (batchIdx > 0) {
        const prevOffset = (batchIdx - 1) * BATCH_SIZE;
        const prevBatch  = mergedSegs.slice(prevOffset, prevOffset + BATCH_SIZE);
        const prevResult = mergedTranslations
          .slice(prevOffset, prevOffset + BATCH_SIZE)
          .map((t, i) => `${i + 1}. ${t}`)
          .join("\n");

        messages.push({
          role: "user",
          content: buildBatchMessage(prevBatch, 0),
        });
        messages.push({
          role: "assistant",
          content: prevResult,
        });
      }

      // Current batch
      messages.push({
        role: "user",
        content: buildBatchMessage(batch, 0),
      });

      const result = await llamaContext.completion({
        messages,
        n_predict:   batch.length * 120,
        temperature: 0.15,
        top_p:       0.9,
        stop:        ["</s>", "<end_of_turn>", "<|end|>"],
      });

      const translations = parseBatchResponse(result.text, batch, 0, patterns);
      for (let i = 0; i < batch.length; i++) {
        mergedTranslations[offset + i] = translations[i];
      }

      // Expand to deduplicated segment array for progress callback
      const expandedPartial = expandGroupTranslations(mergedGroups, mergedTranslations, deduped);
      onProgress?.(
        offset + batch.length,
        mergedTotal,
        mergeWithTranslations(deduped, expandedPartial)
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
    const partialExpanded = expandGroupTranslations(mergedGroups, mergedTranslations, deduped);
    return mergeWithTranslations(deduped, partialExpanded);
  }

  await deleteCheckpoint(videoHash);

  // ── Step F: Re-expand merged translations → original segment slots ────────
  const translatedTexts = expandGroupTranslations(mergedGroups, mergedTranslations, deduped);

  // ── Step G: 번역 실패 세그먼트 재시도 (최대 2회, deduplicated segments) ────
  // Retries operate on deduplicated segments to fix expansion artifacts or LLM gaps.
  // 조건 1: translated 텍스트가 비어있는 경우.
  // 조건 2: translated 텍스트가 원문 영어와 동일하고 원문 길이가 15자 초과인 경우.
  // 조건 3: 모델이 번호만 출력한 경우.
  const MAX_RETRY_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    const failedIndices: number[] = [];
    for (let i = 0; i < deduped.length; i++) {
      const t   = translatedTexts[i];
      const src = deduped[i].text.trim();
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

    const retryBatch = failedIndices.map((i) => deduped[i]);
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
    deduped, translatedTexts, systemPrompt, targetLanguage, patterns
  );

  // ── Step I: Assemble final segments + Netflix-style timing adjustment ─────
  const completed = adjustTimingsForReadability(
    mergeWithTranslations(deduped, validatedTexts)
  );
  console.log(`[Gemma] Translation complete: ${completed.length} segments.`);
  return completed;
}
