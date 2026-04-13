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
// Changelog
//
//  [FIX-1] mergedLen: 공백 제거 → 공백 포함으로 수정
//          readingSpeed가 실제보다 높게 잡혀 merge가 과도하게 막히던 버그 수정
//          `merged.replace(/\s/g, "").length` → `merged.length`
//
//  [FIX-2] MAX_MERGED_CHARS: 28 → 42 로 조정 (MAX_LINE_CHARS * 2 = 44 근사)
//          기존 28자 제한은 2줄 자막 기준으로 지나치게 짧았음
//          MAX_LINE_CHARS(22) * 2 = 44를 상한으로 두되, 약간 여유를 줘서 42 설정
//
//  [FIX-3] punctuation soft break 추가
//          문장 끝 구두점(.!?)으로 끝나는 세그먼트는 merge를 멈춤
//          Hard rule이 아닌 soft break — 맥락상 의미 단위 보존
//
//  [SKIP]  segmentId → 가운데 세그먼트: 배제
//          첫 세그먼트가 그룹 시작점이므로 편집 UX상 더 직관적
//          멀티 segmentIds는 SubtitleEditModal 구조 변경 필요 → 범위 초과
//
//  [SKIP]  짧은 그룹 merge 강화 (mergedLen < 10): 배제
//          현재 gap/speed 로직이 자연스럽게 처리 — 코드 복잡도 대비 실익 작음
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface DisplayLine {
  startTime: number;
  endTime:   number;
  lines:     string[];          // 최대 2줄
  segmentId: string;            // 대표 세그먼트 ID (편집 모달용)
  original:  string;            // 원문 (병합된 전체)
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LINE_CHARS    = 22;   // 한 줄 최대 글자 수
const MAX_MERGE_GAP_S   = 0.4;  // 세그먼트 간 병합 허용 gap (초)
const MAX_MERGED_CHARS  = 42;   // [FIX-2] 28 → 42 (MAX_LINE_CHARS * 2 기준)
const MAX_MERGE_COUNT   = 3;    // 병합 최대 세그먼트 수
const MAX_READING_SPEED = 14;   // 글자/초 — 초과 시 병합 금지

const BLANK_PATTERNS = [
  "[BLANK_AUDIO]", "[BLANK_VIDEO]", "[blank_audio]", "[silence]", "[SILENCE]",
];

const MIN_DISPLAY_S  = 0.5;
const FADE_IN_MS     = 200;
const FADE_OUT_MS    = 150;
const SWITCH_DIP_MS  = 100;
const POS_MIN        = 0.02;
const POS_MAX        = 0.92;
const LONG_PRESS_MS  = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isBlankText(text: string): boolean {
  if (!text || text.trim().length === 0) return true;
  return BLANK_PATTERNS.some((p) => text.includes(p));
}

function cleanSubtitleText(text: string): string {
  if (!text) return "";
  text = text.replace(/^[.!?,;:\s]+/, "");
  text = text.replace(/\s+[.!?,;:]$/, (m) => m.trim());
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\s+([.!?,;:])/g, "$1");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2줄 분기 알고리즘
// 우선순위: 1) 조사 앞  2) 접속사  3) 공백 중간  4) 강제 분할
// ─────────────────────────────────────────────────────────────────────────────

const RE_KO_PARTICLE = /(은|는|이|가|을|를|에서|에게|으로|로|하고|이고|지만|는데|인데)\s/g;
const RE_KO_CONJUNCT = /(그리고|근데|그래서|그런데|하지만)\s/g;
const RE_EN_CONJUNCT = /\b(and|but|so|because|or|however)\s/gi;

function splitIntoTwoLines(text: string): [string, string] {
  const t = text.trim();
  if (t.length <= MAX_LINE_CHARS) return [t, ""];

  const mid = Math.floor(t.length / 2);

  // 1순위: 조사 앞 (한국어)
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

  // 5순위: 강제 분할
  return [t.slice(0, mid).trim(), t.slice(mid).trim()];
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDisplayLines  (핵심 엔진 — 번역 데이터 무손상)
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

      // [FIX-1] 공백 포함 길이로 계산 — readingSpeed 과대평가 방지
      const mergedLen = merged.length;

      if (mergedLen > MAX_MERGED_CHARS) break;

      // [FIX-3] punctuation soft break — 문장 끝이면 merge 중단
      // 마침표/느낌표/물음표로 끝나는 세그먼트는 의미 단위 경계로 간주
      if (/[.!?]$/.test(currentText.trim())) break;

      // reading speed 체크: 병합 구간 전체 duration 기준
      const groupDuration = next.endTime - group[0].startTime;
      const readingSpeed  = groupDuration > 0 ? mergedLen / groupDuration : 999;
      if (readingSpeed > MAX_READING_SPEED) break;

      group.push(next);
      j++;
    }

    // ── 텍스트 재조합 ────────────────────────────────────────────────────────
    const originalText = group.map((s) => s.original).join(" ").trim();
    const translatedRaw = group
      .map((s) => s.translated || s.original)
      .join(" ")
      .trim();

    const translatedText = translatedRaw
      .replace(profile.trailingPunctuationToStrip, "")
      .trim();

    let displayText = "";
    if (mode === "translation" || mode === "both") {
      displayText = translatedText || originalText;
    } else {
      displayText = originalText;
    }

    const [line1, line2] = splitIntoTwoLines(cleanSubtitleText(displayText));
    const lines = line2 ? [line1, line2] : [line1];

    result.push({
      startTime: group[0].startTime,
      endTime:   group[group.length - 1].endTime,
      lines,
      segmentId: seg.id,   // 첫 세그먼트 유지 (편집 UX상 그룹 시작점이 직관적)
      original:  originalText,
    });

    i = j;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// findActiveDisplayLine (binary search)
// ─────────────────────────────────────────────────────────────────────────────

function findActiveDisplayLine(
  lines: DisplayLine[],
  currentTime: number,
): DisplayLine | null {
  if (lines.length === 0) return null;

  let lo = 0, hi = lines.length - 1;
  let lastEndedIdx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const dl  = lines[mid];
    if (currentTime < dl.startTime) {
      hi = mid - 1;
    } else if (currentTime > dl.endTime) {
      lastEndedIdx = mid;
      lo = mid + 1;
    } else {
      return dl;
    }
  }

  if (lastEndedIdx >= 0) return lines[lastEndedIdx];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SubtitleOverlay
// ─────────────────────────────────────────────────────────────────────────────

export function SubtitleOverlay() {
  const subtitleFontSize    = useSettingsStore((s) => s.subtitleFontSize);
  const subtitleColor       = useSettingsStore((s) => s.subtitleColor);
  const subtitleOpacity     = useSettingsStore((s) => s.subtitleOpacity);
  const subtitleMode        = useSettingsStore((s) => s.subtitleMode);
  const subtitlePositionPct = useSettingsStore((s) => s.subtitlePositionPct);
  const subtitleStyle       = useSettingsStore((s) => s.subtitleStyle ?? "outline");
  const targetLanguage      = useSettingsStore((s) => s.targetLanguage);
  const update              = useSettingsStore((s) => s.update);

  const positionPctRef = useRef(subtitlePositionPct);
  positionPctRef.current = subtitlePositionPct;

  const subtitles   = usePlayerStore((s) => s.subtitles);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const seekVersion = usePlayerStore((s) => s.seekVersion);

  const [containerHeight, setContainerHeight] = useState(0);
  const containerHeightRef = useRef(0);
  const [dragPct, setDragPct]  = useState<number | null>(null);
  const startPctRef = useRef(0);

  const [editingSegment, setEditingSegment] = useState<SubtitleSegment | null>(null);

  const longPressTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef      = useRef(false);
  const renderedLineRef    = useRef<DisplayLine | null>(null);
  const isLongPressRef     = useRef(false);

  const displayLines = useMemo(
    () => buildDisplayLines(subtitles, subtitleMode, targetLanguage),
    [subtitles, subtitleMode, targetLanguage],
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder:        () => true,
      onMoveShouldSetPanResponder:         () => true,
      onStartShouldSetPanResponderCapture: () => true,

      onPanResponderGrant: () => {
        isDraggingRef.current  = false;
        isLongPressRef.current = false;
        startPctRef.current    = positionPctRef.current;

        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
          if (!isDraggingRef.current && renderedLineRef.current) {
            isLongPressRef.current = true;
            const seg = subtitles.find(
              (s) => s.id === renderedLineRef.current!.segmentId,
            );
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
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
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
    }),
  ).current;

  const activePct = dragPct !== null ? dragPct : subtitlePositionPct;

  const [displayedLine, setDisplayedLine] = useState<DisplayLine | null>(null);
  const [renderedLine,  setRenderedLine]  = useState<DisplayLine | null>(null);
  const displayedLineRef  = useRef<DisplayLine | null>(null);
  const displayedAtRef    = useRef(0);
  const prevSeekVersion   = useRef(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => { renderedLineRef.current = renderedLine; }, [renderedLine]);

  const candidate = useMemo(
    () => findActiveDisplayLine(displayLines, currentTime),
    [displayLines, currentTime],
  );

  useEffect(() => {
    const isSeeked = seekVersion !== prevSeekVersion.current;
    if (isSeeked) prevSeekVersion.current = seekVersion;

    const current = displayedLineRef.current;
    const sameId  = candidate?.segmentId === current?.segmentId;

    if (sameId && isSeeked) { displayedAtRef.current = currentTime; return; }
    if (sameId) return;

    const elapsed = currentTime - displayedAtRef.current;
    const minMet  = isSeeked || elapsed >= MIN_DISPLAY_S;

    if (current === null || isSeeked) {
      displayedLineRef.current = candidate;
      displayedAtRef.current   = currentTime;
      setDisplayedLine(candidate);
    } else if (candidate === null) {
      if (minMet) { displayedLineRef.current = null; setDisplayedLine(null); }
    } else {
      if (minMet) {
        displayedLineRef.current = candidate;
        displayedAtRef.current   = currentTime;
        setDisplayedLine(candidate);
      }
    }
  }, [currentTime, candidate?.segmentId, seekVersion]);

  useEffect(() => {
    const prev = renderedLine;
    const next = displayedLine;
    if (prev === null && next === null) return;

    if (prev === null && next !== null) {
      setRenderedLine(next);
      Animated.timing(fadeAnim, {
        toValue: subtitleOpacity, duration: FADE_IN_MS, useNativeDriver: true,
      }).start();
    } else if (prev !== null && next === null) {
      Animated.timing(fadeAnim, {
        toValue: 0, duration: FADE_OUT_MS, useNativeDriver: true,
      }).start(({ finished }) => { if (finished) setRenderedLine(null); });
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0, duration: SWITCH_DIP_MS, useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setRenderedLine(displayedLineRef.current);
          Animated.timing(fadeAnim, {
            toValue: subtitleOpacity, duration: FADE_IN_MS, useNativeDriver: true,
          }).start();
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedLine?.segmentId]);

  const topStyle = containerHeight > 0
    ? { top: containerHeight * activePct }
    : { top: "85%" as any };

  const showOriginal    = subtitleMode === "original" || subtitleMode === "both";
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
    wrapStyle?: object,
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
              wrapStyle,
            ]}
            numberOfLines={1}
          >
            {line}
          </Text>
        ))
      ) : null}
    </Animated.View>
  );

  const renderOutline = () =>
    renderLines(
      styles.container,
      styles.outlineOriginal,
      styles.outlineTranslated,
    );

  const renderPill = () => (
    <Animated.View
      style={[styles.container, topStyle, { opacity: fadeAnim }]}
      {...(renderedLine ? panResponder.panHandlers : {})}
    >
      {showOriginal && activeOriginal ? (
        <View style={styles.pillBox}>
          <Text
            style={[styles.pillOriginal, { fontSize: Math.round(subtitleFontSize * 0.78) }]}
            numberOfLines={2}
          >
            {activeOriginal}
          </Text>
        </View>
      ) : null}

      {showTranslation && renderedLine ? (
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
      ) : null}
    </Animated.View>
  );

  const renderBar = () => (
    <Animated.View
      style={[styles.barContainer, topStyle, { opacity: fadeAnim }]}
      {...(renderedLine ? panResponder.panHandlers : {})}
    >
      {showOriginal && activeOriginal ? (
        <Text
          style={[styles.barOriginal, { fontSize: Math.round(subtitleFontSize * 0.78) }]}
          numberOfLines={2}
        >
          {activeOriginal}
        </Text>
      ) : null}

      {showTranslation && renderedLine ? (
        renderedLine.lines.map((line, idx) => (
          <Text
            key={idx}
            style={[styles.barTranslated, { color: subtitleColor, fontSize: subtitleFontSize }]}
            numberOfLines={1}
          >
            {line}
          </Text>
        ))
      ) : null}
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
    position:        "absolute",
    left:            0,
    right:           0,
    alignItems:      "center",
    paddingHorizontal: 12,
    gap:             3,
  },

  outlineOriginal: {
    color:            "#cccccc",
    fontWeight:       "600",
    textAlign:        "center",
    textShadowColor:  "#000",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 4,
  },
  outlineTranslated: {
    fontWeight:       "900",
    textAlign:        "center",
    letterSpacing:    -0.3,
    textShadowColor:  "#000",
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 8,
  },

  pillBox: {
    backgroundColor:  "rgba(0,0,0,0.65)",
    borderRadius:     4,
    paddingHorizontal: 10,
    paddingVertical:  6,
    maxWidth:         "92%",
    alignItems:       "center",
  },
  pillOriginal: {
    color:            "#aaaaaa",
    fontWeight:       "500",
    textAlign:        "center",
    textShadowColor:  "rgba(0,0,0,0.85)",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 3,
  },
  pillTranslated: {
    fontWeight:       "700",
    textAlign:        "center",
    textShadowColor:  "rgba(0,0,0,0.95)",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 5,
  },

  barContainer: {
    position:         "absolute",
    left:             0,
    right:            0,
    backgroundColor:  "rgba(0,0,0,0.75)",
    paddingHorizontal: 16,
    paddingVertical:  10,
    alignItems:       "center",
    gap:              2,
  },
  barOriginal: {
    color:      "#cccccc",
    fontWeight: "500",
    textAlign:  "center",
  },
  barTranslated: {
    fontWeight: "700",
    textAlign:  "center",
  },
});