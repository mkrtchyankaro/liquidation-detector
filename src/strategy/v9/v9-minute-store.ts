import { MINUTE_MS, type Bucket, type Victim } from "./v9-core";

/**
 * Bounded per-symbol memory for the live V9 engine.
 *
 * Research loads raw rows (one OI poll per second per symbol = ~260k rows
 * per 3 days). The bucket grid only ever uses, per minute:
 *   - the sum/count of liquidations, and
 *   - the OI/price of the LAST exchange update in that minute
 *     (latest poll wins for the same update time),
 * so this store keeps exactly that (~4.3k rows per 3 days), plus the
 * minute's poll-price low/high which the live trade needs for its SL.
 * toBuckets() is tested to be identical to buildBuckets() on raw rows.
 */
interface LiqMinute { long: number; short: number; count: number }
interface OiMinute { updated: number; ts: number; oi: number; price: number }
interface PriceMinute { low: number; high: number; last: number; lastTs: number }

const minuteOf = (ts: number): number => Math.floor(ts / MINUTE_MS) * MINUTE_MS;

export class V9MinuteStore {
  private readonly liq = new Map<number, LiqMinute>();
  private readonly oi = new Map<number, OiMinute>();
  private readonly prices = new Map<number, PriceMinute>();
  private newestTs = -Infinity;

  addLiquidation(ts: number, victim: Victim, usd: number): void {
    if (!Number.isFinite(ts) || !Number.isFinite(usd) || usd < 0) return;
    const m = minuteOf(ts);
    const row = this.liq.get(m) ?? { long: 0, short: 0, count: 0 };
    if (victim === "LONG") row.long += usd; else row.short += usd;
    row.count++;
    this.liq.set(m, row);
    this.newestTs = Math.max(this.newestTs, ts);
  }

  /** One OI poll. `ts` = capture time, `updated` = exchange update time. */
  addOiObservation(ts: number, updated: number, oi: number, price: number): void {
    if (Number.isFinite(ts) && price > 0) {
      const pm = minuteOf(ts);
      const p = this.prices.get(pm);
      if (!p) this.prices.set(pm, { low: price, high: price, last: price, lastTs: ts });
      else { p.low = Math.min(p.low, price); p.high = Math.max(p.high, price); if (ts >= p.lastTs) { p.last = price; p.lastTs = ts; } }
      this.newestTs = Math.max(this.newestTs, ts);
    }
    if (!Number.isFinite(updated) || !(updated <= ts) || !Number.isFinite(oi) || !(oi > 0)) return;
    const m = minuteOf(updated);
    const cur = this.oi.get(m);
    if (!cur || updated > cur.updated || (updated === cur.updated && ts >= cur.ts)) {
      this.oi.set(m, { updated, ts, oi, price });
    }
  }

  /** Drop minutes older than `keepFromTs` (bounded memory). */
  prune(keepFromTs: number): void {
    const cut = minuteOf(keepFromTs);
    for (const map of [this.liq, this.oi, this.prices] as Array<Map<number, unknown>>) {
      for (const k of map.keys()) if (k < cut) map.delete(k);
    }
  }

  get latestTs(): number { return this.newestTs; }

  /** Same grid and carry-forward semantics as v9-core buildBuckets(). */
  toBuckets(from: number, until: number): Bucket[] {
    const buckets: Bucket[] = [];
    let lastOi = NaN, lastPrice = NaN;
    for (let ts = minuteOf(from); ts <= minuteOf(until); ts += MINUTE_MS) {
      const l = this.liq.get(ts);
      const o = this.oi.get(ts);
      const inRange = o !== undefined && o.updated >= from && o.updated <= until;
      if (inRange) { lastOi = o!.oi; lastPrice = o!.price; }
      buckets.push({
        ts, long: l?.long ?? 0, short: l?.short ?? 0, count: l?.count ?? 0,
        oi: lastOi, price: lastPrice, oiPoints: inRange ? 1 : 0,
      });
    }
    return buckets;
  }

  /** Lowest / highest polled price over [fromTs, toTs] (whole minutes). */
  extremePrice(side: "LOW" | "HIGH", fromTs: number, toTs: number): number {
    let best = side === "LOW" ? Infinity : -Infinity;
    for (let m = minuteOf(fromTs); m <= minuteOf(toTs); m += MINUTE_MS) {
      const p = this.prices.get(m);
      if (!p) continue;
      best = side === "LOW" ? Math.min(best, p.low) : Math.max(best, p.high);
    }
    return best;
  }

  /** Per-minute poll-price low/high for whole minutes in [fromTs, toTs]. */
  minuteRange(fromTs: number, toTs: number): Array<{ ts: number; low: number; high: number }> {
    const out: Array<{ ts: number; low: number; high: number }> = [];
    for (let m = minuteOf(fromTs); m <= minuteOf(toTs); m += MINUTE_MS) {
      const p = this.prices.get(m);
      if (p) out.push({ ts: m, low: p.low, high: p.high });
    }
    return out;
  }

  /** Latest polled price at or before `ts`. */
  lastPrice(ts: number): number {
    for (let m = minuteOf(ts); m >= minuteOf(ts) - 10 * MINUTE_MS; m -= MINUTE_MS) {
      const p = this.prices.get(m);
      if (p && p.lastTs <= ts) return p.last;
    }
    return NaN;
  }
}
