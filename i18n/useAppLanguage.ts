import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../store/useSettingsStore";

/**
 * Syncs the Zustand interfaceLanguage setting to i18next.
 * Call this hook once near the root of the app (e.g. app/_layout.tsx).
 */
export function useAppLanguage() {
  const { i18n } = useTranslation();
  const interfaceLanguage = useSettingsStore((s) => s.interfaceLanguage);

  useEffect(() => {
    if (interfaceLanguage && i18n.language !== interfaceLanguage) {
      i18n.changeLanguage(interfaceLanguage);
    }
  }, [interfaceLanguage]);
}
