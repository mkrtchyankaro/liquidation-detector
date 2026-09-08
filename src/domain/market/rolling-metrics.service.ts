import type { Trade } from '../../shared/common.types';
import { percentile, median } from '../../shared/math';

interface MinuteBucket {
  startMs: number;
  buyQuote: number;
  sellQuote: number;
}

interface SymbolState {
  buckets: MinuteBucket[];      // completed 1m buckets, oldest → newest
  current: MinuteBucket | null; // currently-accumulating bucket
  tradeSamples: number[];       // ring buffer of recent per-trade quoteQty
  tradeSampleIdx: number;
}

/**
 * Maintains per-symbol adaptive baselines used everywhere thresholds are needed:
 *
 *  - Completed 1-minute buckets of aggressive BUY / aggressive SELL quote volume
 *    (capacity = cfg.buckets1mCount). Percentiles (P50/P90/P95/P99) of these
 *    buckets answer "is the current 1m volume a burst?"
 *
 *  - A ring buffer of recent per-trade quoteQty samples. Percentiles answer
 *    "is this trade a large one?"
 *
 * All decisions are RELATIVE to rolling history. No hardcoded dollar floors.
 */
export class RollingMetricsService {
  private state = new Map<string, SymbolState>();
  private readonly bucketMs = 60_000;

  constructor(
    private readonly buckets1mCount: number,
    private readonly tradeSampleCapacity: number,
    private readonly minSamplesForPercentiles: number,
  ) {}

  ingest(trade: Trade, now: number = trade.timestamp): void {
    const s = this.ensure(trade.symbol);
    const bucketStart = Math.floor(now / this.bucketMs) * this.bucketMs;

    if (!s.current || s.current.startMs !== bucketStart) {
      // Seal prior bucket if any
      if (s.current) {
        s.buckets.push(s.current);
        if (s.buckets.length > this.buckets1mCount) s.buckets.shift();
      }
      s.current = { startMs: bucketStart, buyQuote: 0, sellQuote: 0 };
    }

    if (trade.aggressor === 'BUY') s.current.buyQuote += trade.quoteQty;
    else s.current.sellQuote += trade.quoteQty;

    // Trade size sample ring buffer
    if (s.tradeSamples.length < this.tradeSampleCapacity) {
      s.tradeSamples.push(trade.quoteQty);
    } else {
      s.tradeSamples[s.tradeSampleIdx] = trade.quoteQty;
      s.tradeSampleIdx = (s.tradeSampleIdx + 1) % this.tradeSampleCapacity;
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /** Current in-progress 1m aggressive buy quote volume (not yet sealed). */
  currentBuyVolume1m(symbol: string): number {
    return this.state.get(symbol)?.current?.buyQuote ?? 0;
  }

  currentSellVolume1m(symbol: string): number {
    return this.state.get(symbol)?.current?.sellQuote ?? 0;
  }

  /** Percentile of sealed 1m aggressive buy buckets. */
  buyVolumePercentile(symbol: string, p: number): number {
    const s = this.state.get(symbol);
    if (!s || s.buckets.length < this.minSamplesForPercentiles) return Number.POSITIVE_INFINITY;
    return percentile(s.buckets.map((b) => b.buyQuote), p);
  }

  sellVolumePercentile(symbol: string, p: number): number {
    const s = this.state.get(symbol);
    if (!s || s.buckets.length < this.minSamplesForPercentiles) return Number.POSITIVE_INFINITY;
    return percentile(s.buckets.map((b) => b.sellQuote), p);
  }

  buyVolumeMedian(symbol: string): number {
    const s = this.state.get(symbol);
    if (!s || s.buckets.length < this.minSamplesForPercentiles) return Number.POSITIVE_INFINITY;
    return median(s.buckets.map((b) => b.buyQuote));
  }

  sellVolumeMedian(symbol: string): number {
    const s = this.state.get(symbol);
    if (!s || s.buckets.length < this.minSamplesForPercentiles) return Number.POSITIVE_INFINITY;
    return median(s.buckets.map((b) => b.sellQuote));
  }

  /** Percentile of per-trade quoteQty size. */
  tradeSizePercentile(symbol: string, p: number): number {
    const s = this.state.get(symbol);
    if (!s || s.tradeSamples.length < this.minSamplesForPercentiles) return Number.POSITIVE_INFINITY;
    return percentile(s.tradeSamples, p);
  }

  /** Count of trades in `trades` whose size exceeds tradeSizePercentile(p). */
  countLargeTrades(symbol: string, trades: readonly Trade[], p: number, side: 'BUY' | 'SELL'): number {
    const cutoff = this.tradeSizePercentile(symbol, p);
    if (!Number.isFinite(cutoff)) return 0;
    let n = 0;
    for (const t of trades) {
      if (t.aggressor !== side) continue;
      if (t.quoteQty >= cutoff) n++;
    }
    return n;
  }

  /** True once we have enough data for meaningful percentile queries. */
  isWarm(symbol: string): boolean {
    const s = this.state.get(symbol);
    if (!s) return false;
    return (
      s.buckets.length >= this.minSamplesForPercentiles &&
      s.tradeSamples.length >= this.minSamplesForPercentiles
    );
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private ensure(symbol: string): SymbolState {
    let s = this.state.get(symbol);
    if (!s) {
      s = { buckets: [], current: null, tradeSamples: [], tradeSampleIdx: 0 };
      this.state.set(symbol, s);
    }
    return s;
  }
}
