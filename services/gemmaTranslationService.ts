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
interface MergedGroup {
  start: number;
  end: number;
  text: string;
  originalIndices: number[];
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MODEL_PATH = FileSystem.documentDirectory + "gemma-models/gemma-3n-e2b-q4.gguf";
const BATCH_SIZE = 5;
const SLEEP_BETWEEN_MS = 600;
const SLEEP_THERMAL_MS = 2500;
const THERMAL_EVERY_N = 5;
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const PROPER_NOUN_MIN_COUNT = 3;

const MERGE_MAX_GAP_S = 0.5;
const MERGE_MAX_DURATION_S = 2.5;
const MERGE_MAX_WORDS = 8;
const SHORT_WORD_MAX = 2;
const SHORT_DURATION_MAX_S = 1.5;

const SECS_PER_CHAR_KO = 0.065;
const MAX_TIMING_OVERLAP = 0.1;

// ── sanitizeTranslationOutput regex constants ─────────────────────────────────
const RE_STAGE_DIRECTION_KO = /\(혼잣말\)|\(독백\)|\(방백\)|\(내레이션\)/g;
const RE_PARENS_ANY = /\([^)]*\)/g;
const RE_ENGLISH_WORD = /\b([a-zA-Z]{3,})\b/g;
const RE_NUMERIC_TOKEN = /^\d+([:.]\d+)*$/;

// ── [FIX v2] 환각 방지용 소셜미디어 앱 정규화 사전 ───────────────────────────
// vine, snapchat 등을 일반 단어로 오해하는 현상 방지
const SOCIAL_MEDIA_NORMALIZATION: Record<string, string> = {
  "vine":       "Vine",
  "snapchat":   "Snapchat",
  "pinterest":  "Pinterest",
  "instagram":  "Instagram",
  "twitter":    "Twitter",
  "facebook":   "Facebook",
  "tiktok":     "TikTok",
  "youtube":    "YouTube",
  "linkedin":   "LinkedIn",
  "reddit":     "Reddit",
  "discord":    "Discord",
  "twitch":     "Twitch",
};

// ── [FIX v2] 번역 후처리: 환각 패턴 제거 ────────────────────────────────────
// "baby", "자기야" 등 원문에 없는 호칭 환각 제거
const RE_HALLUCINATED_TERMS_KO = /\b자기야\b[,\s]*/g;

const GENRE_PERSONA: Record<string, string> = {
  "tech lecture": "You specialize in technology and programming subtitles.",
  "comedy": "You specialize in comedy subtitles. Preserve humor, sarcasm, irony, and exaggeration. Use casual, natural Korean (구어체). Translate the emotional tone and comedic intent, not just the literal words. Slang and idioms should be translated by feel and meaning. Translate idioms and slang by meaning, not literally. Examples: 'surprised you didn't save Facebook' in context of listing social media apps means 'surprised you didn't include/mention Facebook' → 'Facebook은 왜 빠뜨린 거예요?'. 'ready to go at 8:00 sharp' → '아침 8시 정각에 준비 완료'. 'mental health day' → '정신건강의 날 (하루 쉬는 날)'. 'that\\'s our old people like my parents' means Facebook is what old people (like her parents) use — dismissive teen attitude → '그건 저희 부모님 같은 아저씨 아줌마들이 쓰는 거죠.'. 'you don\\'t work here' said to someone = telling them they have no authority here → '여기서 일하지도 않잖아요'. 'are you firing me' = shocked reaction → '저 해고하시는 거예요?'. 'good fit' in an interview context means compatibility, not physical fitness → '잘 맞을 것 같지 않아'. 'Vine' is a social media app, not a plant vine → translate as '바인(Vine)'.",
  "news": "You specialize in news subtitles, using formal and precise language.",
  "documentary": "You specialize in documentary narration, using descriptive language.",
  "gaming": "You specialize in gaming content, preserving gamer slang and terms.",
  "education": "You specialize in educational content for learners.",
  "general": "",
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

// ── [FIX v2] 소셜미디어 앱명 정규화 ─────────────────────────────────────────
// 입력 텍스트에서 소문자로 된 앱 이름을 고유명사로 대문자 정규화
// vine → Vine, snapchat → Snapchat 등
function normalizeSocialMediaNames(text: string): string {
  let result = text;
  for (const [lower, proper] of Object.entries(SOCIAL_MEDIA_NORMALIZATION)) {
    result = result.replace(
      new RegExp(`(?<![a-zA-Z])${escapeRegex(lower)}(?![a-zA-Z])`, "gi"),
      proper
    );
  }
  return result;
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
        model: modelPath,
        n_threads: 4,
        n_gpu_layers: 0,
        n_ctx: 4096,
        use_mlock: true,
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
function deduplicateOverlappingSegments(
  segments: TranslationSegment[]
): TranslationSegment[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const result: TranslationSegment[] = [];
  let accStart = sorted[0].start;
  let accEnd = sorted[0].end;
  let accText = sorted[0].text.trim();
  let accWords = accText.toLowerCase().split(/\s+/).filter(Boolean);

  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i];
    const OVERLAP_THRESHOLD = 0.05;
    if (seg.start < accEnd - OVERLAP_THRESHOLD) {
      const incomingWords = seg.text.trim().split(/\s+/).filter(Boolean);
      const seen = new Set(accWords);
      for (const w of incomingWords) {
        if (!seen.has(w.toLowerCase())) {
          accText += " " + w;
          accWords.push(w.toLowerCase());
          seen.add(w.toLowerCase());
        }
      }
      accEnd = Math.max(accEnd, seg.end);
    } else {
      result.push({ start: accStart, end: accEnd, text: accText.trim(), translated: "" });
      accStart = seg.start;
      accEnd = seg.end;
      accText = seg.text.trim();
      accWords = accText.toLowerCase().split(/\s+/).filter(Boolean);
    }
  }
  result.push({ start: accStart, end: accEnd, text: accText.trim(), translated: "" });
  return result;
}

