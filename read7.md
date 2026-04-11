# RealtimeSub — YouTube Caption Extraction & Translation Pipeline

Full end-to-end documentation of how a YouTube URL becomes synchronized, translated Korean subtitles.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [URL Reception & Video ID Parsing](#2-url-reception--video-id-parsing)
3. [Proxy Server & yt-dlp Caption Extraction](#3-proxy-server--yt-dlp-caption-extraction)
4. [Caption Format Parsing & Server-Side Cleaning](#4-caption-format-parsing--server-side-cleaning)
5. [Client-Side Fetch & Post-Processing](#5-client-side-fetch--post-processing)
6. [Speaker Diarization](#6-speaker-diarization)
7. [Sentence Assembly](#7-sentence-assembly)
8. [Gemma Translation Pipeline](#8-gemma-translation-pipeline)
9. [Post-Translation Display Expansion](#9-post-translation-display-expansion)
10. [Output Storage & Real-Time Display](#10-output-storage--real-time-display)
11. [Error Handling & Retry Logic](#11-error-handling--retry-logic)
12. [Data Flow Diagram](#12-data-flow-diagram)
13. [Key Implementation Details](#13-key-implementation-details)
14. [File Manifest](#14-file-manifest)

---

## 1. Architecture Overview

The system is split into two runtime boundaries:

| Boundary | Components | Responsibility |
|---|---|---|
| **Proxy server** | `server/server.js` | Invoke yt-dlp, parse captions, group phrases, cache results |
| **React Native client** | `app/`, `components/`, `services/`, `store/` | Fetch from proxy, run on-device Gemma translation, display subtitles |

The proxy exists because YouTube's `/timedtext` API returns HTTP 429 to direct React Native `fetch` calls (missing cookies and browser User-Agent). The proxy runs on a local or self-hosted Express server that the app calls at `PROXY_BASE_URL`.

On-device translation uses `llama.rn` (llama.cpp bindings) running a Gemma 3 model in INT4/INT8. No cloud API keys are required.

---

## 2. URL Reception & Video ID Parsing

**Entry point:** `app/index.tsx` — home screen with a URL input modal.

1. User pastes a YouTube URL (any form: `youtu.be/ID`, `youtube.com/watch?v=ID`, `youtube.com/shorts/ID`).
2. `parseYoutubeId(url)` extracts the 11-character video ID with a regex covering all URL variants.
3. On success, `usePlayerStore.setYoutubeVideo(videoId, title)` is called, which sets:
   ```
   playerMode   = "youtube"
   youtubeVideoId = "<11-char ID>"
   videoName    = "<display title>"
   subtitles    = []
   ```
4. Expo Router navigates to `app/youtube-player.tsx`.

**Relevant store state** (`store/usePlayerStore.ts`):
```typescript
playerMode:     "local" | "youtube" | "url"
youtubeVideoId: string | null
videoName:      string | null
subtitles:      SubtitleSegment[]
```

---

## 3. Proxy Server & yt-dlp Caption Extraction

**File:** `server/server.js`  
**Endpoint:** `GET /subtitles?videoId=VIDEO_ID&lang=en`

### 3a. yt-dlp Invocation

```javascript
const args = [
  `https://www.youtube.com/watch?v=${videoId}`,
  "--write-auto-subs",          // auto-generated captions
  "--write-subs",               // manual captions (higher quality when present)
  "--sub-langs", langPref,      // e.g. "en.*" or "ko.*,en.*"
  "--sub-format", "json3",      // word-level timing (preferred over VTT)
  "--skip-download",            // no audio/video download
  "--no-playlist",
  "--no-warnings",
  "--quiet",
  "-o", `/tmp/rtsub_${sessionId}_%(id)s`,
];
spawn("yt-dlp", args);
```

**Session isolation:** Each request generates a random 8-byte hex `sessionId` to prevent temp file collisions across concurrent requests.

**Format preference:** `json3` is preferred because it encodes per-word timestamps within each caption event. If only a `.vtt` file is found, the VTT parser runs instead.

### 3b. Temp File Lifecycle

1. yt-dlp writes `.json3` or `.vtt` to `/tmp/`.
2. After `close` event, `readdirSync("/tmp")` scans for files matching `rtsub_${sessionId}_*`.
3. Files are parsed, then deleted via `Promise.allSettled(files.map(f => unlink(f)))` (best-effort).
4. If yt-dlp exits with non-zero status code, the handler resolves null.

### 3c. Server-Side Cache

Results are cached in a `Map<cacheKey, {segments, language, source, cachedAt}>` with a 1-hour TTL.  
Cache key: `${videoId}:${normalizedLang}`.  
A cached hit skips yt-dlp entirely and returns immediately.

---

## 4. Caption Format Parsing & Server-Side Cleaning

### 4a. JSON3 Parser — `parseJson3ToSegments(data)`

YouTube JSON3 format structure:
```
events[]
  tStartMs     — event start time (ms)
  dDurMs       — event duration (ms)
  segs[]
    utf8        — word text
    tOffsetMs   — word start offset within event (ms)
```

The parser expands this into one `TimedTextSegment` per word:
- `startTime = (tStartMs + tOffsetMs) / 1000`
- `endTime   = next word's startTime` OR `(tStartMs + dDurMs) / 1000` for the last word in an event
- Minimum word duration enforced: 100 ms

This produces very fine-grained timing — typically 1–3 words per segment.

### 4b. VTT Parser — `parseVtt(vttText)` (fallback)

Parses standard WebVTT cue blocks:
```
HH:MM:SS.mmm --> HH:MM:SS.mmm
line of text
```
- Strips HTML-like tags: `<b>`, `<i>`, `<c.colorname>`, timestamp tags
- Supports both `HH:MM:SS.mmm` and `MM:SS.mmm` timestamp formats

### 4c. Server-Side Cleaning Pipeline

After parsing, the server runs five sequential cleaning steps:

**Step A — Sort by startTime**  
Guarantees strictly ascending order for all downstream logic.

**Step B — Resolve Overlapping Segments**  
For each pair where `seg[i].endTime > seg[i+1].startTime`:  
- Trim `seg[i].endTime = seg[i+1].startTime`  
- Drop segments with resulting duration < 0.05 s

**Step C — Extract Short Responses from Inflated Windows**  
yt-dlp sometimes produces a word like "no" with a 5-second timestamp window (it inherits the surrounding caption block's duration). The server detects this pattern:
- Word count ≤ 5, duration > 3 s, text matches short-response regex:
  ```regex
  \b(no|yes|yeah|nope|right|exactly|okay|ok|sure|never|really|...|got it|fair enough)\b
  ```
- Splits at the time midpoint: preceding text keeps the first half, the short response gets the second half.

**Step D — Re-sort and Deduplicate**  
After splitting, re-sort and remove exact duplicates (same `startTime` + same `text`).

**Step E — Group Words into Phrases** — `groupWordsIntoPhrases(wordSegs, maxWords=6, pauseThreshold=0.4)`  

Merges consecutive word-level segments into phrase-level groups. Flush triggers (in priority order):

| Priority | Rule | Condition |
|---|---|---|
| 1 | Natural pause | Gap to next segment ≥ 0.4 s |
| 2 | Speaker-change backchannel | Short word (≤ 1–2 words) matching backchannel pattern AND gap < 0.5 s → flush *before* this word, emit it as standalone |
| 3 | Duration cap | Projected group span > 5.0 s |
| 4 | Word count cap | Group ≥ 6 words |

After grouping, any phrase with duration < 0.3 s is extended to 0.8 s (capped at the next phrase start).  
Overlaps created by extension are resolved via `resolveOverlaps()`.

**Step F — Merge Orphan Phrases** — `mergeOrphanPhrases(phrases)` (up to 3 passes)  
Phrases of ≤ 2 words with a nearby neighbor (gap < 0.4 s) are absorbed into that neighbor.  
After stable merge, any phrase > 10 words is split at the midpoint to keep display chunks manageable.

**Final server response:**
```json
{
  "segments": [
    { "startTime": 1.25, "endTime": 3.5, "text": "Hello world" },
    ...
  ],
  "language": "en",
  "source": "yt-dlp"
}
```

---

## 5. Client-Side Fetch & Post-Processing

**Files:** `services/youtubeTimedText.ts`, `components/YouTubePlayer.tsx`

### 5a. Proxy Fetch — `fetchYoutubeSubtitles(videoId, preferLang)`

```typescript
const url = `${PROXY_BASE_URL}/subtitles?videoId=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(preferLang)}`;

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);  // 10-second hard timeout
const res = await fetch(url, { signal: controller.signal });
```

Returns `FetchSubtitlesResult | null`. Returns null (never throws) for:
- Network failure (fetch throws)
- HTTP error status (4xx, 5xx)
- JSON parse failure
- Empty `segments` array

`RateLimitError` (HTTP 429) is thrown as a typed error so callers can handle it separately.

### 5b. Client-Side Deduplication & Overlap Fix (`YouTubePlayer.doFetch`)

After receiving the server response, three quick passes run on the client:

1. **Sort** by `startTime` (defensive, server already sorts)
2. **Deduplicate** segments within 0.1 s of the previous start time
3. **Trim overlaps**: if `seg[i].endTime > seg[i+1].startTime`, set `seg[i].endTime = seg[i+1].startTime`

The cleaned `TimedTextSegment[]` is passed to the `onSubtitlesLoaded` callback on the screen.

---

## 6. Speaker Diarization

**File:** `app/youtube-player.tsx` — `assignSpeakerIds(segments)`

Since yt-dlp word-level gaps are near-zero, gap-based diarization is unreliable. Instead, a sentence-boundary heuristic assigns speaker IDs `"A"` or `"B"`.

### Step 1 — Lightweight Sentence Grouping

Accumulates segments into groups, flushing on:
- Sentence-final punctuation (`.!?`) or terminal words (`okay, yeah, right, thanks, please`)
- Group reaches 6 words
- Solo backchannel word detected (`BACKCHANNEL_RE`: `yes|yeah|no|nope|ok|okay|right|sure|exactly|wow|wait|what|huh|hmm|uh|oh|really|totally`)

Backchannel solo detection triggers a pre-flush (flush the accumulator *before* the backchannel word) then a post-flush (emit it as its own group).

### Step 2 — Sentence-Boundary Speaker Assignment Rules

Applied to groups in sequence, with a **COOLDOWN=1** (require at least 1 same-speaker group before next switch):

| Rule | Trigger | Action |
|---|---|---|
| Rule 1 — Q→A | Previous group ends with `?` AND current doesn't start with continuation word | Switch |
| Rule 2 — Backchannel | Current ≤ 2 words, all backchannel; previous > 5 words | Switch |
| Rule 3 — Direct address | Current starts with `well|so|now + Capital` (direct address pattern) | Switch |
| Rule 4a — Short response | Current ≤ 3 words; previous ≥ 6 words; not both-backchannel | Switch |
| Rule 4b — Rapid exchange | Both current AND previous ≤ 5 words | Switch |
| Rule 5 — Floor limit | Same speaker held > 5 consecutive groups AND current ≤ 4 words | Switch |

**Skew warning:** If > 80% of groups are assigned to a single speaker, a console warning is logged.

### Step 3 — Propagate to Raw Segments

The group's assigned `speakerId` is written back to each constituent raw segment. After this step every `TimedTextSegment` has a `speakerId: "A" | "B"` field.

---

## 7. Sentence Assembly

**File:** `app/youtube-player.tsx` — `assembleIntoSentences(segments)`

yt-dlp produces 1–3 word fragments per segment. Sending these individually to the LLM produces poor translations. Sentence assembly groups them into full sentence-level `SentenceUnit` objects before translation.

### SentenceUnit Interface

```typescript
interface SentenceUnit {
  startTime:   number;
  endTime:     number;
  speakerId?:  string;
  text:        string;      // Full assembled sentence text
  sourceTexts: string[];    // Individual raw segment texts (for re-expansion later)
}
```

### Flush Conditions (checked after each segment is appended)

| Condition | Detail |
|---|---|
| `endsSentence(accText)` | Ends with `.!?` or terminal word (`okay`, `yeah`, etc.) |
| Word count ≥ 15 | Hard cap to prevent runaway sentences |
| Gap to next > 1.5 s | Natural pause boundary |
| Accumulated duration > 4.0 s | Time cap |
| Speaker change | `next.speakerId !== accSegs[0].speakerId` |
| `accContainsCompleteSentence` | Mid-text `?` or `!` followed by space AND next is not a continuation word |
| `accEndsWithQuestion` | Accumulated text ends with `?` AND next is not a continuation word |
| `accHasMidQuestion` | Text has ≥ 5 words of statement + question-opener (`are|is|do|does|...`) AND total ≥ 8 words |

**Pre-flush duration check:** Before pushing a segment, if `seg.endTime - accSegs[0].startTime > SENTENCE_MAX_DUR_S`, the accumulator is flushed first. This prevents the duration limit from firing too late (after the offending segment is already merged in).

`sourceTexts` on each `SentenceUnit` preserves the original per-word texts for proportional re-expansion after translation.

---

## 8. Gemma Translation Pipeline

**File:** `services/gemmaTranslationService.ts`  
**Entry point:** `translateSegments(segments, onProgress, videoHash, targetLanguage, videoGenre)`

### 8a. Pre-Translation Preparation

**Step 0 — Deduplicate Overlapping Segments** — `deduplicateOverlappingSegments(segments)`

Single O(n) forward pass. For each segment:
- If `startTime < accumEnd - 0.05 s` (overlap): union-merge words (dedup case-insensitive, preserve first-occurrence casing), extend `accumEnd`.
- Else: flush the accumulated group, start new.

**Step 0b — ASR Noise Cleanup**
```typescript
text
  .replace(/\.{2,}$/, "")             // trailing "..."
  .replace(/(?<!\()[^)]*\)/g, "")    // unmatched close paren
  .replace(/(?<!\[)[^\]]*\]/g, "")   // unmatched close bracket
  .trim()
```

### 8b. Fragment Merging — `mergeFragments(segments)` → `MergedGroup[]`

[UPDATED] Groups consecutive segments into translation-context units. Filler text segments (empty, single punctuation, or digits-only) are always emitted as isolated 1-element groups and never merged with neighbors. For non-filler segments, flush triggers are:

| Trigger | Detail |
|---|---|
| Gap ≥ 0.5 s | Default pause threshold (`MERGE_MAX_GAP_S`) |
| Gap ≥ 1.5 s (relaxed) | Only if accumulated text has no terminal punctuation AND next starts with a continuation word (`CONTINUATION_WORDS = /^(gonna\|going\|been\|have\|just\|really\|so\|that\|the\|a\|an\|to\|be\|get\|even\|don't\|i\|and\|in\|until\|like)\b/i`) |
| Complete clause boundary | Accumulated text matches `\b(I\|you\|we\|they\|he\|she\|it)\b.{4,}/i` (contains subject+verb) AND next segment starts with `^(I\|you\|we\|they\|he\|she\|it\|[A-Z][a-z])\b/i` (new clause opener) |
| Duration > 2.5 s | Hard duration cap (`MERGE_MAX_DURATION_S`) |
| Word count > 8 | Hard word cap (`MERGE_MAX_WORDS`) |
| Terminal punctuation | Group already ends with `.!?` |
| Filler detection | Next segment is pure filler |

### 8c. Short Group Absorption — `absorbShortGroups(groups)`

Second pass. Isolated groups of ≤ 2 words and < 1.5 s are merged into their nearest neighbor (next preferred, then previous). Gives isolated words like "yes" or "no" translation context from surrounding segments.

### 8d. Proper Noun Dictionary — `buildProperNounDict(segments, videoHash, targetLanguage)`

**Extraction:** `extractProperNounCandidates(segments)`  
- Capitalized words ≥ 3 chars not in `COMMON_WORDS` set
- [UPDATED] Score: `mid * 1.5 + first * 0.5 >= PROPER_NOUN_MIN_COUNT` — mid-sentence occurrences weighted 1.5×, sentence-start occurrences weighted 0.5×
- Threshold: ≥ 3 total (weighted) occurrences

**Storage:** `AsyncStorage` key `proper_nouns_{videoHash}` (persistent across sessions)

**Transliteration:** Batch LLM call: `"Transliterate each proper noun into Korean phonetically..."` → parses `English=한국어` pairs.

[UPDATED] **Application:** `buildPatterns(dict)` compiles word-boundary regex for each noun (using Unicode word boundaries that include Korean syllable ranges). Applied during response parsing via `applyProperNounFixes(text, patterns)`. Patterns are cached by dictionary key to avoid recompilation on each batch.

### 8e. Checkpoint System — `loadCheckpoint` / `saveCheckpoint`

**Storage:** `AsyncStorage` key `gemma_checkpoint_v3_{videoHash}`  
**TTL:** 24 hours

```typescript
interface Checkpoint {
  translatedTexts:  string[];            // Merged-group level translations
  lastBatchIndex:   number;              // Resume point
  properNouns:      Record<string, string>;
  totalBatches:     number;
  timestamp:        number;
}
```

On startup, if a valid checkpoint exists, `startBatch = checkpoint.lastBatchIndex + 1` and `mergedTranslations[]` is pre-populated. The LLM resumes from where it left off. Checkpoint is deleted after all batches complete successfully.

### 8f. System Prompt Construction

[UPDATED] Assembled at runtime as a single concatenated string from:
1. Role introduction: `"You are a professional Korean subtitle translator."`
2. Genre persona (`GENRE_PERSONA["tech lecture" | "comedy" | "news" | "general" | ...]`)
3. Output instruction: numbered lines, no explanations, one output per input, never skip or merge lines
4. **Rule 1 — OUTPUT FORMAT:**
   - One numbered output line per input line
   - Filler-only input (single punctuation, digits only) → output as-is
   - Fragment input (≤ 3 words) → fragment output; never expand a short fragment into a full sentence
   - Length proportionality: > 15 Korean chars for a sub-4-word source = borrowing from adjacent lines
5. **Rule 2 — MEANING FIRST:**
   - Translate intended meaning, not word-for-word
   - When literal meaning is physically impossible in context, use contextually correct meaning
   - Do not add meaning not present in the source line
6. **Rule 2b — DEMONSTRATIVE REFERENCE DIRECTION:** [ADDED]
   - When `that`, `those`, or `it` dismisses or mocks a thing as old/uncool/inferior, the predicate of contempt must attach to the thing itself in Korean — not to the people associated with it
7. **Rule 3 — NEGATION:** Preserve all negation markers; negated thought split across two lines must produce Korean negation marker (않/안/못/없) in the translated predicate
8. **Rule 4 — AGENT DIRECTION:** Communication verbs with tool as object: tool is receiving the action, not performing it
9. **Rule 5 — REGISTER:** 존댓말 for workplace/interview; sentence-initial casual fillers translated by function; romantic address forms only when explicitly confirmed in immediate context
10. **Rule 6 — SEGMENT BOUNDARY & CONTEXT READING:** [ADDED]
    - Each output line covers only its own input line's content
    - Never borrow, repeat, or anticipate content from adjacent lines
    - Read full batch for scene/register understanding but never import words from other lines
    - Bare noun/app list → neutral comma-separated list; incomplete clause fragment → natural fragment only
11. Language-specific rules from `profile.systemPromptRules` (joined with space)
12. [UPDATED] Proper noun hint block formatted as `\nReference translations: Name=이름, Name2=이름2` (no spaces around `=`)

### 8g. Batch Translation Loop

[UPDATED] **Batch size:** `BATCH_SIZE = 5` segments per LLM call

**For each batch:**

1. [UPDATED] **Sliding window context:** If `batchIdx > 0`, the previous batch's user message and assistant response are prepended as context turns. This sliding window is always applied — there is no conditional thermal drop of context.

2. **Message construction:**
   - System message always included
   - If `batchIdx > 0`: prepend previous batch as user+assistant turns (1-batch sliding window)
   - Current batch numbered locally from 1 (`buildBatchMessage(batch, 0)`)

3. **LLM inference:**
   ```typescript
   await llamaContext.completion({
     messages,
     n_predict:   batch.length * 120,  // ~120 tokens per segment
     temperature: 0.15,
     top_p:       0.9,
     stop: ["</s>", "<end_of_turn>", "<|end|>"],
   });
   ```

4. **Response parsing** — `parseBatchResponse(response, batch, batchOffset, patterns)`:

   Three-pass strategy to handle model formatting variance:
   - **Pass 1 — Strict:** `^(\d+)[.)]\s*(.+)$`
   - **Pass 2 — Broad:** `^(\d+)[.):\-]\s+(.+)$` or double-space separated
   - **Pass 3 — Positional:** Strip leading numbers/punctuation, match by line position
   - **Last resort:** Use whatever matches exist; fall back to source text for gaps

   Each parsed translation goes through `sanitizeTranslationOutput` and `applyProperNounFixes`.

5. **Progress callback:** `onProgress(completed, total, partial)` fires after each batch, where `partial` is expanded back to original (deduplicated) segment slots for real-time display.

6. **Checkpoint save** after each batch.

7. [UPDATED] **Inter-batch sleep:** `SLEEP_BETWEEN_MS = 600` ms normally; `SLEEP_THERMAL_MS = 2500` ms every `THERMAL_EVERY_N = 5` batches (longer pause to reduce thermal throttling — no context window is dropped).

### 8g-ii. Multi-Attempt Retry Pass — Step G [ADDED]

After the main batch loop completes, a separate retry pass runs up to `MAX_RETRY_ATTEMPTS = 2` times over the expanded translations. Targets:
- Empty or whitespace-only translation
- Translation identical to source text when source length > 15 chars (passthrough detected)
- Translation that is digits-only (model emitted only the line number)

Failed segments are collected, re-batched together, and re-submitted to the LLM with the same system prompt at `temperature: 0.15`. Each successful retry result overwrites the corresponding slot.

### 8h. Group-to-Segment Expansion — `expandGroupTranslations(groups, translations, originalSegments)`

Each `MergedGroup` may span N original segments. The translation must be distributed across those N slots.

[UPDATED] **Distribution algorithm:**

- **N = 1:** Slot 0 gets the full translation.
- **Multi-segment dense translation (N ≥ 3, `charsPerSlot < 6`):** If the translation has ≥ 2 sentences (split on `(?<=[.!?])\s+`), split into two halves by sentence count. The time boundary (`splitTime`) is computed from the character ratio of each half against total duration, then `splitSlot` is found by scanning `originalIndices` for the first segment starting at or after `splitTime`. First half goes to slot 0 (slots 1..splitSlot-1 are cleared); second half goes to `splitSlot` (remaining slots cleared). If fewer than 2 sentences found, the full translation goes to slot 0 only with remaining slots cleared.
- **Word-proportional split (default for N ≥ 2):** Calculate each original segment's non-space character count. Allocate translation words proportionally. Last slot receives all remaining words to absorb rounding.
- **Backward deduplication:** Scan pairs of adjacent slots backward. If slot A equals slot B, or A is a substring of B, clear A. If B is a substring of A, clear B. If A's suffix overlaps B's prefix by ≥ 6 chars, trim the overlap from B.
- [UPDATED] Slots set to empty string `""` are respected downstream as intentional suppression — the display layer shows empty rather than falling back to original text. (No `"\x00"` sentinel is used; empty string `""` is the suppression signal.)

### 8i. Translation Validation — `validateTranslations(segments, translations, systemPrompt, targetLang, patterns)`

[UPDATED] **Conditions that trigger single-segment retry** (all checked before retry decision):
- Empty or whitespace-only translation
- Ellipsis-only (`/^[.…]{2,}$/`)
- > 90% ASCII Latin characters (likely untranslated pass-through, via `isLikelyUntranslated`)
- Negation dropped: `logicalSrc` (current + next segment when no terminal punctuation) matches `don't think|i don't think|not a|doesn't work|don't work|can't|won't` but Korean output has no `않|안|못|없|아니|모르`
- Split-negation dropped: source ends with negated auxiliary (`don't|won't|can't|didn't|...not`) but Korean missing negation
- Hallucinated proper noun: translation contains known Korean noun form (from `HALLUCINATION_GUARD` or compiled `patterns`) but the English source word is absent from this segment
- Leftover English: `hasLeftoverEnglish(tSanitized, src, patterns, targetLanguage)` returns true

[UPDATED] `sanitizeTranslationOutput` is applied to the current translation before the leftover-English check, removing stage-direction artefacts (`혼잣말`, `독백`, `방백`, `내레이션`) and unmatched parenthesised content before deciding whether to retry.

**Retry call:**
```typescript
const singlePrompt = `Translate this single English subtitle line to natural ${targetLanguage}. Output ONLY the ${targetLanguage} translation, nothing else:\n${src}`;
llamaContext.completion({ messages: [{ role: "system", content: systemPrompt }, { role: "user", content: singlePrompt }], n_predict: 80, temperature: 0.1, stop: [..., "\n"] });
```

[UPDATED] Retry result goes through `sanitizeTranslationOutput` then `isLikelyUntranslated`. If the retry is still bad, the segment is marked `[미번역] <src>` / `[UNTRANSLATED] <src>`.

### 8j. Netflix-Style Timing Adjustment — `adjustTimingsForReadability(segments)`

Two passes:

1. **Minimum display duration:** `minDur = charCount × 0.065 s` (15 chars/sec Korean reading speed), applied to `translated || text` character count. If current duration < minDur, extend `endTime`.
2. **Forward overlap resolution:** If extending creates overlap > 0.1 s with the next segment, trim to `nextStart + 0.1 s`.

---

## 9. Post-Translation Display Expansion

**File:** `app/youtube-player.tsx` — `translateFromResult` function, steps 3–6.

The translation pipeline (Step 8) works at sentence level. Steps 3–6 expand sentence-level translations back to per-raw-segment subtitles for accurate timestamp alignment.

### Step 3 — `splitTranslatedSentence(translatedText, sourceTexts[])` → `string[]`

Split priority for distributing one sentence translation into N chunks:

| Priority | Strategy |
|---|---|
| 1 | Sentence-boundary split: `(?<=[?!.])\s+` — exact or ±1 chunk count accepted |
| 2 | Korean question-mark split: `\?\s+` (restores `?` on each non-final chunk) — ±1 tolerance |
| 3 | Meaning-based split: `，`, ` 그리고 `, ` 하지만 ` — exact or +1 accepted |
| 4 | `safeSplit` — proportional character count fallback |

**`safeSplit(text, sourceLengths[])`** cut-position logic (per cut):
- **Priority 0:** Within ±5 chars of `rawCut`, find `?` or `!` at end-of-text or followed by space → snap to just after it.
- **Priority 1:** Scan backward ≤ 15 chars for `[?!.]` followed by a space → cut after punctuation.
- **Priority 2:** Scan forward ≤ 20 chars for a space.
- **Fallback:** Use `rawCut` as-is.
- **Safety:** `actualCut = max(cut, prev + 1)` prevents infinite loops.

### Step 4 — Timestamp Redistribution — `redistributeTimestamps(segs, sentences)`

Within each `SentenceUnit`'s time range, reassign `startTime`/`endTime` per raw segment proportionally to its source character count (non-space chars). Minimum per-segment duration: 0.4 s. The last segment in each sentence is snapped exactly to `sentence.endTime` to absorb float accumulation error.

### Step 5 — Minimum Display Duration — `applyMinDuration(segs)`

Any segment with `endTime - startTime < 1.2 s` is extended to `startTime + 1.2 s`, capped at `nextSeg.startTime - 0.01 s` (never encroaches on next subtitle).

### Step 6 — Two-Line Format — `applyTwoLineFormat(text)`

For translated text > 20 chars:
1. Find best split point at or before the midpoint: last comma (split after it), then last space.
2. If either half > 25 chars, retry with the midpoint of the longer half.
3. Insert `\n` at the final split point.

---

## 10. Output Storage & Real-Time Display

### Store Structure (`store/usePlayerStore.ts`)

```typescript
interface SubtitleSegment {
  id:         string;
  startTime:  number;
  endTime:    number;
  original:   string;   // Source English
  translated: string;   // Korean translation (or original if failed)
  speakerId?: string;   // "A" | "B"
}
```

`setSubtitles(segments)` replaces the full array atomically.

`appendSubtitles(segments)` (used during streaming):
1. Filter out BLANK segments (`[BLANK_AUDIO]`, `[BLANK_VIDEO]`, `[silence]`, etc.)
2. Deduplicate by `id`
3. Time-sort and merge into existing array

### Real-Time Subtitle Polling (`components/YouTubePlayer.tsx`)

A 500 ms interval polls the player for `currentTime`, looks up the active segment:
```typescript
const lookupTime = currentTime + 0.5;  // 0.5 s lead time
const active = segments.find(s => lookupTime >= s.startTime && lookupTime < s.endTime);
```

The active segment is dispatched to `SubtitleOverlay` via the store.

**Display modes** (from `useSettingsStore`):
- `"both"` — Original text (small, top) + Korean translation (large, bottom)
- `"original"` — English only
- `"translation"` — Korean only

---

## 11. Error Handling & Retry Logic

### Network Layer (`youtubeTimedText.ts`)

| Error | Behavior |
|---|---|
| `fetch` throws (network down) | Return `null` |
| HTTP 429 | Throw `RateLimitError` |
| Any other HTTP error | Log status + body snippet, return `null` |
| JSON parse failure | Return `null` |
| Empty segments | Return `null` |
| 10 s timeout | Abort via `AbortController`, return `null` |

### LLM Translation Layer (`gemmaTranslationService.ts`)

| Scenario | Handling |
|---|---|
| [UPDATED] Empty/passthrough/digit-only translation after batch | Up to 2 retry passes (Step G), re-batching all failed segments together |
| Hard validation failure (empty, ellipsis-only, untranslated, negation dropped, hallucinated noun, leftover English) | Single-segment LLM retry at temperature 0.1 (Step H) |
| Retry still fails `isLikelyUntranslated` | Mark as `[미번역] <src>` |
| Inference exception mid-batch | Log error, return partial expanded results immediately |

### Screen Layer (`app/youtube-player.tsx`)

| Phase state | Meaning | User sees |
|---|---|---|
| `"fetching"` | Waiting for proxy response | Loading indicator |
| `"translating"` | Gemma in progress | Progress bar + original text |
| `"done"` | Complete | Final translated subtitles |
| `"no_subtitles"` | Proxy returned nothing | Message + option to retry |
| `"error"` | Exception thrown | Error toast + retry button |

**`handleRetrySubtitles()`** resets all refs (`cancelledRef`, `lastFetchResult`, `allSegmentsRef`, `translationCacheRef`), clears the subtitle store, then triggers a fresh fetch after 300 ms.

**`cancelledRef`** gate: every `await` point checks `if (cancelledRef.current) return` to abort silently if the user navigates away or cancels.

---

## 12. Data Flow Diagram

```
┌─────────────────────────────────────────────────────┐
│ 1. USER INPUTS YOUTUBE URL                          │
│    parseYoutubeId(url) → videoId                    │
│    store.setYoutubeVideo(videoId)                   │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 2. YOUTUBE PLAYER READY                             │
│    handlePlayerReady() → phase = "fetching"         │
│    YouTubePlayer.doFetch(videoId) starts            │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 3. PROXY SERVER (server/server.js)                  │
│    GET /subtitles?videoId=xxx&lang=en               │
│    → yt-dlp spawn (json3 preferred)                 │
│    → parseJson3ToSegments() or parseVtt()           │
│    → clean overlaps, extract short responses        │
│    → groupWordsIntoPhrases() → mergeOrphanPhrases() │
│    → return { segments[], language, source }        │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 4. CLIENT DEDUP & CLEAN (YouTubePlayer.doFetch)     │
│    → sort, deduplicate 0.1 s, trim overlaps         │
│    → onSubtitlesLoaded callback                     │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 5. SPEAKER DIARIZATION (youtube-player.tsx)         │
│    assignSpeakerIds(segments)                       │
│    → group into sentences → 5-rule assignment       │
│    → speakerId = "A" | "B" on each segment          │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 6. SENTENCE ASSEMBLY                                │
│    assembleIntoSentences(segments)                  │
│    → SentenceUnit[] with sourceTexts[]              │
│    → store original subtitles (phase = "translating")│
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 7. GEMMA TRANSLATION (gemmaTranslationService.ts)   │
│    translateSegments(sentences, …)                  │
│    ├─ dedup overlaps, clean ASR artifacts           │
│    ├─ mergeFragments → absorbShortGroups            │
│    ├─ buildProperNounDict                           │
│    ├─ load checkpoint (resume if < 24h)             │
│    ├─ batch loop (5-segment batches)                │
│    │   ├─ 1-batch sliding window context            │
│    │   ├─ 3-pass response parsing                   │
│    │   ├─ longer sleep every 5 batches (thermal)    │
│    │   └─ save checkpoint                           │
│    ├─ multi-attempt retry for failed/passthrough    │
│    ├─ expandGroupTranslations → original slots      │
│    ├─ validateTranslations + single-seg retries     │
│    └─ adjustTimingsForReadability                   │
│    onProgress(completed, total, partial) → store    │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 8. DISPLAY EXPANSION (youtube-player.tsx)           │
│    Step 3: splitTranslatedSentence per sentence     │
│    Step 4: redistributeTimestamps (proportional)    │
│    Step 5: applyMinDuration (min 1.2 s)             │
│    Step 6: applyTwoLineFormat (> 20 chars)          │
│    → adjustSpeakerTimings                           │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 9. STORE UPDATE & DISPLAY (phase = "done")          │
│    store.setSubtitles(finalSegments)                │
│    SubtitleOverlay: 500 ms poll → active segment    │
│    Display mode: both | original | translation      │
└─────────────────────────────────────────────────────┘
```

---

## 13. Key Implementation Details

### Why Sentence-Level Translation?

yt-dlp word-level output gives 1–3 words per segment. Sending fragments like `"are"` or `"you adept"` to the LLM produces poor results — the model lacks context. `assembleIntoSentences` groups these into full sentences before LLM input, then `splitTranslatedSentence` + `redistributeTimestamps` expand the result back to per-word segments with accurate timing.

### Thermal Sleep Strategy

[UPDATED] Every `THERMAL_EVERY_N = 5` batches the inter-batch sleep is extended to `SLEEP_THERMAL_MS = 2500` ms (vs. the normal `SLEEP_BETWEEN_MS = 600` ms). This gives the device time to shed heat on long videos. The sliding window context (previous batch as user+assistant turns) is always included regardless of thermal boundary — no KV-cache or context drop occurs.

### Checkpoint Resumability

Long videos (30–60 min) can take several minutes to translate. If the app is backgrounded or the device sleeps, the checkpoint allows exact resumption — the model picks up from `lastBatchIndex + 1` with `mergedTranslations[]` pre-populated from the saved state.

### Proportional Re-Expansion

[UPDATED] When a merged group of N raw segments is translated as a unit, the translation must be distributed across N display slots. For dense translations (N ≥ 3 with fewer than 6 chars per slot), the translation is split at a sentence boundary into two halves and placed at time-proportional slots. For the default case, words are allocated proportionally by each original segment's non-space character count. Adjacent slots that are identical or overlap by ≥ 6 chars are deduplicated in a backward pass. Slots intentionally left empty use empty string `""` as the suppression signal — the display layer shows empty rather than falling back to the English source.

### Multi-Attempt Retry for Failed Segments

[ADDED] After the main batch loop and before per-segment validation, a separate retry pass (up to 2 attempts) re-submits all segments whose translation is empty, identical to the English source (for lengths > 15 chars), or is a bare number. Failed segments are collected across the deduplicated segment array, re-batched together, and sent to the LLM with the same system prompt. This catches expansion artifacts and merge-boundary gaps without requiring per-segment single calls.

### Speaker ID Preservation

`speakerId` is assigned during diarization (Step 6), carried through sentence assembly (`SentenceUnit.speakerId`), translation input construction (`input[].speakerId`), sentence-to-segment expansion (`sentence.speakerId` applied to all constituent segments), and all post-processing steps (which use spread copies). The final `SubtitleSegment` always has `speakerId` from the sentence that contained it.

### Hallucination Guard in Validation

[ADDED] `validateTranslations` checks for two classes of hallucinated proper nouns: (1) a hard-coded guard list (`HALLUCINATION_GUARD`) of common AI assistants (시리/Siri, 알렉사/Alexa, 구글/Google) that the model frequently injects from context, and (2) any noun in the video-specific `patterns` dictionary whose Korean form appears in the translation but whose English source form is absent from the current segment. Both trigger a single-segment retry.

---

## 14. File Manifest

| File | Role |
|---|---|
| `server/server.js` | Express proxy, yt-dlp spawn, JSON3/VTT parsing, phrase grouping, server-side cache |
| `services/youtubeTimedText.ts` | Client fetch interface to proxy (`fetchYoutubeSubtitles`), 10 s timeout, typed errors |
| `services/gemmaTranslationService.ts` | Full Gemma translation pipeline: fragment merge, batch LLM, multi-attempt retry, per-segment validation, timing adjustment |
| [UPDATED] `services/translationUtils.ts` | Rule-based post-translation correction: `normalizeTranslation()`, `PHONETIC_CORRECTIONS` (loanword mis-renderings), `DOMAIN_TERMS` (domain-specific substitutions) |
| `store/usePlayerStore.ts` | Zustand store: subtitle array, player mode, `appendSubtitles`, `setSubtitles`, `updateSubtitle` |
| `app/youtube-player.tsx` | Main screen: speaker diarization, sentence assembly, translation orchestration, display expansion pipeline (Steps 3–6), subtitle phase state machine |
| `components/YouTubePlayer.tsx` | WebView-based player, `doFetch` on ready, 500 ms subtitle polling, `onSubtitlesLoaded` callback |
| `components/SubtitleOverlay.tsx` | Real-time subtitle display, store subscription, display mode rendering |
| `constants/languageProfiles.ts` | Per-language system prompt rules, cleanup functions, transliteration validity checks |
| `app/index.tsx` | Home screen, URL input modal, `parseYoutubeId`, `setYoutubeVideo` |
