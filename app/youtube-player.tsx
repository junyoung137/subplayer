/**
 * YoutubePlayerScreen (v19)
 *
 * 변경사항 (v18 → v19):
 * ─────────────────────────────────────────────────────────────────────────────
 * [BUG FIX] 재생버튼 미작동 문제
 *   - 원인 1: current=0 (영상 미시작) 상태에서 YouTubePlayer 내부 tap 핸들러가
 *             "double-tap ignored" 처리하여 play() 명령 자체가 무시됨
 *   - 원인 2: 연속 탭 시 play() → pause() 순서 역전으로 상태 충돌 발생
 *   - 수정: optimisticPlaying 로컬 state + debounce ref 로 해결.
 *           버튼 탭 시 optimisticPlaying 즉시 토글 (UI 즉각 반응).
 *           300ms debounce 후 실제 ref.play()/pause() 1회만 호출.
 *           isPlaying store 상태는 오직 onStateChange 이벤트에서만 업데이트 (단방향).
 *           play prop 추가 없음 — YouTubePlayerHandle ref 메서드만 사용.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useRef, useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  Animated,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  Pressable,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
  PanResponder,
  StatusBar,
  Platform,
  PermissionsAndroid,
  NativeModules,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ScreenOrientation from "expo-screen-orientation";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  YouTubePlayer,
  YouTubePlayerHandle,
  SubtitleFetchResult,
} from "../components/YouTubePlayer";
import { TimedTextSegment } from "../services/youtubeTimedText";
import { SubtitleOverlay } from "../components/SubtitleOverlay";
import { SubtitleQuickPanel } from "../components/SubtitleQuickPanel";
import { SubtitleSaveModal } from "../components/SubtitleSaveModal";
import { VideoSearchModal } from "../components/VideoSearchModal";
import { useMediaProjectionProcessor } from "../hooks/useMediaProjectionProcessor";
import { useWhisperModel } from "../hooks/useWhisperModel";
import { LANGUAGES, getLanguageByCode } from "../constants/languages";
import { useRetranslate } from "../hooks/useRetranslate";
import { Settings, Check, CheckCircle2, XCircle, AlertTriangle, Mic, Search, Loader2, Globe, CheckCircle, AlertCircle, Radio, RotateCcw, Brain, Clock, Minimize2 } from 'lucide-react-native';
import { useBackgroundTranslation } from '../hooks/useBackgroundTranslation';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from "expo-file-system/legacy";
import { pendingSubtitleRef } from "../utils/pendingSubtitle";
import { parseSrt } from "../utils/srtParser";
import {
  loadModel as loadGemma,
  unloadModel as unloadGemma,
  translateSegments,
  cancelFgInference,
} from "../services/gemmaTranslationService";
import { getLocalModelPath } from "../services/modelDownloadService";
import { SubtitleSegment } from "../store/usePlayerStore";
import {
  loadSubtitles,
  saveSubtitles,
  savePartialSubtitles,
  makeSegmentId,
} from "../services/subtitleDB";

// ── 상수 ─────────────────────────────────────────────────────────────────────

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function speedLabel(rate: number): string {
  return Number.isInteger(rate) ? `${rate}.0x` : `${rate}x`;
}

function fmt(sec: number): string {
  if (!sec || isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── 자막 phase 타입 ───────────────────────────────────────────────────────────

type SubtitlePhase =
  | "idle"
  | "fetching"
  | "resuming"
  | "translating"
  | "done"
  | "error"
  | "no_subtitles"
  | "fallback_whisper";

function formatRemaining(secs: number): string {
  if (secs <= 0) return '';
  if (secs <= 3)  return '거의 완료';
  if (secs < 60)  return `약 ${Math.ceil(secs)}초 남음`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  return s > 0 ? `약 ${m}분 ${s}초 남음` : `약 ${m}분 남음`;
}

function getSubtitleStatusLabel(phase: SubtitlePhase, progress: number, tFn: (key: string, opts?: any) => string): string {
  switch (phase) {
    case "fetching":         return tFn("player.statusFetching");
    case "resuming":         return tFn("player.statusResuming");
    case "translating":      return tFn("player.statusTranslating", { percent: Math.round(progress * 100) });
    case "done":             return tFn("player.statusDone");
    case "no_subtitles":     return tFn("player.statusNoSubtitles");
    case "fallback_whisper": return tFn("player.statusWhisper");
    case "error":            return tFn("player.statusError");
    default:                 return "";
  }
}

// ── 시크바 ────────────────────────────────────────────────────────────────────

function YoutubeSeekBar({
  currentTime,
  duration,
  onSeek,
  onSeekStart,
  onSeekMove,
  onSeekEnd,
}: {
  currentTime: number;
  duration: number;
  onSeek: (t: number) => void;
  onSeekStart?: (t: number) => void;
  onSeekMove?: (t: number) => void;
  onSeekEnd?: (t: number) => void;
}) {
  const barWidthRef = useRef(0);
  const getTimeRef  = useRef((x: number) => {
    const bw = barWidthRef.current;
    if (bw <= 0 || duration <= 0) return 0;
    return Math.min(Math.max((x / bw) * duration, 0), duration);
  });
  getTimeRef.current = (x: number) => {
    const bw = barWidthRef.current;
    if (bw <= 0 || duration <= 0) return 0;
    return Math.min(Math.max((x / bw) * duration, 0), duration);
  };

  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onSeekStartRef = useRef(onSeekStart);
  onSeekStartRef.current = onSeekStart;
  const onSeekMoveRef = useRef(onSeekMove);
  onSeekMoveRef.current = onSeekMove;
  const onSeekEndRef = useRef(onSeekEnd);
  onSeekEndRef.current = onSeekEnd;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder:        () => true,
      onMoveShouldSetPanResponder:         () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture:  () => true,
      onPanResponderGrant: (e) => {
        const t = getTimeRef.current(e.nativeEvent.locationX);
        if (onSeekStartRef.current) onSeekStartRef.current(t);
        else onSeekRef.current(t);
      },
      onPanResponderMove: (e) => {
        const t = getTimeRef.current(e.nativeEvent.locationX);
        if (onSeekMoveRef.current) onSeekMoveRef.current(t);
        else onSeekRef.current(t);
      },
      onPanResponderRelease: (e) => {
        const t = getTimeRef.current(e.nativeEvent.locationX);
        if (onSeekEndRef.current) onSeekEndRef.current(t);
        else onSeekRef.current(t);
      },
    })
  ).current;

  const pct = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

  return (
    <View
      style={sk.hitArea}
      onLayout={(e) => { barWidthRef.current = e.nativeEvent.layout.width; }}
      {...pan.panHandlers}
    >
      <View style={sk.track}>
        <View style={[sk.fill, { width: `${(pct * 100).toFixed(2)}%` as any }]} />
      </View>
      <View style={[sk.thumb, { left: `${(pct * 100).toFixed(2)}%` as any }]} />
    </View>
  );
}

const sk = StyleSheet.create({
  hitArea: { width: "100%", height: 36, justifyContent: "center", position: "relative" },
  track:   { width: "100%", height: 3, backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 2, overflow: "hidden" },
  fill:    { height: "100%", backgroundColor: "#ff0000", borderRadius: 2 },
  thumb:   { position: "absolute", top: "50%", width: 14, height: 14, borderRadius: 7, backgroundColor: "#fff", marginTop: -7, marginLeft: -7 },
});

// ── 메인 화면 ─────────────────────────────────────────────────────────────────

export default function YoutubePlayerScreen() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  // ── Store ─────────────────────────────────────────────────────────────────
  const youtubeVideoId  = usePlayerStore((s) => s.youtubeVideoId);
  const videoName       = usePlayerStore((s) => s.videoName);
  const isPlaying       = usePlayerStore((s) => s.isPlaying);
  const setPlaying      = usePlayerStore((s) => s.setPlaying);
  const currentTime     = usePlayerStore((s) => s.currentTime);
  const duration        = usePlayerStore((s) => s.duration);
  const subtitles       = usePlayerStore((s) => s.subtitles);
  const setSubtitles    = usePlayerStore((s) => s.setSubtitles);
  const clearSubtitles  = usePlayerStore((s) => s.clearSubtitles);
  const setCurrentTime  = usePlayerStore((s) => s.setCurrentTime);
  const bumpSeek        = usePlayerStore((s) => s.bumpSeek);
  const setPendingGenre = usePlayerStore((s) => s.setPendingGenre);

  const _initialGenre = usePlayerStore.getState().pendingGenre ?? "general";

  const subtitleMode   = useSettingsStore((s) => s.subtitleMode);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const update         = useSettingsStore((s) => s.update);

  // ── 훅 ───────────────────────────────────────────────────────────────────
  const { t } = useTranslation();
  const GENRE_OPTIONS = [
    { key: "general",      label: t("genre.general") },
    { key: "tech lecture", label: t("genre.techLecture") },
    { key: "comedy",       label: t("genre.comedy") },
    { key: "news",         label: t("genre.news") },
    { key: "documentary",  label: t("genre.documentary") },
    { key: "gaming",       label: t("genre.gaming") },
    { key: "education",    label: t("genre.education") },
  ];
  const { loaded: modelLoaded } = useWhisperModel();
  const {
    status: whisperStatus,
    start:  startWhisper,
    stop:   stopWhisper,
  } = useMediaProjectionProcessor();

  const { isRetranslating } = useRetranslate();

  const {
    status:              bgStatus,
    isBackgroundRunning: isBgRunning,
    pendingTaskTitle,
    enqueueTranslation,
    cancelTranslation,
    loadResult:          loadBgResult,
    clearResult:         clearBgResult,
  } = useBackgroundTranslation(youtubeVideoId ?? undefined);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const ytPlayerRef            = useRef<YouTubePlayerHandle>(null);
  const gemmaLoadedRef         = useRef(false);
  const cancelledRef           = useRef(false);
  const lastFetchResult        = useRef<SubtitleFetchResult | null>(null);
  const allSegmentsRef         = useRef<SubtitleFetchResult | null>(null);
  const translationCacheRef    = useRef<Map<string, string>>(new Map());
  const whisperStartedRef      = useRef(false);
  const partialTranslationsRef = useRef<Map<string, string>>(new Map());
  const jobIdRef               = useRef(0);
  const rafHandleRef           = useRef<number | null>(null);
  const bgResultApplied        = useRef(false);
  const autoFetchCompletedRef  = useRef(false);
  const srtModeActiveRef       = useRef(false);

  const initialSrtUri = useRef<string | null>(null);
  const shimmerAnim            = useRef(new Animated.Value(0)).current;
  const bannerOpacity          = useRef(new Animated.Value(0.7)).current;
  const lastProgressTimestampRef = useRef<number>(0);

  // optimisticPlaying: 버튼 탭 시 UI 즉각 반응용 로컬 state
  // 실제 isPlaying store 상태는 오직 onStateChange 이벤트에서만 업데이트 (단방향)
  const [optimisticPlaying, setOptimisticPlaying] = useState(false);
  const optimisticPlayingRef  = useRef(false);
  const [fullscreenOverlayVisible, setFullscreenOverlayVisible] = useState(false);

  // Animation refs for smooth progress bar interpolation
  const animProgressRef = useRef(0);
  const animFrameRef    = useRef<number | null>(null);
  const animTargetRef   = useRef(0);

  // BG smooth progress interpolation
  const displayedPctRef = useRef(0);
  const rafIdRef        = useRef<number | null>(null);
  const heartbeatRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  // FG remaining-time estimation refs
  const batchStartTimeRef   = useRef<number>(0);
  const lastCompletedRef    = useRef<number>(0);
  const secsPerSegmentRef   = useRef<number>(0);
  const fgAnimThrottleRef   = useRef<number>(0);

  // BG remaining-time estimation refs
  const bgPrevProgressRef  = useRef<number>(0);
  const bgPrevTimestampRef = useRef<number>(0);
  const bgSecsPerPctRef    = useRef<number>(0);
  const bgUpdateCountRef   = useRef<number>(0);

  const isBgRunningRef = useRef(false);
  useEffect(() => {
    isBgRunningRef.current = isBgRunning;
  }, [isBgRunning]);

  const bgStatusRef = useRef<typeof bgStatus>(bgStatus);
  useEffect(() => {
    bgStatusRef.current = bgStatus;
  }, [bgStatus]);

  // Unified progress high-water mark
  const highWaterProgressRef = useRef(0);

  // ── Genre-restore race guards ─────────────────────────────────────────────
  const currentVideoIdRef  = useRef<string | null>(null);
  const playerReadyOnceRef = useRef(false);
  const genreReadyRef      = useRef(true);
  const genreValueRef      = useRef(_initialGenre);

  // ── Local state ───────────────────────────────────────────────────────────
  const [langModalVisible,     setLangModalVisible]     = useState(false);
  const [subtitlePanelVisible, setSubtitlePanelVisible] = useState(false);
  const [genreModalVisible,    setGenreModalVisible]    = useState(false);
  const [saveModalVisible,     setSaveModalVisible]     = useState(false);
  const [searchModalVisible,   setSearchModalVisible]   = useState(false);
  const [speedIdx,             setSpeedIdx]             = useState(2);
  const [selectedGenre,        setSelectedGenre]        = useState(_initialGenre);
  const isLandscape = screenWidth > screenHeight;
  const navigation  = useNavigation();

  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, []);

  useEffect(() => {
    StatusBar.setHidden(isLandscape);
    return () => { StatusBar.setHidden(false); };
  }, [isLandscape]);

  const [subtitlePhase,    setSubtitlePhase_DO_NOT_CALL] = useState<SubtitlePhase>("idle");
  const subtitlePhaseRef = useRef<SubtitlePhase>("idle");
  const [subtitleProgress, setSubtitleProgress] = useState(0);
  const [totalSegments,    setTotalSegments]     = useState(0);
  const [translatedCount,  setTranslatedCount]   = useState(0);
  const [remainingSecs,    setRemainingSecs]      = useState<number | null>(null);
  const [bgRemainingSecs,  setBgRemainingSecs]    = useState<number | null>(null);
  const [displayedPct,     setDisplayedPct]       = useState(0);
  const [translationEverCompleted, setTranslationEverCompleted] = useState(false);
  const [usingWhisper,     setUsingWhisper]      = useState(false);
  const [showBgDoneBanner, setShowBgDoneBanner]  = useState(false);
  const bgDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isStale, setIsStale] = useState(false);

  // ── Loading sub-label ──────────────────────────────────────────────────────
  const [loadingSubLabel, setLoadingSubLabel] = useState<string>('');
  const loadingSubLabelRef = useRef<string>('');
  const setLoadingLabel = useCallback((label: string) => {
    setLoadingSubLabel(label);
    loadingSubLabelRef.current = label;
  }, []);

  const setPhase = useCallback((phase: SubtitlePhase) => {
    subtitlePhaseRef.current = phase;
    setSubtitlePhase_DO_NOT_CALL(phase);
  }, []);

  const playbackRate = SPEEDS[speedIdx];
  const videoHeight  = Math.round(screenWidth * (9 / 16));
  const playerHeight = isLandscape ? screenHeight : videoHeight;

  // ── 라우팅 가드 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!youtubeVideoId) router.back();
  }, [youtubeVideoId]);

  // ── 화면 unmount 시 정리 ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      const bgSt = bgStatusRef.current?.status;
      const bgActive = isBgRunningRef.current
        || bgSt === 'fetching'
        || bgSt === 'translating'
        || bgSt === 'saving';

      if (!bgActive) {
        cancelledRef.current = true;
        jobIdRef.current++;
        cancelFgInference();
      }

      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (portraitSeekTimerRef.current) clearTimeout(portraitSeekTimerRef.current);
      animProgressRef.current = 0;
      animTargetRef.current   = 0;
      if (gemmaLoadedRef.current && !bgActive) {
        unloadGemma().catch(() => {});
        gemmaLoadedRef.current = false;
      }
      ScreenOrientation.unlockAsync().catch(() => {});
      if (youtubeVideoId) {
        AsyncStorage.removeItem(`fg_fetched_subtitles_${youtubeVideoId}`).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── SRT fallback: handles case where handlePlayerReady fired before pendingSubtitleRef was set ──
  useEffect(() => {
    const srtUri = pendingSubtitleRef.current;
    if (!srtUri) return;
    pendingSubtitleRef.current = null;
    initialSrtUri.current = srtUri;
    srtModeActiveRef.current = true;
    (async () => {
      try {
        const { readAsStringAsync } = await import('expo-file-system/legacy');
        const content = await readAsStringAsync(srtUri);
        const segments = parseSrt(content);
        if (segments.length > 0) {
          bgResultApplied.current = true;
          autoFetchCompletedRef.current = true;
          cancelledRef.current = true;
          jobIdRef.current++;
          setSubtitles(segments);
          setPhase('done');
          setSubtitleProgress(1);
          setTotalSegments(segments.length);
          setTranslatedCount(segments.length);
          setTranslationEverCompleted(true);
          ytPlayerRef.current?.disableCaptions?.();
        }
      } catch (e) {
        console.warn('[SRT useEffect] Failed to load SRT:', e);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    highWaterProgressRef.current = 0;
    secsPerSegmentRef.current = 0;
    bgUpdateCountRef.current = 0;
    setRemainingSecs(null);
  }, [youtubeVideoId, targetLanguage, selectedGenre]);

  // ── no_subtitles → Whisper 전환 ──────────────────────────────────────────
  useEffect(() => {
    if (subtitlePhase !== "no_subtitles") return;
    if (usingWhisper) return;
    if (whisperStartedRef.current) return;

    whisperStartedRef.current = true;
    setUsingWhisper(true);
    setPhase("fallback_whisper");

    Alert.alert(
      t("player.noSubtitlesTitle"),
      t("player.noSubtitlesMessage"),
      [{ text: t("player.noSubtitlesConfirm") }]
    );
    if (modelLoaded) startWhisper();
  }, [subtitlePhase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── bg done 배너 자동 숨김 ───────────────────────────────────────────────
  useEffect(() => {
    if (bgStatus?.status === 'done' && bgStatus.videoId === youtubeVideoId) {
      setShowBgDoneBanner(true);
      if (bgDoneTimerRef.current) clearTimeout(bgDoneTimerRef.current);
      bgDoneTimerRef.current = setTimeout(() => setShowBgDoneBanner(false), 5000);
    }
    return () => {
      if (bgDoneTimerRef.current) clearTimeout(bgDoneTimerRef.current);
    };
  }, [bgStatus?.status, bgStatus?.videoId, youtubeVideoId]);

  // ── Shimmer animation
  useEffect(() => {
    const phase: SubtitlePhase = usingWhisper
      ? (whisperStatus.isRunning ? 'fallback_whisper' : 'idle')
      : subtitlePhase;

    const bgProgress = bgStatus?.progress ?? 0;
    const activePhase = isBgRunning || (phase !== 'idle' && phase !== 'done');
    const noRealProgress = isBgRunning ? bgProgress === 0 : subtitleProgress === 0;

    if (activePhase && noRealProgress) {
      const animation = Animated.loop(
        Animated.timing(shimmerAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        })
      );
      animation.start();
      return () => animation.stop();
    } else {
      shimmerAnim.setValue(0);
    }
  }, [isBgRunning, usingWhisper, whisperStatus.isRunning, subtitlePhase, subtitleProgress, bgStatus?.progress, shimmerAnim]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pulsing opacity animation for background banner
  useEffect(() => {
    if (!isBgRunning) {
      bannerOpacity.setValue(0.7);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(bannerOpacity, { toValue: 1.0, duration: 750, useNativeDriver: true }),
        Animated.timing(bannerOpacity, { toValue: 0.7, duration: 750, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [isBgRunning, bannerOpacity]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Staleness detection
  useEffect(() => {
    const bgProg = bgStatus?.progress ?? 0;
    if (subtitleProgress > 0 || bgProg > 0) {
      lastProgressTimestampRef.current = Date.now();
      setIsStale(false);
    }
  }, [subtitleProgress, bgStatus?.progress]);

  useEffect(() => {
    if (subtitlePhase === 'idle' || subtitlePhase === 'done' || subtitlePhase === 'fetching') {
      setIsStale(false);
      lastProgressTimestampRef.current = 0;
    }
  }, [subtitlePhase]);

  useEffect(() => {
    const interval = setInterval(() => {
      const activePhase =
        subtitlePhase === 'translating' || subtitlePhase === 'resuming' || isBgRunning;
      const stillInLoadingStage = loadingSubLabelRef.current !== '';
      if (!activePhase || lastProgressTimestampRef.current === 0) return;
      if (stillInLoadingStage) return;
      if (Date.now() - lastProgressTimestampRef.current > 30_000) {
        setIsStale(true);
      }
    }, 5_000);
    return () => clearInterval(interval);
  }, [subtitlePhase, isBgRunning]);

  // ── BG remaining-time estimation ─────────────────────────────────────────
  useEffect(() => {
    if (!isBgRunning || !bgStatus || bgStatus.status !== 'translating') {
      setBgRemainingSecs(null);
      bgSecsPerPctRef.current = 0;
      bgPrevProgressRef.current = 0;
      bgPrevTimestampRef.current = 0;
      return;
    }
    bgUpdateCountRef.current += 1;
    const p   = bgStatus.progress ?? 0;
    const now = Date.now();
    if (
      bgPrevProgressRef.current > 0 &&
      p > bgPrevProgressRef.current
    ) {
      const deltaPct  = p - bgPrevProgressRef.current;
      const elapsedMs = now - bgPrevTimestampRef.current;
      const elapsedS  = elapsedMs / 1000;
      if (elapsedS >= 0.05 && deltaPct >= 0.001) {
        const rate = deltaPct / elapsedS;
        const secPerPct = 1 / rate;
        bgSecsPerPctRef.current =
          bgSecsPerPctRef.current === 0
            ? secPerPct
            : 0.7 * bgSecsPerPctRef.current + 0.3 * secPerPct;
      }
    }
    bgPrevProgressRef.current  = p;
    bgPrevTimestampRef.current = now;
    if (bgSecsPerPctRef.current > 0 && p > 0.06) {
      const remainingSecs = (1 - p) * bgSecsPerPctRef.current;
      const clamped = Math.ceil(remainingSecs);
      if (bgUpdateCountRef.current >= 3 && clamped > 3) {
        setBgRemainingSecs(clamped);
      } else if (clamped <= 3) {
        setBgRemainingSecs(clamped);
      }
    }
  }, [bgStatus, isBgRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BG smooth progress bar ────────────────────────────────────────────────
  const bgAnimateTo = useCallback((
    targetFraction: number,
    durationMs: number,
    options?: { ignoreCap?: boolean },
  ) => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const real          = bgStatusRef.current?.progress ?? 0;
    const clampedTarget = options?.ignoreCap
      ? targetFraction
      : Math.min(targetFraction, real + 0.03);

    const start = displayedPctRef.current;
    const diff  = clampedTarget - start;
    if (Math.abs(diff) < 0.001) return;

    const startTime = performance.now();

    const frame = (now: number) => {
      if (Math.abs(clampedTarget - displayedPctRef.current) < 0.001) {
        displayedPctRef.current = clampedTarget;
        setDisplayedPct(clampedTarget);
        rafIdRef.current = null;
        return;
      }

      const elapsed = now - startTime;
      const t       = Math.min(elapsed / durationMs, 1);
      const eased   = 1 - Math.pow(1 - t, 3);

      const currentReal = bgStatusRef.current?.progress ?? 0;
      const maxAllowed  = options?.ignoreCap
        ? clampedTarget
        : Math.min(clampedTarget, currentReal + 0.03);

      const next = Math.min(start + diff * eased, maxAllowed);

      if (next > displayedPctRef.current) {
        displayedPctRef.current = next;
        setDisplayedPct(next);
      }

      if (t < 1) {
        rafIdRef.current = requestAnimationFrame(frame);
      } else {
        rafIdRef.current = null;
      }
    };

    rafIdRef.current = requestAnimationFrame(frame);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BG progress: react to real progress updates ───────────────────────────
  useEffect(() => {
    const target = bgStatus?.progress ?? 0;
    if (target <= displayedPctRef.current) return;
    bgAnimateTo(target, 800);
  }, [bgStatus?.progress, bgAnimateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BG progress: heartbeat nudge between batch callbacks ─────────────────
  useEffect(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);

    const status = bgStatus?.status;
    if (!status || status === 'done' || status === 'error' || status === 'idle') return;

    heartbeatRef.current = setInterval(() => {
      const realProgress = bgStatusRef.current?.progress ?? 0;
      const cap = Math.max(0, realProgress - 0.02);
      if (displayedPctRef.current < cap) {
        const next = Math.min(displayedPctRef.current + 0.012, cap);
        displayedPctRef.current = next;
        setDisplayedPct(next);
      }
    }, 600);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [bgStatus?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BG progress: done / error / idle transitions ──────────────────────────
  useEffect(() => {
    if (bgStatus?.status === 'done') {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      bgAnimateTo(1, 350, { ignoreCap: true });
    }

    if (bgStatus?.status === 'error' || bgStatus?.status === 'idle') {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      displayedPctRef.current = 0;
      setDisplayedPct(0);
    }
  }, [bgStatus?.status, bgAnimateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BG progress: unmount cleanup ─────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, []);

  // ── Genre restore from player store ──────────────────────────────────────
  useEffect(() => {
    const g = usePlayerStore.getState().pendingGenre ?? "general";
    currentVideoIdRef.current  = youtubeVideoId;
    playerReadyOnceRef.current = false;
    genreValueRef.current      = g;
    genreReadyRef.current      = true;
    setSelectedGenre(g);
    setPendingGenre(null);
  }, [youtubeVideoId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (srtModeActiveRef.current) return; // SRT mode — don't reset pipeline guards
    bgResultApplied.current      = false;
    autoFetchCompletedRef.current = false;
    allSegmentsRef.current    = null;

    if (
      isBgRunning &&
      bgStatus?.videoId &&
      bgStatus.videoId !== youtubeVideoId
    ) {
      cancelTranslation();
    }
  }, [youtubeVideoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── bg 번역 결과 복원 ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!youtubeVideoId) return;
    (async () => {
      if (srtModeActiveRef.current) return; // SRT mode — skip bg result restore
      const result = await loadBgResult(youtubeVideoId);
      if (!result) return;
      if (isBgRunningRef.current) return;
      if (bgStatus?.status === 'done') return;
      if (Date.now() - result.completedAt > 86400000) {
        await clearBgResult(youtubeVideoId);
        return;
      }
      console.log(`[YT_SCREEN] Restoring bg result on mount: ${result.segments.length} segs`);
      const restored = result.segments.map((seg, i) => ({
        id:         `bg_${i}_${Math.round(seg.startTime * 1000)}`,
        startTime:  seg.startTime,
        endTime:    seg.endTime,
        original:   seg.original,
        translated: seg.translated,
      }));
      bgResultApplied.current = true;
      setSubtitles(restored);
      setPhase('done');
      setSubtitleProgress(1);
      setTotalSegments(restored.length);
      setTranslatedCount(restored.length);
      saveSubtitles(youtubeVideoId, result.language, selectedGenre, restored).catch(() => {});
      await clearBgResult(youtubeVideoId);
    })();
  }, [youtubeVideoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BG 번역 완료 시 자동 자막 적용 ──────────────────────────────────────────
  useEffect(() => {
    if (bgStatus?.status !== 'done' || !youtubeVideoId) return;
    if (bgResultApplied.current) return;

    (async () => {
      const result = await loadBgResult(youtubeVideoId);
      if (!result) return;
      const restored: SubtitleSegment[] = result.segments.map((seg, i) => ({
        id:         `bg_${i}_${Math.round(seg.startTime * 1000)}`,
        startTime:  seg.startTime,
        endTime:    seg.endTime,
        original:   seg.original,
        translated: seg.translated,
      }));
      bgResultApplied.current = true;
      jobIdRef.current++;
      cancelledRef.current = true;
      const bgFetchResult: SubtitleFetchResult = {
        segments: restored.map(s => ({ startTime: s.startTime, endTime: s.endTime, text: s.original })),
        language: result.language,
        source: 'bg',
      };
      allSegmentsRef.current  = bgFetchResult;
      lastFetchResult.current = bgFetchResult;
      setSubtitles(restored);
      setPhase('done');
      setSubtitleProgress(1);
      setTotalSegments(restored.length);
      setTranslatedCount(restored.length);
      setTranslationEverCompleted(true);
      saveSubtitles(youtubeVideoId, result.language, selectedGenre, restored).catch(() => {});
      await clearBgResult(youtubeVideoId);
      console.log(`[YT_SCREEN] BG result auto-applied while screen open: ${restored.length} segs`);
    })();
  }, [bgStatus?.status, youtubeVideoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Gemma 지연 로드 ──────────────────────────────────────────────────────
  const ensureGemma = async (): Promise<boolean> => {
    if (gemmaLoadedRef.current) return true;
    const path = await getLocalModelPath();
    if (!path) {
      console.warn("[YT_SCREEN] Gemma 없음 — 원문만 표시");
      return false;
    }
    await loadGemma();
    gemmaLoadedRef.current = true;
    return true;
  };

  // ── throttled setSubtitles
  const scheduleSetSubtitles = useCallback((subs: SubtitleSegment[], callerJobId: number) => {
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
    }
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      if (callerJobId !== jobIdRef.current) return;
      setSubtitles(subs);
    });
  }, [setSubtitles]);

  // ── Smooth progress bar animation ─────────────────────────────────────
  const animateTo = useCallback((target: number) => {
    animTargetRef.current = target;
    if (animFrameRef.current !== null) return;

    const duration  = 400;
    const startVal  = animProgressRef.current;
    const startTime = performance.now();

    function frame(now: number) {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const value = animProgressRef.current
        + (animTargetRef.current - animProgressRef.current) * eased;
      animProgressRef.current = value;
      setSubtitleProgress(value);
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(frame);
      } else {
        animProgressRef.current = animTargetRef.current;
        setSubtitleProgress(animTargetRef.current);
        animFrameRef.current = null;
      }
    }
    animFrameRef.current = requestAnimationFrame(frame);
  }, []);

  // ── Segmented progress crawl ───────────────────────────────────────────
  const startCrawl = useCallback((
    fromVal: number,
    toVal: number,
    duration: number,
    jobId: number,
    onComplete?: () => void,
  ) => {
    const crawlStart = performance.now();
    let crawlLastRender = 0;
    const effectiveStart = Math.max(fromVal, animProgressRef.current);

    const crawlFrame = () => {
      const now     = performance.now();
      const elapsed = now - crawlStart;
      const t       = Math.min(elapsed / duration, 1);

      if (jobId !== jobIdRef.current)             return;
      if (animProgressRef.current > toVal)        return;
      if (t >= 1)                                 { onComplete?.(); return; }

      const value = effectiveStart + (toVal - effectiveStart) * t;

      if (value > animProgressRef.current && now - crawlLastRender >= 200) {
        animProgressRef.current = value;
        setSubtitleProgress(value);
        crawlLastRender = now;
      }

      requestAnimationFrame(crawlFrame);
    };
    requestAnimationFrame(crawlFrame);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 번역 파이프라인 ──────────────────────────────────────────────────────
  const translateFromResult = useCallback(async (
    result: SubtitleFetchResult,
    langOverride?: string,
    genreOverride?: string,
    existingTranslations?: Map<string, string> | null,
  ) => {
    if (bgResultApplied.current) {
      console.log('[TRANSLATE] BG result already applied, skipping FG translation');
      return;
    }

    if (isBgRunningRef.current) {
      console.log('[TRANSLATE] BG translation running, skipping FG translation');
      return;
    }

    const myJobId = ++jobIdRef.current;
    cancelledRef.current = false;

    if (!result || result.segments.length === 0) {
      setPhase("no_subtitles");
      return;
    }

    const useLang  = langOverride  ?? targetLanguage;
    const useGenre = genreOverride ?? genreValueRef.current;
    const isResume = (existingTranslations?.size ?? 0) > 0;

    console.log(
      `[TRANSLATE] ▶ job=${myJobId}, segs=${result.segments.length}, ` +
      `lang=${useLang}, genre=${useGenre}, resume=${isResume}`
    );

    const originalOnly: SubtitleSegment[] = (result.segments ?? [])
      .filter((seg) => seg != null && seg.text != null)
      .map((seg) => {
        const sid = makeSegmentId(seg.startTime, seg.endTime);
        return {
          id:         sid,
          startTime:  seg.startTime,
          endTime:    seg.endTime,
          original:   seg.text,
          translated: existingTranslations?.get(sid) ?? "",
        };
      });

    setSubtitles(originalOnly);
    setTotalSegments(result.segments.length);
    setTranslatedCount(0);
    setPhase(isResume ? "resuming" : "translating");
    setSubtitleProgress(0);
    batchStartTimeRef.current  = 0;
    lastCompletedRef.current   = 0;
    secsPerSegmentRef.current  = 0;
    setRemainingSecs(null);
    if (!isResume) setLoadingLabel('');

    setLoadingLabel(t("player.loadingModel"));
    const hasGemma = await ensureGemma();
    if (isBgRunningRef.current || myJobId !== jobIdRef.current) return;

    if (isResume) {
      setLoadingLabel(t("player.loadingRestoring"));
    } else {
      setLoadingLabel(t("player.loadingAnalyzing"));

      const jobIdAtProbe = myJobId;
      AsyncStorage.getItem(`gemma_checkpoint_v4_${youtubeVideoId ?? ''}`)
        .then(v => {
          if (!v) return;
          if (jobIdAtProbe !== jobIdRef.current) return;
          setLoadingLabel(t("player.loadingRestoring"));
        })
        .catch(() => {});
    }

    if (!isResume) {
      animateTo(0.12);

      const crawlStartJobId = myJobId;

      requestAnimationFrame(() => {
        if (crawlStartJobId !== jobIdRef.current) return;

        const startFrom = Math.max(animProgressRef.current, 0.12);
        if (animProgressRef.current < startFrom) {
          animProgressRef.current = startFrom;
        }

        startCrawl(startFrom, 0.15, 8_000, myJobId, () => {
          startCrawl(0.15, 0.20, 5_000, myJobId);
        });
      });
    }

    if (!hasGemma) {
      setPhase("done");
      setRemainingSecs(null);
      animateTo(1);
      setTranslationEverCompleted(true);
      saveSubtitles(youtubeVideoId ?? "default", useLang, useGenre, originalOnly).catch(() => {});
      return;
    }

    type InputItem = { id: string; start: number; end: number; text: string };
    const inputFiltered: InputItem[] = result.segments
      .map((seg) => ({
        id:    makeSegmentId(seg.startTime, seg.endTime),
        start: seg.startTime,
        end:   seg.endTime,
        text:  seg.text,
      }))
      .filter((seg) => {
        if (!existingTranslations) return true;
        const existing = existingTranslations.get(seg.id);
        return !existing || existing.trim() === "";
      });

    const alreadyDoneCount = result.segments.length - inputFiltered.length;

    if (inputFiltered.length === 0) {
      setPhase("done");
      setRemainingSecs(null);
      animateTo(1);
      setTranslatedCount(result.segments.length);
      setTranslationEverCompleted(true);
      saveSubtitles(youtubeVideoId ?? "default", useLang, useGenre, originalOnly).catch(() => {});
      return;
    }

    const langName = getLanguageByCode(useLang)?.name ?? useLang;
    const translateInput = inputFiltered.map((seg) => ({
      start:      seg.start,
      end:        seg.end,
      text:       seg.text,
      translated: "",
    }));

    try {
      const translated = await translateSegments(
        translateInput,
        (completed, total, partial) => {
          if (loadingSubLabelRef.current !== '') {
            setLoadingLabel('');
          }
          if (myJobId !== jobIdRef.current) return;
          if (isBgRunningRef.current) return;

          const totalDone = alreadyDoneCount + completed;
          const totalAll  = total;
          setTranslatedCount(totalDone);
          const newProgress = totalAll > 0 ? totalDone / totalAll : 0;
          if (newProgress > animProgressRef.current) animateTo(newProgress);

          const now = performance.now();
          if (lastCompletedRef.current > 0 && completed > lastCompletedRef.current) {
            const delta   = completed - lastCompletedRef.current;
            const elapsed = (now - batchStartTimeRef.current) / 1000;
            if (elapsed >= 0.05) {
              const rate = delta / elapsed;
              const secPerSeg = 1 / rate;
              if (secsPerSegmentRef.current === 0) {
                secsPerSegmentRef.current = secPerSeg;
              } else {
                secsPerSegmentRef.current =
                  0.7 * secsPerSegmentRef.current + 0.3 * secPerSeg;
              }
            }
          }
          batchStartTimeRef.current = now;
          lastCompletedRef.current  = completed;

          const remaining = totalAll - totalDone;
          if (
            secsPerSegmentRef.current > 0.02 &&
            remaining > 0 &&
            completed > 5
          ) {
            const nextEstimate = remaining * secsPerSegmentRef.current;
            setRemainingSecs(prev => {
              if (prev === null) return Math.ceil(nextEstimate);
              const clamped = Math.min(prev * 1.3, Math.max(prev * 0.7, nextEstimate));
              return Math.ceil(clamped);
            });
          } else {
            setRemainingSecs(null);
          }

          const shouldUpdateUI = (completed % 3 === 0) || (completed === total);

          if (shouldUpdateUI) {
            const newTranslatedMap = new Map<string, string>();
            partial?.forEach((p, idx) => {
              const item = inputFiltered[idx];
              if (p?.translated && item) {
                newTranslatedMap.set(item.id, p.translated);
              }
            });

            const updatedSubs: SubtitleSegment[] = originalOnly.map((sub) => ({
              ...sub,
              translated: newTranslatedMap.get(sub.id) ?? sub.translated ?? "",
            }));

            setPhase("translating");
            scheduleSetSubtitles(updatedSubs, myJobId);

            savePartialSubtitles(
              youtubeVideoId ?? "default",
              useLang,
              useGenre,
              updatedSubs,
              totalDone,
            ).catch(() => {});
          }
        },
        youtubeVideoId ?? "default",
        langName,
        useGenre,
      );

      if (isBgRunningRef.current || myJobId !== jobIdRef.current) return;

      const finalMap = new Map<string, string>();
      existingTranslations?.forEach((t, k) => { if (t.trim()) finalMap.set(k, t); });
      translated?.forEach((t, idx) => {
        const item = inputFiltered[idx];
        if (t?.translated?.trim() && item) {
          finalMap.set(item.id, t.translated);
        }
      });

      const finalSubs: SubtitleSegment[] = originalOnly.map((sub) => {
        const t = finalMap.get(sub.id);
        return {
          ...sub,
          translated: (t && t.trim().length > 0 && t !== sub.original) ? t : sub.original,
        };
      });

      finalSubs.forEach((sub) => {
        translationCacheRef.current.set(sub.id, sub.translated);
      });

      setSubtitles(finalSubs);
      setPhase("done");
      setRemainingSecs(null);
      animateTo(1);
      setTranslatedCount(result.segments.length);
      setTranslationEverCompleted(true);

      console.log(`[TRANSLATE] ✓ job=${myJobId} complete: ${finalSubs.length} segs`);
      saveSubtitles(youtubeVideoId ?? "default", useLang, useGenre, finalSubs).catch(() => {});

    } catch (e: any) {
      if (e?.message === 'INFERENCE_CANCELLED') return;
      if (myJobId !== jobIdRef.current) return;
      console.error("[YT_SCREEN] 번역 오류:", e);
      setPhase("error");
    }
  }, [targetLanguage, youtubeVideoId, setSubtitles, scheduleSetSubtitles, setLoadingLabel, setPhase]);

  // ── onSubtitleData 콜백 ──────────────────────────────────────────────────
  const handleSubtitleData = useCallback((_result: SubtitleFetchResult) => {}, []);

  // ── onSubtitlesLoaded 콜백 ────────────────────────────────────────────────
  const handleSubtitlesLoaded = useCallback((
    segments: TimedTextSegment[],
    language: string,
  ) => {
    if (srtModeActiveRef.current) return;

    if (bgResultApplied.current) {
      console.log('[YT_SCREEN] BG result applied, skipping FG subtitle load');
      return;
    }

    if (allSegmentsRef.current !== null) return;

    autoFetchCompletedRef.current = true;

    if (!segments || segments.length === 0) {
      setPhase("no_subtitles");
      return;
    }

    translationCacheRef.current = new Map();

    const result: SubtitleFetchResult = {
      segments: segments.map((s) => ({
        startTime: s.startTime,
        endTime:   s.endTime,
        text:      s.text,
      })),
      language,
      source: "timedtext",
    };

    console.log(`[YT_SCREEN] 전체 세그먼트 수신: ${segments.length}개, lang=${language}`);

    allSegmentsRef.current  = result;
    lastFetchResult.current = result;

    if (isBgRunningRef.current) {
      console.log('[YT_SCREEN] BG translation running — segments stored, showing raw subtitles');
      const rawSubs: SubtitleSegment[] = result.segments.map((seg) => ({
        id:         makeSegmentId(seg.startTime, seg.endTime),
        startTime:  seg.startTime,
        endTime:    seg.endTime,
        original:   seg.text,
        translated: seg.text,
      }));
      setSubtitles(rawSubs);
      return;
    }

    const existingMap = partialTranslationsRef.current.size > 0
      ? new Map(partialTranslationsRef.current)
      : null;

    setPhase(existingMap ? "resuming" : "translating");
    translateFromResult(result, undefined, undefined, existingMap);
    partialTranslationsRef.current = new Map();
  }, [translateFromResult, setSubtitles]);

  // ── 플레이어 준비 + 캐시 체크 ─────────────────────────────────────────────
  const handlePlayerReady = useCallback(async () => {
    // ── SRT mode: must be FIRST — skip entire AI pipeline ─────────────────
    const srtUri = initialSrtUri.current ?? pendingSubtitleRef.current;
    pendingSubtitleRef.current = null;
    initialSrtUri.current = null;
    if (srtUri) {
      srtModeActiveRef.current = true; // set BEFORE async read — blocks any racing handleSubtitlesLoaded
      try {
        const content = await FileSystem.readAsStringAsync(srtUri);
        const segments = parseSrt(content);
        if (segments.length > 0) {
          bgResultApplied.current       = true;
          autoFetchCompletedRef.current = true;
          cancelledRef.current          = true;
          jobIdRef.current++;
          setSubtitles(segments);
          setPhase("done");
          setSubtitleProgress(1);
          setTotalSegments(segments.length);
          setTranslatedCount(segments.length);
          setTranslationEverCompleted(true);
          ytPlayerRef.current?.disableCaptions?.();
        }
      } catch (e) {
        console.warn("[SRT] Failed to load SRT in handlePlayerReady:", e);
      }
      return; // unconditional — never start AI pipeline when SRT was provided
    }
    // ── existing pipeline code ─────────────────────────────────────────────
    if (!youtubeVideoId) return;

    const videoIdAtStart = youtubeVideoId;

    if (playerReadyOnceRef.current) return;
    playerReadyOnceRef.current = true;

    if (!genreReadyRef.current) {
      await new Promise<void>((resolve) => {
        const CHECK_INTERVAL_MS = 20;
        const HARD_TIMEOUT_MS   = 500;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        };
        const check   = setInterval(() => { if (genreReadyRef.current) finish(); },
                                    CHECK_INTERVAL_MS);
        const timeout = setTimeout(finish, HARD_TIMEOUT_MS);
      });
    }

    if (currentVideoIdRef.current !== videoIdAtStart) return;

    const genre = genreValueRef.current;

    AsyncStorage.getItem(`gemma_checkpoint_v4_${youtubeVideoId}`)
      .then(raw => {
        if (raw && loadingSubLabelRef.current === '') {
          setLoadingLabel(t("player.loadingModelPreparing"));
          setPhase('resuming');
        }
      })
      .catch(() => {});

    if (isBgRunningRef.current) {
      const earlyResult = await loadBgResult(youtubeVideoId);
      if (earlyResult && !bgResultApplied.current) {
        const restored: SubtitleSegment[] = earlyResult.segments.map((seg, i) => ({
          id:         `bg_${i}_${Math.round(seg.startTime * 1000)}`,
          startTime:  seg.startTime,
          endTime:    seg.endTime,
          original:   seg.original,
          translated: seg.translated,
        }));
        bgResultApplied.current = true;
        jobIdRef.current++;
        cancelledRef.current = true;
        setSubtitles(restored);
        setPhase('done');
        setSubtitleProgress(1);
        setTotalSegments(restored.length);
        setTranslatedCount(restored.length);
        setTranslationEverCompleted(true);
        saveSubtitles(youtubeVideoId, earlyResult.language, genre, restored).catch(() => {});
        await clearBgResult(youtubeVideoId);
        if (currentVideoIdRef.current !== videoIdAtStart) return;
        return;
      }
      setPhase('idle');
      ytPlayerRef.current?.fetchSubtitles();
      return;
    }

    const cached = await loadSubtitles(youtubeVideoId, targetLanguage, genre);

    if (currentVideoIdRef.current !== videoIdAtStart) return;

    if (isBgRunningRef.current) {
      setPhase('idle');
      return;
    }

    if (cached) {
      setSubtitles(cached.segments);

      if (cached.isPartial) {
        const cachedTranslatedCount = cached.translatedCount;
        const totalCount            = cached.segments.length;

        console.log(
          `[CACHE] Partial cache hit: ${cachedTranslatedCount}/${totalCount} 번역됨 → resume`
        );

        setTranslatedCount(cachedTranslatedCount);
        setTotalSegments(totalCount);
        setSubtitleProgress(totalCount > 0 ? cachedTranslatedCount / totalCount : 0);

        partialTranslationsRef.current = new Map(
          cached.segments
            .filter((s) => s.translated && s.translated.trim() !== "")
            .map((s) => [s.id, s.translated])
        );

        allSegmentsRef.current = null;
        if (!autoFetchCompletedRef.current) {
          setLoadingLabel(t("player.loadingModelPreparing"));
          setPhase("resuming");
          ytPlayerRef.current?.fetchSubtitles();
        } else {
          setPhase("resuming");
        }
      } else {
        if (isBgRunningRef.current) {
          setPhase('idle');
          return;
        }
        if (bgResultApplied.current) {
          console.log('[CACHE] BG result applied, skipping full-cache FG restore');
          return;
        }
        console.log(`[CACHE] Full cache hit → auto-start FG translation (${cached.translatedCount}개)`);

        partialTranslationsRef.current = new Map(
          cached.segments
            .filter((s: any) => s.translated && s.translated.trim() !== "")
            .map((s: any) => [s.id, s.translated])
        );
        allSegmentsRef.current = null;

        setTranslatedCount(cached.translatedCount);
        setTotalSegments(cached.segments.length);
        setSubtitleProgress(
          cached.segments.length > 0 ? cached.translatedCount / cached.segments.length : 0
        );
        if (!autoFetchCompletedRef.current) {
          setLoadingLabel(t("player.loadingModelPreparing"));
          setPhase("resuming");
          ytPlayerRef.current?.fetchSubtitles();
        } else {
          setPhase("resuming");
        }
      }
      return;
    }

    if (isBgRunningRef.current) return;

    if (bgResultApplied.current) {
      console.log('[CACHE] BG result applied, skipping FG fetch on cache miss');
      return;
    }

    if (autoFetchCompletedRef.current) {
      console.log("[CACHE] Cache miss — auto-fetch already completed, skipping");
      return;
    }
    console.log("[CACHE] Cache miss → start fetch");
    if (subtitlePhaseRef.current !== 'resuming') {
      setLoadingLabel(t("player.loadingFetching"));
    }
    setPhase("fetching");
    ytPlayerRef.current?.fetchSubtitles();
  }, [youtubeVideoId, targetLanguage, setPlaying, setSubtitles, setLoadingLabel, setPhase]);

  // ── 뒤로가기 ─────────────────────────────────────────────────────────────
  const handleBack = useCallback(async () => {
    const bgStBack = bgStatusRef.current?.status;
    const bgActiveBack = isBgRunningRef.current
      || bgStBack === 'fetching'
      || bgStBack === 'translating'
      || bgStBack === 'saving';

    if (!bgActiveBack) {
      cancelledRef.current = true;
      jobIdRef.current++;
      cancelFgInference();
    }

    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    if (whisperStatus.isRunning) await stopWhisper();
    if (gemmaLoadedRef.current && !bgActiveBack) {
      try { await unloadGemma(); } catch {}
      gemmaLoadedRef.current = false;
    }
    clearSubtitles();
    setPlaying(false);
    router.back();
  }, [whisperStatus.isRunning, stopWhisper, clearSubtitles, setPlaying]);

  // ── 전체화면 토글 ─────────────────────────────────────────────────────────
  const handleFullscreenToggle = useCallback(async () => {
    try {
      if (isLandscape) {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      } else {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE_LEFT);
      }
      await ScreenOrientation.unlockAsync();
    } catch (e) {
      console.warn("[Fullscreen] orientation lock failed:", e);
    }
  }, [isLandscape]);

  // ── 자막 표시 모드 순환 ───────────────────────────────────────────────────
  const cycleModes = () => {
    const modes: Array<"both" | "original" | "translation"> = ["both", "original", "translation"];
    const next = modes[(modes.indexOf(subtitleMode) + 1) % modes.length];
    update({ subtitleMode: next });
  };
  const modeLabel: Record<string, string> = {
    both:        t("player.both"),
    original:    t("player.original"),
    translation: t("player.translation"),
  };

  // ── 시크 ─────────────────────────────────────────────────────────────────
  const fsSeekPendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fsSeekValueRef = useRef<number>(0);
  const fsSeekingRef = useRef<boolean>(false);
  const portraitSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portraitSeekEndRef = useRef<number>(0);

  const handleSeek = useCallback((t: number) => {
    if (fsSeekingRef.current) return;
    setCurrentTime(t);
    if (portraitSeekTimerRef.current) clearTimeout(portraitSeekTimerRef.current);
    portraitSeekTimerRef.current = setTimeout(() => {
      portraitSeekTimerRef.current = null;
      ytPlayerRef.current?.seekTo(t);
      bumpSeek();
    }, 200);
  }, [setCurrentTime, bumpSeek]);

  const handlePortraitSeekEnd = useCallback((t: number) => {
    portraitSeekEndRef.current = t;
    setCurrentTime(t);
    ytPlayerRef.current?.seekTo(t);
    bumpSeek();
  }, [setCurrentTime, bumpSeek]);

  const handleFullscreenSeek = useCallback((t: number) => {
    // fallback for portrait seekbar (unchanged behavior)
    fsSeekValueRef.current = t;
    fsSeekingRef.current = true;
    setCurrentTime(t);
    ytPlayerRef.current?.blockTimeSync(1200);
    if (fsSeekPendingRef.current) clearTimeout(fsSeekPendingRef.current);
    fsSeekPendingRef.current = setTimeout(() => {
      ytPlayerRef.current?.seekTo(fsSeekValueRef.current);
      bumpSeek();
      fsSeekPendingRef.current = null;
      setTimeout(() => { fsSeekingRef.current = false; }, 800);
    }, 200);
  }, [setCurrentTime, bumpSeek]);

  const handleFsSeekStart = useCallback((t: number) => {
    fsSeekingRef.current = true;
    fsSeekValueRef.current = t;
    setCurrentTime(t);
    ytPlayerRef.current?.pauseTimeSync();
    if (fsSeekPendingRef.current) clearTimeout(fsSeekPendingRef.current);
  }, [setCurrentTime]);

  const handleFsSeekMove = useCallback((t: number) => {
    fsSeekValueRef.current = t;
    setCurrentTime(t); // update display only, no seekTo
  }, [setCurrentTime]);

  const handleFsSeekEnd = useCallback((t: number) => {
    fsSeekValueRef.current = t;
    setCurrentTime(t);
    if (fsSeekPendingRef.current) clearTimeout(fsSeekPendingRef.current);
    // Small delay before seekTo so the block is fully in place
    setTimeout(() => {
      ytPlayerRef.current?.seekTo(t);
      bumpSeek();
    }, 50);
    setTimeout(() => {
      fsSeekingRef.current = false;
      ytPlayerRef.current?.resumeTimeSync();
    }, 2500);
  }, [setCurrentTime, bumpSeek]);

  // ── 검색 모달용 seek 핸들러 ───────────────────────────────────────────────
  const handleSearchSeek = useCallback((time: number) => {
    setCurrentTime(time);
    bumpSeek();
    ytPlayerRef.current?.seekTo(time);
  }, [setCurrentTime, bumpSeek]);

  const handlePlayToggle = useCallback(() => {
    console.log('[TOGGLE] handlePlayToggle called, optimisticPlayingRef=', optimisticPlayingRef.current);
    const next = !optimisticPlayingRef.current;
    optimisticPlayingRef.current = next;
    setOptimisticPlaying(next);
  }, []);

  // ── 수동 재시도 ───────────────────────────────────────────────────────────
  const handleRetrySubtitles = useCallback(() => {
    jobIdRef.current++;
    cancelledRef.current = true;
    bgResultApplied.current = false;
    highWaterProgressRef.current = 0;
    setTranslationEverCompleted(false);
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    clearSubtitles();
    setUsingWhisper(false);
    whisperStartedRef.current        = false;
    lastFetchResult.current          = null;
    allSegmentsRef.current           = null;
    translationCacheRef.current      = new Map();
    partialTranslationsRef.current   = new Map();
    autoFetchCompletedRef.current    = false;
    batchStartTimeRef.current        = 0;
    lastCompletedRef.current         = 0;
    secsPerSegmentRef.current        = 0;
    setRemainingSecs(null);
    setLoadingLabel('');
    setPhase("fetching");
    setSubtitleProgress(0);
    setTranslatedCount(0);
    setTotalSegments(0);
    setTimeout(() => {
      cancelledRef.current = false;
      ytPlayerRef.current?.fetchSubtitles();
    }, 300);
  }, [clearSubtitles, setLoadingLabel]);

  // ── 자막 불러오기 중지 ────────────────────────────────────────────────────
  const handleCancelFetch = useCallback(() => {
    jobIdRef.current++;
    cancelledRef.current  = true;
    setPhase("idle");
  }, []);

  // ── 장르 변경 ─────────────────────────────────────────────────────────────
  const handleGenreChange = useCallback((genre: string) => {
    genreValueRef.current = genre;
    setSelectedGenre(genre);
    setGenreModalVisible(false);
    bgResultApplied.current = false;
    highWaterProgressRef.current = 0;
    setTranslationEverCompleted(false);

    if (lastFetchResult.current && lastFetchResult.current.segments.length > 0) {
      clearSubtitles();
      translateFromResult(lastFetchResult.current!, targetLanguage, genre, null);
    } else {
      handleRetrySubtitles();
    }
  }, [clearSubtitles, translateFromResult, targetLanguage, handleRetrySubtitles]);

  // ── 언어 변경 ─────────────────────────────────────────────────────────────
  const handleLanguageChange = useCallback((langCode: string) => {
    update({ targetLanguage: langCode });
    setLangModalVisible(false);
    bgResultApplied.current = false;
    highWaterProgressRef.current = 0;
    setTranslationEverCompleted(false);

    if (!youtubeVideoId) return;

    if (lastFetchResult.current && lastFetchResult.current.segments.length > 0) {
      clearSubtitles();
      translateFromResult(lastFetchResult.current!, langCode, genreValueRef.current, null);
    } else {
      handleRetrySubtitles();
    }
  }, [youtubeVideoId, update, clearSubtitles, translateFromResult, handleRetrySubtitles]);

  // ── 백그라운드 번역 시작 ─────────────────────────────────────────────────
  const startBgTranslation = useCallback(async () => {
    if (!youtubeVideoId) return;

    isBgRunningRef.current = true;

    jobIdRef.current++;
    cancelledRef.current = true;
    cancelFgInference();
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }

    setSubtitleProgress(0);
    setTranslatedCount(0);
    setTotalSegments(0);
    highWaterProgressRef.current = 0;
    setTranslationEverCompleted(false);
    clearSubtitles();

    if (allSegmentsRef.current?.segments?.length) {
      try {
        await AsyncStorage.setItem(
          `fg_fetched_subtitles_${youtubeVideoId}`,
          JSON.stringify(allSegmentsRef.current)
        );
      } catch {}
    }

    try {
      await enqueueTranslation({
        videoId:    youtubeVideoId,
        videoTitle: videoName ?? 'YouTube 영상',
        language:   targetLanguage,
        genre:      selectedGenre,
      });
      setPhase('idle');
    } catch (e: any) {
      isBgRunningRef.current = false;
      setPhase('error');
      Alert.alert('오류', e?.message ?? '백그라운드 서비스를 시작할 수 없습니다.');
    }
  }, [youtubeVideoId, videoName, targetLanguage, selectedGenre,
      enqueueTranslation, clearSubtitles]);

  const handleSendToBackground = useCallback(async () => {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        {
          title:           t("player.notifPermTitle"),
          message:         t("player.notifPermMessage"),
          buttonPositive:  t("player.notifPermAllow"),
          buttonNegative:  t("player.notifPermDeny"),
        }
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
    }
    if (Platform.OS === 'android') {
      NativeModules.TranslationService?.checkAndRequestBatteryOptimization?.()
        .catch(() => {});
    }

    if (isBgRunning) {
      Alert.alert(
        t("player.bgCancelTitle"),
        t("player.bgCancelMessage"),
        [
          { text: t("player.bgCancelKeep"), style: 'cancel' },
          {
            text: t("player.bgCancelRestart"),
            style: 'destructive',
            onPress: async () => {
              await cancelTranslation();
              await startBgTranslation();
            },
          },
        ]
      );
      return;
    }
    await startBgTranslation();
  }, [isBgRunning, cancelTranslation, startBgTranslation]);

  if (!youtubeVideoId) return null;

  const currentPhase: SubtitlePhase =
    usingWhisper
      ? (whisperStatus.isRunning ? "fallback_whisper" : "idle")
      : subtitlePhase;

  const getPillBorderColor = (phase: SubtitlePhase): string => {
    switch (phase) {
      case 'translating':      return '#3b82f6';
      case 'resuming':         return '#a78bfa';
      case 'fetching':         return '#6366f1';
      case 'done':             return '#22c55e';
      case 'error':            return '#ef4444';
      case 'fallback_whisper': return '#f59e0b';
      default:                 return '#3b82f6';
    }
  };

  const getBarColor = (): string => {
    if (isBgRunning)                  return '#6366f1';
    if (displayPhase === 'done')      return '#22c55e';
    if (displayPhase === 'resuming')  return '#a78bfa';
    return '#3b82f6';
  };

  const displayPhase: SubtitlePhase = isBgRunning ? 'idle' : currentPhase;

  const rawProgress = isBgRunning
    ? (bgStatus?.progress ?? 0)
    : (displayPhase === 'done' ? 1 : subtitleProgress);

  const barProgress = Math.max(rawProgress, highWaterProgressRef.current);
  const showShimmer = barProgress < 0.02 && (isBgRunning || (displayPhase !== 'idle' && displayPhase !== 'done'));

  useEffect(() => {
    if (rawProgress > highWaterProgressRef.current) {
      highWaterProgressRef.current = rawProgress;
    }
  }, [rawProgress]);

  const Wrapper = isLandscape ? View : SafeAreaView;
  const wrapperStyle = isLandscape
    ? { flex: 1, backgroundColor: "#000" }
    : styles.safe;

  return (
    <Wrapper style={wrapperStyle}>

      {/* ── 헤더 ─────────────────────────────────────────────────────────── */}
      {!isLandscape && <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{videoName ?? "YouTube"}</Text>
          <Text style={styles.titleSub}>YouTube · 자막 번역</Text>
        </View>
        <TouchableOpacity onPress={() => router.push("./settings")} style={styles.headerBtn}>
          <Settings size={18} color="#fff" />
        </TouchableOpacity>
      </View>}

      {/* ── 플레이어 ──────────────────────────────────────────────────────── */}
      <View style={isLandscape
        ? {
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 1,
            backgroundColor: '#000',
            overflow: 'hidden',
          }
        : [styles.playerWrap, { height: playerHeight }]}>
        <View style={isLandscape ? {
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          justifyContent: 'center',
          alignItems: 'center',
        } : undefined}>
        <YouTubePlayer
          ref={ytPlayerRef}
          videoId={youtubeVideoId}
          height={playerHeight}
          style={isLandscape ? { width: screenWidth } : undefined}
          playbackRate={playbackRate}
          onReady={handlePlayerReady}
          onSubtitleData={handleSubtitleData}
          onSubtitlesLoaded={handleSubtitlesLoaded}
          onSeek={handleSeek}
          playing={optimisticPlaying}
          onTap={handlePlayToggle}
          onFullscreenToggle={handleFullscreenToggle}
          onOverlayVisibilityChange={(visible) => setFullscreenOverlayVisible(visible)}
          isFullscreen={isLandscape}
          onStateChange={(state) => {
            // [FIX v19] 실제 플레이어 이벤트 기반 단방향 상태 업데이트
            if (state === "playing") {
              setPlaying(true);
              optimisticPlayingRef.current = true;
              setOptimisticPlaying(true);
              if (subtitlePhase === "idle" && !isBgRunningRef.current && !srtModeActiveRef.current) {
                setPhase("fetching");
              }
            }
            if (state === "paused" || state === "ended") {
              setPlaying(false);
              // Only sync optimisticPlaying to false if we WERE playing.
              // Do NOT reset on the initial iframe load PAUSED event.
              if (optimisticPlaying) {
                optimisticPlayingRef.current = false;
                setOptimisticPlaying(false);
              }
            }
          }}
          onError={(code) => {
            Alert.alert(
              t("player.embedErrorTitle"),
              code === "150" || code === "101"
                ? t("player.embedErrorMessage")
                : t("player.playbackErrorMessage", { code })
            );
          }}
        />
        </View>
        <View style={styles.subtitleLayer} pointerEvents="box-none">
          <SubtitleOverlay />
        </View>
        {/* ── 풀스크린 오버레이 컨트롤 (landscape only) ─────────────────── */}
        {isLandscape && fullscreenOverlayVisible && (
          <View
            style={{
              position: 'absolute',
              bottom: 8,
              left: 0,
              right: 0,
              zIndex: 30,
              paddingHorizontal: 12,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: 'rgba(0,0,0,0.55)',
                borderRadius: 10,
                paddingHorizontal: 10,
                paddingVertical: 6,
                gap: 8,
              }}
            >
              <Text style={{
                color: '#fff', fontSize: 11,
                fontVariant: ['tabular-nums'], minWidth: 36,
              }}>
                {fmt(currentTime)}
              </Text>
              <View style={{ flex: 1 }}>
                <YoutubeSeekBar
                  currentTime={currentTime}
                  duration={duration}
                  onSeek={handleFullscreenSeek}
                  onSeekStart={handleFsSeekStart}
                  onSeekMove={handleFsSeekMove}
                  onSeekEnd={handleFsSeekEnd}
                />
              </View>
              <Text style={{
                color: '#fff', fontSize: 11,
                fontVariant: ['tabular-nums'],
                minWidth: 36, textAlign: 'right',
              }}>
                {fmt(duration)}
              </Text>
              <TouchableOpacity
                onPress={handleFullscreenToggle}
                activeOpacity={0.7}
                style={{
                  width: 24, height: 24, borderRadius: 4,
                  backgroundColor: 'rgba(0,0,0,0.4)',
                  justifyContent: 'center', alignItems: 'center',
                }}
              >
                <Minimize2 size={16} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* ── 시간 표시 ────────────────────────────────────────────────────── */}
      {!isLandscape && (
        <View style={styles.timeSection}>
          <Text style={styles.timeText}>{fmt(currentTime)}</Text>
          <Text style={styles.timeText}>{fmt(duration)}</Text>
        </View>
      )}

      {/* ── FG 진행 카드 ──────────────────────────────────────────────────── */}
      {!isLandscape && !isBgRunning && (
        displayPhase === 'fetching' ||
        displayPhase === 'translating' ||
        displayPhase === 'resuming'
      ) && (
        <View style={progressCard.card}>
          <Text style={progressCard.pct}>
            {displayPhase === 'fetching'
              ? '--'
              : subtitleProgress > 0 ? `${Math.round(subtitleProgress * 100)}%` : '--'}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={progressCard.title}>
              {displayPhase === 'fetching' ? t("player.loadingSubtitles") : t("player.translatingProgress")}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {(displayPhase === 'fetching' || displayPhase === 'translating' || displayPhase === 'resuming') && (
                <Loader2 size={11} color="#6366f1" />
              )}
              <Text style={progressCard.sub} numberOfLines={1}>
                {isStale
                  ? t("player.processing")
                  : displayPhase === 'fetching'
                    ? (loadingSubLabel || t("player.loadingFetching"))
                    : (displayPhase === 'translating' || displayPhase === 'resuming') &&
                      translatedCount > 0 && totalSegments > 0
                      ? `${translatedCount} / ${totalSegments}`
                      : loadingSubLabel !== ''
                        ? loadingSubLabel
                        : t("player.progressPreparingShort")}
              </Text>
            </View>
            {(displayPhase === 'translating' || displayPhase === 'resuming') && remainingSecs !== null && remainingSecs > 0 && (
              <Text style={progressCard.eta}>
                {formatRemaining(remainingSecs)}
              </Text>
            )}
          </View>
          <TouchableOpacity onPress={handleCancelFetch} style={progressCard.cancelBtn}>
            <Text style={progressCard.cancelBtnText}>{t("player.stop")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── 에러/no-subtitles/whisper 컴팩트 pill ───────────────────────── */}
      {!isLandscape && !isBgRunning && (
        displayPhase === 'error' ||
        displayPhase === 'no_subtitles' ||
        displayPhase === 'fallback_whisper'
      ) && (
        <View style={[
          pillStyles.container,
          { borderLeftColor: getPillBorderColor(displayPhase) },
        ]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {displayPhase === 'error'            && <AlertCircle   size={12} color="#ef4444" />}
            {displayPhase === 'no_subtitles'     && <AlertTriangle size={12} color="#f59e0b" />}
            {displayPhase === 'fallback_whisper' && <Mic           size={12} color="#aaa"    />}
            <Text style={[pillStyles.statusText, displayPhase === 'error' && { color: '#ef4444' }]} numberOfLines={1}>
              {getSubtitleStatusLabel(displayPhase, subtitleProgress, t)}
            </Text>
          </View>
          <TouchableOpacity onPress={handleRetrySubtitles} style={pillStyles.retryBtn}>
            <Text style={pillStyles.retryBtnText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── BG 번역 진행 카드 ─────────────────────────────────────────────── */}
      {!isLandscape && isBgRunning && (
        <Animated.View style={[progressCard.card, { opacity: bannerOpacity }]}>
          <Text style={progressCard.pct}>
            {Math.round(displayedPct * 100)}%
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={progressCard.title}>{t("player.bgTranslating")}</Text>
            <Text style={progressCard.sub} numberOfLines={1}>
              {(() => {
                const p = bgStatus?.progress ?? 0;
                const st = bgStatus?.status;
                if (!st || st === 'fetching') {
                  if (p < 0.02) return t("player.bgSubLabelFetching1");
                  if (p < 0.05) return t("player.bgSubLabelFetching2");
                  return t("player.bgSubLabelFetching3");
                }
                if (st === 'saving') return t("player.bgSubLabelSaving");
                if (st === 'translating' && (bgStatus?.totalCount ?? 0) > 0) {
                  return `${bgStatus!.translatedCount} / ${bgStatus!.totalCount}`;
                }
                return t("player.bgSubLabelPreparing");
              })()}
            </Text>
            {bgRemainingSecs !== null && bgRemainingSecs > 0 && (
              <Text style={progressCard.eta}>
                {formatRemaining(bgRemainingSecs)}
              </Text>
            )}
          </View>
          <TouchableOpacity onPress={cancelTranslation} style={progressCard.cancelBtn}>
            <Text style={progressCard.cancelBtnText}>{t("common.cancel")}</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {!isLandscape && showBgDoneBanner && (
        <View style={[progressCard.card, { backgroundColor: '#0a1f0a', borderTopColor: '#22c55e' }]}>
          <CheckCircle2 size={16} color="#22c55e" />
          <Text style={[progressCard.title, { color: '#22c55e', marginLeft: 8 }]}>
            {t("player.bgDone")}
          </Text>
        </View>
      )}

      {!isLandscape && bgStatus?.status === 'error' && (
        <View style={[progressCard.card, { backgroundColor: '#1a0a0a', borderTopColor: '#ef4444' }]}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <XCircle size={14} color="#ef4444" />
            <Text style={{ color: '#ef4444', fontSize: 11 }}>
              {bgStatus.error ?? '번역 실패'}
            </Text>
          </View>
          <TouchableOpacity onPress={handleSendToBackground} style={progressCard.cancelBtn}>
            <Text style={progressCard.cancelBtnText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── 시크바 ────────────────────────────────────────────────────────── */}
      {!isLandscape && (
        <View style={styles.seekSection}>
          {(isBgRunning || (currentPhase !== 'idle' && currentPhase !== 'done')) && (
            <View style={styles.progressBarTrack}>
              {showShimmer ? (
                <Animated.View
                  style={[
                    styles.progressBarShimmer,
                    {
                      backgroundColor: getBarColor(),
                      transform: [{
                        translateX: shimmerAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [-screenWidth * 0.4, screenWidth],
                        }),
                      }],
                    },
                  ]}
                />
              ) : (
                <View
                  style={[
                    styles.progressBarFillFull,
                    {
                      width: `${Math.min((isBgRunning ? displayedPct : barProgress) * 100, 100)}%` as any,
                      backgroundColor: getBarColor(),
                    },
                  ]}
                />
              )}
            </View>
          )}
          <YoutubeSeekBar currentTime={currentTime} duration={duration} onSeek={handleSeek} onSeekEnd={handlePortraitSeekEnd} />
        </View>
      )}

      {/* ── 컨트롤 바 ─────────────────────────────────────────────────────── */}
      {!isLandscape && <View style={styles.controlBar}>
        {/*
          [FIX v19] 재생버튼: debounce 방식으로 교체
          - optimisticPlaying으로 아이콘 즉각 반응
          - 300ms debounce 후 ref.play()/pause() 1회만 호출
          - isPlaying store는 onStateChange에서만 업데이트 (단방향)
        */}
        <TouchableOpacity
          style={styles.playBtn}
          onPress={() => { console.log('[BTN] play button pressed'); handlePlayToggle(); }}
          activeOpacity={0.75}
        >
          <Text style={styles.playBtnText}>{optimisticPlaying ? "⏸" : "▶"}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.chipBtn}
          onPress={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
          activeOpacity={0.75}
        >
          <Text style={styles.chipBtnText}>{speedLabel(playbackRate)}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.chipBtn, styles.chipBtnFlex]}
          onPress={cycleModes}
          activeOpacity={0.75}
        >
          <Text style={styles.chipBtnText} numberOfLines={1}>
            {modeLabel[subtitleMode] ?? "원문+번역"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.chipBtn}
          onPress={() => setSubtitlePanelVisible(true)}
        >
          <Text style={styles.chipBtnText}>Aa</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.chipBtn}
          onPress={() => setSearchModalVisible(true)}
          activeOpacity={0.75}
        >
          <Search size={15} color="#ccc" />
        </TouchableOpacity>

        {Platform.OS === 'android' && (
          <TouchableOpacity
            style={[
              styles.chipBtn,
              styles.chipBtnFlex,
              isBgRunning && {
                borderWidth: 1,
                borderColor: '#6366f1',
                backgroundColor: '#1e1b4b',
              },
            ]}
            onPress={handleSendToBackground}
            activeOpacity={0.75}
          >
            <Text style={styles.chipBtnText} numberOfLines={1}>
              {isBgRunning ? t("player.bgInProgress") : t("player.background")}
            </Text>
          </TouchableOpacity>
        )}

        {displayPhase === "done" && !isBgRunning && subtitles.length > 0 && translationEverCompleted && (
          <TouchableOpacity
            style={[
              styles.chipBtn,
              { backgroundColor: "#14532d", borderWidth: 1, borderColor: "#22c55e" },
            ]}
            onPress={() => setSaveModalVisible(true)}
          >
            <Text style={styles.chipBtnText}>{t("player.save")}</Text>
          </TouchableOpacity>
        )}
      </View>}

      {/* ── 언어 선택 모달 ────────────────────────────────────────────────── */}
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
                  style={[styles.langOption, targetLanguage === lang.code && styles.langSelected]}
                  onPress={() => handleLanguageChange(lang.code)}
                >
                  <Text style={styles.langNative}>{lang.nativeName}</Text>
                  <Text style={styles.langCode}>{lang.name}</Text>
                  {targetLanguage === lang.code && <Check size={14} color="#2563eb" />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── 장르 선택 모달 ────────────────────────────────────────────────── */}
      <Modal
        visible={genreModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setGenreModalVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setGenreModalVisible(false)}>
          <Pressable style={[styles.modalSheet, { maxHeight: 340 }]} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t("genre.modalTitle")}</Text>
            <Text style={styles.modalSubtitle}>{t("genre.sectionHint")}</Text>
            <ScrollView>
              {GENRE_OPTIONS.map((g) => (
                <TouchableOpacity
                  key={g.key}
                  style={[styles.langOption, selectedGenre === g.key && styles.langSelected]}
                  onPress={() => handleGenreChange(g.key)}
                >
                  <Text style={styles.langNative}>{g.label}</Text>
                  {selectedGenre === g.key && <Check size={14} color="#2563eb" />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <SubtitleQuickPanel
        visible={subtitlePanelVisible}
        onClose={() => setSubtitlePanelVisible(false)}
      />

      <SubtitleSaveModal
        visible={saveModalVisible}
        onClose={() => setSaveModalVisible(false)}
        videoId={youtubeVideoId ?? ""}
        videoTitle={videoName ?? "YouTube"}
        subtitles={subtitles.map((s) => ({
          startTime:  s.startTime,
          endTime:    s.endTime,
          original:   s.original,
          translated: s.translated,
        }))}
      />

      <VideoSearchModal
        visible={searchModalVisible}
        onClose={() => setSearchModalVisible(false)}
        subtitles={subtitles}
        currentTime={currentTime}
        onSeek={handleSearchSeek}
      />
    </Wrapper>
  );
}

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#000" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: "#111", gap: 8,
  },
  headerBtn:     { padding: 8 },
  headerBtnText: { color: "#fff", fontSize: 20 },
  title:    { color: "#fff", fontSize: 14, fontWeight: "600" },
  titleSub: { color: "#555", fontSize: 11, marginTop: 1 },

  playerWrap: { width: "100%", backgroundColor: "#000" },

  subtitleLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },

  timeSection: {
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: '#111',
    paddingHorizontal: 14, paddingTop: 4, paddingBottom: 2,
  },
  timeText: { color: '#666', fontSize: 11, fontVariant: ['tabular-nums'] },

  seekSection: {
    backgroundColor: '#111',
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 2,
  },
  progressBarTrack: {
    width: '100%', height: 4,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    marginBottom: 4,
  },
  progressBarShimmer: {
    position: 'absolute', top: 0, left: 0,
    height: 4, width: '40%', opacity: 0.85,
  },
  progressBarFillFull: {
    height: 4, borderRadius: 0,
  },

  controlBar: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#111",
    paddingHorizontal: 12, paddingVertical: 8, gap: 8,
  },
  controlBar2: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#111",
    paddingHorizontal: 12, paddingBottom: 10, gap: 8,
  },

  playBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: "#ff0000",
    justifyContent: "center", alignItems: "center", flexShrink: 0,
  },
  playBtnText: { fontSize: 18, color: "#fff" },

  chipBtn: {
    backgroundColor: "#222", borderRadius: 18,
    paddingHorizontal: 12, paddingVertical: 8,
    flexShrink: 0, minWidth: 44,
    alignItems: "center", justifyContent: "center",
  },
  chipBtnFlex:     { flex: 1 },
  chipBtnActive:   { backgroundColor: "#1e3a5f", borderWidth: 1, borderColor: "#2563eb" },
  chipBtnDone:     { backgroundColor: "#14532d", borderWidth: 1, borderColor: "#22c55e" },
  chipBtnWhisper:  { backgroundColor: "#431407", borderWidth: 1, borderColor: "#f59e0b" },
  chipBtnResume:   { backgroundColor: "#2e1a5e", borderWidth: 1, borderColor: "#a78bfa" },
  chipBtnDisabled: { opacity: 0.4 },
  chipBtnText: { color: "#ccc", fontSize: 12 },

  modalBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#1a1a1a",
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    maxHeight: "60%", paddingBottom: 24,
  },
  modalTitle: {
    color: "#fff", fontSize: 16, fontWeight: "700",
    textAlign: "center", paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#333",
  },
  modalSubtitle: {
    color: "#555", fontSize: 12, textAlign: "center",
    paddingVertical: 8, paddingHorizontal: 16,
  },
  langOption: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#2a2a2a",
  },
  langSelected: { backgroundColor: "#1e3a5f" },
  langNative:   { color: "#fff", fontSize: 15, flex: 1 },
  langCode:     { color: "#666", fontSize: 13, marginRight: 8 },
});

