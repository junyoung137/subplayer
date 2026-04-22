/**
 * youtubeSegmentPipeline.ts
 *
 * YouTube timedtext 전용 세그먼트 전처리 파이프라인.
 *
 * 문제 배경:
 *   yt-dlp timedtext는 2~4단어짜리 극단적 단편(fragment) 세그먼트가 대량 포함됨.
 *   이를 그대로 translateSegments()에 넘기면:
 *     1) SBD가 fragment 단위에서 작동해 문장 복원 불가
 *     2) CONTEXT_CHUNK_SIZE(8) 경계에서 문장이 잘려 번역 불연속 발생
 *
 * 해결 구조:
 *   mergeSegmentsForYoutube()   → fragment를 의미 단위로 사전 병합
 *   createOverlappedChunks()    → 청크 간 overlap으로 경계 단절 방지
 *   stitchChunkResults()        → overlap 구간 품질 비교 후 최종 결과 조립
 *
 * v5 → v6 개선사항:
 *
 *   [MERGE-2] 단문 문장 끝 과병합 방지 (치명적 UX 버그 수정)
 *     - "Yes." / "I agree." 같이 짧지만 완결된 문장이 합쳐지는 문제 해결
 *     - 강제 병합 조건에 "sentenceEnd && gap > SHORT_SENTENCE_SPLIT_GAP" 예외 추가
 *     - 결과: 단어 수가 적어도 문장이 끝나고 gap이 0.5초 이상이면 분리 허용
 *
 *   [SPLIT-1] splitTranslationByTime 한국어/일본어/중국어 어절 분배 (치명적 UX 버그 수정)
 *     - 기존: 문자(글자) 단위로 분배 → "안녕하", "세요여" 같은 음절 쪼개기 발생
 *     - 변경: 공백 기준 어절 단위 분배 (한국어는 공백이 어절 경계)
 *     - 공백 없을 때만 문자 단위 fallback (일본어/중국어 대응)
 *     - 결과: 의미 단위가 보존된 자막 분배
 *
 *   [SPLIT-2] splitByPhrase() — 언어별 구절 분리 전처리
 *     - 비라틴계: 조사/어미 경계(은/는/이/가/을/를/에/로/의/도/만/과/와) 뒤에서 선호 분리
 *     - 라틴계: 콤마/접속사(and/but/or/so/because) 앞에서 선호 분리
 *     - splitTranslationByTime 진입 전 적용 → 슬롯 수와 구절 수가 맞으면 1:1 할당
 *
 *   [SCORE-1] scoreTranslation 한국어 특화 보강
 *     - 한국어 문장 종결어미(다/요/죠/까/네/야/어/아) 감지 → 가점
 *     - 한국어 hallucination 패턴(같은 조사 3회 반복) 감지 → 감점
 *     - 원문이 영어, 번역이 한국어인 경우 글자 수 비율 보정(영→한 약 0.7배)
 *
 *   [MAP-2] buildTranslationMap 빈 슬롯 fallback 강화
 *     - 분배 결과 빈 슬롯이 있으면 인접 슬롯 텍스트로 채움
 *     - 최종적으로 빈 슬롯은 전체 merged 번역으로 채움 (기존 동작 유지)
 */

import { TimedTextSegment } from "./youtubeTimedText";
import { TranslationSegment } from "./gemmaTranslationService";
import { getLanguageProfile } from "../constants/languageProfiles";

// ── 상수 ─────────────────────────────────────────────────────────────────────

/** 병합 후 단일 세그먼트 최대 지속 시간(초) */
const YT_MAX_MERGE_DURATION_S = 5.0;

/** 병합 후 단일 세그먼트 최대 문자 수 */
const YT_MAX_MERGE_CHARS = 100;

/** 문장 끝으로 간주하는 구두점 패턴 */
const RE_SENTENCE_END = /[.?!]$/;

/** 절 구분으로 간주하는 구두점 (문장 끝보다 약한 경계) */
const RE_CLAUSE_END = /[,;:]$/;

/**
 * 강제 분리 임계값(초):
 * 이 이상의 pause가 있으면 문장 끝 여부와 무관하게 새 그룹으로 분리.
 */
const YT_FORCE_SPLIT_GAP_S = 1.2;

