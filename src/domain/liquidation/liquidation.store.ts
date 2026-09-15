import type { Liquidation, OrderSide } from "../../shared/common.types";

export class LiquidationStore {
  private byMap = new Map<string, Liquidation[]>();

  constructor(
    private readonly windowMs: number = 10 * 60 * 1000, // 10 minutes
    private readonly hardCap: number = 5_000,
  ) {}

  ingest(liq: Liquidation): void {
    let arr = this.byMap.get(liq.symbol);
    if (!arr) {
      arr = [];
      this.byMap.set(liq.symbol, arr);
    }
    arr.push(liq);
    if (arr.length > this.hardCap) arr.splice(0, arr.length - this.hardCap);
  }

  all(symbol: string, now: number = Date.now()): Liquidation[] {
    const arr = this.byMap.get(symbol);
    if (!arr || arr.length === 0) return [];
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < arr.length && arr[i]!.timestamp < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr;
  }

  /** Sep 15 2026 (Karo), operator-reported causality audit -- added
   *  the upper bound (`l.timestamp <= now`) that was previously
   *  missing here. Same bug CLASS as the order-book fix: without this,
   *  a different liquidation for the same symbol that got ingest()'d
   *  moments after this one (but with an earlier or equal timestamp
   *  relative to the caller's own `now`) could never leak forward, but
   *  one ingested with a LATER timestamp than the window being asked
   *  about absolutely could. Defensive, zero real-world cost. */
  inWindow(
    symbol: string,
    ms: number,
    now: number = Date.now(),
  ): Liquidation[] {
    const arr = this.all(symbol, now);
    const cutoff = now - ms;
    return arr.filter((l) => l.timestamp >= cutoff && l.timestamp <= now);
  }

  /**
   * Count liquidations of a given side in the last `ms` milliseconds.
   * Remember: Binance forceOrder side = side of the liquidation ORDER.
   * SELL forceOrder => a LONG got liquidated.
   * BUY forceOrder  => a SHORT got liquidated.
   */
  countBySide(
    symbol: string,
    side: OrderSide,
    ms: number,
    now: number = Date.now(),
  ): number {
    return this.inWindow(symbol, ms, now).filter((l) => l.side === side).length;
  }
}
