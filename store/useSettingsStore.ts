import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Localization from "expo-localization";
import * as SecureStore from 'expo-secure-store';

export type SubtitleStyleType = "outline" | "pill" | "bar";

export interface Settings {
  whisperModel: "tiny" | "small" | "medium" | "large-v3";
  sourceLanguage: string;
  targetLanguage: string;
  chunkDuration: 1 | 2 | 3;
  subtitleFontSize: number;
  subtitleColor: string;
  subtitleOpacity: number;
  showOriginal: boolean;
  subtitleMode: "original" | "translation" | "both";
  timingOffset: number;
  /** Fraction of container height from the top (0 = top, 1 = bottom). Default 0.85 = near bottom. */
  subtitlePositionPct: number;
  /** Pause between translation batches to prevent device overheating. */
  thermalProtection: boolean;
  /** Visual style of the subtitle overlay. */
  subtitleStyle: SubtitleStyleType;
  /** UI display language code, e.g. "ko", "en", "ja". */
  interfaceLanguage: string;
  plan: 'free' | 'lite' | 'standard' | 'pro';
  planExpiresAt: number | null;
  monthlyUsedMinutes: number;
  monthlyResetAt: number | null;
  /** Timestamp (ms) of last successful RevenueCat server verification.
   *  MUST be updated by the caller (syncPlanFromCustomerInfo) alongside
   *  plan/planExpiresAt on every successful CustomerInfo fetch.
   *  Example: update({ plan: 'pro', planExpiresAt: expiry, lastVerifiedAt: Date.now() })
   *  Downstream logic should treat plan as stale if now - lastVerifiedAt > threshold.
   */
  lastVerifiedAt: number | null;
}

interface SettingsStore extends Settings {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  update: (partial: Partial<Settings>) => void;
}

const SUPPORTED_LANGS = [
  "ko","en","ja","zh","fr","de","es","it","pt","ru","ar","hi","th","vi","id",
];

const deviceLang = Localization.getLocales?.()[0]?.languageCode ?? "en";
const defaultInterfaceLang = SUPPORTED_LANGS.includes(deviceLang) ? deviceLang : "en";

const DEFAULTS: Settings = {
  whisperModel: "small",
  sourceLanguage: "auto",
  targetLanguage: "ko",
  chunkDuration: 2,
  subtitleFontSize: 14,
  subtitleColor: "#FFFFFF",
  subtitleOpacity: 0.9,
  showOriginal: true,
  subtitleMode: "translation",
  timingOffset: 0,
  subtitlePositionPct: 0.85,
  thermalProtection: true,
  subtitleStyle: "pill",  // 기본값: 갈매기형
  interfaceLanguage: defaultInterfaceLang,
  plan: 'free',
  planExpiresAt: null,
  monthlyUsedMinutes: 0,
  monthlyResetAt: null,
  lastVerifiedAt: null,
};

const STORAGE_KEY = "realtimesub_settings";

// ── Secure storage — plan fields only ────────────────────────────────────────
// plan, planExpiresAt, lastVerifiedAt are stored ONLY in SecureStore (encrypted).
// They are NEVER written to AsyncStorage — this is intentional and must not change.
// monthlyUsedMinutes and monthlyResetAt remain in AsyncStorage (usage cache only).
//
// Security posture: protects against low-effort attacks (direct AsyncStorage
// read/write, adb backup). Does NOT protect against runtime patching (Frida etc.)
// or JS bundle modification. Server-side revalidation via RevenueCat remains the
// true security boundary — lastVerifiedAt enables staleness detection for that purpose.
const SECURE_PLAN_KEY = 'secure_plan_info';

interface SecurePlanData {
  plan: Settings['plan'];
  planExpiresAt: number | null;
  lastVerifiedAt: number | null;
}

