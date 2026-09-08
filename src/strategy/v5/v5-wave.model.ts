import type { Side } from '../../shared/common.types';

/**
 * V5 Liquidation Wave-Chain model (Sep 7 2026, replacing V4's fixed
 * Wave1/Wave2-retest architecture, per explicit operator-led offline
 * replay validation this session -- see v5_wave_reclaim_experiment.ts,
 * the validated source of this live logic).
 *
 * LIFECYCLE (locked, per explicit operator specification):
 *   - A watch starts ONLY when an individual liquidation event's own
 *     notional clears individualEventP95(symbol) -- PURE P95, no
 *     tier-floor blend (operator-requested, explicit contrast against
 *     V3/V4's own thresholdLargeLiq(), which DOES blend in a tier
 *     floor -- that function is untouched, still used elsewhere; V5
 *     uses its own separate pure-P95 path, see v5-liq-stats.ts).
 *   - That qualifying event becomes Wave 1's own anchor.
 *   - Each wave's own extreme is tracked continuously (own-anchor,
 *     own-extreme, exactly like V4's wave mechanics).
 *   - If price (current market price) reclaims a wave's OWN anchor ->
 *     ENTRY on that wave, unconditionally. No retest-of-a-different-
 *     wave's-extreme requirement (that was V4's Wave2-specific rule;
 *     V5 has no cross-wave comparison at all).
 *   - If a NEW liquidation event arrives while price has ALREADY
 *     moved away from the CURRENT wave's own extreme (any amount) --
 *     i.e. recovery was underway -- that event's own price becomes
 *     the NEXT wave's anchor. The current wave is now permanently
 *     un-reclaimable (SUPERSEDED).
 *   - If a new liquidation event arrives while price is still AT or
 *     beyond the current extreme, it's the SAME continuing push:
 *     added to the current wave's own liquidation total, and may
 *     extend the extreme further.
 *   - No time-based rule of any kind decides wave completion or
 *     failure -- price structure and liquidation-event occurrence are
 *     the only inputs. A large, diagnostic-only safety timeout exists
 *     purely to prevent a pathological watch from tracking forever
 *     (see v5.config.ts) -- it NEVER decides wave completion.
 */

export type V5WaveState = "ACTIVE" | "COMPLETED" | "SUPERSEDED";

export interface V5Wave {
  waveNumber: number;
  state: V5WaveState;

  anchorPrice: number;
  anchorTs: number;

  /** Updated continuously while ACTIVE; frozen once COMPLETED (reclaimed)
   *  or SUPERSEDED (replaced by the next wave). */
  extremePrice: number;
  extremeTs: number;

  /** Set only when state -> COMPLETED (this wave's own anchor was
   *  reclaimed -- this is the wave that produced ENTRY). */
  reclaimPrice: number | null;
  reclaimTs: number | null;

  /** This wave's OWN liquidation accumulation -- never another wave's,
   *  never the whole-episode total (see totalEpisodePressure on the
   *  watch/signal for that). */
  liqNotionalUsd: number;
  liqEvents: number;
  /** Largest single individual event absorbed into this wave -- kept
   *  for diagnostics/audit even though only WAVE 1's own qualifying
   *  event actually gates whether the episode starts at all. */
  maxSingleEventUsd: number;

  /** Sep 7 2026 (Karo) -- best (recovery-direction) price reached
   *  SINCE this wave's own LATEST extreme. Reset to the extreme's own
   *  value every time a new, deeper extreme forms (per explicit
   *  operator instruction: recovery is measured from the latest
   *  extreme, never an earlier one). Uses the SAME price reference as
   *  the reclaim check (never a wick vs close mismatch -- that was a
   *  confirmed, fixed bug in the offline validation). */
  maxRecoveryPrice: number;

  /** (maxRecoveryPrice - extreme) / (anchor - extreme), LONG; mirrored
   *  for SHORT. Null when anchor===extreme (range is zero, genuinely
   *  undefined -- never forced to 0% or 100%, per explicit operator
   *  instruction). Recomputed/persisted at the moment this wave stops
   *  being live (COMPLETED or SUPERSEDED). */
  recoveryPct: number | null;

