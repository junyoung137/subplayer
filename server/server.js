/**
 * RealtimeSub subtitle proxy server (v2)
 *
 * GET /subtitles?videoId=VIDEO_ID[&lang=en]
 *
 * 변경사항 (v1 → v2):
 * ─────────────────────────────────────────────────────────────────────────────
 * [FIX] SENTENCE_PAUSE_S 0.45 → 0.30
 *       빠른 문답 코미디에서 더 자주 flush해 화자 혼입 방지
 * [FIX] SENTENCE_MAX_WORDS 14 → 9
 *       한 세그먼트에 여러 화자 발언이 섞이는 현상 차단
 * [FIX] mergeOrphanPhrases gap 0.4/0.6 → 0.25/0.40
 *       orphan 병합 조건 엄격화로 발화 경계 유지
 * [FIX] orphan 병합 후 최대 단어 수 10 → 8
 * [FIX] long phrase split cap 10 → 8 단어
 * [FIX] NEW_UTTERANCE_CAPS_RE에 That's/There's/It's/No/Yes/Yeah 등 추가
 * [FIX] resolveAndCleanSegments SHORT_RESPONSE split threshold 3s → 2s
 * [FIX] 규칙 E gap 최소값 0.05 → 0.03s
 * ─────────────────────────────────────────────────────────────────────────────
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

const TIGHT_GAP_S           = 0.5;
const MIN_PHRASE_DURATION_S = 0.3;
const FLOOR_DURATION_S      = 0.8;

// [FIX v2] 0.45 → 0.30: 빠른 문답에서 더 자주 flush
const SENTENCE_PAUSE_S      = 0.30;
// [FIX v2] 14 → 9: 여러 화자 발언 혼입 방지
const SENTENCE_MAX_WORDS    = 9;
const SENTENCE_TERMINAL_RE  = /[.?!]$/;
const DECIMAL_OR_TIME_RE    = /^\d+[.:]\d+[.!?]?$/;
const LOWER_START_RE        = /^[a-z]/;
const CONTINUATION_CAPS_RE  = /^(And|But|Or|So|Because|When|If|That|Which|Who|Where|While|Although|Though|Yet|For|Nor|After|Before|Since|Until|However|Therefore|Also|Then|As)\b/;

// [FIX v2] 화자 전환 감지 단어 목록 확장
// 원래: I|You|We|They|He|She|It|Are|Is|Do|Does|Did|Have|Has|Was|Were|Will|Would|Can|Could|Tell|That|This|For|Well|Amy|So|But|Now|Why|What|Who|How|Where|When
// 추가: That's|There's|It's|No|Yes|Yeah|Hmm|Oh|Wow|Actually|Look|Listen|Wait
const NEW_UTTERANCE_CAPS_RE = /^(I|You|We|They|He|She|It|Are|Is|Do|Does|Did|Have|Has|Was|Were|Will|Would|Can|Could|Tell|That|This|For|Well|Amy|So|But|Now|Why|What|Who|How|Where|When|That's|There's|It's|No|Yes|Yeah|Hmm|Oh|Wow|Actually|Look|Listen|Wait)\b/;

// ── Subtitle parsers ──────────────────────────────────────────────────────────

/**
 * Parse YouTube JSON3 format into word-level segments.
 *
 * KEY FIX: en-orig 트랙은 event의 dDurMs가 매우 길어서
 * word endTime이 다음 event까지 뻗어나가 overlap이 발생한다.
 * 파싱 후 forward-pass로 각 word의 endTime을 다음 word의 startTime으로 cap한다.
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
        endTime:   Math.max(wordEndMs, wordStartMs + 100) / 1000,
        text,
      });
    }
  }

  // ── endTime cap: 각 word의 endTime을 다음 word의 startTime으로 제한 ─────
  for (let i = 0; i < wordSegments.length - 1; i++) {
    const cur  = wordSegments[i];
    const next = wordSegments[i + 1];
    if (cur.endTime > next.startTime) {
      wordSegments[i] = {
        ...cur,
        endTime: Math.max(next.startTime, cur.startTime + 0.05),
      };
    }
  }

  return wordSegments;
}

/**
 * word-level 세그먼트를 sentence-level phrase로 묶는다.
 */
