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
 * ── CHANGES (v13) ────────────────────────────────────────────────────────────
 * [SELF-1] 로그 품질 개선 + 방어 코드 강화 (로직 변경 없음)
 *
 *   - [LOG-1] batch loop 진입 시 remainingQuotaSeconds 로그 추가
 *             → quota 소진 흐름 추적 용이
 *   - [LOG-2] earlyPlayback fired 시점 로그 추가
 *             → playback 트리거 timing 가시화
 *   - [DEF-1] serverCompleted.batches null guard
 *             → fetchCompletedBatches UNKNOWN 응답 시 batches 순회 오류 방지
 *   - [DEF-2] allSubtitles 정렬 전 length 체크 로그
 *             → 빈 결과 반환 추적
 *
 * v12에서 유지되는 것들:
 *   - [FIX-7 v12] getEffectiveBatchDuration adaptive ratio 디버깅 로그
 *   - [FIX-5 v11] planned vs actual duration 명확히 분리
 *   - [FIX-6 v11] segments.length === 0 → serverTranslate 호출 차단
 *   - [FIX-4 v10] Hybrid quota guard (HARD_MIN / MIN_QUOTA 분기)
 *   - [FIX-5 v10] isLastPartialBatch 파라미터
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
  serverTranslateYoutubeSegments,
  fetchCompletedBatches,
  loadServerBridgeConfig,
  makeStableVideoId,
  makeDeterministicYtKey,
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
import { extractChunkViaCpuServer, CpuExtractError } from '../services/cpuServerService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_DURATION_SECS  = 30;
const CHUNKS_PER_BATCH     = 6;
const CHECKPOINT_TTL_MS    = 72 * 60 * 60 * 1000;
const BATCH_RETRY_DELAY_MS = 2000;

/**
 * MIN_QUOTA_TO_PROCESS_SECS — 정상 배치 처리 기준선
 * calcReservedSeconds의 10초 최솟값 guard를 단독 소유
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
 * HARD_MIN < MIN_QUOTA 불변식:
 *   HARD_MIN_EXECUTE_SECS(3) < MIN_QUOTA_TO_PROCESS_SECS(10) ✅
 *
 * ⚠️ 변경 시 serverBridgeService.ts의 MIN_EXECUTION_FLOOR_SECS,
 *    useVideoProcessor.ts의 HARD_MIN_EXECUTE_SECS도 함께 변경
 */
const HARD_MIN_EXECUTE_SECS = 3;

let _logSeq = 0;
const _logTs = () => `seq=${++_logSeq}, ts=${Date.now()}`;

function makeSegmentId(startSecs: number, endSecs: number): string {
  return `${Math.round(startSecs * 1000)}_${Math.round(endSecs * 1000)}`;
}

function getRemainingQuotaSeconds(): number {
  const state = usePlanStore.getState();
  const cap   = state.tier === 'free'
    ? state.limits.dailyCapMinutes
    : state.limits.monthlyCapMinutes;
  return Math.max((cap - state.usedMinutes) * 60, 0);
}