  /** Sep 7 2026, operator-approved (Karo) -- LIQUIDATION-LAYER
   *  architecture. This wave's OWN price-progress-per-liquidation-
   *  dollar, computed ONLY at the exact moment this wave reaches its
   *  own recoveryTargetPrice (i.e. "layer complete") -- null while
   *  ACTIVE. extremeDistanceAtr already IS this wave's own INCREMENTAL
   *  ATR progress (each wave's anchor starts where the previous one
   *  left off, by construction) -- no separate "incremental progress"
   *  field is needed; this is simply extremeDistanceAtr / liqNotionalUsd,
   *  named for clarity in reports. */
  priceEfficiency: number | null;

  /** Sep 7 2026, operator-approved (Karo) -- this wave's own liquidation
   *  total divided by watch.dominantLayerLiqUsd AS IT STOOD immediately
   *  BEFORE this wave's own completion (i.e. compared against the
   *  PREVIOUS dominant, never itself). Null for the very first wave
   *  ever to reach layer-completion (no prior dominant exists yet).
   *  MEASUREMENT ONLY in this phase -- persisted for every completed
   *  layer so real distributions can be studied before any exhaustion-
   *  magnitude threshold is chosen; the PRODUCTION gate for this phase
   *  is the simple "any decrease" rule (see v5-wave.service.ts's own
   *  gate site), not this ratio's specific value. */
  liquidationRatioVsDominant: number | null;

  /** Same idea as liquidationRatioVsDominant, for priceEfficiency
   *  instead of raw liquidation size. Null under the same conditions
   *  (no prior dominant, or priceEfficiency itself undefined). */
  priceEfficiencyRatioVsDominant: number | null;

  /** Sep 7 2026, operator-approved (Karo) -- the meaningful-extreme
   *  gate (v5MinMeaningfulExtremeAtr(), chosen 0.10 ATR from validated
   *  historical replay). Recomputed continuously as this wave's own
   *  extreme extends -- monotonic within a single wave's life (distance
   *  can only grow, never shrink, since extreme only moves in the
   *  adverse direction), so once true, always true for THIS wave.
   *  extremeDistanceAtr = |anchor-extreme| / atrAtEpisodeStart. */
  extremeDistanceAtr: number;
  isMeaningful: boolean;

  /** Sep 7 2026, operator-approved (Karo) -- which recovery requirement
   *  this wave is CURRENTLY using (recomputed every tick alongside
   *  isMeaningful -- can flip from 100 to 50 mid-life if the extreme
   *  later crosses the meaningful threshold, per explicit operator
   *  instruction; never the reverse, since isMeaningful is monotonic).
   *  Wave 1 has NO target at all while !isMeaningful (selectedRecoveryPct
   *  stays null in that case) -- see v5-wave.service.ts's own gate. */
  selectedRecoveryPct: 50 | 100 | null;
  recoveryTargetPrice: number | null;

  /** Sep 7 2026 (Karo), operator-requested shadow diagnostics ONLY --
   *  first time price reached each recovery milestone toward this
   *  wave's own anchor. NEVER read by any entry/decision logic in this
   *  migration; recorded purely so a later offline pass can compare
   *  50%/75%/100%(reclaim) as alternative hypothetical entry points.
   *  100% is reclaimTs itself, not duplicated here. Null if the
   *  milestone was never reached before this wave ended (reclaimed or
   *  superseded). */
  recovery50AtTs: number | null;
  recovery50AtPrice: number | null;
  recovery75AtTs: number | null;
  recovery75AtPrice: number | null;

  /** Research-only, best-effort -- null if unavailable at the relevant
   *  moment. Never gates any decision. */
  takerBuyUsd: number | null;
  takerSellUsd: number | null;
  takerImbalance: number | null;
  oiStart: number | null;
  oiEnd: number | null;
  oiDeltaPct: number | null;
}

/** Every way a watch can end, successfully or not -- nothing is ever
 *  silently discarded; every terminal reason is persisted with its
 *  full wave-chain fingerprint. */