/**
 * 절 구분자 + pause 조합으로 분리하는 임계값(초).
 * RE_CLAUSE_END로 끝나고 이 이상의 pause이면 분리.
 * [MERGE-1]
 */
const YT_CLAUSE_SPLIT_GAP_S = 0.8;

/**
 * 짧은 fragment 강제 병합 임계값(단어 수):
 * 이 이하이면 문장 끝 여부와 무관하게 다음 세그먼트와 무조건 병합.
 */
const YT_FORCE_MERGE_WORD_COUNT = 3;

/**
 * [MERGE-1] 짧은 fragment 강제 병합 임계값(문자 수):
 * 단어 수가 YT_FORCE_MERGE_WORD_COUNT를 초과해도 문자 수가 이 이하이면 병합 유지.
 */
const YT_FORCE_MERGE_CHAR_COUNT = 20;

/**
 * [MERGE-2] 단문 문장 끝 분리 gap 임계값(초).
 * "Yes." / "I agree." 처럼 짧지만 완결된 문장은
 * gap이 이 이상이면 강제 병합을 예외 처리하여 분리 허용.
 */
const SHORT_SENTENCE_SPLIT_GAP_S = 0.5;

/**
 * [MAP-1] 타이밍 분배 시 독립 segment로 유지하는 최소 duration(초).
 * 이보다 짧은 원본 segment는 번역 분배 대신 merged 번역을 그대로 사용.
 */
const MIN_SPLIT_DURATION_S = 0.8;

/** overlap chunk 방식에서 앞뒤로 겹칠 세그먼트 수 — [FIX-1] 2 → 3 */
export const OVERLAP_SIZE = 3;

/** overlap chunk 하나의 핵심(core) 세그먼트 수 (overlap 제외) */
export const CHUNK_CORE_SIZE = 8;

// ── 언어별 구절 분리 패턴 ──────────────────────────────────────────────────────

/**
 * [SPLIT-2] 한국어 어절 경계 우선 분리에 쓰이는 조사/어미 패턴.
 * 이 패턴으로 끝나는 어절 뒤를 분리 선호점으로 사용.
 */
const RE_KO_PARTICLE_END = /(?:은|는|이|가|을|를|에|로|의|도|만|과|와|으로|에서|에게|께|부터|까지|처럼|보다)$/;

/**
 * [SPLIT-2] 라틴계 언어 구절 분리 선호 접속사/콤마 패턴.
 * 이 단어 앞에서 분리 선호점으로 사용.
 */
const RE_LATIN_SPLIT_BEFORE = /^(?:and|but|or|so|because|however|although|while|when|if|that|which|who)\b/i;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MergedTimedSegment {
  startTime: number;
  endTime: number;
  text: string;
  /** 병합된 원본 timedtext 세그먼트 인덱스들 */
  sourceIndices: number[];
}

export interface OverlappedChunk {
  segments: MergedTimedSegment[];
  /** 이 청크의 결과에서 실제로 채택할 세그먼트 인덱스 범위 (inclusive) */
  keepStart: number;
  keepEnd: number;
  /** 전체 병합 세그먼트 배열 기준 시작 인덱스 */
  globalStart: number;
}

// ── Step 1: mergeSegmentsForYoutube ──────────────────────────────────────────

/**
 * YouTube timedtext 전용 세그먼트 병합.
 *
 * [MERGE-1] v5 개선:
 *   - 문자 수(20자) 기준 추가로 "too short" 판단 정확도 향상
 *   - 절 구분자(,;:) + pause(0.8초) 조합 분리 추가
 *   - 다음 fragment 대문자 시작 시 문장 끝 신호로 강화
 *
 * [MERGE-2] v6 개선:
 *   - 짧은 문장이라도 완결된 문장 + gap >= 0.5초 → 분리 허용
 *   - "Yes." "I agree." 등의 단문이 과병합되어 톤이 깨지는 문제 해결
 */
