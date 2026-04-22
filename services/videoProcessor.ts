import * as FileSystem from "expo-file-system/legacy";
import { SubtitleSegment } from "../store/usePlayerStore";
import { AudioChunk, clearChunkDir, getVideoDuration, extractSingleChunkAt } from "./audioChunker";
import { transcribeChunkSegmented, releaseModel as releaseWhisper } from "./whisperService";
import { loadModel as loadGemma, unloadModel as unloadGemma, translateSegments } from "./gemmaTranslationService";
import { getLocalModelPath } from "./modelDownloadService";
import { getLanguageByCode } from "../constants/languages";
import { createThermalController } from "./thermalMonitor";

export interface ProcessingProgress {
  step: "extracting" | "transcribing" | "unloading" | "translating" | "done" | "error";
  current: number;
  total: number;
  percent: number;
  message: string;
  error?: string;
}

export interface ProcessingResult {
  subtitles: SubtitleSegment[];
  translationSkipped: boolean;
}

const BAND_EXTRACT_END    = 10;
const BAND_TRANSCRIBE_END = 90;
const BAND_TRANSLATE_END  = 99;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SENTENCE_END       = /[.?!。]$/;
const MAX_MERGE_DURATION = 2.5;
const MAX_MERGE_CHARS    = 60;

// ── BLANK 판정 패턴 ───────────────────────────────────────────────────────────
const BLANK_PATTERNS = [
  '[BLANK_AUDIO]',
  '[BLANK_VIDEO]',
  '[blank_audio]',
  '[silence]',
  '[SILENCE]',
];

// 괄호 노이즈 패턴: 텍스트 전체가 괄호인 경우만 필터링
const RE_BRACKET_NOISE = /^\s*[\(\[（【][^\)\]）】]*[\)\]）】]\s*[.!?,;]?\s*$/;

function isBlankSegment(text: string): boolean {
  if (!text || text.trim().length <= 2) return true;
  if (BLANK_PATTERNS.some(p => text.includes(p))) return true;
  if (RE_BRACKET_NOISE.test(text)) return true;
  return false;
}

function cleanSegmentText(text: string): string {
  if (!text) return text;
  text = text.replace(/^[.!?,;:\s]+/, '');
  text = text.replace(/\s+[.!?,;:]$/, match => match.trim());
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\s+([.!?,;:])/g, '$1');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.trim();
}

type RawSegment = { startTime: number; endTime: number; text: string; language: string };

function mergeSegmentsIntoSentences(segments: RawSegment[]): RawSegment[] {
  if (segments.length === 0) return [];

  const merged: RawSegment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const combinedText     = current.text + " " + next.text;
    const combinedDuration = next.endTime - current.startTime;

    const wouldExceedDuration = combinedDuration > MAX_MERGE_DURATION;
    const wouldExceedChars    = combinedText.length > MAX_MERGE_CHARS;

    if (wouldExceedDuration || wouldExceedChars) {
      merged.push({ ...current, text: cleanSegmentText(current.text) });
      current = { ...next };
    } else {
      current = {
        startTime: current.startTime,
        endTime:   next.endTime,
        text:      combinedText,
        language:  current.language,
      };

      if (SENTENCE_END.test(current.text.trimEnd())) {
        merged.push({ ...current, text: cleanSegmentText(current.text) });
        if (i + 1 < segments.length) {
          current = { ...segments[++i] };
        } else {
          return merged;
        }
      }
    }
  }

  merged.push({ ...current, text: cleanSegmentText(current.text) });
  return merged;
}

// ── chunk 파일 삭제 헬퍼 ──────────────────────────────────────────────────────
// Whisper가 파일 핸들을 닫기 전에 deleteAsync를 호출하면 Android에서
// "isn't deletable" IOException 발생 → 딜레이 후 재시도, fire-and-forget
async function safeDeleteChunk(filePath: string): Promise<void> {
  await sleep(200);
  try {
    await FileSystem.deleteAsync(filePath, { idempotent: true });
    return;
  } catch {
    await sleep(500);
    try {
      await FileSystem.deleteAsync(filePath, { idempotent: true });
    } catch (e) {
      console.warn("[VideoProcessor] chunk delete failed (will be cleaned by clearChunkDir):", e);
    }
  }
}

// ── [자체 개선] ExtractionOutcome 타입 ───────────────────────────────────────
// SILENT_CHUNK(VAD skip)와 EXTRACTION_ERROR를 명확히 구분.
// 기존: catch 블록에서 모든 에러를 동일하게 skippedChunks++ 처리
//       → SILENT_CHUNK도 "extraction 실패"로 카운트돼 skipRate 오경보 발생
// 개선: SILENT_CHUNK는 정상 처리(VAD가 무음 제거), extraction 실패만 카운트
type ExtractionOutcome =
  | { kind: "ok";      chunk: AudioChunk }
  | { kind: "silent"              }   // VAD → 정상 skip, 실패 아님
  | { kind: "error";   reason: unknown }; // 진짜 extraction 실패