function clampReservedSeconds(
  requested: number,
  remaining: number,
): number {
  const safe = Math.max(0, Math.min(requested, remaining));
  return isFinite(safe) ? safe : 0;
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

      const _pipelineStartMs = Date.now();
      console.log(
        `[SB-PIPELINE-START] totalDuration=${totalDuration.toFixed(1)}s, ` +
        `stableId=${stableId}, src=${sourceLanguage}, tgt=${targetLanguage}, ` +
        `${_logTs()}`,
      );

      const allSubtitles: SubtitleSegment[] = [];
      let offset = 0, chunkIndex = 0, batchIndex = 0;
      let earlyPlaybackFired = false, lastEmittedEndTime = 0, skippedChunks = 0;

      // ── [RESUME] server-authoritative ────────────────────────────────────

      onProgress({ step: 'extracting', current: 0, total: 0, percent: 6, message: t('serverBridge.checkingProgress') });

      const serverCompleted = await fetchCompletedBatches(stableId);
      const serverCompletedIndices = new Set(serverCompleted.completedBatchIndices);

      // [DEF-1] batches null guard — UNKNOWN 응답 시 빈 배열 fallback
      const resumeBatches = serverCompleted.batches ?? [];

      for (const batch of resumeBatches) {
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
          _usageRecorded.set(batchJobKey, batch.completedAt ?? Date.now());
        }
      }

      if (serverCompleted.completedBatchIndices.length > 0) {
        const maxBatch = Math.max(...serverCompleted.completedBatchIndices);
        chunkIndex = Math.min(maxBatch * CHUNKS_PER_BATCH, totalChunks);
        offset     = Math.min(chunkIndex * CHUNK_DURATION_SECS, totalDuration);
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
          offset     += chunksInBatch * CHUNK_DURATION_SECS;
          chunkIndex += chunksInBatch;
          batchIndex  = scan + 1;
          const ck    = `${stableId}_batch_${scan + 1}`;
          if (!_usageRecorded.has(ck)) _usageRecorded.set(ck, Date.now());
          scan++;
        }
      }

      console.log(
        `[SB-RESUME-STATE] ` +
        `serverBatches=${serverCompleted.completedBatchIndices.length}, ` +
        `resumedFromBatch=${batchIndex}, ` +
        `resumedSubtitles=${allSubtitles.length}, ` +
        `resumeOffsetSecs=${offset.toFixed(1)}, ` +
        `${_logTs()}`,
      );

      // ── [BATCH] main loop ─────────────────────────────────────────────────

      while (offset < totalDuration) {
        if (isCancelled()) return { subtitles: [], translationSkipped: false };

        batchIndex++;
        const batchJobKey = `${stableId}_batch_${batchIndex}`;

        if (serverCompletedIndices.has(batchIndex)) {
          const n = Math.min(CHUNKS_PER_BATCH, Math.ceil((totalDuration - offset) / CHUNK_DURATION_SECS));
          console.log(`[SB-CKPT-SKIP] batch=${batchIndex}, reason=server_completed, n=${n}, ${_logTs()}`);
          offset += n * CHUNK_DURATION_SECS; chunkIndex += n; continue;
        }

        const existingCkpt = await loadBatchCheckpoint(batchJobKey);
        if (existingCkpt) {
          allSubtitles.push(...existingCkpt.subtitles);
          const n = Math.min(CHUNKS_PER_BATCH, Math.ceil((totalDuration - offset) / CHUNK_DURATION_SECS));
          offset += n * CHUNK_DURATION_SECS; chunkIndex += n;
          if (!_usageRecorded.has(batchJobKey)) _usageRecorded.set(batchJobKey, Date.now());
          console.log(
            `[SB-CKPT-SKIP] batch=${batchIndex}, reason=client_checkpoint, ` +
            `restoredSubtitles=${existingCkpt.subtitles.length}, ` +
            `${_logTs()}`,
          );
          continue;
        }

        // ── remainingQuotaSeconds 계산 ────────────────────────────────────
        const remainingQuotaSeconds = getRemainingQuotaSeconds();

        // [LOG-1] batch 진입 시 quota 상태 로그 — quota 소진 흐름 추적
        console.log(
          `[ServerBridge] batch ${batchIndex} start: ` +
          `offset=${offset.toFixed(1)}s, ` +
          `remainingQuota=${remainingQuotaSeconds}s, ` +
          `totalDuration=${totalDuration.toFixed(1)}s`,
        );

        // ── [FIX-4 v10] Hybrid quota guard ───────────────────────────────

        if (remainingQuotaSeconds <= 0) {
          console.warn(
            `[ServerBridge] Quota exhausted (${remainingQuotaSeconds}s) — ` +
            `stopping batch loop at batch ${batchIndex}`,
          );
          break;
        }

        if (remainingQuotaSeconds < HARD_MIN_EXECUTE_SECS) {
          console.warn(
            `[ServerBridge] Below hard minimum: ${remainingQuotaSeconds}s < ${HARD_MIN_EXECUTE_SECS}s — ` +
            `stopping batch loop at batch ${batchIndex} (server cost > work value)`,
          );
          break;
        }

        const isLastPartialBatch = remainingQuotaSeconds < MIN_QUOTA_TO_PROCESS_SECS;

        if (isLastPartialBatch) {
          console.log(
            `[ServerBridge] Entering final partial batch ${batchIndex}: ` +
            `remaining=${remainingQuotaSeconds}s ` +
            `(${HARD_MIN_EXECUTE_SECS}s ≤ remaining < ${MIN_QUOTA_TO_PROCESS_SECS}s) — ` +
            `will process once then stop`,
          );
        }

        console.log(
          `[SB-BATCH-START] batch=${batchIndex}, ` +
          `isLastPartial=${isLastPartialBatch}, ` +
          `chunkIndex=${chunkIndex}, totalChunks=${totalChunks}, ` +
          `elapsed=${Date.now() - _pipelineStartMs}ms, ` +
          `${_logTs()}`,
        );

        // Phase A: transcribe
        const batchRawSegments: Array<{ start: number; end: number; text: string }> = [];
        let chunksThisBatch = 0;

        let batchPlannedDurationSecs = 0;
        let batchActualDurationSecs  = 0;

        let _batchExtractMs = 0;
        let _batchSttMs = 0;
        const _batchStartMs = Date.now();

        while (chunksThisBatch < CHUNKS_PER_BATCH && offset < totalDuration) {
          if (isCancelled()) return { subtitles: [], translationSkipped: false };
          const chunkDur = Math.min(CHUNK_DURATION_SECS, totalDuration - offset);

          batchPlannedDurationSecs += chunkDur;

          let chunkSucceeded = false;
          try {
            const _chunkStartMs = Date.now();
            console.log(
              `[SB-CHUNK-START] batch=${batchIndex}, chunk=${chunkIndex}, ` +
              `offset=${offset.toFixed(1)}s, chunkDur=${chunkDur.toFixed(1)}s, ` +
              `${_logTs()}`,
            );
            const chunk = await extractSingleChunkAt(videoUri, offset, chunkDur, chunkIndex);
            const _extractDoneMs = Date.now(); _batchExtractMs += _extractDoneMs - _chunkStartMs;
            const audioBase64 = await FileSystem.readAsStringAsync(
              chunk.filePath, { encoding: FileSystem.EncodingType.Base64 },
            );
            const tr = await serverTranscribe({ audioBase64, sourceLanguage, chunkStartSec: chunk.startTime });
            _batchSttMs += Date.now() - _extractDoneMs;
            batchRawSegments.push(...tr.segments);
            console.log(
              `[SB-TRANSCRIBE-OK] batch=${batchIndex}, chunk=${chunkIndex}, ` +
              `segments=${tr.segments.length}, ` +
              `chunkStart=${chunk.startTime.toFixed(1)}s, ` +
              `chunkMs=${Date.now() - _chunkStartMs}, ` +
              `${_logTs()}`,
            );
            await FileSystem.deleteAsync(chunk.filePath, { idempotent: true }).catch(() => {});
            chunkSucceeded = tr.segments.length > 0;
          } catch (e: any) {
            if (!(e?.code === 'SILENT_CHUNK' || e?.message?.includes('SILENT_CHUNK'))) {
              skippedChunks++;
              console.warn(`[ServerBridge] chunk ${chunkIndex} error (${skippedChunks} skips):`, e);
              console.log(
                `[SB-CHUNK-SKIP] batch=${batchIndex}, chunk=${chunkIndex}, ` +
                `skippedTotal=${skippedChunks}, ` +
                `${_logTs()}`,
              );
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

        // [FIX-6 v11] 빈 segments → translate 차단
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

        // [FIX-7 v12] adaptive ratio 로그
        const effectiveDurationSecs = getEffectiveBatchDuration(
          batchPlannedDurationSecs,
          batchActualDurationSecs,
          isLastPartialBatch,
        );

        const reservedSeconds = clampReservedSeconds(
          calcReservedSeconds(
            effectiveDurationSecs,
            remainingQuotaSeconds,
            isLastPartialBatch,
          ),
          remainingQuotaSeconds,
        );

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

        // Phase B: translate — [FIX-3 v9] retry policy
        const batchEndOffset = offset;
        let translateResult: Awaited<ReturnType<typeof serverTranslate>> | undefined;
        let lastErr: any;
        let unknownRetried = false;

        const _translateStartMs = Date.now();
        console.log(
          `[SB-TRANSLATE-START] batch=${batchIndex}, ` +
          `segments=${batchRawSegments.length}, ` +
          `reservedSeconds=${reservedSeconds.toFixed(1)}, ` +
          `effectiveDuration=${effectiveDurationSecs.toFixed(1)}s, ` +
          `elapsed=${Date.now() - _pipelineStartMs}ms, ` +
          `${_logTs()}`,
        );

        for (let attempt = 0; attempt <= 1; attempt++) {
          try {
            translateResult = await serverTranslate({
              segments: batchRawSegments,
              targetLanguage: langName,
              videoId: batchJobKey,
              reservedSeconds,
            });
            console.log(
              `[SB-TRANSLATE-OK] batch=${batchIndex}, attempt=${attempt + 1}, ` +
              `usageSeconds=${translateResult.usageSeconds}, ` +
              `completed=${translateResult.completed}, ` +
              `segments=${translateResult.segments.length}, ` +
              `translateMs=${Date.now() - _translateStartMs}, ` +
              `${_logTs()}`,
            );
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

        // ── [BILLING] safeRecordUsage ─────────────────────────────────────
        if (translateResult.completed) {
          const billed = await safeRecordUsage(
            batchJobKey,
            translateResult.usageSeconds,
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
          console.log(
            `[SB-BILLING-DONE] batch=${batchIndex}, ` +
            `billedResult=${billed}, ` +
            `usageSeconds=${translateResult.usageSeconds}, ` +
            `cumulativeSubtitles=${allSubtitles.length + translateResult.segments.length}, ` +
            `${_logTs()}`,
          );
          console.log(
            `[SB-QUOTA-DELTA] batch=${batchIndex}, ` +
            `reserved=${translateResult.reservedSeconds}, ` +
            `actual=${translateResult.usageSeconds}, ` +
            `delta=${(translateResult.usageSeconds - translateResult.reservedSeconds).toFixed(1)}, ` +
            `overrun=${translateResult.usageSeconds > translateResult.reservedSeconds}, ` +
            `${_logTs()}`,
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

        console.log(
          `[SB-TIMING] batch=${batchIndex}, ` +
          `extractMs=${_batchExtractMs}, ` +
          `sttMs=${_batchSttMs}, ` +
          `translateMs=${Date.now() - _translateStartMs}, ` +
          `totalBatchMs=${Date.now() - _batchStartMs}, ` +
          `${_logTs()}`,
        );
        console.log(
          `[SB-BATCH-DONE] batch=${batchIndex}, ` +
          `batchSubtitles=${batchSubtitles.length}, ` +
          `allSubtitles=${allSubtitles.length}, ` +
          `isLastPartial=${isLastPartialBatch}, ` +
          `offset=${offset.toFixed(1)}s / ${totalDuration.toFixed(1)}s, ` +
          `batchMs=${Date.now() - _pipelineStartMs}ms, ` +
          `${_logTs()}`,
        );

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
            // [LOG-2] early playback fired 시점 로그
            console.log(
              `[ServerBridge] early playback fired at batch ${batchIndex}: ` +
              `coverage=${coverage.toFixed(1)}s, segments=${contiguous.length}`,
            );
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

      // [DEF-2] 빈 결과 추적 로그
      if (allSubtitles.length === 0) {
        console.warn(
          `[ServerBridge] Processing complete but no subtitles produced — ` +
          `videoUri=${videoUri}, totalDuration=${totalDuration.toFixed(1)}s`,
        );
      }

      onProgress({
        step: 'done', current: allSubtitles.length, total: allSubtitles.length,
        percent: 100, message: t('serverBridge.processingDone'),
      });

      console.log(
        `[SB-PIPELINE-SUMMARY] totalBatches=${batchIndex}, ` +
        `totalSubtitles=${allSubtitles.length}, ` +
        `totalDuration=${totalDuration.toFixed(1)}s, ` +
        `totalMs=${Date.now() - _pipelineStartMs}, ` +
        `skippedChunks=${skippedChunks}, ` +
        `${_logTs()}`,
      );

      return {
        subtitles: allSubtitles.sort((a, b) => a.startTime - b.startTime),
        translationSkipped: false,
      };

    } finally {
      await clearChunkDir().catch(() => {});
    }
  }, [recordUsage, tier, t]);

  const processYoutubeServer = useCallback(async (
    youtubeVideoId: string,
    segments: Array<{ start: number; end: number; text: string }>,
    targetLanguage: string,
    onProgress?: (completed: number, total: number) => void,
    isCancelled?: () => boolean,
  ): Promise<{
    segments: Array<{ start: number; end: number; text: string; translated: string }>;
    usageSeconds: number;
  }> => {

    // GUARD: GPU billing only for Standard/Pro
    if (tier !== 'lite' && tier !== 'standard' && tier !== 'pro') {
      throw new Error('[processYoutubeServer] GPU translation requires Lite, Standard or Pro plan. tier=' + tier);
    }

    const config = await loadServerBridgeConfig();
    if (!config) throw new Error('[processYoutubeServer] ServerBridge not configured');

    if (!segments || segments.length === 0) {
      return { segments: [], usageSeconds: 0 };
    }

    // effectiveDurationSecs: sum of actual subtitle segment durations
    const effectiveDurationSecs = segments.reduce(
      (acc, seg) => acc + Math.max(0, seg.end - seg.start),
      0,
    );

    // remainingQuotaSeconds from plan store
    const remainingQuotaSeconds = getRemainingQuotaSeconds();

    const reservedSeconds = clampReservedSeconds(
      calcReservedSeconds(
        effectiveDurationSecs,
        remainingQuotaSeconds,
        false, // YouTube: no batch split, single pass
      ),
      remainingQuotaSeconds,
    );

    // Deterministic jobKey — same segments always produce same key (RULE 13)
    const jobKey = makeDeterministicYtKey(
      youtubeVideoId,
      segments.map(s => ({ start: s.start, end: s.end })),
    );

    console.log(
      `[processYoutubeServer] videoId=${youtubeVideoId}, ` +
      `segments=${segments.length}, effectiveDuration=${effectiveDurationSecs.toFixed(1)}s, ` +
      `reserved=${reservedSeconds}s, remaining=${remainingQuotaSeconds.toFixed(1)}s`,
    );

    if (isCancelled?.()) return { segments: [], usageSeconds: 0 };

    const result = await serverTranslateYoutubeSegments(
      segments,
      targetLanguage,
      jobKey,
      reservedSeconds,
    );

    // BILLING: single call site — safeRecordUsage dedup prevents double billing
    await safeRecordUsage(
      jobKey,
      result.usageSeconds,
      recordUsage,
      recordGpuSeconds,
      tier,
    ).catch(e => {
      console.error('[processYoutubeServer] safeRecordUsage error:', e);
    });

    console.log(
      `[processYoutubeServer] done: usageSeconds=${result.usageSeconds}, ` +
      `segments=${result.segments.length}`,
    );

    return {
      segments: result.segments,
      usageSeconds: result.usageSeconds,
    };

  }, [recordUsage, tier]);

  const processYoutubeAudioServer = useCallback(async (
    youtubeVideoId: string,
    sourceLanguage: string,
    targetLanguage: string,
    totalDurationSecs: number,
    onProgress?: (p: import('../services/videoProcessor').ProcessingProgress) => void,
    isCancelled?: () => boolean,
  ): Promise<{
    subtitles: SubtitleSegment[];
    usageSeconds: number;
  }> => {

    // GUARD: Standard/Pro only — Free must never reach this
    if (tier !== 'lite' && tier !== 'standard' && tier !== 'pro') {
      throw new Error('[processYoutubeAudioServer] Requires Lite, Standard or Pro plan');
    }

    const config = await loadServerBridgeConfig();
    if (!config) throw new Error('[processYoutubeAudioServer] ServerBridge not configured');

    const _ytAudioPipelineStartMs = Date.now();
    let _ytAudioCpuFailCount = 0;
    let _ytAudioGpuFailCount = 0;
    console.log(
      `[YA-ENTRY] videoId=${youtubeVideoId}, ` +
      `src=${sourceLanguage}, tgt=${targetLanguage}, ` +
      `totalDurationSecs=${totalDurationSecs.toFixed(1)}s, ` +
      `${_logTs()}`,
    );

    const stableId    = youtubeVideoId; // already stable for YouTube
    const totalChunks = Math.ceil(totalDurationSecs / 30);
    const langMeta    = (await import('../constants/languages')).getLanguageByCode(targetLanguage);
    const langName    = langMeta?.name ?? targetLanguage;

    const allSubtitles: SubtitleSegment[] = [];
    let offset      = 0;
    let chunkIndex  = 0;
    let batchIndex  = 0;
    let skippedChunks = 0;
    let cpuBotBlocked = false; // session-level bot_403 block

    // Reuse same batch structure as processVideoServer (CHUNKS_PER_BATCH=6, CHUNK_DURATION_SECS=30)
    while (offset < totalDurationSecs) {
      if (isCancelled?.()) return { subtitles: [], usageSeconds: 0 };
      if (cpuBotBlocked) {
        console.warn('[processYoutubeAudioServer] bot_403 — stopping pipeline');
        break;
      }

      batchIndex++;
      const batchJobKey = `${stableId}_audio_batch_${batchIndex}`;

      // Quota check
      const remainingQuotaSeconds = getRemainingQuotaSeconds();

      if (remainingQuotaSeconds < HARD_MIN_EXECUTE_SECS) {
        console.warn('[processYoutubeAudioServer] Quota below hard min — stopping');
        console.warn(
          `[YA-QUOTA-STOP] batch=${batchIndex}, ` +
          `remainingQuotaSeconds=${remainingQuotaSeconds.toFixed(1)}, ` +
          `hardMin=${HARD_MIN_EXECUTE_SECS}, ` +
          `elapsed=${Date.now() - _ytAudioPipelineStartMs}ms, ` +
          `${_logTs()}`,
        );
        break;
      }

      const isLastPartialBatch = remainingQuotaSeconds < MIN_QUOTA_TO_PROCESS_SECS;

      console.log(
        `[YA-BATCH-START] batch=${batchIndex}, ` +
        `isLastPartial=${isLastPartialBatch}, ` +
        `chunkIndex=${chunkIndex}, totalChunks=${totalChunks}, ` +
        `remainingQuota=${remainingQuotaSeconds.toFixed(1)}s, ` +
        `elapsed=${Date.now() - _ytAudioPipelineStartMs}ms, ` +
        `${_logTs()}`,
      );

      // Phase A: extract chunks via CPU server
      const batchRawSegments: Array<{ start: number; end: number; text: string }> = [];
      let chunksThisBatch = 0;
      let batchPlannedDurationSecs = 0;
      let batchActualDurationSecs  = 0;

      let _yaBatchExtractMs = 0;
      let _yaBatchSttMs = 0;
      const _yaBatchStartMs = Date.now();

      while (chunksThisBatch < CHUNKS_PER_BATCH && offset < totalDurationSecs) {
        if (isCancelled?.()) return { subtitles: [], usageSeconds: 0 };

        const chunkDur = Math.min(30, totalDurationSecs - offset);
        batchPlannedDurationSecs += chunkDur;

        try {
          const _ytChunkStartMs = Date.now();
          console.log(
            `[YA-CPU-START] batch=${batchIndex}, chunk=${chunkIndex}, ` +
            `offset=${offset.toFixed(1)}s, chunkDur=${chunkDur.toFixed(1)}s, ` +
            `${_logTs()}`,
          );
          const cpuChunk = await extractChunkViaCpuServer(
            stableId,
            offset,
            chunkDur,
            sourceLanguage,
            undefined,
            tier,
          );
          const _yaExtractDoneMs = Date.now(); _yaBatchExtractMs += _yaExtractDoneMs - _ytChunkStartMs;

          const tr = await serverTranscribe({
            audioBase64:   cpuChunk.audioBase64,
            sourceLanguage,
            chunkStartSec: cpuChunk.chunkStartSec,
          });
          _yaBatchSttMs += Date.now() - _yaExtractDoneMs;

          batchRawSegments.push(...tr.segments);
          console.log(
            `[YA-CPU-OK] batch=${batchIndex}, chunk=${chunkIndex}, ` +
            `cpuKB=${(cpuChunk.audioBase64.length * 0.75 / 1024).toFixed(1)}, ` +
            `segments=${tr.segments.length}, ` +
            `chunkMs=${Date.now() - _ytChunkStartMs}, ` +
            `${_logTs()}`,
          );
          batchActualDurationSecs += chunkDur;

        } catch (e: any) {
          if (e instanceof CpuExtractError && e.type === 'bot_403') {
            cpuBotBlocked = true;
            console.warn('[processYoutubeAudioServer] bot_403 — session blocked');
            console.warn(
              `[YA-CPU-BOT-BLOCK] batch=${batchIndex}, chunk=${chunkIndex}, ` +
              `cpuFailTotal=${++_ytAudioCpuFailCount}, ` +
              `elapsed=${Date.now() - _ytAudioPipelineStartMs}ms, ` +
              `${_logTs()}`,
            );
            break;
          }
          // timeout/network: skip chunk, continue
          skippedChunks++;
          console.warn(
            `[processYoutubeAudioServer] chunk ${chunkIndex} skip ` +
            `(${e?.type ?? e?.message ?? 'unknown'})`
          );
          console.warn(
            `[YA-CPU-SKIP] batch=${batchIndex}, chunk=${chunkIndex}, ` +
            `errorType=${e?.type ?? 'unknown'}, ` +
            `cpuFailTotal=${++_ytAudioCpuFailCount}, ` +
            `skippedTotal=${skippedChunks}, ` +
            `${_logTs()}`,
          );
        }

        offset += chunkDur;
        chunkIndex++;
        chunksThisBatch++;

        onProgress?.({
          step:    'transcribing',
          current: chunkIndex,
          total:   totalChunks,
          percent: Math.min(Math.round(5 + (chunkIndex / totalChunks) * 45), 50),
          message: `음성 인식 중... (${chunkIndex}/${totalChunks})`,
        });
      }

      if (cpuBotBlocked) break;

      if (batchRawSegments.length === 0) {
        if (isLastPartialBatch) break;
        continue;
      }

      if (isCancelled?.()) return { subtitles: [], usageSeconds: 0 };

      // Phase B: translate via RunPod
      const effectiveDurationSecs = getEffectiveBatchDuration(
        batchPlannedDurationSecs,
        batchActualDurationSecs,
        isLastPartialBatch,
      );

      const reservedSeconds = clampReservedSeconds(
        calcReservedSeconds(
          effectiveDurationSecs,
          remainingQuotaSeconds,
          isLastPartialBatch,
        ),
        remainingQuotaSeconds,
      );

      let translateResult: Awaited<ReturnType<typeof serverTranslate>> | undefined;
      let lastErr: any;

      const _ytTranslateStartMs = Date.now();
      console.log(
        `[YA-GPU-START] batch=${batchIndex}, ` +
        `segments=${batchRawSegments.length}, ` +
        `reservedSeconds=${reservedSeconds.toFixed(1)}, ` +
        `effectiveDuration=${effectiveDurationSecs.toFixed(1)}s, ` +
        `elapsed=${Date.now() - _ytAudioPipelineStartMs}ms, ` +
        `${_logTs()}`,
      );

      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          translateResult = await serverTranslate({
            segments:        batchRawSegments,
            targetLanguage:  langName,
            videoId:         batchJobKey,
            reservedSeconds,
          });
          console.log(
            `[YA-GPU-OK] batch=${batchIndex}, attempt=${attempt + 1}, ` +
            `usageSeconds=${translateResult.usageSeconds}, ` +
            `completed=${translateResult.completed}, ` +
            `segments=${translateResult.segments.length}, ` +
            `gpuMs=${Date.now() - _ytTranslateStartMs}, ` +
            `${_logTs()}`,
          );
          break;
        } catch (err: any) {
          if (isCancelled?.()) return { subtitles: [], usageSeconds: 0 };
          lastErr = err;
          const ec = classifyServerError(err);
          if (ec === 'auth' || ec === 'validation') throw err;
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, BATCH_RETRY_DELAY_MS));
          }
        }
      }

      if (!translateResult) {
        _ytAudioGpuFailCount++;
        console.warn(
          `[YA-GPU-FAIL] batch=${batchIndex}, ` +
          `gpuFailCount=${_ytAudioGpuFailCount}, ` +
          `lastErrClass=${classifyServerError(lastErr ?? {})}, ` +
          `isLastPartial=${isLastPartialBatch}, ` +
          `elapsed=${Date.now() - _ytAudioPipelineStartMs}ms, ` +
          `${_logTs()}`,
        );
        if (isLastPartialBatch) break;
        continue;
      }

      // BILLING: single call site
      if (translateResult.completed) {
        await safeRecordUsage(
          batchJobKey,
          translateResult.usageSeconds,
          recordUsage,
          recordGpuSeconds,
          tier,
        ).catch(e => console.error('[processYoutubeAudioServer] safeRecordUsage:', e));
      }

      const batchSubtitles: SubtitleSegment[] = translateResult.segments
        .filter(seg => seg.translated && seg.translated.trim().length > 2)
        .map(seg => ({
          id:         makeSegmentId(seg.start, seg.end),
          startTime:  seg.start,
          endTime:    seg.end,
          original:   seg.text,
          translated: seg.translated,
        }));

      console.log(
        `[YA-BILLING-DONE] batch=${batchIndex}, ` +
        `usageSeconds=${translateResult.usageSeconds}, ` +
        `allSubtitles=${allSubtitles.length + batchSubtitles.length}, ` +
        `${_logTs()}`,
      );

      allSubtitles.push(...batchSubtitles);

      console.log(
        `[YA-TIMING] batch=${batchIndex}, ` +
        `extractMs=${_yaBatchExtractMs}, ` +
        `sttMs=${_yaBatchSttMs}, ` +
        `gpuMs=${Date.now() - _ytTranslateStartMs}, ` +
        `totalBatchMs=${Date.now() - _yaBatchStartMs}, ` +
        `${_logTs()}`,
      );
      console.log(
        `[YA-BATCH-DONE] batch=${batchIndex}, ` +
        `batchSubtitles=${batchSubtitles.length}, ` +
        `allSubtitles=${allSubtitles.length}, ` +
        `isLastPartial=${isLastPartialBatch}, ` +
        `offset=${offset.toFixed(1)}s / ${totalDurationSecs.toFixed(1)}s, ` +
        `batchMs=${Date.now() - _ytAudioPipelineStartMs}ms, ` +
        `${_logTs()}`,
      );

      onProgress?.({
        step:    'translating',
        current: allSubtitles.length,
        total:   totalChunks * 5,
        percent: Math.min(Math.round(50 + (offset / totalDurationSecs) * 49), 99),
        message: `번역 중... (배치 ${batchIndex})`,
      });

      if (isLastPartialBatch) break;
    }

    // If bot blocked and no subtitles at all — throw so caller handles as failure
    if (cpuBotBlocked && allSubtitles.length === 0) {
      throw new Error('CPU_SERVER_BOT_BLOCKED');
    }

    console.log(
      `[YA-PIPELINE-SUMMARY] totalBatches=${batchIndex}, ` +
      `totalSubtitles=${allSubtitles.length}, ` +
      `totalDurationSecs=${totalDurationSecs.toFixed(1)}s, ` +
      `cpuFailCount=${_ytAudioCpuFailCount}, ` +
      `gpuFailCount=${_ytAudioGpuFailCount}, ` +
      `cpuBotBlocked=${cpuBotBlocked}, ` +
      `totalMs=${Date.now() - _ytAudioPipelineStartMs}, ` +
      `${_logTs()}`,
    );

    const totalUsage = allSubtitles.reduce(
      (acc, s) => acc + Math.max(0, s.endTime - s.startTime), 0
    );

    return {
      subtitles: allSubtitles.sort((a, b) => a.startTime - b.startTime),
      usageSeconds: totalUsage,
    };

  }, [recordUsage, tier, t]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cancelAllInflight();
    // TODO: 서버 cancel API 연동
  }, []);

  return { processVideoServer, processYoutubeServer, processYoutubeAudioServer, cancel };
}