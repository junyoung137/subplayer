import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  Alert,
  Animated,
  Easing,
  BackHandler,
} from "react-native";
import { Svg, Circle, Text as SvgText } from 'react-native-svg';
import AsyncStorage from "@react-native-async-storage/async-storage";
import { X, Check } from 'lucide-react-native';
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useWhisperModel } from "../hooks/useWhisperModel";
import { useVideoProcessor } from "../hooks/useVideoProcessor";
import { getCachedSubtitles } from "../services/subtitleCache";
import {
  startBackgroundProcessing,
  stopBackgroundProcessing,
  updateBackgroundProgress,
} from "../services/processingServiceBridge";

type CacheStatus = "checking" | "miss";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getResumeInfo(videoUri: string): Promise<number | null> {
  try {
    const key = `gemma_checkpoint_${videoUri}`;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const cp = JSON.parse(raw) as { completedSegments?: unknown[]; timestamp?: number };
    const age = Date.now() - (cp.timestamp ?? 0);
    if (age >= 24 * 60 * 60 * 1000) return null;
    return Array.isArray(cp.completedSegments) ? cp.completedSegments.length : null;
  } catch {
    return null;
  }
}

// ── SmoothProgressBar ─────────────────────────────────────────────────────────

type SmoothMode = 'heartbeat' | 'tween' | 'stuck' | 'done' | 'error';

interface SmoothProgressBarProps {
  percent: number;
  step:    string;
  isDone:  boolean;
  onSmoothPercent?: (value: number) => void;
}

