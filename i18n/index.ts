import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import * as Localization from "expo-localization";

import ko from "./translations/ko";
import en from "./translations/en";
import ja from "./translations/ja";
import zh from "./translations/zh";
import fr from "./translations/fr";
import de from "./translations/de";
import es from "./translations/es";
import it from "./translations/it";
import pt from "./translations/pt";
import ru from "./translations/ru";
import ar from "./translations/ar";
import hi from "./translations/hi";
import th from "./translations/th";
import vi from "./translations/vi";
import id from "./translations/id";

const SUPPORTED_LANGS = [
  "ko","en","ja","zh","fr","de","es","it","pt","ru","ar","hi","th","vi","id",
];
const rawLocale = Localization.getLocales?.()[0]?.languageCode ?? "en";
const deviceLocale = SUPPORTED_LANGS.includes(rawLocale) ? rawLocale : "en";

i18n
  .use(initReactI18next)
  .init({
    resources: {
      ko: { translation: ko },
      en: { translation: en },
      ja: { translation: ja },
      zh: { translation: zh },
      fr: { translation: fr },
      de: { translation: de },
      es: { translation: es },
      it: { translation: it },
      pt: { translation: pt },
      ru: { translation: ru },
      ar: { translation: ar },
      hi: { translation: hi },
      th: { translation: th },
      vi: { translation: vi },
      id: { translation: id },
    },
    lng: deviceLocale,
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
    initImmediate: false,
  } as any);

export default i18n;