function isFillerText(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || /^[\d\s.,;:!?'"()[\]-]+$/.test(t);
}

const CONTINUATION_WORDS = /^(gonna|going|been|have|just|really|so|that|the|a|an|to|be|get|even|don't|i|and|in|until|like)\b/i;
const MERGE_CONTINUATION_GAP_S = 1.5;

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
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      originalIndices: [i],
    };
    let j = i + 1;
    while (j < segments.length) {
      const next = segments[j];
      if (isFillerText(next.text)) break;
      const gap = next.start - group.end;
      const projectedDuration = next.end - group.start;
      const projectedText = group.text + " " + next.text.trim();
      const wordCount = projectedText.split(/\s+/).filter(Boolean).length;
      const hasTerminal = /[.!?]$/.test(group.text);

      const accHasCompleteClause = /\b(I|you|we|they|he|she|it)\b.{4,}/i.test(group.text);
      const nextStartsNewClause = /^(I|you|we|they|he|she|it|[A-Z][a-z])\b/i.test(next.text.trim());
      if (accHasCompleteClause && nextStartsNewClause) break;

      const isContinuation = !hasTerminal && CONTINUATION_WORDS.test(next.text.trim());
      const effectiveGapCap = isContinuation ? MERGE_CONTINUATION_GAP_S : MERGE_MAX_GAP_S;
      const isShortBackchannel = /^(yeah|yes|no|right|ok|okay|sure|great|fine|well|hmm|oh|ah|uh|exactly|absolutely|definitely|seriously|really|wait|what|huh)$/i.test(next.text.trim());
      const isLikelyEnglish =
        /^[a-zA-Z\s'.,!?]+$/.test(next.text.trim()) &&
        /\b(the|and|but|or|you|I|we|is|are|it|a|to|of|in|that|have|for)\b/i.test(next.text);
      const isVeryShort =
        !isShortBackchannel &&
        next.text.trim().split(/\s+/).length <= 2 &&
        (!isLikelyEnglish ||
          !/^(and|but|or|so|that|to|if|because|when|don't|can't|going|gonna|want|have|need)/i.test(next.text.trim()));
      const nextStartsLower =
        /^[a-z]/.test(next.text.trim()) ||
        (typeof next.text === "string" && next.text.trim()[0] === next.text.trim()[0].toLowerCase());
      const groupHasNoTerminal = !/[.!?]$/.test(group.text);
      if (
        nextStartsLower &&
        groupHasNoTerminal &&
        gap < MERGE_CONTINUATION_GAP_S &&
        !isShortBackchannel &&
        !isVeryShort
      ) {
        group.text = projectedText;
        group.end = next.end;
        group.originalIndices.push(j);
        j++;
        continue;
      }
      if (
        gap >= effectiveGapCap ||
        projectedDuration > MERGE_MAX_DURATION_S ||
        wordCount > MERGE_MAX_WORDS ||
        hasTerminal
      ) break;
      group.text = projectedText;
      group.end = next.end;
      group.originalIndices.push(j);
      j++;
    }
    groups.push(group);
    i = j;
  }
  return groups;
}

