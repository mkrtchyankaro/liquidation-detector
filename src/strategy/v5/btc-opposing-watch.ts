/**
 * Sep 4 2026, operator-requested (Karo) — Step 2A of the production
 * simplification. Shared, PURE BTC opposing-WATCH evaluation.
 *
 * WHY THIS EXISTS: before this file, the opposition-comparison logic
 * lived inline inside fireEntry()'s own execution-blocking branch
 * (simple-liquidation.service.ts). MAIN now also needs to evaluate the
 * SAME question purely for observation/persistence (never blocking).
 * Extracting one pure function that BOTH call sites use guarantees
 * MAIN's own frozen observation and FRIEND/BROTHER's own live
 * execution decision can never drift apart -- there is exactly one
 * place this comparison is written.
 *
 * This function is intentionally pure (no `this`, no I/O, no
 * exceptions from normal inputs) so it is trivially unit-testable and
 * so callers control their own error handling explicitly (see the two
 * call sites in simple-liquidation.service.ts: the execution gate
 * wraps nothing extra since a live in-memory Map.get() cannot throw;
 * MAIN's own observation call site wraps its OWN gathering step in a
 * try/catch, defaulting to UNKNOWN on any unexpected failure, per the
 * operator's own "never silently convert UNKNOWN to CLEAN, never
 * crash" requirement).
 *
 * SEMANTICS (operator-specified):
 *   N/A_BTC     — the signal itself is BTCUSDT (no self-opposition)
 *   CLEAN       — btcWatchVictim is null (reliably known: no active
 *                 BTC watch right now) OR an active watch exists but
 *                 does not oppose this ALT's own side
 *   WOULD_BLOCK — an active BTC watch exists and its own victim side
 *                 matches this ALT's own side (the exact existing
 *                 opposition formula: same-side = opposes)
 *   UNKNOWN     — reserved for the CALLER to use when BTC watch state
 *                 could not be reliably determined at all (this pure
 *                 function itself never returns UNKNOWN from a
 *                 successful call -- see evaluateBtcOpposingWatchSafe()
 *                 below for the wrapped, UNKNOWN-capable entry point
 *                 MAIN's own observation code actually calls).
 */

import type { Side } from '../../shared/common.types';

export type BtcOpposingWatchStatus =
  | "CLEAN"
  | "WOULD_BLOCK"
  | "UNKNOWN"
  | "N/A_BTC";

export interface BtcOpposingWatchEvaluation {
  status: BtcOpposingWatchStatus;
  /** The BTC watch's own victim side, if an active watch existed at
   *  evaluation time -- null otherwise (no watch, N/A_BTC, or UNKNOWN). */
  victimSide: Side | null;
}

/** Pure core comparison -- EXACTLY the same formula as the original
 *  inline fireEntry() logic: same-side-as-victim = opposes. Never
 *  throws on well-typed inputs. */
export function evaluateBtcOpposingWatch(
  altSymbol: string,
  altSide: Side,
  /** null = reliably known that no active BTC watch exists right now.
   *  A Side value = an active BTC watch exists with this victim side.
   *  This function does NOT accept "undefined" -- callers that cannot
   *  reliably determine watch state must use evaluateBtcOpposingWatchSafe()
   *  instead, which produces UNKNOWN explicitly rather than guessing. */
  btcWatchVictim: Side | null,
): BtcOpposingWatchEvaluation {
  if (altSymbol === "BTCUSDT") {
    return { status: "N/A_BTC", victimSide: null };
  }
  if (btcWatchVictim === null) {
    return { status: "CLEAN", victimSide: null };
  }
  const opposes = altSide === btcWatchVictim;
  return {
    status: opposes ? "WOULD_BLOCK" : "CLEAN",
    victimSide: btcWatchVictim,
  };
}

/** Wrapped, never-throws entry point for OBSERVATION call sites (MAIN)
 *  that need an explicit UNKNOWN outcome if the watch-state-gathering
 *  step itself fails unexpectedly, rather than crashing or silently
 *  defaulting to CLEAN. `getBtcWatchVictim` is the caller's own
 *  (possibly throwing) accessor -- e.g. `() => this.watches.get("BTCUSDT")?.victim ?? null`.
 *  Never used by the execution-blocking gate itself, which reads the
 *  live in-memory Map directly (cannot throw) and calls
 *  evaluateBtcOpposingWatch() above without this wrapper. */
export function evaluateBtcOpposingWatchSafe(
  altSymbol: string,
  altSide: Side,
  getBtcWatchVictim: () => Side | null,
): BtcOpposingWatchEvaluation {
  if (altSymbol === "BTCUSDT") {
    return { status: "N/A_BTC", victimSide: null };
  }
  try {
    const victim = getBtcWatchVictim();
    return evaluateBtcOpposingWatch(altSymbol, altSide, victim);
  } catch {
    return { status: "UNKNOWN", victimSide: null };
  }
}
