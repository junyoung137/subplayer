import AsyncStorage from '@react-native-async-storage/async-storage';
import { BG_PENDING_TASK_KEY, BgTranslationTask } from './backgroundTranslationTask';

/**
 * Call on app startup (App.tsx useEffect on mount).
 * Returns the unfinished task if found and < 24h old. Returns null otherwise.
 */
export async function checkPendingTranslationTask(): Promise<BgTranslationTask | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_PENDING_TASK_KEY);
    if (!raw) return null;
    const task: BgTranslationTask = JSON.parse(raw);
    if (Date.now() - task.enqueuedAt > 24 * 60 * 60 * 1000) {
      await AsyncStorage.removeItem(BG_PENDING_TASK_KEY);
      return null;
    }
    return task;
  } catch {
    return null;
  }
}

export async function clearPendingTranslationTask(): Promise<void> {
  try { await AsyncStorage.removeItem(BG_PENDING_TASK_KEY); } catch {}
}