export type V5TerminalReason =
  | "ANCHOR_RECLAIMED" // some wave's own anchor (100%) OR its 50% recovery target was reached -- ENTRY fired
  | "W1_EXTREME_TOO_SMALL" // Wave1's own extremeDistanceAtr never crossed the meaningful-extreme gate before being superseded -- entire episode discarded, per explicit operator instruction (no entry, no 100% fallback, no Wave2 continuation)
  | "W1_SINGLE_EVENT_ONLY" // Sep 7 2026, operator-requested (Karo) -- Wave1 reached its own recovery/entry trigger (50% or 100%) while still having exactly ONE liquidation event. Regardless of that event's size, price displacement, P95 ratio, or speed, a single-event Wave1 is never sufficient -- the ENTIRE episode is terminated immediately, the watch released. A later liquidation starts a genuinely NEW episode (new anchor, new pressure) -- it must NEVER resurrect this one as a "Wave 2".
  | "WAVE_CHRONOLOGY_INVALID" // Sep 7 2026, operator-requested (Karo) -- hard runtime invariant guard: anchorTs<=extremeTs<=reclaimTs (and extremeTs<=recovery50/75AtTs<=reclaimTs when set) failed at the moment of reclaim. Persistence/entry is REFUSED rather than trusting corrupted chronology -- see V5WaveService's own validateWaveChronology().
  | "EPISODE_EXPIRED_INACTIVITY" // no qualifying liquidation activity for the configured quiet window
  | "EPISODE_EXPIRED_SAFETY_TIMEOUT" // the large, diagnostic-only safety valve -- never a quality filter
  | "BTC_BLOCK_NO_ENTRY" // Sep 8 2026, operator-approved (Karo) -- V5_BTC_BLOCK=true: BTC's own wave-chain reached a genuine entry-trigger, but BTC itself never trades -- it exists purely as a directional filter for other symbols (see v5BtcBlockEnabled()'s own doc comment). Persisted, never silently discarded.
  | "BTC_BLOCK_SAME_SIDE"; // Sep 8 2026, operator-approved (Karo) -- V5_BTC_BLOCK=true: an ALT's own entry-trigger fired, but BTC currently has an active, unresolved SAME-SIDE setup (not opposing -- see v5BtcBlockEnabled()'s own doc comment for the exact truth-table). Persisted, never silently discarded.

/**
 * Sep 7 2026, operator-requested (Karo) -- MEASUREMENT ONLY, not a
 * filter. Captures Wave 1's own full diagnostic fingerprint at the
 * exact moment it stops being the live wave -- whether it fires ENTRY
 * itself, gets superseded to Wave 2, gets discarded
 * (W1_EXTREME_TOO_SMALL), or the episode times out while Wave 1 is
 * still the current wave. Persisted regardless of which wave
 * eventually produces the entry (if any), so "how did W1 look" can
 * always be studied independently of the final outcome. NEVER read by
 * any entry/decision logic -- purely observational, per explicit
 * operator instruction: "just make the live diagnostics complete and
 * trustworthy... then we will decide the actual W1 validity rule from
 * clean live evidence."
 */
export interface V5Wave1Diagnostics {
  qualifyingEventUsd: number;
  p95AtQualification: number;
  qualifyingEventToP95Ratio: number;

  anchorPrice: number;
  anchorTs: number;
  extremePrice: number;
  extremeTs: number;

  extremeDistanceAtr: number;
  anchorToExtremeMs: number;
  /** Null only if anchorToExtremeMs is 0 (division guard) -- an
   *  instantaneous extreme (same tick as anchor) has no defined speed. */
  speedAtrPerMinute: number | null;

  w1TotalLiqUsd: number;
  w1LiqEvents: number;
  /** w1TotalLiqUsd - qualifyingEventUsd -- liquidation absorbed into
   *  W1 AFTER the qualifying event itself, i.e. genuine continuation. */
  continuationLiqUsd: number;
  continuationRatio: number;

  /** Percent price move (anchor->extreme) per $1M of W1's own total
   *  liquidation -- null if w1TotalLiqUsd is 0 (division guard, should
   *  never actually happen since W1 always has at least the qualifying
   *  event). */
  priceImpactPer1M: number | null;

  takerBuyUsd: number | null;
  takerSellUsd: number | null;
  takerImbalance: number | null;

  oiStart: number | null;
  oiEnd: number | null;
  oiDeltaPct: number | null;

