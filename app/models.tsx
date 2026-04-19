import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Switch,
} from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
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
  const selectedModel       = useSettingsStore((s) => s.whisperModel);
  const update              = useSettingsStore((s) => s.update);
  const thermalProtection   = useSettingsStore((s) => s.thermalProtection);
  const { t } = useTranslation();

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
    Alert.alert(t("models.deleteModel"), t("models.deleteModelMsg"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await deleteGemmaModel();
            const remaining = await getLocalModelPath();
            if (remaining) {
              Alert.alert(t("models.deleteFailed"), t("models.deleteFailedMsg"));
              return;
            }
            setGemmaPhase("idle_not_downloaded");
          } catch (e) {
            const msg = e instanceof Error ? e.message : t("common.unknownError");
            Alert.alert(t("models.deleteFailed"), msg);
          }
        },
      },
    ]);
  };

  const pct = gemmaProgress ? Math.round(gemmaProgress.fraction * 100) : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── 음성 인식 ─────────────────────────────────────────────── */}
      <Text style={styles.sectionLabel}>{t("models.speechRecognition")}</Text>
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
      <Text style={styles.sectionLabel}>{t("models.translationModel")}</Text>
      <View style={styles.card}>
        <View style={styles.cardRow}>
          {/* Top row: version/size info + action button */}
          <View style={styles.cardTopRow}>
            <View>
              <Text style={styles.cardName}>{t("models.version")}</Text>
              <Text style={styles.cardSub}>{t("models.size")}</Text>
            </View>

            {gemmaPhase === "idle_not_downloaded" && (
              <TouchableOpacity style={styles.btnDownload} onPress={handleGemmaDownload}>
                <Text style={styles.btnDownloadText}>{t("models.download")}</Text>
              </TouchableOpacity>
            )}

            {gemmaPhase === "downloading" && (
              <View style={styles.progressWrapper}>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${pct}%` as any }]} />
                </View>
                <Text style={styles.progressText}>{pct}%</Text>
                <TouchableOpacity onPress={handleGemmaCancel}>
                  <Text style={styles.cancelText}>{t("common.cancel")}</Text>
                </TouchableOpacity>
              </View>
            )}

            {gemmaPhase === "idle_downloaded" && (
              <TouchableOpacity style={styles.btnDelete} onPress={handleGemmaDelete}>
                <Text style={styles.btnDeleteText}>{t("common.delete")}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Bottom row: thermal protection toggle */}
          <View style={styles.cardBottomRow}>
            <Text style={styles.rowLabel}>{t("models.thermalProtection")}</Text>
            <Switch
              value={thermalProtection}
              onValueChange={(v) => update({ thermalProtection: v })}
              trackColor={{ true: "#2563eb" }}
            />
          </View>
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
    flexDirection: "column",
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardBottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardName: { color: "#fff", fontSize: 15, fontWeight: "600" },
  cardSub:  { color: "#666", fontSize: 12, marginTop: 2 },
  rowLabel: { color: "#ccc", fontSize: 14 },

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
