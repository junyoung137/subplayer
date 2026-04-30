import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Localization from "expo-localization";

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
  plan: 'free' | 'standard' | 'pro';
  planExpiresAt: number | null;
  monthlyUsedMinutes: number;
  monthlyResetAt: number | null;
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
};

const STORAGE_KEY = "realtimesub_settings";

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Settings>;
        set({ ...DEFAULTS, ...saved, timingOffset: 0, hydrated: true });
      } else {
        set({ hydrated: true });
      }
    } catch {
      set({ hydrated: true });
    }
  },

  update: (partial) => {
    set(partial);
    const current = get();
    const toSave: Settings = {
      whisperModel: current.whisperModel,
      sourceLanguage: current.sourceLanguage,
      targetLanguage: current.targetLanguage,
      chunkDuration: current.chunkDuration,
      subtitleFontSize: current.subtitleFontSize,
      subtitleColor: current.subtitleColor,
      subtitleOpacity: current.subtitleOpacity,
      showOriginal: current.showOriginal,
      subtitleMode: current.subtitleMode,
      timingOffset: current.timingOffset,
      subtitlePositionPct: current.subtitlePositionPct,
      thermalProtection: current.thermalProtection,
      subtitleStyle: current.subtitleStyle,
      interfaceLanguage: current.interfaceLanguage,
      plan: current.plan,
      planExpiresAt: current.planExpiresAt,
      monthlyUsedMinutes: current.monthlyUsedMinutes,
      monthlyResetAt: current.monthlyResetAt,
    };
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...toSave, ...partial }));
  },
}));