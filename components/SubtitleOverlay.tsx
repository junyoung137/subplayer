import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Animated,
  StyleSheet,
  PanResponder,
} from "react-native";
import { usePlayerStore, SubtitleSegment } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";

function cleanSubtitleText(text: string): string {
  if (!text) return '';

  // Remove leading punctuation (., !, ?, :, ;) and whitespace
  text = text.replace(/^[.!?,;:\s]+/, '');

  // Remove trailing orphan punctuation preceded by a space
  text = text.replace(/\s+[.!?,;:]$/, match => match.trim());

  // Fix double spaces
  text = text.replace(/\s+/g, ' ');

  // Fix space before punctuation
  text = text.replace(/\s+([.!?,;:])/g, '$1');

  // Capitalize first letter
  text = text.charAt(0).toUpperCase() + text.slice(1);

  return text.trim();
}

const MIN_DISPLAY_S  = 1.5;
const FADE_IN_MS     = 200;
const FADE_OUT_MS    = 150;
const SWITCH_DIP_MS  = 100;

// Clamp positionPct so the subtitle never leaves the video area
const POS_MIN = 0.02;
const POS_MAX = 0.92;

/**
 * Binary search for the subtitle whose window contains `currentTime`.
 */
function findActiveSubtitle(
  subtitles: SubtitleSegment[],
  currentTime: number
): SubtitleSegment | null {
  let lo = 0;
  let hi = subtitles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = subtitles[mid];
    if (currentTime < seg.startTime) {
      hi = mid - 1;
    } else if (currentTime > seg.endTime) {
      lo = mid + 1;
    } else {
      return seg;
    }
  }
  return null;
}