  /** Sep 7 2026 (Karo) -- explicit, honest disambiguation. The
   *  operator's own field names (extremeToRecoveryMs/recoveryPctAtEntry)
   *  assume W1 itself always reaches its own conclusion by reclaiming --
   *  but W1 can also be superseded (Wave 2 starts instead) or discarded
   *  (W1_EXTREME_TOO_SMALL) or simply still be ACTIVE when an episode-
   *  level timeout fires. This field states plainly which of those four
   *  things actually happened, so extremeToRecoveryMs/recoveryPctAtEntry
   *  below are never misread as "W1 itself became the entry" when it
   *  didn't. */
  concludedReason: "RECLAIMED_AS_ENTRY" | "SUPERSEDED_TO_W2" | "DISCARDED_TOO_SMALL" | "TERMINATED_SINGLE_EVENT" | "COMPLETED_AS_DOMINANT" | "STILL_ACTIVE_AT_EPISODE_TIMEOUT";
  concludedTs: number;
  /** Time from W1's own extreme to whatever concludedTs above is
   *  (its own reclaim, the liquidation that superseded it, the
   *  liquidation that triggered the too-small discard, or the episode
   *  timeout moment). Named to match the operator's own request. */
  extremeToRecoveryMs: number;
  /** The ACTUAL computed recovery percentage (toward W1's own full
   *  anchor) at concludedTs -- null if anchor===extreme (undefined
   *  range) or W1's own extreme was never displaced from the price
   *  reference used at concludedTs. Distinct from selectedRecoveryPct
   *  (the 50/100 target CHOICE) -- this is the REAL, measured percent. */
  recoveryPctAtEntry: number | null;
}

export interface V5WatchState {
  symbol: string;
  side: Side;
  /** SELL liquidation order = LONG positions force-closed = LONG-victim
   *  (matches the existing, unmodified Liquidation.side convention). */
  victim: Side;
  signalId: string;
  createdAt: number;

  atrAtStart: number;

  /** Full wave chain, in order. waves[waves.length-1] is always the
   *  live/current wave while the watch is still active. */
  waves: V5Wave[];

  /** Never resets -- the TRUE sum of same-side liquidation across the
   *  ENTIRE episode, from the qualifying event through to entry. This
   *  is what feeds cumLiq in the trade plan (the bug found and fixed
   *  during offline validation: previously only the last wave/segment
   *  was passed, silently excluding all earlier pressure). */
  totalEpisodePressure: number;

  /** The individual liquidation event that satisfied pure-P95 and
   *  started this watch, plus the P95 value itself at that moment --
   *  persisted for full audit, per explicit operator instruction. */
  qualifyingEventUsd: number;
  qualifyingEventTs: number;
  p95AtQualification: number;

  /** Sep 7 2026 (Karo) -- live-architecture inactivity tracking
   *  (wall-clock milliseconds, not a per-minute-tick counter -- the
   *  offline replay's minute-loop convention doesn't apply to a live,
   *  continuously-ticking service). Updated on every relevant
   *  liquidation event. */
  lastLiquidationTs: number;

  signalIssued: boolean;
  tradeActive: boolean;

  /** Sep 7 2026, operator-requested (Karo) -- Wave 1's own full
   *  diagnostic snapshot, captured ONCE (the first time it stops being
   *  the live wave) and never overwritten afterward -- persisted into
   *  the eventual V5SignalDoc regardless of which wave produces the
   *  entry (if any). Null only in the brief window before Wave 1 has
   *  concluded by any of its four possible routes. */
  w1Diagnostics: V5Wave1Diagnostics | null;

  /** Sep 7 2026, operator-approved (Karo) -- LIQUIDATION-LAYER
   *  architecture (confirmed design, "B" -- see v5-wave.service.ts's
   *  own gate site for the full lifecycle). Tracks the STRONGEST
   *  completed layer seen so far in this episode. Null until the
   *  first wave EVER reaches its own recoveryTargetPrice (layer-
   *  completion) -- a wave superseded by a NEW liquidation event
   *  BEFORE ever reaching its own target (the existing, untouched
   *  supersession path -- explicitly deferred, see the operator's own
   *  "#3" discussion) never updates or competes for dominance at all.
   *  Growing/tied completed layers UPDATE this immediately (real
   *  production state, not diagnostics-only) -- only a layer that
   *  completes STRICTLY WEAKER than this becomes an exhaustion
   *  candidate and gets to consult the existing recovery-confirmation
   *  entry mechanism. */
  dominantLayerLiqUsd: number | null;
  dominantLayerWaveNumber: number | null;
  dominantLayerPriceEfficiency: number | null;
}