async function loadSecurePlan(): Promise<SecurePlanData | null> {
  try {
    const raw = await SecureStore.getItemAsync(SECURE_PLAN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SecurePlanData;
  } catch {
    return null;
  }
}

async function saveSecurePlan(data: SecurePlanData): Promise<void> {
  try {
    await SecureStore.setItemAsync(SECURE_PLAN_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[SecurePlan] saveSecurePlan failed (non-fatal):', e);
  }
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {};

      // Load plan fields from SecureStore — SecureStore is authoritative.
      // Fall back to AsyncStorage values for first-run migration only
      // (existing installs that have not yet written to SecureStore).
      const securePlan = await loadSecurePlan();

      // One-time migration: if SecureStore is empty but AsyncStorage has plan data,
      // write it to SecureStore now so all subsequent reads use SecureStore only.
      // Condition uses 'in' operator — checks KEY EXISTENCE, not value truthiness.
      // This is intentional: plan: 'free' is valid and must also be migrated.
      if (securePlan === null && 'plan' in saved) {
        saveSecurePlan({
          plan:           saved.plan!,
          planExpiresAt:  'planExpiresAt' in saved ? (saved.planExpiresAt ?? null) : null,
          lastVerifiedAt: null,
        });
      }

      set({
        ...DEFAULTS,
        ...saved,
        // SecureStore is authoritative — fallback to AsyncStorage only for migration
        plan:           securePlan?.plan           ?? saved.plan           ?? DEFAULTS.plan,
        planExpiresAt:  securePlan?.planExpiresAt  ?? saved.planExpiresAt  ?? DEFAULTS.planExpiresAt,
        lastVerifiedAt: securePlan?.lastVerifiedAt ?? null,
        timingOffset: 0,
        hydrated: true,
      });
    } catch {
      // On any error: apply safe defaults and mark hydrated so the app
      // does not block on a failed storage read.
      set({ ...DEFAULTS, hydrated: true });
    }
  },

  update: (partial) => {
    set(partial);
    const current = get();

    // Persist plan fields to SecureStore whenever any plan field changes.
    // Uses 'in' operator (not ??) to correctly handle explicit null assignments
    // e.g. update({ planExpiresAt: null }) for lifetime purchases must write null,
    // not be silently skipped.
    // Partial values take priority over current state to avoid race conditions
    // when update() is called multiple times in rapid succession (e.g. purchase flow).
    if (
      'plan' in partial ||
      'planExpiresAt' in partial ||
      'lastVerifiedAt' in partial
    ) {
      saveSecurePlan({
        plan:           'plan'           in partial ? partial.plan!                  : current.plan,
        planExpiresAt:  'planExpiresAt'  in partial ? (partial.planExpiresAt  ?? null) : current.planExpiresAt,
        lastVerifiedAt: 'lastVerifiedAt' in partial ? (partial.lastVerifiedAt ?? null) : current.lastVerifiedAt,
      });
    }

    // AsyncStorage stores NON-plan settings only.
    // plan, planExpiresAt, lastVerifiedAt are intentionally EXCLUDED —
    // they live in SecureStore only. Do NOT add them back here.
    const toSave = {
      whisperModel:        current.whisperModel,
      sourceLanguage:      current.sourceLanguage,
      targetLanguage:      current.targetLanguage,
      chunkDuration:       current.chunkDuration,
      subtitleFontSize:    current.subtitleFontSize,
      subtitleColor:       current.subtitleColor,
      subtitleOpacity:     current.subtitleOpacity,
      showOriginal:        current.showOriginal,
      subtitleMode:        current.subtitleMode,
      timingOffset:        current.timingOffset,
      subtitlePositionPct: current.subtitlePositionPct,
      thermalProtection:   current.thermalProtection,
      subtitleStyle:       current.subtitleStyle,
      interfaceLanguage:   current.interfaceLanguage,
      monthlyUsedMinutes:  current.monthlyUsedMinutes,
      monthlyResetAt:      current.monthlyResetAt,
      // plan, planExpiresAt, lastVerifiedAt intentionally NOT included
    };

    // Strip plan fields from partial before spreading into AsyncStorage write.
    // Prevents plan data from leaking back into AsyncStorage even if partial
    // contains them (e.g. during purchase flow).
    const { plan: _p, planExpiresAt: _pe, lastVerifiedAt: _lv, ...safePartial } = partial as any;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...toSave, ...safePartial }));
  },
}));
