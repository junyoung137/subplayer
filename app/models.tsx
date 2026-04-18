import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from "react-native";
import { router } from "expo-router";
import * as FileSystem from "expo-file-system/legacy";
import { WHISPER_MODELS } from "../constants/whisperModels";
import { ModelDownloader } from "../components/ModelDownloader";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  downloadGemmaModel,
  deleteGemmaModel,
  getLocalModelPath,
  verifyModelIntegrity,
  DEST_PATH,
  type DownloadProgress,
} from "../services/modelDownloadService";

type GemmaPhase = "checking" | "idle_not_downloaded" | "idle_downloaded" | "downloading";

export default function ModelsScreen() {
  const selectedModel = useSettingsStore((s) => s.whisperModel);
  const update        = useSettingsStore((s) => s.update);

  const [gemmaPhase,    setGemmaPhase]    = useState<GemmaPhase>("checking");
  const [gemmaProgress, setGemmaProgress] = useState<DownloadProgress | null>(null);
  const cancelledRef      = useRef(false);
  const gemmaResumableRef = useRef<FileSystem.DownloadResumable | null>(null);

  useEffect(() => {
    verifyModelIntegrity().then((meta) =>
      setGemmaPhase(meta !== null ? "idle_downloaded" : "idle_not_downloaded")
    );
  }, []);

  const handleGemmaDownload = async () => {
    cancelledRef.current = false;
    gemmaResumableRef.current = null;
    setGemmaProgress(null);
    setGemmaPhase("downloading");

    try {
      await downloadGemmaModel(
        (p) => {
          if (cancelledRef.current) return;
          setGemmaProgress(p);
        },
        (resumable) => {
          gemmaResumableRef.current = resumable;
        },
      );
      if (cancelledRef.current) return;
      gemmaResumableRef.current = null;
      setGemmaPhase("idle_downloaded");
    } catch {
      if (cancelledRef.current) return;
      gemmaResumableRef.current = null;
      setGemmaPhase("idle_not_downloaded");
    }
  };

  const handleGemmaCancel = async () => {
    cancelledRef.current = true;
    if (gemmaResumableRef.current) {
      await gemmaResumableRef.current.pauseAsync();
      gemmaResumableRef.current = null;
    }
    await FileSystem.deleteAsync(DEST_PATH, { idempotent: true });
    setGemmaPhase("idle_not_downloaded");
    setGemmaProgress(null);
  };

  const handleGemmaDelete = () => {
    Alert.alert("모델 삭제", "번역 모델을 삭제할까요?", [
      { text: "취소", style: "cancel" },
      {
        text: "삭제",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteGemmaModel();
            const remaining = await getLocalModelPath();
            if (remaining) {
              Alert.alert("삭제 실패", "모델 파일을 삭제하지 못했습니다. 저장 공간을 확인해 주세요.");
              return;
            }
            setGemmaPhase("idle_not_downloaded");
          } catch (e) {
            const msg = e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
            Alert.alert("삭제 실패", msg);
          }
        },
      },
    ]);
  };

  const pct = gemmaProgress ? Math.round(gemmaProgress.fraction * 100) : 0;

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
          <View>
            <Text style={styles.cardName}>버전: v1.0</Text>
            <Text style={styles.cardSub}>~2.8 GB</Text>
          </View>

          {gemmaPhase === "idle_not_downloaded" && (
            <TouchableOpacity style={styles.btnDownload} onPress={handleGemmaDownload}>
              <Text style={styles.btnDownloadText}>다운로드</Text>
            </TouchableOpacity>
          )}

          {gemmaPhase === "downloading" && (
            <View style={styles.progressWrapper}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${pct}%` as any }]} />
              </View>
              <Text style={styles.progressText}>{pct}%</Text>
              <TouchableOpacity onPress={handleGemmaCancel}>
                <Text style={styles.cancelText}>취소</Text>
              </TouchableOpacity>
            </View>
          )}

          {gemmaPhase === "idle_downloaded" && (
            <TouchableOpacity style={styles.btnDelete} onPress={handleGemmaDelete}>
              <Text style={styles.btnDeleteText}>삭제</Text>
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
  cardSub:  { color: "#666", fontSize: 12, marginTop: 2 },

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

  progressWrapper: { alignItems: "center", gap: 4 },
  progressTrack: {
    width: 80,
    height: 4,
    backgroundColor: "#333",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#2563eb" },
  progressText: { color: "#aaa", fontSize: 11 },
  cancelText:   { color: "#ef4444", fontSize: 12 },
});
