/**
 * Sep 16 2026 (Karo), operator-approved architecture. Every threshold
 * in this file is an EXPERIMENTAL market-model parameter, not a
 * proven or statistically optimized value -- each is named, its
 * effect on signal frequency documented, and every entry decision
 * logs the actual values compared against these so live trades can
 * be used to tune them later. Mechanical/safety constants (Binance
 * precision, timeouts) are NOT here -- they belong with the code that
 * enforces them, not mixed in with market-model experimentation.
 */

export interface LiquidationOiStrategyConfig {
  minPercentileRankForWatch: number;
  minHistoricalSampleCountForWatch: number;
  minDisplacementAtrForWatch: number;
  clearingLookbackWindowsSec: readonly [5, 10, 15, 30];
  stabilizationSlopeFractionOfPeak: number;
  minConsecutiveWindowsForClearingEnd: number;
  minCounterMoveAtrForEntry: number;
  maxDistanceFromExtremeAtrForEntry: number;
  maxOiSampleAgeMsForEntry: number;
  maxAtrAgeMsForEntry: number;

  /** Sep 16 2026 (Karo), operator-requested lifecycle-death parameters
   *  -- a SEPARATE concern from the market-signal thresholds above
   *  (these govern how long a symbol's tracking slot may be occupied
   *  by a setup that never resolves, not what qualifies a setup).
   *  All UNTUNED, same as everything else in this file. */
  noProgressTimeoutMs: number;
  entryWindowTimeoutMs: number;
  thesisInvalidationAtrMultiple: number;
  marketDataStaleTimeoutMs: number;
  /** FAILSAFE ONLY -- a final safety net so a programming/data edge
   *  case can never lock a symbol indefinitely. NOT the primary
   *  episode-death mechanism (noProgressTimeoutMs/entryWindowTimeoutMs/
   *  thesisInvalidationAtrMultiple/marketDataStaleTimeoutMs are).
   *  Applies across the ENTIRE pre-ACTIVE lifetime (EPISODE_TRACKING
   *  through ENTRY_READY-awaiting-resolution), measured from the
   *  episode's own first liquidation event. */
  preEntryFailsafeMaxLifetimeMs: number;
}

/**
 * minPercentileRankForWatch (default 90): minimum causal historical
 * percentile rank (0-100) the episode's own sameDirectionLiqUsd must
 * reach for WATCH. Higher = fewer, more-serious-only WATCHes. Chosen
 * to match EpisodePercentileService's existing P90 zone, not proven
 * optimal for this strategy.
 *
 * minHistoricalSampleCountForWatch (default 5): minimum prior same-
 * symbol-same-direction episodes before the percentile rank is
 * trusted at all -- below this, WATCH is refused as unreliable
 * rather than gated on a noisy rank.
 *
 * minDisplacementAtrForWatch (default 0.5): minimum episode
 * displacement in ATR3m for WATCH, even if percentile passes -- guards
 * against a technically-serious episode with almost no price movement.
 *
 * clearingLookbackWindowsSec: fixed by the approved architecture
 * itself, not tunable.
 *
 * stabilizationSlopeFractionOfPeak (default 0.15): an OI slope below
 * this fraction of the episode's own peak destruction slope is
 * "flat" -- relative, not an absolute contract count, so it scales
 * across symbols.
 *
 * minConsecutiveWindowsForClearingEnd (default 2): how many of the 4
 * lookback windows must agree before clearing-end is declared --
 * guards against single-sample noise.
 *
 * minCounterMoveAtrForEntry (default 0.15 ATR3m): minimum favorable
 * counter-move from the extreme before ENTRY_READY -- the "early
 * entry" floor.
 *
 * maxDistanceFromExtremeAtrForEntry (default 1.0 ATR3m): beyond this
 * from the extreme, a setup is too stale to enter even if every other
 * gate passes.
 *
 * maxOiSampleAgeMsForEntry (default 5000ms): OI data older than this
 * refuses entry as stale -- never silently ignored.
 *
 * maxAtrAgeMsForEntry (default 240000ms / 4min): ATR3m older than
 * this is treated as not-ready.
 *
 * None of these values are statistically optimized -- they are
 * defensible starting points, each logged on every entry decision so
 * live tiny-risk trades can inform later tuning.
 */
export const DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG: LiquidationOiStrategyConfig =
  {
    minPercentileRankForWatch: 90,
    minHistoricalSampleCountForWatch: 5,
    minDisplacementAtrForWatch: 0.5,
    clearingLookbackWindowsSec: [5, 10, 15, 30],
    stabilizationSlopeFractionOfPeak: 0.15,
    minConsecutiveWindowsForClearingEnd: 2,
    minCounterMoveAtrForEntry: 0.15,
    maxDistanceFromExtremeAtrForEntry: 1.0,
    maxOiSampleAgeMsForEntry: 5_000,
    maxAtrAgeMsForEntry: 240_000,

    // Lifecycle-death parameters -- all UNTUNED starting points.
    // noProgressTimeoutMs (default 30min): in EPISODE_TRACKING, if
    // neither a new same-direction liquidation nor a new adverse
    // extreme has occurred for this long, the flow is considered dead.
    noProgressTimeoutMs: 30 * 60_000,
    // entryWindowTimeoutMs (default 20min): in EXHAUSTION_CANDIDATE
    // (clearing being awaited), if ENTRY_READY has not been reached
    // within this long of entering the state, the window is missed.
    entryWindowTimeoutMs: 20 * 60_000,
    // thesisInvalidationAtrMultiple (default 0.5 ATR3m): in
    // EXHAUSTION_CANDIDATE, if price moves back past the episode's own
    // startPrice by more than this many ATR in the adverse direction,
    // the "capitulation" premise itself has failed.
    thesisInvalidationAtrMultiple: 0.5,
    // marketDataStaleTimeoutMs (default 10min): if the gap between two
    // consecutive onTick calls for a symbol exceeds this, the market
    // data feed itself is considered to have gone stale.
    marketDataStaleTimeoutMs: 10 * 60_000,
    // preEntryFailsafeMaxLifetimeMs (default 4h): FAILSAFE ONLY -- see
    // the field's own doc comment above.
    preEntryFailsafeMaxLifetimeMs: 4 * 3_600_000,
  };
