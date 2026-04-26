import { initLlama, LlamaContext } from "llama.rn";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLanguageProfile } from "../constants/languageProfiles";
import { NativeModules, Platform } from 'react-native';

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

// ── SBD 관련 타입 ─────────────────────────────────────────────────────────────
interface SBDSentence {
  segmentIndices: number[];
  text: string;
  start: number;
  end: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MODEL_PATH = FileSystem.documentDirectory + "gemma-models/gemma-3n-e2b-q4.gguf";
const BATCH_SIZE = 5;
const SLEEP_BETWEEN_MS = 150;
const SLEEP_THERMAL_MS = 1200;
const THERMAL_EVERY_N = 5;
const EMA_ALPHA_BG = 0.4;
const EMA_REANCHOR_WEIGHT = 0.5;

// ── Thermal management ────────────────────────────────────────────────────────
const THERMAL_NPREDICT_SCALE = [1.0, 0.75, 0.55] as const;

let _thermalLevel = 0;
let _thermalConsecutiveHigh = 0;
let _thermalConsecutiveLow  = 0;

const SAVE_INTERVAL_MS = 1500;
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const PROPER_NOUN_MIN_COUNT = 3;

const SECS_PER_CHAR_KO = 0.065;
const MAX_TIMING_OVERLAP = 0.1;

const NETFLIX_MAX_CHARS_PER_LINE = 20;
const NETFLIX_MIN_CHARS_FOR_SPLIT = 15;

const EXPAND_GAP_THRESHOLD_S = 0.8;
const MERGE_GAP_HARD_LIMIT_S = 0.6;
const MERGE_GAP_SPEAKER_CHANGE_S = 0.35;
const MAX_WORDS_PER_GROUP = 35;

// [FIX-SBD-1] SBD가 너무 많이 묶는 문제 해결:
// 배치 크기를 15로 줄여 30세그 → 2배치로 나눔, 각 배치에서 더 정밀하게 경계 검출
const SBD_BATCH_SIZE = 15;
// [FIX-SBD-2] fallback ratio를 낮춰 SBD 결과를 더 쉽게 수용
const SBD_FALLBACK_RATIO = 0.7;

// [FIX-SBD-3] 그룹당 최대 세그먼트 수 제한: 이를 초과하면 강제 분리
const SBD_MAX_SEGS_PER_GROUP = 8;

const RE_DANGLING_FRAGMENT = /\b(with|for|and|but|or|to|in|at|on|of|by|a|an|the|is|are|was|were|be|been|being|have|has|had|will|would|could|should|may|might|must|do|does|did|not|no|i|you|we|they|he|she|it)\s*$/i;

const SOCIAL_MEDIA_NORMALIZATION: Record<string, string> = {
  "vine": "Vine", "snapchat": "Snapchat", "pinterest": "Pinterest",
  "instagram": "Instagram", "twitter": "Twitter", "facebook": "Facebook",
  "tiktok": "TikTok", "youtube": "YouTube", "linkedin": "LinkedIn",
  "reddit": "Reddit", "discord": "Discord", "twitch": "Twitch",
};

const RE_HALLUCINATED_TERMS_KO = /자기야[,，\s]*|자기[,，\s]+|여보[,，\s]*|오빠[,，\s]*|언니[,，\s]*/g;
const RE_HALLUCINATION_GUARD = /\b(honey|sweetie|darling|dear|oppa|unnie)\b/i;
const RE_OUTPUT_CORRUPTION = /^##\s*Translation\s*:?\s*/i;
const RE_UNTRANSLATED_MARKER = /^\[미번역\]\s*/;
const RE_STAGE_DIRECTION_KO = /\(혼잣말\)|\(독백\)|\(방백\)|\(내레이션\)/g;
const RE_PARENS_ANY = /\([^)]*\)/g;
const RE_ENGLISH_WORD = /\b([a-zA-Z]{3,})\b/g;
const RE_NUMERIC_TOKEN = /^\d+([:.]\d+)*[%]?$|^\d+(st|nd|rd|th)$/i;

const RE_NUMBERED_PREFIX = /^\d+\.\s+/;
const RE_AWKWARD_DEMONSTRATIVE = /^저것은\s/;
const RE_AWKWARD_DEMONSTRATIVE_I = /^저것이\s/;

const RE_LIKELY_QUESTION_END = /\?$|\bright\b|\bunderstood\b|\bunderstand\b|\bgot it\b/i;
const RE_LIKELY_RESPONSE_START = /^(yes|no|yeah|nope|yep|nah|i do|i don'?t|not really|of course|okay|ok|sure|right|hmm|uh|oh|well|i|we|that|it'?s|what|why|how)\b/i;

const RE_HALLUCINATED_ADDITION_KO = /놀랍네요|놀랍습니다|놀랍군요|이상하네요|이상합니다/g;
const RE_MORNING_TIME_KO = /아침\s*(\d{1,2})시/g;
const RE_TIME_HHMM = /\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(AM|PM|am|pm))?\b/g;
const RE_TIME_UNIT_DEDUP = /(\d{1,2})시\s*시/g;
const RE_MINUTE_UNIT_DEDUP = /(\d{1,2})분\s*분/g;
const RE_UNTIL_IN_MORNING = /until\s+(?:like\s+)?(\d{1,2})(?::\d{2})?\s+in\s+the\s+morning/i;
const RE_UNTIL_TIME_ONLY = /until\s+(?:like\s+)?(\d{1,2})(?::\d{2})?\b(?!\s+in\s+the\s+morning)/i;
const RE_PLACEHOLDER_LEAK = /__NUM\d+__/g;
const RE_THAT_KIND_OF_THING = /that\s+kind\s+of\s+thing/i;
const RE_THAT_KIND_OF_NOUN = /that\s+kind\s+of\s+([a-z]+(?:\s+[a-z]+)?)/i;
const RE_THAT_KIND_OF_VERB_ADJ = /that\s+kind\s+of\s+(is|was|are|were|feels|feel|seems|seem|looks|look|sounds|sound|works|work|makes|make|does|do|did|doesn't|don't|won't|can't|isn't|wasn't)/i;
const RE_KIND_OF_ALONE = /(?<!that\s)kind\s+of\b/i;
const RE_NEGATIVE_VERB = /\b(doesn't|don't|won't|can't|isn't|wasn't|didn't|never|no|not)\b/i;

const GENRE_PERSONA: Record<string, string> = {
  "general": `[ROLE] Professional subtitle translator.

[PRIORITY]
1. Accuracy — preserve exact meaning
2. Naturalness — sound like a native speaker
3. Conciseness — short, readable subtitles

[STYLE RULES]
- Prefer natural spoken Korean over written/formal style
- Match the speaker's energy and register
- Contractions and spoken forms over stiff written forms

[EXAMPLES]
EN: I don't know what you're talking about. → KR: 무슨 말인지 모르겠는데
EN: That actually makes a lot of sense. → KR: 그거 진짜 말 되네

[FORBIDDEN]
- Do NOT produce unnatural word-for-word translations
- Do NOT add filler words not in the source`,

  "comedy": `[ROLE] Professional comedy subtitle translator. Making the joke land is your #1 job.

[PRIORITY]
1. Comedic impact — translation must be funny if original is funny
2. Natural Korean expression — sound like a Korean comedian
3. Literal accuracy — least important; sacrifice it for the joke

[STYLE RULES]
- Preserve sarcasm, irony, deadpan, and self-deprecating humor
- Keep sentences short and punchy — comedy depends on brevity
- Use casual 반말/구어체; exaggeration in = exaggeration out

[EXAMPLES]
EN: Nice job, genius. → KR: 와 잘한다, 천재네
EN: I'm fine. Everything is fine. → KR: 괜찮아. 다 괜찮다고
EN: Oh sure, that worked out great. → KR: 물론이지, 완전 잘됐잖아
EN: Yeah, that's not gonna end well. → KR: 응, 저건 망했다

[FORBIDDEN]
- Do NOT translate word-for-word if it kills the punchline
- Do NOT soften sarcasm into neutral statements
- Do NOT use formal or stiff tone`,

  "news": `[ROLE] Professional broadcast news subtitle translator. Accuracy is non-negotiable.

[PRIORITY]
1. Factual accuracy — numbers, names, dates must be exact
2. Neutral tone — avoid adding emotional interpretation
3. Formal clarity — standard written Korean

[STYLE RULES]
- Use formal 합쇼체 (-습니다/-입니다) consistently
- Preserve all proper nouns and organization names exactly
- Translate numbers and statistics with full precision

[FORBIDDEN]
- Do NOT reinterpret, paraphrase, or editorialize factual statements
- Do NOT add emotional language not present in the source
- Do NOT omit or approximate numbers`,

  "documentary": `[ROLE] Professional documentary narrator translator. Your translation must feel cinematic.

[PRIORITY]
1. Narrative immersion — keep the audience engaged
2. Descriptive richness — preserve imagery and atmosphere
3. Accuracy — factual content must remain precise

[STYLE RULES]
- Use smooth, flowing sentences that read like narration
- Preserve metaphors and vivid descriptive language
- Match the gravitas or wonder of the narrator's tone

[EXAMPLES]
EN: For thousands of years, this place has remained untouched. → KR: 수천 년 동안, 이곳은 손길 하나 닿지 않은 채 남아 있었다

[FORBIDDEN]
- Do NOT flatten poetic language into plain statements
- Do NOT use choppy sentences`,

  "tech lecture": `[ROLE] Technical education subtitle translator for software, engineering, and science.

[PRIORITY]
1. Terminology accuracy — technical terms must be correct and consistent
2. Conceptual clarity — the learner must understand the concept
3. Natural flow — avoid robotic phrasing

[STYLE RULES]
- Keep English technical terms in English when universally used in Korean tech communities
- Use standard Korean vocabulary for concepts with established Korean terms
- Maintain strict term consistency throughout
- Use 합쇼체 (-습니다)

[EXAMPLES]
EN: This function returns a Promise. → KR: 이 함수는 Promise를 반환합니다
EN: The API call is asynchronous. → KR: API 호출은 비동기로 처리됩니다

[FORBIDDEN]
- Do NOT replace well-known English terms with awkward Korean equivalents
- Do NOT oversimplify or mistranslate technical concepts`,

  "gaming": `[ROLE] Gaming content subtitle translator. Translate like a Korean gamer, not a linguist.

[PRIORITY]
1. Gaming terminology — correct and natural to Korean gamers
2. Energy and emotion — preserve hype, frustration, excitement
3. Accuracy — gamer authenticity matters more than literal meaning

[STYLE RULES]
- Keep gaming terms in phonetic Korean form (너프, 버프, 렉, 딜, 탱커, 힐러, 궁극기)
- Use casual 반말 and gamer slang naturally
- Prefer shorter, fast-paced phrasing

[FORBIDDEN]
- Do NOT translate "nerf" → use "너프" / "buff" → use "버프"`,

  "education": `[ROLE] Educational content subtitle translator. Maximum comprehension for learners.

[PRIORITY]
1. Clarity — concept must be immediately understandable
2. Simplicity — accessible vocabulary without losing meaning
3. Accuracy — never sacrifice correctness for simplicity

[STYLE RULES]
- Break complex expressions into clear, simple Korean
- Warm, encouraging tone; use 합쇼체 (-습니다)

[FORBIDDEN]
- Do NOT use obscure vocabulary
- Do NOT add explanations beyond what is in the source`,
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
  "Save",
]);

