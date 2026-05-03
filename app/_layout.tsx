import "../i18n";
import { useEffect } from "react";
import { usePurchaseStore } from "../store/usePurchaseStore";
import { REVENUECAT_ANDROID_API_KEY } from "../utils/revenueCatConfig";
import Purchases from "react-native-purchases";
import { AppRegistry, Text, View, Image } from "react-native";
import SplashAnimScreen from "./splash";
import { Stack, router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StatusBar } from "expo-status-bar";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAppLanguage } from "../i18n/useAppLanguage";
import { initDB, purgeExpiredCache } from "../services/subtitleDB";
// [FIX BUG1] Seed the proxy URL into AsyncStorage at FG startup so the
// HeadlessJS BG task context (where __DEV__ is always false) can read the
// correct dev-server URL via getProxyBaseUrl().
import { setProxyBaseUrl, PROXY_BASE_URL_DEFAULT } from "../services/youtubeTimedText";
import { onAuthStateChanged } from "../services/authService";
import { firestore } from "../services/firebase";
import { useAuthStore } from "../store/useAuthStore";
import { usePlanStore } from '../store/usePlanStore';
import { hydrateUsageDedup, ensureUsageDedupHydrated, purgeExpiredCheckpoints } from '../services/serverBridgeService';

export default function RootLayout() {
  const { t } = useTranslation();
  const hydrate = useSettingsStore((s) => s.hydrate);
  useAppLanguage();

  const setUser    = useAuthStore((s) => s.setUser);
  const setIsPro   = useAuthStore((s) => s.setIsPro);
  const setLoading = useAuthStore((s) => s.setLoading);
  const isLoading  = useAuthStore((s) => s.isLoading);

  useEffect(() => {
    ensureUsageDedupHydrated().catch(() => {});
    purgeExpiredCheckpoints().catch(() => {});
    hydrate().then(() => {
      // Warming order — do not reorder:
      // 1. hydrateUsageDedup: restore dedup Map from disk (fire-and-forget).
      //    safeRecordUsage joins the in-progress Promise if called before completion (RULE 12).
      // 2. syncFromSettings: load plan tier/usedMinutes/resetAt into usePlanStore.
      //    Must run after hydrate() (AsyncStorage order guarantee).
      // 3. [DEV] DevConfig.hydrate(): restore dev overrides (no-op in production).
      hydrateUsageDedup().catch(() => {});
      usePlanStore.getState().syncFromSettings();
      if (__DEV__) {
        import('../utils/devConfig').then(m => m.DevConfig.hydrate()).catch(() => {});
      }
    });

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

    // RevenueCat initialization
    (async () => {
      try {
        const purchaseStore = usePurchaseStore.getState();

        // Await configure so offerings are ready before getCustomerInfo runs.
        // configure() internally calls fetchOfferings(true) before setting
        // isConfigured:true — so PricingScreen poll won't fire prematurely.
        await purchaseStore.configure(REVENUECAT_ANDROID_API_KEY);

        // Revalidate plan if lastVerifiedAt is stale (> 6h) or null (new install).
        // Replaces the previous unconditional getCustomerInfo() call —
        // revalidatePlanIfStale() fetches only when needed, avoiding duplicate API calls.
        purchaseStore.revalidatePlanIfStale().catch(() => {});
      } catch (e) {
        // configure() can throw if the API key is invalid or the native module
        // is not linked. Log clearly so the cause is immediately visible.
        console.error('[RevenueCat] configure() failed:', e instanceof Error ? e.message : String(e));
        // Do NOT rethrow — app must remain functional for free-tier users
        // even if RevenueCat initialization fails.
      }
    })();

    // Auth state listener
    const unsubscribe = onAuthStateChanged(async (user) => {
      if (!user) {
        setUser(null);
        setIsPro(false);
        setLoading(false);
        router.replace("/login");
        return;
      }

      setUser(user);

      try {
        const doc = await firestore().collection("users").doc(user.uid).get();
        const isPro = (doc.data()?.isPro as boolean) ?? false;
        setIsPro(isPro);
      } catch {
        setIsPro(false);
      }

      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  if (isLoading) {
    return <SplashAnimScreen />;
  }

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
        <Stack.Screen
          name="index"
          options={{
            headerTitle: () => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                <Text style={{ fontSize: 20, fontWeight: "700", color: "#fff" }}>
                  Realtime<Text style={{ color: "#60a5fa" }}>Sub</Text>
                </Text>
                <Image
                  source={require("../assets/header_icon.png")}
                  style={{ width: 36, height: 36, borderRadius: 8 }}
                  resizeMode="contain"
                />
              </View>
            ),
          }}
        />
        <Stack.Screen name="processing"   options={{ title: "처리 중",   headerShown: false }} />
        <Stack.Screen name="player"       options={{ title: "플레이어", headerShown: false }} />
        <Stack.Screen name="settings"     options={{ title: t("layout.settings") }} />
        <Stack.Screen name="models"       options={{ title: t("layout.models") }} />
        <Stack.Screen name="gemmaModels"  options={{ title: "Gemma 모델 관리" }} />
        <Stack.Screen name="youtube-player" options={{ headerShown: false }} />
        <Stack.Screen name="support"        options={{ title: "피드백", headerShown: false }} />
        <Stack.Screen name="login"          options={{ headerShown: false }} />
        <Stack.Screen name="signup"         options={{ headerShown: false }} />
        <Stack.Screen name="pricing"        options={{ headerShown: false }} />
      </Stack>
    </>
  );
}