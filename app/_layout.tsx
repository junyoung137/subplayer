import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSettingsStore } from "../store/useSettingsStore";

export default function RootLayout() {
  const hydrate = useSettingsStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
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
        <Stack.Screen name="index" options={{ title: "RealtimeSub" }} />
        <Stack.Screen name="processing" options={{ title: "처리 중", headerShown: false }} />
        <Stack.Screen name="player" options={{ title: "플레이어", headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: "설정" }} />
        <Stack.Screen name="models" options={{ title: "모델 관리" }} />
        <Stack.Screen name="gemmaModels" options={{ title: "Gemma 모델 관리" }} />
        <Stack.Screen name="youtube-player" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}
