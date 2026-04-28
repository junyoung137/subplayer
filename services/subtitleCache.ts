import AsyncStorage from "@react-native-async-storage/async-storage";
import { SubtitleSegment } from "../store/usePlayerStore";

const PREFIX = "realtimesub_cache_";

const MAX_SUBTITLE_CACHE_ENTRIES = 20;
const EVICTION_TRIGGER = MAX_SUBTITLE_CACHE_ENTRIES + 5;

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

/**
 * AsyncStorage key for a given video URI + target language.
 * Each language gets its own cache slot so switching languages is instant
 * after the first translation.
 */
function cacheKey(videoUri: string, language: string): string {
  return `${PREFIX}${language}_${videoUri}`;
}

/**
 * Returns the raw cache entry for a video URI + language, or null if nothing
 * is stored for that combination.
 */
export async function getCacheEntry(
  videoUri: string,
  targetLanguage: string
): Promise<SubtitleCacheEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(videoUri, targetLanguage));
    if (!raw) return null;
    return JSON.parse(raw) as SubtitleCacheEntry;
  } catch {
    return null;
  }
}

/**
 * Returns cached subtitles for the given video URI + target language,
 * or null if nothing is cached for that combination.
 */
export async function getCachedSubtitles(
  videoUri: string,
  targetLanguage: string
): Promise<SubtitleSegment[] | null> {
  const entry = await getCacheEntry(videoUri, targetLanguage);
  if (!entry) return null;
  return entry.subtitles;
}

/**
 * Persists subtitles for a video + language pair.
 * Each language is stored under its own key so switching languages never
 * overwrites a previously translated result.
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
    await AsyncStorage.setItem(
      cacheKey(videoUri, targetLanguage),
      JSON.stringify(entry)
    );

    try {
      // WARNING: getAllKeys() scans entire AsyncStorage.
      // Acceptable here — subtitle cache stays small (<30 entries typical).
      // Do NOT copy this pattern for high-frequency writes elsewhere.
      const allKeys   = await AsyncStorage.getAllKeys();
      const cacheKeys = allKeys.filter(k => k.startsWith(PREFIX));

      if (cacheKeys.length > EVICTION_TRIGGER) {
        // Sort by timestamp in the stored value — do NOT rely on key ordering.
        const raw = await AsyncStorage.multiGet(cacheKeys);
        const parsed = raw
          .map(([key, val]) => {
            try {
              const obj = JSON.parse(val ?? '{}');
              return {
                key,
                timestamp: typeof obj.createdAt === 'number' ? obj.createdAt : 0,
              };
            } catch {
              return { key, timestamp: 0 };
            }
          })
          .sort((a, b) => a.timestamp - b.timestamp);  // oldest first

        const toDelete = parsed
          .slice(0, parsed.length - MAX_SUBTITLE_CACHE_ENTRIES)
          .map(e => e.key);

        if (toDelete.length > 0) {
          await AsyncStorage.multiRemove(toDelete);
          console.log(`[SubtitleCache] evicted ${toDelete.length} old entries`);
        }
      }
    } catch (evictErr) {
      console.warn("[subtitleCache] Eviction failed (non-fatal):", evictErr);
    }
  } catch (e) {
    console.warn("[subtitleCache] Failed to save:", e);
  }
}

/** Removes the cached subtitles for a specific video URI + language. */
export async function clearCacheForUri(
  videoUri: string,
  targetLanguage?: string
): Promise<void> {
  try {
    if (targetLanguage) {
      await AsyncStorage.removeItem(cacheKey(videoUri, targetLanguage));
    } else {
      // targetLanguage 미지정 시 전체 언어 캐시 삭제
      const allKeys = await AsyncStorage.getAllKeys();
      const toDelete = allKeys.filter((k) =>
        k.startsWith(PREFIX) && k.endsWith(videoUri)
      );
      if (toDelete.length > 0) {
        await AsyncStorage.multiRemove(toDelete);
      }
    }
  } catch {
    // ignore
  }
}