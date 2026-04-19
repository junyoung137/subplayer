/**
 * UrlInputModal (v2-fix)
 *
 * 변경사항:
 * - parseYoutubeId import 경로: "./YouTubePlayer" → "../utils/youtubeUtils"
 *   (순환 의존성 제거 + 빨간줄 해결)
 * - 기존 탭 구조(local / url) 유지
 * - URL 탭 안내 문구: timedtext 기반 자막으로 설명 업데이트
 * - YouTube Shorts URL 지원 추가 (utils에서 처리)
 * - 입력값 유효성 미리보기 (videoId 파싱 결과 표시)
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
} from "react-native";
import { useTranslation } from "react-i18next";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
// ✅ 핵심 수정: YouTubePlayer에서 직접 import하지 않고 utils에서 import
import { parseYoutubeId } from "../utils/youtubeUtils";

// ── 파일 URI 안정화 ───────────────────────────────────────────────────────────
async function ensureFileUri(uri: string, filename: string): Promise<string | null> {
  if (uri.startsWith("file://")) return uri;
  try {
    const cacheDir = FileSystem.cacheDirectory + "videos/";
    await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
    const dest = cacheDir + filename;
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) await FileSystem.copyAsync({ from: uri, to: dest });
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
  /** 로컬 파일 선택 완료 시 — 기존 플로우와 동일하게 langModal 표시 */
  onLocalFilePicked: (uri: string, name: string) => void;
  /** YouTube/URL 선택 완료 시 — player로 바로 이동 */
  onUrlPicked: (videoId: string, title: string, isYoutube: boolean) => void;
}

// ── 탭 타입 ───────────────────────────────────────────────────────────────────
type Tab = "local" | "url";

