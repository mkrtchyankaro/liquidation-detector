/**
 * CROWD STOP POOLS -- where the popular retail strategies park their stops, and what the price does there
 * (Johnny, Sep 28 2026). Pure, no I/O, only candles, always looking back (pools at candle i are built from
 * candles < i only).
 *
 * POOLS (SELL_STOPS below the price = the longs' stops, BUY_STOPS above = the shorts' stops), sources:
 *   PDHL     previous UTC day high / low                     (breakout traders, 2)
 *   SWING    1h swing high/low (3 candles each side), 72h    (EMA / RSI / SMC traders: "stop below the last low", 1 4 5)
 *   EQUAL    two swing highs (lows) within 0.1%              (the classic "equal highs" liquidity)
 *   PATTERN  hammer / shooting star / engulfing, last 24h    (candle-pattern traders: stop beyond the pattern, 3)
 *   ROUND    the nearest round number above and below        (everyone)
 * A pool disappears once the price traded through it (swept). Pools within 0.15% are merged; weight = the
 * number of different sources in it (more strategies agree -> more stops).
 *
 * VARIANTS (every trade: TP = rr x risk, fees taker in / maker TP / taker SL, one trade per coin at a time,
 * the outcome read from the following candles, SL first if one candle touches both):
 *   MAGNET        towards the strongest pool 1-4 ATR away (weight >= 2): TP just before it, SL = distance / rr
 *   ANTI_MAGNET   the control: the same distances, the other way
 *   SWEEP_REV     a candle pierced a pool (<= 1 ATR) and closed back -> trade the reversal, SL beyond the wick
 *   CROWD_BREAK   the control: a candle closed through a pool -> trade the break like the crowd, SL behind the pool
 *   PDH_TRAP      the close broke the previous day high/low and within 3 candles closed back -> fade it
 *   CROWD_PDH     the control: buy/sell that breakout like the crowd, SL behind the previous day high/low
 *   CROWD_PATTERN the control: trade the hammer / engulfing like the crowd, SL beyond the pattern
 */
export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export type Source = "PDHL" | "SWING" | "EQUAL" | "PATTERN" | "ROUND";
export const SOURCES: Source[] = ["PDHL", "SWING", "EQUAL", "PATTERN", "ROUND"];
export interface Pool {
  side: "SELL_STOPS" | "BUY_STOPS";
  price: number;
  sources: Source[];
  weight: number;
}
export const VARIANTS = [
  "MAGNET",
  "ANTI_MAGNET",
  "SWEEP_REV",
  "CROWD_BREAK",
  "PDH_TRAP",
  "CROWD_PDH",
  "CROWD_PATTERN",
] as const;
export type Variant = (typeof VARIANTS)[number];
export interface CTrade {
  v: Variant;
  side: "LONG" | "SHORT";
  entryTs: number;
  entry: number;
  sl: number;
  tp: number;
  result: "TP" | "SL" | "OPEN";
  exitTs: number;
  netR: number;
  sources: Source[];
}
export interface CSettings {
  rr: number;
  takerFee: number;
  makerFee: number;
}
export const DEFAULT_C: CSettings = {
  rr: 2.2,
  takerFee: 0.0005,
  makerFee: 0.0002,
};

const DAY = 86_400_000;

export function atrAt(h: readonly Candle[], i: number, n = 14): number {
  if (i < n) return NaN;
  let s = 0;
  for (let k = i - n; k < i; k++) s += h[k].high - h[k].low;
  return s / n;
}

/** A round-number step for this price: the smallest 1/2/5 x 10^k that is >= 0.5% of the price. */
export function roundStep(p: number): number {
  const min = p * 0.005;
  let k = Math.pow(10, Math.floor(Math.log10(min)));
  for (;;) {
    for (const m of [1, 2, 5]) if (m * k >= min) return m * k;
    k *= 10;
  }
}