const PROTECTED_PROPER_NOUNS = new Set([
  "Siri", "Alexa", "Google", "ChatGPT", "GPT", "AI",
  "Snapchat", "Pinterest", "Instagram", "Vine", "Twitter", "Facebook",
  "TikTok", "YouTube", "LinkedIn", "Reddit", "Discord", "Twitch",
  "Starbucks", "iPhone", "Android", "iOS", "macOS", "Windows",
  "Excel", "PowerPoint", "Publisher", "Word", "Outlook",
  "Skype", "Zoom", "Teams", "Slack",
]);

const PROTECTED_ACRONYMS = new Set(["HR", "CEO", "CFO", "CTO", "IT", "PR", "VP"]);

let llamaContext: LlamaContext | null = null;
let _loadModelPromise: Promise<void> | null = null;
let _unloadModelPromise: Promise<void> | null = null;
let _isAppBackgrounded = false;

export function setAppBackgroundedHint(val: boolean): void {
  _isAppBackgrounded = val;
}

// ── Inference serialization ───────────────────────────────────────────────────
let _inferenceQueue: Promise<void> = Promise.resolve();
let _nextJobId      = 0;
const _activeJobs   = new Set<number>();
const _bgProtected  = new Set<number>();

let _isInferenceRunning = false;

export function setBgJobProtection(val: boolean): void {
  if (val) {
    for (const id of _activeJobs) _bgProtected.add(id);
  } else {
    _bgProtected.clear();
  }
}

export function isTranslating(): boolean {
  return _isInferenceRunning;
}

export function isModelBusy(): boolean {
  return _isInferenceRunning;
}

function safeStopCompletion(ctx: LlamaContext): void {
  try {
    const result = (ctx as any).stopCompletion();
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {}
}

export function cancelCurrentInference(): void {
  if (llamaContext) {
    safeStopCompletion(llamaContext);
  }
  _bgProtected.clear();
}

export function cancelFgInference(): void {
  const toRemove: number[] = [];
  for (const id of _activeJobs) {
    if (!_bgProtected.has(id)) toRemove.push(id);
  }
  if (toRemove.length > 0 && llamaContext) {
    const hasBgJobRunning = _bgProtected.size > 0 && [..._activeJobs].some(id => _bgProtected.has(id));
    if (!hasBgJobRunning) {
      safeStopCompletion(llamaContext);
    }
  }
  for (const id of toRemove) _activeJobs.delete(id);
  if (__DEV__) {
    console.log(`[INFERENCE] cancelFgInference: removed ${toRemove.length} jobs, ${_activeJobs.size} remain`);
  }
}

export function debugInferenceCounters(): {
  enqueueId: number;
  activeJobId: number;
  activeJobs: number[];
  bgProtected: number[];
} {
  const activeArr = [..._activeJobs];
  return {
    enqueueId:   _nextJobId,
    activeJobId: activeArr.length > 0 ? Math.max(...activeArr) : _nextJobId,
    activeJobs:  activeArr,
    bgProtected: [..._bgProtected],
  };
}

function enqueueInference<T>(fn: (isCancelled: () => boolean) => Promise<T>): Promise<T> {
  const myJobId = ++_nextJobId;
  _activeJobs.add(myJobId);

  const isCancelled = () => !_activeJobs.has(myJobId);

  const task = _inferenceQueue.then(async () => {
    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

    if (!llamaContext) {
      _activeJobs.delete(myJobId);
      throw new Error('INFERENCE_CANCELLED');
    }

    _isInferenceRunning = true;
    try {
      return await fn(isCancelled);
    } finally {
      _isInferenceRunning = false;
      _activeJobs.delete(myJobId);
      _bgProtected.delete(myJobId);
    }
  });

  _inferenceQueue = task.then(() => {}, () => {});
  return task;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function sleep(ms: number): Promise<void> {
  if (_isAppBackgrounded && NativeModules.TranslationService?.nativeSleep) {
    return NativeModules.TranslationService.nativeSleep(ms);
  }
  return new Promise<void>((r) => setTimeout(r, ms));
}

function getInferenceThreadCount(): number {
  if (_thermalLevel >= 2) return 2;
  if (_thermalLevel >= 1) return 3;
  return 4;
}

function applyThermalNPredict(base: number): number {
  const scaled = Math.round(base * THERMAL_NPREDICT_SCALE[_thermalLevel]);
  return Math.max(scaled, 8);
}

function getThermalSleepMs(): number {
  if (_thermalLevel === 0) return 0;
  if (_thermalLevel === 1) return 800;
  return 1500;
}

function checkThermalPressure(rawBatchMs: number, emaBatchMs: number): void {
  if (rawBatchMs > 2500) {
    _thermalConsecutiveLow = 0;
    _thermalConsecutiveHigh++;
    if (_thermalConsecutiveHigh >= 2 && _thermalLevel < 2) {
      _thermalLevel++;
      _thermalConsecutiveHigh = 0;
      if (__DEV__) console.log(`[THERMAL] Level UP → ${_thermalLevel} (raw=${rawBatchMs}ms)`);
    }
  } else if (emaBatchMs < 1200) {
    _thermalConsecutiveHigh = 0;
    _thermalConsecutiveLow++;
    if (_thermalConsecutiveLow >= 3 && _thermalLevel > 0) {
      _thermalLevel--;
      _thermalConsecutiveLow = 0;
      if (__DEV__) console.log(`[THERMAL] Level DOWN → ${_thermalLevel} (ema=${Math.round(emaBatchMs)}ms)`);
    }
  } else {
    _thermalConsecutiveHigh = 0;
    _thermalConsecutiveLow  = 0;
  }
}

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

// ── 숫자/시간 토큰 마스킹 ────────────────────────────────────────────────────
interface MaskedToken { placeholder: string; original: string; }

function maskNumericTokens(text: string): { masked: string; tokens: MaskedToken[] } {
  const tokens: MaskedToken[] = [];
  const RE_MASK = /\b(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM|am|pm))?|\d+(?:\.\d+)?%|\d+(st|nd|rd|th)|\d+)\b/gi;
  const masked = text.replace(RE_MASK, (match) => {
    const ph = `__NUM${tokens.length}__`;
    tokens.push({ placeholder: ph, original: match });
    return ph;
  });
  return { masked, tokens };
}

function restoreNumericTokens(text: string, tokens: MaskedToken[]): string {
  let r = text;
  for (let i = tokens.length - 1; i >= 0; i--) {
    r = r.replace(new RegExp(escapeRegex(tokens[i].placeholder), "g"), tokens[i].original);
  }
  return r;
}

function stripLeakedPlaceholders(text: string): string {
  return text.replace(RE_PLACEHOLDER_LEAK, "").replace(/\s{2,}/g, " ").trim();
}

function deduplicateTimeUnits(text: string): string {
  return text
    .replace(RE_TIME_UNIT_DEDUP, "$1시")
    .replace(RE_MINUTE_UNIT_DEDUP, "$1분");
}

function convertTimeExpressionKo(text: string): string {
  RE_TIME_HHMM.lastIndex = 0;
  const converted = text.replace(RE_TIME_HHMM, (match, hour, minute, ampm) => {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (ampm) {
      const isAm = /am/i.test(ampm);
      const prefix = isAm ? "오전" : "오후";
      if (m === 0) return `${prefix} ${h}시`;
      return `${prefix} ${h}시 ${m}분`;
    }
    if (m === 0) return `${h}시`;
    return `${h}시 ${m}분`;
  });
  return deduplicateTimeUnits(converted);
}

function applyDawnTimeCorrection(out: string, sourceText: string): string {
  const morningMatch = sourceText.match(RE_UNTIL_IN_MORNING);
  if (morningMatch) {
    const hour = parseInt(morningMatch[1], 10);
    if (hour >= 1 && hour <= 6) {
      out = out.replace(RE_MORNING_TIME_KO, (_, h) => `새벽 ${h}시`);
      out = out.replace(/아침까지/, "새벽까지");
      out = out.replace(/오전\s*(\d{1,2})시/g, (_, h) => {
        const hNum = parseInt(h, 10);
        return hNum >= 1 && hNum <= 6 ? `새벽 ${h}시` : `오전 ${h}시`;
      });
    }
    return out;
  }
  const inMorningMatch = sourceText.match(/(?:^|,|\s)(?:like\s+)?(\d{1,2})(?::\d{2})?\s+in\s+the\s+morning/i);
  if (inMorningMatch) {
    const hour = parseInt(inMorningMatch[1], 10);
    if (hour >= 1 && hour <= 6) {
      out = out.replace(RE_MORNING_TIME_KO, (_, h) => `새벽 ${h}시`);
      out = out.replace(/오전\s*(\d{1,2})시/g, (_, h) => {
        const hNum = parseInt(h, 10);
        return hNum >= 1 && hNum <= 6 ? `새벽 ${h}시` : `오전 ${h}시`;
      });
    }
    return out;
  }
  const untilArrivalMatch = sourceText.match(RE_UNTIL_TIME_ONLY);
  if (untilArrivalMatch) {
    const hour = parseInt(untilArrivalMatch[1], 10);
    if (hour >= 7) {
      out = out.replace(/새벽\s*(\d{1,2})시/g, (_, h) =>
        parseInt(h, 10) >= 7 ? `${h}시` : `새벽 ${h}시`
      );
    }
  }
  return out;
}

