import React, { useState, useCallback, useEffect } from "react";
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
} from "react-native";
import { router } from "expo-router";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { VideoPlayer } from "../components/VideoPlayer";
import { SubtitleOverlay } from "../components/SubtitleOverlay";
import { LANGUAGES, getLanguageByCode } from "../constants/languages";
import { useRetranslate } from "../hooks/useRetranslate";

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

/**
 * Approximate height of the landscape bottom overlay area:
 *   overlayControls row (~52px) + seek-bar bottomBar (~58px) = ~110px.
 * Used to offset subtitles so they never sit on top of controls.
 */
const LANDSCAPE_BOTTOM_HEIGHT = 110;

export default function PlayerScreen() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isLandscape = screenWidth > screenHeight;

  const videoUri   = usePlayerStore((s) => s.videoUri);
  const videoName  = usePlayerStore((s) => s.videoName);
  const isPlaying  = usePlayerStore((s) => s.isPlaying);
  const setPlaying = usePlayerStore((s) => s.setPlaying);

  const subtitleMode   = useSettingsStore((s) => s.subtitleMode);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const update         = useSettingsStore((s) => s.update);

  const { isRetranslating, retranslate, cancelRetranslation } = useRetranslate();

  const [langModalVisible, setLangModalVisible] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(2); // default 1.0x
  const [isFullscreen, setIsFullscreen] = useState(false);

  const playbackRate = SPEEDS[speedIdx];
  const speedLabel = Number.isInteger(playbackRate)
    ? `${playbackRate}.0x`
    : `${playbackRate}x`;

  const cycleModes = () => {
    const modes: Array<"both" | "original" | "translation"> = ["both", "original", "translation"];
    update({ subtitleMode: modes[(modes.indexOf(subtitleMode as any) + 1) % modes.length] });
  };

  const modeLabel = { both: "원문+번역", original: "원문만", translation: "번역만" }[subtitleMode];

  // ── Status bar: hidden in landscape or portrait-fullscreen ───────────────
  useEffect(() => {
    StatusBar.setHidden(isLandscape || isFullscreen, "slide");
  }, [isLandscape, isFullscreen]);

  // ── Portrait fullscreen toggle ────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      StatusBar.setHidden(false, "none");
      cancelRetranslation();
    };
  }, []);

  if (!videoUri) {
    router.back();
    return null;
  }

  // ── Video wrapper height for portrait ────────────────────────────────────
  // At least 16:9 for current width, or 50% of screen, whichever is larger.
  const videoHeight = Math.max(screenWidth * (9 / 16), screenHeight * 0.5);

  // ── Language picker ───────────────────────────────────────────────────────
  const langBtn = (extraStyle?: object) => (
    <TouchableOpacity
      style={[styles.chipBtn, styles.chipBtnFlex, isRetranslating && styles.chipBtnDisabled, extraStyle]}
      onPress={() => { if (!isRetranslating) setLangModalVisible(true); }}
      activeOpacity={isRetranslating ? 1 : 0.75}
    >
      <Text style={styles.chipBtnText} numberOfLines={1}>
        🌐 {getLanguageByCode(targetLanguage)?.nativeName ?? targetLanguage}
      </Text>
    </TouchableOpacity>
  );

  // ── Nodes passed into VideoPlayer's overlay in landscape ──────────────────
  const landscapeHeader = (
    <View style={styles.lsHeader}>
      <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
        <Text style={styles.headerBtnText}>←</Text>
      </TouchableOpacity>
      <Text style={styles.lsTitle} numberOfLines={1}>{videoName ?? "동영상"}</Text>
      <TouchableOpacity onPress={() => router.push("/settings")} style={styles.headerBtn}>
        <Text style={styles.headerBtnText}>⚙</Text>
      </TouchableOpacity>
    </View>
  );

  const landscapeControls = (
    <View style={styles.lsControlBar}>
      {/* Play / Pause */}
      <TouchableOpacity style={styles.playBtn} onPress={() => setPlaying(!isPlaying)} activeOpacity={0.75}>
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

      {/* Subtitle mode */}
      <TouchableOpacity style={[styles.chipBtn, styles.chipBtnFlex]} onPress={cycleModes} activeOpacity={0.75}>
        <Text style={styles.chipBtnText} numberOfLines={1}>{modeLabel}</Text>
      </TouchableOpacity>

      {/* Language */}
      {langBtn()}
    </View>
  );

  // ── Shared language-picker modal ──────────────────────────────────────────
  const langModal = (
    <Modal
      visible={langModalVisible}
      transparent
      animationType="slide"
      onRequestClose={() => setLangModalVisible(false)}
    >
      <Pressable style={styles.modalBackdrop} onPress={() => setLangModalVisible(false)}>
        <Pressable style={styles.modalSheet} onPress={() => {}}>
          <Text style={styles.modalTitle}>번역 언어 선택</Text>
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
                  <Text style={styles.langCheckmark}>✓</Text>
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
  // Video fills the entire SafeAreaView via absoluteFillObject.
  // Header + controls live inside VideoPlayer's auto-hiding overlay.
  // ══════════════════════════════════════════════════════════════════════════
  if (isLandscape) {
    return (
      <View style={{ width: screenWidth, height: screenHeight, backgroundColor: "#000" }}>
        {/* VideoPlayer fills 100% — flex:1 expands into the explicit-size root */}
        <VideoPlayer
          rate={playbackRate}
          overlayHeader={landscapeHeader}
          overlayControls={landscapeControls}
        />

        {/* Subtitle and banners: position:absolute, relative to root View */}
        <SubtitleOverlay />

        {isRetranslating && (
          <View style={styles.lsRetranslateBanner}>
            <ActivityIndicator size="small" color="#2563eb" />
            <Text style={styles.retranslateText}>번역 중...</Text>
          </View>
        )}

        {langModal}
      </View>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PORTRAIT LAYOUT  (unchanged from before)
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={styles.safe}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {videoName ?? "동영상"}
        </Text>
        <TouchableOpacity onPress={() => router.push("/settings")} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>⚙</Text>
        </TouchableOpacity>
      </View>

      {/* Video wrapper: explicit height normally, absolute fullscreen on demand */}
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

      {/* External control bar */}
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

        {/* Fullscreen toggle */}
        <TouchableOpacity style={styles.chipBtn} onPress={toggleFullscreen} activeOpacity={0.75}>
          <Text style={styles.chipBtnText}>{isFullscreen ? "✕" : "⛶"}</Text>
        </TouchableOpacity>

        {/* Subtitle mode */}
        <TouchableOpacity
          style={[styles.chipBtn, styles.chipBtnFlex]}
          onPress={cycleModes}
          activeOpacity={0.75}
        >
          <Text style={styles.chipBtnText} numberOfLines={1}>{modeLabel}</Text>
        </TouchableOpacity>

        {/* Language */}
        {langBtn()}
      </View>

      {/* Re-translation banner */}
      {isRetranslating && (
        <View style={styles.retranslateBanner}>
          <ActivityIndicator size="small" color="#2563eb" />
          <Text style={styles.retranslateText}>번역 중...</Text>
        </View>
      )}

      {langModal}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#000" },

  // ── Portrait header ───────────────────────────────────────────────────────
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

  // ── Portrait video wrapper ────────────────────────────────────────────────
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

  // ── Portrait control bar ──────────────────────────────────────────────────
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
  },
  chipBtnFlex: { flex: 1, alignItems: "center" },
  chipBtnText: { color: "#ccc", fontSize: 12 },
  chipBtnDisabled: { opacity: 0.4 },

  // ── Portrait retranslate banner ───────────────────────────────────────────
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

  // ── Landscape overlays (rendered inside VideoPlayer's auto-hiding overlay) ─
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
  // Retranslate banner in landscape: absolute so it's always visible above controls
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

  // ── Language picker modal ─────────────────────────────────────────────────
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
  langCheckmark: { color: "#2563eb", fontSize: 16, fontWeight: "700" },
});
