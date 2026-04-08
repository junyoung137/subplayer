/**
 * RealtimeSub subtitle proxy server
 *
 * GET /subtitles?videoId=VIDEO_ID[&lang=en]
 *
 * Uses yt-dlp to extract subtitles (manual + auto-generated).
 * Parses JSON3 or VTT into { startTime, endTime, text } segments.
 * Caches results in memory for 1 hour.
 *
 * Prerequisites:
 *   npm install          (in this directory)
 *   yt-dlp in PATH       (https://github.com/yt-dlp/yt-dlp#installation)
 *
 * Run:
 *   npm start            (production)
 *   npm run dev          (with --watch auto-restart)
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
const HOST = "0.0.0.0"; // bind to all interfaces — reachable from physical devices

app.use(cors());

// ── In-memory subtitle cache ──────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** @type {Map<string, { segments: any[], language: string, source: string, cachedAt: number }>} */
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

// ── Subtitle parsers ──────────────────────────────────────────────────────────

/**
 * Parse YouTube JSON3 format into word-level segments using tOffsetMs timing.
 * Each seg entry becomes its own segment so per-word timing is preserved.
 * @param {object} data
 * @returns {{ startTime: number, endTime: number, text: string }[]}
 */
function parseJson3ToSegments(data) {
  const events = data?.events ?? [];
  const wordSegments = [];

  for (const event of events) {
    if (!event.segs) continue;
    const eventStartMs = event.tStartMs ?? 0;
    const eventEndMs   = eventStartMs + (event.dDurMs ?? event.dDurationMs ?? 3000);

    for (let i = 0; i < event.segs.length; i++) {
      const seg  = event.segs[i];
      const text = (seg.utf8 ?? "").replace(/\n/g, " ").trim();
      if (!text) continue;

      const wordStartMs  = eventStartMs + (seg.tOffsetMs ?? 0);
      const nextOffsetMs = event.segs[i + 1]?.tOffsetMs;
      const wordEndMs    = nextOffsetMs != null
        ? eventStartMs + nextOffsetMs
        : eventEndMs;

      wordSegments.push({
        startTime: wordStartMs / 1000,
        endTime:   Math.max(wordEndMs, wordStartMs + 100) / 1000, // min 100ms
        text,
      });
    }
  }

  return wordSegments;
}

/**
 * Group word-level segments into natural phrase segments.
 *
 * Break rules (evaluated in priority order):
 *   Rule 2 — Speaker-change heuristic (highest priority):
 *     If the current word matches SPEAKER_CHANGE_RE (short conversational response)
 *     AND the gap to the previous word is < TIGHT_GAP_S (overlapping speakers),
 *     flush the current group and emit this word as its own standalone phrase.
 *   Rule 1 — Natural pause: gap between words > pauseThreshold seconds.
 *   Rule 3 — Duration cap: adding this word would push the group span > MAX_PHRASE_DURATION_S.
 *   Rule 4 — Word count: group has reached maxWords.
 *
 * Post-grouping:
 *   Rule 4 floor — any phrase with duration < MIN_PHRASE_DURATION_S is extended to
 *     FLOOR_DURATION_S (capped at the next phrase's startTime).
 *   Rule 5 — resolveOverlaps() trims any overlaps created by the extension step.
 *
 * @param {{ startTime: number, endTime: number, text: string }[]} wordSegments
 * @param {number} maxWords
 * @param {number} pauseThreshold  seconds
 * @returns {{ startTime: number, endTime: number, text: string }[]}
 */
