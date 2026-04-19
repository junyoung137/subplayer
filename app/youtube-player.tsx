/**
 * YoutubePlayerScreen (v16)
 *
 * 변경사항 (v15 → v16):
 * ─────────────────────────────────────────────────────────────────────────────
 * [BUG FIX 1] BG 번역 중 FG 번역 동시 실행 방지
 *   - handleSubtitlesLoaded: isBgRunning 체크 추가
 *   - handlePlayerReady: isBgRunning 시 fetchSubtitles 호출 자체 차단
 *   - translateFromResult: isBgRunning ref 체크 추가
 *
 * [BUG FIX 2] BG progress 0%에서 멈추는 문제
 *   - useBackgroundTranslation POLL_INTERVAL_MS 기본값이 2000ms로 느림
 *   - bgStatus polling을 500ms로 강화 (BG 활성 시에만)
 *   - bgStatus.progress === 0 shimmer → 실제 progress 반영 즉시 전환
 *   - backgroundTranslationTask onProgress throttle 완화:
 *     completed % 5 → completed % 2 (더 자주 AsyncStorage 업데이트)
 *
 * [BUG FIX 3] 저장 버튼 번역 중 표시 문제
 *   - 저장 버튼 조건: subtitlePhase === "done" && !isBgRunning && subtitles.length > 0
 *   - BG 실행 중에는 저장 버튼 완전 숨김
 *
 * [BUG FIX 4] 캐시 히트 후 FG 번역 재시작 문제
 *   - handlePlayerReady에서 full cache hit 시 allSegmentsRef.current에 sentinel 세팅
 *   - handleSubtitlesLoaded에서 sentinel 감지 시 번역 스킵
 *   - isBgRunningRef 추가: 비동기 콜백에서 최신 isBgRunning 값 참조
 *
 * [KEEP v15]
 *   - jobIdRef 패턴, makeSegmentId, RAF throttle, bgResultApplied
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useRef, useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  Animated,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
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
import { useMediaProjectionProcessor } from "../hooks/useMediaProjectionProcessor";
import { useWhisperModel } from "../hooks/useWhisperModel";
import { LANGUAGES, getLanguageByCode } from "../constants/languages";
import { useRetranslate } from "../hooks/useRetranslate";
import { useBackgroundTranslation } from '../hooks/useBackgroundTranslation';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

function getSubtitleStatusLabel(phase: SubtitlePhase, progress: number): string {
  switch (phase) {
    case "fetching":         return "📡 자막 데이터 가져오는 중...";
    case "resuming":         return "⏳ 이어서 번역 중...";
    case "translating":      return `🌐 번역 중... ${Math.round(progress * 100)}%`;
    case "done":             return "✓ 자막 준비 완료";
    case "no_subtitles":     return "⚠️ 자막 없음 → Whisper 모드";
    case "fallback_whisper": return "🎙 Whisper 캡처 모드";
    case "error":            return "❌ 자막 오류";
    default:                 return "";
  }
}

// ── 시크바 ────────────────────────────────────────────────────────────────────

function YoutubeSeekBar({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (t: number) => void;
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

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder:        () => true,
      onMoveShouldSetPanResponder:         () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture:  () => true,
      onPanResponderGrant:   (e) => onSeek(getTimeRef.current(e.nativeEvent.locationX)),
      onPanResponderMove:    (e) => onSeek(getTimeRef.current(e.nativeEvent.locationX)),
      onPanResponderRelease: (e) => onSeek(getTimeRef.current(e.nativeEvent.locationX)),
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

  // Read pendingGenre synchronously once — not a hook, safe here.
  // By the time this component mounts, HomeScreen has already called
  // setPendingGenre() before router.push(), so the store value is current.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const shimmerAnim            = useRef(new Animated.Value(0)).current;
  const bannerOpacity          = useRef(new Animated.Value(0.7)).current;
  const lastProgressTimestampRef = useRef<number>(0);

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

  // [BUG FIX 1] isBgRunning을 비동기 콜백에서 참조하기 위한 ref
  // useState는 클로저에서 stale해지므로 ref로 최신값 동기화
  const isBgRunningRef = useRef(false);
  useEffect(() => {
    isBgRunningRef.current = isBgRunning;
  }, [isBgRunning]);

  // [BUG 5] Mirror bgStatus into a ref so the unmount closure can read the
  // latest value without capturing a stale state snapshot.
  const bgStatusRef = useRef<typeof bgStatus>(bgStatus);
  useEffect(() => {
    bgStatusRef.current = bgStatus;
  }, [bgStatus]);

  // Unified progress high-water mark — ensures the bar never jumps backward.
  const highWaterProgressRef = useRef(0);

  // ── Genre-restore race guards ─────────────────────────────────────────────
  const currentVideoIdRef  = useRef<string | null>(null);
  const playerReadyOnceRef = useRef(false);
  const genreReadyRef      = useRef(true);           // synchronous — always ready
  const genreValueRef      = useRef(_initialGenre);  // seeded from store on mount

  // ── Local state ───────────────────────────────────────────────────────────
  const [langModalVisible,     setLangModalVisible]     = useState(false);
  const [subtitlePanelVisible, setSubtitlePanelVisible] = useState(false);
  const [genreModalVisible,    setGenreModalVisible]    = useState(false);
  const [saveModalVisible,     setSaveModalVisible]     = useState(false);
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
  // [FIX BUG2] Guards the save button — true only when a translation or BG result
  // has fully completed in the current screen session.  Prevents premature save
  // button appearance on cache-restore before BG state is confirmed.
  const [translationEverCompleted, setTranslationEverCompleted] = useState(false);
  const [usingWhisper,     setUsingWhisper]      = useState(false);
  const [showBgDoneBanner, setShowBgDoneBanner]  = useState(false);
  const bgDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isStale, setIsStale] = useState(false);

  // ── Loading sub-label (stage hint inside the progress card sub-text) ──────
  const [loadingSubLabel, setLoadingSubLabel] = useState<string>('');
  const loadingSubLabelRef = useRef<string>('');
  const setLoadingLabel = useCallback((label: string) => {
    setLoadingSubLabel(label);
    loadingSubLabelRef.current = label;
  }, []);

  const setPhase = useCallback((phase: SubtitlePhase) => {
    subtitlePhaseRef.current = phase;        // ← ref FIRST, always
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

      // Only cancel FG work on unmount — never interrupt a running BG job.
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
      animProgressRef.current = 0;
      animTargetRef.current   = 0;
      // [BUG 5] Do NOT unload the model if BG is actively translating.
      // Two guards in combination:
      //   • isBgRunningRef.current  — set synchronously in startBgTranslation,
      //     so it's already true even before the state update commits.
      //   • bgStatusRef.current     — covers the brief window between
      //     enqueueTranslation resolving and the isBgRunning state effect firing.
      //     If bgStatus is 'fetching' or 'translating', BG owns llamaContext.
      if (gemmaLoadedRef.current && !bgActive) {
        unloadGemma().catch(() => {});
        gemmaLoadedRef.current = false;
      }
      ScreenOrientation.unlockAsync().catch(() => {});
      // Clean up any FG-fetched subtitle cache key to prevent AsyncStorage leaks
      // (consumed by backgroundTranslationTask if BG was started, otherwise orphaned)
      if (youtubeVideoId) {
        AsyncStorage.removeItem(`fg_fetched_subtitles_${youtubeVideoId}`).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset high-water mark when the translation job identity changes.
  // Keyed on video + language + genre so retranslation starts fresh.
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
      "자막 없음",
      "이 영상에 자막 데이터가 없습니다.\nWhisper 음성 인식 모드로 전환합니다.",
      [{ text: "확인" }]
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
      // Do not arm staleness while a loading-stage label is showing.
      // SBD / mergeFragments / model restore can legitimately take 10–20 s
      // with zero onProgress ticks — this is not a stall.
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
      const eased   = 1 - Math.pow(1 - t, 3); // ease-out cubic

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

  // ── Genre restore from player store (set by HomeScreen before navigation) ───
  // Fully synchronous — pendingGenre is already in the store before this
  // component mounts or before youtubeVideoId changes, so no async wait needed.
  useEffect(() => {
    const g = usePlayerStore.getState().pendingGenre ?? "general";
    currentVideoIdRef.current  = youtubeVideoId;
    playerReadyOnceRef.current = false;
    genreValueRef.current      = g;
    genreReadyRef.current      = true;
    setSelectedGenre(g);
    setPendingGenre(null);
  }, [youtubeVideoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BUG 4: bgResultApplied reset on videoId change ─────────────────────────
  // Must run BEFORE handlePlayerReady fires and BEFORE the restore effect below.
  // React runs effects in definition order for the same dep, so place this first.
  useEffect(() => {
    bgResultApplied.current      = false;
    autoFetchCompletedRef.current = false;
    allSegmentsRef.current    = null;   // allow handleSubtitlesLoaded to run on re-entry

    // [FIX ISSUE1] If there is a stale BG task for a DIFFERENT video (e.g. the
    // user navigated from one video to another while BG was running), cancel it
    // so the new screen starts in FG mode instead of showing the BG banner.
    if (
      isBgRunning &&
      bgStatus?.videoId &&
      bgStatus.videoId !== youtubeVideoId
    ) {
      cancelTranslation();
    }
  }, [youtubeVideoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── bg 번역 결과 복원 (마운트 시 / BG가 이미 완료된 경우) ──────────────────
  useEffect(() => {
    if (!youtubeVideoId) return;
    (async () => {
      const result = await loadBgResult(youtubeVideoId);
      if (!result) return;
      // BG still running: the bgStatus 'done' watcher will handle it
      if (isBgRunningRef.current) return;
      // bgStatus watcher already handled it on this mount
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

  // ── BG 번역 완료 시 자동 자막 적용 (화면이 열려 있는 동안 완료된 경우) ────────
  // Watch for BG status → 'done' while the screen is open.
  // (The youtubeVideoId mount effect handles the case where BG finished BEFORE the screen opened.)
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
      // Cancel any in-flight FG job before applying BG result
      bgResultApplied.current = true;
      jobIdRef.current++;
      cancelledRef.current = true;
      // BUG 3: reset FG refs so subsequent genre/language changes work correctly
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
      setTranslationEverCompleted(true); // [FIX BUG2] BG result fully applied
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
  // [Improvement 5] Accept the caller's jobId and re-check it when the RAF
  // fires — the job may have been cancelled during the frame delay.
  const scheduleSetSubtitles = useCallback((subs: SubtitleSegment[], callerJobId: number) => {
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
    }
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      if (callerJobId !== jobIdRef.current) return; // stale — job was superseded
      setSubtitles(subs);
    });
  }, [setSubtitles]);

  // ── Smooth progress bar animation ─────────────────────────────────────
  const animateTo = useCallback((target: number) => {
    animTargetRef.current = target;
    // If an animation loop is already running, only update the target.
    // The running frame() closure reads animTargetRef.current on every tick
    // so it will naturally converge to the new target without restarting.
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
  // Crawls animProgressRef from fromVal to toVal over duration ms.
  // Throttled to one setState per 200ms to prevent update-depth loops.
  // Guards: job identity → toVal ceiling → duration elapsed (in that order).
  // onComplete fires only when duration elapses naturally (not on early exit).
  const startCrawl = useCallback((
    fromVal: number,
    toVal: number,
    duration: number,
    jobId: number,
    onComplete?: () => void,
  ) => {
    const crawlStart = performance.now();
    let crawlLastRender = 0;
    // Ensure the effective start never falls below fromVal even if the ref
    // hasn't committed its first frame yet (RAF timing race on slow devices).
    const effectiveStart = Math.max(fromVal, animProgressRef.current);

    const crawlFrame = () => {
      const now     = performance.now();
      const elapsed = now - crawlStart;
      const t       = Math.min(elapsed / duration, 1);

      // Guards — in this exact order, no code before them
      if (jobId !== jobIdRef.current)             return; // job superseded
      if (animProgressRef.current > toVal)        return; // real progress took over
      if (t >= 1)                                 { onComplete?.(); return; } // elapsed

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

    // [BUG FIX 1] BG 번역 실행 중이면 FG 번역 시작 차단
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
    // Only clear for fresh jobs — resume jobs keep their
    // "⏳ 이전 번역 이어서 준비 중..." label visible through model load.
    if (!isResume) setLoadingLabel('');

    setLoadingLabel('🔄 모델 로딩 중...');
    const hasGemma = await ensureGemma();
    if (isBgRunningRef.current || myJobId !== jobIdRef.current) return;

    if (isResume) {
      setLoadingLabel('⏳ 이전 번역 복원 중...');
    } else {
      // Show analysis label immediately — no await, UI must respond instantly.
      setLoadingLabel('🧠 문장 분석 중...');

      // Non-blocking probe: a gemma checkpoint may exist even when
      // existingTranslations is empty (checkpoint survived but DB partial cache
      // was cleared). The engine will resume internally — show the correct label.
      const jobIdAtProbe = myJobId;
      AsyncStorage.getItem(`gemma_checkpoint_v4_${youtubeVideoId ?? ''}`)
        .then(v => {
          if (!v) return;
          // Verify job is still valid before touching UI.
          if (jobIdAtProbe !== jobIdRef.current) return;
          setLoadingLabel('⏳ 이전 번역 복원 중...');
        })
        .catch(() => {});
    }

    // 10% visual anchor — model loaded, translation imminent.
    // Placed BEFORE hasGemma check: if model failed to load, this must NOT fire.
    if (!isResume) {
      // Step 1: start smooth 0 → 12% animation.
      // animateTo is async (RAF-based) and owns the visual progress update.
      animateTo(0.12);

      const crawlStartJobId = myJobId;

      requestAnimationFrame(() => {
        // Guard: job may have been cancelled between animateTo() and this frame.
        if (crawlStartJobId !== jobIdRef.current) return;

        // Compute a single authoritative startFrom that both the ref and
        // startCrawl's fromVal argument agree on.
        // Math.max ensures we never start the crawl below 0.12 even if
        // animateTo hasn't committed its first frame yet (RAF timing race).
        const startFrom = Math.max(animProgressRef.current, 0.12);
        if (animProgressRef.current < startFrom) {
          animProgressRef.current = startFrom;
          // Do NOT call setSubtitleProgress here — animateTo owns the render.
        }

        // Phase 2: startFrom → 15% over 8 s (SBD batches)
        // Phase 3: 15%      → 20% over 5 s (mergeFragments / group confirmation)
        startCrawl(startFrom, 0.15, 8_000, myJobId, () => {
          startCrawl(0.15, 0.20, 5_000, myJobId);
        });
      });
    }

    if (!hasGemma) {
      setPhase("done");
      setRemainingSecs(null);
      animateTo(1);
      setTranslationEverCompleted(true); // [FIX BUG2]
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
      setTranslationEverCompleted(true); // [FIX BUG2]
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
          if (isBgRunningRef.current) return; // BG started mid-translation — stop updating UI

          const totalDone = alreadyDoneCount + completed;
          const totalAll  = total;   // authoritative value from translateSegments
          setTranslatedCount(totalDone);
          const newProgress = totalAll > 0 ? totalDone / totalAll : 0;
          if (newProgress > animProgressRef.current) animateTo(newProgress);

          // Update rolling rate (exponential moving average, α = 0.3)
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
      setTranslationEverCompleted(true); // [FIX BUG2] FG translation fully finished

      console.log(`[TRANSLATE] ✓ job=${myJobId} complete: ${finalSubs.length} segs`);
      saveSubtitles(youtubeVideoId ?? "default", useLang, useGenre, finalSubs).catch(() => {});

    } catch (e: any) {
      if (e?.message === 'INFERENCE_CANCELLED') return; // clean exit — not an error
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
    // [BUG FIX 4] allSegmentsRef에 sentinel('done') 세팅된 경우: 캐시 히트로 이미 완료
    if (allSegmentsRef.current !== null) return;

    if (bgResultApplied.current) {
      console.log('[YT_SCREEN] BG result applied, skipping FG subtitle load');
      return;
    }

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

    // Always store segments — needed by language/genre change handlers and BG
    // result merge even when BG is running.  Must happen before any early return.
    allSegmentsRef.current  = result;
    lastFetchResult.current = result;

    // [FIX] If BG is translating: show the raw (original-language) segments so
    // the user sees something in the subtitle overlay while BG works.
    // Do NOT start FG translation — BG will auto-apply when it finishes.
    if (isBgRunningRef.current) {
      console.log('[YT_SCREEN] BG translation running — segments stored, showing raw subtitles');
      const rawSubs: SubtitleSegment[] = result.segments.map((seg) => ({
        id:         makeSegmentId(seg.startTime, seg.endTime),
        startTime:  seg.startTime,
        endTime:    seg.endTime,
        original:   seg.text,
        translated: seg.text, // display original-language text while BG translates
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
    if (!youtubeVideoId) return;

    // ── Step 1: capture videoId before any await ──────────────────────────
    const videoIdAtStart = youtubeVideoId;

    // ── Step 2: dedup guard — only the first call per video should proceed ─
    if (playerReadyOnceRef.current) return;
    playerReadyOnceRef.current = true;

    // ── Step 3: wait for genre to be restored from AsyncStorage ───────────
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

    // ── Step 4: stale check after genre await ─────────────────────────────
    if (currentVideoIdRef.current !== videoIdAtStart) return;

    // ── Step 5: alias the resolved genre value ────────────────────────────
    const genre = genreValueRef.current;

    // Probe gemma checkpoint so user sees a resume hint within
    // milliseconds of returning to the screen — before any network
    // request or model load begins.
    AsyncStorage.getItem(`gemma_checkpoint_v4_${youtubeVideoId}`)
      .then(raw => {
        // Guard: only set if nothing has written a label yet.
        // Prevents a race where the cache-miss fetch label (📡) has
        // already been written before this async probe resolves,
        // which would cause an incorrect ⏳ → 📡 → ⏳ overwrite sequence.
        if (raw && loadingSubLabelRef.current === '') {
          setLoadingLabel('⏳ 이전 번역 이어서 준비 중...');
          setPhase('resuming');
        }
      })
      .catch(() => {});

    if (isBgRunningRef.current) {
      // BG is running — try to grab a completed result immediately before the next poll.
      // Handles the race: BG finishes at t=0, user returns at t=100ms, next poll at t=500ms.
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
        setTranslationEverCompleted(true); // [FIX BUG2] BG result applied on ready
        saveSubtitles(youtubeVideoId, earlyResult.language, genre, restored).catch(() => {});
        await clearBgResult(youtubeVideoId);
        if (currentVideoIdRef.current !== videoIdAtStart) return;
        return;
      }
      // BG still in progress — trigger subtitle fetch so handleSubtitlesLoaded
      // can store segments and show raw subtitles while BG translates.
      setPhase('idle');
      ytPlayerRef.current?.fetchSubtitles(); // BG path — no label
      return;
    }

    const cached = await loadSubtitles(youtubeVideoId, targetLanguage, genre);

    if (currentVideoIdRef.current !== videoIdAtStart) return;

    // Re-check ref after the async gap — BG may have started while we awaited
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

        // partial 캐시: allSegmentsRef를 null로 유지하여 fetchSubtitles 허용
        allSegmentsRef.current = null;
        if (!autoFetchCompletedRef.current) {
          setLoadingLabel('⏳ 이전 번역 이어서 준비 중...');
          setPhase("resuming");                              // ref updated synchronously
          ytPlayerRef.current?.fetchSubtitles();             // must come AFTER setPhase
        } else {
          setPhase("resuming");
        }
        // else: auto-fetch already ran — handleSubtitlesLoaded will pick up
        // partialTranslationsRef and resume translation on its own
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

        // Pre-load all cached translations into partialTranslationsRef so
        // translateFromResult can skip segments that are already done (fast path).
        // Clear the sentinel so handleSubtitlesLoaded runs the normal translation flow.
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
          setLoadingLabel('⏳ 이전 번역 이어서 준비 중...');
          setPhase("resuming");                              // ref updated synchronously
          ytPlayerRef.current?.fetchSubtitles();             // must come AFTER setPhase
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
      // Auto-fetch already completed and handleSubtitlesLoaded has run.
      // Translation is already in progress — do not overwrite the phase
      // or issue a redundant fetch.
      console.log("[CACHE] Cache miss — auto-fetch already completed, skipping");
      return;
    }
    console.log("[CACHE] Cache miss → start fetch");
    // Cache miss — fetch is actually starting, safe to show the label.
    // FIX 2: guard against checkpoint probe having already set resuming phase.
    if (subtitlePhaseRef.current !== 'resuming') {
      setLoadingLabel('📡 자막 가져오는 중...');
    }
    setPhase("fetching");
    ytPlayerRef.current?.fetchSubtitles();
  }, [youtubeVideoId, targetLanguage, setPlaying, setSubtitles, setLoadingLabel, setPhase]);

  // ── 뒤로가기 ─────────────────────────────────────────────────────────────
  const handleBack = useCallback(async () => {
    // [BUG 5] Same dual-guard as unmount — don't cancel FG inference if BG owns it.
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
  const handleSeek = useCallback((t: number) => {
    setCurrentTime(t);
    bumpSeek();
    ytPlayerRef.current?.seekTo(t);
  }, [setCurrentTime, bumpSeek]);

  // ── 수동 재시도 ───────────────────────────────────────────────────────────
  const handleRetrySubtitles = useCallback(() => {
    jobIdRef.current++;
    cancelledRef.current = true;
    bgResultApplied.current = false;
    highWaterProgressRef.current = 0; // [BUG 6]
    setTranslationEverCompleted(false); // [FIX BUG2]
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

  // ── 자막 불러오기 중지 (fetching 단계에서 취소, retry 없음) ─────────────────
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
    highWaterProgressRef.current = 0; // [BUG 6]
    setTranslationEverCompleted(false); // [FIX BUG2]

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
    highWaterProgressRef.current = 0; // [BUG 6]
    setTranslationEverCompleted(false); // [FIX BUG2]

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

    // [BUG 2] Set the ref synchronously — do NOT rely on the useEffect sync which
    // runs after the next render commit.  Any async code already in-flight (e.g.
    // handlePlayerReady awaiting loadSubtitles) will see the true value immediately.
    isBgRunningRef.current = true;

    // Cancel FG synchronously BEFORE any await so no FG work slips through
    jobIdRef.current++;
    cancelledRef.current = true;
    // [BUG A] Use cancelFgInference (not cancelCurrentInference) so the counter
    // re-alignment guarantees the upcoming BG enqueueInference call is never
    // treated as stale, regardless of how many prior cancels happened.
    cancelFgInference();
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }

    setSubtitleProgress(0);
    setTranslatedCount(0);
    setTotalSegments(0);
    highWaterProgressRef.current = 0;
    setTranslationEverCompleted(false); // [FIX BUG2] BG started — reset completed flag
    clearSubtitles();

    // Cache any already-fetched FG subtitles so BG can skip the network round-trip
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
      // Only clear phase after BG is confirmed started — prevents flicker when
      // transitioning from phase='done' or phase='translating'.
      setPhase('idle');
    } catch (e: any) {
      isBgRunningRef.current = false; // rollback — BG never started
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
          title:           '알림 권한',
          message:         '번역 완료 시 알림을 받으려면 권한이 필요합니다.',
          buttonPositive:  '허용',
          buttonNegative:  '거부',
        }
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
    }
    // [FIX ISSUE2] Request battery optimization exemption so the OS does not
    // suspend the foreground service on aggressive OEM ROMs. The native method
    // opens the system dialog if the exemption is not already granted, and also
    // schedules the WorkManager watchdog. We fire-and-forget (no await) so the
    // user flow continues immediately.
    if (Platform.OS === 'android') {
      NativeModules.TranslationService?.checkAndRequestBatteryOptimization?.()
        .catch(() => {});
    }

    if (isBgRunning) {
      Alert.alert(
        '백그라운드 번역 중',
        '현재 번역이 진행 중입니다.\n취소하고 새로 시작할까요?',
        [
          { text: '계속 유지', style: 'cancel' },
          {
            text: '취소하고 새로 시작',
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

  // BUG 2: while BG is running, treat phase as 'idle' everywhere in the render
  // so the chip/pill/save button never show a stale 'done' state.
  const displayPhase: SubtitlePhase = isBgRunning ? 'idle' : currentPhase;

  // Unified progress — takes the higher of the raw value and the high-water mark
  // so the bar never jumps backward mid-job.
  const rawProgress = isBgRunning
    ? (bgStatus?.progress ?? 0)
    : (displayPhase === 'done' ? 1 : subtitleProgress);

  // Safe read during render — ref mutation happens in effect below
  const barProgress = Math.max(rawProgress, highWaterProgressRef.current);
  // [FIX BUG3] Use < 0.02 threshold (not === 0) so intermediate progress saves
  // (0.01 after lock, 0.04 after fetch) transition the shimmer to a real bar.
  const showShimmer = barProgress < 0.02 && (isBgRunning || (displayPhase !== 'idle' && displayPhase !== 'done'));

  // Update high-water mark outside render path (render-phase mutation is unsafe in StrictMode)
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
          <Text style={styles.headerBtnText}>⚙</Text>
        </TouchableOpacity>
      </View>}

      {/* ── 플레이어 ──────────────────────────────────────────────────────── */}
      <View style={isLandscape
        ? {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1,
            backgroundColor: '#000',
            justifyContent: 'center',
            alignItems: 'center',
          }
        : [styles.playerWrap, { height: playerHeight }]}>
        <YouTubePlayer
          ref={ytPlayerRef}
          videoId={youtubeVideoId}
          height={playerHeight}
          playbackRate={playbackRate}
          onReady={handlePlayerReady}
          onSubtitleData={handleSubtitleData}
          onSubtitlesLoaded={handleSubtitlesLoaded}
          onSeek={handleSeek}
          onFullscreenToggle={handleFullscreenToggle}
          isFullscreen={isLandscape}
          onStateChange={(state) => {
            if (state === "playing") {
              setPlaying(true);
              if (subtitlePhase === "idle" && !isBgRunningRef.current) {
                setPhase("fetching");
              }
            }
            if (state === "paused" || state === "ended") {
              setPlaying(false);
            }
          }}
          onError={(code) => {
            Alert.alert(
              "재생 오류",
              code === "150" || code === "101"
                ? "이 영상은 임베드가 허용되지 않습니다.\n다른 영상을 시도해 보세요."
                : `YouTube 오류 코드: ${code}`
            );
          }}
        />
        <View style={styles.subtitleLayer} pointerEvents="box-none">
          <SubtitleOverlay />
        </View>
      </View>

      {/* ── [FIX ISSUE2] 시간 표시 — 플레이어 바로 아래 ──────────────────────── */}
      {!isLandscape && (
        <View style={styles.timeSection}>
          <Text style={styles.timeText}>{fmt(currentTime)}</Text>
          <Text style={styles.timeText}>{fmt(duration)}</Text>
        </View>
      )}

      {/* ── [FIX ISSUE4] Unified progress card — FG active phases ────────── */}
      {/* Replaces the old small pill for fetching/translating/resuming.      */}
      {/* Matches the BG banner layout: large % · title · sub-text · cancel   */}
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
            <Text style={progressCard.sub} numberOfLines={1}>
              {isStale
                ? '처리 중...'
                : displayPhase === 'fetching'
                  ? (loadingSubLabel || '자막 요청 중...')
                  : (displayPhase === 'translating' || displayPhase === 'resuming') &&
                    translatedCount > 0 && totalSegments > 0
                    ? `${translatedCount} / ${totalSegments}`
                    : loadingSubLabel !== ''
                      ? loadingSubLabel
                      : '번역 준비 중...'}
            </Text>
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

      {/* Error / no-subtitles / fallback — keep compact pill for these states */}
      {!isLandscape && !isBgRunning && (
        displayPhase === 'error' ||
        displayPhase === 'no_subtitles' ||
        displayPhase === 'fallback_whisper'
      ) && (
        <View style={[
          pillStyles.container,
          { borderLeftColor: getPillBorderColor(displayPhase) },
        ]}>
          <Text style={{ fontSize: 13, marginRight: 4 }}>
            {displayPhase === 'error'            ? '❌'
            : displayPhase === 'no_subtitles'    ? '⚠️'
            : '🎙'}
          </Text>
          <Text
            style={[
              pillStyles.statusText,
              displayPhase === 'error' && { color: '#ef4444' },
            ]}
            numberOfLines={1}
          >
            {getSubtitleStatusLabel(displayPhase, subtitleProgress)}
          </Text>
          <TouchableOpacity onPress={handleRetrySubtitles} style={pillStyles.retryBtn}>
            <Text style={pillStyles.retryBtnText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── [FIX ISSUE4] Background translation banner ───────────────────── */}
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
                  if (p < 0.02) return '자막 요청 중...';
                  if (p < 0.05) return '자막 수신 중...';
                  return '모델 로딩 중...';
                }
                if (st === 'saving') return '결과 저장 중...';
                if (st === 'translating' && (bgStatus?.totalCount ?? 0) > 0) {
                  return `${bgStatus!.translatedCount} / ${bgStatus!.totalCount}`;
                }
                return '번역 준비 중...';
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
          <Text style={{ fontSize: 16 }}>✅</Text>
          <Text style={[progressCard.title, { color: '#22c55e', marginLeft: 8 }]}>
            {t("player.bgDone")}
          </Text>
        </View>
      )}

      {!isLandscape && bgStatus?.status === 'error' && (
        <View style={[progressCard.card, { backgroundColor: '#1a0a0a', borderTopColor: '#ef4444' }]}>
          <Text style={{ flex: 1, color: '#ef4444', fontSize: 11 }}>
            ❌ {bgStatus.error ?? '번역 실패'}
          </Text>
          <TouchableOpacity onPress={handleSendToBackground} style={progressCard.cancelBtn}>
            <Text style={progressCard.cancelBtnText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── [FIX ISSUE2] 시크바 — 번역 카드 바로 위, 컨트롤 버튼 바로 위 ──── */}
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
          <YoutubeSeekBar currentTime={currentTime} duration={duration} onSeek={handleSeek} />
        </View>
      )}

      {/* ── 컨트롤 바 1행 ─────────────────────────────────────────────────── */}
      {!isLandscape && <View style={styles.controlBar}>
        <TouchableOpacity
          style={styles.playBtn}
          onPress={() => {
            if (isPlaying) {
              ytPlayerRef.current?.pause();
            } else {
              ytPlayerRef.current?.play();
            }
            setPlaying(!isPlaying);
          }}
          activeOpacity={0.75}
        >
          <Text style={styles.playBtnText}>{isPlaying ? "⏸" : "▶"}</Text>
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
      </View>}

      {/* ── 컨트롤 바 2행 ─────────────────────────────────────────────────── */}
      {!isLandscape && <View style={styles.controlBar2}>
        <TouchableOpacity
          style={styles.chipBtn}
          onPress={() => setSubtitlePanelVisible(true)}
        >
          <Text style={styles.chipBtnText}>Aa</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.chipBtn,
            styles.chipBtnFlex,
            isRetranslating && styles.chipBtnDisabled,
          ]}
          onPress={() => !isRetranslating && setLangModalVisible(true)}
        >
          <Text style={styles.chipBtnText} numberOfLines={1}>
            🌐 {getLanguageByCode(targetLanguage)?.nativeName ?? targetLanguage}
          </Text>
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

        {/* [FIX BUG2] Require translationEverCompleted so save button never appears
            on a stale cache restore before BG state is confirmed. */}
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
                  {targetLanguage === lang.code && <Text style={styles.langCheck}>✓</Text>}
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
                  {selectedGenre === g.key && <Text style={styles.langCheck}>✓</Text>}
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

  // [FIX ISSUE2] Time labels stay directly under the video player
  timeSection: {
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: '#111',
    paddingHorizontal: 14, paddingTop: 4, paddingBottom: 2,
  },
  timeText: { color: '#666', fontSize: 11, fontVariant: ['tabular-nums'] },

  // [FIX ISSUE2] Seek bar moved above the control buttons (below translation card)
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
  langCheck:    { color: "#2563eb", fontSize: 16, fontWeight: "700" },
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

// [FIX ISSUE4] Unified progress card — same visual style for both FG and BG.
// FG shows "번역 진행 중", BG shows "백그라운드 번역 진행 중".
// Matches the layout: large % · title+sub · cancel button.
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