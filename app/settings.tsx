import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
} from "react-native";
import Slider from "@react-native-community/slider";
import { router } from "expo-router";
import { useSettingsStore } from "../store/useSettingsStore";

export default function SettingsScreen() {
  const settings = useSettingsStore();
  const { update } = settings;

  const subtitleStyles = [
    { key: "outline",  label: "외곽선형",   desc: "갈매기 스타일"   },
    { key: "pill",     label: "박스형",     desc: "현재 스타일"     },
    { key: "bar",      label: "바형",       desc: "넷플릭스 스타일" },
  ] as const;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── Audio chunk duration ─────────────────────────────────────────────── */}
      <Section title="오디오 청크 길이">
        <View style={styles.chipRow}>
          {([1, 2, 3] as const).map((n) => (
            <TouchableOpacity
              key={n}
              style={[styles.chip, settings.chunkDuration === n && styles.chipActive]}
              onPress={() => update({ chunkDuration: n })}
            >
              <Text style={[styles.chipText, settings.chunkDuration === n && styles.chipTextActive]}>
                {n}초
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>

      {/* ── Subtitle appearance ──────────────────────────────────────────────── */}
      <Section title="자막 스타일">

        {/* 자막 스타일 종류 선택 */}
        <Text style={styles.subLabel}>자막 디자인</Text>
        <View style={styles.styleCardRow}>
          {subtitleStyles.map((s) => {
            const isActive = settings.subtitleStyle === s.key;
            return (
              <TouchableOpacity
                key={s.key}
                style={[styles.styleCard, isActive && styles.styleCardActive]}
                onPress={() => update({ subtitleStyle: s.key })}
                activeOpacity={0.75}
              >
                {/* 미리보기 */}
                <View style={styles.stylePreview}>
                  {s.key === "outline" && (
                    <Text style={styles.previewOutline}>자막</Text>
                  )}
                  {s.key === "pill" && (
                    <View style={styles.previewPillBox}>
                      <Text style={styles.previewPillText}>자막</Text>
                    </View>
                  )}
                  {s.key === "bar" && (
                    <View style={styles.previewBarBox}>
                      <Text style={styles.previewBarText}>자막</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.styleCardLabel, isActive && styles.styleCardLabelActive]}>
                  {s.label}
                </Text>
                <Text style={styles.styleCardDesc}>{s.desc}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Row label={`글자 크기: ${settings.subtitleFontSize}px`}>
          <Slider
            style={{ flex: 1 }}
            minimumValue={12}
            maximumValue={36}
            step={1}
            value={settings.subtitleFontSize}
            onValueChange={(v) => update({ subtitleFontSize: v })}
            minimumTrackTintColor="#2563eb"
            maximumTrackTintColor="#333"
          />
        </Row>

        <Row label={`불투명도: ${Math.round(settings.subtitleOpacity * 100)}%`}>
          <Slider
            style={{ flex: 1 }}
            minimumValue={0.3}
            maximumValue={1.0}
            step={0.05}
            value={settings.subtitleOpacity}
            onValueChange={(v) => update({ subtitleOpacity: v })}
            minimumTrackTintColor="#2563eb"
            maximumTrackTintColor="#333"
          />
        </Row>

        <Row label="원문 표시">
          <Switch
            value={settings.showOriginal}
            onValueChange={(v) => update({ showOriginal: v })}
            trackColor={{ true: "#2563eb" }}
          />
        </Row>

        <Row label="자막 모드">
          <View style={styles.chipRow}>
            {(["both", "translation", "original"] as const).map((mode) => (
              <TouchableOpacity
                key={mode}
                style={[styles.chip, settings.subtitleMode === mode && styles.chipActive]}
                onPress={() => update({ subtitleMode: mode })}
              >
                <Text style={[styles.chipText, settings.subtitleMode === mode && styles.chipTextActive]}>
                  {mode === "both" ? "둘 다" : mode === "translation" ? "번역만" : "원문만"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Row>
      </Section>

      {/* ── Timing offset ────────────────────────────────────────────────────── */}
      <Section title={`타이밍 오프셋: ${settings.timingOffset}초`}>
        <Slider
          minimumValue={-5}
          maximumValue={0}
          step={0.1}
          value={settings.timingOffset}
          onValueChange={(v) => update({ timingOffset: Math.round(v * 10) / 10 })}
          minimumTrackTintColor="#2563eb"
          maximumTrackTintColor="#333"
        />
        <Text style={styles.hint}>STT 처리 지연을 보정합니다 (기본: -1.5초)</Text>
      </Section>

    </ScrollView>
  );
}

// ── Layout helpers ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content:   { padding: 16, gap: 8 },

  section: {
    backgroundColor: "#141414",
    borderRadius: 12,
    padding: 16,
    gap: 12,
    marginBottom: 12,
  },
  sectionTitle: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  subLabel: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  rowLabel: { color: "#ccc", fontSize: 14, minWidth: 100, flexShrink: 1 },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: "#222",
  },
  chipActive:     { backgroundColor: "#2563eb" },
  chipText:       { color: "#aaa", fontSize: 13 },
  chipTextActive: { color: "#fff", fontWeight: "600" },

  // ── 스타일 카드 ──────────────────────────────────────────────────────────
  styleCardRow: {
    flexDirection: "row",
    gap: 8,
  },
  styleCard: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
    gap: 6,
    borderWidth: 1.5,
    borderColor: "#2a2a2a",
  },
  styleCardActive: {
    borderColor: "#2563eb",
    backgroundColor: "#0f1f3d",
  },
  stylePreview: {
    width: "100%",
    height: 40,
    backgroundColor: "#333",
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  // outline 미리보기
  previewOutline: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
    textShadowColor: "rgba(0,0,0,1)",
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 4,
  },
  // pill 미리보기
  previewPillBox: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  previewPillText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  // bar 미리보기
  previewBarBox: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.75)",
    paddingVertical: 4,
    alignItems: "center",
  },
  previewBarText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },

  styleCardLabel: {
    color: "#aaa",
    fontSize: 12,
    fontWeight: "600",
  },
  styleCardLabelActive: {
    color: "#60a5fa",
  },
  styleCardDesc: {
    color: "#555",
    fontSize: 10,
    textAlign: "center",
  },

  manageBtn: {
    backgroundColor: "#1e3a5f",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#2563eb",
  },
  manageBtnText: { color: "#93c5fd", fontSize: 13, fontWeight: "600" },

  hint:     { color: "#555", fontSize: 11, marginTop: 2 },
  hintOk:   { color: "#22c55e" },
  hintWarn: { color: "#f59e0b" },

  infoText: {
    color: "#4b5563",
    fontSize: 12,
    textAlign: "center",
    marginTop: 4,
  },
});