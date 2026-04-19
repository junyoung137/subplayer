import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  Modal,
  Pressable,
} from "react-native";
import Slider from "@react-native-community/slider";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../store/useSettingsStore";
import { LANGUAGES } from "../constants/languages";

export default function SettingsScreen() {
  const settings = useSettingsStore();
  const { update } = settings;
  const { t } = useTranslation();

  const [langDropdownVisible, setLangDropdownVisible] = useState(false);

  const subtitleStyles = [
    { key: "outline",  label: t("settings.outlineStyle"), desc: t("settings.outlineDesc") },
    { key: "pill",     label: t("settings.pillStyle"),    desc: t("settings.pillDesc")    },
    { key: "bar",      label: t("settings.barStyle"),     desc: t("settings.barDesc")     },
  ] as const;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

      {/* ── Interface language ──────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("settings.languageSection")}</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t("settings.displayLanguage")}</Text>
          <TouchableOpacity
            style={styles.dropdown}
            onPress={() => setLangDropdownVisible(true)}
          >
            <Text style={styles.dropdownText}>
              {LANGUAGES.find((l) => l.code === settings.interfaceLanguage)?.nativeName ?? "한국어"}
            </Text>
            <Text style={styles.dropdownArrow}>▾</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Audio chunk duration ─────────────────────────────────────────────── */}
      <Section title={t("settings.audioChunkDuration")}>
        <View style={styles.chipRow}>
          {([1, 2, 3] as const).map((n) => (
            <TouchableOpacity
              key={n}
              style={[styles.chip, settings.chunkDuration === n && styles.chipActive]}
              onPress={() => update({ chunkDuration: n })}
            >
              <Text style={[styles.chipText, settings.chunkDuration === n && styles.chipTextActive]}>
                {n}{t("settings.seconds")}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>

      {/* ── Subtitle appearance ──────────────────────────────────────────────── */}
      <Section title={t("settings.subtitleStyleSection")}>

        {/* Sub 스타일 종류 선택 */}
        <Text style={styles.subLabel}>{t("settings.subtitleDesign")}</Text>
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
                    <Text style={styles.previewOutline}>Sub</Text>
                  )}
                  {s.key === "pill" && (
                    <View style={styles.previewPillBox}>
                      <Text style={styles.previewPillText}>Sub</Text>
                    </View>
                  )}
                  {s.key === "bar" && (
                    <View style={styles.previewBarBox}>
                      <Text style={styles.previewBarText}>Sub</Text>
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

        <Row label={t("settings.fontSize", { size: settings.subtitleFontSize })}>
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

        <Row label={t("settings.opacity", { pct: Math.round(settings.subtitleOpacity * 100) })}>
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

        <View style={{ gap: 6 }}>
          <Text style={styles.subLabel}>{t("settings.subtitleMode")}</Text>
          {(["both", "translation", "original"] as const).map((mode) => (
            <TouchableOpacity
              key={mode}
              style={[styles.modeBtn, settings.subtitleMode === mode && styles.modeBtnActive]}
              onPress={() => update({ subtitleMode: mode })}
            >
              <Text style={[styles.modeBtnText, settings.subtitleMode === mode && styles.modeBtnTextActive]}>
                {mode === "both" ? t("settings.both") : mode === "translation" ? t("settings.translationOnly") : t("settings.originalOnly")}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>

      {/* ── Timing offset ────────────────────────────────────────────────────── */}
      <Section title={t("settings.timingOffset", { offset: settings.timingOffset })}>
        <Slider
          minimumValue={-5}
          maximumValue={0}
          step={0.1}
          value={settings.timingOffset}
          onValueChange={(v) => update({ timingOffset: Math.round(v * 10) / 10 })}
          minimumTrackTintColor="#2563eb"
          maximumTrackTintColor="#333"
        />
        <Text style={styles.hint}>{t("settings.timingOffsetHint")}</Text>
      </Section>

      {/* ── Support ─────────────────────────────────────────────────────────── */}
      <TouchableOpacity
        style={styles.supportBtn}
        onPress={() => router.push("/support")}
        activeOpacity={0.8}
      >
        <Text style={styles.supportBtnText}>{t("support.settingsBtn")}</Text>
      </TouchableOpacity>

      <Modal
        visible={langDropdownVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLangDropdownVisible(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setLangDropdownVisible(false)}
        >
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t("settings.selectDisplayLanguage")}</Text>
            <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled>
              {LANGUAGES.map((lang) => {
                const isActive = settings.interfaceLanguage === lang.code;
                return (
                  <TouchableOpacity
                    key={lang.code}
                    style={[styles.modalOption, isActive && styles.modalOptionActive]}
                    onPress={() => {
                      update({ interfaceLanguage: lang.code });
                      setLangDropdownVisible(false);
                    }}
                  >
                    <Text style={styles.modalOptionText}>{lang.nativeName}</Text>
                    <Text style={styles.modalOptionSub}>{lang.name}</Text>
                    {isActive && <Text style={styles.modalCheck}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

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
  content:   { padding: 16, gap: 8, paddingBottom: 40 },

  section: {
    backgroundColor: "#141414",
    borderRadius: 12,
    padding: 16,
    gap: 4,
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
    minHeight: 36,
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

  dropdown: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#222",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 8,
    borderWidth: 1,
    borderColor: "#333",
  },
  dropdownText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  dropdownArrow: { color: "#666", fontSize: 12 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  modalCard: {
    backgroundColor: "#1a1a1a",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  modalTitle: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 12,
  },
  modalOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a2a",
    gap: 8,
  },
  modalOptionActive: { backgroundColor: "#1e3a5f", borderRadius: 8 },
  modalOptionText: { color: "#fff", fontSize: 15, flex: 1 },
  modalOptionSub: { color: "#555", fontSize: 12 },
  modalCheck: { color: "#2563eb", fontSize: 14, fontWeight: "700" },

  supportBtn: {
    backgroundColor: "#141414",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    marginBottom: 12,
  },
  supportBtnText: { color: "#60a5fa", fontSize: 15, fontWeight: "600" },

  modeBtn:         { backgroundColor: "#222", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16, alignItems: "center" },
  modeBtnActive:   { backgroundColor: "#2563eb" },
  modeBtnText:     { color: "#aaa", fontSize: 14 },
  modeBtnTextActive: { color: "#fff", fontWeight: "600" },

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