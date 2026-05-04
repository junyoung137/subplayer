/**
 * RealtimeSub subtitle proxy server (v28 — useWordLevel isASR fix + multilingual)
 *
 * 변경사항 (v27 → v28):
 *
 * [BUGFIX] useWordLevel — 수동자막에서 Word-Level 파이프라인 오진입 방지
 *   원인: const useWordLevel = !!enJson3File && !langJson3File
 *         → en.json3이 수동자막이어도 useWordLevel=true 진입
 *         → parseJson3WordLevel이 word-offset 없는 event를 잘못 grouping
 *         → buildDisplaySegments 입력이 3개 이하로 축소되어 초반 자막 소실
 *   수정: useWordLevel에 isASR 조건 추가
 *         const useWordLevel = !!enJson3File && !langJson3File && isASR
 *   효과: 수동자막은 parseJson3ByEvent → mergeOrphanPhrases(isManual=true) →
 *         MANUAL-BYPASS VTT 경로로 올바르게 흐름
 *
 * [MULTILINGUAL] 다국어 json3/vtt 파일 선택 로직 정교화
 *   기존: en 고정 우선순위 (enJson3File, enOrigFile, enVttFile)
 *   변경: 요청 lang → en → orig → fallback 순서로 일반화
 *   추가: langJson3File 존재 시 useWordLevel=false (비영어 ASR은 word-level 미지원)
 *         → 비영어 언어는 항상 parseJson3ASR/parseJson3ByEvent 경로 사용
 *   지원 언어: ko, en, ja, zh, fr, de, es, it, pt, ru, ar, hi, th, vi, id 등
 *              (LANGUAGES 배열과 동일, 코드 유효성 검사 정규식으로 범용 처리)
 *
 * 유지된 구조 (변경 없음):
 * - parseJson3WordLevel / parseJson3ASR / parseJson3ByEvent / splitEventWords
 * - mergeOrphanPhrases / resolveOverlaps / resolveAndCleanSegments
 * - parseVtt / clampVttSegments / scoreSegmentText / applyPunctuationAnchors
 * - lcsLength / longestCommonSubstringLength / hybridSimilarity
 * - snapToBestSubsequence / alignVttTextToJson3Timing
 * - fixStickyPairsInSegments / applyBoundaryPolish / applyConfidenceFilter
 * - selectBestSegments / applyPostProcess
 * - premergeRawSegments / buildDisplaySegments (v27 그대로)
 * - 캐시 / yt-dlp runner / Routes
 */

import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { readFile, readdir, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import dns from "dns";
import https from "https";

const app  = express();
const PORT = 3001;
const HOST = "0.0.0.0";

app.use(cors());

// ── In-memory subtitle cache ──────────────────────────────────────────────────
const CACHE_TTL_MS  = 60 * 60 * 1000;
const subtitleCache = new Map();

function getCached(key) {
  const entry = subtitleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    subtitleCache.delete(key);
    return null;
  }
  return entry;
}

let _ytdlpSeq = 0;
const _ytdlpTs = () => `seq=${++_ytdlpSeq}, ts=${Date.now()}`;

