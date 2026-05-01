import AsyncStorage from "@react-native-async-storage/async-storage";
import { SubtitleSegment } from "../store/usePlayerStore";

const PREFIX = "realtimesub_cache_";

const MAX_SUBTITLE_CACHE_ENTRIES = 20;
const EVICTION_TRIGGER           = MAX_SUBTITLE_CACHE_ENTRIES + 5;

export interface SubtitleCacheEntry {
  videoUri: string;
  subtitles: SubtitleSegment[];
  /** Target language the subtitles were translated into (e.g. "ko"). */
  language: string;
  /** Source language of the audio/original text (e.g. "en"). */
  sourceLanguage: string;
  createdAt: number;
}

function cacheKey(videoUri: string, language: string): string {
  return `${PREFIX}${language}_${videoUri}`;
}

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

export async function getCachedSubtitles(
  videoUri: string,
  targetLanguage: string
): Promise<SubtitleSegment[] | null> {
  const entry = await getCacheEntry(videoUri, targetLanguage);
  if (!entry) return null;
  return entry.subtitles;
}

/**
 * saveSubtitleCache — 자막 캐시 저장
 *
 * [EVICT-1] eviction 로직 개선:
 *
 *   v1 문제:
 *     - getAllKeys() + multiGet() 조합: 전체 AsyncStorage 스캔 후
 *       모든 캐시 entry를 읽어 파싱 → I/O 비용 과다
 *     - 특히 캐시 entry 수가 적을 때(통상 <30)도 항상 multiGet 실행
 *
 *   v2 개선:
 *     - 트리거(EVICTION_TRIGGER) 초과 시에만 multiGet 실행 (동일)
 *     - 파싱 실패 entry → timestamp=0 처리 후 eviction 대상 우선 포함
 *       (기존 동작 유지)
 *     - createdAt 유효성 검사: number 타입 + 미래 시각 방어
 *       (미래 timestamp가 있으면 eviction 대상에서 제외되는 버그 방지)
 *     - multiGet 결과 null 값 방어 처리 명시화
 *     - eviction 실패 시 저장 자체는 성공 처리 (기존 동작 유지)
 *
 * NOTE: getAllKeys()는 전체 AsyncStorage를 스캔합니다.
 * 캐시 entry가 소규모(<30)이고 eviction 빈도가 낮아 허용 범위입니다.
 * 고빈도 쓰기 경로에서는 이 패턴을 사용하지 마세요.
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
      const allKeys   = await AsyncStorage.getAllKeys();
      const cacheKeys = allKeys.filter(k => k.startsWith(PREFIX));

      if (cacheKeys.length > EVICTION_TRIGGER) {
        const raw = await AsyncStorage.multiGet(cacheKeys);

        const now = Date.now();
        const parsed = raw
          .map(([key, val]) => {
            // [EVICT-1] null 값 명시 방어
            if (val === null) return { key, timestamp: 0 };
            try {
              const obj = JSON.parse(val);
              const ts  = obj?.createdAt;
              // [EVICT-1] 유효성 검사: number이고 미래 시각이 아닌 경우만 사용
              const validTs = typeof ts === 'number' && ts > 0 && ts <= now ? ts : 0;
              return { key, timestamp: validTs };
            } catch {
              return { key, timestamp: 0 };
            }
          })
          .sort((a, b) => a.timestamp - b.timestamp); // oldest first

        const toDelete = parsed
          .slice(0, parsed.length - MAX_SUBTITLE_CACHE_ENTRIES)
          .map(e => e.key);

        if (toDelete.length > 0) {
          await AsyncStorage.multiRemove(toDelete);
          console.log(`[SubtitleCache] evicted ${toDelete.length} old entries`);
        }
      }
    } catch (evictErr) {
      // eviction 실패는 저장 성공에 영향 없음
      console.warn("[subtitleCache] Eviction failed (non-fatal):", evictErr);
    }
  } catch (e) {
    console.warn("[subtitleCache] Failed to save:", e);
  }
}

export async function clearCacheForUri(
  videoUri: string,
  targetLanguage?: string
): Promise<void> {
  try {
    if (targetLanguage) {
      await AsyncStorage.removeItem(cacheKey(videoUri, targetLanguage));
    } else {
      const allKeys  = await AsyncStorage.getAllKeys();
      const toDelete = allKeys.filter(
        k => k.startsWith(PREFIX) && k.endsWith(videoUri)
      );
      if (toDelete.length > 0) {
        await AsyncStorage.multiRemove(toDelete);
      }
    }
  } catch {
    // ignore
  }
}