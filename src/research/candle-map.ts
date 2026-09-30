/**
 * CANDLE MAP (Johnny, Sep 30 2026). Pure, no I/O. Research data only -- never affects trading.
 * For every 1h and 15m candle of a coin: what the PRICE did, what LIQUIDATIONS happened (LONG / SHORT, in coin and
 * USD), and what OPEN INTEREST did inside the candle, described like a candle too (open/high/low/close, how much it
 * rose and fell on the way, the biggest swing up and down, which came first).
 *
 * Sources (all UTC):
 *   price   Binance klines of that timeframe (the same numbers as on the chart), + 1-minute bars to know WHEN the
 *           high and the low happened inside the candle
 *   OI      our 1/s polls condensed per minute (minute_bars: oiFirst / oiLast / oiMin / oiMax, in coins)
 *   liq     every Binance forced order (liq_raw_events): victim side, price, USD -> coins = USD / price
 *
 * OI path inside a candle = oiFirst of its first minute, then oiLast of every minute (a minute-resolution line).
 *   oiRise / oiFall     sum of all up-steps / down-steps on that path (coins) -- how much OI was OPENED and CLOSED
 *                       on the way, not only the net change (a lower bound: moves inside one minute are netted)
 *   oiRunUpPct          biggest rise from a low to a LATER high inside the candle (% of oiOpen)
 *   oiDropPct           biggest fall from a high to a LATER low inside the candle (% of oiOpen)
 *   oiOrder             "UP>DOWN" if the OI high came before the OI low, "DOWN>UP" if after, "-" if equal
 *   USD values of OI changes = coins x the candle's close price (so they are comparable inside the candle)
 */
export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volCoin: number;
  volUsd: number;
  takerBuyCoin: number;
}
export interface MinuteBar {
  ts: number;
  high: number | null;
  low: number | null;
  close: number | null;
  oiFirst: number | null;
  oiLast: number | null;
  oiMin: number | null;
  oiMax: number | null;
}
export interface LiqEvent {
  ts: number;
  victim: "LONG" | "SHORT";
  price: number;
  usd: number;
}

export interface CandleRow {
  symbol: string;
  tf: "1h" | "15m";
  openTime: number;
  closeTime: number;
  hour: number;
  open: number;
  high: number;
  low: number;
  close: number;
  chgPct: number;
  rangePct: number;
  bodyPct: number;
  upperWickPct: number;
  lowerWickPct: number;
  highAt: number | null;
  lowAt: number | null;
  priceOrder: string;
  volCoin: number;
  volUsd: number;
  takerBuyPct: number;
  liqLongCoin: number;
  liqLongUsd: number;
  liqLongN: number;
  liqShortCoin: number;
  liqShortUsd: number;
  liqShortN: number;
  liqMaxMinUsd: number;
  liqMaxMinAt: number | null;
  liqMaxMinSide: string;
  oiOpen: number | null;
  oiHigh: number | null;
  oiLow: number | null;
  oiClose: number | null;
  oiChgCoin: number | null;
  oiChgUsd: number | null;
  oiChgPct: number | null;
  oiRiseCoin: number | null;
  oiFallCoin: number | null;
  oiRisePct: number | null;
  oiFallPct: number | null;
  oiRunUpPct: number | null;
  oiDropPct: number | null;
  oiOrder: string;
  oiUpperWickPct: number | null;
  oiLowerWickPct: number | null;
  oiCloseUsd: number | null;
  minutesWithOi: number;
  minutes: number;
}

const MIN = 60_000;
const pct = (a: number, b: number): number => (b ? (100 * a) / b : 0);