// ── Startup network health-check ─────────────────────────────────────────────
// Runs once on boot. Makes DNS / YouTube reachability failures visible
// immediately in logs instead of only on the first subtitle request.
(async () => {
  let dnsOk = false;
  try {
    await new Promise((resolve, reject) =>
      dns.lookup("www.youtube.com", (err, addr) => (err ? reject(err) : resolve(addr)))
    );
    dnsOk = true;
  } catch (e) {
    // dns failed — logged below
  }

  let youtubeOk = false;
  if (dnsOk) {
    try {
      await new Promise((resolve, reject) => {
        const req = https.get("https://www.youtube.com", { timeout: 5000 }, (res) => {
          res.destroy();
          resolve(res.statusCode);
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
      });
      youtubeOk = true;
    } catch (e) {
      // https failed — logged below
    }
  }

  console.log(
    `[YTDLP-NETWORK-CHECK] dns=${dnsOk ? "ok" : "fail"} youtube=${youtubeOk ? "ok" : "fail"}, ${_ytdlpTs()}`
  );
  if (!dnsOk) {
    console.error(
      `[YTDLP-NETWORK-FAIL] reason=dns_fail, detail="DNS resolution for www.youtube.com FAILED — yt-dlp will not work. Check server network/DNS configuration. Set YTDLP_PROXY env var to route yt-dlp through a proxy that has YouTube access.", ${_ytdlpTs()}`
    );
  } else if (!youtubeOk) {
    console.warn(
      `[YTDLP-NETWORK-FAIL] reason=https_fail, detail="www.youtube.com is DNS-resolvable but HTTPS connection failed — yt-dlp may still fail depending on network policy.", ${_ytdlpTs()}`
    );
  }
})();

// ── Constants ─────────────────────────────────────────────────────────────────
const SPEAKER_CHANGE_RE    = /^\s*(no|yes|yeah|nope|right|exactly|okay|ok|sure|never|really|not\s+really|of\s+course|i\s+know|i\s+see|got\s+it|me\s+too|wow|wait|what|huh|hmm|uh|oh)\s*[.!?]?\s*$/i;
const TWO_WORD_RESPONSE_RE = /^\s*(not really|of course|i know|i see|me too|got it|fair enough)\s*[.!?]?\s*$/i;
const SHORT_RESPONSE_RE    = /\b(no|yes|yeah|nope|right|exactly|okay|ok|sure|never|really|totally|absolutely|not really|of course|i know|i see|me too|got it|fair enough)\b/i;

const MIN_PHRASE_DURATION_S = 0.3;
const FLOOR_DURATION_S      = 0.8;
const SENTENCE_MAX_WORDS    = 6;
const GAP_THRESHOLD_MS      = 400;
const BOUNDARY_TOLERANCE_MS = 80;
const BOUNDARY_MAX_SPAN_MS  = 1000;
const CROSS_MERGE_MAX_GAP_S = 0.5;

// ── buildDisplaySegments constants ───────────────────────────────────────────
const DISPLAY_MIN_WORDS   = 4;
const DISPLAY_MAX_WORDS   = 7;
const DISPLAY_GAP_FLUSH_S = 0.8;
const DISPLAY_GAP_FORCE_S = 1.5;

// ── [SPEAKER-HINT] speaker hint score 관련 상수 ───────────────────────────────
const SPEAKER_HINT_FORCE_THRESHOLD = 0.7;
const SPEAKER_HINT_PREMERGE_MIN    = 0.65;

// ── [SPEAKER-SOFT] shouldForceBreak 조건 상수 ────────────────────────────────
const SPEAKER_SOFT_GAP_S    = 0.6;
const SPEAKER_SOFT_MAX_WORDS = 3;

// ── [SPEAKER-1] threshold ─────────────────────────────────────────────────────
const SPEAKER_INDEPENDENCE_THRESHOLD = 0.65;

const STICKY_PAIRS = [
  ["not", "really"], ["kind", "of"], ["sort", "of"], ["going", "to"],
  ["i", "know"], ["of", "course"], ["got", "it"], ["me", "too"],
  ["i", "see"], ["that", "is"], ["it", "is"],
];

const ORPHAN_WORDS = new Set([
  "not", "really", "exactly", "in", "what", "just", "so", "and", "but",
  "or", "the", "a", "an", "to", "be", "get", "even", "that", "this",
  "very", "well", "now", "like", "also", "kind", "sort", "going",
  "i", "you", "we", "they", "he", "she", "it", "hmm", "uh",
]);

const ORPHAN_MERGE_GAP_S = 3.0;

// ── [HYBRID] VTT 관련 상수 ────────────────────────────────────────────────────
const VTT_MAX_DURATION_S      = 3.5;
const VTT_EARLY_CUT_MS        = 150;
const VTT_MIN_SEGMENT_RATIO   = 0.5;
const ALIGN_OVERLAP_RATIO_MIN = 0.3;
const TEXT_RATIO_MAX          = 1.8;
const TEXT_RATIO_MIN          = 0.4;
const SPLIT_MAX_WORDS         = 10;

// ── [SNAP] 상수 ───────────────────────────────────────────────────────────────
const SNAP_MIN_IMPROVEMENT = 0.05;
const SNAP_W_LCS           = 0.50;
const SNAP_W_CONTIGUOUS    = 0.20;
const SNAP_W_JACC          = 0.20;
const SNAP_W_LEN           = 0.15;
const SNAP_SEARCH_RADIUS   = 20;

// ── [PUNCT-1] 상수 ────────────────────────────────────────────────────────────
const PUNCT_MIN_CHUNK_WORDS = 3;
const PUNCT_MIN_DURATION_S  = 1.2;

// ── [BOUNDARY] 상수 ──────────────────────────────────────────────────────────
const BOUNDARY_START_WORDS = new Set([
  "and", "but", "so", "because", "then", "or", "yet", "nor",
]);
const BOUNDARY_END_WORDS       = new Set(["and", "but", "so", "or"]);
const BOUNDARY_MERGE_MAX_GAP_S = 0.4;

// ── [CONF-1] 상수 ─────────────────────────────────────────────────────────────
const CONF_MAX_WORDS        = 2;
const CONF_MAX_GAP_S        = 0.25;
const CONF_STANDALONE_GAP_S = 0.4;

const LOW_INFORMATION_PHRASES = new Set([
  "you know", "i mean", "like i said", "sort of", "kind of", "i guess",
  "you see", "i mean like", "you know what i mean", "as i said", "right so",
  "well anyway", "anyway so", "so yeah", "yeah so",
]);

// ── 열거형 명사구 감지 ────────────────────────────────────────────────────────
const VERB_RE         = /\b(is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|must|get|gets|got|go|goes|went|work|works|worked|think|feel|know|see|say|said|told|need|want|like|look|take|make|come|give|send|find|tell|ask|try|use|keep|let|seem|become|show|turn|help|start|call|end|put|mean|run|set|move|follow|add|change|stand|hear|play|run|live|talk|include)\b/i;
const SUBJECT_VERB_RE = /\b(i|you|we|they|he|she|it)\s+\w+/i;

function isEnumerationPhrase(text) {
  const t = text.trim();
  if (VERB_RE.test(t)) return false;
  if (SUBJECT_VERB_RE.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < DISPLAY_MIN_WORDS) return false;
  if (/[.!?]$/.test(t)) return false;
  return true;
}

// ── ASR 판별 ──────────────────────────────────────────────────────────────────
function isSlidingWindow(events) {
  const valid = events.filter((e) => e.segs && e.tStartMs != null);
  for (let i = 0; i < valid.length - 1; i++) {
    const aEndMs   = valid[i].tStartMs + (valid[i].dDurMs ?? valid[i].dDurationMs ?? 1000);
    const bStartMs = valid[i + 1].tStartMs;
    if (bStartMs < aEndMs) return true;
  }
  return false;
}

// ── [SPEAKER-1] 화자 전환 독립성 점수 ────────────────────────────────────────
function speakerIndependenceScore(gapMs, prevWordCount) {
  const gapScore = gapMs >= 350 ? 0.5
    : gapMs >= 200 ? 0.3
    : gapMs >= 100 ? 0.15
    : 0;

  const prevScore = prevWordCount >= 5 ? 0.35
    : prevWordCount >= 3 ? 0.25
    : prevWordCount >= 2 ? 0.10
    : 0;

  const shortBonus = 0.15;
  return Math.min(1, gapScore + prevScore + shortBonus);
}

// ── parseJson3WordLevel ───────────────────────────────────────────────────────
function parseJson3WordLevel(data) {
  const allEvents = (data?.events ?? [])
    .filter(e => e.tStartMs != null || e.segs?.some(s => s.tOffsetMs != null))
    .sort((a, b) => (a.tStartMs ?? 0) - (b.tStartMs ?? 0));

  const boundaryMs = allEvents
    .filter(e => e.aAppend && e.segs?.some(s => s.utf8 === "\n"))
    .map(e => e.tStartMs);

  const hasBoundaryBetween = (prevEnd, currStart) => {
    const maxSpan = currStart - prevEnd;
    if (maxSpan > BOUNDARY_MAX_SPAN_MS) return false;
    return boundaryMs.some(b =>
      b >= prevEnd - BOUNDARY_TOLERANCE_MS &&
      b <= currStart + BOUNDARY_TOLERANCE_MS
    );
  };

  // 1. WORD FLATTEN
  const words = [];
  for (const event of allEvents) {
    if (!event.segs) continue;
    const eventStartMs = event.tStartMs ?? 0;
    const validSegs    = event.segs.filter(s => s.utf8 && s.utf8.trim() && s.utf8 !== "\n");
    for (const seg of validSegs) {
      const startMs = eventStartMs + (seg.tOffsetMs ?? 0);
      const durMs   = seg.dDurationMs ?? 0;
      words.push({ text: seg.utf8.trim(), startMs, endMs: startMs + durMs });
    }
  }

  if (words.length === 0) return [];

  // 2. GROUPING
  const utterances     = [];
  let group            = [words[0]];
  let nextGroupHintScore = 0;

  const flushGroup = (hintScore) => {
    if (group.length > 0) {
      utterances.push({ words: group, speakerHint: hintScore });
    }
  };

  for (let i = 1; i < words.length; i++) {
    const prev     = words[i - 1];
    const curr     = words[i];
    const gap      = curr.startMs - prev.endMs;
    const isBoundary = hasBoundaryBetween(prev.endMs, curr.startMs);
    const prevWord = prev.text.toLowerCase();
    const currWord = curr.text.toLowerCase();
    const isSticky = STICKY_PAIRS.some(([a, b]) => a === prevWord && b === currWord);
    const twoWord  = (prev.text + " " + curr.text).trim();
    const isTwoWordResponse = TWO_WORD_RESPONSE_RE.test(twoWord);

    if (isSticky) { group.push(curr); continue; }

    if (isBoundary) {
      flushGroup(nextGroupHintScore);
      group = [curr];
      nextGroupHintScore = 0;
      continue;
    }

    const isCurrShortResponse = SPEAKER_CHANGE_RE.test(curr.text.trim());
    const isPrevShortResponse = SPEAKER_CHANGE_RE.test(prev.text.trim());

    if (isCurrShortResponse && !isSticky) {
      const score = speakerIndependenceScore(gap, group.length);
      if (score >= SPEAKER_INDEPENDENCE_THRESHOLD) {
        flushGroup(nextGroupHintScore);
        group = [curr];
        nextGroupHintScore = score;
        continue;
      }
    }

    if (isPrevShortResponse && !isSticky) {
      const score = speakerIndependenceScore(gap, group.length);
      if (score >= SPEAKER_INDEPENDENCE_THRESHOLD) {
        flushGroup(nextGroupHintScore);
        group = [curr];
        nextGroupHintScore = score;
        continue;
      }
    }

    if (gap > GAP_THRESHOLD_MS) {
      if (isTwoWordResponse) { group.push(curr); continue; }
      flushGroup(nextGroupHintScore);
      group = [curr];
      nextGroupHintScore = 0;
      continue;
    }

    group.push(curr);
  }
  flushGroup(nextGroupHintScore);

  // 3. CONVERT TO SEGMENTS
  return utterances.map(u => ({
    startTime:    u.words[0].startMs / 1000,
    endTime:      u.words[u.words.length - 1].endMs / 1000,
    text:         u.words.map(w => w.text).join(" ").trim(),
    _speakerHint: u.speakerHint,
  }));
}

// ── premergeRawSegments ───────────────────────────────────────────────────────
function premergeRawSegments(segs) {
  if (segs.length === 0) return segs;

  const isHintStrong = (seg) => (seg._speakerHint ?? 0) >= SPEAKER_HINT_PREMERGE_MIN;

  let out = [];
  let i   = 0;
  while (i < segs.length) {
    const cur  = segs[i];
    const next = segs[i + 1] ?? null;
    if (!next) { out.push(cur); i++; continue; }

    if (isHintStrong(cur) || isHintStrong(next)) {
      out.push(cur);
      i++;
      continue;
    }

    const curWord  = cur.text.trim().toLowerCase();
    const nextWord = next.text.trim().split(/\s+/)[0].toLowerCase();
    const isSticky = STICKY_PAIRS.some(([a, b]) => a === curWord && b === nextWord);

    if (isSticky) {
      out.push({
        startTime:    cur.startTime,
        endTime:      next.endTime,
        text:         (cur.text.trim() + ' ' + next.text.trim()).trim(),
        _uttBreak:    next._uttBreak ?? false,
        _speakerHint: 0,
      });
      i += 2;
      continue;
    }
    out.push(cur);
    i++;
  }

  let changed = true;
  while (changed) {
    changed = false;
    const pass2 = [];
    let j = 0;
    while (j < out.length) {
      const cur      = out[j];
      const next     = out[j + 1] ?? null;
      const curWords = cur.text.trim().split(/\s+/).filter(Boolean);
      const curWord  = curWords[0]?.toLowerCase() ?? "";
      const isOrphan = curWords.length === 1 && ORPHAN_WORDS.has(curWord);
      const isShortResponseWord = SPEAKER_CHANGE_RE.test(cur.text.trim());

      if (isOrphan && !isShortResponseWord && !isHintStrong(cur) && next && !isHintStrong(next)) {
        const gap       = next.startTime - cur.endTime;
        const nextWord1 = next.text.trim().split(/\s+/)[0].toLowerCase();
        const nextIsRealBreak = next._uttBreak && !ORPHAN_WORDS.has(nextWord1);
        if (gap < ORPHAN_MERGE_GAP_S && !nextIsRealBreak) {
          pass2.push({
            startTime:    cur.startTime,
            endTime:      next.endTime,
            text:         (cur.text.trim() + ' ' + next.text.trim()).trim(),
            _uttBreak:    next._uttBreak ?? false,
            _speakerHint: 0,
          });
          j += 2;
          changed = true;
          continue;
        }
      }
      pass2.push(cur);
      j++;
    }
    out = pass2;
  }

  return out;
}

// ── buildDisplaySegments ──────────────────────────────────────────────────────
function buildDisplaySegments(rawSegs) {
  if (rawSegs.length === 0) return [];

  const result = [];
  let buffer   = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const combined = buffer.map(s => s.text).join(' ').trim();
    const words    = combined.split(/\s+/).filter(Boolean);
    if (words.length > DISPLAY_MAX_WORDS) {
      const mid      = Math.floor(words.length / 2);
      const totalDur = buffer[buffer.length - 1].endTime - buffer[0].startTime;
      const midTime  = buffer[0].startTime + totalDur * (mid / words.length);
      console.log(`[BDS] flush(split) words=${words.length} → 2 segs, text="${combined.slice(0,80)}" result.length=${result.length+2}`);
      result.push({ startTime: buffer[0].startTime, endTime: midTime,                           text: words.slice(0, mid).join(' ') });
      result.push({ startTime: midTime,              endTime: buffer[buffer.length - 1].endTime, text: words.slice(mid).join(' ')   });
    } else {
      console.log(`[BDS] flush words=${words.length} text="${combined.slice(0,80)}" result.length=${result.length+1}`);
      result.push({ startTime: buffer[0].startTime, endTime: buffer[buffer.length - 1].endTime, text: combined });
    }
    buffer = [];
  };

  for (let i = 0; i < rawSegs.length; i++) {
    const seg      = rawSegs[i];
    const nextSeg  = rawSegs[i + 1] ?? null;
    const prevSeg  = rawSegs[i - 1] ?? null;
    const nextGap  = nextSeg ? nextSeg.startTime - seg.endTime : Infinity;
    const prevGap  = prevSeg ? seg.startTime - prevSeg.endTime : Infinity;
    const segWords = seg.text.trim().split(/\s+/).filter(Boolean);
    const hintScore = seg._speakerHint ?? 0;

    // ── [SPEAKER-HINT] speakerHint score 기반 soft rule ──────────────────
    if (hintScore >= SPEAKER_HINT_FORCE_THRESHOLD) {
      const bufferText      = buffer.map(s => s.text).join(' ').trim();
      const bufferWordCount = bufferText.split(/\s+/).filter(Boolean).length;

      // [SENT-GUARD-EX] 완결 판단 확장
      const endsLikeCompleteThought =
        /[.!?]$/.test(bufferText) ||
        /\b(you know|i mean|right|okay|so)\s*$/i.test(bufferText);

      // [SENT-GUARD-EX] 문장 진행 중 판별
      const isSentenceContinuing =
        bufferText.length > 0 &&
        !endsLikeCompleteThought &&
        nextSeg !== null &&
        /^[a-z]/i.test(seg.text.trim());

      if (isSentenceContinuing) {
        // 문장 흐름 유지: 일반 buffer 처리로 fall-through
      } else {
        // [SOFT-CONTINUATION] 다음 segment가 소문자 continuation이면 분리 금지
        const nextStartsLowerContinuation =
          nextSeg !== null &&
          /^[a-z]/.test(nextSeg.text.trim()) &&
          !SPEAKER_CHANGE_RE.test(nextSeg.text.trim());

        const isShortResponse = SPEAKER_CHANGE_RE.test(seg.text.trim());

        // [DYNAMIC-MIN-SAFE]
        const dynamicMinSafeWords =
          nextGap > 1.2 ? 3 :
          nextGap > 0.6 ? 4 :
          5;

        const shouldForceBreak =
          hintScore >= SPEAKER_HINT_FORCE_THRESHOLD &&
          nextGap > SPEAKER_SOFT_GAP_S &&
          segWords.length <= SPEAKER_SOFT_MAX_WORDS &&
          isShortResponse &&
          !nextStartsLowerContinuation;

        if (shouldForceBreak && bufferWordCount >= dynamicMinSafeWords) {
          flushBuffer();
          console.log(`[BDS] push(speakerHint-force) text="${seg.text.slice(0,60)}" hint=${hintScore.toFixed(2)} result.length=${result.length+1}`);
          result.push({ startTime: seg.startTime, endTime: seg.endTime, text: seg.text });
          continue;
        }
      }
    }

    const isSingleResponse = SPEAKER_CHANGE_RE.test(seg.text.trim());
    const isOrphanWord     = segWords.length === 1 && ORPHAN_WORDS.has(segWords[0].toLowerCase());
    const bufferLastWord   = buffer.length > 0
      ? buffer[buffer.length - 1].text.trim().split(/\s+/).pop().toLowerCase()
      : null;
    const curFirstWord = segWords[0]?.toLowerCase() ?? "";
    const isSticky     = bufferLastWord !== null &&
      STICKY_PAIRS.some(([a, b]) => a === bufferLastWord && b === curFirstWord);

    if (isSingleResponse && !isSticky && !isOrphanWord) {
      const isIsolated = seg._uttBreak || nextGap > 0.5 || prevGap > 0.3;
      if (isIsolated) {
        flushBuffer();
        console.log(`[BDS] push(singleResponse-isolated) text="${seg.text.slice(0,60)}" nextGap=${nextGap===Infinity?'∞':nextGap.toFixed(3)} prevGap=${prevGap===Infinity?'∞':prevGap.toFixed(3)} result.length=${result.length+1}`);
        result.push({ startTime: seg.startTime, endTime: seg.endTime, text: seg.text });
      } else {
        buffer.push(seg);
        const wc = buffer.map(s => s.text).join(' ').split(/\s+/).filter(Boolean).length;
        if (wc >= DISPLAY_MAX_WORDS || nextGap > DISPLAY_GAP_FORCE_S) flushBuffer();
      }
      continue;
    }

    if (isOrphanWord) {
      buffer.push(seg);
      const wc = buffer.map(s => s.text).join(' ').split(/\s+/).filter(Boolean).length;
      if (wc >= DISPLAY_MAX_WORDS) flushBuffer();
      continue;
    }

    buffer.push(seg);
    const combined  = buffer.map(s => s.text).join(' ').trim();
    const wordCount = combined.split(/\s+/).filter(Boolean).length;

    if (isSticky) {
      if (wordCount >= DISPLAY_MAX_WORDS) flushBuffer();
      continue;
    }

    const forceFlush   = wordCount >= DISPLAY_MAX_WORDS || nextGap > DISPLAY_GAP_FORCE_S;
    const naturalFlush = wordCount >= DISPLAY_MIN_WORDS && nextGap > DISPLAY_GAP_FLUSH_S;
    const nextIsBreakResponse = nextSeg
      && SPEAKER_CHANGE_RE.test(nextSeg.text.trim())
      && !ORPHAN_WORDS.has(nextSeg.text.trim().toLowerCase())
      && (nextSeg._uttBreak || (nextSeg._speakerHint ?? 0) >= SPEAKER_HINT_FORCE_THRESHOLD || nextGap > 0.5);

    const bufferText       = buffer.map(s => s.text).join(' ').trim();
    const endsWithDangler  = /\b(my|your|his|her|our|their|the|a|an|this|that)\s*$/i.test(bufferText);
    const nextStartsClause = nextSeg &&
      /^(I|you|we|they|he|she|well|so|but|and|because|when|if)\b/i.test(nextSeg.text.trim());
    const clauseBoundaryFlush = endsWithDangler && nextStartsClause && wordCount >= 3;

    const SENTENCE_FINAL_WORDS = new Set(["here", "there", "now", "today", "yet"]);
    const lastBufWord = buffer.length > 0
      ? buffer[buffer.length - 1].text.trim().split(/\s+/).pop().toLowerCase()
      : "";
    const sentenceFinalFlush = SENTENCE_FINAL_WORDS.has(lastBufWord) &&
      nextSeg && nextGap < 0.8 && wordCount >= 3;

    const bufferIsEnumeration   = isEnumerationPhrase(bufferText);
    const nextIsAlsoEnumeration = nextSeg && isEnumerationPhrase(nextSeg.text.trim());
    const enumerationFlush      = bufferIsEnumeration && nextIsAlsoEnumeration && wordCount >= DISPLAY_MIN_WORDS;

    if (forceFlush || naturalFlush || nextIsBreakResponse || clauseBoundaryFlush || sentenceFinalFlush || enumerationFlush) {
      flushBuffer();
    }
  }

  flushBuffer();
  console.log(`[BDS] TOTAL result: ${result.length}`);
  return result;
}

// ── parseJson3ASR ─────────────────────────────────────────────────────────────
function parseJson3ASR(data) {
  const events = (data?.events ?? [])
    .filter((e) => e.segs && e.tStartMs != null)
    .sort((a, b) => a.tStartMs - b.tStartMs);

  const utterances = [];
  let cursorMs = -1;

  for (const event of events) {
    const startMs = event.tStartMs;
    const durMs   = event.dDurMs ?? event.dDurationMs ?? 1000;
    const endMs   = startMs + durMs;
    if (startMs <= cursorMs) continue;

    const text = event.segs
      .map((s) => (s.utf8 ?? "").replace(/\n/g, " ").trim())
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!text) continue;
    utterances.push({ startMs, endMs, text });
    cursorMs = endMs;
  }

  const segments = [];
  for (const u of utterances) {
    const startS = u.startMs / 1000;
    const endS   = u.endMs   / 1000;
    const words  = u.text.split(/\s+/).filter(Boolean);

    if (words.length === 0) continue;
    if (words.length === 1 || SPEAKER_CHANGE_RE.test(u.text)) {
      segments.push({ startTime: startS, endTime: endS, text: u.text });
      continue;
    }
    const split = splitEventWords(words, startS, endS);
    for (const seg of split) segments.push(seg);
  }
  return segments;
}

