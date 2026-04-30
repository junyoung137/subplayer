/**
 * usePlanStore.ts
 * Plan state, usage cap enforcement, monthly reset.
 * recordUsage() → called ONLY via safeRecordUsage() (RULE 10).
 * Direct recordUsage() in server paths is BANNED.
 */

import { useState, useEffect } from 'react';
import { create } from 'zustand';
import { useSettingsStore } from './useSettingsStore';
import i18n from '../i18n';

// ── [DEV MODE] Dynamic imports — tree-shaken in production ────────────────────
let _DevConfig: typeof import('../utils/devConfig').DevConfig | null = null;
if (__DEV__) {
  import('../utils/devConfig').then(m => { _DevConfig = m.DevConfig; }).catch(() => {});
}

export type PlanTier = 'free' | 'standard' | 'pro';

export interface PlanLimits {
  dailyCapMinutes: number;
  monthlyCapMinutes: number;
  useServerGpu: boolean;
  maxConcurrentJobs: number;
}

const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free:     { dailyCapMinutes: 20,   monthlyCapMinutes: 0,    useServerGpu: false, maxConcurrentJobs: 1 },
  standard: { dailyCapMinutes: 0,    monthlyCapMinutes: 1200, useServerGpu: true,  maxConcurrentJobs: 1 },
  pro:      { dailyCapMinutes: 0,    monthlyCapMinutes: 2400, useServerGpu: true,  maxConcurrentJobs: 1 },
};

interface PlanStore {
  tier: PlanTier;
  limits: PlanLimits;
  usedMinutes: number;
  resetAt: number | null;

  syncFromSettings: () => void;
  canProcess: (estimatedMinutes?: number) => { allowed: boolean; reason?: string };
  recordUsage: (seconds: number) => void; // ONLY called via safeRecordUsage
  resetMonthlyUsage: () => void;
}

export const usePlanStore = create<PlanStore>((set, get) => ({
  tier: 'free',
  limits: PLAN_LIMITS['free'],
  usedMinutes: 0,
  resetAt: null,

  syncFromSettings: () => {
    const s = useSettingsStore.getState();
    // [DEV 4b] Inject plan override when dev mode is active
    const effectivePlan = (__DEV__ && _DevConfig?.isDevMode() && _DevConfig.getDevPlan())
      ? _DevConfig.getDevPlan()! as PlanTier
      : s.plan as PlanTier;
    set({ tier: effectivePlan, limits: PLAN_LIMITS[effectivePlan], usedMinutes: s.monthlyUsedMinutes, resetAt: s.monthlyResetAt });
  },

  canProcess: (estimatedMinutes = 1) => {
    const { tier, limits, usedMinutes, resetAt } = get();
    const s = useSettingsStore.getState();

    // [DEV 4c] Apply dev overrides when dev mode is active
    let effectiveUsedMinutes = usedMinutes;
    let effectiveResetAt = resetAt;
    let effectiveExpiresAt = s.planExpiresAt;
    if (__DEV__ && _DevConfig?.isDevMode()) {
      const devUsage   = _DevConfig.getDevUsageMinutes();
      const devReset   = _DevConfig.getDevResetAt();
      const devExpires = _DevConfig.getDevExpiresAt();
      if (devUsage   !== null) effectiveUsedMinutes = devUsage;
      if (devReset   !== null) effectiveResetAt     = devReset;
      if (devExpires !== null) effectiveExpiresAt   = devExpires;
    }

    if (effectiveResetAt && Date.now() > effectiveResetAt) get().resetMonthlyUsage();

    if (tier !== 'free' && effectiveExpiresAt && Date.now() > effectiveExpiresAt) {
      return { allowed: false, reason: i18n.t('plan.subscriptionExpired') };
    }

    if (tier === 'free') {
      if (effectiveUsedMinutes + estimatedMinutes > limits.dailyCapMinutes) {
        return { allowed: false, reason: i18n.t('plan.freeDailyLimitReached', { cap: limits.dailyCapMinutes }) };
      }
    } else {
      if (limits.monthlyCapMinutes > 0 && effectiveUsedMinutes + estimatedMinutes > limits.monthlyCapMinutes) {
        return { allowed: false, reason: i18n.t('plan.monthlyLimitReached', { hours: limits.monthlyCapMinutes / 60 }) };
      }
    }
    return { allowed: true };
  },

  recordUsage: (seconds: number) => {
    const newUsed = get().usedMinutes + seconds / 60;
    set({ usedMinutes: newUsed });
    useSettingsStore.getState().update({ monthlyUsedMinutes: newUsed });
  },

  resetMonthlyUsage: () => {
    const nextResetAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    set({ usedMinutes: 0, resetAt: nextResetAt });
    useSettingsStore.getState().update({ monthlyUsedMinutes: 0, monthlyResetAt: nextResetAt });
  },
}));

export const useCurrentPlan = () => usePlanStore((s) => s.tier);
export const usePlanLimits  = () => usePlanStore((s) => s.limits);
export const useCanProcess  = () => usePlanStore((s) => s.canProcess);

/**
 * useEffectiveUsedMinutes
 * Returns dev-overridden usedMinutes in __DEV__ + dev mode, real value otherwise.
 *
 * HOOKS RULES COMPLIANT: useState and useEffect are the first calls in the
 * function body — no conditional returns before them.
 */
export function useEffectiveUsedMinutes(): number {
  const real = usePlanStore((s) => s.usedMinutes);

  // Hooks always called unconditionally — never after any conditional return ──
  const [devOverride, setDevOverride] = useState<number | null>(null);

  useEffect(() => {
    // In production __DEV__ is false — this block is dead code / tree-shaken
    if (!__DEV__) return;

    // Read current cached value immediately (DevConfig already hydrated at app start)
    if (_DevConfig) {
      setDevOverride(_DevConfig.isDevMode() ? _DevConfig.getDevUsageMinutes() : null);
    }

    let unsub: (() => void) | undefined;
    import('../utils/devConfig').then(m => {
      _DevConfig = m.DevConfig;
      // Sync in case hydration completed between render and effect
      setDevOverride(m.DevConfig.isDevMode() ? m.DevConfig.getDevUsageMinutes() : null);
      // Zero-argument callback — matches DevConfig.subscribe() signature
      unsub = m.DevConfig.subscribe(() => {
        setDevOverride(m.DevConfig.isDevMode() ? m.DevConfig.getDevUsageMinutes() : null);
      });
    }).catch(() => {});

    return () => { unsub?.(); };
  }, []);
  // ─────────────────────────────────────────────────────────────────────────

  // Production: devOverride is always null (effect is dead code)
  // Dev: devOverride reflects the simulated value when dev mode is active
  return (__DEV__ && devOverride !== null) ? devOverride : real;
}
