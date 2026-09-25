import type { Db } from "mongodb";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "minute-bars" });

/**
 * LONG-TERM MINUTE HISTORY (research data, never affects trading).
 *
 * Raw rows (every liquidation, OI polled every second) are kept only a few
 * days. For studying liquidation episodes per coin we need months, so every
 * minute is also condensed into ONE small row per symbol:
 *
 *   price  open/high/low/close   (from the 1/s OI polls' mark price)
 *   OI     first/last/min/max    (contracts; x price = USD)
 *   liq    LONG / SHORT victim USD and count
 *
 * ~1,440 rows per symbol per day (~0.3 KB each), kept 365 days.
 * Written every minute for the previous minutes (idempotent upsert, so a late
 * DB batch is picked up on the next pass) and back-fillable from raw rows.
 */
export const MINUTE_BARS = "minute_bars";
const MINUTE_MS = 60_000;
const RETENTION_DAYS = 365;
const REWRITE_MINUTES = 3; // late raw batches (OI written every ~5 s) are included on the next passes
const RUN_OFFSET_MS = 20_000;

export interface MinuteBarDoc {
  symbol: string;
  ts: Date; // minute start (UTC)
  open: number | null; high: number | null; low: number | null; close: number | null;
  oiFirst: number | null; oiLast: number | null; oiMin: number | null; oiMax: number | null;
  polls: number;
  longLiqUsd: number; shortLiqUsd: number; longLiqCount: number; shortLiqCount: number;
}
export interface RawLiq { ts: number; victim: string; usd: number }
export interface RawOi { ts: number; oi: number; price: number }

/** Pure: raw rows -> one bar per minute in [from, to) that has any data. */
export function aggregateMinuteBars(symbol: string, liq: readonly RawLiq[], oi: readonly RawOi[], from: number, to: number): MinuteBarDoc[] {
  const bars = new Map<number, MinuteBarDoc & { lastTs: number; firstTs: number }>();
  const bar = (m: number) => {
    let b = bars.get(m);
    if (!b) {
      b = { symbol, ts: new Date(m), open: null, high: null, low: null, close: null, oiFirst: null, oiLast: null, oiMin: null, oiMax: null, polls: 0, longLiqUsd: 0, shortLiqUsd: 0, longLiqCount: 0, shortLiqCount: 0, lastTs: -Infinity, firstTs: Infinity };
      bars.set(m, b);
    }
    return b;
  };
  for (const o of oi) {
    if (!(o.ts >= from && o.ts < to)) continue;
    const b = bar(Math.floor(o.ts / MINUTE_MS) * MINUTE_MS);
    b.polls++;
    if (o.price > 0) {
      b.high = b.high === null ? o.price : Math.max(b.high, o.price);
      b.low = b.low === null ? o.price : Math.min(b.low, o.price);
    }
    if (o.oi > 0) { b.oiMin = b.oiMin === null ? o.oi : Math.min(b.oiMin, o.oi); b.oiMax = b.oiMax === null ? o.oi : Math.max(b.oiMax, o.oi); }
    if (o.ts < b.firstTs) { b.firstTs = o.ts; if (o.price > 0) b.open = o.price; if (o.oi > 0) b.oiFirst = o.oi; }
    if (o.ts >= b.lastTs) { b.lastTs = o.ts; if (o.price > 0) b.close = o.price; if (o.oi > 0) b.oiLast = o.oi; }
  }
  for (const l of liq) {
    if (!(l.ts >= from && l.ts < to) || !(l.usd > 0)) continue;
    const b = bar(Math.floor(l.ts / MINUTE_MS) * MINUTE_MS);
    if (l.victim === "LONG") { b.longLiqUsd += l.usd; b.longLiqCount++; }
    else if (l.victim === "SHORT") { b.shortLiqUsd += l.usd; b.shortLiqCount++; }
  }
  return [...bars.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime()).map(({ lastTs: _l, firstTs: _f, ...b }) => b);
}

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

/** Reads raw rows for [from, to) and upserts the bars. Returns bars written. */
export async function writeMinuteBars(db: Db, symbol: string, from: number, to: number): Promise<number> {
  const liq = (await db.collection("liq_raw_events")
    .find({ symbol, victim: { $in: ["LONG", "SHORT"] }, timestamp: { $gte: from, $lt: to } })
    .project({ timestamp: 1, victim: 1, quoteQty: 1 }).toArray())
    .map((r) => ({ ts: toMs(r.timestamp), victim: String(r.victim), usd: Number(r.quoteQty) }));
  const oi = (await db.collection("oi_second_observations")
    .find({ symbol, timestamp: { $gte: new Date(from), $lt: new Date(to) } })
    .project({ timestamp: 1, openInterest: 1, price: 1 }).toArray())
    .map((r) => ({ ts: toMs(r.timestamp), oi: Number(r.openInterest), price: Number(r.price) }));
  const bars = aggregateMinuteBars(symbol, liq, oi, from, to);
  if (bars.length === 0) return 0;
  await db.collection<MinuteBarDoc>(MINUTE_BARS).bulkWrite(
    bars.map((b) => ({ updateOne: { filter: { symbol: b.symbol, ts: b.ts }, update: { $set: b }, upsert: true } })),
    { ordered: false },
  );
  return bars.length;
}

export async function ensureMinuteBarIndexes(getDb: () => Promise<Db | null>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Mongo unavailable for minute_bars indexes");
  const col = db.collection(MINUTE_BARS);
  await col.createIndex({ symbol: 1, ts: 1 }, { unique: true });
  await col.createIndex({ ts: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 3600 });
}

/** Live writer: every minute at hh:mm:20, re-writes the last few whole
 *  minutes of every symbol. Failures are logged and never affect trading. */
export class MinuteBarWriter {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly symbols: readonly string[], private readonly getDb: () => Promise<Db | null>, private readonly now: () => number = Date.now) {}

  start(): void {
    const tick = (): void => {
      const now = this.now();
      const next = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS + RUN_OFFSET_MS;
      this.timer = setTimeout(() => { void this.runOnce().finally(tick); }, Math.max(1_000, next - now));
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const db = await this.getDb();
      if (!db) return;
      const to = Math.floor(this.now() / MINUTE_MS) * MINUTE_MS; // current (incomplete) minute excluded
      const from = to - REWRITE_MINUTES * MINUTE_MS;
      for (const symbol of this.symbols) {
        try { await writeMinuteBars(db, symbol, from, to); }
        catch (err) { log.error({ symbol, err: err instanceof Error ? err.message : String(err) }, "[MINUTE_BARS_WRITE_FAILED] -- research data only, trading unaffected"); }
      }
    } finally {
      this.busy = false;
    }
  }
}