function absorbShortGroups(groups: MergedGroup[]): MergedGroup[] {
  if (groups.length <= 1) return groups;
  const result: MergedGroup[] = [];
  let i = 0;
  while (i < groups.length) {
    const g = groups[i];
    const words = g.text.trim().split(/\s+/).filter(Boolean).length;
    const duration = g.end - g.start;
    const isShort = !isFillerText(g.text) && words <= SHORT_WORD_MAX && duration < SHORT_DURATION_MAX_S;
    if (isShort && i < groups.length - 1) {
      const next: MergedGroup = groups[i + 1];
      result.push({
        start: g.start,
        end: next.end,
        text: g.text.trim() + " " + next.text.trim(),
        originalIndices: [...g.originalIndices, ...next.originalIndices],
      });
      i += 2;
    } else if (isShort && result.length > 0) {
      const prev = result[result.length - 1];
      prev.text = prev.text.trim() + " " + g.text.trim();
      prev.end = g.end;
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
function expandGroupTranslations(
  groups: MergedGroup[],
  groupTranslations: string[],
  originalSegments: TranslationSegment[]
): string[] {
  const result: string[] = new Array(originalSegments.length).fill("");
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const translation = groupTranslations[gi] ?? "";
    const { originalIndices } = group;
    if (originalIndices.length >= 3) {
      const charLength = translation.replace(/\s+/g, "").length;
      const charsPerSlot = charLength / originalIndices.length;
      if (charsPerSlot < 6) {
        const sentences = translation.split(/(?<=[.!?])\s+/).filter(Boolean);
        if (sentences.length >= 2) {
          const firstSentences = sentences.slice(0, Math.ceil(sentences.length / 2)).join(" ");
          const secondSentences = sentences.slice(Math.ceil(sentences.length / 2)).join(" ");
          const firstCharRatio = firstSentences.length /
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
          for (let k = 1; k < originalIndices.length; k++) result[originalIndices[k]] = "";
          result[originalIndices[splitSlot]] = secondSentences;
          for (let k = splitSlot + 1; k < originalIndices.length; k++) result[originalIndices[k]] = "";
        } else {
          result[originalIndices[0]] = translation;
          for (let k = 1; k < originalIndices.length; k++) result[originalIndices[k]] = "";
        }
        continue;
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
      const idx = originalIndices[k];
      const isLast = k === originalIndices.length - 1;
      if (isLast) {
        result[idx] = words.slice(wordOffset).join(" ");
      } else {
        const fraction = originalSegments[idx].text.trim().length / totalSrcChars;
        const count = Math.max(1, Math.round(fraction * words.length));
        result[idx] = words.slice(wordOffset, wordOffset + count).join(" ");
        wordOffset += count;
      }
    }
    for (let k = originalIndices.length - 1; k > 0; k--) {
      const idxA = originalIndices[k - 1];
      const idxB = originalIndices[k];
      const a = result[idxA].trim();
      const b = result[idxB].trim();
      if (!a || !b) continue;
      if (a === b) { result[idxA] = ""; continue; }
      if (a.includes(b)) { result[idxA] = ""; continue; }
      if (b.includes(a)) { result[idxB] = ""; continue; }
      const OVERLAP_MIN = 6;
      const maxCheck = Math.min(a.length, b.length);
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
export function adjustTimingsForReadability(
  segments: TranslationSegment[]
): TranslationSegment[] {
  const result = segments.map(seg => ({ ...seg }));
  for (const seg of result) {
    const originalDuration = seg.end - seg.start;
    const charCount = (seg.translated || seg.text).length;
    const minDuration = charCount * SECS_PER_CHAR_KO;
    if (minDuration > originalDuration) {
      seg.end = seg.start + minDuration;
    }
  }
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
  const allUpperPattern = /\b([A-Z][a-zA-Z]{2,})\b/g;
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
      const entry = stats.get(word) ?? { mid: 0, first: 0 };
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
    n_predict: nouns.length * 20,
    temperature: 0.1,
    top_p: 0.9,
    stop: ["</s>", "<end_of_turn>", "<|end|>"],
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
  const stored = await AsyncStorage.getItem(properNounKey(videoHash));
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
  cachedDictKey = key;
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

// [FIX v2] 배치 메시지 생성 시 소셜미디어 앱명 정규화 적용
function buildBatchMessage(batch: TranslationSegment[], batchOffset: number): string {
  return batch
    .map((seg, i) => `${batchOffset + i + 1}. ${normalizeSocialMediaNames(cleanWhisperText(seg.text))}`)
    .join("\n");
}

// ── Text cleaning & parsing functions ─────────────────────────────────────────
export function sanitizeTranslationOutput(text: string, sourceText: string): string {
  let out = text;
  out = out.replace(RE_STAGE_DIRECTION_KO, "");
  // [FIX v2] 환각 호칭("자기야" 등) 제거 — 원문에 "baby"가 없는데 번역에 삽입되는 현상
  if (!/\bbaby\b/i.test(sourceText)) {
    out = out.replace(RE_HALLUCINATED_TERMS_KO, "");
  }
  if (!sourceText.includes("(") && !sourceText.includes(")")) {
    out = out.replace(RE_PARENS_ANY, "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

export function hasLeftoverEnglish(
  translated: string,
  sourceText: string,
  patterns: CompiledNounPattern[],
  targetLanguage: string
): boolean {
  const profile = getLanguageProfile(targetLanguage);
  if (profile.isLatinScript) return false;
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
    if (RE_NUMERIC_TOKEN.test(word)) continue;
    if (knownEnglish.has(word.toLowerCase())) continue;
    if (knownTranslit.has(word.toLowerCase())) continue;
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
function isLikelyUntranslated(translated: string, targetLanguage: string): boolean {
  const profile = getLanguageProfile(targetLanguage);
  const t = translated.trim();
  if (!t) return true;
  if (profile.isLatinScript) return false;
  const nonSpace = t.replace(/\s/g, "");
  const asciiLatin = (nonSpace.match(/[a-zA-Z]/g) ?? []).length;
  return nonSpace.length > 0 && asciiLatin / nonSpace.length > 0.9;
}

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
    const t = result[i]?.trim() ?? "";
    const src = segments[i].text.trim();
    if (isFillerText(src)) continue;

    const hasTerminalPunct = /[.!?]$/.test(src);
    const nextSrc = (!hasTerminalPunct && i + 1 < segments.length)
      ? segments[i + 1].text.trim()
      : "";
    const logicalSrc = nextSrc ? `${src} ${nextSrc}` : src;
    const srcHasNegation = /\bdon't think\b|\bi don't think\b|\bnot a\b|\bdoesn't work\b|\bdon't work\b|\bcan't\b|\bwon't\b/i.test(logicalSrc);
    const tgtHasNegation = /않|안|못|없|아니|모르/.test(t);
    const negationDropped = srcHasNegation && t.length > 0 && !tgtHasNegation;

    const HALLUCINATION_GUARD: Array<[korean: string, english: RegExp]> = [
      ["시리", /\bsiri\b/i],
      ["알렉사", /\balexa\b/i],
      ["구글", /\bgoogle\b/i],
    ];
    const nounHallucinationFound =
      HALLUCINATION_GUARD.some(([ko, enRe]) => t.includes(ko) && !enRe.test(src)) ||
      patterns.some(p => {
        return p.tgt && t.includes(p.tgt) && !new RegExp(`\\b${p.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(src);
      });

    result[i] = sanitizeTranslationOutput(t, src);
    const tSanitized = result[i];
    const leftoverEnglish = hasLeftoverEnglish(tSanitized, src, patterns, targetLanguage);

    const profile = getLanguageProfile(targetLanguage);
    const hasForeignChar =
      !profile.isLatinScript &&
      /[a-zA-Z\u0400-\u04FF\u3040-\u30ff\u4e00-\u9fff]/.test(tSanitized);
    const hasForeignCharLatin =
      profile.isLatinScript &&
      /[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(tSanitized);

    const isEllipsisOnly = /^[.…]{2,}$/.test(tSanitized.trim());
    const srcEndsWithNegAux =
      /\b(don't|won't|can't|didn't|doesn't|haven't|hasn't|couldn't|shouldn't|wouldn't|not)\s*$/i.test(src);
    const tgtMissingNegation = !/않|안|못|없|아니|모르/.test(tSanitized);
    const splitNegationDropped = srcEndsWithNegAux && tgtMissingNegation && tSanitized.length > 0;

    // [FIX v2] "good fit" 오역 감지: 원문에 "fit"이 있고 번역에 신체 관련 단어가 들어온 경우
    const goodFitMistranslated =
      /\bgood\s+fit\b/i.test(src) &&
      /몸|체형|체격|사이즈|맞는 몸/.test(tSanitized);

    const needsRetry =
      tSanitized.length === 0 ||
      isEllipsisOnly ||
      isLikelyUntranslated(tSanitized, targetLanguage) ||
      negationDropped ||
      splitNegationDropped ||
      nounHallucinationFound ||
      leftoverEnglish ||
      hasForeignCharLatin ||
      goodFitMistranslated;  // [FIX v2]

    if (!needsRetry) continue;

    console.warn(`[VALIDATE] segment ${i} queued for retry: "${src}" → "${tSanitized}"`);
    try {
      const singlePrompt =
        `Translate this single English subtitle line to natural ${targetLanguage}. ` +
        `Output ONLY the ${targetLanguage} translation, nothing else:\n${src}`;
      const retryResult = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: singlePrompt },
        ],
        n_predict: 80,
        temperature: 0.1,
        top_p: 0.9,
        stop: ["</s>", "<end_of_turn>", "<|end|>", "\n"],
      });
      const rawCandidate = retryResult.text.trim();
      const candidate = sanitizeTranslationOutput(rawCandidate, src);
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
  const deduped = deduplicateOverlappingSegments(segments);
  console.log(
    `[TRANSLATE] dedup: ${segments.length} → ${deduped.length} segments` +
    ` (${segments.length - deduped.length} overlaps resolved)`
  );

  // ── Step 0b: Lightweight ASR noise cleanup ───────────────────────────────
  const cleanedDeduped = deduped.map(seg => ({
    ...seg,
    // [FIX v2] 소셜미디어 앱명 정규화도 여기서 적용
    text: normalizeSocialMediaNames(
      seg.text
        .replace(/\.{2,}$/, "")
        .replace(/(?<!\()[^)]*\)/g, "")
        .replace(/(?<!\[)[^\]]*\]/g, "")
        .trim()
    ),
  }));

  // ── Step A: Merge yt-dlp word fragments into sentence-level groups ────────
  const mergedGroups = absorbShortGroups(mergeFragments(cleanedDeduped));
  const mergedSegs: TranslationSegment[] = mergedGroups.map(g => ({
    start: g.start, end: g.end, text: g.text, translated: "",
  }));
  const mergedTotal = mergedSegs.length;
  const mergedTotalBatches = Math.ceil(mergedTotal / BATCH_SIZE);
  console.log(
    `[TRANSLATE] merged ${deduped.length} → ${mergedTotal} groups` +
    ` (${deduped.length - mergedTotal} fragments combined)`
  );

  // ── Step B: 고유명사 사전 구축 ─────────────────────────────────────────────
  const profile = getLanguageProfile(targetLanguage);
  const properNouns = await buildProperNounDict(deduped, videoHash, targetLanguage);
  const nounHint = formatNounHint(properNouns);
  const patterns = buildPatterns(properNouns);
  console.log(`[Gemma] Proper nouns: ${Object.keys(properNouns).length} entries`);

  // ── Step C: 장르 페르소나 + 시스템 프롬프트 ───────────────────────────────
  const genrePersona = GENRE_PERSONA[videoGenre] ?? GENRE_PERSONA["general"];
  const langRules = profile.systemPromptRules.join(" ");

  const systemPrompt =
  `You are a professional subtitle translator.\n` +
  `Do not explain. Do not analyze. Do not output reasoning.\n\n` +
  (genrePersona ? genrePersona + "\n" : "") +
  `Translate each numbered line into natural ${langRules}.\n` +
  `Output ONLY numbered lines. One output line per input line. Never skip or merge lines.\n\n` +
  `CORE RULES:\n` +
  `1. OUTPUT FORMAT\n` +
  `Each input line must produce exactly one output line with the same number.\n` +
  `Filler-only input (punctuation, digits) → output as-is.\n` +
  `Adjacent fragments may be combined ONLY if the next fragment:\n` +
  `- starts with a lowercase conjunction (and/but/or/so/because/when/if), OR\n` +
  `- is a very short (≤2 words in source) conversational filler typical in spoken ${targetLanguage}.\n` +
  `Do NOT infer, reconstruct, or add meaning beyond the exact words given.\n` +
  `Preserve original sentence structure whenever possible.\n` +
  `Incomplete input must remain incomplete — do not complete the thought.\n\n` +
  `2. MEANING\n` +
  `Translate intended meaning, not word-for-word.\n` +
  `Do not add information not present in the source.\n` +
  `Use context only to resolve ambiguity, not to add content.\n\n` +
  `3. NEGATION\n` +
  `Preserve negation meaning (not, don't, can't, never).\n\n` +
  `4. ROLE DIRECTION\n` +
  `Maintain correct subject/object relationships.\n\n` +
  `5. TONE\n` +
  `Use natural, context-appropriate tone in the target language.\n` +
  // [FIX v2] 호칭 환각 방지 규칙 명시
  `NEVER add terms of endearment or informal nicknames (like "자기야", "honey", "baby") unless explicitly present in the source.\n\n` +
  `6. SEGMENT BOUNDARY\n` +
  `Translate ONLY the content of the current line.\n` +
  `Do NOT borrow or repeat content from adjacent lines.\n` +
  `Incomplete fragments must remain incomplete.\n` +
  `Lists should remain neutral lists.\n\n` +
  `7. CONSISTENCY\n` +
  `Avoid repetition and hallucination.\n\n` +
  `8. DISCOURSE MARKERS\n` +
  `Translate conversational expressions naturally.\n` +
  `"you know" → "알잖아요"\n` +
  `Do NOT convert them into factual statements.\n\n` +
  `9. LANGUAGE PURITY\n` +
  `Output MUST be written ONLY in the target language.\n` +
  `Do NOT include words or characters from other languages.\n` +
  `If a word is unknown, translate or transliterate it into the target language.\n` +
  `Never copy foreign words directly unless they are proper nouns.\n\n` +
  `10. FOREIGN WORD HANDLING\n` +
  `Translate common software/tools into localized names.\n` +
  `Example: "Excel" → "엑셀"\n` +
  // [FIX v2] Vine 오역 방지 명시
  `Social media app names are proper nouns — keep them as-is or transliterate phonetically.\n` +
  `"Vine" is a social media app → "바인(Vine)" NOT "덩굴" or "포도나무".\n` +
  `"good fit" in a job interview context means compatibility → "잘 맞다" NOT physical fitness.\n` +
  `Avoid leaving English or other language words untranslated.\n\n` +
  langRules +
  nounHint;

  // ── Step D: 체크포인트 복원 ───────────────────────────────────────────────
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

  // ── Step E: 배치 번역 ─────────────────────────────────────────────────────
  try {
    for (let batchIdx = startBatch; batchIdx < mergedTotalBatches; batchIdx++) {
      const offset = batchIdx * BATCH_SIZE;
      const batch = mergedSegs.slice(offset, offset + BATCH_SIZE);
      console.log(`[TRANSLATE] batch ${batchIdx + 1}/${mergedTotalBatches}, groups: ${batch.length}`);

      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemPrompt },
      ];

      // [FIX v3] previous batch reference 완전 제거
      // Gemma 3n 같은 소형 모델은 "참고만 해라" 지시를 무시하고
      // 이전 배치 번역을 그대로 복사하는 심각한 오염을 일으킨다.
      // 고유명사 일관성은 system prompt의 nounHint로 충분히 보장된다.
      const currentBatchMessage = buildBatchMessage(batch, 0);

      messages.push({ role: "user", content: currentBatchMessage });

      const result = await llamaContext.completion({
        messages,
        n_predict: batch.length * 120,
        temperature: 0.15,
        top_p: 0.9,
        stop: ["</s>", "<end_of_turn>", "<|end|>"],
      });

      const translations = parseBatchResponse(result.text, batch, 0, patterns);
      for (let i = 0; i < batch.length; i++) {
        mergedTranslations[offset + i] = translations[i];
      }

      const expandedPartial = expandGroupTranslations(mergedGroups, mergedTranslations, deduped);
      onProgress?.(
        offset + batch.length,
        mergedTotal,
        mergeWithTranslations(deduped, expandedPartial)
      );

      await saveCheckpoint(videoHash, {
        translatedTexts: mergedTranslations,
        lastBatchIndex: batchIdx,
        properNouns,
        totalBatches: mergedTotalBatches,
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

  // ── Step G: 번역 실패 세그먼트 재시도 ─────────────────────────────────────
  const MAX_RETRY_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    const failedIndices: number[] = [];
    for (let i = 0; i < deduped.length; i++) {
      const t = translatedTexts[i];
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
    const retryMsg = buildBatchMessage(retryBatch, 0);
    try {
      const retryResult = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: retryMsg },
        ],
        n_predict: retryBatch.length * 120,
        temperature: 0.15,
        top_p: 0.9,
        stop: ["</s>", "<end_of_turn>", "<|end|>"],
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

  // ── Step H: Post-translation validation ───────────────────────────────────
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