import React, { useEffect, useRef, useState } from "react";
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
} from "react-native";
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
type StageStatus = "done" | "active" | "waiting";

interface StageInfo {
  id: number;
  label: string;
  status: StageStatus;
}

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

// ── Stage row ─────────────────────────────────────────────────────────────────

interface StageRowProps {
  stage: StageInfo;
  isLast: boolean;
  /** Only provided when this stage is active */
  animatedWidth?: Animated.Value;
  subLabel?: string;
  timeText?: string;
}

function StageRow({ stage, isLast, animatedWidth, subLabel, timeText }: StageRowProps) {
  const isActive  = stage.status === "active";
  const isDone    = stage.status === "done";

  return (
    <View style={[rowStyles.row, isActive && rowStyles.rowActive, !isLast && rowStyles.rowBorder]}>
      {/* Status icon */}
      <View style={rowStyles.iconWrap}>
        {isDone ? (
          <Check size={14} color="#22c55e" />
        ) : isActive ? (
          <ActivityIndicator size="small" color="#3b82f6" />
        ) : (
          <View style={rowStyles.iconCircle} />
        )}
      </View>

      {/* Label + expanded content */}
      <View style={rowStyles.content}>
        <Text
          style={[
            rowStyles.label,
            isActive  && rowStyles.labelActive,
            isDone    && rowStyles.labelDone,
          ]}
        >
          {stage.label}
        </Text>

        {isActive && animatedWidth && (
          <>
            {/* Sub-progress bar */}
            <View style={rowStyles.barTrack}>
              <Animated.View
                style={[
                  rowStyles.barFill,
                  {
                    width: animatedWidth.interpolate({
                      inputRange:  [0, 100],
                      outputRange: ["0%", "100%"],
                      extrapolate: "clamp",
                    }),
                  },
                ]}
              />
            </View>

            {/* Sub-label (left) + time remaining (right) */}
            <View style={rowStyles.barFooter}>
              <Text style={rowStyles.subLabel} numberOfLines={1}>
                {subLabel}
              </Text>
              {timeText ? (
                <Text style={rowStyles.timeText}>{timeText}</Text>
              ) : null}
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 14,
    paddingHorizontal: 4,
    gap: 12,
  },
  rowActive: {
    backgroundColor: "#161616",
    borderRadius: 10,
    paddingHorizontal: 10,
    marginHorizontal: -10,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: "#1c1c1c" },

  iconWrap: { width: 22, height: 22, alignItems: "center", justifyContent: "center", marginTop: 1 },
  iconCircle: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#3a3a3a",
  },

  content: { flex: 1, gap: 6 },
  label:        { fontSize: 14, color: "#444", fontWeight: "500" },
  labelActive:  { color: "#fff", fontWeight: "700", fontSize: 15 },
  labelDone:    { color: "#22c55e" },

  barTrack: {
    height: 4,
    backgroundColor: "#202020",
    borderRadius: 2,
    overflow: "hidden",
  },
  barFill: { height: "100%", backgroundColor: "#3b82f6", borderRadius: 2 },

  barFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  subLabel: { color: "#666", fontSize: 11, flex: 1 },
  timeText:  { color: "#444", fontSize: 11, textAlign: "right" },
});

// ── SmoothProgressBar ─────────────────────────────────────────────────────────

type SmoothMode = 'heartbeat' | 'tween' | 'stuck' | 'done' | 'error';

interface SmoothProgressBarProps {
  percent: number;
  step:    string;
  isDone:  boolean;
}