function applyThatKindOfFix(out: string, sourceText: string): string {
  if (!/kind\s+of/i.test(sourceText)) return out;
  const isNegative = RE_NEGATIVE_VERB.test(sourceText);
  if (RE_THAT_KIND_OF_THING.test(sourceText)) {
    out = out
      .replace(/그런\s+종류의\s+것[은이가을를]?/g, "그런 거")
      .replace(/그런\s+종류는/g, "그런 거")
      .replace(/그런\s+종류가/g, "그게");
    return out;
  }
  if (RE_THAT_KIND_OF_VERB_ADJ.test(sourceText)) {
    if (isNegative) {
      out = out
        .replace(/그런\s+종류는\s+/g, "그게 좀 ")
        .replace(/그런\s+종류가\s+/g, "그게 좀 ")
        .replace(/^그런\s+종류는/, "그게 좀");
    } else {
      out = out
        .replace(/그런\s+종류는\s+/g, "그게 좀 ")
        .replace(/그런\s+종류가\s+/g, "그게 좀 ");
    }
    return out;
  }
  const nounMatch = sourceText.match(RE_THAT_KIND_OF_NOUN);
  if (nounMatch) {
    out = out.replace(/그게\s+좀\s+(연구|기술|능력|역량|자료|정보)/g, "그런 종류의 $1");
    return out;
  }
  if (RE_KIND_OF_ALONE.test(sourceText)) {
    out = out
      .replace(/그런\s+종류의\s+/g, "좀 ")
      .replace(/그런\s+종류로\s+/g, "좀 ");
  }
  return out;
}

