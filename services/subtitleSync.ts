import { SubtitleSegment } from "../store/usePlayerStore";

/**
 * Find the active subtitle for the given video time + timing offset.
 */
export function getActiveSubtitle(
  subtitles: SubtitleSegment[],
  currentTime: number,
  timingOffset: number
): SubtitleSegment | null {
  const adjustedTime = currentTime + timingOffset;
  return (
    subtitles.find(
      (s) => adjustedTime >= s.startTime && adjustedTime <= s.endTime
    ) ?? null
  );
}

/**
 * Build a subtitle segment from chunk timing and transcription.
 */
export function buildSegment(params: {
  index: number;
  startTime: number;
  chunkDuration: number;
  original: string;
  translated: string;
}): SubtitleSegment {
  return {
    id: `sub_${params.index}_${params.startTime}`,
    startTime: params.startTime,
    endTime: params.startTime + params.chunkDuration,
    original: params.original,
    translated: params.translated,
  };
}
