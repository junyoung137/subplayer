import { SubtitleSegment } from "../store/usePlayerStore";

const BLANK_PATTERNS = [
  "[BLANK_AUDIO]", "[blank_audio]", "[silence]", "[SILENCE]",
];

type Script = "latin" | "cjk" | "other";

function detectScript(text: string): Script {
  const hasCJK   = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);
  if (hasCJK && !hasLatin) return "cjk";
  if (hasLatin && !hasCJK) return "latin";
  return "other";
}


function parseTimecode(tc: string): number {
  // HH:MM:SS,mmm
  const [hms, ms] = tc.trim().split(",");
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

export function parseSrt(content: string): SubtitleSegment[] {
  // Normalize line endings, strip BOM
  const normalized = content
    .replace(/\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const blocks = normalized.split(/\n\n+/);
  const segments: SubtitleSegment[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;

    // First line should be an index number
    const indexLine = lines[0].trim();
    if (!/^\d+$/.test(indexLine)) continue;

    // Second line should be timecode
    const timecodeLine = lines[1].trim();
    const tcMatch = timecodeLine.match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );
    if (!tcMatch) continue;

    const startTime = parseTimecode(tcMatch[1]);
    const endTime = parseTimecode(tcMatch[2]);

    // Remaining lines are text
    const textLines = lines.slice(2).map((l) => l.trim()).filter((l) => l.length > 0);
    if (textLines.length === 0) continue;
    const joined = textLines.join(" ");
    if (BLANK_PATTERNS.some((p) => joined.includes(p))) continue;

    let original: string;
    let translated: string;

    if (textLines.length >= 2) {
      // Deduplicate: if all lines are identical, treat as single line
      const uniqueLines = [...new Set(textLines)];
      if (uniqueLines.length === 1) {
        original   = uniqueLines[0].replace(/^-\s*/, "").trim();
        translated = original;
        const id = `srt_${indexLine}_${Math.round(startTime * 1000)}`;
        segments.push({ id, startTime, endTime, original, translated });
        continue;
      }

      // Find the best split point using dominant-script scoring.
      // Counts CJK vs Latin chars in each half to tolerate mixed-script lines
      // (e.g. Korean text containing a Latin acronym like "MMO").
      let bestSplit = -1;
      let bestScore = -1;

      for (let i = 1; i < textLines.length; i++) {
        const topText    = textLines.slice(0, i).join(" ").trim();
        const bottomText = textLines.slice(i).join(" ").trim();

        const topCJK    = (topText.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
        const topLatin  = (topText.match(/[a-zA-Z]/g) ?? []).length;
        const botCJK    = (bottomText.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
        const botLatin  = (bottomText.match(/[a-zA-Z]/g) ?? []).length;

        const topDominant = topCJK > topLatin ? "cjk" : topLatin > topCJK ? "latin" : "other";
        const botDominant = botCJK > botLatin ? "cjk" : botLatin > botCJK ? "latin" : "other";

        if (
          topDominant !== botDominant &&
          topDominant !== "other" &&
          botDominant !== "other" &&
          topText.length > 3 &&
          bottomText.length > 3
        ) {
          const score = Math.abs(topCJK - topLatin) + Math.abs(botCJK - botLatin);
          if (score > bestScore) {
            bestScore = score;
            bestSplit = i;
          }
        }
      }

      if (bestSplit !== -1) {
        original   = textLines.slice(0, bestSplit).join(" ").trim();
        translated = textLines.slice(bestSplit).join(" ").trim();
      } else {
        // Same dominant script or ambiguous: monolingual
        original   = joined;
        translated = joined;
      }
    } else {
      original   = textLines[0];
      translated = textLines[0];
    }

    const id = `srt_${indexLine}_${Math.round(startTime * 1000)}`;
    segments.push({
      id,
      startTime,
      endTime,
      original,
      translated,
    });
  }

  return segments.sort((a, b) => a.startTime - b.startTime);
}
