import React, { useState, useEffect, useRef } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { usePlayerStore, SubtitleSegment } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";

interface SubtitleEditModalProps {
  segment: SubtitleSegment | null;
  onClose: () => void;
}

export function SubtitleEditModal({ segment, onClose }: SubtitleEditModalProps) {
  const updateSubtitle = usePlayerStore((s) => s.updateSubtitle);
  const subtitleMode   = useSettingsStore((s) => s.subtitleMode);

  const [editedOriginal,    setEditedOriginal]    = useState("");
  const [editedTranslated,  setEditedTranslated]  = useState("");
  const [activeTab,         setActiveTab]          = useState<"translated" | "original">("translated");

  const translatedRef = useRef<TextInput>(null);
  const originalRef   = useRef<TextInput>(null);

  // 모달이 열릴 때 현재 자막 내용으로 초기화
  useEffect(() => {
    if (segment) {
      setEditedOriginal(segment.original ?? "");
      setEditedTranslated(segment.translated ?? "");
      // 현재 subtitleMode에 맞는 탭을 기본 선택
      setActiveTab(subtitleMode === "original" ? "original" : "translated");
    }
  }, [segment?.id]);

  const handleSave = () => {
    if (!segment) return;
    updateSubtitle(segment.id, {
      original:   editedOriginal.trim(),
      translated: editedTranslated.trim(),
    });
    onClose();
  };

  const handleReset = () => {
    if (!segment) return;
    setEditedOriginal(segment.original ?? "");
    setEditedTranslated(segment.translated ?? "");
  };

  const hasChanges =
    segment &&
    (editedOriginal.trim()   !== (segment.original   ?? "") ||
     editedTranslated.trim() !== (segment.translated ?? ""));

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <Modal
      visible={!!segment}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}}>

            {/* 핸들 */}
            <View style={styles.handle} />

            {/* 헤더 */}
            <View style={styles.header}>
              <Text style={styles.headerTitle}>자막 수정</Text>
              {segment && (
                <Text style={styles.headerTime}>
                  {formatTime(segment.startTime)} → {formatTime(segment.endTime)}
                </Text>
              )}
            </View>

            {/* 탭 */}
            <View style={styles.tabRow}>
              <TouchableOpacity
                style={[styles.tab, activeTab === "translated" && styles.tabActive]}
                onPress={() => {
                  setActiveTab("translated");
                  setTimeout(() => translatedRef.current?.focus(), 50);
                }}
              >
                <Text style={[styles.tabText, activeTab === "translated" && styles.tabTextActive]}>
                  번역문
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tab, activeTab === "original" && styles.tabActive]}
                onPress={() => {
                  setActiveTab("original");
                  setTimeout(() => originalRef.current?.focus(), 50);
                }}
              >
                <Text style={[styles.tabText, activeTab === "original" && styles.tabTextActive]}>
                  원문
                </Text>
              </TouchableOpacity>
            </View>

            {/* 입력 영역 */}
            <View style={styles.inputSection}>
              {activeTab === "translated" ? (
                <>
                  <Text style={styles.inputLabel}>번역문 수정</Text>
                  <TextInput
                    ref={translatedRef}
                    style={styles.textInput}
                    value={editedTranslated}
                    onChangeText={setEditedTranslated}
                    multiline
                    autoFocus
                    placeholder="번역문을 입력하세요"
                    placeholderTextColor="#555"
                    selectionColor="#2563eb"
                  />
                  {/* 원문 참고 표시 */}
                  {editedOriginal.length > 0 && (
                    <View style={styles.referenceBox}>
                      <Text style={styles.referenceLabel}>원문 참고</Text>
                      <Text style={styles.referenceText}>{editedOriginal}</Text>
                    </View>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.inputLabel}>원문 수정</Text>
                  <TextInput
                    ref={originalRef}
                    style={styles.textInput}
                    value={editedOriginal}
                    onChangeText={setEditedOriginal}
                    multiline
                    autoFocus
                    placeholder="원문을 입력하세요"
                    placeholderTextColor="#555"
                    selectionColor="#2563eb"
                  />
                  {/* 번역문 참고 표시 */}
                  {editedTranslated.length > 0 && (
                    <View style={styles.referenceBox}>
                      <Text style={styles.referenceLabel}>번역문 참고</Text>
                      <Text style={styles.referenceText}>{editedTranslated}</Text>
                    </View>
                  )}
                </>
              )}
            </View>

            {/* 버튼 영역 */}
            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[styles.btn, styles.btnReset, !hasChanges && styles.btnDisabled]}
                onPress={handleReset}
                disabled={!hasChanges}
                activeOpacity={0.75}
              >
                <Text style={styles.btnResetText}>되돌리기</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.btn}
                onPress={onClose}
                activeOpacity={0.75}
              >
                <Text style={styles.btnCancelText}>취소</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.btn, styles.btnSave]}
                onPress={handleSave}
                activeOpacity={0.75}
              >
                <Text style={styles.btnSaveText}>저장</Text>
              </TouchableOpacity>
            </View>

          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#1a1a1a",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingBottom: 32,
    paddingTop: 10,
    gap: 14,
  },
  handle: {
    width: 38,
    height: 4,
    backgroundColor: "#444",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 2,
  },

  // ── 헤더 ─────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  headerTime: {
    color: "#555",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },

  // ── 탭 ───────────────────────────────────────────────────────────────────
  tabRow: {
    flexDirection: "row",
    backgroundColor: "#111",
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  tabActive: {
    backgroundColor: "#2563eb",
  },
  tabText: {
    color: "#666",
    fontSize: 13,
    fontWeight: "600",
  },
  tabTextActive: {
    color: "#fff",
  },

  // ── 입력 ─────────────────────────────────────────────────────────────────
  inputSection: {
    gap: 8,
  },
  inputLabel: {
    color: "#888",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  textInput: {
    backgroundColor: "#111",
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#2563eb",
    color: "#fff",
    fontSize: 16,
    lineHeight: 24,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 80,
    textAlignVertical: "top",
  },
  referenceBox: {
    backgroundColor: "#111",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2a2a2a",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 3,
  },
  referenceLabel: {
    color: "#555",
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  referenceText: {
    color: "#666",
    fontSize: 13,
    lineHeight: 20,
  },

  // ── 버튼 ─────────────────────────────────────────────────────────────────
  btnRow: {
    flexDirection: "row",
    gap: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: "#222",
    alignItems: "center",
  },
  btnReset: {
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#333",
    flex: 0.8,
  },
  btnDisabled: {
    opacity: 0.3,
  },
  btnSave: {
    backgroundColor: "#2563eb",
  },
  btnResetText: { color: "#888",  fontSize: 13, fontWeight: "600" },
  btnCancelText: { color: "#aaa", fontSize: 13, fontWeight: "600" },
  btnSaveText:   { color: "#fff", fontSize: 13, fontWeight: "700" },
});