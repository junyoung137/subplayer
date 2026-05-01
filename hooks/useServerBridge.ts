/**
 * useServerBridge.ts
 * Standard/Pro server-side pipeline. Produces SubtitleSegment[] identical to Free pipeline.
 *
 * BILLING:  safeRecordUsage() only — direct recordUsage() BANNED (RULE 10)
 * RESUME:   fetchCompletedBatches() 3-state → server-authoritative (RULE 4)
 * FALLBACK: classifyServerError() → 3-state → RULE 6
 * RETRY:    [FIX-3 v9] unknown → 1회, retryable → retry, auth/validation → throw
 * CANCEL:   HTTP only — server GPU may continue (RULE 7)
 *           TODO: POST /jobs/:id/cancel 서버 엔드포인트 구현 후 연동
 * UNKNOWN:  Retry ONCE with SAME jobKey (RULE 13) — no billing, no GPU recompute
 *
 * ── CHANGES (v12) ────────────────────────────────────────────────────────────
 * [FIX-7] getEffectiveBatchDuration adaptive 연동 로그 보강
 *
 *   v11: effective/planned/actual 로그 출력
 *   v12: dynamicRatio 값도 함께 로그 출력
 *        → serverBridgeService v14 [FIX-12] adaptive ratio 디버깅 가시성 향상
 *        → "어떤 failureRatio에 어떤 ratio가 선택됐는지" 운영 로그에서 추적 가능
 *
 * v11에서 유지되는 것들:
 *   - [FIX-5 v11] planned vs actual duration 명확히 분리
 *   - [FIX-6 v11] segments.length === 0 → serverTranslate 호출 차단
 *   - [FIX-4 v10] Hybrid quota guard (HARD_MIN / MIN_QUOTA 분기)
 *   - [FIX-5 v10] isLastPartialBatch 파라미터 (calcReservedSeconds 전달)
 *   - [CHECKPOINT] client-side checkpoint read/write/clear
 *   - [RESUME] server + client resume on re-entry
 *   - [BATCH] transcribe + translate loop 구조
 *   - [BILLING] safeRecordUsage call sites
 *   - [PLAYBACK] early playback + streaming partial update
 *   - [FIX-2 v9] serverCompleted timestamp 활용
 *   - [FIX-3 v9] retry policy: unknown vs retryable 명확화
 *   - remainingQuotaSeconds 계산 위치 (Phase A 직전)
 *
 * SECTIONS:
 *   [CHECKPOINT] — client-side checkpoint read/write/clear
 *   [RESUME]     — server + client resume on re-entry
 *   [BATCH]      — transcribe + translate loop
 *   [BILLING]    — safeRecordUsage call sites
 *   [PLAYBACK]   — early playback + streaming partial update
 */

import { useRef, useCallback } from 'react';
import { SubtitleSegment } from '../store/usePlayerStore';
import {
  serverTranscribe,
  serverTranslate,
  fetchCompletedBatches,
  loadServerBridgeConfig,
  makeStableVideoId,
  cancelAllInflight,
  classifyServerError,
  safeRecordUsage,
  calcReservedSeconds,
  getEffectiveBatchDuration,
  getAdaptiveFloorRatio,
  _usageRecorded,
} from '../services/serverBridgeService';
import { recordGpuSeconds } from '../services/usageTracker';
import { usePlanStore } from '../store/usePlanStore';
import { ProcessingProgress } from '../services/videoProcessor';
import { getVideoDuration, extractSingleChunkAt, clearChunkDir } from '../services/audioChunker';
import * as FileSystem from 'expo-file-system/legacy';
import { getLanguageByCode } from '../constants/languages';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_DURATION_SECS       = 30;
const CHUNKS_PER_BATCH          = 6;
const CHECKPOINT_TTL_MS         = 72 * 60 * 60 * 1000;
const BATCH_RETRY_DELAY_MS      = 2000;

