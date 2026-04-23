/**
 * subtitleDB.ts — v5 (patched)
 *
 * 변경사항 (v5 → v5-patched):
 * ─────────────────────────────────────────────────────────────────────────────
 * [FIX A] _batchUpsertSegments: 빈 translated로 기존 번역 덮어쓰기 방지
 *   - DO UPDATE SET translated = excluded.translated
 *     → CASE WHEN excluded.translated != '' THEN ... ELSE 기존값 유지
 *   - partial 저장 중 translated='' 세그먼트가 이미 번역된 세그먼트를
 *     덮어쓰던 버그 수정
 *
 * [FIX B] _doSave (full 저장): translated 없는 배열의 full 저장 차단
 *   - segments 전체에 translated=''이면 DB 저장 자체를 skip
 *   - patchSubtitles 렌더 사이클 타이밍 문제로 번역 없는 배열이
 *     isPartial=false로 저장되던 버그 수정
 *   - 기존 partial 캐시가 빈 full로 덮어써지는 현상 방지
 *
 * 원본 v5 변경사항 (유지):
 * ─────────────────────────────────────────────────────────────────────────────
 * [FIX 1] DELETE+INSERT → UPSERT diff 저장
 * [FIX 2] makeSegmentId: toFixed(3) → Math.round(* 1000) ms 기반
 * [FIX 3] translated_count 컬럼 추가 — resume 고도화
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as SQLite from "expo-sqlite";
import { SubtitleSegment } from "../store/usePlayerStore";

// ── 상수 ─────────────────────────────────────────────────────────────────────

const DB_NAME                = "subtitles_v5.db";
const CACHE_TTL_MS           = 7 * 24 * 60 * 60 * 1000;
const LRU_MAX_ITEMS          = 50;
const BATCH_CHUNK_SIZE       = 166;
const PARTIAL_THROTTLE_COUNT = 10;

// ── [FIX 2] segmentId 생성 — ms 기반 정수 (float rounding 완전 제거) ──────────
// YoutubePlayerScreen.makeSegmentId와 반드시 동일해야 함
export function makeSegmentId(startTime: number, endTime: number): string {
  return `${Math.round(startTime * 1000)}_${Math.round(endTime * 1000)}`;
}

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface CacheInfo {
  videoId:          string;
  language:         string;
  genre:            string;
  cachedAt:         number;
  isPartial:        boolean;
  count:            number;
  translatedCount:  number;
}

// ── DB 싱글톤 ─────────────────────────────────────────────────────────────────

let _db: SQLite.SQLiteDatabase | null = null;
let _initPromise: Promise<void> | null = null;

function getDB(): SQLite.SQLiteDatabase {
  if (!_db) throw new Error("[DB] initDB()를 먼저 호출하세요.");
  return _db;
}

// ── in-memory lock ────────────────────────────────────────────────────────────

const _inFlight = new Map<string, Promise<void>>();

function lockKey(videoId: string, language: string, genre: string): string {
  return `${videoId}::${language}::${genre}`;
}

// ── partial throttle: translatedCount 기준 ────────────────────────────────────

const _partialLastSaved = new Map<string, number>();

// ── 초기화 ────────────────────────────────────────────────────────────────────

export async function initDB(): Promise<void> {
  if (_db) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    _db = await SQLite.openDatabaseAsync(DB_NAME);

    await _db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS subtitle_cache (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id         TEXT    NOT NULL,
      language         TEXT    NOT NULL,
      genre            TEXT    NOT NULL,
      cached_at        INTEGER NOT NULL,
      is_partial       INTEGER NOT NULL DEFAULT 0,
      translated_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(video_id, language, genre)
    );

    CREATE TABLE IF NOT EXISTS subtitle_segments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_id    INTEGER NOT NULL
                  REFERENCES subtitle_cache(id) ON DELETE CASCADE,
      segment_id  TEXT    NOT NULL,
      start_time  REAL    NOT NULL,
      end_time    REAL    NOT NULL,
      original    TEXT    NOT NULL,
      translated  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cache_lookup
      ON subtitle_cache(video_id, language, genre);

    CREATE INDEX IF NOT EXISTS idx_segments_order
      ON subtitle_segments(cache_id, start_time);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_unique
      ON subtitle_segments(cache_id, segment_id);
  `);

    console.log("[DB] v5 초기화 완료");
  })();
  await _initPromise;
}

// ── 저장: 완료 자막 ───────────────────────────────────────────────────────────

export async function saveSubtitles(
  videoId: string,
  language: string,
  genre: string,
  segments: SubtitleSegment[],
): Promise<void> {
  const key = lockKey(videoId, language, genre);

  if (_inFlight.has(key)) {
    await _inFlight.get(key);
    return;
  }

  const p = _doSave(videoId, language, genre, segments, false, segments.length);
  _inFlight.set(key, p);
  try {
    await p;
  } finally {
    _inFlight.delete(key);
    _partialLastSaved.delete(key);
  }
}

// ── 저장: 번역 진행 중 partial ────────────────────────────────────────────────

/**
 * @param translatedCount 현재까지 번역 완료된 세그먼트 수 (throttle 기준)
 */
