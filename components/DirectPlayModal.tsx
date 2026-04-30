/**
 * DirectPlayModal — 바로보기 모드
 * 번역 프로세스 없이 로컬/URL 영상을 바로 플레이어로 전송
 * 자막 파일(SRT) 선택 옵션 포함 (로컬 + URL 탭 모두)
 */
import React, { useState, useCallback } from "react";
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  StyleSheet, Pressable, Alert, ActivityIndicator,
  ScrollView, KeyboardAvoidingView, Platform,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { parseYoutubeId } from "../utils/youtubeUtils";
import { FolderOpen, X, Check, Play } from "lucide-react-native";

async function ensureStableFileUri(uri: string, filename: string): Promise<string | null> {
  const cacheDir = FileSystem.cacheDirectory ?? "";
  const docDir   = FileSystem.documentDirectory ?? "";
  const isStable =
    (cacheDir && uri.startsWith(cacheDir) && !uri.includes("/DocumentPicker/")) ||
    (docDir   && uri.startsWith(docDir));
  if (isStable) return uri;
  try {
    const videosDir = cacheDir + "videos/";
    await FileSystem.makeDirectoryAsync(videosDir, { intermediates: true });
    const safeName = Date.now() + "_" + filename.replace(/[^a-zA-Z0-9._\-]/g, "_");
    const dest = videosDir + safeName;
    await FileSystem.copyAsync({ from: uri, to: dest });
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) throw new Error("Copy failed: " + dest);
    return dest;
  } catch (e) {
    console.error("[FILE] Copy failed:", e);
    return null;
  }
}

interface DirectPlayModalProps {
  visible: boolean;
  onClose: () => void;
  onLocalFilePicked: (uri: string, name: string, subtitleUri?: string) => void;
  onUrlPicked: (videoId: string, title: string, subtitleUri?: string) => void;
}

type Tab = "local" | "url";

