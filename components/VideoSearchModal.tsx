/**
 * VideoSearchModal.tsx
 *
 * 영상 탐색 도구 모달
 * - 자막 기반 의미 검색 결과 표시
 * - 결과 탭 시 해당 timestamp로 영상 이동
 * - 기존 번역/재생 로직 전혀 건드리지 않음
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
} from "react-native";
import { Search, X, Clock, ChevronRight, Mic } from "lucide-react-native";
import { useVideoSearch, SearchResult } from "../hooks/useVideoSearch";
import { SubtitleSegment } from "../store/usePlayerStore";

// ── 타입 ──────────────────────────────────────────────────────────────────────

interface VideoSearchModalProps {
  visible: boolean;
  onClose: () => void;
  subtitles: SubtitleSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
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

// ── 결과 아이템 ───────────────────────────────────────────────────────────────

const ResultItem = React.memo(function ResultItem({
  item,
  index,
  onPress,
}: {
  item: SearchResult;
  index: number;
  onPress: (startTime: number) => void;
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 50,
      bounciness: 0,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const lines = item.previewText.split("\n");
  const mainLine = lines[0] ?? "";
  const subLine = lines[1] ?? "";

  const scorePercent = Math.round(item.score * 100);
  const scoreColor =
    scorePercent >= 60 ? "#22c55e" :
    scorePercent >= 35 ? "#f59e0b" :
    "#64748b";

  return (
    <TouchableOpacity
      activeOpacity={1}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={() => onPress(item.startTime)}
    >
      <Animated.View style={[styles.resultCard, { transform: [{ scale: scaleAnim }] }]}>
        {/* 왼쪽 타임라인 바 */}
        <View style={styles.resultLeft}>
          <View style={[styles.scoreBar, { backgroundColor: scoreColor }]} />
          <View style={styles.timeChip}>
            <Clock size={10} color="#64748b" />
            <Text style={styles.timeText}>{fmtTime(item.startTime)}</Text>
          </View>
          {item.startTime !== item.endTime && (
            <Text style={styles.durationText}>
              ~{fmtTime(item.endTime)}
            </Text>
          )}
        </View>

        {/* 텍스트 영역 */}
        <View style={styles.resultContent}>
          {mainLine ? (
            <Text style={styles.mainText} numberOfLines={2}>{mainLine}</Text>
          ) : null}
          {subLine ? (
            <Text style={styles.subText} numberOfLines={1}>{subLine}</Text>
          ) : null}
        </View>

        {/* 오른쪽 화살표 */}
        <View style={styles.resultRight}>
          <ChevronRight size={16} color="#334155" />
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
});

// ── 빈 상태 ───────────────────────────────────────────────────────────────────

function EmptyState({ query, hasSubtitles }: { query: string; hasSubtitles: boolean }) {
  if (!hasSubtitles) {
    return (
      <View style={styles.emptyContainer}>
        <Mic size={32} color="#334155" />
        <Text style={styles.emptyTitle}>자막 없음</Text>
        <Text style={styles.emptyDesc}>영상 번역이 완료된 후 검색할 수 있어요</Text>
      </View>
    );
  }

  if (!query) {
    return (
      <View style={styles.emptyContainer}>
        <Search size={32} color="#334155" />
        <Text style={styles.emptyTitle}>영상 탐색</Text>
        <Text style={styles.emptyDesc}>
          찾고 싶은 장면을 자연어로 검색하세요{"\n"}
          예: "환율 설명", "결론 부분", "예시 나오는 곳"
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.emptyContainer}>
      <Search size={32} color="#334155" />
      <Text style={styles.emptyTitle}>결과 없음</Text>
      <Text style={styles.emptyDesc}>
        다른 키워드로 시도해보세요{"\n"}
        더 구체적인 단어나 영어로도 검색 가능해요
      </Text>
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
}: VideoSearchModalProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<TextInput>(null);
  const { results, isSearching, search, clearResults, clearCache } = useVideoSearch();

  // 모달 열릴 때 input 포커스
  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 150);
    } else {
      setQuery("");
      clearResults();
    }
  }, [visible]);

  // 자막 변경 시 캐시 초기화
  useEffect(() => {
    clearCache();
  }, [subtitles.length]);

  const handleSearch = useCallback(
    (text: string) => {
      setQuery(text);
      if (text.trim().length >= 1) {
        search(text, subtitles, currentTime);
      } else {
        clearResults();
      }
    },
    [subtitles, currentTime, search, clearResults]
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
      <View style={styles.backdrop}>
        <TouchableOpacity style={styles.backdropTouch} onPress={handleClose} activeOpacity={1} />

        <View style={styles.sheet}>
          {/* 핸들 */}
          <View style={styles.handle} />

          {/* 헤더 */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Search size={16} color="#6366f1" />
              <Text style={styles.headerTitle}>영상 탐색</Text>
            </View>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <X size={18} color="#64748b" />
            </TouchableOpacity>
          </View>

          {/* 검색 입력 */}
          <View style={styles.inputWrapper}>
            <Search size={15} color={query ? "#6366f1" : "#475569"} style={styles.inputIcon} />
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={query}
              onChangeText={handleSearch}
              placeholder="찾고 싶은 장면 입력..."
              placeholderTextColor="#475569"
              returnKeyType="search"
              onSubmitEditing={() => query && search(query, subtitles, currentTime)}
              selectionColor="#6366f1"
              autoCorrect={false}
              autoCapitalize="none"
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

          {/* 자막 개수 힌트 */}
          {hasSubtitles && (
            <Text style={styles.hintText}>
              {subtitles.length}개 자막 세그먼트 검색 가능
            </Text>
          )}

          {/* 결과 */}
          {isSearching ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color="#6366f1" />
              <Text style={styles.loadingText}>탐색 중...</Text>
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
            <EmptyState query={query} hasSubtitles={hasSubtitles} />
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
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
    maxHeight: "78%",
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
  closeBtn: {
    padding: 4,
  },

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
  loadingText: {
    color: "#64748b",
    fontSize: 13,
  },

  // 결과 리스트
  resultList: {
    flex: 1,
  },
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
  resultRight: {
    paddingHorizontal: 10,
  },

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