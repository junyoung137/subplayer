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

const SECS_PER_CHAR_KO = 0.065;
const MAX_TIMING_OVERLAP = 0.1;

// Netflix 레이아웃 상수
const NETFLIX_MAX_CHARS_PER_LINE = 20;
const NETFLIX_MIN_CHARS_FOR_SPLIT = 15;

// expand: gap 기준 자연 분할 임계값
const EXPAND_GAP_THRESHOLD_S = 0.8;

// ── [핵심 수정] 병합 금지 gap 임계값 ──────────────────────────────────────────
// 이전: MERGE_GAP_HARD_LIMIT_S = 1.5 (너무 관대 — "Yeah"→"Yes" 0.76s gap도 못 막음)
// 수정: 0.6s — 대화 흐름상 0.6s 이상이면 다른 발화자 or 다른 문장
const MERGE_GAP_HARD_LIMIT_S = 0.6;

// ── 소셜미디어 앱명 정규화 ────────────────────────────────────────────────────
const SOCIAL_MEDIA_NORMALIZATION: Record<string, string> = {
  "vine": "Vine", "snapchat": "Snapchat", "pinterest": "Pinterest",
  "instagram": "Instagram", "twitter": "Twitter", "facebook": "Facebook",
  "tiktok": "TikTok", "youtube": "YouTube", "linkedin": "LinkedIn",
  "reddit": "Reddit", "discord": "Discord", "twitch": "Twitch",
};

// ── 환각 / 오염 패턴 ──────────────────────────────────────────────────────────
const RE_HALLUCINATED_TERMS_KO = /자기야[,，\s]*|자기[,，\s]+|여보[,，\s]*|오빠[,，\s]*|언니[,，\s]*/g;
// [수정] baby는 비격식 호칭어(informal address)로, 자기야가 아닌 이름/생략으로 처리해야 함
// HALLUCINATION_GUARD는 "honey/sweetie/darling/dear/oppa/unnie"만 유지 — baby 제외
const RE_HALLUCINATION_GUARD = /\b(honey|sweetie|darling|dear|oppa|unnie)\b/i;
const RE_OUTPUT_CORRUPTION = /^##\s*Translation\s*:?\s*/i;
const RE_UNTRANSLATED_MARKER = /^\[미번역\]\s*/;
const RE_STAGE_DIRECTION_KO = /\(혼잣말\)|\(독백\)|\(방백\)|\(내레이션\)/g;
const RE_PARENS_ANY = /\([^)]*\)/g;
const RE_ENGLISH_WORD = /\b([a-zA-Z]{3,})\b/g;
const RE_NUMERIC_TOKEN = /^\d+([:.]\d+)*$/;

// ── [Fix 1] 숫자 접두사 오염 패턴 ────────────────────────────────────────────
const RE_NUMBERED_PREFIX = /^\d+\.\s+/;

// ── [Fix 2] 어색한 지시사 패턴 ────────────────────────────────────────────────
const RE_AWKWARD_DEMONSTRATIVE = /^저것은\s/;
const RE_AWKWARD_DEMONSTRATIVE_I = /^저것이\s/;

// ── 장르 페르소나 ─────────────────────────────────────────────────────────────
const GENRE_PERSONA: Record<string, string> = {
  "tech lecture": "You specialize in technology and programming subtitles.",
  "comedy": "You specialize in comedy subtitles. Preserve humor, sarcasm, irony, and casual tone (구어체). Translate emotional intent and comedic meaning, not just literal words.",
  "news": "You specialize in news subtitles using formal, precise language.",
  "documentary": "You specialize in documentary narration using descriptive language.",
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

let llamaContext: LlamaContext | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function checkpointKey(h: string) { return `gemma_checkpoint_v4_${h}`; }
function properNounKey(h: string) { return `proper_nouns_${h}`; }
function escapeRegex(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeSocialMediaNames(text: string): string {
  let r = text;
  for (const [lower, proper] of Object.entries(SOCIAL_MEDIA_NORMALIZATION)) {
    r = r.replace(new RegExp(`(?<![a-zA-Z])${escapeRegex(lower)}(?![a-zA-Z])`, "gi"), proper);
  }
  return r;
}

// ── Model lifecycle ───────────────────────────────────────────────────────────
export async function loadModel(onProgress?: (fraction: number) => void): Promise<void> {
  if (llamaContext) return;
  const info = await FileSystem.getInfoAsync(MODEL_PATH);
  if (!info.exists) throw new Error("Gemma 모델 파일을 찾을 수 없습니다. 먼저 다운로드해 주세요.");
  const modelPath = MODEL_PATH.startsWith("file://") ? MODEL_PATH.slice(7) : MODEL_PATH;
  try {
    llamaContext = await initLlama(
      { model: modelPath, n_threads: 4, n_gpu_layers: 0, n_ctx: 4096, use_mlock: true },
      onProgress ? (p: number) => onProgress(p / 100) : undefined
    );
    console.log("[Gemma] Model loaded.");
  } catch (e) {
    llamaContext = null;
    throw new Error(`Gemma 모델 로드 실패: ${(e as Error).message}`);
  }
}

export async function unloadModel(): Promise<void> {
  if (!llamaContext) return;
  try { await llamaContext.release(); } catch (e) { console.warn("[Gemma] release error:", e); }
  llamaContext = null;
}

// ── Deduplication ─────────────────────────────────────────────────────────────
function deduplicateOverlappingSegments(segments: TranslationSegment[]): TranslationSegment[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const result: TranslationSegment[] = [];
  let { start: accStart, end: accEnd, text: accText } = sorted[0];
  accText = accText.trim();
  let accWords = accText.toLowerCase().split(/\s+/).filter(Boolean);

  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i];
    if (seg.start < accEnd - 0.05) {
      const incoming = seg.text.trim().split(/\s+/).filter(Boolean);
      const seen = new Set(accWords);
      for (const w of incoming) {
        if (!seen.has(w.toLowerCase())) { accText += " " + w; accWords.push(w.toLowerCase()); seen.add(w.toLowerCase()); }
      }
      accEnd = Math.max(accEnd, seg.end);
    } else {
      result.push({ start: accStart, end: accEnd, text: accText.trim(), translated: "" });
      ({ start: accStart, end: accEnd } = seg);
      accText = seg.text.trim();
      accWords = accText.toLowerCase().split(/\s+/).filter(Boolean);
    }
  }
  result.push({ start: accStart, end: accEnd, text: accText.trim(), translated: "" });
  return result;
}