export async function savePartialSubtitles(
  videoId: string,
  language: string,
  genre: string,
  segments: SubtitleSegment[],
  translatedCount: number,
): Promise<void> {
  const key = lockKey(videoId, language, genre);
  if (_inFlight.has(key)) return;

  const lastSaved = _partialLastSaved.get(key) ?? 0;
  if (translatedCount - lastSaved < PARTIAL_THROTTLE_COUNT) return;

  _partialLastSaved.set(key, translatedCount);
  await _doSave(videoId, language, genre, segments, true, translatedCount);
}

// ── 내부 저장 로직 ────────────────────────────────────────────────────────────

async function _doSave(
  videoId: string,
  language: string,
  genre: string,
  segments: SubtitleSegment[],
  isPartial: boolean,
  translatedCount: number,
): Promise<void> {
  if (segments.length === 0) return;

  const db = getDB();

  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ id: number }>(
      `INSERT INTO subtitle_cache
         (video_id, language, genre, cached_at, is_partial, translated_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id, language, genre)
       DO UPDATE SET
         cached_at        = excluded.cached_at,
         is_partial       = excluded.is_partial,
         translated_count = excluded.translated_count
       WHERE
         subtitle_cache.cached_at <= excluded.cached_at
         AND (
           subtitle_cache.is_partial = 1
           OR excluded.is_partial = 0
         )
       RETURNING id`,
      [videoId, language, genre, Date.now(), isPartial ? 1 : 0, translatedCount],
    );

    if (!row) {
      console.log(`[DB] 덮어쓰기 건너뜀 (full 보호 또는 최신 데이터 존재): ${videoId}/${language}/${genre}`);
      return;
    }

    const cacheId = row.id;

    if (isPartial) {
      // [FIX 1] partial: DELETE 없이 UPSERT only (diff 저장)
      await _batchUpsertSegments(db, cacheId, segments);
    } else {
      // ── [FIX B] full 저장: translated 없는 배열 차단 ──────────────────────
      // patchSubtitles 렌더 타이밍으로 translated='' 배열이 full 저장되는 버그 방지
      const actualTranslatedCount = segments.filter(
        (s) => s.translated && s.translated.trim() !== ""
      ).length;

      if (actualTranslatedCount === 0) {
        console.log(
          `[DB] full 저장 차단 — translated 없음: ${videoId}/${language}/${genre} ` +
          `(segments=${segments.length}, translated=0)`
        );
        return;
      }

      console.log(
        `[DB] full 저장 진행: ${videoId}/${language}/${genre} ` +
        `(translated=${actualTranslatedCount}/${segments.length})`
      );

      // 최종 저장: 완전 교체 보장 (순서 정합성)
      await db.runAsync(
        `DELETE FROM subtitle_segments WHERE cache_id = ?`,
        [cacheId],
      );
      await _batchInsertSegments(db, cacheId, segments);
    }
  });

  await _enforceLRU(db);

  console.log(
    `[DB] 저장 완료${isPartial ? ` (partial ${translatedCount}개)` : ""}: ` +
    `${videoId}/${language}/${genre} — 총 ${segments.length}개`,
  );
}

// ── [FIX 1 + FIX A] batch UPSERT (partial 전용) ───────────────────────────────
// [FIX A] UNIQUE(cache_id, segment_id) 충돌 시:
//   - translated가 비어있지 않을 때만 업데이트 (빈 문자열로 기존 번역 덮어쓰기 방지)
//   - translated=''인 경우 기존 DB 값을 그대로 유지

async function _batchUpsertSegments(
  db: SQLite.SQLiteDatabase,
  cacheId: number,
  segments: SubtitleSegment[],
): Promise<void> {
  for (let offset = 0; offset < segments.length; offset += BATCH_CHUNK_SIZE) {
    const chunk = segments.slice(offset, offset + BATCH_CHUNK_SIZE);

    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(",");
    const values = chunk.flatMap((seg) => [
      cacheId,
      makeSegmentId(seg.startTime, seg.endTime),
      seg.startTime,
      seg.endTime,
      seg.original,
      seg.translated,
    ]);

    await db.runAsync(
      `INSERT INTO subtitle_segments
         (cache_id, segment_id, start_time, end_time, original, translated)
       VALUES ${placeholders}
       ON CONFLICT(cache_id, segment_id)
       DO UPDATE SET
         translated = CASE
           WHEN excluded.translated != '' THEN excluded.translated
           ELSE subtitle_segments.translated
         END`,
      values,
    );
  }
}

// ── batch INSERT (최종 저장 전용) ─────────────────────────────────────────────

