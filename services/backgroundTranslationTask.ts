import { NativeModules, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
// [FIX BUG1] Import async resolver — getProxyBaseUrl() reads AsyncStorage on
// first call in HeadlessJS context (where __DEV__ is always false).
import { fetchYoutubeSubtitles, getProxyBaseUrl, clearProxyUrlCache } from './youtubeTimedText';
import { loadModel, unloadModel, translateSegments, isModelBusy, debugInferenceCounters, setBgJobProtection, cancelFgInference, setAppBackgroundedHint } from './gemmaTranslationService';
import { getLocalModelPath } from './modelDownloadService';

export const BG_TASK_STATUS_KEY  = 'bg_translation_status';
export const BG_TASK_RESULT_KEY  = 'bg_translation_result';
export const BG_PENDING_TASK_KEY = 'bg_translation_pending_task';
export const BG_TASK_CHECKPOINT_KEY = 'bg_translation_checkpoint_v1';
export const BG_TASK_LOCK_KEY    = 'bg_translation_lock';

// IPC 알림 throttle (2s) — do not change
const NOTIFY_THROTTLE_MS = 2000;
// Fix 3: checkpoint every 5 segments to reduce AsyncStorage write pressure on low-end devices
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
// Set to true when AppState fires a 'memoryWarning' event during BG translation.
// The progress callback checks this flag and throws to abort gracefully after
// saving the checkpoint — preventing an OOM kill mid-translation.
let _memoryWarningAbort = false;
// Counts in-flight fire-and-forget AsyncStorage checkpoint writes inside progressCallback.
// Capped at 3 to prevent write queue buildup on low-end devices when batches run at full
// speed in background. Reset to 0 in the finally block between task invocations.
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

async function sendFailureNotification(videoTitle: string, reason?: string): Promise<void> {
  try {
    await NativeModules.TranslationService?.sendCompletionNotification(
      `❌ ${videoTitle} 번역 실패${reason ? ': ' + reason : ''}`, 0
    );
  } catch {}
}

export async function backgroundTranslationTask(taskData: BgTranslationTask): Promise<void> {
  const { videoId, videoTitle, language, genre } = taskData;
  const statusBase = { videoId, updatedAt: Date.now() };

  // [DEBUG] If counters are 0 this task runs in a FRESH JS context (separate from FG).
  // If counters are > 0 it shares the FG module singleton — cancelFgInference() must
  // be used in startBgTranslation to keep the queue counters aligned.
  const ctrs = debugInferenceCounters();
  console.log(
    `[BG_TASK] Starting. JS context: enqueueId=${ctrs.enqueueId} activeJobId=${ctrs.activeJobId} ` +
    `(0/0 = fresh context; >0 = shared with FG)`
  );
  // [FIX BUG1] Log the resolved proxy URL so logcat shows what URL HeadlessJS is using.
  // getProxyBaseUrl() reads AsyncStorage (seeded by setProxyBaseUrl in FG _layout.tsx).
  getProxyBaseUrl().then(url => {
    console.log(`[BG_TASK] PROXY_BASE_URL = ${url}`);
  }).catch(() => {});

  // Fix 4: if _isRunning is true the previous task may still be in its finally block.
  // Wait up to 3 s for it to clear before proceeding.
  if (_isRunning) {
    const waitMs = 3000;
    console.warn(`[BG_TASK] _isRunning=true on entry — waiting ${waitMs}ms for previous task to clear...`);
    await sleep(waitMs);
    if (_isRunning) {
      console.error(`[BG_TASK] _isRunning still true after ${waitMs}ms — force-clearing and proceeding`);
      _isRunning = false;
    }
  }
  _isRunning = true;

  // Write initial status FIRST — before any await — so UI shows 'fetching' even if
  // the task dies early during checkpoint read or lock acquisition.
  await saveStatus({ ...statusBase, status: 'fetching', progress: 0,
    translatedCount: 0, totalCount: 0 });
  notifyProgress(0, '📡 자막 가져오는 중...');

  await AsyncStorage.setItem(BG_TASK_LOCK_KEY, '1').catch(() => {});

  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  let memWarnSub: ReturnType<typeof AppState.addEventListener> | null = null;
  let bgStateSub: ReturnType<typeof AppState.addEventListener> | null = null;

  try {
    await AsyncStorage.setItem(BG_PENDING_TASK_KEY, JSON.stringify(taskData)).catch(() => {});

    // Improvement 1-a: progress 0.01 — lock acquired, task is live
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

    // Try to reuse subtitles already fetched by FG to skip the network round-trip.
    // Retry up to 3 times with 500ms delay — FG may not have written the cache yet.
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
          await AsyncStorage.removeItem(fgCacheKey).catch(() => {}); // consume once
          break; // found (or empty cache key) — stop retrying
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
        // On retries (attempt > 0), force-clear the in-memory URL cache so
        // getProxyBaseUrl() re-reads AsyncStorage.  This recovers from the race
        // where HeadlessJS starts before FG _layout.tsx has written the proxy URL:
        // the 3 s sleep gives FG time to persist the correct URL, and clearing the
        // cache ensures the next attempt picks it up rather than re-using a stale
        // null-resolved placeholder from the previous attempt.
        if (attempt > 0) {
          clearProxyUrlCache();
        }

        // Log the exact URL that will be used for this attempt BEFORE calling
        // fetchYoutubeSubtitles, so a timeout-based AbortError can be correlated
        // with the specific URL that was hanging.
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
      // No fetchSubtitlesViaYtDlp() client-side fallback exists — yt-dlp runs
      // server-side only. All strategies (proxy → retry with fresh URL) exhausted.
      console.error(
        '[BG_TASK] All fetch strategies exhausted — ' +
        'server cannot reach YouTube (DNS failure). ' +
        'Check server network/DNS configuration. ' +
        'Set YTDLP_PROXY env var on the server to route yt-dlp through a proxy.'
      );
      console.error('[BG_TASK] All subtitle fetch attempts failed — aborting');
      await saveStatus({ ...statusBase, status: 'error', progress: 0,
        translatedCount: 0, totalCount: 0, error: '자막 없음' });
      await sendFailureNotification(videoTitle, '자막 없음');
      return;
    }

    // Improvement 1-b: progress 0.04 — subtitles fetched
    await saveStatus({ ...statusBase, status: 'fetching', progress: 0.04,
      translatedCount: checkpoint?.translatedCount ?? 0,
      totalCount: subtitleResult.segments.length });

    const totalCount = subtitleResult.segments.length;
    notifyProgress(5, `📥 자막 ${totalCount}개 로드 완료`);

    const modelPath = await getLocalModelPath();
    if (!modelPath) {
      console.error('[BG_TASK] Model file not found — aborting');
      await saveStatus({ ...statusBase, status: 'error', progress: 0,
        translatedCount: 0, totalCount, error: '모델 파일 없음' });
      await sendFailureNotification(videoTitle, '모델 파일 없음');
      return;
    }
    // Improvement 1-c: progress 0.05 — model path verified
    await saveStatus({ ...statusBase, status: 'fetching', progress: 0.05,
      translatedCount: checkpoint?.translatedCount ?? 0, totalCount });

    try {
      await loadModel();
    } catch (e: any) {
      console.error('[BG_TASK] loadModel() failed:', e);
      await saveStatus({ ...statusBase, status: 'error', progress: 0,
        translatedCount: 0, totalCount, error: '모델 로드 실패' });
      await sendFailureNotification(videoTitle, '모델 로드 실패');
      return;
    }
    // Improvement 1-d: translating/0.05 — model loaded, translation about to start
    await saveStatus({ ...statusBase, status: 'translating', progress: 0.05,
      translatedCount: checkpoint?.translatedCount ?? 0, totalCount });

    keepAliveInterval = setInterval((() => {
      // isRenewing scoped to IIFE — not module level.
      // Prevents retry chains from overlapping across interval ticks.
      let isRenewing = false;

      return () => {
        if (isRenewing) {
          console.warn('[BG_TASK] WakeLock renew skipped — previous attempt in progress');
          return;
        }
        isRenewing = true;

        // 2 min interval — some OEMs (Xiaomi MIUI, Samsung One UI) silently
        // revoke wake locks in <3 minutes. Previous interval was too infrequent.
        const attemptRenew = (retriesLeft: number, delayMs: number): void => {
          const renewed = NativeModules.TranslationService?.renewWakeLock?.();

          // Only retry on explicit false — undefined/void means fire-and-forget native
          // call that doesn't return a confirmation, which is not a real failure.
          if (renewed === false && retriesLeft > 0) {
            console.warn(
              `[BG_TASK] WakeLock renew returned false — retrying in ${delayMs}ms ` +
              `(${retriesLeft} retries left)`
            );
            setTimeout(() => attemptRenew(retriesLeft - 1, delayMs * 2), delayMs);
            return; // chain continues — isRenewing stays true
          }

          // Terminal path: explicit false after retries exhausted, ambiguous, or success.
          if (renewed === false) {
            // Explicit failure confirmed after all retries — real WakeLock problem.
            console.error(
              '[BG_TASK] WakeLock renewWakeLock() returned false after all retries — ' +
              'OS may interrupt translation on battery-optimized devices'
            );
          } else if (renewed === undefined || renewed === null) {
            // Ambiguous: native method returned void/undefined (fire-and-forget).
            // Treat as success — no retry, no error log in production.
            if (__DEV__) {
              console.log('[BG_TASK] WakeLock renewWakeLock() returned void (fire-and-forget — assumed success)');
            }
          } else if (__DEV__) {
            console.log('[BG_TASK] WakeLock renewed successfully');
          }

          isRenewing = false; // exactly once, at true end of chain
        };

        attemptRenew(2, 500);
      };
    })(), 2 * 60 * 1000);

    // Memory pressure guard: when Android signals low memory, set the abort flag so
    // the progress callback throws after saving the current checkpoint. This gives us
    // a clean exit (with resume data) rather than a hard OOM kill.
    _memoryWarningAbort = false;
    memWarnSub = AppState.addEventListener('memoryWarning', () => {
      console.warn('[BG_TASK] Memory warning received — will abort after checkpoint save');
      _memoryWarningAbort = true;
    });

    // Background state hint for gemmaTranslationService — drives sleep() branch selection
    // and inter-batch sleep skip. AppState listener is event-driven so the flag is always
    // current; AppState.currentState has a propagation delay and must not be used inside
    // the per-batch hot path.
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

    console.log(
      `[BG_TASK] Total=${totalCount}, checkpoint=${alreadyDoneCount}, toTranslate=${input.length}`
    );

    let lastNotifyTime = 0;
    let translated: any[];
    let completedSegments: BgTranslationResult['segments'] = [...alreadyDoneSegments];

    if (input.length === 0 && alreadyDoneCount === totalCount) {
      console.log('[BG_TASK] All segments already in checkpoint — skipping translation');
      translated = [];
    } else {
      // [BUG 1] Wait for any in-flight FG inference to stop before entering the queue.
      // enqueueInference already serialises execution, but this makes intent explicit
      // and gives us an early log so we know BG was blocked.
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

      // Extract the progress callback so it can be reused on retry.
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

        // Save checkpoint every PROGRESS_SAVE_EVERY_N=5 segments (or on last segment).
        // Both writes are fire-and-forget so they never block the batch loop — awaiting
        // AsyncStorage inside progressCallback causes Stall #3 when Hermes is throttled.
        // _pendingCheckpointWrites guards against write queue buildup on low-end devices.
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

          // status에 progress를 즉시 기록 — 500ms 폴링이 읽어감
          saveStatus({
            ...statusBase,
            status: 'translating',
            progress: fraction,
            translatedCount: totalDone,
            totalCount,
            completedSegments: completedSegments.length,
            updatedAt: Date.now(),
          }); // saveStatus has internal try/catch; fire-and-forget is intentional

          // Memory pressure abort: both writes dispatched above, safe to throw now.
          // The outer catch writes 'error' status; checkpoint allows resume.
          if (_memoryWarningAbort) {
            throw new Error('MEMORY_WARNING_ABORT');
          }

        }

        // IPC는 2초 throttle 유지 (네이티브 알림 과부하 방지)
        const now = Date.now();
        if (now - lastNotifyTime > NOTIFY_THROTTLE_MS) {
          lastNotifyTime = now;
          notifyProgress(pct,
            `🌐 번역 중... ${totalDone}/${totalCount} (${Math.round(fraction * 100)}%)`);
        }
      };

      // Protect the BG translateSegments call from screen-unmount cancellation.
      // setBgJobProtection(true) makes cancelFgInference() a no-op until we clear it.
      // One retry is attempted if INFERENCE_CANCELLED slips through (counter misalign race).
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
            // Reset completedSegments so the progress callback accumulates cleanly.
            completedSegments = [...alreadyDoneSegments];
          }
          translated = await translateSegments(
            input, progressCallback, videoId, language, genre,
          );
          setBgJobProtection(false);
          break; // success — exit retry loop
        } catch (e: any) {
          setBgJobProtection(false);
          if (e?.message === 'MEMORY_WARNING_ABORT') {
            // Checkpoint was saved just before throwing — translation can be resumed.
            console.warn('[BG_TASK] Aborted due to memory pressure. Checkpoint saved for resume.');
            await saveStatus({ ...statusBase, status: 'error', progress: 0,
              translatedCount: 0, totalCount,
              error: '메모리 부족 — 재시작 시 이어서 번역됩니다' });
            await sendFailureNotification(videoTitle, '메모리 부족 (재시작 시 재개)');
            return;
          }
          if (e?.message === 'INFERENCE_CANCELLED') {
            translateAttempt++;
            const ctrsOnCancel = debugInferenceCounters();
            if (translateAttempt < MAX_TRANSLATE_ATTEMPTS) {
              // Counter misalignment race despite protection — re-align and retry once.
              console.warn(
                `[BG_TASK] INFERENCE_CANCELLED during protected BG job (attempt ${translateAttempt}) — ` +
                `enqueueId=${ctrsOnCancel.enqueueId} activeJobId=${ctrsOnCancel.activeJobId}. Realigning and retrying.`
              );
              cancelFgInference(); // re-aligns _enqueueId so next enqueue wins
              continue;
            }
            // Both attempts cancelled — give up.
            console.error(
              `[BG_TASK] BG translateSegments cancelled on both attempts — ` +
              `enqueueId=${ctrsOnCancel.enqueueId} activeJobId=${ctrsOnCancel.activeJobId}`
            );
            await saveStatus({ ...statusBase, status: 'error', progress: 0,
              translatedCount: 0, totalCount,
              error: 'BG 번역 취소됨 (재시도 실패)' });
            await sendFailureNotification(videoTitle, 'BG 번역 취소됨 (재시도 실패)');
            return;
          }
          console.error('[BG_TASK] translateSegments error:', e);
          await saveStatus({ ...statusBase, status: 'error', progress: 0,
            translatedCount: 0, totalCount, error: e?.message ?? '번역 오류' });
          await sendFailureNotification(videoTitle, e?.message);
          return;
        }
      }
    }

    // 결과 저장
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
    // Fix 4: explicit log so logcat confirms the guard is cleared for the next invocation.
    console.log('[BG_TASK] _isRunning cleared in finally');
    _isRunning = false;
    await AsyncStorage.removeItem(BG_TASK_LOCK_KEY).catch(() => {});
    // Clean up any unconsumed FG subtitle cache (e.g., task failed before reaching fetch)
    await AsyncStorage.removeItem(`fg_fetched_subtitles_${videoId}`).catch(() => {});
    try { await unloadModel(); } catch {}
  }
}