/**
 * YouTubePlayer (v27)
 *
 * Subtitle source: yt-dlp proxy only (youtubeTimedText.ts).
 * Architecture:
 *   1. onReady → fetchYoutubeSubtitles(videoId) loads all TimedTextSegments
 *   2. 500ms polling loop matches currentTime ↔ segments
 *   3. onSubtitleData fires only when active segment changes
 */
import React, { useRef, useCallback, useEffect, useState } from "react";
import {
  View,
  StyleSheet,
  ActivityIndicator,
  Text,
  TouchableOpacity,
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
  fetchSubtitles: () => void; // 수동 재시도
  play: () => void;
  pause: () => void;
}

export interface SubtitleFetchResult {
  segments: Array<{ startTime: number; endTime: number; text: string }>;
  language: string;
  source: string;
}

// ── YouTube 내장 자막 숨김 ────────────────────────────────────────────────────
// outer frame(lonelycpp.github.io)에서 실행됨.
// display:none OK — DOM 읽기 불필요 (timedtext fetch 방식으로 전환)
// YouTube 플레이어의 caption DOM은 cross-origin iframe 내부이므로
// 실질적 숨김은 cc_load_policy:0(showClosedCaptions:false)으로 처리됨.
// YouTube timedtext 딜레이 보정 — 발화 대비 자막이 늦게 도착하는 시간(초)
const SUBTITLE_LEAD_S = 0.5;

