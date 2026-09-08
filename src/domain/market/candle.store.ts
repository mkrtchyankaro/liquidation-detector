import type { Candle, KlineInterval } from '../../shared/common.types';

/**
 * Per-symbol, per-interval candle store. Holds a rolling window of CLOSED
 * candles and the single currently-forming (live) candle separately.
 */
export class CandleStore {
  /** symbol -> interval -> closed candles (oldest → newest) */
  private closed = new Map<string, Map<KlineInterval, Candle[]>>();
  /** symbol -> interval -> current live candle */
  private live = new Map<string, Map<KlineInterval, Candle>>();

  constructor(private readonly maxHistoryPerSeries = 500) {}

  seed(symbol: string, interval: KlineInterval, candles: Candle[]): void {
    if (candles.length === 0) return;
    const byItv = this.ensureSymbolMap(this.closed, symbol);
    // Binance REST returns the latest candle as (potentially) still open; drop it if so.
    const sealed = candles.filter((c) => c.isClosed);
    byItv.set(interval, sealed.slice(-this.maxHistoryPerSeries));
  }

  ingest(candle: Candle): void {
    if (candle.isClosed) {
      const byItv = this.ensureSymbolMap(this.closed, candle.symbol);
      const arr = byItv.get(candle.interval) ?? [];
      // Replace if same openTime (duplicate close event), else append.
      const last = arr[arr.length - 1];
      if (last && last.openTime === candle.openTime) arr[arr.length - 1] = candle;
      else arr.push(candle);
      if (arr.length > this.maxHistoryPerSeries) arr.shift();
      byItv.set(candle.interval, arr);
      // Clear live for this interval
      this.live.get(candle.symbol)?.delete(candle.interval);
    } else {
      const byItv = this.ensureSymbolMap(this.live, candle.symbol);
      byItv.set(candle.interval, candle);
    }
  }

  /** Closed candles only, oldest to newest. */
  getClosed(symbol: string, interval: KlineInterval): Candle[] {
    return this.closed.get(symbol)?.get(interval) ?? [];
  }

  /** The currently-forming candle for the given series, or null. */
  getLive(symbol: string, interval: KlineInterval): Candle | null {
    return this.live.get(symbol)?.get(interval) ?? null;
  }

  /** Last closed candle. */
  lastClosed(symbol: string, interval: KlineInterval): Candle | null {
    const arr = this.getClosed(symbol, interval);
    return arr.length > 0 ? arr[arr.length - 1]! : null;
  }

  /** Closed candles with closeTime > after. */
  closedAfter(symbol: string, interval: KlineInterval, after: number): Candle[] {
    return this.getClosed(symbol, interval).filter((c) => c.closeTime > after);
  }

  private ensureSymbolMap<V>(
    map: Map<string, Map<KlineInterval, V>>,
    symbol: string,
  ): Map<KlineInterval, V> {
    let inner = map.get(symbol);
    if (!inner) { inner = new Map(); map.set(symbol, inner); }
    return inner;
  }
}
