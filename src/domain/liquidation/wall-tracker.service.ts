import type { OrderBookSnapshot } from '../../shared/common.types';
import type { ObservabilityConfig } from '../../infrastructure/config/observability.config';
import { median } from '../../shared/math';
import { childLogger } from '../../infrastructure/logging/logger';

/** Public view of a tracked candidate wall. */
export interface WallCandidate {
  symbol: string;
  side: "BID" | "ASK";
  /** Inclusive low price of the band the wall lives in. */
  priceBandLow: number;
  /** Inclusive high price of the band the wall lives in. */
  priceBandHigh: number;
  /** A representative price within the band (best level price last seen there). */
  representativePrice: number;
  firstSeenAt: number;
  lastSeenAt: number;
  ageMs: number;
  peakNotional: number;
  currentNotional: number;
  snapshotsObserved: number;
  /** ms when the wall was first marked as pulled (null = still healthy). */
  pulledAt: number | null;
  /** Wall has lived ≥ minPersistenceMs and has never been pulled. */
  isPersistent: boolean;
}

export interface WallTrackerSnapshot {
  symbol: string;
  topBidWall: WallCandidate | null;
  topAskWall: WallCandidate | null;
  candidateBidCount: number;
  candidateAskCount: number;
  /** Walls pulled within the last 60 seconds, both sides combined. */
  pulled1mCount: number;
}

/**
 * Step E2 — point-in-time snapshot used by the persistence layer to write a
 * minute aggregate to Mongo. Combines the WallTrackerSnapshot view of the
 * current state with two minute-window counters that the tracker accumulates
 * during ingest. Counters are RESET to zero by snapshotForPersist().
 *
 * Note the semantic distinction:
 *   pulled1mCount   — running 60s window of pull events (live monitoring)
 *   pulledMinute    — count of pull transitions DURING this exact minute,
 *                     reset to 0 after each snapshotForPersist() call.
 *   newWallsMinute  — count of new walls created DURING this exact minute.
 */
export interface WallPersistSnapshot {
  symbol: string;
  topBidWall: WallCandidate | null;
  topAskWall: WallCandidate | null;
  candidateBidCount: number;
  candidateAskCount: number;
  persistentBidCount: number;
  persistentAskCount: number;
  pulledMinute: number;
  newWallsMinute: number;
  /** Mid price at the moment of snapshot (best bid+ask)/2 from last ingest;
   *  null if this symbol has not been ingested yet. */
  midPrice: number | null;
}

interface TrackedWall {
  side: "BID" | "ASK";
  bandKey: number;
  priceBandLow: number;
  priceBandHigh: number;
  representativePrice: number;
  firstSeenAt: number;
  lastSeenAt: number;
  peakNotional: number;
  currentNotional: number;
  snapshotsObserved: number;
  pulledAt: number | null;
}

interface SymbolState {
  bidWalls: Map<number, TrackedWall>;
  askWalls: Map<number, TrackedWall>;
  lastProcessedMs: number;
  lastMid: number;
  /** Counter (incremented every time a tracked wall transitions to pulled
   *  during ingest). Reset to 0 by snapshotForPersist() at minute boundaries. */
  pulledThisMinute: number;
  /** Counter (incremented every time a new wall is created in updateSide).
   *  Reset to 0 by snapshotForPersist() at minute boundaries. */
  newWallsThisMinute: number;
}

/**
 * Per-symbol tracker for limit-order walls observed in depth20 snapshots.
 *
 * The depth20 stream arrives every 100 ms; we throttle to `throttleMs`
 * (default 250 ms) per symbol to keep CPU light.
 *
 * Wall identification (per snapshot, per side):
 *   1. Compute median level notional across the 20 levels of that side.
 *   2. A level qualifies as a candidate wall when its notional ≥
 *      wallMedianMultiplierByTier[tier] × median (default 5× for btc/eth,
 *      3× for largeAlt/midAlt/smallAlt). Per-tier because alt-coin
 *      orderbooks tend to have flatter notional distributions than BTC/ETH.
 *   3. Adjacent qualifying levels within bandPctOfMid (default 0.01% of mid)
 *      are aggregated into a single price band — we don't double-count two
 *      ticks of the same wall.
 *
 * Persistence (per tracked band):
 *   - First time we see a band, it is `firstSeenAt = now`.
 *   - Each subsequent snapshot it appears in, we update lastSeenAt and
 *     refresh peak/current notional.
 *   - A wall becomes `isPersistent` once `now - firstSeenAt ≥ minPersistenceMs`
 *     (default 3 s) AND it has never been marked pulled.
 *
 * Pull / spoof detection (per tracked band):
 *   - In any snapshot where the band is no longer above the wall threshold,
 *     we look at how much it shrank vs peak.
 *   - If the band shrank ≥ pullShrinkPct of its peak (default 70%) OR the
 *     band sits within pullProximityPct of mid when it disappears (default
 *     0.1%), we set pulledAt = now.
 *   - pulledAt is sticky — once a band has been pulled, it stays pulled
 *     even if the wall later reappears, because a wall that has been pulled
 *     once cannot be trusted as confirmation in this strategy.
 *
 * Memory: per symbol we keep at most maxTrackedPerSymbol bands per side
 * (default 50). Bands not seen for evictAfterMs (default 30 s) are dropped.
 *
 * This service does not emit events, does not log periodic summaries, and
 * does not call into the strategy layer. ObservabilityMonitor reads
 * snapshot() and prints the summary line.
 */