// ── parseJson3ByEvent ─────────────────────────────────────────────────────────
function parseJson3ByEvent(data) {
  const events   = data?.events ?? [];
  const segments = [];

  for (const event of events) {
    if (!event.segs) continue;
    const startS = (event.tStartMs ?? 0) / 1000;
    const durMs  = event.dDurMs ?? event.dDurationMs ?? 1000;
    const endS   = startS + durMs / 1000;
    const words  = event.segs
      .map((s) => (s.utf8 ?? "").replace(/\n/g, " ").trim())
      .filter(Boolean);
    if (words.length === 0) continue;

    const fullText = words.join(" ").trim();
    if (words.length === 1 || SPEAKER_CHANGE_RE.test(fullText)) {
      segments.push({ startTime: startS, endTime: endS, text: fullText });
      continue;
    }
    const split = splitEventWords(words, startS, endS);
    for (const seg of split) segments.push(seg);
  }
  return segments;
}

// ── splitEventWords ───────────────────────────────────────────────────────────
function splitEventWords(words, startS, endS) {
  const duration = Math.max(endS - startS, 0.1);
  const results  = [];
  let group      = [];

  const flushGroup = (endIdx) => {
    if (group.length === 0) return;
    const gStartFrac = group[0].idx / words.length;
    const gEndFrac   = endIdx        / words.length;
    results.push({
      startTime: startS + duration * gStartFrac,
      endTime:   startS + duration * gEndFrac,
      text:      group.map((w) => w.word).join(" ").trim(),
    });
    group = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word     = words[i];
    const nextWord = words[i + 1];

    if (nextWord) {
      const twoText = (word + " " + nextWord).trim();
      if (TWO_WORD_RESPONSE_RE.test(twoText)) {
        flushGroup(i);
        results.push({
          startTime: startS + duration * (i       / words.length),
          endTime:   startS + duration * ((i + 2) / words.length),
          text: twoText,
        });
        i++;
        continue;
      }
    }

    if (SPEAKER_CHANGE_RE.test(word)) {
      flushGroup(i);
      results.push({
        startTime: startS + duration * (i       / words.length),
        endTime:   startS + duration * ((i + 1) / words.length),
        text: word.trim(),
      });
      continue;
    }

    if (group.length >= SENTENCE_MAX_WORDS) flushGroup(i);
    group.push({ word, idx: i });
  }

  flushGroup(words.length);
  return results;
}