const pillStyles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.85)',
    marginHorizontal: 10, marginVertical: 4,
    paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 8,
    borderLeftWidth: 3,
    gap: 4,
    minHeight: 36,
  },
  statusText: {
    color: '#60a5fa', fontSize: 11, fontWeight: '600', flex: 1,
  },
  counter: {
    color: '#94a3b8', fontSize: 11,
    fontVariant: ['tabular-nums'],
    marginLeft: 4,
  },
  retryBtn: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 6, backgroundColor: '#1e3a5f', marginLeft: 4,
  },
  retryBtnText: { color: '#60a5fa', fontSize: 11, fontWeight: '600' },
});

const progressCard = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0d0d2e',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#312e81',
    gap: 10,
  },
  pct: {
    fontSize: 28, fontWeight: '800', color: '#a5b4fc',
    minWidth: 56, textAlign: 'right',
  },
  title: { color: '#a5b4fc', fontSize: 12, fontWeight: '600' },
  sub:   { color: '#6366f1', fontSize: 11, marginTop: 2 },
  cancelBtn: {
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: '#7f1d1d',
    borderWidth: 1, borderColor: '#ef4444',
  },
  cancelBtnText: { color: '#fca5a5', fontSize: 11, fontWeight: '600' },
  eta: {
    color: '#818cf8',
    fontSize: 10,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
});