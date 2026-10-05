import type { Db } from "mongodb";

/**
 * V10 ORDER BOOK AT EVERY 15m CLOSE (Johnny, Oct 4 2026) -- RECORDED ONLY, it never changes a trade.
 * The archive test (src/tools/v10-book-study.ts, 36 trades): when, from the top candle's close to the entry, the share
 * of the limit orders within 1% that are on the SUPPORT side grew (a SHORT: more bids below = someone defends the
 * price), the trade won 45%; when it did not grow, 88%. To check that live, the bot keeps one snapshot per alt per
 * 15m close and the entry message shows the two moments (the top candle's close and the entry).
 *
 *   v10_book  { symbol, candleEnd, t, mid, bid1, ask1, bid2, ask2, covered1, covered2, walls }
 *     walls (Oct 5) = the 3 biggest 0.1% slices of each side within 3% (price, $, % from the mid) + how far the
 *     fetched levels reach -- to see WHERE the limit orders are and, snapshot after snapshot, whether a wall stays
 *     bid1 / ask1 = $ of the buy / sell limit orders within 1% of the mid price (bid2 / ask2: within 2%);
 *     covered = the fetched levels reach that far (else the figure is a lower bound). Kept 90 days.
 * Public Binance REST /fapi/v1/depth (no keys), limit 1000 = weight 20 per alt per 15 min.
 */
export const V10_BOOK = "v10_book";
const BOOK_TTL_DAYS = 90;
const FAPI = process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com";

export interface BookBands { mid: number; bid1: number; ask1: number; bid2: number; ask2: number; covered1: boolean; covered2: boolean }
/** Oct 5 (Johnny: "where are the limit orders, and how big for this coin?"): the biggest walls -- the book cut into
 *  0.1%-wide slices by distance from the mid, the $ in each slice summed (a big order is often spread over
 *  neighbouring ticks), the 3 biggest slices of each side within 3%; price = the slice's $-weighted price */
export interface Wall { price: number; usd: number; distPct: number }
export interface BookWalls { bids: Wall[]; asks: Wall[]; reachBidPct: number; reachAskPct: number }
export interface V10BookSnap extends BookBands { symbol: string; candleEnd: number; t: number; walls?: BookWalls }
export type Levels = ReadonlyArray<readonly [number, number]>;

/** pure: $ within 1% / 2% of the mid on each side. bids best (highest) first, asks best (lowest) first. */
export function bookBands(bids: Levels, asks: Levels): BookBands | null {
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2;
  if (!(mid > 0)) return null;
  const sum = (l: Levels, ok: (p: number) => boolean): number => l.reduce((a, [p, q]) => (ok(p) ? a + p * q : a), 0);
  return {
    mid,
    bid1: sum(bids, (p) => p >= mid * 0.99), ask1: sum(asks, (p) => p <= mid * 1.01),
    bid2: sum(bids, (p) => p >= mid * 0.98), ask2: sum(asks, (p) => p <= mid * 1.02),
    covered1: bids[bids.length - 1][0] <= mid * 0.99 && asks[asks.length - 1][0] >= mid * 1.01,
    covered2: bids[bids.length - 1][0] <= mid * 0.98 && asks[asks.length - 1][0] >= mid * 1.02,
  };
}

