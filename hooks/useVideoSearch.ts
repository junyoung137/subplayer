/**
 * useVideoSearch.ts
 *
 * 영상 탐색 도구 — 자막 기반 의미 검색
 *
 * 설계 원칙:
 * - 기존 번역/재생 로직에 전혀 영향 없음
 * - SubtitleSegment 읽기만 (store write 없음)
 * - Gemma 모델 사용 안 함 (검색은 벡터 문제, LLM 문제 아님)
 * - 온디바이스 순수 JS: BM25 키워드 매칭 + 코사인 유사도 재랭킹
 *
 * 아키텍처:
 * 1단계: BM25 키워드 매칭 → 후보 20개 추림
 * 2단계: TF-IDF 벡터 코사인 유사도 → 재랭킹
 * 3단계: hybrid score = 0.6*similarity + 0.3*keyword + 0.1*proximity
 * 4단계: 인접 구간 병합 (10초 이내)
 * 5단계: Top 5 반환
 */

import { useState, useCallback, useRef } from "react";
import { SubtitleSegment } from "../store/usePlayerStore";

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface SearchResult {
  startTime: number;
  endTime: number;
  previewText: string;     // 자막 미리보기 (원문 + 번역)
  score: number;
  segmentIndices: number[];
}

// ── 상수 ─────────────────────────────────────────────────────────────────────

const TOP_CANDIDATES = 20;
const TOP_RESULTS = 5;
const MERGE_THRESHOLD_SECS = 10;
const CHUNK_WINDOW_SECS = 25; // 세그먼트 묶음 단위 (의미 단위 확보)
const PROXIMITY_DECAY = 60;   // Math.exp(-distance / PROXIMITY_DECAY)

// ── 한국어/영어 쿼리 확장 ────────────────────────────────────────────────────
// 온디바이스 rule-based 확장 (Gemma 불필요)

const EXPANSION_MAP: Record<string, string[]> = {
  // 경제/금융
  "환율": ["환율", "exchange rate", "currency", "달러", "원화", "환전"],
  "금리": ["금리", "interest rate", "금융", "이자"],
  "주식": ["주식", "stock", "shares", "투자", "코스피"],
  "인플레이션": ["인플레이션", "inflation", "물가", "가격상승"],
  // 기술
  "인공지능": ["인공지능", "AI", "artificial intelligence", "머신러닝", "딥러닝"],
  "알고리즘": ["알고리즘", "algorithm", "코드", "프로그래밍"],
  // 일반
  "설명": ["설명", "explain", "introduction", "소개", "개요", "정의"],
  "방법": ["방법", "how to", "방식", "절차", "단계"],
  "이유": ["이유", "why", "reason", "원인", "배경"],
  "결론": ["결론", "conclusion", "summary", "요약", "마지막"],
  "예시": ["예시", "example", "사례", "예를 들어", "for example"],
};

function expandQuery(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  const terms: Set<string> = new Set([trimmed]);

  // 직접 매핑
  for (const [key, expansions] of Object.entries(EXPANSION_MAP)) {
    if (trimmed.includes(key) || key.includes(trimmed)) {
      expansions.forEach((e) => terms.add(e.toLowerCase()));
    }
  }

  // 단어 분리 (공백/조사 기준)
  const words = trimmed
    .split(/[\s,]+/)
    .map((w) => w.replace(/[은는이가을를에서에게으로로하고이고지만는데인데]$/, ""))
    .filter((w) => w.length > 1);
  words.forEach((w) => terms.add(w));

  return [...terms];
}

