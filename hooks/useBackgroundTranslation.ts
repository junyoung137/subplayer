import { useState, useEffect, useCallback, useRef } from 'react';
import { NativeModules, AppState, AppStateStatus, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BgTranslationTask, BgTranslationResult, BgTaskStatusData,
  BG_TASK_STATUS_KEY, BG_TASK_RESULT_KEY, BG_PENDING_TASK_KEY,
  BG_TASK_LOCK_KEY,
  backgroundTranslationTask,
} from '../services/backgroundTranslationTask';

const POLL_INTERVAL_MS      = 2000;
const POLL_INTERVAL_ACTIVE  = 500;  // faster when BG is running
// Minimum time (ms) a non-terminal status must be displayed before transitioning
const MIN_STATUS_DISPLAY_MS = 500;

// [Improvement 3] Module-level enqueue lock — guards against double-tapping the BG
// button faster than the React state update cycle.  Unlike the `status` state check
// (which is stale during async gaps), this flag is set synchronously and cleared
// only when polling confirms a terminal state or cancelTranslation() is called.
let _enqueueLock = false;

export interface UseBackgroundTranslationReturn {
  status: BgTaskStatusData | null;
  isBackgroundRunning: boolean;
  pendingTaskTitle: string | null;
  enqueueTranslation: (task: Omit<BgTranslationTask, 'enqueuedAt'>) => Promise<void>;
  cancelTranslation: () => Promise<void>;
  loadResult: (videoId: string) => Promise<BgTranslationResult | null>;
  clearResult: (videoId: string) => Promise<void>;
}

