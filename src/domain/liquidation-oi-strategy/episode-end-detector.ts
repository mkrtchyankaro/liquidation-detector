import type { Side } from "../../shared/common.types";
import type { Candle } from "../../shared/common.types";

/**
 * Sep 17 2026 (Karo), operator-approved lifecycle correction.
 *
 * PURE PORT of displacement-balanced-core.ts's runStateMachine() --
 * same decision rules, same frozen PRIMARY_VARIANT parameters, made
 * INCREMENTAL (one call per newly-closed candle batch, driven by the
 * live tick loop) instead of batch-replaying a whole pre-fetched
 * array.
 *
 * Not imported directly from the research module: that module pulls
 * in research-only Mongo/Binance-backtest dependencies
 * (loadRawEvents, getCollectionCoverage) that must never be reachable
 * from the live production bundle. The parameters below are a literal
 * mirror, confirmed identical by direct audit against
 * PRIMARY_VARIANT / MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE in
 * displacement-balanced-core.ts; any future change to the frozen
 * research variant must be mirrored here deliberately, never silently.
 *
 * CAUSAL GUARANTEE: only ever reads candles the caller has already
 * confirmed are closed (CandleStore's own closedAfter()) -- no future
 * lookahead, exactly like the research version. OI is NEVER read or
 * referenced anywhere in this file -- episode end is price/ATR/
 * candle-structure only, per the operator's own explicit Phase 2
 * requirement.
 */

export const PRIMARY_VARIANT_MIRROR = {
  candidate1mAtrMultiple: 0.75,
  confirm3mAtrMultiple: 1.0,
  confirm5mAtrMultiple: null as number | null,
  recoveryFractionMinimum: 0.3,
};
export const MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE_MIRROR = 1.0;

export interface EpisodeEndDetectionState {
  /** Running adverse extreme for EPISODE-END purposes, seeded from
   *  the episode's own extremePrice at first evaluation and extended
   *  via closed-candle low/high thereafter (exactly like the research
   *  state machine's own internal `extreme` -- a continuous,
   *  candle-driven adverse extreme, distinct from the liquidation-
   *  event-only extreme Phase 1 already tracks for episode
   *  accumulation; both are legitimate, serving different purposes). */
  extreme: number;
  extremeTime: number;
  candidateTime: number | null;
  lastProcessed1mCloseTime: number;
  lastProcessed3mCloseTime: number;
}

export function initEpisodeEndDetectionState(
  episodeStartPrice: number,
  episodeStartTs: number,
): EpisodeEndDetectionState {
  return {
    extreme: episodeStartPrice,
    extremeTime: episodeStartTs,
    candidateTime: null,
    lastProcessed1mCloseTime: episodeStartTs,
    lastProcessed3mCloseTime: episodeStartTs,
  };
}

export interface EpisodeEndResult {
  state: EpisodeEndDetectionState;
  confirmed: boolean;
  confirmedAtCloseTime: number | null;
  confirmedPrice: number | null;
  extremeUpdated: boolean;
  candidateStarted: boolean;
  candidateInvalidated: boolean;
}

function isMoreAdverse(
  direction: Side,
  candidatePrice: number,
  currentExtreme: number,
): boolean {
  return direction === "LONG"
    ? candidatePrice < currentExtreme
    : candidatePrice > currentExtreme;
}

export interface AtrLookup {
  /** Must return the ATR value effective AT OR BEFORE atMs -- same
   *  causal contract as AtrTrackerService.getWilderATRAtOrBefore(). */
  get(interval: "1m" | "3m" | "5m", atMs: number): number | null;
}

/** Advances episode-end detection by exactly the NEW closed 1m
 *  candles (closeTime > state.lastProcessed1mCloseTime); callers pass
 *  whatever CandleStore.closedAfter() returns -- already-seen candles
 *  are naturally skipped via the cursor. Stops and returns
 *  immediately on the FIRST confirmation (one confirmation attempt
 *  per candidate, matching the research version's own early exit).
 *  The recovery-fraction gate is intentionally NOT applied inside
 *  this function -- see passesRecoveryFractionGate() below, applied
 *  by the caller, which alone knows the episode's own startPrice. */