function isFillerText(text: string): boolean {
  return text.trim().length === 0 || /^[\d\s.,;:!?'"()[\]-]+$/.test(text.trim());
}

// ── [핵심 수정] isShortIndependent — 1~3단어 독립 발화 보호 ────────────────────
/**
 * 이전 isSingleWordIndependent(1단어만)에서 확장.
 * 1~3단어이면서 완결된 의미 단위인 경우 병합 금지.
 *
 * 보호 케이스:
 *   1) 1단어 물음표   — "PowerPoint?", "Publisher?"
 *   2) yes/no 계열    — "No", "Yes", "Yeah", "Nope", "Not really", "Okay yes"
 *   3) 감탄사/호응    — "Hmm", "Wow", "Oh", "That's funny"
 *   4) 단일 고유명사  — "Amy", "Twitter" (대문자 시작 1단어)
 *   5) 짧은 완결 동사 — "I do", "I will", "You do"
 *   6) 감정/반응 짧은 문장 — 3단어 이하 + 마침표/느낌표로 끝
 */
function isShortIndependent(t: string): boolean {
  const trimmed = t.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wc = words.length;

  // 4단어 이상은 보호 대상 아님
  if (wc === 0 || wc > 3) return false;

  const word = words[0];

  // 케이스 1: 단일 단어 물음표
  if (wc === 1 && word.endsWith("?")) return true;

  // 케이스 2: yes/no 계열 (단어 수 무관, 3단어 이하)
  if (/^(no|yes|yeah|nope|yep|nah|not\s+really|okay\s+yes|alright|sure|right)$/i.test(trimmed)) return true;

  // 케이스 3: 감탄사/호응어 (1단어)
  if (wc === 1 && /^(hmm|hm|uh|um|oh|wow|okay|ok|hey|right|sure|fine|well|whoa|ow|ugh|yikes|oops)$/i.test(word)) return true;

  // 케이스 4: 단일 고유명사 호칭 (대문자 시작, 알파벳만, 2~12자)
  if (wc === 1 && /^[A-Z][a-zA-Z]{1,11}$/.test(word)) return true;

  // 케이스 5: 짧은 완결 동사 구문 ("I do", "I will", "You do", "I get it")
  if (wc <= 3 && /^(i|you|we|they)\s+(do|did|will|won't|can|can't|get|got|know|see|am|was)$/i.test(trimmed)) return true;

  // 케이스 6: 2~3단어 + 마침표/느낌표 (완결된 짧은 문장)
  // "That's funny.", "I see.", "Me too." 등
  if (wc >= 2 && wc <= 3 && /[.!]$/.test(trimmed)) return true;

  // 케이스 7: "That's [형용사]" 패턴 — "That's funny", "That's great"
  if (wc === 2 && /^that's\s+\w+$/i.test(trimmed)) return true;

  return false;
}

// ── Fragment merging ──────────────────────────────────────────────────────────
// merge 상한: 이 단어 수 초과 시 문장 미완성이어도 더 이상 붙이지 않음
const MAX_MERGE_WORDS = 12;

function mergeFragments(segments: TranslationSegment[]): MergedGroup[] {
  const groups: MergedGroup[] = [];
  let i = 0;
  const isFiller = (t: string) => t.trim().length === 0 || /^[\d\s.,;:!?'"()[\]-]+$/.test(t);
  const isSentenceEnd = (t: string) => /[.!?]$/.test(t.trim());
  const isBackchannel = (t: string) => /^(yes|no|yeah|nope|ok|okay|right|sure|hmm|uh|oh)$/i.test(t.trim());

  while (i < segments.length) {
    const seg = segments[i];

    if (isFiller(seg.text)) {
      groups.push({ start: seg.start, end: seg.end, text: seg.text, originalIndices: [i] });
      i++; continue;
    }

    // [핵심 수정] 독립 보호 대상 → 병합 없이 바로 push
    if (isShortIndependent(seg.text)) {
      groups.push({ start: seg.start, end: seg.end, text: seg.text, originalIndices: [i] });
      i++; continue;
    }

    let group: MergedGroup = { start: seg.start, end: seg.end, text: seg.text.trim(), originalIndices: [i] };
    let j = i + 1;

    while (j < segments.length) {
      const next = segments[j];
      if (isFiller(next.text)) break;

      // 다음 세그먼트가 독립 보호 대상이면 현재 병합 중단
      if (isShortIndependent(next.text)) break;

      const gap = next.start - group.end;
      const wc = group.text.split(/\s+/).length;

      // [핵심 수정] gap 하드 리밋: 0.6s 이상이면 병합 중단
      if (gap >= MERGE_GAP_HARD_LIMIT_S) break;

      if (wc >= MAX_MERGE_WORDS) break;

      if (!isSentenceEnd(group.text)) {
        group.text += " " + next.text.trim(); group.end = next.end; group.originalIndices.push(j); j++; continue;
      }
      if (wc < 6 && gap < 0.4) {
        // gap 기준도 함께 강화 (1.2 → 0.4)
        group.text += " " + next.text.trim(); group.end = next.end; group.originalIndices.push(j); j++; continue;
      }
      if (isBackchannel(group.text) && wc <= 3) break;
      break;
    }

    groups.push(group); i = j;
  }
  return groups;
}

// ── [핵심 수정] enforceSentence — 역할 대폭 축소 ─────────────────────────────
/**
 * 변경:
 *   1) isShortIndependent로 보호 범위 확장 (기존 isSingleWordIndependent → 1~3단어)
 *   2) gap ≥ MERGE_GAP_HARD_LIMIT_S → 병합 금지 (0.6s)
 *   3) 병합 기준: 3단어 미만 → 2단어 미만 (더 보수적)
 *      — "I do" 같은 2단어도 독립 유지
 *   4) buffer 자체가 isShortIndependent이면 절대 병합 안 함
 */
function enforceSentence(groups: MergedGroup[]): MergedGroup[] {
  const result: MergedGroup[] = [];
  let buffer: MergedGroup | null = null;

  for (const g of groups) {
    if (!buffer) { buffer = { ...g }; continue; }

    // [핵심 수정] buffer 또는 다음 그룹이 독립 보호 대상이면 병합 면제
    if (isShortIndependent(buffer.text) || isShortIndependent(g.text)) {
      result.push(buffer);
      buffer = { ...g };
      continue;
    }

    // gap 하드 리밋
    const gap = g.start - buffer.end;
    if (gap >= MERGE_GAP_HARD_LIMIT_S) {
      result.push(buffer);
      buffer = { ...g };
      continue;
    }

    // [핵심 수정] 병합 기준: 2단어 미만일 때만 (기존 3 → 2)
    // 실질적으로 1단어 미완성 프래그먼트("are")만 병합
    if (buffer.text.split(/\s+/).length < 2) {
      buffer.text += " " + g.text;
      buffer.end = g.end;
      buffer.originalIndices = [...buffer.originalIndices, ...g.originalIndices];
    } else {
      result.push(buffer);
      buffer = { ...g };
    }
  }
  if (buffer) result.push(buffer);
  return result;
}

// ── Netflix-style formatting ──────────────────────────────────────────────────
function isBalancedSplit(l1: string, l2: string): boolean {
  const len1 = l1.length, len2 = l2.length;
  if (len1 < 3 || len2 < 3) return false;
  const shorter = Math.min(len1, len2);
  const longer = Math.max(len1, len2);
  return shorter / longer >= 0.4;
}

export function formatNetflixSubtitle(text: string): string {
  const t = text.trim();
  if (!t || t.length <= NETFLIX_MIN_CHARS_FOR_SPLIT) return t;
  if (t.includes("\n")) return t;
  if (t.length <= NETFLIX_MAX_CHARS_PER_LINE) return t;

  const midPoint = Math.floor(t.length / 2);

  const sentenceMatch = t.match(/^(.+?[.!?])\s+(.+)$/);
  if (sentenceMatch) {
    const l1 = sentenceMatch[1].trim(), l2 = sentenceMatch[2].trim();
    if (isBalancedSplit(l1, l2)) return `${l1}\n${l2}`;
  }

  const commaMatch = t.match(/^(.+?,)\s+(.+)$/);
  if (commaMatch) {
    const l1 = commaMatch[1].trim(), l2 = commaMatch[2].trim();
    if (isBalancedSplit(l1, l2)) return `${l1}\n${l2}`;
  }

  const koPattern = /(은|는|이|가|을|를|에서|에게|으로|로|하고|이고|지만|는데|인데|그리고|그래서|하지만|그런데)\s/g;
  let bestPos = -1, bestDist = Infinity;
  let m: RegExpExecArray | null;
  koPattern.lastIndex = 0;
  while ((m = koPattern.exec(t)) !== null) {
    const pos = m.index + m[1].length;
    const l1c = t.slice(0, pos).trim(), l2c = t.slice(pos).trim();
    if (!isBalancedSplit(l1c, l2c)) continue;
    const dist = Math.abs(pos - midPoint);
    if (dist < bestDist) { bestDist = dist; bestPos = pos; }
  }
  if (bestPos > 2 && bestPos < t.length - 2) {
    const l1 = t.slice(0, bestPos).trim(), l2 = t.slice(bestPos).trim();
    if (isBalancedSplit(l1, l2)) return `${l1}\n${l2}`;
  }

  const spaces: number[] = [];
  for (let i = 0; i < t.length; i++) { if (t[i] === " ") spaces.push(i); }
  if (spaces.length > 0) {
    const sorted = [...spaces].sort((a, b) => Math.abs(a - midPoint) - Math.abs(b - midPoint));
    for (const sp of sorted) {
      const l1 = t.slice(0, sp).trim(), l2 = t.slice(sp).trim();
      if (isBalancedSplit(l1, l2)) return `${l1}\n${l2}`;
    }
  }

  return t;
}

// ── 의미 단위 chunk 분할 ──────────────────────────────────────────────────────
function splitIntoMeaningChunks(text: string): string[] {
  const t = text.trim();
  if (!t) return [t];

  const sentParts = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (sentParts.length > 1) return healDanglingParticles(sentParts);

  const commaParts = t.split(/,\s+/).map(s => s.trim()).filter(Boolean);
  if (commaParts.length > 1) return healDanglingParticles(commaParts);

  const koSplit = t
    .split(/(?<=은|는|이|가|을|를|에서|에게|으로|로|하고|이고|지만|는데|인데|그리고|그래서|하지만|그런데)\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (koSplit.length > 1) return healDanglingParticles(koSplit);

  const enPhraseSplit = t
    .split(/(?<=\b(?:and|but|so|because|that|when|if|although|while|after|before|since|until|though|or)\b)\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
  if (enPhraseSplit.length > 1) return enPhraseSplit;

  const wordParts = t.split(/\s+/).filter(Boolean);
  return wordParts.length > 0 ? wordParts : [t];
}

function healDanglingParticles(chunks: string[]): string[] {
  const RE_DANGLING = /^(은|는|이|가|을|를|에서|에게|으로|로)$/;
  const result: string[] = [];
  let i = 0;
  while (i < chunks.length) {
    const curr = chunks[i];
    if (RE_DANGLING.test(curr) && i + 1 < chunks.length) {
      result.push(curr + " " + chunks[i + 1]);
      i += 2;
    } else {
      result.push(curr);
      i++;
    }
  }
  return result.filter(Boolean);
}

function distributeChunksToSlots(chunks: string[], slotCount: number): string[] {
  if (slotCount <= 0) return [];
  if (chunks.length === 0) return new Array(slotCount).fill("");
  if (slotCount === 1) return [chunks.join(" ")];

  if (chunks.length < slotCount) {
    const words = chunks.join(" ").split(/\s+/).filter(Boolean);
    if (words.length >= slotCount) {
      const result: string[] = [];
      let offset = 0;
      for (let s = 0; s < slotCount; s++) {
        const remaining = slotCount - s;
        const take = Math.round((words.length - offset) / remaining);
        result.push(words.slice(offset, offset + take).join(" "));
        offset += take;
      }
      return result;
    }
    const result = new Array(slotCount).fill("");
    for (let i = 0; i < words.length; i++) result[i] = words[i];
    return result;
  }

  const result: string[] = [];
  let offset = 0;
  for (let s = 0; s < slotCount; s++) {
    const remaining = slotCount - s;
    const take = Math.round((chunks.length - offset) / remaining);
    result.push(chunks.slice(offset, offset + take).join(" "));
    offset += take;
  }
  return result;
}

// ── expandGroupTranslations ────────────────────────────────────────────────────
function expandGroupTranslations(
  groups: MergedGroup[],
  groupTranslations: string[],
  originalSegments: TranslationSegment[]
): string[] {
  const result: string[] = new Array(originalSegments.length).fill("");

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const { originalIndices } = group;
    let translation = (groupTranslations[gi] ?? "").trim();

    if (!translation) {
      for (const idx of originalIndices) result[idx] = originalSegments[idx].text;
      continue;
    }

    const groupSrc = originalIndices.map(idx => originalSegments[idx].text).join(" ");
    if (!RE_HALLUCINATION_GUARD.test(groupSrc)) {
      translation = translation.replace(RE_HALLUCINATED_TERMS_KO, "").trim();
    }
    if (!translation) { for (const idx of originalIndices) result[idx] = originalSegments[idx].text; continue; }

    if (originalIndices.length === 1) {
      result[originalIndices[0]] = translation;
      continue;
    }

    if (originalIndices.length === 2) {
      const [p1, p2] = splitTranslationInTwo(
        translation,
        originalSegments[originalIndices[0]],
        originalSegments[originalIndices[1]]
      );
      result[originalIndices[0]] = p1;
      result[originalIndices[1]] = p2;
      continue;
    }

    const breakPoints = findNaturalBreakPoints(originalIndices, originalSegments);

    if (breakPoints.length === 0) {
      if (originalIndices.length === 1) {
        result[originalIndices[0]] = translation;
      } else {
        const chunks = splitIntoMeaningChunks(translation);
        const distributed = distributeChunksToSlots(chunks, originalIndices.length);
        for (let k = 0; k < originalIndices.length; k++) result[originalIndices[k]] = distributed[k] ?? "";
      }
    } else {
      distributeByBreakPoints(translation, originalIndices, breakPoints, originalSegments, result);
    }
  }

  return result;
}

function splitTranslationInTwo(
  translation: string,
  seg1: TranslationSegment,
  seg2: TranslationSegment
): [string, string] {
  const t = translation.trim();

  const sentenceBreak = t.match(/^(.+?[.!?])\s+(.+)$/);
  if (sentenceBreak) return [sentenceBreak[1].trim(), sentenceBreak[2].trim()];

  const commaBreak = t.match(/^(.+?,)\s+(.+)$/);
  if (commaBreak) return [commaBreak[1].trim(), commaBreak[2].trim()];

  const dur1 = Math.max(seg1.end - seg1.start, 0.1);
  const dur2 = Math.max(seg2.end - seg2.start, 0.1);
  const targetRatio = dur1 / (dur1 + dur2);
  const targetPos = Math.floor(t.length * targetRatio);

  const koPattern = /(은|는|이|가|을|를|에서|에게|으로|로|하고|이고|지만|는데|인데|그리고|그래서|하지만|그런데)\s/g;
  let bestPos = -1, bestDist = Infinity;
  let m: RegExpExecArray | null;
  koPattern.lastIndex = 0;
  while ((m = koPattern.exec(t)) !== null) {
    const pos = m.index + m[1].length;
    const dist = Math.abs(pos - targetPos);
    if (dist < bestDist) { bestDist = dist; bestPos = pos; }
  }
  if (bestPos > 0 && bestPos < t.length - 2) {
    return [t.slice(0, bestPos).trim(), t.slice(bestPos).trim()];
  }

  const chunks = splitIntoMeaningChunks(t);
  if (chunks.length >= 2) {
    const splitIdx = Math.max(1, Math.round(chunks.length * targetRatio));
    return [
      chunks.slice(0, splitIdx).join(" "),
      chunks.slice(splitIdx).join(" "),
    ];
  }

  return [t, ""];
}

function findNaturalBreakPoints(
  originalIndices: number[],
  originalSegments: TranslationSegment[]
): number[] {
  const breaks: number[] = [];
  for (let k = 0; k < originalIndices.length - 1; k++) {
    const curr = originalSegments[originalIndices[k]];
    const next = originalSegments[originalIndices[k + 1]];
    if (next.start - curr.end >= EXPAND_GAP_THRESHOLD_S) breaks.push(k);
  }
  return breaks;
}

function distributeByBreakPoints(
  translation: string,
  originalIndices: number[],
  breakPoints: number[],
  originalSegments: TranslationSegment[],
  result: string[]
): void {
  const slotGroups: number[][] = [];
  let start = 0;
  for (const bp of breakPoints) {
    slotGroups.push(originalIndices.slice(start, bp + 1));
    start = bp + 1;
  }
  slotGroups.push(originalIndices.slice(start));

  const durations = slotGroups.map(grp =>
    grp.reduce((sum, idx) =>
      sum + Math.max(originalSegments[idx].end - originalSegments[idx].start, 0.1), 0)
  );
  const totalDuration = durations.reduce((a, b) => a + b, 0);

  const chunks = splitIntoMeaningChunks(translation);
  const totalChunks = chunks.length;

  let chunkOffset = 0;

  for (let si = 0; si < slotGroups.length; si++) {
    const grp = slotGroups[si];
    let assignedText: string;

    if (si === slotGroups.length - 1) {
      assignedText = chunks.slice(chunkOffset).join(" ");
    } else {
      const chunkCount = Math.max(
        1,
        Math.round((durations[si] / totalDuration) * totalChunks)
      );
      assignedText = chunks.slice(chunkOffset, chunkOffset + chunkCount).join(" ");
      chunkOffset += chunkCount;
    }

    if (grp.length === 1) {
      result[grp[0]] = assignedText.trim();
    } else {
      const subChunks = splitIntoMeaningChunks(assignedText.trim());
      const distributed = distributeChunksToSlots(subChunks, grp.length);
      for (let k = 0; k < grp.length; k++) result[grp[k]] = distributed[k] ?? "";
    }
  }
}

// ── Netflix-style timing adjustment ──────────────────────────────────────────
export function adjustTimingsForReadability(segments: TranslationSegment[]): TranslationSegment[] {
  const result = segments.map(seg => ({ ...seg }));
  for (const seg of result) {
    const charCount = (seg.translated || seg.text).replace("\n", "").length;
    const minDuration = charCount * SECS_PER_CHAR_KO;
    if (minDuration > seg.end - seg.start) seg.end = seg.start + minDuration;
  }
  for (let i = 0; i < result.length - 1; i++) {
    const overlap = result[i].end - result[i + 1].start;
    if (overlap > MAX_TIMING_OVERLAP) result[i].end = result[i + 1].start + MAX_TIMING_OVERLAP;
  }
  return result;
}

// ── 고유명사 추출 / 음역 ──────────────────────────────────────────────────────
function extractProperNounCandidates(segments: TranslationSegment[]): string[] {
  const stats = new Map<string, { mid: number; first: number }>();
  const spPat = /(?:^|[.!?]\s+)([A-Z][a-zA-Z]{2,})/g;
  const allPat = /\b([A-Z][a-zA-Z]{2,})\b/g;
  for (const seg of segments) {
    const firstWords = new Set<string>();
    let m: RegExpExecArray | null;
    spPat.lastIndex = 0;
    while ((m = spPat.exec(seg.text)) !== null) firstWords.add(m[1]);
    allPat.lastIndex = 0;
    while ((m = allPat.exec(seg.text)) !== null) {
      const w = m[1];
      if (COMMON_WORDS.has(w)) continue;
      const e = stats.get(w) ?? { mid: 0, first: 0 };
      if (firstWords.has(w)) e.first++; else e.mid++;
      stats.set(w, e);
    }
  }
  const result: string[] = [];
  for (const [w, { mid, first }] of stats) if (mid * 1.5 + first * 0.5 >= PROPER_NOUN_MIN_COUNT) result.push(w);
  return result;
}

async function transliterateProperNouns(nouns: string[], targetLanguage: string): Promise<Record<string, string>> {
  if (!llamaContext || nouns.length === 0) return {};
  const r = await llamaContext.completion({
    messages: [
      { role: "system", content: `Transliterate each proper noun into ${targetLanguage} phonetically.\nOutput ONLY 'English=Transliteration' lines.` },
      { role: "user", content: nouns.join("\n") },
    ],
    n_predict: nouns.length * 20, temperature: 0.1, top_p: 0.9,
    stop: ["</s>", "<end_of_turn>", "<|end|>"],
  });
  const dict: Record<string, string> = {};
  for (const line of r.text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const src = line.slice(0, eq).trim(), tgt = line.slice(eq + 1).trim();
    if (src && tgt) dict[src] = tgt;
  }
  return dict;
}

async function buildProperNounDict(segments: TranslationSegment[], videoHash: string, targetLanguage: string): Promise<Record<string, string>> {
  const stored = await AsyncStorage.getItem(properNounKey(videoHash));
  const existing: Record<string, string> = stored ? JSON.parse(stored) : {};
  const candidates = extractProperNounCandidates(segments);
  const merged: Record<string, string> = { ...existing };
  for (const n of candidates) if (!(n in merged)) merged[n] = "";
  const unmapped = Object.entries(merged).filter(([, v]) => !v).map(([k]) => k);
  if (unmapped.length > 0) {
    const fresh = await transliterateProperNouns(unmapped, targetLanguage);
    for (const [s, t] of Object.entries(fresh)) merged[s] = t;
  }
  await AsyncStorage.setItem(properNounKey(videoHash), JSON.stringify(merged));
  return merged;
}

function formatNounHint(dict: Record<string, string>): string {
  const pairs = Object.entries(dict).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ");
  return pairs ? `\nReference proper nouns: ${pairs}` : "";
}

interface CompiledNounPattern { src: string; tgt: string; fullRegex: RegExp; }
let cachedPatterns: CompiledNounPattern[] | null = null;
let cachedDictKey = "";

function buildPatterns(dict: Record<string, string>): CompiledNounPattern[] {
  const key = JSON.stringify(dict);
  if (cachedPatterns && cachedDictKey === key) return cachedPatterns;
  cachedPatterns = Object.entries(dict).filter(([, v]) => v).map(([src, tgt]) => ({
    src, tgt,
    fullRegex: new RegExp(`(?<![\\wㄱ-ㅎㅏ-ㅣ가-힣])${escapeRegex(src)}(?![\\wㄱ-ㅎㅏ-ㅣ가-힣])`, "gi"),
  }));
  cachedDictKey = key;
  return cachedPatterns;
}

function applyProperNounFixes(text: string, patterns: CompiledNounPattern[]): string {
  let r = text;
  for (const { tgt, fullRegex } of patterns) {
    fullRegex.lastIndex = 0;
    if (fullRegex.test(r)) { fullRegex.lastIndex = 0; r = r.replace(fullRegex, tgt); }
  }
  return r;
}

// ── Text cleaning ─────────────────────────────────────────────────────────────
function cleanWhisperText(text: string): string {
  return text.replace(/\.{2,}$/, "").replace(/(?<!\()[^)]*\)/g, "").replace(/(?<!\[)[^\]]*\]/g, "").replace(/\s{2,}/g, " ").trim();
}

function buildBatchMessage(batch: TranslationSegment[]): string {
  return batch.map((seg, i) => `${i + 1}. ${normalizeSocialMediaNames(cleanWhisperText(seg.text))}`).join("\n");
}

// ── Sanitize ──────────────────────────────────────────────────────────────────
export function sanitizeTranslationOutput(text: string, sourceText: string): string {
  let out = text
    .replace(RE_OUTPUT_CORRUPTION, "")
    .replace(RE_UNTRANSLATED_MARKER, "")
    .replace(RE_STAGE_DIRECTION_KO, "")
    .replace(RE_NUMBERED_PREFIX, "")
    .replace(RE_AWKWARD_DEMONSTRATIVE, "그건 ")
    .replace(RE_AWKWARD_DEMONSTRATIVE_I, "그게 ");

  if (!RE_HALLUCINATION_GUARD.test(sourceText)) out = out.replace(RE_HALLUCINATED_TERMS_KO, "");
  if (!sourceText.includes("(") && !sourceText.includes(")")) out = out.replace(RE_PARENS_ANY, "");
  return out.replace(/\s{2,}/g, " ").trim();
}

export function hasLeftoverEnglish(translated: string, sourceText: string, patterns: CompiledNounPattern[], targetLanguage: string): boolean {
  const profile = getLanguageProfile(targetLanguage);
  if (profile.isLatinScript) return false;
  const knownEn = new Set(sourceText.toLowerCase().split(/\s+/).filter(Boolean));
  const knownTr = new Set(patterns.map(p => p.src.toLowerCase()));
  RE_ENGLISH_WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ENGLISH_WORD.exec(translated)) !== null) {
    const w = m[1];
    if (RE_NUMERIC_TOKEN.test(w) || knownEn.has(w.toLowerCase()) || knownTr.has(w.toLowerCase())) continue;
    return true;
  }
  return false;
}

