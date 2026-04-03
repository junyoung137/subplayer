import { NativeModules } from "react-native";
console.log("[DEBUG] NativeModules keys:", Object.keys(NativeModules).filter(k => k.toLowerCase().includes('llama')));
console.log("[DEBUG] RNLlama:", NativeModules.RNLlama);

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { router } from "expo-router";
import { usePlayerStore } from "../store/usePlayerStore";

const SUPPORTED_TYPES = [
  "video/mp4",
  "video/x-matroska",
  "video/x-msvideo",
  "video/quicktime",
  "video/*",
];

const RECENT_KEY = "realtimesub_recent_files";

interface RecentFile {
  uri: string;
  name: string;
}

// ── Persistence helpers ───────────────────────────────────────────────────────

async function loadRecent(): Promise<RecentFile[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentFile[]) : [];
  } catch {
    return [];
  }
}

async function saveRecent(files: RecentFile[]): Promise<void> {
  try {
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(files));
  } catch {
    // best-effort
  }
}

// ── URI helpers ──────────────────────────────────────────────────────────────

/**
 * Ensure a URI is a stable file:// path by copying content:// URIs to the
 * app cache directory. Returns the file:// URI on success or null on failure.
 */
async function ensureFileUri(uri: string, filename: string): Promise<string | null> {
  if (uri.startsWith("file://")) return uri;

  try {
    const cacheDir = FileSystem.cacheDirectory + "videos/";
    await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
    const dest     = cacheDir + filename;
    const info     = await FileSystem.getInfoAsync(dest);
    if (!info.exists) {
      await FileSystem.copyAsync({ from: uri, to: dest });
    }
    console.log("[FILE] Copied content:// → file://:", dest);
    return dest;
  } catch (e) {
    console.error("[FILE] Copy failed:", e);
    return null;
  }
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const setVideo = usePlayerStore((s) => s.setVideo);

  // Load persisted recent files on mount
  useEffect(() => {
    loadRecent().then(setRecentFiles);
  }, []);

  // Persist whenever the list changes
  useEffect(() => {
    saveRecent(recentFiles);
  }, [recentFiles]);

  // ── File picker (unchanged logic) ─────────────────────────────────────────

  const pickVideo = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["video/*"],
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;
      const file = result.assets[0];

      console.log("[FILE] Picker URI:", file.uri);

      // Guarantee a stable file:// URI — copyToCacheDirectory may still return
      // content:// on some Android versions, so copy manually as fallback.
      const stableUri = await ensureFileUri(file.uri, file.name);
      if (!stableUri) {
        Alert.alert("오류", "파일을 캐시에 복사할 수 없습니다. 다시 시도해 주세요.");
        return;
      }

      console.log("[FILE] Stable URI:", stableUri);

      const entry: RecentFile = { uri: stableUri, name: file.name };
      setRecentFiles((prev) => {
        const filtered = prev.filter((f) => f.uri !== stableUri);
        return [entry, ...filtered].slice(0, 10);
      });

      setVideo(stableUri, file.name);
      router.push("/processing");
    } catch (e) {
      Alert.alert("오류", "파일을 열 수 없습니다: " + String(e));
    }
  };

  const openRecent = async (file: RecentFile) => {
    // Ensure we have a stable file:// URI. content:// entries saved before
    // the fix will fail to copy (expired permission), surfacing a clear error.
    const stableUri = await ensureFileUri(file.uri, file.name);
    if (!stableUri) {
      Alert.alert(
        "파일을 다시 선택하세요",
        "이 파일의 접근 권한이 만료되었습니다. 파일 열기 버튼으로 다시 선택해 주세요.",
        [
          {
            text: "목록에서 삭제",
            style: "destructive",
            onPress: () =>
              setRecentFiles((prev) => prev.filter((f) => f.uri !== file.uri)),
          },
          { text: "확인", style: "cancel" },
        ]
      );
      return;
    }

    // If the stable URI differs from what was saved, update the entry in-place
    // so future opens skip the copy step.
    if (stableUri !== file.uri) {
      setRecentFiles((prev) =>
        prev.map((f) => f.uri === file.uri ? { ...f, uri: stableUri } : f)
      );
    }

    console.log("[FILE] Opening recent:", stableUri);
    setVideo(stableUri, file.name);
    router.push("/processing");
  };

  // ── Delete helpers ────────────────────────────────────────────────────────

  const deleteOne = useCallback((uri: string) => {
    Alert.alert(
      "파일 삭제",
      "이 파일을 목록에서 삭제하시겠습니까?",
      [
        { text: "취소", style: "cancel" },
        {
          text: "확인",
          style: "destructive",
          onPress: () =>
            setRecentFiles((prev) => prev.filter((f) => f.uri !== uri)),
        },
      ]
    );
  }, []);

  const deleteAll = useCallback(() => {
    Alert.alert(
      "전체 삭제",
      "최근 파일 목록을 모두 삭제하시겠습니까?",
      [
        { text: "취소", style: "cancel" },
        {
          text: "확인",
          style: "destructive",
          onPress: () => setRecentFiles([]),
        },
      ]
    );
  }, []);

  const handleLongPress = useCallback((file: RecentFile) => {
    Alert.alert(
      file.name,
      undefined,
      [
        {
          text: "재생",
          onPress: () => { openRecent(file); },
        },
        {
          text: "목록에서 삭제",
          style: "destructive",
          onPress: () =>
            setRecentFiles((prev) => prev.filter((f) => f.uri !== file.uri)),
        },
        { text: "취소", style: "cancel" },
      ]
    );
  }, []); // openRecent is stable (doesn't depend on state)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.appName}>RealtimeSub</Text>
        <Text style={styles.tagline}>실시간 AI 자막 · 완전 무료</Text>
      </View>

      <TouchableOpacity style={styles.pickButton} onPress={pickVideo}>
        <Text style={styles.pickIcon}>📂</Text>
        <Text style={styles.pickText}>동영상 파일 열기</Text>
        <Text style={styles.pickSub}>MP4, MKV, AVI, MOV</Text>
      </TouchableOpacity>

      {recentFiles.length > 0 && (
        <View style={styles.recentSection}>
          {/* Section header with "전체 삭제" */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>최근 파일</Text>
            <TouchableOpacity onPress={deleteAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.clearAllText}>전체 삭제</Text>
            </TouchableOpacity>
          </View>

          <FlatList
            data={recentFiles}
            keyExtractor={(item) => item.uri}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.recentItem}
                onPress={() => openRecent(item)}
                onLongPress={() => handleLongPress(item)}
                delayLongPress={400}
              >
                <Text style={styles.recentIcon}>🎬</Text>
                <Text style={styles.recentName} numberOfLines={1}>
                  {item.name}
                </Text>
                {/* Per-item delete button */}
                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={() => deleteOne(item.uri)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
                >
                  <Text style={styles.deleteBtnText}>🗑️</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            )}
          />
        </View>
      )}

      <View style={styles.navButtons}>
        <TouchableOpacity
          style={styles.navBtn}
          onPress={() => router.push("/models")}
        >
          <Text style={styles.navBtnText}>🤖 모델 관리</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navBtn}
          onPress={() => router.push("/settings")}
        >
          <Text style={styles.navBtnText}>⚙️ 설정</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a", padding: 20 },
  hero: { alignItems: "center", paddingVertical: 32 },
  appName: { color: "#fff", fontSize: 32, fontWeight: "bold" },
  tagline: { color: "#888", fontSize: 14, marginTop: 4 },
  pickButton: {
    backgroundColor: "#1e1e1e",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#333",
    borderStyle: "dashed",
  },
  pickIcon: { fontSize: 40, marginBottom: 8 },
  pickText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  pickSub: { color: "#666", fontSize: 12, marginTop: 4 },
  recentSection: { marginTop: 28 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sectionTitle: {
    color: "#aaa",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  clearAllText: {
    color: "#ef4444",
    fontSize: 12,
    fontWeight: "600",
  },
  recentItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#222",
  },
  recentIcon: { fontSize: 20 },
  recentName: { color: "#ddd", fontSize: 14, flex: 1 },
  deleteBtn: {
    paddingLeft: 8,
  },
  deleteBtnText: {
    fontSize: 18,
  },
  navButtons: {
    flexDirection: "row",
    gap: 12,
    marginTop: "auto",
    paddingTop: 20,
  },
  navBtn: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
  },
  navBtnText: { color: "#ccc", fontSize: 14 },
});
