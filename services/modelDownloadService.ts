import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface MirrorEntry {
  repo: string;
  file: string;
}

const MIRROR_REPOS: MirrorEntry[] = [
  {
    repo: "bartowski/google_gemma-3n-E2B-it-GGUF",
    file: "google_gemma-3n-E2B-it-Q4_K_M.gguf",
  },
  {
    repo: "unsloth/gemma-3n-E2B-it-GGUF",
    file: "gemma-3n-E2B-it-Q4_K_M.gguf",
  },
  {
    repo: "google/gemma-3n-E2B-it-GGUF",
    file: "gemma-3n-E2B-it-Q4_K_M.gguf",
  },
];

const HF_BASE          = "https://huggingface.co";
const HF_API_BASE      = "https://huggingface.co/api";
const META_STORAGE_KEY = "gemma_model_meta";
const DEST_DIR              = FileSystem.documentDirectory + "gemma-models/";
export const DEST_PATH      = DEST_DIR + "gemma-3n-e2b-q4.gguf";

export interface ResolvedUrl {
  url: string;
  expectedSize: number;
  sha256: string;
}

export interface ModelMeta {
  size: number;
  sha256: string;
  downloadedAt: number;
  sourceUrl: string;
}

export interface DownloadProgress {
  bytesWritten: number;
  bytesTotal: number;
  fraction: number;
}

export async function resolveModelDownloadUrl(): Promise<ResolvedUrl> {
  const errors: string[] = [];

  for (const mirror of MIRROR_REPOS) {
    try {
      const treeUrl  = `${HF_API_BASE}/models/${mirror.repo}/tree/main`;
      const treeResp = await fetch(treeUrl, { method: "GET" });

      if (!treeResp.ok) {
        errors.push(`[${mirror.repo}] tree API ${treeResp.status}`);
        continue;
      }

      const tree: Array<{
        path: string;
        lfs?: { size: number; oid: string; pointerSize: number };
      }> = await treeResp.json();

      const entry = tree.find((f) => f.path === mirror.file);
      if (!entry) {
        errors.push(`[${mirror.repo}] file not found in tree`);
        continue;
      }

      if (!entry.lfs?.size || !entry.lfs?.oid) {
        errors.push(`[${mirror.repo}] LFS metadata missing`);
        continue;
      }

      const expectedSize = entry.lfs.size;
      const sha256       = entry.lfs.oid;
      const downloadUrl  = `${HF_BASE}/${mirror.repo}/resolve/main/${mirror.file}`;
      const headResp = await fetch(downloadUrl, { method: "HEAD", redirect: "manual" });

      if (headResp.status === 200) {
        return { url: downloadUrl, expectedSize, sha256 };
      }

      if (headResp.status === 302) {
        const location = headResp.headers.get("location");
        if (!location) {
          errors.push(`[${mirror.repo}] 302 but no location header`);
          continue;
        }
        const confirmResp = await fetch(location, { method: "HEAD", redirect: "manual" });
        if (confirmResp.status !== 200) {
          errors.push(`[${mirror.repo}] final URL HEAD ${confirmResp.status}`);
          continue;
        }
        return { url: location, expectedSize, sha256 };
      }

      errors.push(`[${mirror.repo}] HEAD ${headResp.status}`);
    } catch (e) {
      errors.push(`[${mirror.repo}] ${String(e)}`);
    }
  }

  throw new Error(`모든 미러에서 모델을 찾을 수 없습니다.\n${errors.join("\n")}`);
}

export async function downloadGemmaModel(
  onProgress?: (progress: DownloadProgress) => void,
  onResumable?: (resumable: FileSystem.DownloadResumable) => void,
): Promise<void> {
  const { url, expectedSize, sha256 } = await resolveModelDownloadUrl();

  await FileSystem.makeDirectoryAsync(DEST_DIR, { intermediates: true });

  const existingInfo = await FileSystem.getInfoAsync(DEST_PATH) as any;

  if (existingInfo.exists) {
    const existingSize = existingInfo.size ?? 0;
    // FIX: expo-file-system returns size=0 for files >2GB on Android (int overflow).
    // Only skip download if size is a positive exact match.
    if (existingSize > 0 && existingSize === expectedSize) {
      console.log("[ModelDownload] Model already present, skipping download.");
      return;
    }
    console.log(`[ModelDownload] Removing existing file (size=${existingSize}), re-downloading.`);
    await FileSystem.deleteAsync(DEST_PATH, { idempotent: true });
  }

  console.log(`[ModelDownload] Starting download from: ${url}`);

  const resumable = FileSystem.createDownloadResumable(
    url,
    DEST_PATH,
    {},
    (downloadProgress) => {
      const { totalBytesWritten, totalBytesExpectedToWrite } = downloadProgress;
      const fraction =
        totalBytesExpectedToWrite > 0
          ? totalBytesWritten / totalBytesExpectedToWrite
          : 0;
      onProgress?.({
        bytesWritten: totalBytesWritten,
        bytesTotal:   totalBytesExpectedToWrite,
        fraction,
      });
    }
  );
  onResumable?.(resumable);

  const result = await resumable.downloadAsync();
  if (!result?.uri) throw new Error("[ModelDownload] Download returned no URI.");

  // FIX: Skip size check — getInfoAsync returns 0 for large files on Android.
  // Trust downloadAsync success as confirmation.
  const meta: ModelMeta = {
    size:         expectedSize,
    sha256,
    downloadedAt: Date.now(),
    sourceUrl:    url,
  };
  await AsyncStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
  console.log("[ModelDownload] Download complete.", meta);
}

export async function getLocalModelPath(): Promise<string | null> {
  const info = await FileSystem.getInfoAsync(DEST_PATH);
  return info.exists ? DEST_PATH : null;
}

export async function getModelMeta(): Promise<ModelMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(META_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ModelMeta) : null;
  } catch {
    return null;
  }
}

export async function deleteGemmaModel(): Promise<void> {
  await FileSystem.deleteAsync(DEST_PATH, { idempotent: true });
  await AsyncStorage.removeItem(META_STORAGE_KEY);
  console.log("[ModelDownload] Model deleted.");
}