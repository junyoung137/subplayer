/**
 * usePlanStore.ts
 * Plan state, usage cap enforcement, monthly reset.
 */

import { useState, useEffect } from 'react';
import { create } from 'zustand';
import { useSettingsStore } from './useSettingsStore';
import i18n from '../i18n';

// ── DEV MODE ─────────────────────────────────────────
let _DevConfig: typeof import('../utils/devConfig').DevConfig | null = null;

if (__DEV__) {
  import('../utils/devConfig')
    .then(m => { _DevConfig = m.DevConfig; })
    .catch(() => {});
}

// ── TYPES ───────────────────────────────────────────
export type PlanTier = 'free' | 'standard' | 'pro';

export interface PlanLimits {
  dailyCapMinutes: number;
  monthlyCapMinutes: number;
  useServerGpu: boolean;
  maxConcurrentJobs: number;
}

// readonly 제거 (타입 충돌 방지)
const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free:     { dailyCapMinutes: 20,   monthlyCapMinutes: 0,    useServerGpu: false, maxConcurrentJobs: 1 },
  standard: { dailyCapMinutes: 0,    monthlyCapMinutes: 1200, useServerGpu: true,  maxConcurrentJobs: 1 },
  pro:      { dailyCapMinutes: 0,    monthlyCapMinutes: 2400, useServerGpu: true,  maxConcurrentJobs: 1 },
};

// ── RESET GUARD ─────────────────────────────────────
let _isResetting = false;

const enterReset = () => { _isResetting = true; };
const exitReset  = () => { _isResetting = false; };

// ── STORE ───────────────────────────────────────────
interface PlanStore {
  tier: PlanTier;
  limits: PlanLimits;
  usedMinutes: number;
  resetAt: number | null;

  syncFromSettings: () => Promise<void>;
  canProcess: (estimatedMinutes?: number) => { allowed: boolean; reason?: string };
  recordUsage: (seconds: number) => void;
  resetMonthlyUsage: () => void;
}

export const usePlanStore = create<PlanStore>((set, get) => ({
  tier: 'free',
  limits: PLAN_LIMITS.free,
  usedMinutes: 0,
  resetAt: null,

  // ── SETTINGS 동기화 ───────────────────────────────
  syncFromSettings: async () => {
    if (__DEV__) {
      await useSettingsStore.getState().hydrate();
    }

    const s = useSettingsStore.getState();

    const devPlan = _DevConfig?.getDevPlan();

    const effectivePlan =
      (__DEV__ && _DevConfig?.isDevMode() && devPlan)
        ? devPlan as PlanTier
        : s.plan as PlanTier;

    const needsReset = !!(s.monthlyResetAt && Date.now() > s.monthlyResetAt);

    set({
      tier: effectivePlan,
      limits: PLAN_LIMITS[effectivePlan],
      usedMinutes: needsReset ? 0 : s.monthlyUsedMinutes,
      resetAt: s.monthlyResetAt,
    });

    if (needsReset) {
      get().resetMonthlyUsage();
    }
  },

  // ── 사용 가능 여부 체크 (pure) ─────────────────────
  canProcess: (estimatedMinutes = 1) => {
    const { tier, limits, usedMinutes, resetAt } = get();
    const s = useSettingsStore.getState();

    let effectiveUsed = usedMinutes;
    let effectiveResetAt = resetAt;
    let effectiveExpires = s.planExpiresAt;

    if (__DEV__ && _DevConfig?.isDevMode()) {
      const devUsage   = _DevConfig.getDevUsageMinutes();
      const devReset   = _DevConfig.getDevResetAt();
      const devExpires = _DevConfig.getDevExpiresAt();

      if (devUsage   !== null) effectiveUsed = devUsage;
      if (devReset   !== null) effectiveResetAt = devReset;
      if (devExpires !== null) effectiveExpires = devExpires;
    }

    const activeUsed =
      (effectiveResetAt && Date.now() > effectiveResetAt)
        ? 0
        : effectiveUsed;

    if (tier !== 'free' && effectiveExpires && Date.now() > effectiveExpires) {
      return { allowed: false, reason: i18n.t('plan.subscriptionExpired') };
    }

    if (tier === 'free') {
      if (activeUsed + estimatedMinutes > limits.dailyCapMinutes) {
        return {
          allowed: false,
          reason: i18n.t('plan.freeDailyLimitReached', { cap: limits.dailyCapMinutes })
        };
      }
    } else {
      if (
        limits.monthlyCapMinutes > 0 &&
        activeUsed + estimatedMinutes > limits.monthlyCapMinutes
      ) {
        return {
          allowed: false,
          reason: i18n.t('plan.monthlyLimitReached', {
            hours: limits.monthlyCapMinutes / 60
          })
        };
      }
    }

    return { allowed: true };
  },

  // ── 사용량 기록 ───────────────────────────────────
  recordUsage: (seconds: number) => {
    const newUsed = get().usedMinutes + seconds / 60;

    try {
      useSettingsStore.getState().update({
        monthlyUsedMinutes: newUsed,
      });

      set({ usedMinutes: newUsed });
    } catch (e) {
      console.warn('[PlanStore] recordUsage 실패:', e);
    }
  },

  // ── 월간 리셋 ─────────────────────────────────────
  resetMonthlyUsage: () => {
    enterReset();

    try {
      const now = new Date();
      const nextMonth = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        1,
        0, 0, 0, 0
      );

      const nextResetAt = nextMonth.getTime();

      set({
        usedMinutes: 0,
        resetAt: nextResetAt,
      });

      useSettingsStore.getState().update({
        monthlyUsedMinutes: 0,
        monthlyResetAt: nextResetAt,
      });

    } finally {
      exitReset();
    }
  },
}));