function groupWordsIntoPhrases(wordSegments, maxWords = 6, pauseThreshold = 0.4) {
  const phrases = [];
  let group = [];

  /** Flush the current word buffer into phrases. */
  const flush = () => {
    if (group.length === 0) return;
    phrases.push({
      startTime: group[0].startTime,
      endTime:   group[group.length - 1].endTime,
      text:      group.map((w) => w.text).join(" ").trim(),
    });
    group = [];
  };

  for (let i = 0; i < wordSegments.length; i++) {
    const word = wordSegments[i];
    const prev = wordSegments[i - 1];
    const next = wordSegments[i + 1];
    const gap  = prev ? word.startTime - prev.endTime : Infinity;

    // ── Two-word response lookahead ("not really", "of course", etc.) ────────
    // Check current + next word as a combined phrase before the single-word Rule 2.
    if (prev && next) {
      const twoWordText = (word.text + " " + next.text).trim();
      if (TWO_WORD_RESPONSE_RE.test(twoWordText) && gap < TIGHT_GAP_S) {
        flush();
        phrases.push({
          startTime: word.startTime,
          endTime:   next.endTime,
          text:      twoWordText,
        });
        i++; // consume the next word too
        continue;
      }
    }

    // ── Rule 2: single-word speaker-change detection ─────────────────────────
    // Tight gap + response word → different speaker; isolate as micro-phrase.
    if (prev && SPEAKER_CHANGE_RE.test(word.text) && gap < TIGHT_GAP_S) {
      flush();
      phrases.push({ startTime: word.startTime, endTime: word.endTime, text: word.text.trim() });
      continue; // do NOT add to the next group
    }

    // ── Rules 1, 3, 4: pause / duration cap / word count ────────────────────
    const isPause            = gap > pauseThreshold;
    const willExceedDuration = group.length > 0 &&
      (word.endTime - group[0].startTime) > MAX_PHRASE_DURATION_S;
    const isFull             = group.length >= maxWords;

    if ((isPause || willExceedDuration || isFull) && group.length > 0) {
      flush();
    }

    group.push(word);
  }

  flush();

  // ── Rule 4 floor: extend very short phrases so they are readable ──────────
  for (let i = 0; i < phrases.length; i++) {
    if (phrases[i].endTime - phrases[i].startTime < MIN_PHRASE_DURATION_S) {
      const next    = phrases[i + 1];
      const ceiling = next ? next.startTime : Infinity;
      phrases[i] = {
        ...phrases[i],
        endTime: Math.min(phrases[i].startTime + FLOOR_DURATION_S, ceiling),
      };
    }
  }

  // ── Rule 5: resolve any overlaps introduced by the extension step ─────────
  // resolveOverlaps is a hoisted function declaration defined later in this file.
  return resolveOverlaps(phrases);
}

/**
 * Merge orphan phrases (≤ 2 words) into adjacent phrase groups.
 * Runs up to 3 passes until stable, then caps oversized phrases at 10 words.
 * @param {{ startTime: number, endTime: number, text: string }[]} phrases
 * @returns {{ startTime: number, endTime: number, text: string }[]}
 */
function mergeOrphanPhrases(phrases) {
  let result = [...phrases];

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const out = [];

    for (let i = 0; i < result.length; i++) {
      const cur = result[i];
      const curWordCount = cur.text.trim().split(/\s+/).length;

      // Protect speaker-change responses that groupWordsIntoPhrases deliberately isolated.
      // Use a hard 0.2s threshold here (not TIGHT_GAP_S which is wider for detection);
      // a gap this small with a response word means it was a different speaker.
      const MERGE_PROTECT_S  = 0.2;
      const isSpeakerResponse =
        curWordCount <= 2 && SPEAKER_CHANGE_RE.test(cur.text.trim());
      const backGap  = out.length > 0 ? cur.startTime - out[out.length - 1].endTime : Infinity;
      const fwdGap   = i + 1 < result.length ? result[i + 1].startTime - cur.endTime : Infinity;
      const isProtected = isSpeakerResponse &&
        (backGap < MERGE_PROTECT_S || fwdGap < MERGE_PROTECT_S);

      // Try merging current (short) into the previous group
      if (curWordCount <= 2 && out.length > 0 && !isProtected) {
        const prev = out[out.length - 1];
        const gap = cur.startTime - prev.endTime;
        if (gap < 0.4) {
          const merged = (prev.text + ' ' + cur.text).trim();
          if (merged.split(/\s+/).length <= 10) {
            out[out.length - 1] = { startTime: prev.startTime, endTime: cur.endTime, text: merged };
            changed = true;
            continue;
          }
        }
      }

      // Try merging current (short) forward into the next group
      if (curWordCount <= 2 && i + 1 < result.length && !isProtected) {
        const nxt = result[i + 1];
        const gap = nxt.startTime - cur.endTime;
        if (gap < 0.6) {
          const merged = (cur.text + ' ' + nxt.text).trim();
          if (merged.split(/\s+/).length <= 10) {
            out.push({ startTime: cur.startTime, endTime: nxt.endTime, text: merged });
            i++; // consume nxt
            changed = true;
            continue;
          }
        }
      }

      out.push(cur);
    }

    result = out;
    if (!changed) break;
  }

  // Cap oversized phrases at 10 words by splitting at the midpoint
  const capped = [];
  for (const phrase of result) {
    const words = phrase.text.trim().split(/\s+/);
    if (words.length > 10) {
      const mid     = Math.floor(words.length / 2);
      const midTime = phrase.startTime + (phrase.endTime - phrase.startTime) * (mid / words.length);
      capped.push({ startTime: phrase.startTime, endTime: midTime,       text: words.slice(0, mid).join(' ') });
      capped.push({ startTime: midTime,          endTime: phrase.endTime, text: words.slice(mid).join(' ')   });
    } else {
      capped.push(phrase);
    }
  }

  return capped;
}

