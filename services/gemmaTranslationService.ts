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

// ── 소셜미디어 앱명 정규화 ────────────────────────────────────────────────────
const SOCIAL_MEDIA_NORMALIZATION: Record<string, string> = {
  "vine": "Vine", "snapchat": "Snapchat", "pinterest": "Pinterest",
  "instagram": "Instagram", "twitter": "Twitter", "facebook": "Facebook",
  "tiktok": "TikTok", "youtube": "YouTube", "linkedin": "LinkedIn",
  "reddit": "Reddit", "discord": "Discord", "twitch": "Twitch",
};

// ── 환각 / 오염 패턴 ──────────────────────────────────────────────────────────
// 호칭어 환각: 원문에 없는데 LLM이 삽입하는 패턴
// 자기야/자기/여보/오빠/언니 — 한국어 LLM에서 빈번히 발생
const RE_HALLUCINATED_TERMS_KO = /자기야[,，\s]*|자기[,，\s]+|여보[,，\s]*|오빠[,，\s]*|언니[,，\s]*/g;
// 원문에 호칭어가 있을 때 제거를 건너뛰기 위한 가드 (영어 원문 기준)
const RE_HALLUCINATION_GUARD = /\b(baby|honey|sweetie|darling|dear|oppa|unnie)\b/i;
const RE_OUTPUT_CORRUPTION = /^##\s*Translation\s*:?\s*/i;
const RE_UNTRANSLATED_MARKER = /^\[미번역\]\s*/;
const RE_STAGE_DIRECTION_KO = /\(혼잣말\)|\(독백\)|\(방백\)|\(내레이션\)/g;
const RE_PARENS_ANY = /\([^)]*\)/g;
const RE_ENGLISH_WORD = /\b([a-zA-Z]{3,})\b/g;
const RE_NUMERIC_TOKEN = /^\d+([:.]\d+)*$/;

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

// ── Fragment merging ──────────────────────────────────────────────────────────
// merge 상한: 이 단어 수 초과 시 문장 미완성이어도 더 이상 붙이지 않음
// → 감정/리듬/강조가 살아있는 짧은 발화가 하나의 덩어리로 flatten되는 현상 방지
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
    let group: MergedGroup = { start: seg.start, end: seg.end, text: seg.text.trim(), originalIndices: [i] };
    let j = i + 1;
    while (j < segments.length) {
      const next = segments[j];
      if (isFiller(next.text)) break;
      const gap = next.start - group.end;
      const wc = group.text.split(/\s+/).length;
      // [Fix] 단어 수 상한 초과 시 문장 미완성이어도 merge 중단
      if (wc >= MAX_MERGE_WORDS) break;
      if (!isSentenceEnd(group.text)) {
        group.text += " " + next.text.trim(); group.end = next.end; group.originalIndices.push(j); j++; continue;
      }
      if (wc < 6 && gap < 1.2) {
        group.text += " " + next.text.trim(); group.end = next.end; group.originalIndices.push(j); j++; continue;
      }
      if (isBackchannel(group.text) && wc <= 3) break;
      break;
    }
    groups.push(group); i = j;
  }
  return groups;
}

function enforceSentence(groups: MergedGroup[]): MergedGroup[] {
  const result: MergedGroup[] = [];
  let buffer: MergedGroup | null = null;
  for (const g of groups) {
    if (!buffer) { buffer = { ...g }; continue; }
    if (buffer.text.split(/\s+/).length < 5) {
      buffer.text += " " + g.text; buffer.end = g.end;
      buffer.originalIndices = [...buffer.originalIndices, ...g.originalIndices];
    } else { result.push(buffer); buffer = { ...g }; }
  }
  if (buffer) result.push(buffer);
  return result;
}

// ── Netflix-style formatting ──────────────────────────────────────────────────
/**
 * 두 줄 균형 검사: 한 줄이 다른 줄의 40% 미만이면 불균형으로 판단해 기각.
 * 예: "안녕\n오늘 정말 기분이 너무 좋아서 일찍 나왔어요" → 기각 → 다음 순위로
 */
