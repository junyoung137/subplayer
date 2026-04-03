import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { WHISPER_MODELS } from "../constants/whisperModels";
import { ModelDownloader } from "../components/ModelDownloader";
import { useSettingsStore } from "../store/useSettingsStore";
import { getModelMeta, deleteGemmaModel } from "../services/modelDownloadService";

export default function ModelsScreen() {
  const selectedModel = useSettingsStore((s) => s.whisperModel);
  const update        = useSettingsStore((s) => s.update);

  const [gemmaDownloaded, setGemmaDownloaded] = useState<boolean | null>(null);

  useEffect(() => {
    getModelMeta().then((meta) => setGemmaDownloaded(meta !== null));
  }, []);

  const handleGemmaDelete = () => {
    Alert.alert("모델 삭제", "Gemma 모델을 삭제할까요?", [
      { text: "취소", style: "cancel" },
      {
        text: "삭제",
        style: "destructive",
        onPress: async () => {
          await deleteGemmaModel();
          setGemmaDownloaded(false);
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── 음성 인식 ─────────────────────────────────────────────── */}
      <Text style={styles.sectionLabel}>음성 인식</Text>
      <View style={styles.card}>
        {WHISPER_MODELS.map((model) => (
          <ModelDownloader
            key={model.id}
            model={model}
            isSelected={selectedModel === model.id}
            onDownloaded={() => update({ whisperModel: model.id as any })}
            onSelect={() => update({ whisperModel: model.id as any })}
          />
        ))}
      </View>

      {/* ── Translation Model ──────────────────────────────────── */}
      <Text style={styles.sectionLabel}>번역 모델</Text>
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <Text style={styles.cardName}>버전: v1.0.0</Text>
          {gemmaDownloaded === null ? null : gemmaDownloaded ? (
            <TouchableOpacity style={styles.btnDelete} onPress={handleGemmaDelete}>
              <Text style={styles.btnDeleteText}>삭제</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.btnDownload}
              onPress={() => router.push("/gemmaModels")}
            >
              <Text style={styles.btnDownloadText}>다운로드</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content:   { padding: 16, gap: 8, paddingBottom: 40 },

  sectionLabel: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 8,
  },

  card: {
    backgroundColor: "#141414",
    borderRadius: 12,
    overflow: "hidden",
  },

  // Gemma row — matches ModelDownloader's container dimensions
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  cardName: { color: "#fff", fontSize: 15, fontWeight: "600" },

  btnDownload: {
    backgroundColor: "#2563eb",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnDownloadText: { color: "#fff", fontWeight: "600", fontSize: 13 },

  btnDelete: {
    borderWidth: 1,
    borderColor: "#ef4444",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnDeleteText: { color: "#ef4444", fontWeight: "600", fontSize: 13 },
});