/**
 * Resolve overlapping segment time ranges.
 * Trims A.endTime to B.startTime for each overlapping consecutive pair.
 * Drops segments whose resolved duration < 0.05s.
 * @param {{ startTime: number, endTime: number, text: string }[]} segments
 * @returns {{ startTime: number, endTime: number, text: string }[]}
 */
function resolveOverlaps(segments) {
  if (segments.length === 0) return segments;

  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);

  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].endTime > sorted[i + 1].startTime) {
      // Floor: keep at least 0.1s so the segment isn't invisible
      sorted[i] = {
        ...sorted[i],
        endTime: Math.max(sorted[i + 1].startTime, sorted[i].startTime + 0.1),
      };
    }
  }

  return sorted.filter((s) => s.endTime - s.startTime >= 0.05);
}

// Short conversational responses that often get buried inside long segments
const SHORT_RESPONSE_RE = /\b(no|yes|yeah|nope|right|exactly|okay|ok|sure|never|really|totally|absolutely|not really|of course|i know|i see|me too|got it|fair enough)\b/i;

// Exact-match version for word-level speaker-change detection in groupWordsIntoPhrases.
// A word matching this regex with a very tight gap to the previous word likely belongs
// to a different speaker (overlapping / back-channel response).
// Allows optional leading/trailing whitespace and a single trailing punctuation mark.
// Used for exact-match on individual word tokens from parseJson3ToSegments.
const SPEAKER_CHANGE_RE = /^\s*(no|yes|yeah|nope|right|exactly|okay|ok|sure|never|really|not\s+really|of\s+course|i\s+know|i\s+see|got\s+it|me\s+too|wow|wait|what|huh|hmm|uh|oh)\s*[.!?]?\s*$/i;

// Two-word back-channel responses that span two consecutive word tokens.
const TWO_WORD_RESPONSE_RE = /^\s*(not really|of course|i know|i see|me too|got it|fair enough)\s*[.!?]?\s*$/i;

const TIGHT_GAP_S           = 0.5;  // JSON3 tOffsetMs words of different speakers often share 0.0s gap
const MAX_PHRASE_DURATION_S = 5.0;  // hard ceiling on how long one phrase may span
const MIN_PHRASE_DURATION_S = 0.3;  // phrases shorter than this get extended
const FLOOR_DURATION_S      = 0.8;  // target duration after extension

/**
 * Comprehensive segment cleaner.
 * Steps:
 *   A  Sort by startTime ascending.
 *   B  Resolve overlapping pairs — trim A.endTime to B.startTime; drop A if < 0.05s.
 *   C  Extract short responses buried in inflated segments (≤ 5 words, duration > 3s,
 *      text matches short-response pattern) → split at time midpoint.
 *   D  Re-sort, deduplicate (same startTime + same text).
 *
 * @param {{ startTime: number, endTime: number, text: string }[]} segments
 * @returns {{ startTime: number, endTime: number, text: string }[]}
 */
