/**
 * devConfig.ts
 * Developer Test Mode configuration store.
 *
 * Triple production safety lock:
 *   1. All methods no-op when !__DEV__
 *   2. DevModePanel renders null in production
 *   3. AsyncStorage keys use __dev__ namespace
 *
 * Overrides injected at:
 *   - usePlanStore.syncFromSettings()  → planOverride
 *   - usePlanStore.canProcess()        → usageMinutesOverride, resetAtOverride, expiresAtOverride
 *   - loadServerBridgeConfig()         → endpointOverride, apiKeyOverride
 *   - safeRecordUsage()                → skip billing when devModeEnabled
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '__dev__config_v1';

export type DevPlanOverride = 'free' | 'lite' | 'standard' | 'pro' | null;

export interface DevConfigState {
  devModeEnabled: boolean;
  planOverride: DevPlanOverride;
  endpointOverride: string | null;
  apiKeyOverride: string | null;
  usageMinutesOverride: number | null;  // simulated usedMinutes
  resetAtOverride: number | null;       // simulated monthly reset timestamp
  expiresAtOverride: number | null;     // simulated planExpiresAt (past = expired)
}

const DEFAULT_STATE: DevConfigState = {
  devModeEnabled: false,
  planOverride: null,
  endpointOverride: null,
  apiKeyOverride: null,
  usageMinutesOverride: null,
  resetAtOverride: null,
  expiresAtOverride: null,
};

let _state: DevConfigState = { ...DEFAULT_STATE };
type Listener = (state: DevConfigState) => void;
const _listeners = new Set<Listener>();

function _notify(): void {
  const snap = { ..._state };
  _listeners.forEach(fn => fn(snap));
}

async function _persist(): Promise<void> {
  if (!__DEV__) return;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(_state));
  } catch {}
}

export const DevConfig = {
  async hydrate(): Promise<void> {
    if (!__DEV__) return;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        _state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
      }
    } catch {}
  },

  isDevMode(): boolean {
    return __DEV__ && _state.devModeEnabled;
  },

  getState(): Readonly<DevConfigState> {
    return { ..._state };
  },

  async set(patch: Partial<DevConfigState>): Promise<void> {
    if (!__DEV__) return;
    _state = { ..._state, ...patch };
    _notify();
    await _persist();
  },

  async reset(): Promise<void> {
    if (!__DEV__) return;
    _state = { ...DEFAULT_STATE };
    _notify();
    try { await AsyncStorage.removeItem(KEY); } catch {}
  },

  subscribe(fn: Listener): () => void {
    if (!__DEV__) return () => {};
    _listeners.add(fn);
    fn({ ..._state }); // emit current state immediately
    return () => _listeners.delete(fn);
  },

  // ── Getter aliases — called by DevModePanel and usePlanStore ─────────────────

  getDevPlan(): 'free' | 'lite' | 'standard' | 'pro' | null {
    if (!__DEV__) return null;
    return _state.planOverride ?? null;
  },

  getDevEndpoint(): string | null {
    if (!__DEV__) return null;
    return _state.endpointOverride ?? null;
  },

  getDevApiKey(): string | null {
    if (!__DEV__) return null;
    return _state.apiKeyOverride ?? null;
  },

  getDevUsageMinutes(): number | null {
    if (!__DEV__) return null;
    return _state.usageMinutesOverride ?? null;
  },

  getDevResetAt(): number | null {
    if (!__DEV__) return null;
    return _state.resetAtOverride ?? null;
  },

  getDevExpiresAt(): number | null {
    if (!__DEV__) return null;
    return _state.expiresAtOverride ?? null;
  },
};
