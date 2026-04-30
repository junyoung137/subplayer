/**
 * usageTracker.ts — audit log only.
 * Does NOT gate processing. Does NOT deduplicate billing.
 * Authoritative cap:   usePlanStore (canProcess)
 * Authoritative dedup: serverBridgeService (safeRecordUsage)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const USAGE_KEY = 'usage_tracker_v1';

interface UsageRecord {
  date: string;
  seconds: number;
  plan: string;
}

export async function recordGpuSeconds(seconds: number, plan: string): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const raw = await AsyncStorage.getItem(USAGE_KEY);
    const records: UsageRecord[] = raw ? JSON.parse(raw) : [];

    const rec = records.find(r => r.date === today && r.plan === plan);
    if (rec) {
      rec.seconds += seconds;
    } else {
      records.push({ date: today, seconds, plan });
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    await AsyncStorage.setItem(USAGE_KEY, JSON.stringify(records.filter(r => r.date >= cutoffStr)));
  } catch (e) {
    console.warn('[UsageTracker] Failed to record:', e);
  }
}

export async function getUsageThisMonth(plan: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(USAGE_KEY);
    if (!raw) return 0;
    const records: UsageRecord[] = JSON.parse(raw);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    return records
      .filter(r => r.date >= monthStart && r.plan === plan)
      .reduce((sum, r) => sum + r.seconds, 0);
  } catch { return 0; }
}

export async function clearUsageHistory(): Promise<void> {
  await AsyncStorage.removeItem(USAGE_KEY).catch(() => {});
}
