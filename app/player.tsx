import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
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
import { pendingSubtitleRef } from "../utils/pendingSubtitle";
import { parseSrt } from "../utils/srtParser";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { VideoPlayer } from "../components/VideoPlayer";
import { SubtitleOverlay } from "../components/SubtitleOverlay";
import { SubtitleQuickPanel } from "../components/SubtitleQuickPanel";
import { SubtitleSaveModal } from "../components/SubtitleSaveModal";
import { VideoSearchModal } from "../components/VideoSearchModal";
import { useRetranslate } from "../hooks/useRetranslate";
import {
  loadSubtitles,
  saveSubtitles,
  savePartialSubtitles,
} from "../services/subtitleDB";
import { SubtitleSegment } from "../store/usePlayerStore";
import {
  Settings,
  Check,
  Maximize2,
  Minimize2,
  Camera,
  Download,
  Layers,
  Search,
} from "lucide-react-native";

// ── expo-video-thumbnails (optional) ─────────────────────────────────────────
let getThumbnailAsync:
  | ((uri: string, opts: { time: number }) => Promise<{ uri: string }>)
  | null = null;
try {
  const mod = require("expo-video-thumbnails");
  getThumbnailAsync = mod.getThumbnailAsync ?? null;
} catch {}

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const LANDSCAPE_BOTTOM_HEIGHT = 110;
const RECENT_KEY = "realtimesub_recent_files_v2";

type SubtitlePhase = "idle" | "processing" | "translating" | "done" | "error";

async function saveThumbnailToFileList(videoUri: string, thumbUri: string) {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    if (!raw) return;
    const files = JSON.parse(raw) as Array<{ uri: string; thumbnailUri?: string; [key: string]: any }>;
    const updated = files.map((f) => f.uri === videoUri ? { ...f, thumbnailUri: thumbUri } : f);
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn("[CAPTURE] Failed to save thumbnail to file list:", e);
  }
}

function localCacheKey(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const parts = decoded.replace(/\\/g, "/").split("/");
    return "local__" + (parts[parts.length - 1] ?? uri);
  } catch {
    return "local__" + uri;
  }
}

