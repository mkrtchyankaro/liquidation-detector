import type { BookTicker } from "../../shared/common.types";

/**
 * Sep 19 2026 (Karo), operator-requested Episode Research capture.
 *
 * Purely observational -- the SIMPLEST possible "latest value" cache:
 * every Futures and Spot bookTicker tick updates this symbol's own
 * entry; readers (EpisodeResearchRecorder) pull the latest snapshot
 * at whatever moment they need one (episode start, each liquidation
 * event, each new extreme, episode end, entry). No history is kept
 * here -- MarketSnapshotSample is a point-in-time read, and its own
 * age (nowMs - timestamp) is what tells the caller whether it's fresh
 * enough to trust, per the operator's own explicit
 * spotDataAgeMs/futuresDataAgeMs requirement.
 *
 * Deliberately does NOT use Futures mark price -- only real
 * executable order-book bid/ask (mid = (bid+ask)/2), per the
 * operator's own explicit instruction against using mark price for
 * Spot/Futures comparison.
 */

export interface MarketSnapshotSample {
  bid: number;
  ask: number;
  mid: number;
  timestamp: number;
}

export interface BasisSnapshot {
  spotBid: number | null;
  spotAsk: number | null;
  spotMid: number | null;
  spotDataAgeMs: number | null;
  futuresBid: number | null;
  futuresAsk: number | null;
  futuresMid: number | null;
  futuresDataAgeMs: number | null;
  basisUsd: number | null;
  basisBps: number | null;
}

export class MarketSnapshotCache {
  private readonly futures = new Map<string, MarketSnapshotSample>();
  private readonly spot = new Map<string, MarketSnapshotSample>();

  ingestFuturesBookTicker(bt: BookTicker): void {
    this.futures.set(bt.symbol, { bid: bt.bid, ask: bt.ask, mid: (bt.bid + bt.ask) / 2, timestamp: bt.timestamp });
  }

  ingestSpotBookTicker(bt: BookTicker): void {
    this.spot.set(bt.symbol, { bid: bt.bid, ask: bt.ask, mid: (bt.bid + bt.ask) / 2, timestamp: bt.timestamp });
  }

  /** A basis snapshot AS OF nowMs -- both sides null if never seen for
   *  this symbol (e.g. Spot WS not yet connected, or this symbol has
   *  no Spot market at all). basisUsd/basisBps are null unless BOTH
   *  sides are present. */
  getBasisSnapshot(symbol: string, nowMs: number): BasisSnapshot {
    const f = this.futures.get(symbol) ?? null;
    const s = this.spot.get(symbol) ?? null;
    const basisUsd = f !== null && s !== null && s.mid > 0 ? f.mid - s.mid : null;
    const basisBps = basisUsd !== null && s !== null && s.mid > 0 ? (basisUsd / s.mid) * 10_000 : null;
    return {
      spotBid: s?.bid ?? null, spotAsk: s?.ask ?? null, spotMid: s?.mid ?? null,
      spotDataAgeMs: s !== null ? nowMs - s.timestamp : null,
      futuresBid: f?.bid ?? null, futuresAsk: f?.ask ?? null, futuresMid: f?.mid ?? null,
      futuresDataAgeMs: f !== null ? nowMs - f.timestamp : null,
      basisUsd, basisBps,
    };
  }
}
