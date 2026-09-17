/**
 * Sep 17 2026 (Karo), operator-requested production-completion pass.
 * Every value here is a SEPARATE concern from the pre-entry market-
 * model thresholds in config.ts -- these govern monitoring cadence,
 * safety retry behavior, and post-entry decision thresholds. All
 * UNTUNED unless explicitly noted otherwise, same convention as
 * config.ts itself.
 */

export interface LiquidationOiActiveLifecycleConfig {
  // ---- Section J: OI + price efficiency controller ----
  /** Minimum OI creation (as a fraction of the position's own starting
   *  OI at ENTRY) for a price/OI reading to count as evidence at all --
   *  below this, a tick is noise and contributes to neither favorable
   *  nor adverse evidence. UNTUNED. */
  oiEfficiencyMinMeaningfulOiCreationFraction: number;
  /** Minimum price displacement (ATR-normalized) for a reading to
   *  count as evidence. UNTUNED. */
  oiEfficiencyMinMeaningfulPriceAtr: number;
  /** How many consecutive evidence-bearing readings in the ADVERSE
   *  direction are required before ADVERSE_CANDIDATE -> ADVERSE_CONFIRMED
   *  (debounce/persistence, not a single-tick exit). UNTUNED. */
  oiEfficiencyConfirmationCount: number;
  /** Rolling window (ms) the controller evaluates deltaOi/deltaPrice
   *  over for each reading. UNTUNED. */
  oiEfficiencyWindowMs: number;
  /** Minimum time (ms) between two consecutive controller evaluations
   *  -- smoothing, prevents every single OI tick from being its own
   *  independent reading. UNTUNED. */
  oiEfficiencyEvalIntervalMs: number;

  // ---- Section K: dynamic TP ----
  /** Minimum TP price change (ATR-normalized) for a revision to be
   *  applied at all -- prevents micro-adjustments. UNTUNED. */
  dynamicTpMinMeaningfulChangeAtr: number;
  /** Minimum time (ms) between two TP revisions for the SAME user --
   *  cooldown. UNTUNED. */
  dynamicTpCooldownMs: number;
  /** TIGHTEN_TP may never move the target closer than this many ATR
   *  from the current price -- a monotonic safety floor so tightening
   *  can never turn into an effective immediate market exit by
   *  accident. UNTUNED. */
  dynamicTpMinDistanceFromPriceAtr: number;

  // ---- Section L/M: termination detection + cleanup ----
  /** How often (ms) the position-lifecycle reconciler polls Binance
   *  for every ACTIVE user's real position state. Reuses each user's
   *  own existing BinanceRestClient -- no new stream. UNTUNED,
   *  conservative default chosen to stay well within REST rate
   *  limits for a small symbol/user count. */
  positionReconciliationIntervalMs: number;
  /** Cleanup retry backoff (ms) after a FAILED_RETRYING cleanup
   *  attempt, before the next attempt. UNTUNED. */
  cleanupRetryIntervalMs: number;

  // ---- Section E: order-book observation ----
  /** ATR-normalized distance band (each direction) within which a
   *  resting order counts as "nearby" for the wall/depth summary.
   *  UNTUNED. */
  orderBookNearbyBandAtr: number;

  // ---- Section C: percentile refresh ----
  /** Low-frequency background refresh interval (ms) for
   *  EpisodePercentileService snapshots, owned entirely by LOX,
   *  independent of V3/V5 close events. Chosen relative to the
   *  existing 3-day rolling window -- refreshing much more often than
   *  this would not meaningfully change a 3-day statistic; refreshing
   *  much less often risks staleness for an active symbol. Marked as
   *  OPERATIONAL INFRASTRUCTURE, not a trading threshold. */
  percentileRefreshIntervalMs: number;
  /** Max concurrent per-symbol reconstructions during a refresh pass
   *  -- keeps the periodic refresh off any single-threaded hot path
   *  and bounds simultaneous Mongo/REST load. */
  percentileRefreshConcurrency: number;

  // ---- Section 13: observational outcome tracking ----
  /** Bounded horizon (ms) an observational (execution-disabled)
   *  ENTRY_READY signal is tracked for MFE/MAE/TP-touch/invalidation-
   *  touch evidence before the observation is finalized and persisted
   *  to Mongo -- never held in memory past this, and never influences
   *  any live decision (strictly retrospective). UNTUNED. */
  observationHorizonMs: number;
}

export const DEFAULT_ACTIVE_LIFECYCLE_CONFIG: LiquidationOiActiveLifecycleConfig = {
  oiEfficiencyMinMeaningfulOiCreationFraction: 0.01, // 1% of starting OI
  oiEfficiencyMinMeaningfulPriceAtr: 0.05,
  oiEfficiencyConfirmationCount: 3,
  oiEfficiencyWindowMs: 15_000,
  oiEfficiencyEvalIntervalMs: 5_000,

  dynamicTpMinMeaningfulChangeAtr: 0.15,
  dynamicTpCooldownMs: 5 * 60_000,
  dynamicTpMinDistanceFromPriceAtr: 0.2,

  positionReconciliationIntervalMs: 15_000,
  cleanupRetryIntervalMs: 30_000,

  orderBookNearbyBandAtr: 1.0,

  percentileRefreshIntervalMs: 6 * 3_600_000, // 6h -- well under the 3-day window itself
  percentileRefreshConcurrency: 3,

  observationHorizonMs: 2 * 3_600_000, // 2h
};