function groupWordsIntoSentences(wordSegments) {
  const phrases = [];
  let group = [];

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

    // ── A: 두 단어 복합 응답어 lookahead ────────────────────────────────────
    if (prev && next) {
      const twoText = (word.text + " " + next.text).trim();
      if (TWO_WORD_RESPONSE_RE.test(twoText) && gap < TIGHT_GAP_S) {
        flush();
        phrases.push({ startTime: word.startTime, endTime: next.endTime, text: twoText });
        i++;
        continue;
      }
    }

    // ── B: 단일 화자교체 응답어 ──────────────────────────────────────────────
    if (prev && SPEAKER_CHANGE_RE.test(word.text) && gap < TIGHT_GAP_S) {
      flush();
      phrases.push({ startTime: word.startTime, endTime: word.endTime, text: word.text.trim() });
      continue;
    }

    // ── C: 종단 부호 flush ────────────────────────────────────────────────────
    if (group.length > 0) {
      const lastText = group[group.length - 1].text.trim();
      const isTerminal =
        SENTENCE_TERMINAL_RE.test(lastText) &&
        !DECIMAL_OR_TIME_RE.test(lastText);

      if (isTerminal) {
        const continuesLower = LOWER_START_RE.test(word.text);
        const continuesCaps  = CONTINUATION_CAPS_RE.test(word.text);
        if (!continuesLower && !continuesCaps) {
          flush();
        }
      }
    }

    // ── D: pause ─────────────────────────────────────────────────────────────
    if (gap >= SENTENCE_PAUSE_S && group.length > 0) {
      flush();
    }

    // ── E: 새 발화 시작 감지 (대문자 + 소문자 끝 이전 단어)
    // [FIX v2] gap 최소값 0.05 → 0.03s
    if (
      group.length >= 2 &&
      gap >= 0.03 &&
      NEW_UTTERANCE_CAPS_RE.test(word.text) &&
      prev && /[a-z]$/.test(prev.text)
    ) {
      flush();
    }

    // ── F: 단어 수 hard cap ───────────────────────────────────────────────────
    if (group.length >= SENTENCE_MAX_WORDS) {
      flush();
    }

    group.push(word);
  }

  flush();

  // ── 최소 표시 시간 보정 ────────────────────────────────────────────────────
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

  return resolveOverlaps(phrases);
}

/**
 * Merge orphan phrases (≤ 2 words) into adjacent phrase groups.
 * [FIX v2] gap threshold 0.4/0.6 → 0.25/0.40, max merge words 10 → 8
 */