function isCorruptedOutput(text: string): boolean {
  return /^##/.test(text) || /^Translation:/i.test(text) || /^\[미번역\]/.test(text) || /^---/.test(text) || text.includes("\n\n");
}

function isOvergenerated(input: string, output: string, targetLanguage = "Korean"): boolean {
  const inLen = input.split(/\s+/).filter(Boolean).length;
  const outLen = output.split(/\s+/).filter(Boolean).length;
  const threshold = targetLanguage === "Korean" ? 2.0 : 1.7;
  return outLen > Math.max(inLen * threshold, 4);
}

// ── 배치 응답 파싱 ────────────────────────────────────────────────────────────
function parseBatchResponse(response: string, batch: TranslationSegment[], patterns: CompiledNounPattern[]): string[] {
  const tmap = new Map<number, string>();
  const lines = response.split("\n").map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^(\d+)[.)]\s*(.+)$/);
    if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= batch.length && !tmap.has(n)) tmap.set(n, m[2].trim()); }
  }
  if (tmap.size < batch.length) {
    for (const line of lines) {
      const m = line.match(/^(\d+)[.):\-]\s+(.+)$/) ?? line.match(/^(\d+)\s{2,}(.+)$/);
      if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= batch.length && !tmap.has(n)) tmap.set(n, m[2].trim()); }
    }
  }
  if (tmap.size === batch.length) {
    return batch.map((seg, i) => sanitizeTranslationOutput(applyProperNounFixes(tmap.get(i + 1) ?? "", patterns), seg.text));
  }
  const contentLines = lines.map(l => l.replace(/^[\d]+[.):\-\s]+/, "").trim()).filter(Boolean);
  if (contentLines.length === batch.length) {
    console.warn(`[TRANSLATE] positional fallback: parsed=${tmap.size} expected=${batch.length}`);
    return batch.map((seg, i) => sanitizeTranslationOutput(applyProperNounFixes(contentLines[i], patterns), seg.text));
  }
  return batch.map((seg, i) => {
    const raw = tmap.get(i + 1);
    if (!raw) { console.warn(`[TRANSLATE] missing #${i + 1}`); return seg.text; }
    return sanitizeTranslationOutput(applyProperNounFixes(raw, patterns), seg.text);
  });
}

