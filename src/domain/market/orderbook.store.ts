import type { BookTicker, OrderBookSnapshot } from "../../shared/common.types";

/** Sep 15 2026 (Karo), operator-reported CRITICAL FIX. The liquidation-
 *  snapshot enrichment was reading getBookTicker()/getDepth()/
 *  midPrice() -- "whatever is CURRENTLY latest in RAM" -- with zero
 *  timestamp awareness. Since the WS liquidation stream and the WS
 *  bookTicker/depth streams are separate, asynchronous message flows,
 *  by the time the liquidation handler actually executes (network
 *  latency, event-loop scheduling), a NEWER depth/bookTicker update
 *  can already have overwritten "latest" -- confirmed in a real
 *  production document: orderBookAgeMs=-923 (order-book state used
 *  was 923ms AFTER the liquidation's own timestamp). Fix: a SHORT
 *  bounded ring of RAW bookTicker/depth snapshots (last
 *  RAW_RING_SIZE updates -- NOT the 5-minute derived-summary ring
 *  below, which stays unchanged and was already causal), with new
 *  *AtOrBefore() accessors that select the latest entry whose OWN
 *  timestamp <= the requested cutoff. The plain getBookTicker()/
 *  getDepth()/midPrice() methods are left unchanged (nothing else in
 *  the codebase calls them -- confirmed via full-repo search -- so
 *  this is purely additive, not a behavior change for any other
 *  caller). */
const RAW_RING_SIZE = 50;

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
 *  versa). Already causal (getHistorySampleNear filters by
 *  timestamp <= atOrBeforeMs) -- unaffected by this fix. */
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
 * partial-depth snapshot per symbol (unchanged, "latest" semantics,
 * used by nothing else in the codebase today), PLUS:
 *   - a SHORT bounded ring of RAW bookTicker/depth updates, used ONLY
 *     for causal (timestamp <= T) lookups
 *   - a compact, coarsely-sampled history of DERIVED price/bid/ask
 *     totals for computing recent-change deltas (5min retention,
 *     already causal, unchanged by this fix)
 * No reconstruction of full order-book depth beyond the last 50
 * updates, no new Binance request of any kind.
 */
export class OrderbookStore {
  private bookTicker = new Map<string, BookTicker>();
  private depthSnap = new Map<string, OrderBookSnapshot>();
  private bookTickerRing = new Map<string, BookTicker[]>();
  private depthRing = new Map<string, OrderBookSnapshot[]>();
  private history = new Map<string, MarketHistoryEntry[]>();
  private lastSampleMs = new Map<string, number>();

  setBookTicker(bt: BookTicker): void {
    this.bookTicker.set(bt.symbol, bt);
    let ring = this.bookTickerRing.get(bt.symbol);
    if (!ring) {
      ring = [];
      this.bookTickerRing.set(bt.symbol, ring);
    }
    ring.push(bt);
    if (ring.length > RAW_RING_SIZE) ring.shift();
    this.sampleIfDue(bt.symbol, bt.timestamp);
  }

  setDepth(snap: OrderBookSnapshot): void {
    this.depthSnap.set(snap.symbol, snap);
    let ring = this.depthRing.get(snap.symbol);
    if (!ring) {
      ring = [];
      this.depthRing.set(snap.symbol, ring);
    }
    ring.push(snap);
    if (ring.length > RAW_RING_SIZE) ring.shift();
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

  /** CAUSAL bookTicker: the latest retained update whose OWN
   *  timestamp <= atOrBeforeMs. Returns null if every retained
   *  update is after atOrBeforeMs (or none exist yet) -- NEVER falls
   *  back to a future update just to avoid returning null. */
  getBookTickerAtOrBefore(
    symbol: string,
    atOrBeforeMs: number,
  ): BookTicker | null {
    const ring = this.bookTickerRing.get(symbol);
    if (!ring || ring.length === 0) return null;
    let best: BookTicker | null = null;
    for (const bt of ring)
      if (
        bt.timestamp <= atOrBeforeMs &&
        (best === null || bt.timestamp > best.timestamp)
      )
        best = bt;
    return best;
  }

  /** CAUSAL depth snapshot -- same contract as getBookTickerAtOrBefore. */
  getDepthAtOrBefore(
    symbol: string,
    atOrBeforeMs: number,
  ): OrderBookSnapshot | null {
    const ring = this.depthRing.get(symbol);
    if (!ring || ring.length === 0) return null;
    let best: OrderBookSnapshot | null = null;
    for (const snap of ring)
      if (
        snap.timestamp <= atOrBeforeMs &&
        (best === null || snap.timestamp > best.timestamp)
      )
        best = snap;
    return best;
  }

  /** CAUSAL mid price, derived from getBookTickerAtOrBefore(). */
  midPriceAtOrBefore(symbol: string, atOrBeforeMs: number): number | null {
    const bt = this.getBookTickerAtOrBefore(symbol, atOrBeforeMs);
    return bt ? (bt.bid + bt.ask) / 2 : null;
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
