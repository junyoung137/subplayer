import React, { useRef, useCallback, useEffect, useState } from "react";
import {
  View,
  StyleSheet,
  TouchableWithoutFeedback,
  Animated,
  Text,
  PanResponder,
  useWindowDimensions,
} from "react-native";
import Video, { ViewType } from "react-native-video";
import { usePlayerStore } from "../store/usePlayerStore";

const HIDE_DELAY_MS    = 3000;
const DOUBLE_TAP_MS    = 300;
const LONG_PRESS_MS    = 400;
const SEEK_SKIP_SEC    = 10;
const FAST_RATE        = 2.0;
const FEEDBACK_FADE_MS = 800;
const BOTTOM_ZONE_H    = 80;
const SCRUB_PX_PER_SEC = 5;    // horizontal pixels per second of scrub
const SCRUB_THRESHOLD  = 10;   // px of dx needed to switch long-press → scrub

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface VideoPlayerProps {
  rate?: number;
  overlayHeader?: React.ReactNode;
  overlayControls?: React.ReactNode;
}

// ── Custom seek bar ───────────────────────────────────────────────────────────
interface SeekBarProps {
  currentTime: number;
  duration: number;
  onSeekStart: () => void;
  onSeekChange: (time: number) => void;
  onSeekEnd: (time: number) => void;
}

function SeekBar({ currentTime, duration, onSeekStart, onSeekChange, onSeekEnd }: SeekBarProps) {
  const barWidth = useRef(0);

  const getTime = (x: number) => {
    const bw = barWidth.current;
    console.log('BAR_WIDTH_AT_SEEK', bw, 'X', x);
    if (bw <= 0 || duration <= 0) return 0;
    return Math.min(Math.max((x / bw) * duration, 0), duration);
  };

  const getTimeRef = useRef(getTime);
  getTimeRef.current = getTime;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderGrant: (evt) => {
        onSeekStart();
        const t = getTimeRef.current(evt.nativeEvent.locationX);
        onSeekChange(t);
      },
      onPanResponderMove: (evt) => {
        const t = getTimeRef.current(evt.nativeEvent.locationX);
        onSeekChange(t);
      },
      onPanResponderRelease: (evt) => {
        const t = getTimeRef.current(evt.nativeEvent.locationX);
        console.log('SEEK_TO', t);
        onSeekEnd(t);
      },
      onPanResponderTerminate: (evt) => {
        const t = getTimeRef.current(evt.nativeEvent.locationX);
        onSeekEnd(t);
      },
    })
  ).current;

  const pct = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

  return (
    <View
      style={styles.seekBarHitArea}
      onLayout={(e) => {
        barWidth.current = e.nativeEvent.layout.width;
        console.log('BAR_WIDTH', barWidth.current);
      }}
      {...panResponder.panHandlers}
    >
      <View style={styles.seekTrack}>
        <View style={[styles.seekFill, { width: `${(pct * 100).toFixed(2)}%` as any}]} />
      </View>
      <View style={[styles.seekThumb, { left: `${(pct * 100).toFixed(2)}%` as any}]} />
    </View>
  );
}

// ── GestureBadge ──────────────────────────────────────────────────────────────
interface GestureBadgeProps {
  anim: Animated.Value;
  label: string;
  side: "left" | "right" | "center";
}

function GestureBadge({ anim, label, side }: GestureBadgeProps) {
  const alignStyle =
    side === "left"  ? { left: 24 }              :
    side === "right" ? { right: 24 }             :
                       { alignSelf: "center" as const };
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.gestureBadge, alignStyle, { opacity: anim }]}
    >
      <Text style={styles.gestureBadgeText}>{label}</Text>
    </Animated.View>
  );
}

// ── ScrubOverlay ──────────────────────────────────────────────────────────────
// Shown while the user drags left/right during a long press.
interface ScrubOverlayProps {
  scrubTime: number;
  scrubDelta: number;
  duration: number;
}

function ScrubOverlay({ scrubTime, scrubDelta, duration }: ScrubOverlayProps) {
  const direction   = scrubDelta >= 0 ? "▶▶" : "◀◀";
  const absDeltaSec = Math.abs(Math.round(scrubDelta));
  const sign        = scrubDelta >= 0 ? "+" : "-";
  const pct         = duration > 0 ? Math.min(scrubTime / duration, 1) : 0;

  return (
    <View style={styles.scrubOverlay} pointerEvents="none">
      {/* 30% black dim over the video */}
      <View style={styles.scrubDim} />

      {/* Centre info card */}
      <View style={styles.scrubCard}>
        <Text style={styles.scrubTimeText}>{formatTime(scrubTime)}</Text>
        <Text style={styles.scrubDeltaText}>
          {direction} {sign}{absDeltaSec}초
        </Text>

        {/* Scrub progress bar */}
        <View style={styles.scrubTrack}>
          <View style={[styles.scrubFill, { width: `${(pct * 100).toFixed(1)}%` as any }]} />
          <View style={[styles.scrubThumb, { left: `${(pct * 100).toFixed(1)}%` as any }]} />
        </View>
      </View>
    </View>
  );
}