function likelySpeakerChange(prevText: string, currText: string, gap: number): boolean {
  const prev = prevText.trim();
  const curr = currText.trim();
  if (gap >= MERGE_GAP_HARD_LIMIT_S) return false;
  if (RE_LIKELY_QUESTION_END.test(prev) && RE_LIKELY_RESPONSE_START.test(curr)) return true;
  if (/[.!]$/.test(prev) && /^(yes|no|yeah|nope|hmm|uh|oh|ok|okay|right|sure|i do|i don't)\b/i.test(curr)) return true;
  if (/^(yes|no|yeah|nope|hmm|uh|oh|ok|okay|right|sure)\.?$/i.test(prev) && curr.split(/\s+/).length >= 3) return true;
  if (/^who\b/i.test(prev) && /^i\s+(do|did|don't|doesn't|am|was)\b/i.test(curr)) return true;
  return false;
}

// ── GPU layer helper ──────────────────────────────────────────────────────────
function getSafeGpuLayers(): number {
  // Android: Vulkan GPU acceleration via llama.cpp
  // Snapdragon 8 Gen 2/3 supports full GPU offload
  // Start with 20 layers (safe for 2GB VRAM headroom)
  // Full model has ~28 layers for 2B model
  if (Platform.OS === 'android') return 20;
  // iOS: Metal GPU acceleration
  if (Platform.OS === 'ios') return 28;
  return 0;
}

// ── Model lifecycle ───────────────────────────────────────────────────────────
export async function loadModel(onProgress?: (fraction: number) => void): Promise<void> {
  if (_unloadModelPromise) {
    console.log('[Gemma] loadModel() waiting for unloadModel() to complete...');
    try { await _unloadModelPromise; } catch {}
  }

  if (llamaContext) return;
  if (_loadModelPromise) return _loadModelPromise;
  _loadModelPromise = (async () => {
    if (llamaContext) return;
    const info = await FileSystem.getInfoAsync(MODEL_PATH);
    if (!info.exists) throw new Error("Gemma 모델 파일을 찾을 수 없습니다. 먼저 다운로드해 주세요.");
    const modelPath = MODEL_PATH.startsWith("file://") ? MODEL_PATH.slice(7) : MODEL_PATH;
    try {
      try {
        llamaContext = await initLlama(
          { model: modelPath, n_threads: getInferenceThreadCount(), n_gpu_layers: getSafeGpuLayers(), n_ctx: 2000, use_mlock: false },
          onProgress ? (p: number) => onProgress(p / 100) : undefined
        );
      } catch (gpuError) {
        console.warn('[Gemma] GPU init failed, falling back to CPU:', gpuError);
        llamaContext = await initLlama(
          { model: modelPath, n_threads: getInferenceThreadCount(), n_gpu_layers: 0, n_ctx: 2000, use_mlock: false },
          onProgress ? (p: number) => onProgress(p / 100) : undefined
        );
      }
      console.log("[Gemma] Model loaded.");
    } catch (e) {
      llamaContext = null;
      throw new Error(`Gemma 모델 로드 실패: ${(e as Error).message}`);
    } finally {
      _loadModelPromise = null;
    }
  })();
  return _loadModelPromise;
}

let _unloadGeneration = 0;

export async function unloadModel(): Promise<void> {
  _thermalLevel = 0;
  _thermalConsecutiveHigh = 0;
  _thermalConsecutiveLow  = 0;

  cancelCurrentInference();

  if (!llamaContext) return;

  const myGeneration = ++_unloadGeneration;
  const ctxToRelease = llamaContext;
  llamaContext = null;

  _unloadModelPromise = (async () => {
    try {
      const UNLOAD_WAIT_MS = 2000;
      const POLL_INTERVAL_MS = 20;
      const deadline = Date.now() + UNLOAD_WAIT_MS;
      while (_activeJobs.size > 0 && Date.now() < deadline) {
        await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (_activeJobs.size > 0 && __DEV__) {
        console.warn(`[Gemma] unloadModel: ${_activeJobs.size} job(s) still active after ${UNLOAD_WAIT_MS}ms wait, proceeding with release`);
      }
      await ctxToRelease.release();
      console.log('[Gemma] Context released successfully.');
    } catch (e) {
      console.warn("[Gemma] release error:", e);
    } finally {
      if (_unloadGeneration === myGeneration) {
        _unloadModelPromise = null;
      }
    }
  })();

  await _unloadModelPromise;
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
        if (!seen.has(w.toLowerCase())) {
          accText += " " + w;
          accWords.push(w.toLowerCase());
          seen.add(w.toLowerCase());
        }
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

// ═══════════════════════════════════════════════════════════════════════════════
// ── SBD ──────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const SBD_SYSTEM_PROMPT = `You are a sentence boundary detector for ASR (speech recognition) subtitles.

ASR splits speech into arbitrary fragments. Your job is to identify which fragments belong to the same complete sentence.

INPUT: Numbered ASR fragments (possibly incomplete mid-sentence breaks)
OUTPUT: A JSON array of segment numbers that START a new sentence.
        Always include 1 as the first element.
        Output ONLY the JSON array, nothing else.

RULES:
- Fragments ending with prepositions (with, for, to, in, at, of, by), conjunctions (and, but, or), articles (a, an, the), or auxiliary verbs MUST be joined with the next fragment
- A new sentence starts when:
  * Previous fragment ends with . ! ?
  * Clear topic/speaker change (question → answer, statement → reaction)
  * Response words at start: Yes/No/Yeah/Nope/Hmm/Oh/Okay/Right/Sure
  * "I do" / "I don't" / "I did" / "I will" as a SHORT standalone response (2 words or fewer) = always its own sentence
  * New independent clause with subject+verb
  * Speaker label in brackets like [Name] indicates a new speaker = new sentence
- Short responses (Yes, No, I do, Hmm, Oh wow) are ALWAYS their own sentence
- When in doubt, SPLIT rather than merge — prefer more boundaries over fewer
- NEVER group more than 6 fragments together

EXAMPLE:
Input:
1. for this meeting with
2. you you've given me no
3. encouragement no supervision is there
4. an HR director somewhere
5. I need to speak
6. to someone

Output: [1, 4, 5]`;

function parseSBDResponse(response: string, segCount: number): number[] | null {
  try {
    const jsonMatch = response.match(/\[[\d,\s]+\]/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed
      .filter((n) => typeof n === "number" && n >= 1 && n <= segCount)
      .map((n) => Math.floor(n));
    const unique = [...new Set(valid)].sort((a, b) => a - b);
    if (unique.length === 0 || unique[0] !== 1) unique.unshift(1);
    return unique;
  } catch {
    return null;
  }
}

// [FIX-SBD-4] 그룹당 최대 세그먼트 수 초과 시 강제 분리
function enforceSBDGroupSizeLimit(
  boundaries: number[],
  segCount: number,
  maxSegsPerGroup: number
): number[] {
  const result = new Set(boundaries);
  // boundaries는 "새 문장 시작" 1-based 인덱스
  const sortedBounds = [...result].sort((a, b) => a - b);

  for (let i = 0; i < sortedBounds.length; i++) {
    const groupStart = sortedBounds[i];
    const groupEnd = i + 1 < sortedBounds.length ? sortedBounds[i + 1] - 1 : segCount;
    const groupSize = groupEnd - groupStart + 1;

    if (groupSize > maxSegsPerGroup) {
      // 강제로 중간에 경계 삽입
      const insertEvery = Math.ceil(groupSize / Math.ceil(groupSize / maxSegsPerGroup));
      for (let k = groupStart + insertEvery; k <= groupEnd; k += insertEvery) {
        result.add(k);
      }
    }
  }

  return [...result].sort((a, b) => a - b);
}

function groupSegmentsByBoundaries(
  segments: TranslationSegment[],
  boundaries: number[]
): SBDSentence[] {
  const sentences: SBDSentence[] = [];
  const boundarySet = new Set(boundaries);
  let currentGroup: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    const oneBased = i + 1;
    if (boundarySet.has(oneBased) && currentGroup.length > 0) {
      const segs = currentGroup.map((idx) => segments[idx]);
      sentences.push({
        segmentIndices: [...currentGroup],
        text: segs.map((s) => s.text).join(" ").trim(),
        start: segs[0].start,
        end: segs[segs.length - 1].end,
      });
      currentGroup = [];
    }
    currentGroup.push(i);
  }

  if (currentGroup.length > 0) {
    const segs = currentGroup.map((idx) => segments[idx]);
    sentences.push({
      segmentIndices: [...currentGroup],
      text: segs.map((s) => s.text).join(" ").trim(),
      start: segs[0].start,
      end: segs[segs.length - 1].end,
    });
  }
  return sentences;
}

async function runSBDBatch(
  segments: TranslationSegment[],
  isCancelled: () => boolean
): Promise<number[]> {
  if (!llamaContext || isCancelled()) return [1];

  const inputLines = segments
    .map((seg, i) => `${i + 1}. ${seg.text}`)
    .join("\n");

  try {
    if (!llamaContext || isCancelled()) return [1];

    const sbdNPredict = Math.max(64, segments.length * 12);

    const result = await llamaContext.completion({
      messages: [
        { role: "system", content: SBD_SYSTEM_PROMPT },
        { role: "user", content: inputLines },
      ],
      n_predict: sbdNPredict,
      temperature: 0.05,
      top_p: 0.9,
      stop: ["</s>", "<end_of_turn>", "<|end|>"],
    });

    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

    const parsed = parseSBDResponse(result.text, segments.length);
    if (!parsed || parsed.length === 0) {
      console.warn("[SBD] parse failed, treating all as one sentence");
      return [1];
    }

    // [FIX-SBD-4] 그룹 크기 제한 적용
    const limited = enforceSBDGroupSizeLimit(parsed, segments.length, SBD_MAX_SEGS_PER_GROUP);
    console.log(`[SBD] batch(${segments.length}) → boundaries: [${limited.join(",")}]`);
    return limited;
  } catch (e: any) {
    if (e?.message === 'INFERENCE_CANCELLED') throw e;
    if (e?.message?.includes('Context') && e?.message?.includes('not found')) {
      console.warn('[SBD] Context already released — skipping SBD batch');
      return [1];
    }
    console.warn("[SBD] LLM error:", e);
    return [1];
  }
}

async function detectSentenceBoundaries(
  segments: TranslationSegment[],
  isCancelled: () => boolean
): Promise<SBDSentence[]> {
  if (segments.length === 0) return [];
  if (segments.length === 1) {
    return [{
      segmentIndices: [0],
      text: segments[0].text,
      start: segments[0].start,
      end: segments[0].end,
    }];
  }

  console.log(`[SBD] Starting boundary detection for ${segments.length} segments`);

  const allSentences: SBDSentence[] = [];
  let globalOffset = 0;

  while (globalOffset < segments.length) {
    if (!llamaContext || isCancelled()) {
      console.warn('[SBD] Cancelled or context null mid-loop — aborting SBD');
      return [];
    }

    const batchEnd = Math.min(globalOffset + SBD_BATCH_SIZE, segments.length);
    const batch = segments.slice(globalOffset, batchEnd);
    const localBoundaries = await runSBDBatch(batch, isCancelled);

    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

    if (globalOffset + SBD_BATCH_SIZE < segments.length) {
      await sleep(_thermalLevel >= 1 ? 300 : 120);
      if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
    }

    const batchSentences = groupSegmentsByBoundaries(batch, localBoundaries);

    if (allSentences.length > 0 && batchSentences.length > 0) {
      const lastSentence = allSentences[allSentences.length - 1];
      const lastText = lastSentence.text;
      const isDangling = RE_DANGLING_FRAGMENT.test(lastText);
      if (isDangling) {
        const firstOfBatch = batchSentences.shift()!;
        const mergedIndices = [
          ...lastSentence.segmentIndices.map((idx) => idx),
          ...firstOfBatch.segmentIndices.map((idx) => idx + globalOffset),
        ];
        const mergedSegs = mergedIndices.map((idx) => segments[idx]);
        allSentences[allSentences.length - 1] = {
          segmentIndices: mergedIndices,
          text: [lastText, firstOfBatch.text].join(" ").trim(),
          start: mergedSegs[0].start,
          end: mergedSegs[mergedSegs.length - 1].end,
        };
      }
    }

    for (const sent of batchSentences) {
      allSentences.push({
        ...sent,
        segmentIndices: sent.segmentIndices.map((idx) => idx + globalOffset),
      });
    }
    globalOffset = batchEnd;
  }

  // [FIX-SBD-2] fallback ratio 낮춤: 0.9 → 0.7
  const sentenceRatio = allSentences.length / segments.length;
  if (sentenceRatio >= SBD_FALLBACK_RATIO && segments.length > 5) {
    console.warn(`[SBD] Low grouping rate (${allSentences.length}/${segments.length} = ${sentenceRatio.toFixed(2)}), falling back to mergeFragments`);
    return [];
  }

  console.log(`[SBD] Done: ${segments.length} segments → ${allSentences.length} sentences`);
  return allSentences;
}

function sbdSentencesToMergedGroups(sentences: SBDSentence[]): MergedGroup[] {
  return sentences.map((sent) => ({
    start: sent.start,
    end: sent.end,
    text: sent.text,
    originalIndices: sent.segmentIndices,
  }));
}

// ── [LEGACY] Fragment merging ─────────────────────────────────────────────────

function isShortIndependent(t: string): boolean {
  const trimmed = t.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wc = words.length;
  if (wc === 0 || wc > 3) return false;
  const word = words[0];
  if (wc === 1 && word.endsWith("?")) return true;
  if (/^(no|yes|yeah|nope|yep|nah|not\s+really|okay\s+yes|alright|sure|right)$/i.test(trimmed)) return true;
  if (wc === 1 && /^(hmm|hm|uh|um|oh|wow|okay|ok|hey|right|sure|fine|well|whoa|ow|ugh|yikes|oops)$/i.test(word)) return true;
  if (/^i\s+(do|did|don'?t|will|won'?t|am|was|can|can'?t)(\s+\w+)?$/i.test(trimmed) && wc <= 3) return true;
  if (wc === 1 && /^[A-Z][a-zA-Z]{1,11}$/.test(word)) return true;
  if (wc <= 3 && /^(i|you|we|they)\s+(do|did|will|won't|can|can't|get|got|know|see|am|was)(\s+\w+)?$/i.test(trimmed)) return true;
  if (wc >= 2 && wc <= 3 && /[.!]$/.test(trimmed)) return true;
  if (wc === 2 && /^that's\s+\w+$/i.test(trimmed)) return true;
  return false;
}

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
    if (isShortIndependent(seg.text)) {
      groups.push({ start: seg.start, end: seg.end, text: seg.text, originalIndices: [i] });
      i++; continue;
    }
    let group: MergedGroup = { start: seg.start, end: seg.end, text: seg.text.trim(), originalIndices: [i] };
    let j = i + 1;
    while (j < segments.length) {
      const next = segments[j];
      if (isFiller(next.text)) break;
      if (isShortIndependent(next.text)) break;
      const gap = next.start - group.end;
      const wc = group.text.split(/\s+/).length;
      const speakerChange = likelySpeakerChange(group.text, next.text, gap);
      const effectiveLimit = speakerChange ? MERGE_GAP_SPEAKER_CHANGE_S : MERGE_GAP_HARD_LIMIT_S;
      if (gap >= effectiveLimit) break;
      if (wc >= MAX_MERGE_WORDS) break;
      if (!isSentenceEnd(group.text)) {
        group.text += " " + next.text.trim();
        group.end = next.end;
        group.originalIndices.push(j);
        j++; continue;
      }
      if (wc < 6 && gap < 0.4 && !speakerChange) {
        group.text += " " + next.text.trim();
        group.end = next.end;
        group.originalIndices.push(j);
        j++; continue;
      }
      if (isBackchannel(group.text) && wc <= 3) break;
      break;
    }
    groups.push(group);
    i = j;
  }
  return groups;
}

function enforceSentence(groups: MergedGroup[]): MergedGroup[] {
  const result: MergedGroup[] = [];
  let buffer: MergedGroup | null = null;
  for (const g of groups) {
    if (!buffer) { buffer = { ...g }; continue; }
    if (isShortIndependent(buffer.text) || isShortIndependent(g.text)) {
      result.push(buffer); buffer = { ...g }; continue;
    }
    const gap = g.start - buffer.end;
    const speakerChange = likelySpeakerChange(buffer.text, g.text, gap);
    if (speakerChange || gap >= MERGE_GAP_HARD_LIMIT_S) {
      result.push(buffer); buffer = { ...g }; continue;
    }
    if (buffer.text.split(/\s+/).length < 2) {
      buffer.text += " " + g.text;
      buffer.end = g.end;
      buffer.originalIndices = [...buffer.originalIndices, ...g.originalIndices];
    } else {
      result.push(buffer); buffer = { ...g };
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
    .map(s => s.trim()).filter(Boolean);
  if (koSplit.length > 1) return healDanglingParticles(koSplit);
  const enPhraseSplit = t
    .split(/(?<=\b(?:and|but|so|because|that|when|if|although|while|after|before|since|until|though|or)\b)\s+/i)
    .map(s => s.trim()).filter(Boolean);
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
      result.push(curr + " " + chunks[i + 1]); i += 2;
    } else { result.push(curr); i++; }
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

// ── expandGroupTranslations ───────────────────────────────────────────────────
// [FIX-EXPAND-1] 핵심 수정: 그룹 번역을 원본 세그먼트에 분배할 때
// 단일 세그먼트 그룹이더라도 반드시 해당 인덱스에 올바르게 배치
function expandGroupTranslations(
  groups: MergedGroup[],
  groupTranslations: string[],
  originalSegments: TranslationSegment[]
): string[] {
  const result: string[] = new Array(originalSegments.length).fill("");

  // [FIX-EXPAND-2] 먼저 모든 인덱스가 어떤 그룹에 속하는지 검증
  const assignedIndices = new Set<number>();
  for (const group of groups) {
    for (const idx of group.originalIndices) {
      if (assignedIndices.has(idx)) {
        console.warn(`[EXPAND] Duplicate index ${idx} across groups!`);
      }
      assignedIndices.add(idx);
    }
  }

  // 할당되지 않은 인덱스가 있으면 경고
  for (let i = 0; i < originalSegments.length; i++) {
    if (!assignedIndices.has(i)) {
      console.warn(`[EXPAND] Index ${i} not covered by any group! text="${originalSegments[i].text}"`);
    }
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const { originalIndices } = group;
    let translation = (groupTranslations[gi] ?? "").trim();

    if (!translation) {
      // 번역이 없으면 원문 유지
      for (const idx of originalIndices) result[idx] = originalSegments[idx].text;
      continue;
    }

    const groupSrc = originalIndices.map(idx => originalSegments[idx].text).join(" ");
    if (!RE_HALLUCINATION_GUARD.test(groupSrc)) {
      translation = translation.replace(RE_HALLUCINATED_TERMS_KO, "").trim();
    }
    if (!translation) {
      for (const idx of originalIndices) result[idx] = originalSegments[idx].text;
      continue;
    }

    // [FIX-EXPAND-3] 단일 인덱스: 직접 할당
    if (originalIndices.length === 1) {
      result[originalIndices[0]] = translation;
      continue;
    }

    // [FIX-EXPAND-4] 2개 인덱스: 2분할
    if (originalIndices.length === 2) {
      const [p1, p2] = splitTranslationInTwo(translation, originalSegments[originalIndices[0]], originalSegments[originalIndices[1]]);
      result[originalIndices[0]] = p1;
      result[originalIndices[1]] = p2 || translation; // p2가 비면 전체 번역 사용
      continue;
    }

    // [FIX-EXPAND-5] 3개 이상: 타이밍 비율 기반 분배
    const breakPoints = findNaturalBreakPoints(originalIndices, originalSegments);
    if (breakPoints.length === 0) {
      const distributed = distributeByTimingRatio(translation, originalIndices, originalSegments);
      for (let k = 0; k < originalIndices.length; k++) {
        result[originalIndices[k]] = distributed[k] || translation;
      }
    } else {
      distributeByBreakPoints(translation, originalIndices, breakPoints, originalSegments, result);
    }

    // [FIX-EXPAND-6] 분배 후 빈 슬롯 보호: 빈 항목은 인접 번역 또는 전체 번역으로 채움
    for (const idx of originalIndices) {
      if (!result[idx] || !result[idx].trim()) {
        result[idx] = translation;
      }
    }
  }

  // [FIX-EXPAND-7] 최종 안전망: 여전히 빈 항목은 원문으로
  for (let i = 0; i < originalSegments.length; i++) {
    if (!result[i] || !result[i].trim()) {
      console.warn(`[EXPAND] Slot ${i} still empty after expand, using source text`);
      result[i] = originalSegments[i].text;
    }
  }

  return result;
}

function distributeByTimingRatio(translation: string, originalIndices: number[], originalSegments: TranslationSegment[]): string[] {
  const segs = originalIndices.map(idx => originalSegments[idx]);
  const durations = segs.map(s => Math.max(s.end - s.start, 0.1));
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const chars = translation.replace(/\s/g, "");
  const totalChars = chars.length;
  const words = translation.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return new Array(originalIndices.length).fill("");
  if (words.length <= originalIndices.length) {
    const result = new Array(originalIndices.length).fill("");
    words.forEach((w, i) => { result[i] = w; });
    return result;
  }
  const result: string[] = [];
  let wordOffset = 0;
  let charOffset = 0;
  for (let i = 0; i < originalIndices.length; i++) {
    if (i === originalIndices.length - 1) { result.push(words.slice(wordOffset).join(" ")); break; }
    const targetCharCount = (durations[i] / totalDuration) * totalChars;
    let accumulated = 0;
    let bestWord = wordOffset + 1;
    for (let w = wordOffset; w < words.length - (originalIndices.length - 1 - i); w++) {
      accumulated += words[w].length;
      if (accumulated >= targetCharCount) { bestWord = w + 1; break; }
      bestWord = w + 1;
    }
    result.push(words.slice(wordOffset, bestWord).join(" "));
    charOffset += words.slice(wordOffset, bestWord).join("").length;
    wordOffset = bestWord;
  }
  return result;
}

function splitTranslationInTwo(translation: string, seg1: TranslationSegment, seg2: TranslationSegment): [string, string] {
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
  if (bestPos > 0 && bestPos < t.length - 2) return [t.slice(0, bestPos).trim(), t.slice(bestPos).trim()];
  const chunks = splitIntoMeaningChunks(t);
  if (chunks.length >= 2) {
    const splitIdx = Math.max(1, Math.round(chunks.length * targetRatio));
    return [chunks.slice(0, splitIdx).join(" "), chunks.slice(splitIdx).join(" ")];
  }
  // [FIX-SPLIT] 분할 불가능하면 앞에 전체, 뒤에 빈 문자열 대신 동일 텍스트
  return [t, t];
}

function findNaturalBreakPoints(originalIndices: number[], originalSegments: TranslationSegment[]): number[] {
  const breaks: number[] = [];
  for (let k = 0; k < originalIndices.length - 1; k++) {
    const curr = originalSegments[originalIndices[k]];
    const next = originalSegments[originalIndices[k + 1]];
    if (next.start - curr.end >= EXPAND_GAP_THRESHOLD_S) breaks.push(k);
  }
  return breaks;
}

function distributeByBreakPoints(
  translation: string, originalIndices: number[], breakPoints: number[],
  originalSegments: TranslationSegment[], result: string[]
): void {
  const slotGroups: number[][] = [];
  let start = 0;
  for (const bp of breakPoints) { slotGroups.push(originalIndices.slice(start, bp + 1)); start = bp + 1; }
  slotGroups.push(originalIndices.slice(start));
  const durations = slotGroups.map(grp =>
    grp.reduce((sum, idx) => sum + Math.max(originalSegments[idx].end - originalSegments[idx].start, 0.1), 0)
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
      const chunkCount = Math.max(1, Math.round((durations[si] / totalDuration) * totalChunks));
      assignedText = chunks.slice(chunkOffset, chunkOffset + chunkCount).join(" ");
      chunkOffset += chunkCount;
    }
    if (grp.length === 1) {
      result[grp[0]] = assignedText.trim() || translation;
    } else {
      const distributed = distributeByTimingRatio(assignedText.trim(), grp, originalSegments);
      for (let k = 0; k < grp.length; k++) result[grp[k]] = distributed[k] || translation;
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

// ── 고유명사 ─────────────────────────────────────────────────────────────────
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
      if (COMMON_WORDS.has(w) || PROTECTED_PROPER_NOUNS.has(w) || PROTECTED_ACRONYMS.has(w)) continue;
      const e = stats.get(w) ?? { mid: 0, first: 0 };
      if (firstWords.has(w)) e.first++; else e.mid++;
      stats.set(w, e);
    }
  }
  const result: string[] = [];
  for (const [w, { mid, first }] of stats)
    if (mid * 1.5 + first * 0.5 >= PROPER_NOUN_MIN_COUNT) result.push(w);
  return result;
}

async function transliterateProperNouns(
  nouns: string[],
  targetLanguage: string,
  isCancelled: () => boolean
): Promise<Record<string, string>> {
  if (!llamaContext || nouns.length === 0 || isCancelled()) return {};
  if (!llamaContext || isCancelled()) return {};
  const r = await llamaContext.completion({
    messages: [
      { role: "system", content: `Transliterate each proper noun into ${targetLanguage} phonetically.\nOutput ONLY 'English=Transliteration' lines.` },
      { role: "user", content: nouns.join("\n") },
    ],
    n_predict: nouns.length * 20,
    temperature: 0.1,
    top_p: 0.9,
    stop: ["</s>", "<end_of_turn>", "<|end|>"],
  });
  if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
  const dict: Record<string, string> = {};
  for (const line of r.text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const src = line.slice(0, eq).trim(), tgt = line.slice(eq + 1).trim();
    if (src && tgt) dict[src] = tgt;
  }
  return dict;
}

async function buildProperNounDict(
  segments: TranslationSegment[],
  videoHash: string,
  targetLanguage: string,
  isCancelled: () => boolean
): Promise<Record<string, string>> {
  const stored = await AsyncStorage.getItem(properNounKey(videoHash));
  const existing: Record<string, string> = stored ? JSON.parse(stored) : {};
  const candidates = extractProperNounCandidates(segments);
  const merged: Record<string, string> = { ...existing };
  for (const n of candidates) if (!(n in merged)) merged[n] = "";
  const unmapped = Object.entries(merged).filter(([, v]) => !v).map(([k]) => k);
  if (unmapped.length > 0) {
    const fresh = await transliterateProperNouns(unmapped, targetLanguage, isCancelled);
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
  return text
    .replace(/\.{2,}$/, "")
    .replace(/(?<!\()[^)]*\)/g, "")
    .replace(/(?<!\[)[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildBatchMessage(batch: MergedGroup[]): { message: string; tokenMaps: MaskedToken[][]; } {
  const tokenMaps: MaskedToken[][] = [];
  const lines: string[] = [];
  for (let i = 0; i < batch.length; i++) {
    const c = normalizeSocialMediaNames(cleanWhisperText(batch[i].text));
    const { masked, tokens } = maskNumericTokens(c);
    tokenMaps.push(tokens);
    lines.push(`${i + 1}. ${masked}`);
  }
  return { message: lines.join("\n"), tokenMaps };
}

function postProcessTranslation(translated: string, sourceText: string, targetLanguage: string): string {
  let out = translated;
  if (RE_PLACEHOLDER_LEAK.test(out)) {
    console.warn(`[POST] Placeholder leak detected: "${out}" (src: "${sourceText}")`);
    out = stripLeakedPlaceholders(out);
  }
  if (targetLanguage === "Korean" || targetLanguage === "ko") {
    out = convertTimeExpressionKo(out);
    out = deduplicateTimeUnits(out);
    out = applyDawnTimeCorrection(out, sourceText);
    out = applyThatKindOfFix(out, sourceText);
    const srcHasSurprise = /surprised|amazing|incredible|unbelievable|wow|astonish/i.test(sourceText);
    if (!srcHasSurprise) { out = out.replace(RE_HALLUCINATED_ADDITION_KO, "").trim(); }
    if (/\bHR\b/i.test(sourceText) && /감독/.test(out)) {
      out = out.replace(/인사\s*감독/g, "인사 담당자").replace(/감독님/g, "인사 책임자").trim();
    }
    if (/no\s+(guidance|validation|encouragement|supervision)/i.test(sourceText)) {
      out = out.replace(/감독\s*없이\s*격려/g, "격려도, 감독도 없이").replace(/감독합니다/g, "감독도 없어요").trim();
    }
    if (/you\s+don'?t\s+work\s+here/i.test(sourceText)) {
      out = out
        .replace(/여기는\s+당신이\s+일하지\s+않아요/, "당신은 여기서 일하지 않아요")
        .replace(/여기는\s+네가\s+일하지\s+않아/, "너는 여기서 일하지 않아")
        .replace(/여기는\s+([^\s]+이|[^\s]+가)\s+일\s+안\s+해/, "너 여기서 일 안 해");
    }
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

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
  out = stripLeakedPlaceholders(out);
  return out.replace(/\s{2,}/g, " ").trim();
}

export function hasLeftoverEnglish(
  translated: string, sourceText: string,
  patterns: CompiledNounPattern[], targetLanguage: string
): boolean {
  const profile = getLanguageProfile(targetLanguage);
  if (profile.isLatinScript) return false;
  const knownEn = new Set(sourceText.toLowerCase().split(/\s+/).filter(Boolean));
  const knownTr = new Set(patterns.map(p => p.src.toLowerCase()));
  const knownProtected = new Set([
    ...[...PROTECTED_PROPER_NOUNS].map(w => w.toLowerCase()),
    ...[...PROTECTED_ACRONYMS].map(w => w.toLowerCase()),
  ]);
  RE_ENGLISH_WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ENGLISH_WORD.exec(translated)) !== null) {
    const w = m[1];
    if (RE_NUMERIC_TOKEN.test(w) || knownEn.has(w.toLowerCase()) || knownTr.has(w.toLowerCase()) || knownProtected.has(w.toLowerCase())) continue;
    return true;
  }
  return false;
}

function isCorruptedOutput(text: string): boolean {
  return (
    /^##/.test(text) || /^Translation:/i.test(text) || /^\[미번역\]/.test(text) ||
    /^---/.test(text) || text.includes("\n\n") || RE_PLACEHOLDER_LEAK.test(text)
  );
}

function isOvergenerated(input: string, output: string, targetLanguage = "Korean"): boolean {
  const inLen = input.split(/\s+/).filter(Boolean).length;
  const outLen = output.split(/\s+/).filter(Boolean).length;
  const baseThreshold = targetLanguage === "Korean" ? 2.0 : 1.7;
  const strictThreshold = inLen <= 3 ? 1.3 : baseThreshold;
  return outLen > Math.max(inLen * strictThreshold, 4);
}

function detectFragment(src: string): boolean {
  const wordCount = src.split(/\s+/).filter(Boolean).length;
  return wordCount <= 4 && !/[.!?]$/.test(src.trim()) && RE_DANGLING_FRAGMENT.test(src);
}

// ── parseBatchResponse ────────────────────────────────────────────────────────
function parseBatchResponse(
  response: string,
  batch: MergedGroup[],
  patterns: CompiledNounPattern[],
  tokenMaps: MaskedToken[][],
  prevTranslations?: string[]
): string[] {
  const tmap = new Map<number, string>();
  const lines = response.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(\d+)[.)]\s*(.+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= batch.length && !tmap.has(n)) tmap.set(n, m[2].trim());
    }
  }
  if (tmap.size < batch.length) {
    for (const line of lines) {
      const m = line.match(/^(\d+)[.):\-]\s+(.+)$/) ?? line.match(/^(\d+)\s{2,}(.+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= batch.length && !tmap.has(n)) tmap.set(n, m[2].trim());
      }
    }
  }
  const restoreAndClean = (raw: string, batchIdx: number, srcText: string): string => {
    if (!raw) return "";
    const tokens = tokenMaps[batchIdx] ?? [];
    const restored = tokens.length > 0 ? restoreNumericTokens(raw, tokens) : raw;
    const deLeaked = stripLeakedPlaceholders(restored);
    const sanitized = sanitizeTranslationOutput(applyProperNounFixes(deLeaked, patterns), srcText);
    return sanitized;
  };
  if (tmap.size === batch.length) {
    return batch.map((seg, i) => restoreAndClean(tmap.get(i + 1) ?? "", i, seg.text));
  }

  const contentLines = lines
    .map(l => l.replace(/^[\d]+[.):\-\s]+/, "").trim())
    .filter(Boolean);

  if (contentLines.length >= batch.length) {
    console.warn(`[TRANSLATE] positional fallback: parsed=${tmap.size} expected=${batch.length}`);
    return batch.map((seg, i) => {
      const fromMap = tmap.get(i + 1);
      if (fromMap) return restoreAndClean(fromMap, i, seg.text);
      return restoreAndClean(contentLines[i] ?? "", i, seg.text);
    });
  }

  console.warn(`[TRANSLATE] parse failed: tmap=${tmap.size}, contentLines=${contentLines.length}, expected=${batch.length} — keeping prev or empty`);
  return batch.map((seg, i) => {
    const fromMap = tmap.get(i + 1);
    if (fromMap) return restoreAndClean(fromMap, i, seg.text);
    const prev = prevTranslations?.[i];
    if (prev && prev.trim() && !isCorruptedOutput(prev)) {
      return prev;
    }
    return "";
  });
}

function isLikelyUntranslated(translated: string, targetLanguage: string): boolean {
  const profile = getLanguageProfile(targetLanguage);
  const t = translated.trim();
  if (!t || profile.isLatinScript) return !t;
  const nonSpace = t.replace(/\s/g, "");
  const ascii = (nonSpace.match(/[a-zA-Z]/g) ?? []).length;
  return nonSpace.length > 0 && ascii / nonSpace.length > 0.9;
}

async function validateTranslations(
  segments: MergedGroup[],
  translatedTexts: string[],
  systemPrompt: string,
  targetLanguage: string,
  patterns: CompiledNounPattern[],
  isCancelled: () => boolean
): Promise<string[]> {
  if (!llamaContext || isCancelled()) return translatedTexts;

  const result = [...translatedTexts];

  type AttemptState = { batchedTried: boolean; individualTried: boolean };
  const attemptMap = new Map<number, AttemptState>();
  function getState(i: number): AttemptState {
    if (!attemptMap.has(i)) attemptMap.set(i, { batchedTried: false, individualTried: false });
    return attemptMap.get(i)!;
  }

  const passedSet = new Set<number>();

  // [FIX-VALIDATE-1] 멀티-세그먼트 그룹의 segmentCount를 정확히 전달
  function passesValidation(src: string, output: string, segmentCount = 1): boolean {
    if (!output || !output.trim()) return false;
    if (isLikelyUntranslated(output, targetLanguage)) return false;
    if (isCorruptedOutput(output)) return false;
    // 그룹이 여러 세그먼트를 포함하면 overgenerated 체크 완화
    if (segmentCount <= 1 && isOvergenerated(src, output, targetLanguage)) return false;
    if (RE_PLACEHOLDER_LEAK.test(output)) return false;
    const srcHasNeg = /\bdon't think\b|\bnot a\b|\bdoesn't work\b|\bdon't work\b|\bcan't\b|\bwon't\b|\bnot going to\b|\bnot gonna\b/i.test(src);
    if (srcHasNeg && !/않|안|못|없|아니|모르/.test(output)) return false;
    if (hasLeftoverEnglish(output, src, patterns, targetLanguage)) return false;
    const profile = getLanguageProfile(targetLanguage);
    if (profile.isLatinScript && /[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(output)) return false;
    if (/good\s+fit/i.test(src) && /몸|체형|체격|사이즈|맞는 몸/.test(output)) return false;
    return true;
  }

  function chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
    return result;
  }

  // Step 1: Initial sanitize pass
  for (let i = 0; i < segments.length; i++) {
    const src = segments[i].text.trim();
    if (isFillerText(src)) continue;
    result[i] = sanitizeTranslationOutput(result[i]?.trim() ?? '', src);
    const segCount = segments[i].originalIndices?.length ?? 1;
    if (passesValidation(src, result[i], segCount)) passedSet.add(i);
  }

  const failedIndices: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const src = segments[i].text.trim();
    if (isFillerText(src)) continue;
    if (!passedSet.has(i)) failedIndices.push(i);
  }
  if (failedIndices.length === 0) return result;

  // Step 2: Stage 1 — Batched retry
  const fragmentIndices = failedIndices.filter(i => detectFragment(segments[i].text));
  const normalIndices   = failedIndices.filter(i => !detectFragment(segments[i].text));
  const allBatches: number[][] = [...chunk(fragmentIndices, BATCH_SIZE), ...chunk(normalIndices, BATCH_SIZE)];
  for (const i of failedIndices) getState(i).batchedTried = true;

  for (const batch of allBatches) {
    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
    if (!llamaContext) {
      console.warn('[VALIDATE] llamaContext became null during Stage 1 — aborting validation');
      break;
    }

    const isFragmentBatch = batch.every(i => detectFragment(segments[i].text));
    const isolationBlock = 'CRITICAL ISOLATION RULE:\nEach numbered line is a completely separate input from a different speaker\nand a different context. Do NOT reference, infer from, or use information\nfrom any other numbered line. Treat each line as if it were the only input.\n\n';
    const fragmentNote = isFragmentBatch
      ? 'NOTE: All inputs in this batch are incomplete ASR fragments cut mid-sentence.\nFor each one, translate ONLY what is literally present.\nDo NOT reconstruct or complete the surrounding sentence.\nKeep output SHORT (typically 2-5 words).\n'
      : 'These are retry translations. Be concise and accurate.\nDo NOT add explanations or content not present in the source.\n';
    const stage1SystemPrompt = isolationBlock + systemPrompt + '\n\n' + fragmentNote;
    const batchGroups: MergedGroup[] = batch.map(i => ({
      start: segments[i].start,
      end: segments[i].end,
      text: segments[i].text,
      originalIndices: segments[i].originalIndices ?? [i],
    }));
    const { message: batchMsg, tokenMaps } = buildBatchMessage(batchGroups);
    const prevBatchTranslations = batch.map(i => result[i] ?? "");
    let parsed: string[] = [];
    try {
      if (!llamaContext || isCancelled()) break;

      const totalSegmentsInBatch = batch.reduce(
        (sum, i) => sum + (segments[i].originalIndices?.length ?? 1), 0
      );
      const r = await llamaContext.completion({
        messages: [
          { role: 'system', content: stage1SystemPrompt },
          { role: 'user', content: batchMsg },
        ],
        n_predict: applyThermalNPredict(Math.max(batch.length * 64, totalSegmentsInBatch * 48)),
        temperature: 0.05,
        top_p: 0.9,
        stop: ['</s>', '<end_of_turn>', '<|end|>'],
      });
      if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
      parsed = parseBatchResponse(r.text, batchGroups, patterns, tokenMaps, prevBatchTranslations);
    } catch (e: any) {
      if (e?.message === 'INFERENCE_CANCELLED') throw e;
      if (e?.message?.includes('Context') && e?.message?.includes('not found')) {
        console.warn('[VALIDATE] Stage 1: Context released — stopping validation');
        break;
      }
      console.warn('[VALIDATE] Stage 1 batch error:', e);
      continue;
    }

    const validCount = parsed.filter(p => p && p.trim().length > 0).length;
    const threshold = Math.ceil(batch.length * 0.5);
    if (validCount < threshold) { console.warn(`[VALIDATE] Stage 1 batch discarded`); continue; }

    for (let bi = 0; bi < batch.length; bi++) {
      const idx = batch[bi];
      const rawOutput = parsed[bi];
      if (!rawOutput || !rawOutput.trim()) continue;
      const src = segments[idx].text;
      const batchTokens = tokenMaps[bi] ?? maskNumericTokens(src).tokens;
      let processed = restoreNumericTokens(rawOutput, batchTokens);
      processed = stripLeakedPlaceholders(processed);
      processed = sanitizeTranslationOutput(applyProperNounFixes(processed, patterns), src);
      processed = postProcessTranslation(processed, src, targetLanguage);
      const segCount = segments[idx].originalIndices?.length ?? 1;
      if (!passesValidation(src, processed, segCount)) continue;
      const oldLen = result[idx]?.length ?? 0;
      const newLen = processed.length;
      if (newLen > oldLen * 1.5 && !detectFragment(src) && passesValidation(src, result[idx], segCount)) continue;
      result[idx] = processed;
      passedSet.add(idx);
    }
  }

  // Step 3: Stage 2 — Individual retry
  if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

  const stage2Targets = failedIndices.filter(i => {
    const state = getState(i);
    if (passedSet.has(i)) return false;
    if (!state.batchedTried) return false;
    if (state.individualTried) return false;
    const src = segments[i].text;
    const output = result[i];
    return (
      isCorruptedOutput(output) || isLikelyUntranslated(output, targetLanguage) ||
      hasLeftoverEnglish(output, src, patterns, targetLanguage) ||
      isOvergenerated(src, output, targetLanguage) || RE_PLACEHOLDER_LEAK.test(output) ||
      (/\bdon't think\b|\bnot a\b|\bdoesn't work\b|\bdon't work\b|\bcan't\b|\bwon't\b|\bnot going to\b|\bnot gonna\b/i.test(src) && !/않|안|못|없|아니|모르/.test(output))
    );
  });
  for (const i of stage2Targets) getState(i).individualTried = true;

  for (const index of stage2Targets) {
    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
    if (!llamaContext) {
      console.warn('[VALIDATE] Stage 2: Context released — stopping individual retry');
      break;
    }

    const src = segments[index].text;
    const wordCount = src.split(/\s+/).filter(Boolean).length;
    const isFragment = detectFragment(src);
    const currentOutput = result[index];
    const isOvergenerated_flag = isOvergenerated(src, currentOutput, targetLanguage);
    const negDropped_flag = /\bdon't think\b|\bnot a\b|\bdoesn't work\b|\bdon't work\b|\bcan't\b|\bwon't\b|\bnot going to\b|\bnot gonna\b/i.test(src) && !/않|안|못|없|아니|모르/.test(currentOutput);
    const leftoverEn_flag = hasLeftoverEnglish(currentOutput, src, patterns, targetLanguage);
    const untranslated_flag = isLikelyUntranslated(currentOutput, targetLanguage);
    const corrupted_flag = isCorruptedOutput(currentOutput);
    const goodFitBad_flag = /good\s+fit/i.test(src) && /몸|체형|체격|사이즈/.test(currentOutput);

    let userPrompt = `Translate to ${targetLanguage}. Output ONLY the translation, nothing else.`;
    if (negDropped_flag) userPrompt += '\nCRITICAL: Preserve NEGATIVE meaning.';
    if (leftoverEn_flag) userPrompt += `\nCRITICAL: Output must contain NO untranslated English words.`;
    if (isOvergenerated_flag && isFragment) userPrompt += `\nCRITICAL: Input is a short fragment. Translate ONLY what is present. Target: ${wordCount} to ${Math.min(wordCount + 2, 6)} words.`;
    else if (isOvergenerated_flag) userPrompt += '\nCRITICAL: Keep translation concise.';
    if (untranslated_flag) userPrompt += `\nCRITICAL: Output must be entirely in ${targetLanguage}.`;
    if (goodFitBad_flag) userPrompt += "\nCRITICAL: 'good fit' means suitability for a role, NOT physical body shape.";
    if (corrupted_flag) userPrompt += '\nCRITICAL: Return ONLY a clean translation with no formatting.';

    const { masked: maskedSrc, tokens } = maskNumericTokens(src);
    try {
      if (!llamaContext || isCancelled()) break;
      const r = await llamaContext.completion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${userPrompt}\n\n${maskedSrc}` },
        ],
        n_predict: applyThermalNPredict(isFragment ? 40 : 80),
        temperature: 0.1,
        top_p: 0.9,
        stop: ['</s>', '<end_of_turn>', '<|end|>', '\n'],
      });
      if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
      const restored = restoreNumericTokens(r.text.trim(), tokens);
      const processed = postProcessTranslation(sanitizeTranslationOutput(applyProperNounFixes(stripLeakedPlaceholders(restored), patterns), src), src, targetLanguage);
      if (passesValidation(src, processed)) {
        result[index] = processed; passedSet.add(index);
      } else {
        if (!isCorruptedOutput(currentOutput) && !isLikelyUntranslated(currentOutput, targetLanguage)) {
          result[index] = currentOutput;
        } else { result[index] = src; }
      }
    } catch (e: any) {
      if (e?.message === 'INFERENCE_CANCELLED') throw e;
      if (e?.message?.includes('Context') && e?.message?.includes('not found')) {
        console.warn('[VALIDATE] Stage 2: Context released — stopping');
        break;
      }
      if (!isCorruptedOutput(currentOutput) && !isLikelyUntranslated(currentOutput, targetLanguage)) {
        result[index] = currentOutput;
      } else { result[index] = src; }
      console.warn(`[VALIDATE] Stage 2 error at ${index}:`, e);
    }
  }

  // Step 4: Final fallback
  for (const i of failedIndices) {
    if (!passedSet.has(i)) {
      const current = result[i];
      if (isCorruptedOutput(current) || isLikelyUntranslated(current, targetLanguage)) {
        result[i] = segments[i].text;
      }
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
  } catch { return null; }
}

