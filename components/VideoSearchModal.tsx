/**
 * VideoSearchModal.tsx (v2)
 *
 * 변경사항:
 * ─────────────────────────────────────────────────────────────────────────────
 * [FIX 1] 키보드 가림 문제
 *   - KeyboardAvoidingView로 모달 시트 감싸기
 *   - iOS: behavior="padding", Android: behavior="height"
 *   - 키보드 높이만큼 시트가 위로 밀려 검색창+결과 항상 보임
 *
 * [FIX 2] 검색 정확도 개선 (한국어)
 *   - 청크 단위 → 세그먼트 단위 직접 검색
 *   - Exact match (문자열 포함) 최우선 점수 부여
 *   - n-gram 유사도로 부분 매칭 보완
 *   - 검색어가 번역문/원문 어느 쪽에 있어도 히트
 *
 * [FIX 3] 검색 버튼 번역 완료 전 비활성화
 *   - VideoSearchModal props에 isReady 추가
 *   - YoutubePlayerScreen에서 subtitlePhase === 'done' 시에만 활성화
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Keyboard,
  Platform,
  Animated,
  KeyboardAvoidingView,
  useWindowDimensions,
} from "react-native";
import { Search, X, Clock, ChevronRight, Mic, Lock } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { SubtitleSegment } from "../store/usePlayerStore";

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface SearchResult {
  startTime: number;
  endTime: number;
  previewText: string;
  score: number;
  segmentIndices: number[];
}

interface VideoSearchModalProps {
  visible: boolean;
  onClose: () => void;
  subtitles: SubtitleSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
  /** 번역 완료 여부 — false면 "번역 완료 후 사용 가능" 안내 표시 */
  isReady?: boolean;
  /** Optional UI locale override (e.g. "en", "ja"). Auto-detected if omitted. */
  uiLocale?: string;
}

// ── 시간 포맷 ─────────────────────────────────────────────────────────────────

function fmtTime(sec: number): string {
  if (!sec || isNaN(sec)) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── 검색 엔진 (세그먼트 단위, 한국어 특화) ───────────────────────────────────

/**
 * 검색 전략:
 * 1. Exact match: 검색어가 번역문 또는 원문에 포함되면 최고점
 * 2. Token overlap: 공백 분리 토큰 기준 겹치는 비율
 * 3. N-gram: 2-gram 기준 부분 유사도
 * 4. 인접 세그먼트 병합 (5초 이내)
 */

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  // 공백 분리 + 조사 제거 (간단한 rule-based)
  return text
    .toLowerCase()
    .split(/[\s,.\-!?]+/)
    .map((w) =>
      w.replace(
        /(은|는|이|가|을|를|에서|에게|으로|로|하고|이고|지만|는데|인데|의|과|와|도|만|부터|까지|라고|이라고)$/,
        ""
      )
    )
    .filter((w) => w.length > 0);
}

function buildBigrams(tokens: string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return bigrams;
}

function scoreSegment(
  query: string,
  queryTokens: string[],
  queryBigrams: Set<string>,
  original: string,
  translated: string
): number {
  const normQuery = normalizeText(query);
  const normOrig  = normalizeText(original);
  const normTrans = normalizeText(translated);

  // ── 1. Exact substring match (최우선) ────────────────────────────────────
  const exactInTrans = normTrans.includes(normQuery);
  const exactInOrig  = normOrig.includes(normQuery);
  if (exactInTrans || exactInOrig) {
    // 완전 포함이면 1.0 기준 + 위치 보너스 (앞에 있을수록 높음)
    const pos = exactInTrans
      ? normTrans.indexOf(normQuery) / Math.max(normTrans.length, 1)
      : normOrig.indexOf(normQuery) / Math.max(normOrig.length, 1);
    return 0.85 + 0.15 * (1 - pos);
  }

  // ── 2. Token overlap ─────────────────────────────────────────────────────
  const docText   = `${normOrig} ${normTrans}`;
  const docTokens = tokenize(docText);
  const docSet    = new Set(docTokens);

  let tokenHits = 0;
  for (const qt of queryTokens) {
    if (qt.length < 2) continue;
    // 직접 포함 or 부분문자열 포함
    if (docSet.has(qt) || docText.includes(qt)) {
      tokenHits++;
    }
  }
  const tokenScore =
    queryTokens.filter((t) => t.length >= 2).length > 0
      ? tokenHits / queryTokens.filter((t) => t.length >= 2).length
      : 0;

  // ── 3. Bigram overlap ────────────────────────────────────────────────────
  const docBigrams = buildBigrams(tokenize(docText));
  let bigramHits = 0;
  for (const bg of queryBigrams) {
    if (docBigrams.has(bg)) bigramHits++;
  }
  const bigramScore =
    queryBigrams.size > 0 ? bigramHits / queryBigrams.size : 0;

  // ── 4. Character n-gram (2-gram) for Korean partial match ───────────────
  let charNgramScore = 0;
  if (normQuery.length >= 2) {
    const queryChars = new Set<string>();
    for (let i = 0; i < normQuery.length - 1; i++) {
      queryChars.add(normQuery.slice(i, i + 2));
    }
    let charHits = 0;
    for (const cg of queryChars) {
      if (docText.includes(cg)) charHits++;
    }
    charNgramScore = queryChars.size > 0 ? charHits / queryChars.size : 0;
  }

  // ── Hybrid score ─────────────────────────────────────────────────────────
  return 0.45 * tokenScore + 0.25 * bigramScore + 0.30 * charNgramScore;
}