const hideSubtitleScript = `
(function() {
  var s = document.createElement('style');
  s.innerHTML = '.ytp-caption-window-container, .captions-text { display: none !important; }';
  (document.head || document.documentElement).appendChild(s);
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
  const playerRef = useRef<YoutubeIframeRef & {
    injectJavaScript?: (s: string) => void;
    playVideo?: () => void;
    pauseVideo?: () => void;
  }>(null);

  const [isReady, setIsReady]         = useState(false);
  const [hasError, setHasError]       = useState(false);
  const [errMsg, setErrMsg]           = useState("");
  const [currentRate, setCurrentRate] = useState(playbackRate);

  useEffect(() => { setCurrentRate(playbackRate); }, [playbackRate]);

  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration    = usePlayerStore((s) => s.setDuration);
  const setPlaying     = usePlayerStore((s) => s.setPlaying);
  const isPlaying      = usePlayerStore((s) => s.isPlaying);

  // ── timedtext 상태 ────────────────────────────────────────────────────────
  const loadedSegmentsRef  = useRef<TimedTextSegment[]>([]);
  const captionLangRef     = useRef<string>("auto");
  const lastEmittedTextRef = useRef<string>("");

  // ── 광고/버퍼링 시간 점프 감지 ───────────────────────────────────────────
  const prevTimeRef          = useRef<number>(0);
  const seekingRef           = useRef<boolean>(false);
  // 시크 직후 폴링이 setCurrentTime을 덮어쓰지 않도록 800ms 보호
  const isTimeSyncBlockedRef = useRef<boolean>(false);

  // ── 탭 감지용 refs ────────────────────────────────────────────────────────
  const tapCountRef      = useRef<number>(0);
  const tapTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapLocationRef   = useRef<number>(0);
  const pressStartRef    = useRef<number>(0);
  const containerWidthRef = useRef<number>(0);

  // isPlaying 최신값 ref (타이머 콜백 내 클로저에서 사용)
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // props ref (interval 내에서 최신 콜백 참조)
  const onSubtitleDataRef     = useRef(onSubtitleData);
  const onSubtitleClearRef    = useRef(onSubtitleClear);
  const onSubtitlesLoadedRef  = useRef(onSubtitlesLoaded);
  const onSeekRef             = useRef(onSeek);
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
          console.log(`[YTPlayer v27] caption fetch 시작: ${vid}`);
          const result = await fetchYoutubeSubtitles(vid, "en");
          if (cancelled) return;

          if (result && result.segments.length > 0) {
            // 1. 정렬
            const raw = [...result.segments].sort((a, b) => a.startTime - b.startTime);

            // 2. 중복 / 0-길이 세그먼트 제거 (startTime 차이 < 0.1s)
            const deduped = raw.filter((seg, i) => {
              if (i === 0) return true;
              return seg.startTime >= raw[i - 1].startTime + 0.1;
            });

            // 3. 오버랩 해소: endTime을 다음 세그먼트 startTime으로 클리핑
            for (let i = 0; i < deduped.length - 1; i++) {
              if (deduped[i].endTime > deduped[i + 1].startTime) {
                deduped[i] = { ...deduped[i], endTime: deduped[i + 1].startTime };
              }
            }

            loadedSegmentsRef.current = deduped;
            captionLangRef.current    = result.language;
            onSubtitlesLoadedRef.current?.(deduped, result.language);
            console.log(
              `[YTPlayer v27] ${deduped.length}개 세그먼트 로드 완료 (raw=${result.segments.length}, lang=${result.language})`
            );
          } else {
            console.log(`[YTPlayer v27] 자막 없음: ${vid}`);
          }
        } catch (e) {
          if (cancelled) return;
          console.warn("[YTPlayer v27] caption fetch 오류:", e);
        }
      })();

      return () => { cancelled = true; };
    },
    []
  );

  // isReady + videoId 변경 시 caption fetch 트리거
  useEffect(() => {
    if (!isReady || !videoId) return;
    return doFetch(videoId);
  }, [isReady, videoId, doFetch]);

  // videoId 변경 시 이전 세그먼트 즉시 클리어 (새 영상 로드 전 잔존 자막 방지)
  useEffect(() => {
    loadedSegmentsRef.current  = [];
    lastEmittedTextRef.current = "";
    onSubtitleClearRef.current?.();
  }, [videoId]);

  // ── 500ms polling: currentTime/duration + subtitle sync ──────────────────
  useEffect(() => {
    if (!isReady) return;
    const timer = setInterval(async () => {
      try {
        const t = await playerRef.current?.getCurrentTime();
        const d = await playerRef.current?.getDuration();

        if (t != null) {
          // 시크 직후 800ms 동안은 폴링이 낙관적 업데이트를 덮어쓰지 않음
          if (!isTimeSyncBlockedRef.current) setCurrentTime(t);

          // ── timedtext 실시간 동기화 ────────────────────────────────────
          const segments = loadedSegmentsRef.current;
          if (segments.length > 0) {
            // 광고/버퍼링 종료 후 시간이 10초 이상 점프하면 한 사이클 건너뜀
            const timeDelta = Math.abs(t - prevTimeRef.current);
            prevTimeRef.current = t;
            if (timeDelta > 10) return; // 불안정한 전환 구간 — 다음 폴링까지 대기

            // 자막 룩업만 lead offset 적용 (시크바 표시에는 미적용)
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
              // 세그먼트 간 공백 구간
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

  // ── 단일탭(재생·일시정지) + 더블탭(±10초 시크) ────────────────────────────
  const DOUBLE_TAP_MS = 300;
  const TAP_MAX_MS    = 250; // 이보다 길면 롱프레스로 간주, 탭 무시
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
    play: () => {
      if (typeof playerRef.current?.playVideo === "function") {
        playerRef.current.playVideo();
      } else {
        playerRef.current?.injectJavaScript?.(
          "if(window.player&&typeof window.player.playVideo==='function')window.player.playVideo(); true;"
        );
      }
    },
    pause: () => {
      if (typeof playerRef.current?.pauseVideo === "function") {
        playerRef.current.pauseVideo();
      } else {
        playerRef.current?.injectJavaScript?.(
          "if(window.player&&typeof window.player.pauseVideo==='function')window.player.pauseVideo(); true;"
        );
      }
    },
  }));

  // ── State change handler ──────────────────────────────────────────────────
  const handleStateChange = useCallback(
    (state: PLAYER_STATES) => {
      if (state === PLAYER_STATES.PLAYING) setPlaying(true);
      if (state === PLAYER_STATES.PAUSED || state === PLAYER_STATES.ENDED)
        setPlaying(false);

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
      if (mapped) onStateChange?.(mapped);
    },
    [setPlaying, onStateChange]
  );

  const handleError = useCallback(
    (e: string) => {
      if (!e || e === "undefined") {
        console.warn("[YTPlayer v27] handleError 무시: code=", e);
        return;
      }
      setHasError(true);
      setErrMsg(e);
      onError?.(e);
    },
    [onError]
  );

  const handleReady = useCallback(() => {
    console.log("[YTPlayer v27] onReady");
    setIsReady(true);
    onReady?.();
  }, [onReady]);

  // ── 에러 화면 ─────────────────────────────────────────────────────────────
  if (hasError) {
    return (
      <View style={[styles.container, { height }, style, styles.errorBox]}>
        <Text style={styles.errorIcon}>⚠️</Text>
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
        videoId={videoId}
        play={isPlaying}
        playbackRate={currentRate}
        onReady={handleReady}
        onChangeState={handleStateChange}
        onError={handleError}
        webViewProps={{
          androidLayerType: "hardware",
          injectedJavaScript: hideSubtitleScript,
        }}
        initialPlayerParams={{
          showClosedCaptions: false, // cc_load_policy:0 — 네이티브 자막 비활성화
          controls: false,
          rel: false,
          modestbranding: true,
          iv_load_policy: 3,
          loop: false,
          preventFullScreen: false,
        }}
      />
      {/*
        단일탭 / 더블탭 오버레이
        - TouchableOpacity 대신 onStartShouldSetResponder View 사용
        - 모든 탭을 가로채서 300ms 창으로 단일/더블 구분
        - 단일탭 → 재생/일시정지 토글
        - 더블탭 좌반 → −10s 시크, 우반 → +10s 시크
      */}
      <View
        style={StyleSheet.absoluteFillObject}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          pressStartRef.current  = Date.now();
          tapLocationRef.current = e.nativeEvent.locationX;
        }}
        onResponderRelease={() => {
          if (Date.now() - pressStartRef.current > TAP_MAX_MS) return; // 롱프레스 무시

          tapCountRef.current += 1;
          if (tapTimerRef.current) clearTimeout(tapTimerRef.current);

          tapTimerRef.current = setTimeout(async () => {
            const count = tapCountRef.current;
            tapCountRef.current = 0;
            tapTimerRef.current = null;

            if (count === 1) {
              console.log(`[TAP] count=${count} isPlaying=${isPlayingRef.current}`);
              // Direct IFrame command is more reliable than waiting for the
              // play prop to propagate through React's render cycle.
              // Try the ref method first; fall back to window.player JS injection.
              if (isPlayingRef.current) {
                if (typeof playerRef.current?.pauseVideo === "function") {
                  playerRef.current.pauseVideo();
                } else {
                  playerRef.current?.injectJavaScript?.(
                    "if(window.player&&typeof window.player.pauseVideo==='function')window.player.pauseVideo(); true;"
                  );
                }
              } else {
                if (typeof playerRef.current?.playVideo === "function") {
                  playerRef.current.playVideo();
                } else {
                  playerRef.current?.injectJavaScript?.(
                    "if(window.player&&typeof window.player.playVideo==='function')window.player.playVideo(); true;"
                  );
                }
              }
              setPlaying(!isPlayingRef.current); // sync Zustand state
            } else if (count >= 2) {
              // 더블탭 → 시크
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
        <Text style={styles.fullscreenBtnText}>{isFullscreen ? "⊡" : "⛶"}</Text>
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
  container: { width: "100%", backgroundColor: "#000", overflow: "hidden" },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  loadingText: { color: "#888", fontSize: 13 },
  errorBox:    { justifyContent: "center", alignItems: "center", gap: 10, padding: 24 },
  errorIcon:   { fontSize: 36 },
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
  fullscreenBtnText: { color: "#fff", fontSize: 14, lineHeight: 18 },
});