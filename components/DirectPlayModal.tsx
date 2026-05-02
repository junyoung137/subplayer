/**
 * DirectPlayModal — 바로보기 모드
 * 번역 프로세스 없이 로컬/URL 영상을 바로 플레이어로 전송
 * 자막 파일(SRT) 선택 옵션 포함 (로컬 + URL 탭 모두)
 * [UPDATE] 비디오 장르 선택 추가 (로컬 + URL 탭 모두)
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
  onLocalFilePicked: (uri: string, name: string, genre: string, subtitleUri?: string) => void;
  onUrlPicked: (videoId: string, title: string, genre: string, subtitleUri?: string) => void;
}

type Tab = "local" | "url";

export function DirectPlayModal({
  visible, onClose, onLocalFilePicked, onUrlPicked,
}: DirectPlayModalProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const GENRE_OPTIONS = [
    { key: "general",      label: t("genre.general") },
    { key: "tech lecture", label: t("genre.techLecture") },
    { key: "comedy",       label: t("genre.comedy") },
    { key: "news",         label: t("genre.news") },
    { key: "documentary",  label: t("genre.documentary") },
    { key: "gaming",       label: t("genre.gaming") },
    { key: "education",    label: t("genre.education") },
  ];

  const [activeTab,     setActiveTab]     = useState<Tab>("local");
  const [urlInput,      setUrlInput]      = useState("");
  const [isLoading,     setIsLoading]     = useState(false);
  const [urlError,      setUrlError]      = useState<string | null>(null);
  const [selectedGenre, setSelectedGenre] = useState("general");
  const [subtitleUri,   setSubtitleUri]   = useState<string | null>(null);
  const [subtitleName,  setSubtitleName]  = useState<string | null>(null);

  const parsedId = parseYoutubeId(urlInput.trim());

  const resetState = () => {
    setUrlInput("");
    setUrlError(null);
    setActiveTab("local");
    setSelectedGenre("general");
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
        Alert.alert(
          t("url.subtitleUnsupportedTitle"),
          t("url.subtitleUnsupportedMsg")
        );
        return;
      }
      setSubtitleUri(file.uri);
      setSubtitleName(file.name);
    } catch (e) {
      Alert.alert(t("url.error"), String(e));
    }
  };

  // 장르 선택 UI (로컬 + URL 탭 공통)
  const GenrePicker = () => (
    <View style={styles.genreSection}>
      <Text style={styles.genreLabel}>{t("genre.sectionTitle")}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.genreRow}
        keyboardShouldPersistTaps="handled"
      >
        {GENRE_OPTIONS.map((g) => (
          <TouchableOpacity
            key={g.key}
            style={[styles.genrePill, selectedGenre === g.key && styles.genrePillActive]}
            onPress={() => setSelectedGenre(g.key)}
          >
            <Text style={[styles.genrePillText, selectedGenre === g.key && styles.genrePillTextActive]}>
              {g.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  // 자막 UI (로컬 + URL 탭 공통)
  const SubtitlePicker = () => (
    <View style={{ gap: 6 }}>
      <Text style={styles.inputLabel}>{t("url.subtitleFileLabel")}</Text>
      {subtitleUri ? (
        <View style={styles.subtitleSelected}>
          <Text style={styles.subtitleSelectedText} numberOfLines={1}>
            ✓ {subtitleName}
          </Text>
          <TouchableOpacity onPress={() => { setSubtitleUri(null); setSubtitleName(null); }}>
            <X size={16} color="#6aab8a" />
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
      if (!stableUri) { 
        Alert.alert(t("url.error"), t("url.fileCopyError")); 
        return; 
      }
      handleClose();
      onLocalFilePicked(stableUri, file.name, selectedGenre, subtitleUri ?? undefined);
    } catch (e) {
      Alert.alert(t("url.error"), t("url.fileOpenError") + String(e));
    } finally {
      setIsLoading(false);
    }
  }, [onLocalFilePicked, selectedGenre, subtitleUri, t]);

  // URL 확인
  const confirmUrl = useCallback(() => {
    setUrlError(null);
    const trimmed = urlInput.trim();
    if (!trimmed) { 
      setUrlError(t("url.urlRequired")); 
      return; 
    }
    const ytId = parseYoutubeId(trimmed);
    if (ytId) {
      const genreSnapshot = selectedGenre;
      handleClose();
      onUrlPicked(ytId, `YouTube: ${ytId}`, genreSnapshot, subtitleUri ?? undefined);
      return;
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      setUrlError(t("url.generalUrlNotSupported"));
      return;
    }
    setUrlError(t("url.invalidUrl"));
  }, [urlInput, selectedGenre, subtitleUri, onUrlPicked, t]);

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
              <Play size={12} color="#8b7bc0" />
              <Text style={styles.modeBadgeText}>{t("url.directModeBadge")}</Text>
            </View>
            <Text style={styles.title}>{t("url.directModeTitle")}</Text>
            <Text style={styles.modeDesc}>{t("url.directModeDesc")}</Text>
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
              <GenrePicker />
              <SubtitlePicker />

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
                    <FolderOpen size={20} color="#8b7bc0" />
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
              <GenrePicker />
              <SubtitlePicker />

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
                    selectionColor="#4a3070"
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
                    <Check size={16} color="#3d7a5a" />
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
  // ... (스타일은 그대로 유지)
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
    backgroundColor: "#1e1535",
    borderRadius: 20, borderWidth: 1, borderColor: "#4a3070",
    paddingHorizontal: 10, paddingVertical: 4,
  },
  modeBadgeText: { color: "#8b7bc0", fontSize: 11, fontWeight: "700" },
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
  tabActive: { backgroundColor: "#4a3070" },
  tabText:       { color: "#555", fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#fff" },

  tabContent: { gap: 12 },

  genreSection: { gap: 8 },
  genreLabel:   { color: "#666", fontSize: 12, fontWeight: "600" },
  genreRow:     { flexDirection: "row", gap: 8, paddingVertical: 2 },
  genrePill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  genrePillActive: {
    backgroundColor: "#4a3070",
    borderColor: "#4a3070",
  },
  genrePillText:       { color: "#666", fontSize: 13, fontWeight: "600" },
  genrePillTextActive: { color: "#fff" },

  subtitleSelected: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#1a3528", borderRadius: 10,
    borderWidth: 1, borderColor: "#3d7a5a",
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
  },
  subtitleSelectedText: { color: "#6aab8a", fontSize: 13, flex: 1 },
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
    borderWidth: 1.5, borderColor: "#4a307088",
    borderStyle: "dashed", gap: 6,
  },
  bigPickText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  bigPickSub:  { color: "#555", fontSize: 12 },

  inputWrap:  { gap: 6 },
  inputLabel: { color: "#666", fontSize: 12, fontWeight: "600" },
  inputRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#1a1a1a", borderRadius: 12,
    borderWidth: 1.5, borderColor: "#4a3070",
    paddingHorizontal: 12, gap: 8,
  },
  inputRowValid: { borderColor: "#3d7a5a" },
  inputRowError: { borderColor: "#8b3a3a" },
  input: { flex: 1, color: "#fff", fontSize: 13, paddingVertical: 12 },
  clearBtn: { padding: 4 },

  parsedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  parsedText: { color: "#3d7a5a", fontSize: 12, fontWeight: "600" },
  errorText:  { color: "#8b3a3a", fontSize: 12, lineHeight: 18 },

  confirmBtn: {
    backgroundColor: "#4a3070",
    borderRadius: 12, paddingVertical: 14, alignItems: "center",
  },
  confirmBtnDisabled: { opacity: 0.35 },
  confirmBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});