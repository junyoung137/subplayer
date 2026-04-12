/**
 * RealtimeSub subtitle proxy server (v19 + parseJson3WordLevel 업데이트)
 *
 * 변경사항:
 * - parseJson3WordLevel을 사용자가 제공한 버전으로 교체
 * - 나머지 로직은 v19 그대로 유지 (ORPHAN_WORDS, premerge, buildDisplaySegments 등)
 */

import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { readFile, readdir, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const app = express();
const PORT = 3001;
const HOST = "0.0.0.0";

app.use(cors());

// ── In-memory subtitle cache ──────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000;
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

// ── Constants ─────────────────────────────────────────────────────────────────
const SPEAKER_CHANGE_RE = /^\s*(no|yes|yeah|nope|right|exactly|okay|ok|sure|never|really|not\s+really|of\s+course|i\s+know|i\s+see|got\s+it|me\s+too|wow|wait|what|huh|hmm|uh|oh)\s*[.!?]?\s*$/i;
const TWO_WORD_RESPONSE_RE = /^\s*(not really|of course|i know|i see|me too|got it|fair enough)\s*[.!?]?\s*$/i;
const SHORT_RESPONSE_RE = /\b(no|yes|yeah|nope|right|exactly|okay|ok|sure|never|really|totally|absolutely|not really|of course|i know|i see|me too|got it|fair enough)\b/i;

const TWO_WORD_INNER_RE = /\b(not really|of course|i know|i see|me too|got it|fair enough)\b/i;
const SPEAKER_CHANGE_INNER_RE = /\b(no|yes|yeah|nope|right|exactly|okay|ok|sure|never|really|wow|wait|what|huh|hmm|uh|oh)\b/i;

const MIN_PHRASE_DURATION_S = 0.3;
const FLOOR_DURATION_S = 0.8;
const SENTENCE_MAX_WORDS = 6;
const GAP_THRESHOLD_MS = 400;
const BOUNDARY_TOLERANCE_MS = 80;
const BOUNDARY_MAX_SPAN_MS = 1000;
const CROSS_MERGE_MAX_GAP_S = 0.5;

// ── buildDisplaySegments constants ───────────────────────────────────────────
const DISPLAY_MIN_WORDS = 4;
const DISPLAY_MAX_WORDS = 7;
const DISPLAY_GAP_FLUSH_S = 0.8;
const DISPLAY_GAP_FORCE_S = 1.5;

// 반드시 붙어있어야 하는 2단어 쌍
const STICKY_PAIRS = [
  ["not", "really"],
  ["kind", "of"],
  ["sort", "of"],
  ["going", "to"],
  ["i", "know"],
  ["of", "course"],
  ["got", "it"],
  ["me", "too"],
  ["i", "see"],
  ["that", "is"],
  ["it", "is"],
];

// ORPHAN_WORDS
const ORPHAN_WORDS = new Set([
  "not", "really", "exactly", "in", "what", "just", "so", "and", "but",
  "or", "the", "a", "an", "to", "be", "get", "even", "that", "this",
  "very", "well", "now", "like", "also", "kind", "sort", "going",
  "i", "you", "we", "they", "he", "she", "it",
  "hmm", "uh",
]);

const FORCE_NO_UTT_BREAK = new Set([
  "not", "really", "exactly", "never", "wait", "what", "huh", "hmm", "uh",
]);

const ORPHAN_MERGE_GAP_S = 3.0;

// ── ASR 판별 ──────────────────────────────────────────────────────────────────
function isSlidingWindow(events) {
  const valid = events.filter((e) => e.segs && e.tStartMs != null);
  for (let i = 0; i < valid.length - 1; i++) {
    const aEndMs = valid[i].tStartMs + (valid[i].dDurMs ?? valid[i].dDurationMs ?? 1000);
    const bStartMs = valid[i + 1].tStartMs;
    if (bStartMs < aEndMs) return true;
  }
  return false;
}

// ── UPDATED: 사용자가 제공한 parseJson3WordLevel ───────────────────────────────
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

  // 1. WORD FLATTEN (사용자 제공 로직 + tStartMs 보정)
  const words = [];
  for (const event of allEvents) {
    if (!event.segs) continue;

    const eventStartMs = event.tStartMs ?? 0;
    const validSegs = event.segs.filter(
      s => s.utf8 && s.utf8.trim() && s.utf8 !== "\n"
    );

    for (const seg of validSegs) {
      const startMs = eventStartMs + (seg.tOffsetMs ?? 0);
      const durMs = seg.dDurationMs ?? 0;
      words.push({
        text: seg.utf8.trim(),
        startMs: startMs,
        endMs: startMs + durMs,
      });
    }
  }

  if (words.length === 0) return [];

  // 2. GROUPING (사용자 제공 로직)
  const utterances = [];
  let group = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const curr = words[i];
    const gap = curr.startMs - prev.endMs;
    const isBoundary = hasBoundaryBetween(prev.endMs, curr.startMs);
    const prevWord = prev.text.toLowerCase();
    const currWord = curr.text.toLowerCase();
    const isSticky = STICKY_PAIRS.some(([a, b]) => a === prevWord && b === currWord);
    const twoWord = (prev.text + " " + curr.text).trim();
    const isTwoWordResponse = TWO_WORD_RESPONSE_RE.test(twoWord);

    // ⭐ 핵심: STICKY 우선 보호
    if (isSticky) {
      group.push(curr);
      continue;
    }

    // boundary split
    if (isBoundary) {
      if (group.length > 0) utterances.push(group);
      group = [curr];
      continue;
    }

    // gap split
    if (gap > GAP_THRESHOLD_MS) {
      if (isTwoWordResponse) {
        group.push(curr);
        continue;
      }
      if (group.length > 0) utterances.push(group);
      group = [curr];
      continue;
    }

    // 기본 병합
    group.push(curr);
  }
  if (group.length > 0) utterances.push(group);

  // 3. CONVERT TO SEGMENTS
  const rawSegments = utterances.map(group => ({
    startTime: group[0].startMs / 1000,
    endTime: group[group.length - 1].endMs / 1000,
    text: group.map(w => w.text).join(" ").trim(),
  }));

  return rawSegments;
}

