import React, { useRef, useCallback, useEffect } from "react";
import { setInterChunkDelay } from "./whisperService";

export type ThermalReturnReason =
  | "cold_gate"   // window < 2, discarded
  | "grace_gate"  // first valid eval, transition blocked
  | "evaluated";  // full FSM ran (tier may or may not have changed)

export interface ThermalTier {
  name: "nominal" | "elevated" | "critical";
  interChunkDelayMs: number;
  chunkDurationSecs: number;
}

export interface ThermalDebugState {
  tierName:       "nominal" | "elevated" | "critical";
  signalIndex:    number | null;
  upgradeCount:   number;
  downgradeCount: number;
  window:         number[];
  graceUsed:      boolean;
  bypassActive:   boolean;
  returnReason:   ThermalReturnReason;
}

const TIERS: ThermalTier[] = [
  { name: "nominal",  interChunkDelayMs: 800,  chunkDurationSecs: 30 },
  { name: "elevated", interChunkDelayMs: 1800, chunkDurationSecs: 20 },
  { name: "critical", interChunkDelayMs: 3000, chunkDurationSecs: 15 },
];

// ── 분류 임계값 ───────────────────────────────────────────────────────────────
// ratio = transcriptionOnlyMs / (chunkSecs * 1000)
//   < 0.4  → nominal  (30s 청크 기준: < 12초 → 충분히 빠름)
//   < 0.75 → elevated (30s 청크 기준: 12~22.5초)
//   ≥ 0.75 → critical (30s 청크 기준: ≥ 22.5초 → 실시간 비율 75% 이상 소요)
//
// [자체 개선] 임계값 튜닝:
//   기존: 0.4 / 0.75
//   개선: 0.35 / 0.70
//   이유: 20s 청크(elevated tier)에서 ratio가 자연히 높아지는 현상 보정.
//         elevated → critical 전환이 너무 민감하게 반응하는 문제 완화.
//         downgrade(0.35 미만) 기준도 함께 낮춰 recovery 속도 유지.
function classify(smoothedValue: number): 0 | 1 | 2 {
  if (smoothedValue < 0.35) return 0;
  if (smoothedValue < 0.70) return 1;
  return 2;
}

