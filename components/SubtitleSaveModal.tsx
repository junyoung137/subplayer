import React, { useEffect, useState, useCallback } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from "react-native";
import * as Sharing from "expo-sharing";
import {
  saveSubtitleFile,
  listSavedSubtitles,
  deleteSavedSubtitle,
  generateSrt,
  generateTxt,
  type SaveableSubtitle,
  type SaveMode,
} from "../services/subtitleSaveService";

// ── Props ─────────────────────────────────────────────────────────────────────

interface SubtitleSaveModalProps {
  visible:    boolean;
  onClose:    () => void;
  videoId:    string;
  videoTitle: string;
  subtitles: Array<{
    startTime:  number;
    endTime:    number;
    original:   string;
    translated: string;
  }>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Format = "srt" | "txt";
type Mode   = "original" | "translated" | "bilingual";

interface SavedFile {
  name:       string;
  uri:        string;
  size:       number;
  modifiedAt: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPreview(
  subtitles: SaveableSubtitle[],
  format: Format,
  mode: Mode,
): string {
  const sample = subtitles.slice(0, 3);
  if (sample.length === 0) return "(자막 없음)";
  return format === "srt"
    ? generateSrt(sample, mode)
    : generateTxt(sample, mode);
}

function estimatedSizeKb(
  subtitles: SaveableSubtitle[],
  format: Format,
  mode: Mode,
): string {
  const content =
    format === "srt"
      ? generateSrt(subtitles, mode)
      : generateTxt(subtitles, mode);
  const bytes = new TextEncoder().encode(content).length;
  return (bytes / 1024).toFixed(1);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SubtitleSaveModal({
  visible,
  onClose,
  videoId,
  videoTitle,
  subtitles,
}: SubtitleSaveModalProps) {
  const [format,     setFormat]     = useState<Format>("srt");
  const [mode,       setMode]       = useState<Mode>("bilingual");
  const [isSaving,   setIsSaving]   = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [savedFiles, setSavedFiles] = useState<SavedFile[]>([]);

  const subs: SaveableSubtitle[] = subtitles.map((s) => ({
    startTime:  s.startTime,
    endTime:    s.endTime,
    original:   s.original,
    translated: s.translated,
  }));

  // ── Load saved files when modal opens ────────────────────────────────────

  const loadSavedFiles = useCallback(async () => {
    const files = await listSavedSubtitles();
    setSavedFiles(files);
  }, []);

  useEffect(() => {
    if (visible) {
      loadSavedFiles();
      setSaveResult(null);
    }
  }, [visible, loadSavedFiles]);

  // ── Save handler ──────────────────────────────────────────────────────────

  const handleSave = async (saveMode: SaveMode = "share") => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveResult(null);

    const result = await saveSubtitleFile(subs, videoId, videoTitle, format, mode, saveMode);

    if (result.success) {
      const label = saveMode === "download" ? "✓ 다운로드 완료!" : "✓ 저장 완료!";
      setSaveResult(label);
      await loadSavedFiles();
      setTimeout(() => {
        setSaveResult(null);
        onClose();
      }, 2000);
    } else {
      setSaveResult(`오류: ${result.error ?? "알 수 없는 오류"}`);
    }

    setIsSaving(false);
  };

  // ── Delete handler ────────────────────────────────────────────────────────

  const handleDelete = (file: SavedFile) => {
    Alert.alert(
      "자막 파일 삭제",
      `"${file.name}"을(를) 삭제하시겠습니까?`,
      [
        { text: "취소", style: "cancel" },
        {
          text: "삭제",
          style: "destructive",
          onPress: async () => {
            await deleteSavedSubtitle(file.uri);
            await loadSavedFiles();
          },
        },
      ],
    );
  };

  // ── Re-share handler ──────────────────────────────────────────────────────

  const handleReshare = async (file: SavedFile) => {
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(file.uri, { dialogTitle: file.name });
    }
  };

  // ── Derived values ────────────────────────────────────────────────────────

  const preview  = buildPreview(subs, format, mode);
  const sizeKb   = estimatedSizeKb(subs, format, mode);
  const isMono   = format === "srt";

  const isSuccess = saveResult?.startsWith("✓") ?? false;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>

