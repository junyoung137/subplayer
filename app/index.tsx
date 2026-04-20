import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  Modal,
  ScrollView,
  Pressable,
  TextInput,
  Image,
  Animated,
  ActivityIndicator,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { router, useFocusEffect } from "expo-router";
import { verifyModelIntegrity } from "../services/modelDownloadService";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { LANGUAGES } from "../constants/languages";
import { UrlInputModal } from "../components/UrlInputModal";

// ── Thumbnail helper (graceful fallback if expo-video-thumbnails not installed) ──
let getThumbnailAsync: ((uri: string, opts: { time: number }) => Promise<{ uri: string }>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("expo-video-thumbnails");
  getThumbnailAsync = mod.getThumbnailAsync ?? null;
} catch {}

// ── Storage keys ─────────────────────────────────────────────────────────────
const RECENT_KEY    = "realtimesub_recent_files_v2";
const CATEGORY_KEY  = "realtimesub_categories_v2";
const DEFAULT_CATEGORY = "전체";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SubtitleStatus = "none" | "processing" | "done";
export type SortOrder = "recent" | "name" | "size";

export interface RecentFile {
  uri: string;
  name: string;
  category?: string;       // category id
  addedAt: number;         // timestamp ms
  duration?: number;       // seconds
  fileSize?: number;       // bytes
  thumbnailUri?: string;
  subtitleStatus?: SubtitleStatus;
  subtitlePercent?: number;
  language?: string;       // detected lang code e.g. "en"
  targetLanguage?: string; // translated lang code e.g. "ko"
  isFavorite?: boolean;
  lastPlayedAt?: number;
}

export interface Category {
  id: string;
  name: string;
  parentId?: string;       // undefined = root category
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function loadRecent(): Promise<RecentFile[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentFile[]) : [];
  } catch { return []; }
}
async function saveRecent(files: RecentFile[]) {
  try { await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(files)); } catch {}
}
async function loadCategories(): Promise<Category[]> {
  try {
    const raw = await AsyncStorage.getItem(CATEGORY_KEY);
    return raw ? (JSON.parse(raw) as Category[]) : [];
  } catch { return []; }
}
async function saveCategories(cats: Category[]) {
  try { await AsyncStorage.setItem(CATEGORY_KEY, JSON.stringify(cats)); } catch {}
}

// ── URI & file helpers ────────────────────────────────────────────────────────

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

async function getFileSize(uri: string): Promise<number | undefined> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return (info as any).size ?? undefined;
  } catch { return undefined; }
}

