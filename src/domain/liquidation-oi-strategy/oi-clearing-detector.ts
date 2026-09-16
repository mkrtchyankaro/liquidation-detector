import type { LiquidationOiStrategyConfig } from "./config";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 4.
 *
 * Consumes OiTrackerService.getOiHistory(symbol) samples directly --
 * NO new Binance polling, NO new data source. OI destruction/rebuild
 * is interpreted identically regardless of victim side (OI DECREASING
 * is "destruction" for both a LONG-victim and a SHORT-victim episode
 * -- forced closing reduces open contracts either way), so no
 * sign-flip by side is needed anywhere in this file.
 *
 * Distinguishes FLOW END (no more liquidation events) from CLEARING
 * END (OI destruction has stopped/materially weakened) -- this module
 * answers the latter only; flow-end tracking is the episode tracker's
 * own concern (latestLiqTs).
 */

export interface OiHistorySample {
  contracts: number;
  fetchedAt: number;
}

export interface ClearingWindow {
  windowSec: number;
  slopeContractsPerSec: number | null;
  sampleCount: number;
}

export interface ClearingState {
  windows: readonly ClearingWindow[];
  peakDestructionSlopeContractsPerSec: number | null;
  isDecelerating: boolean | null;
  isStabilizing: boolean | null;
  hasEarlyRebuildSign: boolean | null;
  windowsShowingClearing: number;
  mostRecentSampleAgeMs: number | null;
}

function slopeOverWindow(
  history: readonly OiHistorySample[],
  nowMs: number,
  windowSec: number,
): ClearingWindow {
  const windowStart = nowMs - windowSec * 1000;
  const inWindow = history
    .filter((s) => s.fetchedAt >= windowStart && s.fetchedAt <= nowMs)
    .sort((a, b) => a.fetchedAt - b.fetchedAt);
  if (inWindow.length < 2)
    return {
      windowSec,
      slopeContractsPerSec: null,
      sampleCount: inWindow.length,
    };
  const first = inWindow[0]!,
    last = inWindow[inWindow.length - 1]!;
  const dtSec = (last.fetchedAt - first.fetchedAt) / 1000;
  if (dtSec <= 0)
    return {
      windowSec,
      slopeContractsPerSec: null,
      sampleCount: inWindow.length,
    };
  return {
    windowSec,
    slopeContractsPerSec: (last.contracts - first.contracts) / dtSec,
    sampleCount: inWindow.length,
  };
}

/** Most negative slope-over-any-adjacent-pair across the whole
 *  supplied history -- deliberately the single worst consecutive rate,
 *  not a windowed average, so a brief sharp burst is not diluted. */
function peakDestructionSlope(
  history: readonly OiHistorySample[],
  episodeStartTs: number,
  nowMs: number,
): number | null {
  const relevant = history
    .filter((s) => s.fetchedAt >= episodeStartTs && s.fetchedAt <= nowMs)
    .sort((a, b) => a.fetchedAt - b.fetchedAt);
  if (relevant.length < 2) return null;
  let worst: number | null = null;
  for (let i = 1; i < relevant.length; i++) {
    const dtSec = (relevant[i]!.fetchedAt - relevant[i - 1]!.fetchedAt) / 1000;
    if (dtSec <= 0) continue;
    const slope = (relevant[i]!.contracts - relevant[i - 1]!.contracts) / dtSec;
    if (worst === null || slope < worst) worst = slope;
  }
  return worst;
}

export function detectClearingState(
  history: readonly OiHistorySample[],
  episodeStartTs: number,
  nowMs: number,
  config: LiquidationOiStrategyConfig,
): ClearingState {
  const windows = config.clearingLookbackWindowsSec.map((w) =>
    slopeOverWindow(history, nowMs, w),
  );
  const peak = peakDestructionSlope(history, episodeStartTs, nowMs);

  const shortest = windows[0]!;
  const longest = windows[windows.length - 1]!;
  const isDecelerating =
    shortest.slopeContractsPerSec !== null &&
    longest.slopeContractsPerSec !== null
      ? shortest.slopeContractsPerSec > longest.slopeContractsPerSec
      : null;

  const stabilizationThreshold =
    peak !== null
      ? Math.abs(peak) * config.stabilizationSlopeFractionOfPeak
      : null;
  const isStabilizing =
    shortest.slopeContractsPerSec !== null && stabilizationThreshold !== null
      ? Math.abs(shortest.slopeContractsPerSec) <= stabilizationThreshold
      : null;

  const hasEarlyRebuildSign =
    shortest.slopeContractsPerSec !== null
      ? shortest.slopeContractsPerSec > 0
      : null;

  let windowsShowingClearing = 0;
  for (const w of windows) {
    if (w.slopeContractsPerSec === null) continue;
    if (w.slopeContractsPerSec > 0) {
      windowsShowingClearing++;
      continue;
    }
    if (
      stabilizationThreshold !== null &&
      Math.abs(w.slopeContractsPerSec) <= stabilizationThreshold
    )
      windowsShowingClearing++;
  }

  const mostRecentSample =
    history.length > 0
      ? history.reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b))
      : null;
  const mostRecentSampleAgeMs =
    mostRecentSample !== null ? nowMs - mostRecentSample.fetchedAt : null;

  return {
    windows,
    peakDestructionSlopeContractsPerSec: peak,
    isDecelerating,
    isStabilizing,
    hasEarlyRebuildSign,
    windowsShowingClearing,
    mostRecentSampleAgeMs,
  };
}

/** Separate from detectClearingState so callers can inspect the full
 *  ClearingState for logging even when this boolean is false. */
export function isClearingEndDetected(
  state: ClearingState,
  config: LiquidationOiStrategyConfig,
): boolean {
  return (
    state.windowsShowingClearing >= config.minConsecutiveWindowsForClearingEnd
  );
}
