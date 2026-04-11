import { Language } from "./languages";

export interface LanguageProfile {
  code: string;
  isLatinScript: boolean;
  systemPromptRules: string[];
  cleanupTranslation: (text: string) => string;
  isValidTranslation: (text: string) => boolean;
  trailingPunctuationToStrip: RegExp;
}

// -----------------------------
// Common Utils (DRY)
// -----------------------------

const STRIP_SINGLE_PERIOD = /(?<!\.)\.$/;

// 기본 cleanup (라틴계 공통)
const defaultCleanup = (text: string) =>
  text.replace(STRIP_SINGLE_PERIOD, "").trim();

// 기존 유지
const createLatinValidator = (extraChars: string = "") => {
  const re = new RegExp(`[a-z0-9${extraChars}]`, "i");
  return (text: string) => re.test(text);
};

// -----------------------------
// 🔥 추가: 외국어 감지 (핵심)
// -----------------------------

const hasForeign = (text: string) =>
  /[a-zA-Z\u0400-\u04FF\u3040-\u30ff\u4e00-\u9fff]/.test(text);

// -----------------------------
// 기존 CJK validators (유지)
// -----------------------------

const hasKorean = (text: string) =>
  /[가-힣0-9]/.test(text) && text.trim().length > 1;

const hasJapanese = (text: string) =>
  /[\u3040-\u30ff\u4e00-\u9fff0-9]/.test(text);

const hasChinese = (text: string) =>
  /[\u4e00-\u9fff0-9]/.test(text);

// -----------------------------
// Language Profiles
// -----------------------------