function trimmedMean(window: number[]): number {
  if (window.length === 2) {
    return (window[0] + window[1]) / 2;
  }
  // length === 3: sort, remove one min and one max, return middle
  const sorted = [...window].sort((a, b) => a - b);
  return sorted[1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory — plain-variable state machine, no React dependency.
// ─────────────────────────────────────────────────────────────────────────────
export function createThermalController(
  onDebugState?: (state: ThermalDebugState) => void,
): {
  getTier:                 () => ThermalTier;
  reportTranscriptionTime: (transcriptionOnlyMs: number, chunkSecs: number) => void;
  dispose:                 () => void;
} {
  let win:            number[]    = [];
  let tierIndex:      number      = 0;
  let tier:           ThermalTier = TIERS[0];
  let upgradeCount:   number      = 0;
  let downgradeCount: number      = 0;
  let graceUsed:      boolean     = false;

  function reportTranscriptionTime(
    transcriptionOnlyMs: number,
    chunkSecs: number,
  ): void {
    // G1 raw ratio
    const ratio = transcriptionOnlyMs / (chunkSecs * 1000);

    // G2 bypass: 비율 ≥ 0.95 → 심각한 과부하. 스무딩 없이 즉시 신호 사용.
    // INTENTIONAL: 아래 window.push는 bypass 여부와 무관하게 항상 실행.
    // bypass 조건에서 push를 건너뛰면, 스파이크 후 첫 정상 측정값의
    // trimmedMean이 스파이크 이전 값들로만 구성돼 과도하게 낮아지는 문제 발생.
    const bypassActive = ratio >= 0.95;
    let smoothedValue: number = ratio; // bypass 시 기본값

    // G3 window 유지 (최대 3)
    win.push(ratio);
    if (win.length > 3) win.shift();

    // [자체 개선] cold gate: 기존 win.length < 2 → win.length < 2 유지
    // 단, bypass일 때는 cold gate 면제: 비율 0.95 이상은 즉시 처리 필요
    if (win.length < 2 && !bypassActive) {
      onDebugState?.({
        tierName: tier.name, signalIndex: null,
        upgradeCount, downgradeCount,
        window: [...win], graceUsed, bypassActive,
        returnReason: "cold_gate",
      });
      return;
    }

    // G4 스무딩 — bypass일 때 스킵 (raw ratio 사용)
    if (!bypassActive) {
      smoothedValue = trimmedMean(win);
    }

    // G5 classify
    const signalIndex: 0 | 1 | 2 = classify(smoothedValue);

    // G6 grace gate: 첫 번째 유효 평가. 방향은 기록하되 tier 전환은 블록.
    if (!graceUsed) {
      if (signalIndex > tierIndex) {
        downgradeCount = 0;
        upgradeCount++;
      } else if (signalIndex < tierIndex) {
        upgradeCount = 0;
        downgradeCount++;
      } else {
        upgradeCount   = 0;
        downgradeCount = 0;
      }
      graceUsed = true;
      onDebugState?.({
        tierName: tier.name, signalIndex,
        upgradeCount, downgradeCount,
        window: [...win], graceUsed, bypassActive,
        returnReason: "grace_gate",
      });
      return;
    }

    // G7 hysteresis FSM
    // upgrade 임계: 2 연속 → 빠른 반응 (과열 대응)
    // downgrade 임계: 3 연속 → 느린 회복 (flapping 방지)
    if (signalIndex > tierIndex) {
      downgradeCount = 0;
      upgradeCount++;
      if (upgradeCount >= 2) {
        tierIndex      = Math.min(tierIndex + 1, 2);
        upgradeCount   = 0;
        downgradeCount = 0;
        tier = TIERS[tierIndex];
        setInterChunkDelay(tier.interChunkDelayMs);
      }
    } else if (signalIndex < tierIndex) {
      upgradeCount = 0;
      downgradeCount++;
      if (downgradeCount >= 3) {
        tierIndex      = Math.max(tierIndex - 1, 0);
        upgradeCount   = 0;
        downgradeCount = 0;
        tier = TIERS[tierIndex];
        setInterChunkDelay(tier.interChunkDelayMs);
      }
    } else {
      upgradeCount   = 0;
      downgradeCount = 0;
    }

    // G8 always after all mutations
    onDebugState?.({
      tierName: tier.name, signalIndex,
      upgradeCount, downgradeCount,
      window: [...win], graceUsed, bypassActive,
      returnReason: "evaluated",
    });
  }

  return {
    getTier:                 () => tier,
    reportTranscriptionTime,
    dispose:                 () => { /* no timers */ },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook — thin wrapper around createThermalController for React components.
// ─────────────────────────────────────────────────────────────────────────────
export function useThermalThrottle(
  onDebugState?: (state: ThermalDebugState) => void,
): {
  tierRef: React.MutableRefObject<ThermalTier>;
  reportTranscriptionTime: (transcriptionOnlyMs: number, chunkSecs: number) => void;
} {
  const tierRef         = useRef<ThermalTier>(TIERS[0]);
  const onDebugStateRef = useRef(onDebugState);
  onDebugStateRef.current = onDebugState;

  const controller = useRef(
    createThermalController((state) => {
      tierRef.current = TIERS.find((t) => t.name === state.tierName) ?? TIERS[0];
      onDebugStateRef.current?.(state);
    }),
  ).current;

  useEffect(() => () => controller.dispose(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const reportTranscriptionTime = useCallback(
    (ms: number, chunkSecs: number) => controller.reportTranscriptionTime(ms, chunkSecs),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return { tierRef, reportTranscriptionTime };
}