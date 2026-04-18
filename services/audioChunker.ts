import { NativeModules } from "react-native";

const { AudioChunker } = NativeModules;

export interface AudioChunk {
  filePath: string;
  startTime: number;
  duration: number;
  index: number;
}

export async function extractAndChunkAudio(
  videoPath: string,
  chunkDuration: number = 30
): Promise<AudioChunk[]> {
  if (!AudioChunker || typeof AudioChunker.getVideoDuration !== "function") {
    throw new Error("AudioChunker native module not found.");
  }
  const totalDuration: number = await AudioChunker.getVideoDuration(videoPath);
  if (!totalDuration || totalDuration <= 0) {
    throw new Error("오디오 트랙을 찾을 수 없습니다. mp4/mkv/mov 권장");
  }
  const chunkCount = Math.ceil(totalDuration / chunkDuration);
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const startSec = i * chunkDuration;
    const actualDuration = Math.min(chunkDuration, totalDuration - startSec);
    const chunk: AudioChunk = await AudioChunker.extractSingleChunk(videoPath, startSec, actualDuration, i);
    chunks.push(chunk);
  }
  return chunks;
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
  if (!AudioChunker || typeof AudioChunker.extractSingleChunk !== "function") {
    throw new Error("AudioChunker native module not found.");
  }
  return AudioChunker.extractSingleChunk(videoPath, startSec, durationSec, index);
}

export async function clearChunkDir(): Promise<void> {
  if (!AudioChunker || typeof AudioChunker.clearChunks !== "function") return;
  await AudioChunker.clearChunks();
}