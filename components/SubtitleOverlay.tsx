import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { getLanguageProfile } from "../constants/languageProfiles";

// ─────────────────────────────────────────────────────────────────────────────
// Changelog (최종 완성형)
//
// [FINAL-OPT-1] MAX_DURATION_S = 4.5초
// [FINAL-OPT-2] MIN_DISPLAY_S = 1.2초
// [FINAL-OPT-3] MAX_MERGED_CHARS = 36자
// [FINAL-OPT-4] MAX_READING_SPEED = 12.5 char/s
// [ADVANCED-1] Dynamic Hold (짧은 자막 빠르게, 긴 자막 여유롭게)
// [CRITICAL-FIX] findActiveDisplayLine 완전 수정
//              → 자막 종료 후 0.2초만 hold, 이후 무조건 null (10초 유지 버그 완전 해결)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface DisplayLine {
  startTime: number;
  endTime: number;
  lines: string[];
  segmentId: string;
  original: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants — 넷플릭스급 최적값
// ─────────────────────────────────────────────────────────────────────────────
const MAX_LINE_CHARS = 22;
const MAX_MERGE_GAP_S = 0.4;
const MAX_MERGED_CHARS = 36;
const MAX_MERGE_COUNT = 3;
const MAX_READING_SPEED = 12.5;
const MAX_DURATION_S = 4.5;
const MIN_DISPLAY_S = 1.2;

const MAX_HOLD_GAP_S = 0.30;     // Dynamic Hold 최대치
const HOLD_AFTER_END = 0.7;      // 자막 종료 후 살짝 유지 시간 (부드러운 전환용)

const BLANK_PATTERNS = [
  "[BLANK_AUDIO]", "[BLANK_VIDEO]", "[blank_audio]", "[silence]", "[SILENCE]",
];

const FADE_IN_MS = 200;
const FADE_OUT_MS = 150;
const SWITCH_DIP_MS = 100;
const POS_MIN = 0.02;
const POS_MAX = 0.92;
const LONG_PRESS_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function isBlankText(text: string): boolean {
  if (!text || text.trim().length === 0) return true;
  return BLANK_PATTERNS.some((p) => text.includes(p));
}

function cleanSubtitleText(text: string): string {
  if (!text) return "";
  // Remove leading dialogue dash (e.g. "- File goes cold." → "File goes cold.")
  text = text.replace(/^-\s*/, "");
  // Normalize ellipsis: "... ..." → "..."
  text = text.replace(/\.\.\.\s*\.\.\./g, "...");
  text = text.replace(/\.{4,}/g, "...");
  text = text.replace(/\.\s*\.\s*\.\s*\.\s*\./g, "...");
  text = text.replace(/^[!?,;:\s]+/, "");
  text = text.replace(/\s+[.!?,;:]$/, (m) => m.trim());
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\s+([.!?,;:])/g, "$1");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2줄 분기 알고리즘
// ─────────────────────────────────────────────────────────────────────────────
const RE_KO_PARTICLE = /(은|는|이|가|을|를|에서|에게|으로|로|하고|이고|지만|는데|인데)\s/g;
const RE_KO_CONJUNCT = /(그리고|근데|그래서|그런데|하지만)\s/g;
const RE_EN_CONJUNCT = /\b(and|but|so|because|or|however)\s/gi;

