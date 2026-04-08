/**
 * subtitleSaveService.ts
 *
 * Saves translated subtitles to the device in SRT or plain-text format,
 * then opens the system share sheet so the user can send the file to
 * Downloads, Google Drive, KakaoTalk, etc.
 *
 * Dependencies (all bundled with Expo SDK — no extra install needed):
 *   expo-file-system   — read/write to sandboxed document directory (new class-based API)
 *   expo-sharing       — native share sheet for files
 */

import { File, Directory, Paths } from "expo-file-system";
import { StorageAccessFramework } from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// ── Type definitions ──────────────────────────────────────────────────────────

export interface SaveableSubtitle {
  startTime:  number;
  endTime:    number;
  original:   string;
  translated: string;
}

export type SubtitleFormat = "srt" | "txt" | "bilingual_srt";

export type SaveMode = "share" | "download" | "both";

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Formats a time value in seconds to the HH:MM:SS,mmm format required by SRT.
 */
function toSrtTime(seconds: number): string {
  const h  = Math.floor(seconds / 3600);
  const m  = Math.floor((seconds % 3600) / 60);
  const s  = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return (
    `${String(h).padStart(2, "0")}:` +
    `${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}

/**
 * Replaces characters that are illegal or problematic in filenames with "_".
 * Trims leading/trailing whitespace and collapses consecutive underscores.
 */
function sanitizeFilename(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/_+/g, "_")
    .substring(0, 80); // cap length so paths stay reasonable
}

// ── Exported generators ───────────────────────────────────────────────────────

/**
 * Builds SRT file content from an array of subtitles.
 *
 * @param subtitles - Array of subtitle segments (must be sorted by startTime).
 * @param mode
 *   "original"   — one text line per cue: the source language text
 *   "translated" — one text line per cue: the translated text
 *   "bilingual"  — two text lines per cue: original on line 1, translated on line 2
 */
export function generateSrt(
  subtitles: SaveableSubtitle[],
  mode: "original" | "translated" | "bilingual",
): string {
  const lines: string[] = [];

  subtitles.forEach((sub, idx) => {
    const index    = idx + 1;
    const timecode = `${toSrtTime(sub.startTime)} --> ${toSrtTime(sub.endTime)}`;

    let text: string;
    switch (mode) {
      case "original":
        text = sub.original;
        break;
      case "translated":
        text = sub.translated || sub.original;
        break;
      case "bilingual":
        text = `${sub.original}\n${sub.translated || sub.original}`;
        break;
    }

    lines.push(`${index}\n${timecode}\n${text}\n`);
  });

  return lines.join("\n");
}

/**
 * Builds plain-text file content (no timestamps).
 *
 * @param mode
 *   "original"   — one line per segment: source text
 *   "translated" — one line per segment: translated text
 *   "bilingual"  — one line per segment: "original | translated"
 */
export function generateTxt(
  subtitles: SaveableSubtitle[],
  mode: "original" | "translated" | "bilingual",
): string {
  return subtitles
    .map((sub) => {
      switch (mode) {
        case "original":
          return sub.original;
        case "translated":
          return sub.translated || sub.original;
        case "bilingual":
          return `${sub.original} | ${sub.translated || sub.original}`;
      }
    })
    .join("\n");
}

// ── Exported I/O functions ────────────────────────────────────────────────────

const SAF_DIR_CACHE_KEY = "realtimesub:saf_dir_uri";

/**
 * Saves a file to a user-chosen directory via StorageAccessFramework (SAF).
 * The chosen directory URI is cached in AsyncStorage so the system picker
 * is only shown once — subsequent saves reuse the cached URI automatically.
 * Android only.
 */
async function saveToDownloads(
  content: string,
  filename: string,
  mimeType: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Try to reuse the previously chosen directory URI.
    let dirUri = await AsyncStorage.getItem(SAF_DIR_CACHE_KEY);

    // If no cached URI (or the cached URI is no longer valid), prompt the user.
    if (!dirUri) {
      const result = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!result.granted) {
        return { success: false, error: "Directory permission denied" };
      }
      dirUri = result.directoryUri;
      await AsyncStorage.setItem(SAF_DIR_CACHE_KEY, dirUri);
    }

    // Create a new file inside the chosen directory.
    const fileUri = await StorageAccessFramework.createFileAsync(
      dirUri,
      filename,
      mimeType,
    );

    await StorageAccessFramework.writeAsStringAsync(fileUri, content);
    console.log(`[SAVE] saved to SAF directory: ${filename}`);
    return { success: true };
  } catch (e) {
    // If the cached URI is stale (e.g. user revoked access), clear it so the
    // next call prompts the picker again rather than looping on the same error.
    await AsyncStorage.removeItem(SAF_DIR_CACHE_KEY);
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[SAVE] saveToDownloads (SAF) failed: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Writes subtitle content to a file in the app's document directory, then
 * saves to Downloads and/or opens the system share sheet.
 *
 * @param saveMode  "share" — share sheet only
 *                  "download" — save to device Downloads (Android) only
 *                  "both" — download + share sheet (default)
 *
 * @returns `{ success: true, uri }` on success, `{ success: false, error }` on failure.
 */
export async function saveSubtitleFile(
  subtitles:  SaveableSubtitle[],
  videoId:    string,
  videoTitle: string,
  format:     "srt" | "txt",
  mode:       "original" | "translated" | "bilingual",
  saveMode:   SaveMode = "both",
): Promise<{ success: boolean; uri?: string; error?: string }> {
  try {
    if (subtitles.length === 0) {
      return { success: false, error: "No subtitles to save" };
    }

    // Ensure the subtitles directory exists
    const dir = new Directory(Paths.document, "subtitles");
    // .exists is a synchronous getter — no await
    if (!dir.exists) {
      await dir.create();
      console.log(`[SAVE] created subtitles dir: ${dir.uri}`);
    }

    const safeName  = sanitizeFilename(videoTitle || videoId);
    const timestamp = Date.now();
    const filename  = `${safeName}_${mode}_${timestamp}.${format}`;

    const content =
      format === "srt"
        ? generateSrt(subtitles, mode)
        : generateTxt(subtitles, mode);

    const file = new File(Paths.document, "subtitles", filename);
    // .write() is asynchronous
    await file.write(content);

    console.log(`[SAVE] wrote ${subtitles.length} segments → ${file.uri}`);

    // ── Download to device Downloads folder via SAF (Android only) ──────
    if ((saveMode === "download" || saveMode === "both") && Platform.OS === "android") {
      const mimeType = format === "srt" ? "application/x-subrip" : "text/plain";
      const dlResult = await saveToDownloads(content, filename, mimeType);
      if (!dlResult.success) {
        console.warn(`[SAVE] saveToDownloads failed: ${dlResult.error}`);
        // Non-fatal — still proceed to share if requested
      }
    }

    // ── Share sheet ───────────────────────────────────────────────────────
    if (saveMode === "share" || saveMode === "both") {
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(file.uri, {
          mimeType:    format === "srt" ? "application/x-subrip" : "text/plain",
          dialogTitle: `Save subtitle file — ${filename}`,
          UTI:         format === "srt" ? "public.text" : "public.plain-text",
        });
      } else {
        console.log("[SAVE] Sharing not available on this device — file saved locally only");
      }
    }

    return { success: true, uri: file.uri };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[SAVE] saveSubtitleFile failed: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Lists all files previously saved to the subtitles folder.
 *
 * @returns Array sorted by modification time, newest first.
 *          Returns an empty array if the folder does not exist yet.
 */
export async function listSavedSubtitles(): Promise<
  { name: string; uri: string; size: number; modifiedAt: number }[]
> {
  try {
    const dir = new Directory(Paths.document, "subtitles");
    // .exists is a synchronous getter — no await
    if (!dir.exists) return [];

    // .list() is asynchronous; returns File | Directory instances, not strings
    const items = await dir.list();

    return items
      .filter((item): item is File => item instanceof File)
      .map((item) => ({
        name: item.name,
        uri:  item.uri,
        // .size and .modifiedTime are synchronous getters — no await
        size: item.size ?? 0,
        modifiedAt: item.modificationTime ?? 0,
      }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch (e) {
    console.error(`[SAVE] listSavedSubtitles failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Deletes a single saved subtitle file.
 *
 * @param uri  URI returned by `saveSubtitleFile` or `listSavedSubtitles`.
 * @returns    `true` on success, `false` on failure.
 */
export async function deleteSavedSubtitle(uri: string): Promise<boolean> {
  try {
    const file = new File(uri);
    // .exists is a synchronous getter — no await
    if (!file.exists) {
      console.warn(`[SAVE] deleteSavedSubtitle: file not found: ${uri}`);
      return false;
    }
    // .delete() is asynchronous
    await file.delete();
    console.log(`[SAVE] deleted: ${uri}`);
    return true;
  } catch (e) {
    console.error(`[SAVE] deleteSavedSubtitle failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
