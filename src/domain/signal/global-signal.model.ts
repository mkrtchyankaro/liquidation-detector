import type { Side } from "../../shared/common.types";
import type {
  V5Wave,
  V5Wave1Diagnostics,
  V5TerminalReason,
} from "../../strategy/v5/v5-wave.model";
import type { ResearchCheckpointGroup } from "./research-checkpoint.model";

/**
 * Sep 8 2026 (Karo). Split from liqwatch-bot's own single, mixed
 * V5SignalDoc (strategy-v2/v5/v5-wave.model.ts), which combined
 * strategy-decision fields together with per-execution fields
 * (isLive, binanceSlOrderId, positionQty, riskUsd, status:
 * OPEN/CLOSED_TP/CLOSED_SL, etc). Those per-execution fields now live
 * in UserSignalDoc (user-signal.model.ts) instead -- ONE per (userId,
 * signalId) pair. This document is the SAME for every user; it is
 * never mutated by any single user's own Binance/Telegram lifecycle.
 */
export interface GlobalSignalDoc {
  signalId: string;
  symbol: string;
  side: Side;
  victim: Side;
  signalTs: number;
  entryPrice: number;
  entryWaveNumber: number;

  waveHistory: V5Wave[];
  w1Diagnostics: V5Wave1Diagnostics | null;

  totalEpisodePressure: number;
  dominantLayerLiqUsd: number | null;
  dominantLayerWaveNumber: number | null;
  exhaustionLayerLiqUsd: number | null;
  exhaustionLayerWaveNumber: number | null;

  qualifyingEventUsd: number;
  qualifyingEventTs: number;
  p95AtQualification: number;

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
  liq24hContext: { dayLiqTotalUsd: number; dayLiqEvents: number } | null;
  wallContext: {
    topBidNotional: number;
    topAskNotional: number;
    topBidPrice: number;
    topAskPrice: number;
    imbalance: number;
  } | null;

  /** Canonical, strategy-computed plan -- identical for every user.
   *  Each user's OWN, actually-executed entry/sl/tp (which can differ
   *  slightly due to per-user slippage on fill) lives in that user's
   *  own UserSignalDoc instead. */
  entry: number | null;
  tp: number | null;
  sl: number | null;
  rr: number | null;

  btcSafetyStatus: "CLEAN" | "WOULD_BLOCK" | "UNKNOWN" | "N/A_BTC";
  btcIntendedSideAtSignalTime: Side | null;

  rejectionReason: string | null;

  /** Sep 8 2026 (Karo) -- REVISED (was: V5TerminalReason | "SIGNAL",
   *  which incorrectly stored EVERY plan-rejected candidate as
   *  "SIGNAL" too -- confirmed and reported during a full audit).
   *    - "SIGNAL": a real, executable plan exists (entry/tp/sl all
   *      non-null) and the strategy is now OPEN -- this is the ONLY
   *      status this project's own same-symbol MAIN lock (see
   *      market-data-orchestrator.ts's own mainSymbolLocks) and
   *      startup-hydration treat as "locked/open".
   *    - "CLOSED_TP" / "CLOSED_SL": MAIN's own canonical market-price
   *      TP/SL was touched (V5WaveService.onPriceTickForTrades()) --
   *      completely independent of any user's own Binance state, see
   *      that method's own doc comment.
   *    - "REJECTED_PLAN": evaluateSignal() produced a real event (the
   *      episode DID reach candidate-evaluation) but deriveV5TradePlan()
   *      itself rejected it (entry/tp/sl all null) -- distinct from
   *      "SIGNAL" precisely because there is no executable trade here
   *      at all, and distinct from a V5TerminalReason because this
   *      candidate DID reach entry-evaluation (unlike an episode that
   *      never became a candidate in the first place).
   *    - every other value is a V5TerminalReason (episode ended
   *      without ever reaching entry-evaluation at all). */
  status:
    | V5TerminalReason
    | "SIGNAL"
    | "CLOSED_TP"
    | "CLOSED_SL"
    | "REJECTED_PLAN";

  /** Sep 8 2026 (Karo) -- MAIN's OWN canonical close facts, set ONLY
   *  when status transitions to CLOSED_TP/CLOSED_SL via
   *  onPriceTickForTrades(). Independent of, and never written by,
   *  any user's own UserSignalDoc close (karo/artak's own Binance
   *  reconciliation touches ONLY their own per-user collection --
   *  see reconcile-user-position.usecase.ts, which never imports or
   *  references GlobalSignalRepository at all). */
  closedAt: number | null;
  closePrice: number | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;

  /** Sep 8 2026 (Karo) -- GLOBAL research observations, NEVER
   *  per-user (see research-checkpoint.model.ts's own doc comment).
   *  Grouped by anchor since a single episode has exactly ONE anchor
   *  group in practice (SIGNAL supersedes EXHAUSTION_CANDIDATE for
   *  the same signalId -- see ResearchCheckpointTracker.registerWatch).
   *  Populated incrementally as each of the 5 sparse offsets
   *  completes -- absent/empty until the first one fires, and never
   *  fully populated for episodes still in progress. */
  researchCheckpoints: ResearchCheckpointGroup[];

  createdAt: number;
}