function mergeOrphanPhrases(phrases) {
  let result = [...phrases];

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const out = [];

    for (let i = 0; i < result.length; i++) {
      const cur = result[i];
      const curWordCount = cur.text.trim().split(/\s+/).length;

      const MERGE_PROTECT_S   = 0.2;
      const isSpeakerResponse = curWordCount <= 2 && SPEAKER_CHANGE_RE.test(cur.text.trim());
      const backGap  = out.length > 0 ? cur.startTime - out[out.length - 1].endTime : Infinity;
      const fwdGap   = i + 1 < result.length ? result[i + 1].startTime - cur.endTime : Infinity;
      const isProtected = isSpeakerResponse &&
        (backGap < MERGE_PROTECT_S || fwdGap < MERGE_PROTECT_S);

      // [FIX v2] gap 0.4 → 0.25, max words 10 → 8
      if (curWordCount <= 2 && out.length > 0 && !isProtected) {
        const prev = out[out.length - 1];
        const gap  = cur.startTime - prev.endTime;
        if (gap < 0.25) {
          const merged = (prev.text + ' ' + cur.text).trim();
          if (merged.split(/\s+/).length <= 8) {
            out[out.length - 1] = { startTime: prev.startTime, endTime: cur.endTime, text: merged };
            changed = true;
            continue;
          }
        }
      }

      // [FIX v2] gap 0.6 → 0.40, max words 10 → 8
      if (curWordCount <= 2 && i + 1 < result.length && !isProtected) {
        const nxt = result[i + 1];
        const gap = nxt.startTime - cur.endTime;
        if (gap < 0.40) {
          const merged = (cur.text + ' ' + nxt.text).trim();
          if (merged.split(/\s+/).length <= 8) {
            out.push({ startTime: cur.startTime, endTime: nxt.endTime, text: merged });
            i++;
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

  // [FIX v2] long phrase split cap 10 → 8
  const capped = [];
  for (const phrase of result) {
    const words = phrase.text.trim().split(/\s+/);
    if (words.length > 8) {
      const mid     = Math.floor(words.length / 2);
      const midTime = phrase.startTime + (phrase.endTime - phrase.startTime) * (mid / words.length);
      capped.push({ startTime: phrase.startTime, endTime: midTime,        text: words.slice(0, mid).join(' ') });
      capped.push({ startTime: midTime,          endTime: phrase.endTime, text: words.slice(mid).join(' ')   });
    } else {
      capped.push(phrase);
    }
  }

  return capped;
}

/**
 * Resolve overlapping segment time ranges.
 */
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

/**
 * Comprehensive segment cleaner.
 * [FIX v2] SHORT_RESPONSE split threshold 3s → 2s
 */
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

  const expanded = [];
  for (const seg of result) {
    const words    = seg.text.trim().split(/\s+/);
    const duration = seg.endTime - seg.startTime;

    // [FIX v2] duration > 3 → > 2
    if (words.length <= 5 && duration > 2 && SHORT_RESPONSE_RE.test(seg.text)) {
      const midTime  = seg.startTime + duration / 2;
      const splitIdx = words.findIndex((w) => SHORT_RESPONSE_RE.test(w));

      if (splitIdx > 0) {
        expanded.push({ startTime: seg.startTime, endTime: midTime,      text: words.slice(0, splitIdx).join(' ') });
        expanded.push({ startTime: midTime,        endTime: seg.endTime,  text: words.slice(splitIdx).join(' ')   });
      } else {
        expanded.push({ startTime: midTime, endTime: seg.endTime, text: seg.text });
      }
      continue;
    }

    expanded.push(seg);
  }

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
 */
function parseVtt(vttText) {
  const TIME_RE =
    /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/;
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

// ── yt-dlp runner ─────────────────────────────────────────────────────────────

async function runYtDlp(videoId, lang) {
  const sessionId      = randomBytes(8).toString("hex");
  const outputTemplate = join(tmpdir(), `rtsub_${sessionId}_%(id)s`);

  const langPref =
    lang && lang !== "en"
      ? `${lang}.*,en.*`
      : "en.*";

  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    langPref,
    "--sub-format",
    "json3",
    "--skip-download",
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
      console.error(`[yt-dlp] spawn error: ${err.message}`);
      resolve(null);
    });

    proc.on("close", async (code) => {
      console.log(
        `[yt-dlp] exited code=${code}${stderr ? ` stderr=${stderr.substring(0, 200)}` : ""}`
      );

      try {
        const tmp      = tmpdir();
        const allFiles = await readdir(tmp);
        const prefix   = `rtsub_${sessionId}_${videoId}`;
        const subFiles = allFiles
          .filter((f) => f.startsWith(prefix) && (f.endsWith(".json3") || f.endsWith(".vtt")))
          .map((f) => join(tmp, f));

        if (subFiles.length === 0) {
          console.log(`[yt-dlp] no subtitle files found (videoId=${videoId})`);
          resolve(null);
          return;
        }

        console.log(`[yt-dlp] found files: ${subFiles.map((f) => f.split(/[/\\]/).pop()).join(", ")}`);

        const pickFile = (files, langCode) =>
          files.find((f) => {
            const base = f.split(/[/\\]/).pop();
            return base.includes(`.${langCode}.`) || base.includes(`.${langCode}-`);
          });

        // en(ASR) 우선, en-orig(수동) 후순위
        const chosenFile =
          pickFile(subFiles, "en") ||
          pickFile(subFiles, lang) ||
          subFiles[0];

        const langMatch = chosenFile
          .split(/[/\\]/)
          .pop()
          .match(/\.([a-zA-Z]{2,}(?:-[a-zA-Z0-9]+)*)\.(?:json3|vtt)$/);
        const detectedLang = langMatch ? langMatch[1] : lang;

        console.log(
          `[yt-dlp] parsing: ${chosenFile.split(/[/\\]/).pop()} detectedLang=${detectedLang}`
        );

        const content = await readFile(chosenFile, "utf8");

        await Promise.allSettled(subFiles.map((f) => unlink(f)));

        let segments = null;
        if (chosenFile.endsWith(".json3")) {
          try {
            const json3  = JSON.parse(content);
            const words  = parseJson3ToSegments(json3);
            if (words.length > 0) {
              console.log("[DEBUG] word segments sample (first 20):",
                words.slice(0, 20).map((w) => `${w.startTime.toFixed(2)}→${w.endTime.toFixed(2)} "${w.text}"`));

              const phrases = groupWordsIntoSentences(words);
              const merged  = mergeOrphanPhrases(phrases);
              segments      = resolveAndCleanSegments(merged);

              console.log("[DEBUG] sentence segments sample (first 20):",
                segments.slice(0, 20).map((s) => `${s.startTime.toFixed(2)}→${s.endTime.toFixed(2)} "${s.text}"`));
              console.log(
                `[yt-dlp] json3 → words=${words.length} sentences=${phrases.length} merged=${merged.length} final=${segments.length}`
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

  if (
    !videoId ||
    typeof videoId !== "string" ||
    !/^[a-zA-Z0-9_-]{11}$/.test(videoId)
  ) {
    return res.status(400).json({ error: "Missing or invalid videoId" });
  }

  const safeLang = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(lang) ? lang : "en";

  const cacheKey = `${videoId}:${safeLang}`;
  const cached   = getCached(cacheKey);
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

// ── Cache clear ───────────────────────────────────────────────────────────────
// GET /cache/clear                  — 전체 캐시 삭제
// GET /cache/clear?videoId=VIDEO_ID — 특정 영상 캐시만 삭제
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
});
