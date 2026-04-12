/**
 * YoutubePlayerScreen (v10)
 *
 * 변경사항 (v9 → v10):
 * ─────────────────────────────────────────────────────────────────────────────
 * [ARCH FIX] RN 직접 fetch 제거 → WebView 컨텍스트 fetch 복귀
 *   - RN fetch는 Google이 429로 차단 (쿠키/UA 없음)
 *   - YouTubePlayer 컴포넌트가 playerReady 후 injectJavaScript()로 fetch
 *   - Screen은 onSubtitleData 콜백으로 결과만 수신
 *
 * [FIX] handlePlayerReady 단순화
 *   - fetchYoutubeSubtitles() 직접 호출 제거
 *   - setPlaying + setSubtitlePhase("fetching")만 담당
 *   - 실제 자막 데이터는 onSubtitleData 콜백으로 수신
 *
 * [KEEP v9]
 *   - youtubeVideoId null 안전 처리
 *   - handleSubtitleData segments 유효성 검사
 *   - lastFetchResult 캐시로 언어·장르 변경 시 재번역만 수행
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useRef, useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
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
} from "react-native";
import * as ScreenOrientation from "expo-screen-orientation";
import { router } from "expo-router";
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
import {
  loadModel as loadGemma,
  unloadModel as unloadGemma,
  translateSegments,
} from "../services/gemmaTranslationService";
import { getLocalModelPath } from "../services/modelDownloadService";
import { SubtitleSegment } from "../store/usePlayerStore";

// ── 상수 ─────────────────────────────────────────────────────────────────────

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

const GENRE_OPTIONS = [
  { key: "general",      label: "일반" },
  { key: "tech lecture", label: "기술 강의" },
  { key: "comedy",       label: "코미디" },
  { key: "news",         label: "뉴스" },
  { key: "documentary",  label: "다큐멘터리" },
  { key: "gaming",       label: "게임" },
  { key: "education",    label: "교육" },
] as const;

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
  | "translating"
  | "done"
  | "error"
  | "no_subtitles"
  | "fallback_whisper";

function getSubtitleStatusLabel(phase: SubtitlePhase, progress: number): string {
  switch (phase) {
    case "fetching":         return "📡 자막 데이터 가져오는 중...";
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
  const youtubeVideoId = usePlayerStore((s) => s.youtubeVideoId);
  const videoName      = usePlayerStore((s) => s.videoName);
  const isPlaying      = usePlayerStore((s) => s.isPlaying);
  const setPlaying     = usePlayerStore((s) => s.setPlaying);
  const currentTime    = usePlayerStore((s) => s.currentTime);
  const duration       = usePlayerStore((s) => s.duration);
  const subtitles      = usePlayerStore((s) => s.subtitles);
  const setSubtitles   = usePlayerStore((s) => s.setSubtitles);
  const clearSubtitles = usePlayerStore((s) => s.clearSubtitles);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const bumpSeek       = usePlayerStore((s) => s.bumpSeek);

  const subtitleMode   = useSettingsStore((s) => s.subtitleMode);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const update         = useSettingsStore((s) => s.update);

  // ── 훅 ───────────────────────────────────────────────────────────────────
  const { loaded: modelLoaded } = useWhisperModel();
  const {
    status: whisperStatus,
    start:  startWhisper,
    stop:   stopWhisper,
  } = useMediaProjectionProcessor();

  const { isRetranslating } = useRetranslate();

  // ── Refs ─────────────────────────────────────────────────────────────────
  const ytPlayerRef       = useRef<YouTubePlayerHandle>(null);
  const gemmaLoadedRef    = useRef(false);
  const cancelledRef      = useRef(false);
  // WebView에서 받은 자막 원본 캐시 (언어·장르 변경 시 재번역용)
  const lastFetchResult       = useRef<SubtitleFetchResult | null>(null);
  // 전체 세그먼트 로드 여부 (중복 번역 방지)
  const allSegmentsRef        = useRef<SubtitleFetchResult | null>(null);
  // 번역 완료 캐시 (startTime → translated)
  const translationCacheRef   = useRef<Map<number, string>>(new Map());
  // Whisper 전환 중복 방지
  const whisperStartedRef     = useRef(false);

  // ── Local state ───────────────────────────────────────────────────────────
  const [langModalVisible,     setLangModalVisible]     = useState(false);
  const [subtitlePanelVisible, setSubtitlePanelVisible] = useState(false);
  const [genreModalVisible,    setGenreModalVisible]    = useState(false);
  const [saveModalVisible,     setSaveModalVisible]     = useState(false);
  const [speedIdx,             setSpeedIdx]             = useState(2);
  const [selectedGenre,        setSelectedGenre]        = useState("general");
  const isLandscape = screenWidth > screenHeight;
  const navigation  = useNavigation();

  // Hide the native stack header unconditionally on this screen
  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, []);

  // Show/hide status bar based on orientation
  useEffect(() => {
    StatusBar.setHidden(isLandscape);
    return () => { StatusBar.setHidden(false); };
  }, [isLandscape]);

  const [subtitlePhase,    setSubtitlePhase]    = useState<SubtitlePhase>("idle");
  const [subtitleProgress, setSubtitleProgress] = useState(0);
  const [totalSegments,    setTotalSegments]     = useState(0);
  const [translatedCount,  setTranslatedCount]   = useState(0);
  const [usingWhisper,     setUsingWhisper]      = useState(false);

  const playbackRate = SPEEDS[speedIdx];
  const videoHeight  = Math.round(screenWidth * (9 / 16)); // portrait baseline
  // In landscape, screenHeight is the short dimension — fill it completely.
  const playerHeight = isLandscape ? screenHeight : videoHeight;

  // ── 라우팅 가드 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!youtubeVideoId) router.back();
  }, [youtubeVideoId]);

  // ── 화면 unmount 시 정리 ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (gemmaLoadedRef.current) {
        unloadGemma().catch(() => {});
        gemmaLoadedRef.current = false;
      }
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, []);

  // ── no_subtitles → Whisper 전환 (중복 방지) ──────────────────────────────
  useEffect(() => {
    if (subtitlePhase !== "no_subtitles") return;
    if (usingWhisper) return;
    if (whisperStartedRef.current) return;

    whisperStartedRef.current = true;
    setUsingWhisper(true);
    setSubtitlePhase("fallback_whisper");

    Alert.alert(
      "자막 없음",
      "이 영상에 자막 데이터가 없습니다.\nWhisper 음성 인식 모드로 전환합니다.",
      [{ text: "확인" }]
    );
    if (modelLoaded) startWhisper();
  }, [subtitlePhase]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── 번역 파이프라인 ──────────────────────────────────────────────────────
  const translateFromResult = useCallback(async (
    result: SubtitleFetchResult,
    langOverride?: string,
    genreOverride?: string,
  ) => {
    cancelledRef.current = false;

    if (!result || result.segments.length === 0) {
      setSubtitlePhase("no_subtitles");
      return;
    }

    const useLang  = langOverride  ?? targetLanguage;
    const useGenre = genreOverride ?? selectedGenre;

    // LOG 1 — pipeline entry
    console.log(
      `[TRANSLATE] ▶ start: ${result.segments.length} segments, sourceLang=${result.language}, targetLang=${useLang}, genre=${useGenre}`
    );

    // 1. 원문 먼저 Store 적재 → 번역 전에도 원문 자막 노출
    const originalOnly: SubtitleSegment[] = (result.segments ?? [])
      .filter((seg) => seg != null && seg.text != null)
      .map((seg, i) => ({
        id:         `yt_${i}_${Math.round(seg.startTime * 1000)}`,
        startTime:  seg.startTime,
        endTime:    seg.endTime,
        original:   seg.text,
        translated: "",
      }));
    setSubtitles(originalOnly);
    setTotalSegments(result.segments.length);
    setTranslatedCount(0);
    setSubtitlePhase("translating");
    setSubtitleProgress(0);

    // LOG 2 — originals in store
    console.log(`[TRANSLATE] ✓ original loaded to store: ${originalOnly.length} segments`);
    console.log(`[TRANSLATE] sample originals:`, originalOnly.slice(0, 3).map((s) => `"${s.original}" (${s.startTime.toFixed(2)}s)`));

    // 2. Gemma 로드
    const hasGemma = await ensureGemma();
    if (cancelledRef.current) return;

    if (!hasGemma) {
      setSubtitlePhase("done");
      setSubtitleProgress(1);
      return;
    }

    // 3. 번역
    const langName = getLanguageByCode(useLang)?.name ?? useLang;
    const input = result.segments.map((seg) => ({
      start:      seg.startTime,
      end:        seg.endTime,
      text:       seg.text,
      translated: "",
    }));

    try {
      const translated = await translateSegments(
        input,
        (completed, total, partial) => {
          if (cancelledRef.current) return;
          setTranslatedCount(completed);
          setSubtitleProgress(total > 0 ? completed / total : 0);

          // LOG 3 — translation progress (every 10 segments and on completion)
          if (completed % 10 === 0 || completed === total) {
            console.log(`[TRANSLATE] progress: ${completed}/${total} (${Math.round(completed / total * 100)}%)`);
            if (partial && partial[completed - 1]) {
              console.log(`[TRANSLATE] latest: "${partial[completed - 1]?.text}" → "${partial[completed - 1]?.translated}"`);
            }
          }

          // 번역 진행 중 Store 즉시 반영
          const updatedSubs: SubtitleSegment[] = originalOnly.map((sub, i) => ({
            ...sub,
            translated: (partial != null && i < partial.length && partial[i] != null)
              ? (partial[i].translated ?? sub.original)
              : sub.original,
          }));
          setSubtitles(updatedSubs);
        },
        youtubeVideoId ?? "default",
        langName,
        useGenre,
      );

      if (!cancelledRef.current) {
        const finalSubs: SubtitleSegment[] = originalOnly.map((sub, i) => ({
          ...sub,
          translated: (
            translated != null &&
            i < translated.length &&
            translated[i] != null &&
            translated[i].translated &&
            translated[i].translated.trim().length > 0 &&
            translated[i].translated !== sub.original
          ) ? translated[i].translated : sub.original,
        }));
        finalSubs.forEach((sub) => {
          translationCacheRef.current.set(sub.startTime, sub.translated);
        });
        setSubtitles(finalSubs);
        setSubtitlePhase("done");
        setSubtitleProgress(1);
        setTranslatedCount(result.segments.length);

        // LOG 4 — completion sample (first 5 + last 5)
        console.log(`[TRANSLATE] ✓ complete: ${finalSubs.length} segments`);
        const sample = [...finalSubs.slice(0, 5), ...finalSubs.slice(-5)];
        sample.forEach((s) => {
          const status = s.translated && s.translated !== s.original ? "✓" : "⚠ UNTRANSLATED";
          console.log(`[TRANSLATE] ${status} ${s.startTime.toFixed(2)}s: "${s.original}" → "${s.translated}"`);
        });

        // LOG 5 — untranslated count warning
        const untranslatedCount = finalSubs.filter((s) => !s.translated || s.translated === s.original).length;
        if (untranslatedCount > 0) {
          console.warn(`[TRANSLATE] ⚠ ${untranslatedCount} segments untranslated out of ${finalSubs.length}`);
        }
      }
    } catch (e) {
      console.error("[YT_SCREEN] 번역 오류:", e);
      if (!cancelledRef.current) setSubtitlePhase("error");
    }
  }, [targetLanguage, selectedGenre, youtubeVideoId, setSubtitles]);

  // ── onSubtitleData 콜백 ──────────────────────────────────────────────────
  // 500ms 폴링에서 현재 활성 세그먼트(1개)만 전달됨 — 번역은 onSubtitlesLoaded에서 처리
  // SubtitleOverlay는 store에서 읽으므로 여기서 별도 작업 불필요
  const handleSubtitleData = useCallback((_result: SubtitleFetchResult) => {}, []);

  // ── onSubtitlesLoaded 콜백 ────────────────────────────────────────────────
  // 전체 세그먼트 배열이 한 번에 도착 → 번역 파이프라인을 정확히 1회 실행
  const handleSubtitlesLoaded = useCallback((
    segments: TimedTextSegment[],
    language: string,
  ) => {
    if (allSegmentsRef.current) return; // 이미 로드됨, 중복 방지

    if (!segments || segments.length === 0) {
      console.log("[YT_SCREEN] 자막 없음 → no_subtitles");
      setSubtitlePhase("no_subtitles");
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

    allSegmentsRef.current  = result;
    lastFetchResult.current = result;

    console.log(
      `[YT_SCREEN] 전체 세그먼트 수신: ${segments.length}개, lang=${language}`
    );

    setSubtitlePhase("translating");
    translateFromResult(result);
  }, [translateFromResult]);

  // ── 플레이어 준비 ─────────────────────────────────────────────────────────
  // 자막 fetch는 YouTubePlayer 내부에서 injectJavaScript()로 수행
  // Screen은 재생 시작 + phase 표시만 담당
  const handlePlayerReady = useCallback(() => {
    if (!youtubeVideoId) return;
    setPlaying(true);
    setSubtitlePhase("fetching");
  }, [youtubeVideoId, setPlaying]);

  // ── 뒤로가기 ─────────────────────────────────────────────────────────────
  const handleBack = useCallback(async () => {
    cancelledRef.current = true;
    if (whisperStatus.isRunning) await stopWhisper();
    if (gemmaLoadedRef.current) {
      try { await unloadGemma(); } catch {}
      gemmaLoadedRef.current = false;
    }
    clearSubtitles();
    setPlaying(false);
    router.back();
  }, [whisperStatus.isRunning, stopWhisper, clearSubtitles, setPlaying]);

  // ── 전체화면 토글 ─────────────────────────────────────────────────────────
  // Rotates device orientation only — player height responds via the listener above.
  const handleFullscreenToggle = useCallback(async () => {
    try {
      if (isLandscape) {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      } else {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE_LEFT);
      }
      // Unlock immediately so future manual rotations keep working
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
    both:        "원문+번역",
    original:    "원문만",
    translation: "번역만",
  };

  // ── 시크 ─────────────────────────────────────────────────────────────────
  const handleSeek = useCallback((t: number) => {
    setCurrentTime(t); // optimistic update — overlay reacts immediately
    bumpSeek();        // force subtitle re-evaluation at new position
    ytPlayerRef.current?.seekTo(t);
  }, [setCurrentTime, bumpSeek]);

  // ── 수동 재시도 ───────────────────────────────────────────────────────────
  const handleRetrySubtitles = useCallback(() => {
    cancelledRef.current = true;
    clearSubtitles();
    setUsingWhisper(false);
    whisperStartedRef.current     = false;
    lastFetchResult.current       = null;
    allSegmentsRef.current        = null;
    translationCacheRef.current   = new Map();
    setSubtitlePhase("fetching");
    setSubtitleProgress(0);
    setTranslatedCount(0);
    setTotalSegments(0);
    setTimeout(() => {
      cancelledRef.current = false;
      ytPlayerRef.current?.fetchSubtitles();
    }, 300);
  }, [clearSubtitles]);

  // ── 장르 변경 ─────────────────────────────────────────────────────────────
  const handleGenreChange = useCallback((genre: string) => {
    setSelectedGenre(genre);
    setGenreModalVisible(false);

    if (lastFetchResult.current && lastFetchResult.current.segments.length > 0) {
      cancelledRef.current = true;
      clearSubtitles();
      setTimeout(() => {
        cancelledRef.current = false;
        translateFromResult(lastFetchResult.current!, targetLanguage, genre);
      }, 100);
    } else {
      handleRetrySubtitles();
    }
  }, [clearSubtitles, translateFromResult, targetLanguage, handleRetrySubtitles]);

  // ── 언어 변경 → 재번역만 ─────────────────────────────────────────────────
  const handleLanguageChange = useCallback((langCode: string) => {
    update({ targetLanguage: langCode });
    setLangModalVisible(false);

    if (!youtubeVideoId) return;

    if (lastFetchResult.current && lastFetchResult.current.segments.length > 0) {
      cancelledRef.current = true;
      clearSubtitles();
      setTimeout(() => {
        cancelledRef.current = false;
        translateFromResult(lastFetchResult.current!, langCode, selectedGenre);
      }, 100);
    } else {
      handleRetrySubtitles();
    }
  }, [youtubeVideoId, update, clearSubtitles, translateFromResult, selectedGenre, handleRetrySubtitles]);

  if (!youtubeVideoId) return null;

  const currentPhase: SubtitlePhase =
    usingWhisper
      ? (whisperStatus.isRunning ? "fallback_whisper" : "idle")
      : subtitlePhase;

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
        ? [StyleSheet.absoluteFillObject, { zIndex: 1 }]
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
            if (state === "playing" && subtitlePhase === "idle") {
              setSubtitlePhase("fetching");
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
        {/* ── 자막 오버레이 ─────────────────────────────────────────────── */}
        <View style={styles.subtitleLayer} pointerEvents="box-none">
          <SubtitleOverlay />
        </View>
      </View>

      {/* ── 시크바 ────────────────────────────────────────────────────────── */}
      {!isLandscape && (
        <View style={styles.seekSection}>
          <YoutubeSeekBar currentTime={currentTime} duration={duration} onSeek={handleSeek} />
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{fmt(currentTime)}</Text>
            <Text style={styles.timeText}>{fmt(duration)}</Text>
          </View>
        </View>
      )}

      {/* ── 자막 상태 바 ─────────────────────────────────────────────────── */}
      {!isLandscape && currentPhase !== "idle" && currentPhase !== "done" && (
        <View style={[
          styles.statusBar,
          currentPhase === "error" && styles.statusBarError,
        ]}>
          {(currentPhase === "fetching" || currentPhase === "translating") && (
            <ActivityIndicator size="small" color="#60a5fa" style={{ marginRight: 6 }} />
          )}
          {currentPhase === "translating" && subtitleProgress > 0 && (
            <View style={styles.progressBarWrap}>
              <View style={[styles.progressBarFill, { width: `${Math.round(subtitleProgress * 100)}%` as any }]} />
            </View>
          )}
          <Text style={[
            styles.statusText,
            currentPhase === "error"            && styles.statusTextError,
            currentPhase === "fallback_whisper" && styles.statusTextWhisper,
          ]}>
            {getSubtitleStatusLabel(currentPhase, subtitleProgress)}
          </Text>
          {(currentPhase === "no_subtitles" || currentPhase === "error") && (
            <TouchableOpacity onPress={handleRetrySubtitles} style={styles.retryBtn}>
              <Text style={styles.retryBtnText}>재시도</Text>
            </TouchableOpacity>
          )}
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
          style={[
            styles.chipBtn,
            styles.chipBtnFlex,
            currentPhase === "done"             && styles.chipBtnDone,
            currentPhase === "translating"      && styles.chipBtnActive,
            currentPhase === "fallback_whisper" && styles.chipBtnWhisper,
          ]}
          onPress={handleRetrySubtitles}
          activeOpacity={0.75}
        >
          {currentPhase === "fetching" || currentPhase === "translating"
            ? <ActivityIndicator size="small" color="#ccc" />
            : <Text style={styles.chipBtnText} numberOfLines={1}>
                {currentPhase === "done"              ? "✓ 자막 완료"
                : currentPhase === "fallback_whisper" ? "🎙 Whisper"
                : currentPhase === "no_subtitles"     ? "⚠️ 재시도"
                : "📡 자막 로딩"}
              </Text>
          }
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
          style={[styles.chipBtn, styles.chipBtnFlex]}
          onPress={() => setGenreModalVisible(true)}
        >
          <Text style={styles.chipBtnText} numberOfLines={1}>
            🎬 {GENRE_OPTIONS.find((g) => g.key === selectedGenre)?.label ?? "일반"}
          </Text>
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

        {subtitlePhase === "done" && subtitles.length > 0 && (
          <TouchableOpacity
            style={[
              styles.chipBtn,
              { backgroundColor: "#14532d", borderWidth: 1, borderColor: "#22c55e" },
            ]}
            onPress={() => setSaveModalVisible(true)}
          >
            <Text style={styles.chipBtnText}>💾 저장</Text>
          </TouchableOpacity>
        )}
      </View>}

      {/* ── 번역 진행 세그먼트 수 ─────────────────────────────────────────── */}
      {!isLandscape && currentPhase === "translating" && totalSegments > 0 && (
        <View style={styles.translateProgressRow}>
          <Text style={styles.translateProgressText}>
            {translatedCount} / {totalSegments} 자막 번역됨
          </Text>
        </View>
      )}

      {/* ── 언어 선택 모달 ────────────────────────────────────────────────── */}
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
            <Text style={styles.modalTitle}>🎬 영상 장르 선택</Text>
            <Text style={styles.modalSubtitle}>장르를 지정하면 번역 품질이 향상됩니다</Text>
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

  seekSection: {
    backgroundColor: "#111",
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 2,
  },
  timeRow: {
    flexDirection: "row", justifyContent: "space-between",
    marginTop: 2, marginBottom: 4,
  },
  timeText: { color: "#666", fontSize: 11, fontVariant: ["tabular-nums"] },

  statusBar: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#0d1520",
    paddingHorizontal: 12, paddingVertical: 7,
    gap: 8,
    borderTopWidth: 1, borderTopColor: "#1e3a5f",
    minHeight: 38,
  },
  statusBarError: { backgroundColor: "#130a0a", borderTopColor: "#7f1d1d" },

  progressBarWrap: {
    height: 3, backgroundColor: "#1e3a5f",
    borderRadius: 2, overflow: "hidden", width: 56,
  },
  progressBarFill: {
    height: "100%", backgroundColor: "#3b82f6", borderRadius: 2,
  },

  statusText:         { color: "#60a5fa", fontSize: 11, fontWeight: "600", flex: 1 },
  statusTextError:    { color: "#ef4444" },
  statusTextWhisper:  { color: "#f59e0b" },

  retryBtn: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 6, backgroundColor: "#1e3a5f",
  },
  retryBtnText: { color: "#60a5fa", fontSize: 11, fontWeight: "600" },

  translateProgressRow: {
    backgroundColor: "#0d0d0d",
    paddingHorizontal: 14, paddingVertical: 4,
    alignItems: "flex-end",
  },
  translateProgressText: { color: "#374151", fontSize: 10 },

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