export function mergeSegmentsForYoutube(
  segments: TimedTextSegment[],
): MergedTimedSegment[] {
  if (segments.length === 0) return [];

  const result: MergedTimedSegment[] = [];
  let current: MergedTimedSegment = {
    startTime: segments[0].startTime,
    endTime: segments[0].endTime,
    text: segments[0].text.trim(),
    sourceIndices: [0],
  };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const nextText = next.text.trim();
    if (!nextText) continue;

    const combinedText = current.text + " " + nextText;
    const combinedDuration = next.endTime - current.startTime;
    const gap = next.startTime - current.endTime;
    const currentWordCount = current.text.split(/\s+/).filter(Boolean).length;
    const currentCharCount = current.text.replace(/\s/g, "").length;

    // ── 강제 분리 조건 ──────────────────────────────────────────────────────

    // 1. 긴 pause: 화자 교체 또는 장면 전환
    const hasForceSplitGap = gap >= YT_FORCE_SPLIT_GAP_S;

    // 2. 용량 초과
    const wouldExceedDuration = combinedDuration > YT_MAX_MERGE_DURATION_S;
    const wouldExceedChars = combinedText.length > YT_MAX_MERGE_CHARS;

    // 3. 문장 끝 + 충분한 길이
    const currentIsSentenceEnd = RE_SENTENCE_END.test(current.text.trimEnd());
    const currentIsLongEnough =
      currentWordCount >= YT_FORCE_MERGE_WORD_COUNT + 1 &&
      currentCharCount >= YT_FORCE_MERGE_CHAR_COUNT;
    const shouldSplitOnSentence = currentIsSentenceEnd && currentIsLongEnough;

    // 4. [MERGE-1] 문장 끝 + 다음 fragment 대문자 시작
    const nextStartsWithCapital = /^[A-Z]/.test(nextText);
    const shouldSplitOnCapital =
      currentIsSentenceEnd && currentIsLongEnough && nextStartsWithCapital;

    // 5. [MERGE-1] 절 구분자 + pause 조합
    const currentIsClauseEnd = RE_CLAUSE_END.test(current.text.trimEnd());
    const shouldSplitOnClause =
      currentIsClauseEnd &&
      gap >= YT_CLAUSE_SPLIT_GAP_S &&
      currentIsLongEnough;

    // ── 강제 병합 조건 ──────────────────────────────────────────────────────
    const currentIsTooShort =
      currentWordCount <= YT_FORCE_MERGE_WORD_COUNT ||
      currentCharCount < YT_FORCE_MERGE_CHAR_COUNT;

    // [MERGE-2] 단문 문장 끝 예외: 짧아도 완결 문장 + gap 충분 → 병합 금지
    // "Yes." + gap 0.6s + "I agree." → 두 문장 유지
    const isShortButComplete =
      currentIsTooShort &&
      currentIsSentenceEnd &&
      gap >= SHORT_SENTENCE_SPLIT_GAP_S;

    const shouldSplit =
      hasForceSplitGap ||
      wouldExceedDuration ||
      wouldExceedChars ||
      shouldSplitOnSentence ||
      shouldSplitOnCapital ||
      shouldSplitOnClause;

    // [MERGE-2] isShortButComplete이면 강제 병합 예외 처리
    const canSplit = !currentIsTooShort || isShortButComplete;

    if (canSplit && shouldSplit) {
      result.push({ ...current });
      current = {
        startTime: next.startTime,
        endTime: next.endTime,
        text: nextText,
        sourceIndices: [i],
      };
    } else {
      current = {
        startTime: current.startTime,
        endTime: next.endTime,
        text: combinedText,
        sourceIndices: [...current.sourceIndices, i],
      };
    }
  }

  if (current.text.trim()) {
    result.push(current);
  }

  return result;
}

// ── Step 2: createOverlappedChunks ───────────────────────────────────────────

/**
 * 병합된 세그먼트 배열을 overlap chunk로 분할.
 *
 * [FIX-1] OVERLAP_SIZE = 3 (기존 2)
 * → 청크 경계 세그먼트에 더 많은 앞뒤 문맥 제공
 *
 * 구조 (core=8, overlap=3):
 *   chunk0: [0..10]          keepStart=0,    keepEnd=7
 *   chunk1: [5..15]          keepStart=3,    keepEnd=10
 *   chunk2: [13..23]         keepStart=3,    keepEnd=10 (또는 끝까지)
 */