/** pure: the n biggest 0.1% slices of each side within maxPct of the mid (see Wall) */
export function bookWalls(bids: Levels, asks: Levels, binPct = 0.1, maxPct = 3, n = 3): BookWalls | null {
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2;
  if (!(mid > 0)) return null;
  const side = (l: Levels, sg: 1 | -1): Wall[] => {
    const bins = new Map<number, { usd: number; pq: number }>();
    for (const [p, q] of l) {
      const d = (sg * 100 * (p - mid)) / mid;   // >= 0 on its own side
      if (d > maxPct) break;                     // levels are sorted away from the mid
      const k = Math.floor(Math.max(0, d) / binPct), b = bins.get(k) ?? { usd: 0, pq: 0 };
      b.usd += p * q; b.pq += p * p * q;
      bins.set(k, b);
    }
    return [...bins.values()].sort((a, b) => b.usd - a.usd).slice(0, n)
      .map((b) => { const price = b.pq / b.usd; return { price, usd: b.usd, distPct: (100 * (price - mid)) / mid }; });
  };
  return { bids: side(bids, -1), asks: side(asks, 1),
    reachBidPct: (100 * (mid - bids[bids.length - 1][0])) / mid, reachAskPct: (100 * (asks[asks.length - 1][0] - mid)) / mid };
}

/** the SUPPORT side's share (%) of the orders within 1%: a SHORT -> the bids (buyers below), a LONG -> the asks */
export const supportPct = (s: Pick<BookBands, "bid1" | "ask1">, side: "SHORT" | "LONG"): number => {
  const all = s.bid1 + s.ask1;
  return all > 0 ? (100 * (side === "SHORT" ? s.bid1 : s.ask1)) / all : NaN;
};

/** what the trade row keeps (for the later check) */
export interface V10BookView {
  /** the top (bottom) candle's close and the entry candle's close */
  topEnd: number; nowEnd: number;
  top: Pick<BookBands, "bid1" | "ask1" | "covered1"> | null;
  now: Pick<BookBands, "bid1" | "ask1" | "covered1"> | null;
  /** the support side's share at the two moments, and whether it grew (null = cannot tell) */
  supportTopPct: number | null; supportNowPct: number | null; grew: boolean | null;
  /** Oct 5: the biggest walls at the entry candle's close, and the coin's average 15m traded volume ($) of the 24h
   *  before it (to say how big a wall is FOR THIS COIN); absent = unknown */
  walls?: BookWalls; vol15?: number;
}

export function bookView(side: "SHORT" | "LONG", topEnd: number, nowEnd: number, top: BookBands | null, now: (BookBands & { walls?: BookWalls }) | null, vol15?: number | null): V10BookView {
  const pick = (s: BookBands | null): V10BookView["top"] => (s ? { bid1: s.bid1, ask1: s.ask1, covered1: s.covered1 } : null);
  const a = top && topEnd < nowEnd ? supportPct(top, side) : NaN, b = now ? supportPct(now, side) : NaN;
  return {
    topEnd, nowEnd, top: topEnd < nowEnd ? pick(top) : null, now: pick(now),
    supportTopPct: Number.isFinite(a) ? a : null, supportNowPct: Number.isFinite(b) ? b : null,
    grew: Number.isFinite(a) && Number.isFinite(b) ? b > a : null,
    ...(now?.walls ? { walls: now.walls } : {}), ...(vol15 && vol15 > 0 ? { vol15 } : {}),
  };
}

