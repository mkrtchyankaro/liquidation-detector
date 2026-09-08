/**
 * Extracted (not copied wholesale) from liqwatch-bot's own
 * strategy-v2/paper-signal.model.ts -- that file mixes this, a
 * genuinely generic trading concept, together with ~15 other V1/V3
 * paper-signal-specific types (PaperSignalDoc, PaperScoreBreakdown,
 * PaperMagContext, etc). Only the type V5/trade-plan actually needs
 * is reproduced here, deliberately kept minimal.
 *
 * Note: `Side` itself is NOT redefined here -- shared/common.types.ts
 * (copied unchanged from the original project) already exports the
 * identical `Side = "LONG" | "SHORT"` type; every file in this
 * project imports Side from there, a single source of truth.
 */

/** Orderbook-wall snapshot at one point in time. Only `topBid*`/`topAsk*`
 *  /`imbalance` are used by the trade-plan wall-cap math; the
 *  `state`/`pulledNotional`/`pulledPrice` fields are optional forensic
 *  context, kept for shape-compatibility with any wall-tracking code
 *  that wants to populate them. */
export interface WallContext {
  topBidNotional: number;
  topAskNotional: number;
  topBidPrice: number;
  topAskPrice: number;
  imbalance: number; // -1.0 (ask-heavy) -> +1.0 (bid-heavy)
  topBidPersistent: boolean;
  topAskPersistent: boolean;
  state?: "pending" | "holding" | "broken" | "none";
  pulledNotional?: number;
  pulledPrice?: number;
}
