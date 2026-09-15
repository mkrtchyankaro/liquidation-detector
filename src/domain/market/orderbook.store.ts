import type { BookTicker, OrderBookSnapshot } from "../../shared/common.types";

/** Sep 15 2026 (Karo), operator-requested -- compact derived summary
 *  retained per market update, NOT the raw 20-level snapshot (that
 *  would be the "300MB problem" this whole research thread has
 *  explicitly tried to avoid). One entry captures everything the
 *  liquidation-snapshot enrichment needs to compute price-change and
 *  book-imbalance deltas (vs 10s/30s/1m/2m/3m/5m ago): mid price plus
 *  total bid/ask USD summed across all levels in the latest depth20
 *  snapshot known at that instant, and the resulting imbalance ratio.
 *  Fed from BOTH setBookTicker() and setDepth() -- whichever update
 *  arrives first in a given second creates the sample, reading
 *  whatever the OTHER side's latest known value already is (so price
 *  history stays populated even if depth updates lag, and vice
 *  versa). */
interface MarketHistoryEntry {
  timestamp: number;
  midPrice: number | null;
  bidUsdTotal: number | null;
  askUsdTotal: number | null;
  imbalance: number | null; // (bid-ask)/(bid+ask), null when both sides are zero or unknown
}

/** Ring retention window. 5 minutes covers every delta the operator's
 *  own spec asks for (10s through 5m); sized generously rather than
 *  exactly matching the longest requested window so a later request
 *  for a slightly longer lookback doesn't need a second change here. */
const HISTORY_RETENTION_MS = 5 * 60 * 1000;
/** Minimum spacing between retained samples. bookTicker/depth updates
 *  arrive far more often than this; sampling every update would
 *  retain thousands of entries/5min/symbol for no real research
 *  benefit at that granularity -- 1s sampling (matching the RAM-
 *  architecture proposal's own recommendation) keeps this small
 *  (~300 entries/symbol, each ~40 bytes) while still resolving a
 *  10s-ago through 5m-ago comparison precisely. */
const MIN_SAMPLE_SPACING_MS = 1000;

/**
 * Holds the most recent book-ticker (top of book) and the most recent
 * partial-depth snapshot per symbol, PLUS a compact, coarsely-sampled
 * history of derived price/bid/ask totals for computing recent-change
 * deltas. No reconstruction of full book, no raw-level history
 * retained, no new Binance request of any kind -- purely a retained
 * summary of data the bot already receives via its existing WS
 * subscriptions.
 */
export class OrderbookStore {
  private bookTicker = new Map<string, BookTicker>();
  private depthSnap = new Map<string, OrderBookSnapshot>();
  private history = new Map<string, MarketHistoryEntry[]>();
  private lastSampleMs = new Map<string, number>();

  setBookTicker(bt: BookTicker): void {
    this.bookTicker.set(bt.symbol, bt);
    this.sampleIfDue(bt.symbol, bt.timestamp);
  }

  setDepth(snap: OrderBookSnapshot): void {
    this.depthSnap.set(snap.symbol, snap);
    this.sampleIfDue(snap.symbol, snap.timestamp);
  }

  getBookTicker(symbol: string): BookTicker | null {
    return this.bookTicker.get(symbol) ?? null;
  }

  getDepth(symbol: string): OrderBookSnapshot | null {
    return this.depthSnap.get(symbol) ?? null;
  }

  /** Mid price from bookTicker, or null if unknown. */
  midPrice(symbol: string): number | null {
    const bt = this.bookTicker.get(symbol);
    if (!bt) return null;
    return (bt.bid + bt.ask) / 2;
  }

  /** Nearest retained history sample at or before `atOrBeforeMs`, or
   *  null if no sample exists that old (cold start / retention window
   *  not yet reached). Used to compute "price/imbalance change vs
   *  Nms ago" without ever looking at a sample AFTER the requested
   *  time. */
  getHistorySampleNear(
    symbol: string,
    atOrBeforeMs: number,
  ): MarketHistoryEntry | null {
    const hist = this.history.get(symbol);
    if (!hist || hist.length === 0) return null;
    let best: MarketHistoryEntry | null = null;
    for (const h of hist) {
      if (
        h.timestamp <= atOrBeforeMs &&
        (best === null || h.timestamp > best.timestamp)
      )
        best = h;
    }
    return best;
  }

  private sampleIfDue(symbol: string, timestamp: number): void {
    const last = this.lastSampleMs.get(symbol);
    if (last !== undefined && timestamp - last < MIN_SAMPLE_SPACING_MS) return; // coarse sampling -- see MIN_SAMPLE_SPACING_MS doc comment
    this.lastSampleMs.set(symbol, timestamp);

    const bt = this.bookTicker.get(symbol);
    const depth = this.depthSnap.get(symbol);
    const midPrice = bt ? (bt.bid + bt.ask) / 2 : null;
    const bidUsdTotal = depth
      ? depth.bids.reduce((s, l) => s + l.price * l.quantity, 0)
      : null;
    const askUsdTotal = depth
      ? depth.asks.reduce((s, l) => s + l.price * l.quantity, 0)
      : null;
    const imbalance =
      bidUsdTotal !== null &&
      askUsdTotal !== null &&
      bidUsdTotal + askUsdTotal > 0
        ? (bidUsdTotal - askUsdTotal) / (bidUsdTotal + askUsdTotal)
        : null;

    let hist = this.history.get(symbol);
    if (!hist) {
      hist = [];
      this.history.set(symbol, hist);
    }
    hist.push({ timestamp, midPrice, bidUsdTotal, askUsdTotal, imbalance });
    const cutoff = timestamp - HISTORY_RETENTION_MS;
    while (hist.length > 0 && hist[0]!.timestamp < cutoff) hist.shift();
  }
}

export type { MarketHistoryEntry };