// ── VideoPlayer ───────────────────────────────────────────────────────────────

export function VideoPlayer({ rate = 1.0, overlayHeader, overlayControls }: VideoPlayerProps) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  const videoRef = useRef<any>(null);

  const videoUri            = usePlayerStore((s) => s.videoUri);
  const isPlaying           = usePlayerStore((s) => s.isPlaying);
  const setPlaying          = usePlayerStore((s) => s.setPlaying);
  const setCurrentTimeStore = usePlayerStore((s) => s.setCurrentTime);
  const setDurationStore    = usePlayerStore((s) => s.setDuration);
  const bumpSeek            = usePlayerStore((s) => s.bumpSeek);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [isSeeking,   setIsSeeking]   = useState(false);
  const [seekValue,   setSeekValue]   = useState(0);

  const [boostActive, setBoostActive] = useState(false);
  const effectiveRate = boostActive ? FAST_RATE : rate;

  // ── Scrub state ─────────────────────────────────────────────────────────────
  const [scrubTime,  setScrubTime]  = useState<number | null>(null);
  const [scrubDelta, setScrubDelta] = useState(0);

  // Live refs for gesture closures
  const currentTimeRef   = useRef(0);
  const durationRef      = useRef(0);
  const isPlayingRef     = useRef(isPlaying);
  const screenWidthRef   = useRef(width);
  currentTimeRef.current   = currentTime;
  durationRef.current      = duration;
  isPlayingRef.current     = isPlaying;
  screenWidthRef.current   = width;

  // ── Top controls ─────────────────────────────────────────────────────────────
  const topControlsAnim    = useRef(new Animated.Value(1)).current;
  const topControlsVisible = useRef(true);
  const topHideTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTopHideTimer = useCallback(() => {
    if (topHideTimer.current) { clearTimeout(topHideTimer.current); topHideTimer.current = null; }
  }, []);

  const scheduleTopHide = useCallback(() => {
    if (!isPlayingRef.current) return;
    clearTopHideTimer();
    topHideTimer.current = setTimeout(() => {
      Animated.timing(topControlsAnim, {
        toValue: 0, duration: 300, useNativeDriver: true,
      }).start(() => { topControlsVisible.current = false; });
    }, HIDE_DELAY_MS);
  }, [clearTopHideTimer, topControlsAnim]);

  const showTopControls = useCallback((autoHide: boolean = true) => {
    topControlsVisible.current = true;
    Animated.timing(topControlsAnim, {
      toValue: 1, duration: 200, useNativeDriver: true,
    }).start();
    if (autoHide) scheduleTopHide();
    else clearTopHideTimer();
  }, [topControlsAnim, scheduleTopHide, clearTopHideTimer]);

  // ── Seek bar ─────────────────────────────────────────────────────────────────
  const seekBarAnim             = useRef(new Animated.Value(0)).current;
  const seekBarVisible          = useRef(false);
  const [seekBarInteractive, setSeekBarInteractive] = useState(false);
  const seekHideTimer           = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSeekHideTimer = useCallback(() => {
    if (seekHideTimer.current) { clearTimeout(seekHideTimer.current); seekHideTimer.current = null; }
  }, []);

  const scheduleSeekHide = useCallback(() => {
    if (!isPlayingRef.current) return;
    clearSeekHideTimer();
    seekHideTimer.current = setTimeout(() => {
      Animated.timing(seekBarAnim, {
        toValue: 0, duration: 300, useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          seekBarVisible.current = false;
          setSeekBarInteractive(false);
        }
      });
    }, HIDE_DELAY_MS);
  }, [clearSeekHideTimer, seekBarAnim]);

  const showSeekBar = useCallback((autoHide: boolean = true) => {
    seekBarVisible.current = true;
    setSeekBarInteractive(true);
    seekBarAnim.stopAnimation();
    Animated.timing(seekBarAnim, {
      toValue: 1, duration: 200, useNativeDriver: true,
    }).start();
    if (autoHide) scheduleSeekHide();
    else clearSeekHideTimer();
  }, [seekBarAnim, scheduleSeekHide, clearSeekHideTimer]);

  // ── isPlaying effect ─────────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isPlaying) {
      showTopControls(true);
      scheduleSeekHide();
    } else {
      showTopControls(false);
      showSeekBar(false);
    }
    return () => {
      clearTopHideTimer();
      clearSeekHideTimer();
    };
  }, [isPlaying]);

  // ── Gesture badge animations ─────────────────────────────────────────────────
  const leftAnim  = useRef(new Animated.Value(0)).current;
  const rightAnim = useRef(new Animated.Value(0)).current;
  const speedAnim = useRef(new Animated.Value(0)).current;

  const flashBadge = useCallback((anim: Animated.Value) => {
    anim.stopAnimation();
    anim.setValue(1);
    Animated.timing(anim, {
      toValue: 0, duration: FEEDBACK_FADE_MS, useNativeDriver: true,
    }).start();
  }, []);

  // ── Double-tap / single-tap ──────────────────────────────────────────────────
  const lastTapLeft    = useRef(0);
  const lastTapRight   = useRef(0);
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSidePress = useCallback((side: "left" | "right") => {
    const now      = Date.now();
    const lastTap  = side === "left" ? lastTapLeft : lastTapRight;
    const isDouble = now - lastTap.current < DOUBLE_TAP_MS;
    lastTap.current = now;

    if (isDouble) {
      if (singleTapTimer.current) { clearTimeout(singleTapTimer.current); singleTapTimer.current = null; }
      const skip = side === "left" ? -SEEK_SKIP_SEC : SEEK_SKIP_SEC;
      const next = Math.min(Math.max(currentTimeRef.current + skip, 0), durationRef.current);
      videoRef.current?.seek(next);
      setCurrentTime(next);
      setCurrentTimeStore(next);
      bumpSeek();
      flashBadge(side === "left" ? leftAnim : rightAnim);
    } else {
      singleTapTimer.current = setTimeout(() => {
        singleTapTimer.current = null;
        if (!topControlsVisible.current) {
          showTopControls(true);
        } else {
          setPlaying(!isPlayingRef.current);
        }
      }, DOUBLE_TAP_MS);
    }
  }, [bumpSeek, flashBadge, leftAnim, rightAnim, setCurrentTimeStore, setPlaying, showTopControls]);

  // ── Bottom zone tap ──────────────────────────────────────────────────────────
  const handleBottomZonePress = useCallback(() => {
    if (!seekBarVisible.current) {
      showSeekBar(true);
    } else {
      scheduleSeekHide();
    }
  }, [showSeekBar, scheduleSeekHide]);

  // ── Main gesture PanResponder ─────────────────────────────────────────────────
  // Replaces left + right TouchableWithoutFeedback.
  // Three gestures detected from the same touch area:
  //   1. Tap (< LONG_PRESS_MS, no drag)  → double-tap skip / single-tap toggle
  //   2. Long press + |dx| < SCRUB_THRESHOLD → 2× speed while held
  //   3. Long press + |dx| >= SCRUB_THRESHOLD → timeline scrub
  //
  // Refs updated every render so PanResponder (created once) reads fresh values.
  const handleSidePressRef  = useRef(handleSidePress);
  handleSidePressRef.current  = handleSidePress;
  const flashBadgeRef       = useRef(flashBadge);
  flashBadgeRef.current       = flashBadge;
  const clearTopHideTimerRef = useRef(clearTopHideTimer);
  clearTopHideTimerRef.current = clearTopHideTimer;
  const scheduleTopHideRef  = useRef(scheduleTopHide);
  scheduleTopHideRef.current  = scheduleTopHide;

  // PanResponder-internal state (refs, not state, to avoid re-renders mid-gesture)
  const longPressTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressActiveRef  = useRef(false);
  const speedModeRef        = useRef(false);
  const scrubModeRef        = useRef(false);
  const scrubStartTimeRef   = useRef(0);
  const gestureStartSideRef = useRef<"left" | "right">("left");

  const mainPanResponder = useRef(PanResponder.create({
    // Claim every touch that starts in the main gesture zone
    onStartShouldSetPanResponder: () => true,

    onPanResponderGrant: (evt) => {
      // Which side did the finger land on?
      gestureStartSideRef.current =
        evt.nativeEvent.pageX < screenWidthRef.current / 2 ? "left" : "right";

      longPressActiveRef.current = false;
      speedModeRef.current       = false;
      scrubModeRef.current       = false;

      // Arm the long-press countdown
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        longPressActiveRef.current = true;
        speedModeRef.current       = true;
        // Enter 2× speed (will switch to scrub if user drags).
        // Hold badge at full opacity while finger is down; fade on release.
        setBoostActive(true);
        speedAnim.stopAnimation();
        speedAnim.setValue(1);
        clearTopHideTimerRef.current();
      }, LONG_PRESS_MS);
    },

    onPanResponderMove: (_, gs) => {
      const absDx = Math.abs(gs.dx);
      const absDy = Math.abs(gs.dy);

      if (!longPressActiveRef.current) {
        // Cancel long press if the finger strays before the timer fires
        if (absDx > 8 || absDy > 8) {
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
        }
        return;
      }

      // ── Long press is active ──
      if (speedModeRef.current && absDx >= SCRUB_THRESHOLD) {
        // Transition: 2× speed → scrub
        speedModeRef.current = false;
        scrubModeRef.current = true;
        setBoostActive(false);
        speedAnim.stopAnimation();
        speedAnim.setValue(0);
        scrubStartTimeRef.current = currentTimeRef.current;
        setScrubDelta(0);
      }

      if (scrubModeRef.current) {
        const delta   = gs.dx / SCRUB_PX_PER_SEC;
        const newTime = Math.min(Math.max(scrubStartTimeRef.current + delta, 0), durationRef.current);
        setScrubDelta(delta);
        setScrubTime(newTime);
      }
    },

    onPanResponderRelease: (_, gs) => {
      // Cancel any pending long-press timer
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      if (scrubModeRef.current) {
        // Commit the scrub seek
        const finalTime = Math.min(
          Math.max(scrubStartTimeRef.current + gs.dx / SCRUB_PX_PER_SEC, 0),
          durationRef.current
        );
        console.log('SCRUB_SEEK_TO', finalTime);
        videoRef.current?.seek(finalTime);
        setCurrentTime(finalTime);
        setCurrentTimeStore(finalTime);
        bumpSeek();
        scrubModeRef.current = false;
        setScrubTime(null);
        setScrubDelta(0);
        scheduleTopHideRef.current();
      } else if (speedModeRef.current || longPressActiveRef.current) {
        // End 2× speed (released without scrubbing) — fade badge out
        setBoostActive(false);
        speedModeRef.current = false;
        Animated.timing(speedAnim, {
          toValue: 0, duration: 500, useNativeDriver: true,
        }).start();
        scheduleTopHideRef.current();
      } else {
        // Normal tap — delegate to double-tap / single-tap handler
        handleSidePressRef.current(gestureStartSideRef.current);
      }

      longPressActiveRef.current = false;
    },

    onPanResponderTerminate: () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      if (scrubModeRef.current) {
        scrubModeRef.current = false;
        setScrubTime(null);
        setScrubDelta(0);
      }
      if (speedModeRef.current || longPressActiveRef.current) {
        setBoostActive(false);
        speedModeRef.current = false;
        Animated.timing(speedAnim, {
          toValue: 0, duration: 500, useNativeDriver: true,
        }).start();
      }
      longPressActiveRef.current = false;
    },
  })).current;

  if (!videoUri) return null;

  return (
    <View style={styles.container}>

      {/* Layer 1: Video */}
      <Video
        ref={(ref) => { videoRef.current = ref; }}
        source={{ uri: videoUri }}
        style={styles.video}
        paused={!isPlaying}
        pointerEvents="none"
        onProgress={(data) => {
          if (!isSeeking) {
            setCurrentTime(data.currentTime);
            setCurrentTimeStore(data.currentTime);
          }
          setDuration(data.seekableDuration);
          setDurationStore(data.seekableDuration);
        }}
        onSeek={() => setIsSeeking(false)}
        progressUpdateInterval={250}
        rate={effectiveRate}
        resizeMode="contain"
        viewType={ViewType.TEXTURE}
        onError={(e) => console.error("[VideoPlayer] error:", e)}
      />

      {/*
       * Layer 2: Main gesture zone — single PanResponder for the full upper area.
       * Handles single-tap, double-tap skip (left/right side), long-press 2× speed,
       * and long-press + horizontal drag → timeline scrub.
       * Does NOT cover the bottom BOTTOM_ZONE_H px (that's the seek bar trigger).
       */}
      <View style={styles.mainGestureZone} {...mainPanResponder.panHandlers} />

      {/* Layer 3: Bottom trigger zone — shows seek bar on tap */}
      <TouchableWithoutFeedback onPress={handleBottomZonePress}>
        <View style={styles.bottomTriggerZone} />
      </TouchableWithoutFeedback>

      {/* Hint line: 2px strip at very bottom, naturally hidden when seek bar appears */}
      <View style={styles.seekHintLine} pointerEvents="none" />

      {/* Layer 4: Top controls — fades independently */}
      <Animated.View
        style={[styles.topControlsOverlay, { opacity: topControlsAnim }]}
        pointerEvents="box-none"
      >
        {overlayHeader}
      </Animated.View>

      {/* Layer 5: Seek bar + overlayControls — fades independently */}
      <Animated.View
        style={[styles.bottomBar, { opacity: seekBarAnim }]}
        pointerEvents={seekBarInteractive ? "box-none" : "none"}
      >
        {overlayControls}

        <Text style={styles.timeText}>
          {formatTime(isSeeking ? seekValue : currentTime)} / {formatTime(duration)}
        </Text>

        <SeekBar
          currentTime={currentTime}
          duration={duration}
          onSeekStart={() => {
            seekBarAnim.stopAnimation();
            seekBarAnim.setValue(1);
            seekBarVisible.current = true;
            clearSeekHideTimer();
            setIsSeeking(true);
          }}
          onSeekChange={(t) => setSeekValue(t)}
          onSeekEnd={(t) => {
            console.log('SEEK_TO', t);
            videoRef.current?.seek(t);
            setCurrentTime(t);
            setCurrentTimeStore(t);
            bumpSeek();
            setIsSeeking(false);
            scheduleSeekHide();
          }}
        />
      </Animated.View>

      {/* Scrub overlay — shown only while long-press-drag is active */}
      {scrubTime !== null && (
        <ScrubOverlay scrubTime={scrubTime} scrubDelta={scrubDelta} duration={duration} />
      )}

      {/* Gesture feedback badges */}
      <GestureBadge anim={leftAnim}  label={`◀◀ ${SEEK_SKIP_SEC}초`} side="left"   />
      <GestureBadge anim={rightAnim} label={`${SEEK_SKIP_SEC}초 ▶▶`} side="right"  />
      <GestureBadge anim={speedAnim} label="2x 배속"                  side="center" />

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },

  // ── Main gesture zone (replaces separate leftZone + rightZone) ───────────────
  mainGestureZone: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: BOTTOM_ZONE_H,
  },

  // ── Bottom trigger zone ──────────────────────────────────────────────────────
  bottomTriggerZone: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: BOTTOM_ZONE_H,
  },

  // ── Hint line ────────────────────────────────────────────────────────────────
  seekHintLine: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: "rgba(255,255,255,0.28)",
  },

  // ── Top controls overlay ─────────────────────────────────────────────────────
  topControlsOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
  },

  // ── Bottom bar ───────────────────────────────────────────────────────────────
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.60)",
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 12,
  },
  timeText: {
    color: "#fff",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    marginBottom: 6,
  },

  // ── Scrub overlay ────────────────────────────────────────────────────────────
  scrubOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  scrubDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.30)",
  },
  scrubCard: {
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: 12,
    paddingHorizontal: 28,
    paddingVertical: 18,
    alignItems: "center",
    gap: 6,
    minWidth: 180,
  },
  scrubTimeText: {
    color: "#fff",
    fontSize: 36,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    letterSpacing: 1,
  },
  scrubDeltaText: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "600",
  },
  scrubTrack: {
    width: 180,
    height: 4,
    backgroundColor: "rgba(255,255,255,0.25)",
    borderRadius: 2,
    overflow: "visible",
    marginTop: 8,
  },
  scrubFill: {
    height: "100%",
    backgroundColor: "#fff",
    borderRadius: 2,
  },
  scrubThumb: {
    position: "absolute",
    top: "50%",
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#fff",
    marginTop: -6,
    marginLeft: -6,
  },

  // ── Gesture feedback badge ────────────────────────────────────────────────────
  gestureBadge: {
    position: "absolute",
    top: "40%",
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  gestureBadgeText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },

  // ── SeekBar ───────────────────────────────────────────────────────────────────
  seekBarHitArea: {
    width: "100%",
    height: 44,
    justifyContent: "center",
    position: "relative",
  },
  seekTrack: {
    width: "100%",
    height: 4,
    backgroundColor: "rgba(255,255,255,0.35)",
    borderRadius: 2,
    overflow: "hidden",
  },
  seekFill: {
    height: "100%",
    backgroundColor: "#fff",
    borderRadius: 2,
  },
  seekThumb: {
    position: "absolute",
    top: "50%",
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#fff",
    marginTop: -8,
    marginLeft: -8,
  },
});