export function advanceEpisodeEndDetection(
  state: EpisodeEndDetectionState,
  direction: Side,
  new1mCandles: readonly Candle[],
  all3mCandlesSorted: readonly Candle[],
  atr: AtrLookup,
): EpisodeEndResult {
  let extreme = state.extreme,
    extremeTime = state.extremeTime;
  let candidateTime = state.candidateTime;
  let last1m = state.lastProcessed1mCloseTime;
  let last3m = state.lastProcessed3mCloseTime;
  let extremeUpdated = false,
    candidateStarted = false,
    candidateInvalidated = false;

  const relevant1m = new1mCandles
    .filter((c) => c.closeTime > state.lastProcessed1mCloseTime)
    .sort((a, b) => a.closeTime - b.closeTime);

  for (const c of relevant1m) {
    last1m = c.closeTime;
    const adverseCandidate = direction === "LONG" ? c.low : c.high;
    if (isMoreAdverse(direction, adverseCandidate, extreme)) {
      extreme = adverseCandidate;
      extremeTime = c.closeTime;
      extremeUpdated = true;
      if (candidateTime !== null) {
        candidateTime = null;
        candidateInvalidated = true;
      }
    } else if (candidateTime === null) {
      const recovery =
        direction === "LONG" ? c.close - extreme : extreme - c.close;
      const atr1 = atr.get("1m", c.closeTime);
      if (
        atr1 !== null &&
        recovery >= PRIMARY_VARIANT_MIRROR.candidate1mAtrMultiple * atr1
      ) {
        candidateTime = c.closeTime;
        candidateStarted = true;
      }
    }

    if (candidateTime !== null) {
      const pending3m = all3mCandlesSorted.filter(
        (c3) =>
          c3.closeTime > last3m &&
          c3.closeTime <= c.closeTime &&
          c3.closeTime > candidateTime!,
      );
      for (const c3 of pending3m) {
        last3m = c3.closeTime;
        const atr3 = atr.get("3m", c3.closeTime);
        const atr5 = atr.get("5m", c3.closeTime);
        const recovery3m =
          direction === "LONG" ? c3.close - extreme : extreme - c3.close;
        const passes3m =
          atr3 !== null &&
          recovery3m >= PRIMARY_VARIANT_MIRROR.confirm3mAtrMultiple * atr3;
        const passes5m =
          PRIMARY_VARIANT_MIRROR.confirm5mAtrMultiple === null ||
          (atr5 !== null &&
            recovery3m >= PRIMARY_VARIANT_MIRROR.confirm5mAtrMultiple * atr5);

        if (passes3m && passes5m) {
          return {
            state: {
              extreme,
              extremeTime,
              candidateTime: null,
              lastProcessed1mCloseTime: last1m,
              lastProcessed3mCloseTime: last3m,
            },
            confirmed: true,
            confirmedAtCloseTime: c3.closeTime,
            confirmedPrice: c3.close,
            extremeUpdated,
            candidateStarted,
            candidateInvalidated,
          };
        }
        candidateTime = null;
        candidateInvalidated = true;
        break;
      }
    }
  }

  return {
    state: {
      extreme,
      extremeTime,
      candidateTime,
      lastProcessed1mCloseTime: last1m,
      lastProcessed3mCloseTime: last3m,
    },
    confirmed: false,
    confirmedAtCloseTime: null,
    confirmedPrice: null,
    extremeUpdated,
    candidateStarted,
    candidateInvalidated,
  };
}

/** Separate, pure recovery-fraction gate -- evaluated by the caller
 *  (which has the episode's own startPrice) against confirmedPrice
 *  from advanceEpisodeEndDetection(), exactly mirroring the research
 *  version's displacement/fraction check. Returns true if the
 *  confirmation should be ACCEPTED (fraction gate passes or is not
 *  active -- below the minimum-displacement threshold for the gate
 *  to even apply). */
export function passesRecoveryFractionGate(
  direction: Side,
  episodeStartPrice: number,
  extreme: number,
  confirmedPrice: number,
  atr3mAtConfirm: number | null,
): boolean {
  if (PRIMARY_VARIANT_MIRROR.recoveryFractionMinimum === null) return true;
  const episodeDisplacement =
    direction === "LONG"
      ? episodeStartPrice - extreme
      : extreme - episodeStartPrice;
  const episodeDisplacementAtr3m =
    atr3mAtConfirm !== null && atr3mAtConfirm > 0
      ? episodeDisplacement / atr3mAtConfirm
      : null;
  const fractionGateActive =
    episodeDisplacementAtr3m !== null &&
    episodeDisplacementAtr3m >= MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE_MIRROR;
  if (!fractionGateActive) return true;
  if (episodeDisplacement <= 0) return true;
  const recovery =
    direction === "LONG" ? confirmedPrice - extreme : extreme - confirmedPrice;
  const recoveryFraction = recovery / episodeDisplacement;
  return recoveryFraction >= PRIMARY_VARIANT_MIRROR.recoveryFractionMinimum;
}
