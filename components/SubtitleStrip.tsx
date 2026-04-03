import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { usePlayerStore, SubtitleSegment } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";

/**
 * Binary search that returns the *index* of the active subtitle, or -1.
 */
function findActiveIndex(subtitles: SubtitleSegment[], currentTime: number): number {
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
      return mid;
    }
  }
  // Between subtitles — return the index of the next upcoming one (or -1).
  // This ensures the "next" slot is filled even during gaps.
  if (lo < subtitles.length) return -(lo + 1); // encode "gap before lo" as negative
  return -1;
}

export function SubtitleStrip() {
  const subtitles   = usePlayerStore((s) => s.subtitles);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const subtitleMode = useSettingsStore((s) => s.subtitleMode);

  if (subtitles.length === 0) return null;

  const raw = findActiveIndex(subtitles, currentTime);

  let activeIdx: number;
  let inGap: boolean;

  if (raw >= 0) {
    activeIdx = raw;
    inGap = false;
  } else if (raw === -1) {
    // Past the last subtitle
    activeIdx = subtitles.length; // no active, no next
    inGap = true;
  } else {
    // In a gap: upcoming subtitle is at index (-raw - 1)
    activeIdx = -raw - 1;
    inGap = true;
  }

  const prev    = inGap ? subtitles[activeIdx - 1] ?? null : subtitles[activeIdx - 1] ?? null;
  const current = inGap ? null : subtitles[activeIdx] ?? null;
  const next    = inGap ? subtitles[activeIdx] ?? null : subtitles[activeIdx + 1] ?? null;

  function getLabel(seg: SubtitleSegment): string {
    if (subtitleMode === "original")    return seg.original;
    if (subtitleMode === "translation") return seg.translated || seg.original;
    // "both" — show translated as primary in the strip
    return seg.translated || seg.original;
  }

  return (
    <View style={styles.strip}>
      {/* Previous */}
      <Text style={styles.adjacent} numberOfLines={1}>
        {prev ? getLabel(prev) : ""}
      </Text>

      {/* Current */}
      <View style={styles.currentRow}>
        <Text style={styles.current} numberOfLines={2}>
          {current ? getLabel(current) : ""}
        </Text>
      </View>

      {/* Next */}
      <Text style={styles.adjacent} numberOfLines={1}>
        {next ? getLabel(next) : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    backgroundColor: "#0d0d0d",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "#222",
    gap: 4,
  },
  adjacent: {
    color: "#555",
    fontSize: 11,
    textAlign: "center",
    fontStyle: "italic",
  },
  currentRow: {
    minHeight: 36,
    justifyContent: "center",
  },
  current: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 20,
  },
});
