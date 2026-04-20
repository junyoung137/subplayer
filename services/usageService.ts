import firestore from '@react-native-firebase/firestore';

const FREE_DAILY_LIMIT_MINUTES = 30;

function getTodayKey(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function usageDocRef(uid: string) {
  return firestore().collection('users').doc(uid).collection('usage').doc(getTodayKey());
}

export async function getTodayUsage(uid: string): Promise<number> {
  try {
    const snap = await usageDocRef(uid).get();
    if (!snap.exists) return 0;
    return (snap.data()?.minutesUsed as number) ?? 0;
  } catch {
    return 0;
  }
}

export async function addUsage(uid: string, minutes: number): Promise<void> {
  try {
    await usageDocRef(uid).set(
      {
        minutesUsed: firestore.FieldValue.increment(minutes),
        updatedAt:   firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (error) {
    throw error;
  }
}

export async function checkCanProcess(
  uid: string,
  isPro: boolean,
  requestedMinutes: number,
): Promise<{ canProcess: boolean; usedMinutes: number; remainingMinutes: number }> {
  if (isPro) {
    return { canProcess: true, usedMinutes: 0, remainingMinutes: Infinity };
  }

  try {
    const usedMinutes      = await getTodayUsage(uid);
    const remainingMinutes = Math.max(0, FREE_DAILY_LIMIT_MINUTES - usedMinutes);
    const canProcess       = usedMinutes + requestedMinutes <= FREE_DAILY_LIMIT_MINUTES;
    return { canProcess, usedMinutes, remainingMinutes };
  } catch {
    return { canProcess: false, usedMinutes: 0, remainingMinutes: 0 };
  }
}