function searchSubtitles(
  query: string,
  segments: SubtitleSegment[],
  currentTime: number
): SearchResult[] {
  if (!query.trim() || segments.length === 0) return [];

  const queryTokens = tokenize(query);
  const queryBigrams = buildBigrams(queryTokens);

  // 각 세그먼트 점수 계산
  const scored = segments.map((seg, idx) => ({
    idx,
    seg,
    score: scoreSegment(
      query,
      queryTokens,
      queryBigrams,
      seg.original,
      seg.translated || seg.original
    ),
  }));

  // 최소 threshold 필터
  const threshold = 0.15;
  const candidates = scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  if (candidates.length === 0) return [];

  // 인접 세그먼트 병합 (5초 이내)
  const MERGE_GAP = 5;
  const sortedByTime = [...candidates].sort(
    (a, b) => a.seg.startTime - b.seg.startTime
  );

  const merged: SearchResult[] = [];
  let current: SearchResult | null = null;

  for (const { idx, seg, score } of sortedByTime) {
    if (!current) {
      current = {
        startTime:      seg.startTime,
        endTime:        seg.endTime,
        previewText:    buildPreviewText([seg]),
        score,
        segmentIndices: [idx],
      };
      continue;
    }

    if (seg.startTime - current.endTime <= MERGE_GAP) {
      current.endTime        = Math.max(current.endTime, seg.endTime);
      current.score          = Math.max(current.score, score);
      current.segmentIndices = [...current.segmentIndices, idx];
      current.previewText    = buildPreviewText(
        current.segmentIndices.map((i) => segments[i])
      );
    } else {
      merged.push(current);
      current = {
        startTime:      seg.startTime,
        endTime:        seg.endTime,
        previewText:    buildPreviewText([seg]),
        score,
        segmentIndices: [idx],
      };
    }
  }
  if (current) merged.push(current);

  // 점수 내림차순 정렬 후 Top 5
  return merged.sort((a, b) => b.score - a.score).slice(0, 5);
}

function buildPreviewText(segs: SubtitleSegment[], maxChars = 120): string {
  const transParts = segs
    .map((s) => s.translated || s.original)
    .join(" ")
    .slice(0, maxChars);
  const origParts = segs
    .map((s) => s.original)
    .join(" ")
    .slice(0, maxChars);

  // 번역문과 원문이 같으면 하나만
  if (transParts === origParts) return origParts;
  return `${transParts}\n${origParts}`;
}

// ── ResultItem ────────────────────────────────────────────────────────────────

