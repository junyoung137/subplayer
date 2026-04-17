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

// 기본 병합 gap 상한 (SBD fallback 용)
const MERGE_GAP_HARD_LIMIT_S = 0.6;

// 발화자 전환이 강하게 의심될 때 적용하는 더 엄격한 gap 상한
const MERGE_GAP_SPEAKER_CHANGE_S = 0.35;
// ── 그룹 크기 제한 (추가) ─────────────────────────────────────────────────────

const MAX_WORDS_PER_GROUP = 35;

// ── SBD 관련 상수 ─────────────────────────────────────────────────────────────
const SBD_BATCH_SIZE = 30;
const SBD_FALLBACK_RATIO = 0.9;

const RE_DANGLING_FRAGMENT = /\b(with|for|and|but|or|to|in|at|on|of|by|a|an|the|is|are|was|were|be|been|being|have|has|had|will|would|could|should|may|might|must|do|does|did|not|no|i|you|we|they|he|she|it)\s*$/i;

// ── 소셜미디어 앱명 정규화 ────────────────────────────────────────────────────
const SOCIAL_MEDIA_NORMALIZATION: Record<string, string> = {
  "vine": "Vine", "snapchat": "Snapchat", "pinterest": "Pinterest",
  "instagram": "Instagram", "twitter": "Twitter", "facebook": "Facebook",
  "tiktok": "TikTok", "youtube": "YouTube", "linkedin": "LinkedIn",
  "reddit": "Reddit", "discord": "Discord", "twitch": "Twitch",
};

// ── 환각 / 오염 패턴 ──────────────────────────────────────────────────────────
const RE_HALLUCINATED_TERMS_KO = /자기야[,，\s]*|자기[,，\s]+|여보[,，\s]*|오빠[,，\s]*|언니[,，\s]*/g;
const RE_HALLUCINATION_GUARD = /\b(honey|sweetie|darling|dear|oppa|unnie)\b/i;
const RE_OUTPUT_CORRUPTION = /^##\s*Translation\s*:?\s*/i;
const RE_UNTRANSLATED_MARKER = /^\[미번역\]\s*/;
const RE_STAGE_DIRECTION_KO = /\(혼잣말\)|\(독백\)|\(방백\)|\(내레이션\)/g;
const RE_PARENS_ANY = /\([^)]*\)/g;
const RE_ENGLISH_WORD = /\b([a-zA-Z]{3,})\b/g;
const RE_NUMERIC_TOKEN = /^\d+([:.]\d+)*[%]?$|^\d+(st|nd|rd|th)$/i;

// ── 접두사 / 지시사 오염 패턴 ────────────────────────────────────────────────
const RE_NUMBERED_PREFIX = /^\d+\.\s+/;
const RE_AWKWARD_DEMONSTRATIVE = /^저것은\s/;
const RE_AWKWARD_DEMONSTRATIVE_I = /^저것이\s/;

// ── 발화자 전환 신호 패턴 ────────────────────────────────────────────────────
const RE_LIKELY_QUESTION_END = /\?$|\bright\b|\bunderstood\b|\bunderstand\b|\bgot it\b/i;
const RE_LIKELY_RESPONSE_START = /^(yes|no|yeah|nope|yep|nah|i do|i don'?t|not really|of course|okay|ok|sure|right|hmm|uh|oh|well|i|we|that|it'?s|what|why|how)\b/i;

// ── 환각 추가 내용 감지 패턴 ─────────────────────────────────────────────────
const RE_HALLUCINATED_ADDITION_KO = /놀랍네요|놀랍습니다|놀랍군요|이상하네요|이상합니다/g;

// ── 시간대 후처리 패턴 ───────────────────────────────────────────────────────
const RE_MORNING_TIME_KO = /아침\s*(\d{1,2})시/g;

// ── [FIX-TIME] 시간 표기 변환 패턴 ─────────────────────────────────────────
const RE_TIME_HHMM = /\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(AM|PM|am|pm))?\b/g;

// ── [FIX-TIME-DEDUP] "8시 시" 중복 감지 패턴 ────────────────────────────────
const RE_TIME_UNIT_DEDUP = /(\d{1,2})시\s*시/g;
const RE_MINUTE_UNIT_DEDUP = /(\d{1,2})분\s*분/g;

// ── [FIX-2] "until (like) X(:00)? in the morning" — 새벽 판정 ───────────────
const RE_UNTIL_IN_MORNING = /until\s+(?:like\s+)?(\d{1,2})(?::\d{2})?\s+in\s+the\s+morning/i;

// ── [FIX-2B] 도착/행동 시간: "until (like) X(:00)?" 패턴 ────────────────────
const RE_UNTIL_TIME_ONLY = /until\s+(?:like\s+)?(\d{1,2})(?::\d{2})?\b(?!\s+in\s+the\s+morning)/i;

// ── [FIX-3] Placeholder 잔존 감지 ────────────────────────────────────────────
const RE_PLACEHOLDER_LEAK = /__NUM\d+__/g;