export interface V5SignalDoc {
  signalId: string;
  symbol: string;
  side: Side;
  victim: Side;
  signalTs: number;
  entryPrice: number;
  entryWaveNumber: number;

  /** The complete wave chain that produced this record, in order --
   *  every wave from the qualifying Wave 1 through the wave that
   *  actually reclaimed. Continuously reflects the same array the
   *  watch itself tracked; nothing is trimmed or summarized. */
  waveHistory: V5Wave[];

  /** Sep 7 2026, operator-requested (Karo) -- Wave 1's own complete
   *  diagnostic snapshot, persisted regardless of which wave actually
   *  produced the entry (or whether the episode was discarded before
   *  any entry) -- see V5Wave1Diagnostics's own doc comment. MEASUREMENT
   *  ONLY, never read by any decision/entry logic. Null only for the
   *  small number of pre-this-migration legacy documents that predate
   *  this field's existence. */
  w1Diagnostics: V5Wave1Diagnostics | null;

  /** Never-reset, whole-episode liquidation sum at entry time -- the
   *  corrected cumLiq input (see the module doc comment above). This
   *  IS "fullEpisodeCumLiq" in the operator's own terminology --
   *  deliberately kept as one field, not duplicated under a second
   *  name, since it already serves exactly that role. */
  totalEpisodePressure: number;

  /** Sep 7 2026, operator-approved (Karo) -- LIQUIDATION-LAYER
   *  architecture. The strongest completed layer's own liquidation
   *  total/wave-number, AS IT STOOD AT ENTRY TIME (never updated by
   *  the exhaustion layer itself, since exhaustion is by definition
   *  weaker than dominant). Null only for terminal, non-signal records
   *  where no layer ever reached completion at all (e.g. W1 itself was
   *  discarded/terminated before ever reaching its own target). */
  dominantLayerLiqUsd: number | null;
  dominantLayerWaveNumber: number | null;

  /** The wave that actually produced this entry (or would have, for a
   *  geometry-rejected signal) -- its own liquidation total/wave-
   *  number, kept as an explicitly separate, named concept from both
   *  totalEpisodePressure (whole episode) and dominantLayerLiqUsd
   *  (the strongest layer, which by construction is NEVER the
   *  exhaustion/entry layer). Null for every non-signal terminal
   *  record (no entry ever fired). */
  exhaustionLayerLiqUsd: number | null;
  exhaustionLayerWaveNumber: number | null;

  qualifyingEventUsd: number;
  qualifyingEventTs: number;
  p95AtQualification: number;

  /** Sep 7 2026, operator-approved (Karo) -- explicit, named physics
   *  breakdown. cumLiq is ALWAYS totalEpisodePressure (never a single
   *  wave's own liqNotionalUsd) -- see v5-trade-plan.ts. Carries the
   *  FULL deriveLiquidityTradePlan() forensics so a rejected or wall-
   *  capped plan can be fully audited later without re-deriving
   *  anything. */
  physics: {
    cumLiqUsd: number;
    atrPct: number;
    liqBaseline: number;
    liqStrengthRaw: number;
    liqStrength: number;
    physicsTPPct: number;
    wallAdjustedTpPct: number;
    wallApplied: boolean;
    rrCandidate: number;
    slCapApplied: boolean;
    slCapValue: number;
    finalTpPct: number;
    finalSlPct: number;
    actualRR: number;
  } | null;

  btcContext: {
    priceAtSignal: number | null;
    oiAtSignal: number | null;
  } | null;

  liq24hContext: {
    dayLiqTotalUsd: number;
    dayLiqEvents: number;
  } | null;

  wallContext: {
    topBidNotional: number;
    topAskNotional: number;
    topBidPrice: number;
    topAskPrice: number;
    imbalance: number;
  } | null;

  entry: number | null;
  tp: number | null;
  sl: number | null;
  rr: number | null;

  btcSafetyStatus: "CLEAN" | "WOULD_BLOCK" | "UNKNOWN" | "N/A_BTC";
  executedReal: boolean;
  rejectionReason: string | null;