function resolveAndCleanSegments(segments) {
  if (segments.length === 0) return segments;

  // ── Step A: sort ──────────────────────────────────────────────────────────
  let result = [...segments].sort((a, b) => a.startTime - b.startTime);

  // ── Step B: resolve overlapping pairs ────────────────────────────────────
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].endTime > result[i + 1].startTime) {
      // Never modify B.startTime — only trim A.endTime, with 0.1s floor
      result[i] = {
        ...result[i],
        endTime: Math.max(result[i + 1].startTime, result[i].startTime + 0.1),
      };
    }
  }
  result = result.filter((s) => s.endTime - s.startTime >= 0.05);

  // ── Step C: extract short responses with inflated time windows ────────────
  const expanded = [];
  for (const seg of result) {
    const words    = seg.text.trim().split(/\s+/);
    const duration = seg.endTime - seg.startTime;

    if (words.length <= 5 && duration > 3 && SHORT_RESPONSE_RE.test(seg.text)) {
      const midTime = seg.startTime + duration / 2;

      // Find the first word that is a short response
      const splitIdx = words.findIndex((w) => SHORT_RESPONSE_RE.test(w));

      if (splitIdx > 0) {
        // There is genuine preceding text — split it off into segment A
        expanded.push({
          startTime: seg.startTime,
          endTime:   midTime,
          text:      words.slice(0, splitIdx).join(' '),
        });
        expanded.push({
          startTime: midTime,
          endTime:   seg.endTime,
          text:      words.slice(splitIdx).join(' '),
        });
      } else {
        // Entire text is the short response — place it in the second half only
        // (first half was leading silence / another speaker)
        expanded.push({
          startTime: midTime,
          endTime:   seg.endTime,
          text:      seg.text,
        });
      }
      continue;
    }

    expanded.push(seg);
  }

  // ── Step D: re-sort, deduplicate ─────────────────────────────────────────
  expanded.sort((a, b) => a.startTime - b.startTime);

  const seen    = new Set();
  const deduped = expanded.filter((s) => {
    const key = `${s.startTime}|${s.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped;
}

/**
 * Parse WebVTT format.
 * Handles both HH:MM:SS.mmm and MM:SS.mmm timestamps.
 * Strips inline VTT tags (<b>, <i>, <ruby>, <c.colorname>, etc).
 * @param {string} vttText
 * @returns {{ startTime: number, endTime: number, text: string }[] | null}
 */
function parseVtt(vttText) {
  const TIME_RE =
    /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/;
  const TAG_RE = /<[^>]+>/g;

  function parseTimestamp(ts) {
    const parts = ts.trim().split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1]; // MM:SS.mmm
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

/**
 * Run yt-dlp to download subtitle file(s) to /tmp, read and parse them,
 * then delete temp files.
 *
 * @param {string} videoId  11-character YouTube video ID
 * @param {string} lang     BCP-47 language code (e.g. "en", "ko", "ja")
 * @returns {Promise<{ segments: any[], language: string, source: "yt-dlp" } | null>}
 */
async function runYtDlp(videoId, lang) {
  // Unique session prefix so parallel requests don't collide
  const sessionId = randomBytes(8).toString("hex");
  const outputTemplate = join(tmpdir(), `rtsub_${sessionId}_%(id)s`);

  // Build language preference list: requested lang first, then English variants
  const langPref =
    lang && lang !== "en"
      ? `${lang}.*,en.*`
      : "en.*";

  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    "--write-auto-subs", // include auto-generated captions
    "--write-subs",       // include manual captions
    "--sub-langs",
    langPref,
    "--sub-format",
    "json3",              // prefer JSON3; yt-dlp falls back to best available
    "--skip-download",    // audio/video not needed
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "-o",
    outputTemplate,
  ];

  console.log(`[yt-dlp] videoId=${videoId} lang=${lang} args: ${args.slice(1).join(" ")}`);

  return new Promise((resolve) => {
    const proc = spawn("yt-dlp", args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      // yt-dlp not in PATH or other spawn error
      console.error(`[yt-dlp] spawn error: ${err.message}`);
      resolve(null);
    });

    proc.on("close", async (code) => {
      console.log(
        `[yt-dlp] exited code=${code}${stderr ? ` stderr=${stderr.substring(0, 200)}` : ""}`
      );

      try {
        // Discover subtitle files written by yt-dlp
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

        console.log(`[yt-dlp] found files: ${subFiles.map((f) => f.split(/[/\\]/).pop()).join(", ")}`);

        // Prefer the requested language, then any English variant, then first file
        const pickFile = (files, langCode) =>
          files.find((f) => {
            const base = f.split(/[/\\]/).pop();
            return base.includes(`.${langCode}.`) || base.includes(`.${langCode}-`);
          });

        const chosenFile =
          pickFile(subFiles, lang) ||
          pickFile(subFiles, "en") ||
          subFiles[0];

        // Extract language code from filename: rtsub_XXX_ID.en.json3 → "en"
        const langMatch = chosenFile
          .split(/[/\\]/)
          .pop()
          .match(/\.([a-zA-Z]{2,}(?:-[a-zA-Z0-9]+)*)\.(?:json3|vtt)$/);
        const detectedLang = langMatch ? langMatch[1] : lang;

        console.log(
          `[yt-dlp] parsing: ${chosenFile.split(/[/\\]/).pop()} detectedLang=${detectedLang}`
        );

        const content = await readFile(chosenFile, "utf8");

        // Clean up all temp files (best-effort)
        await Promise.allSettled(subFiles.map((f) => unlink(f)));

        // Parse
        let segments = null;
        if (chosenFile.endsWith(".json3")) {
          try {
            const json3   = JSON.parse(content);
            const words   = parseJson3ToSegments(json3);
            if (words.length > 0) {
              console.log("[DEBUG] word segments sample (first 20):",
                words.slice(0, 20).map((w) => `${w.startTime.toFixed(2)}→${w.endTime.toFixed(2)} "${w.text}"`));
              const phrases  = groupWordsIntoPhrases(words);
              const merged   = mergeOrphanPhrases(phrases);
              segments       = resolveAndCleanSegments(merged);
              console.log("[DEBUG] phrase segments sample (first 20):",
                segments.slice(0, 20).map((s) => `${s.startTime.toFixed(2)}→${s.endTime.toFixed(2)} "${s.text}"`));
              console.log(
                `[yt-dlp] json3 → words=${words.length} phrases=${phrases.length} merged=${merged.length} final=${segments.length}`
              );
              console.log(`[SERVER] final segments sample (first 10):`,
                segments.slice(0, 10).map((s) =>
                  `${s.startTime.toFixed(2)}→${s.endTime.toFixed(2)} "${s.text}"`
                ).join(" | ")
              );
              if (segments.length === 0) segments = null;
            }
          } catch (e) {
            console.warn(`[yt-dlp] JSON3 parse error: ${e}`);
          }
        }
        // VTT fallback (or if json3 parse failed)
        if (!segments) {
          segments = parseVtt(content);
        }

        if (!segments || segments.length === 0) {
          console.log(`[yt-dlp] parsed 0 segments from file`);
          resolve(null);
          return;
        }

        console.log(
          `[yt-dlp] success: ${segments.length} segments, lang=${detectedLang}`
        );
        resolve({ segments, language: detectedLang, source: "yt-dlp" });
      } catch (e) {
        console.error(`[yt-dlp] file handling error: ${e}`);
        resolve(null);
      }
    });
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

app.get("/subtitles", async (req, res) => {
  const { videoId, lang = "en" } = req.query;

  // Validate videoId (YouTube IDs are exactly 11 URL-safe characters)
  if (
    !videoId ||
    typeof videoId !== "string" ||
    !/^[a-zA-Z0-9_-]{11}$/.test(videoId)
  ) {
    return res.status(400).json({ error: "Missing or invalid videoId" });
  }

  // Validate lang (loose check)
  const safeLang = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(lang) ? lang : "en";

  const cacheKey = `${videoId}:${safeLang}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[SUBTITLE] cache hit: videoId=${videoId} lang=${safeLang}`);
    return res.json({
      segments: cached.segments,
      language: cached.language,
      source: cached.source,
    });
  }

  console.log(`[SUBTITLE] yt-dlp fetch: videoId=${videoId} lang=${safeLang}`);

  try {
    const result = await runYtDlp(videoId, safeLang);

    if (!result || result.segments.length === 0) {
      return res.status(500).json({ error: "No subtitles available for this video" });
    }

    // Cache successful result
    subtitleCache.set(cacheKey, { ...result, cachedAt: Date.now() });

    console.log(
      `[SUBTITLE] yt-dlp success: videoId=${videoId} segments=${result.segments.length} lang=${result.language}`
    );
    return res.json(result);
  } catch (e) {
    console.error(`[SUBTITLE] unexpected error: ${e}`);
    return res.status(500).json({ error: "Subtitle fetch failed" });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`[SUBTITLE] server listening on http://${HOST}:${PORT}`);
  console.log(`[SUBTITLE] endpoints:`);
  console.log(`           GET /subtitles?videoId=VIDEO_ID[&lang=en]`);
  console.log(`           GET /health`);
});