/** The pools at candle i (built from candles < i; the price now = h[i-1].close). */
export function poolsAt(h: readonly Candle[], i: number): Pool[] {
  if (i < 80) return [];
  const price = h[i - 1].close;
  const raw: Array<{
    side: Pool["side"];
    price: number;
    src: Source;
    from: number;
  }> = [];
  // previous UTC day high / low (from the hourly candles)
  const today = Math.floor(h[i - 1].ts / DAY) * DAY,
    yday = today - DAY;
  let pdh = -Infinity,
    pdl = Infinity,
    todayStart = i;
  for (let k = i - 1; k >= Math.max(0, i - 60); k--) {
    if (h[k].ts >= today) {
      todayStart = k;
      continue;
    }
    if (h[k].ts >= yday) {
      pdh = Math.max(pdh, h[k].high);
      pdl = Math.min(pdl, h[k].low);
    }
  }
  if (Number.isFinite(pdh)) {
    raw.push({ side: "BUY_STOPS", price: pdh, src: "PDHL", from: todayStart });
    raw.push({ side: "SELL_STOPS", price: pdl, src: "PDHL", from: todayStart });
  }
  // swings (3 each side, the right side finished), last 72 candles
  const highs: Array<{ p: number; k: number }> = [],
    lows: Array<{ p: number; k: number }> = [];
  for (let k = Math.max(3, i - 72); k <= i - 4; k++) {
    let hi = true,
      lo = true;
    for (let d = 1; d <= 3; d++) {
      if (!(h[k].high >= h[k - d].high && h[k].high >= h[k + d].high))
        hi = false;
      if (!(h[k].low <= h[k - d].low && h[k].low <= h[k + d].low)) lo = false;
    }
    if (hi) {
      highs.push({ p: h[k].high, k });
      raw.push({
        side: "BUY_STOPS",
        price: h[k].high,
        src: "SWING",
        from: k + 1,
      });
    }
    if (lo) {
      lows.push({ p: h[k].low, k });
      raw.push({
        side: "SELL_STOPS",
        price: h[k].low,
        src: "SWING",
        from: k + 1,
      });
    }
  }
  // equal highs / lows (0.1%)
  for (let a = 0; a < highs.length; a++)
    for (let b = a + 1; b < highs.length; b++)
      if (Math.abs(highs[a].p - highs[b].p) <= highs[a].p * 0.001)
        raw.push({
          side: "BUY_STOPS",
          price: Math.max(highs[a].p, highs[b].p),
          src: "EQUAL",
          from: highs[b].k + 1,
        });
  for (let a = 0; a < lows.length; a++)
    for (let b = a + 1; b < lows.length; b++)
      if (Math.abs(lows[a].p - lows[b].p) <= lows[a].p * 0.001)
        raw.push({
          side: "SELL_STOPS",
          price: Math.min(lows[a].p, lows[b].p),
          src: "EQUAL",
          from: lows[b].k + 1,
        });
  // candle patterns, last 24 candles: hammer / shooting star / engulfing
  for (let k = Math.max(1, i - 24); k <= i - 1; k++) {
    const c = h[k],
      p = h[k - 1],
      range = c.high - c.low;
    if (!(range > 0)) continue;
    const lowerWick = Math.min(c.open, c.close) - c.low,
      upperWick = c.high - Math.max(c.open, c.close);
    if (lowerWick >= 0.6 * range)
      raw.push({
        side: "SELL_STOPS",
        price: c.low,
        src: "PATTERN",
        from: k + 1,
      });
    if (upperWick >= 0.6 * range)
      raw.push({
        side: "BUY_STOPS",
        price: c.high,
        src: "PATTERN",
        from: k + 1,
      });
    if (
      c.close > c.open &&
      p.close < p.open &&
      c.close >= p.open &&
      c.open <= p.close
    )
      raw.push({
        side: "SELL_STOPS",
        price: Math.min(c.low, p.low),
        src: "PATTERN",
        from: k + 1,
      });
    if (
      c.close < c.open &&
      p.close > p.open &&
      c.close <= p.close &&
      c.open >= p.open
    )
      raw.push({
        side: "BUY_STOPS",
        price: Math.max(c.high, p.high),
        src: "PATTERN",
        from: k + 1,
      });
  }
  // round numbers
  const step = roundStep(price);
  raw.push({
    side: "BUY_STOPS",
    price: Math.ceil(price / step) * step,
    src: "ROUND",
    from: i,
  });
  raw.push({
    side: "SELL_STOPS",
    price: Math.floor(price / step) * step,
    src: "ROUND",
    from: i,
  });
  // drop the swept ones (and the ones on the wrong side of the price)
  const alive = raw.filter((x) => {
    if (x.side === "SELL_STOPS" ? !(x.price < price) : !(x.price > price))
      return false;
    for (let k = x.from; k < i; k++)
      if (x.side === "SELL_STOPS" ? h[k].low < x.price : h[k].high > x.price)
        return false;
    return true;
  });
  // merge within 0.15%
  const out: Pool[] = [];
  for (const side of ["SELL_STOPS", "BUY_STOPS"] as const) {
    const xs = alive
      .filter((x) => x.side === side)
      .sort((a, b) => a.price - b.price);
    let g: typeof xs = [];
    const flush = (): void => {
      if (!g.length) return;
      const sources = [...new Set(g.map((x) => x.src))];
      out.push({
        side,
        price: side === "SELL_STOPS" ? g[0].price : g[g.length - 1].price,
        sources,
        weight: sources.length,
      });
      g = [];
    };
    for (const x of xs) {
      if (g.length && x.price - g[0].price > g[0].price * 0.0015) flush();
      g.push(x);
    }
    flush();
  }
  return out;
}