// ── [FIX-THAT-KIND-OF] 패턴 ─────────────────────────────────────────────────
const RE_THAT_KIND_OF_THING = /that\s+kind\s+of\s+thing/i;
const RE_THAT_KIND_OF_NOUN = /that\s+kind\s+of\s+([a-z]+(?:\s+[a-z]+)?)/i;
const RE_THAT_KIND_OF_VERB_ADJ = /that\s+kind\s+of\s+(is|was|are|were|feels|feel|seems|seem|looks|look|sounds|sound|works|work|makes|make|does|do|did|doesn't|don't|won't|can't|isn't|wasn't)/i;
const RE_KIND_OF_ALONE = /(?<!that\s)kind\s+of\b/i;
const RE_NEGATIVE_VERB = /\b(doesn't|don't|won't|can't|isn't|wasn't|didn't|never|no|not)\b/i;

// ── 장르 페르소나 ─────────────────────────────────────────────────────────────
const GENRE_PERSONA: Record<string, string> = {
  "tech lecture": "You specialize in technology and programming subtitles.",
  "comedy": "You specialize in comedy subtitles. Preserve humor, sarcasm, irony, and casual tone. Translate emotional intent and comedic meaning, not just literal words.",
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
  "Save",
]);

// ── 보호 고유명사 (번역 금지) ─────────────────────────────────────────────────
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
// Dedup concurrent loadModel() calls: both callers await the same promise
let _loadModelPromise: Promise<void> | null = null;

// ── Inference serialization ─────────────────────────────────────────────────
// Serialises all translateSegments calls so llama.rn (single-context) is
// never driven concurrently by FG and BG.  Uses two separate counters to
// avoid the classic race: cancel-FG must NOT cancel the already-queued BG job.
let _inferenceQueue: Promise<void> = Promise.resolve();
let _enqueueId    = 0;  // incremented per enqueue call; never reset
let _activeJobId  = 0;  // set to myEnqueueId when a job starts executing
let _isInferenceRunning = false;

// BG job protection flag — module-level singleton that survives screen unmount.
// When true, cancelFgInference() is a no-op so screen unmount cannot interrupt
// a BG translateSegments call that is already executing in the queue.
let _bgJobProtected = false;

/**
 * Set to true immediately before BG calls translateSegments; false in the
 * finally block after it returns (or throws).  While protected,
 * cancelFgInference() is a no-op so screen-unmount cleanup cannot cancel BG.
 */
export function setBgJobProtection(val: boolean): void {
  _bgJobProtected = val;
}

/** Returns true while translateSegments is executing inside the queue. */
export function isTranslating(): boolean {
  return _isInferenceRunning;
}

/**
 * Returns true while any inference job is actively running.
 * Use this to gate BG work: the enqueueInference queue serialises execution,
 * but callers can also poll this to make the waiting intent explicit.
 */
export function isModelBusy(): boolean {
  return _isInferenceRunning;
}

/**
 * Cancels only the CURRENTLY EXECUTING job.
 * Queued-but-not-yet-started jobs are NOT affected.
 *
 * ⚠️  Do NOT call this before enqueuing a BG job — use cancelFgInference()
 *     instead.  This function only bumps _activeJobId; if _activeJobId was
 *     already ahead of _enqueueId the next BG enqueue will see
 *     myEnqueueId < _activeJobId and be instantly cancelled.
 */
export function cancelCurrentInference(): void {
  _activeJobId++;
}

/**
 * Cancels the currently-executing FG job AND re-aligns the counters so
 * that the NEXT enqueued job (the BG job) is guaranteed NOT to be treated
 * as stale by the `myEnqueueId < _activeJobId` guard.
 *
 * Why this is necessary instead of cancelCurrentInference():
 *   cancelCurrentInference() increments _activeJobId.  If _activeJobId was
 *   already > _enqueueId (e.g. due to a prior cancel or double-tap race),
 *   the gap widens further and the next BG job's myEnqueueId will be strictly
 *   less than _activeJobId → instant INFERENCE_CANCELLED for BG.
 *
 *   By setting _enqueueId = _activeJobId - 1 after the bump we guarantee:
 *     next enqueue:  myEnqueueId = _enqueueId + 1 = _activeJobId
 *     stale check:   myEnqueueId < _activeJobId  →  false  ✓
 */
export function cancelFgInference(): void {
  if (_bgJobProtected) {
    console.log('[INFERENCE] cancelFgInference() suppressed — BG job is protected');
    return;
  }
  _activeJobId++;
  // Re-align so the very next enqueueInference call gets myEnqueueId === _activeJobId.
  _enqueueId = _activeJobId - 1;
}

/**
 * Returns current queue counter state for debugging.
 * Log this at the start of backgroundTranslationTask to determine whether
 * the HeadlessJS task shares this module instance with the foreground
 * (counters > 0 → shared context; counters = 0 → fresh context).
 */
export function debugInferenceCounters(): { enqueueId: number; activeJobId: number } {
  return { enqueueId: _enqueueId, activeJobId: _activeJobId };
}