// ── TF-IDF 벡터 생성 ─────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\sㄱ-ㅎㅏ-ㅣ가-힣]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function buildTfVector(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  // 정규화
  const total = tokens.length || 1;
  for (const [k, v] of tf) {
    tf.set(k, v / total);
  }
  return tf;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [k, va] of a) {
    const vb = b.get(k) ?? 0;
    dot += va * vb;
    normA += va * va;
  }
  for (const [, vb] of b) {
    normB += vb * vb;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ── BM25 키워드 점수 ──────────────────────────────────────────────────────────

function bm25Score(
  queryTerms: string[],
  docTokens: string[],
  avgDocLen: number,
  k1 = 1.5,
  b = 0.75
): number {
  const tf = new Map<string, number>();
  for (const t of docTokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  let score = 0;
  const docLen = docTokens.length;

  for (const term of queryTerms) {
    const termFreq = tf.get(term) ?? 0;
    if (termFreq === 0) continue;

    // IDF 근사 (단일 문서 내에서는 term 존재 여부로 대체)
    const idf = 1.0;
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (docLen / (avgDocLen || 1)));
    score += idf * (numerator / denominator);
  }

  return score;
}

// ── 청크 생성 (10~30초 단위로 세그먼트 묶기) ─────────────────────────────────

interface Chunk {
  startTime: number;
  endTime: number;
  text: string;            // 원문
  translatedText: string;  // 번역
  segmentIndices: number[];
}

function buildChunks(segments: SubtitleSegment[]): Chunk[] {
  if (segments.length === 0) return [];

  const chunks: Chunk[] = [];
  let i = 0;

  while (i < segments.length) {
    const chunkStart = segments[i].startTime;
    const chunkTexts: string[] = [];
    const chunkTranslated: string[] = [];
    const indices: number[] = [];

    while (
      i < segments.length &&
      segments[i].startTime - chunkStart < CHUNK_WINDOW_SECS
    ) {
      chunkTexts.push(segments[i].original);
      chunkTranslated.push(segments[i].translated || segments[i].original);
      indices.push(i);
      i++;
    }

    if (indices.length === 0) { i++; continue; }

    const lastSeg = segments[indices[indices.length - 1]];
    chunks.push({
      startTime: chunkStart,
      endTime: lastSeg.endTime,
      text: chunkTexts.join(" "),
      translatedText: chunkTranslated.join(" "),
      segmentIndices: indices,
    });
  }

  return chunks;
}

// ── 인접 결과 병합 ────────────────────────────────────────────────────────────

function mergeAdjacentResults(results: SearchResult[]): SearchResult[] {
  if (results.length === 0) return [];

  const sorted = [...results].sort((a, b) => a.startTime - b.startTime);
  const merged: SearchResult[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.startTime - current.endTime <= MERGE_THRESHOLD_SECS) {
      // 병합
      current.endTime = Math.max(current.endTime, next.endTime);
      current.score = Math.max(current.score, next.score);
      current.previewText =
        current.previewText.length >= next.previewText.length
          ? current.previewText
          : next.previewText;
      current.segmentIndices = [
        ...current.segmentIndices,
        ...next.segmentIndices,
      ];
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

// ── 미리보기 텍스트 생성 ──────────────────────────────────────────────────────

function buildPreviewText(
  segments: SubtitleSegment[],
  indices: number[],
  maxChars = 120
): string {
  const origParts: string[] = [];
  const transParts: string[] = [];

  for (const idx of indices.slice(0, 6)) {
    const seg = segments[idx];
    if (seg) {
      origParts.push(seg.original);
      if (seg.translated && seg.translated !== seg.original) {
        transParts.push(seg.translated);
      }
    }
  }

  const orig = origParts.join(" ").slice(0, maxChars);
  const trans = transParts.join(" ").slice(0, maxChars);

  return trans ? `${trans}\n${orig}` : orig;
}

// ── 메인 훅 ───────────────────────────────────────────────────────────────────

export function useVideoSearch() {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState("");

  // 캐시: 같은 쿼리 반복 시 재계산 안 함
  const cacheRef = useRef<Map<string, SearchResult[]>>(new Map());
  const chunksRef = useRef<Chunk[]>([]);
  const segmentsRef = useRef<SubtitleSegment[]>([]);

  const search = useCallback(
    async (query: string, segments: SubtitleSegment[], currentTime = 0) => {
      if (!query.trim() || segments.length === 0) {
        setResults([]);
        return;
      }

      const cacheKey = `${query}::${segments.length}`;
      if (cacheRef.current.has(cacheKey)) {
        setResults(cacheRef.current.get(cacheKey)!);
        setLastQuery(query);
        return;
      }

      setIsSearching(true);
      setLastQuery(query);

      // 세그먼트 변경 시 청크 재생성
      if (segmentsRef.current !== segments) {
        chunksRef.current = buildChunks(segments);
        segmentsRef.current = segments;
        cacheRef.current.clear();
      }

      const chunks = chunksRef.current;
      if (chunks.length === 0) {
        setResults([]);
        setIsSearching(false);
        return;
      }

      // 비동기로 처리 (JS thread 블로킹 방지)
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            // 쿼리 확장
            const expandedTerms = expandQuery(query);
            const queryText = expandedTerms.join(" ");
            const queryTokens = tokenize(queryText);

            // 전체 청크 평균 길이 계산 (BM25용)
            const avgDocLen =
              chunks.reduce((sum, c) => sum + tokenize(c.text + " " + c.translatedText).length, 0) /
              chunks.length;

            // ── 1단계: BM25 키워드 점수 ─────────────────────────────────
            const scored = chunks.map((chunk, idx) => {
              const docText = chunk.text + " " + chunk.translatedText;
              const docTokens = tokenize(docText);
              const kwScore = bm25Score(queryTokens, docTokens, avgDocLen);
              return { chunk, idx, kwScore };
            });

            // 상위 후보 추림
            const candidates = [...scored]
              .sort((a, b) => b.kwScore - a.kwScore)
              .slice(0, TOP_CANDIDATES);

            if (candidates.every((c) => c.kwScore === 0)) {
              // 키워드 매칭 실패 → 전체에서 벡터 검색
              candidates.push(...scored.slice(TOP_CANDIDATES, TOP_CANDIDATES + 10));
            }

            // ── 2단계: 코사인 유사도 재랭킹 ─────────────────────────────
            const queryVec = buildTfVector(queryTokens);

            const reranked = candidates.map(({ chunk, idx, kwScore }) => {
              const docText = chunk.text + " " + chunk.translatedText;
              const docVec = buildTfVector(tokenize(docText));
              const similarity = cosineSimilarity(queryVec, docVec);

              // 시간 근접성 (현재 재생 위치 기준)
              const distance = Math.abs(chunk.startTime - currentTime);
              const proximity = Math.exp(-distance / PROXIMITY_DECAY);

              // ── hybrid score ──────────────────────────────────────────
              const maxKw = Math.max(...candidates.map((c) => c.kwScore), 1);
              const normalizedKw = kwScore / maxKw;

              const finalScore =
                0.6 * similarity + 0.3 * normalizedKw + 0.1 * proximity;

              return {
                chunk,
                finalScore,
                similarity,
              };
            });

            // ── 3단계: Top N 선택 ────────────────────────────────────────
            const topResults = reranked
              .filter((r) => r.finalScore > 0.01)
              .sort((a, b) => b.finalScore - a.finalScore)
              .slice(0, TOP_RESULTS);

            if (topResults.length === 0) {
              setResults([]);
              resolve();
              return;
            }

            // ── 4단계: SearchResult 변환 ─────────────────────────────────
            const searchResults: SearchResult[] = topResults.map(({ chunk, finalScore }) => ({
              startTime: chunk.startTime,
              endTime: chunk.endTime,
              previewText: buildPreviewText(segments, chunk.segmentIndices),
              score: finalScore,
              segmentIndices: chunk.segmentIndices,
            }));

            // ── 5단계: 인접 구간 병합 ────────────────────────────────────
            const merged = mergeAdjacentResults(searchResults);

            // 캐시 저장 (최대 20개)
            if (cacheRef.current.size > 20) {
              const firstKey = cacheRef.current.keys().next().value;
              if (firstKey) cacheRef.current.delete(firstKey);
            }
            cacheRef.current.set(cacheKey, merged);
            setResults(merged);
          } catch (e) {
            console.warn("[useVideoSearch] search error:", e);
            setResults([]);
          }
          resolve();
        }, 0);
      });

      setIsSearching(false);
    },
    []
  );

  const clearResults = useCallback(() => {
    setResults([]);
    setLastQuery("");
  }, []);

  const clearCache = useCallback(() => {
    cacheRef.current.clear();
    chunksRef.current = [];
    segmentsRef.current = [] as SubtitleSegment[];
  }, []);

  return {
    results,
    isSearching,
    lastQuery,
    search,
    clearResults,
    clearCache,
  };
}