function isBalancedSplit(l1: string, l2: string): boolean {
  const len1 = l1.length, len2 = l2.length;
  if (len1 < 3 || len2 < 3) return false;
  const shorter = Math.min(len1, len2);
  const longer = Math.max(len1, len2);
  return shorter / longer >= 0.4; // 짧은 쪽이 긴 쪽의 40% 이상이어야 균형
}

export function formatNetflixSubtitle(text: string): string {
  const t = text.trim();
  if (!t || t.length <= NETFLIX_MIN_CHARS_FOR_SPLIT) return t;
  if (t.includes("\n")) return t;
  if (t.length <= NETFLIX_MAX_CHARS_PER_LINE) return t;

  const midPoint = Math.floor(t.length / 2);

  // 1순위: 문장부호 뒤 분할 — 균형 검사 통과 시만 채택
  const sentenceMatch = t.match(/^(.+?[.!?])\s+(.+)$/);
  if (sentenceMatch) {
    const l1 = sentenceMatch[1].trim(), l2 = sentenceMatch[2].trim();
    if (isBalancedSplit(l1, l2)) return `${l1}\n${l2}`;
    // 불균형이면 다음 순위로 — 강제 채택하지 않음
  }

  // 2순위: 쉼표 뒤 분할 — 균형 검사
  const commaMatch = t.match(/^(.+?,)\s+(.+)$/);
  if (commaMatch) {
    const l1 = commaMatch[1].trim(), l2 = commaMatch[2].trim();
    if (isBalancedSplit(l1, l2)) return `${l1}\n${l2}`;
  }

  // 3순위: 한국어 조사/접속사 기준 — midPoint 가장 가까운 균형 지점
  const koPattern = /(은|는|이|가|을|를|에서|에게|으로|로|하고|이고|지만|는데|인데|그리고|그래서|하지만|그런데)\s/g;
  let bestPos = -1, bestDist = Infinity;
  let m: RegExpExecArray | null;
  koPattern.lastIndex = 0;
  while ((m = koPattern.exec(t)) !== null) {
    const pos = m.index + m[1].length;
    const l1c = t.slice(0, pos).trim(), l2c = t.slice(pos).trim();
    if (!isBalancedSplit(l1c, l2c)) continue; // 불균형 후보 스킵
    const dist = Math.abs(pos - midPoint);
    if (dist < bestDist) { bestDist = dist; bestPos = pos; }
  }
  if (bestPos > 2 && bestPos < t.length - 2) {
    const l1 = t.slice(0, bestPos).trim(), l2 = t.slice(bestPos).trim();
    if (isBalancedSplit(l1, l2)) return `${l1}\n${l2}`;
  }

  // 4순위: 공백 기준 midPoint 가장 가까운 균형 지점
  const spaces: number[] = [];
  for (let i = 0; i < t.length; i++) { if (t[i] === " ") spaces.push(i); }
  if (spaces.length > 0) {
    // midPoint 기준 정렬 후, 균형 조건을 만족하는 첫 번째 후보 채택
    const sorted = [...spaces].sort((a, b) => Math.abs(a - midPoint) - Math.abs(b - midPoint));
    for (const sp of sorted) {
      const l1 = t.slice(0, sp).trim(), l2 = t.slice(sp).trim();
      if (isBalancedSplit(l1, l2)) return `${l1}\n${l2}`;
    }
  }

  return t;
}

// ── [핵심 개선] 의미 단위 chunk 분할 ─────────────────────────────────────────
/**
 * 번역 텍스트를 의미 단위로 분할한다.
 * 우선순위: 문장부호 > 쉼표 > 한국어 조사/접속사 > 영어 접속사(phrase) > 단어
 *
 * [보정] healDanglingParticles: 단독 조사 토큰이 된 chunk를 다음 chunk와 병합
 * 반환값은 항상 1개 이상의 non-empty string 배열.
 */