// ── 예시 영상 ──────────────────────────────────────────────────────────────────
const EXAMPLES = [
  { label: "Me at the zoo (YouTube 첫 영상)", id: "jNQXAC9IVRw" },
  { label: "PSY - Gangnam Style",             id: "9bZkp7q19f0" },
];

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
export function UrlInputModal({
  visible,
  onClose,
  onLocalFilePicked,
  onUrlPicked,
}: UrlInputModalProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("local");
  const [urlInput,  setUrlInput]  = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [urlError,  setUrlError]  = useState<string | null>(null);

  // 실시간 videoId 파싱 미리보기
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
      const stableUri = await ensureFileUri(file.uri, file.name);
      if (!stableUri) {
        Alert.alert(t("url.error"), t("url.fileCopyError"));
        return;
      }
      onClose();
      onLocalFilePicked(stableUri, file.name);
    } catch (e) {
      Alert.alert(t("url.error"), t("url.fileOpenError") + String(e));
    } finally {
      setIsLoading(false);
    }
  }, [onClose, onLocalFilePicked]);

  // ── URL 확인 ─────────────────────────────────────────────────────────────
  const confirmUrl = useCallback(() => {
    setUrlError(null);
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setUrlError(t("url.urlRequired"));
      return;
    }

    // YouTube 판별
    const ytId = parseYoutubeId(trimmed);
    if (ytId) {
      onClose();
      onUrlPicked(ytId, `YouTube: ${ytId}`, true);
      setUrlInput("");
      return;
    }

    // 일반 URL (http/https) — 향후 확장 예정
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      setUrlError(t("url.generalUrlNotSupported"));
      return;
    }

    setUrlError(t("url.invalidUrl"));
  }, [urlInput, onClose, onUrlPicked]);

  // ── 모달 닫기 ────────────────────────────────────────────────────────────
  const handleClose = () => {
    setUrlInput("");
    setUrlError(null);
    setActiveTab("local");
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
        <Pressable style={styles.sheet} onPress={() => {}}>

          {/* 드래그 핸들 */}
          <View style={styles.handle} />

          {/* 헤더 */}
          <Text style={styles.title}>{t("url.title")}</Text>

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

          {/* ── 로컬 탭 ──────────────────────────────────────────────────── */}
          {activeTab === "local" && (
            <View style={styles.tabContent}>
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
                    <Text style={styles.bigPickIcon}>📂</Text>
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

              {/* 입력창 */}
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
                      <Text style={styles.clearBtnText}>✕</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {/* 파싱 성공 미리보기 */}
                {parsedId && urlInput.length > 0 && (
                  <View style={styles.parsedRow}>
                    <Text style={styles.parsedIcon}>✓</Text>
                    <Text style={styles.parsedText}>{t("url.idDetected", { id: parsedId })}</Text>
                  </View>
                )}

                {/* 에러 메시지 */}
                {urlError && (
                  <Text style={styles.errorText}>{urlError}</Text>
                )}
              </View>

              {/* 확인 버튼 */}
              <TouchableOpacity
                style={[styles.confirmBtn, !urlInput.trim() && styles.confirmBtnDisabled]}
                onPress={confirmUrl}
                disabled={!urlInput.trim()}
              >
                <Text style={styles.confirmBtnText}>{t("url.play")}</Text>
              </TouchableOpacity>

              {/* 구분선 */}
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>{t("url.examples")}</Text>
                <View style={styles.dividerLine} />
              </View>

              {/* 예시 링크 */}
              {EXAMPLES.map((ex) => (
                <TouchableOpacity
                  key={ex.id}
                  style={styles.exampleRow}
                  onPress={() => {
                    setUrlInput(`https://youtube.com/watch?v=${ex.id}`);
                    setUrlError(null);
                  }}
                >
                  <Text style={styles.exampleIcon}>▶</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.exampleLabel}>{ex.label}</Text>
                    <Text style={styles.exampleId}>ID: {ex.id}</Text>
                  </View>
                  <Text style={styles.exampleArrow}>→</Text>
                </TouchableOpacity>
              ))}

              {/* 안내 박스 */}
              <View style={styles.infoBox}>
                <Text style={styles.infoText}>{t("url.infoText")}</Text>
              </View>

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
    paddingBottom: 40,
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

  // ── 탭 ──────────────────────────────────────────────────────────────────────
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

  // ── 로컬 파일 버튼 ──────────────────────────────────────────────────────────
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
  bigPickIcon: { fontSize: 36 },
  bigPickText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  bigPickSub:  { color: "#555", fontSize: 12 },

  // ── URL 입력 ────────────────────────────────────────────────────────────────
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
  clearBtn:     { padding: 4 },
  clearBtnText: { color: "#555", fontSize: 14 },

  // 파싱 성공 미리보기
  parsedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  parsedIcon: { color: "#22c55e", fontSize: 13 },
  parsedText: { color: "#22c55e", fontSize: 12, fontWeight: "600" },

  errorText: {
    color: "#ef4444",
    fontSize: 12,
    lineHeight: 18,
  },

  // ── 확인 버튼 ───────────────────────────────────────────────────────────────
  confirmBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  confirmBtnDisabled: { opacity: 0.35 },
  confirmBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },

  // ── 구분선 ──────────────────────────────────────────────────────────────────
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 4,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#222" },
  dividerText: { color: "#444", fontSize: 12, fontWeight: "600" },

  // ── 예시 ────────────────────────────────────────────────────────────────────
  exampleRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    borderWidth: 1,
    borderColor: "#222",
  },
  exampleIcon:  { color: "#ff0000", fontSize: 12 },
  exampleLabel: { color: "#ccc", fontSize: 12, fontWeight: "500" },
  exampleId:    { color: "#555", fontSize: 11, marginTop: 1 },
  exampleArrow: { color: "#444", fontSize: 14 },

  // ── 안내 박스 ───────────────────────────────────────────────────────────────
  infoBox: {
    backgroundColor: "#0d1520",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1e3a5f",
  },
  infoText: { color: "#60a5fa", fontSize: 12, lineHeight: 18 },
});