export const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  ko: {
    code: "ko",
    isLatinScript: false,
    systemPromptRules: [
      "Use 존댓말 (-요/-습니다) for formal or workplace contexts.",
      "Use 반말 only when speakers are clearly close.",
      "Do not use romantic expressions unless explicitly required.",
    ],
    cleanupTranslation: (text) =>
      text.replace(STRIP_SINGLE_PERIOD, "").trim(),

    // 🔥 핵심 변경 (안전 버전)
    isValidTranslation: (text) =>
      hasKorean(text) && !hasForeign(text),

    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  ja: {
    code: "ja",
    isLatinScript: false,
    systemPromptRules: [
      "Use です/ます for formal scenes, plain form for casual speech.",
      "Transliterate foreign words into natural katakana.",
    ],
    cleanupTranslation: (text) =>
      text.replace(/[。？！]$/, "").trim(),

    isValidTranslation: (text) =>
      hasJapanese(text) && !/[a-zA-Z\u0400-\u04FF]/.test(text),

    trailingPunctuationToStrip: /[。？！]$/,
  },

  zh: {
    code: "zh",
    isLatinScript: false,
    systemPromptRules: [
      "Use Simplified Chinese.",
      "Use natural spoken Mandarin style.",
    ],
    cleanupTranslation: (text) =>
      text.replace(/[。？！]$/, "").trim(),

    isValidTranslation: (text) =>
      hasChinese(text) && !/[a-zA-Z\u0400-\u04FF]/.test(text),

    trailingPunctuationToStrip: /[。？！]$/,
  },

  es: {
    code: "es",
    isLatinScript: true,
    systemPromptRules: [
      "Use 'tú' for casual speech and 'usted' for formal contexts.",
      "Use inverted punctuation (¿ ¡) where appropriate.",
    ],
    cleanupTranslation: defaultCleanup,

    // 🔥 라틴계도 혼합 차단
    isValidTranslation: (text) =>
      createLatinValidator("áéíóúüñ")(text) &&
      !/[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(text),

    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  fr: {
    code: "fr",
    isLatinScript: true,
    systemPromptRules: [
      "Use 'tu' for casual speech and 'vous' for formal contexts.",
      "Use natural spoken contractions.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      createLatinValidator("àâçéèêëîïôûùüæœ")(text) &&
      !/[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  de: {
    code: "de",
    isLatinScript: true,
    systemPromptRules: [
      "Use 'du' for casual speech and 'Sie' for formal contexts.",
      "Capitalize nouns properly.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      createLatinValidator("äöüß")(text) &&
      !/[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  it: {
    code: "it",
    isLatinScript: true,
    systemPromptRules: [
      "Use 'tu' for casual speech and 'Lei' for formal contexts.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      createLatinValidator("àèéìíîòóùú")(text) &&
      !/[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  pt: {
    code: "pt",
    isLatinScript: true,
    systemPromptRules: [
      "Use Brazilian Portuguese (pt-BR).",
      "Use 'você' unless context requires otherwise.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      createLatinValidator("àáâãçéêíóôõú")(text) &&
      !/[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  ru: {
    code: "ru",
    isLatinScript: false,
    systemPromptRules: [
      "Use 'ты' for casual speech and 'вы' for formal contexts.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      /[а-яёА-ЯЁ0-9]/.test(text) &&
      !/[a-zA-Z가-힣\u3040-\u30ff\u4e00-\u9fff]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  ar: {
    code: "ar",
    isLatinScript: false,
    systemPromptRules: [
      "Use Modern Standard Arabic (MSA).",
      "Maintain RTL direction.",
    ],
    cleanupTranslation: (text) =>
      text.replace(/[.。]$/, "").trim(),
    isValidTranslation: (text) =>
      /[\u0600-\u06ff0-9]/.test(text) &&
      !/[a-zA-Z]/.test(text),
    trailingPunctuationToStrip: /[.。]$/,
  },

  hi: {
    code: "hi",
    isLatinScript: false,
    systemPromptRules: [
      "Use 'आप' for formal and 'तुम/तू' for casual speech.",
    ],
    cleanupTranslation: (text) =>
      text.replace(/[.।]$/, "").trim(),
    isValidTranslation: (text) =>
      /[\u0900-\u097f0-9]/.test(text) &&
      !/[a-zA-Z]/.test(text),
    trailingPunctuationToStrip: /[.।]$/,
  },

  th: {
    code: "th",
    isLatinScript: false,
    systemPromptRules: [
      "Use ครับ/ค่ะ appropriately.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      /[\u0e00-\u0e7f0-9]/.test(text) &&
      !/[a-zA-Z]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  vi: {
    code: "vi",
    isLatinScript: true,
    systemPromptRules: [
      "Use appropriate pronouns based on context.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      createLatinValidator("àáâãèéêìíòóôõùúýăđơư")(text) &&
      !/[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  id: {
    code: "id",
    isLatinScript: true,
    systemPromptRules: [
      "Use 'Anda' for formal and 'kamu' for casual speech.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      createLatinValidator()(text) &&
      !/[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },

  en: {
    code: "en",
    isLatinScript: true,
    systemPromptRules: [
      "Preserve natural spoken English style.",
    ],
    cleanupTranslation: defaultCleanup,
    isValidTranslation: (text) =>
      createLatinValidator()(text) &&
      !/[가-힣\u4e00-\u9fff\u3040-\u30ff\u0400-\u04FF]/.test(text),
    trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
  },
};

// -----------------------------
// Default Profile
// -----------------------------

export const DEFAULT_PROFILE: LanguageProfile = {
  code: "default",
  isLatinScript: false,
  systemPromptRules: [],
  cleanupTranslation: defaultCleanup,
  isValidTranslation: (text) => text.length > 0,
  trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
};

// -----------------------------
// Language Mapping
// -----------------------------

const LANGUAGE_NAME_MAP: Record<string, string> = {
  korean: "ko",
  japanese: "ja",
  chinese: "zh",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  russian: "ru",
  arabic: "ar",
  hindi: "hi",
  thai: "th",
  vietnamese: "vi",
  indonesian: "id",
  english: "en",
};

export function getLanguageProfile(targetLanguage: string): LanguageProfile {
  const key = targetLanguage.toLowerCase();
  const code = LANGUAGE_NAME_MAP[key] ?? key;
  return LANGUAGE_PROFILES[code] ?? DEFAULT_PROFILE;
}