import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  Modal,
  ScrollView,
  Pressable,
  TextInput,
  Animated,
  ActivityIndicator,
  Dimensions,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { router } from "expo-router";
import { deleteSubtitleCache } from "../services/subtitleDB";
import { pendingSubtitleRef } from "../utils/pendingSubtitle";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { usePlanStore } from "../store/usePlanStore";
import { LANGUAGES } from "../constants/languages";
import { UrlInputModal } from "../components/UrlInputModal";
import { DirectPlayModal } from "../components/DirectPlayModal";
import {
  Camera, Film, Settings, FolderOpen, Folder, Package,
  Clock, CaseSensitive, Search, Star, Check, X,
  Pencil, Play,
} from 'lucide-react-native';

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
  category?: string;
  addedAt: number;
  duration?: number;
  fileSize?: number;
  thumbnailUri?: string;
  subtitleStatus?: SubtitleStatus;
  subtitlePercent?: number;
  language?: string;
  targetLanguage?: string;
  isFavorite?: boolean;
  lastPlayedAt?: number;
}

export interface Category {
  id: string;
  name: string;
  parentId?: string;
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

function localCacheKey(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const parts = decoded.replace(/\\/g, "/").split("/");
    return "local__" + (parts[parts.length - 1] ?? uri);
  } catch {
    return "local__" + uri;
  }
}