// ── mergeOrphanPhrases ────────────────────────────────────────────────────────
function mergeOrphanPhrases(phrases, isManual = false) {
  let result = [...phrases];

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const out   = [];

    for (let i = 0; i < result.length; i++) {
      const cur          = result[i];
      const curWordCount = cur.text.trim().split(/\s+/).length;

      const isProtectedRaw = SPEAKER_CHANGE_RE.test(cur.text.trim());
      const prevGap        = out.length > 0 ? cur.startTime - out[out.length - 1].endTime : Infinity;
      const nextGap        = i + 1 < result.length ? result[i + 1].startTime - cur.endTime : Infinity;
      const isShortOrphan  = curWordCount <= 2 && (prevGap < 0.3 || nextGap < 0.3);
      const isProtected    = isProtectedRaw && !isShortOrphan;

      if (out.length > 0) {
        const prev     = out[out.length - 1];
        const gap      = cur.startTime - prev.endTime;
        const combined = (prev.text.trim() + " " + cur.text.trim()).trim();
        if (gap < CROSS_MERGE_MAX_GAP_S && TWO_WORD_RESPONSE_RE.test(combined)) {
          out[out.length - 1] = { startTime: prev.startTime, endTime: cur.endTime, text: combined };
          changed = true;
          continue;
        }
      }

      if (isProtected) { out.push(cur); continue; }

      const isOneWord = curWordCount === 1;

      if (isOneWord && i + 1 < result.length) {
        const nxt    = result[i + 1];
        const gapFwd = nxt.startTime - cur.endTime;
        if (gapFwd < 0.05) {
          const merged = (cur.text + " " + nxt.text).trim();
          if (merged.split(/\s+/).length <= 8) {
            out.push({ startTime: cur.startTime, endTime: nxt.endTime, text: merged });
            i++; changed = true; continue;
          }
        }
      }

      if (curWordCount <= 2 && out.length > 0) {
        const prev     = out[out.length - 1];
        const gap      = cur.startTime - prev.endTime;
        const gapLimit = isOneWord ? 0.8 : 0.4;
        if (gap < gapLimit) {
          const merged = (prev.text + " " + cur.text).trim();
          if (merged.split(/\s+/).length <= 8) {
            out[out.length - 1] = { startTime: prev.startTime, endTime: cur.endTime, text: merged };
            changed = true; continue;
          }
        }
      }

      if (curWordCount <= 2 && i + 1 < result.length) {
        const nxt      = result[i + 1];
        const gap      = nxt.startTime - cur.endTime;
        const gapLimit = isManual ? (isOneWord ? 0.8 : 0.5) : (isOneWord ? 1.0 : 0.6);
        if (gap < gapLimit) {
          const merged = (cur.text + " " + nxt.text).trim();
          if (merged.split(/\s+/).length <= 8) {
            out.push({ startTime: cur.startTime, endTime: nxt.endTime, text: merged });
            i++; changed = true; continue;
          }
        }
      }

      out.push(cur);
    }

    result = out;
    if (!changed) break;
  }

  const capped = [];
  for (const phrase of result) {
    const words = phrase.text.trim().split(/\s+/);
    if (words.length > 8) {
      const mid     = Math.floor(words.length / 2);
      const midTime = phrase.startTime + (phrase.endTime - phrase.startTime) * (mid / words.length);
      capped.push({ startTime: phrase.startTime, endTime: midTime,         text: words.slice(0, mid).join(" ") });
      capped.push({ startTime: midTime,           endTime: phrase.endTime, text: words.slice(mid).join(" ")   });
    } else {
      capped.push(phrase);
    }
  }
  return capped;
}

// ── resolveOverlaps ───────────────────────────────────────────────────────────
function resolveOverlaps(segments) {
  if (segments.length === 0) return segments;
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].endTime > sorted[i + 1].startTime) {
      sorted[i] = {
        ...sorted[i],
        endTime: Math.max(sorted[i + 1].startTime, sorted[i].startTime + 0.1),
      };
    }
  }
  return sorted.filter((s) => s.endTime - s.startTime >= 0.05);
}

