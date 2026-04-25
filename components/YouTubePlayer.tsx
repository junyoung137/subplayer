/**
 * YouTubePlayer (v28)
 *
 * 변경사항 (v27 → v28):
 * ─────────────────────────────────────────────────────────────────────────────
 * [BUG FIX 1] 더블탭으로 재생 시 10초 점프 후 재생되는 문제
 *   - 원인: 탭 오버레이에서 단일탭(재생/일시정지) + 더블탭(±10s 시크)을 모두
 *           내부에서 처리하여 충돌 발생
 *   - 수정: 단일탭 처리를 onTap prop으로 Screen에 완전 위임.
 *           내부에서는 더블탭 시크만 처리.
 *           isPlayingRef / setPlaying 내부 직접 조작 제거.
 *
 * [BUG FIX 2] 외부 재생버튼과 화면 상태 연동 안되는 문제
 *   - 원인: 내부에서 setPlaying을 직접 호출하여 Screen의 optimisticPlaying과
 *           Zustand isPlaying store 상태가 엇갈림
 *   - 수정: 단일탭 시 onTap prop만 호출, 내부 상태 조작 전혀 없음.
 *           실제 상태는 onStateChange 이벤트에서만 업데이트 (단방향 유지).
 * ─────────────────────────────────────────────────────────────────────────────
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
import { AlertTriangle, Maximize2 } from 'lucide-react-native';

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
  onTap?: () => void;           // ✅ [v28] 단일탭을 Screen으로 위임
  onFullscreenToggle?: () => void;
  onOverlayVisibilityChange?: (visible: boolean) => void;
  isFullscreen?: boolean;
  playing?: boolean;
  style?: object;
}

export interface YouTubePlayerHandle {
  seekTo: (t: number) => void;
  setRate: (rate: number) => void;
  fetchSubtitles: () => void; // 수동 재시도
  play: () => void;
  pause: () => void;
  disableCaptions: () => void;
  blockTimeSync: (ms: number) => void;
  pauseTimeSync: () => void;
  resumeTimeSync: () => void;
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
    onTap,            // ✅ [v28] 추가
    onFullscreenToggle,
    onOverlayVisibilityChange,
    isFullscreen = false,
    playing,
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
  const [showOverlay, setShowOverlay] = useState(false);
  const overlayHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onOverlayVisibilityChangeRef = useRef(onOverlayVisibilityChange);
  useEffect(() => { onOverlayVisibilityChangeRef.current = onOverlayVisibilityChange; }, [onOverlayVisibilityChange]);

  // Use a ref to always access latest isFullscreen value inside callbacks
  const isFullscreenRef = useRef(isFullscreen);
  useEffect(() => { isFullscreenRef.current = isFullscreen; }, [isFullscreen]);

  const triggerOverlay = useCallback(() => {
    if (overlayHideTimerRef.current) {
      clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = null;
    }
    setShowOverlay(true);
    onOverlayVisibilityChangeRef.current?.(true);
    if (!isPlayingRef.current) {
      overlayHideTimerRef.current = setTimeout(() => {
        setShowOverlay(false);
        onOverlayVisibilityChangeRef.current?.(false);
        overlayHideTimerRef.current = null;
      }, 1500);
    }
    // If playing: no timer — overlay hides via isPlaying effect
  }, []);

  useEffect(() => {
    if (!isFullscreenRef.current) return;
    if (!isPlaying) {
      // Paused → start 1500ms hide timer
      if (overlayHideTimerRef.current) {
        clearTimeout(overlayHideTimerRef.current);
        overlayHideTimerRef.current = null;
      }
      overlayHideTimerRef.current = setTimeout(() => {
        setShowOverlay(false);
        onOverlayVisibilityChangeRef.current?.(false);
        overlayHideTimerRef.current = null;
      }, 1500);
    } else {
      // Playing → cancel any running timer, keep overlay hidden
      // (overlay shown only via tap → triggerOverlay())
      if (overlayHideTimerRef.current) {
        clearTimeout(overlayHideTimerRef.current);
        overlayHideTimerRef.current = null;
      }
    }
  }, [isPlaying]);

  // Separate effect for isFullscreen changes only
  useEffect(() => {
    if (!isFullscreen) {
      if (overlayHideTimerRef.current) {
        clearTimeout(overlayHideTimerRef.current);
        overlayHideTimerRef.current = null;
      }
      setShowOverlay(false);
      onOverlayVisibilityChangeRef.current?.(false);
    }
  }, [isFullscreen]);

  useEffect(() => {
    return () => {
      if (overlayHideTimerRef.current) clearTimeout(overlayHideTimerRef.current);
      if (blockTimeSyncTimerRef.current) clearTimeout(blockTimeSyncTimerRef.current);
    };
  }, []);


  useEffect(() => { setCurrentRate(playbackRate); }, [playbackRate]);

  useEffect(() => {
    if (!isReady) return;
    const webViewRef = (playerRef.current as any)?.getWebViewRef?.();
    if (!webViewRef) {
      console.log('[PLAY_EFFECT] no webViewRef');
      return;
    }
    const script = playing
      ? 'window.player && window.player.playVideo(); true;'
      : 'window.player && window.player.pauseVideo(); true;';
    console.log('[PLAY_EFFECT] injecting:', playing ? 'play' : 'pause');
    webViewRef.injectJavaScript(script);
  }, [playing, isReady]);

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
  const blockTimeSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTimeSyncPausedRef = useRef<boolean>(false);

  // ── 탭 감지용 refs ────────────────────────────────────────────────────────
  const tapCountRef      = useRef<number>(0);
  const tapTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapLocationRef   = useRef<number>(0);
  const pressStartRef    = useRef<number>(0);
  const containerWidthRef = useRef<number>(0);

  // playIntent race condition guard
  const wasPlayingRef = useRef(false);

  // isPlaying 최신값 ref (타이머 콜백 내 클로저에서 사용)
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // props ref (interval 내에서 최신 콜백 참조)
  const onSubtitleDataRef     = useRef(onSubtitleData);
  const onSubtitleClearRef    = useRef(onSubtitleClear);
  const onSubtitlesLoadedRef  = useRef(onSubtitlesLoaded);
  const onSeekRef             = useRef(onSeek);
  // ✅ [v28] onTap ref 추가
  const onTapRef              = useRef(onTap);
  useEffect(() => { onSubtitleDataRef.current = onSubtitleData; }, [onSubtitleData]);
  useEffect(() => { onSubtitleClearRef.current = onSubtitleClear; }, [onSubtitleClear]);
  useEffect(() => { onSubtitlesLoadedRef.current = onSubtitlesLoaded; }, [onSubtitlesLoaded]);
  useEffect(() => { onSeekRef.current = onSeek; }, [onSeek]);
  useEffect(() => { onTapRef.current = onTap; }, [onTap]); // ✅ [v28]

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
      if (!isPlayingRef.current) return;
      if (isTimeSyncBlockedRef.current) return;
      if (seekingRef.current) return;
      if (isTimeSyncPausedRef.current) return;
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

  // ── 단일탭(onTap 위임) + 더블탭(±10초 시크) ─────────────────────────────
  // ✅ [v28] 단일탭에서 내부 play/pause 직접 호출 완전 제거.
  //         단일탭은 onTapRef.current?.() 로만 처리 → Screen의 handlePlayToggle에 위임.
  //         더블탭 시크 로직은 그대로 유지.
  const DOUBLE_TAP_MS = 300;
  const TAP_MAX_MS    = 250; // 이보다 길면 롱프레스로 간주, 탭 무시
  const SEEK_DELTA    = 10;

  // ── Ref 메서드 노출 ───────────────────────────────────────────────────────
  React.useImperativeHandle(ref, () => ({
    seekTo: (t: number) => {
      seekingRef.current = true;
      // Do NOT touch isTimeSyncBlockedRef here —
      // blockTimeSync manages it independently now.
      // Only set it if blockTimeSync is not already controlling it.
      if (!blockTimeSyncTimerRef.current) {
        isTimeSyncBlockedRef.current = true;
        blockTimeSyncTimerRef.current = setTimeout(() => {
          isTimeSyncBlockedRef.current = false;
          blockTimeSyncTimerRef.current = null;
        }, 800);
      }
      playerRef.current?.seekTo(t, true);
    },
    setRate: (rate: number) => { setCurrentRate(rate); },
    fetchSubtitles: () => {
      if (videoId) doFetch(videoId);
    },
    play:  () => {},
    pause: () => {},
    disableCaptions: () => {
      playerRef.current?.injectJavaScript?.(
        "try{player.unloadModule('captions');player.unloadModule('cc');}catch(e){}; true;"
      );
    },
    blockTimeSync: (ms: number) => {
      isTimeSyncBlockedRef.current = true;
      if (blockTimeSyncTimerRef.current) {
        clearTimeout(blockTimeSyncTimerRef.current);
      }
      blockTimeSyncTimerRef.current = setTimeout(() => {
        isTimeSyncBlockedRef.current = false;
        blockTimeSyncTimerRef.current = null;
      }, ms);
    },
    pauseTimeSync: () => { isTimeSyncPausedRef.current = true; },
    resumeTimeSync: () => { isTimeSyncPausedRef.current = false; },
  }));

  // ── State change handler ──────────────────────────────────────────────────
  const handleStateChange = useCallback(
    (state: PLAYER_STATES) => {

      if (state === PLAYER_STATES.PLAYING) {
        wasPlayingRef.current = true;
        setPlaying(true);
      }
      if (state === PLAYER_STATES.PAUSED || state === PLAYER_STATES.ENDED) {
        setPlaying(false);
        wasPlayingRef.current = false;
      }

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
    setIsReady(true);
    setTimeout(() => {
      const webViewRef = (playerRef.current as any)?.getWebViewRef?.();
      if (webViewRef && playing) {
        console.log('[PLAY_EFFECT] delayed post-ready play trigger');
        webViewRef.injectJavaScript('window.player && window.player.playVideo(); true;');
      }
    }, 500);
    onReady?.();
  }, [onReady, playing]);

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
        width={undefined}
        videoId={videoId}
        play={playing ?? false}
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
        단일탭 / 더블탭 오버레이 [v28 수정]
        - 단일탭 → onTap prop 호출 (Screen의 handlePlayToggle에 완전 위임)
        - 더블탭 좌반 → −10s 시크, 우반 → +10s 시크 (기존 유지)
        - 내부에서 play/pause 직접 호출 완전 제거 → 상태 충돌 방지
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
              // ✅ [v28] 단일탭: 내부에서 play/pause 직접 호출하지 않음
              //          onTap prop을 통해 Screen의 handlePlayToggle에 완전 위임
              console.log(`[TAP v28] single-tap → delegating to onTap`);
              onTapRef.current?.();
              if (isFullscreen) triggerOverlay();

            } else if (count >= 2) {
              tapCountRef.current = 0;
              // 더블탭 → ±10초 시크 (기존 로직 그대로 유지)
              const x    = tapLocationRef.current;
              const w    = containerWidthRef.current;
              const side = w > 0 && x < w / 2 ? "left" : "right";
              try {
                const current = (await playerRef.current?.getCurrentTime()) ?? 0;
                const newTime = Math.max(0, current + (side === "right" ? SEEK_DELTA : -SEEK_DELTA));
                console.log(`[TAP v28] double-tap side=${side} newTime=${newTime}`);
                onSeekRef.current?.(newTime);
              } catch {}
            }
          }, DOUBLE_TAP_MS);
        }}
      />
      {/* ── 전체화면 버튼 (portrait only — landscape minimize는 Screen에서 렌더링) ── */}
      {!isFullscreen && (
        <TouchableOpacity
          style={styles.fullscreenBtn}
          onPress={onFullscreenToggle}
          activeOpacity={0.7}
        >
          <Maximize2 size={18} color="#fff" />
        </TouchableOpacity>
      )}
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