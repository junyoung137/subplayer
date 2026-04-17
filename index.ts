import { AppRegistry, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { backgroundTranslationTask } from './services/backgroundTranslationTask';
import {
  BG_PENDING_TASK_KEY,
  BG_TASK_STATUS_KEY,
  BgTranslationTask,
  BgTaskStatusData,
} from './services/backgroundTranslationTask';

// Global unhandled promise rejection handler — prevents silent crashes where a
// rejected promise with no .catch() would kill the process on Android.
// This must be registered before any async code runs.
const _origHandler = (global as any).onunhandledrejection;
(global as any).onunhandledrejection = (event: any) => {
  console.error('[GLOBAL] Unhandled promise rejection:', event?.reason ?? event);
  if (_origHandler) _origHandler(event);
};

// Wrap task in a top-level safety catch so the returned Promise ALWAYS resolves.
// An unhandled rejection from a HeadlessJS task silently kills the JS thread on Android.
//
// isHeadlessContext=true tells backgroundTranslationTask that it is running in a
// background-only context (no React UI, app already backgrounded or killed).
// This disables the AppState 'background' guard (appHasGoneBackground) so
// APP_BACKGROUNDED is structurally unreachable and the yield-to-HeadlessJS loop
// cannot trigger.  Without this, the task would throw APP_BACKGROUNDED on the
// first checkpoint and call notifyJsYielded() → infinite retry cycle.
AppRegistry.registerHeadlessTask('BackgroundTranslation', () => async (taskData: any) => {
  console.log('[HEADLESS] BackgroundTranslation task entry taskData=', JSON.stringify(taskData));
  try {
    await backgroundTranslationTask({
      ...(taskData as BgTranslationTask),
      isHeadlessContext: true,
    });
    console.log('[HEADLESS] BackgroundTranslation task completed');
  } catch (e) {
    console.error('[HEADLESS] Uncaught top-level error in BackgroundTranslation task:', e);
    // Always resolve — never let the HeadlessJS runner receive a rejection
  }
});

// Recovery: if a task was pending when the app was killed, restart it
async function recoverPendingTask(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!NativeModules.TranslationService) return;
  try {
    const [pendingRaw, statusRaw] = await Promise.all([
      AsyncStorage.getItem(BG_PENDING_TASK_KEY),
      AsyncStorage.getItem(BG_TASK_STATUS_KEY),
    ]);
    if (!pendingRaw) return;

    const pending: BgTranslationTask = JSON.parse(pendingRaw);
    const status: BgTaskStatusData | null = statusRaw
      ? JSON.parse(statusRaw) : null;

    // Skip recovery if already done/error
    if (status?.status === 'done' || status?.status === 'error') return;

    // Skip if task is stale (>2 hours old)
    if (Date.now() - pending.enqueuedAt > 2 * 60 * 60 * 1000) {
      await AsyncStorage.multiRemove([BG_PENDING_TASK_KEY, BG_TASK_STATUS_KEY]);
      return;
    }

    // Restart the foreground service — it will re-launch the HeadlessTask
    await NativeModules.TranslationService.startTranslation({
      videoId:    pending.videoId,
      videoTitle: pending.videoTitle,
      language:   pending.language,
      genre:      pending.genre,
    });
  } catch (e) {
    console.warn('[Recovery] Failed to recover pending task:', e);
  }
}

recoverPendingTask();

import "expo-router/entry";
