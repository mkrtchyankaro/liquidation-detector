/**
 * GERCHIK-STYLE LEVEL TRADING, made mechanical for a backtest (Johnny, Sep 28 2026). Pure, no I/O.
 * Only candles (Binance klines), always looking back.
 *
 * LEVELS (daily, D1): in the last `lookbackDays` FINISHED daily candles, the turning points -- a high (low)
 *   that the 2 days before and the 2 days after did not pass. Turning points closer than 30% of the daily
 *   ATR are one level (price = their median). A level is STRONG if touched >= 2 times, or MIRROR (it was
 *   both a top and a bottom). Only strong levels are traded.
 * ATR (daily): mean high-low of the last 14 finished days, abnormal days (> 2x the median) left out.
 * ENTRY (1h, at the close of a finished hourly candle), three kinds, reported separately:
 *   FALSE_BREAK  the candle pierced the level (by <= 30% ATR) and closed back on the side it came from
 *   REBOUND      the candle came to the level (within 10% ATR, no close through) and closed >= 10% ATR away,
 *                in the rebound direction
 *   BREAKOUT     the candle closed through the level (by <= 30% ATR -- not too late)
 * FILTER: no entry when today's range already covered >= 70% of the daily ATR.
 * STOP: behind the level (or behind the false-break wick), at least 20% ATR from the entry.
 * TARGET: 3R. If another strong level stands between the entry and the target, no trade (Gerchik: the
 *   target is the next level and must be >= 3x the stop).
 * Exits on the following hourly candles; SL first if one candle touches both. Fees: taker in, maker TP /
 * taker SL. One trade per coin at a time.
 */
export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export type Kind = "FALSE_BREAK" | "REBOUND" | "BREAKOUT";
export const KINDS: Kind[] = ["FALSE_BREAK", "REBOUND", "BREAKOUT"];
export interface Level {
  price: number;
  touches: number;
  mirror: boolean;
}
export interface GTrade {
  kind: Kind;
  side: "LONG" | "SHORT";
  level: number;
  entryTs: number;
  entry: number;
  sl: number;
  tp: number;
  result: "TP" | "SL" | "OPEN";
  exitTs: number;
  netR: number;
  atr: number;
}
export interface GSettings {
  lookbackDays: number;
  rr: number;
  atrUsedMax: number;
  minStopAtr: number;
  mergeAtr: number;
  pierceMaxAtr: number;
  takerFee: number;
  makerFee: number;
}
export const DEFAULT_G: GSettings = {
  lookbackDays: 90,
  rr: 3,
  atrUsedMax: 0.7,
  minStopAtr: 0.2,
  mergeAtr: 0.3,
  pierceMaxAtr: 0.3,
  takerFee: 0.0005,
  makerFee: 0.0002,
};

const DAY = 86_400_000;
const median = (v: number[]): number => {
  const a = [...v].sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : NaN;
};

/** Daily ATR from the finished days before index `i` (exclusive). */
export function atrBefore(d1: readonly Candle[], i: number): number {
  const last = d1.slice(Math.max(0, i - 20), i).map((c) => c.high - c.low);
  if (last.length < 10) return NaN;
  const m = median(last);
  const ok = last.filter((r) => r <= 2 * m).slice(-14);
  return ok.reduce((a, b) => a + b, 0) / ok.length;
}

/** Strong levels from the finished days before index `i`. */
export function levelsBefore(
  d1: readonly Candle[],
  i: number,
  atr: number,
  s: GSettings = DEFAULT_G,
): Level[] {
  const from = Math.max(0, i - s.lookbackDays);
  const pts: Array<{ p: number; top: boolean }> = [];
  for (let k = from + 2; k <= i - 3; k++) {
    // k+2 must be finished (< i)
    const c = d1[k];
    const nb = [d1[k - 2], d1[k - 1], d1[k + 1], d1[k + 2]];
    if (nb.every((x) => c.high >= x.high)) pts.push({ p: c.high, top: true });
    if (nb.every((x) => c.low <= x.low)) pts.push({ p: c.low, top: false });
  }
  pts.sort((a, b) => a.p - b.p);
  const groups: Array<typeof pts> = [];
  for (const x of pts) {
    const g = groups[groups.length - 1];
    if (g && x.p - g[0].p <= s.mergeAtr * atr) g.push(x);
    else groups.push([x]); // no chaining: within 30% ATR of the group start
  }
  return groups
    .map((g) => ({
      price: median(g.map((x) => x.p)),
      touches: g.length,
      mirror: g.some((x) => x.top) && g.some((x) => !x.top),
    }))
    .filter((l) => l.touches >= 2 || l.mirror);
}

/** One trade's outcome from the hourly candles after `from` (index of the entry candle). */
function resolve(
  h1: readonly Candle[],
  from: number,
  long: boolean,
  entry: number,
  sl: number,
  tp: number,
  s: GSettings,
): Pick<GTrade, "result" | "exitTs" | "netR"> {
  const risk = Math.abs(entry - sl);
  for (let j = from + 1; j < h1.length; j++) {
    const c = h1[j];
    const hitSl = long ? c.low <= sl : c.high >= sl,
      hitTp = long ? c.high >= tp : c.low <= tp;
    if (hitSl)
      return {
        result: "SL",
        exitTs: c.ts,
        netR: -1 - (s.takerFee * 2 * entry) / risk,
      };
    if (hitTp)
      return {
        result: "TP",
        exitTs: c.ts,
        netR: s.rr - ((s.takerFee + s.makerFee) * entry) / risk,
      };
  }
  return { result: "OPEN", exitTs: Infinity, netR: 0 };
}

