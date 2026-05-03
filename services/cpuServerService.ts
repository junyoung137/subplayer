/**
 * cpuServerService.ts
 *
 * Client for the CPU server that runs yt-dlp audio extraction.
 * No proxy pool logic, no billing logic, no RunPod calls.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── URL management ────────────────────────────────────────────────────────────
// Mirrors the exact in-memory cache + AsyncStorage fallback pattern used in
// youtubeTimedText.ts (setProxyBaseUrl / getProxyBaseUrl).

const CPU_SERVER_STORAGE_KEY = 'cpu_server_base_url';

// In-memory cache — avoids AsyncStorage round-trip on every call.
let _cachedCpuServerUrl: string | null = null;

/**
 * Called once from FG context to persist the resolved URL.
 * Also seeds the in-memory cache so FG calls never touch AsyncStorage.
 */
export function setCpuServerBaseUrl(url: string): void {
  _cachedCpuServerUrl = url;
  AsyncStorage.setItem(CPU_SERVER_STORAGE_KEY, url).catch(() => {});
}

/**
 * Reads the CPU server base URL. In FG context returns the in-memory cache.
 * In HeadlessJS context reads AsyncStorage on first call, then caches.
 */
export async function getCpuServerBaseUrl(): Promise<string> {
  if (_cachedCpuServerUrl) return _cachedCpuServerUrl;
  try {
    const stored = await AsyncStorage.getItem(CPU_SERVER_STORAGE_KEY);
    _cachedCpuServerUrl = stored ?? 'https://YOUR_CPU_SERVER_URL';
  } catch {
    _cachedCpuServerUrl = 'https://YOUR_CPU_SERVER_URL';
  }
  return _cachedCpuServerUrl;
}

export function isCpuServerConfigured(url: string): boolean {
  return !!url && !url.includes('YOUR_CPU_SERVER_URL');
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type CpuExtractErrorType = 'network' | 'bot_403' | 'timeout' | 'not_available';

export class CpuExtractError extends Error {
  type: CpuExtractErrorType;
  shouldTryPlaywright: boolean;
  constructor(type: CpuExtractErrorType, message: string) {
    super(message);
    this.name = 'CpuExtractError';
    this.type = type;
    this.shouldTryPlaywright = type === 'bot_403';
  }
}

export interface CpuChunkResult {
  chunkIndex: number;
  chunkStartSec: number;
  audioBase64: string;
  durationSec: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a signal that aborts when either a or b aborts.
 * Uses AbortSignal.any() when available; falls back to a manual implementation.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  // Native path (Node 20+ / modern browsers)
  if (typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any(signals);
  }
  // Manual fallback
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort();
      break;
    }
    sig.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

// ── Chunk-unit API ────────────────────────────────────────────────────────────

/**
 * Extracts a single audio chunk from the CPU server via yt-dlp.
 *
 * Throws CpuExtractError (never a raw Error) on any failure:
 *   - HTTP 403 or bot_detected in response → type='bot_403', shouldTryPlaywright=true
 *   - AbortError / timeout (90 s)          → type='timeout'
 *   - Network / fetch error                → type='network'
 */
export async function extractChunkViaCpuServer(
  stableVideoId: string,
  startSec: number,
  durationSec: number,
  sourceLanguage: string,
  signal?: AbortSignal,
): Promise<CpuChunkResult> {
  const base = await getCpuServerBaseUrl();

  const internalController = new AbortController();
  const timeoutId = setTimeout(() => internalController.abort(), 90_000);

  const combinedSignal = signal
    ? anySignal([internalController.signal, signal])
    : internalController.signal;

  try {
    let response: Response;
    try {
      response = await fetch(`${base}/extract-chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: stableVideoId,
          startSec,
          durationSec,
          sourceLanguage,
        }),
        signal: combinedSignal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new CpuExtractError('timeout', 'CPU server chunk extraction timed out');
      }
      throw new CpuExtractError('network', err?.message ?? 'Network error');
    }

    if (response.status === 403) {
      throw new CpuExtractError('bot_403', 'YouTube bot detection on CPU server');
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new CpuExtractError('network', 'CPU server returned invalid JSON');
    }

    if (json?.bot_detected === true) {
      throw new CpuExtractError('bot_403', 'YouTube bot detection on CPU server');
    }

    if (!response.ok) {
      throw new CpuExtractError(
        'network',
        `CPU server returned HTTP ${response.status}`,
      );
    }

    return json as CpuChunkResult;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Subtitle check API ────────────────────────────────────────────────────────

/**
 * Checks whether the CPU server reports a manual subtitle track for the given
 * video. Returns true if { hasManualSubtitle: true }, false on any error.
 * Never throws.
 */
export async function checkManualSubtitleAvailable(videoId: string): Promise<boolean> {
  try {
    const base = await getCpuServerBaseUrl();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);

    let response: Response;
    try {
      response = await fetch(
        `${base}/check-manual-subtitle?videoId=${encodeURIComponent(videoId)}`,
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      console.log('[CpuServer] manual subtitle check:', videoId, false);
      return false;
    }

    const json = await response.json();
    const result = json?.hasManualSubtitle === true;
    console.log('[CpuServer] manual subtitle check:', videoId, result);
    return result;
  } catch {
    console.log('[CpuServer] manual subtitle check:', videoId, false);
    return false;
  }
}