// ── resolveAndCleanSegments ───────────────────────────────────────────────────
function resolveAndCleanSegments(segments) {
  if (segments.length === 0) return segments;

  const _in = segments.length;

  let result = [...segments].sort((a, b) => a.startTime - b.startTime);

  // Step 1: overlap clamping
  let overlapClampCount = 0;
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].endTime > result[i + 1].startTime) {
      overlapClampCount++;
      result[i] = {
        ...result[i],
        endTime: Math.max(result[i + 1].startTime, result[i].startTime + 0.1),
      };
    }
  }
  const afterOverlap = result.length;
  console.log(`[CLEAN] step1 overlap-clamp: ${_in} in, ${overlapClampCount} clamped → still ${afterOverlap}`);

  // Step 2: duration filter
  const beforeDurFilter = result.length;
  const durDropped = result.filter((s) => s.endTime - s.startTime < 0.05);
  if (durDropped.length > 0) {
    console.log(`[CLEAN] step2 dur-filter dropping ${durDropped.length} segs:`);
    durDropped.forEach((s) =>
      console.log(`  DROP dur<0.05: [${s.startTime.toFixed(3)}→${s.endTime.toFixed(3)}] dur=${
        (s.endTime - s.startTime).toFixed(4)} "${s.text?.slice(0, 60)}"`));
  }
  result = result.filter((s) => s.endTime - s.startTime >= 0.05);
  console.log(`[CLEAN] step2 dur-filter: ${beforeDurFilter} → ${result.length} (dropped ${beforeDurFilter - result.length})`);

  // Step 3: FLOOR_DURATION_S expansion
  for (let i = 0; i < result.length; i++) {
    if (result[i].endTime - result[i].startTime < MIN_PHRASE_DURATION_S) {
      const next    = result[i + 1];
      const ceiling = next ? next.startTime : Infinity;
      result[i] = {
        ...result[i],
        endTime: Math.min(result[i].startTime + FLOOR_DURATION_S, ceiling),
      };
    }
  }
  console.log(`[CLEAN] step3 floor-expand: ${result.length} (count unchanged)`);

  // Step 4: SHORT_RESPONSE_RE expand / split
  const expanded = [];
  let splitCount = 0, shiftCount = 0, passthroughCount = 0;
  for (const seg of result) {
    const words    = seg.text.trim().split(/\s+/);
    const duration = seg.endTime - seg.startTime;

    if (words.length <= 5 && duration > 2 && seg.startTime > 5.0 && SHORT_RESPONSE_RE.test(seg.text)) {
      const midTime  = seg.startTime + duration / 2;
      const splitIdx = words.findIndex((w) => SHORT_RESPONSE_RE.test(w));
      if (splitIdx > 0) {
        splitCount++;
        console.log(`[CLEAN] step4 SPLIT idx=${splitIdx}: [${seg.startTime.toFixed(3)}→${seg.endTime.toFixed(3)}] "${seg.text?.slice(0, 60)}"`);
        expanded.push({ startTime: seg.startTime, endTime: midTime,      text: words.slice(0, splitIdx).join(" ") });
        expanded.push({ startTime: midTime,        endTime: seg.endTime, text: words.slice(splitIdx).join(" ")    });
      } else {
        shiftCount++;
        console.log(`[CLEAN] step4 SHIFT-DROP(idx=0): [${seg.startTime.toFixed(3)}→${seg.endTime.toFixed(3)}] "${seg.text?.slice(0, 60)}"`);
        expanded.push({ startTime: midTime, endTime: seg.endTime, text: seg.text });
      }
      continue;
    }
    passthroughCount++;
    expanded.push(seg);
  }
  expanded.sort((a, b) => a.startTime - b.startTime);
  console.log(`[CLEAN] step4 SHORT_RESPONSE expand: passthrough=${passthroughCount}, split=${splitCount}, shift(drop-first-half)=${shiftCount} → expanded=${expanded.length}`);

  // Step 5: deduplication
  const seen    = new Set();
  const deduped = expanded.filter((s) => {
    const key = `${s.startTime.toFixed(3)}|${s.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (expanded.length !== deduped.length) {
    console.log(`[CLEAN] step5 dedup: ${expanded.length} → ${deduped.length} (dropped ${expanded.length - deduped.length} duplicates)`);
  } else {
    console.log(`[CLEAN] step5 dedup: ${deduped.length} (no duplicates)`);
  }

  console.log(`[CLEAN] TOTAL: ${_in} → ${deduped.length}`);
  return deduped;
}

// ── parseVtt ──────────────────────────────────────────────────────────────────
function parseVtt(vttText) {
  const TIME_RE = /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/;
  const TAG_RE  = /<[^>]+>/g;

  function parseTimestamp(ts) {
    const parts = ts.trim().split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1];
  }

  const lines    = vttText.split(/\r?\n/);
  const segments = [];
  let i = 0;

  while (i < lines.length) {
    const m = lines[i].match(TIME_RE);
    if (m) {
      const startTime = parseTimestamp(m[1]);
      const endTime   = parseTimestamp(m[2]);
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        const clean = lines[i].replace(TAG_RE, "").trim();
        if (clean) textLines.push(clean);
        i++;
      }
      const text = textLines.join(" ").trim();
      if (text) segments.push({ startTime, endTime, text });
    } else {
      i++;
    }
  }

  return segments.length > 0 ? segments : null;
}

// ── scoreSegmentText ──────────────────────────────────────────────────────────
function scoreSegmentText(segments) {
  if (!segments || segments.length === 0) return 0;
  const total = segments.length;

  const wordCounts = segments.map(s =>
    s.text.trim().split(/\s+/).filter(Boolean).length
  );
  const avgWords  = wordCounts.reduce((a, b) => a + b, 0) / total;
  const wordScore = avgWords >= 2 && avgWords <= 6
    ? 40
    : avgWords < 2
      ? avgWords * 15
      : Math.max(0, 40 - (avgWords - 6) * 6);

  const texts     = segments.map(s => s.text.trim().toLowerCase());
  const uniqueSet = new Set(texts);
  const dupRatio  = 1 - uniqueSet.size / texts.length;
  const dupScore  = Math.max(0, 35 - dupRatio * 120);

  const sentenceEnds  = segments.filter(s => /[.!?]$/.test(s.text.trim())).length;
  const sentenceScore = Math.min(15, (sentenceEnds / total) * 25);

  const variance        = wordCounts.reduce((sum, wc) => sum + (wc - avgWords) ** 2, 0) / total;
  const stdDev          = Math.sqrt(variance);
  const variancePenalty = Math.min(10, stdDev * (10 / 3));

  return Math.round(Math.min(100, Math.max(0, wordScore + dupScore + sentenceScore - variancePenalty)));
}

function clampVttSegments(vttSegs) {
  if (vttSegs.length === 0) return vttSegs;
  return vttSegs.map((seg, i) => {
    const nextStart  = vttSegs[i + 1]?.startTime ?? Infinity;
    const earlyCut   = nextStart - VTT_EARLY_CUT_MS / 1000;
    const clampedEnd = Math.min(
      seg.endTime,
      seg.startTime + VTT_MAX_DURATION_S,
      earlyCut > seg.startTime + 0.1 ? earlyCut : seg.endTime,
    );
    return { ...seg, endTime: clampedEnd };
  });
}

// ── applyPunctuationAnchors ───────────────────────────────────────────────────
function applyPunctuationAnchors(vttSegs) {
  const result = [];

  for (const seg of vttSegs) {
    const text     = seg.text.trim();
    const words    = text.split(/\s+/).filter(Boolean);
    const duration = seg.endTime - seg.startTime;

    if (words.length <= 1 || duration <= PUNCT_MIN_DURATION_S) {
      result.push(seg);
      continue;
    }

    const hasInternalBreak = words.some((w, i) => i < words.length - 1 && /[.!?]$/.test(w));
    if (!hasInternalBreak) { result.push(seg); continue; }

    const chunks   = [];
    let chunkStart = 0;

    for (let i = 0; i < words.length; i++) {
      const isLast           = i === words.length - 1;
      const hasTerminalPunct = /[.!?]$/.test(words[i]);
      if (hasTerminalPunct || isLast) {
        chunks.push({ from: chunkStart, to: i + 1 });
        chunkStart = i + 1;
      }
    }

    if (chunks.length <= 1) { result.push(seg); continue; }

    const allChunksLongEnough = chunks.every(c => (c.to - c.from) >= PUNCT_MIN_CHUNK_WORDS);
    if (!allChunksLongEnough) { result.push(seg); continue; }

    for (const chunk of chunks) {
      if (chunk.from >= chunk.to) continue;
      const chunkWords = words.slice(chunk.from, chunk.to);
      const startFrac  = chunk.from / words.length;
      const endFrac    = chunk.to   / words.length;
      result.push({
        startTime: seg.startTime + duration * startFrac,
        endTime:   seg.startTime + duration * endFrac,
        text:      chunkWords.join(" "),
      });
    }
  }

  return result;
}

// ── LCS utilities ─────────────────────────────────────────────────────────────
function lcsLength(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[n];
}

function longestCommonSubstringLength(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  let maxLen = 0;
  let prev   = new Array(n + 1).fill(0);
  let curr   = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > maxLen) maxLen = curr[j];
      } else {
        curr[j] = 0;
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return maxLen;
}

function hybridSimilarity(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const aNorm  = a.map(w => w.toLowerCase());
  const bNorm  = b.map(w => w.toLowerCase());
  const maxLen = Math.max(aNorm.length, bNorm.length, 1);

  const lcsRatio        = lcsLength(aNorm, bNorm) / maxLen;
  const contiguousScore = longestCommonSubstringLength(aNorm, bNorm) / maxLen;

  const setA = new Set(aNorm);
  const setB = new Set(bNorm);
  let inter  = 0;
  for (const w of setA) { if (setB.has(w)) inter++; }
  const union   = setA.size + setB.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;

  const lenPenalty = 1 - Math.abs(aNorm.length - bNorm.length) / maxLen;

  return SNAP_W_LCS        * lcsRatio
       + SNAP_W_CONTIGUOUS * contiguousScore
       + SNAP_W_JACC       * jaccard
       + SNAP_W_LEN        * lenPenalty;
}

function snapToBestSubsequence(vttWords, slicedWords, j3Words) {
  const n      = slicedWords.length;
  const vttLen = vttWords.length;
  if (n === 0 || vttLen === 0) return slicedWords;

  const currentScore = hybridSimilarity(slicedWords, j3Words);
  let bestScore      = currentScore + SNAP_MIN_IMPROVEMENT;
  let bestWindow     = null;
  let bestDist       = Infinity;

  const currentStartIdx = vttWords.findIndex(
    w => w.toLowerCase() === slicedWords[0]?.toLowerCase()
  );
  const searchCenter = currentStartIdx >= 0 ? currentStartIdx : 0;
  const searchFrom   = Math.max(0, searchCenter - SNAP_SEARCH_RADIUS);
  const searchTo     = Math.min(vttLen, searchCenter + SNAP_SEARCH_RADIUS + 1);

  for (const windowSize of [n - 1, n, n + 1]) {
    if (windowSize <= 0 || windowSize > vttLen) continue;
    const rangeEnd = Math.min(searchTo, vttLen - windowSize + 1);
    for (let start = searchFrom; start <= rangeEnd; start++) {
      const window = vttWords.slice(start, start + windowSize);
      const score  = hybridSimilarity(window, j3Words);
      const dist   = Math.abs(start - searchCenter);
      if (score > bestScore || (score === bestScore && dist < bestDist)) {
        bestScore  = score;
        bestWindow = window;
        bestDist   = dist;
      }
    }
  }

  return bestWindow ?? slicedWords;
}

// ── fixStickyPairsInSegments ──────────────────────────────────────────────────
function fixStickyPairsInSegments(segs) {
  if (segs.length === 0) return segs;
  let result  = [...segs];
  let changed = true;

  while (changed) {
    changed = false;
    const out = [];
    for (let i = 0; i < result.length; i++) {
      const cur  = result[i];
      const next = result[i + 1] ?? null;
      if (!next) { out.push(cur); continue; }

      const curWords  = cur.text.trim().split(/\s+/).filter(Boolean);
      const nextWords = next.text.trim().split(/\s+/).filter(Boolean);
      const lastWord  = curWords[curWords.length - 1]?.toLowerCase() ?? "";
      const firstWord = nextWords[0]?.toLowerCase() ?? "";
      const isSticky  = STICKY_PAIRS.some(([a, b]) => a === lastWord && b === firstWord);
      if (!isSticky) { out.push(cur); continue; }

      const gap     = next.startTime - cur.endTime;
      const merged  = [...curWords, ...nextWords].join(" ");
      const tooLong = merged.split(/\s+/).length > SPLIT_MAX_WORDS;
      if (gap > BOUNDARY_MERGE_MAX_GAP_S || tooLong) { out.push(cur); continue; }

      out.push({
        ...cur,
        endTime:      next.endTime,
        text:         merged,
        _vttAligned:  cur._vttAligned || next._vttAligned || false,
        _stickyFixed: true,
      });
      i++;
      changed = true;
    }
    result = out;
  }

  return result;
}

// ── applyBoundaryPolish ───────────────────────────────────────────────────────
function applyBoundaryPolish(segs) {
  if (segs.length === 0) return segs;
  let result  = [...segs];
  let changed = true;

  while (changed) {
    changed = false;
    const out = [];
    for (let i = 0; i < result.length; i++) {
      const cur  = result[i];
      const next = result[i + 1] ?? null;

      const curWords  = cur.text.trim().split(/\s+/).filter(Boolean);
      const firstWord = curWords[0]?.toLowerCase()                   ?? "";
      const lastWord  = curWords[curWords.length - 1]?.toLowerCase() ?? "";
      const isProtected = SPEAKER_CHANGE_RE.test(cur.text.trim());

      if (!isProtected && BOUNDARY_START_WORDS.has(firstWord) && out.length > 0) {
        const prev      = out[out.length - 1];
        const gap       = cur.startTime - prev.endTime;
        const merged    = prev.text.trim() + " " + cur.text.trim();
        const wordCount = merged.split(/\s+/).length;
        if (gap < BOUNDARY_MERGE_MAX_GAP_S && wordCount <= SPLIT_MAX_WORDS) {
          out[out.length - 1] = { ...prev, endTime: cur.endTime, text: merged, _boundaryPolish: true };
          changed = true;
          continue;
        }
      }

      if (!isProtected && BOUNDARY_END_WORDS.has(lastWord) && next !== null) {
        const gap       = next.startTime - cur.endTime;
        const merged    = cur.text.trim() + " " + next.text.trim();
        const wordCount = merged.split(/\s+/).length;
        if (gap < BOUNDARY_MERGE_MAX_GAP_S && wordCount <= SPLIT_MAX_WORDS) {
          out.push({ ...cur, endTime: next.endTime, text: merged, _boundaryPolish: true });
          i++;
          changed = true;
          continue;
        }
      }

      out.push(cur);
    }
    result = out;
  }

  return result;
}

// ── applyConfidenceFilter ─────────────────────────────────────────────────────
function applyConfidenceFilter(segs) {
  if (segs.length === 0) return segs;
  let result  = [...segs];
  let changed = true;

  while (changed) {
    changed = false;
    const out = [];

    for (let i = 0; i < result.length; i++) {
      const cur      = result[i];
      const next     = result[i + 1] ?? null;
      const curWords = cur.text.trim().split(/\s+/).filter(Boolean);
      const curNorm  = cur.text.trim().toLowerCase();

      const isProtected    = SPEAKER_CHANGE_RE.test(cur.text.trim());
      const isShortGarbage = !cur._vttAligned && curWords.length <= CONF_MAX_WORDS;
      const isStopPhrase   = !cur._vttAligned && LOW_INFORMATION_PHRASES.has(curNorm);

      if (!isProtected && isStopPhrase) {
        const prevGap = out.length > 0 ? cur.startTime - out[out.length - 1].endTime : Infinity;
        const nextGap = next ? next.startTime - cur.endTime : Infinity;
        const isStandalone = prevGap > CONF_STANDALONE_GAP_S && nextGap > CONF_STANDALONE_GAP_S;
        if (isStandalone) { out.push(cur); continue; }
      }

      const isGarbage = !isProtected && (isShortGarbage || isStopPhrase);
      if (!isGarbage) { out.push(cur); continue; }

      const prevGap = out.length > 0 ? cur.startTime - out[out.length - 1].endTime : Infinity;
      const nextGap = next ? next.startTime - cur.endTime : Infinity;

      if (out.length > 0 && prevGap < CONF_MAX_GAP_S) {
        const prev   = out[out.length - 1];
        const merged = prev.text.trim() + " " + cur.text.trim();
        if (merged.split(/\s+/).length <= SPLIT_MAX_WORDS) {
          out[out.length - 1] = { ...prev, endTime: cur.endTime, text: merged };
          changed = true;
          continue;
        }
      }

      if (next && nextGap < CONF_MAX_GAP_S) {
        const merged = cur.text.trim() + " " + next.text.trim();
        if (merged.split(/\s+/).length <= SPLIT_MAX_WORDS) {
          out.push({ ...cur, endTime: next.endTime, text: merged });
          i++;
          changed = true;
          continue;
        }
      }

      out.push(cur);
    }

    result = out;
  }

  return result;
}

// ── alignVttTextToJson3Timing ─────────────────────────────────────────────────
function alignVttTextToJson3Timing(json3Segs, vttSegs) {
  if (json3Segs.length === 0) return json3Segs;
  if (vttSegs.length === 0)   return json3Segs;

  const consumedFrac = new Map();

  return json3Segs.map((j3) => {
    const j3Duration  = j3.endTime - j3.startTime;
    const j3WordsOrig = j3.text.trim().split(/\s+/).filter(Boolean);

    if (SPEAKER_CHANGE_RE.test(j3.text.trim())) return j3;

    const candidates = [];
    for (let vi = 0; vi < vttSegs.length; vi++) {
      const vtt          = vttSegs[vi];
      const overlapStart = Math.max(j3.startTime, vtt.startTime);
      const overlapEnd   = Math.min(j3.endTime,   vtt.endTime);
      const overlap      = overlapEnd - overlapStart;
      if (overlap <= 0) continue;
      const overlapRatio = j3Duration > 0 ? overlap / j3Duration : 0;
      if (overlapRatio < ALIGN_OVERLAP_RATIO_MIN) continue;
      candidates.push({ vi, vtt, overlap, overlapRatio });
    }

    if (candidates.length === 0) return j3;

    if (candidates.length === 1) {
      const { vi, vtt } = candidates[0];
      const vttWords  = vtt.text.trim().split(/\s+/).filter(Boolean);
      const vttDur    = vtt.endTime - vtt.startTime;
      const startFrac = consumedFrac.get(vi) ?? 0;

      const localStart = vttDur > 0
        ? Math.max(startFrac, (j3.startTime - vtt.startTime) / vttDur) : startFrac;
      const localEnd   = vttDur > 0
        ? Math.min(1, (j3.endTime - vtt.startTime) / vttDur) : 1;

      const wordStart   = Math.round(localStart * vttWords.length);
      const wordEnd     = Math.round(localEnd   * vttWords.length);
      let   slicedWords = vttWords.slice(wordStart, Math.max(wordEnd, wordStart + 1));

      consumedFrac.set(vi, localEnd);

      if (slicedWords.length === 0) return j3;
      if (slicedWords.length > SPLIT_MAX_WORDS) return j3;

      const textRatio = slicedWords.length / Math.max(j3WordsOrig.length, 1);
      if (textRatio > TEXT_RATIO_MAX || textRatio < TEXT_RATIO_MIN) return j3;

      slicedWords = snapToBestSubsequence(vttWords, slicedWords, j3WordsOrig);
      return { ...j3, text: slicedWords.join(" "), _vttAligned: true };
    }

    const slicedParts = [];
    for (const { vi, vtt } of candidates) {
      const vttWords = vtt.text.trim().split(/\s+/).filter(Boolean);
      if (vttWords.length === 0) continue;

      const vttDur    = vtt.endTime - vtt.startTime;
      const startFrac = consumedFrac.get(vi) ?? 0;

      const localStart = vttDur > 0
        ? Math.max(startFrac, (j3.startTime - vtt.startTime) / vttDur) : startFrac;
      const localEnd   = vttDur > 0
        ? Math.min(1, (j3.endTime - vtt.startTime) / vttDur) : 1;

      if (localEnd <= localStart) continue;

      const wordStart = Math.round(localStart * vttWords.length);
      const wordEnd   = Math.round(localEnd   * vttWords.length);
      let   sliced    = vttWords.slice(wordStart, Math.max(wordEnd, wordStart + 1));
      sliced = snapToBestSubsequence(vttWords, sliced, j3WordsOrig);

      if (sliced.length > 0) {
        slicedParts.push(...sliced);
        consumedFrac.set(vi, localEnd);
      }
    }

    if (slicedParts.length === 0) return j3;
    if (slicedParts.length > SPLIT_MAX_WORDS) return j3;

    const textRatio = slicedParts.length / Math.max(j3WordsOrig.length, 1);
    if (textRatio > TEXT_RATIO_MAX || textRatio < TEXT_RATIO_MIN) return j3;

    return { ...j3, text: slicedParts.join(" "), _vttAligned: true, _vttSplit: true };
  });
}

// ── selectBestSegments ────────────────────────────────────────────────────────
function selectBestSegments(json3Segs, vttSegs) {
  if (!vttSegs || vttSegs.length === 0) {
    const result = applyPostProcess(json3Segs);
    return { segments: result, hybridUsed: false, scoreJson3: 0, scoreVtt: 0 };
  }

  const minVttCount = Math.floor(json3Segs.length * VTT_MIN_SEGMENT_RATIO);
  if (vttSegs.length < minVttCount) {
    console.log(`[HYBRID] VTT 세그먼트 수 부족 (${vttSegs.length} < ${minVttCount}) → JSON3 사용`);
    const result = applyPostProcess(json3Segs);
    return { segments: result, hybridUsed: false, scoreJson3: 0, scoreVtt: 0 };
  }

  const scoreJson3  = scoreSegmentText(json3Segs);
  const anchoredVtt = applyPunctuationAnchors(vttSegs);
  const clampedVtt  = clampVttSegments(anchoredVtt);
  const scoreVtt    = scoreSegmentText(clampedVtt);

  console.log(`[HYBRID] 텍스트 품질 — JSON3: ${scoreJson3}, VTT: ${scoreVtt}`);

  if (scoreVtt > scoreJson3 + 10) {
    let aligned = alignVttTextToJson3Timing(json3Segs, clampedVtt);

    const alignedCount = aligned.filter(s => s._vttAligned).length;
    const splitCount   = aligned.filter(s => s._vttSplit).length;
    console.log(
      `[HYBRID] VTT 텍스트 채택: aligned ${alignedCount}/${json3Segs.length}` +
      (splitCount > 0 ? `, split mapping ${splitCount}개` : "")
    );

    aligned = applyPostProcess(aligned);
    return { segments: aligned, hybridUsed: true, scoreJson3, scoreVtt };
  }

  console.log(`[HYBRID] JSON3 텍스트 유지 (점수 차이 미달)`);
  const result = applyPostProcess(json3Segs);
  return { segments: result, hybridUsed: false, scoreJson3, scoreVtt };
}

// ── applyPostProcess ──────────────────────────────────────────────────────────
function applyPostProcess(segs) {
  let out = fixStickyPairsInSegments(segs);
  out = applyBoundaryPolish(out);
  out = applyConfidenceFilter(out);
  return out;
}

// ── yt-dlp runner ─────────────────────────────────────────────────────────────
/**
 * [MULTILINGUAL] 파일 선택 전략:
 *
 *   json3 우선순위: langJson3 → en.json3 → en-orig.json3 → 아무 json3
 *   vtt  우선순위: langVtt   → en.vtt   → 아무 vtt
 *
 *   useWordLevel 조건 (v28 수정):
 *     - en.json3 파일이 선택된 경우에만 후보
 *     - langJson3가 없어야 함 (비영어 요청에서 en fallback은 word-level 미사용)
 *     - isASR === true 이어야 함  ← [BUGFIX] 수동자막 오진입 방지
 *
 *   비영어 언어 처리:
 *     - langJson3 존재 시: parseJson3ASR 또는 parseJson3ByEvent (isASR 기준)
 *     - langJson3 없이 en fallback: useWordLevel=false, 동일 경로
 *     - MANUAL-BYPASS: 언어 무관, isManualCaption && vttScore >= 40 이면 VTT 직접 사용
 */
async function runYtDlp(videoId, lang) {
  const sessionId      = randomBytes(8).toString("hex");
  // FIX 4: Use forward slashes so MINGW64/Git Bash and yt-dlp both handle the
  // path correctly. join() produces backslashes on Windows; replace them here.
  const outputTemplate = join(tmpdir(), `rtsub_${sessionId}_%(id)s`)
    .replace(/\\/g, "/");

  // 다국어 요청: 요청 언어 우선, en 폴백
  const isEnglish = !lang || lang === "en";
  const langPref  = isEnglish
    ? "en.*"
    : `${lang}.*,en.*`;

  // Use the yt_dlp Python API directly to avoid the Windows/deno TTY issue
  // that causes spawn('yt-dlp') to never fire the 'close' event.
  const scriptPath = fileURLToPath(new URL("./ytdlp_fetch.py", import.meta.url));

  console.log(`[yt-dlp] cmd: python3.11 ${scriptPath} ${videoId} ${lang ?? "en"} ${outputTemplate}`);
  console.log(`[yt-dlp] videoId=${videoId} lang=${lang}`);

  const _ytdlpSpawnMs = Date.now();
  console.log(`[YTDLP-SPAWN] videoId=${videoId}, lang=${lang ?? "en"}, ${_ytdlpTs()}`);

  return new Promise((resolve) => {
    const proc = spawn(process.env.PYTHON_PATH || "C:\\Program Files\\Python311\\python.exe", [
      "-u",
      scriptPath,
      videoId,
      lang ?? "en",
      outputTemplate,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => {
      console.error(`[yt-dlp] spawn error: ${err.message}`);
      resolve(null);
    });

    // Hard kill-timeout so a hung process never becomes a zombie.
    // Cleared immediately when the process closes normally.
    const killTimer = setTimeout(() => {
      console.error("[yt-dlp] hard timeout 120s — killing process");
      console.error(`[YTDLP-KILL-TIMEOUT] videoId=${videoId}, elapsedMs=${Date.now() - _ytdlpSpawnMs}, ${_ytdlpTs()}`);
      proc.kill("SIGKILL");
    }, 120_000);

    proc.on("close", async (code) => {
      clearTimeout(killTimer);
      console.log(
        `[yt-dlp] exited code=${code}${stderr ? ` stderr=${stderr.substring(0, 200)}` : ""}`
      );

      // Parse the JSON result written to stdout by ytdlp_fetch.py.
      // A { success: false } result means yt-dlp threw an exception — return
      // the structured error immediately before attempting any file I/O.
      let pyResult = null;
      try {
        pyResult = JSON.parse(stdout.trim());
      } catch (e) {
        console.warn(`[yt-dlp] stdout JSON parse error: ${e.message} raw="${stdout.substring(0, 200)}"`);
        console.warn(`[YTDLP-STDOUT-PARSE-FAIL] videoId=${videoId}, errMsg=${String(e.message).slice(0, 100)}, elapsedMs=${Date.now() - _ytdlpSpawnMs}, ${_ytdlpTs()}`);
      }
      if (pyResult && !pyResult.success) {
        const detail = pyResult.error ?? `yt-dlp exited with code ${code}`;
        console.error(`[yt-dlp] Python script reported failure: "${detail}"`);
        console.error(`[YTDLP-PY-FAIL] videoId=${videoId}, exitCode=${code}, detail=${String(detail).slice(0, 200)}, elapsedMs=${Date.now() - _ytdlpSpawnMs}, ${_ytdlpTs()}`);
        resolve({ ytdlpError: true, detail });
        return;
      }

      // Fast-fail on any non-zero exit not already caught above.
      if (code !== 0) {
        const firstLine = stderr.split("\n").find(l => l.trim().length > 0) ?? `yt-dlp exited with code ${code}`;
        console.error(`[yt-dlp] non-zero exit — network or yt-dlp error: "${firstLine}"`);
        console.error(`[YTDLP-NONZERO-EXIT] videoId=${videoId}, exitCode=${code}, firstStderr=${String(firstLine).slice(0, 200)}, elapsedMs=${Date.now() - _ytdlpSpawnMs}, ${_ytdlpTs()}`);
        resolve({ ytdlpError: true, detail: firstLine });
        return;
      }

      try {
        const tmp      = tmpdir();
        const allFiles = await readdir(tmp);
        const prefix   = `rtsub_${sessionId}_${videoId}`;
        const subFiles = allFiles
          .filter((f) => f.startsWith(prefix) && (f.endsWith(".json3") || f.endsWith(".vtt")))
          .map((f) => join(tmp, f));

        if (subFiles.length === 0) {
          console.log(`[yt-dlp] no subtitle files found (videoId=${videoId})`);
          console.log(`[YTDLP-NO-FILES] videoId=${videoId}, elapsedMs=${Date.now() - _ytdlpSpawnMs}, ${_ytdlpTs()}`);
          resolve(null);
          return;
        }

        // ── 파일 선택 헬퍼 ─────────────────────────────────────────────────
        const pickFile = (files, langCode) =>
          files.find((f) => {
            const base = f.split(/[/\\]/).pop();
            return new RegExp(`\\.${langCode}(?:\\.|$)`).test(base);
          });

        const json3Files = subFiles.filter(f => f.endsWith(".json3"));
        const vttFiles   = subFiles.filter(f => f.endsWith(".vtt"));

        // 요청 언어 파일
        const langJson3File = !isEnglish ? pickFile(json3Files, lang) : null;
        const langVttFile   = !isEnglish ? pickFile(vttFiles,   lang) : null;

        // 영어 파일 (fallback 포함)
        const enJson3File   = pickFile(json3Files, "en");
        const enOrigFile    = pickFile(json3Files, "en-orig");
        const enVttFile     = pickFile(vttFiles,   "en");

        // 최종 선택
        const chosenJson3 = langJson3File ?? enJson3File ?? enOrigFile ?? json3Files[0] ?? null;
        const chosenVtt   = langVttFile   ?? enVttFile   ?? vttFiles[0]  ?? null;

        console.log(
          `[YTDLP-FILE-SELECT] videoId=${videoId}, ` +
          `json3=${chosenJson3?.split(/[/\\]/).pop() ?? "none"}, ` +
          `vtt=${chosenVtt?.split(/[/\\]/).pop() ?? "none"}, ` +
          `totalFiles=${subFiles.length}, ` +
          `elapsedMs=${Date.now() - _ytdlpSpawnMs}, ` +
          `${_ytdlpTs()}`
        );

        if (!chosenJson3 && !chosenVtt) {
          console.log(`[yt-dlp] no usable subtitle files (videoId=${videoId})`);
          resolve(null);
          return;
        }

        // 감지된 언어 코드 추출
        const langMatch = (chosenJson3 ?? chosenVtt)
          .split(/[/\\]/).pop()
          .match(/\.([a-zA-Z]{2,}(?:-[a-zA-Z0-9]+)*)\.(?:json3|vtt)$/);
        const detectedLang = langMatch ? langMatch[1] : (lang ?? "en");

        const json3Content = chosenJson3 ? await readFile(chosenJson3, "utf8") : null;
        const vttContent   = chosenVtt   ? await readFile(chosenVtt,   "utf8") : null;

        await Promise.allSettled(subFiles.map((f) => unlink(f)));

        let json3Segs       = null;
        let isManualCaption = false;

        if (json3Content) {
          try {
            const json3  = JSON.parse(json3Content);
            const events = json3.events ?? [];
            const isASR  = isSlidingWindow(events);
            isManualCaption = !isASR;

            // ── [BUGFIX v28] useWordLevel: ASR이고 en.json3 선택이고 lang 파일 없을 때만 ──
            // 수동자막(isASR=false)은 word-offset이 없으므로 반드시 제외.
            // 비영어 langJson3이 있으면 해당 언어 그대로 처리 (word-level 미지원).
            const useWordLevel =
              isASR &&
              !langJson3File &&
              (chosenJson3 === enJson3File || chosenJson3 === enOrigFile);

            console.log(
              `[yt-dlp] lang=${detectedLang} isASR=${isASR} isManual=${isManualCaption}` +
              ` useWordLevel=${useWordLevel} chosenJson3=${chosenJson3?.split(/[/\\]/).pop()}`
            );

            if (useWordLevel) {
              const rawSegs = parseJson3WordLevel(json3);
              console.log(`[yt-dlp] parser: Word-Level (en.json3 ASR) raw=${rawSegs.length}`);
              if (rawSegs.length > 0) {
                const preSegs = premergeRawSegments(rawSegs);
                console.log(`[BDS-PRE] premerge: ${rawSegs.length} → ${preSegs.length} segments`);
                preSegs.forEach((s, idx) => {
                  console.log(
                    `[BDS-PRE] seg[${idx}]` +
                    ` start=${s.startTime?.toFixed(3)}` +
                    ` end=${s.endTime?.toFixed(3)}` +
                    ` hint=${(s._speakerHint ?? 0).toFixed(2)}` +
                    ` text="${s.text?.slice(0, 80)}"`
                  );
                });
                const displaySegs = buildDisplaySegments(preSegs);
                console.log(`[yt-dlp] premerge: ${rawSegs.length} → ${preSegs.length}, display: ${displaySegs.length}`);
                json3Segs = resolveAndCleanSegments(resolveOverlaps(displaySegs));
                console.log(`[yt-dlp] resolveAndClean: ${json3Segs.length} segments`);
              }
            } else {
              // 수동자막 또는 비영어 ASR: event 단위 파싱
              console.log(`[yt-dlp] parser: ${isASR ? "ASR sliding window" : "manual captions"} (lang=${detectedLang})`);
              const eventSegs = isASR ? parseJson3ASR(json3) : parseJson3ByEvent(json3);
              console.log(`[yt-dlp] parseJson3: ${eventSegs.length} segments`);
              if (eventSegs.length > 0) {
                if (isManualCaption) {
                  const merged   = mergeOrphanPhrases(eventSegs, true);
                  console.log(`[MANUAL] mergeOrphanPhrases: ${eventSegs.length} → ${merged.length}`);
                  const resolved = resolveOverlaps(merged);
                  json3Segs = resolveAndCleanSegments(resolved);
                  console.log(`[MANUAL] resolveAndClean: ${resolved.length} → ${json3Segs.length}`);
                } else {
                  const merged = mergeOrphanPhrases(eventSegs);
                  json3Segs    = resolveAndCleanSegments(resolveOverlaps(merged));
                }
              }
            }

            if (json3Segs && json3Segs.length === 0) json3Segs = null;
            console.log(
              `[YTDLP-SEGMENT-PIPELINE] videoId=${videoId}, ` +
              `isASR=${isASR}, ` +
              `isManual=${isManualCaption}, ` +
              `json3Segs=${json3Segs?.length ?? 0}, ` +
              `elapsedMs=${Date.now() - _ytdlpSpawnMs}, ` +
              `${_ytdlpTs()}`
            );
          } catch (e) {
            console.warn(`[yt-dlp] JSON3 parse error: ${e}`);
            console.warn(`[YTDLP-JSON3-PARSE-FAIL] videoId=${videoId}, err=${String(e).slice(0, 150)}, elapsedMs=${Date.now() - _ytdlpSpawnMs}, ${_ytdlpTs()}`);
          }
        }

        let vttSegs = null;
        if (vttContent) {
          const parsed = parseVtt(vttContent);
          if (parsed && parsed.length > 0) {
            vttSegs = parsed;
            console.log(`[yt-dlp] VTT parsed: ${vttSegs.length} segments`);
          }
        }

        let finalSegments = null;

        // [MANUAL-BYPASS] 수동자막 + 양질 VTT → JSON3 파이프라인 건너뛰고 VTT 직접 사용.
        // 언어 무관하게 적용 (ko, ja, zh 등 비영어 수동자막도 동일).
        if (isManualCaption && vttSegs && vttSegs.length > 0) {
          const anchored = applyPunctuationAnchors(vttSegs);
          const clamped  = clampVttSegments(anchored);
          const vttScore = scoreSegmentText(clamped);
          console.log(`[MANUAL-BYPASS] VTT score=${vttScore}, segments=${clamped.length}`);
          if (vttScore >= 40) {
            console.log(`[MANUAL-BYPASS] VTT quality sufficient — using VTT directly`);
            finalSegments = clamped;
          } else {
            console.log(`[MANUAL-BYPASS] VTT score too low (${vttScore} < 40) — falling through`);
          }
        }

        if (finalSegments === null) {
          if (json3Segs && json3Segs.length > 0) {
            const { segments, hybridUsed, scoreJson3, scoreVtt } =
              selectBestSegments(json3Segs, vttSegs);
            finalSegments = segments;
            console.log(
              `[HYBRID] 결과: ${hybridUsed ? "VTT 텍스트 채택" : "JSON3 유지"} ` +
              `(JSON3=${scoreJson3}, VTT=${scoreVtt})`
            );
          } else if (vttSegs && vttSegs.length > 0) {
            console.log(`[yt-dlp] JSON3 없음 → VTT 단독 (clamp 보정 적용)`);
            finalSegments = clampVttSegments(vttSegs);
          }
        }

        if (!finalSegments || finalSegments.length === 0) {
          console.log(`[YTDLP-SEGMENT-EMPTY] videoId=${videoId}, json3Segs=${json3Segs?.length ?? 0}, vttSegs=${vttSegs?.length ?? 0}, elapsedMs=${Date.now() - _ytdlpSpawnMs}, ${_ytdlpTs()}`);
          resolve(null);
          return;
        }

        console.log(`[yt-dlp] success: ${finalSegments.length} segments, lang=${detectedLang}`);
        resolve({ segments: finalSegments, language: detectedLang, source: "yt-dlp" });
      } catch (e) {
        console.error(`[yt-dlp] file handling error: ${e}`);
        console.error(`[YTDLP-FILE-IO-ERROR] videoId=${videoId}, err=${String(e).slice(0, 200)}, elapsedMs=${Date.now() - _ytdlpSpawnMs}, ${_ytdlpTs()}`);
        resolve(null);
      }
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/subtitles", async (req, res) => {
  const { videoId, lang = "en" } = req.query;
  const userPlan = req.headers['x-user-plan'] ?? null;

  if (!videoId || typeof videoId !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Missing or invalid videoId" });
  }

  // 다국어 lang 코드 유효성: 2~8자 알파벳 + 선택적 서브태그 (ko, zh-Hans, pt-BR 등)
  const safeLang = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(lang) ? lang : "en";
  const cacheKey = `${videoId}:${safeLang}`;
  const cached   = getCached(cacheKey);

  if (cached) {
    console.log(`[YTDLP-CACHE-HIT] videoId=${videoId}, lang=${safeLang}, segments=${cached.segments?.length ?? 0}, ${_ytdlpTs()}`);
    console.log(`[SUBTITLE] cache hit: videoId=${videoId} lang=${safeLang}`);
    return res.json({ segments: cached.segments, language: cached.language, source: cached.source });
  }

  console.log(`[SUBTITLE] yt-dlp fetch: videoId=${videoId} lang=${safeLang}`);
  console.log(
    `[YTDLP-PLAN-GATE] videoId=${videoId}, plan=${userPlan ?? "none"}, ` +
    `lang=${safeLang}, ${_ytdlpTs()}`
  );
  if (!userPlan) {
    console.warn(
      `[YTDLP-PLAN-MISSING] videoId=${videoId}, lang=${safeLang}, ` +
      `reason=untagged_free_or_bg, note=missing_header_does_not_imply_free_only, ` +
      `${_ytdlpTs()}`
    );
  }

  try {
    const result = await runYtDlp(videoId, safeLang);

    // yt-dlp returned a structured error (non-zero exit / network failure).
    // Return 502 immediately so the client gets a real error response
    // instead of waiting for the 30 s AbortController to fire.
    if (result && result.ytdlpError) {
      console.error(
        `[SUBTITLE] yt-dlp network failure for videoId=${videoId}: ${result.detail}`
      );
      return res.status(502).json({
        error: "yt-dlp network failure",
        detail: result.detail,
      });
    }

    if (!result || result.segments.length === 0) {
      return res.status(500).json({ error: "No subtitles available for this video" });
    }

    subtitleCache.set(cacheKey, { ...result, cachedAt: Date.now() });
    console.log(`[SUBTITLE] success: videoId=${videoId} segments=${result.segments.length} lang=${result.language}`);
    return res.json(result);
  } catch (e) {
    console.error(`[SUBTITLE] unexpected error: ${e}`);
    return res.status(500).json({ error: "Subtitle fetch failed" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/cache/clear", (req, res) => {
  const { videoId } = req.query;
  if (videoId && typeof videoId === "string") {
    let removed = 0;
    for (const key of subtitleCache.keys()) {
      if (key.startsWith(`${videoId}:`)) { subtitleCache.delete(key); removed++; }
    }
    console.log(`[CACHE] cleared ${removed} entries for videoId=${videoId}`);
    return res.json({ cleared: removed, videoId });
  }
  const total = subtitleCache.size;
  subtitleCache.clear();
  console.log(`[CACHE] cleared all ${total} entries`);
  return res.json({ cleared: total });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`[SERVER] Python path: ${process.env.PYTHON_PATH || "C:\\Program Files\\Python311\\python.exe (default)"}`);
  console.log(`[SUBTITLE] server listening on http://${HOST}:${PORT}`);
  console.log(`[SUBTITLE] endpoints:`);
  console.log(`           GET /subtitles?videoId=VIDEO_ID[&lang=en|ko|ja|zh|fr|de|es|...]`);
  console.log(`           GET /health`);
  console.log(`           GET /cache/clear[?videoId=VIDEO_ID]`);
});