function resolve(
  h: readonly Candle[],
  from: number,
  long: boolean,
  entry: number,
  sl: number,
  tp: number,
  s: CSettings,
): Pick<CTrade, "result" | "exitTs" | "netR"> {
  const risk = Math.abs(entry - sl);
  const rr = Math.abs(tp - entry) / risk;
  for (let j = from + 1; j < h.length; j++) {
    const c = h[j];
    if (long ? c.low <= sl : c.high >= sl)
      return {
        result: "SL",
        exitTs: c.ts,
        netR: -1 - (2 * s.takerFee * entry) / risk,
      };
    if (long ? c.high >= tp : c.low <= tp)
      return {
        result: "TP",
        exitTs: c.ts,
        netR: rr - ((s.takerFee + s.makerFee) * entry) / risk,
      };
  }
  return { result: "OPEN", exitTs: Infinity, netR: 0 };
}

/** One coin, one variant. `tradeFrom` = the first candle time that may trade. */
export function runCoin(
  h: readonly Candle[],
  v: Variant,
  tradeFrom: number,
  s: CSettings = DEFAULT_C,
  poolsCache?: ReadonlyArray<Pool[] | undefined>,
): CTrade[] {
  const out: CTrade[] = [];
  let busyUntil = -Infinity;
  let pdBreak: {
    dir: 1 | -1;
    k: number;
    level: number;
    extreme: number;
  } | null = null;
  const take = (
    i: number,
    side: "LONG" | "SHORT",
    slRaw: number,
    atr: number,
    sources: Source[],
    tpFixed?: number,
  ): void => {
    const c = h[i],
      entry = c.close,
      long = side === "LONG";
    const sl = long
      ? Math.min(slRaw, entry - 0.3 * atr)
      : Math.max(slRaw, entry + 0.3 * atr);
    const risk = Math.abs(entry - sl);
    if (!(risk > 0) || risk / entry < 0.001) return; // too tight for the fees
    const tp = tpFixed ?? (long ? entry + s.rr * risk : entry - s.rr * risk);
    const r = resolve(h, i, long, entry, sl, tp, s);
    out.push({
      v,
      side,
      entryTs: c.ts + (h[1].ts - h[0].ts),
      entry,
      sl,
      tp,
      sources,
      ...r,
    });
    busyUntil = r.exitTs;
  };
  for (let i = 81; i < h.length; i++) {
    const c = h[i],
      p = h[i - 1];
    if (c.ts < tradeFrom || c.ts <= busyUntil) {
      if (pdBreak && i - pdBreak.k > 3) pdBreak = null;
      continue;
    }
    const atr = atrAt(h, i);
    if (!Number.isFinite(atr) || !(atr > 0)) continue;
    const pools = poolsCache?.[i] ?? poolsAt(h, i);
    if (v === "MAGNET" || v === "ANTI_MAGNET") {
      const cand = pools
        .filter((q) => q.weight >= 2)
        .map((q) => ({ q, d: Math.abs(q.price - p.close) / atr }))
        .filter((x) => x.d >= 1 && x.d <= 4)
        .sort((a, b) => b.q.weight - a.q.weight || a.d - b.d);
      if (!cand.length) continue;
      const q = cand[0].q,
        towardUp = q.side === "BUY_STOPS";
      // decided at the close of candle i-1 -> enter at the open of i (= close of i-1): use candle i-1 as the entry candle
      const entry = p.close,
        target = towardUp ? q.price - 0.05 * atr : q.price + 0.05 * atr,
        dist = Math.abs(target - entry);
      const long = v === "MAGNET" ? towardUp : !towardUp;
      const tp = long ? entry + dist : entry - dist,
        sl = long ? entry - dist / s.rr : entry + dist / s.rr;
      const r = resolve(h, i - 1, long, entry, sl, tp, s);
      out.push({
        v,
        side: long ? "LONG" : "SHORT",
        entryTs: c.ts,
        entry,
        sl,
        tp,
        sources: q.sources,
        ...r,
      });
      busyUntil = r.exitTs;
      continue;
    }
    if (v === "SWEEP_REV" || v === "CROWD_BREAK") {
      for (const q of pools) {
        const L = q.price;
        if (q.side === "SELL_STOPS") {
          if (
            v === "SWEEP_REV" &&
            c.low < L &&
            L - c.low <= atr &&
            c.close > L
          ) {
            take(i, "LONG", c.low - 0.1 * atr, atr, q.sources);
            break;
          }
          if (v === "CROWD_BREAK" && c.close < L) {
            take(i, "SHORT", L + 0.1 * atr, atr, q.sources);
            break;
          }
        } else {
          if (
            v === "SWEEP_REV" &&
            c.high > L &&
            c.high - L <= atr &&
            c.close < L
          ) {
            take(i, "SHORT", c.high + 0.1 * atr, atr, q.sources);
            break;
          }
          if (v === "CROWD_BREAK" && c.close > L) {
            take(i, "LONG", L - 0.1 * atr, atr, q.sources);
            break;
          }
        }
      }
      continue;
    }
    if (v === "PDH_TRAP" || v === "CROWD_PDH") {
      const pd = pools.filter((q) => q.sources.includes("PDHL"));
      if (pdBreak && i - pdBreak.k > 3) pdBreak = null;
      if (pdBreak) {
        pdBreak.extreme =
          pdBreak.dir > 0
            ? Math.max(pdBreak.extreme, c.high)
            : Math.min(pdBreak.extreme, c.low);
        if (
          v === "PDH_TRAP" &&
          (pdBreak.dir > 0 ? c.close < pdBreak.level : c.close > pdBreak.level)
        ) {
          take(
            i,
            pdBreak.dir > 0 ? "SHORT" : "LONG",
            pdBreak.dir > 0
              ? pdBreak.extreme + 0.1 * atr
              : pdBreak.extreme - 0.1 * atr,
            atr,
            ["PDHL"],
          );
          pdBreak = null;
        }
        continue;
      }
      for (const q of pd) {
        const up = q.side === "BUY_STOPS";
        if (up ? c.close > q.price : c.close < q.price) {
          if (v === "CROWD_PDH")
            take(
              i,
              up ? "LONG" : "SHORT",
              up ? q.price - 0.2 * atr : q.price + 0.2 * atr,
              atr,
              ["PDHL"],
            );
          else
            pdBreak = {
              dir: up ? 1 : -1,
              k: i,
              level: q.price,
              extreme: up ? c.high : c.low,
            };
          break;
        }
      }
      continue;
    }
    // CROWD_PATTERN: hammer / engulfing just closed (candle i) -> trade it like the crowd
    const range = c.high - c.low;
    if (!(range > 0)) continue;
    const lowerWick = Math.min(c.open, c.close) - c.low,
      upperWick = c.high - Math.max(c.open, c.close);
    if (
      lowerWick >= 0.6 * range ||
      (c.close > c.open &&
        p.close < p.open &&
        c.close >= p.open &&
        c.open <= p.close)
    )
      take(
        i,
        "LONG",
        Math.min(c.low, lowerWick >= 0.6 * range ? c.low : p.low) - 0.05 * atr,
        atr,
        ["PATTERN"],
      );
    else if (
      upperWick >= 0.6 * range ||
      (c.close < c.open &&
        p.close > p.open &&
        c.close <= p.close &&
        c.open >= p.open)
    )
      take(
        i,
        "SHORT",
        Math.max(c.high, upperWick >= 0.6 * range ? c.high : p.high) +
          0.05 * atr,
        atr,
        ["PATTERN"],
      );
  }
  return out;
}

export function cstats(trades: readonly CTrade[]): {
  n: number;
  tp: number;
  sl: number;
  open: number;
  netR: number;
  worst: number;
  dd: number;
} {
  const closed = trades
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
    worst,
    dd,
  };
}
