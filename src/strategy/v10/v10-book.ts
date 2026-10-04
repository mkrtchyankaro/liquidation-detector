import type { Db } from "mongodb";

/**
 * V10 ORDER BOOK AT EVERY 15m CLOSE (Johnny, Oct 4 2026) -- RECORDED ONLY, it never changes a trade.
 * The archive test (src/tools/v10-book-study.ts, 36 trades): when, from the top candle's close to the entry, the share
 * of the limit orders within 1% that are on the SUPPORT side grew (a SHORT: more bids below = someone defends the
 * price), the trade won 45%; when it did not grow, 88%. To check that live, the bot keeps one snapshot per alt per
 * 15m close and the entry message shows the two moments (the top candle's close and the entry).
 *
 *   v10_book  { symbol, candleEnd, t, mid, bid1, ask1, bid2, ask2, covered1, covered2 }
 *     bid1 / ask1 = $ of the buy / sell limit orders within 1% of the mid price (bid2 / ask2: within 2%);
 *     covered = the fetched levels reach that far (else the figure is a lower bound). Kept 90 days.
 * Public Binance REST /fapi/v1/depth (no keys), limit 1000 = weight 20 per alt per 15 min.
 */
export const V10_BOOK = "v10_book";
const BOOK_TTL_DAYS = 90;
const FAPI = process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com";

export interface BookBands {
  mid: number;
  bid1: number;
  ask1: number;
  bid2: number;
  ask2: number;
  covered1: boolean;
  covered2: boolean;
}
export interface V10BookSnap extends BookBands {
  symbol: string;
  candleEnd: number;
  t: number;
}
export type Levels = ReadonlyArray<readonly [number, number]>;

/** pure: $ within 1% / 2% of the mid on each side. bids best (highest) first, asks best (lowest) first. */
export function bookBands(bids: Levels, asks: Levels): BookBands | null {
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2;
  if (!(mid > 0)) return null;
  const sum = (l: Levels, ok: (p: number) => boolean): number =>
    l.reduce((a, [p, q]) => (ok(p) ? a + p * q : a), 0);
  return {
    mid,
    bid1: sum(bids, (p) => p >= mid * 0.99),
    ask1: sum(asks, (p) => p <= mid * 1.01),
    bid2: sum(bids, (p) => p >= mid * 0.98),
    ask2: sum(asks, (p) => p <= mid * 1.02),
    covered1:
      bids[bids.length - 1][0] <= mid * 0.99 &&
      asks[asks.length - 1][0] >= mid * 1.01,
    covered2:
      bids[bids.length - 1][0] <= mid * 0.98 &&
      asks[asks.length - 1][0] >= mid * 1.02,
  };
}

/** the SUPPORT side's share (%) of the orders within 1%: a SHORT -> the bids (buyers below), a LONG -> the asks */
export const supportPct = (
  s: Pick<BookBands, "bid1" | "ask1">,
  side: "SHORT" | "LONG",
): number => {
  const all = s.bid1 + s.ask1;
  return all > 0 ? (100 * (side === "SHORT" ? s.bid1 : s.ask1)) / all : NaN;
};

/** what the trade row keeps (for the later check) */
export interface V10BookView {
  /** the top (bottom) candle's close and the entry candle's close */
  topEnd: number;
  nowEnd: number;
  top: Pick<BookBands, "bid1" | "ask1" | "covered1"> | null;
  now: Pick<BookBands, "bid1" | "ask1" | "covered1"> | null;
  /** the support side's share at the two moments, and whether it grew (null = cannot tell) */
  supportTopPct: number | null;
  supportNowPct: number | null;
  grew: boolean | null;
}

export function bookView(
  side: "SHORT" | "LONG",
  topEnd: number,
  nowEnd: number,
  top: BookBands | null,
  now: BookBands | null,
): V10BookView {
  const pick = (s: BookBands | null): V10BookView["top"] =>
    s ? { bid1: s.bid1, ask1: s.ask1, covered1: s.covered1 } : null;
  const a = top && topEnd < nowEnd ? supportPct(top, side) : NaN,
    b = now ? supportPct(now, side) : NaN;
  return {
    topEnd,
    nowEnd,
    top: topEnd < nowEnd ? pick(top) : null,
    now: pick(now),
    supportTopPct: Number.isFinite(a) ? a : null,
    supportNowPct: Number.isFinite(b) ? b : null,
    grew: Number.isFinite(a) && Number.isFinite(b) ? b > a : null,
  };
}

