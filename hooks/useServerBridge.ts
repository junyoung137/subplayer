/**
 * useServerBridge.ts
 * Standard/Pro server-side pipeline. Produces SubtitleSegment[] identical to Free pipeline.
 *
 * BILLING:  safeRecordUsage() only — direct recordUsage() BANNED (RULE 10)
 * RESUME:   fetchCompletedBatches() 3-state → server-authoritative (RULE 4)
 * FALLBACK: classifyServerError() → 3-state → RULE 6
 * RETRY:    Each batch retried once (2000ms delay) before skip (RULE 9)
 * CANCEL:   HTTP only — server GPU may continue (RULE 7)
 * UNKNOWN:  Retry ONCE with SAME jobKey (RULE 13) — no billing, no GPU recompute
 *
 * SECTIONS:
 *   [CHECKPOINT] — client-side checkpoint read/write/clear
 *   [RESUME]     — server + client resume on re-entry
 *   [BATCH]      — transcribe + translate loop
 *   [BILLING]    — safeRecordUsage call sites
 *   [PLAYBACK]   — early playback + streaming partial update
 */

import { useState, useRef, useCallback } from 'react';
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

const CHUNK_DURATION_SECS   = 30;
const CHUNKS_PER_BATCH      = 6;
const CHECKPOINT_TTL_MS     = 72 * 60 * 60 * 1000;
const BATCH_RETRY_DELAY_MS  = 2000;
const FETCH_RETRY_DELAY_MS  = 2000;

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
    await AsyncStorage.multiRemove(keys.filter(k => k.startsWith(`server_batch_ckpt_${stableId}_batch_`)));
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
  const [progress, setProgress] = useState<ProcessingProgress>({
    step: 'extracting', current: 0, total: 0, percent: 0, message: '',
  });
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

      const langMeta  = getLanguageByCode(targetLanguage);
      const langName  = langMeta?.name ?? targetLanguage;
      const stableId  = makeStableVideoId(videoUri);
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
        // RULE 12 invariant 8: never overwrite existing entry
        if (!_usageRecorded.has(batchJobKey)) _usageRecorded.set(batchJobKey, Date.now());
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
        // Client checkpoint fallback
        let scan = 0;
        while (true) {
          const ckpt = await loadBatchCheckpoint(`${stableId}_batch_${scan + 1}`);
          if (!ckpt) break;
          allSubtitles.push(...ckpt.subtitles);
          const chunksInBatch = Math.min(CHUNKS_PER_BATCH, Math.ceil((totalDuration - scan * CHUNKS_PER_BATCH * CHUNK_DURATION_SECS) / CHUNK_DURATION_SECS));
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
        // RULE 13: batchJobKey is the deterministic idempotency key for this batch
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

        // Phase A: transcribe (NOT billed — RULE 2)
        const batchRawSegments: Array<{ start: number; end: number; text: string }> = [];
        let chunksThisBatch = 0;

        while (chunksThisBatch < CHUNKS_PER_BATCH && offset < totalDuration) {
          if (isCancelled()) return { subtitles: [], translationSkipped: false };
          const chunkDur = Math.min(CHUNK_DURATION_SECS, totalDuration - offset);
          try {
            const chunk = await extractSingleChunkAt(videoUri, offset, chunkDur, chunkIndex);
            const audioBase64 = await FileSystem.readAsStringAsync(chunk.filePath, { encoding: FileSystem.EncodingType.Base64 });
            const tr = await serverTranscribe({ audioBase64, sourceLanguage, chunkStartSec: chunk.startTime });
            batchRawSegments.push(...tr.segments);
            await FileSystem.deleteAsync(chunk.filePath, { idempotent: true }).catch(() => {});
          } catch (e: any) {
            if (!(e?.code === 'SILENT_CHUNK' || e?.message?.includes('SILENT_CHUNK'))) {
              skippedChunks++;
              console.warn(`[ServerBridge] chunk ${chunkIndex} error (${skippedChunks} skips):`, e);
            }
          }
          offset += chunkDur; chunkIndex++; chunksThisBatch++;
          onProgress({
            step: 'transcribing', current: chunkIndex, total: totalChunks,
            percent: Math.min(Math.round(5 + (chunkIndex / totalChunks) * 45), 50),
            message: t('serverBridge.transcribing', { current: chunkIndex, total: totalChunks }),
          });
        }

        if (batchRawSegments.length === 0) continue;
        if (isCancelled()) return { subtitles: [], translationSkipped: false };

        // Phase B: translate — RULE 9: retry once
        // RULE 13: batchJobKey computed above — same key used on retry
        const batchEndOffset = offset;
        let translateResult: Awaited<ReturnType<typeof serverTranslate>> | undefined;
        let lastErr: any;

        for (let attempt = 0; attempt <= 1; attempt++) {
          try {
            translateResult = await serverTranslate({
              segments: batchRawSegments,
              targetLanguage: langName,
              videoId: batchJobKey, // idempotency key — same on retry
            });
            break;
          } catch (err: any) {
            lastErr = err;
            if (isCancelled()) return { subtitles: [], translationSkipped: false };
            const ec = classifyServerError(err);
            if (ec === 'auth' || ec === 'validation') throw err;
            if (attempt === 0) {
              console.warn(`[ServerBridge] Batch ${batchIndex} attempt 1 failed, retrying:`, err);
              await new Promise(r => setTimeout(r, BATCH_RETRY_DELAY_MS));
            }
          }
        }

        if (!translateResult) {
          console.warn(`[ServerBridge] Batch ${batchIndex} failed after retry (not charged):`, lastErr);
          continue;
        }

        if (isCancelled()) return { subtitles: [], translationSkipped: false };

        // ── [BILLING] safeRecordUsage ─────────────────────────────────────
        if (translateResult.completed) {
          safeRecordUsage(batchJobKey, translateResult.usageSeconds, recordUsage, recordGpuSeconds, tier).catch(e => {
            console.error('[ServerBridge] safeRecordUsage error:', e);
          });
        }

        const batchSubtitles: SubtitleSegment[] = translateResult.segments
          .filter(seg => seg.translated && seg.translated.trim().length > 2)
          .map(seg => ({
            id: makeSegmentId(seg.start, seg.end),
            startTime: seg.start, endTime: seg.end,
            original: seg.text, translated: seg.translated,
          }));

        await saveBatchCheckpoint({ jobKey: batchJobKey, batchIndex, subtitles: batchSubtitles, usageSeconds: translateResult.usageSeconds, completedAt: Date.now() });
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
      }

      await clearBatchCheckpoints(stableId);
      onProgress({ step: 'done', current: allSubtitles.length, total: allSubtitles.length, percent: 100, message: t('serverBridge.processingDone') });

      return { subtitles: allSubtitles.sort((a, b) => a.startTime - b.startTime), translationSkipped: false };

    } finally {
      await clearChunkDir().catch(() => {});
    }
  }, [recordUsage, tier]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cancelAllInflight(); // HTTP only — server GPU may continue (RULE 7)
  }, []);

  return { progress, processVideoServer, cancel };
}