function splitIntoMeaningChunks(text: string): string[] {
  const t = text.trim();
  if (!t) return [t];

  // 1순위: 문장부호(.!?) 뒤 공백
  const sentParts = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (sentParts.length > 1) return healDanglingParticles(sentParts);

  // 2순위: 쉼표 뒤 공백
  const commaParts = t.split(/,\s+/).map(s => s.trim()).filter(Boolean);
  if (commaParts.length > 1) return healDanglingParticles(commaParts);

  // 3순위: 한국어 조사/접속사 경계 (lookbehind → 조사는 앞 청크에 포함)
  const koSplit = t
    .split(/(?<=은|는|이|가|을|를|에서|에게|으로|로|하고|이고|지만|는데|인데|그리고|그래서|하지만|그런데)\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (koSplit.length > 1) return healDanglingParticles(koSplit);

  // 4순위: 영어 접속사/전치사 기준 phrase 분할 (단어 단위 분해보다 의미 보존 우선)
  const enPhraseSplit = t
    .split(/(?<=\b(?:and|but|so|because|that|when|if|although|while|after|before|since|until|though|or)\b)\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
  if (enPhraseSplit.length > 1) return enPhraseSplit;

  // 5순위: 단어 분할 (최후 수단 — 어떤 패턴도 없는 경우)
  const wordParts = t.split(/\s+/).filter(Boolean);
  return wordParts.length > 0 ? wordParts : [t];
}

/**
 * chunk 배열에서 "단독 조사 토큰"이 된 chunk를 다음 chunk와 병합.
 * 예: split 결과로 ["이", "정말 중요합니다"] 가 나온 경우
 *     → ["이 정말 중요합니다"] 로 복원
 * 의미 단위 깨짐 방지용 보정 패스.
 */
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

/**
 * chunk 배열을 target 개수의 슬롯에 가능한 한 균등하게 병합하여 분배.
 * 예: chunks 5개, slots 3개 → [2, 2, 1] 개씩 병합
 */
function distributeChunksToSlots(chunks: string[], slotCount: number): string[] {
  if (slotCount <= 0) return [];
  if (chunks.length === 0) return new Array(slotCount).fill("");
  if (slotCount === 1) return [chunks.join(" ")];

  // chunk 수 < slot 수: word 단위로 한 번 더 쪼개서 슬롯을 채움
  // (빈 슬롯 없이 모든 슬롯에 텍스트 배치 → 모바일 UX 개선)
  if (chunks.length < slotCount) {
    const words = chunks.join(" ").split(/\s+/).filter(Boolean);
    if (words.length >= slotCount) {
      // 단어 수 >= 슬롯 수 → 단어 단위 균등 분배
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
    // 단어 수 < 슬롯 수: 어쩔 수 없이 빈 슬롯 허용 (텍스트 자체가 너무 짧음)
    const result = new Array(slotCount).fill("");
    for (let i = 0; i < words.length; i++) result[i] = words[i];
    return result;
  }

  // chunk 수 >= slot 수 → chunk 단위 균등 병합
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

    // 호칭어 환각 제거
    const groupSrc = originalIndices.map(idx => originalSegments[idx].text).join(" ");
    if (!RE_HALLUCINATION_GUARD.test(groupSrc)) {
      translation = translation.replace(RE_HALLUCINATED_TERMS_KO, "").trim();
    }
    if (!translation) { for (const idx of originalIndices) result[idx] = originalSegments[idx].text; continue; }

    // ── 케이스 1: 단일 세그먼트 ─────────────────────────────────────────────
    if (originalIndices.length === 1) {
      result[originalIndices[0]] = translation;
      continue;
    }

    // ── 케이스 2: 2개 세그먼트 ──────────────────────────────────────────────
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

    // ── 케이스 3: 3개+ 세그먼트 ─────────────────────────────────────────────
    // gap 기반 자연 분할 지점 탐색
    const breakPoints = findNaturalBreakPoints(originalIndices, originalSegments);

    if (breakPoints.length === 0) {
      // gap 없음:
      //   슬롯 1개 → 전체 텍스트 첫 슬롯에 (빈 슬롯 없이 자연스러움)
      //   슬롯 2개+ → 균등 chunk 분배 (긴 문장이 한 슬롯에 몰리는 UX 문제 방지)
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

/**
 * 번역을 2개 세그먼트에 의미 단위로 분배
 * 우선순위: 문장부호 > 쉼표 > 한국어 조사/접속사(타이밍 비율 기준) > 공백(타이밍 비율)
 */
function splitTranslationInTwo(
  translation: string,
  seg1: TranslationSegment,
  seg2: TranslationSegment
): [string, string] {
  const t = translation.trim();

  // 1순위: 문장 부호
  const sentenceBreak = t.match(/^(.+?[.!?])\s+(.+)$/);
  if (sentenceBreak) return [sentenceBreak[1].trim(), sentenceBreak[2].trim()];

  // 2순위: 쉼표
  const commaBreak = t.match(/^(.+?,)\s+(.+)$/);
  if (commaBreak) return [commaBreak[1].trim(), commaBreak[2].trim()];

  // 3순위: 한국어 조사/접속사 (타이밍 비율에 가장 가까운 지점)
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

  // 4순위: chunk 기반 타이밍 비율 분할
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

/**
 * 0.8s 이상 gap이 있는 세그먼트 경계를 자연 분할 지점으로 반환
 */
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

/**
 * gap 분할 지점 기준으로 번역을 구간별로 배분.
 *
 * [핵심 변경]
 * 기존: words.split(/\s+/) → 단어 단위 분배 (의미 단위 파괴 위험)
 * 신규: splitIntoMeaningChunks() → 의미 chunk 단위 분배
 *
 * 각 구간(gap으로 나뉜 slot 그룹)에 타이밍 비율로 chunk를 배분하고,
 * 구간 내 첫 번째 슬롯에 병합된 텍스트를 배치, 나머지는 빈칸.
 */
function distributeByBreakPoints(
  translation: string,
  originalIndices: number[],
  breakPoints: number[],
  originalSegments: TranslationSegment[],
  result: string[]
): void {
  // 1. gap 기준으로 슬롯 그룹 구성
  const slotGroups: number[][] = [];
  let start = 0;
  for (const bp of breakPoints) {
    slotGroups.push(originalIndices.slice(start, bp + 1));
    start = bp + 1;
  }
  slotGroups.push(originalIndices.slice(start));

  // 2. 각 슬롯 그룹의 총 duration 계산
  const durations = slotGroups.map(grp =>
    grp.reduce((sum, idx) =>
      sum + Math.max(originalSegments[idx].end - originalSegments[idx].start, 0.1), 0)
  );
  const totalDuration = durations.reduce((a, b) => a + b, 0);

  // 3. [핵심] 단어가 아닌 의미 chunk 단위로 분할
  const chunks = splitIntoMeaningChunks(translation);
  const totalChunks = chunks.length;

  let chunkOffset = 0;

  for (let si = 0; si < slotGroups.length; si++) {
    const grp = slotGroups[si];
    let assignedText: string;

    if (si === slotGroups.length - 1) {
      // 마지막 그룹: 남은 chunk 전부
      assignedText = chunks.slice(chunkOffset).join(" ");
    } else {
      // 타이밍 비율로 chunk 개수 결정
      const chunkCount = Math.max(
        1,
        Math.round((durations[si] / totalDuration) * totalChunks)
      );
      assignedText = chunks.slice(chunkOffset, chunkOffset + chunkCount).join(" ");
      chunkOffset += chunkCount;
    }

    // [Fix 2] 구간 내 슬롯이 2개 이상이면 chunk 균등 분배
    // (슬롯 1개: 전체 텍스트 그대로 / 슬롯 2개+: 빈칸 없이 균등 분배 → 모바일 UX 개선)
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
    .replace(RE_STAGE_DIRECTION_KO, "");
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
  // 한국어는 조사/어미 구조상 원문 대비 어절 수가 늘어나므로 임계값 완화
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
    `- NEVER add 자기야/여보/honey/baby unless that exact word is in the source.\n` +
    `- "not really" → "그다지요"\n` +
    `- "good fit" in job/interview context → "잘 맞다" (compatibility, NOT fitness)\n` +
    `- "mental health day" → "정신 건강을 위한 휴가"\n` +
    `- "Vine" is a social media app → "바인(Vine)", never "덩굴"\n` +
    `- "surprised you didn't say X" → "X라고 안 하신 게 놀랍네요"\n` +
    `- "you don't work here" → "여기서 일하지도 않잖아요"\n` +
    `- "are you firing me" → "저 해고하시는 거예요?"\n\n` +
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
      } as any); // 🔥 TS 에러 방지
  
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
      } as any); // 🔥 TS 에러 방지
  
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