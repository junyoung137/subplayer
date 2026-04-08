import { Language } from "./languages";

export interface LanguageProfile {
  code: string;
  isLatinScript: boolean;
  systemPromptRules: string[];
  cleanupTranslation: (text: string) => string;
  isValidTranslation: (text: string) => boolean;
  trailingPunctuationToStrip: RegExp;
}

const STRIP_SINGLE_PERIOD = /(?<!\.)\.$/;

export const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  ko: { code: "ko", isLatinScript: false, systemPromptRules: ["Use 존댓말 (formal -요/-습니다) for workplace, interview, or formal scenes. Use 반말 only when speakers are clearly close friends, family, or romantic partners.", "Only translate 'baby' as '자기야' when it is clearly a romantic term of endearment directed at a partner. Do NOT use '자기야' for infants, general exclamations, or non-romantic address.", "Never insert '자기야' unless the exact word 'baby' appears explicitly as a direct address in that segment — never trigger '자기야' from pronouns like 'me', 'I', 'you', 'my', or any word other than 'baby'."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[가-힣]/.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  ja: { code: "ja", isLatinScript: false, systemPromptRules: ["Use です/ます form for formal scenes, plain form for casual speech.", "Transliterate foreign proper nouns into natural katakana."], cleanupTranslation: (text) => text.replace(/。$/, "").trim(), isValidTranslation: (text) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(text), trailingPunctuationToStrip: /。$/ },
  zh: { code: "zh", isLatinScript: false, systemPromptRules: ["Use Simplified Chinese characters.", "Use natural Mandarin spoken style for subtitles."], cleanupTranslation: (text) => text.replace(/。$/, "").trim(), isValidTranslation: (text) => /[\u4e00-\u9fff]/.test(text), trailingPunctuationToStrip: /。$/ },
  es: { code: "es", isLatinScript: true, systemPromptRules: ["Use 'tú' for casual/friendly speech and 'usted' for formal/workplace speech.", "Include inverted punctuation (¿¡) at sentence start where appropriate."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[a-záéíóúüñ]/i.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  fr: { code: "fr", isLatinScript: true, systemPromptRules: ["Use 'tu' for casual speech and 'vous' for formal/workplace speech.", "Use natural spoken French contractions in casual dialogue."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[a-zàâçéèêëîïôûùüæœ]/i.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  de: { code: "de", isLatinScript: true, systemPromptRules: ["Use 'du' for casual speech and 'Sie' for formal/workplace speech.", "Capitalize all nouns as required by German grammar."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[a-zäöüß]/i.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  it: { code: "it", isLatinScript: true, systemPromptRules: ["Use 'tu' for casual speech and 'Lei' for formal/workplace speech."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[a-zàèéìíîòóùú]/i.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  pt: { code: "pt", isLatinScript: true, systemPromptRules: ["Use Brazilian Portuguese (pt-BR) style as default.", "Use 'você' for both formal and informal unless context is clearly intimate."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[a-zàáâãçéêíóôõú]/i.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  ru: { code: "ru", isLatinScript: false, systemPromptRules: ["Use 'ты' for casual speech and 'вы' for formal/workplace speech."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[а-яёА-ЯЁ]/.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  ar: { code: "ar", isLatinScript: false, systemPromptRules: ["Use Modern Standard Arabic (MSA) for formal scenes.", "Text direction is RTL — do not insert LTR markers."], cleanupTranslation: (text) => text.replace(/[.。]$/, "").trim(), isValidTranslation: (text) => /[\u0600-\u06ff]/.test(text), trailingPunctuationToStrip: /[.。]$/ },
  hi: { code: "hi", isLatinScript: false, systemPromptRules: ["Use 'आप' for formal speech and 'तुम/तू' for casual speech."], cleanupTranslation: (text) => text.replace(/[.।]$/, "").trim(), isValidTranslation: (text) => /[\u0900-\u097f]/.test(text), trailingPunctuationToStrip: /[.।]$/ },
  th: { code: "th", isLatinScript: false, systemPromptRules: ["Use ครับ/ค่ะ particles appropriately for formal speech."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[\u0e00-\u0e7f]/.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  vi: { code: "vi", isLatinScript: true, systemPromptRules: ["Use appropriate pronouns based on social context (anh/chị/em/bạn)."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[àáâãèéêìíòóôõùúýăđơư]/i.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  id: { code: "id", isLatinScript: true, systemPromptRules: ["Use 'Anda' for formal speech and 'kamu' for casual speech."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[a-z]/i.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
  en: { code: "en", isLatinScript: true, systemPromptRules: ["Preserve natural English spoken style."], cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(), isValidTranslation: (text) => /[a-z]/i.test(text), trailingPunctuationToStrip: STRIP_SINGLE_PERIOD },
};

export const DEFAULT_PROFILE: LanguageProfile = {
  code: "default",
  isLatinScript: false,
  systemPromptRules: [],
  cleanupTranslation: (text) => text.replace(STRIP_SINGLE_PERIOD, "").trim(),
  isValidTranslation: (text) => text.trim().length > 0,
  trailingPunctuationToStrip: STRIP_SINGLE_PERIOD,
};

export function getLanguageProfile(targetLanguage: string): LanguageProfile {
  const key = targetLanguage.toLowerCase();
  const nameMap: Record<string, string> = {
    korean: "ko", japanese: "ja", chinese: "zh",
    spanish: "es", french: "fr", german: "de",
    italian: "it", portuguese: "pt", russian: "ru",
    arabic: "ar", hindi: "hi", thai: "th",
    vietnamese: "vi", indonesian: "id", english: "en",
  };
  const code = nameMap[key] ?? key;
  return LANGUAGE_PROFILES[code] ?? DEFAULT_PROFILE;
}