async function saveCheckpoint(videoHash: string, cp: Omit<Checkpoint, "timestamp">): Promise<void> {
  try {
    await AsyncStorage.setItem(checkpointKey(videoHash), JSON.stringify({ ...cp, timestamp: Date.now() }));
  } catch (e) { console.warn("[Gemma] Checkpoint save failed:", e); }
}

async function deleteCheckpoint(videoHash: string): Promise<void> {
  await AsyncStorage.removeItem(checkpointKey(videoHash));
}

function mergeWithTranslations(segments: TranslationSegment[], translatedTexts: string[]): TranslationSegment[] {
  return segments.map((seg, i) => ({ ...seg, translated: translatedTexts[i] || seg.text }));
}

function buildSystemPrompt(targetLanguage: string, langRules: string, genrePersona: string, nounHint: string, batchSize: number): string {
  const protectedNounList = [...[...PROTECTED_PROPER_NOUNS], ...[...PROTECTED_ACRONYMS]].join(", ");
  const timeRuleKo = (targetLanguage === "Korean" || targetLanguage === "ko")
    ? `- Time format: NEVER output "HH:MM" clock notation. Use Korean spoken form: "8시", "3시", "10시 30분".\n` +
      `- "X in the morning" where X is 1–6: ALWAYS use "새벽 X시".\n` +
      `- "until like X:00" as arrival time: just "X시", no 새벽/아침 prefix.\n`
    : "";
  return (
    `You are a professional subtitle translator. Translate English subtitles to ${targetLanguage}.\n\n` +
    `[GLOBAL RULES]\n- Do not hallucinate or add information not present in the source\n- Preserve original meaning and speaker intent exactly\n- Keep subtitles concise — under 15 words per line if possible\n- Never merge, split, skip, or reorder the numbered lines\n\n` +
    (genrePersona ? genrePersona + "\n\n" : "") +
    `STRICT OUTPUT FORMAT:\n- Input has exactly ${batchSize} numbered lines\n- Output MUST have exactly ${batchSize} numbered lines: "1. translation", "2. translation", ...\n- ONE output line per input line. Never merge. Never split. Never skip.\n- NEVER output headers like "## Translation:", "[미번역]", "---".\n\n` +
    `TRANSLATION RULES:\n- Translate exact meaning only.\n- Preserve negation: "don't/can't/never/not" → must reflect negation in translation.\n- Fragment lines → translate as fragment, do NOT complete the sentence.\n- "baby" as informal address → use name or omit. NEVER translate as 자기야.\n- "HR" always means Human Resources. "HR director" → 인사 담당자.\n- Tokens like __NUM0__ are placeholders. Copy them EXACTLY as-is.\n- These proper nouns must NOT be translated: ${protectedNounList}\n- "good fit" in work context → compatibility match, NOT physical fitness\n- "that kind of thing" → always "그런 거". NEVER "그런 종류의 것".\n` +
    timeRuleKo +
    `\n` + langRules + nounHint
  ).trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Main: translateSegments ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
export async function translateSegments(
  segments: TranslationSegment[],
  onProgress?: (completed: number, total: number, partial: TranslationSegment[]) => void | Promise<void>,
  videoHash = "default",
  targetLanguage = "Korean",
  videoGenre = "general"
): Promise<TranslationSegment[]> {
  console.log("[TRANSLATE]", segments.length, "segs |", targetLanguage, "|", videoGenre);

  let emaBatchDurationMs = 0;

  const updateEmaAndGetBgSleepMs = (batchDurationMs: number, batchIndex: number): number => {
    if (emaBatchDurationMs === 0) { emaBatchDurationMs = batchDurationMs; return 300; }
    else if (batchIndex !== 0 && batchIndex % 20 === 0) {
      emaBatchDurationMs = EMA_REANCHOR_WEIGHT * batchDurationMs + (1 - EMA_REANCHOR_WEIGHT) * emaBatchDurationMs;
    } else {
      emaBatchDurationMs = EMA_ALPHA_BG * batchDurationMs + (1 - EMA_ALPHA_BG) * emaBatchDurationMs;
    }
    if (emaBatchDurationMs < 800)  return 600;
    if (emaBatchDurationMs < 1500) return 400;
    return 300;
  };

  const yieldToEventLoop = (): Promise<void> => new Promise<void>(r => setImmediate(r));

  return enqueueInference(async (isCancelled) => {
    if (!llamaContext) throw new Error("모델이 로드되지 않았습니다. loadModel()을 먼저 호출하세요.");

    // ── Step 0 ───────────────────────────────────────────────────────────────
    const deduped = deduplicateOverlappingSegments(segments);
    const cleaned = deduped.map(seg => ({
      ...seg,
      text: normalizeSocialMediaNames(cleanWhisperText(seg.text)),
    }));

    // [FIX-STEP0] 빈 텍스트 세그먼트 필터링 후 인덱스 맵 구성
    // 빈 세그먼트는 번역 건너뛰고 원문 유지
    const nonEmptyIndices: number[] = [];
    const nonEmptySegments: TranslationSegment[] = [];
    for (let i = 0; i < cleaned.length; i++) {
      if (!isFillerText(cleaned[i].text)) {
        nonEmptyIndices.push(i);
        nonEmptySegments.push(cleaned[i]);
      }
    }

    console.log(`[TRANSLATE] Non-empty segments: ${nonEmptySegments.length}/${cleaned.length}`);

    // ── Step A: 고유명사 + 프롬프트 구성 ─────────────────────────────────────
    const profile = getLanguageProfile(targetLanguage);
    const properNouns = await buildProperNounDict(deduped, videoHash, targetLanguage, isCancelled);
    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
    const nounHint = formatNounHint(properNouns);
    const patterns = buildPatterns(properNouns);
    const genrePersona = GENRE_PERSONA[videoGenre] || GENRE_PERSONA["general"] || "";
    const langRules = profile.systemPromptRules.join(" ");

    // ── Step B: SBD ───────────────────────────────────────────────────────────
    let merged: MergedGroup[];
    let usedSBD = false;

    if (!llamaContext || isCancelled()) throw new Error('INFERENCE_CANCELLED');

    // SBD disabled — using mergeFragments for all cases (faster, no quality loss)
    // To re-enable: replace the line below with the original detectSentenceBoundaries call
    const sbdSentences: SBDSentence[] = [];

    if (sbdSentences.length > 0) {
      // [FIX-SBD-6] SBD 결과의 originalIndices를 실제 cleaned 배열 인덱스로 재매핑
      const remappedSentences = sbdSentences.map(sent => ({
        ...sent,
        segmentIndices: sent.segmentIndices.map(localIdx => nonEmptyIndices[localIdx]),
      }));
      merged = sbdSentencesToMergedGroups(remappedSentences);
      usedSBD = true;
      console.log(`[TRANSLATE] SBD success: ${nonEmptySegments.length} segs → ${merged.length} sentences`);
    } else {
      console.log(`[TRANSLATE] SBD fallback: using mergeFragments`);
      let fallbackMerged = mergeFragments(nonEmptySegments);
      fallbackMerged = enforceSentence(fallbackMerged);
      // [FIX-SBD-7] fallback merged groups도 nonEmptyIndices로 재매핑
      merged = fallbackMerged.map(g => ({
        ...g,
        originalIndices: g.originalIndices.map(localIdx => nonEmptyIndices[localIdx]),
      }));
    }

    // [FIX-COVERAGE] 필터링된 빈 세그먼트들을 각각 단독 그룹으로 추가
    const coveredIndices = new Set(merged.flatMap(g => g.originalIndices));
    for (let i = 0; i < cleaned.length; i++) {
      if (!coveredIndices.has(i)) {
        merged.push({
          start: cleaned[i].start,
          end: cleaned[i].end,
          text: cleaned[i].text,
          originalIndices: [i],
        });
      }
    }
    // 시작 시간 순으로 정렬
    merged.sort((a, b) => a.start - b.start);

    const total = merged.length;
    const totalBatches = Math.ceil(total / BATCH_SIZE);
    console.log(`[TRANSLATE] ${usedSBD ? "SBD" : "fallback"} → ${total} groups (${totalBatches} batches)`);

    // [FIX-PROGRESS] 그룹별 누적 세그먼트 수 계산
    const segmentCountUpToGroup: number[] = new Array(merged.length).fill(0);
    let cumulativeSegs = 0;
    for (let i = 0; i < merged.length; i++) {
      cumulativeSegs += merged[i].originalIndices.length;
      segmentCountUpToGroup[i] = cumulativeSegs;
    }

    // ── Step C: 체크포인트 복원 ───────────────────────────────────────────────
    const checkpoint = await loadCheckpoint(videoHash);
    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
    let startBatch = 0;
    const mergedTranslations: string[] = new Array(total).fill("");
    if (checkpoint && checkpoint.translatedTexts.length === total) {
      startBatch = checkpoint.lastBatchIndex + 1;
      for (let i = 0; i < checkpoint.translatedTexts.length; i++) {
        mergedTranslations[i] = checkpoint.translatedTexts[i];
      }
      console.log(`[Gemma] Resuming from batch ${startBatch}/${totalBatches}`);
    }
    if (startBatch === 0) {
      emaBatchDurationMs = 0; _thermalLevel = 0;
      _thermalConsecutiveHigh = 0; _thermalConsecutiveLow = 0;
    }

    // ── Step D: 배치 번역 ─────────────────────────────────────────────────────
    try {
      let lastSaveTime = 0;
      for (let bi = startBatch; bi < totalBatches; bi++) {
        const batchStartTime = Date.now();
        if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
        if (!llamaContext) throw new Error('INFERENCE_CANCELLED');

        const offset = bi * BATCH_SIZE;
        const batch = merged.slice(offset, offset + BATCH_SIZE);
        console.log(`[TRANSLATE] batch ${bi + 1}/${totalBatches} (${batch.length})`);
        if (batch.length === 0) continue;

        const sysPrompt = buildSystemPrompt(targetLanguage, langRules, genrePersona, nounHint, batch.length);
        const { message: batchMessage, tokenMaps } = buildBatchMessage(batch);
        const prevBatchTranslations = batch.map((_, i) => mergedTranslations[offset + i] ?? "");

        if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
        await yieldToEventLoop();

        if (!llamaContext || isCancelled()) throw new Error('INFERENCE_CANCELLED');

        // [FIX-NPREDICT] n_predict를 배치 내 총 원본 세그먼트 수 기준으로 산출
        const totalOriginalSegsInBatch = batch.reduce(
          (sum, g) => sum + g.originalIndices.length, 0
        );
        const nPredict = applyThermalNPredict(
          Math.max(batch.length * 80, totalOriginalSegsInBatch * 60)
        );

        const r = await llamaContext.completion({
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: batchMessage },
          ],
          n_predict: nPredict,
          temperature: 0.1,
          top_p: 0.9,
          stop: ["</s>", "<end_of_turn>", "<|end|>"],
        } as any);

        if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
        if (_isAppBackgrounded) await yieldToEventLoop();
        if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

        const translations = parseBatchResponse(r.text, batch, patterns, tokenMaps, prevBatchTranslations);

        if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
        await yieldToEventLoop();

        for (let i = 0; i < batch.length; i++) {
          mergedTranslations[offset + i] = translations[i];
        }

        const partial = expandGroupTranslations(merged, mergedTranslations, cleaned);
        if (onProgress) {
          const lastGroupInBatch = Math.min(offset + batch.length - 1, merged.length - 1);
          const segmentsCompletedSoFar = segmentCountUpToGroup[lastGroupInBatch];
          await onProgress(segmentsCompletedSoFar, cleaned.length, mergeWithTranslations(cleaned, partial));
        }

        const now = Date.now();
        if (now - lastSaveTime >= SAVE_INTERVAL_MS) {
          lastSaveTime = now;
          await saveCheckpoint(videoHash, { translatedTexts: mergedTranslations, lastBatchIndex: bi, properNouns, totalBatches });
        }
        if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

        if (bi < totalBatches - 1) {
          const batchDuration = Date.now() - batchStartTime;
          checkThermalPressure(batchDuration, emaBatchDurationMs);
          const thermalSleep = getThermalSleepMs();
          const bgEmaSleep   = _isAppBackgrounded ? updateEmaAndGetBgSleepMs(batchDuration, bi) : 0;
          const fgAdaptiveSleep = !_isAppBackgrounded ? (bi === startBatch ? 200 : Math.min(400, Math.max(200, Math.round(batchDuration * 0.18)))) : 0;
          const sleepMs = Math.max(thermalSleep, bgEmaSleep, fgAdaptiveSleep);
          if (sleepMs > 0) await sleep(sleepMs);
          if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
        }
      }
      await saveCheckpoint(videoHash, { translatedTexts: mergedTranslations, lastBatchIndex: totalBatches - 1, properNouns, totalBatches });
    } catch (e: any) {
      if (e?.message === 'INFERENCE_CANCELLED') throw e;
      if (e?.message === 'APP_BACKGROUNDED') throw e;
      if (e?.message?.includes('Context') && e?.message?.includes('not found')) {
        console.warn('[TRANSLATE] Context released mid-batch — returning partial results');
        return mergeWithTranslations(cleaned, expandGroupTranslations(merged, mergedTranslations, cleaned));
      }
      console.error("[Gemma] Inference error:", e);
      return mergeWithTranslations(cleaned, expandGroupTranslations(merged, mergedTranslations, cleaned));
    }

    await deleteCheckpoint(videoHash);

    // ── Step E: postProcess (그룹 단위 번역에 직접 적용) ─────────────────────
    for (let i = 0; i < merged.length; i++) {
      const groupSrc = merged[i].text;
      if (!RE_HALLUCINATION_GUARD.test(groupSrc) && mergedTranslations[i]) {
        mergedTranslations[i] = mergedTranslations[i].replace(RE_HALLUCINATED_TERMS_KO, "").trim();
      }
      if (mergedTranslations[i]) {
        mergedTranslations[i] = postProcessTranslation(mergedTranslations[i], groupSrc, targetLanguage);
      }
    }

    // ── Step G: 검증 ──────────────────────────────────────────────────────────
    if (!llamaContext || isCancelled()) {
      console.warn('[TRANSLATE] Step G: Context null or cancelled — skipping validation');
      const formatted = expandGroupTranslations(merged, mergedTranslations, cleaned)
        .map(t => formatNetflixSubtitle(t));
      return adjustTimingsForReadability(mergeWithTranslations(cleaned, formatted));
    }

    const finalPrompt = buildSystemPrompt(targetLanguage, langRules, genrePersona, nounHint, BATCH_SIZE);
    const mergedForValidation: MergedGroup[] = merged.map((g) => ({ ...g }));
    const groupTranslationsForValidation = mergedTranslations.slice();

    const validatedGroupTexts = await validateTranslations(
      mergedForValidation, groupTranslationsForValidation,
      finalPrompt, targetLanguage, patterns, isCancelled
    );
    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

    // ── Step H: expand (단 1회 실행) + postProcess ────────────────────────────
    const revalidatedTexts = expandGroupTranslations(merged, validatedGroupTexts, cleaned);
    for (let i = 0; i < cleaned.length; i++) {
      if (revalidatedTexts[i]) {
        revalidatedTexts[i] = postProcessTranslation(revalidatedTexts[i], cleaned[i].text, targetLanguage);
      }
    }

    // ── Step I: Netflix 포맷팅 ────────────────────────────────────────────────
    const formatted = revalidatedTexts.map(t => formatNetflixSubtitle(t));

    // ── Step J: 타이밍 조정 + 최종 조립 ──────────────────────────────────────
    const completed = adjustTimingsForReadability(mergeWithTranslations(cleaned, formatted));
    console.log(`[Gemma] Done: ${completed.length} segments.`);
    return completed;
  });
}