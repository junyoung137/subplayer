import React, { useEffect, useState } from "react";
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
import { getModelMeta } from "../services/modelDownloadService";
import type { ModelMeta } from "../services/modelDownloadService";

export default function SettingsScreen() {
  const settings = useSettingsStore();
  const { update } = settings;

  const [gemmaMeta, setGemmaMeta] = useState<ModelMeta | null | undefined>(undefined);

  // Check whether Gemma model is downloaded
  useEffect(() => {
    getModelMeta().then(setGemmaMeta);
  }, []);

  const whisperModels = ["tiny", "small", "medium", "large-v3"] as const;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── Gemma model status ──────────────────────────────────────────────── */}
      <Section title="번역 모델 (Gemma 3n E2B)">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>Gemma 3n E2B</Text>
            {gemmaMeta === undefined ? (
              <Text style={styles.hint}>확인 중…</Text>
            ) : gemmaMeta ? (
              <Text style={[styles.hint, styles.hintOk]}>
                다운로드됨 ✓  ({(gemmaMeta.size / 1e9).toFixed(1)} GB)
              </Text>
            ) : (
              <Text style={[styles.hint, styles.hintWarn]}>미다운로드 ⚠️</Text>
            )}
          </View>
          <TouchableOpacity
            style={styles.manageBtn}
            onPress={() => router.push("/gemmaModels")}
          >
            <Text style={styles.manageBtnText}>모델 관리</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>발열 보호 모드</Text>
          <Switch
            value={settings.thermalProtection}
            onValueChange={(v) => update({ thermalProtection: v })}
            trackColor={{ true: "#2563eb" }}
          />
        </View>

        <Text style={styles.infoText}>번역은 완전히 오프라인으로 처리됩니다.</Text>
      </Section>

      {/* ── Whisper model ───────────────────────────────────────────────────── */}
      <Section title="Whisper 음성 인식 모델">
        <View style={styles.chipRow}>
          {whisperModels.map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.chip, settings.whisperModel === m && styles.chipActive]}
              onPress={() => update({ whisperModel: m })}
            >
              <Text style={[styles.chipText, settings.whisperModel === m && styles.chipTextActive]}>
                {m}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>

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
