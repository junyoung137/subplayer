import { create } from "zustand";

export interface SubtitleSegment {
  id: string;
  startTime: number;
  endTime: number;
  original: string;
  translated: string;
}

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
  /** 특정 자막 세그먼트의 번역/원문을 수동으로 수정 */
  updateSubtitle: (id: string, patch: Partial<Pick<SubtitleSegment, "original" | "translated">>) => void;
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

  setVideo: (uri, name) =>
    set({ videoUri: uri, videoName: name, subtitles: [], isPlaying: false, currentTime: 0, duration: 0 }),

  setPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration }),
  setSubtitles: (segments) => {
    console.log('[STORE] subtitles updated, count:', segments.length);
    set({ subtitles: segments });
  },
  clearSubtitles: () => set({ subtitles: [] }),
  setProcessing: (isProcessing) => set({ isProcessing }),
  setProcessingError: (processingError) => set({ processingError }),
  setProcessingProgress: (processingPercent, processingMessage) => set({ processingPercent, processingMessage }),
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
    }),
}));