function SmoothProgressBar({ percent, step, isDone, onSmoothPercent }: SmoothProgressBarProps) {
  const { t } = useTranslation();
  const smoothAnim      = useRef(new Animated.Value(0)).current;
  const smoothRef       = useRef(0);
  const [smoothDisplay, setSmoothDisplay] = useState(0);
  const [isStuck, setIsStuck]             = useState(false);
  const isStuckRef      = useRef(false);
  const animRunningRef  = useRef(false);
  const bridgeActiveRef = useRef(false);
  const heartbeatRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const stuckTimerRef   = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const animRef         = useRef<Animated.CompositeAnimation    | null>(null);
  const stepRef         = useRef(step);
  const prevModeRef     = useRef<SmoothMode>('tween');

  // addListener: single writer of smoothRef.current + onSmoothPercent callback
  useEffect(() => {
    const id = smoothAnim.addListener(({ value }) => { smoothRef.current = value; });
    const listenerId = smoothAnim.addListener(({ value }) => {
      onSmoothPercent?.(Math.round(value));
    });
    return () => {
      smoothAnim.removeListener(id);
      smoothAnim.removeListener(listenerId);
    };
  }, [smoothAnim]);

  // Sync animated value → display text at ~5 fps to avoid 60fps re-renders
  useEffect(() => {
    const syncId = setInterval(() => {
      const v = Math.round(smoothRef.current);
      setSmoothDisplay(prev => prev === v ? prev : v);
    }, 200);
    return () => clearInterval(syncId);
  }, []);

  // Main scheduler
  useEffect(() => {
    stepRef.current = step;

    const setSmooth = (v: number) => {
      smoothAnim.setValue(v);
    };
    const clearHB = () => {
      if (heartbeatRef.current !== null) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    };
    const startHB = (cap: number) => {
      if (heartbeatRef.current !== null) return;
      heartbeatRef.current = setInterval(() => {
        const cur = smoothRef.current;
        if (cur < cap) setSmooth(Math.min(cur + 0.4, cap));
      }, 500);
    };
    const runTween = (target: number, dur: number, onDone?: () => void) => {
      animRef.current?.stop();
      animRef.current = null;
      animRunningRef.current = true;
      const a = Animated.timing(smoothAnim, {
        toValue:         target,
        duration:        dur,
        easing:          Easing.out(Easing.cubic),
        useNativeDriver: false,
      });
      animRef.current = a;
      a.start(({ finished }) => {
        animRunningRef.current = false;
        if (finished) onDone?.();
      });
    };

    const executeMode = (mode: SmoothMode, pct: number, pm: SmoothMode) => {
      if (animRunningRef.current && mode !== 'done' && mode !== 'error') return;

      switch (mode) {
        case 'done': {
          bridgeActiveRef.current = false;
          clearHB();
          animRef.current?.stop(); animRef.current = null;
          animRunningRef.current = false;
          if (stuckTimerRef.current) { clearTimeout(stuckTimerRef.current); stuckTimerRef.current = null; }
          isStuckRef.current = false;
          setIsStuck(false);
          setSmooth(100);
          break;
        }
        case 'error': {
          bridgeActiveRef.current = false;
          clearHB();
          animRef.current?.stop(); animRef.current = null;
          animRunningRef.current = false;
          if (stuckTimerRef.current) { clearTimeout(stuckTimerRef.current); stuckTimerRef.current = null; }
          isStuckRef.current = false;
          setIsStuck(false);
          break;
        }
        case 'heartbeat': {
          animRef.current?.stop(); animRef.current = null;
          animRunningRef.current = false;
          startHB(17);
          break;
        }
        case 'stuck': {
          const cap = pct === 0 ? 17 : Math.min(pct + 20, 95);
          if (heartbeatRef.current === null) startHB(cap);
          break;
        }
        case 'tween': {
          if (bridgeActiveRef.current) return;
          clearHB();
          const comingFromHeartbeat = pm === 'heartbeat' || pm === 'stuck';
          if (smoothRef.current > pct + 20) {
            runTween(pct, 200);
            break;
          }
          const duration = stepRef.current === 'translating' ? 1200 : 800;
          if (comingFromHeartbeat) {
            bridgeActiveRef.current = true;
            runTween(smoothRef.current, 150, () => {
              bridgeActiveRef.current = false;
              runTween(pct, duration);
            });
          } else {
            runTween(pct, duration);
          }
          break;
        }
      }
    };

    const deriveModeFromState = (): SmoothMode => {
      if (isDone || percent >= 100 || step === 'done') return 'done';
      if (step === 'error') return 'error';
      if (isStuckRef.current) return 'stuck';
      if (step === 'translating' && percent === 0) return 'heartbeat';
      return 'tween';
    };

    if (isStuckRef.current && percent > 0) {
      isStuckRef.current = false;
      setIsStuck(false);
    }

    const mode = deriveModeFromState();
    executeMode(mode, percent, prevModeRef.current);
    prevModeRef.current = mode;

    if (step === 'translating' && !isStuckRef.current && mode !== 'done' && mode !== 'error') {
      if (stuckTimerRef.current) { clearTimeout(stuckTimerRef.current); stuckTimerRef.current = null; }
      stuckTimerRef.current = setTimeout(() => {
        stuckTimerRef.current = null;
        isStuckRef.current    = true;
        setIsStuck(true);
        const cap = percent === 0 ? 17 : Math.min(percent + 20, 95);
        if (heartbeatRef.current === null) startHB(cap);
      }, 4000);
    } else if (step !== 'translating') {
      if (stuckTimerRef.current) { clearTimeout(stuckTimerRef.current); stuckTimerRef.current = null; }
    }

    return () => {
      bridgeActiveRef.current = false;
      clearHB();
      animRef.current?.stop(); animRef.current = null;
      animRunningRef.current = false;
      if (stuckTimerRef.current) { clearTimeout(stuckTimerRef.current); stuckTimerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [percent, step, isDone]);

  const isEstimate = (step === 'translating' && percent === 0) || isStuck;
  const pctText    = isDone
    ? "100%"
    : isEstimate
      ? `~${smoothDisplay}%`
      : `${smoothDisplay}%`;
  const statusMsg  = isStuck
    ? t("processing.translationModelReady")
    : step === 'translating' && smoothDisplay < 5
      ? t("processing.translationPreparing")
      : null;

  return (
    <View style={styles.overallWrap}>
      <View style={styles.overallRow}>
        <Text style={styles.overallLabel}>{t("processing.totalProgress")}</Text>
        <Text style={styles.overallPercent}>{pctText}</Text>
      </View>
      <View style={styles.overallTrack}>
        <Animated.View
          style={[
            styles.overallFill,
            {
              width: smoothAnim.interpolate({
                inputRange:  [0, 100],
                outputRange: ["0%", "100%"],
                extrapolate: "clamp",
              }),
            },
            isDone && styles.overallFillDone,
          ]}
        />
      </View>
      {statusMsg !== null && (
        <Text style={smoothBarStyles.statusMsg}>{statusMsg}</Text>
      )}
    </View>
  );
}

const smoothBarStyles = StyleSheet.create({
  statusMsg: { color: "#666", fontSize: 11, marginTop: 2 },
});

// ── CircularProgressRing ──────────────────────────────────────────────────────

interface CircularRingProps {
  percent: number;
  isDone: boolean;
}

function CircularProgressRing({ percent, isDone }: CircularRingProps) {
  const R = 80;
  const circumference = 2 * Math.PI * R;
  const dashOffset = circumference * (1 - percent / 100);
  const strokeColor = isDone ? '#22c55e' : '#3b82f6';

  return (
    <Svg width={220} height={220} viewBox="0 0 200 200">
      <Circle cx={100} cy={100} r={R}
        stroke="#1e1e1e" strokeWidth={12} fill="none" />
      <Circle cx={100} cy={100} r={R}
        stroke={strokeColor} strokeWidth={12} fill="none"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90, 100, 100)" />
      <SvgText x={100} y={116} textAnchor="middle"
        fontSize={42} fontWeight="800" fill="#ffffff">
        {isDone ? '100%' : `${percent}%`}
      </SvgText>
    </Svg>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ProcessingScreen() {
  const { t } = useTranslation();
  const videoUri           = usePlayerStore((s) => s.videoUri);
  const videoName          = usePlayerStore((s) => s.videoName);
  const setSubtitles       = usePlayerStore((s) => s.setSubtitles);
  const appendSubtitles    = usePlayerStore((s) => s.appendSubtitles);
  const setPlaying         = usePlayerStore((s) => s.setPlaying);
  const storeIsProcessing  = usePlayerStore((s) => s.isProcessing);
  const storePercent       = usePlayerStore((s) => s.processingPercent);

  const targetLanguage = useSettingsStore((s) => s.targetLanguage);

  const { loaded: modelLoaded, loading: modelLoading, error: modelError } = useWhisperModel();
  const { progress, process, cancel } = useVideoProcessor();

  const [cacheStatus,   setCacheStatus]   = useState<CacheStatus>("checking");
  const [resumeCount,   setResumeCount]   = useState<number | null>(null);
  const [earlyReady,    setEarlyReady]    = useState(false);

  const hasStartedRef         = useRef(false);
  const serviceStartedRef     = useRef(false);
  const cancelledRef          = useRef(false);
  const earlyPlaybackFiredRef = useRef(false);
  const navigationDoneRef     = useRef(false);
  const earlyReadyFiredRef    = useRef(false);

  // ── Effect 1: cache check + resume detection ──────────────────────────────
  useEffect(() => {
    if (!videoUri) {
      router.back();
      return;
    }

    console.log("[FILE] URI being passed to player:", videoUri);
    console.log("[FILE] URI type:", videoUri.startsWith("file://") ? "file:// ✓" : "content:// ✗");

    (async () => {
      const [cached, resumeN] = await Promise.all([
        getCachedSubtitles(videoUri, targetLanguage),
        getResumeInfo(videoUri),
      ]);

      if (cached) {
        setSubtitles(cached);
        setPlaying(true);
        router.replace("/player");
      } else {
        if (resumeN !== null) setResumeCount(resumeN);
        setCacheStatus("miss");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Effect 2: start pipeline (or reconnect if already running) ────────────
  useEffect(() => {
    if (cacheStatus !== "miss") return;
    if (!videoUri) return;

    if (storeIsProcessing && !hasStartedRef.current) {
      hasStartedRef.current = true;
      return;
    }

    if (modelError) {
      Alert.alert(
        t("processing.modelRequired"),
        t("processing.modelNotLoaded"),
        [
          { text: t("processing.modelManage"), onPress: () => router.replace("/models") },
          { text: t("processing.cancel"),      onPress: () => router.back(), style: "cancel" },
        ]
      );
      return;
    }

    if (modelLoaded && !hasStartedRef.current) {
      hasStartedRef.current = true;
      startBackgroundProcessing();
      serviceStartedRef.current = true;

      const handleEarlyPlayback = (
        initialSubtitles: import('../store/usePlayerStore').SubtitleSegment[]
      ) => {
        if (cancelledRef.current) return;
        if (earlyPlaybackFiredRef.current) return;
        earlyPlaybackFiredRef.current = true;
        navigationDoneRef.current = true;
        setSubtitles(initialSubtitles);
        setPlaying(true);
        // Force ring to 100% so user sees completion before navigation
        monotonicRef.current = 100;
        setRingPercent(100);
        if (!earlyReadyFiredRef.current) {
          earlyReadyFiredRef.current = true;
          setEarlyReady(true);
        }
        // Delay navigation so the 100% ring renders first
        setTimeout(() => {
          if (!cancelledRef.current) router.replace("/player");
        }, 400);
      };

      const handlePartialUpdate = (
        newSubtitles: import('../store/usePlayerStore').SubtitleSegment[]
      ) => {
        if (cancelledRef.current) return;
        if (!earlyPlaybackFiredRef.current) return;
        appendSubtitles(newSubtitles);
      };

      process(videoUri, handleEarlyPlayback, handlePartialUpdate)
        .then(({ success, translationSkipped }) => {
          if (cancelledRef.current) return;
          stopBackgroundProcessing();
          serviceStartedRef.current = false;

          if (navigationDoneRef.current) {
            if (success && !translationSkipped) {
              // Final complete subtitles are set by useVideoProcessor
              // via setSubtitles() after processVideo() resolves.
              // No navigation needed.
            }
            return;
          }

          if (success) {
            setPlaying(true);
            if (translationSkipped) {
              Alert.alert(
                t("processing.noTranslationModel"),
                t("processing.noTranslationModelMsg"),
                [
                  { text: t("processing.modelManage"), onPress: () => router.replace("/models") },
                  { text: t("processing.continueWithOriginal"), onPress: () => router.replace("/player") },
                ]
              );
            } else {
              setTimeout(() => router.replace("/player"), 1000);
            }
          }
        });
    }
  }, [cacheStatus, modelLoaded, modelError, videoUri, storeIsProcessing]);

  // ── Effect 3: mirror progress to foreground service notification ──────────
  useEffect(() => {
    if (!serviceStartedRef.current) return;
    updateBackgroundProgress(progress.percent, progress.message);
  }, [progress.percent, progress.message]);

  // ── Stage derivation ──────────────────────────────────────────────────────
  const displayPercent = progress.percent > 0 ? progress.percent : storePercent;

  const isWaitingForModel = modelLoading || (!modelLoaded && !modelError);
  const isDone  = progress.step === "done";
  const isError = progress.step === "error";

  let effStep = progress.step as string;

  if (progress.percent === 0 && storeIsProcessing && storePercent > 0) {
    if      (storePercent < 5)  effStep = "extracting";
    else if (storePercent < 45) effStep = "transcribing";
    else if (storePercent < 50) effStep = "unloading";
    else                        effStep = "translating";
  }

  // ── Monotonic progress ──────────────────────────────────────────────────────
  // Uses fine-grained progress.current / progress.total per step so each
  // STT chunk and translation batch produces visible ring movement.

  const monotonicRef = useRef(0);
  const ringAnimRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [ringPercent, setRingPercent] = useState(0);

  useEffect(() => {
    // videoProcessor now emits unified timeline percent for all steps.
    // Trust it directly; only apply monotonic guard here.
    let computed: number;

    if (isDone) {
      computed = 100;
    } else if (progress.step === 'error') {
      computed = monotonicRef.current; // freeze on error
    } else if (progress.percent > 0) {
      computed = progress.percent;
    } else {
      computed = monotonicRef.current; // no regression if percent=0
    }

    // Monotonic guard: never go backward
    if (computed > monotonicRef.current) {
      monotonicRef.current = computed;
      setRingPercent(Math.round(computed));
    }

    // Clear any previous ticker
    if (ringAnimRef.current !== null) {
      clearInterval(ringAnimRef.current);
      ringAnimRef.current = null;
    }

    // Only animate during translation phase; other phases update
    // infrequently enough that direct setRingPercent is fine.
    if (progress.step === 'translating' && !isDone) {
      const target = monotonicRef.current;
      ringAnimRef.current = setInterval(() => {
        setRingPercent(prev => {
          if (prev >= target) {
            clearInterval(ringAnimRef.current!);
            ringAnimRef.current = null;
            return prev;
          }
          return Math.min(prev + 1, target);
        });
      }, 120);  // advance 1% every 120ms → smooth over ~0.5s per 4% step
    }

    return () => {
      if (ringAnimRef.current !== null) {
        clearInterval(ringAnimRef.current);
        ringAnimRef.current = null;
      }
    };
  }, [progress.step, progress.percent, isDone]);

  // Reset on new video
  useEffect(() => {
    monotonicRef.current = 0;
    setRingPercent(0);
    if (ringAnimRef.current !== null) {
      clearInterval(ringAnimRef.current);
      ringAnimRef.current = null;
    }
  }, [videoUri]);

  // Force 100 on done
  useEffect(() => {
    if (isDone) {
      monotonicRef.current = 100;
      setRingPercent(100);
    }
  }, [isDone]);

  // ── End monotonic progress ──────────────────────────────────────────────────

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    cancel();
    if (serviceStartedRef.current) {
      stopBackgroundProcessing();
      serviceStartedRef.current = false;
    }
    setTimeout(() => router.back(), 100);
  }, [cancel]);

  // ── Hardware back button: route through handleCancel ──────────────────────
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      handleCancel();
      return true;
    });
    return () => subscription.remove();
  }, [handleCancel]);

  // ── Cache-checking UI ─────────────────────────────────────────────────────
  if (cacheStatus === "checking") {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerContainer}>
          <Text style={styles.appName}>RealtimeSub</Text>
          <Text style={styles.fileName} numberOfLines={2}>{videoName ?? t("processing.video")}</Text>
          <View style={styles.simpleCard}>
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text style={styles.simpleCardText}>{t("processing.loadingCache")}</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main processing UI ────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Text style={styles.appName}>RealtimeSub</Text>
        <Text style={styles.fileName} numberOfLines={2}>{videoName ?? t("processing.video")}</Text>

        {/* Resume banner */}
        {resumeCount !== null && !isDone && !isError && (
          <View style={styles.resumeBanner}>
            <Text style={styles.resumeText}>
              {t("processing.resumeBanner", { count: resumeCount })}
            </Text>
          </View>
        )}

        {/* Waiting for Whisper model */}
        {isWaitingForModel && !isDone && !isError && (
          <View style={styles.waitCard}>
            <ActivityIndicator size="small" color="#3b82f6" />
            <Text style={styles.waitText}>{t("processing.whisperLoading")}</Text>
          </View>
        )}

        {/* Error card */}
        {isError && (
          <View style={styles.errorCard}>
            <X size={32} color="#ef4444" />
            <Text style={styles.errorTitle}>{t("processing.processFailed")}</Text>
            {progress.error ? (
              <Text style={styles.errorDetail}>{progress.error}</Text>
            ) : null}
          </View>
        )}

        {/* Ring area */}
        {!isError && (
          <View style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingBottom: 24,
          }}>
            <CircularProgressRing
              percent={ringPercent}
              isDone={isDone}
            />

            {/* STATUS: before earlyReady */}
            {!earlyReady && !isDone && (
              <View style={ringStyles.statusRow}>
                <ActivityIndicator size="small" color="#3b82f6" />
                <Text style={ringStyles.statusText}>앞부분 자막 준비 중...</Text>
              </View>
            )}

            {/* STATUS: earlyReady but still processing */}
            {earlyReady && !isDone && (
              <View style={{ alignItems: 'center', gap: 8, marginTop: 16 }}>
                <View style={ringStyles.statusRow}>
                  <Check size={16} color="#22c55e" />
                  <Text style={ringStyles.readyText}>지금 재생 가능</Text>
                </View>
                <Text style={ringStyles.hintText}>뒤쪽 자막은 자동 생성 중입니다</Text>
                <Text style={ringStyles.hintSubText}>
                  재생 중 자막이 없는 구간은 잠시 후 자동으로 표시됩니다
                </Text>
              </View>
            )}

            {/* STATUS: done */}
            {isDone && (
              <View style={ringStyles.statusRow}>
                <Check size={16} color="#22c55e" />
                <Text style={ringStyles.doneText}>완료! 재생을 시작합니다...</Text>
              </View>
            )}
          </View>
        )}

        {/* Cancel / back button */}
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
          <Text style={styles.cancelBtnText}>
            {isError ? t("processing.goBack") : t("processing.cancel")}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const ringStyles = StyleSheet.create({
  statusRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  statusText:  { color: '#888', fontSize: 14 },
  readyText:   { color: '#22c55e', fontSize: 16, fontWeight: '700' },
  hintText:    { color: '#4ade80', fontSize: 13, textAlign: 'center' },
  hintSubText: { color: '#555', fontSize: 11, textAlign: 'center', paddingHorizontal: 28 },
  doneText:    { color: '#22c55e', fontSize: 14 },
});

const styles = StyleSheet.create({
  safe:  { flex: 1, backgroundColor: "#0a0a0a" },
  scroll: { flex: 1 },
  scrollContent: {
    padding: 24,
    alignItems: "center",
    gap: 14,
    paddingBottom: 48,
  },

  centerContainer: {
    flex: 1,
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },

  appName:  { color: "#444", fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase" },
  fileName: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
    maxWidth: 320,
  },

  resumeBanner: {
    backgroundColor: "#0f2340",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    width: "100%",
    borderWidth: 1,
    borderColor: "#1d4ed8",
  },
  resumeText: { color: "#93c5fd", fontSize: 13, textAlign: "center" },

  waitCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#0d1520",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    width: "100%",
    borderWidth: 1,
    borderColor: "#1e3a5f",
  },
  waitText: { color: "#60a5fa", fontSize: 13 },

  errorCard: {
    backgroundColor: "#130a0a",
    borderRadius: 14,
    padding: 24,
    width: "100%",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#7f1d1d",
  },
  errorTitle:  { color: "#ef4444", fontSize: 16, fontWeight: "700" },
  errorDetail: { color: "#888", fontSize: 12, textAlign: "center" },

  // Used by SmoothProgressBar (component kept, not mounted in ProcessingScreen)
  overallWrap: { width: "100%", gap: 6 },
  overallRow:  { flexDirection: "row", justifyContent: "space-between" },
  overallLabel:   { color: "#555", fontSize: 12 },
  overallPercent: { color: "#999", fontSize: 12, fontWeight: "600" },
  overallTrack: {
    width: "100%",
    height: 4,
    backgroundColor: "#181818",
    borderRadius: 2,
    overflow: "hidden",
  },
  overallFill:     { height: "100%", backgroundColor: "#3b82f6", borderRadius: 2 },
  overallFillDone: { backgroundColor: "#22c55e" },

  simpleCard: {
    backgroundColor: "#111",
    borderRadius: 16,
    padding: 28,
    width: "100%",
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderColor: "#1e1e1e",
  },
  simpleCardText: { color: "#fff", fontSize: 15, fontWeight: "600" },

  cancelBtn: {
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 36,
    borderRadius: 24,
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#222",
  },
  cancelBtnText: { color: "#777", fontSize: 14 },
});
