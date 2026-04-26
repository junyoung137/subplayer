import { NativeModules, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchYoutubeSubtitles, getProxyBaseUrl, clearProxyUrlCache } from './youtubeTimedText';
import { loadModel, unloadModel, translateSegments, isModelBusy, debugInferenceCounters, setBgJobProtection, cancelFgInference, setAppBackgroundedHint } from './gemmaTranslationService';
import { getLocalModelPath } from './modelDownloadService';
import { getBgStrings } from '../utils/bgStrings';

export const BG_TASK_STATUS_KEY  = 'bg_translation_status';
export const BG_TASK_RESULT_KEY  = 'bg_translation_result';
export const BG_PENDING_TASK_KEY = 'bg_translation_pending_task';
export const BG_TASK_CHECKPOINT_KEY = 'bg_translation_checkpoint_v1';
export const BG_TASK_LOCK_KEY    = 'bg_translation_lock';

const NOTIFY_THROTTLE_MS = 2000;
const PROGRESS_SAVE_EVERY_N = 5;

export type BgTaskStatus =
  | 'idle' | 'fetching' | 'translating' | 'saving' | 'done' | 'error';

export type SubtitleSource = 'fg' | 'bg';

export interface BgTranslationTask {
  videoId: string;
  videoTitle: string;
  language: string;
  genre: string;
  enqueuedAt: number;
}

export interface BgTranslationResult {
  videoId: string;
  videoTitle: string;
  language: string;
  completedAt: number;
  source: SubtitleSource;
  segments: Array<{
    startTime: number;
    endTime: number;
    original: string;
    translated: string;
  }>;
}

export interface BgTaskStatusData {
  videoId: string;
  status: BgTaskStatus;
  progress: number;
  translatedCount: number;
  totalCount: number;
  completedSegments?: number;
  error?: string;
  updatedAt: number;
}

interface BgTranslationCheckpoint {
  videoId: string;
  language: string;
  genre: string;
  translatedSegments: Array<{
    start: number; end: number; text: string; translated: string;
  }>;
  translatedCount: number;
  totalCount: number;
  updatedAt: number;
}