/** All trades of one coin for one entry kind (one at a time). `tradeFrom` = first hour that may trade. */
export function backtestCoin(
  d1: readonly Candle[],
  h1: readonly Candle[],
  kind: Kind,
  tradeFrom: number,
  s: GSettings = DEFAULT_G,
): { trades: GTrade[]; skippedNextLevel: number; skippedAtr: number } {
  const trades: GTrade[] = [];
  let busyUntil = -Infinity,
    skippedNextLevel = 0,
    skippedAtr = 0;
  const dayIdx = new Map<number, number>(
    d1.map((c, i) => [Math.floor(c.ts / DAY), i]),
  );
  const cache = new Map<number, { atr: number; levels: Level[] }>();
  let dayKey = -1,
    dayHi = -Infinity,
    dayLo = Infinity;
  for (let j = 1; j < h1.length; j++) {
    const c = h1[j],
      p = h1[j - 1];
    const dk = Math.floor(c.ts / DAY);
    if (dk !== dayKey) {
      dayKey = dk;
      dayHi = -Infinity;
      dayLo = Infinity;
    }
    dayHi = Math.max(dayHi, c.high);
    dayLo = Math.min(dayLo, c.low);
    if (c.ts < tradeFrom || c.ts <= busyUntil) continue; // one trade at a time: next entry after the exit candle
    const di = dayIdx.get(dk);
    if (di === undefined) continue;
    let ctx = cache.get(di);
    if (!ctx) {
      const atr = atrBefore(d1, di);
      ctx = {
        atr,
        levels: Number.isFinite(atr) ? levelsBefore(d1, di, atr, s) : [],
      };
      cache.set(di, ctx);
    }
    const { atr, levels } = ctx;
    if (!Number.isFinite(atr) || !levels.length) continue;
    let sig: { side: "LONG" | "SHORT"; level: number; sl: number } | null =
      null;
    for (const lv of levels) {
      const L = lv.price,
        pierce = s.pierceMaxAtr * atr,
        near = 0.1 * atr;
      if (kind === "FALSE_BREAK") {
        if (p.close > L && c.low < L && L - c.low <= pierce && c.close > L)
          sig = { side: "LONG", level: L, sl: c.low };
        else if (
          p.close < L &&
          c.high > L &&
          c.high - L <= pierce &&
          c.close < L
        )
          sig = { side: "SHORT", level: L, sl: c.high };
      } else if (kind === "REBOUND") {
        if (
          p.close > L &&
          c.low <= L + near &&
          c.low >= L - 0.05 * atr &&
          c.close - L >= near &&
          c.close > c.open
        )
          sig = { side: "LONG", level: L, sl: L - near };
        else if (
          p.close < L &&
          c.high >= L - near &&
          c.high <= L + 0.05 * atr &&
          L - c.close >= near &&
          c.close < c.open
        )
          sig = { side: "SHORT", level: L, sl: L + near };
      } else {
        if (p.close < L && c.close > L && c.close - L <= pierce)
          sig = { side: "LONG", level: L, sl: L - near };
        else if (p.close > L && c.close < L && L - c.close <= pierce)
          sig = { side: "SHORT", level: L, sl: L + near };
      }
      if (sig) break;
    }
    if (!sig) continue;
    if ((dayHi - dayLo) / atr >= s.atrUsedMax) {
      skippedAtr++;
      continue;
    }
    const long = sig.side === "LONG",
      entry = c.close;
    const slFar = long
      ? Math.min(sig.sl, entry - s.minStopAtr * atr)
      : Math.max(sig.sl, entry + s.minStopAtr * atr);
    const risk = Math.abs(entry - slFar);
    const tp = long ? entry + s.rr * risk : entry - s.rr * risk;
    const blocked = levels.some(
      (l) =>
        l.price !== sig!.level &&
        (long
          ? l.price > entry + near(atr) && l.price < tp
          : l.price < entry - near(atr) && l.price > tp),
    );
    if (blocked) {
      skippedNextLevel++;
      continue;
    }
    const r = resolve(h1, j, long, entry, slFar, tp, s);
    trades.push({
      kind,
      side: sig.side,
      level: sig.level,
      entryTs: c.ts + 3_600_000,
      entry,
      sl: slFar,
      tp,
      atr,
      ...r,
    });
    busyUntil = r.exitTs;
  }
  return { trades, skippedNextLevel, skippedAtr };
}
const near = (atr: number): number => 0.1 * atr;

/** Summary numbers of a list of trades (closed ones). */
export function stats(trades: readonly GTrade[]): {
  n: number;
  tp: number;
  sl: number;
  open: number;
  netR: number;
  worstStreak: number;
  maxDdR: number;
} {
  const closed = [...trades]
    .filter((t) => t.result !== "OPEN")
    .sort((a, b) => a.exitTs - b.exitTs);
  let streak = 0,
    worst = 0,
    eq = 0,
    peak = 0,
    dd = 0;
  for (const t of closed) {
    streak = t.result === "SL" ? streak + 1 : 0;
    worst = Math.max(worst, streak);
    eq += t.netR;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return {
    n: closed.length,
    tp: closed.filter((t) => t.result === "TP").length,
    sl: closed.filter((t) => t.result === "SL").length,
    open: trades.length - closed.length,
    netR: eq,
    worstStreak: worst,
    maxDdR: dd,
  };
}