function enqueueInference<T>(fn: (isCancelled: () => boolean) => Promise<T>): Promise<T> {
  const myEnqueueId = ++_enqueueId;

  const task = _inferenceQueue.then(async () => {
    // A prior cancel bumped _activeJobId above this job's ID → stale, skip.
    // Using strict `<` (not `<=`) so that a queued job whose ID happens to
    // equal the post-cancel _activeJobId is NOT incorrectly cancelled.
    if (myEnqueueId < _activeJobId) {
      throw new Error('INFERENCE_CANCELLED');
    }
    _activeJobId = myEnqueueId;

    // isCancelled: true if cancelCurrentInference() was called after this job started.
    const isCancelled = () => myEnqueueId !== _activeJobId;

    _isInferenceRunning = true;
    try {
      return await fn(isCancelled);
    } finally {
      _isInferenceRunning = false;
    }
  });

  // Drain errors so the queue chain never breaks on cancellation or failure.
  _inferenceQueue = task.then(() => {}, () => {});
  return task;
}

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

// ── 발화자 전환 가능성 판단 ───────────────────────────────────────────────────
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

// ── Model lifecycle ───────────────────────────────────────────────────────────
export async function loadModel(onProgress?: (fraction: number) => void): Promise<void> {
  if (llamaContext) return;
  // If another caller already started loading, share the same promise
  if (_loadModelPromise) return _loadModelPromise;
  _loadModelPromise = (async () => {
    if (llamaContext) return; // recheck after await queue clears
    const info = await FileSystem.getInfoAsync(MODEL_PATH);
    if (!info.exists) throw new Error("Gemma 모델 파일을 찾을 수 없습니다. 먼저 다운로드해 주세요.");
    const modelPath = MODEL_PATH.startsWith("file://") ? MODEL_PATH.slice(7) : MODEL_PATH;
    try {
      llamaContext = await initLlama(
        // use_mlock: false — do NOT pin model pages in RAM.
        // use_mlock: true caused Android OOM kills during model load: the OS could
        // not page out the ~1.5 GB allocation and the OOM killer terminated the process.
        { model: modelPath, n_threads: 4, n_gpu_layers: 0, n_ctx: 4096, use_mlock: false },
        onProgress ? (p: number) => onProgress(p / 100) : undefined
      );
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

let _unloadGeneration = 0; // incremented before each release; checked after to prevent stale null-set

export async function unloadModel(): Promise<void> {
  if (!llamaContext) return;
  const myGeneration  = ++_unloadGeneration;
  const ctxToRelease  = llamaContext;
  llamaContext = null; // null BEFORE release so loadModel() can start a fresh init immediately
  try {
    await ctxToRelease.release();
  } catch (e) {
    console.warn("[Gemma] release error:", e);
  }
  // If a new loadModel() ran during our release, do NOT re-null the new context
  if (_unloadGeneration !== myGeneration) {
    console.log('[Gemma] unloadModel: skipping final null-set — new context was loaded during release');
  }
  // (llamaContext was already set to null before release — no further assignment needed)
}

/**
 * Called by backgroundTranslationTask when isHeadlessContext=true, BEFORE loadModel().
 * Ensures any FG unloadModel() race is resolved cleanly:
 *   1. Waits for any in-progress _loadModelPromise to settle
 *   2. Releases and nulls llamaContext so loadModel() always does a fresh init
 *   3. Resets inference counters to prevent INFERENCE_CANCELLED on first enqueue
 */
export async function resetForHeadlessRestart(): Promise<void> {
  // 1. Wait for any pending load to settle first
  if (_loadModelPromise) {
    try { await _loadModelPromise; } catch {}
    _loadModelPromise = null;
  }
  // 2. Release existing context if still held (handles the race where FG unloadModel
  //    was in progress but not yet null-assigned)
  if (llamaContext) {
    try { await llamaContext.release(); } catch {}
    llamaContext = null;
  }
  // 3. Re-align counters: set _enqueueId = _activeJobId so next enqueueInference
  //    call gets myEnqueueId === _activeJobId + 1 (immediately wins the active slot)
  _enqueueId = _activeJobId;
  _isInferenceRunning = false;
  _bgJobProtected = false;
  console.log('[GEMMA] resetForHeadlessRestart() complete — llamaContext=null, counters realigned');
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
// ── SBD: Sentence Boundary Detection ─────────────────────────────────────────
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
- Short responses (Yes, No, I do, Hmm, Oh wow) are ALWAYS their own sentence
- "who gets up at X" continues the PREVIOUS clause if the previous fragment ends with "for me" or similar
- When in doubt, keep fragments together

EXAMPLE:
Input:
1. for this meeting with
2. you you've given me no
3. encouragement no supervision is there
4. an HR director somewhere
5. I need to speak
6. to someone

Output: [1, 4, 5]
(fragments 1+2+3 form one sentence, 4 is new, 5+6 form one sentence)`;

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

async function runSBDBatch(segments: TranslationSegment[]): Promise<number[]> {
  if (!llamaContext) return [1];

  const inputLines = segments
    .map((seg, i) => `${i + 1}. ${seg.text}`)
    .join("\n");

  try {
    const result = await llamaContext.completion({
      messages: [
        { role: "system", content: SBD_SYSTEM_PROMPT },
        { role: "user", content: inputLines },
      ],
      n_predict: segments.length * 8,
      temperature: 0.05,
      top_p: 0.9,
      stop: ["</s>", "<end_of_turn>", "<|end|>"],
    });

    const parsed = parseSBDResponse(result.text, segments.length);
    if (!parsed || parsed.length === 0) {
      console.warn("[SBD] parse failed, treating all as one sentence");
      return [1];
    }

    console.log(`[SBD] batch(${segments.length}) → boundaries: [${parsed.join(",")}]`);
    return parsed;
  } catch (e) {
    console.warn("[SBD] LLM error:", e);
    return [1];
  }
}

async function detectSentenceBoundaries(
  segments: TranslationSegment[]
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
    const batchEnd = Math.min(globalOffset + SBD_BATCH_SIZE, segments.length);
    const batch = segments.slice(globalOffset, batchEnd);

    const localBoundaries = await runSBDBatch(batch);
    const globalBoundaries = localBoundaries.map((b) => b);

    const batchSentences = groupSegmentsByBoundaries(batch, globalBoundaries);

    if (
      allSentences.length > 0 &&
      batchSentences.length > 0
    ) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// ── [LEGACY] Fragment merging (SBD fallback) ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── [수정] isShortIndependent: "I do / I don't / I did / I will" 등 단답 응답 보호 강화
// 기존 함수에서 누락됐던 케이스들을 명확히 포함
function isShortIndependent(t: string): boolean {
  const trimmed = t.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wc = words.length;

  if (wc === 0 || wc > 3) return false;

  const word = words[0];

  // 물음표로 끝나는 단일 단어
  if (wc === 1 && word.endsWith("?")) return true;

  // 전형적인 단답 응답
  if (/^(no|yes|yeah|nope|yep|nah|not\s+really|okay\s+yes|alright|sure|right)$/i.test(trimmed)) return true;

  // 감탄사/추임새
  if (wc === 1 && /^(hmm|hm|uh|um|oh|wow|okay|ok|hey|right|sure|fine|well|whoa|ow|ugh|yikes|oops)$/i.test(word)) return true;

  // ── [수정 핵심] "I do / I don't / I did / I will / I won't / I am / I was / I can / I can't"
  // 2단어 이하의 1인칭 단답 응답은 항상 독립 세그먼트
  // "I do i" (다음 세그먼트에서 소문자 i가 붙어있는 경우도 포함하기 위해 wc <= 3까지 허용)
  if (/^i\s+(do|did|don'?t|will|won'?t|am|was|can|can'?t)(\s+\w+)?$/i.test(trimmed) && wc <= 3) return true;

  // 단일 고유명사 (대문자 시작 3~12자)
  if (wc === 1 && /^[A-Z][a-zA-Z]{1,11}$/.test(word)) return true;

  // 2~3단어 1인칭/2인칭 단답
  if (wc <= 3 && /^(i|you|we|they)\s+(do|did|will|won't|can|can't|get|got|know|see|am|was)(\s+\w+)?$/i.test(trimmed)) return true;

  // 문장 종결부호로 끝나는 2~3단어
  if (wc >= 2 && wc <= 3 && /[.!]$/.test(trimmed)) return true;

  // "that's X" 형태
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
      i++;
      continue;
    }

    // ── [수정] isShortIndependent 체크를 루프 진입 시 먼저 수행
    // 기존: while 루프 내부에서 next 세그먼트를 isShortIndependent로만 체크
    // 수정: 현재 세그먼트(seg) 자체가 isShortIndependent이면 즉시 독립 그룹으로 출력
    // → "I do i" 처럼 앞 문장의 "who gets up at 8:00" 뒤에 흡수되는 문제 방지
    if (isShortIndependent(seg.text)) {
      groups.push({ start: seg.start, end: seg.end, text: seg.text, originalIndices: [i] });
      i++;
      continue;
    }

    let group: MergedGroup = {
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      originalIndices: [i],
    };
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
        j++;
        continue;
      }
      if (wc < 6 && gap < 0.4 && !speakerChange) {
        group.text += " " + next.text.trim();
        group.end = next.end;
        group.originalIndices.push(j);
        j++;
        continue;
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
      result.push(buffer);
      buffer = { ...g };
      continue;
    }

    const gap = g.start - buffer.end;

    const speakerChange = likelySpeakerChange(buffer.text, g.text, gap);
    if (speakerChange || gap >= MERGE_GAP_HARD_LIMIT_S) {
      result.push(buffer);
      buffer = { ...g };
      continue;
    }

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

// ── expandGroupTranslations ───────────────────────────────────────────────────
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
    if (!translation) {
      for (const idx of originalIndices) result[idx] = originalSegments[idx].text;
      continue;
    }

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
      const distributed = distributeByTimingRatio(translation, originalIndices, originalSegments);
      for (let k = 0; k < originalIndices.length; k++) result[originalIndices[k]] = distributed[k] ?? "";
    } else {
      distributeByBreakPoints(translation, originalIndices, breakPoints, originalSegments, result);
    }
  }

  return result;
}

function distributeByTimingRatio(
  translation: string,
  originalIndices: number[],
  originalSegments: TranslationSegment[]
): string[] {
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
    if (i === originalIndices.length - 1) {
      result.push(words.slice(wordOffset).join(" "));
      break;
    }

    const targetCharCount = (durations[i] / totalDuration) * totalChars;
    let accumulated = 0;
    let bestWord = wordOffset + 1;

    for (let w = wordOffset; w < words.length - (originalIndices.length - 1 - i); w++) {
      accumulated += words[w].length;
      if (accumulated >= targetCharCount) {
        bestWord = w + 1;
        break;
      }
      bestWord = w + 1;
    }

    result.push(words.slice(wordOffset, bestWord).join(" "));
    charOffset += words.slice(wordOffset, bestWord).join("").length;
    wordOffset = bestWord;
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
      const distributed = distributeByTimingRatio(
        assignedText.trim(),
        grp,
        originalSegments
      );
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
      if (PROTECTED_PROPER_NOUNS.has(w)) continue;
      if (PROTECTED_ACRONYMS.has(w)) continue;
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

async function transliterateProperNouns(nouns: string[], targetLanguage: string): Promise<Record<string, string>> {
  if (!llamaContext || nouns.length === 0) return {};
  const r = await llamaContext.completion({
    messages: [
      {
        role: "system",
        content: `Transliterate each proper noun into ${targetLanguage} phonetically.\nOutput ONLY 'English=Transliteration' lines.`,
      },
      { role: "user", content: nouns.join("\n") },
    ],
    n_predict: nouns.length * 20,
    temperature: 0.1,
    top_p: 0.9,
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

async function buildProperNounDict(
  segments: TranslationSegment[],
  videoHash: string,
  targetLanguage: string
): Promise<Record<string, string>> {
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
  return text
    .replace(/\.{2,}$/, "")
    .replace(/(?<!\()[^)]*\)/g, "")
    .replace(/(?<!\[)[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── buildBatchMessage ─────────────────────────────────────────────────────────
function buildBatchMessage(batch: MergedGroup[]): {
  message: string;
  tokenMaps: MaskedToken[][];
} {
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

// ── postProcessTranslation ────────────────────────────────────────────────────
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
    if (!srcHasSurprise) {
      out = out.replace(RE_HALLUCINATED_ADDITION_KO, "").trim();
    }

    if (/\bHR\b/i.test(sourceText) && /감독/.test(out)) {
      out = out.replace(/인사\s*감독/g, "인사 담당자").replace(/감독님/g, "인사 책임자").trim();
    }

    if (/no\s+(guidance|validation|encouragement|supervision)/i.test(sourceText)) {
      out = out
        .replace(/감독\s*없이\s*격려/g, "격려도, 감독도 없이")
        .replace(/감독합니다/g, "감독도 없어요")
        .trim();
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

  out = stripLeakedPlaceholders(out);

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
    if (
      RE_NUMERIC_TOKEN.test(w) ||
      knownEn.has(w.toLowerCase()) ||
      knownTr.has(w.toLowerCase()) ||
      knownProtected.has(w.toLowerCase())
    ) continue;
    return true;
  }
  return false;
}

function isCorruptedOutput(text: string): boolean {
  return (
    /^##/.test(text) ||
    /^Translation:/i.test(text) ||
    /^\[미번역\]/.test(text) ||
    /^---/.test(text) ||
    text.includes("\n\n") ||
    RE_PLACEHOLDER_LEAK.test(text)
  );
}

function isOvergenerated(input: string, output: string, targetLanguage = "Korean"): boolean {
  const inLen = input.split(/\s+/).filter(Boolean).length;
  const outLen = output.split(/\s+/).filter(Boolean).length;
  const baseThreshold = targetLanguage === "Korean" ? 2.0 : 1.7;
  const strictThreshold = inLen <= 3 ? 1.5 : baseThreshold;
  return outLen > Math.max(inLen * strictThreshold, 4);
}

// ── 배치 응답 파싱 ────────────────────────────────────────────────────────────
function parseBatchResponse(
  response: string,
  batch: MergedGroup[],
  patterns: CompiledNounPattern[],
  tokenMaps: MaskedToken[][]
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
    if (!raw) return srcText;
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
  if (contentLines.length === batch.length) {
    console.warn(`[TRANSLATE] positional fallback: parsed=${tmap.size} expected=${batch.length}`);
    return batch.map((seg, i) => restoreAndClean(contentLines[i], i, seg.text));
  }

  return batch.map((seg, i) => {
    const raw = tmap.get(i + 1);
    if (!raw) {
      console.warn(`[TRANSLATE] missing #${i + 1}, keeping source`);
      return seg.text;
    }
    return restoreAndClean(raw, i, seg.text);
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
  segments: MergedGroup[],
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
    const placeholderLeak = RE_PLACEHOLDER_LEAK.test(t);

    const needsRetry =
      t.length === 0 ||
      /^[.…]{2,}$/.test(t) ||
      isLikelyUntranslated(t, targetLanguage) ||
      isCorruptedOutput(t) ||
      isOvergenerated(src, t, targetLanguage) ||
      negDropped ||
      leftoverEn ||
      foreignLatin ||
      goodFitBad ||
      placeholderLeak;

    if (!needsRetry) continue;
    console.warn(`[VALIDATE] retry ${i}: "${src}" → "${t}"`);

    const { masked: maskedSrc, tokens } = maskNumericTokens(src);

    try {
      const r = await llamaContext.completion({
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Translate to ${targetLanguage}. Output ONLY translation:\n${maskedSrc}${negDropped ? "\nCRITICAL: Preserve NEGATIVE meaning." : ""}`,
          },
        ],
        n_predict: 80,
        temperature: 0.1,
        top_p: 0.9,
        stop: ["</s>", "<end_of_turn>", "<|end|>", "\n"],
      });
      const restored = restoreNumericTokens(r.text.trim(), tokens);
      const deLeaked = stripLeakedPlaceholders(restored);
      const c = sanitizeTranslationOutput(deLeaked, src);
      result[i] =
        c &&
        !isLikelyUntranslated(c, targetLanguage) &&
        !isCorruptedOutput(c) &&
        !isOvergenerated(src, c, targetLanguage)
          ? applyProperNounFixes(c, patterns)
          : src;
    } catch (e) {
      result[i] = src;
      console.warn(`[VALIDATE] error ${i}:`, e);
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
  return segments.map((seg, i) => ({ ...seg, translated: translatedTexts[i] || seg.text }));
}

// ── 시스템 프롬프트 빌더 ──────────────────────────────────────────────────────
function buildSystemPrompt(
  targetLanguage: string,
  langRules: string,
  genrePersona: string,
  nounHint: string,
  batchSize: number
): string {
  const protectedNounList = [
    ...[...PROTECTED_PROPER_NOUNS],
    ...[...PROTECTED_ACRONYMS],
  ].join(", ");

  const timeRuleKo = (targetLanguage === "Korean" || targetLanguage === "ko")
    ? `- Time format: NEVER output "HH:MM" clock notation (e.g. 8:00, 3:00, 10:00). ` +
      `Instead use Korean spoken form WITHOUT colon: "8시", "3시", "10시 30분". ` +
      `With AM/PM context: "오전 8시", "새벽 3시", "오후 2시".\n` +
      `- "X in the morning" where X is 1–6: ALWAYS use "새벽 X시" (deep night), NOT "아침 X시".\n` +
      `- "until like X:00" as an arrival/action time (no "in the morning"): just "X시", no 새벽/아침 prefix.\n`
    : "";

  return (
    `You are a professional subtitle translator. Translate English subtitles to ${targetLanguage}.\n\n` +
    (genrePersona ? genrePersona + "\n\n" : "") +
    `STRICT OUTPUT FORMAT:\n` +
    `- Input has exactly ${batchSize} numbered lines\n` +
    `- Output MUST have exactly ${batchSize} numbered lines: "1. translation", "2. translation", ...\n` +
    `- ONE output line per input line. Never merge. Never split. Never skip.\n` +
    `- NEVER output headers like "## Translation:", "[미번역]", "---", or any non-translation text.\n\n` +
    `TRANSLATION RULES:\n` +
    `- Translate exact meaning only. Do NOT add, infer, or embellish content not in the source.\n` +
    `- Preserve negation: "don't/can't/never/not" → must reflect negation in translation.\n` +
    `- Fragment lines (no complete verb) → translate as fragment, do NOT complete the sentence.\n` +
    `- Short responses (Yes/No/Hmm/I do) → translate naturally as single words or short phrases.\n` +
    `- "I do" as a standalone affirmative response (2 words only) → translate as "저도요" or "그러게요". NOT a full sentence.\n` +
    `- "baby" as an informal address (non-romantic) → use the person's name or omit. NEVER translate as 자기야.\n` +
    `- NEVER add 자기야/여보/honey/darling unless that exact term is in the source.\n` +
    `- "HR" always means Human Resources. "HR director" → 인사 담당자 or 인사 책임자. NEVER 감독님.\n` +
    `- "no guidance", "no validation", "no encouragement", "no supervision" → each is a SEPARATE lack of support. Translate each phrase independently with negation.\n` +
    `- Tokens like __NUM0__, __NUM1__ are number/time placeholders. Copy them EXACTLY as-is. Do not translate or remove.\n` +
    `- These proper nouns must NOT be translated — keep or phonetically transliterate only: ${protectedNounList}\n` +
    `- "not really" → translate as mild negation in context\n` +
    `- "good fit" in work/interview context → compatibility match, NOT physical fitness\n` +
    `- "mental health day" → a day off for mental wellbeing\n` +
    `- "you don't work here" → factual: this person is NOT an employee here\n` +
    `- "didn't say X" / "didn't mention X" → someone failed to verbally state X, NOT about saving/storing\n` +
    `- "the big ones" in listing context (apps, brands) → "유명한 것들" or "큰 것들", NOT "큰 회사들"\n` +
    `- "until like X:00" as arrival/action time → time the person arrives or does something, NOT a staying-up time\n` +
    `- Conversational "That's/That is" → use proximal pronoun (그건/그게), never distal (저것은/저것이)\n` +
    `- Time expressions: "until X in the morning" — if X is 1–6, it is the middle of the night (새벽), not 아침\n` +
    `- "like X in the morning" or "until like X in the morning" follows same rule as above\n` +
    `- "that kind of thing" → always "그런 거" or "그런 식". NEVER "그런 종류의 것".\n` +
    `- "that kind of + verb/adj" (e.g. "that kind of doesn't work") → softening expression: "그게 좀 안 맞아요". NEVER "그런 종류는".\n` +
    `- "that kind of + noun" (e.g. "that kind of research") → noun reference: "그런 종류의 연구". This is the ONLY case where "그런 종류의" is correct.\n` +
    `- "kind of" alone (without "that") → softening adverb: "좀" or "약간". Not a noun reference.\n` +
    timeRuleKo +
    `\n` +
    langRules +
    nounHint
  );
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

  // NOTE: llamaContext is checked INSIDE enqueueInference (not here) so the check
  // happens at execution time — by then, any FG job that was running has finished
  // (and could have changed llamaContext).  Checking before entering the queue would
  // pass even if FG is mid-inference and then unloads the model before BG runs.
  return enqueueInference(async (isCancelled) => {
  if (!llamaContext) throw new Error("모델이 로드되지 않았습니다. loadModel()을 먼저 호출하세요.");
  // ── Step 0: 중복 제거 + ASR 정리 ────────────────────────────────────────────
  const deduped = deduplicateOverlappingSegments(segments);
  const cleaned = deduped.map(seg => ({
    ...seg,
    text: normalizeSocialMediaNames(cleanWhisperText(seg.text)),
  }));

  // ── Step A: 고유명사 + 프롬프트 구성 ────────────────────────────────────────
  const profile = getLanguageProfile(targetLanguage);
  const properNouns = await buildProperNounDict(deduped, videoHash, targetLanguage);
  if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
  const nounHint = formatNounHint(properNouns);
  const patterns = buildPatterns(properNouns);
  const genrePersona = GENRE_PERSONA[videoGenre] ?? "";
  const langRules = profile.systemPromptRules.join(" ");

  // ── Step B: SBD — 문장 경계 탐지 ────────────────────────────────────────────
  let merged: MergedGroup[];
  let usedSBD = false;

  const sbdSentences = await detectSentenceBoundaries(cleaned);
  if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

  if (sbdSentences.length > 0) {
    merged = sbdSentencesToMergedGroups(sbdSentences);
    usedSBD = true;
    console.log(`[TRANSLATE] SBD success: ${cleaned.length} segs → ${merged.length} sentences`);
  } else {
    console.log(`[TRANSLATE] SBD fallback: using mergeFragments`);
    let fallbackMerged = mergeFragments(cleaned);
    fallbackMerged = enforceSentence(fallbackMerged);
    merged = fallbackMerged;
  }

  const total = merged.length;
  const totalBatches = Math.ceil(total / BATCH_SIZE);
  console.log(`[TRANSLATE] ${usedSBD ? "SBD" : "fallback"} → ${total} groups (${totalBatches} batches)`);

  // ── Step C: 체크포인트 복원 ──────────────────────────────────────────────────
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

  // ── Step D: 배치 번역 ────────────────────────────────────────────────────────
  try {
    for (let bi = startBatch; bi < totalBatches; bi++) {
      if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
      const offset = bi * BATCH_SIZE;
      const batch = merged.slice(offset, offset + BATCH_SIZE);
      console.log(`[TRANSLATE] batch ${bi + 1}/${totalBatches} (${batch.length})`);

      const sysPrompt = buildSystemPrompt(targetLanguage, langRules, genrePersona, nounHint, batch.length);
      const { message: batchMessage, tokenMaps } = buildBatchMessage(batch);

      const r = await llamaContext.completion({
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: batchMessage },
        ],
        n_predict: batch.length * 80,
        temperature: 0.1,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
        stop: ["</s>", "<end_of_turn>", "<|end|>"],
      } as any);
      if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

      const translations = parseBatchResponse(r.text, batch, patterns, tokenMaps);

      for (let i = 0; i < batch.length; i++) {
        mergedTranslations[offset + i] = translations[i];
      }

      const partial = expandGroupTranslations(merged, mergedTranslations, cleaned);
      // [FIX ISSUE2] Await onProgress so that AsyncStorage status writes (BG mode)
      // and React state updates (FG mode) complete BEFORE the next batch begins.
      // Without await, the last batch's saveStatus(translating, X%) races with
      // backgroundTranslationTask's saveStatus(done, 100%) — the poll only sees 'done'.
      if (onProgress) await onProgress(offset + batch.length, total, mergeWithTranslations(cleaned, partial));

      await saveCheckpoint(videoHash, {
        translatedTexts: mergedTranslations,
        lastBatchIndex: bi,
        properNouns,
        totalBatches,
      });
      if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

      if (bi < totalBatches - 1) {
        await sleep((bi + 1) % THERMAL_EVERY_N === 0 ? SLEEP_THERMAL_MS : SLEEP_BETWEEN_MS);
        if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
      }
    }
  } catch (e: any) {
    if (e?.message === 'INFERENCE_CANCELLED') throw e;
    if (e?.message === 'APP_BACKGROUNDED') throw e;
    console.error("[Gemma] Inference error:", e);
    return mergeWithTranslations(cleaned, expandGroupTranslations(merged, mergedTranslations, cleaned));
  }

  await deleteCheckpoint(videoHash);

  // ── Step E: 재분배 ───────────────────────────────────────────────────────────
  const translatedTexts = expandGroupTranslations(merged, mergedTranslations, cleaned);

  // Step E.1: 호칭어 환각 제거
  for (let i = 0; i < cleaned.length; i++) {
    if (!RE_HALLUCINATION_GUARD.test(cleaned[i].text) && translatedTexts[i]) {
      translatedTexts[i] = translatedTexts[i].replace(RE_HALLUCINATED_TERMS_KO, "").trim();
    }
  }

  // Step E.2: 후처리
  for (let i = 0; i < cleaned.length; i++) {
    if (translatedTexts[i]) {
      translatedTexts[i] = postProcessTranslation(translatedTexts[i], cleaned[i].text, targetLanguage);
    }
  }

  // ── Step F: 실패 세그먼트 재시도 ─────────────────────────────────────────────
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = cleaned.reduce<number[]>((acc, seg, i) => {
      const t = translatedTexts[i];
      const src = seg.text.trim();
      if (
        !t ||
        !t.trim() ||
        (t.trim() === src && src.length > 10) ||
        /^\d+\.?$/.test(t.trim()) ||
        isCorruptedOutput(t) ||
        RE_PLACEHOLDER_LEAK.test(t)
      ) {
        return [...acc, i];
      }
      return acc;
    }, []);

    if (failed.length === 0) break;
    console.log(`[Gemma] Retry ${attempt + 1}: ${failed.length} segs`);

    const retryGroups: MergedGroup[] = failed.map(i => ({
      start: cleaned[i].start,
      end: cleaned[i].end,
      text: cleaned[i].text,
      originalIndices: [i],
    }));

    if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
    const retryPrompt = buildSystemPrompt(targetLanguage, langRules, genrePersona, nounHint, retryGroups.length);
    const { message: retryMessage, tokenMaps: retryTokenMaps } = buildBatchMessage(retryGroups);

    try {
      const rr = await llamaContext.completion({
        messages: [
          { role: "system", content: retryPrompt },
          { role: "user", content: retryMessage },
        ],
        n_predict: retryGroups.length * 80,
        temperature: 0.1,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
        stop: ["</s>", "<end_of_turn>", "<|end|>"],
      } as any);
      if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

      const rt = parseBatchResponse(rr.text, retryGroups, patterns, retryTokenMaps);

      for (let j = 0; j < failed.length; j++) {
        if (rt[j] && rt[j].trim() && !isCorruptedOutput(rt[j])) {
          translatedTexts[failed[j]] = postProcessTranslation(rt[j], retryGroups[j].text, targetLanguage);
        }
      }
    } catch (e: any) {
      if (e?.message === 'INFERENCE_CANCELLED') throw e;
      console.warn(`[Gemma] Retry ${attempt + 1} error:`, e);
      break;
    }

    if (attempt < 1) {
      await sleep(SLEEP_BETWEEN_MS);
      if (isCancelled()) throw new Error('INFERENCE_CANCELLED');
    }
  }

  // ── Step G: 검증 ─────────────────────────────────────────────────────────────
  const finalPrompt = buildSystemPrompt(targetLanguage, langRules, genrePersona, nounHint, BATCH_SIZE);

  const mergedForValidation: MergedGroup[] = merged.map((g, i) => ({
    ...g,
    text: g.text,
  }));

  const groupTranslationsForValidation = merged.map((g) => {
    const texts = g.originalIndices
      .map((idx) => translatedTexts[idx])
      .filter(Boolean);
    return texts.join(" ").trim();
  });

  const validatedGroupTexts = await validateTranslations(
    mergedForValidation,
    groupTranslationsForValidation,
    finalPrompt,
    targetLanguage,
    patterns
  );
  if (isCancelled()) throw new Error('INFERENCE_CANCELLED');

  const revalidatedTexts = expandGroupTranslations(merged, validatedGroupTexts, cleaned);

  for (let i = 0; i < cleaned.length; i++) {
    if (revalidatedTexts[i]) {
      revalidatedTexts[i] = postProcessTranslation(revalidatedTexts[i], cleaned[i].text, targetLanguage);
    }
  }

  // ── Step H: Netflix 포맷팅 ───────────────────────────────────────────────────
  const formatted = revalidatedTexts.map(t => formatNetflixSubtitle(t));

  // ── Step I: 타이밍 조정 + 최종 조립 ─────────────────────────────────────────
  const completed = adjustTimingsForReadability(mergeWithTranslations(cleaned, formatted));
  console.log(`[Gemma] Done: ${completed.length} segments.`);
  return completed;
  }); // ── end enqueueInference ──────────────────────────────────────────────
}