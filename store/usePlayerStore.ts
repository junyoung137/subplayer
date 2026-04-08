import { create } from "zustand";

export interface SubtitleSegment {
  id: string;
  startTime: number;
  endTime: number;
  original: string;
  translated: string;
}

// URL 파이프 전용 진행 상태
export interface UrlProcessingState {
  isActive: boolean;
  chunkIndex: number;
  totalChunksEstimated: number;
  lastChunkAt: number;
  error: string | null;
}

export type PlayerMode = "local" | "youtube" | "url";

interface PlayerStore {
  videoUri: string | null;
  videoName: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  subtitles: SubtitleSegment[];
  isProcessing: boolean;
  processingError: string | null;
  processingPercent: number;
  processingMessage: string;
  seekVersion: number;

  playerMode: PlayerMode;
  youtubeVideoId: string | null;
  rawUrl: string | null;
  urlProcessing: UrlProcessingState;

  setVideo: (uri: string, name: string) => void;
  setPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setSubtitles: (segments: SubtitleSegment[]) => void;
  clearSubtitles: () => void;
  setProcessing: (processing: boolean) => void;
  setProcessingError: (error: string | null) => void;
  setProcessingProgress: (percent: number, message: string) => void;
  bumpSeek: () => void;
  reset: () => void;
  updateSubtitle: (id: string, patch: Partial<Pick<SubtitleSegment, "original" | "translated">>) => void;

  setYoutubeVideo: (videoId: string, name: string) => void;
  setUrlVideo: (url: string, name: string) => void;
  updateUrlProcessing: (patch: Partial<UrlProcessingState>) => void;
  resetUrlProcessing: () => void;
  appendSubtitles: (segments: SubtitleSegment[]) => void;
}

const INITIAL_URL_PROCESSING: UrlProcessingState = {
  isActive: false,
  chunkIndex: 0,
  totalChunksEstimated: 0,
  lastChunkAt: 0,
  error: null,
};

// ── BLANK 판정 ────────────────────────────────────────────────────────────────
const BLANK_PATTERNS = ['[BLANK_AUDIO]', '[BLANK_VIDEO]', '[blank_audio]', '[silence]', '[SILENCE]'];

function isBlankText(text: string): boolean {
  if (!text || text.trim().length === 0) return true;
  return BLANK_PATTERNS.some(p => text.includes(p));
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  videoUri: null,
  videoName: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  subtitles: [],
  isProcessing: false,
  processingError: null,
  processingPercent: 0,
  processingMessage: "",
  seekVersion: 0,

  playerMode: "local",
  youtubeVideoId: null,
  rawUrl: null,
  urlProcessing: INITIAL_URL_PROCESSING,

  setVideo: (uri, name) =>
    set({
      videoUri: uri,
      videoName: name,
      subtitles: [],
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      playerMode: "local",
      youtubeVideoId: null,
      rawUrl: null,
    }),

  setPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration }),
  setSubtitles: (segments) => {
    console.log("[STORE] subtitles updated, count:", segments.length);
    set({ subtitles: segments });
  },
  clearSubtitles: () => set({ subtitles: [] }),
  setProcessing: (isProcessing) => set({ isProcessing }),
  setProcessingError: (processingError) => set({ processingError }),
  setProcessingProgress: (processingPercent, processingMessage) =>
    set({ processingPercent, processingMessage }),
  bumpSeek: () => set((s) => ({ seekVersion: s.seekVersion + 1 })),

  updateSubtitle: (id, patch) =>
    set((s) => ({
      subtitles: s.subtitles.map((seg) =>
        seg.id === id ? { ...seg, ...patch } : seg
      ),
    })),

  reset: () =>
    set({
      videoUri: null,
      videoName: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      subtitles: [],
      isProcessing: false,
      processingError: null,
      processingPercent: 0,
      processingMessage: "",
      seekVersion: 0,
      playerMode: "local",
      youtubeVideoId: null,
      rawUrl: null,
      urlProcessing: INITIAL_URL_PROCESSING,
    }),

  setYoutubeVideo: (videoId, name) =>
    set({
      youtubeVideoId: videoId,
      videoName: name,
      videoUri: null,
      rawUrl: null,
      playerMode: "youtube",
      subtitles: [],
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      urlProcessing: INITIAL_URL_PROCESSING,
    }),

  setUrlVideo: (url, name) =>
    set({
      rawUrl: url,
      videoName: name,
      videoUri: null,
      youtubeVideoId: null,
      playerMode: "url",
      subtitles: [],
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      urlProcessing: INITIAL_URL_PROCESSING,
    }),

  updateUrlProcessing: (patch) =>
    set((s) => ({
      urlProcessing: { ...s.urlProcessing, ...patch },
    })),

  resetUrlProcessing: () =>
    set({ urlProcessing: INITIAL_URL_PROCESSING }),

  /** ✅ 청크 처리 완료 시 자막을 시간순으로 병합하여 추가
   *  - BLANK 세그먼트 필터링
   *  - 중복 id 세그먼트 제거 (같은 청크 중복 삽입 방지)
   */
  appendSubtitles: (segments) =>
    set((s) => {
      // ✅ BLANK 및 빈 세그먼트 필터링
      const filtered = segments.filter(
        seg => !isBlankText(seg.original) && seg.original.trim().length > 0
      );

      if (filtered.length === 0) {
        console.log("[STORE] appendSubtitles: BLANK만 있어 건너뜀");
        return {};
      }

      // ✅ 이미 존재하는 id는 중복 삽입 방지
      const existingIds = new Set(s.subtitles.map(seg => seg.id));
      const newSegs = filtered.filter(seg => !existingIds.has(seg.id));

      if (newSegs.length === 0) {
        console.log("[STORE] appendSubtitles: 모두 중복 — 건너뜀");
        return {};
      }

      const merged = [...s.subtitles, ...newSegs].sort(
        (a, b) => a.startTime - b.startTime
      );

      console.log(
        "[STORE] appendSubtitles: added",
        newSegs.length,
        "→ total",
        merged.length
      );
      return { subtitles: merged };
    }),
}));