/**
 * MIN_QUOTA_TO_PROCESS_SECS — 정상 배치 처리 기준선
 * 이 이상이면 buffer 포함 정상 reservedSeconds 계산
 * calcReservedSeconds의 10초 최솟값 guard를 단독 소유
 * (serverBridgeService v9 [FIX-1]: 이 상수가 있으므로 함수 내 이중 방어 불필요)
 */
const MIN_QUOTA_TO_PROCESS_SECS = 10;

/**
 * HARD_MIN_EXECUTE_SECS — 절대 최소 실행 가능선 (v10 [FIX-4])
 *
 * RunPod serverless 구조 특성:
 *   - 콜드 스타트 warmup: ~2초
 *   - HTTP roundtrip: ~0.5초
 *   - 총 오버헤드: ~2.5초
 *
 * 3초 미만 job → 서버 비용 > 실제 작업 가치 → 전송 차단
 * 3~9초 구간  → 마지막 partial batch로 처리 (남은 quota 소진)
 *
 * HARD_MIN < MIN_QUOTA 불변식 필수:
 *   HARD_MIN_EXECUTE_SECS(3) < MIN_QUOTA_TO_PROCESS_SECS(10) ✅
 *
 * ⚠️ 이 값을 변경하면 serverBridgeService.ts의 MIN_EXECUTION_FLOOR_SECS,
 *    useVideoProcessor.ts의 HARD_MIN_EXECUTE_SECS도 함께 변경 필요
 */
const HARD_MIN_EXECUTE_SECS = 3;

