/**
 * UrlInputModal (v2-fix-2)
 *
 * [FIX] ensureFileUri:
 *   DocumentPicker가 file:///...cache/DocumentPicker/... URI를 주는 경우,
 *   file://로 시작해도 앱 소유 디렉토리가 아니므로 Android가 언제든 삭제할 수 있음.
 *   → cache/DocumentPicker/ 경로는 반드시 앱 소유 cacheDirectory/videos/ 로 복사.
 *   → content:// 도 동일하게 복사.
 *   → FileSystem.cacheDirectory 나 documentDirectory 소속 파일만 그대로 사용.
 */

import React, { useState, useCallback } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  Alert,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { parseYoutubeId } from "../utils/youtubeUtils";
import { FolderOpen, X, Check } from 'lucide-react-native';

// ── 파일 URI 안정화 ───────────────────────────────────────────────────────────
// [FIX] 기존: file:// 이면 무조건 그대로 반환 → DocumentPicker 임시 파일 삭제 버그
// [FIX] 수정: 앱 소유 디렉토리(cacheDirectory / documentDirectory) 소속인지 확인,
//             아니면 반드시 cacheDirectory/videos/ 로 복사
async function ensureStableFileUri(uri: string, filename: string): Promise<string | null> {
  const cacheDir = FileSystem.cacheDirectory ?? "";
  const docDir   = FileSystem.documentDirectory ?? "";

  // 이미 앱 소유 안정 경로에 있으면 그대로 사용
  // (단, DocumentPicker 임시 경로는 cacheDirectory 하위라도 불안정하므로 제외)
  const isStable =
    (cacheDir && uri.startsWith(cacheDir) && !uri.includes("/DocumentPicker/")) ||
    (docDir   && uri.startsWith(docDir));

  if (isStable) {
    console.log("[FILE] Already in stable path, skipping copy:", uri);
    return uri;
  }

  // content:// 또는 cache/DocumentPicker/ 등 불안정 경로 → 안정 경로로 복사
  try {
    const videosDir = cacheDir + "videos/";
    await FileSystem.makeDirectoryAsync(videosDir, { intermediates: true });

    // 파일명 충돌 방지: timestamp prefix
    const safeName = Date.now() + "_" + filename.replace(/[^a-zA-Z0-9._\-]/g, "_");
    const dest = videosDir + safeName;

    console.log("[FILE] Copying to stable path:", dest);
    await FileSystem.copyAsync({ from: uri, to: dest });

    // 복사 성공 확인
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) throw new Error("Copy succeeded but dest not found: " + dest);

    console.log("[FILE] Copy complete:", dest);
    return dest;
  } catch (e) {
    console.error("[FILE] Copy failed:", e);
    return null;
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface UrlInputModalProps {
  visible: boolean;
  onClose: () => void;
  onLocalFilePicked: (uri: string, name: string, genre: string) => void;
  onUrlPicked: (videoId: string, title: string, isYoutube: boolean, genre?: string) => void;
}

type Tab = "local" | "url";

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
export function UrlInputModal({
  visible,
  onClose,
  onLocalFilePicked,
  onUrlPicked,
}: UrlInputModalProps) {
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

  const parsedId = parseYoutubeId(urlInput.trim());

  // ── 로컬 파일 선택 ───────────────────────────────────────────────────────
  const pickLocalFile = useCallback(async () => {
    try {
      setIsLoading(true);
      const result = await DocumentPicker.getDocumentAsync({
        type: ["video/*"],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      const file = result.assets[0];

      console.log("[FILE] URI being passed to player:", file.uri);
      console.log("[FILE] URI type:", file.uri.startsWith("file://") ? "file:// ✓" : file.uri.startsWith("content://") ? "content:// (needs copy)" : "other");

      // [FIX] ensureStableFileUri: DocumentPicker 임시 경로도 반드시 복사
      const stableUri = await ensureStableFileUri(file.uri, file.name);
      if (!stableUri) {
        Alert.alert(t("url.error"), t("url.fileCopyError"));
        return;
      }

      console.log("[FILE] Stable URI:", stableUri);

      onClose();
      onLocalFilePicked(stableUri, file.name, selectedGenre);
    } catch (e) {
      Alert.alert(t("url.error"), t("url.fileOpenError") + String(e));
    } finally {
      setIsLoading(false);
    }
  }, [onClose, onLocalFilePicked, selectedGenre, t]);

  // ── URL 확인 ─────────────────────────────────────────────────────────────
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
      onClose();
      onUrlPicked(ytId, `YouTube: ${ytId}`, true, genreSnapshot);
      setUrlInput("");
      return;
    }

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      setUrlError(t("url.generalUrlNotSupported"));
      return;
    }

    setUrlError(t("url.invalidUrl"));
  }, [urlInput, selectedGenre, onClose, onUrlPicked, t]);

  // ── 모달 닫기 ────────────────────────────────────────────────────────────
  const handleClose = () => {
    setUrlInput("");
    setUrlError(null);
    setActiveTab("local");
    setSelectedGenre("general");
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <Pressable style={[styles.sheet, { paddingBottom: Math.max(insets.bottom + 16, 40) }]} onPress={() => {}}>

          <View style={styles.handle} />

          <Text style={styles.title}>{t("url.title")}</Text>

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

          {/* ── 로컬 탭 ──────────────────────────────────────────────────── */}
          {activeTab === "local" && (
            <View style={styles.tabContent}>
              <View style={styles.genreSection}>
                <Text style={styles.genreLabel}>{t("genre.sectionTitle")}</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.genreRow}
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
                    <FolderOpen size={20} color="#aaa" />
                    <Text style={styles.bigPickText}>{t("url.selectFile")}</Text>
                    <Text style={styles.bigPickSub}>{t("url.supportedFormats")}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* ── URL 탭 ───────────────────────────────────────────────────── */}
          {activeTab === "url" && (
            <View style={styles.tabContent}>
              <View style={styles.genreSection}>
                <Text style={styles.genreLabel}>{t("genre.sectionTitle")}</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.genreRow}
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
                    selectionColor="#2563eb"
                    returnKeyType="go"
                    onSubmitEditing={confirmUrl}
                  />
                  {urlInput.length > 0 && (
                    <TouchableOpacity
                      style={styles.clearBtn}
                      onPress={() => { setUrlInput(""); setUrlError(null); }}
                    >
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

                {urlError && (
                  <Text style={styles.errorText}>{urlError}</Text>
                )}
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
      </Pressable>
    </Modal>
  );
}

// ── 스타일 ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#111",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 14,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: "#333",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 4,
  },
  title: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },

  tabRow: {
    flexDirection: "row",
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 3,
    gap: 3,
  },
  tab: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: "center",
  },
  tabActive:     { backgroundColor: "#2563eb" },
  tabText:       { color: "#555", fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#fff" },

  tabContent: { gap: 12 },

  bigPickBtn: {
    backgroundColor: "#1e1e1e",
    borderRadius: 16,
    paddingVertical: 28,
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#2a2a2a",
    borderStyle: "dashed",
    gap: 6,
  },
  bigPickText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  bigPickSub:  { color: "#555", fontSize: 12 },

  inputWrap: { gap: 6 },
  inputLabel: { color: "#666", fontSize: 12, fontWeight: "600" },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#2563eb",
    paddingHorizontal: 12,
    gap: 8,
  },
  inputRowValid: { borderColor: "#22c55e" },
  inputRowError: { borderColor: "#ef4444" },
  input: {
    flex: 1,
    color: "#fff",
    fontSize: 13,
    paddingVertical: 12,
  },
  clearBtn: { padding: 4 },

  parsedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  parsedText: { color: "#22c55e", fontSize: 12, fontWeight: "600" },

  errorText: {
    color: "#ef4444",
    fontSize: 12,
    lineHeight: 18,
  },

  confirmBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  confirmBtnDisabled: { opacity: 0.35 },
  confirmBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },

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
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  genrePillText:       { color: "#666", fontSize: 13, fontWeight: "600" },
  genrePillTextActive: { color: "#fff" },
});