async function _batchInsertSegments(
  db: SQLite.SQLiteDatabase,
  cacheId: number,
  segments: SubtitleSegment[],
): Promise<void> {
  for (let offset = 0; offset < segments.length; offset += BATCH_CHUNK_SIZE) {
    const chunk = segments.slice(offset, offset + BATCH_CHUNK_SIZE);

    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(",");
    const values = chunk.flatMap((seg) => [
      cacheId,
      makeSegmentId(seg.startTime, seg.endTime),
      seg.startTime,
      seg.endTime,
      seg.original,
      seg.translated,
    ]);

    await db.runAsync(
      `INSERT INTO subtitle_segments
         (cache_id, segment_id, start_time, end_time, original, translated)
       VALUES ${placeholders}`,
      values,
    );
  }
}

// ── 조회 ─────────────────────────────────────────────────────────────────────

export async function loadSubtitles(
  videoId: string,
  language: string,
  genre: string,
): Promise<{
  segments:         SubtitleSegment[];
  isPartial:        boolean;
  translatedCount:  number;
} | null> {
  const db = getDB();

  const cache = await db.getFirstAsync<{
    id:               number;
    cached_at:        number;
    is_partial:       number;
    translated_count: number;
  }>(
    `SELECT id, cached_at, is_partial, translated_count
     FROM subtitle_cache
     WHERE video_id = ? AND language = ? AND genre = ?`,
    [videoId, language, genre],
  );

  if (!cache) {
    console.log(`[DB] 캐시 없음: ${videoId}/${language}/${genre}`);
    return null;
  }

  if (Date.now() - cache.cached_at > CACHE_TTL_MS) {
    await db.runAsync(`DELETE FROM subtitle_cache WHERE id = ?`, [cache.id]);
    console.log(`[DB] 만료 삭제: ${videoId}/${language}/${genre}`);
    return null;
  }

  const rows = await db.getAllAsync<{
    segment_id: string;
    start_time: number;
    end_time:   number;
    original:   string;
    translated: string;
  }>(
    `SELECT segment_id, start_time, end_time, original, translated
     FROM subtitle_segments
     WHERE cache_id = ?
     ORDER BY start_time ASC`,
    [cache.id],
  );

  if (rows.length === 0) return null;

  const isPartial = cache.is_partial === 1;
  console.log(
    `[DB] 캐시 히트${isPartial ? ` (partial, ${cache.translated_count}/${rows.length})` : ""}: ` +
    `${videoId}/${language}/${genre}`,
  );

  const segments: SubtitleSegment[] = rows.map((r) => ({
    id:         r.segment_id,
    startTime:  r.start_time,
    endTime:    r.end_time,
    original:   r.original,
    translated: r.translated,
  }));

  return {
    segments,
    isPartial,
    translatedCount: cache.translated_count,
  };
}

// ── 삭제 ─────────────────────────────────────────────────────────────────────

export async function deleteSubtitleCache(videoId: string): Promise<void> {
  const db = getDB();
  const result = await db.runAsync(
    `DELETE FROM subtitle_cache WHERE video_id = ?`,
    [videoId],
  );
  console.log(`[DB] 삭제: ${videoId} — ${result.changes}개`);
}

export async function purgeExpiredCache(): Promise<void> {
  const db = getDB();
  const cutoff = Date.now() - CACHE_TTL_MS;
  const result = await db.runAsync(
    `DELETE FROM subtitle_cache WHERE cached_at < ?`,
    [cutoff],
  );
  console.log(`[DB] 만료 정리: ${result.changes}개 삭제`);
}

// ── LRU ──────────────────────────────────────────────────────────────────────

async function _enforceLRU(db: SQLite.SQLiteDatabase): Promise<void> {
  const result = await db.runAsync(
    `DELETE FROM subtitle_cache
     WHERE id IN (
       SELECT id FROM subtitle_cache
       ORDER BY cached_at ASC
       LIMIT MAX(0, (SELECT COUNT(*) FROM subtitle_cache) - ?)
     )`,
    [LRU_MAX_ITEMS],
  );
  if (result.changes > 0) {
    console.log(`[DB] LRU 정리: ${result.changes}개 삭제`);
  }
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

export async function getCacheInfo(): Promise<CacheInfo[]> {
  const db = getDB();

  const rows = await db.getAllAsync<{
    video_id:         string;
    language:         string;
    genre:            string;
    cached_at:        number;
    is_partial:       number;
    translated_count: number;
    cnt:              number;
  }>(
    `SELECT
       c.video_id,
       c.language,
       c.genre,
       c.cached_at,
       c.is_partial,
       c.translated_count,
       COUNT(s.id) AS cnt
     FROM subtitle_cache c
     LEFT JOIN subtitle_segments s ON s.cache_id = c.id
     GROUP BY c.id
     ORDER BY c.cached_at DESC`,
  );

  return rows.map((r) => ({
    videoId:         r.video_id,
    language:        r.language,
    genre:           r.genre,
    cachedAt:        r.cached_at,
    isPartial:       r.is_partial === 1,
    translatedCount: r.translated_count,
    count:           r.cnt,
  }));
}