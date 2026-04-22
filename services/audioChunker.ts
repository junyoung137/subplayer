import { NativeModules } from "react-native";

const { AudioChunker } = NativeModules;

export interface AudioChunk {
  filePath: string;
  startTime: number;
  duration: number;
  index: number;
}

// ── 모듈 가용성 검사 ──────────────────────────────────────────────────────────
function assertModule(): void {
  if (!AudioChunker || typeof AudioChunker.extractSingleChunk !== "function") {
    throw new Error("AudioChunker native module not found.");
  }
}

export async function getVideoDuration(videoPath: string): Promise<number> {
  if (!AudioChunker || typeof AudioChunker.getVideoDuration !== "function") {
    throw new Error("AudioChunker native module not found.");
  }
  const duration: number = await AudioChunker.getVideoDuration(videoPath);
  if (!duration || duration <= 0) {
    throw new Error("오디오 트랙을 찾을 수 없습니다. mp4/mkv/mov 권장");
  }
  return duration;
}

export async function extractSingleChunkAt(
  videoPath: string,
  startSec: number,
  durationSec: number,
  index: number,
): Promise<AudioChunk> {
  assertModule();
  // SILENT_CHUNK / EMPTY_AUDIO reject는 그대로 throw — 호출부(videoProcessor)에서 분류
  return AudioChunker.extractSingleChunk(videoPath, startSec, durationSec, index);
}

export async function clearChunkDir(): Promise<void> {
  if (!AudioChunker || typeof AudioChunker.clearChunks !== "function") return;
  await AudioChunker.clearChunks();
}