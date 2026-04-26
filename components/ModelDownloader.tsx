import React, { useState, useEffect } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { useTranslation } from "react-i18next";
import { WhisperModel } from "../constants/whisperModels";

const MODEL_DIR = FileSystem.documentDirectory + "whisper-models/";

interface Props {
  model: WhisperModel;
  isSelected?: boolean;
  onDownloaded?: () => void;
  onSelect?: () => void;
}

type Status = "idle" | "downloading" | "downloaded" | "error";

export function ModelDownloader({ model, isSelected, onDownloaded, onSelect }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [downloadResumable, setDownloadResumable] =
    useState<FileSystem.DownloadResumable | null>(null);

    const modelPath = MODEL_DIR + (model.url.split("/").pop() ?? `ggml-${model.id}.bin`);

  useEffect(() => {
    checkExists();
  }, [model.id]);

  const checkExists = async () => {
    const info = await FileSystem.getInfoAsync(modelPath);
    if (info.exists) {
      setStatus("downloaded");
    } else {
      setStatus("idle");
    }
  };

  const startDownload = async () => {
    try {
      const dirInfo = await FileSystem.getInfoAsync(MODEL_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
      }

      setStatus("downloading");
      setProgress(0);

      const resumable = FileSystem.createDownloadResumable(
        model.url,
        modelPath,
        {},
        (downloadProgress) => {
          const pct =
            downloadProgress.totalBytesWritten /
            downloadProgress.totalBytesExpectedToWrite;
          setProgress(pct);
        }
      );

      setDownloadResumable(resumable);
      const result = await resumable.downloadAsync();

      if (result?.uri) {
        setStatus("downloaded");
        onDownloaded?.();
      } else {
        throw new Error("Download returned no URI");
      }
    } catch (e) {
      setStatus("error");
      console.error("[ModelDownloader] Error:", e);
    }
  };

  const cancelDownload = async () => {
    if (downloadResumable) {
      await downloadResumable.pauseAsync();
      setDownloadResumable(null);
    }
    setStatus("idle");
    setProgress(0);
  };

  const deleteModel = async () => {
    Alert.alert(t("models.deleteModelTitle"), t("models.deleteModelConfirm", { name: model.name }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: async () => {
          await FileSystem.deleteAsync(modelPath, { idempotent: true });
          setStatus("idle");
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{model.name}</Text>
          <View style={styles.speedBadge}>
            <Text style={styles.speedBadgeText}>{model.speedLabel}</Text>
          </View>
        </View>
        <Text style={styles.meta}>
          {model.sizeLabel} · {model.description}
        </Text>
      </View>

      {status === "idle" && (
        <TouchableOpacity style={styles.btnDownload} onPress={startDownload}>
          <Text style={styles.btnText}>{t("models.downloadBtn")}</Text>
        </TouchableOpacity>
      )}

      {status === "downloading" && (
        <View style={styles.progressWrapper}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
          <Text style={styles.progressText}>{Math.round(progress * 100)}%</Text>
          <TouchableOpacity onPress={cancelDownload}>
            <Text style={styles.cancelText}>{t("models.cancelBtn")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {status === "downloaded" && (
        <View style={styles.downloadedActions}>
          {isSelected ? (
            <View style={styles.selectedBadge}>
              <Text style={styles.selectedBadgeText}>{t("models.inUse")}</Text>
            </View>
          ) : (
            <TouchableOpacity style={styles.btnSelect} onPress={onSelect}>
              <Text style={styles.btnSelectText}>{t("models.selectBtn")}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.btnDelete} onPress={deleteModel}>
            <Text style={styles.btnDeleteText}>{t("common.delete")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {status === "error" && (
        <TouchableOpacity style={styles.btnDownload} onPress={startDownload}>
          <Text style={styles.btnText}>{t("models.retryBtn")}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#333",
  },
  info: { flex: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  name: { color: "#fff", fontWeight: "600", fontSize: 15 },
  speedBadge: {
    backgroundColor: "#1e293b",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  speedBadgeText: { color: "#94a3b8", fontSize: 11, fontWeight: "600" },
  meta: { color: "#888", fontSize: 12, marginTop: 2 },
  btnDownload: {
    backgroundColor: "#2563eb",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 13 },
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
  cancelText: { color: "#ef4444", fontSize: 12 },
  downloadedActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  btnSelect: {
    backgroundColor: "#16a34a",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnSelectText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  selectedBadge: {
    borderWidth: 1,
    borderColor: "#16a34a",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  selectedBadgeText: { color: "#16a34a", fontSize: 12, fontWeight: "600" },
});