  /** ANCHOR_RECLAIMED is the only status representing an actual fired
   *  signal; the EPISODE_EXPIRED_* values represent a saved, non-
   *  signal research sample -- nothing is ever silently discarded.
   *  CLOSED_TP/CLOSED_SL only ever follow an ANCHOR_RECLAIMED record
   *  whose plan succeeded and installed a monitorable trade. */
  status: V5TerminalReason | "OPEN" | "CLOSED_TP" | "CLOSED_SL";
  closedAt: number | null;
  closePrice: number | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;

  /** Sep 7 2026, operator-approved (Karo) -- REAL Binance execution
   *  tracking, reusing V3's own BinanceExecutionService pattern
   *  (per explicit operator instruction: same variables/functions,
   *  minimal new code). false/null for a shadow/paper signal -- the
   *  default, and the ONLY state on any instance where
   *  BINANCE_EXECUTION_MODE is not "live". Updated in place (via
   *  V5SignalRepository.markLive()) the moment BinanceExecutionService
   *  confirms a real fill -- entry/tp/sl above reflect the ACTUAL,
   *  post-fill-replanned values from that point on, never the stale
   *  original plan. Required for restart-survivability: reconcileV5OnBoot()
   *  reads this to correctly resume Binance reconciliation (not price-
   *  crossing simulation) for a trade that was live before a restart. */
  isLive: boolean;
  binanceSlOrderId: number | null;
  binanceTpOrderId: number | null;
  /** Sep 7 2026, operator-approved (Karo) -- see V5ActiveTrade's own
   *  doc comment for the same fields; required for accurate daily-
   *  loss-limit accounting on restart (DailyLossLimitTracker's DB-
   *  backed init sums these for today's already-closed live trades). */
  positionQty: number | null;
  notional: number | null;
  riskUsd: number | null;

  createdAt: number;
  updatedAt: number;
}

/** Runtime price-monitoring state for an issued V5 signal's trade --
 *  deliberately separate from V5WatchState. Removed the moment the
 *  trade reaches a terminal outcome. */
export interface V5ActiveTrade {
  signalId: string;
  symbol: string;
  victim: Side;
  side: Side;
  entry: number;
  tp: number;
  sl: number;
  openedAt: number;
  bestPrice: number;
  worstPrice: number;
  /** Sep 7 2026, operator-caught bug fix (Karo) -- was missing
   *  entirely, causing formatV5CloseMessage() to be called with a
   *  hardcoded 0 in app.ts ("Entered on Wave 0" in every CLOSE
   *  message, regardless of the real entry wave). */
  entryWaveNumber: number;

  /** Sep 7 2026, operator-approved (Karo) -- REAL Binance execution
   *  wiring, reusing the EXACT SAME BinanceExecutionService/order-
   *  tracking pattern V3 already uses (per explicit operator
   *  instruction: reuse the same variables and functions, minimal new
   *  code). Null/false for a shadow/paper trade (the default, and the
   *  ONLY behavior on any instance where BINANCE_EXECUTION_MODE is not
   *  "live" -- see v5-wave.service.ts's own evaluateSignal() and
   *  app.ts's own entry-firing site). When isLive is true,
   *  onPriceTickForTrades()'s own price-crossing simulation is NOT
   *  what closes this trade -- app.ts's own reconciliation poll
   *  (mirroring V3's reconcileLiveTrade()) is the sole source of
   *  truth, using Binance's own confirmed fill price/reason. */
  isLive: boolean;
  binanceSlOrderId: number | null;
  binanceTpOrderId: number | null;

  /** Sep 7 2026, operator-approved (Karo) -- REQUIRED for accurate
   *  daily-loss-limit accounting (see DailyLossLimitTracker's own doc
   *  comment). Populated ONLY when isLive is true, from
   *  ExecutionResult's own SUCCESS shape (actualQty/actualNotionalUsdt/
   *  actualRiskUsd) -- the REAL, Binance-confirmed position size, used
   *  to compute the trade's real $ P&L at close (SAME formula V3 uses:
   *  grossPnl = (closePrice-entry)*positionQty*dirMul, fees =
   *  notional*FEE_ROUNDTRIP_PCT). Null for a shadow/paper trade -- no
   *  real money moved, so it never contributes to the daily-loss
   *  accounting at all. */
  positionQty: number | null;
  notional: number | null;
  riskUsd: number | null;
}