const ResultItem = React.memo(function ResultItem({
  item,
  onPress,
}: {
  item: SearchResult;
  index: number;
  onPress: (startTime: number) => void;
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () =>
    Animated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true, speed: 50, bounciness: 0 }).start();
  const handlePressOut = () =>
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 50, bounciness: 4 }).start();

  const lines    = item.previewText.split("\n");
  const mainLine = lines[0] ?? "";
  const subLine  = lines[1] ?? "";

  const scorePercent = Math.round(item.score * 100);
  const scoreColor =
    scorePercent >= 70 ? "#22c55e" :
    scorePercent >= 40 ? "#f59e0b" :
    "#64748b";

  return (
    <TouchableOpacity
      activeOpacity={1}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={() => onPress(item.startTime)}
    >
      <Animated.View style={[styles.resultCard, { transform: [{ scale: scaleAnim }] }]}>
        <View style={styles.resultLeft}>
          <View style={[styles.scoreBar, { backgroundColor: scoreColor }]} />
          <View style={styles.timeChip}>
            <Clock size={10} color="#64748b" />
            <Text style={styles.timeText}>{fmtTime(item.startTime)}</Text>
          </View>
          {item.startTime !== item.endTime && (
            <Text style={styles.durationText}>~{fmtTime(item.endTime)}</Text>
          )}
        </View>
        <View style={styles.resultContent}>
          {mainLine ? <Text style={styles.mainText} numberOfLines={2}>{mainLine}</Text> : null}
          {subLine  ? <Text style={styles.subText}  numberOfLines={1}>{subLine}</Text>  : null}
        </View>
        <View style={styles.resultRight}>
          <ChevronRight size={16} color="#334155" />
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
});

// ── EmptyState ────────────────────────────────────────────────────────────────