export function DirectPlayModal({
  visible, onClose, onLocalFilePicked, onUrlPicked,
}: DirectPlayModalProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [activeTab,    setActiveTab]    = useState<Tab>("local");
  const [urlInput,     setUrlInput]     = useState("");
  const [isLoading,    setIsLoading]    = useState(false);
  const [urlError,     setUrlError]     = useState<string | null>(null);
  const [subtitleUri,  setSubtitleUri]  = useState<string | null>(null);
  const [subtitleName, setSubtitleName] = useState<string | null>(null);

  const parsedId = parseYoutubeId(urlInput.trim());

  const resetState = () => {
    setUrlInput("");
    setUrlError(null);
    setActiveTab("local");
    setSubtitleUri(null);
    setSubtitleName(null);
  };

  const handleClose = () => { resetState(); onClose(); };

  // 자막 파일 선택 (로컬 + URL 탭 공통)
  const pickSubtitleFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/x-subrip", "text/plain", "*/*"],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      if (!file.name.toLowerCase().endsWith(".srt")) {
        Alert.alert("지원하지 않는 형식", ".srt 파일만 지원합니다.");
        return;
      }
      setSubtitleUri(file.uri);
      setSubtitleName(file.name);
    } catch (e) {
      Alert.alert(t("url.error"), String(e));
    }
  };

  // 자막 UI (재사용 컴포넌트)
  const SubtitlePicker = () => (
    <View style={{ gap: 6 }}>
      <Text style={styles.inputLabel}>{t("url.subtitleFileLabel")}</Text>
      {subtitleUri ? (
        <View style={styles.subtitleSelected}>
          <Text style={styles.subtitleSelectedText} numberOfLines={1}>
            ✓ {subtitleName}
          </Text>
          <TouchableOpacity onPress={() => { setSubtitleUri(null); setSubtitleName(null); }}>
            <X size={16} color="#86efac" />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.subtitleEmpty} onPress={pickSubtitleFile} activeOpacity={0.75}>
          <Text style={styles.subtitleEmptyText}>{t("url.subtitleFilePlaceholder")}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // 로컬 파일 선택
  const pickLocalFile = useCallback(async () => {
    try {
      setIsLoading(true);
      const result = await DocumentPicker.getDocumentAsync({
        type: ["video/*"],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      const stableUri = await ensureStableFileUri(file.uri, file.name);
      if (!stableUri) { Alert.alert(t("url.error"), t("url.fileCopyError")); return; }
      handleClose();
      onLocalFilePicked(stableUri, file.name, subtitleUri ?? undefined);
    } catch (e) {
      Alert.alert(t("url.error"), t("url.fileOpenError") + String(e));
    } finally {
      setIsLoading(false);
    }
  }, [onLocalFilePicked, subtitleUri, t]);

  // URL 확인
  const confirmUrl = useCallback(() => {
    setUrlError(null);
    const trimmed = urlInput.trim();
    if (!trimmed) { setUrlError(t("url.urlRequired")); return; }
    const ytId = parseYoutubeId(trimmed);
    if (ytId) {
      handleClose();
      onUrlPicked(ytId, `YouTube: ${ytId}`, subtitleUri ?? undefined);
      return;
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      setUrlError(t("url.generalUrlNotSupported"));
      return;
    }
    setUrlError(t("url.invalidUrl"));
  }, [urlInput, subtitleUri, onUrlPicked, t]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.kavWrapper}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <Pressable style={styles.backdropFlex} onPress={handleClose} />

        <Pressable
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom + 16, 40) }]}
          onPress={() => {}}
        >
          <View style={styles.handle} />

          {/* 헤더 */}
          <View style={styles.headerRow}>
            <View style={styles.modeBadge}>
              <Play size={12} color="#a78bfa" />
              <Text style={styles.modeBadgeText}>바로보기 모드</Text>
            </View>
            <Text style={styles.title}>동영상 불러오기</Text>
            <Text style={styles.modeDesc}>번역 없이 즉시 재생</Text>
          </View>

          {/* 탭 */}
          <View style={styles.tabRow}>
            <TouchableOpacity
              style={[styles.tab, activeTab === "local" && styles.tabActive]}
              onPress={() => setActiveTab("local")}
            >
              <Text style={[styles.tabText, activeTab === "local" && styles.tabTextActive]}>
                {t("url.localFile")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, activeTab === "url" && styles.tabActive]}
              onPress={() => setActiveTab("url")}
            >
              <Text style={[styles.tabText, activeTab === "url" && styles.tabTextActive]}>
                {t("url.urlYoutube")}
              </Text>
            </TouchableOpacity>
          </View>

          {/* ── 로컬 탭 ─────────────────────────────────────────────── */}
          {activeTab === "local" && (
            <View style={styles.tabContent}>
              {/* 자막 파일 선택 */}
              <SubtitlePicker />

              {/* 파일 선택 버튼 */}
              <TouchableOpacity
                style={styles.bigPickBtn}
                onPress={pickLocalFile}
                disabled={isLoading}
                activeOpacity={0.8}
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <FolderOpen size={20} color="#a78bfa" />
                    <Text style={styles.bigPickText}>{t("url.selectFile")}</Text>
                    <Text style={styles.bigPickSub}>{t("url.supportedFormats")}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* ── URL 탭 ──────────────────────────────────────────────── */}
          {activeTab === "url" && (
            <View style={styles.tabContent}>
              {/* 자막 파일 선택 */}
              <SubtitlePicker />

              {/* URL 입력 */}
              <View style={styles.inputWrap}>
                <Text style={styles.inputLabel}>{t("url.youtubeUrlLabel")}</Text>
                <View style={[
                  styles.inputRow,
                  parsedId && urlInput.length > 0 ? styles.inputRowValid : undefined,
                  urlError ? styles.inputRowError : undefined,
                ]}>
                  <TextInput
                    style={styles.input}
                    value={urlInput}
                    onChangeText={(v) => { setUrlInput(v); setUrlError(null); }}
                    placeholder="https://youtube.com/watch?v=..."
                    placeholderTextColor="#444"
                    autoCorrect={false}
                    autoCapitalize="none"
                    selectionColor="#7c3aed"
                    returnKeyType="go"
                    onSubmitEditing={confirmUrl}
                  />
                  {urlInput.length > 0 && (
                    <TouchableOpacity style={styles.clearBtn} onPress={() => { setUrlInput(""); setUrlError(null); }}>
                      <X size={16} color="#888" />
                    </TouchableOpacity>
                  )}
                </View>
                {parsedId && urlInput.length > 0 && (
                  <View style={styles.parsedRow}>
                    <Check size={16} color="#22c55e" />
                    <Text style={styles.parsedText}>{t("url.idDetected", { id: parsedId })}</Text>
                  </View>
                )}
                {urlError && <Text style={styles.errorText}>{urlError}</Text>}
              </View>

              <TouchableOpacity
                style={[styles.confirmBtn, !urlInput.trim() && styles.confirmBtnDisabled]}
                onPress={confirmUrl}
                disabled={!urlInput.trim()}
              >
                <Text style={styles.confirmBtnText}>{t("url.play")}</Text>
              </TouchableOpacity>
            </View>
          )}
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  kavWrapper: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "flex-end",
  },
  backdropFlex: { flex: 1 },
  sheet: {
    backgroundColor: "#111",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 14,
  },
  handle: {
    width: 40, height: 4,
    backgroundColor: "#333",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 4,
  },
  headerRow: { alignItems: "center", gap: 4 },
  modeBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "#2d1b69",
    borderRadius: 20, borderWidth: 1, borderColor: "#7c3aed",
    paddingHorizontal: 10, paddingVertical: 4,
  },
  modeBadgeText: { color: "#a78bfa", fontSize: 11, fontWeight: "700" },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  modeDesc: { color: "#555", fontSize: 12 },

  tabRow: {
    flexDirection: "row",
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 3,
    gap: 3,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: "center" },
  tabActive: { backgroundColor: "#7c3aed" },   // 보라색 — 번역모드와 구분
  tabText:       { color: "#555", fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#fff" },

  tabContent: { gap: 12 },

  subtitleSelected: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#14532d", borderRadius: 10,
    borderWidth: 1, borderColor: "#22c55e",
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
  },
  subtitleSelectedText: { color: "#86efac", fontSize: 13, flex: 1 },
  subtitleEmpty: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#1a1a1a", borderRadius: 10,
    borderWidth: 1, borderColor: "#2a2a2a", borderStyle: "dashed",
    paddingHorizontal: 12, paddingVertical: 10,
  },
  subtitleEmptyText: { color: "#555", fontSize: 13 },

  bigPickBtn: {
    backgroundColor: "#1e1e1e",
    borderRadius: 16, paddingVertical: 28,
    alignItems: "center",
    borderWidth: 1.5, borderColor: "#7c3aed55",
    borderStyle: "dashed", gap: 6,
  },
  bigPickText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  bigPickSub:  { color: "#555", fontSize: 12 },

  inputWrap:  { gap: 6 },
  inputLabel: { color: "#666", fontSize: 12, fontWeight: "600" },
  inputRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#1a1a1a", borderRadius: 12,
    borderWidth: 1.5, borderColor: "#7c3aed",
    paddingHorizontal: 12, gap: 8,
  },
  inputRowValid: { borderColor: "#22c55e" },
  inputRowError: { borderColor: "#ef4444" },
  input: { flex: 1, color: "#fff", fontSize: 13, paddingVertical: 12 },
  clearBtn: { padding: 4 },

  parsedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  parsedText: { color: "#22c55e", fontSize: 12, fontWeight: "600" },
  errorText:  { color: "#ef4444", fontSize: 12, lineHeight: 18 },

  confirmBtn: {
    backgroundColor: "#7c3aed",   // 보라색 버튼
    borderRadius: 12, paddingVertical: 14, alignItems: "center",
  },
  confirmBtnDisabled: { opacity: 0.35 },
  confirmBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});