function makeSegmentId(startSecs: number, endSecs: number): string {
  return `${Math.round(startSecs * 1000)}_${Math.round(endSecs * 1000)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// [CHECKPOINT]
// ─────────────────────────────────────────────────────────────────────────────

interface ClientBatchCheckpoint {
  jobKey: string;
  batchIndex: number;
  subtitles: SubtitleSegment[];
  usageSeconds: number;
  completedAt: number;
}

async function saveBatchCheckpoint(c: ClientBatchCheckpoint): Promise<void> {
  try {
    await AsyncStorage.setItem(`server_batch_ckpt_${c.jobKey}`, JSON.stringify(c));
  } catch {}
}

async function loadBatchCheckpoint(jobKey: string): Promise<ClientBatchCheckpoint | null> {
  try {
    const raw = await AsyncStorage.getItem(`server_batch_ckpt_${jobKey}`);
    if (!raw) return null;
    const ckpt = JSON.parse(raw) as ClientBatchCheckpoint;
    if (Date.now() - ckpt.completedAt > CHECKPOINT_TTL_MS) {
      await AsyncStorage.removeItem(`server_batch_ckpt_${jobKey}`);
      return null;
    }
    return ckpt;
  } catch { return null; }
}

async function clearBatchCheckpoints(stableId: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(
      keys.filter(k => k.startsWith(`server_batch_ckpt_${stableId}_batch_`)),
    );
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerProcessResult {
  subtitles: SubtitleSegment[];
  translationSkipped: boolean;
}

export function useServerBridge() {
  const { t } = useTranslation();
  const cancelledRef = useRef(false);
  const recordUsage  = usePlanStore((s) => s.recordUsage);
  const tier         = usePlanStore((s) => s.tier);

  const processVideoServer = useCallback(async (
    videoUri: string,
    sourceLanguage: string,
    targetLanguage: string,
    onProgress: (p: ProcessingProgress) => void,
    isCancelled: () => boolean,
    onEarlyPlaybackReady?: (subtitles: SubtitleSegment[]) => void,
    onPartialUpdate?: (subtitles: SubtitleSegment[]) => void,
  ): Promise<ServerProcessResult> => {
    cancelledRef.current = false;

    try {
      const config = await loadServerBridgeConfig();
      if (!config) throw new Error(t('serverBridge.notConfigured'));

      onProgress({ step: 'extracting', current: 0, total: 0, percent: 5, message: t('serverBridge.extractingAudio') });

      const totalDuration = await getVideoDuration(videoUri);
      if (totalDuration <= 0) throw new Error(t('serverBridge.noAudioTrack'));

      const langMeta    = getLanguageByCode(targetLanguage);
      const langName    = langMeta?.name ?? targetLanguage;
      const stableId    = makeStableVideoId(videoUri);
      const totalChunks = Math.ceil(totalDuration / CHUNK_DURATION_SECS);

      const allSubtitles: SubtitleSegment[] = [];
      let offset = 0, chunkIndex = 0, batchIndex = 0;
      let earlyPlaybackFired = false, lastEmittedEndTime = 0, skippedChunks = 0;

      // ── [RESUME] server-authoritative ────────────────────────────────────

      onProgress({ step: 'extracting', current: 0, total: 0, percent: 6, message: t('serverBridge.checkingProgress') });

      const serverCompleted = await fetchCompletedBatches(stableId);
      const serverCompletedIndices = new Set(serverCompleted.completedBatchIndices);

      for (const batch of serverCompleted.batches) {
        const batchSubs: SubtitleSegment[] = batch.segments
          .filter(seg => seg.translated && seg.translated.trim().length > 2)
          .map(seg => ({
            id: makeSegmentId(seg.start, seg.end),
            startTime: seg.start, endTime: seg.end,
            original: seg.text, translated: seg.translated,
          }));
        allSubtitles.push(...batchSubs);
        const batchJobKey = `${stableId}_batch_${batch.batchIndex}`;
        if (!_usageRecorded.has(batchJobKey)) {
          // [FIX-2 v9] batch.completedAt 있으면 우선 사용 — TTL 계산 정확도 향상
          _usageRecorded.set(batchJobKey, batch.completedAt ?? Date.now());
        }
      }

      if (serverCompleted.completedBatchIndices.length > 0) {
        const maxBatch = Math.max(...serverCompleted.completedBatchIndices);
        chunkIndex = Math.min(maxBatch * CHUNKS_PER_BATCH, totalChunks);
        offset = Math.min(chunkIndex * CHUNK_DURATION_SECS, totalDuration);
        batchIndex = maxBatch;
        onProgress({
          step: 'transcribing', current: chunkIndex, total: totalChunks,
          percent: Math.round(5 + (chunkIndex / totalChunks) * 45),
          message: t('serverBridge.restoringBatch', { batch: maxBatch }),
        });
      } else {
        let scan = 0;
        while (true) {
          const ckpt = await loadBatchCheckpoint(`${stableId}_batch_${scan + 1}`);
          if (!ckpt) break;
          allSubtitles.push(...ckpt.subtitles);
          const chunksInBatch = Math.min(
            CHUNKS_PER_BATCH,
            Math.ceil((totalDuration - scan * CHUNKS_PER_BATCH * CHUNK_DURATION_SECS) / CHUNK_DURATION_SECS),
          );
          offset += chunksInBatch * CHUNK_DURATION_SECS;
          chunkIndex += chunksInBatch;
          batchIndex = scan + 1;
          const ck = `${stableId}_batch_${scan + 1}`;
          if (!_usageRecorded.has(ck)) _usageRecorded.set(ck, Date.now());
          scan++;
        }
      }

      // ── [BATCH] main loop ─────────────────────────────────────────────────

      while (offset < totalDuration) {
        if (isCancelled()) return { subtitles: [], translationSkipped: false };

        batchIndex++;
        const batchJobKey = `${stableId}_batch_${batchIndex}`;

        if (serverCompletedIndices.has(batchIndex)) {
          const n = Math.min(CHUNKS_PER_BATCH, Math.ceil((totalDuration - offset) / CHUNK_DURATION_SECS));
          offset += n * CHUNK_DURATION_SECS; chunkIndex += n; continue;
        }

        const existingCkpt = await loadBatchCheckpoint(batchJobKey);
        if (existingCkpt) {
          allSubtitles.push(...existingCkpt.subtitles);
          const n = Math.min(CHUNKS_PER_BATCH, Math.ceil((totalDuration - offset) / CHUNK_DURATION_SECS));
          offset += n * CHUNK_DURATION_SECS; chunkIndex += n;
          if (!_usageRecorded.has(batchJobKey)) _usageRecorded.set(batchJobKey, Date.now());
          continue;
        }

        // ── remainingQuotaSeconds — 배치 처리 시작 시점에 계산 ─────────────
        const currentPlanState = usePlanStore.getState();
        const remainingQuotaSeconds = Math.max(
          currentPlanState.tier === 'free'
            ? (currentPlanState.limits.dailyCapMinutes - currentPlanState.usedMinutes) * 60
            : (currentPlanState.limits.monthlyCapMinutes - currentPlanState.usedMinutes) * 60,
          0,
        );

        // ── [FIX-4 v10] Hybrid quota guard ────────────────────────────────

        // (A) quota 완전 소진
        if (remainingQuotaSeconds <= 0) {
          console.warn(
            `[ServerBridge] Quota exhausted (${remainingQuotaSeconds}s) — ` +
            `stopping batch loop at batch ${batchIndex}`,
          );
          break;
        }

        // (B) 서버 효율 최소선 미달
        if (remainingQuotaSeconds < HARD_MIN_EXECUTE_SECS) {
          console.warn(
            `[ServerBridge] Below hard minimum: ${remainingQuotaSeconds}s < ${HARD_MIN_EXECUTE_SECS}s — ` +
            `stopping batch loop at batch ${batchIndex} (server cost > work value)`,
          );
          break;
        }

        // (C) partial 구간: HARD_MIN ≤ remaining < MIN_QUOTA
        const isLastPartialBatch = remainingQuotaSeconds < MIN_QUOTA_TO_PROCESS_SECS;

        if (isLastPartialBatch) {
          console.log(
            `[ServerBridge] Entering final partial batch ${batchIndex}: ` +
            `remaining=${remainingQuotaSeconds}s (${HARD_MIN_EXECUTE_SECS}s ≤ remaining < ${MIN_QUOTA_TO_PROCESS_SECS}s) — ` +
            `will process once then stop`,
          );
        }

        // Phase A: transcribe (NOT billed — RULE 2)
        const batchRawSegments: Array<{ start: number; end: number; text: string }> = [];
        let chunksThisBatch = 0;

        // [FIX-5 v11] planned vs actual 명확히 분리
        let batchPlannedDurationSecs = 0;
        let batchActualDurationSecs  = 0;

        while (chunksThisBatch < CHUNKS_PER_BATCH && offset < totalDuration) {
          if (isCancelled()) return { subtitles: [], translationSkipped: false };
          const chunkDur = Math.min(CHUNK_DURATION_SECS, totalDuration - offset);

          batchPlannedDurationSecs += chunkDur;

          let chunkSucceeded = false;
          try {
            const chunk = await extractSingleChunkAt(videoUri, offset, chunkDur, chunkIndex);
            const audioBase64 = await FileSystem.readAsStringAsync(
              chunk.filePath, { encoding: FileSystem.EncodingType.Base64 },
            );
            const tr = await serverTranscribe({ audioBase64, sourceLanguage, chunkStartSec: chunk.startTime });
            batchRawSegments.push(...tr.segments);
            await FileSystem.deleteAsync(chunk.filePath, { idempotent: true }).catch(() => {});
            chunkSucceeded = tr.segments.length > 0;
          } catch (e: any) {
            if (!(e?.code === 'SILENT_CHUNK' || e?.message?.includes('SILENT_CHUNK'))) {
              skippedChunks++;
              console.warn(`[ServerBridge] chunk ${chunkIndex} error (${skippedChunks} skips):`, e);
            }
          }

          if (chunkSucceeded) {
            batchActualDurationSecs += chunkDur;
          }

          offset += chunkDur; chunkIndex++; chunksThisBatch++;
          onProgress({
            step: 'transcribing', current: chunkIndex, total: totalChunks,
            percent: Math.min(Math.round(5 + (chunkIndex / totalChunks) * 45), 50),
            message: t('serverBridge.transcribing', { current: chunkIndex, total: totalChunks }),
          });
        }

        // [FIX-6 v11] segments.length === 0 → translate 호출 차단
        if (batchRawSegments.length === 0) {
          console.warn(
            `[ServerBridge] Batch ${batchIndex}: segments empty after transcription — ` +
            `skipping translate (planned=${batchPlannedDurationSecs}s, ` +
            `isLastPartial=${isLastPartialBatch})`,
          );
          if (isLastPartialBatch) break;
          continue;
        }

        if (isCancelled()) return { subtitles: [], translationSkipped: false };

        // [FIX-5 v11] getEffectiveBatchDuration으로 안전한 effective 값 계산
        // [FIX-7 v12] adaptive ratio 로그 보강 — serverBridgeService v14 [FIX-12] 연동
        const effectiveDurationSecs = getEffectiveBatchDuration(
          batchPlannedDurationSecs,
          batchActualDurationSecs,
          isLastPartialBatch,
        );

        const reservedSeconds = calcReservedSeconds(
          effectiveDurationSecs,
          remainingQuotaSeconds,
          isLastPartialBatch,
        );

        // [FIX-7 v12] dynamicRatio 로그 추가 — adaptive ratio 선택 추적
        const dynamicRatio = isLastPartialBatch
          ? getAdaptiveFloorRatio(batchActualDurationSecs, batchPlannedDurationSecs)
          : null;

        console.log(
          `[ServerBridge] batch ${batchIndex}: ` +
          `planned=${batchPlannedDurationSecs}s, ` +
          `actual=${batchActualDurationSecs}s, ` +
          `failureRatio=${batchPlannedDurationSecs > 0
            ? (batchActualDurationSecs / batchPlannedDurationSecs).toFixed(2)
            : 'n/a'}, ` +
          `dynamicRatio=${dynamicRatio ?? 'n/a (normal batch)'}, ` +
          `effective=${effectiveDurationSecs}s, ` +
          `remaining=${remainingQuotaSeconds}s, ` +
          `reserved=${reservedSeconds}s, ` +
          `isLastPartial=${isLastPartialBatch}`,
        );

        // Phase B: translate
        // [FIX-3 v9] retry policy: unknown vs retryable 명확화 (RULE 13 spec 준수)
        const batchEndOffset = offset;
        let translateResult: Awaited<ReturnType<typeof serverTranslate>> | undefined;
        let lastErr: any;
        let unknownRetried = false;

        for (let attempt = 0; attempt <= 1; attempt++) {
          try {
            translateResult = await serverTranslate({
              segments: batchRawSegments,
              targetLanguage: langName,
              videoId: batchJobKey,
              reservedSeconds,
            });
            break;
          } catch (err: any) {
            lastErr = err;
            if (isCancelled()) return { subtitles: [], translationSkipped: false };

            const ec = classifyServerError(err);

            if (ec === 'auth' || ec === 'validation') throw err;

            if (attempt === 0) {
              if (ec === 'unknown') {
                if (!unknownRetried) {
                  unknownRetried = true;
                  console.warn(
                    `[ServerBridge] Batch ${batchIndex} unknown error — retry once (RULE 13):`, err,
                  );
                  await new Promise(r => setTimeout(r, BATCH_RETRY_DELAY_MS));
                } else {
                  console.warn(`[ServerBridge] Batch ${batchIndex} unknown retry exhausted — skip`);
                  break;
                }
              } else {
                // retryable (network/5xx/429) → retry
                console.warn(`[ServerBridge] Batch ${batchIndex} retryable error — retry:`, err);
                await new Promise(r => setTimeout(r, BATCH_RETRY_DELAY_MS));
              }
            }
          }
        }

        if (!translateResult) {
          console.warn(`[ServerBridge] Batch ${batchIndex} failed after retry (not charged):`, lastErr);
          if (isLastPartialBatch) break;
          continue;
        }

        if (isCancelled()) return { subtitles: [], translationSkipped: false };

        // ── [BILLING] safeRecordUsage (await) ─────────────────────────────
        if (translateResult.completed) {
          const billed = await safeRecordUsage(
            batchJobKey,
            translateResult.usageSeconds,   // actualSeconds — BILLING SOURCE OF TRUTH
            recordUsage,
            recordGpuSeconds,
            tier,
          ).catch(e => {
            console.error('[ServerBridge] safeRecordUsage error:', e);
            return false;
          });
          console.log(
            `[ServerBridge] batch ${batchIndex} billing: ` +
            `reserved=${translateResult.reservedSeconds}s, ` +
            `actual=${translateResult.usageSeconds}s, ` +
            `billed=${billed}, ` +
            `isLastPartial=${isLastPartialBatch}`,
          );
        }

        const batchSubtitles: SubtitleSegment[] = translateResult.segments
          .filter(seg => seg.translated && seg.translated.trim().length > 2)
          .map(seg => ({
            id: makeSegmentId(seg.start, seg.end),
            startTime: seg.start, endTime: seg.end,
            original: seg.text, translated: seg.translated,
          }));

        await saveBatchCheckpoint({
          jobKey: batchJobKey,
          batchIndex,
          subtitles: batchSubtitles,
          usageSeconds: translateResult.usageSeconds,
          completedAt: Date.now(),
        });
        allSubtitles.push(...batchSubtitles);

        // ── [PLAYBACK] early playback + streaming ─────────────────────────
        if (!earlyPlaybackFired && onEarlyPlaybackReady) {
          const sorted = [...allSubtitles].sort((a, b) => a.startTime - b.startTime);
          let coverage = 0;
          const contiguous: SubtitleSegment[] = [];
          for (let i = 0; i < sorted.length; i++) {
            if (i > 0 && sorted[i].startTime - sorted[i - 1].endTime > 4) break;
            contiguous.push(sorted[i]);
            coverage += sorted[i].endTime - sorted[i].startTime;
          }
          if (coverage >= 20) {
            earlyPlaybackFired = true;
            lastEmittedEndTime = contiguous[contiguous.length - 1].endTime;
            onEarlyPlaybackReady([...contiguous]);
          }
        }

        if (earlyPlaybackFired && onPartialUpdate) {
          const newSegs = batchSubtitles.filter(s => s.startTime >= lastEmittedEndTime);
          if (newSegs.length > 0) {
            lastEmittedEndTime = newSegs[newSegs.length - 1].endTime;
            onPartialUpdate(newSegs);
          }
        }

        onProgress({
          step: 'translating',
          current: allSubtitles.length,
          total: Math.ceil(totalDuration / CHUNK_DURATION_SECS) * 5,
          percent: Math.min(Math.round(50 + (batchEndOffset / totalDuration) * 49), 99),
          message: t('serverBridge.translatingBatch', { batch: batchIndex }),
        });

        if (isLastPartialBatch) {
          console.log(
            `[ServerBridge] Final partial batch ${batchIndex} completed — ` +
            `stopping loop (remaining quota exhausted)`,
          );
          break;
        }
      }

      await clearBatchCheckpoints(stableId);
      onProgress({
        step: 'done', current: allSubtitles.length, total: allSubtitles.length,
        percent: 100, message: t('serverBridge.processingDone'),
      });

      return {
        subtitles: allSubtitles.sort((a, b) => a.startTime - b.startTime),
        translationSkipped: false,
      };

    } finally {
      await clearChunkDir().catch(() => {});
    }
  }, [recordUsage, tier, t]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cancelAllInflight();
    // TODO: 서버 cancel API 연동 — cancelAllInflight() 내부 주석 참조
  }, []);

  return { processVideoServer, cancel };
}