function SmoothProgressBar({ percent, step, isDone }: SmoothProgressBarProps) {
  const { t } = useTranslation();
  const smoothAnim      = useRef(new Animated.Value(0)).current;
  const smoothRef       = useRef(0);
  const [smoothDisplay, setSmoothDisplay] = useState(0);
  const [isStuck, setIsStuck]             = useState(false);
  const isStuckRef      = useRef(false);
  const animRunningRef  = useRef(false);
  const bridgeActiveRef = useRef(false); // true during 150ms heartbeat→tween bridge
  const heartbeatRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const stuckTimerRef   = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const animRef         = useRef<Animated.CompositeAnimation    | null>(null);
  const stepRef         = useRef(step);
  const prevModeRef     = useRef<SmoothMode>('tween');

  // addListener: single writer of smoothRef.current
  useEffect(() => {
    const id = smoothAnim.addListener(({ value }) => { smoothRef.current = value; });
    return () => smoothAnim.removeListener(id);
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
      // smoothRef.current is updated by the addListener callback — do NOT write here
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
      animRunningRef.current = true; // LOCK
      const a = Animated.timing(smoothAnim, {
        toValue:         target,
        duration:        dur,
        easing:          Easing.out(Easing.cubic),
        useNativeDriver: false,
      });
      animRef.current = a;
      a.start(({ finished }) => {
        animRunningRef.current = false; // UNLOCK
        // smoothRef.current is already synced by listener — no manual write needed
        if (finished) onDone?.();
      });
    };

    const executeMode = (mode: SmoothMode, pct: number, pm: SmoothMode) => {
      // Fix 1: gate ALL modes except done/error when animation is running
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
          if (bridgeActiveRef.current) return; // Fix 3: bridge lock — yield entirely if bridge in progress
          clearHB();
          const comingFromHeartbeat = pm === 'heartbeat' || pm === 'stuck';
          if (smoothRef.current > pct + 20) {
            // Overshoot guard: snap to within 20 pp then tween
            runTween(pct, 200);
            break;
          }
          const duration = stepRef.current === 'translating' ? 1200 : 800;
          if (comingFromHeartbeat) {
            bridgeActiveRef.current = true; // LOCK bridge
            runTween(smoothRef.current, 150, () => {
              bridgeActiveRef.current = false; // UNLOCK bridge
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

    // Stuck recovery: real percent advanced while stuck
    if (isStuckRef.current && percent > 0) {
      isStuckRef.current = false;
      setIsStuck(false);
    }

    // Execute current mode
    const mode = deriveModeFromState();
    executeMode(mode, percent, prevModeRef.current);
    prevModeRef.current = mode;

    // Stuck detection: reset timer on every update — fires only if nothing changes for 4000 ms
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

  // ── Derived display values ───────────────────────────────────────────────────
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

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ProcessingScreen() {
  const { t } = useTranslation();
  const videoUri           = usePlayerStore((s) => s.videoUri);
  const videoName          = usePlayerStore((s) => s.videoName);
  const setSubtitles       = usePlayerStore((s) => s.setSubtitles);
  const setPlaying         = usePlayerStore((s) => s.setPlaying);
  const storeIsProcessing  = usePlayerStore((s) => s.isProcessing);
  const storePercent       = usePlayerStore((s) => s.processingPercent);
  const storeMessage       = usePlayerStore((s) => s.processingMessage);

  const targetLanguage = useSettingsStore((s) => s.targetLanguage);

  const { loaded: modelLoaded, loading: modelLoading, error: modelError } = useWhisperModel();
  const { progress, process, cancel } = useVideoProcessor();

  const [cacheStatus,    setCacheStatus]  = useState<CacheStatus>("checking");
  const [resumeCount,    setResumeCount]  = useState<number | null>(null);
  const hasStartedRef     = useRef(false);
  const serviceStartedRef = useRef(false);
  const cancelledRef      = useRef(false);

  /** Peak values for completion detail text */
  const peakRef = useRef({ transcribeTotal: 0, sentenceTotal: 0 });

  // ── Animation + timing state ──────────────────────────────────────────────
  const animatedProgress    = useRef(new Animated.Value(0)).current;
  const indeterminateAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const stageStartTimeRef   = useRef<Partial<Record<number, number>>>({});
  const [timeText, setTimeText] = useState<string>("");

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
      process(videoUri).then(({ success, translationSkipped }) => {
        if (cancelledRef.current) return;
        stopBackgroundProcessing();
        serviceStartedRef.current = false;
        if (success) {
          setPlaying(true);
          if (translationSkipped) {
            Alert.alert(
              t("processing.noTranslationModel"),
              t("processing.noTranslationModelMsg"),
              [
                { text: t("processing.modelManage"),        onPress: () => router.replace("/models") },
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

  // ── Effect 4: track peak values for completion text ───────────────────────
  useEffect(() => {
    if (progress.step === "transcribing" && progress.total > 0) {
      peakRef.current.transcribeTotal = progress.total;
    }
    if (progress.step === "translating" && progress.total > 0) {
      peakRef.current.sentenceTotal = progress.total;
    }
  }, [progress]);

  // ── Stage derivation ──────────────────────────────────────────────────────
  const displayPercent = progress.percent > 0 ? progress.percent : storePercent;
  const displayMessage = progress.message || storeMessage;

  const isWaitingForModel = modelLoading || (!modelLoaded && !modelError);
  const isDone  = progress.step === "done";
  const isError = progress.step === "error";

  // When reconnecting, derive stage from store percent
  let effStep    = progress.step as string;
  let effCurrent = progress.current;
  let effTotal   = progress.total;

  if (progress.percent === 0 && storeIsProcessing && storePercent > 0) {
    if      (storePercent < 10) effStep = "extracting";
    else if (storePercent < 90) effStep = "transcribing";
    else if (storePercent < 94) effStep = "unloading";
    else                        effStep = "translating";
    effCurrent = 0;
    effTotal   = 0;
  }

  let currentStageIdx = 0;
  if      (effStep === "extracting" && displayPercent > 0)            currentStageIdx = 1;
  else if (effStep === "transcribing")                                 currentStageIdx = 2;
  else if (effStep === "unloading" || (effStep === "translating" && effCurrent === 0)) currentStageIdx = 3;
  else if (effStep === "translating" && effCurrent > 0)               currentStageIdx = 4;
  else if (effStep === "done")                                         currentStageIdx = 5;

  const translationWasSkipped = isDone && peakRef.current.sentenceTotal === 0;

  const getStatus = (id: number): StageStatus => {
    if (currentStageIdx === 0) return "waiting";
    if (isDone) {
      if (translationWasSkipped && id >= 3) return "waiting";
      return "done";
    }
    if (id < currentStageIdx) return "done";
    if (id === currentStageIdx) return "active";
    return "waiting";
  };

  const stages: StageInfo[] = [
    { id: 1, label: t("processing.extractAudio"),       status: getStatus(1) },
    { id: 2, label: t("processing.transcribe"),         status: getStatus(2) },
    { id: 3, label: t("processing.loadTranslationModel"), status: getStatus(3) },
    { id: 4, label: t("processing.translating"),        status: getStatus(4) },
  ];

  const activeStageId = stages.find((s) => s.status === "active")?.id ?? null;

  // ── Effect 5: animate bar + record start time when stage changes ──────────
  useEffect(() => {
    if (currentStageIdx >= 1 && currentStageIdx <= 4) {
      if (!stageStartTimeRef.current[currentStageIdx]) {
        stageStartTimeRef.current[currentStageIdx] = Date.now();
      }
    }

    // Reset bar and stop any running indeterminate animation
    animatedProgress.setValue(0);
    indeterminateAnimRef.current?.stop();
    indeterminateAnimRef.current = null;
    setTimeText(t("processing.calculating"));

    // Indeterminate animation for stages 1 (fast) and 3 (slow)
    if (currentStageIdx === 1) {
      const anim = Animated.timing(animatedProgress, {
        toValue: 85,
        duration: 10_000,
        useNativeDriver: false,
      });
      indeterminateAnimRef.current = anim;
      anim.start();
    } else if (currentStageIdx === 3) {
      const anim = Animated.timing(animatedProgress, {
        toValue: 70,
        duration: 14_000,
        useNativeDriver: false,
      });
      indeterminateAnimRef.current = anim;
      anim.start();
    }

    return () => {
      indeterminateAnimRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStageIdx]);

  // ── Effect 6: animate bar for determinate stages (2 and 4) ───────────────
  useEffect(() => {
    if (currentStageIdx !== 2 && currentStageIdx !== 4) return;
    if (effTotal <= 0) return;
    const sp = Math.round((effCurrent / effTotal) * 100);
    Animated.timing(animatedProgress, {
      toValue: sp,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [effCurrent, effTotal, currentStageIdx]);

  // ── Effect 7: compute estimated time remaining every second ───────────────
  useEffect(() => {
    // Only compute for stages with real sub-progress
    if (currentStageIdx !== 2 && currentStageIdx !== 4) {
      // Indeterminate stages — keep calculating text
      setTimeText(t("processing.calculating"));
      return;
    }
    if (effTotal <= 0) return;

    const realSp = Math.round((effCurrent / effTotal) * 100);

    if (realSp < 5) {
      setTimeText(t("processing.calculating"));
      return;
    }
    if (realSp >= 98) {
      setTimeText(t("processing.completing"));
      return;
    }

    const startTime = stageStartTimeRef.current[currentStageIdx] ?? Date.now();

    const compute = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed < 3) {
        setTimeText(t("processing.calculating"));
        return;
      }
      const rate = realSp / elapsed; // % per second
      if (rate <= 0) return;
      const remaining = Math.max(0, (100 - realSp) / rate);
      if (remaining > 60) {
        const m = Math.floor(remaining / 60);
        const s = Math.round(remaining % 60);
        setTimeText(t("processing.timeMinSec", { m, s }));
      } else {
        setTimeText(t("processing.timeSec", { s: Math.round(remaining) }));
      }
    };

    compute();
    const interval = setInterval(compute, 1000);
    return () => clearInterval(interval);
  }, [currentStageIdx, effCurrent, effTotal]);

  // ── Sub-label for the active stage ────────────────────────────────────────
  const activeSubLabel: string = (() => {
    switch (activeStageId) {
      case 1: return t("processing.convertingAudio");
      case 2: return effTotal > 0 ? t("processing.chunk", { current: effCurrent, total: effTotal }) : t("processing.analyzing");
      case 3:
        if (displayMessage.includes("언로드"))  return t("processing.whisperUnloading");
        if (displayMessage.includes("안정화"))  return t("processing.memoryStabilizing");
        return t("processing.modelInitializing");
      case 4: return effTotal > 0 ? t("processing.sentencesTranslated", { current: effCurrent, total: effTotal }) : t("processing.preparing");
      default: return "";
    }
  })();

  const handleCancel = () => {
    cancelledRef.current = true;
    cancel();
    if (serviceStartedRef.current) {
      stopBackgroundProcessing();
      serviceStartedRef.current = false;
    }
    router.back();
  };

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

        {!isError && (
          <>
            {/* ── Overall progress bar ───────────────────────────────────── */}
            <SmoothProgressBar percent={displayPercent} step={effStep} isDone={isDone} />

            {/* ── Stage list ─────────────────────────────────────────────── */}
            <View style={styles.stageCard}>
              {stages.map((stage, idx) => (
                <StageRow
                  key={stage.id}
                  stage={stage}
                  isLast={idx === stages.length - 1}
                  animatedWidth={stage.status === "active" ? animatedProgress : undefined}
                  subLabel={stage.status === "active" ? activeSubLabel : undefined}
                  timeText={stage.status === "active" ? timeText : undefined}
                />
              ))}
            </View>
          </>
        )}

        {/* Done card */}
        {isDone && (
          <View style={styles.doneCard}>
            <Check size={32} color="#22c55e" />
            <Text style={styles.doneTitle}>{t("processing.done")}</Text>
            <Text style={styles.doneSubtitle}>{t("processing.doneSubtitle")}</Text>
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

const styles = StyleSheet.create({
  safe:  { flex: 1, backgroundColor: "#0a0a0a" },
  scroll: { flex: 1 },
  scrollContent: {
    padding: 24,
    alignItems: "center",
    gap: 14,
    paddingBottom: 48,
  },

  // Center layout for cache-checking screen
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

  // Overall progress
  overallWrap: { width: "100%" , gap: 6 },
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

  // Stage list card
  stageCard: {
    backgroundColor: "#0e0e0e",
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 16,
    width: "100%",
    borderWidth: 1,
    borderColor: "#1a1a1a",
  },

  // Simple card (cache-checking)
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

  // Done card
  doneCard: {
    backgroundColor: "#071510",
    borderRadius: 14,
    padding: 24,
    width: "100%",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#14532d",
  },
  doneTitle:    { color: "#22c55e", fontSize: 17, fontWeight: "700" },
  doneSubtitle: { color: "#4ade80", fontSize: 13 },

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
