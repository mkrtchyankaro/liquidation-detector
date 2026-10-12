import axios, { type AxiosInstance } from "axios";
import type { Db } from "mongodb";
import { MINUTE_BARS } from "../../collector/minute-bars";
import { H, type V11Bar } from "./v11-engine";

/**
 * V11 data (Oct 12 2026) -- the same sources as the research test (src/tools/research-1h-export.ts):
 *   price         Binance PUBLIC 1h klines (no keys)
 *   open interest Binance PUBLIC /futures/data/openInterestHist, 5m, the points at the hour edges (timestamp T = OI at T)
 *                 -- NOT our database's OI (Johnny: OI from Binance, liquidations from our database)
 *   liquidations  our minute_bars (written from liq_raw_events): the hour's long / short $; an hour with fewer than
 *                 MIN_MINUTES rows of ours is "unknown" (liqOk = false: the collector or the database was down)
 * Kept in memory per coin and fetched incrementally. Only CLOSED hours are ever returned.
 */
export interface V11Source {
  /** the 1h bars whose hour starts in [fromT, toT) (both on the hour), one per hour, null where something is missing */
  bars(symbol: string, fromT: number, toT: number): Promise<Array<V11Bar | null>>;
  /** the open price of the hour starting at t (the current, still open candle; null = not known yet) */
  hourOpen(symbol: string, t: number): Promise<number | null>;
}

const M5 = 5 * 60_000;
/** an hour of our liquidations counts as complete with at least this many minute rows (of 60) */
export const MIN_MINUTES = 55;
/** the newest hours of our liquidations are read again each time (the minute rows are written up to ~1 min late) */
const LIQ_REREAD_H = 2;
/** memory: what is older than this is dropped */
const KEEP_MS = 10 * 24 * H;

interface K { o: number; h: number; l: number; c: number }
interface Liq { s: number; l: number; n: number }

export class BinanceMongoV11Source implements V11Source {
  private readonly fapi: AxiosInstance;
  private readonly kl = new Map<string, Map<number, K>>();
  private readonly oi = new Map<string, Map<number, number>>();
  private readonly oiUpTo = new Map<string, number>();
  private readonly liq = new Map<string, Map<number, Liq>>();

  constructor(
    private readonly getDb: () => Promise<Db | null>,
    baseURL = process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
    private readonly now: () => number = Date.now,
  ) {
    this.fapi = axios.create({ baseURL, timeout: 20_000 });
  }

  private async klines(symbol: string, fromT: number, toT: number): Promise<Map<number, K>> {
    let m = this.kl.get(symbol);
    if (!m) { m = new Map(); this.kl.set(symbol, m); }
    let s = fromT;
    while (s < toT && m.has(s)) s += H;           // what we already have (closed candles never change)
    while (s < toT) {
      const limit = Math.min(1500, Math.ceil((toT - s) / H) + 1);
      const rows: unknown[][] = (await this.fapi.get("/fapi/v1/klines", { params: { symbol, interval: "1h", startTime: s, endTime: toT - 1, limit } })).data;
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) {
        const t = Number(r[0]);
        if (t + H <= this.now()) m.set(t, { o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) });
      }
      s = Number(rows[rows.length - 1][0]) + H;
      if (rows.length < limit) break;
    }
    for (const t of m.keys()) if (t < this.now() - KEEP_MS) m.delete(t);
    return m;
  }

  private async openInterest(symbol: string, fromT: number, toT: number): Promise<Map<number, number>> {
    let m = this.oi.get(symbol);
    if (!m) { m = new Map(); this.oi.set(symbol, m); }
    // from the last point we have (or fromT), up to toT inclusive (the last hour's close)
    let s = Math.max(fromT, (this.oiUpTo.get(symbol) ?? -Infinity) + M5);
    while (s <= toT) {
      const e = Math.min(toT, s + 499 * M5);
      const rows = (await this.fapi.get("/futures/data/openInterestHist", { params: { symbol, period: "5m", limit: 500, startTime: s, endTime: e } })).data as Array<{ timestamp: number; sumOpenInterest: string }>;
      let last = -Infinity;
      if (Array.isArray(rows)) for (const r of rows) {
        const t = Number(r.timestamp), v = Number(r.sumOpenInterest);
        if (!(v > 0)) continue;
        if (t % H === 0) m.set(t, v);
        last = Math.max(last, t);
      }
      if (last > -Infinity) this.oiUpTo.set(symbol, Math.max(this.oiUpTo.get(symbol) ?? -Infinity, last));
      if (last < e) break;                         // Binance has nothing newer yet -> asked again next time
      s = e + M5;
    }
    for (const t of m.keys()) if (t < this.now() - KEEP_MS) m.delete(t);
    return m;
  }

  private async liquidations(symbol: string, fromT: number, toT: number): Promise<Map<number, Liq>> {
    let m = this.liq.get(symbol);
    if (!m) { m = new Map(); this.liq.set(symbol, m); }
    const reread = Math.floor(this.now() / H) * H - LIQ_REREAD_H * H;
    let s = fromT;
    while (s < toT && s < reread && m.has(s)) s += H;
    if (s < toT) {
      const db = await this.getDb();
      if (!db) throw new Error("Mongo unavailable");
      // a plain read of the minute rows (the same query style as the V10 loader), summed per hour here
      const rows = await db.collection(MINUTE_BARS).find({ symbol, ts: { $gte: new Date(s), $lt: new Date(toT) } })
        .project({ _id: 0, ts: 1, shortLiqUsd: 1, longLiqUsd: 1 }).toArray();
      for (let t = s; t < toT; t += H) m.set(t, { s: 0, l: 0, n: 0 });
      for (const r of rows) {
        const t = new Date(r.ts).getTime(), h = Math.floor(t / H) * H, x = m.get(h);
        if (!x) continue;
        x.s += Number(r.shortLiqUsd) || 0; x.l += Number(r.longLiqUsd) || 0; x.n++;
      }
    }
    for (const t of m.keys()) if (t < this.now() - KEEP_MS) m.delete(t);
    return m;
  }

  async bars(symbol: string, fromT: number, toT: number): Promise<Array<V11Bar | null>> {
    const [k, oi, lq] = [await this.klines(symbol, fromT, toT), await this.openInterest(symbol, fromT, toT), await this.liquidations(symbol, fromT, toT)];
    const out: Array<V11Bar | null> = [];
    for (let t = fromT; t < toT; t += H) {
      const c = k.get(t), oo = oi.get(t), oc = oi.get(t + H), q = lq.get(t);
      out.push(c && oo !== undefined && oc !== undefined && t + H <= this.now()
        ? { t, o: c.o, h: c.h, l: c.l, c: c.c, oo, oc, shortLiq: q?.s ?? 0, longLiq: q?.l ?? 0, liqOk: (q?.n ?? 0) >= MIN_MINUTES }
        : null);
    }
    return out;
  }

  async hourOpen(symbol: string, t: number): Promise<number | null> {
    const rows: unknown[][] = (await this.fapi.get("/fapi/v1/klines", { params: { symbol, interval: "1h", startTime: t, limit: 1 } })).data;
    return Array.isArray(rows) && rows.length && Number(rows[0][0]) === t && Number(rows[0][1]) > 0 ? Number(rows[0][1]) : null;
  }
}
