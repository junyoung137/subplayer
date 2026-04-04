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
import { SubtitleEditModal } from "./SubtitleEditModal";

function cleanSubtitleText(text: string): string {
  if (!text) return '';
  text = text.replace(/^[.!?,;:\s]+/, '');
  text = text.replace(/\s+[.!?,;:]$/, match => match.trim());
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\s+([.!?,;:])/g, '$1');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.trim();
}

const MIN_DISPLAY_S  = 1.5;
const FADE_IN_MS     = 200;
const FADE_OUT_MS    = 150;
const SWITCH_DIP_MS  = 100;
const POS_MIN        = 0.02;
const POS_MAX        = 0.92;
const LONG_PRESS_MS  = 500;   // 길게 누르기 판정 시간

function findActiveSubtitle(
  subtitles: SubtitleSegment[],
  currentTime: number
): SubtitleSegment | null {
  let lo = 0;
  let hi = subtitles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = subtitles[mid];
    if (currentTime < seg.startTime)    hi = mid - 1;
    else if (currentTime > seg.endTime) lo = mid + 1;
    else                                return seg;
  }
  return null;
}

export function SubtitleOverlay() {
  const subtitleFontSize    = useSettingsStore((s) => s.subtitleFontSize);
  const subtitleColor       = useSettingsStore((s) => s.subtitleColor);
  const subtitleOpacity     = useSettingsStore((s) => s.subtitleOpacity);
  const subtitleMode        = useSettingsStore((s) => s.subtitleMode);
  const subtitlePositionPct = useSettingsStore((s) => s.subtitlePositionPct);
  const subtitleStyle       = useSettingsStore((s) => s.subtitleStyle ?? "outline");
  const update              = useSettingsStore((s) => s.update);

  const positionPctRef = useRef(subtitlePositionPct);
  positionPctRef.current = subtitlePositionPct;

  const subtitles   = usePlayerStore((s) => s.subtitles);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const seekVersion = usePlayerStore((s) => s.seekVersion);
  const setPlaying  = usePlayerStore((s) => s.setPlaying);

  const [containerHeight, setContainerHeight] = useState(0);
  const containerHeightRef = useRef(0);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const startPctRef = useRef(0);

  // ── 편집 모달 state ────────────────────────────────────────────────────────
  const [editingSegment, setEditingSegment] = useState<SubtitleSegment | null>(null);

  // ── 길게 누르기 판정 refs ──────────────────────────────────────────────────
  const longPressTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef      = useRef(false);
  const renderedSubRef     = useRef<SubtitleSegment | null>(null);
  const isLongPressRef     = useRef(false);

  // ── PanResponder: 드래그(위치 조절) + 길게 누르기(편집) ───────────────────
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,

      onPanResponderGrant: () => {
        isDraggingRef.current   = false;
        isLongPressRef.current  = false;
        startPctRef.current     = positionPctRef.current;

        // 길게 누르기 타이머 시작
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
          if (!isDraggingRef.current) {
            isLongPressRef.current = true;
            // 편집 모달 오픈 (렌더링된 자막 기준)
            if (renderedSubRef.current) {
              setEditingSegment({ ...renderedSubRef.current });
            }
          }
        }, LONG_PRESS_MS);
      },

      onPanResponderMove: (_, gs) => {
        const h = containerHeightRef.current;
        if (h <= 0) return;

        // 일정 px 이상 움직이면 드래그로 판정 → 길게 누르기 취소
        if (Math.abs(gs.dy) > 6 || Math.abs(gs.dx) > 6) {
          if (!isDraggingRef.current) {
            isDraggingRef.current = true;
            if (longPressTimerRef.current) {
              clearTimeout(longPressTimerRef.current);
              longPressTimerRef.current = null;
            }
          }
        }

        if (isDraggingRef.current) {
          setDragPct(Math.min(Math.max(startPctRef.current + gs.dy / h, POS_MIN), POS_MAX));
        }
      },

      onPanResponderRelease: (_, gs) => {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        const h = containerHeightRef.current;
        if (isDraggingRef.current && h > 0) {
          update({ subtitlePositionPct: Math.min(Math.max(startPctRef.current + gs.dy / h, POS_MIN), POS_MAX) });
        }
        setDragPct(null);
        isDraggingRef.current  = false;
        isLongPressRef.current = false;
      },

      onPanResponderTerminate: () => {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        setDragPct(null);
        isDraggingRef.current  = false;
        isLongPressRef.current = false;
      },
    })
  ).current;

  const activePct = dragPct !== null ? dragPct : subtitlePositionPct;

  const [displayedSub, setDisplayedSub] = useState<SubtitleSegment | null>(null);
  const [renderedSub,  setRenderedSub]  = useState<SubtitleSegment | null>(null);
  const displayedSubRef = useRef<SubtitleSegment | null>(null);
  const displayedAtRef  = useRef(0);
  const prevSeekVersion = useRef(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // renderedSubRef를 항상 최신으로 유지
  useEffect(() => { renderedSubRef.current = renderedSub; }, [renderedSub]);

  const candidate = findActiveSubtitle(subtitles, currentTime);

  useEffect(() => {
    const isSeeked = seekVersion !== prevSeekVersion.current;
    if (isSeeked) prevSeekVersion.current = seekVersion;

    const current = displayedSubRef.current;
    const sameId  = candidate?.id === current?.id;

    if (sameId && isSeeked) { displayedAtRef.current = currentTime; return; }
    if (sameId) return;

    const elapsed = currentTime - displayedAtRef.current;
    const minMet  = isSeeked || elapsed >= MIN_DISPLAY_S;

    if (current === null || isSeeked) {
      displayedSubRef.current = candidate;
      displayedAtRef.current  = currentTime;
      setDisplayedSub(candidate);
    } else if (candidate === null) {
      if (minMet) { displayedSubRef.current = null; setDisplayedSub(null); }
    } else {
      if (minMet) {
        displayedSubRef.current = candidate;
        displayedAtRef.current  = currentTime;
        setDisplayedSub(candidate);
      }
    }
  }, [currentTime, candidate?.id, seekVersion]);

  useEffect(() => {
    const prev = renderedSub;
    const next = displayedSub;
    if (prev === null && next === null) return;

    if (prev === null && next !== null) {
      setRenderedSub(next);
      Animated.timing(fadeAnim, { toValue: subtitleOpacity, duration: FADE_IN_MS, useNativeDriver: true }).start();
    } else if (prev !== null && next === null) {
      Animated.timing(fadeAnim, { toValue: 0, duration: FADE_OUT_MS, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setRenderedSub(null); });
    } else {
      Animated.timing(fadeAnim, { toValue: 0, duration: SWITCH_DIP_MS, useNativeDriver: true })
        .start(({ finished }) => {
          if (finished) {
            setRenderedSub(displayedSubRef.current);
            Animated.timing(fadeAnim, { toValue: subtitleOpacity, duration: FADE_IN_MS, useNativeDriver: true }).start();
          }
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedSub?.id]);

  const topStyle = containerHeight > 0
    ? { top: containerHeight * activePct }
    : { top: "85%" as any };

  const showOriginal    = renderedSub && (subtitleMode === "original" || subtitleMode === "both") && renderedSub.original;
  const showTranslation = renderedSub && (subtitleMode === "translation" || subtitleMode === "both") && renderedSub.translated;

  const handleEditClose = () => {
    setEditingSegment(null);
  };

  // ── 외곽선형 ──────────────────────────────────────────────────────────────
  const renderOutline = () => (
    <Animated.View
      style={[styles.container, topStyle, { opacity: fadeAnim }]}
      {...(renderedSub ? panResponder.panHandlers : {})}
    >
      {showOriginal && (
        <Text
          style={[styles.outlineOriginal, { fontSize: Math.round(subtitleFontSize * 0.72) }]}
          numberOfLines={3}
        >
          {cleanSubtitleText(renderedSub!.original)}
        </Text>
      )}
      {showTranslation && (
        <Text
          style={[styles.outlineTranslated, { color: subtitleColor, fontSize: subtitleFontSize }]}
          numberOfLines={3}
        >
          {cleanSubtitleText(renderedSub!.translated)}
        </Text>
      )}
    </Animated.View>
  );

  // ── 박스형 ────────────────────────────────────────────────────────────────
  const renderPill = () => (
    <Animated.View
      style={[styles.container, topStyle, { opacity: fadeAnim }]}
      {...(renderedSub ? panResponder.panHandlers : {})}
    >
      {showOriginal && (
        <View style={styles.pillBox}>
          <Text
            style={[styles.pillOriginal, { fontSize: Math.round(subtitleFontSize * 0.78) }]}
            numberOfLines={3}
          >
            {cleanSubtitleText(renderedSub!.original)}
          </Text>
        </View>
      )}
      {showTranslation && (
        <View style={styles.pillBox}>
          <Text
            style={[styles.pillTranslated, { color: subtitleColor, fontSize: subtitleFontSize }]}
            numberOfLines={3}
          >
            {cleanSubtitleText(renderedSub!.translated)}
          </Text>
        </View>
      )}
    </Animated.View>
  );

  // ── 바형 ──────────────────────────────────────────────────────────────────
  const renderBar = () => (
    <Animated.View
      style={[styles.barContainer, topStyle, { opacity: fadeAnim }]}
      {...(renderedSub ? panResponder.panHandlers : {})}
    >
      {showOriginal && (
        <Text
          style={[styles.barOriginal, { fontSize: Math.round(subtitleFontSize * 0.78) }]}
          numberOfLines={3}
        >
          {cleanSubtitleText(renderedSub!.original)}
        </Text>
      )}
      {showTranslation && (
        <Text
          style={[styles.barTranslated, { color: subtitleColor, fontSize: subtitleFontSize }]}
          numberOfLines={3}
        >
          {cleanSubtitleText(renderedSub!.translated)}
        </Text>
      )}
    </Animated.View>
  );

  return (
    <View
      style={StyleSheet.absoluteFillObject}
      pointerEvents="box-none"
      onLayout={(e) => {
        containerHeightRef.current = e.nativeEvent.layout.height;
        setContainerHeight(e.nativeEvent.layout.height);
      }}
    >
      {subtitleStyle === "outline" && renderOutline()}
      {subtitleStyle === "pill"    && renderPill()}
      {subtitleStyle === "bar"     && renderBar()}

      {/* 자막 편집 모달 */}
      <SubtitleEditModal
        segment={editingSegment}
        onClose={handleEditClose}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 12,
    gap: 3,
  },

  // ── 외곽선형 ──────────────────────────────────────────────────────────────
  outlineOriginal: {
    color: "#cccccc",
    fontWeight: "600",
    textAlign: "center",
    textShadowColor: "#000",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 4,
  },
  outlineTranslated: {
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: -0.3,
    textShadowColor: "#000",
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 8,
  },

  // ── 박스형 ────────────────────────────────────────────────────────────────
  pillBox: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: "92%",
    alignItems: "center",
  },
  pillOriginal: {
    color: "#aaaaaa",
    fontWeight: "500",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 3,
  },
  pillTranslated: {
    fontWeight: "700",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.95)",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 5,
  },

  // ── 바형 ──────────────────────────────────────────────────────────────────
  barContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.75)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: "center",
    gap: 2,
  },
  barOriginal: {
    color: "#cccccc",
    fontWeight: "500",
    textAlign: "center",
  },
  barTranslated: {
    fontWeight: "700",
    textAlign: "center",
  },
});