export default function PlayerScreen() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isLandscape = screenWidth > screenHeight;

  const videoUri    = usePlayerStore((s) => s.videoUri);
  const videoName   = usePlayerStore((s) => s.videoName);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const isPlaying   = usePlayerStore((s) => s.isPlaying);
  const setPlaying  = usePlayerStore((s) => s.setPlaying);
  const subtitles   = usePlayerStore((s) => s.subtitles);
  const setSubtitles   = usePlayerStore((s) => s.setSubtitles);
  const clearSubtitles = usePlayerStore((s) => s.clearSubtitles);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const bumpSeek       = usePlayerStore((s) => s.bumpSeek);
  const storeIsProcessing = usePlayerStore((s) => s.isProcessing);

  const subtitleMode   = useSettingsStore((s) => s.subtitleMode);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const update         = useSettingsStore((s) => s.update);

  const { t } = useTranslation();
  const { isRetranslating, retranslate, cancelRetranslation } = useRetranslate();

  const cacheKey = videoUri ? localCacheKey(videoUri) : null;

  // Read and consume pending SRT URI synchronously at render time.
  const initialSrtUri = useRef<string | null>(pendingSubtitleRef.current);
  const hasSrtRef = useRef<boolean>(pendingSubtitleRef.current !== null);
  if (pendingSubtitleRef.current) {
    pendingSubtitleRef.current = null;
  }

  const subtitleLoadedRef = useRef<string | null>(null);

  const [subtitlePanelVisible, setSubtitlePanelVisible] = useState(false);
  const [saveModalVisible,     setSaveModalVisible]     = useState(false);
  const [searchModalVisible,   setSearchModalVisible]   = useState(false);
  const [speedIdx,   setSpeedIdx]   = useState(2);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCapturing,  setIsCapturing]  = useState(false);
  const [captureSuccess, setCaptureSuccess] = useState(false);

  const [subtitlePhase,    setSubtitlePhase]    = useState<SubtitlePhase>("idle");
  const [subtitleProgress, setSubtitleProgress] = useState(0);
  const [translationEverCompleted, setTranslationEverCompleted] = useState(false);

  // ── Entry toast (TASK 3) ──────────────────────────────────────────────────
  const entryToastShownRef = useRef(false);
  const [showEntryToast, setShowEntryToast] = useState(false);

  useEffect(() => {
    if (storeIsProcessing && !entryToastShownRef.current) {
      entryToastShownRef.current = true;
      setShowEntryToast(true);
      const timer = setTimeout(() => setShowEntryToast(false), 3000);
      return () => clearTimeout(timer);
    }
  }, []); // empty deps — mount only

  const playbackRate = SPEEDS[speedIdx];
  const speedLabel = Number.isInteger(playbackRate) ? `${playbackRate}.0x` : `${playbackRate}x`;

  const cycleModes = () => {
    const modes: Array<"both" | "original" | "translation"> = ["both", "original", "translation"];
    update({ subtitleMode: modes[(modes.indexOf(subtitleMode as any) + 1) % modes.length] });
  };
  const modeLabel = { both: t("player.both"), original: t("player.original"), translation: t("player.translation") }[subtitleMode];

  useEffect(() => { StatusBar.setHidden(isLandscape || isFullscreen, "slide"); }, [isLandscape, isFullscreen]);
  const toggleFullscreen = useCallback(() => setIsFullscreen((p) => !p), []);

  useEffect(() => {
    return () => {
      StatusBar.setHidden(false, "none");
      cancelRetranslation();
    };
  }, []);

  // ── cacheKey reset ────────────────────────────────────────────────────────
  useEffect(() => {
    setTranslationEverCompleted(false);
    setSubtitlePhase("idle");
    setSubtitleProgress(0);
    subtitleLoadedRef.current = null;
  }, [cacheKey]);

  // ── Load from SQLite on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (!cacheKey) return;
    if (subtitleLoadedRef.current === cacheKey) return;
    if (hasSrtRef.current) return;

    (async () => {
      const cached = await loadSubtitles(cacheKey, targetLanguage, "local");
      if (!cached) return;
      subtitleLoadedRef.current = cacheKey;
      setSubtitles(cached.segments);
      if (!cached.isPartial) {
        setSubtitlePhase("done"); setSubtitleProgress(1); setTranslationEverCompleted(true);
      } else {
        setSubtitlePhase("processing");
        setSubtitleProgress(cached.segments.length > 0 ? cached.translatedCount / cached.segments.length : 0);
      }
    })();
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Subtitle phase tracking (TASK 4) ─────────────────────────────────────
  useEffect(() => {
    if (hasSrtRef.current) return;
    if (!cacheKey || subtitles.length === 0) return;

    const translatedCount = subtitles.filter(
      (s) => s.translated && s.translated.trim() !== ""
    ).length;

    if (
      translatedCount === subtitles.length &&
      subtitles.length > 0 &&
      !storeIsProcessing
    ) {
      setSubtitlePhase("done");
      setSubtitleProgress(1);
      setTranslationEverCompleted(true);
      saveSubtitles(cacheKey, targetLanguage, "local", subtitles).catch(() => {});
    } else if (translatedCount > 0) {
      setSubtitlePhase("translating");
      setSubtitleProgress(subtitles.length > 0 ? translatedCount / subtitles.length : 0);
      savePartialSubtitles(cacheKey, targetLanguage, "local", subtitles, translatedCount).catch(() => {});
    } else if (subtitles.length > 0) {
      setSubtitlePhase("processing");
    }
  }, [subtitles, storeIsProcessing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── SRT loading ───────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const srtUri = initialSrtUri.current;
    if (!srtUri || !videoUri) return;
    initialSrtUri.current = null;

    (async () => {
      try {
        const content = await FileSystem.readAsStringAsync(srtUri);
        const segments = parseSrt(content);
        if (segments.length > 0) {
          setSubtitles(segments);
          setSubtitlePhase("done");
          setSubtitleProgress(1);
          setTranslationEverCompleted(true);
        }
      } catch (e) {
        console.warn("[SRT] Failed to load SRT:", e);
      }
    })();
  }, []); // runs once synchronously before other effects

  // ── Search seek handler ───────────────────────────────────────────────────
  const handleSearchSeek = useCallback((time: number) => {
    setCurrentTime(time);
    bumpSeek();
  }, [setCurrentTime, bumpSeek]);

  // ── Capture frame ─────────────────────────────────────────────────────────
  const captureFrame = useCallback(async () => {
    if (!videoUri || !getThumbnailAsync || isCapturing) return;
    setIsCapturing(true);
    try {
      const timeMs = Math.max(Math.round(currentTime * 1000), 500);
      const safeUri = videoUri.startsWith("file://") ? videoUri : "file://" + videoUri;
      const result = await getThumbnailAsync(safeUri, { time: timeMs });
      if (result?.uri) {
        const cacheDir = FileSystem.cacheDirectory + "thumbs/";
        await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
        const dest = cacheDir + Date.now() + ".jpg";
        await FileSystem.copyAsync({ from: result.uri, to: dest });
        await saveThumbnailToFileList(videoUri, dest);
        setCaptureSuccess(true);
        setTimeout(() => setCaptureSuccess(false), 1800);
      }
    } catch (e) {
      Alert.alert(t("player.captureFailed"), "현재 프레임을 캡처할 수 없습니다.\n" + String(e));
    } finally {
      setIsCapturing(false);
    }
  }, [videoUri, currentTime, isCapturing]);

  if (!videoUri) { router.back(); return null; }

  const videoHeight = Math.max(screenWidth * (9 / 16), screenHeight * 0.5);

  const showSaveBtn = subtitlePhase === "done" && subtitles.length > 0 && translationEverCompleted;

  // ── 가로 모드 오버레이 컴포넌트 ──────────────────────────────────────────
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
      <TouchableOpacity style={styles.chipBtn} onPress={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)} activeOpacity={0.75}>
        <Text style={styles.chipBtnText}>{speedLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.chipBtn, styles.chipBtnFlex]} onPress={cycleModes} activeOpacity={0.75}>
        <Layers size={13} color="#ccc" />
        <Text style={[styles.chipBtnText, { marginLeft: 4 }]} numberOfLines={1}>{modeLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.chipBtn} onPress={() => setSubtitlePanelVisible(true)} activeOpacity={0.75}>
        <Text style={styles.chipBtnText}>Aa</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.chipBtn} onPress={() => setSearchModalVisible(true)} activeOpacity={0.75}>
        <Search size={15} color="#ccc" />
      </TouchableOpacity>
      {getThumbnailAsync && (
        <TouchableOpacity
          style={[styles.chipBtn, isCapturing && styles.chipBtnDisabled]}
          onPress={captureFrame} activeOpacity={isCapturing ? 1 : 0.75} disabled={isCapturing}
        >
          {isCapturing ? <ActivityIndicator size="small" color="#ccc" />
            : captureSuccess ? <Check size={14} color="#22c55e" />
            : <Camera size={14} color="#ccc" />}
        </TouchableOpacity>
      )}
      {showSaveBtn && (
        <TouchableOpacity style={[styles.chipBtn, styles.chipBtnSave]} onPress={() => setSaveModalVisible(true)}>
          <Download size={13} color="#86efac" />
          <Text style={[styles.chipBtnText, styles.chipBtnSaveText]}>{t("player.save")}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // LANDSCAPE LAYOUT
  // ══════════════════════════════════════════════════════════════════════════
  if (isLandscape) {
    return (
      <View style={{ width: screenWidth, height: screenHeight, backgroundColor: "#000" }}>
        <VideoPlayer rate={playbackRate} overlayHeader={landscapeHeader} overlayControls={landscapeControls} />
        <SubtitleOverlay />
        {showEntryToast && (
          <View style={styles.entryToast} pointerEvents="none">
            <Text style={styles.entryToastLine1}>앞부분 자막부터 재생됩니다</Text>
            <Text style={styles.entryToastLine2}>뒤쪽은 곧 채워집니다</Text>
          </View>
        )}
        {isRetranslating && (
          <View style={styles.lsRetranslateBanner}>
            <ActivityIndicator size="small" color="#2563eb" />
            <Text style={styles.retranslateText}>번역 중...</Text>
          </View>
        )}
        {captureSuccess && (
          <View style={styles.captureToast} pointerEvents="none">
            <Text style={styles.captureToastText}>{t("player.thumbnailSaved")}</Text>
          </View>
        )}
        <SubtitleQuickPanel visible={subtitlePanelVisible} onClose={() => setSubtitlePanelVisible(false)} />
        <SubtitleSaveModal
          visible={saveModalVisible} onClose={() => setSaveModalVisible(false)}
          videoId={cacheKey ?? "local"} videoTitle={videoName ?? "video"}
          subtitles={subtitles.map((s) => ({ startTime: s.startTime, endTime: s.endTime, original: s.original, translated: s.translated }))}
        />
        <VideoSearchModal
          visible={searchModalVisible}
          onClose={() => setSearchModalVisible(false)}
          subtitles={subtitles}
          currentTime={currentTime}
          onSeek={handleSearchSeek}
        />
      </View>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PORTRAIT LAYOUT
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={styles.safe}>

      {/* 헤더 */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{videoName ?? t("player.video")}</Text>
        <TouchableOpacity onPress={() => router.push("/settings")} style={styles.headerBtn}>
          <Settings size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={isFullscreen ? styles.videoWrapperFullscreen : [styles.videoWrapper, { height: videoHeight }]}>
        <VideoPlayer rate={playbackRate} />
        <SubtitleOverlay />
        {/* [B] Entry toast */}
        {showEntryToast && (
          <View style={styles.entryToast} pointerEvents="none">
            <Text style={styles.entryToastLine1}>앞부분 자막부터 재생됩니다</Text>
            <Text style={styles.entryToastLine2}>뒤쪽은 곧 채워집니다</Text>
          </View>
        )}
      </View>

      {/* 번역 진행 바 */}
      {(subtitlePhase !== "idle" && subtitlePhase !== "done") && (
        <View style={styles.progressBarTrack}>
          <View
            style={[styles.progressBarFill, {
              width: `${Math.min(subtitleProgress * 100, 100)}%` as any,
              backgroundColor: "#3b82f6",
            }]}
          />
        </View>
      )}

      {/* 컨트롤 바 (단일 행) */}
      <View style={styles.controlBar}>
        <View style={styles.controlRow}>
          <TouchableOpacity style={styles.playBtn} onPress={() => setPlaying(!isPlaying)} activeOpacity={0.75}>
            <Text style={styles.playBtnText}>{isPlaying ? "⏸" : "▶"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.chipBtn} onPress={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)} activeOpacity={0.75}>
            <Text style={styles.chipBtnText}>{speedLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chipBtn, styles.chipBtnFlex]} onPress={cycleModes} activeOpacity={0.75}>
            <Layers size={13} color="#ccc" />
            <Text style={[styles.chipBtnText, { marginLeft: 4 }]} numberOfLines={1}>{modeLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.chipBtn} onPress={() => setSubtitlePanelVisible(true)} activeOpacity={0.75}>
            <Text style={styles.chipBtnText}>Aa</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.chipBtn} onPress={() => setSearchModalVisible(true)} activeOpacity={0.75}>
            <Search size={15} color="#ccc" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.chipBtn} onPress={toggleFullscreen} activeOpacity={0.75}>
            {isFullscreen ? <Minimize2 size={15} color="#ccc" /> : <Maximize2 size={15} color="#ccc" />}
          </TouchableOpacity>
          {getThumbnailAsync && (
            <TouchableOpacity
              style={[styles.chipBtn, isCapturing && styles.chipBtnDisabled]}
              onPress={captureFrame} activeOpacity={isCapturing ? 1 : 0.75} disabled={isCapturing}
            >
              {isCapturing ? <ActivityIndicator size="small" color="#ccc" />
                : captureSuccess ? <Check size={14} color="#22c55e" />
                : <Camera size={14} color="#ccc" />}
            </TouchableOpacity>
          )}
          {showSaveBtn && (
            <TouchableOpacity style={[styles.chipBtn, styles.chipBtnSave]} onPress={() => setSaveModalVisible(true)}>
              <Download size={13} color="#86efac" />
              <Text style={[styles.chipBtnText, styles.chipBtnSaveText]}>{t("player.save")}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {isRetranslating && (
        <View style={styles.retranslateBanner}>
          <ActivityIndicator size="small" color="#2563eb" />
          <Text style={styles.retranslateText}>번역 중...</Text>
        </View>
      )}

      {captureSuccess && (
        <View style={styles.captureToast} pointerEvents="none">
          <Text style={styles.captureToastText}>{t("player.thumbnailSaved")}</Text>
        </View>
      )}

      <SubtitleQuickPanel visible={subtitlePanelVisible} onClose={() => setSubtitlePanelVisible(false)} />
      <SubtitleSaveModal
        visible={saveModalVisible} onClose={() => setSaveModalVisible(false)}
        videoId={cacheKey ?? "local"} videoTitle={videoName ?? "video"}
        subtitles={subtitles.map((s) => ({ startTime: s.startTime, endTime: s.endTime, original: s.original, translated: s.translated }))}
      />
      <VideoSearchModal
        visible={searchModalVisible}
        onClose={() => setSearchModalVisible(false)}
        subtitles={subtitles}
        currentTime={currentTime}
        onSeek={handleSearchSeek}
      />
    </SafeAreaView>
  );
}

// ── 스타일 ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#000" },

  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#111" },
  headerBtn: { padding: 8 },
  headerBtnText: { color: "#fff", fontSize: 20 },
  title: { flex: 1, color: "#fff", fontSize: 14, fontWeight: "600", marginHorizontal: 8 },

  videoWrapper: {
    width: "100%",
    backgroundColor: "#000",
    overflow: "hidden",
    position: "relative",
  },
  videoWrapperFullscreen: {
    position: "absolute",
    top: 0, left: 0,
    width: Dimensions.get("screen").width,
    height: Dimensions.get("screen").height,
    zIndex: 999,
    backgroundColor: "#000",
  },

  progressBarTrack: { width: "100%", height: 3, backgroundColor: "rgba(255,255,255,0.08)", overflow: "hidden" },
  progressBarFill: { height: 3, borderRadius: 0 },

  controlBar: { backgroundColor: "#111", paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10, gap: 6 },
  controlRow:  { flexDirection: "row", alignItems: "center", gap: 6 },

  playBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#2563eb", justifyContent: "center", alignItems: "center", flexShrink: 0 },
  playBtnText: { fontSize: 16, color: "#fff" },

  chipBtn: {
    flexDirection: "row", backgroundColor: "#222", borderRadius: 16,
    paddingHorizontal: 10, paddingVertical: 7,
    flexShrink: 0, minWidth: 34, alignItems: "center", justifyContent: "center", height: 34,
  },
  chipBtnFlex: { flex: 1 },
  chipBtnText: { color: "#ccc", fontSize: 12 },
  chipBtnDisabled: { opacity: 0.4 },
  chipBtnSave: { backgroundColor: "#14532d", borderWidth: 1, borderColor: "#22c55e", gap: 4 },
  chipBtnSaveText: { color: "#86efac" },

  retranslateBanner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#0f1f3d", paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#1e3a6e" },
  retranslateText: { color: "#60a5fa", fontSize: 13, fontWeight: "600" },

  captureToast: { position: "absolute", bottom: 90, alignSelf: "center", backgroundColor: "rgba(0,0,0,0.75)", borderRadius: 20, paddingHorizontal: 18, paddingVertical: 9, borderWidth: 1, borderColor: "#22c55e44" },
  captureToastText: { color: "#22c55e", fontSize: 13, fontWeight: "700" },

  entryToast: {
    position: 'absolute', top: 12, left: 16, right: 16,
    backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10,
    alignItems: 'center', zIndex: 10, gap: 2,
  },
  entryToastLine1: {
    color: 'rgba(255,255,255,0.92)', fontSize: 13,
    fontWeight: '600', textAlign: 'center',
  },
  entryToastLine2: {
    color: 'rgba(255,255,255,0.60)', fontSize: 11,
    fontWeight: '400', textAlign: 'center',
  },

  lsHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "rgba(0,0,0,0.55)", gap: 4 },
  lsTitle: { flex: 1, color: "#fff", fontSize: 14, fontWeight: "600", marginHorizontal: 8 },
  lsControlBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "rgba(0,0,0,0.55)", gap: 8 },
  lsRetranslateBanner: { position: "absolute", bottom: LANDSCAPE_BOTTOM_HEIGHT + 4, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#0f1f3d", paddingVertical: 6 },
});

const progressCard = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", backgroundColor: "#0d0d2e", paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#312e81", gap: 10 },
  pct: { fontSize: 28, fontWeight: "800", color: "#a5b4fc", minWidth: 56, textAlign: "right" },
  title: { color: "#a5b4fc", fontSize: 12, fontWeight: "600" },
  sub:   { color: "#6366f1", fontSize: 11, marginTop: 2 },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: "#7f1d1d", borderWidth: 1, borderColor: "#ef4444" },
  cancelBtnText: { color: "#fca5a5", fontSize: 11, fontWeight: "600" },
  eta: { color: "#818cf8", fontSize: 10, marginTop: 2, fontVariant: ["tabular-nums"] },
});
