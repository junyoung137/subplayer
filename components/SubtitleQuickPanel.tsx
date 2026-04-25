import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  StyleSheet,
} from "react-native";
import Slider from "@react-native-community/slider";
import { useSettingsStore } from "../store/useSettingsStore";
import { useTranslation } from "react-i18next";

const SUBTITLE_STYLE_KEYS = ["outline", "pill", "bar"] as const;
type SubtitleStyleKey = typeof SUBTITLE_STYLE_KEYS[number];

interface SubtitleQuickPanelProps {
  visible: boolean;
  onClose: () => void;
}

export function SubtitleQuickPanel({ visible, onClose }: SubtitleQuickPanelProps) {
  const subtitleStyle    = useSettingsStore((s) => s.subtitleStyle ?? "outline");
  const subtitleFontSize = useSettingsStore((s) => s.subtitleFontSize);
  const timingOffset     = useSettingsStore((s) => s.timingOffset);
  const update           = useSettingsStore((s) => s.update);

  const { t } = useTranslation();

  const SUBTITLE_STYLES: { key: SubtitleStyleKey; label: string; icon: string }[] = [
    { key: "outline", label: t("subtitlePanel.styleOutline"), icon: "T" },
    { key: "pill",    label: t("subtitlePanel.stylePill"),    icon: "T" },
    { key: "bar",     label: t("subtitlePanel.styleBar"),     icon: "T" },
  ];

  const offsetUnit = t("subtitlePanel.offsetUnit") ?? "s";
  const offsetLabel = timingOffset === 0
    ? t("subtitlePanel.offsetZero")
    : timingOffset > 0
      ? `+${timingOffset.toFixed(1)}${offsetUnit}`
      : `${timingOffset.toFixed(1)}${offsetUnit}`;

  const offsetColor = timingOffset === 0 ? "#60a5fa" : timingOffset > 0 ? "#34d399" : "#f87171";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>

          {/* 핸들 바 */}
          <View style={styles.handle} />

          <Text style={styles.title}>{t("subtitlePanel.title")}</Text>

          {/* 스타일 선택 카드 */}
          <View style={styles.styleRow}>
            {SUBTITLE_STYLES.map((s) => {
              const isActive = subtitleStyle === s.key;
              return (
                <TouchableOpacity
                  key={s.key}
                  style={[styles.styleCard, isActive && styles.styleCardActive]}
                  onPress={() => update({ subtitleStyle: s.key })}
                  activeOpacity={0.75}
                >
                  {/* 미리보기 영역 */}
                  <View style={styles.preview}>
                    {s.key === "outline" && (
                      <Text style={styles.prevOutline}>Sub</Text>
                    )}
                    {s.key === "pill" && (
                      <View style={styles.prevPillBox}>
                        <Text style={styles.prevPillText}>Sub</Text>
                      </View>
                    )}
                    {s.key === "bar" && (
                      <View style={styles.prevBarBox}>
                        <Text style={styles.prevBarText}>Sub</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.cardLabel, isActive && styles.cardLabelActive]}>
                    {s.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* 글자 크기 슬라이더 */}
          <View style={styles.sliderSection}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>{t("subtitlePanel.fontSize")}</Text>
              <Text style={styles.sliderValue}>{subtitleFontSize}px</Text>
            </View>
            <View style={styles.sliderRow}>
              <Text style={styles.sliderHint}>A</Text>
              <Slider
                style={styles.slider}
                minimumValue={10}
                maximumValue={25}
                step={1}
                value={subtitleFontSize}
                onValueChange={(v) => update({ subtitleFontSize: v })}
                minimumTrackTintColor="#2563eb"
                maximumTrackTintColor="#333"
                thumbTintColor="#fff"
              />
              <Text style={[styles.sliderHint, styles.sliderHintLg]}>A</Text>
            </View>
          </View>

          {/* 타이밍 오프셋 슬라이더 */}
          <View style={styles.sliderSection}>
            <View style={styles.sliderHeader}>
              <View>
                <Text style={styles.sliderLabel}>{t("subtitlePanel.timingOffset")}</Text>
                <Text style={styles.sliderSubLabel}>{t("subtitlePanel.timingOffsetHint")}</Text>
              </View>
              <Text style={[styles.sliderValue, { color: offsetColor }]}>{offsetLabel}</Text>
            </View>
            <View style={styles.sliderRow}>
              <Text style={styles.sliderHint}>-5</Text>
              <Slider
                style={styles.slider}
                minimumValue={-5}
                maximumValue={5}
                step={0.1}
                value={timingOffset}
                onValueChange={(v) => update({ timingOffset: Math.round(v * 10) / 10 })}
                minimumTrackTintColor="#f87171"
                maximumTrackTintColor="#333"
                thumbTintColor="#fff"
              />
              <Text style={styles.sliderHint}>+5</Text>
            </View>
            {timingOffset !== 0 && (
              <TouchableOpacity
                style={styles.resetBtn}
                onPress={() => update({ timingOffset: 0 })}
                activeOpacity={0.75}
              >
                <Text style={styles.resetBtnText}>{t("subtitlePanel.resetToZero")}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* 자막 편집 안내 */}
          <Text style={styles.editHint}>{t("subtitlePanel.editHint")}</Text>

          {/* 닫기 버튼 */}
          <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.75}>
            <Text style={styles.closeBtnText}>{t("subtitlePanel.close")}</Text>
          </TouchableOpacity>

        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#1a1a1a",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingBottom: 28,
    paddingTop: 10,
    gap: 16,
  },
  handle: {
    width: 38,
    height: 4,
    backgroundColor: "#444",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 4,
  },
  title: {
    color: "#aaa",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    textAlign: "center",
  },

  // ── 스타일 카드 ────────────────────────────────────────────────────────────
  styleRow: {
    flexDirection: "row",
    gap: 10,
  },
  styleCard: {
    flex: 1,
    backgroundColor: "#242424",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
    gap: 7,
    borderWidth: 1.5,
    borderColor: "#2e2e2e",
  },
  styleCardActive: {
    borderColor: "#2563eb",
    backgroundColor: "#0f1f3d",
  },
  preview: {
    width: "100%",
    height: 38,
    backgroundColor: "#3a3a3a",
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  prevOutline: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800",
    textShadowColor: "#000",
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 4,
  },
  prevPillBox: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  prevPillText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  prevBarBox: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.75)",
    paddingVertical: 4,
    alignItems: "center",
  },
  prevBarText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  cardLabel: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
  },
  cardLabelActive: {
    color: "#60a5fa",
  },

  // ── 슬라이더 ───────────────────────────────────────────────────────────────
  sliderSection: {
    gap: 6,
  },
  sliderHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sliderLabel: {
    color: "#ccc",
    fontSize: 13,
    fontWeight: "600",
  },
  sliderSubLabel: {
    color: "#555",
    fontSize: 11,
    marginTop: 2,
  },
  sliderValue: {
    color: "#60a5fa",
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  sliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  slider: { flex: 1 },
  sliderHint: {
    color: "#666",
    fontSize: 11,
    fontWeight: "700",
    width: 14,
    textAlign: "center",
  },
  sliderHintLg: {
    fontSize: 17,
  },

  // ── 초기화 버튼 ────────────────────────────────────────────────────────────
  resetBtn: {
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: "#2a2a2a",
    borderWidth: 1,
    borderColor: "#3a3a3a",
  },
  resetBtnText: {
    color: "#888",
    fontSize: 11,
    fontWeight: "600",
  },

  editHint: {
    color: "#555",
    fontSize: 11,
    textAlign: "center",
    marginTop: -4,
  },

  // ── 닫기 버튼 ──────────────────────────────────────────────────────────────
  closeBtn: {
    backgroundColor: "#222",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  closeBtnText: {
    color: "#aaa",
    fontSize: 14,
    fontWeight: "600",
  },
});