async function deleteSubtitleCacheForUri(uri: string): Promise<void> {
  try {
    const cacheKey = localCacheKey(uri);
    const allKeys = await AsyncStorage.getAllKeys();
    const toRemove = allKeys.filter(
      (k) =>
        (k.startsWith("realtimesub_cache_") && k.includes(cacheKey)) ||
        k === `gemma_checkpoint_v4_${cacheKey}` ||
        k === `fg_fetched_subtitles_${cacheKey}`
    );
    if (toRemove.length > 0) {
      await AsyncStorage.multiRemove(toRemove);
    }
    await deleteSubtitleCache(cacheKey);
    console.log("[CACHE] Cleaned subtitle cache for:", cacheKey);
  } catch (e) {
    console.warn("[CACHE] Could not clean subtitle cache for:", uri, e);
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

async function fetchThumbnail(
  uri: string,
  durationSec?: number,
): Promise<string | null> {
  if (!getThumbnailAsync) return null;
  if (thumbCache[uri]) return thumbCache[uri];

  const safeUri = uri.startsWith("file://") || uri.startsWith("http")
    ? uri
    : "file://" + uri;

  const candidates: number[] = [];
  if (durationSec && durationSec > 0) {
    const tenPct = Math.max(Math.floor(durationSec * 0.1) * 1000, 3000);
    candidates.push(tenPct);
  }
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
  const { t } = useTranslation();
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

  if (loading) {
    return (
      <View style={thumbStyles.wrap}>
        <View style={thumbStyles.skeleton} />
        <ActivityIndicator size="small" color="#444" style={{ position: "absolute" }} />
      </View>
    );
  }

  if (thumb) {
    return (
      <View style={thumbStyles.wrap}>
        <Animated.Image
          source={{ uri: thumb }}
          style={[thumbStyles.img, { opacity: fadeAnim }]}
          resizeMode="cover"
        />
        <View style={thumbStyles.playOverlay} pointerEvents="none">
          <Text style={thumbStyles.playIcon}>▶</Text>
        </View>
        <TouchableOpacity
          style={thumbStyles.camBadge}
          onPress={onPickManual}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          activeOpacity={0.7}
        >
          <Camera size={18} color="#aaa" />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={[thumbStyles.wrap, thumbStyles.wrapEmpty]}
      onPress={onPickManual}
      activeOpacity={0.7}
    >
      <Film size={32} color="#555" />
      <Text style={thumbStyles.emptyLabel}>{t("home.addPhoto")}</Text>
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
  camBadge: {
    position: "absolute",
    bottom: 3,
    right: 3,
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  emptyLabel: { color: "#444", fontSize: 9, fontWeight: "600", letterSpacing: 0.2 },
});

function SubBadge({ status, percent }: { status?: SubtitleStatus; percent?: number }) {
  const { t } = useTranslation();
  if (!status || status === "none") return null;
  if (status === "processing") {
    return (
      <View style={[badgeStyles.badge, badgeStyles.processing]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Settings size={18} color="#ccc" />
          <Text style={badgeStyles.text}>{percent ?? 0}%</Text>
        </View>
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
  processing: { backgroundColor: "#f0997b22", borderWidth: 1, borderColor: "#f0997b" },
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
                  {isSelected && <Check size={14} color="#2563eb" />}
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
              <FolderOpen size={20} color="#aaa" />
              <Text style={moveStyles.optionName}>{t("home.uncat")}</Text>
              {!currentCategory && <Check size={14} color="#2563eb" />}
            </TouchableOpacity>
            {roots.map((cat) => {
              const children = categories.filter((c) => c.parentId === cat.id);
              return (
                <React.Fragment key={cat.id}>
                  <TouchableOpacity
                    style={[moveStyles.option, currentCategory === cat.id && moveStyles.optionActive]}
                    onPress={() => onSelect(cat.id)}
                  >
                    <Folder size={16} color="#aaa" />
                    <Text style={moveStyles.optionName}>{cat.name}</Text>
                    {currentCategory === cat.id && <Check size={14} color="#2563eb" />}
                  </TouchableOpacity>
                  {children.map((child) => (
                    <TouchableOpacity
                      key={child.id}
                      style={[moveStyles.option, moveStyles.childOption, currentCategory === child.id && moveStyles.optionActive]}
                      onPress={() => onSelect(child.id)}
                    >
                      <FolderOpen size={20} color="#aaa" />
                      <Text style={moveStyles.optionName}>{child.name}</Text>
                      {currentCategory === child.id && <Check size={14} color="#2563eb" />}
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
  const options: { key: SortOrder; label: string; icon: React.ReactNode }[] = [
    { key: "recent", label: t("home.sortRecent"), icon: <Clock size={14} color="#aaa" /> },
    { key: "name",   label: t("home.sortName"),   icon: <CaseSensitive size={14} color="#aaa" /> },
    { key: "size",   label: t("home.sortSize"),   icon: <Package size={14} color="#aaa" /> },
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
              {o.icon}
              <Text style={moveStyles.optionName}>{o.label}</Text>
              {current === o.key && <Check size={14} color="#2563eb" />}
            </TouchableOpacity>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── HomeScreen ────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const CARD_WIDTH = (Dimensions.get("window").width - 20 * 2 - 10) / 2;
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [recentFiles,      setRecentFiles]      = useState<RecentFile[]>([]);
  const [categories,       setCategories]       = useState<Category[]>([]);
  const [selectedCat,      setSelectedCat]      = useState<string>(DEFAULT_CATEGORY);
  const [langModalVisible, setLangModalVisible] = useState(false);
  const [filePickerVisible,  setFilePickerVisible]  = useState(false);
  // ── 새로 추가: 바로보기 모드 모달 ─────────────────────────────────────────
  const [directPlayVisible, setDirectPlayVisible] = useState(false);
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

  const setVideo = usePlayerStore((s) => s.setVideo);
  const setYoutubeVideo = usePlayerStore((s) => s.setYoutubeVideo);
  const setPendingGenre = usePlayerStore((s) => s.setPendingGenre);
  const setDirectMode = usePlayerStore((s) => s.setDirectMode);
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
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(t("home.permissionRequired"), t("home.galleryPermissionMsg"), [
          { text: t("common.confirm") },
        ]);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [3, 2],
        quality: 0.8,
      });
      if (result.canceled || !result.assets[0]) return;
      const picked = result.assets[0].uri;
      const cacheDir = FileSystem.cacheDirectory + "thumbs/";
      await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
      const dest = cacheDir + Date.now() + ".jpg";
      await FileSystem.copyAsync({ from: picked, to: dest });
      thumbCache[fileUri] = dest;
      setRecentFiles((prev) =>
        prev.map((f) => f.uri === fileUri ? { ...f, thumbnailUri: dest } : f)
      );
    } catch (e) {
      Alert.alert(t("common.error"), t("home.thumbnailSetFailed", { error: String(e) }));
    }
  }, [t]);

  // ── File open helpers ──────────────────────────────────────────────────────

  const goToProcessing = useCallback(() => {
    setLangModalVisible(false);
    if (pendingSubtitleRef.current) {
      router.push("/player");
    } else {
      router.push("/processing");
    }
  }, []);

  const handleCancelModal = useCallback(() => {
    setLangModalVisible(false);
    pendingFileRef.current = null;
    pendingSubtitleRef.current = null;
  }, []);

  // ── 번역 모드: 로컬 파일 선택 후 처리 ────────────────────────────────────
  const handleLocalFilePicked = async (stableUri: string, name: string, genre: string, subtitleUri?: string, duration?: number) => {
    // Free plan: block videos longer than 10 minutes in translate mode
    const currentTier = usePlanStore.getState().tier;
    if (currentTier === 'free' && duration != null && duration > 600) {
      Alert.alert(
        t('pricing.freeDurationLimitTitle'),
        t('pricing.freeDurationLimitMsg'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('plan.viewPlans'), onPress: () => router.push('/pricing') },
        ]
      );
      return;
    }
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
    pendingSubtitleRef.current = subtitleUri ?? null;
    setPendingGenre(genre);
    setVideo(stableUri, name);
    pendingFileRef.current = { uri: stableUri, name };
    setLangModalVisible(true);
  };

  // ── 번역 모드: URL(YouTube) 선택 후 처리 ─────────────────────────────────
  const handleUrlPicked = (videoId: string, title: string, isYoutube: boolean, genre?: string, subtitleUri?: string) => {
    if (isYoutube) {
      if (subtitleUri) {
        pendingSubtitleRef.current = subtitleUri;
      }
      setPendingGenre(genre ?? 'general');
      setYoutubeVideo(videoId, title);
      setTimeout(() => router.push("/youtube-player"), 0);
    }
  };

  // ── 바로보기 모드: 로컬 파일 선택 후 번역 없이 바로 플레이어 진입 ────────
  const handleDirectLocalFilePicked = async (
    stableUri: string,
    name: string,
    genre: string,
    subtitleUri?: string,
  ) => {
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

    // 자막이 있으면 적용, 없으면 null (번역 없이 그냥 재생)
    pendingSubtitleRef.current = subtitleUri ?? null;
    setVideo(stableUri, name);
    pendingFileRef.current = { uri: stableUri, name };

    // 번역 과정(processing) 없이 바로 플레이어로
    router.push("/player");
  };

  // ── 바로보기 모드: URL(YouTube) 선택 후 번역 없이 바로 플레이어 진입 ─────
  const handleDirectUrlPicked = (
    videoId: string,
    title: string,
    genre: string,
    subtitleUri?: string,
  ) => {
    if (subtitleUri) {
      pendingSubtitleRef.current = subtitleUri;
    } else {
      pendingSubtitleRef.current = null;
    }
    setDirectMode(true);
    setYoutubeVideo(videoId, title);
    setTimeout(() => router.push("/youtube-player"), 0);
  };

  const handleResume = useCallback(() => {
    if (!resumeDialog) return;
    setResumeDialog(null);
    setYoutubeVideo(resumeDialog.videoId, resumeDialog.videoTitle);
    router.push('/youtube-player');
  }, [resumeDialog, setYoutubeVideo]);

  const handleResumeCancel = useCallback(async () => {
    setResumeDialog(null);
    await AsyncStorage.removeItem('bg_translation_pending_task').catch(() => {});
  }, []);

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
    pendingSubtitleRef.current = null;
    // Free plan: block videos longer than 10 minutes in translate mode
    const currentTier = usePlanStore.getState().tier;
    if (currentTier === 'free' && file.duration != null && file.duration > 600) {
      Alert.alert(
        t('pricing.freeDurationLimitTitle'),
        t('pricing.freeDurationLimitMsg'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('plan.viewPlans'), onPress: () => router.push('/pricing') },
        ]
      );
      return;
    }
    setLangModalVisible(true);
  };

  const deleteOne = useCallback((uri: string) => {
    Alert.alert(t("home.deleteFile"), t("home.deleteFileMsg"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.confirm"), style: "destructive", onPress: async () => {
          await deleteFileFromDisk(uri);
          await deleteSubtitleCacheForUri(uri);
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
          await Promise.all(targets.map((f) => deleteSubtitleCacheForUri(f.uri)));
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
          await Promise.all([...selectedUris].map((uri) => deleteSubtitleCacheForUri(uri)));
          setRecentFiles((prev) => prev.filter((f) => !selectedUris.has(f.uri)));
          setSelectedUris(new Set());
          setMultiSelect(false);
        },
      },
    ]);
  };

  const handleLongPress = useCallback((file: RecentFile) => {
    if (multiSelect) return;
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

  const subCategories = categories.filter((c) => c.parentId === selectedCat);
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
        {multiSelect && (
          <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
            {isSelected && <Check size={14} color="#fff" />}
          </View>
        )}

        <FileThumbnail
          uri={item.uri}
          thumbUri={item.thumbnailUri}
          duration={item.duration}
          onPickManual={() => pickManualThumbnail(item.uri)}
        />

        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {item.isFavorite && <Star size={14} color="#f59e0b" fill="#f59e0b" />}
            <Text style={styles.recentName} numberOfLines={1}>{item.name}</Text>
          </View>

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

          <SubBadge status={item.subtitleStatus} percent={item.subtitlePercent} />

          {catName && selectedCat === DEFAULT_CATEGORY && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
              <Folder size={16} color="#aaa" />
              <Text style={styles.recentCatBadge}>{catName}</Text>
            </View>
          )}
        </View>

        {!multiSelect && (
          <View style={styles.itemActions}>
            <TouchableOpacity
              onPress={() => toggleFavorite(item.uri)}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              {item.isFavorite
                ? <Star size={14} color="#f59e0b" fill="#f59e0b" />
                : <Star size={14} color="#555" />}
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

        {/* ── 분할 버튼: 번역 모드 / 바로보기 모드 ─────────────────────────── */}
        <View style={styles.pickButtonRow}>

          <TouchableOpacity
            style={[styles.modeCard, styles.modeCardLeft, { width: CARD_WIDTH }]}
            onPress={() => setFilePickerVisible(true)}
            activeOpacity={0.85}
          >
            <View style={styles.modeIconBox}>
              <CaseSensitive size={18} color="#60a5fa" />
            </View>
            <Text style={styles.modeCardTitle}>{t("home.translateMode")}</Text>
            <Text style={styles.modeCardDesc}>{t("home.translateModeDesc")}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeCard, styles.modeCardRight, { width: CARD_WIDTH }]}
            onPress={() => setDirectPlayVisible(true)}
            activeOpacity={0.85}
          >
            <View style={[styles.modeIconBox, styles.modeIconBoxRight]}>
              <Play size={18} color="#a78bfa" />
            </View>
            <Text style={styles.modeCardTitle}>{t("home.directMode")}</Text>
            <Text style={styles.modeCardDesc}>{t("home.directModeDesc")}</Text>
          </TouchableOpacity>

        </View>

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
              <Search size={16} color="#555" />
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
                <X size={14} color="#888" />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.searchBarInactive} onPress={() => setSearchActive(true)}>
              <Search size={16} color="#555" />
              <Text style={styles.searchPlaceholder}>{t("home.searchPlaceholder")}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.sortBtn} onPress={() => setSortModalVisible(true)}>
            {sortOrder === "recent"
              ? <Clock size={14} color="#aaa" />
              : sortOrder === "name"
              ? <CaseSensitive size={14} color="#aaa" />
              : <Package size={14} color="#aaa" />}
          </TouchableOpacity>
        </View>

        {/* ── Category tab bar ───────────────────────────────────────────────── */}
        <View style={styles.catBarWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catBar}>
            <TouchableOpacity
              style={[styles.catTab, selectedCat === DEFAULT_CATEGORY && styles.catTabActive]}
              onPress={() => setSelectedCat(DEFAULT_CATEGORY)}
            >
              <Text style={[styles.catTabText, selectedCat === DEFAULT_CATEGORY && styles.catTabTextActive]}>{t("home.allFolders")}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.catTab, selectedCat === "__fav__" && styles.catTabActive]}
              onPress={() => setSelectedCat("__fav__")}
            >
              <Text style={[styles.catTabText, selectedCat === "__fav__" && styles.catTabTextActive]}>{t("home.favorites")}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.catTab, selectedCat === "__uncat__" && styles.catTabActive]}
              onPress={() => setSelectedCat("__uncat__")}
            >
              <Text style={[styles.catTabText, selectedCat === "__uncat__" && styles.catTabTextActive]}>{t("home.uncat")}</Text>
            </TouchableOpacity>

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
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Folder size={16} color="#aaa" />
                  <Text style={[styles.catTabText, selectedCat === cat.id && styles.catTabTextActive]}>{cat.name}</Text>
                </View>
              </TouchableOpacity>
            ))}

            <TouchableOpacity style={styles.catTabNew} onPress={() => setCatNameModal({ visible: true })}>
              <Text style={styles.catTabNewText}>＋</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>

        {/* ── Sub-category tabs ───────────────────────────────────────────────── */}
        {currentCatObj && !currentCatObj.parentId && subCategories.length > 0 && (
          <View style={styles.subCatBarWrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subCatBar}>
              <TouchableOpacity
                style={[styles.subCatTab, selectedCat === currentCatObj.id && styles.subCatTabActive]}
                onPress={() => setSelectedCat(currentCatObj.id)}
              >
                <Text style={[styles.subCatText, selectedCat === currentCatObj.id && styles.subCatTextActive]}>
                  {t("home.allWithCount", { count: recentFiles.filter((f) => {
                    const ids = [currentCatObj.id, ...subCategories.map((c) => c.id)];
                    return ids.includes(f.category ?? "");
                  }).length })}
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
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <FolderOpen size={20} color="#aaa" />
                      <Text style={[styles.subCatText, selectedCat === sub.id && styles.subCatTextActive]}>{sub.name} ({count})</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
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
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}>
                {parentCatObj && (
                  <>
                    <Folder size={16} color="#aaa" />
                    <Text style={styles.sectionTitle}>{parentCatObj.name} › </Text>
                  </>
                )}
                {currentCatObj && <Folder size={16} color="#aaa" />}
                <Text style={styles.sectionTitle}>
                  {currentCatObj ? currentCatObj.name :
                   selectedCat === "__uncat__" ? t("home.uncat") :
                   selectedCat === "__fav__"   ? t("home.favorites") : t("home.fileList")}
                  <Text style={styles.fileCount}> {t("home.fileCount", { count: filteredFiles.length })}</Text>
                </Text>
              </View>
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
          <TouchableOpacity style={styles.navBtn} onPress={() => router.push("/pricing")}>
            <Text style={styles.navBtnText}>{t("home.pricingBtn")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.navBtn} onPress={() => router.push("/settings")}>
            <Text style={styles.navBtnText}>{t("home.settingsBtn")}</Text>
          </TouchableOpacity>
        </View>

      </View>{/* end flex space-between wrapper */}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      <LangSetupModal visible={langModalVisible} onConfirm={goToProcessing} onCancel={handleCancelModal} />

      {/* 번역 모드 모달 (장르 선택 + URL탭 자막칸 없음) */}
      <UrlInputModal
        visible={filePickerVisible}
        onClose={() => setFilePickerVisible(false)}
        onLocalFilePicked={handleLocalFilePicked}
        onUrlPicked={handleUrlPicked}
      />

      {/* 바로보기 모드 모달 (자막 선택 가능 + 바로 플레이어 진입) */}
      <DirectPlayModal
        visible={directPlayVisible}
        onClose={() => setDirectPlayVisible(false)}
        onLocalFilePicked={handleDirectLocalFilePicked}
        onUrlPicked={handleDirectUrlPicked}
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
            {[
              { key: "thumb",  icon: <Camera size={18} color="#ccc" />,   label: t("home.changeThumbnail"), onPress: () => { setFileActionModal({ visible: false }); pickManualThumbnail(fileActionModal.file!.uri); } },
              { key: "rename", icon: <Pencil size={16} color="#aaa" />,    label: t("home.rename"),          onPress: () => { setFileActionModal({ visible: false }); setRenameModal({ visible: true, file: fileActionModal.file }); } },
              { key: "move",   icon: <Folder size={16} color="#aaa" />,   label: t("home.moveFolder"),      onPress: () => { setFileActionModal({ visible: false }); setMoveModal({ visible: true, file: fileActionModal.file }); } },
            ].map((btn) => (
              <TouchableOpacity
                key={btn.key}
                style={{
                  paddingVertical: 16,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: "#2a2a2a",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                }}
                onPress={btn.onPress}
              >
                {btn.icon}
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

  // ── 분할 버튼 ────────────────────────────────────────────────────────────────
  pickButtonRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  modeCard: {
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    gap: 6,
  },
  modeCardLeft: {
    backgroundColor: "#0d1829",
    borderColor: "#2563eb44",
  },
  modeCardRight: {
    backgroundColor: "#0e0a1e",
    borderColor: "#7c3aed44",
  },
  modeIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#162a45",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  modeIconBoxRight: {
    backgroundColor: "#231545",
  },
  modeCardTitle: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  modeCardDesc: {
    color: "#6b7280",
    fontSize: 10,
    lineHeight: 14,
  },

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
  searchInput: { flex: 1, color: "#fff", fontSize: 14, padding: 0 },
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

  itemActions: { flexDirection: "row", gap: 6, alignItems: "center" },
  actionIcon: { fontSize: 18, color: "#555" },

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
  optionName: { color: "#ddd", fontSize: 15, flex: 1 },
  cancelBtn: { margin: 16, paddingVertical: 13, borderRadius: 10, backgroundColor: "#222", alignItems: "center" },
  cancelText: { color: "#aaa", fontSize: 14, fontWeight: "600" },
});