// ── SETTINGS → PLAN 동기화 (subscribe) ─────────────
let _subscribed = false;

if (!_subscribed) {
  _subscribed = true;

  useSettingsStore.subscribe((state, prev) => {
    if (_isResetting) return;

    if (
      state.plan === prev.plan &&
      state.monthlyUsedMinutes === prev.monthlyUsedMinutes &&
      state.monthlyResetAt === prev.monthlyResetAt
    ) return;

    const devPlan = _DevConfig?.getDevPlan();

    const effectivePlan =
      (__DEV__ && _DevConfig?.isDevMode() && devPlan)
        ? devPlan as PlanTier
        : state.plan as PlanTier;

    const current = usePlanStore.getState();

    usePlanStore.setState({
      ...(effectivePlan !== current.tier && {
        tier: effectivePlan,
        limits: PLAN_LIMITS[effectivePlan],
      }),
      ...(state.monthlyUsedMinutes !== current.usedMinutes && {
        usedMinutes: state.monthlyUsedMinutes,
      }),
      ...(state.monthlyResetAt !== current.resetAt && {
        resetAt: state.monthlyResetAt,
      }),
    });
  });
}

// ── SELECTORS ───────────────────────────────────────
export const useCurrentPlan = () => usePlanStore(s => s.tier);
export const usePlanLimits  = () => usePlanStore(s => s.limits);
export const useCanProcess  = () => usePlanStore(s => s.canProcess);

// ── DEV override hook ──────────────────────────────
export function useEffectiveUsedMinutes(): number {
  const real = usePlanStore(s => s.usedMinutes);
  const [devOverride, setDevOverride] = useState<number | null>(null);

  useEffect(() => {
    if (!__DEV__) return;

    if (_DevConfig) {
      setDevOverride(
        _DevConfig.isDevMode()
          ? _DevConfig.getDevUsageMinutes()
          : null
      );
    }

    let unsub: (() => void) | undefined;

    import('../utils/devConfig')
      .then(m => {
        _DevConfig = m.DevConfig;

        setDevOverride(
          m.DevConfig.isDevMode()
            ? m.DevConfig.getDevUsageMinutes()
            : null
        );

        unsub = m.DevConfig.subscribe(() => {
          setDevOverride(
            m.DevConfig.isDevMode()
              ? m.DevConfig.getDevUsageMinutes()
              : null
          );
        });
      })
      .catch(() => {});

    return () => { unsub?.(); };

  }, []);

  return (__DEV__ && devOverride !== null) ? devOverride : real;
}