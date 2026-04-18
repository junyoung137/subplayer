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
  signalIndex:    number | null;  // null when returnReason is "cold_gate"
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

function classify(smoothedValue: number): 0 | 1 | 2 {
  if (smoothedValue < 0.4)  return 0;
  if (smoothedValue < 0.75) return 1;
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
    // G1 [L1] raw ratio
    const ratio = transcriptionOnlyMs / (chunkSecs * 1000);

    // G2 [L2] bypass check
    const bypassActive = ratio >= 0.95;
    let smoothedValue: number = ratio; // bypass default; G4 overrides when not bypassing

    // G3 [L5] push into window, enforce max size 3, cold gate.
    // INTENTIONAL: push before length check so the window always accumulates raw
    // history. Skipping under bypass would leave stale pre-spike values and produce
    // a misleadingly low trimmed mean on the first non-bypass measurement.
    win.push(ratio);
    if (win.length > 3) win.shift();
    if (win.length < 2) {
      onDebugState?.({
        tierName: tier.name, signalIndex: null,
        upgradeCount, downgradeCount,
        window: [...win], graceUsed, bypassActive,
        returnReason: "cold_gate",
      });
      return;
    }

    // G4 [L3] smoothing — skipped when bypass is active
    if (!bypassActive) {
      smoothedValue = trimmedMean(win);
    }

    // G5 [L4] classify; G5b type-narrowing guard (classify always returns 0|1|2)
    const signalIndex: 0 | 1 | 2 | null =
      classify(smoothedValue) as unknown as 0 | 1 | 2 | null;
    if (signalIndex === null) {
      onDebugState?.({
        tierName: tier.name, signalIndex: null,
        upgradeCount, downgradeCount,
        window: [...win], graceUsed, bypassActive,
        returnReason: "cold_gate",
      });
      return;
    }

    // G6 [L6] cold-start grace gate
    if (!graceUsed) {
      if (signalIndex > tierIndex) {
        downgradeCount = 0;
        upgradeCount++;
      } else if (signalIndex < tierIndex) {
        upgradeCount = 0;
        downgradeCount++;
      } else {
        upgradeCount = 0;
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

    // G7 [L7] hysteresis FSM — signalIndex guaranteed 0|1|2
    if (signalIndex > tierIndex) {
      downgradeCount = 0;           // reset opposite first
      upgradeCount++;
      if (upgradeCount >= 2) {
        tierIndex      = Math.min(tierIndex + 1, 2);
        upgradeCount   = 0;
        downgradeCount = 0;
        tier = TIERS[tierIndex];
        setInterChunkDelay(tier.interChunkDelayMs);
      }
    } else if (signalIndex < tierIndex) {
      upgradeCount = 0;             // reset opposite first
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

    // G8 [END] — always after all mutations
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
    dispose:                 () => { /* no timers to release */ },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook — thin wrapper around createThermalController for React components.
// Preserves the original tierRef / reportTranscriptionTime API exactly.
// ─────────────────────────────────────────────────────────────────────────────
export function useThermalThrottle(
  onDebugState?: (state: ThermalDebugState) => void,
): {
  tierRef: React.MutableRefObject<ThermalTier>;
  reportTranscriptionTime: (transcriptionOnlyMs: number, chunkSecs: number) => void;
} {
  const tierRef         = useRef<ThermalTier>(TIERS[0]);
  const onDebugStateRef = useRef(onDebugState);
  onDebugStateRef.current = onDebugState; // keep current without re-creating controller

  const controller = useRef(
    createThermalController((state) => {
      // Keep tierRef in sync whenever the FSM fires.
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
