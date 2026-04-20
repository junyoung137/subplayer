import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Modal,
  ScrollView,
  Pressable,
  StatusBar,
  Dimensions,
  ActivityIndicator,
  useWindowDimensions,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { VideoPlayer } from "../components/VideoPlayer";
import { SubtitleOverlay } from "../components/SubtitleOverlay";
import { SubtitleQuickPanel } from "../components/SubtitleQuickPanel";
import { LANGUAGES, getLanguageByCode } from "../constants/languages";
import { useRetranslate } from "../hooks/useRetranslate";
import { Settings, Globe, Check, Maximize2, Minimize2, Camera } from 'lucide-react-native';

// ── expo-video-thumbnails (optional) ─────────────────────────────────────────
let getThumbnailAsync: ((uri: string, opts: { time: number }) => Promise<{ uri: string }>) | null = null;
try {
  const mod = require("expo-video-thumbnails");
  getThumbnailAsync = mod.getThumbnailAsync ?? null;
} catch {}

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const LANDSCAPE_BOTTOM_HEIGHT = 110;
const RECENT_KEY = "realtimesub_recent_files_v2";

// ── Save captured thumbnail back to the shared file list ─────────────────────
async function saveThumbnailToFileList(videoUri: string, thumbUri: string) {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    if (!raw) return;
    const files = JSON.parse(raw) as Array<{ uri: string; thumbnailUri?: string;[key: string]: any }>;
    const updated = files.map((f) =>
      f.uri === videoUri ? { ...f, thumbnailUri: thumbUri } : f
    );
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn("[CAPTURE] Failed to save thumbnail to file list:", e);
  }
}