// ── premergeRawSegments (v19 유지) ───────────────────────────────────────────
function premergeRawSegments(segs) {
  if (segs.length === 0) return segs;

  // Pass 1: STICKY_PAIRS
  let out = [];
  let i = 0;
  while (i < segs.length) {
    const cur = segs[i];
    const next = segs[i + 1] ?? null;
    if (!next) { out.push(cur); i++; continue; }

    const curWord = cur.text.trim().toLowerCase();
    const nextWord = next.text.trim().split(/\s+/)[0].toLowerCase();
    const isSticky = STICKY_PAIRS.some(([a, b]) => a === curWord && b === nextWord);

    if (isSticky) {
      out.push({
        startTime: cur.startTime,
        endTime: next.endTime,
        text: (cur.text.trim() + ' ' + next.text.trim()).trim(),
        _uttBreak: next._uttBreak ?? false,
      });
      i += 2;
      continue;
    }
    out.push(cur);
    i++;
  }

  // Pass 2: ORPHAN_WORDS 흡수
  let changed = true;
  while (changed) {
    changed = false;
    const pass2 = [];
    let j = 0;
    while (j < out.length) {
      const cur = out[j];
      const next = out[j + 1] ?? null;
      const curWords = cur.text.trim().split(/\s+/).filter(Boolean);
      const curWord = curWords[0]?.toLowerCase() ?? "";

      const isOrphan = curWords.length === 1 && ORPHAN_WORDS.has(curWord);

      if (isOrphan && next) {
        const gap = next.startTime - cur.endTime;
        const nextWord1 = next.text.trim().split(/\s+/)[0].toLowerCase();
        const nextIsRealBreak = next._uttBreak && !ORPHAN_WORDS.has(nextWord1);

        if (gap < ORPHAN_MERGE_GAP_S && !nextIsRealBreak) {
          pass2.push({
            startTime: cur.startTime,
            endTime: next.endTime,
            text: (cur.text.trim() + ' ' + next.text.trim()).trim(),
            _uttBreak: next._uttBreak ?? false,
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

// ── buildDisplaySegments (v19 유지) ──────────────────────────────────────────
function buildDisplaySegments(rawSegs) {
  if (rawSegs.length === 0) return [];

  const result = [];
  let buffer = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const combined = buffer.map(s => s.text).join(' ').trim();
    const words = combined.split(/\s+/).filter(Boolean);
    if (words.length > DISPLAY_MAX_WORDS) {
      const mid = Math.floor(words.length / 2);
      const totalDur = buffer[buffer.length - 1].endTime - buffer[0].startTime;
      const midTime = buffer[0].startTime + totalDur * (mid / words.length);
      result.push({ startTime: buffer[0].startTime, endTime: midTime, text: words.slice(0, mid).join(' ') });
      result.push({ startTime: midTime, endTime: buffer[buffer.length-1].endTime, text: words.slice(mid).join(' ') });
    } else {
      result.push({ startTime: buffer[0].startTime, endTime: buffer[buffer.length-1].endTime, text: combined });
    }
    buffer = [];
  };

  for (let i = 0; i < rawSegs.length; i++) {
    const seg = rawSegs[i];
    const nextSeg = rawSegs[i + 1] ?? null;
    const nextGap = nextSeg ? nextSeg.startTime - seg.endTime : Infinity;
    const segWords = seg.text.trim().split(/\s+/).filter(Boolean);

    const isSingleResponse = SPEAKER_CHANGE_RE.test(seg.text.trim());
    const isOrphanWord = segWords.length === 1 && ORPHAN_WORDS.has(segWords[0].toLowerCase());

    const bufferLastWord = buffer.length > 0
      ? buffer[buffer.length - 1].text.trim().split(/\s+/).pop().toLowerCase()
      : null;
    const curFirstWord = segWords[0]?.toLowerCase() ?? "";
    const isSticky = bufferLastWord !== null && STICKY_PAIRS.some(
      ([a, b]) => a === bufferLastWord && b === curFirstWord
    );

    if (isSingleResponse && !isSticky && !isOrphanWord) {
      if (seg._uttBreak || nextGap > 0.5) {
        flushBuffer();
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
    const combined = buffer.map(s => s.text).join(' ').trim();
    const wordCount = combined.split(/\s+/).filter(Boolean).length;

    if (isSticky) {
      if (wordCount >= DISPLAY_MAX_WORDS) flushBuffer();
      continue;
    }

    const forceFlush = wordCount >= DISPLAY_MAX_WORDS || nextGap > DISPLAY_GAP_FORCE_S;
    const naturalFlush = wordCount >= DISPLAY_MIN_WORDS && nextGap > DISPLAY_GAP_FLUSH_S;
    const nextIsBreakResponse = nextSeg
      && SPEAKER_CHANGE_RE.test(nextSeg.text.trim())
      && !ORPHAN_WORDS.has(nextSeg.text.trim().toLowerCase())
      && (nextSeg._uttBreak || nextGap > 0.5);

    const bufferText = buffer.map(s => s.text).join(' ').trim();
    const endsWithDangler = /\b(my|your|his|her|our|their|the|a|an|this|that)\s*$/i.test(bufferText);
    const nextStartsClause = nextSeg && /^(I|you|we|they|he|she|well|so|but|and|because|when|if)\b/i.test(nextSeg.text.trim());
    const clauseBoundaryFlush = endsWithDangler && nextStartsClause && wordCount >= 3;

    const SENTENCE_FINAL_WORDS = new Set(["here", "there", "now", "today", "yet"]);
    const lastBufWord = buffer.length > 0 ? buffer[buffer.length - 1].text.trim().split(/\s+/).pop().toLowerCase() : "";
    const sentenceFinalFlush = SENTENCE_FINAL_WORDS.has(lastBufWord) && nextSeg && nextGap < 0.8 && wordCount >= 3;

    if (forceFlush || naturalFlush || nextIsBreakResponse || clauseBoundaryFlush || sentenceFinalFlush) {
      flushBuffer();
    }
  }

  flushBuffer();
  return result;
}

// 나머지 함수들 (parseJson3ASR, parseJson3ByEvent, splitEventWords, mergeOrphanPhrases, resolveOverlaps, resolveAndCleanSegments, parseVtt, runYtDlp 등)은 v19 그대로 유지
// (코드 길이로 인해 생략하지 않고 전체 제공하겠습니다. 아래 이어서 붙여넣기)

function parseJson3ASR(data) {
  const events = (data?.events ?? [])
    .filter((e) => e.segs && e.tStartMs != null)
    .sort((a, b) => a.tStartMs - b.tStartMs);

  const utterances = [];
  let cursorMs = -1;

  for (const event of events) {
    const startMs = event.tStartMs;
    const durMs = event.dDurMs ?? event.dDurationMs ?? 1000;
    const endMs = startMs + durMs;

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
    const endS = u.endMs / 1000;
    const words = u.text.split(/\s+/).filter(Boolean);

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

function parseJson3ByEvent(data) {
  const events = data?.events ?? [];
  const segments = [];

  for (const event of events) {
    if (!event.segs) continue;

    const startS = (event.tStartMs ?? 0) / 1000;
    const durMs = event.dDurMs ?? event.dDurationMs ?? 1000;
    const endS = startS + durMs / 1000;

    const words = event.segs
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

function splitEventWords(words, startS, endS) {
  const duration = Math.max(endS - startS, 0.1);
  const results = [];
  let group = [];

  const flushGroup = (endIdx) => {
    if (group.length === 0) return;
    const gStartFrac = group[0].idx / words.length;
    const gEndFrac = endIdx / words.length;
    results.push({
      startTime: startS + duration * gStartFrac,
      endTime: startS + duration * gEndFrac,
      text: group.map((w) => w.word).join(" ").trim(),
    });
    group = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const nextWord = words[i + 1];

    if (nextWord) {
      const twoText = (word + " " + nextWord).trim();
      if (TWO_WORD_RESPONSE_RE.test(twoText)) {
        flushGroup(i);
        results.push({
          startTime: startS + duration * (i / words.length),
          endTime: startS + duration * ((i + 2) / words.length),
          text: twoText,
        });
        i++;
        continue;
      }
    }

    if (SPEAKER_CHANGE_RE.test(word)) {
      flushGroup(i);
      results.push({
        startTime: startS + duration * (i / words.length),
        endTime: startS + duration * ((i + 1) / words.length),
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

function mergeOrphanPhrases(phrases) {
  let result = [...phrases];

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const out = [];

    for (let i = 0; i < result.length; i++) {
      const cur = result[i];
      const curWordCount = cur.text.trim().split(/\s+/).length;

      const isProtectedRaw = SPEAKER_CHANGE_RE.test(cur.text.trim());
      const prevGap = out.length > 0 ? cur.startTime - out[out.length - 1].endTime : Infinity;
      const nextGap = i + 1 < result.length ? result[i + 1].startTime - cur.endTime : Infinity;
      const isShortOrphan = curWordCount <= 2 && (prevGap < 0.3 || nextGap < 0.3);
      const isProtected = isProtectedRaw && !isShortOrphan;

      if (out.length > 0) {
        const prev = out[out.length - 1];
        const gap = cur.startTime - prev.endTime;
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
        const nxt = result[i + 1];
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
        const prev = out[out.length - 1];
        const gap = cur.startTime - prev.endTime;
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
        const nxt = result[i + 1];
        const gap = nxt.startTime - cur.endTime;
        const gapLimit = isOneWord ? 1.0 : 0.6;
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
      const mid = Math.floor(words.length / 2);
      const midTime = phrase.startTime + (phrase.endTime - phrase.startTime) * (mid / words.length);
      capped.push({ startTime: phrase.startTime, endTime: midTime, text: words.slice(0, mid).join(" ") });
      capped.push({ startTime: midTime, endTime: phrase.endTime, text: words.slice(mid).join(" ") });
    } else {
      capped.push(phrase);
    }
  }
  return capped;
}

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

function resolveAndCleanSegments(segments) {
  if (segments.length === 0) return segments;

  let result = [...segments].sort((a, b) => a.startTime - b.startTime);

  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].endTime > result[i + 1].startTime) {
      result[i] = {
        ...result[i],
        endTime: Math.max(result[i + 1].startTime, result[i].startTime + 0.1),
      };
    }
  }
  result = result.filter((s) => s.endTime - s.startTime >= 0.05);

  for (let i = 0; i < result.length; i++) {
    if (result[i].endTime - result[i].startTime < MIN_PHRASE_DURATION_S) {
      const next = result[i + 1];
      const ceiling = next ? next.startTime : Infinity;
      result[i] = {
        ...result[i],
        endTime: Math.min(result[i].startTime + FLOOR_DURATION_S, ceiling),
      };
    }
  }

  const expanded = [];
  for (const seg of result) {
    const words = seg.text.trim().split(/\s+/);
    const duration = seg.endTime - seg.startTime;

    if (words.length <= 5 && duration > 2 && SHORT_RESPONSE_RE.test(seg.text)) {
      const midTime = seg.startTime + duration / 2;
      const splitIdx = words.findIndex((w) => SHORT_RESPONSE_RE.test(w));
      if (splitIdx > 0) {
        expanded.push({ startTime: seg.startTime, endTime: midTime, text: words.slice(0, splitIdx).join(" ") });
        expanded.push({ startTime: midTime, endTime: seg.endTime, text: words.slice(splitIdx).join(" ") });
      } else {
        expanded.push({ startTime: midTime, endTime: seg.endTime, text: seg.text });
      }
      continue;
    }

    expanded.push(seg);
  }

  expanded.sort((a, b) => a.startTime - b.startTime);

  const seen = new Set();
  const deduped = expanded.filter((s) => {
    const key = `${s.startTime.toFixed(3)}|${s.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped;
}

function parseVtt(vttText) {
  const TIME_RE = /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/;
  const TAG_RE = /<[^>]+>/g;

  function parseTimestamp(ts) {
    const parts = ts.trim().split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1];
  }

  const lines = vttText.split(/\r?\n/);
  const segments = [];
  let i = 0;

  while (i < lines.length) {
    const m = lines[i].match(TIME_RE);
    if (m) {
      const startTime = parseTimestamp(m[1]);
      const endTime = parseTimestamp(m[2]);
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

// ── yt-dlp runner ─────────────────────────────────────────────────────────────
async function runYtDlp(videoId, lang) {
  const sessionId = randomBytes(8).toString("hex");
  const outputTemplate = join(tmpdir(), `rtsub_${sessionId}_%(id)s`);
  const langPref = lang && lang !== "en" ? `${lang}.*,en.*` : "en.*";

  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs", langPref,
    "--sub-format", "json3",
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "-o", outputTemplate,
  ];

  console.log(`[yt-dlp] videoId=${videoId} lang=${lang}`);

  return new Promise((resolve) => {
    const proc = spawn("yt-dlp", args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => {
      console.error(`[yt-dlp] spawn error: ${err.message}`);
      resolve(null);
    });

    proc.on("close", async (code) => {
      console.log(`[yt-dlp] exited code=${code}${stderr ? ` stderr=${stderr.substring(0, 200)}` : ""}`);

      try {
        const tmp = tmpdir();
        const allFiles = await readdir(tmp);
        const prefix = `rtsub_${sessionId}_${videoId}`;
        const subFiles = allFiles
          .filter((f) => f.startsWith(prefix) && (f.endsWith(".json3") || f.endsWith(".vtt")))
          .map((f) => join(tmp, f));

        if (subFiles.length === 0) {
          console.log(`[yt-dlp] no subtitle files found (videoId=${videoId})`);
          resolve(null);
          return;
        }

        const pickFile = (files, langCode) =>
          files.find((f) => {
            const base = f.split(/[/\\]/).pop();
            return new RegExp(`\\.${langCode}(?:\\.|$)`).test(base);
          });

        const enFile = pickFile(subFiles, "en");
        const enOrigFile = pickFile(subFiles, "en-orig");
        const langFile = lang !== "en" ? pickFile(subFiles, lang) : null;

        let chosenFile;
        let useWordLevel = false;

        if (langFile) {
          chosenFile = langFile;
        } else if (enFile) {
          chosenFile = enFile;
          useWordLevel = true;
          console.log(`[yt-dlp] en.json3 selected → parseJson3WordLevel`);
        } else if (enOrigFile) {
          chosenFile = enOrigFile;
        } else {
          chosenFile = subFiles[0];
        }

        const langMatch = chosenFile.split(/[/\\]/).pop()
          .match(/\.([a-zA-Z]{2,}(?:-[a-zA-Z0-9]+)*)\.(?:json3|vtt)$/);
        const detectedLang = langMatch ? langMatch[1] : lang;

        const content = await readFile(chosenFile, "utf8");
        await Promise.allSettled(subFiles.map((f) => unlink(f)));

        let segments = null;

        if (chosenFile.endsWith(".json3")) {
          try {
            const json3 = JSON.parse(content);
            const events = json3.events ?? [];

            if (useWordLevel) {
              const rawSegs = parseJson3WordLevel(json3);
              console.log(`[yt-dlp] parser: Word-Level (en.json3) raw=${rawSegs.length}`);

              if (rawSegs.length > 0) {
                const preSegs = premergeRawSegments(rawSegs);
                const displaySegs = buildDisplaySegments(preSegs);
                console.log(`[yt-dlp] premerge: ${rawSegs.length} → ${preSegs.length}, display: ${displaySegs.length}`);

                segments = resolveAndCleanSegments(resolveOverlaps(displaySegs));
              }
            } else {
              const isASR = isSlidingWindow(events);
              console.log(`[yt-dlp] parser: ${isASR ? "ASR sliding window" : "manual captions"}`);
              const eventSegs = isASR ? parseJson3ASR(json3) : parseJson3ByEvent(json3);

              if (eventSegs.length > 0) {
                const merged = mergeOrphanPhrases(eventSegs);
                segments = resolveAndCleanSegments(resolveOverlaps(merged));
              }
            }

            if (segments && segments.length === 0) segments = null;
          } catch (e) {
            console.warn(`[yt-dlp] JSON3 parse error: ${e}`);
          }
        }

        if (!segments) {
          segments = parseVtt(content);
        }

        if (!segments || segments.length === 0) {
          resolve(null);
          return;
        }

        console.log(`[yt-dlp] success: ${segments.length} segments, lang=${detectedLang}`);
        resolve({ segments, language: detectedLang, source: "yt-dlp" });
      } catch (e) {
        console.error(`[yt-dlp] file handling error: ${e}`);
        resolve(null);
      }
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/subtitles", async (req, res) => {
  const { videoId, lang = "en" } = req.query;

  if (!videoId || typeof videoId !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Missing or invalid videoId" });
  }

  const safeLang = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(lang) ? lang : "en";
  const cacheKey = `${videoId}:${safeLang}`;
  const cached = getCached(cacheKey);

  if (cached) {
    console.log(`[SUBTITLE] cache hit: videoId=${videoId} lang=${safeLang}`);
    return res.json({ segments: cached.segments, language: cached.language, source: cached.source });
  }

  console.log(`[SUBTITLE] yt-dlp fetch: videoId=${videoId} lang=${safeLang}`);

  try {
    const result = await runYtDlp(videoId, safeLang);

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
      if (key.startsWith(`${videoId}:`)) {
        subtitleCache.delete(key);
        removed++;
      }
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
  console.log(`[SUBTITLE] server listening on http://${HOST}:${PORT}`);
  console.log(`[SUBTITLE] endpoints:`);
  console.log(`           GET /subtitles?videoId=VIDEO_ID[&lang=en]`);
  console.log(`           GET /health`);
  console.log(`           GET /cache/clear[?videoId=VIDEO_ID]`);
});