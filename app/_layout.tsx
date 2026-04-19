import "../i18n";
import { useEffect } from "react";
import { AppRegistry } from "react-native";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { StatusBar } from "expo-status-bar";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAppLanguage } from "../i18n/useAppLanguage";
import { initDB, purgeExpiredCache } from "../services/subtitleDB";
// [FIX BUG1] Seed the proxy URL into AsyncStorage at FG startup so the
// HeadlessJS BG task context (where __DEV__ is always false) can read the
// correct dev-server URL via getProxyBaseUrl().
import { setProxyBaseUrl, PROXY_BASE_URL_DEFAULT } from "../services/youtubeTimedText";

export default function RootLayout() {
  const { t } = useTranslation();
  const hydrate = useSettingsStore((s) => s.hydrate);
  useAppLanguage();

  useEffect(() => {
    hydrate();

    // [FIX BUG1] Persist resolved proxy URL for BG (HeadlessJS) context.
    setProxyBaseUrl(PROXY_BASE_URL_DEFAULT);

    // ✅ DB 초기화 + 만료 캐시 정리 (앱 시작 시 1회)
    initDB()
      .then(() => purgeExpiredCache())
      .catch((e) => console.error("[DB] 초기화 실패:", e));

    // Fix 2: Register HeadlessJS task with isHeadlessContext=true so that
    // backgroundTranslationTask disables the AppState 'background' guard that
    // is only relevant in the foreground UI context.
    AppRegistry.registerHeadlessTask('BackgroundTranslation', () => async (taskData: any) => {
      const { backgroundTranslationTask } = await import('../services/backgroundTranslationTask');
      await backgroundTranslationTask({ ...taskData, isHeadlessContext: true });
    });
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#0a0a0a" },
          headerTintColor: "#fff",
          headerTitleStyle: { fontWeight: "bold" },
          contentStyle: { backgroundColor: "#0a0a0a" },
        }}
      >
        <Stack.Screen name="index"        options={{ title: "RealtimeSub" }} />
        <Stack.Screen name="processing"   options={{ title: "처리 중",   headerShown: false }} />
        <Stack.Screen name="player"       options={{ title: "플레이어", headerShown: false }} />
        <Stack.Screen name="settings"     options={{ title: t("layout.settings") }} />
        <Stack.Screen name="models"       options={{ title: t("layout.models") }} />
        <Stack.Screen name="gemmaModels"  options={{ title: "Gemma 모델 관리" }} />
        <Stack.Screen name="youtube-player" options={{ headerShown: false }} />
        <Stack.Screen name="support"        options={{ title: "피드백", headerShown: false }} />
      </Stack>
    </>
  );
}