/** one row per kline; `minutes` and `liq` may cover more time than the klines (they are filtered per candle) */
export function buildCandles(
  symbol: string,
  tf: "1h" | "15m",
  klines: readonly Kline[],
  minutes: readonly MinuteBar[],
  liq: readonly LiqEvent[],
): CandleRow[] {
  const tfMs = tf === "1h" ? 60 * MIN : 15 * MIN;
  const ms = [...minutes].sort((a, b) => a.ts - b.ts),
    lq = [...liq].sort((a, b) => a.ts - b.ts);
  const lower = <T extends { ts: number }>(
    arr: readonly T[],
    t: number,
  ): number => {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m].ts < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  return klines.map((k) => {
    const t0 = k.openTime,
      t1 = t0 + tfMs;
    const mins = ms.slice(lower(ms, t0), lower(ms, t1));
    const ev = lq.slice(lower(lq, t0), lower(lq, t1));
    // price: when inside the candle were the high and the low (first minute that reached them, from our minute bars)
    let highAt: number | null = null,
      lowAt: number | null = null,
      hiSeen = -Infinity,
      loSeen = Infinity;
    for (const m of mins) {
      if (m.high !== null && m.high > hiSeen) {
        hiSeen = m.high;
        highAt = m.ts;
      }
      if (m.low !== null && m.low < loSeen) {
        loSeen = m.low;
        lowAt = m.ts;
      }
    }
    const priceOrder =
      highAt === null || lowAt === null
        ? "-"
        : highAt < lowAt
          ? "HIGH>LOW"
          : highAt > lowAt
            ? "LOW>HIGH"
            : "SAME_MIN";
    // liquidations
    let lc = 0,
      lu = 0,
      ln = 0,
      sc = 0,
      su = 0,
      sn = 0;
    const perMin = new Map<
      number,
      { usd: number; long: number; short: number }
    >();
    for (const e of ev) {
      if (!(e.usd > 0)) continue;
      const coin = e.price > 0 ? e.usd / e.price : e.usd / k.close;
      if (e.victim === "LONG") {
        lc += coin;
        lu += e.usd;
        ln++;
      } else {
        sc += coin;
        su += e.usd;
        sn++;
      }
      const m = Math.floor(e.ts / MIN) * MIN,
        x = perMin.get(m) ?? { usd: 0, long: 0, short: 0 };
      x.usd += e.usd;
      if (e.victim === "LONG") x.long += e.usd;
      else x.short += e.usd;
      perMin.set(m, x);
    }
    let maxMin = 0,
      maxAt: number | null = null,
      maxSide = "-";
    for (const [m, x] of perMin)
      if (x.usd > maxMin) {
        maxMin = x.usd;
        maxAt = m;
        maxSide = x.long >= x.short ? "LONG" : "SHORT";
      }
    // open interest as a candle
    const path: number[] = [];
    let oiHigh: number | null = null,
      oiLow: number | null = null,
      oiHighAt = 0,
      oiLowAt = 0,
      withOi = 0;
    for (const m of mins) {
      if (m.oiLast === null || !(m.oiLast > 0)) continue;
      withOi++;
      if (path.length === 0 && m.oiFirst !== null && m.oiFirst > 0)
        path.push(m.oiFirst);
      path.push(m.oiLast);
      const mx = m.oiMax ?? m.oiLast,
        mn = m.oiMin ?? m.oiLast;
      if (oiHigh === null || mx > oiHigh) {
        oiHigh = mx;
        oiHighAt = m.ts;
      }
      if (oiLow === null || mn < oiLow) {
        oiLow = mn;
        oiLowAt = m.ts;
      }
    }
    const blank = {
      oiOpen: null,
      oiHigh: null,
      oiLow: null,
      oiClose: null,
      oiChgCoin: null,
      oiChgUsd: null,
      oiChgPct: null,
      oiRiseCoin: null,
      oiFallCoin: null,
      oiRisePct: null,
      oiFallPct: null,
      oiRunUpPct: null,
      oiDropPct: null,
      oiOrder: "-",
      oiUpperWickPct: null,
      oiLowerWickPct: null,
      oiCloseUsd: null,
    };
    let oi: Omit<
      CandleRow,
      | "symbol"
      | "tf"
      | "openTime"
      | "closeTime"
      | "hour"
      | "open"
      | "high"
      | "low"
      | "close"
      | "chgPct"
      | "rangePct"
      | "bodyPct"
      | "upperWickPct"
      | "lowerWickPct"
      | "highAt"
      | "lowAt"
      | "priceOrder"
      | "volCoin"
      | "volUsd"
      | "takerBuyPct"
      | "liqLongCoin"
      | "liqLongUsd"
      | "liqLongN"
      | "liqShortCoin"
      | "liqShortUsd"
      | "liqShortN"
      | "liqMaxMinUsd"
      | "liqMaxMinAt"
      | "liqMaxMinSide"
      | "minutesWithOi"
      | "minutes"
    > = blank;
    if (path.length >= 2 && oiHigh !== null && oiLow !== null) {
      const o = path[0],
        c = path[path.length - 1];
      let rise = 0,
        fall = 0,
        runUp = 0,
        drop = 0,
        lo = path[0],
        hi = path[0];
      for (let i = 1; i < path.length; i++) {
        const d = path[i] - path[i - 1];
        if (d > 0) rise += d;
        else fall -= d;
        lo = Math.min(lo, path[i]);
        hi = Math.max(hi, path[i]);
        runUp = Math.max(runUp, path[i] - lo);
        drop = Math.max(drop, hi - path[i]);
      }
      oiHigh = Math.max(oiHigh, o, c);
      oiLow = Math.min(oiLow, o, c);
      oi = {
        oiOpen: o,
        oiHigh,
        oiLow,
        oiClose: c,
        oiChgCoin: c - o,
        oiChgUsd: (c - o) * k.close,
        oiChgPct: pct(c - o, o),
        oiRiseCoin: rise,
        oiFallCoin: fall,
        oiRisePct: pct(rise, o),
        oiFallPct: pct(fall, o),
        oiRunUpPct: pct(runUp, o),
        oiDropPct: pct(drop, o),
        oiOrder:
          oiHighAt < oiLowAt ? "UP>DOWN" : oiHighAt > oiLowAt ? "DOWN>UP" : "-",
        oiUpperWickPct: pct(oiHigh - Math.max(o, c), o),
        oiLowerWickPct: pct(Math.min(o, c) - oiLow, o),
        oiCloseUsd: c * k.close,
      };
    }
    return {
      symbol,
      tf,
      openTime: t0,
      closeTime: t1,
      hour: Math.floor(t0 / (60 * MIN)) * 60 * MIN,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      chgPct: pct(k.close - k.open, k.open),
      rangePct: pct(k.high - k.low, k.open),
      bodyPct: pct(Math.abs(k.close - k.open), k.open),
      upperWickPct: pct(k.high - Math.max(k.open, k.close), k.open),
      lowerWickPct: pct(Math.min(k.open, k.close) - k.low, k.open),
      highAt,
      lowAt,
      priceOrder,
      volCoin: k.volCoin,
      volUsd: k.volUsd,
      takerBuyPct: pct(k.takerBuyCoin, k.volCoin),
      liqLongCoin: lc,
      liqLongUsd: lu,
      liqLongN: ln,
      liqShortCoin: sc,
      liqShortUsd: su,
      liqShortN: sn,
      liqMaxMinUsd: maxMin,
      liqMaxMinAt: maxAt,
      liqMaxMinSide: maxSide,
      ...oi,
      minutesWithOi: withOi,
      minutes: tfMs / MIN,
    };
  });
}

