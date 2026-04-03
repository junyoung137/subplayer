import AsyncStorage from "@react-native-async-storage/async-storage";
import { SubtitleSegment } from "../store/usePlayerStore";

const PREFIX = "realtimesub_cache_";

export interface SubtitleCacheEntry {
  videoUri: string;
  subtitles: SubtitleSegment[];
  /** Target language the subtitles were translated into (e.g. "ko"). */
  language: string;
  /** Source language of the audio/original text (e.g. "en"). Needed when
   *  re-translating to a different target language without re-running Whisper. */
  sourceLanguage: string;
  createdAt: number;
}

/** AsyncStorage key for a given video URI. */
function cacheKey(videoUri: string): string {
  return PREFIX + videoUri;
}

/**
 * Returns the raw cache entry for a video URI, or null if nothing is stored.
 * Does NOT filter by language — callers decide what to do with a mismatch.
 */
export async function getCacheEntry(
  videoUri: string
): Promise<SubtitleCacheEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(videoUri));
    if (!raw) return null;
    return JSON.parse(raw) as SubtitleCacheEntry;
  } catch {
    return null;
  }
}

/**
 * Returns cached subtitles for the given video URI + target language,
 * or null if nothing is cached / the stored language doesn't match.
 */
export async function getCachedSubtitles(
  videoUri: string,
  targetLanguage: string
): Promise<SubtitleSegment[] | null> {
  const entry = await getCacheEntry(videoUri);
  if (!entry) return null;
  // Invalidate if the user changed target language since the cache was written.
  if (entry.language !== targetLanguage) return null;
  return entry.subtitles;
}

/**
 * Persists subtitles for a video + language pair.
 * Silently swallows storage errors — cache is best-effort.
 */
export async function saveSubtitleCache(
  videoUri: string,
  targetLanguage: string,
  subtitles: SubtitleSegment[],
  sourceLanguage: string = "en"
): Promise<void> {
  try {
    const entry: SubtitleCacheEntry = {
      videoUri,
      subtitles,
      language: targetLanguage,
      sourceLanguage,
      createdAt: Date.now(),
    };
    await AsyncStorage.setItem(cacheKey(videoUri), JSON.stringify(entry));
  } catch (e) {
    console.warn("[subtitleCache] Failed to save:", e);
  }
}

/** Removes the cached subtitles for a video URI. */
export async function clearCacheForUri(videoUri: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(cacheKey(videoUri));
  } catch {
    // ignore
  }
}