// ── 유효성 검사 + 재시도 ──────────────────────────────────────────────────────
function isLikelyUntranslated(translated: string, targetLanguage: string): boolean {
  const profile = getLanguageProfile(targetLanguage);
  const t = translated.trim();
  if (!t || profile.isLatinScript) return !t;
  const nonSpace = t.replace(/\s/g, "");
  const ascii = (nonSpace.match(/[a-zA-Z]/g) ?? []).length;
  return nonSpace.length > 0 && ascii / nonSpace.length > 0.9;
}

async function validateTranslations(
  segments: TranslationSegment[],
  translatedTexts: string[],
  systemPrompt: string,
  targetLanguage: string,
  patterns: CompiledNounPattern[]
): Promise<string[]> {
  if (!llamaContext) return translatedTexts;
  const result = [...translatedTexts];

  for (let i = 0; i < segments.length; i++) {
    const src = segments[i].text.trim();
    if (isFillerText(src)) continue;
    result[i] = sanitizeTranslationOutput(result[i]?.trim() ?? "", src);
    const t = result[i];

    const srcHasNeg = /\bdon't think\b|\bnot a\b|\bdoesn't work\b|\bdon't work\b|\bcan't\b|\bwon't\b|\bnot going to\b|\bnot gonna\b/i.test(src);
    const negDropped = srcHasNeg && t.length > 0 && !/않|안|못|없|아니|모르/.test(t);
    const profile = getLanguageProfile(targetLanguage);
    const leftoverEn = hasLeftoverEnglish(t, src, patterns, targetLanguage);
    const foreignLatin = profile.isLatinScript && /[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(t);
    const goodFitBad = /\bgood\s+fit\b/i.test(src) && /몸|체형|체격|사이즈|맞는 몸/.test(t);

    const needsRetry = t.length === 0 || /^[.…]{2,}$/.test(t) || isLikelyUntranslated(t, targetLanguage) ||
      isCorruptedOutput(t) || isOvergenerated(src, t, targetLanguage) || negDropped || leftoverEn || foreignLatin || goodFitBad;

    if (!needsRetry) continue;
    console.warn(`[VALIDATE] retry ${i}: "${src}" → "${t}"`);

    try {
      const r = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Translate to ${targetLanguage}. Output ONLY translation:\n${src}${negDropped ? "\nCRITICAL: Preserve NEGATIVE meaning." : ""}` },
        ],
        n_predict: 80, temperature: 0.1, top_p: 0.9,
        stop: ["</s>", "<end_of_turn>", "<|end|>", "\n"],
      });
      const c = sanitizeTranslationOutput(r.text.trim(), src);
      result[i] = (c && !isLikelyUntranslated(c, targetLanguage) && !isCorruptedOutput(c) && !isOvergenerated(src, c, targetLanguage))
        ? applyProperNounFixes(c, patterns) : src;
    } catch (e) { result[i] = src; console.warn(`[VALIDATE] error ${i}:`, e); }
  }
  return result;
}

// ── 체크포인트 ────────────────────────────────────────────────────────────────
async function loadCheckpoint(videoHash: string): Promise<Checkpoint | null> {
  try {
    const raw = await AsyncStorage.getItem(checkpointKey(videoHash));
    if (!raw) return null;
    const cp: Checkpoint = JSON.parse(raw);
    if (Date.now() - cp.timestamp >= CHECKPOINT_TTL_MS) { await AsyncStorage.removeItem(checkpointKey(videoHash)); return null; }
    return cp;
  } catch { return null; }
}
async function saveCheckpoint(videoHash: string, cp: Omit<Checkpoint, "timestamp">): Promise<void> {
  try { await AsyncStorage.setItem(checkpointKey(videoHash), JSON.stringify({ ...cp, timestamp: Date.now() })); }
  catch (e) { console.warn("[Gemma] Checkpoint save failed:", e); }
}
async function deleteCheckpoint(videoHash: string): Promise<void> { await AsyncStorage.removeItem(checkpointKey(videoHash)); }

function mergeWithTranslations(segments: TranslationSegment[], translatedTexts: string[]): TranslationSegment[] {
  return segments.map((seg, i) => ({ ...seg, translated: translatedTexts[i] || seg.text }));
}

// ── 시스템 프롬프트 빌더 ──────────────────────────────────────────────────────
function buildSystemPrompt(targetLanguage: string, langRules: string, genrePersona: string, nounHint: string, batchSize: number): string {
  return (
    `You are a professional subtitle translator. Translate English subtitles to ${targetLanguage}.\n\n` +
    (genrePersona ? genrePersona + "\n\n" : "") +
    `STRICT OUTPUT FORMAT:\n` +
    `- Input has exactly ${batchSize} numbered lines\n` +
    `- Output MUST have exactly ${batchSize} numbered lines: "1. translation", "2. translation", ...\n` +
    `- ONE output line per input line. Never merge. Never split. Never skip.\n` +
    `- NEVER output headers like "## Translation:", "[미번역]", "---", or any non-translation text.\n\n` +
    `TRANSLATION RULES:\n` +
    `- Translate exact meaning only. Do not add, remove, or infer content.\n` +
    `- Preserve negation: "don't/can't/never" → must use 않/안/못/없 in Korean.\n` +
    `- Fragment lines (no complete verb) → translate as fragment, do NOT complete.\n` +
    `- Short responses (Yes/No/Hmm) → translate naturally as single words.\n` +
    // [핵심 수정] baby 번역 규칙 추가
    `- "baby" as informal address (not romantic context) → use the person's name or omit. NEVER translate as 자기야.\n` +
    `- NEVER add 자기야/여보/honey unless that exact romantic term is in the source.\n` +
    `- "not really" → "그다지요"\n` +
    `- "good fit" in job/interview context → "잘 맞다" (compatibility, NOT fitness)\n` +
    `- "mental health day" → "정신 건강을 위한 휴가"\n` +
    `- "Vine" is a social media app → "바인(Vine)", never "덩굴"\n` +
    `- "surprised you didn't say X" → "X라고 안 하신 게 놀랍네요"\n` +
    `- "you don't work here" → "여기서 일하지도 않잖아요"\n` +
    `- "are you firing me" → "저 해고하시는 거예요?"\n` +
    `- "I do" → "나" or "그럼요" depending on context\n` +
    `- Conversational "That's/That is" referring to something just mentioned → "그건" or "그게" (NOT "저것은" or "그것은")\n` +
    `- "This is/That's" in casual dialogue → use 그/이 pronouns, never 저\n` +
    `\n` +
    langRules +
    nounHint
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function translateSegments(
  segments: TranslationSegment[],
  onProgress?: (completed: number, total: number, partial: TranslationSegment[]) => void,
  videoHash = "default",
  targetLanguage = "Korean",
  videoGenre = "general"
): Promise<TranslationSegment[]> {
  console.log("[TRANSLATE]", segments.length, "segs |", targetLanguage, "|", videoGenre);
  if (!llamaContext) throw new Error("모델이 로드되지 않았습니다. loadModel()을 먼저 호출하세요.");

  // Step 0: 중복 제거 + ASR 정리
  const deduped = deduplicateOverlappingSegments(segments);
  const cleaned = deduped.map(seg => ({ ...seg, text: normalizeSocialMediaNames(cleanWhisperText(seg.text)) }));

  // Step A: 프래그먼트 병합 → 완전한 문장
  // [핵심 수정] mergeFragments: gap 0.6s + isShortIndependent(1~3단어) 보호
  // [핵심 수정] enforceSentence: 2단어 미만만 병합 + isShortIndependent 보호
  let merged = mergeFragments(cleaned);
  merged = enforceSentence(merged);
  const mergedSegs = merged.map(g => ({ start: g.start, end: g.end, text: g.text, translated: "" }));
  const total = mergedSegs.length;
  const totalBatches = Math.ceil(total / BATCH_SIZE);
  console.log(`[TRANSLATE] merged → ${total} groups (${totalBatches} batches)`);

  // Step B: 고유명사 + 프롬프트 구성
  const profile = getLanguageProfile(targetLanguage);
  const properNouns = await buildProperNounDict(deduped, videoHash, targetLanguage);
  const nounHint = formatNounHint(properNouns);
  const patterns = buildPatterns(properNouns);
  const genrePersona = GENRE_PERSONA[videoGenre] ?? "";
  const langRules = profile.systemPromptRules.join(" ");

  // Step C: 체크포인트 복원
  const checkpoint = await loadCheckpoint(videoHash);
  let startBatch = 0;
  const mergedTranslations: string[] = new Array(total).fill("");
  if (checkpoint && checkpoint.translatedTexts.length === total) {
    startBatch = checkpoint.lastBatchIndex + 1;
    for (let i = 0; i < checkpoint.translatedTexts.length; i++) mergedTranslations[i] = checkpoint.translatedTexts[i];
    console.log(`[Gemma] Resuming from batch ${startBatch}/${totalBatches}`);
  }

  // Step D: 배치 번역
  try {
    for (let bi = startBatch; bi < totalBatches; bi++) {
      const offset = bi * BATCH_SIZE;
      const batch = mergedSegs.slice(offset, offset + BATCH_SIZE);
      console.log(`[TRANSLATE] batch ${bi + 1}/${totalBatches} (${batch.length})`);

      const sysPrompt = buildSystemPrompt(
        targetLanguage,
        langRules,
        genrePersona,
        nounHint,
        batch.length
      );

      const r = await llamaContext.completion({
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: buildBatchMessage(batch) }
        ],
        n_predict: batch.length * 80,
        temperature: 0.1,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
        stop: ["</s>", "<end_of_turn>", "<|end|>"],
      } as any);

      const translations = parseBatchResponse(r.text, batch, patterns);

      for (let i = 0; i < batch.length; i++) {
        mergedTranslations[offset + i] = translations[i];
      }

      const partial = expandGroupTranslations(merged, mergedTranslations, cleaned);

      onProgress?.(
        offset + batch.length,
        total,
        mergeWithTranslations(cleaned, partial)
      );

      await saveCheckpoint(videoHash, {
        translatedTexts: mergedTranslations,
        lastBatchIndex: bi,
        properNouns,
        totalBatches,
      });

      if (bi < totalBatches - 1) {
        await sleep(
          (bi + 1) % THERMAL_EVERY_N === 0
            ? SLEEP_THERMAL_MS
            : SLEEP_BETWEEN_MS
        );
      }
    }
  } catch (e) {
    console.error("[Gemma] Inference error:", e);
    return mergeWithTranslations(
      cleaned,
      expandGroupTranslations(merged, mergedTranslations, cleaned)
    );
  }

  await deleteCheckpoint(videoHash);

  // Step E: 재분배
  const translatedTexts = expandGroupTranslations(
    merged,
    mergedTranslations,
    cleaned
  );

  // Step E.1: 호칭어 환각 제거
  for (let i = 0; i < cleaned.length; i++) {
    if (
      !RE_HALLUCINATION_GUARD.test(cleaned[i].text) &&
      translatedTexts[i]
    ) {
      translatedTexts[i] = translatedTexts[i]
        .replace(RE_HALLUCINATED_TERMS_KO, "")
        .trim();
    }
  }

  // Step F: 실패 세그먼트 재시도
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = cleaned.reduce<number[]>((acc, seg, i) => {
      const t = translatedTexts[i];
      const src = seg.text.trim();

      if (
        !t ||
        !t.trim() ||
        (t.trim() === src && src.length > 10) ||
        /^\d+\.?$/.test(t.trim()) ||
        isCorruptedOutput(t)
      ) {
        return [...acc, i];
      }

      return acc;
    }, []);

    if (failed.length === 0) break;

    console.log(`[Gemma] Retry ${attempt + 1}: ${failed.length} segs`);

    const retryBatch = failed.map(i => cleaned[i]);

    const retryPrompt = buildSystemPrompt(
      targetLanguage,
      langRules,
      genrePersona,
      nounHint,
      retryBatch.length
    );

    try {
      const rr = await llamaContext.completion({
        messages: [
          { role: "system", content: retryPrompt },
          { role: "user", content: buildBatchMessage(retryBatch) }
        ],
        n_predict: retryBatch.length * 80,
        temperature: 0.1,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
        stop: ["</s>", "<end_of_turn>", "<|end|>"],
      } as any);

      const rt = parseBatchResponse(rr.text, retryBatch, patterns);

      for (let j = 0; j < failed.length; j++) {
        if (
          rt[j] &&
          rt[j].trim() &&
          !isCorruptedOutput(rt[j])
        ) {
          translatedTexts[failed[j]] = rt[j];
        }
      }

    } catch (e) {
      console.warn(`[Gemma] Retry ${attempt + 1} error:`, e);
      break;
    }

    if (attempt < 1) {
      await sleep(SLEEP_BETWEEN_MS);
    }
  }

  // Step G: 검증
  const finalPrompt = buildSystemPrompt(targetLanguage, langRules, genrePersona, nounHint, BATCH_SIZE);
  const validated = await validateTranslations(cleaned, translatedTexts, finalPrompt, targetLanguage, patterns);

  // Step H: Netflix 포맷팅
  const formatted = validated.map(t => formatNetflixSubtitle(t));

  // Step I: 타이밍 조정 + 최종 조립
  const completed = adjustTimingsForReadability(mergeWithTranslations(cleaned, formatted));
  console.log(`[Gemma] Done: ${completed.length} segments.`);
  return completed;
}