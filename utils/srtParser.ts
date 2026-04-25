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

function isMixedScript(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)
      && /[a-zA-Z]/.test(text);
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

      const firstLine  = textLines[0];
      const restLines  = textLines.slice(1);
      const restJoined = restLines.join(" ").trim();

      const firstScript   = detectScript(firstLine);
      const restScript    = detectScript(restJoined);
      const firstNotMixed = !isMixedScript(firstLine);
      const differentScripts =
        firstScript !== restScript &&
        firstScript !== "other" &&
        restScript  !== "other";

      if (differentScripts && firstNotMixed && firstLine.length > 3 && restJoined.length > 3) {
        // Bilingual: first line = source language, rest (possibly wrapped) = translation
        original   = firstLine;
        translated = restJoined;
      } else {
        // Same script or ambiguous: treat as monolingual
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