export function createOverlappedChunks(
  merged: MergedTimedSegment[],
): OverlappedChunk[] {
  if (merged.length === 0) return [];

  const chunks: OverlappedChunk[] = [];
  let globalStart = 0;

  while (globalStart < merged.length) {
    const isFirst = globalStart === 0;

    const readStart = isFirst ? 0 : globalStart - OVERLAP_SIZE;
    const readEnd = Math.min(readStart + CHUNK_CORE_SIZE + OVERLAP_SIZE * 2, merged.length);

    const segments = merged.slice(readStart, readEnd);

    const keepStart = isFirst ? 0 : OVERLAP_SIZE;
    const isLast = readEnd >= merged.length;
    const keepEnd = isLast ? segments.length - 1 : segments.length - 1 - OVERLAP_SIZE;

    chunks.push({
      segments,
      keepStart,
      keepEnd,
      globalStart,
    });

    const adoptedCount = Math.max(keepEnd - keepStart + 1, 1);
    globalStart += adoptedCount;
  }

  return chunks;
}

// ── Step 3: stitchChunkResults ───────────────────────────────────────────────

/**
 * 청크 번역 결과를 하나의 배열로 조립.
 *
 * 기존 구조: 무조건 앞 chunk(keepStart~keepEnd) 채택
 * 개선 구조: overlap 경계 세그먼트는 앞/뒤 chunk 번역을 scoreTranslation()으로
 *            비교해 더 높은 점수를 가진 쪽을 선택.
 *
 * scoreTranslation() 기준:
 *   1. 길이 점수: 너무 짧으면(< 2자) 감점
 *   2. 문장 끝 구두점: 완전한 문장이면 가점
 *   3. 반복 패턴: 같은 단어/구가 반복되면 감점 (hallucination 징후)
 *   4. 원문 대비 길이 비율: 극단적으로 길면 감점 (overgeneration)
 *   [SCORE-1] 5. 한국어 종결어미 감지 가점
 *   [SCORE-1] 6. 한국어 조사 반복 hallucination 감점
 *   [SCORE-1] 7. 영→한 길이 비율 보정
 */
export function stitchChunkResults(
  chunks: OverlappedChunk[],
  chunkResults: TranslationSegment[][],
  totalMerged: number,
): string[] {
  const result: string[] = new Array(totalMerged).fill("");

  // [STITCH-1] globalIdx별로 후보를 모아두고 최종 선택
  const candidates = new Map<number, Array<{ text: string; score: number }>>();

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const translations = chunkResults[ci];
    if (!translations) continue;

    const { keepStart, keepEnd, globalStart, segments } = chunk;

    for (let li = keepStart; li <= keepEnd; li++) {
      const globalIdx = globalStart + (li - keepStart);
      if (globalIdx >= totalMerged) break;

      const seg = translations[li];
      if (!seg) continue;

      const text = seg.translated || seg.text || segments[li]?.text || "";
      const srcText = segments[li]?.text || "";
      const score = scoreTranslation(text, srcText);

      if (!candidates.has(globalIdx)) {
        candidates.set(globalIdx, []);
      }
      candidates.get(globalIdx)!.push({ text, score });
    }
  }

  // 후보 중 최고 점수 선택
  candidates.forEach((cands, globalIdx) => {
    if (cands.length === 0) return;
    const best = cands.reduce((a, b) => (b.score > a.score ? b : a));
    result[globalIdx] = best.text;
  });

  return result;
}

/**
 * [STITCH-1] + [SCORE-1] 번역 텍스트의 품질 점수 산출 (높을수록 좋음).
 *
 * @param translated  번역 결과
 * @param sourceText  원문
 * @returns           품질 점수 (0~100)
 */