export function SubtitleOverlay() {
  // ── Settings ──────────────────────────────────────────────────────────────
  const subtitleFontSize    = useSettingsStore((s) => s.subtitleFontSize);
  const subtitleColor       = useSettingsStore((s) => s.subtitleColor);
  const subtitleOpacity     = useSettingsStore((s) => s.subtitleOpacity);
  const subtitleMode        = useSettingsStore((s) => s.subtitleMode);
  const subtitlePositionPct = useSettingsStore((s) => s.subtitlePositionPct);
  const update              = useSettingsStore((s) => s.update);

  // Ref so PanResponder closure always reads the latest saved value
  const positionPctRef = useRef(subtitlePositionPct);
  positionPctRef.current = subtitlePositionPct;

  // ── Player state ──────────────────────────────────────────────────────────
  const subtitles   = usePlayerStore((s) => s.subtitles);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const seekVersion = usePlayerStore((s) => s.seekVersion);

  // ── Container measurement ─────────────────────────────────────────────────
  // Measured via onLayout on the absoluteFill wrapper so we can convert the
  // stored fraction → absolute pixel offset.
  const [containerHeight, setContainerHeight] = useState(0);
  const containerHeightRef = useRef(0);

  // ── Drag state ────────────────────────────────────────────────────────────
  // dragPct is non-null only while the user is actively dragging; we show it
  // immediately for smooth feedback and commit to the store on release.
  const [dragPct, setDragPct] = useState<number | null>(null);
  const startPctRef = useRef(0); // positionPct at the moment the finger goes down

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onPanResponderGrant: () => {
        startPctRef.current = positionPctRef.current;
      },
      onPanResponderMove: (_, gs) => {
        const h = containerHeightRef.current;
        if (h <= 0) return;
        const newPct = Math.min(Math.max(startPctRef.current + gs.dy / h, POS_MIN), POS_MAX);
        setDragPct(newPct);
      },
      onPanResponderRelease: (_, gs) => {
        const h = containerHeightRef.current;
        if (h > 0) {
          const newPct = Math.min(Math.max(startPctRef.current + gs.dy / h, POS_MIN), POS_MAX);
          update({ subtitlePositionPct: newPct });
        }
        setDragPct(null);
      },
      onPanResponderTerminate: () => {
        setDragPct(null);
      },
    })
  ).current;

  // The position used for rendering (live during drag, persisted otherwise)
  const activePct = dragPct !== null ? dragPct : subtitlePositionPct;

  // ── Subtitle timing logic ─────────────────────────────────────────────────
  const [displayedSub, setDisplayedSub] = useState<SubtitleSegment | null>(null);
  const [renderedSub,  setRenderedSub]  = useState<SubtitleSegment | null>(null);

  const displayedSubRef = useRef<SubtitleSegment | null>(null);
  const displayedAtRef  = useRef(0);
  const prevSeekVersion = useRef(0);

  const fadeAnim = useRef(new Animated.Value(0)).current;

  const candidate = findActiveSubtitle(subtitles, currentTime);

  useEffect(() => {
    console.log('[OVERLAY] currentTime:', currentTime);
    console.log('[OVERLAY] active subtitle:', candidate);
    const isSeeked = seekVersion !== prevSeekVersion.current;
    if (isSeeked) prevSeekVersion.current = seekVersion;

    const current = displayedSubRef.current;
    const sameId  = candidate?.id === current?.id;

    if (sameId && isSeeked) {
      displayedAtRef.current = currentTime;
      return;
    }
    if (sameId) return;

    const elapsed = currentTime - displayedAtRef.current;
    const minMet  = isSeeked || elapsed >= MIN_DISPLAY_S;

    if (current === null || isSeeked) {
      displayedSubRef.current = candidate;
      displayedAtRef.current  = currentTime;
      setDisplayedSub(candidate);
    } else if (candidate === null) {
      if (minMet) {
        displayedSubRef.current = null;
        setDisplayedSub(null);
      }
    } else {
      if (minMet) {
        displayedSubRef.current = candidate;
        displayedAtRef.current  = currentTime;
        setDisplayedSub(candidate);
      }
    }
  }, [currentTime, candidate?.id, seekVersion]);

  // ── Fade animations ───────────────────────────────────────────────────────
  useEffect(() => {
    const prev = renderedSub;
    const next = displayedSub;

    if (prev === null && next === null) return;

    if (prev === null && next !== null) {
      setRenderedSub(next);
      Animated.timing(fadeAnim, {
        toValue: subtitleOpacity,
        duration: FADE_IN_MS,
        useNativeDriver: true,
      }).start();
    } else if (prev !== null && next === null) {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: FADE_OUT_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setRenderedSub(null);
      });
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: SWITCH_DIP_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setRenderedSub(displayedSubRef.current);
          Animated.timing(fadeAnim, {
            toValue: subtitleOpacity,
            duration: FADE_IN_MS,
            useNativeDriver: true,
          }).start();
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedSub?.id]);

  // ── Pixel top position ────────────────────────────────────────────────────
  // Only calculate once containerHeight is known; fall back to "near bottom"
  // using a percentage string so the first frame looks correct too.
  const topStyle = containerHeight > 0
    ? { top: containerHeight * activePct }
    : { top: "85%" as any };

  return (
    // Full-size transparent wrapper — measures the video container height.
    // pointerEvents="box-none" so the transparent background never blocks video touches;
    // the subtitle pill itself still receives drag touches.
    <View
      style={StyleSheet.absoluteFillObject}
      pointerEvents="box-none"
      onLayout={(e) => {
        containerHeightRef.current = e.nativeEvent.layout.height;
        setContainerHeight(e.nativeEvent.layout.height);
      }}
    >
      <Animated.View
        style={[styles.container, topStyle, { opacity: fadeAnim }]}
        // Only attach drag handlers when a subtitle is visible
        {...(renderedSub ? panResponder.panHandlers : {})}
      >
        {/* Drag handle — always rendered when subtitle is visible */}
        {renderedSub && (
          <Text style={styles.dragHandle}>≡</Text>
        )}

        {/* Top line: original Whisper text — smaller, gray */}
        {renderedSub &&
          (subtitleMode === "original" || subtitleMode === "both") &&
          renderedSub.original ? (
          <View style={styles.pill}>
            <Text
              style={[
                styles.originalText,
                { fontSize: Math.round(subtitleFontSize * 0.78) },
              ]}
              numberOfLines={2}
            >
              {cleanSubtitleText(renderedSub.original)}
            </Text>
          </View>
        ) : null}

        {/* Bottom line: Korean translation — larger, white + shadow */}
        {renderedSub &&
          (subtitleMode === "translation" || subtitleMode === "both") &&
          renderedSub.translated ? (
          <View style={styles.pill}>
            <Text
              style={[
                styles.translatedText,
                { color: subtitleColor, fontSize: subtitleFontSize },
              ]}
              numberOfLines={2}
            >
              {cleanSubtitleText(renderedSub.translated)}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Absolutely positioned within the video container; top is set inline.
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 4,
  },
  dragHandle: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 16,
    lineHeight: 18,
    marginBottom: 2,
    // Wider touch area via padding so the finger doesn't have to be precise
    paddingHorizontal: 24,
    paddingVertical: 4,
  },
  pill: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: "92%",
    alignItems: "center",
  },
  originalText: {
    // Top line: gray, smaller — always independent of user's subtitle color
    color: "#aaaaaa",
    fontWeight: "500",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 3,
  },
  translatedText: {
    // Bottom line: user color (default white), larger, stronger shadow
    fontWeight: "700",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.95)",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 5,
  },
});
