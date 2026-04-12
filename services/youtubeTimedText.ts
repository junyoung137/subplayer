/**
 * youtubeTimedText.ts — proxy-only
 *
 * Single source: GET /subtitles?videoId=...&lang=...
 * Returns null on any failure (no fallback).
 */
// ── Proxy server URL ──────────────────────────────────────────────────────────
declare const __DEV__: boolean;
const PROXY_BASE_URL: string = __DEV__
  ? "http://192.168.0.101:3001"
  : "https://YOUR_PRODUCTION_URL";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface TimedTextSegment {
  startTime: number;
  endTime: number;
  text: string;
}

export interface FetchSubtitlesResult {
  segments: TimedTextSegment[];
  language: string;
}

export class RateLimitError extends Error {
  constructor() {
    super("YouTube timedtext 429 Rate Limited");
    this.name = "RateLimitError";
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function fetchYoutubeSubtitles(
  videoId?: string,
  preferLang = "en"
): Promise<FetchSubtitlesResult | null> {
  if (!videoId) return null;

  const url = `${PROXY_BASE_URL}/subtitles?videoId=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(preferLang)}`;
  console.log(`[SUBTITLE] proxy fetch start: ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    console.log(`[SUBTITLE] proxy failed: network error — ${e}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.log(`[SUBTITLE] proxy failed: HTTP ${res.status} — ${body.substring(0, 120)}`);
    return null;
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    console.log(`[SUBTITLE] proxy failed: JSON parse error`);
    return null;
  }

  if (!Array.isArray(data.segments) || data.segments.length === 0) {
    console.log(`[SUBTITLE] proxy failed: empty segments`);
    return null;
  }

  console.log(`[SUBTITLE] proxy success: segments=${data.segments.length} lang=${data.language}`);
  return {
    segments: data.segments as TimedTextSegment[],
    language: data.language ?? preferLang,
  };
}