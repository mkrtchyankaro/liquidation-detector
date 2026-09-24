import type { Db } from "mongodb";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "context" });

/**
 * Market context for research -- data Binance keeps only ~30 days (or not at
 * all), so it must be collected now to be usable in backtests later.
 *
 *  market_positioning_5m  one row per symbol per 5-minute period:
 *     global       all accounts: % long / % short          (globalLongShortAccountRatio)
 *     topAccounts  top traders by account                  (topLongShortAccountRatio)
 *     topPositions top traders by position size            (topLongShortPositionRatio)
 *     -> backfilled for the last 30 days at startup, then kept current.
 *  market_premium_1m      every minute: mark, index, premium %, funding rate.
 *
 * Candles, taker buy/sell volume and ATR are NOT stored: Binance keeps full
 * kline history (taker buy volume is inside each kline), so backtests fetch
 * them on demand.
 */
export const POSITIONING = "market_positioning_5m";
export const PREMIUM = "market_premium_1m";
const RETENTION_S = 365 * 24 * 3600;
const PERIOD_MS = 5 * 60_000;
const BACKFILL_MS = 29.5 * 24 * 3_600_000; // Binance serves at most ~30 days
const PAGE = 500;
const BASE = "https://fapi.binance.com";

export type RatioKind = "global" | "topAccounts" | "topPositions";
export const RATIO_ENDPOINT: Record<RatioKind, string> = {
  global: "/futures/data/globalLongShortAccountRatio",
  topAccounts: "/futures/data/topLongShortAccountRatio",
  topPositions: "/futures/data/topLongShortPositionRatio",
};

export interface RatioRow { longAccount: string; shortAccount: string; longShortRatio: string; timestamp: number }
export interface PositioningUpdate { symbol: string; ts: Date; kind: RatioKind; value: { longPct: number; shortPct: number; ratio: number } }

/** Pure: Binance ratio rows -> per-period updates (shares as percentages). */
export function toPositioningUpdates(symbol: string, kind: RatioKind, rows: readonly RatioRow[]): PositioningUpdate[] {
  return rows
    .map((r) => ({ ts: Number(r.timestamp), l: Number(r.longAccount), s: Number(r.shortAccount), ratio: Number(r.longShortRatio) }))
    .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.l) && Number.isFinite(r.s))
    .map((r) => ({ symbol, ts: new Date(r.ts), kind, value: { longPct: r.l * 100, shortPct: r.s * 100, ratio: r.ratio } }));
}

/** Pure: [startTime, endTime] pages to fetch so that (latest, now] is covered. */
export function backfillPages(latestTs: number | null, now: number): Array<{ startTime: number; endTime: number }> {
  let start = Math.max(latestTs !== null ? latestTs + PERIOD_MS : 0, now - BACKFILL_MS);
  const pages: Array<{ startTime: number; endTime: number }> = [];
  while (start <= now) {
    const end = Math.min(now, start + (PAGE - 1) * PERIOD_MS);
    pages.push({ startTime: start, endTime: end });
    start = end + PERIOD_MS;
  }
  return pages;
}

export interface PremiumRow { symbol: string; markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number; time: number }
export function toPremiumDoc(r: PremiumRow): { symbol: string; timestamp: Date; markPrice: number; indexPrice: number; premiumPct: number; fundingRate: number; nextFundingTime: Date } {
  const mark = Number(r.markPrice), index = Number(r.indexPrice);
  return {
    symbol: r.symbol, timestamp: new Date(r.time), markPrice: mark, indexPrice: index,
    premiumPct: index > 0 ? ((mark - index) / index) * 100 : NaN,
    fundingRate: Number(r.lastFundingRate), nextFundingTime: new Date(r.nextFundingTime),
  };
}

type Get = (path: string, params: Record<string, string | number>) => Promise<unknown>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function publicGet(path: string, params: Record<string, string | number>): Promise<unknown> {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json();
}

export class ContextCollector {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly symbols: readonly string[],
    private readonly db: () => Promise<Db | null>,
    private readonly get: Get = publicGet,
    private readonly now: () => number = Date.now,
  ) {}

  async ensureIndexes(): Promise<void> {
    const db = await this.db();
    if (!db) throw new Error("Mongo unavailable");
    await db.collection(POSITIONING).createIndex({ symbol: 1, ts: 1 }, { unique: true });
    await db.collection(POSITIONING).createIndex({ ts: 1 }, { expireAfterSeconds: RETENTION_S });
    await db.collection(PREMIUM).createIndex({ symbol: 1, timestamp: 1 });
    await db.collection(PREMIUM).createIndex({ timestamp: 1 }, { expireAfterSeconds: RETENTION_S });
  }

  start(): void {
    void this.backfill().catch((err) => log.error(`[CONTEXT_BACKFILL_FAILED] ${err instanceof Error ? err.message : String(err)}`));
    this.timers.push(setInterval(() => void this.pollPremium(), 60_000));
    this.timers.push(setInterval(() => void this.pollPositioning(), PERIOD_MS));
    void this.pollPremium();
    log.info(`[CONTEXT_STARTED] symbols=${this.symbols.join(",")}`);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Last 30 days of 5-minute positioning, only for periods not stored yet. */
  async backfill(): Promise<void> {
    const db = await this.db();
    if (!db) throw new Error("Mongo unavailable");
    let rows = 0;
    for (const symbol of this.symbols) {
      for (const kind of Object.keys(RATIO_ENDPOINT) as RatioKind[]) {
        const latest = await db.collection(POSITIONING).find({ symbol, [kind]: { $exists: true } }).sort({ ts: -1 }).limit(1).next();
        for (const page of backfillPages(latest ? (latest.ts as Date).getTime() : null, this.now())) {
          rows += await this.fetchRatios(symbol, kind, { period: "5m", limit: PAGE, ...page });
          await sleep(400); // ~2.5 req/s: well below Binance's 1000 req / 5 min limit for /futures/data
        }
      }
    }
    log.info(`[CONTEXT_BACKFILL_DONE] rows=${rows}`);
  }

  async pollPositioning(): Promise<void> {
    for (const symbol of this.symbols) {
      for (const kind of Object.keys(RATIO_ENDPOINT) as RatioKind[]) {
        await this.fetchRatios(symbol, kind, { period: "5m", limit: 3 }).catch((err) =>
          log.warn(`[POSITIONING_POLL] ${symbol} ${kind}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  async pollPremium(): Promise<void> {
    try {
      const all = (await this.get("/fapi/v1/premiumIndex", {})) as PremiumRow[];
      const docs = all.filter((r) => this.symbols.includes(r.symbol)).map(toPremiumDoc);
      const db = await this.db();
      if (db && docs.length) await db.collection(PREMIUM).insertMany(docs, { ordered: false });
    } catch (err) {
      log.warn(`[PREMIUM_POLL] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async fetchRatios(symbol: string, kind: RatioKind, params: Record<string, string | number>): Promise<number> {
    const rows = (await this.get(RATIO_ENDPOINT[kind], { symbol, ...params })) as RatioRow[];
    const updates = toPositioningUpdates(symbol, kind, Array.isArray(rows) ? rows : []);
    const db = await this.db();
    if (!db || updates.length === 0) return 0;
    await db.collection(POSITIONING).bulkWrite(updates.map((u) => ({
      updateOne: { filter: { symbol: u.symbol, ts: u.ts }, update: { $set: { [u.kind]: u.value } }, upsert: true },
    })), { ordered: false });
    return updates.length;
  }
}