async function deleteFileFromDisk(uri: string): Promise<void> {
  try {
    // Only delete files stored in our app's own directories
    // (documentDirectory or cacheDirectory). Never delete external URIs
    // like content:// or original user-picked files outside our scope.
    const ownedPrefixes = [
      FileSystem.documentDirectory ?? "",
      FileSystem.cacheDirectory ?? "",
    ];
    const isOwned = ownedPrefixes.some(
      (prefix) => prefix && uri.startsWith(prefix)
    );
    if (!isOwned) {
      console.log("[FILE] Skipping delete of external URI:", uri);
      return;
    }
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      console.log("[FILE] Deleted from disk:", uri);
    }
  } catch (e) {
    console.warn("[FILE] Could not delete file from disk:", uri, e);
  }
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec?: number): string {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function flagEmoji(code?: string): string {
  if (!code) return "";
  const map: Record<string, string> = {
    en: "🇺🇸", ko: "🇰🇷", ja: "🇯🇵", zh: "🇨🇳",
    fr: "🇫🇷", de: "🇩🇪", es: "🇪🇸", pt: "🇵🇹",
    ru: "🇷🇺", ar: "🇸🇦", hi: "🇮🇳", it: "🇮🇹",
  };
  return map[code] ?? code.toUpperCase();
}

// ── Thumbnail cache ───────────────────────────────────────────────────────────

const thumbCache: Record<string, string> = {};

/**
 * Smart thumbnail extraction — avoids black opening frames.
 * Tries: 10% of duration → 10s → 5s → 3s → 1s
 * Android: ensures uri starts with file:// before calling getThumbnailAsync
 */
async function fetchThumbnail(
  uri: string,
  durationSec?: number,
): Promise<string | null> {
  if (!getThumbnailAsync) return null;
  if (thumbCache[uri]) return thumbCache[uri];

  // Android requires file:// scheme — content:// URIs will fail
  const safeUri = uri.startsWith("file://") || uri.startsWith("http")
    ? uri
    : "file://" + uri;

  const candidates: number[] = [];
  if (durationSec && durationSec > 0) {
    const tenPct = Math.max(Math.floor(durationSec * 0.1) * 1000, 3000);
    candidates.push(tenPct);
  }
  // Fixed fallbacks — avoids black intro frames
  candidates.push(10000, 5000, 3000, 1000, 500);

  for (const timeMs of candidates) {
    try {
      const result = await getThumbnailAsync(safeUri, { time: timeMs });
      if (result?.uri) {
        thumbCache[uri] = result.uri;
        return result.uri;
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

// ── Sub-components ────────────────────────────────────────────────────────────

/**
 * FileThumbnail
 * - Auto-extracts on mount (smart multi-point, avoids black frames)
 * - Fades in smoothly once ready
 * - Shows camera edit-overlay badge so user knows it's tappable
 * - Empty state: clean placeholder with camera icon
 * - Tap (empty) or tap camera badge (filled) → onPickManual
 * - All images: center crop via resizeMode="cover"
 */
function FileThumbnail({
  uri,
  thumbUri,
  duration,
  onPickManual,
}: {
  uri: string;
  thumbUri?: string;
  duration?: number;
  onPickManual?: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(thumbUri ?? null);
  const [loading, setLoading] = useState(!thumbUri);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (thumbUri) {
      setThumb(thumbUri);
      setLoading(false);
      fadeAnim.setValue(1);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fadeAnim.setValue(0);
    fetchThumbnail(uri, duration).then((t) => {
      if (cancelled) return;
      setThumb(t);
      setLoading(false);
      if (t) {
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 350,
          useNativeDriver: true,
        }).start();
      }
    });
    return () => { cancelled = true; };
  }, [uri, thumbUri, duration]);

  // ── Skeleton / loading state ──────────────────────────────────────────────
  if (loading) {
    return (
      <View style={thumbStyles.wrap}>
        <View style={thumbStyles.skeleton} />
        <ActivityIndicator size="small" color="#444" style={{ position: "absolute" }} />
      </View>
    );
  }

  // ── Filled: thumbnail present ─────────────────────────────────────────────
  if (thumb) {
    return (
      <View style={thumbStyles.wrap}>
        {/* Center-crop image with fade-in */}
        <Animated.Image
          source={{ uri: thumb }}
          style={[thumbStyles.img, { opacity: fadeAnim }]}
          resizeMode="cover"
        />
        {/* Subtle play overlay */}
        <View style={thumbStyles.playOverlay} pointerEvents="none">
          <Text style={thumbStyles.playIcon}>▶</Text>
        </View>
        {/* Camera badge — bottom-right corner — signals "tap to change" */}
        <TouchableOpacity
          style={thumbStyles.camBadge}
          onPress={onPickManual}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          activeOpacity={0.7}
        >
          <Text style={thumbStyles.camIcon}>📷</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Empty: no thumbnail yet ───────────────────────────────────────────────
  return (
    <TouchableOpacity
      style={[thumbStyles.wrap, thumbStyles.wrapEmpty]}
      onPress={onPickManual}
      activeOpacity={0.7}
    >
      <Text style={thumbStyles.emptyIcon}>🎞</Text>
      <Text style={thumbStyles.emptyLabel}>사진 추가</Text>
    </TouchableOpacity>
  );
}

const thumbStyles = StyleSheet.create({
  wrap: {
    width: 64,
    height: 42,
    borderRadius: 8,
    backgroundColor: "#1a1a1a",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  wrapEmpty: {
    borderStyle: "dashed",
    borderColor: "#3a3a3a",
    backgroundColor: "#111",
    gap: 3,
  },
  skeleton: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#1e1e1e",
  },
  // center-crop: fill the container completely
  img: {
    width: "100%",
    height: "100%",
  },
  playOverlay: {
    position: "absolute",
    backgroundColor: "rgba(0,0,0,0.35)",
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: { color: "#fff", fontSize: 13, opacity: 0.85 },
  // Camera badge — bottom-right corner
  camBadge: {
    position: "absolute",
    bottom: 3,
    right: 3,
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  camIcon: { fontSize: 9 },
  // Empty placeholder
  emptyIcon: { fontSize: 18, opacity: 0.4 },
  emptyLabel: { color: "#444", fontSize: 9, fontWeight: "600", letterSpacing: 0.2 },
});

// Subtitle status badge
function SubBadge({ status, percent }: { status?: SubtitleStatus; percent?: number }) {
  const { t } = useTranslation();
  if (!status || status === "none") return null;
  if (status === "processing") {
    return (
      <View style={[badgeStyles.badge, badgeStyles.processing]}>
        <Text style={badgeStyles.text}>⚙️ {percent ?? 0}%</Text>
      </View>
    );
  }
  return (
    <View style={[badgeStyles.badge, badgeStyles.done]}>
      <Text style={badgeStyles.text}>{t("home.subtitleDone")}</Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  badge: {
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignSelf: "flex-start",
    marginTop: 3,
  },
  processing: { backgroundColor: "#7c3aed22", borderWidth: 1, borderColor: "#7c3aed" },
  done:       { backgroundColor: "#16653422", borderWidth: 1, borderColor: "#22c55e" },
  text: { fontSize: 10, color: "#aaa", fontWeight: "600" },
});

// ── Language Setup Modal ──────────────────────────────────────────────────────
interface LangSetupModalProps {
  visible: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}
function LangSetupModal({ visible, onConfirm, onCancel }: LangSetupModalProps) {
  const { t } = useTranslation();
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const update         = useSettingsStore((s) => s.update);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={modalStyles.backdrop} onPress={onCancel}>
        <Pressable style={modalStyles.sheet} onPress={() => {}}>
          <Text style={modalStyles.title}>{t("home.langSetupTitle")}</Text>
          <Text style={modalStyles.subtitle}>{t("home.langSetupSubtitle")}</Text>
          <ScrollView style={modalStyles.langList} nestedScrollEnabled>
            {LANGUAGES.map((lang) => {
              const isSelected = targetLanguage === lang.code;
              return (
                <TouchableOpacity
                  key={lang.code}
                  style={[modalStyles.langOption, isSelected && modalStyles.langOptionSelected]}
                  onPress={() => update({ targetLanguage: lang.code })}
                >
                  <Text style={modalStyles.langOptionNative}>{lang.nativeName}</Text>
                  <Text style={modalStyles.langOptionCode}>{lang.name}</Text>
                  {isSelected && <Text style={modalStyles.checkmark}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <Text style={modalStyles.hint}>{t("home.langSetupHint")}</Text>
          <View style={modalStyles.btnRow}>
            <TouchableOpacity style={modalStyles.cancelBtn} onPress={onCancel}>
              <Text style={modalStyles.cancelBtnText}>{t("common.cancel")}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={modalStyles.confirmBtn} onPress={onConfirm}>
              <Text style={modalStyles.confirmBtnText}>{t("home.startProcessing")}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Category Name Modal ───────────────────────────────────────────────────────
interface CategoryNameModalProps {
  visible: boolean;
  initial?: string;
  parentName?: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}
function CategoryNameModal({ visible, initial = "", parentName, onConfirm, onCancel }: CategoryNameModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  useEffect(() => { if (visible) setName(initial); }, [visible, initial]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={catModalStyles.backdrop} onPress={onCancel}>
        <Pressable style={catModalStyles.card} onPress={() => {}}>
          <Text style={catModalStyles.title}>
            {initial ? t("home.folderNameChange") : parentName ? t("home.createSubfolderIn", { parentName }) : t("home.newFolder")}
          </Text>
          <TextInput
            style={catModalStyles.input}
            value={name}
            onChangeText={setName}
            placeholder={t("home.folderNamePlaceholder")}
            placeholderTextColor="#555"
            autoFocus
            maxLength={20}
            selectionColor="#2563eb"
          />
          <View style={catModalStyles.btnRow}>
            <TouchableOpacity style={catModalStyles.cancelBtn} onPress={onCancel}>
              <Text style={catModalStyles.cancelText}>{t("common.cancel")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[catModalStyles.confirmBtn, !name.trim() && catModalStyles.confirmDisabled]}
              onPress={() => { if (name.trim()) onConfirm(name.trim()); }}
              disabled={!name.trim()}
            >
              <Text style={catModalStyles.confirmText}>{t("common.confirm")}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Move Category Modal ───────────────────────────────────────────────────────
interface MoveCategoryModalProps {
  visible: boolean;
  categories: Category[];
  currentCategory?: string;
  onSelect: (categoryId: string | undefined) => void;
  onCancel: () => void;
}
function MoveCategoryModal({ visible, categories, currentCategory, onSelect, onCancel }: MoveCategoryModalProps) {
  const { t } = useTranslation();
  const roots = categories.filter((c) => !c.parentId);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={modalStyles.backdrop} onPress={onCancel}>
        <Pressable style={modalStyles.sheet} onPress={() => {}}>
          <Text style={modalStyles.title}>{t("home.moveToFolderTitle")}</Text>
          <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled>
            <TouchableOpacity
              style={[moveStyles.option, !currentCategory && moveStyles.optionActive]}
              onPress={() => onSelect(undefined)}
            >
              <Text style={moveStyles.optionIcon}>📂</Text>
              <Text style={moveStyles.optionName}>{t("home.uncat")}</Text>
              {!currentCategory && <Text style={moveStyles.check}>✓</Text>}
            </TouchableOpacity>
            {roots.map((cat) => {
              const children = categories.filter((c) => c.parentId === cat.id);
              return (
                <React.Fragment key={cat.id}>
                  <TouchableOpacity
                    style={[moveStyles.option, currentCategory === cat.id && moveStyles.optionActive]}
                    onPress={() => onSelect(cat.id)}
                  >
                    <Text style={moveStyles.optionIcon}>📁</Text>
                    <Text style={moveStyles.optionName}>{cat.name}</Text>
                    {currentCategory === cat.id && <Text style={moveStyles.check}>✓</Text>}
                  </TouchableOpacity>
                  {children.map((child) => (
                    <TouchableOpacity
                      key={child.id}
                      style={[moveStyles.option, moveStyles.childOption, currentCategory === child.id && moveStyles.optionActive]}
                      onPress={() => onSelect(child.id)}
                    >
                      <Text style={moveStyles.optionIcon}>  📂</Text>
                      <Text style={moveStyles.optionName}>{child.name}</Text>
                      {currentCategory === child.id && <Text style={moveStyles.check}>✓</Text>}
                    </TouchableOpacity>
                  ))}
                </React.Fragment>
              );
            })}
          </ScrollView>
          <TouchableOpacity style={moveStyles.cancelBtn} onPress={onCancel}>
            <Text style={moveStyles.cancelText}>{t("common.cancel")}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Sort picker modal ─────────────────────────────────────────────────────────
interface SortModalProps {
  visible: boolean;
  current: SortOrder;
  onSelect: (s: SortOrder) => void;
  onCancel: () => void;
}
function SortModal({ visible, current, onSelect, onCancel }: SortModalProps) {
  const { t } = useTranslation();
  const options: { key: SortOrder; label: string; icon: string }[] = [
    { key: "recent", label: t("home.sortRecent"), icon: "🕐" },
    { key: "name",   label: t("home.sortName"),   icon: "🔤" },
    { key: "size",   label: t("home.sortSize"),   icon: "📦" },
  ];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={catModalStyles.backdrop} onPress={onCancel}>
        <Pressable style={[catModalStyles.card, { gap: 4 }]} onPress={() => {}}>
          <Text style={catModalStyles.title}>{t("home.sortModal")}</Text>
          {options.map((o) => (
            <TouchableOpacity
              key={o.key}
              style={[moveStyles.option, { borderRadius: 10, marginVertical: 2 }, current === o.key && moveStyles.optionActive]}
              onPress={() => onSelect(o.key)}
            >
              <Text style={{ fontSize: 18 }}>{o.icon}</Text>
              <Text style={moveStyles.optionName}>{o.label}</Text>
              {current === o.key && <Text style={moveStyles.check}>✓</Text>}
            </TouchableOpacity>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── HomeScreen ────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [recentFiles,      setRecentFiles]      = useState<RecentFile[]>([]);
  const [categories,       setCategories]       = useState<Category[]>([]);
  const [selectedCat,      setSelectedCat]      = useState<string>(DEFAULT_CATEGORY);
  const [langModalVisible, setLangModalVisible] = useState(false);
  const [filePickerVisible, setFilePickerVisible] = useState(false); // ← 추가
  const [searchQuery,      setSearchQuery]      = useState("");
  const [searchActive,     setSearchActive]     = useState(false);
  const [sortOrder,        setSortOrder]        = useState<SortOrder>("recent");
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [multiSelect,      setMultiSelect]      = useState(false);
  const [selectedUris,     setSelectedUris]     = useState<Set<string>>(new Set());
  const [batchMoveVisible, setBatchMoveVisible] = useState(false);

  const [renameModal, setRenameModal] = useState<{
    visible: boolean;
    file?: RecentFile;
  }>({ visible: false });

  const [fileActionModal, setFileActionModal] = useState<{
    visible: boolean;
    file?: RecentFile;
  }>({ visible: false });

  const [catNameModal, setCatNameModal] = useState<{
    visible: boolean;
    editId?: string;
    parentId?: string;
  }>({ visible: false });
  const [moveModal, setMoveModal] = useState<{ visible: boolean; file?: RecentFile }>({ visible: false });

  const [hasWhisperModel, setHasWhisperModel] = useState(true); // true = no banner on first render
  const [hasGemmaModel,   setHasGemmaModel]   = useState(true);

  const checkModels = useCallback(async () => {
    const [whisperOk, gemmaOk] = await Promise.all([
      (async () => {
        try {
          const modelDir = FileSystem.documentDirectory + "whisper-models/";
          const dirInfo = await FileSystem.getInfoAsync(modelDir);
          if (!dirInfo.exists) return false;
          const files = await FileSystem.readDirectoryAsync(modelDir);
          return files.some((f) => f.endsWith(".bin"));
        } catch { return false; }
      })(),
      (async () => {
        try {
          const meta = await verifyModelIntegrity();
          return meta !== null;
        } catch { return false; }
      })(),
    ]);
    setHasWhisperModel(whisperOk);
    setHasGemmaModel(gemmaOk);
  }, []);

  useFocusEffect(
    useCallback(() => {
      checkModels();
    }, [checkModels])
  );

  const setVideo = usePlayerStore((s) => s.setVideo);
  const setYoutubeVideo = usePlayerStore((s) => s.setYoutubeVideo); // ← 추가
  const setPendingGenre = usePlayerStore((s) => s.setPendingGenre);
  const pendingFileRef = useRef<{ uri: string; name: string } | null>(null);

  const [resumeDialog, setResumeDialog] = useState<{
    visible: boolean;
    videoId: string;
    videoTitle: string;
    language: string;
    genre: string;
  } | null>(null);

  // ── Load on mount ──────────────────────────────────────────────────────────
  useEffect(() => {
    loadRecent().then(setRecentFiles);
    loadCategories().then(setCategories);
  }, []);

  // ── Pending background task recovery ──────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('bg_translation_pending_task');
        if (!raw) return;
        const task = JSON.parse(raw);
        // Only show resume if task was enqueued within the last 24 hours
        if (!task.videoId || Date.now() - (task.enqueuedAt ?? 0) > 86400000) {
          await AsyncStorage.removeItem('bg_translation_pending_task');
          return;
        }
        setResumeDialog({
          visible: true,
          videoId:    task.videoId,
          videoTitle: task.videoTitle ?? t("home.youtubeVideoDefault"),
          language:   task.language   ?? 'Korean',
          genre:      task.genre      ?? 'general',
        });
      } catch {}
    })();
  }, []);

  useEffect(() => { saveRecent(recentFiles); }, [recentFiles]);
  useEffect(() => { saveCategories(categories); }, [categories]);

  // ── Sorted + filtered files ────────────────────────────────────────────────
  const filteredFiles = useMemo(() => {
    let files = recentFiles.filter((f) => {
      if (selectedCat === DEFAULT_CATEGORY) return true;
      if (selectedCat === "__uncat__") return !f.category;
      if (selectedCat === "__fav__") return f.isFavorite;
      // check if selectedCat or its sub-cats match
      const subCatIds = categories
        .filter((c) => c.parentId === selectedCat)
        .map((c) => c.id);
      return f.category === selectedCat || subCatIds.includes(f.category ?? "");
    });

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      files = files.filter((f) => f.name.toLowerCase().includes(q));
    }

    files = [...files].sort((a, b) => {
      if (sortOrder === "recent") return (b.addedAt ?? 0) - (a.addedAt ?? 0);
      if (sortOrder === "name")   return a.name.localeCompare(b.name);
      if (sortOrder === "size")   return (b.fileSize ?? 0) - (a.fileSize ?? 0);
      return 0;
    });

    return files;
  }, [recentFiles, categories, selectedCat, searchQuery, sortOrder]);

  // Recent played (last 5, has lastPlayedAt)
  const recentlyPlayed = useMemo(() => {
    return [...recentFiles]
      .filter((f) => f.lastPlayedAt)
      .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
      .slice(0, 5);
  }, [recentFiles]);

  // ── Category helpers ───────────────────────────────────────────────────────

  const createCategory = (name: string, parentId?: string) => {
    const id = Date.now().toString();
    setCategories((prev) => [...prev, { id, name, parentId }]);
    setCatNameModal({ visible: false });
    setSelectedCat(id);
  };

  const renameCategory = (id: string, name: string) => {
    setCategories((prev) => prev.map((c) => c.id === id ? { ...c, name } : c));
    setCatNameModal({ visible: false });
  };

  const renameFile = (uri: string, newName: string) => {
    setRecentFiles((prev) =>
      prev.map((f) => f.uri === uri ? { ...f, name: newName } : f)
    );
    setRenameModal({ visible: false });
  };

  const deleteCategory = (id: string) => {
    // also delete all sub-categories
    const toDelete = new Set<string>([id]);
    categories.filter((c) => c.parentId === id).forEach((c) => toDelete.add(c.id));
    Alert.alert(t("home.folderDelete"), t("home.folderDeleteMsg"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () => {
          setCategories((prev) => prev.filter((c) => !toDelete.has(c.id)));
          setRecentFiles((prev) =>
            prev.map((f) => toDelete.has(f.category ?? "") ? { ...f, category: undefined } : f)
          );
          if (toDelete.has(selectedCat)) setSelectedCat(DEFAULT_CATEGORY);
        },
      },
    ]);
  };

  const moveFileToCategory = (file: RecentFile, categoryId: string | undefined) => {
    setRecentFiles((prev) =>
      prev.map((f) => f.uri === file.uri ? { ...f, category: categoryId } : f)
    );
    setMoveModal({ visible: false });
  };

  const batchMoveToCategory = (categoryId: string | undefined) => {
    setRecentFiles((prev) =>
      prev.map((f) => selectedUris.has(f.uri) ? { ...f, category: categoryId } : f)
    );
    setSelectedUris(new Set());
    setMultiSelect(false);
    setBatchMoveVisible(false);
  };

  const toggleFavorite = (uri: string) => {
    setRecentFiles((prev) =>
      prev.map((f) => f.uri === uri ? { ...f, isFavorite: !f.isFavorite } : f)
    );
  };

  // ── Manual thumbnail picker ────────────────────────────────────────────────
  const pickManualThumbnail = useCallback(async (fileUri: string) => {
    Alert.alert(
      t("home.changeThumbnail"),
      t("home.changeThumbnailMsg"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("home.galleryPick"),
          onPress: async () => {
            try {
              const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
              if (!perm.granted) {
                Alert.alert("권한 필요", "사진 라이브러리 접근 권한이 필요합니다.");
                return;
              }
              const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
                allowsEditing: true,
                aspect: [3, 2],   // enforce 3:2 crop — matches thumbStyles wrap ratio
                quality: 0.8,
              });
              if (result.canceled || !result.assets[0]) return;
              const picked = result.assets[0].uri;
              // Persist to cache dir so uri survives app restarts
              const cacheDir = FileSystem.cacheDirectory + "thumbs/";
              await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
              const dest = cacheDir + Date.now() + ".jpg";
              await FileSystem.copyAsync({ from: picked, to: dest });
              thumbCache[fileUri] = dest;
              setRecentFiles((prev) =>
                prev.map((f) => f.uri === fileUri ? { ...f, thumbnailUri: dest } : f)
              );
            } catch (e) {
              Alert.alert("오류", "썸네일을 설정할 수 없습니다: " + String(e));
            }
          },
        },
      ]
    );
  }, []);

  // ── File open helpers ──────────────────────────────────────────────────────

  const goToProcessing = useCallback(() => {
    setLangModalVisible(false);
    router.push("/processing");
  }, []);

  const handleCancelModal = useCallback(() => {
    setLangModalVisible(false);
    pendingFileRef.current = null;
  }, []);

  // ── 새 핸들러: 로컬 파일 선택 후 처리 ─────────────────────────────────────
  const handleLocalFilePicked = async (stableUri: string, name: string, genre: string) => {
    const fileSize = await getFileSize(stableUri);
    const thumbUri = (await fetchThumbnail(stableUri, undefined)) ?? undefined;
    const autoCategory =
      selectedCat !== DEFAULT_CATEGORY &&
      selectedCat !== "__uncat__" &&
      selectedCat !== "__fav__"
        ? selectedCat
        : undefined;
    const entry: RecentFile = {
      uri: stableUri,
      name,
      category: autoCategory,
      addedAt: Date.now(),
      fileSize,
      thumbnailUri: thumbUri,
      subtitleStatus: "none",
    };
    setRecentFiles((prev) => {
      const filtered = prev.filter((f) => f.uri !== stableUri);
      return [entry, ...filtered].slice(0, 50);
    });
    setPendingGenre(genre);
    setVideo(stableUri, name);
    pendingFileRef.current = { uri: stableUri, name };
    setLangModalVisible(true); // 기존 언어 선택 모달 그대로 사용
  };

  // ── 새 핸들러: URL (YouTube) 선택 후 처리 ─────────────────────────────────
  const handleUrlPicked = (videoId: string, title: string, isYoutube: boolean, genre?: string) => {
    if (isYoutube) {
      setPendingGenre(genre ?? 'general');
      setYoutubeVideo(videoId, title);
      router.push("/youtube-player");
    }
    // 일반 URL은 향후 확장 가능
  };

  const handleResume = useCallback(() => {
    if (!resumeDialog) return;
    setResumeDialog(null);
    // Restore store state so youtube-player screen can load
    setYoutubeVideo(resumeDialog.videoId, resumeDialog.videoTitle);
    router.push('/youtube-player');
  }, [resumeDialog, setYoutubeVideo]);

  const handleResumeCancel = useCallback(async () => {
    setResumeDialog(null);
    await AsyncStorage.removeItem('bg_translation_pending_task').catch(() => {});
  }, []);

  // pickVideo 함수는 더 이상 버튼에서 직접 호출되지 않지만,
  // UrlInputModal 내부에서 로컬 파일 선택 시에도 동일한 로직을 사용하므로 유지
  const pickVideo = async () => {
    // 실제로는 UrlInputModal이 대신 처리하므로 빈 함수로 두거나,
    // 필요 시 내부에서 DocumentPicker를 호출할 수도 있음 (현재는 모달이 담당)
    // 여기서는 모달이 모든 파일/URL 입력을 담당하므로 단순히 모달을 여는 용도로만 사용
  };

  const openRecent = async (file: RecentFile) => {
    const stableUri = await ensureFileUri(file.uri, file.name);
    if (!stableUri) {
      Alert.alert(t("home.fileAccessExpired"), t("home.permissionExpired"), [
        { text: t("home.deleteFromList"), style: "destructive", onPress: () => setRecentFiles((prev) => prev.filter((f) => f.uri !== file.uri)) },
        { text: t("common.confirm"), style: "cancel" },
      ]);
      return;
    }
    if (stableUri !== file.uri) {
      setRecentFiles((prev) => prev.map((f) => f.uri === file.uri ? { ...f, uri: stableUri } : f));
    }
    setRecentFiles((prev) => prev.map((f) => f.uri === stableUri ? { ...f, lastPlayedAt: Date.now() } : f));
    setVideo(stableUri, file.name);
    pendingFileRef.current = { uri: stableUri, name: file.name };
    setLangModalVisible(true);
  };

  const deleteOne = useCallback((uri: string) => {
    Alert.alert(t("home.deleteFile"), t("home.deleteFileMsg"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.confirm"), style: "destructive", onPress: async () => {
          await deleteFileFromDisk(uri);
          setRecentFiles((prev) => prev.filter((f) => f.uri !== uri));
        },
      },
    ]);
  }, []);

  const deleteAll = useCallback(() => {
    const targets = selectedCat === DEFAULT_CATEGORY ? recentFiles : filteredFiles;
    if (!targets.length) return;
    Alert.alert(t("home.deleteAllTitle"), t("home.deleteAllMsg"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.confirm"), style: "destructive",
        onPress: async () => {
          const uris = new Set(targets.map((f) => f.uri));
          await Promise.all(targets.map((f) => deleteFileFromDisk(f.uri)));
          setRecentFiles((prev) => prev.filter((f) => !uris.has(f.uri)));
        },
      },
    ]);
  }, [recentFiles, filteredFiles, selectedCat]);

  const deleteSelected = () => {
    Alert.alert(t("home.deleteSelected", { count: selectedUris.size }), t("home.deleteSelectedMsg"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"), style: "destructive",
        onPress: async () => {
          await Promise.all([...selectedUris].map((uri) => deleteFileFromDisk(uri)));
          setRecentFiles((prev) => prev.filter((f) => !selectedUris.has(f.uri)));
          setSelectedUris(new Set());
          setMultiSelect(false);
        },
      },
    ]);
  };

  const handleLongPress = useCallback((file: RecentFile) => {
    if (multiSelect) return; // already in multi-select
    // Enter multi-select and select this file
    setMultiSelect(true);
    setSelectedUris(new Set([file.uri]));
  }, [multiSelect]);

  const toggleSelectFile = (uri: string) => {
    setSelectedUris((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  };

  // ── Current category obj ───────────────────────────────────────────────────
  const currentCatObj = categories.find((c) => c.id === selectedCat);
  const parentCatObj  = currentCatObj?.parentId
    ? categories.find((c) => c.id === currentCatObj.parentId)
    : undefined;

  // Sub-categories of selected
  const subCategories = categories.filter((c) => c.parentId === selectedCat);

  // Root categories
  const rootCategories = categories.filter((c) => !c.parentId);

  // ── Render file item ───────────────────────────────────────────────────────
  const renderFileItem = ({ item }: { item: RecentFile }) => {
    const catName = item.category
      ? categories.find((c) => c.id === item.category)?.name
      : undefined;
    const isSelected = selectedUris.has(item.uri);

    return (
      <TouchableOpacity
        style={[styles.recentItem, isSelected && styles.recentItemSelected]}
        onPress={() => {
          if (multiSelect) { toggleSelectFile(item.uri); return; }
          openRecent(item);
        }}
        onLongPress={() => handleLongPress(item)}
        delayLongPress={400}
        activeOpacity={0.75}
      >
        {/* Multi-select checkbox */}
        {multiSelect && (
          <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
            {isSelected && <Text style={styles.checkboxMark}>✓</Text>}
          </View>
        )}

        {/* Thumbnail — auto-extracted (smart), tap camera badge to change */}
        <FileThumbnail
          uri={item.uri}
          thumbUri={item.thumbnailUri}
          duration={item.duration}
          onPickManual={() => pickManualThumbnail(item.uri)}
        />

        {/* Info */}
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {item.isFavorite && <Text style={styles.starIcon}>★</Text>}
            <Text style={styles.recentName} numberOfLines={1}>{item.name}</Text>
          </View>

          {/* Duration + Size */}
          <View style={styles.metaRow}>
            {item.duration ? <Text style={styles.metaText}>⏱ {formatDuration(item.duration)}</Text> : null}
            {item.fileSize ? <Text style={styles.metaText}>· {formatSize(item.fileSize)}</Text> : null}
            {item.language ? (
              <Text style={styles.langTag}>{flagEmoji(item.language)} {item.language.toUpperCase()}</Text>
            ) : null}
            {item.targetLanguage ? (
              <Text style={styles.langTag}>→ {flagEmoji(item.targetLanguage)} {item.targetLanguage.toUpperCase()}</Text>
            ) : null}
          </View>

          {/* Subtitle badge */}
          <SubBadge status={item.subtitleStatus} percent={item.subtitlePercent} />

          {/* Category badge in 전체 view */}
          {catName && selectedCat === DEFAULT_CATEGORY && (
            <Text style={styles.recentCatBadge}>📁 {catName}</Text>
          )}
        </View>

        {/* Right actions — ☆ 즐겨찾기 + ⋯ 이동/삭제 메뉴 */}
        {!multiSelect && (
          <View style={styles.itemActions}>
            <TouchableOpacity
              onPress={() => toggleFavorite(item.uri)}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              <Text style={[styles.actionIcon, item.isFavorite && styles.starActive]}>
                {item.isFavorite ? "★" : "☆"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setFileActionModal({ visible: true, file: item })}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
            >
              <Text style={styles.actionIcon}>⋯</Text>
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={{ flex: 1, justifyContent: "space-between" }}>


      {/* File open button — 이제 UrlInputModal을 통해 열림 */}
      <TouchableOpacity 
        style={styles.pickButton} 
        onPress={() => setFilePickerVisible(true)}
      >
        <Text style={styles.pickIcon}>📂</Text>
        <Text style={styles.pickText}>{t("home.pickText")}</Text>
        <Text style={styles.pickSub}>{t("home.pickSub")}</Text>
      </TouchableOpacity>

      {/* ── Missing-model combined card ────────────────────────────────────── */}
      {(!hasWhisperModel || !hasGemmaModel) && (
        <TouchableOpacity
          style={bannerStyles.modelCard}
          onPress={() => router.push("/models")}
          activeOpacity={0.8}
        >
          <View style={bannerStyles.modelCardHeader}>
            <Text style={bannerStyles.modelCardTitle}>⚠️  {t("home.modelBannerTitle")}</Text>
            <Text style={bannerStyles.modelCardAction}>{t("home.modelBannerAction")}</Text>
          </View>
          <View style={bannerStyles.modelCardDivider} />
          {!hasWhisperModel && (
            <View style={bannerStyles.modelCardRow}>
              <Text style={bannerStyles.modelCardRowText}>🎙  {t("home.noModelBanner")}</Text>
            </View>
          )}
          {!hasGemmaModel && (
            <View style={bannerStyles.modelCardRow}>
              <Text style={bannerStyles.modelCardRowText}>🔤  {t("home.noGemmaBanner")}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* ── Recently played horizontal scroll ──────────────────────────────── */}
      {recentlyPlayed.length > 0 && (
        <View style={styles.recentPlaySection}>
          <Text style={styles.recentPlayTitle}>{t("home.recentPlay")}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentPlayRow}>
            {recentlyPlayed.map((file) => (
              <TouchableOpacity
                key={file.uri}
                style={styles.recentPlayCard}
                onPress={() => openRecent(file)}
                activeOpacity={0.75}
              >
                <FileThumbnail uri={file.uri} thumbUri={file.thumbnailUri} duration={file.duration} />
                <Text style={styles.recentPlayName} numberOfLines={2}>{file.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── Search bar ─────────────────────────────────────────────────────── */}
      <View style={styles.searchRow}>
        {searchActive ? (
          <View style={styles.searchBar}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t("home.searchPlaceholder")}
              placeholderTextColor="#444"
              autoFocus
              selectionColor="#2563eb"
            />
            <TouchableOpacity onPress={() => { setSearchQuery(""); setSearchActive(false); }}>
              <Text style={styles.searchClear}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.searchBarInactive} onPress={() => setSearchActive(true)}>
            <Text style={styles.searchIcon}>🔍</Text>
            <Text style={styles.searchPlaceholder}>{t("home.searchPlaceholder")}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.sortBtn} onPress={() => setSortModalVisible(true)}>
          <Text style={styles.sortBtnText}>
            {sortOrder === "recent" ? "🕐" : sortOrder === "name" ? "🔤" : "📦"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Category tab bar ───────────────────────────────────────────────── */}
      <View style={styles.catBarWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catBar}>
          {/* 전체 */}
          <TouchableOpacity
            style={[styles.catTab, selectedCat === DEFAULT_CATEGORY && styles.catTabActive]}
            onPress={() => setSelectedCat(DEFAULT_CATEGORY)}
          >
            <Text style={[styles.catTabText, selectedCat === DEFAULT_CATEGORY && styles.catTabTextActive]}>{t("home.allFolders")}</Text>
          </TouchableOpacity>

          {/* 즐겨찾기 */}
          <TouchableOpacity
            style={[styles.catTab, selectedCat === "__fav__" && styles.catTabActive]}
            onPress={() => setSelectedCat("__fav__")}
          >
            <Text style={[styles.catTabText, selectedCat === "__fav__" && styles.catTabTextActive]}>{t("home.favorites")}</Text>
          </TouchableOpacity>

          {/* 미분류 */}
          <TouchableOpacity
            style={[styles.catTab, selectedCat === "__uncat__" && styles.catTabActive]}
            onPress={() => setSelectedCat("__uncat__")}
          >
            <Text style={[styles.catTabText, selectedCat === "__uncat__" && styles.catTabTextActive]}>{t("home.uncat")}</Text>
          </TouchableOpacity>

          {/* Root categories */}
          {rootCategories.map((cat) => (
            <TouchableOpacity
              key={cat.id}
              style={[styles.catTab, selectedCat === cat.id && styles.catTabActive]}
              onPress={() => setSelectedCat(cat.id)}
              onLongPress={() =>
                Alert.alert(cat.name, undefined, [
                  { text: t("home.createSubfolder"), onPress: () => setCatNameModal({ visible: true, parentId: cat.id }) },
                  { text: t("home.rename"),           onPress: () => setCatNameModal({ visible: true, editId: cat.id }) },
                  { text: t("home.folderDelete"),     style: "destructive", onPress: () => deleteCategory(cat.id) },
                  { text: t("common.cancel"),         style: "cancel" },
                ])
              }
              delayLongPress={400}
            >
              <Text style={[styles.catTabText, selectedCat === cat.id && styles.catTabTextActive]}>
                📁 {cat.name}
              </Text>
            </TouchableOpacity>
          ))}

          {/* New folder button */}
          <TouchableOpacity style={styles.catTabNew} onPress={() => setCatNameModal({ visible: true })}>
          <Text style={styles.catTabNewText}>＋</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* ── Sub-category tabs (shown when a root folder is selected) ───────── */}
      {currentCatObj && !currentCatObj.parentId && subCategories.length > 0 && (
        <View style={styles.subCatBarWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subCatBar}>
            {/* Show parent-only files option */}
            <TouchableOpacity
              style={[styles.subCatTab, selectedCat === currentCatObj.id && styles.subCatTabActive]}
              onPress={() => setSelectedCat(currentCatObj.id)}
            >
              <Text style={[styles.subCatText, selectedCat === currentCatObj.id && styles.subCatTextActive]}>
                전체 ({recentFiles.filter((f) => {
                  const ids = [currentCatObj.id, ...subCategories.map((c) => c.id)];
                  return ids.includes(f.category ?? "");
                }).length})
              </Text>
            </TouchableOpacity>
            {subCategories.map((sub) => {
              const count = recentFiles.filter((f) => f.category === sub.id).length;
              return (
                <TouchableOpacity
                  key={sub.id}
                  style={[styles.subCatTab, selectedCat === sub.id && styles.subCatTabActive]}
                  onPress={() => setSelectedCat(sub.id)}
                  onLongPress={() =>
                    Alert.alert(sub.name, undefined, [
                      { text: t("home.rename"),       onPress: () => setCatNameModal({ visible: true, editId: sub.id }) },
                      { text: t("home.folderDelete"), style: "destructive", onPress: () => deleteCategory(sub.id) },
                      { text: t("common.cancel"),     style: "cancel" },
                    ])
                  }
                  delayLongPress={400}
                >
                  <Text style={[styles.subCatText, selectedCat === sub.id && styles.subCatTextActive]}>
                    📂 {sub.name} ({count})
                  </Text>
                </TouchableOpacity>
              );
            })}
            {/* Add sub-folder button */}
            <TouchableOpacity
              style={styles.subCatTabNew}
              onPress={() => setCatNameModal({ visible: true, parentId: currentCatObj.id })}
            >
              <Text style={styles.subCatTextNew}>＋</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {/* ── Multi-select action bar ─────────────────────────────────────────── */}
      {multiSelect && (
        <View style={styles.multiBar}>
          <Text style={styles.multiCount}>{t("home.selected", { count: selectedUris.size })}</Text>
          <TouchableOpacity style={styles.multiBtn} onPress={() => setBatchMoveVisible(true)} disabled={selectedUris.size === 0}>
            <Text style={styles.multiBtnText}>{t("home.moveBtn")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.multiBtn, styles.multiBtnDanger]} onPress={deleteSelected} disabled={selectedUris.size === 0}>
            <Text style={styles.multiBtnText}>{t("home.deleteBtn")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.multiBtn} onPress={() => { setMultiSelect(false); setSelectedUris(new Set()); }}>
            <Text style={styles.multiBtnText}>{t("common.cancel")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── File list ──────────────────────────────────────────────────────── */}
      {recentFiles.length > 0 && (
        <View style={styles.recentSection}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              {parentCatObj ? `📁 ${parentCatObj.name} › ` : ""}
              {currentCatObj ? `📁 ${currentCatObj.name}` :
               selectedCat === "__uncat__" ? t("home.uncat") :
               selectedCat === "__fav__"   ? t("home.favorites") : t("home.fileList")}
              <Text style={styles.fileCount}> {t("home.fileCount", { count: filteredFiles.length })}</Text>
            </Text>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              {!multiSelect && (
                <TouchableOpacity onPress={() => setMultiSelect(true)}>
                  <Text style={styles.multiSelectText}>{t("home.multiSelectBtn")}</Text>
                </TouchableOpacity>
              )}
              {filteredFiles.length > 0 && (
                <TouchableOpacity onPress={deleteAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.clearAllText}>{t("home.deleteAll")}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {filteredFiles.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>
                {searchQuery ? t("home.noSearchResult") : t("home.noFilesInFolder")}
              </Text>
              <Text style={styles.emptyHint}>{t("home.multiSelectHint")}</Text>
            </View>
          ) : (
            <FlatList
              data={filteredFiles}
              keyExtractor={(item) => item.uri}
              renderItem={renderFileItem}
              showsVerticalScrollIndicator={false}
              style={{ flex: 1 }}
              nestedScrollEnabled={true}
            />
          )}
        </View>
      )}

      {recentFiles.length === 0 && (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>{t("home.noFilesYet")}</Text>
          <Text style={styles.emptyHint}>{t("home.noFilesHint")}</Text>
        </View>
      )}

      {/* Bottom nav */}
      <View style={[styles.navButtons, { paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.navBtn} onPress={() => router.push("/models")}>
          <Text style={styles.navBtnText}>{t("home.modelManage")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBtn} onPress={() => router.push("/settings")}>
          <Text style={styles.navBtnText}>{t("home.settingsBtn")}</Text>
        </TouchableOpacity>
      </View>

      </View>{/* end flex space-between wrapper */}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      <LangSetupModal visible={langModalVisible} onConfirm={goToProcessing} onCancel={handleCancelModal} />

      {/* URL 입력 모달 (로컬 파일 + YouTube URL 지원) */}
      <UrlInputModal
        visible={filePickerVisible}
        onClose={() => setFilePickerVisible(false)}
        onLocalFilePicked={handleLocalFilePicked}
        onUrlPicked={handleUrlPicked}
      />

      <CategoryNameModal
        visible={catNameModal.visible}
        initial={catNameModal.editId ? (categories.find((c) => c.id === catNameModal.editId)?.name ?? "") : ""}
        parentName={catNameModal.parentId ? categories.find((c) => c.id === catNameModal.parentId)?.name : undefined}
        onConfirm={(name) => {
          if (catNameModal.editId) renameCategory(catNameModal.editId, name);
          else createCategory(name, catNameModal.parentId);
        }}
        onCancel={() => setCatNameModal({ visible: false })}
      />

      <CategoryNameModal
        visible={renameModal.visible}
        initial={renameModal.file?.name ?? ""}
        onConfirm={(name) => {
          if (renameModal.file) renameFile(renameModal.file.uri, name);
        }}
        onCancel={() => setRenameModal({ visible: false })}
      />

      <Modal
        visible={fileActionModal.visible}
        transparent
        animationType="slide"
        onRequestClose={() => setFileActionModal({ visible: false })}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}
          onPress={() => setFileActionModal({ visible: false })}
        >
          <Pressable
            style={{
              backgroundColor: "#1a1a1a",
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: 36,
              gap: 4,
            }}
            onPress={() => {}}
          >
            <Text style={{ color: "#888", fontSize: 13, textAlign: "center", marginBottom: 8 }}
              numberOfLines={1}>
              {fileActionModal.file?.name}
            </Text>

            {[
              { label: `📷  ${t("home.changeThumbnail")}`, onPress: () => { setFileActionModal({ visible: false }); pickManualThumbnail(fileActionModal.file!.uri); } },
              { label: `✏️  ${t("home.rename")}`,          onPress: () => { setFileActionModal({ visible: false }); setRenameModal({ visible: true, file: fileActionModal.file }); } },
              { label: `📁  ${t("home.moveFolder")}`,      onPress: () => { setFileActionModal({ visible: false }); setMoveModal({ visible: true, file: fileActionModal.file }); } },
            ].map((btn) => (
              <TouchableOpacity
                key={btn.label}
                style={{
                  paddingVertical: 16,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: "#2a2a2a",
                }}
                onPress={btn.onPress}
              >
                <Text style={{ color: "#fff", fontSize: 16 }}>{btn.label}</Text>
              </TouchableOpacity>
            ))}

            <TouchableOpacity
              style={{
                paddingVertical: 16,
                marginTop: 4,
                backgroundColor: "#222",
                borderRadius: 12,
                alignItems: "center",
              }}
              onPress={() => setFileActionModal({ visible: false })}
            >
              <Text style={{ color: "#aaa", fontSize: 16, fontWeight: "600" }}>{t("common.cancel")}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <MoveCategoryModal
        visible={moveModal.visible}
        categories={categories}
        currentCategory={moveModal.file?.category}
        onSelect={(catId) => { if (moveModal.file) moveFileToCategory(moveModal.file, catId); }}
        onCancel={() => setMoveModal({ visible: false })}
      />

      {/* Batch move modal */}
      <MoveCategoryModal
        visible={batchMoveVisible}
        categories={categories}
        currentCategory={undefined}
        onSelect={batchMoveToCategory}
        onCancel={() => setBatchMoveVisible(false)}
      />

      <SortModal
        visible={sortModalVisible}
        current={sortOrder}
        onSelect={(s) => { setSortOrder(s); setSortModalVisible(false); }}
        onCancel={() => setSortModalVisible(false)}
      />

      {/* ── 번역 재개 모달 ──────────────────────────────────────────────────── */}
      <Modal
        visible={!!resumeDialog?.visible}
        transparent
        animationType="fade"
        onRequestClose={handleResumeCancel}
      >
        <Pressable style={catModalStyles.backdrop} onPress={handleResumeCancel}>
          <Pressable style={[catModalStyles.card, { gap: 16 }]} onPress={() => {}}>
            <Text style={catModalStyles.title}>{t("home.resumeTitle")}</Text>
            <Text style={{ color: '#aaa', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
              {t("home.resumeMsg", { title: resumeDialog?.videoTitle })}
            </Text>
            <View style={catModalStyles.btnRow}>
              <TouchableOpacity style={catModalStyles.cancelBtn} onPress={handleResumeCancel}>
                <Text style={catModalStyles.cancelText}>{t("common.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={catModalStyles.confirmBtn} onPress={handleResume}>
                <Text style={catModalStyles.confirmText}>{t("home.resume")}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a", padding: 20, paddingTop: 8 },

  hero: { alignItems: "center", paddingVertical: 8 },
  appName: { color: "#fff", fontSize: 32, fontWeight: "bold" },
  tagline: { color: "#888", fontSize: 14, marginTop: 4 },

  pickButton: {
    backgroundColor: "#1e1e1e",
    borderRadius: 16,
    padding: 16,
    marginTop: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#333",
    borderStyle: "dashed",
  },
  pickIcon: { fontSize: 40, marginBottom: 8 },
  pickText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  pickSub: { color: "#666", fontSize: 12, marginTop: 4 },

  // ── Recently played ─────────────────────────────────────────────────────────
  recentPlaySection: { marginTop: 4 },
  recentPlayTitle: { color: "#666", fontSize: 11, fontWeight: "600", letterSpacing: 0.5, marginBottom: 4 },
  recentPlayRow: { flexDirection: "row", gap: 10 },
  recentPlayCard: { width: 64, gap: 3 },
  recentPlayName: { color: "#888", fontSize: 10, lineHeight: 13 },

  // ── Search ──────────────────────────────────────────────────────────────────
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  searchBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2563eb",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  searchBarInactive: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2a2a2a",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  searchIcon: { fontSize: 14 },
  searchInput: { flex: 1, color: "#fff", fontSize: 14, padding: 0 },
  searchClear: { color: "#555", fontSize: 14, paddingLeft: 4 },
  searchPlaceholder: { color: "#444", fontSize: 14 },
  sortBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    alignItems: "center",
    justifyContent: "center",
  },
  sortBtnText: { fontSize: 18 },

  // ── Category tabs ───────────────────────────────────────────────────────────
  catBarWrap: { marginTop: 8 },
  catBar: { flexDirection: "row", gap: 8, paddingBottom: 4 },
  catTab: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  catTabActive: { backgroundColor: "#1e3a5f", borderColor: "#2563eb" },
  catTabText: { color: "#666", fontSize: 13, fontWeight: "600" },
  catTabTextActive: { color: "#60a5fa" },
  catTabNew: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    borderStyle: "dashed",
  },
  catTabNewText: { color: "#444", fontSize: 13, fontWeight: "600" },

  // ── Sub-category tabs ───────────────────────────────────────────────────────
  subCatBarWrap: { marginTop: 8 },
  subCatBar: { flexDirection: "row", gap: 6, paddingBottom: 4, paddingLeft: 8 },
  subCatTab: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#222",
  },
  subCatTabActive: { backgroundColor: "#1a2d4a", borderColor: "#3b82f6" },
  subCatText: { color: "#555", fontSize: 12, fontWeight: "600" },
  subCatTextActive: { color: "#93c5fd" },
  subCatTabNew: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#222",
    borderStyle: "dashed",
  },
  subCatTextNew: { color: "#333", fontSize: 14, fontWeight: "600" },

  // ── Multi-select bar ────────────────────────────────────────────────────────
  multiBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1a2e",
    borderRadius: 12,
    marginTop: 10,
    padding: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: "#2563eb44",
  },
  multiCount: { color: "#60a5fa", fontSize: 13, fontWeight: "600", flex: 1 },
  multiBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: "#1e3a5f",
  },
  multiBtnDanger: { backgroundColor: "#3f0000" },
  multiBtnText: { color: "#fff", fontSize: 12, fontWeight: "600" },

  // ── File list ───────────────────────────────────────────────────────────────
  recentSection: { marginTop: 4, flex: 2 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  sectionTitle: { color: "#aaa", fontSize: 13, fontWeight: "600", letterSpacing: 0.5 },
  fileCount: { color: "#555", fontWeight: "400" },
  clearAllText: { color: "#ef4444", fontSize: 12, fontWeight: "600" },
  multiSelectText: { color: "#60a5fa", fontSize: 12, fontWeight: "600" },

  recentItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1e1e1e",
  },
  recentItemSelected: {
    backgroundColor: "#1e3a5f22",
    borderRadius: 8,
    paddingHorizontal: 6,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#444",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  checkboxMark: { color: "#fff", fontSize: 12, fontWeight: "700" },

  recentName: { color: "#ddd", fontSize: 13, fontWeight: "500", flex: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  metaText: { color: "#555", fontSize: 11 },
  langTag: {
    color: "#4a9eff",
    fontSize: 10,
    fontWeight: "700",
    backgroundColor: "#1a2d4a",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  recentCatBadge: { color: "#555", fontSize: 11, marginTop: 2 },
  starIcon: { color: "#f59e0b", fontSize: 12 },

  itemActions: { flexDirection: "row", gap: 6, alignItems: "center" },
  actionIcon: { fontSize: 18, color: "#555" },
  starActive: { color: "#f59e0b" },

  emptyBox: { paddingVertical: 40, alignItems: "center", gap: 8 },
  emptyText: { color: "#444", fontSize: 14 },
  emptyHint: { color: "#333", fontSize: 12 },

  navButtons: { flexDirection: "row", gap: 12, paddingTop: 8 },
  navBtn: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
  },
  navBtnText: { color: "#ccc", fontSize: 13 },
});

const bannerStyles = StyleSheet.create({
  modelCard: {
    backgroundColor: "#1a1200",
    borderWidth: 1,
    borderColor: "#f59e0b",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 8,
  },
  modelCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modelCardTitle: { fontSize: 13, fontWeight: "700", color: "#f59e0b" },
  modelCardAction: { fontSize: 13, fontWeight: "700", color: "#f59e0b" },
  modelCardDivider: { height: 1, backgroundColor: "#2a2000", marginVertical: 6 },
  modelCardRow: { flexDirection: "row", alignItems: "center", paddingVertical: 5 },
  modelCardRowText: { fontSize: 12, color: "#a16207" },
});

const modalStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#111",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 36,
    gap: 12,
  },
  title: { color: "#fff", fontSize: 18, fontWeight: "700", textAlign: "center" },
  subtitle: { color: "#666", fontSize: 13, textAlign: "center", marginBottom: 4 },
  langList: {
    maxHeight: 260,
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  langOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a2a",
    gap: 8,
  },
  langOptionSelected: { backgroundColor: "#1e3a5f" },
  langOptionNative: { color: "#fff", fontSize: 14, flex: 1 },
  langOptionCode: { color: "#555", fontSize: 12 },
  checkmark: { color: "#2563eb", fontSize: 15, fontWeight: "700" },
  hint: { color: "#444", fontSize: 12, textAlign: "center", marginTop: 4 },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  cancelBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12,
    backgroundColor: "#1a1a1a", alignItems: "center",
    borderWidth: 1, borderColor: "#2a2a2a",
  },
  cancelBtnText: { color: "#888", fontSize: 15 },
  confirmBtn: {
    flex: 2, paddingVertical: 14, borderRadius: 12,
    backgroundColor: "#2563eb", alignItems: "center",
  },
  confirmBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});

const catModalStyles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center", paddingHorizontal: 32,
  },
  card: {
    backgroundColor: "#1a1a1a", borderRadius: 16,
    padding: 20, gap: 14, borderWidth: 1, borderColor: "#2a2a2a",
  },
  title: { color: "#fff", fontSize: 16, fontWeight: "700", textAlign: "center" },
  input: {
    backgroundColor: "#111", borderRadius: 10, borderWidth: 1.5,
    borderColor: "#2563eb", color: "#fff", fontSize: 16,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  btnRow: { flexDirection: "row", gap: 10 },
  cancelBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    backgroundColor: "#222", alignItems: "center",
  },
  cancelText: { color: "#888", fontSize: 14, fontWeight: "600" },
  confirmBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    backgroundColor: "#2563eb", alignItems: "center",
  },
  confirmDisabled: { opacity: 0.35 },
  confirmText: { color: "#fff", fontSize: 14, fontWeight: "700" },
});

const moveStyles = StyleSheet.create({
  option: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#2a2a2a", gap: 10,
  },
  childOption: { paddingLeft: 32, backgroundColor: "#0f0f0f" },
  optionActive: { backgroundColor: "#1e3a5f" },
  optionIcon: { fontSize: 18 },
  optionName: { color: "#ddd", fontSize: 15, flex: 1 },
  check: { color: "#2563eb", fontSize: 15, fontWeight: "700" },
  cancelBtn: { margin: 16, paddingVertical: 13, borderRadius: 10, backgroundColor: "#222", alignItems: "center" },
  cancelText: { color: "#aaa", fontSize: 14, fontWeight: "600" },
});