const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const usd = (v: number): string =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(1)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(0)}k`
      : `$${v.toFixed(0)}`;

/** the Telegram lines (Armenian, as agreed with Johnny on Oct 4) */
export function formatBookLines(
  v: V10BookView | null | undefined,
  side: "SHORT" | "LONG",
): string[] {
  const head = "📚 Լիմիտ օրդերներ (գնից ±1%)";
  if (!v || !v.now || v.supportNowPct === null) return [`${head}՝ տվյալ չկա`];
  const short = side === "SHORT";
  // two shares that round to the same integer are shown with one decimal (the verdict uses the exact values)
  const same =
    v.supportTopPct !== null &&
    Math.round(v.supportTopPct) === Math.round(v.supportNowPct);
  const p = (x: number): string =>
    same ? x.toFixed(1) : String(Math.round(x));
  const split = (s: number): string =>
    short
      ? `ներքևում գնորդ ${p(s)}% · վերևում վաճառող ${p(100 - s)}%`
      : `վերևում վաճառող ${p(s)}% · ներքևում գնորդ ${p(100 - s)}%`;
  const at = short ? "Գագաթին" : "Հատակին";
  const lines = [head];
  if (v.topEnd >= v.nowEnd)
    lines.push(`${at}՝ ${short ? "գագաթը" : "հատակը"} հենց այս մոմն է`);
  else if (v.supportTopPct === null)
    lines.push(
      `${at} (${hm(v.topEnd)})՝ տվյալ չկա (բոտը այդ պահին չէր գրանցում)`,
    );
  else lines.push(`${at} (${hm(v.topEnd)})՝ ${split(v.supportTopPct)}`);
  lines.push(`Հիմա (${hm(v.nowEnd)})՝ ${split(v.supportNowPct)}`);
  if (v.grew === true) {
    const ch = `${p(v.supportTopPct!)}% → ${p(v.supportNowPct)}%`;
    lines.push(
      short
        ? `⚠️ Գագաթից հետո ներքևում գնորդներն ավելացան (${ch}) → ինչ-որ մեկը պաշտպանում է գինը`
        : `⚠️ Հատակից հետո վերևում վաճառողներն ավելացան (${ch}) → ինչ-որ մեկը չի թողնում, որ գինը բարձրանա`,
    );
    lines.push("Թեստում այսպիսիները հաճախ SL են եղել");
  } else if (v.grew === false) {
    lines.push(
      short
        ? "✅ Գագաթից հետո ներքևում գնորդները չավելացան → գինը պաշտպանող չկա"
        : "✅ Հատակից հետո վերևում վաճառողները չավելացան → գինը պահող չկա",
    );
  }
  lines.push(
    `(գնորդ ${usd(v.now.bid1)} · վաճառող ${usd(v.now.ask1)}${v.now.covered1 ? "" : " · order book-ը ամբողջ 1%-ը չի ծածկում"})`,
  );
  return lines;
}

export interface V10BookSource {
  /** one snapshot per symbol for this 15m close; returns how many were stored */
  record(candleEnd: number, symbols: readonly string[]): Promise<number>;
  get(symbol: string, candleEnd: number): Promise<V10BookSnap | null>;
}

export type DepthFetch = (
  symbol: string,
) => Promise<{ bids: Levels; asks: Levels }>;

/** public REST depth, 1000 levels a side */
export const publicDepth: DepthFetch = async (symbol) => {
  const r = await fetch(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=1000`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) throw new Error(`depth ${symbol}: HTTP ${r.status}`);
  const j = (await r.json()) as {
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
  };
  const num = (l: Array<[string, string]>): Array<[number, number]> =>
    l.map(([p, q]) => [Number(p), Number(q)]);
  return { bids: num(j.bids), asks: num(j.asks) };
};

export class V10BookRecorder implements V10BookSource {
  private indexes = false;
  constructor(
    private readonly getDb: () => Promise<Db | null>,
    private readonly fetchDepth: DepthFetch = publicDepth,
    private readonly now: () => number = Date.now,
  ) {}

  private async db(): Promise<Db> {
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    if (!this.indexes) {
      await db
        .collection(V10_BOOK)
        .createIndex({ symbol: 1, candleEnd: 1 }, { unique: true });
      await db
        .collection(V10_BOOK)
        .createIndex({ t: 1 }, { expireAfterSeconds: BOOK_TTL_DAYS * 86_400 });
      this.indexes = true;
    }
    return db;
  }

  async record(candleEnd: number, symbols: readonly string[]): Promise<number> {
    const db = await this.db();
    // all alts at once (each with a 5 s timeout) so a slow answer never holds the minute loop for long
    const done = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const d = await this.fetchDepth(symbol),
            b = bookBands(d.bids, d.asks);
          if (!b) return false;
          await db
            .collection(V10_BOOK)
            .updateOne(
              { symbol, candleEnd: new Date(candleEnd) },
              {
                $setOnInsert: {
                  symbol,
                  candleEnd: new Date(candleEnd),
                  t: new Date(this.now()),
                  ...b,
                },
              },
              { upsert: true },
            );
          return true;
        } catch {
          return false;
        } // one alt failing never stops the others; the caller logs the count
      }),
    );
    return done.filter(Boolean).length;
  }

  async get(symbol: string, candleEnd: number): Promise<V10BookSnap | null> {
    const d = await (await this.db())
      .collection(V10_BOOK)
      .findOne(
        { symbol, candleEnd: new Date(candleEnd) },
        { projection: { _id: 0 } },
      );
    return d
      ? {
          ...(d as unknown as V10BookSnap),
          candleEnd,
          t: new Date(d.t).getTime(),
        }
      : null;
  }
}