function scoreTranslation(translated: string, sourceText: string): number {
  const t = translated.trim();
  if (!t) return 0;

  let score = 50; // 기본 점수

  // 1. 길이 점수: 너무 짧으면 감점
  if (t.length < 2) return 0;
  if (t.length >= 4) score += 10;

  // 2. 문장 끝 구두점: 완전한 문장이면 가점
  if (/[.?!。？！]$/.test(t)) score += 10;

  // 3. 반복 패턴 감점 (hallucination 징후)
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 4) {
    const wordSet = new Set(words);
    const uniqueRatio = wordSet.size / words.length;
    if (uniqueRatio < 0.5) score -= 30;
    else if (uniqueRatio < 0.7) score -= 15;
  }

  // 4. 원문 대비 길이 비율: 극단적으로 길면 감점 (overgeneration)
  const srcWords = sourceText.split(/\s+/).filter(Boolean).length;
  const tgtWords = words.length;

  // [SCORE-1] 영→한 번역 시 글자 수 비율 보정 (한국어는 영어보다 글자 수가 적음)
  const isKoreanOutput = /[\uAC00-\uD7A3]/.test(t);
  const isEnglishInput = /^[A-Za-z\s.,!?'"]+$/.test(sourceText.trim());
  const overgenThreshold = (isKoreanOutput && isEnglishInput) ? 2.0 : 2.5;

  if (srcWords > 0 && tgtWords > srcWords * overgenThreshold) score -= 20;

  // 5. 숫자/플레이스홀더 누락 감지
  const srcNumbers = (sourceText.match(/\d+/g) ?? []);
  if (srcNumbers.length > 0) {
    const tgtNumbers = new Set(t.match(/\d+/g) ?? []);
    const missingCount = srcNumbers.filter(n => !tgtNumbers.has(n)).length;
    if (missingCount > 0) score -= missingCount * 5;
  }

  // [SCORE-1] 6. 한국어 종결어미 감지 → 완결된 번역이면 가점
  if (isKoreanOutput) {
    if (/(?:다|요|죠|까|네|야|어|아|지|구나|군|걸|게|든|는데|니다|습니다)[.!?。]?$/.test(t)) {
      score += 8;
    }
  }

  // [SCORE-1] 7. 한국어 조사 과반복 hallucination 감지
  //    예: "학교에서 학교에서 학교에서" → 조사 3회 이상 연속 반복
  if (isKoreanOutput) {
    const particleRepeatMatch = t.match(/(\S{2,}(?:은|는|이|가|을|를|에서?|로|의))\s+\1\s+\1/);
    if (particleRepeatMatch) score -= 25;
  }

  return Math.max(0, Math.min(100, score));
}

// ── Step 4: buildTranslationMap ───────────────────────────────────────────────

/**
 * [MAP-1] + [MAP-2] stitchChunkResults 결과와 merged 배열을 합쳐
 * 원본 timedtext 인덱스 기준의 번역 맵을 생성.
 *
 * [MAP-2] v6 개선:
 *   - splitTranslationByTime 분배 결과의 빈 슬롯을 인접 슬롯으로 채움
 *   - 최종 빈 슬롯은 전체 merged 번역으로 fallback
 *
 * @param merged              mergeSegmentsForYoutube() 결과
 * @param stitchedTranslations stitchChunkResults() 결과
 * @param originalSegments    원본 timedtext 세그먼트 전체
 * @param targetLanguage      번역 대상 언어 코드 (예: "Korean", "ko")
 */
export function buildTranslationMap(
  merged: MergedTimedSegment[],
  stitchedTranslations: string[],
  originalSegments: TimedTextSegment[],
  targetLanguage: string = "Korean",
): Map<number, string> {
  const map = new Map<number, string>();
  const profile = getLanguageProfile(targetLanguage);

  for (let i = 0; i < merged.length; i++) {
    const translation = stitchedTranslations[i] || merged[i].text;
    const { sourceIndices } = merged[i];

    // 원본이 하나이거나 번역이 비어있으면 그대로 할당
    if (sourceIndices.length === 1 || !translation.trim()) {
      for (const srcIdx of sourceIndices) {
        map.set(srcIdx, translation);
      }
      continue;
    }

    // [MAP-1] duration 비율 기반 분배 시도
    const srcSegs = sourceIndices.map(idx => originalSegments[idx]);
    const distributed = splitTranslationByTime(
      translation,
      srcSegs,
      profile.isLatinScript,
    );

    // [MAP-2] 빈 슬롯 fallback: 인접 슬롯 텍스트로 채운 뒤 최종 fallback은 전체 번역
    const filled = fillEmptySlots(distributed, translation);

    for (let k = 0; k < sourceIndices.length; k++) {
      map.set(sourceIndices[k], filled[k] ?? translation);
    }
  }

  return map;
}

/**
 * [MAP-2] 분배 결과의 빈 슬롯을 채움.
 *
 * 전략:
 *   1. 앞 방향 전파(forward fill): 비어있으면 앞 슬롯 텍스트 복사
 *   2. 뒤 방향 전파(backward fill): 첫 슬롯이 비어있으면 뒤 슬롯 텍스트 복사
 *   3. 여전히 빈 슬롯은 fallbackText로 채움
 *
 * 주의: 이 함수는 동일 텍스트를 여러 슬롯에 복사하는 것이 의도적임.
 *       단문 fragment가 연속으로 올 때 자막이 완전히 비지 않도록 보호.
 */