const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const usd = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`);

const px = (v: number): string => String(+v.toPrecision(5));
const pc = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
/** Oct 5: the wall lines -- the biggest buyer below and seller above (from the entry), how big for this coin (x the
 *  average 15m traded volume), and the biggest SUPPORT wall between the entry and the TP. Shown only, no verdict. */
export function formatWallLines(v: V10BookView | null | undefined, trade: { side: "SHORT" | "LONG"; entry: number; tp: number | null }): string[] {
  const w = v?.walls;
  if (!w) return [];
  const x = (usdv: number): string => (v?.vol15 ? ` · 15ր առևտրի ${(usdv / v.vol15).toFixed(1)}×` : "");
  const one = (l: Wall): string => `${usd(l.usd)} · ${px(l.price)} (${pc((100 * (l.price - trade.entry)) / trade.entry)})${x(l.usd)}`;
  const lines = ["🧲 Ամենամեծ պատերը (0.1% հատվածներ, մինչև 3%)"];
  lines.push(w.bids.length ? `Ներքևում ամենամեծ գնորդ՝ ${one(w.bids[0])}` : "Ներքևում գնորդ՝ տվյալ չկա");
  lines.push(w.asks.length ? `Վերևում ամենամեծ վաճառող՝ ${one(w.asks[0])}` : "Վերևում վաճառող՝ տվյալ չկա");
  if (trade.tp !== null) {
    const short = trade.side === "SHORT", tp = trade.tp;
    const sup = (short ? w.bids : w.asks).filter((l) => (short ? l.price < trade.entry && l.price >= tp : l.price > trade.entry && l.price <= tp));
    const reach = short ? w.reachBidPct : w.reachAskPct, tpPct = (100 * Math.abs(tp - trade.entry)) / trade.entry;
    if (sup.length) lines.push(`TP-ի ճանապարհին ամենամեծ ${short ? "գնորդը" : "վաճառողը"}՝ ${one(sup[0])}`);
    else lines.push(`TP-ի ճանապարհին ${short ? "գնորդների" : "վաճառողների"} մեծ պատ չկա (3 ամենամեծից ոչ մեկը)${reach < tpPct ? ` · order book-ը տեսնում է միայն ${reach.toFixed(1)}%` : ""}`);
  }
  if (!v?.vol15) lines.push("(15ր առևտրի ծավալը հայտնի չէ)");
  return lines;
}

/** the Telegram lines (Armenian, as agreed with Johnny on Oct 4) */
export function formatBookLines(v: V10BookView | null | undefined, side: "SHORT" | "LONG"): string[] {
  const head = "📚 Լիմիտ օրդերներ (գնից ±1%)";
  if (!v || !v.now || v.supportNowPct === null) return [`${head}՝ տվյալ չկա`];
  const short = side === "SHORT";
  // two shares that round to the same integer are shown with one decimal (the verdict uses the exact values)
  const same = v.supportTopPct !== null && Math.round(v.supportTopPct) === Math.round(v.supportNowPct);
  const p = (x: number): string => (same ? x.toFixed(1) : String(Math.round(x)));
  const split = (s: number): string => (short
    ? `ներքևում գնորդ ${p(s)}% · վերևում վաճառող ${p(100 - s)}%`
    : `վերևում վաճառող ${p(s)}% · ներքևում գնորդ ${p(100 - s)}%`);
  const at = short ? "Գագաթին" : "Հատակին";
  const lines = [head];
  if (v.topEnd >= v.nowEnd) lines.push(`${at}՝ ${short ? "գագաթը" : "հատակը"} հենց այս մոմն է`);
  else if (v.supportTopPct === null) lines.push(`${at} (${hm(v.topEnd)})՝ տվյալ չկա (բոտը այդ պահին չէր գրանցում)`);
  else lines.push(`${at} (${hm(v.topEnd)})՝ ${split(v.supportTopPct)}`);
  lines.push(`Հիմա (${hm(v.nowEnd)})՝ ${split(v.supportNowPct)}`);
  if (v.grew === true) {
    const ch = `${p(v.supportTopPct!)}% → ${p(v.supportNowPct)}%`;
    lines.push(short
      ? `⚠️ Գագաթից հետո ներքևում գնորդներն ավելացան (${ch}) → ինչ-որ մեկը պաշտպանում է գինը`
      : `⚠️ Հատակից հետո վերևում վաճառողներն ավելացան (${ch}) → ինչ-որ մեկը չի թողնում, որ գինը բարձրանա`);
    lines.push("Թեստում այսպիսիները հաճախ SL են եղել");
  } else if (v.grew === false) {
    lines.push(short ? "✅ Գագաթից հետո ներքևում գնորդները չավելացան → գինը պաշտպանող չկա" : "✅ Հատակից հետո վերևում վաճառողները չավելացան → գինը պահող չկա");
  }
  lines.push(`(գնորդ ${usd(v.now.bid1)} · վաճառող ${usd(v.now.ask1)}${v.now.covered1 ? "" : " · order book-ը ամբողջ 1%-ը չի ծածկում"})`);
  return lines;
}

export interface V10BookSource {
  /** one snapshot per symbol for this 15m close; returns how many were stored */
  record(candleEnd: number, symbols: readonly string[]): Promise<number>;
  get(symbol: string, candleEnd: number): Promise<V10BookSnap | null>;
  /** Oct 5: the coin's average 15m traded volume ($) over the 24h before candleEnd; null = unknown */
  avgVol15?(symbol: string, candleEnd: number): Promise<number | null>;
}

/** public 15m klines: the average quote volume of the 96 candles closed by candleEnd */
export async function publicAvgVol15(symbol: string, candleEnd: number): Promise<number | null> {
  const r = await fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=15m&endTime=${candleEnd - 1}&limit=96`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`klines ${symbol}: HTTP ${r.status}`);
  const v = ((await r.json()) as unknown[][]).filter((x) => Number(x[6]) < candleEnd).map((x) => Number(x[7])).filter(Number.isFinite);
  return v.length >= 48 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export type DepthFetch = (symbol: string) => Promise<{ bids: Levels; asks: Levels }>;

