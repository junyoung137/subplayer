/**
 * YouTubePlayer (v28)
 *
 * 변경사항 (v27 → v28):
 * ─────────────────────────────────────────────────────────────────────────────
 * [BUG FIX] 외부 재생버튼 작동 안 하는 문제
 *   - 원인: play()/pause()가 setPlaying()만 호출 → store 값이 이미 같으면
 *           zustand가 업데이트를 건너뜀 → play prop 변화 없음 → postMessage 미전송
 *   - 수정: useImperativeHandle의 play()/pause()에서
 *           store 업데이트 전에 false→true (또는 true→false) 토글을 한 사이클
 *           먼저 실행하여 prop 변화를 강제로 만듦
 *   - 영향 범위: useImperativeHandle 내부 play/pause 2개 메서드만 변경
 *               다른 로직(자막, 폴링, 탭, 시크 등) 전혀 변경 없음
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useRef, useCallback, useEffect, useState } from "react";
import {
  View,
  StyleSheet,
  ActivityIndicator,
  Text,
  TouchableOpacity,
  Platform,
} from "react-native";
import YoutubePlayer, {
  YoutubeIframeRef,
  PLAYER_STATES,
} from "react-native-youtube-iframe";
import { usePlayerStore } from "../store/usePlayerStore";
import {
  fetchYoutubeSubtitles,
  TimedTextSegment,
  RateLimitError,
} from "../services/youtubeTimedText";
import { parseYoutubeId } from "../utils/youtubeUtils";
export { parseYoutubeId };
import { AlertTriangle, Maximize2, Minimize2 } from 'lucide-react-native';

// ── Props / Handle 타입 ───────────────────────────────────────────────────────
export interface YouTubePlayerProps {
  videoId: string;
  height: number;
  playbackRate?: number;
  onReady?: () => void;
  onStateChange?: (
    state: "playing" | "paused" | "ended" | "buffering" | "unstarted"
  ) => void;
  onError?: (code: string) => void;
  onSubtitleData?: (data: SubtitleFetchResult) => void;
  onSubtitleClear?: () => void;
  onSubtitlesLoaded?: (segments: TimedTextSegment[], language: string) => void;
  onSeek?: (newTime: number) => void;
  onFullscreenToggle?: () => void;
  isFullscreen?: boolean;
  style?: object;
}

export interface YouTubePlayerHandle {
  seekTo: (t: number) => void;
  setRate: (rate: number) => void;
  fetchSubtitles: () => void;
  play: () => void;
  pause: () => void;
}

export interface SubtitleFetchResult {
  segments: Array<{ startTime: number; endTime: number; text: string }>;
  language: string;
  source: string;
}

// ── YouTube 내장 자막 숨김 ────────────────────────────────────────────────────
const SUBTITLE_LEAD_S = 0.5;

const hideSubtitleScript = `
(function() {
  var s = document.createElement('style');
  s.innerHTML = '.ytp-caption-window-container, .captions-text { display: none !important; }';
  (document.head || document.documentElement).appendChild(s);

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('message', function(e) {
      window.dispatchEvent(new MessageEvent('message', { data: e.data, origin: e.origin }));
    });
    var _origPost = window.postMessage.bind(window);
    window.postMessage = function(data, origin) {
      _origPost(data, origin || '*');
      try {
        document.dispatchEvent(new MessageEvent('message', { data: data }));
      } catch(e) {}
    };
  }
})();
true;
`;

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
export const YouTubePlayer = React.forwardRef<
  YouTubePlayerHandle,
  YouTubePlayerProps
>(function YouTubePlayerInner(
  {
    videoId,
    height,
    playbackRate = 1.0,
    onReady,
    onStateChange,
    onError,
    onSubtitleData,
    onSubtitleClear,
    onSubtitlesLoaded,
    onSeek,
    onFullscreenToggle,
    isFullscreen = false,
    style,
  },
  ref
) {
  const playerRef = useRef<YoutubeIframeRef>(null);

  const [isReady, setIsReady]         = useState(false);
  const [hasError, setHasError]       = useState(false);
  const [errMsg, setErrMsg]           = useState("");
  const [currentRate, setCurrentRate] = useState(playbackRate);

  useEffect(() => { setCurrentRate(playbackRate); }, [playbackRate]);

  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration    = usePlayerStore((s) => s.setDuration);
  const setPlaying     = usePlayerStore((s) => s.setPlaying);
  const isPlaying      = usePlayerStore((s) => s.isPlaying);

  const playerReadyRef = useRef(false);
  const pendingPlayRef = useRef<boolean | null>(null);

  // ── timedtext 상태 ────────────────────────────────────────────────────────
  const loadedSegmentsRef  = useRef<TimedTextSegment[]>([]);
  const captionLangRef     = useRef<string>("auto");
  const lastEmittedTextRef = useRef<string>("");

  // ── 광고/버퍼링 시간 점프 감지 ───────────────────────────────────────────
  const prevTimeRef          = useRef<number>(0);
  const seekingRef           = useRef<boolean>(false);
  const isTimeSyncBlockedRef = useRef<boolean>(false);

  // ── 탭 감지용 refs ────────────────────────────────────────────────────────
  const tapCountRef       = useRef<number>(0);
  const tapTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapLocationRef    = useRef<number>(0);
  const pressStartRef     = useRef<number>(0);
  const containerWidthRef = useRef<number>(0);

  // isPlaying 최신값 ref
  const isPlayingRef = useRef(isPlaying);

  // ── Android spurious PAUSED guard ────────────────────────────────────────
  const playIntentMsRef = useRef<number>(0);

  useEffect(() => {
    if (isPlaying) {
      playIntentMsRef.current = Date.now();
    }
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (isPlaying || !playerReadyRef.current) return;

    const check = setTimeout(async () => {
      try {
        const t1 = await playerRef.current?.getCurrentTime();
        if (t1 == null) return;
        await new Promise<void>(r => setTimeout(r, 350));
        const t2 = await playerRef.current?.getCurrentTime();
        if (t2 == null) return;
        const stillPlaying = Math.abs(t2 - t1) > 0.08;
        if (stillPlaying) {
          console.log('[YTPlayer v28] pause not delivered, sending again');
          setPlaying(true);
          setTimeout(() => {
            if (!isPlayingRef.current) {
              setPlaying(false);
            }
          }, 80);
        }
      } catch {}
    }, 700);

    return () => clearTimeout(check);
  }, [isPlaying, setPlaying]);

  // props ref
  const onSubtitleDataRef    = useRef(onSubtitleData);
  const onSubtitleClearRef   = useRef(onSubtitleClear);
  const onSubtitlesLoadedRef = useRef(onSubtitlesLoaded);
  const onSeekRef            = useRef(onSeek);
  useEffect(() => { onSubtitleDataRef.current = onSubtitleData; }, [onSubtitleData]);
  useEffect(() => { onSubtitleClearRef.current = onSubtitleClear; }, [onSubtitleClear]);
  useEffect(() => { onSubtitlesLoadedRef.current = onSubtitlesLoaded; }, [onSubtitlesLoaded]);
  useEffect(() => { onSeekRef.current = onSeek; }, [onSeek]);

  // ── caption fetch ─────────────────────────────────────────────────────────
  const doFetch = useCallback(
    (vid: string) => {
      loadedSegmentsRef.current  = [];
      lastEmittedTextRef.current = "";
      let cancelled = false;

      (async () => {
        try {
          console.log(`[YTPlayer v28] caption fetch 시작: ${vid}`);
          const result = await fetchYoutubeSubtitles(vid, "en");
          if (cancelled) return;

          if (result && result.segments.length > 0) {
            const raw = [...result.segments].sort((a, b) => a.startTime - b.startTime);

            const deduped = raw.filter((seg, i) => {
              if (i === 0) return true;
              return seg.startTime >= raw[i - 1].startTime + 0.1;
            });

            for (let i = 0; i < deduped.length - 1; i++) {
              if (deduped[i].endTime > deduped[i + 1].startTime) {
                deduped[i] = { ...deduped[i], endTime: deduped[i + 1].startTime };
              }
            }

            loadedSegmentsRef.current = deduped;
            captionLangRef.current    = result.language;
            onSubtitlesLoadedRef.current?.(deduped, result.language);
            console.log(
              `[YTPlayer v28] ${deduped.length}개 세그먼트 로드 완료 (raw=${result.segments.length}, lang=${result.language})`
            );
          } else {
            console.log(`[YTPlayer v28] 자막 없음: ${vid}`);
          }
        } catch (e) {
          if (cancelled) return;
          console.warn("[YTPlayer v28] caption fetch 오류:", e);
        }
      })();

      return () => { cancelled = true; };
    },
    []
  );

  useEffect(() => {
    if (!isReady || !videoId) return;
    return doFetch(videoId);
  }, [isReady, videoId, doFetch]);

  useEffect(() => {
    loadedSegmentsRef.current  = [];
    lastEmittedTextRef.current = "";
    onSubtitleClearRef.current?.();
  }, [videoId]);

  // ── 500ms polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isReady) return;
    const timer = setInterval(async () => {
      if (!isPlayingRef.current) return;
      try {
        const t = await playerRef.current?.getCurrentTime();
        const d = await playerRef.current?.getDuration();

        if (t != null) {
          if (!isTimeSyncBlockedRef.current) setCurrentTime(t);

          const segments = loadedSegmentsRef.current;
          if (segments.length > 0) {
            const timeDelta = Math.abs(t - prevTimeRef.current);
            prevTimeRef.current = t;
            if (timeDelta > 10) return;

            const lookupTime = t + SUBTITLE_LEAD_S;
            const active = segments.find(
              (s) => lookupTime >= s.startTime && lookupTime < s.endTime
            );

            if (active) {
              if (active.text !== lastEmittedTextRef.current || seekingRef.current) {
                seekingRef.current         = false;
                lastEmittedTextRef.current = active.text;
                onSubtitleDataRef.current?.({
                  segments: [{
                    text:      active.text,
                    startTime: active.startTime,
                    endTime:   active.endTime,
                  }],
                  language: captionLangRef.current,
                  source:   "timedtext",
                });
              }
            } else if (lastEmittedTextRef.current !== "") {
              seekingRef.current         = false;
              lastEmittedTextRef.current = "";
              onSubtitleClearRef.current?.();
            }
          }
        }

        if (d != null && d > 0) setDuration(d);
      } catch {}
    }, 500);
    return () => clearInterval(timer);
  }, [isReady, setCurrentTime, setDuration]);

  const DOUBLE_TAP_MS = 300;
  const TAP_MAX_MS    = 250;
  const SEEK_DELTA    = 10;

  // ── Ref 메서드 노출 ───────────────────────────────────────────────────────
  React.useImperativeHandle(ref, () => ({
    seekTo: (t: number) => {
      seekingRef.current           = true;
      isTimeSyncBlockedRef.current = true;
      setTimeout(() => { isTimeSyncBlockedRef.current = false; }, 800);
      playerRef.current?.seekTo(t, true);
    },
    setRate: (rate: number) => { setCurrentRate(rate); },
    fetchSubtitles: () => {
      if (videoId) doFetch(videoId);
    },

    // [BUG FIX] 외부 재생버튼 수정
    // 문제: setPlaying(true)만 호출하면 store 값이 이미 true일 때
    //       zustand가 동일 값으로 판단해 상태 업데이트를 건너뜀
    //       → play prop 변화 없음 → postMessage 미전송 → 재생 안 됨
    // 해결: 현재 store 값과 관계없이 false→true 토글을 강제로 실행하여
    //       react-native-youtube-iframe의 play prop 변화를 보장
    play: () => {
      if (!playerReadyRef.current) {
        pendingPlayRef.current = true;
        return;
      }
      // 이미 playing 상태여도 prop 변화를 강제로 만들기 위해 토글
      const alreadyPlaying = isPlayingRef.current;
      if (alreadyPlaying) {
        // false → true 토글: prop이 변해야 library가 playVideo postMessage 전송
        setPlaying(false);
        setTimeout(() => setPlaying(true), 50);
      } else {
        setPlaying(true);
      }
    },

    pause: () => {
      if (!playerReadyRef.current) {
        pendingPlayRef.current = false;
        return;
      }
      // 이미 paused 상태여도 prop 변화를 강제로 만들기 위해 토글
      const alreadyPaused = !isPlayingRef.current;
      if (alreadyPaused) {
        // true → false 토글
        setPlaying(true);
        setTimeout(() => setPlaying(false), 50);
      } else {
        setPlaying(false);
      }
    },
  }));

  // ── State change handler ──────────────────────────────────────────────────
  const handleStateChange = useCallback(
    (state: PLAYER_STATES) => {
      const stateMap: Partial<Record<
        PLAYER_STATES,
        "playing" | "paused" | "ended" | "buffering" | "unstarted"
      >> = {
        [PLAYER_STATES.PLAYING]:   "playing",
        [PLAYER_STATES.PAUSED]:    "paused",
        [PLAYER_STATES.ENDED]:     "ended",
        [PLAYER_STATES.BUFFERING]: "buffering",
        [PLAYER_STATES.UNSTARTED]: "unstarted",
      };

      const mapped = stateMap[state];
      if (!mapped) return;

      if (mapped === 'paused' && Date.now() - playIntentMsRef.current < 300) {
        console.log('[YTPlayer v28] Suppressing spurious PAUSED (Android buffering guard)');
        return;
      }

      onStateChange?.(mapped);
    },
    [onStateChange]
  );

  const handleError = useCallback(
    (e: string) => {
      if (!e || e === "undefined") {
        console.warn("[YTPlayer v28] handleError 무시: code=", e);
        return;
      }
      setHasError(true);
      setErrMsg(e);
      onError?.(e);
    },
    [onError]
  );

  const handleReady = useCallback(() => {
    console.log("[YTPlayer v28] onReady");
    playerReadyRef.current = true;
    setIsReady(true);
    onReady?.();
    if (pendingPlayRef.current !== null) {
      const queued = pendingPlayRef.current;
      pendingPlayRef.current = null;
      setTimeout(() => {
        requestAnimationFrame(() => {
          setPlaying(queued);
        });
      }, 150);
    }
  }, [onReady, setPlaying]);

  useEffect(() => {
    if (!playerReadyRef.current) return;

    const timeout = setTimeout(() => {
      const currentlyPlaying = usePlayerStore.getState().isPlaying;
      if (currentlyPlaying) {
        setPlaying(false);
        setTimeout(() => setPlaying(true), 100);
      }
    }, 500);

    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 에러 화면 ─────────────────────────────────────────────────────────────
  if (hasError) {
    return (
      <View style={[styles.container, { height }, style, styles.errorBox]}>
        <AlertTriangle size={32} color="#f59e0b" />
        <Text style={styles.errorText}>
          {errMsg === "150" || errMsg === "101" || errMsg === "embed_not_allowed"
            ? "이 영상은 임베드가 허용되지 않습니다.\n다른 영상을 시도해 보세요."
            : errMsg === "100" || errMsg === "video_not_found"
            ? "존재하지 않거나 비공개 영상입니다."
            : `재생 오류 (${errMsg})`}
        </Text>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={() => {
            setHasError(false);
            setIsReady(false);
          }}
        >
          <Text style={styles.retryText}>다시 시도</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View
      style={[styles.container, { height }, style]}
      onLayout={(e) => { containerWidthRef.current = e.nativeEvent.layout.width; }}
    >
      <YoutubePlayer
        ref={playerRef}
        height={height}
        width={isFullscreen ? height * (16 / 9) : undefined}
        videoId={videoId}
        play={isPlaying}
        playbackRate={currentRate}
        onReady={handleReady}
        onChangeState={handleStateChange}
        onError={handleError}
        forceAndroidAutoplay={Platform.OS === 'android'}
        webViewProps={{
          androidLayerType: "hardware",
          injectedJavaScript: hideSubtitleScript,
          allowsInlineMediaPlayback: true,
          mediaPlaybackRequiresUserAction: false,
        }}
        initialPlayerParams={{
          showClosedCaptions: false,
          controls: false,
          rel: false,
          modestbranding: true,
          iv_load_policy: 3,
          loop: false,
          preventFullScreen: false,
        }}
      />
      <View
        style={StyleSheet.absoluteFillObject}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          pressStartRef.current  = Date.now();
          tapLocationRef.current = e.nativeEvent.locationX;
        }}
        onResponderRelease={() => {
          if (Date.now() - pressStartRef.current > TAP_MAX_MS) return;

          tapCountRef.current += 1;
          if (tapTimerRef.current) clearTimeout(tapTimerRef.current);

          tapTimerRef.current = setTimeout(async () => {
            const count = tapCountRef.current;
            tapCountRef.current = 0;
            tapTimerRef.current = null;

            if (count === 1) {
              const nextPlaying = !isPlayingRef.current;
              console.log(`[TAP] count=${count} isPlaying=${isPlayingRef.current} ready=${playerReadyRef.current}`);
              if (!playerReadyRef.current) {
                pendingPlayRef.current = nextPlaying;
                return;
              }
              setPlaying(nextPlaying);
            } else if (count >= 2) {
              const x    = tapLocationRef.current;
              const w    = containerWidthRef.current;
              const side = w > 0 && x < w / 2 ? "left" : "right";
              try {
                const current = (await playerRef.current?.getCurrentTime()) ?? 0;
                const newTime = Math.max(0, current + (side === "right" ? SEEK_DELTA : -SEEK_DELTA));
                console.log(`[TAP] double-tap side=${side} newTime=${newTime}`);
                onSeekRef.current?.(newTime);
              } catch {}
            }
          }, DOUBLE_TAP_MS);
        }}
      />
      {/* ── 전체화면 버튼 ─────────────────────────────────────────────────── */}
      <TouchableOpacity
        style={styles.fullscreenBtn}
        onPress={onFullscreenToggle}
        activeOpacity={0.7}
      >
        {isFullscreen ? <Minimize2 size={18} color="#fff" /> : <Maximize2 size={18} color="#fff" />}
      </TouchableOpacity>
      {!isReady && (
        <View style={[styles.loadingOverlay, { height }]}>
          <ActivityIndicator size="large" color="#ff0000" />
          <Text style={styles.loadingText}>YouTube 로딩 중...</Text>
        </View>
      )}
    </View>
  );
});

// ── 스타일 ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { backgroundColor: "#000", overflow: "hidden" },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  loadingText: { color: "#888", fontSize: 13 },
  errorBox:    { justifyContent: "center", alignItems: "center", gap: 10, padding: 24 },
  errorText:   { color: "#aaa", fontSize: 13, textAlign: "center", lineHeight: 20 },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: "#ff0000",
  },
  retryText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  fullscreenBtn: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 4,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
  },
});