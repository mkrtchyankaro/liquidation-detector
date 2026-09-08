import type { Trade } from '../../shared/common.types';

/**
 * Rolling window of recent aggTrades per symbol. Keeps up to `windowMs` of
 * history and caps absolute size for safety. Insertion is O(1) amortized;
 * we drop old entries lazily on reads.
 */
export class TradeStore {
  private byMap = new Map<string, Trade[]>();

  constructor(
    private readonly windowMs: number = 5 * 60 * 1000, // 5 minutes
    private readonly hardCap: number = 50_000,
  ) {}

  ingest(trade: Trade): void {
    let arr = this.byMap.get(trade.symbol);
    if (!arr) { arr = []; this.byMap.set(trade.symbol, arr); }
    arr.push(trade);
    if (arr.length > this.hardCap) arr.splice(0, arr.length - this.hardCap);
  }

  /** All retained trades for the symbol, oldest → newest. Prunes stale ones. */
  all(symbol: string, now: number = Date.now()): Trade[] {
    const arr = this.byMap.get(symbol);
    if (!arr || arr.length === 0) return [];
    const cutoff = now - this.windowMs;
    // Find first non-stale index
    let i = 0;
    while (i < arr.length && arr[i]!.timestamp < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr;
  }

  inWindow(symbol: string, ms: number, now: number = Date.now()): Trade[] {
    const arr = this.all(symbol, now);
    const cutoff = now - ms;
    const out: Trade[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const t = arr[i]!;
      if (t.timestamp < cutoff) break;
      out.push(t);
    }
    return out.reverse();
  }
}