          {/* ── Header ─────────────────────────────────────────────────── */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>💾 자막 저장</Text>
            <TouchableOpacity onPress={onClose} hitSlop={HIT_SLOP}>
              <Text style={styles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >

            {/* ── Format selection ───────────────────────────────────── */}
            <Text style={styles.sectionLabel}>파일 형식</Text>
            <View style={styles.toggleRow}>
              <ToggleButton
                label="SRT"
                sublabel="영상 플레이어용"
                active={format === "srt"}
                onPress={() => setFormat("srt")}
              />
              <ToggleButton
                label="TXT"
                sublabel="텍스트 파일"
                active={format === "txt"}
                onPress={() => setFormat("txt")}
              />
            </View>

            {/* ── Content mode selection ─────────────────────────────── */}
            <Text style={styles.sectionLabel}>자막 내용</Text>
            <View style={styles.toggleRow}>
              <ToggleButton
                label="원문"
                sublabel="원어만"
                active={mode === "original"}
                onPress={() => setMode("original")}
              />
              <ToggleButton
                label="번역"
                sublabel="번역어만"
                active={mode === "translated"}
                onPress={() => setMode("translated")}
              />
              <ToggleButton
                label="이중"
                sublabel="원문+번역"
                active={mode === "bilingual"}
                onPress={() => setMode("bilingual")}
              />
            </View>

            {/* ── Preview ────────────────────────────────────────────── */}
            <Text style={styles.sectionLabel}>미리보기</Text>
            <ScrollView
              style={styles.previewBox}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              <Text style={[styles.previewText, isMono && styles.monoText]}>
                {preview}
              </Text>
            </ScrollView>

            {/* ── Info ───────────────────────────────────────────────── */}
            <View style={styles.infoRow}>
              <Text style={styles.infoText}>
                총 {subtitles.length}개 자막
              </Text>
              <Text style={styles.infoText}>
                예상 크기: {sizeKb} KB
              </Text>
            </View>

            {/* ── Save buttons ───────────────────────────────────────── */}
            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[styles.saveBtn, styles.saveBtnShare, isSaving && styles.saveBtnDisabled]}
                onPress={() => handleSave("share")}
                disabled={isSaving || subtitles.length === 0}
                activeOpacity={0.8}
              >
                {isSaving ? (
                  <View style={styles.saveBtnInner}>
                    <ActivityIndicator color="#fff" size="small" />
                    <Text style={styles.saveBtnText}>저장 중...</Text>
                  </View>
                ) : (
                  <Text style={styles.saveBtnText}>📤 공유</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.saveBtn, styles.saveBtnDownload, isSaving && styles.saveBtnDisabled]}
                onPress={() => handleSave("download")}
                disabled={isSaving || subtitles.length === 0}
                activeOpacity={0.8}
              >
                {isSaving ? (
                  <View style={styles.saveBtnInner}>
                    <ActivityIndicator color="#fff" size="small" />
                    <Text style={styles.saveBtnText}>저장 중...</Text>
                  </View>
                ) : (
                  <Text style={styles.saveBtnText}>💾 기기에 저장</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* ── Save result feedback ───────────────────────────────── */}
            {saveResult !== null && (
              <Text style={[styles.resultText, !isSuccess && styles.resultError]}>
                {saveResult}
              </Text>
            )}

            {/* ── Saved files list ───────────────────────────────────── */}
            {savedFiles.length > 0 && (
              <>
                <Text style={[styles.sectionLabel, styles.sectionLabelTop]}>
                  📁 저장된 자막 목록
                </Text>
                {savedFiles.map((file) => (
                  <View key={file.uri} style={styles.fileRow}>
                    <TouchableOpacity
                      style={styles.fileInfo}
                      onPress={() => handleReshare(file)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.fileName} numberOfLines={1}>
                        {file.name}
                      </Text>
                      <Text style={styles.fileMeta}>
                        {formatFileSize(file.size)}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleDelete(file)}
                      hitSlop={HIT_SLOP}
                      style={styles.deleteBtn}
                    >
                      <Text style={styles.deleteBtnText}>🗑</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </>
            )}

            {/* bottom padding */}
            <View style={styles.bottomPad} />

          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── Sub-component: ToggleButton ───────────────────────────────────────────────

interface ToggleButtonProps {
  label:    string;
  sublabel: string;
  active:   boolean;
  onPress:  () => void;
}

function ToggleButton({ label, sublabel, active, onPress }: ToggleButtonProps) {
  return (
    <TouchableOpacity
      style={[styles.toggleBtn, active && styles.toggleBtnActive]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Text style={[styles.toggleBtnLabel, active && styles.toggleBtnLabelActive]}>
        {label}
      </Text>
      <Text style={[styles.toggleBtnSub, active && styles.toggleBtnSubActive]}>
        {sublabel}
      </Text>
    </TouchableOpacity>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 } as const;

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Modal / sheet ──────────────────────────────────────────────────────────
  backdrop: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent:  "flex-end",
  },
  sheet: {
    backgroundColor: "#1a1a1a",
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    maxHeight:       "90%",
    paddingTop:      20,
    paddingHorizontal: 16,
  },

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
    marginBottom:   18,
  },
  headerTitle: {
    color:      "#fff",
    fontSize:   18,
    fontWeight: "700",
  },
  closeBtn: {
    color:    "#888",
    fontSize: 18,
    padding:  4,
  },

  // ── Section labels ─────────────────────────────────────────────────────────
  sectionLabel: {
    color:        "#aaa",
    fontSize:     12,
    fontWeight:   "600",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom:  8,
  },
  sectionLabelTop: {
    marginTop: 20,
  },

  // ── Toggle rows ────────────────────────────────────────────────────────────
  toggleRow: {
    flexDirection:  "row",
    gap:            8,
    marginBottom:   16,
  },
  toggleBtn: {
    flex:            1,
    backgroundColor: "#333",
    borderRadius:    10,
    paddingVertical: 10,
    alignItems:      "center",
    gap:             2,
  },
  toggleBtnActive: {
    backgroundColor: "#2563eb",
  },
  toggleBtnLabel: {
    color:      "#aaa",
    fontSize:   14,
    fontWeight: "700",
  },
  toggleBtnLabelActive: {
    color: "#fff",
  },
  toggleBtnSub: {
    color:    "#666",
    fontSize: 10,
  },
  toggleBtnSubActive: {
    color: "rgba(255,255,255,0.75)",
  },

  // ── Preview ────────────────────────────────────────────────────────────────
  previewBox: {
    backgroundColor: "#111",
    borderRadius:    8,
    padding:         10,
    maxHeight:       150,
    marginBottom:    12,
  },
  previewText: {
    color:      "#ccc",
    fontSize:   12,
    lineHeight: 18,
  },
  monoText: {
    fontFamily: "monospace",
  },

  // ── Info row ───────────────────────────────────────────────────────────────
  infoRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:   16,
  },
  infoText: {
    color:    "#666",
    fontSize: 12,
  },

  // ── Save buttons ───────────────────────────────────────────────────────────
  btnRow: {
    flexDirection: "row",
    gap:           8,
    marginBottom:  10,
  },
  saveBtn: {
    flex:            1,
    borderRadius:    12,
    paddingVertical: 14,
    alignItems:      "center",
  },
  saveBtnShare: {
    backgroundColor: "#2563eb",
  },
  saveBtnDownload: {
    backgroundColor: "#16a34a",
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnInner: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
  },
  saveBtnText: {
    color:      "#fff",
    fontSize:   15,
    fontWeight: "700",
  },

  // ── Result feedback ────────────────────────────────────────────────────────
  resultText: {
    color:      "#4ade80",
    fontSize:   14,
    fontWeight: "600",
    textAlign:  "center",
    marginBottom: 8,
  },
  resultError: {
    color: "#f87171",
  },

  // ── Saved files list ───────────────────────────────────────────────────────
  fileRow: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#252525",
    borderRadius:    8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom:    6,
  },
  fileInfo: {
    flex: 1,
    gap:  3,
  },
  fileName: {
    color:      "#ddd",
    fontSize:   13,
    fontWeight: "500",
  },
  fileMeta: {
    color:    "#666",
    fontSize: 11,
  },
  deleteBtn: {
    paddingLeft: 12,
  },
  deleteBtnText: {
    fontSize: 18,
  },

  // ── Bottom padding ─────────────────────────────────────────────────────────
  bottomPad: {
    height: 24,
  },
});