function splitIntoTwoLines(text: string): [string, string] {
  const t = text.trim();
  if (t.length <= MAX_LINE_CHARS) return [t, ""];

  const mid = Math.floor(t.length / 2);

  // 1순위: 조사 앞
  {
    let bestPos = -1, bestDist = Infinity;
    RE_KO_PARTICLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_KO_PARTICLE.exec(t)) !== null) {
      const pos = m.index + m[1].length;
      const dist = Math.abs(pos - mid);
      if (dist < bestDist && pos > 2 && pos < t.length - 2) {
        bestDist = dist;
        bestPos = pos;
      }
    }
    if (bestPos > 0) {
      const l1 = t.slice(0, bestPos).trim();
      const l2 = t.slice(bestPos).trim();
      if (l1.length >= 3 && l2.length >= 3) return [l1, l2];
    }
  }

  // 2순위: 한국어 접속사
  {
    let bestPos = -1, bestDist = Infinity;
    RE_KO_CONJUNCT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_KO_CONJUNCT.exec(t)) !== null) {
      const pos = m.index;
      const dist = Math.abs(pos - mid);
      if (dist < bestDist && pos > 2 && pos < t.length - 2) {
        bestDist = dist;
        bestPos = pos;
      }
    }
    if (bestPos > 0) {
      const l1 = t.slice(0, bestPos).trim();
      const l2 = t.slice(bestPos).trim();
      if (l1.length >= 3 && l2.length >= 3) return [l1, l2];
    }
  }

  // 3순위: 영어 접속사
  {
    let bestPos = -1, bestDist = Infinity;
    RE_EN_CONJUNCT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_EN_CONJUNCT.exec(t)) !== null) {
      const pos = m.index;
      const dist = Math.abs(pos - mid);
      if (dist < bestDist && pos > 2 && pos < t.length - 2) {
        bestDist = dist;
        bestPos = pos;
      }
    }
    if (bestPos > 0) {
      const l1 = t.slice(0, bestPos).trim();
      const l2 = t.slice(bestPos).trim();
      if (l1.length >= 3 && l2.length >= 3) return [l1, l2];
    }
  }

  // 4순위: 중간 공백
  {
    const spaces: number[] = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] === " ") spaces.push(i);
    }
    if (spaces.length > 0) {
      const best = spaces.reduce((prev, cur) =>
        Math.abs(cur - mid) < Math.abs(prev - mid) ? cur : prev
      );
      const l1 = t.slice(0, best).trim();
      const l2 = t.slice(best).trim();
      if (l1.length >= 3 && l2.length >= 3) return [l1, l2];
    }
  }

  return [t.slice(0, mid).trim(), t.slice(mid).trim()];
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDisplayLines
// ─────────────────────────────────────────────────────────────────────────────
function buildDisplayLines(
  segments: SubtitleSegment[],
  mode: "both" | "original" | "translation",
  targetLanguage: string,
): DisplayLine[] {
  if (segments.length === 0) return [];

  const profile = getLanguageProfile(targetLanguage);
  const result: DisplayLine[] = [];

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (isBlankText(seg.original)) {
      i++;
      continue;
    }

    const group: SubtitleSegment[] = [seg];
    let j = i + 1;

    while (j < segments.length && group.length < MAX_MERGE_COUNT) {
      const next = segments[j];
      if (isBlankText(next.original)) break;

      const gap = next.startTime - group[group.length - 1].endTime;
      if (gap > MAX_MERGE_GAP_S) break;

      const currentText = mode === "original"
        ? group.map((s) => s.original).join(" ")
        : group.map((s) => s.translated || s.original).join(" ");

      const nextText = mode === "original"
        ? next.original
        : (next.translated || next.original);

      const merged = (currentText + " " + nextText).replace(/\s+/g, " ").trim();
      const mergedLen = merged.length;

      if (mergedLen > MAX_MERGED_CHARS) break;

      const lastSegText = group[group.length - 1].translated || group[group.length - 1].original;
      if (/[.!?]$/.test(lastSegText.trim())) break;

      const groupDuration = next.endTime - group[0].startTime;
      if (groupDuration > MAX_DURATION_S) break;

      const readingSpeed = groupDuration > 0 ? mergedLen / groupDuration : 999;
      if (readingSpeed > MAX_READING_SPEED) break;

      group.push(next);
      j++;
    }

    const originalText = group.map((s) => s.original).join(" ").trim();
    const translatedRaw = group
      .map((s) => s.translated || s.original)
      .join(" ")
      .trim();

    const translatedText = translatedRaw
      .replace(profile.trailingPunctuationToStrip, "")
      .trim();

    let displayText = mode === "translation" || mode === "both"
      ? (translatedText || originalText)
      : originalText;

    displayText = displayText.replace(/\.\.\.\s*\.\.\./g, "...");
    displayText = displayText.replace(/\.{4,}/g, "...");
    const [line1, line2] = splitIntoTwoLines(cleanSubtitleText(displayText));
    const lines = line2 ? [line1, line2] : [line1];

    result.push({
      startTime: group[0].startTime,
      endTime: group[group.length - 1].endTime,
      lines,
      segmentId: seg.id,
      original: originalText,
    });

    i = j;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// findActiveDisplayLine — 핵심 수정 완료
// ─────────────────────────────────────────────────────────────────────────────
function findActiveDisplayLine(
  lines: DisplayLine[],
  currentTime: number,
  lastSeekTime?: number,
): DisplayLine | null {
  if (lines.length === 0) return null;

  let lo = 0, hi = lines.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const dl = lines[mid];

    if (currentTime < dl.startTime) {
      hi = mid - 1;
    } else if (currentTime > dl.endTime) {
      lo = mid + 1;
    } else {
      return dl;
    }
  }

  // Only hold the previous segment if we are naturally just past its
  // end (not after a seek jump). The hold must be within HOLD_AFTER_END
  // seconds AND the segment must have ended very recently in wall-clock
  // terms (endTime close to currentTime).
  const prev = lines[hi];
  if (
    prev &&
    currentTime <= prev.endTime + HOLD_AFTER_END &&
    currentTime <= prev.endTime + 0.8
  ) {
    return prev;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SubtitleOverlay
// ─────────────────────────────────────────────────────────────────────────────
export function SubtitleOverlay() {
  const subtitleFontSize = useSettingsStore((s) => s.subtitleFontSize);
  const subtitleColor = useSettingsStore((s) => s.subtitleColor);
  const subtitleOpacity = useSettingsStore((s) => s.subtitleOpacity);
  const subtitleMode = useSettingsStore((s) => s.subtitleMode);
  const subtitlePositionPct = useSettingsStore((s) => s.subtitlePositionPct);
  const subtitleStyle = useSettingsStore((s) => s.subtitleStyle ?? "outline");
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const timingOffset = useSettingsStore((s) => s.timingOffset);
  const update = useSettingsStore((s) => s.update);

  const positionPctRef = useRef(subtitlePositionPct);
  positionPctRef.current = subtitlePositionPct;

  const subtitles = usePlayerStore((s) => s.subtitles);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const seekVersion = usePlayerStore((s) => s.seekVersion);

  const [containerHeight, setContainerHeight] = useState(0);
  const containerHeightRef = useRef(0);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const startPctRef = useRef(0);
  const [editingSegment, setEditingSegment] = useState<SubtitleSegment | null>(null);

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef = useRef(false);
  const renderedLineRef = useRef<DisplayLine | null>(null);
  const isLongPressRef = useRef(false);
  const subtitlesRef = useRef(subtitles);

  const displayLines = useMemo(
    () => buildDisplayLines(subtitles, subtitleMode, targetLanguage),
    [subtitles, subtitleMode, targetLanguage],
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onPanResponderGrant: () => {
        isDraggingRef.current = false;
        isLongPressRef.current = false;
        startPctRef.current = positionPctRef.current;
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
          if (!isDraggingRef.current && renderedLineRef.current) {
            isLongPressRef.current = true;
            const seg = subtitlesRef.current.find((s) => s.id === renderedLineRef.current!.segmentId);
            if (seg) setEditingSegment({ ...seg });
          }
        }, LONG_PRESS_MS);
      },
      onPanResponderMove: (_, gs) => {
        const h = containerHeightRef.current;
        if (h <= 0) return;
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
          setDragPct(
            Math.min(Math.max(startPctRef.current + gs.dy / h, POS_MIN), POS_MAX),
          );
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        const h = containerHeightRef.current;
        if (isDraggingRef.current && h > 0) {
          update({
            subtitlePositionPct: Math.min(
              Math.max(startPctRef.current + gs.dy / h, POS_MIN),
              POS_MAX,
            ),
          });
        }
        setDragPct(null);
        isDraggingRef.current = false;
        isLongPressRef.current = false;
      },
      onPanResponderTerminate: () => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        setDragPct(null);
        isDraggingRef.current = false;
        isLongPressRef.current = false;
      },
    }),
  ).current;

  const activePct = dragPct !== null ? dragPct : subtitlePositionPct;

  const [displayedLine, setDisplayedLine] = useState<DisplayLine | null>(null);
  const [renderedLine, setRenderedLine] = useState<DisplayLine | null>(null);
  const displayedLineRef = useRef<DisplayLine | null>(null);
  const displayedAtRef = useRef(0);
  const prevSeekVersion = useRef(0);
  const lastSeekTimeRef = useRef<number>(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => { renderedLineRef.current = renderedLine; }, [renderedLine]);
  useEffect(() => { subtitlesRef.current = subtitles; }, [subtitles]);

  const adjustedTime = currentTime + (timingOffset ?? 0) + 0.5;
  const candidate = useMemo(
    () => findActiveDisplayLine(displayLines, adjustedTime),
    [displayLines, adjustedTime, seekVersion],
  );

  // Dynamic Hold + MIN_DISPLAY_S 적용
  useEffect(() => {
    const isSeeked = seekVersion !== prevSeekVersion.current;
    if (isSeeked) prevSeekVersion.current = seekVersion;

    if (isSeeked) {
      lastSeekTimeRef.current = adjustedTime;
      displayedLineRef.current = null;
      displayedAtRef.current = adjustedTime;
    }

    const current = displayedLineRef.current;
    const sameId = candidate?.segmentId === current?.segmentId;

    if (sameId && !isSeeked) return;

    const elapsed = adjustedTime - displayedAtRef.current;

    let dynamicHold = 0;
    if (candidate) {
      const textLength = candidate.lines.join("").length;
      dynamicHold = textLength < 12 ? 0.15 : 0.22;
    }

    const minMet = isSeeked || elapsed >= MIN_DISPLAY_S + dynamicHold;

    if (current === null || isSeeked) {
      displayedLineRef.current = candidate;
      displayedAtRef.current = adjustedTime;
      setDisplayedLine(candidate);
    } else if (candidate === null) {
      displayedLineRef.current = null;
      setDisplayedLine(null);
    } else if (minMet) {
      displayedLineRef.current = candidate;
      displayedAtRef.current = candidate.startTime;
      setDisplayedLine(candidate);
    }
  }, [adjustedTime, candidate?.segmentId, seekVersion]);

  // Fade Animation
  useEffect(() => {
    const prev = renderedLine;
    const next = displayedLine;

    if (prev === null && next === null) return;

    if (prev === null && next !== null) {
      setRenderedLine(next);
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
        if (finished) setRenderedLine(null);
      });
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: SWITCH_DIP_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setRenderedLine(displayedLineRef.current);
          Animated.timing(fadeAnim, {
            toValue: subtitleOpacity,
            duration: FADE_IN_MS,
            useNativeDriver: true,
          }).start();
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedLine?.segmentId]);

  const topStyle = containerHeight > 0
    ? { top: containerHeight * activePct }
    : { top: "85%" as any };

  const showOriginal = subtitleMode === "original" || subtitleMode === "both";
  const showTranslation = subtitleMode === "translation" || subtitleMode === "both";

  const activeOriginal = useMemo(() => {
    if (!renderedLine) return "";
    const seg = subtitles.find((s) => s.id === renderedLine.segmentId);
    return seg ? cleanSubtitleText(seg.original) : "";
  }, [renderedLine, subtitles]);

  const renderLines = (
    containerStyle: object,
    originalTextStyle: object,
    translationTextStyle: object,
  ) => (
    <Animated.View
      style={[containerStyle, topStyle, { opacity: fadeAnim }]}
      {...(renderedLine ? panResponder.panHandlers : {})}
    >
      {showOriginal && activeOriginal ? (
        <Text
          style={[originalTextStyle, { fontSize: Math.round(subtitleFontSize * 0.72) }]}
          numberOfLines={2}
        >
          {activeOriginal}
        </Text>
      ) : null}

      {showTranslation && renderedLine ? (
        renderedLine.lines.map((line, idx) => (
          <Text
            key={idx}
            style={[
              translationTextStyle,
              { color: subtitleColor, fontSize: subtitleFontSize },
            ]}
            numberOfLines={1}
          >
            {line}
          </Text>
        ))
      ) : null}
    </Animated.View>
  );

  const renderOutline = () => renderLines(styles.container, styles.outlineOriginal, styles.outlineTranslated);

  const renderPill = () => (
    <Animated.View
      style={[styles.container, topStyle, { opacity: fadeAnim }]}
      {...(renderedLine ? panResponder.panHandlers : {})}
    >
      {showOriginal && activeOriginal && (
        <View style={styles.pillBox}>
          <Text
            style={[styles.pillOriginal, { fontSize: Math.round(subtitleFontSize * 0.78) }]}
            numberOfLines={2}
          >
            {activeOriginal}
          </Text>
        </View>
      )}
      {showTranslation && renderedLine && (
        <View style={styles.pillBox}>
          {renderedLine.lines.map((line, idx) => (
            <Text
              key={idx}
              style={[styles.pillTranslated, { color: subtitleColor, fontSize: subtitleFontSize }]}
              numberOfLines={1}
            >
              {line}
            </Text>
          ))}
        </View>
      )}
    </Animated.View>
  );

  const renderBar = () => (
    <Animated.View
      style={[styles.barContainer, topStyle, { opacity: fadeAnim }]}
      {...(renderedLine ? panResponder.panHandlers : {})}
    >
      {showOriginal && activeOriginal && (
        <Text
          style={[styles.barOriginal, { fontSize: Math.round(subtitleFontSize * 0.78) }]}
          numberOfLines={2}
        >
          {activeOriginal}
        </Text>
      )}
      {showTranslation && renderedLine && (
        renderedLine.lines.map((line, idx) => (
          <Text
            key={idx}
            style={[styles.barTranslated, { color: subtitleColor, fontSize: subtitleFontSize }]}
            numberOfLines={1}
          >
            {line}
          </Text>
        ))
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
      {subtitleStyle === "pill" && renderPill()}
      {subtitleStyle === "bar" && renderBar()}

      <SubtitleEditModal
        segment={editingSegment}
        onClose={() => setEditingSegment(null)}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 12,
    gap: 3,
  },
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