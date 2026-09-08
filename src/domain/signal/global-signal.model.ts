import type { Side } from "../../shared/common.types";
import type { V5Wave, V5Wave1Diagnostics, V5TerminalReason } from "../../strategy/v5/v5-wave.model";

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

  btcContext: { priceAtSignal: number | null; oiAtSignal: number | null } | null;
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

  /** Strategy-level outcome ONLY -- never OPEN/CLOSED_TP/CLOSED_SL
   *  (those are per-user, in UserSignalDoc). "SIGNAL" means the
   *  strategy produced a valid, executable plan and fanned it out;
   *  every other value is a V5TerminalReason (episode ended without
   *  ever producing an executable signal at all). */
  status: V5TerminalReason | "SIGNAL";

  createdAt: number;
}