function EmptyState({
  query,
  hasSubtitles,
  isReady,
}: {
  query: string;
  hasSubtitles: boolean;
  isReady: boolean;
}) {
  const { t } = useTranslation();

  if (!isReady) {
    return (
      <View style={styles.emptyContainer}>
        <Lock size={32} color="#334155" />
        <Text style={styles.emptyTitle}>{t("videoSearch.notReadyTitle")}</Text>
        <Text style={styles.emptyDesc}>{t("videoSearch.notReadyDesc")}</Text>
      </View>
    );
  }
  if (!hasSubtitles) {
    return (
      <View style={styles.emptyContainer}>
        <Mic size={32} color="#334155" />
        <Text style={styles.emptyTitle}>{t("videoSearch.noSubtitlesTitle")}</Text>
        <Text style={styles.emptyDesc}>{t("videoSearch.noSubtitlesDesc")}</Text>
      </View>
    );
  }
  if (!query) {
    return (
      <View style={styles.emptyContainer}>
        <Search size={32} color="#334155" />
        <Text style={styles.emptyTitle}>{t("videoSearch.searchTitle")}</Text>
        <Text style={styles.emptyDesc}>{t("videoSearch.searchDesc")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.emptyContainer}>
      <Search size={32} color="#334155" />
      <Text style={styles.emptyTitle}>{t("videoSearch.noResultsTitle")}</Text>
      <Text style={styles.emptyDesc}>{t("videoSearch.noResultsDesc")}</Text>
    </View>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export function VideoSearchModal({
  visible,
  onClose,
  subtitles,
  currentTime,
  onSeek,
  isReady = true,
}: VideoSearchModalProps) {
  const { t } = useTranslation();
  const { height: screenHeight } = useWindowDimensions();
  const [query,      setQuery]      = useState("");
  const [results,    setResults]    = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef  = useRef<TextInput>(null);
  const cacheRef  = useRef<Map<string, SearchResult[]>>(new Map());
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 모달 열릴 때 포커스
  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 150);
    } else {
      setQuery("");
      setResults([]);
    }
  }, [visible]);

  // 자막 변경 시 캐시 초기화
  useEffect(() => {
    cacheRef.current.clear();
  }, [subtitles.length]);

  const handleSearch = useCallback(
    (text: string) => {
      setQuery(text);

      if (timerRef.current) clearTimeout(timerRef.current);

      if (!text.trim() || text.trim().length < 1) {
        setResults([]);
        setIsSearching(false);
        return;
      }

      setIsSearching(true);

      timerRef.current = setTimeout(() => {
        const cacheKey = `${text}::${subtitles.length}`;
        if (cacheRef.current.has(cacheKey)) {
          setResults(cacheRef.current.get(cacheKey)!);
          setIsSearching(false);
          return;
        }

        const found = searchSubtitles(text, subtitles, currentTime);

        if (cacheRef.current.size > 30) {
          const firstKey = cacheRef.current.keys().next().value;
          if (firstKey) cacheRef.current.delete(firstKey);
        }
        cacheRef.current.set(cacheKey, found);
        setResults(found);
        setIsSearching(false);
      }, 120); // 120ms debounce — 빠른 반응
    },
    [subtitles, currentTime]
  );

  const handleResultPress = useCallback(
    (startTime: number) => {
      Keyboard.dismiss();
      onSeek(startTime);
      onClose();
    },
    [onSeek, onClose]
  );

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  const hasSubtitles = subtitles.length > 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      {/*
        KeyboardAvoidingView를 Modal 안에 배치:
        - iOS: behavior="padding" → 시트 하단에 padding 추가
        - Android: behavior="height" → 시트 높이 자체를 줄임
        포인트: flex:1 로 전체 채우고 justifyContent:"flex-end" 로 하단 고정
      */}
      <KeyboardAvoidingView
        style={styles.kavWrapper}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {/* 반투명 배경 (터치 시 닫기) */}
        <TouchableOpacity
          style={styles.backdropTouch}
          onPress={handleClose}
          activeOpacity={1}
        />

        {/* 시트 */}
        <View style={[styles.sheet, { maxHeight: screenHeight * 0.78 }]}>
          {/* 핸들 */}
          <View style={styles.handle} />

          {/* 헤더 */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Search size={16} color="#6366f1" />
              <Text style={styles.headerTitle}>{t("videoSearch.searchTitle")}</Text>
            </View>
            <TouchableOpacity
              onPress={handleClose}
              style={styles.closeBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <X size={18} color="#64748b" />
            </TouchableOpacity>
          </View>

          {/* 검색 입력 */}
          <View style={styles.inputWrapper}>
            <Search
              size={15}
              color={query ? "#6366f1" : "#475569"}
              style={styles.inputIcon}
            />
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={query}
              onChangeText={handleSearch}
              placeholder={isReady ? t("videoSearch.searchPlaceholder") : t("videoSearch.notReadyPlaceholder")}
              placeholderTextColor="#475569"
              returnKeyType="search"
              selectionColor="#6366f1"
              autoCorrect={false}
              autoCapitalize="none"
              editable={isReady}
            />
            {query.length > 0 && (
              <TouchableOpacity
                onPress={() => handleSearch("")}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <X size={15} color="#475569" />
              </TouchableOpacity>
            )}
          </View>

          {/* 결과 영역 */}
          {isSearching ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color="#6366f1" />
              <Text style={styles.loadingText}>{t("videoSearch.searching")}</Text>
            </View>
          ) : results.length > 0 ? (
            <FlatList
              data={results}
              keyExtractor={(item) => `${item.startTime}-${item.endTime}`}
              renderItem={({ item, index }) => (
                <ResultItem item={item} index={index} onPress={handleResultPress} />
              )}
              style={styles.resultList}
              contentContainerStyle={styles.resultListContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            />
          ) : (
            <EmptyState
              query={query}
              hasSubtitles={hasSubtitles}
              isReady={isReady}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // KeyboardAvoidingView가 전체를 채우고 하단 정렬
  kavWrapper: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  backdropTouch: {
    flex: 1,
  },
  sheet: {
    backgroundColor: "#0f172a",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    minHeight: 360,
    paddingBottom: Platform.OS === "ios" ? 32 : 16,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#334155",
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 4,
  },

  // 헤더
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  headerTitle: {
    color: "#e2e8f0",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  closeBtn: { padding: 4 },

  // 검색 입력
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 12 : 8,
    borderWidth: 1,
    borderColor: "#334155",
    gap: 8,
  },
  inputIcon: {},
  input: {
    flex: 1,
    color: "#f1f5f9",
    fontSize: 15,
    padding: 0,
  },

  // 힌트
  hintText: {
    color: "#475569",
    fontSize: 11,
    marginHorizontal: 16,
    marginBottom: 8,
  },

  // 로딩
  loadingContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 40,
  },
  loadingText: { color: "#64748b", fontSize: 13 },

  // 결과 리스트
  resultList: { flex: 1 },
  resultListContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 8,
  },

  // 결과 카드
  resultCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#334155",
  },
  resultLeft: {
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 10,
    width: 70,
    gap: 4,
  },
  scoreBar: {
    width: 3,
    height: 28,
    borderRadius: 2,
    marginBottom: 4,
  },
  timeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  timeText: {
    color: "#94a3b8",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  durationText: {
    color: "#475569",
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
  resultContent: {
    flex: 1,
    paddingVertical: 12,
    paddingRight: 4,
    gap: 4,
  },
  mainText: {
    color: "#e2e8f0",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  subText: {
    color: "#64748b",
    fontSize: 11,
    lineHeight: 15,
  },
  resultRight: { paddingHorizontal: 10 },

  // 빈 상태
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    color: "#e2e8f0",
    fontSize: 15,
    fontWeight: "700",
  },
  emptyDesc: {
    color: "#64748b",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },
});