export function useBackgroundTranslation(activeVideoId?: string): UseBackgroundTranslationReturn {
  const [status, setStatus] = useState<BgTaskStatusData | null>(null);
  const [isBackgroundRunning, setIsBackgroundRunning] = useState(false);
  const [pendingTaskTitle, setPendingTaskTitle] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // For 500ms minimum display time on non-terminal status transitions
  const prevPolledStatusRef = useRef<string | null>(null);
  const statusDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(BG_TASK_STATUS_KEY);
      if (!raw) {
        prevPolledStatusRef.current = null;
        setStatus(null);
        setIsBackgroundRunning(false);
        return;
      }
      const data: BgTaskStatusData = JSON.parse(raw);

      // Video-id guard: status belongs to a different video — treat as idle for this screen
      if (activeVideoId && data.videoId !== activeVideoId) {
        prevPolledStatusRef.current = null;
        setStatus(null);
        setIsBackgroundRunning(false);
        return;
      }

      // Stale check: discard if >10 min old and not a terminal state
      const isTerminal = data.status === 'done' || data.status === 'error';
      if (!isTerminal && Date.now() - data.updatedAt > 10 * 60 * 1000) {
        prevPolledStatusRef.current = null;
        setStatus(null);
        setIsBackgroundRunning(false);
        return;
      }

      const active = data.status === 'fetching'
        || data.status === 'translating'
        || data.status === 'saving';

      const isStatusTransition = prevPolledStatusRef.current !== data.status;

      if (isStatusTransition && !isTerminal && prevPolledStatusRef.current !== null) {
        // Non-terminal transition: debounce by MIN_STATUS_DISPLAY_MS to prevent flicker
        if (statusDebounceTimerRef.current) clearTimeout(statusDebounceTimerRef.current);
        statusDebounceTimerRef.current = setTimeout(() => {
          prevPolledStatusRef.current = data.status;
          setStatus(data);
          setIsBackgroundRunning(active);
          statusDebounceTimerRef.current = null;
        }, MIN_STATUS_DISPLAY_MS);
        // Update isBackgroundRunning immediately so banner shows/hides correctly
        setIsBackgroundRunning(active);
      } else {
        prevPolledStatusRef.current = data.status;
        setStatus(data);
        setIsBackgroundRunning(active);
      }

      // Terminal: clear pendingTaskTitle, lock, and stop polling
      if (isTerminal) {
        _enqueueLock = false;
        setPendingTaskTitle(null);
        stopPolling();
      }
    } catch {
      prevPolledStatusRef.current = null;
      setStatus(null);
      setIsBackgroundRunning(false);
    }
  }, [stopPolling]);

  const startPolling = useCallback((intervalMs = POLL_INTERVAL_MS) => {
    stopPolling();
    pollStatus(); // immediate first poll
    pollTimerRef.current = setInterval(pollStatus, intervalMs);
  }, [pollStatus, stopPolling]);

  useEffect(() => {
    // Hydrate isBackgroundRunning synchronously from persisted status
    AsyncStorage.getItem(BG_TASK_STATUS_KEY).then(raw => {
      if (!raw) return;
      try {
        const data: BgTaskStatusData = JSON.parse(raw);
        // Video-id guard: ignore status from a different video
        if (activeVideoId && data.videoId !== activeVideoId) return;
        const isTerminal = data.status === 'done' || data.status === 'error';
        // [FIX ISSUE1] Apply the same staleness check as pollStatus — if the
        // persisted status is >10 min old and non-terminal, it is from a crashed
        // previous session. Restoring it would incorrectly show the BG banner on
        // a fresh video load.
        if (!isTerminal && Date.now() - data.updatedAt > 10 * 60 * 1000) return;
        const active = data.status === 'fetching'
          || data.status === 'translating'
          || data.status === 'saving';
        if (active) {
          prevPolledStatusRef.current = data.status;
          setStatus(data);
          setIsBackgroundRunning(true);
        }
      } catch {}
    });
    startPolling();
    // On app foreground: poll immediately to reflect latest state
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') pollStatus();
    });
    return () => {
      sub.remove();
      stopPolling();
      if (statusDebounceTimerRef.current) {
        clearTimeout(statusDebounceTimerRef.current);
        statusDebounceTimerRef.current = null;
      }
    };
  }, [startPolling, stopPolling, pollStatus]);

  // Switch to 500 ms when BG is active so the screen gets near-real-time progress.
  useEffect(() => {
    startPolling(isBackgroundRunning ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_MS);
  }, [isBackgroundRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  const enqueueTranslation = useCallback(async (
    task: Omit<BgTranslationTask, 'enqueuedAt'>
  ): Promise<void> => {
    if (Platform.OS !== 'android') return;

    // Guard: prevent double-enqueue.  Check module-level lock first (synchronous,
    // immune to stale closure) then fall back to status state for good measure.
    if (_enqueueLock) {
      throw new Error('Translation already in progress');
    }
    if (
      status?.status === 'fetching' ||
      status?.status === 'translating' ||
      status?.status === 'saving'
    ) {
      throw new Error('Translation already in progress');
    }
    _enqueueLock = true; // set synchronously before any await

    const initial: BgTaskStatusData = {
      videoId: task.videoId,
      status: 'fetching',
      progress: 0,
      translatedCount: 0,
      totalCount: 0,
      updatedAt: Date.now(),
    };
    await AsyncStorage.setItem(BG_TASK_STATUS_KEY, JSON.stringify(initial)).catch(() => {});
    prevPolledStatusRef.current = 'fetching';
    setPendingTaskTitle(task.videoTitle);
    setStatus(initial);
    setIsBackgroundRunning(true);

    // Clear any stale lock from a previous crashed session before starting fresh
    await AsyncStorage.removeItem(BG_TASK_LOCK_KEY).catch(() => {});

    // Start native Android ForegroundService.
    // This keeps the process and JS context alive when the app goes to background.
    // Without this, the OS can kill the process mid-translation.
    // This is NOT for triggering HeadlessJS — HeadlessJS has been removed.
    // The ForegroundService simply holds a WakeLock and foreground notification
    // so Android does not kill the process during background translation.
    if (NativeModules.TranslationService) {
      try {
        await NativeModules.TranslationService.startTranslation({
          videoId:    task.videoId,
          videoTitle: task.videoTitle,
          language:   task.language,
          genre:      task.genre,
        });
      } catch (e) {
        console.warn('[BG_TRANSLATE] ForegroundService start failed (non-fatal):', e);
      }
    }

    console.log('[BG_TRANSLATE] Starting direct JS translation runner');
    const fullTask: BgTranslationTask = {
      ...task,
      enqueuedAt: Date.now(),
    };
    backgroundTranslationTask(fullTask).catch(e => {
      console.warn('[BG_TRANSLATE] Direct JS runner error:', e);
    });

    startPolling();
  }, [status, startPolling]);

  const cancelTranslation = useCallback(async (): Promise<void> => {
    _enqueueLock = false; // release lock synchronously
    stopPolling();
    prevPolledStatusRef.current = null;
    setPendingTaskTitle(null);
    try { await NativeModules.TranslationService?.stopService(); } catch {}
    await AsyncStorage.multiRemove([BG_TASK_STATUS_KEY, BG_PENDING_TASK_KEY, BG_TASK_LOCK_KEY]).catch(() => {});
    setStatus(null);
    setIsBackgroundRunning(false);
  }, [stopPolling]);

  const loadResult = useCallback(async (
    videoId: string
  ): Promise<BgTranslationResult | null> => {
    try {
      const raw = await AsyncStorage.getItem(`${BG_TASK_RESULT_KEY}_${videoId}`);
      if (!raw) return null;
      return JSON.parse(raw) as BgTranslationResult;
    } catch { return null; }
  }, []);

  const clearResult = useCallback(async (videoId: string): Promise<void> => {
    try { await AsyncStorage.removeItem(`${BG_TASK_RESULT_KEY}_${videoId}`); } catch {}
  }, []);

  return {
    status,
    isBackgroundRunning,
    pendingTaskTitle,
    enqueueTranslation,
    cancelTranslation,
    loadResult,
    clearResult,
  };
}