export default function PlayerScreen() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isLandscape = screenWidth > screenHeight;

  const videoUri   = usePlayerStore((s) => s.videoUri);
  const videoName  = usePlayerStore((s) => s.videoName);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const isPlaying  = usePlayerStore((s) => s.isPlaying);
  const setPlaying = usePlayerStore((s) => s.setPlaying);

  const subtitleMode   = useSettingsStore((s) => s.subtitleMode);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const update         = useSettingsStore((s) => s.update);

  const { t } = useTranslation();
  const { isRetranslating, retranslate, cancelRetranslation } = useRetranslate();

  const [langModalVisible,     setLangModalVisible]     = useState(false);
  const [subtitlePanelVisible, setSubtitlePanelVisible] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(2);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureSuccess, setCaptureSuccess] = useState(false);

  const playbackRate = SPEEDS[speedIdx];
  const speedLabel = Number.isInteger(playbackRate)
    ? `${playbackRate}.0x`
    : `${playbackRate}x`;

  const cycleModes = () => {
    const modes: Array<"both" | "original" | "translation"> = ["both", "original", "translation"];
    update({ subtitleMode: modes[(modes.indexOf(subtitleMode as any) + 1) % modes.length] });
  };

  const modeLabel = { both: t("player.both"), original: t("player.original"), translation: t("player.translation") }[subtitleMode];

  useEffect(() => {
    StatusBar.setHidden(isLandscape || isFullscreen, "slide");
  }, [isLandscape, isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  useEffect(() => {
    return () => {
      StatusBar.setHidden(false, "none");
      cancelRetranslation();
    };
  }, []);

  // ── Frame capture ──────────────────────────────────────────────────────────
  const captureFrame = useCallback(async () => {
    if (!videoUri || !getThumbnailAsync || isCapturing) return;

    setIsCapturing(true);
    try {
      // Capture current playback position (ms)
      const timeMs = Math.max(Math.round(currentTime * 1000), 500);
      const safeUri = videoUri.startsWith("file://") ? videoUri : "file://" + videoUri;
      const result = await getThumbnailAsync(safeUri, { time: timeMs });

      if (result?.uri) {
        // Persist to cache so it survives app restarts
        const cacheDir = FileSystem.cacheDirectory + "thumbs/";
        await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
        const dest = cacheDir + Date.now() + ".jpg";
        await FileSystem.copyAsync({ from: result.uri, to: dest });

        // Write back to the shared recent-files list
        await saveThumbnailToFileList(videoUri, dest);

        // Brief success flash
        setCaptureSuccess(true);
        setTimeout(() => setCaptureSuccess(false), 1800);
      }
    } catch (e) {
      Alert.alert(t("player.captureFailed"), "현재 프레임을 캡처할 수 없습니다.\n" + String(e));
    } finally {
      setIsCapturing(false);
    }
  }, [videoUri, currentTime, isCapturing]);

  if (!videoUri) {
    router.back();
    return null;
  }

  const videoHeight = Math.max(screenWidth * (9 / 16), screenHeight * 0.5);

  // ── Capture button (shared between portrait & landscape) ──────────────────
  const captureBtn = getThumbnailAsync ? (
    <TouchableOpacity
      style={[styles.chipBtn, isCapturing && styles.chipBtnDisabled]}
      onPress={captureFrame}
      activeOpacity={isCapturing ? 1 : 0.75}
      disabled={isCapturing}
    >
      {isCapturing ? (
        <ActivityIndicator size="small" color="#ccc" />
      ) : (
        captureSuccess ? <Check size={14} color="#22c55e" /> : <Camera size={14} color="#ccc" />
      )}
    </TouchableOpacity>
  ) : null;

  const langBtn = (extraStyle?: object) => (
    <TouchableOpacity
      style={[styles.chipBtn, styles.chipBtnFlex, isRetranslating && styles.chipBtnDisabled, extraStyle]}
      onPress={() => { if (!isRetranslating) setLangModalVisible(true); }}
      activeOpacity={isRetranslating ? 1 : 0.75}
    >
      <Globe size={14} color="#ccc" />
      <Text style={[styles.chipBtnText, { marginLeft: 4 }]} numberOfLines={1}>
        {getLanguageByCode(targetLanguage)?.nativeName ?? targetLanguage}
      </Text>
    </TouchableOpacity>
  );

  const subtitleStyleBtn = (
    <TouchableOpacity
      style={styles.chipBtn}
      onPress={() => setSubtitlePanelVisible(true)}
      activeOpacity={0.75}
    >
      <Text style={styles.chipBtnText}>Aa</Text>
    </TouchableOpacity>
  );

  const landscapeHeader = (
    <View style={styles.lsHeader}>
      <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
        <Text style={styles.headerBtnText}>←</Text>
      </TouchableOpacity>
      <Text style={styles.lsTitle} numberOfLines={1}>{videoName ?? t("player.video")}</Text>
      <TouchableOpacity onPress={() => router.push("/settings")} style={styles.headerBtn}>
        <Settings size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  const landscapeControls = (
    <View style={styles.lsControlBar}>
      <TouchableOpacity style={styles.playBtn} onPress={() => setPlaying(!isPlaying)} activeOpacity={0.75}>
        <Text style={styles.playBtnText}>{isPlaying ? "⏸" : "▶"}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.chipBtn}
        onPress={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
        activeOpacity={0.75}
      >
        <Text style={styles.chipBtnText}>{speedLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.chipBtn, styles.chipBtnFlex]} onPress={cycleModes} activeOpacity={0.75}>
        <Text style={styles.chipBtnText} numberOfLines={1}>{modeLabel}</Text>
      </TouchableOpacity>
      {subtitleStyleBtn}
      {/* 📷 현재 프레임 캡처 */}
      {captureBtn}
    </View>
  );

  const langModal = (
    <Modal
      visible={langModalVisible}
      transparent
      animationType="slide"
      onRequestClose={() => setLangModalVisible(false)}
    >
      <Pressable style={styles.modalBackdrop} onPress={() => setLangModalVisible(false)}>
        <Pressable style={styles.modalSheet} onPress={() => {}}>
          <Text style={styles.modalTitle}>{t("player.selectLang")}</Text>
          <ScrollView>
            {LANGUAGES.map((lang) => (
              <TouchableOpacity
                key={lang.code}
                style={[
                  styles.langOption,
                  targetLanguage === lang.code && styles.langOptionSelected,
                ]}
                onPress={() => {
                  update({ targetLanguage: lang.code });
                  setLangModalVisible(false);
                  retranslate(lang.code);
                }}
              >
                <Text style={styles.langOptionNative}>{lang.nativeName}</Text>
                <Text style={styles.langOptionCode}>{lang.name}</Text>
                {targetLanguage === lang.code && (
                  <Check size={14} color="#2563eb" />
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // LANDSCAPE LAYOUT
  // ══════════════════════════════════════════════════════════════════════════
  if (isLandscape) {
    return (
      <View style={{ width: screenWidth, height: screenHeight, backgroundColor: "#000" }}>
        <VideoPlayer
          rate={playbackRate}
          overlayHeader={landscapeHeader}
          overlayControls={landscapeControls}
        />
        <SubtitleOverlay />
        {isRetranslating && (
          <View style={styles.lsRetranslateBanner}>
            <ActivityIndicator size="small" color="#2563eb" />
            <Text style={styles.retranslateText}>번역 중...</Text>
          </View>
        )}
        {/* Capture success toast */}
        {captureSuccess && (
          <View style={styles.captureToast} pointerEvents="none">
            <Text style={styles.captureToastText}>{t("player.thumbnailSaved")}</Text>
          </View>
        )}
        {langModal}
        <SubtitleQuickPanel
          visible={subtitlePanelVisible}
          onClose={() => setSubtitlePanelVisible(false)}
        />
      </View>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PORTRAIT LAYOUT
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={styles.safe}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {videoName ?? t("player.video")}
        </Text>
        <TouchableOpacity onPress={() => router.push("/settings")} style={styles.headerBtn}>
          <Settings size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Video wrapper */}
      <View
        style={
          isFullscreen
            ? styles.videoWrapperFullscreen
            : [styles.videoWrapper, { height: videoHeight }]
        }
      >
        <VideoPlayer rate={playbackRate} />
        <SubtitleOverlay />
      </View>

      {/* Control bar */}
      <View style={styles.controlBar}>
        {/* Play / Pause */}
        <TouchableOpacity
          style={styles.playBtn}
          onPress={() => setPlaying(!isPlaying)}
          activeOpacity={0.75}
        >
          <Text style={styles.playBtnText}>{isPlaying ? "⏸" : "▶"}</Text>
        </TouchableOpacity>

        {/* Speed */}
        <TouchableOpacity
          style={styles.chipBtn}
          onPress={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
          activeOpacity={0.75}
        >
          <Text style={styles.chipBtnText}>{speedLabel}</Text>
        </TouchableOpacity>

        {/* Fullscreen */}
        <TouchableOpacity style={styles.chipBtn} onPress={toggleFullscreen} activeOpacity={0.75}>
          {isFullscreen ? <Minimize2 size={16} color="#ccc" /> : <Maximize2 size={16} color="#ccc" />}
        </TouchableOpacity>

        {/* Subtitle mode */}
        <TouchableOpacity
          style={[styles.chipBtn, styles.chipBtnFlex]}
          onPress={cycleModes}
          activeOpacity={0.75}
        >
          <Text style={styles.chipBtnText} numberOfLines={1}>{modeLabel}</Text>
        </TouchableOpacity>

        {/* 자막 스타일 */}
        {subtitleStyleBtn}

        {/* 📷 현재 프레임 캡처 */}
        {captureBtn}

      </View>

      {/* Re-translation banner */}
      {isRetranslating && (
        <View style={styles.retranslateBanner}>
          <ActivityIndicator size="small" color="#2563eb" />
          <Text style={styles.retranslateText}>번역 중...</Text>
        </View>
      )}

      {/* Capture success toast */}
      {captureSuccess && (
        <View style={styles.captureToast} pointerEvents="none">
          <Text style={styles.captureToastText}>{t("player.thumbnailSaved")}</Text>
        </View>
      )}

      {langModal}

      <SubtitleQuickPanel
        visible={subtitlePanelVisible}
        onClose={() => setSubtitlePanelVisible(false)}
      />

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#000" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#111",
  },
  headerBtn: { padding: 8 },
  headerBtnText: { color: "#fff", fontSize: 20 },
  title: {
    flex: 1,
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    marginHorizontal: 8,
  },

  videoWrapper: {
    width: "100%",
    backgroundColor: "#000",
    overflow: "hidden",
  },
  videoWrapperFullscreen: {
    position: "absolute",
    top: 0,
    left: 0,
    width: Dimensions.get("screen").width,
    height: Dimensions.get("screen").height,
    zIndex: 999,
    backgroundColor: "#000",
  },

  controlBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  playBtnText: { fontSize: 18, color: "#fff" },
  chipBtn: {
    backgroundColor: "#222",
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexShrink: 0,
    minWidth: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  chipBtnFlex: { flex: 1, alignItems: "center" },
  chipBtnText: { color: "#ccc", fontSize: 12 },
  chipBtnDisabled: { opacity: 0.4 },
  chipBtnSuccess: { color: "#22c55e" },

  retranslateBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#0f1f3d",
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1e3a6e",
  },
  retranslateText: { color: "#60a5fa", fontSize: 13, fontWeight: "600" },

  // ── Capture toast ──────────────────────────────────────────────────────────
  captureToast: {
    position: "absolute",
    bottom: 90,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: "#22c55e44",
  },
  captureToastText: {
    color: "#22c55e",
    fontSize: 13,
    fontWeight: "700",
  },

  lsHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(0,0,0,0.55)",
    gap: 4,
  },
  lsTitle: {
    flex: 1,
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    marginHorizontal: 8,
  },
  lsControlBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(0,0,0,0.55)",
    gap: 8,
  },
  lsRetranslateBanner: {
    position: "absolute",
    bottom: LANDSCAPE_BOTTOM_HEIGHT + 4,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#0f1f3d",
    paddingVertical: 6,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#1a1a1a",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "60%",
    paddingBottom: 24,
  },
  modalTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#333",
  },
  langOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a2a",
  },
  langOptionSelected: { backgroundColor: "#1e3a5f" },
  langOptionNative: { color: "#fff", fontSize: 15, flex: 1 },
  langOptionCode: { color: "#666", fontSize: 13, marginRight: 8 },
});