function fillEmptySlots(slots: string[], fallbackText: string): string[] {
  const result = [...slots];
  const n = result.length;

  // Forward fill
  for (let k = 1; k < n; k++) {
    if (!result[k]?.trim() && result[k - 1]?.trim()) {
      result[k] = result[k - 1];
    }
  }

  // Backward fill (첫 슬롯이 비어있는 경우)
  for (let k = n - 2; k >= 0; k--) {
    if (!result[k]?.trim() && result[k + 1]?.trim()) {
      result[k] = result[k + 1];
    }
  }

  // 최종 fallback
  return result.map(s => (s?.trim() ? s : fallbackText));
}

/**
 * [MAP-1] + [SPLIT-1] + [SPLIT-2] 번역 텍스트를 원본 세그먼트 duration 비율로 분배.
 *
 * v6 개선 ([SPLIT-1]):
 *   - 비라틴계: 문자 단위 대신 공백 기준 어절 단위 분배
 *     → 한국어 "안녕하세요 여러분" → ["안녕하세요", "여러분"] (어절 단위 유지)
 *     → 공백 없을 때만 문자 단위 fallback (일본어/중국어 대응)
 *   - 어절 수와 슬롯 수가 일치하면 1:1 할당 (최우선)
 *
 * v6 개선 ([SPLIT-2]):
 *   - splitByPhrase()로 구절 분리 전처리
 *   - 구절 수와 슬롯 수가 맞으면 구절 단위 1:1 할당
 *
 * 전략 우선순위:
 *   1. splitByPhrase() 구절 수 == 슬롯 수 → 구절 1:1 할당
 *   2. 어절/단어 단위 duration 비율 분배
 *   3. allTooShort → 동일 번역 반환
 *
 * @param translation     분배할 번역 텍스트
 * @param srcSegs         원본 timedtext 세그먼트들
 * @param isLatinScript   라틴계 언어 여부
 */
function splitTranslationByTime(
  translation: string,
  srcSegs: TimedTextSegment[],
  isLatinScript: boolean,
): string[] {
  const n = srcSegs.length;
  if (n === 0) return [];
  if (n === 1) return [translation];

  // 모든 세그먼트가 너무 짧으면 분배 의미 없음
  const durations = srcSegs.map(s => Math.max(s.endTime - s.startTime, 0.05));
  const allTooShort = durations.every(d => d < MIN_SPLIT_DURATION_S);
  if (allTooShort) {
    return new Array(n).fill(translation);
  }

  const totalDuration = durations.reduce((a, b) => a + b, 0);

  // [SPLIT-2] 구절 분리 시도 — 슬롯 수와 일치하면 1:1 할당
  const phrases = splitByPhrase(translation, isLatinScript);
  if (phrases.length === n) {
    return phrases;
  }

  if (isLatinScript) {
    // ── 라틴계: 단어 단위 분배 ──────────────────────────────────────────────
    const words = translation.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return new Array(n).fill("");
    if (words.length <= n) {
      const result = new Array(n).fill("");
      words.forEach((w, k) => { result[k] = w; });
      return result;
    }

    const result: string[] = [];
    let wordOffset = 0;
    for (let k = 0; k < n; k++) {
      if (k === n - 1) {
        result.push(words.slice(wordOffset).join(" "));
        break;
      }
      const ratio = durations[k] / totalDuration;
      const targetWords = Math.max(1, Math.round(words.length * ratio));
      const take = Math.min(targetWords, words.length - wordOffset - (n - 1 - k));
      result.push(words.slice(wordOffset, wordOffset + take).join(" "));
      wordOffset += take;
    }
    return result;

  } else {
    // ── 비라틴계(한국어, 일본어, 중국어 등) ────────────────────────────────
    // [SPLIT-1] 공백 기준 어절 단위 분배 (공백 없을 때만 문자 단위 fallback)
    const hasSpaces = /\s/.test(translation.trim());

    if (hasSpaces) {
      // 어절 단위 분배 (한국어 핵심 경로)
      const eojeols = translation.trim().split(/\s+/).filter(Boolean);

      if (eojeols.length === 0) return new Array(n).fill("");
      if (eojeols.length <= n) {
        // 어절 수보다 슬롯이 많으면 앞부터 1개씩 배분
        const result = new Array(n).fill("");
        eojeols.forEach((e, k) => { result[k] = e; });
        return result;
      }

      const result: string[] = [];
      let eojeolOffset = 0;
      for (let k = 0; k < n; k++) {
        if (k === n - 1) {
          result.push(eojeols.slice(eojeolOffset).join(" "));
          break;
        }
        const ratio = durations[k] / totalDuration;
        const targetEojeols = Math.max(1, Math.round(eojeols.length * ratio));
        const take = Math.min(targetEojeols, eojeols.length - eojeolOffset - (n - 1 - k));
        result.push(eojeols.slice(eojeolOffset, eojeolOffset + take).join(" "));
        eojeolOffset += take;
      }
      return result;

    } else {
      // 공백 없음 → 문자(글자) 단위 분배 (일본어/중국어 fallback)
      const chars = translation.split("");
      if (chars.length === 0) return new Array(n).fill("");
      if (chars.length <= n) {
        const result = new Array(n).fill("");
        chars.forEach((c, k) => { result[k] = c; });
        return result;
      }

      const result: string[] = [];
      let charOffset = 0;
      for (let k = 0; k < n; k++) {
        if (k === n - 1) {
          result.push(chars.slice(charOffset).join(""));
          break;
        }
        const ratio = durations[k] / totalDuration;
        const targetChars = Math.max(1, Math.round(chars.length * ratio));
        const take = Math.min(targetChars, chars.length - charOffset - (n - 1 - k));
        result.push(chars.slice(charOffset, charOffset + take).join(""));
        charOffset += take;
      }
      return result;
    }
  }
}