async function tryExtractChunk(
  videoUri: string,
  offset: number,
  chunkDur: number,
  chunkIndex: number,
): Promise<ExtractionOutcome> {
  try {
    const chunk = await extractSingleChunkAt(videoUri, offset, chunkDur, chunkIndex);
    return { kind: "ok", chunk };
  } catch (e: any) {
    // SILENT_CHUNK: native 모듈이 VAD로 판단해 reject — 정상 케이스
    if (e?.code === "SILENT_CHUNK" || e?.message?.includes("SILENT_CHUNK")) {
      return { kind: "silent" };
    }
    return { kind: "error", reason: e };
  }
}

export async function processVideo(
  videoUri: string,
  sourceLanguage: string,
  targetLanguage: string,
  onProgress: (p: ProcessingProgress) => void,
  isCancelled: () => boolean,
  thermalProtection: boolean = true,
): Promise<ProcessingResult> {
  const thermal = createThermalController();
  try {
    // ── Step 1: Duration probe ────────────────────────────────────────────────
    onProgress({
      step: "extracting", current: 0, total: 0,
      percent: 5, message: "오디오 추출 중...",
    });

    const totalDuration = await getVideoDuration(videoUri);
    if (totalDuration <= 0)
      throw new Error("오디오 트랙을 찾을 수 없습니다. mp4/mkv/mov 권장");

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // estimatedTotal: 초기 tier 기준 고정 → tier 변경 시 progress 숫자 점프 없음
    const estimatedTotal = Math.ceil(
      totalDuration / thermal.getTier().chunkDurationSecs,
    );

    onProgress({
      step: "extracting", current: 0, total: estimatedTotal,
      percent: BAND_EXTRACT_END, message: "오디오 추출 중...",
    });

    // ── Step 2: Interleaved extract-then-transcribe loop ──────────────────────
    // [자체 개선] skipRate 경고 임계값 조정
    // 기존: SILENT_CHUNK도 skippedChunks에 포함 → 무음 컨텐츠에서 false alarm
    // 개선: extraction 실패만 skippedChunks++ (SILENT_CHUNK는 별도 silentChunks)
    const SKIP_RATE_WARN_THRESHOLD = 0.3;

    const rawSegments:  RawSegment[] = [];
    let offset        = 0;
    let chunkIndex    = 0;
    let skippedChunks = 0; // extraction 실패만
    let silentChunks  = 0; // VAD skip (정상)

    while (offset < totalDuration) {
      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      const tier     = thermal.getTier();
      const chunkDur = Math.min(tier.chunkDurationSecs, totalDuration - offset);

      const outcome = await tryExtractChunk(videoUri, offset, chunkDur, chunkIndex);

      if (outcome.kind === "silent") {
        // VAD skip — 정상, 실패 카운트 안 함
        silentChunks++;
        if (__DEV__) {
          console.log(`[VideoProcessor] chunk ${chunkIndex} silent (VAD), skipping`);
        }
        offset += chunkDur;
        chunkIndex++;
        onProgress({
          step: "transcribing", current: chunkIndex, total: estimatedTotal,
          percent: Math.round(
            BAND_EXTRACT_END +
            ((offset / totalDuration) * (BAND_TRANSCRIBE_END - BAND_EXTRACT_END)),
          ),
          message: `음성 인식 중... (${chunkIndex}/${estimatedTotal})`,
        });
        continue;
      }

      if (outcome.kind === "error") {
        // 진짜 extraction 실패
        console.warn(`[VideoProcessor] chunk ${chunkIndex} extraction failed:`, outcome.reason);
        skippedChunks++;
        offset += chunkDur;
        chunkIndex++;
        onProgress({
          step: "transcribing", current: chunkIndex, total: estimatedTotal,
          percent: Math.round(
            BAND_EXTRACT_END +
            ((offset / totalDuration) * (BAND_TRANSCRIBE_END - BAND_EXTRACT_END)),
          ),
          message: `음성 인식 중... (${chunkIndex}/${estimatedTotal})`,
        });
        continue;
      }

      // outcome.kind === "ok"
      const chunk = outcome.chunk;

      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      const t0   = Date.now();
      const segs = await transcribeChunkSegmented(
        chunk.filePath, chunk.startTime, sourceLanguage,
      );
      thermal.reportTranscriptionTime(Date.now() - t0, chunkDur);

      // BLANK 필터링
      const filteredSegs = segs.filter(seg => !isBlankSegment(seg.text));
      if (segs.length !== filteredSegs.length) {
        console.log(
          `[VideoProcessor] chunk ${chunkIndex}: ${segs.length - filteredSegs.length} BLANK 세그먼트 제거`
        );
      }
      rawSegments.push(...filteredSegs);

      offset += chunkDur;
      chunkIndex++;

      // fire-and-forget 안전 삭제
      safeDeleteChunk(chunk.filePath);

      onProgress({
        step: "transcribing", current: chunkIndex, total: estimatedTotal,
        percent: Math.round(
          BAND_EXTRACT_END +
          ((offset / totalDuration) * (BAND_TRANSCRIBE_END - BAND_EXTRACT_END)),
        ),
        message: `음성 인식 중... (${chunkIndex}/${estimatedTotal})`,
      });
    }

    // [자체 개선] skipRate: extraction 실패만 포함, silent은 별도 로그
    const totalChunks = chunkIndex;
    const skipRate    = totalChunks > 0 ? skippedChunks / totalChunks : 0;

    if (silentChunks > 0) {
      console.log(
        `[VideoProcessor] ${silentChunks}/${totalChunks} chunks were silent (VAD) — normal`,
      );
    }
    if (skipRate >= SKIP_RATE_WARN_THRESHOLD) {
      console.warn(
        `[VideoProcessor] high extraction failure rate: ${skippedChunks}/${totalChunks}` +
        ` (${Math.round(skipRate * 100)}%) — translation will be skipped`,
      );
    }

    if (rawSegments.length === 0) {
      onProgress({
        step: "done", current: 0, total: 0,
        percent: 100, message: "인식 결과 없음 — 파일을 확인하세요.",
      });
      return { subtitles: [], translationSkipped: true };
    }

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    const sentences = mergeSegmentsIntoSentences(rawSegments);

    // ── Step 3: Translate ─────────────────────────────────────────────────────
    const gemmaPath = await getLocalModelPath();
    let translationSkipped = false;

    const translationInput = sentences.map((seg) => ({
      start:      seg.startTime,
      end:        seg.endTime,
      text:       seg.text,
      translated: "",
    }));

    let translated = translationInput;

    if (!gemmaPath) {
      console.warn("[TRANSLATE] Gemma model not downloaded — skipping translation");
      translationSkipped = true;
    } else {
      onProgress({ step: "unloading", current: 0, total: 0, percent: 91, message: "Whisper 언로드 중..." });
      await releaseWhisper();

      onProgress({ step: "unloading", current: 0, total: 0, percent: 93, message: "메모리 안정화 대기 중..." });

      // thermalProtection 설정에 따라 cooldown 조정
      const cooldownMs: Record<string, number> = thermalProtection
        ? { nominal: 1000, elevated: 2500, critical: 4000 }
        : { nominal: 500,  elevated: 500,  critical: 500  };
      await sleep(cooldownMs[thermal.getTier().name] ?? (thermalProtection ? 2000 : 500));

      if (isCancelled()) return { subtitles: [], translationSkipped: false };

      onProgress({
        step: "translating", current: 0, total: sentences.length,
        percent: 94, message: "Gemma 모델 로드 중...",
      });
      await loadGemma();

      onProgress({
        step: "translating", current: 0, total: sentences.length,
        percent: 95, message: "번역 시작 중...",
      });

      const langMeta = getLanguageByCode(targetLanguage);
      const langName = langMeta?.name ?? targetLanguage;

      console.log("[TRANSLATE] calling translation for segments:", translationInput.length);
      console.log("[TRANSLATE] target language name:", langName);

      try {
        translated = await translateSegments(
          translationInput,
          (completed, total) => {
            const percent = Math.round(
              95 + ((completed / total) * (BAND_TRANSLATE_END - 95)),
            );
            onProgress({
              step: "translating", current: completed, total, percent,
              message: `번역 중... (${completed}/${total})`,
            });
          },
          videoUri,
          langName,
        );
      } finally {
        await unloadGemma();
      }
    }

    if (isCancelled()) return { subtitles: [], translationSkipped: false };

    // ── Step 4: Assemble subtitles ────────────────────────────────────────────
    const subtitles: SubtitleSegment[] = sentences.map((seg, i) => ({
      id:         `sub_${i}_${Math.round(seg.startTime * 1000)}`,
      startTime:  seg.startTime,
      endTime:    seg.endTime,
      original:   seg.text,
      translated: translated[i]?.translated ?? "",
    }));

    onProgress({
      step: "done",
      current: subtitles.length,
      total:   subtitles.length,
      percent: 100,
      message: translationSkipped
        ? "번역 모델 없음 — 원문만 표시"
        : "완료! 재생을 시작합니다...",
    });

    return { subtitles, translationSkipped };
  } finally {
    thermal.dispose();
    await clearChunkDir();
  }
}