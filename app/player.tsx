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
  Animated,
  Platform,
  PermissionsAndroid,
  NativeModules,
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
import { useBackgroundTranslation } from "../hooks/useBackgroundTranslation";
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
  CheckCircle2,
  XCircle,
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

function formatRemaining(secs: number): string {
  if (secs <= 0) return "";
  if (secs <= 3) return "거의 완료";
  if (secs < 60) return `약 ${Math.ceil(secs)}초 남음`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  return s > 0 ? `약 ${m}분 ${s}초 남음` : `약 ${m}분 남음`;
}

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

  const subtitleMode   = useSettingsStore((s) => s.subtitleMode);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const update         = useSettingsStore((s) => s.update);

  const { t } = useTranslation();
  const { isRetranslating, retranslate, cancelRetranslation } = useRetranslate();

  const cacheKey = videoUri ? localCacheKey(videoUri) : null;

  const {
    status:              bgStatus,
    isBackgroundRunning: isBgRunning,
    enqueueTranslation,
    cancelTranslation,
    loadResult:          loadBgResult,
    clearResult:         clearBgResult,
  } = useBackgroundTranslation(cacheKey ?? undefined);

  const isBgRunningRef  = useRef(false);
  useEffect(() => { isBgRunningRef.current = isBgRunning; }, [isBgRunning]);

  const bgStatusRef = useRef<typeof bgStatus>(bgStatus);
  useEffect(() => { bgStatusRef.current = bgStatus; }, [bgStatus]);

  const bgResultApplied = useRef(false);

  // Read and consume pending SRT URI synchronously at render time.
  const initialSrtUri = useRef<string | null>(pendingSubtitleRef.current);
  if (pendingSubtitleRef.current) {
    pendingSubtitleRef.current = null;
  }
  const shimmerAnim     = useRef(new Animated.Value(0)).current;
  const bannerOpacity   = useRef(new Animated.Value(0.7)).current;
  const displayedPctRef = useRef(0);
  const rafIdRef        = useRef<number | null>(null);
  const heartbeatRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const bgDoneTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bgPrevProgressRef  = useRef<number>(0);
  const bgPrevTimestampRef = useRef<number>(0);
  const bgSecsPerPctRef    = useRef<number>(0);
  const bgUpdateCountRef   = useRef<number>(0);

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
  const [showBgDoneBanner, setShowBgDoneBanner] = useState(false);
  const [displayedPct,     setDisplayedPct]     = useState(0);
  const [bgRemainingSecs,  setBgRemainingSecs]  = useState<number | null>(null);

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
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, []);

  // ── [FIX 3-B] SQLite/BG 결과 로드 중복 실행 방지 ──────────────────────────
  const subtitleLoadedRef = useRef<string | null>(null);

  useEffect(() => {
    bgResultApplied.current = false;
    setTranslationEverCompleted(false);
    setSubtitlePhase("idle");
    setSubtitleProgress(0);
    displayedPctRef.current = 0;
    setDisplayedPct(0);
    bgPrevProgressRef.current = 0; bgPrevTimestampRef.current = 0;
    bgSecsPerPctRef.current = 0; bgUpdateCountRef.current = 0;
    setBgRemainingSecs(null);
    subtitleLoadedRef.current = null;
  }, [cacheKey]);

  useEffect(() => {
    if (!cacheKey) return;
    if (subtitleLoadedRef.current === cacheKey) return;

    (async () => {
      const bgResult = await loadBgResult(cacheKey);
      if (bgResult && !isBgRunningRef.current) {
        if (Date.now() - bgResult.completedAt > 86400000) {
          await clearBgResult(cacheKey);
        } else {
          const restored: SubtitleSegment[] = bgResult.segments.map((seg, i) => ({
            id: `local_bg_${i}_${Math.round(seg.startTime * 1000)}`,
            startTime: seg.startTime, endTime: seg.endTime,
            original: seg.original, translated: seg.translated,
          }));
          bgResultApplied.current = true;
          subtitleLoadedRef.current = cacheKey;
          setSubtitles(restored);
          setSubtitlePhase("done"); setSubtitleProgress(1); setTranslationEverCompleted(true);
          saveSubtitles(cacheKey, targetLanguage, "local", restored).catch(() => {});
          await clearBgResult(cacheKey);
          return;
        }
      }
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

  useEffect(() => {
    if (bgStatus?.status !== "done" || !cacheKey || bgResultApplied.current) return;
    (async () => {
      const result = await loadBgResult(cacheKey);
      if (!result) return;
      const restored: SubtitleSegment[] = result.segments.map((seg, i) => ({
        id: `local_bg_${i}_${Math.round(seg.startTime * 1000)}`,
        startTime: seg.startTime, endTime: seg.endTime,
        original: seg.original, translated: seg.translated,
      }));
      bgResultApplied.current = true;
      subtitleLoadedRef.current = cacheKey;
      setSubtitles(restored);
      setSubtitlePhase("done"); setSubtitleProgress(1); setTranslationEverCompleted(true);
      saveSubtitles(cacheKey, targetLanguage, "local", restored).catch(() => {});
      await clearBgResult(cacheKey);
    })();
  }, [bgStatus?.status, cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cacheKey || subtitles.length === 0 || isBgRunningRef.current) return;
    const translatedCount = subtitles.filter((s) => s.translated && s.translated.trim() !== "").length;
    if (translatedCount === subtitles.length && subtitles.length > 0) {
      setSubtitlePhase("done"); setSubtitleProgress(1); setTranslationEverCompleted(true);
      saveSubtitles(cacheKey, targetLanguage, "local", subtitles).catch(() => {});
    } else if (translatedCount > 0) {
      setSubtitlePhase("translating");
      setSubtitleProgress(subtitles.length > 0 ? translatedCount / subtitles.length : 0);
      savePartialSubtitles(cacheKey, targetLanguage, "local", subtitles, translatedCount).catch(() => {});
    } else if (subtitles.length > 0) {
      setSubtitlePhase("processing");
    }
  }, [subtitles]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const srtUri = initialSrtUri.current;
    if (!srtUri || !videoUri) return;
    initialSrtUri.current = null;

    (async () => {
      try {
        const content = await FileSystem.readAsStringAsync(srtUri);
        const segments = parseSrt(content);
        if (segments.length > 0) {
          bgResultApplied.current = true;
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

  useEffect(() => {
    if (bgStatus?.status === "done" && bgStatus.videoId === cacheKey) {
      setShowBgDoneBanner(true);
      if (bgDoneTimerRef.current) clearTimeout(bgDoneTimerRef.current);
      bgDoneTimerRef.current = setTimeout(() => setShowBgDoneBanner(false), 5000);
    }
    return () => { if (bgDoneTimerRef.current) clearTimeout(bgDoneTimerRef.current); };
  }, [bgStatus?.status, bgStatus?.videoId, cacheKey]);

  useEffect(() => {
    const bgProgress = bgStatus?.progress ?? 0;
    const isActive = isBgRunning || subtitlePhase === "processing" || subtitlePhase === "translating";
    const noProgress = isBgRunning ? bgProgress === 0 : subtitleProgress === 0;
    if (isActive && noProgress) {
      const anim = Animated.loop(Animated.timing(shimmerAnim, { toValue: 1, duration: 1200, useNativeDriver: true }));
      anim.start();
      return () => anim.stop();
    } else { shimmerAnim.setValue(0); }
  }, [isBgRunning, subtitlePhase, subtitleProgress, bgStatus?.progress, shimmerAnim]);

  useEffect(() => {
    if (!isBgRunning) { bannerOpacity.setValue(0.7); return; }
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(bannerOpacity, { toValue: 1.0, duration: 750, useNativeDriver: true }),
      Animated.timing(bannerOpacity, { toValue: 0.7, duration: 750, useNativeDriver: true }),
    ]));
    anim.start();
    return () => anim.stop();
  }, [isBgRunning, bannerOpacity]);

  const bgAnimateTo = useCallback((targetFraction: number, durationMs: number, options?: { ignoreCap?: boolean }) => {
    if (rafIdRef.current !== null) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    const real = bgStatusRef.current?.progress ?? 0;
    const clampedTarget = options?.ignoreCap ? targetFraction : Math.min(targetFraction, real + 0.03);
    const start = displayedPctRef.current;
    const diff = clampedTarget - start;
    if (Math.abs(diff) < 0.001) return;
    const startTime = performance.now();
    const frame = (now: number) => {
      if (Math.abs(clampedTarget - displayedPctRef.current) < 0.001) {
        displayedPctRef.current = clampedTarget; setDisplayedPct(clampedTarget); rafIdRef.current = null; return;
      }
      const elapsed = now - startTime;
      const t = Math.min(elapsed / durationMs, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const maxAllowed = options?.ignoreCap ? clampedTarget : Math.min(clampedTarget, (bgStatusRef.current?.progress ?? 0) + 0.03);
      const next = Math.min(start + diff * eased, maxAllowed);
      if (next > displayedPctRef.current) { displayedPctRef.current = next; setDisplayedPct(next); }
      if (t < 1) { rafIdRef.current = requestAnimationFrame(frame); } else { rafIdRef.current = null; }
    };
    rafIdRef.current = requestAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const target = bgStatus?.progress ?? 0;
    if (target <= displayedPctRef.current) return;
    bgAnimateTo(target, 800);
  }, [bgStatus?.progress, bgAnimateTo]);

  useEffect(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    const status = bgStatus?.status;
    if (!status || status === "done" || status === "error" || status === "idle") return;
    heartbeatRef.current = setInterval(() => {
      const realProgress = bgStatusRef.current?.progress ?? 0;
      const cap = Math.max(0, realProgress - 0.02);
      if (displayedPctRef.current < cap) {
        const next = Math.min(displayedPctRef.current + 0.012, cap);
        displayedPctRef.current = next; setDisplayedPct(next);
      }
    }, 600);
    return () => { if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; } };
  }, [bgStatus?.status]);

  useEffect(() => {
    if (bgStatus?.status === "done") {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      if (rafIdRef.current !== null) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
      bgAnimateTo(1, 350, { ignoreCap: true });
    }
    if (bgStatus?.status === "error" || bgStatus?.status === "idle") {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      if (rafIdRef.current !== null) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
      displayedPctRef.current = 0; setDisplayedPct(0);
    }
  }, [bgStatus?.status, bgAnimateTo]);

  useEffect(() => {
    if (!isBgRunning || !bgStatus || bgStatus.status !== "translating") {
      setBgRemainingSecs(null); bgSecsPerPctRef.current = 0;
      bgPrevProgressRef.current = 0; bgPrevTimestampRef.current = 0; return;
    }
    bgUpdateCountRef.current += 1;
    const p = bgStatus.progress ?? 0;
    const now = Date.now();
    if (bgPrevProgressRef.current > 0 && p > bgPrevProgressRef.current) {
      const deltaPct = p - bgPrevProgressRef.current;
      const elapsedS = (now - bgPrevTimestampRef.current) / 1000;
      if (elapsedS >= 0.05 && deltaPct >= 0.001) {
        const secPerPct = 1 / (deltaPct / elapsedS);
        bgSecsPerPctRef.current = bgSecsPerPctRef.current === 0 ? secPerPct : 0.7 * bgSecsPerPctRef.current + 0.3 * secPerPct;
      }
    }
    bgPrevProgressRef.current = p; bgPrevTimestampRef.current = now;
    if (bgSecsPerPctRef.current > 0 && p > 0.06) {
      const rem = Math.ceil((1 - p) * bgSecsPerPctRef.current);
      if (bgUpdateCountRef.current >= 3 && rem > 3) setBgRemainingSecs(rem);
      else if (rem <= 3) setBgRemainingSecs(rem);
    }
  }, [bgStatus, isBgRunning]);

  const startBgTranslation = useCallback(async () => {
    if (!cacheKey || !videoName) return;
    isBgRunningRef.current = true;
    bgResultApplied.current = false;
    setSubtitleProgress(0);
    setTranslationEverCompleted(false);
    clearSubtitles();
    try {
      await enqueueTranslation({ videoId: cacheKey, videoTitle: videoName, language: targetLanguage, genre: "local" });
    } catch (e: any) {
      isBgRunningRef.current = false;
      Alert.alert("오류", e?.message ?? "백그라운드 서비스를 시작할 수 없습니다.");
    }
  }, [cacheKey, videoName, targetLanguage, enqueueTranslation, clearSubtitles]);

  const handleSendToBackground = useCallback(async () => {
    if (Platform.OS === "android" && Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        { title: "알림 권한", message: "번역 완료 시 알림을 받으려면 권한이 필요합니다.", buttonPositive: "허용", buttonNegative: "거부" }
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
    }
    if (Platform.OS === "android") {
      NativeModules.TranslationService?.checkAndRequestBatteryOptimization?.().catch(() => {});
    }
    if (isBgRunning) {
      Alert.alert("백그라운드 번역 중", "현재 번역이 진행 중입니다.\n취소하고 새로 시작할까요?", [
        { text: "계속 유지", style: "cancel" },
        { text: "취소하고 새로 시작", style: "destructive", onPress: async () => { await cancelTranslation(); await startBgTranslation(); } },
      ]);
      return;
    }
    await startBgTranslation();
  }, [isBgRunning, cancelTranslation, startBgTranslation]);

  // ── 검색 모달용 seek 핸들러 ───────────────────────────────────────────────
  const handleSearchSeek = useCallback((time: number) => {
    setCurrentTime(time);
    bumpSeek();
  }, [setCurrentTime, bumpSeek]);

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

  const getBarColor = (): string => {
    if (isBgRunning) return "#6366f1";
    if (subtitlePhase === "done") return "#22c55e";
    if (subtitlePhase === "translating") return "#3b82f6";
    return "#3b82f6";
  };

  const barProgress = isBgRunning ? displayedPct : subtitleProgress;
  const showShimmer = barProgress < 0.02 && (isBgRunning || (subtitlePhase !== "idle" && subtitlePhase !== "done"));
  const showSaveBtn = subtitlePhase === "done" && !isBgRunning && subtitles.length > 0 && translationEverCompleted;

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
      {/* 자막 검색 버튼 (가로 모드) */}
      <TouchableOpacity
        style={styles.chipBtn}
        onPress={() => setSearchModalVisible(true)}
        activeOpacity={0.75}
      >
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
      </View>

      {/* BG 번역 진행 카드 */}
      {isBgRunning && (
        <Animated.View style={[progressCard.card, { opacity: bannerOpacity }]}>
          <Text style={progressCard.pct}>{Math.round(displayedPct * 100)}%</Text>
          <View style={{ flex: 1 }}>
            <Text style={progressCard.title}>{t("player.bgTranslating")}</Text>
            <Text style={progressCard.sub} numberOfLines={1}>
              {(() => {
                const p = bgStatus?.progress ?? 0;
                const st = bgStatus?.status;
                if (!st || st === "fetching") return p < 0.02 ? "번역 준비 중..." : "모델 로딩 중...";
                if (st === "saving") return "결과 저장 중...";
                if (st === "translating" && (bgStatus?.totalCount ?? 0) > 0) return `${bgStatus!.translatedCount} / ${bgStatus!.totalCount}`;
                return "번역 준비 중...";
              })()}
            </Text>
            {bgRemainingSecs !== null && bgRemainingSecs > 0 && (
              <Text style={progressCard.eta}>{formatRemaining(bgRemainingSecs)}</Text>
            )}
          </View>
          <TouchableOpacity onPress={cancelTranslation} style={progressCard.cancelBtn}>
            <Text style={progressCard.cancelBtnText}>{t("common.cancel")}</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* FG 번역 진행 카드 */}
      {!isBgRunning && (subtitlePhase === "processing" || subtitlePhase === "translating") && (
        <View style={progressCard.card}>
          <Text style={progressCard.pct}>{subtitleProgress > 0 ? `${Math.round(subtitleProgress * 100)}%` : "--"}</Text>
          <View style={{ flex: 1 }}>
            <Text style={progressCard.title}>{subtitlePhase === "processing" ? "🎙 음성 인식 중..." : t("player.translatingProgress")}</Text>
            <Text style={progressCard.sub} numberOfLines={1}>
              {subtitlePhase === "processing" ? "Whisper 처리 중..." : `${subtitles.filter((s) => s.translated).length} / ${subtitles.length}`}
            </Text>
          </View>
        </View>
      )}

      {/* BG 완료 배너 */}
      {showBgDoneBanner && (
        <View style={[progressCard.card, { backgroundColor: "#0a1f0a", borderTopColor: "#22c55e" }]}>
          <CheckCircle2 size={16} color="#22c55e" />
          <Text style={[progressCard.title, { color: "#22c55e", marginLeft: 8 }]}>{t("player.bgDone")}</Text>
        </View>
      )}

      {/* BG 오류 배너 */}
      {bgStatus?.status === "error" && (
        <View style={[progressCard.card, { backgroundColor: "#1a0a0a", borderTopColor: "#ef4444" }]}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <XCircle size={14} color="#ef4444" />
            <Text style={{ color: "#ef4444", fontSize: 11 }}>{bgStatus.error ?? "번역 실패"}</Text>
          </View>
          <TouchableOpacity onPress={handleSendToBackground} style={progressCard.cancelBtn}>
            <Text style={progressCard.cancelBtnText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 번역 진행 바 */}
      {(isBgRunning || (subtitlePhase !== "idle" && subtitlePhase !== "done")) && (
        <View style={styles.progressBarTrack}>
          {showShimmer ? (
            <Animated.View
              style={[styles.progressBarShimmer, {
                backgroundColor: getBarColor(),
                transform: [{ translateX: shimmerAnim.interpolate({ inputRange: [0, 1], outputRange: [-screenWidth * 0.4, screenWidth] }) }],
              }]}
            />
          ) : (
            <View style={[styles.progressBarFill, { width: `${Math.min(barProgress * 100, 100)}%` as any, backgroundColor: getBarColor() }]} />
          )}
        </View>
      )}

      {/* 컨트롤 바 (2행) */}
      <View style={styles.controlBar}>
        {/* 행 1 */}
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
          {/* 자막 검색 버튼 (세로 모드) */}
          <TouchableOpacity
            style={styles.chipBtn}
            onPress={() => setSearchModalVisible(true)}
            activeOpacity={0.75}
          >
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
        </View>

        {/* 행 2 (조건부) */}
        {(Platform.OS === "android" || showSaveBtn) && (
          <View style={styles.controlRow2}>
            {Platform.OS === "android" && (
              <TouchableOpacity
                style={[styles.chipBtn, styles.chipBtnFlex, isBgRunning && styles.chipBtnBgActive]}
                onPress={handleSendToBackground} activeOpacity={0.75}
              >
                <Text style={styles.chipBtnText} numberOfLines={1}>
                  {isBgRunning ? t("player.bgInProgress") : t("player.background")}
                </Text>
              </TouchableOpacity>
            )}
            {showSaveBtn && (
              <TouchableOpacity style={[styles.chipBtn, styles.chipBtnSave]} onPress={() => setSaveModalVisible(true)}>
                <Download size={13} color="#86efac" />
                <Text style={[styles.chipBtnText, styles.chipBtnSaveText]}>{t("player.save")}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
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
  progressBarShimmer: { position: "absolute", top: 0, left: 0, height: 3, width: "40%", opacity: 0.85 },
  progressBarFill: { height: 3, borderRadius: 0 },

  controlBar: { backgroundColor: "#111", paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10, gap: 6 },
  controlRow:  { flexDirection: "row", alignItems: "center", gap: 6 },
  controlRow2: { flexDirection: "row", alignItems: "center", gap: 6 },

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
  chipBtnBgActive: { borderWidth: 1, borderColor: "#6366f1", backgroundColor: "#1e1b4b" },
  chipBtnSave: { backgroundColor: "#14532d", borderWidth: 1, borderColor: "#22c55e", gap: 4 },
  chipBtnSaveText: { color: "#86efac" },

  retranslateBanner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#0f1f3d", paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#1e3a6e" },
  retranslateText: { color: "#60a5fa", fontSize: 13, fontWeight: "600" },

  captureToast: { position: "absolute", bottom: 90, alignSelf: "center", backgroundColor: "rgba(0,0,0,0.75)", borderRadius: 20, paddingHorizontal: 18, paddingVertical: 9, borderWidth: 1, borderColor: "#22c55e44" },
  captureToastText: { color: "#22c55e", fontSize: 13, fontWeight: "700" },

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