/** public REST depth, 1000 levels a side */
export const publicDepth: DepthFetch = async (symbol) => {
  const r = await fetch(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=1000`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`depth ${symbol}: HTTP ${r.status}`);
  const j = (await r.json()) as { bids: Array<[string, string]>; asks: Array<[string, string]> };
  const num = (l: Array<[string, string]>): Array<[number, number]> => l.map(([p, q]) => [Number(p), Number(q)]);
  return { bids: num(j.bids), asks: num(j.asks) };
};

export class V10BookRecorder implements V10BookSource {
  private indexes = false;
  constructor(private readonly getDb: () => Promise<Db | null>, private readonly fetchDepth: DepthFetch = publicDepth, private readonly now: () => number = Date.now,
    private readonly fetchVol: (symbol: string, candleEnd: number) => Promise<number | null> = publicAvgVol15) {}

  avgVol15(symbol: string, candleEnd: number): Promise<number | null> { return this.fetchVol(symbol, candleEnd); }

  private async db(): Promise<Db> {
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    if (!this.indexes) {
      await db.collection(V10_BOOK).createIndex({ symbol: 1, candleEnd: 1 }, { unique: true });
      await db.collection(V10_BOOK).createIndex({ t: 1 }, { expireAfterSeconds: BOOK_TTL_DAYS * 86_400 });
      this.indexes = true;
    }
    return db;
  }

  async record(candleEnd: number, symbols: readonly string[]): Promise<number> {
    const db = await this.db();
    // all alts at once (each with a 5 s timeout) so a slow answer never holds the minute loop for long
    const done = await Promise.all(symbols.map(async (symbol) => {
      try {
        const d = await this.fetchDepth(symbol), b = bookBands(d.bids, d.asks);
        if (!b) return false;
        const walls = bookWalls(d.bids, d.asks);
        await db.collection(V10_BOOK).updateOne({ symbol, candleEnd: new Date(candleEnd) }, { $setOnInsert: { symbol, candleEnd: new Date(candleEnd), t: new Date(this.now()), ...b, ...(walls ? { walls } : {}) } }, { upsert: true });
        return true;
      } catch { return false; }   // one alt failing never stops the others; the caller logs the count
    }));
    return done.filter(Boolean).length;
  }

  async get(symbol: string, candleEnd: number): Promise<V10BookSnap | null> {
    const d = await (await this.db()).collection(V10_BOOK).findOne({ symbol, candleEnd: new Date(candleEnd) }, { projection: { _id: 0 } });
    return d ? { ...(d as unknown as V10BookSnap), candleEnd, t: new Date(d.t).getTime() } : null;
  }
}