export const CSV_COLUMNS: Array<keyof CandleRow> = [
  "symbol",
  "tf",
  "openTime",
  "closeTime",
  "open",
  "high",
  "low",
  "close",
  "chgPct",
  "rangePct",
  "bodyPct",
  "upperWickPct",
  "lowerWickPct",
  "highAt",
  "lowAt",
  "priceOrder",
  "volCoin",
  "volUsd",
  "takerBuyPct",
  "liqLongCoin",
  "liqLongUsd",
  "liqLongN",
  "liqShortCoin",
  "liqShortUsd",
  "liqShortN",
  "liqMaxMinUsd",
  "liqMaxMinAt",
  "liqMaxMinSide",
  "oiOpen",
  "oiHigh",
  "oiLow",
  "oiClose",
  "oiChgCoin",
  "oiChgUsd",
  "oiChgPct",
  "oiRiseCoin",
  "oiFallCoin",
  "oiRisePct",
  "oiFallPct",
  "oiRunUpPct",
  "oiDropPct",
  "oiOrder",
  "oiUpperWickPct",
  "oiLowerWickPct",
  "oiCloseUsd",
  "minutesWithOi",
  "minutes",
];
const TIME_COLS = new Set<keyof CandleRow>([
  "openTime",
  "closeTime",
  "highAt",
  "lowAt",
  "liqMaxMinAt",
]);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const num = (v: number, col: string): string => {
  if (!Number.isFinite(v)) return "";
  if (col.endsWith("Pct")) return v.toFixed(3);
  if (col.endsWith("Usd")) return v.toFixed(0);
  if (col.endsWith("N") || col.startsWith("minutes")) return String(v);
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(2) : a >= 1 ? v.toFixed(4) : v.toPrecision(6);
};
export function toCsvLine(r: CandleRow): string {
  return CSV_COLUMNS.map((c) => {
    const v = r[c];
    if (v === null || v === undefined) return "";
    if (TIME_COLS.has(c)) return utc(v as number);
    return typeof v === "number" ? num(v, c) : String(v);
  }).join(",");
}