let _isRunning = false;
let _memoryWarningAbort = false;
let _pendingCheckpointWrites = 0;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function saveStatus(data: BgTaskStatusData): Promise<void> {
  try {
    await AsyncStorage.setItem(BG_TASK_STATUS_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[BG_TASK] saveStatus write failed:', e);
  }
}

function notifyProgress(pct: number, text: string): void {
  NativeModules.TranslationService?.updateProgress(pct, text);
}

async function sendFailureNotification(videoTitle: string, s: ReturnType<typeof getBgStrings>, reason?: string): Promise<void> {
  try {
    await NativeModules.TranslationService?.sendFailureNotification(reason ?? s.translationFailed);
  } catch {}
}

export async function backgroundTranslationTask(taskData: BgTranslationTask): Promise<void> {
  const { videoId, videoTitle = 'YouTube Video', language, genre } = taskData;
  const s = getBgStrings(language);
  const statusBase = { videoId, updatedAt: Date.now() };

  const ctrs = debugInferenceCounters();
  console.log(
    `[BG_TASK] Starting. JS context: enqueueId=${ctrs.enqueueId} activeJobId=${ctrs.activeJobId} ` +
    `(0/0 = fresh context; >0 = shared with FG)`
  );
  getProxyBaseUrl().then(url => {
    console.log(`[BG_TASK] PROXY_BASE_URL = ${url}`);
  }).catch(() => {});

  if (_isRunning) {
    const waitMs = 3000;
    console.warn(`[BG_TASK] _isRunning=true on entry — waiting ${waitMs}ms for previous task to clear...`);
    await sleep(waitMs);
    if (_isRunning) {
      console.warn(`[BG_TASK] _isRunning still true after ${waitMs}ms — force-clearing and proceeding`);
      _isRunning = false;
    }
  }
  _isRunning = true;

  await saveStatus({ ...statusBase, status: 'fetching', progress: 0,
    translatedCount: 0, totalCount: 0 });
  notifyProgress(0, s.fetchingSubtitles);

  await AsyncStorage.setItem(BG_TASK_LOCK_KEY, '1').catch(() => {});

  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  let memWarnSub: ReturnType<typeof AppState.addEventListener> | null = null;
  let bgStateSub: ReturnType<typeof AppState.addEventListener> | null = null;

  try {
    await AsyncStorage.setItem(BG_PENDING_TASK_KEY, JSON.stringify(taskData)).catch(() => {});

    await saveStatus({ ...statusBase, status: 'fetching', progress: 0.01,
      translatedCount: 0, totalCount: 0 });

    let checkpoint: BgTranslationCheckpoint | null = null;
    try {
      const ckptJson = await AsyncStorage.getItem(BG_TASK_CHECKPOINT_KEY);
      if (ckptJson) {
        const parsed = JSON.parse(ckptJson) as BgTranslationCheckpoint;
        if (
          parsed.videoId === videoId &&
          parsed.language === language &&
          parsed.genre === genre &&
          parsed.translatedSegments?.length > 0
        ) {
          checkpoint = parsed;
          console.log(
            `[BG_TASK] Checkpoint found: ${checkpoint.translatedCount}/${checkpoint.totalCount} already done`
          );
        } else {
          await AsyncStorage.removeItem(BG_TASK_CHECKPOINT_KEY).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[BG_TASK] Failed to read checkpoint:', e);
    }

    let subtitleResult: Awaited<ReturnType<typeof fetchYoutubeSubtitles>> = null;
    const fgCacheKey = `fg_fetched_subtitles_${videoId}`;
    for (let cacheAttempt = 0; cacheAttempt < 3; cacheAttempt++) {
      try {
        const fgCached = await AsyncStorage.getItem(fgCacheKey);
        if (fgCached) {
          const parsed = JSON.parse(fgCached);
          if (parsed?.segments?.length > 0) {
            subtitleResult = parsed;
            console.log(`[BG_TASK] Reusing FG-fetched subtitles (attempt ${cacheAttempt + 1}): ${parsed.segments.length} segs`);
          }
          await AsyncStorage.removeItem(fgCacheKey).catch(() => {});
          break;
        } else if (cacheAttempt < 2) {
          console.log(`[BG_TASK] FG cache not ready (attempt ${cacheAttempt + 1}), retrying in 500ms...`);
          await sleep(500);
        }
      } catch (e) {
        console.warn(`[BG_TASK] FG cache read attempt ${cacheAttempt + 1} threw:`, e);
        if (cacheAttempt < 2) await sleep(500);
      }
    }

    if (!subtitleResult || subtitleResult.segments.length === 0) {
      console.log('[BG_TASK] No FG cache — fetching subtitles from network...');
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          clearProxyUrlCache();
        }
        const resolvedProxyUrl = await getProxyBaseUrl();
        console.log(
          `[BG_TASK] Subtitle fetch attempt ${attempt + 1}/3 — ` +
          `strategy=proxy url=${resolvedProxyUrl}/subtitles?videoId=${videoId}&lang=en`
        );
        try {
          subtitleResult = await fetchYoutubeSubtitles(videoId, 'en');
          if (subtitleResult?.segments?.length > 0) {
            console.log(
              `[BG_TASK] Network subtitle fetch OK (attempt ${attempt + 1}): ` +
              `${subtitleResult.segments.length} segs proxyBase=${resolvedProxyUrl}`
            );
            break;
          }
          console.warn(
            `[BG_TASK] Subtitle fetch attempt ${attempt + 1} returned empty result ` +
            `proxyBase=${resolvedProxyUrl}`
          );
        } catch (fetchErr) {
          console.warn(
            `[BG_TASK] Subtitle fetch attempt ${attempt + 1} threw — ` +
            `proxyBase=${resolvedProxyUrl} error:`,
            fetchErr
          );
        }
        if (attempt < 2) await sleep(3000);
      }
    }
    if (!subtitleResult || subtitleResult.segments.length === 0) {
      console.error('[BG_TASK] All subtitle fetch attempts failed — aborting');
      await saveStatus({ ...statusBase, status: 'error', progress: 0,
        translatedCount: 0, totalCount: 0, error: s.noSubtitles });
      await sendFailureNotification(videoTitle, s, s.failNoSubtitles);
      return;
    }

    await saveStatus({ ...statusBase, status: 'fetching', progress: 0.04,
      translatedCount: checkpoint?.translatedCount ?? 0,
      totalCount: subtitleResult.segments.length });

    const totalCount = subtitleResult.segments.length;
    notifyProgress(5, s.subtitlesLoaded(totalCount));

    const modelPath = await getLocalModelPath();
    if (!modelPath) {
      console.error('[BG_TASK] Model file not found — aborting');
      await saveStatus({ ...statusBase, status: 'error', progress: 0,
        translatedCount: 0, totalCount, error: s.noModel });
      await sendFailureNotification(videoTitle, s, s.failNoModel);
      return;
    }
    await saveStatus({ ...statusBase, status: 'fetching', progress: 0.05,
      translatedCount: checkpoint?.translatedCount ?? 0, totalCount });

    try {
      await loadModel();
    } catch (e: any) {
      console.error('[BG_TASK] loadModel() failed:', e);
      await saveStatus({ ...statusBase, status: 'error', progress: 0,
        translatedCount: 0, totalCount, error: s.modelLoadFailed });
      await sendFailureNotification(videoTitle, s, s.failModelLoad);
      return;
    }
    await saveStatus({ ...statusBase, status: 'translating', progress: 0.05,
      translatedCount: checkpoint?.translatedCount ?? 0, totalCount });

    keepAliveInterval = setInterval((() => {
      let isRenewing = false;
      return () => {
        if (isRenewing) {
          console.warn('[BG_TASK] WakeLock renew skipped — previous attempt in progress');
          return;
        }
        isRenewing = true;
        const attemptRenew = (retriesLeft: number, delayMs: number): void => {
          const renewed = NativeModules.TranslationService?.renewWakeLock?.();
          if (renewed === false && retriesLeft > 0) {
            console.warn(`[BG_TASK] WakeLock renew returned false — retrying in ${delayMs}ms (${retriesLeft} retries left)`);
            setTimeout(() => attemptRenew(retriesLeft - 1, delayMs * 2), delayMs);
            return;
          }
          if (renewed === false) {
            console.error('[BG_TASK] WakeLock renewWakeLock() returned false after all retries — OS may interrupt translation on battery-optimized devices');
          } else if (renewed === undefined || renewed === null) {
            if (__DEV__) console.log('[BG_TASK] WakeLock renewWakeLock() returned void (fire-and-forget — assumed success)');
          } else if (__DEV__) {
            console.log('[BG_TASK] WakeLock renewed successfully');
          }
          isRenewing = false;
        };
        attemptRenew(2, 500);
      };
    })(), 2 * 60 * 1000);

    _memoryWarningAbort = false;
    memWarnSub = AppState.addEventListener('memoryWarning', () => {
      console.warn('[BG_TASK] Memory warning received — will abort after checkpoint save');
      _memoryWarningAbort = true;
    });

    setAppBackgroundedHint(AppState.currentState !== 'active');
    bgStateSub = AppState.addEventListener('change', (nextState) => {
      setAppBackgroundedHint(nextState !== 'active');
    });

    const allInput = subtitleResult.segments.map(seg => ({
      start: seg.startTime, end: seg.endTime, text: seg.text, translated: '',
    }));

    const checkpointMap = new Map<string, string>();
    const alreadyDoneSegments: BgTranslationResult['segments'] = [];
    if (checkpoint) {
      for (const seg of checkpoint.translatedSegments) {
        checkpointMap.set(`${seg.start}_${seg.end}`, seg.translated);
        alreadyDoneSegments.push({
          startTime: seg.start, endTime: seg.end,
          original: seg.text, translated: seg.translated,
        });
      }
    }

    const input = checkpointMap.size > 0
      ? allInput.filter(seg => !checkpointMap.has(`${seg.start}_${seg.end}`))
      : allInput;
    const alreadyDoneCount = allInput.length - input.length;

    console.log(`[BG_TASK] Total=${totalCount}, checkpoint=${alreadyDoneCount}, toTranslate=${input.length}`);

    let lastNotifyTime = 0;
    let translated: any[];
    let completedSegments: BgTranslationResult['segments'] = [...alreadyDoneSegments];

    if (input.length === 0 && alreadyDoneCount === totalCount) {
      console.log('[BG_TASK] All segments already in checkpoint — skipping translation');
      translated = [];
    } else {
      if (isModelBusy()) {
        console.log('[BG_TASK] FG inference still running — waiting for it to stop before starting BG translateSegments...');
        const MAX_BUSY_WAIT_MS = 10_000;
        const busyWaitStart = Date.now();
        while (isModelBusy() && Date.now() - busyWaitStart < MAX_BUSY_WAIT_MS) {
          await sleep(200);
        }
        if (isModelBusy()) {
          console.warn('[BG_TASK] FG inference did not clear after 10s — proceeding anyway (stale _isInferenceRunning suspected)');
        } else {
          console.log('[BG_TASK] FG inference stopped — proceeding with BG translation');
        }
      }

      const progressCallback = async (completed: number, total: number, partial: any[]) => {
        const newlyTranslated = partial
          .filter(seg => !!seg.translated)
          .map(seg => ({
            startTime: seg.start,
            endTime: seg.end,
            original: seg.text,
            translated: seg.translated,
          }));
        completedSegments = [...alreadyDoneSegments, ...newlyTranslated];

        const totalDone = alreadyDoneCount + completed;
        const rawFraction = totalCount > 0 ? totalDone / totalCount : 0;
        const fraction = Math.min(1, Math.max(0, rawFraction));
        const pct = Math.round(20 + fraction * 75);

        if (completed % PROGRESS_SAVE_EVERY_N === 0 || completed === total) {
          const ckpt: BgTranslationCheckpoint = {
            videoId, language, genre,
            translatedSegments: completedSegments.map(s => ({
              start: s.startTime, end: s.endTime,
              text: s.original, translated: s.translated,
            })),
            translatedCount: totalDone,
            totalCount,
            updatedAt: Date.now(),
          };

          if (_pendingCheckpointWrites < 3) {
            _pendingCheckpointWrites++;
            AsyncStorage.setItem(BG_TASK_CHECKPOINT_KEY, JSON.stringify(ckpt))
              .catch((e) => console.warn('[BG_TASK] Checkpoint write failed:', e))
              .finally(() => { _pendingCheckpointWrites--; });
          }

          saveStatus({
            ...statusBase,
            status: 'translating',
            progress: fraction,
            translatedCount: totalDone,
            totalCount,
            completedSegments: completedSegments.length,
            updatedAt: Date.now(),
          });

          if (_memoryWarningAbort) {
            throw new Error('MEMORY_WARNING_ABORT');
          }
        }

        const now = Date.now();
        if (now - lastNotifyTime > NOTIFY_THROTTLE_MS) {
          lastNotifyTime = now;
          notifyProgress(pct, s.translating(totalDone, totalCount, Math.round(fraction * 100)));
        }
      };

      let translateAttempt = 0;
      const MAX_TRANSLATE_ATTEMPTS = 2;
      const initialProgress = Math.min(
        0.06,
        totalCount > 0 ? alreadyDoneCount / totalCount : 0
      );
      await saveStatus({
        ...statusBase,
        status: 'translating',
        progress: initialProgress,
        translatedCount: alreadyDoneCount,
        totalCount,
      });
      while (translateAttempt < MAX_TRANSLATE_ATTEMPTS) {
        setBgJobProtection(true);
        try {
          if (translateAttempt > 0) {
            completedSegments = [...alreadyDoneSegments];
          }
          translated = await translateSegments(
            input, progressCallback, videoId, language, genre,
          );
          setBgJobProtection(false);
          break;
        } catch (e: any) {
          setBgJobProtection(false);
          if (e?.message === 'MEMORY_WARNING_ABORT') {
            console.warn('[BG_TASK] Aborted due to memory pressure. Checkpoint saved for resume.');
            await saveStatus({ ...statusBase, status: 'error', progress: 0,
              translatedCount: 0, totalCount, error: s.memoryAbort });
            await sendFailureNotification(videoTitle, s, s.failMemory);
            return;
          }
          if (e?.message === 'INFERENCE_CANCELLED') {
            translateAttempt++;
            const ctrsOnCancel = debugInferenceCounters();
            if (translateAttempt < MAX_TRANSLATE_ATTEMPTS) {
              console.warn(
                `[BG_TASK] INFERENCE_CANCELLED during protected BG job (attempt ${translateAttempt}) — ` +
                `enqueueId=${ctrsOnCancel.enqueueId} activeJobId=${ctrsOnCancel.activeJobId}. Realigning and retrying.`
              );
              cancelFgInference();
              continue;
            }
            console.error(
              `[BG_TASK] BG translateSegments cancelled on both attempts — ` +
              `enqueueId=${ctrsOnCancel.enqueueId} activeJobId=${ctrsOnCancel.activeJobId}`
            );
            await saveStatus({ ...statusBase, status: 'error', progress: 0,
              translatedCount: 0, totalCount, error: s.bgCancelledRetry });
            await sendFailureNotification(videoTitle, s, s.failCancelled);
            return;
          }
          console.error('[BG_TASK] translateSegments error:', e);
          await saveStatus({ ...statusBase, status: 'error', progress: 0,
            translatedCount: 0, totalCount, error: e?.message ?? s.translationError });
          await sendFailureNotification(videoTitle, s, e?.message);
          return;
        }
      }
    }

    const newlyTranslated: BgTranslationResult['segments'] = translated.map(seg => ({
      startTime: seg.start, endTime: seg.end,
      original: seg.text, translated: seg.translated || seg.text,
    }));
    const mergedSegments: BgTranslationResult['segments'] =
      [...alreadyDoneSegments, ...newlyTranslated]
        .sort((a, b) => a.startTime - b.startTime);

    const finalSegments = mergedSegments.length > 0 ? mergedSegments : completedSegments;

    await saveStatus({ ...statusBase, status: 'saving', progress: 0.98,
      translatedCount: finalSegments.length, totalCount: finalSegments.length,
      completedSegments: finalSegments.length });

    const result: BgTranslationResult = {
      videoId, videoTitle, language,
      completedAt: Date.now(),
      source: 'bg',
      segments: finalSegments,
    };

    const RESULT_KEY = `${BG_TASK_RESULT_KEY}_${videoId}`;
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      try {
        await AsyncStorage.setItem(RESULT_KEY, JSON.stringify(result));
        const verify = await AsyncStorage.getItem(RESULT_KEY);
        if (verify) {
          const parsed: BgTranslationResult = JSON.parse(verify);
          if (parsed.segments?.length === finalSegments.length) {
            saved = true;
          } else {
            console.warn(`[BG_TASK] Save verify mismatch (attempt ${attempt + 1})`);
          }
        }
      } catch (e) {
        console.warn(`[BG_TASK] Save result attempt ${attempt + 1} failed:`, e);
      }
      if (!saved && attempt < 2) await sleep(500);
    }

    await AsyncStorage.removeItem(BG_TASK_CHECKPOINT_KEY).catch(() => {});
    await AsyncStorage.removeItem(BG_PENDING_TASK_KEY).catch(() => {});
    await saveStatus({ ...statusBase, status: 'done', progress: 1,
      translatedCount: finalSegments.length, totalCount: finalSegments.length });
    try {
      await NativeModules.TranslationService?.sendCompletionNotification(
        videoTitle, finalSegments.length
      );
    } catch {}

    console.log(`[BG_TASK] Complete: ${videoTitle} (${finalSegments.length} segs)`);

  } finally {
    if (keepAliveInterval !== null) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (memWarnSub !== null) {
      memWarnSub.remove();
      memWarnSub = null;
    }
    if (bgStateSub !== null) {
      bgStateSub.remove();
      bgStateSub = null;
    }
    setAppBackgroundedHint(false);
    _memoryWarningAbort = false;
    _pendingCheckpointWrites = 0;
    console.log('[BG_TASK] _isRunning cleared in finally');
    _isRunning = false;
    await AsyncStorage.removeItem(BG_TASK_LOCK_KEY).catch(() => {});
    await AsyncStorage.removeItem(`fg_fetched_subtitles_${videoId}`).catch(() => {});
    try { await unloadModel(); } catch {}
  }
}