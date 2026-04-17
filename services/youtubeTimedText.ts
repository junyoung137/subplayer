/**
 * youtubeTimedText.ts — proxy-only
 *
 * Single source: GET /subtitles?videoId=...&lang=...
 * Returns null on any failure (no fallback).
 */
// ── Proxy server URL ──────────────────────────────────────────────────────────
// [FIX BUG1] [IMPROVEMENT 1] Async proxy URL resolver with AsyncStorage backing.
// The old __DEV__-based constant resolves at module evaluation time. In a
// HeadlessJS task context (separate JS runtime) __DEV__ is always false, so it
// always picks the production URL — breaking all BG subtitle fetches.
//
// New approach:
//   • FG app calls setProxyBaseUrl(url) once at startup (from _layout.tsx).
//     This stores the URL in AsyncStorage AND caches it in _cachedProxyUrl.
//   • BG task calls getProxyBaseUrl() which reads AsyncStorage on first call,
//     then caches the result in _cachedProxyUrl for subsequent calls.
//   • fetchYoutubeSubtitles() now calls getProxyBaseUrl() instead of reading
//     the module-level constant.
//
// Fallback chain: module cache → AsyncStorage → default prod URL.

import AsyncStorage from '@react-native-async-storage/async-storage';

const PROXY_STORAGE_KEY = 'proxy_base_url';

// Compile-time default (FG context with Metro globals available).
// Used only as the seed value passed to setProxyBaseUrl() at app startup.
declare const __DEV__: boolean | undefined;
const _isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
export const PROXY_BASE_URL_DEFAULT: string = _isDev
  ? 'http://192.168.0.101:3001'
  : 'https://YOUR_PRODUCTION_URL';

// In-memory cache — avoids AsyncStorage round-trip on every fetch call.
let _cachedProxyUrl: string | null = null;

/**
 * Called once from FG context (_layout.tsx) to persist the resolved URL.
 * Also seeds the in-memory cache so FG fetches never touch AsyncStorage.
 */
export function setProxyBaseUrl(url: string): void {
  _cachedProxyUrl = url;
  AsyncStorage.setItem(PROXY_STORAGE_KEY, url).catch(() => {});
}

/**
 * Forces the next getProxyBaseUrl() call to re-read AsyncStorage instead of
 * returning the in-memory cached value. Used by the BG retry loop to recover
 * from the race condition where HeadlessJS starts before the FG context has
 * written the URL to AsyncStorage.
 */
export function clearProxyUrlCache(): void {
  _cachedProxyUrl = null;
}

/**
 * Reads the proxy URL. In FG context this returns the in-memory cache
 * (set by setProxyBaseUrl at startup). In HeadlessJS context it reads
 * AsyncStorage on the first call, then caches the result.
 */
export async function getProxyBaseUrl(): Promise<string> {
  if (_cachedProxyUrl) return _cachedProxyUrl;
  try {
    const stored = await AsyncStorage.getItem(PROXY_STORAGE_KEY);
    _cachedProxyUrl = stored ?? PROXY_BASE_URL_DEFAULT;
  } catch {
    _cachedProxyUrl = PROXY_BASE_URL_DEFAULT;
  }
  return _cachedProxyUrl;
}

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

  // [FIX BUG1] Use async resolver so HeadlessJS context gets the correct URL.
  const proxyBase = await getProxyBaseUrl();

  // Diagnose URL misconfiguration early — the placeholder default is never valid.
  if (!proxyBase || proxyBase.includes('YOUR_PRODUCTION_URL') || proxyBase === 'https://YOUR_PRODUCTION_URL') {
    console.error(
      `[SUBTITLE] proxy URL is still the unset placeholder "${proxyBase}". ` +
      `Ensure setProxyBaseUrl() is called from FG _layout.tsx before the BG task starts, ` +
      `and that AsyncStorage write has persisted before HeadlessJS reads it.`
    );
    return null;
  }

  const url = `${proxyBase}/subtitles?videoId=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(preferLang)}`;
  console.log(`[SUBTITLE] proxy fetch start: strategy=proxy url=${url}`);

  // Fresh AbortController per call — never shared across retries.
  // The 30 s timeout is independent of any task-level abort signal.
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.warn(`[SUBTITLE] 30 s timeout fired for ${url} — aborting`);
    controller.abort();
  }, 30_000);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    console.log(`[SUBTITLE] proxy failed: network error — ${e} url=${url}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 502) {
      // Server returned 502 — yt-dlp exited with non-zero code (DNS/network failure).
      // The server already failed fast; log the detail so it's visible client-side too.
      let detail = body.substring(0, 200);
      try { detail = JSON.parse(body).detail ?? detail; } catch {}
      console.error(
        `[SUBTITLE] proxy 502: server yt-dlp network failure url=${url} detail="${detail}"`
      );
    } else {
      console.log(`[SUBTITLE] proxy failed: HTTP ${res.status} url=${url} body=${body.substring(0, 120)}`);
    }
    return null;
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    console.log(`[SUBTITLE] proxy failed: JSON parse error url=${url}`);
    return null;
  }

  if (!Array.isArray(data.segments) || data.segments.length === 0) {
    console.log(`[SUBTITLE] proxy failed: empty segments url=${url}`);
    return null;
  }

  console.log(`[SUBTITLE] proxy success: segments=${data.segments.length} lang=${data.language} url=${url}`);
  return {
    segments: data.segments as TimedTextSegment[],
    language: data.language ?? preferLang,
  };
}