export class WallTrackerService {
  private readonly log = childLogger({ mod: "wall-track" });
  private readonly state = new Map<string, SymbolState>();
  private readonly cfg: ObservabilityConfig["wallTracker"];
  private readonly tierMap: ObservabilityConfig["tierMap"];
  private readonly defaultTier: ObservabilityConfig["defaultTier"];

  constructor(cfg: ObservabilityConfig) {
    this.cfg = cfg.wallTracker;
    this.tierMap = cfg.tierMap;
    this.defaultTier = cfg.defaultTier;
  }

  /** Per-symbol wall multiplier. Resolves the symbol's tier and looks up the
   *  tier-specific multiplier configured in `wallMedianMultiplierByTier`. */
  private wallMultiplierFor(symbol: string): number {
    const tier = this.tierMap[symbol] ?? this.defaultTier;
    return this.cfg.wallMedianMultiplierByTier[tier];
  }

  // ── Ingest ───────────────────────────────────────────────────────

  ingest(snap: OrderBookSnapshot): void {
    if (snap.bids.length === 0 || snap.asks.length === 0) return;
    const s = this.ensure(snap.symbol);
    const now = snap.timestamp;
    if (now - s.lastProcessedMs < this.cfg.throttleMs) return;
    s.lastProcessedMs = now;

    const bestBid = snap.bids[0]!.price;
    const bestAsk = snap.asks[0]!.price;
    const mid = (bestBid + bestAsk) / 2;
    if (!(mid > 0)) return;
    s.lastMid = mid;

    const bandSize = mid * this.cfg.bandPctOfMid;
    if (!(bandSize > 0)) return;

    // Compute per-side median + wall threshold (multiplier is tier-aware).
    const multiplier = this.wallMultiplierFor(snap.symbol);
    const bidNotionals = snap.bids.map((l) => l.price * l.quantity);
    const askNotionals = snap.asks.map((l) => l.price * l.quantity);
    const minBidWall = median(bidNotionals) * multiplier;
    const minAskWall = median(askNotionals) * multiplier;

    // Aggregate level notionals into bands
    const bidBands = aggregateIntoBands(snap.bids, bandSize, "BID");
    const askBands = aggregateIntoBands(snap.asks, bandSize, "ASK");

    this.updateSide(
      s,
      s.bidWalls,
      "BID",
      bidBands,
      minBidWall,
      bandSize,
      mid,
      now,
    );
    this.updateSide(
      s,
      s.askWalls,
      "ASK",
      askBands,
      minAskWall,
      bandSize,
      mid,
      now,
    );
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** All currently-tracked candidates on a side, sorted by peak notional desc. */
  getCandidateWalls(symbol: string, side: "BID" | "ASK"): WallCandidate[] {
    const s = this.state.get(symbol);
    if (!s) return [];
    const tracked = side === "BID" ? s.bidWalls : s.askWalls;
    const now = Date.now();
    const out: WallCandidate[] = [];
    for (const w of tracked.values())
      out.push(this.toCandidate(symbol, w, now));
    out.sort((a, b) => b.peakNotional - a.peakNotional);
    return out;
  }

  getPersistentWalls(symbol: string, side: "BID" | "ASK"): WallCandidate[] {
    return this.getCandidateWalls(symbol, side).filter((c) => c.isPersistent);
  }

  getLargestPersistentWall(
    symbol: string,
    side: "BID" | "ASK",
  ): WallCandidate | null {
    const persistent = this.getPersistentWalls(symbol, side);
    return persistent.length > 0 ? persistent[0]! : null;
  }

  /**
   * Was any tracked wall on the given side, near the given price, marked as
   * pulled within the last `withinMs` ms? "Near" = within 2 × pullProximityPct
   * of nearPrice (slightly wider than the approach radius so we don't miss
   * walls that drifted a bit before being pulled).
   */
  wasWallPulled(
    symbol: string,
    side: "BID" | "ASK",
    nearPrice: number,
    withinMs: number,
  ): boolean {
    const s = this.state.get(symbol);
    if (!s) return false;
    if (!(nearPrice > 0)) return false;
    const tracked = side === "BID" ? s.bidWalls : s.askWalls;
    const cutoff = Date.now() - withinMs;
    const radius = this.cfg.pullProximityPct * 2;
    for (const w of tracked.values()) {
      if (w.pulledAt === null) continue;
      if (w.pulledAt < cutoff) continue;
      if (Math.abs(w.representativePrice - nearPrice) / nearPrice <= radius)
        return true;
    }
    return false;
  }

  // ── Snapshot ─────────────────────────────────────────────────────

  snapshot(symbol: string): WallTrackerSnapshot {
    const bids = this.getCandidateWalls(symbol, "BID");
    const asks = this.getCandidateWalls(symbol, "ASK");
    const persistentBids = bids.filter((b) => b.isPersistent);
    const persistentAsks = asks.filter((a) => a.isPersistent);
    const cutoff = Date.now() - 60_000;

    let pulled1m = 0;
    const s = this.state.get(symbol);
    if (s) {
      for (const w of s.bidWalls.values())
        if (w.pulledAt !== null && w.pulledAt >= cutoff) pulled1m += 1;
      for (const w of s.askWalls.values())
        if (w.pulledAt !== null && w.pulledAt >= cutoff) pulled1m += 1;
    }

    return {
      symbol,
      topBidWall: persistentBids[0] ?? null,
      topAskWall: persistentAsks[0] ?? null,
      candidateBidCount: bids.length,
      candidateAskCount: asks.length,
      pulled1mCount: pulled1m,
    };
  }

  getKnownSymbols(): string[] {
    return Array.from(this.state.keys());
  }

  // ── Persistence hook (Step E2) ───────────────────────────────────
  // This is the ONLY surface used by the wall persistence orchestrator.
  // It returns a point-in-time analytical snapshot AND atomically resets
  // the per-minute counters so the next minute starts at zero.
  //
  // IMPORTANT: this method intentionally has SIDE EFFECTS (resets counters).
  // It must be called exactly once per symbol per minute by the persistence
  // orchestrator. Calling it from anywhere else (live decision logic, etc.)
  // would corrupt the counters. There is no live-decision use case for this
  // — wall persistence is forensic-only by design.

  /**
   * Snapshot for persistence. Reads top wall + counts at this instant, plus
   * the pull/new-wall counters accumulated since the previous call to this
   * method (or since boot). Atomically RESETS those counters to 0.
   *
   * Returns null if the symbol has never been ingested (we don't write empty
   * docs for symbols that have produced no data).
   */
  snapshotForPersist(symbol: string): WallPersistSnapshot | null {
    const s = this.state.get(symbol);
    if (!s) return null;

    const bids = this.getCandidateWalls(symbol, "BID");
    const asks = this.getCandidateWalls(symbol, "ASK");
    const persistentBids = bids.filter((b) => b.isPersistent);
    const persistentAsks = asks.filter((a) => a.isPersistent);

    const pulledMinute = s.pulledThisMinute;
    const newWallsMinute = s.newWallsThisMinute;
    s.pulledThisMinute = 0;
    s.newWallsThisMinute = 0;

    return {
      symbol,
      topBidWall: persistentBids[0] ?? null,
      topAskWall: persistentAsks[0] ?? null,
      candidateBidCount: bids.length,
      candidateAskCount: asks.length,
      persistentBidCount: persistentBids.length,
      persistentAskCount: persistentAsks.length,
      pulledMinute,
      newWallsMinute,
      midPrice: s.lastMid > 0 ? s.lastMid : null,
    };
  }

  // ── Internals ────────────────────────────────────────────────────

  private updateSide(
    state: SymbolState,
    tracked: Map<number, TrackedWall>,
    side: "BID" | "ASK",
    bands: Map<number, { sum: number; bestPrice: number }>,
    minWallNotional: number,
    bandSize: number,
    mid: number,
    now: number,
  ): void {
    // Bands that qualify as walls in this snapshot
    const present = new Map<number, { sum: number; bestPrice: number }>();
    for (const [key, val] of bands) {
      if (val.sum >= minWallNotional) present.set(key, val);
    }

    // 1) Update or create tracked walls for present bands
    for (const [key, val] of present) {
      const existing = tracked.get(key);
      if (existing) {
        existing.lastSeenAt = now;
        existing.currentNotional = val.sum;
        if (val.sum > existing.peakNotional) existing.peakNotional = val.sum;
        existing.snapshotsObserved += 1;
        // pulledAt is sticky — we do NOT clear it on recovery.
      } else {
        if (tracked.size >= this.cfg.maxTrackedPerSymbol) {
          // Evict the oldest unseen entry to make room
          let oldestKey: number | null = null;
          let oldestSeen = Number.POSITIVE_INFINITY;
          for (const [k, w] of tracked) {
            if (w.lastSeenAt < oldestSeen) {
              oldestSeen = w.lastSeenAt;
              oldestKey = k;
            }
          }
          if (oldestKey !== null) tracked.delete(oldestKey);
        }
        tracked.set(key, {
          side,
          bandKey: key,
          priceBandLow: (key - 0.5) * bandSize,
          priceBandHigh: (key + 0.5) * bandSize,
          representativePrice: val.bestPrice,
          firstSeenAt: now,
          lastSeenAt: now,
          peakNotional: val.sum,
          currentNotional: val.sum,
          snapshotsObserved: 1,
          pulledAt: null,
        });
        // Step E2: count newly-observed walls per minute (reset by
        // snapshotForPersist() at minute boundaries).
        state.newWallsThisMinute += 1;
      }
    }

    // 2) For bands we are tracking that are NOT in the current snapshot's
    //    wall list: check for pull (shrunk vs peak) or approach-then-vanish.
    for (const w of tracked.values()) {
      if (present.has(w.bandKey)) continue;
      const stillThere = bands.get(w.bandKey);
      const currentNow = stillThere?.sum ?? 0;
      const peakOrTiny = w.peakNotional > 0 ? w.peakNotional : 1;
      const shrinkPct = (peakOrTiny - currentNow) / peakOrTiny;
      const distToMid = Math.abs(w.representativePrice - mid) / mid;
      const wasApproached = distToMid <= this.cfg.pullProximityPct;
      if (
        w.pulledAt === null &&
        (shrinkPct >= this.cfg.pullShrinkPct ||
          (wasApproached && currentNow === 0))
      ) {
        w.pulledAt = now;
        // Step E2: count pull transitions per minute (reset by
        // snapshotForPersist() at minute boundaries). Note this counts the
        // transition event, not the running 1m-window size that
        // WallTrackerSnapshot.pulled1mCount represents.
        state.pulledThisMinute += 1;
      }
      w.currentNotional = currentNow;
    }

    // 3) Evict stale walls
    const staleCutoff = now - this.cfg.evictAfterMs;
    for (const [key, w] of tracked) {
      if (w.lastSeenAt < staleCutoff) tracked.delete(key);
    }
  }

  private ensure(symbol: string): SymbolState {
    let s = this.state.get(symbol);
    if (!s) {
      s = {
        bidWalls: new Map(),
        askWalls: new Map(),
        lastProcessedMs: 0,
        lastMid: 0,
        pulledThisMinute: 0,
        newWallsThisMinute: 0,
      };
      this.state.set(symbol, s);
      this.log.debug({ symbol }, "tracking new symbol");
    }
    return s;
  }

  private toCandidate(
    symbol: string,
    w: TrackedWall,
    now: number,
  ): WallCandidate {
    const ageMs = now - w.firstSeenAt;
    const isPersistent =
      ageMs >= this.cfg.minPersistenceMs &&
      w.pulledAt === null &&
      w.currentNotional > 0;
    return {
      symbol,
      side: w.side,
      priceBandLow: w.priceBandLow,
      priceBandHigh: w.priceBandHigh,
      representativePrice: w.representativePrice,
      firstSeenAt: w.firstSeenAt,
      lastSeenAt: w.lastSeenAt,
      ageMs,
      peakNotional: w.peakNotional,
      currentNotional: w.currentNotional,
      snapshotsObserved: w.snapshotsObserved,
      pulledAt: w.pulledAt,
      isPersistent,
    };
  }
}

/** Aggregate book levels into price bands keyed by `Math.round(price/bandSize)`. */
function aggregateIntoBands(
  levels: readonly { price: number; quantity: number }[],
  bandSize: number,
  side: "BID" | "ASK",
): Map<number, { sum: number; bestPrice: number }> {
  const out = new Map<number, { sum: number; bestPrice: number }>();
  for (const lvl of levels) {
    const notional = lvl.price * lvl.quantity;
    if (notional <= 0) continue;
    const key = Math.round(lvl.price / bandSize);
    const cur = out.get(key);
    if (cur) {
      cur.sum += notional;
      // BID: "best" = highest price; ASK: "best" = lowest price.
      if (
        side === "BID" ? lvl.price > cur.bestPrice : lvl.price < cur.bestPrice
      ) {
        cur.bestPrice = lvl.price;
      }
    } else {
      out.set(key, { sum: notional, bestPrice: lvl.price });
    }
  }
  return out;
}
