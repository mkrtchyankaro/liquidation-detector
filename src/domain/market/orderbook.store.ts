import type { BookTicker, OrderBookSnapshot } from "../../shared/common.types";

/** Sep 15 2026 (Karo), operator-reported CRITICAL FIX #2 (root cause
 *  of a SECOND recorder gap, distinct from the wiring fix above).
 *  RAW_RING_SIZE was a fixed ENTRY COUNT, not a time window. On a
 *  high-frequency symbol (BTCUSDT bookTicker can update many times
 *  per second), 50 entries can represent well under a second of real
 *  elapsed time -- so if the liquidation handler has ANY processing
 *  lag at all (network, event-loop scheduling -- the exact same class
 *  of lag that caused the original -923ms bug), by the time it calls
 *  getBookTickerAtOrBefore(T), every one of the 50 currently-retained
 *  entries could already postdate T, since enough newer updates had
 *  already evicted everything older within that tiny lag window.
 *  This is why priceChange*Pct (reading the 5-minute, TIME-windowed,
 *  coarsely-sampled `history` ring below) kept working while the RAW
 *  ring came up empty for the SAME instant -- `history`'s retention
 *  is generous specifically because it's time-based, not count-based.
 *  Fix: switch the raw rings to the SAME time-window retention model
 *  (30s, comfortably larger than any realistic processing lag), with
 *  RAW_RING_MAX_ENTRIES as a defensive absolute cap only for a
 *  pathological burst scenario -- not the primary eviction mechanism
 *  anymore. */
const RAW_RING_RETENTION_MS = 30_000;
const RAW_RING_MAX_ENTRIES = 5000;

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
 *   - a TIME-windowed bounded ring of RAW bookTicker/depth updates
 *     (last RAW_RING_RETENTION_MS, see that constant's own doc
 *     comment for why time-based eviction replaced a fixed entry
 *     count), used ONLY for causal (timestamp <= T) lookups
 *   - a compact, coarsely-sampled history of DERIVED price/bid/ask
 *     totals for computing recent-change deltas (5min retention,
 *     already causal, unaffected by this fix)
 * No reconstruction of full order-book depth beyond the raw ring's own
 * retention window, no new Binance request of any kind.
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
    const cutoff = bt.timestamp - RAW_RING_RETENTION_MS;
    while (ring.length > 0 && ring[0]!.timestamp < cutoff) ring.shift(); // primary eviction: time-based
    if (ring.length > RAW_RING_MAX_ENTRIES)
      ring.splice(0, ring.length - RAW_RING_MAX_ENTRIES); // safety valve only
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
    const cutoff = snap.timestamp - RAW_RING_RETENTION_MS;
    while (ring.length > 0 && ring[0]!.timestamp < cutoff) ring.shift(); // primary eviction: time-based
    if (ring.length > RAW_RING_MAX_ENTRIES)
      ring.splice(0, ring.length - RAW_RING_MAX_ENTRIES); // safety valve only
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