/**
 * [SPLIT-2] 번역 텍스트를 언어별 구절 단위로 분리.
 *
 * 비라틴계 (한국어):
 *   - 조사/어미(은/는/이/가/을/를/에/로/의/도/만/과/와 등) 뒤에서 선호 분리
 *   - 이 경계를 기준으로 슬롯 수와 맞는 분리를 시도
 *
 * 라틴계:
 *   - 콤마(,) 또는 접속사(and/but/or/so...) 앞에서 분리
 *
 * 반환: 구절 배열. 슬롯 수와 일치하지 않으면 빈 배열([]) 반환.
 *
 * @param translation   번역 텍스트
 * @param isLatinScript 라틴계 여부
 */
function splitByPhrase(translation: string, isLatinScript: boolean): string[] {
  const text = translation.trim();
  if (!text) return [];

  if (isLatinScript) {
    // 콤마 기준 분리
    const byComma = text.split(/,\s*/).map(s => s.trim()).filter(Boolean);
    if (byComma.length >= 2) return byComma;

    // 접속사 앞 분리
    const byConj = text.split(/\s+(?=\b(?:and|but|or|so|because|however|although|while|when|if)\b)/i)
      .map(s => s.trim()).filter(Boolean);
    if (byConj.length >= 2) return byConj;

    return [];
  } else {
    // 한국어: 조사/어미 뒤 공백 기준 분리 선호점 감지
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 2) return [];

    // 조사로 끝나는 어절 뒤를 분리 선호점으로 마킹
    const splitPoints: number[] = []; // 이 인덱스 다음에서 분리
    for (let k = 0; k < words.length - 1; k++) {
      if (RE_KO_PARTICLE_END.test(words[k])) {
        splitPoints.push(k);
      }
    }

    if (splitPoints.length === 0) return [];

    // 가장 중간에 가까운 분리점 선택 (균형 분리)
    const midWord = (words.length - 1) / 2;
    const bestPoint = splitPoints.reduce((a, b) =>
      Math.abs(b - midWord) < Math.abs(a - midWord) ? b : a,
    );

    const left = words.slice(0, bestPoint + 1).join(" ");
    const right = words.slice(bestPoint + 1).join(" ");
    if (left && right) return [left, right];

    return [];
  }
}

// ── 변환 헬퍼 ─────────────────────────────────────────────────────────────────

/**
 * MergedTimedSegment[] → TranslationSegment[] 변환.
 * translateSegments()의 입력 형식으로 맞춤.
 */
export function toTranslationInput(
  merged: MergedTimedSegment[],
): TranslationSegment[] {
  return merged.map((seg) => ({
    start: seg.startTime,
    end: seg.endTime,
    text: seg.text,
    translated: "",
  }));
}