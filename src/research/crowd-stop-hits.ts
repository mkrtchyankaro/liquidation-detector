/**
 * CROWD STOP HITS (Johnny, Sep 29 2026) -- a strategy of its own, not V9. Pure, no I/O, always looking back.
 *
 * 1. CROWD ENTRIES on 15m UTC candles: where the popular strategies would have entered, WHILE the open
 *    interest was growing in that candle (new positions really opened), and where they put the stop:
 *      PATTERN   hammer / bullish engulfing -> LONG, stop below the pattern low (mirror: SHORT above the high)
 *      BREAKOUT  close above the last 24h high -> LONG, stop below the broken high (mirror)
 *      EMA       EMA9 crosses EMA21 up -> LONG, stop below the lowest low of the last 8 candles (mirror)
 *      RSI       RSI14 comes back above 30 -> LONG, stop below the lowest low of the last 8 candles (mirror 70)
 *      SMC       the candle took the lowest low of the last 20 and closed back above -> LONG, stop below the wick
 *    A crowd stop lives until it is hit, at most 48h.
 * 2. CLEANING on 15m candles from OUR data: the OI fell >= 2x its normal 15m change AND the liquidations were
 *    >= 2x normal. DOWN = more longs liquidated, UP = more shorts.
 * 3. HIT: the cleaning candle went through live crowd stops of the flushed side (DOWN -> the crowd longs' stops).
 * TRADES at the close of the cleaning candle, TP = rr x risk, fees:
 *    WITH_MOVE   (Johnny's idea) the crowd was long and got stopped -> we SELL; stop above the cleaning candle high
 *    REVERSAL    the control: we BUY the flush (like V9); stop below the cleaning candle low
 *   each split: the cleaning HIT crowd stops / hit NONE.
 */
export interface C {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface Flow {
  oiStart: number;
  oiEnd: number;
  liqLong: number;
  liqShort: number;
}
export type Kind = "PATTERN" | "BREAKOUT" | "EMA" | "RSI" | "SMC";
export const KINDS: Kind[] = ["PATTERN", "BREAKOUT", "EMA", "RSI", "SMC"];
export interface CrowdEntry {
  i: number;
  side: "LONG" | "SHORT";
  stop: number;
  kind: Kind;
}
export interface Cleaning {
  i: number;
  dir: "DOWN" | "UP";
  oiPct: number;
  liq: number;
}
export interface HitTrade {
  variant: "WITH_MOVE" | "REVERSAL";
  hit: boolean;
  kinds: Kind[];
  stopsHit: number;
  cleaningTs: number;
  side: "LONG" | "SHORT";
  entry: number;
  sl: number;
  tp: number;
  result: "TP" | "SL" | "OPEN";
  exitTs: number;
  netR: number;
}

const Q = 15 * 60_000,
  TAKER = 0.0005,
  MAKER = 0.0002;
const median = (v: number[]): number => {
  const a = v.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : NaN;
};

function ema(v: readonly number[], n: number): number[] {
  const k = 2 / (n + 1),
    out: number[] = [];
  v.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
  return out;
}
function rsi(v: readonly number[], n = 14): number[] {
  const out: number[] = new Array(v.length).fill(NaN);
  let g = 0,
    l = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1],
      up = Math.max(d, 0),
      dn = Math.max(-d, 0);
    if (i <= n) {
      g += up / n;
      l += dn / n;
      if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
      continue;
    }
    g = (g * (n - 1) + up) / n;
    l = (l * (n - 1) + dn) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** Crowd entries at the close of candle i (only candles where the OI grew, unless requireOiUp = false). */
export function crowdEntries(
  c: readonly C[],
  flow: ReadonlyArray<Flow | undefined>,
  requireOiUp = true,
): CrowdEntry[] {
  const closes = c.map((x) => x.close),
    e9 = ema(closes, 9),
    e21 = ema(closes, 21),
    r = rsi(closes);
  const out: CrowdEntry[] = [];
  for (let i = 25; i < c.length; i++) {
    const f = flow[i];
    if (requireOiUp && !(f && f.oiEnd > f.oiStart)) continue;
    const x = c[i],
      p = c[i - 1],
      range = x.high - x.low;
    const lo8 = Math.min(...c.slice(i - 7, i + 1).map((k) => k.low)),
      hi8 = Math.max(...c.slice(i - 7, i + 1).map((k) => k.high));
    if (range > 0) {
      const lw = Math.min(x.open, x.close) - x.low,
        uw = x.high - Math.max(x.open, x.close);
      if (
        lw >= 0.6 * range ||
        (x.close > x.open &&
          p.close < p.open &&
          x.close >= p.open &&
          x.open <= p.close)
      )
        out.push({
          i,
          side: "LONG",
          stop: Math.min(x.low, p.low),
          kind: "PATTERN",
        });
      if (
        uw >= 0.6 * range ||
        (x.close < x.open &&
          p.close > p.open &&
          x.close <= p.close &&
          x.open >= p.open)
      )
        out.push({
          i,
          side: "SHORT",
          stop: Math.max(x.high, p.high),
          kind: "PATTERN",
        });
    }
    const hi24 = Math.max(
        ...c.slice(Math.max(0, i - 96), i).map((k) => k.high),
      ),
      lo24 = Math.min(...c.slice(Math.max(0, i - 96), i).map((k) => k.low));
    if (p.close <= hi24 && x.close > hi24)
      out.push({ i, side: "LONG", stop: hi24 * (1 - 0.001), kind: "BREAKOUT" });
    if (p.close >= lo24 && x.close < lo24)
      out.push({
        i,
        side: "SHORT",
        stop: lo24 * (1 + 0.001),
        kind: "BREAKOUT",
      });
    if (e9[i - 1] <= e21[i - 1] && e9[i] > e21[i])
      out.push({ i, side: "LONG", stop: lo8, kind: "EMA" });
    if (e9[i - 1] >= e21[i - 1] && e9[i] < e21[i])
      out.push({ i, side: "SHORT", stop: hi8, kind: "EMA" });
    if (r[i - 1] < 30 && r[i] >= 30)
      out.push({ i, side: "LONG", stop: lo8, kind: "RSI" });
    if (r[i - 1] > 70 && r[i] <= 70)
      out.push({ i, side: "SHORT", stop: hi8, kind: "RSI" });
    const lo20 = Math.min(...c.slice(i - 20, i).map((k) => k.low)),
      hi20 = Math.max(...c.slice(i - 20, i).map((k) => k.high));
    if (x.low < lo20 && x.close > lo20)
      out.push({ i, side: "LONG", stop: x.low, kind: "SMC" });
    if (x.high > hi20 && x.close < hi20)
      out.push({ i, side: "SHORT", stop: x.high, kind: "SMC" });
  }
  return out;
}

/** Cleaning candles: OI fell >= 2x normal and liquidations >= 2x normal (normal = the coin's median). */
export function cleanings(flow: ReadonlyArray<Flow | undefined>): Cleaning[] {
  const pct = flow.map((f) =>
    f && f.oiStart > 0 && f.oiEnd > 0
      ? (100 * (f.oiEnd - f.oiStart)) / f.oiStart
      : NaN,
  );
  const liq = flow.map((f) => (f ? f.liqLong + f.liqShort : NaN));
  const nOi = median(pct.map(Math.abs)),
    nLiq = median(liq.filter((x) => x > 0));
  if (!(nOi > 0) || !(nLiq > 0)) return [];
  const out: Cleaning[] = [];
  flow.forEach((f, i) => {
    if (!f || !(pct[i] <= -2 * nOi) || !(liq[i] >= 2 * nLiq)) return;
    out.push({
      i,
      dir: f.liqLong >= f.liqShort ? "DOWN" : "UP",
      oiPct: pct[i],
      liq: liq[i],
    });
  });
  return out;
}

function resolve(
  m1: readonly C[],
  fromTs: number,
  long: boolean,
  entry: number,
  sl: number,
  tp: number,
): Pick<HitTrade, "result" | "exitTs" | "netR"> {
  const risk = Math.abs(entry - sl),
    rr = Math.abs(tp - entry) / risk;
  let lo = 0,
    hi = m1.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m1[mid].ts < fromTs) lo = mid + 1;
    else hi = mid;
  }
  for (let j = lo; j < m1.length; j++) {
    const k = m1[j];
    if (long ? k.low <= sl : k.high >= sl)
      return {
        result: "SL",
        exitTs: k.ts,
        netR: -1 - (2 * TAKER * entry) / risk,
      };
    if (long ? k.high >= tp : k.low <= tp)
      return {
        result: "TP",
        exitTs: k.ts,
        netR: rr - ((TAKER + MAKER) * entry) / risk,
      };
  }
  return { result: "OPEN", exitTs: Infinity, netR: 0 };
}

/** All trades of one coin. c = 15m candles, m1 = 1m candles (the path), flow = our OI/liquidations per 15m. */
export function runHits(
  c: readonly C[],
  m1: readonly C[],
  flow: ReadonlyArray<Flow | undefined>,
  rr = 2.2,
  requireOiUp = true,
): HitTrade[] {
  const entries = crowdEntries(c, flow, requireOiUp);
  const out: HitTrade[] = [];
  const busy: Record<HitTrade["variant"], number> = {
    WITH_MOVE: -Infinity,
    REVERSAL: -Infinity,
  };
  for (const cl of cleanings(flow)) {
    const x = c[cl.i];
    if (!x) continue;
    const flushedSide = cl.dir === "DOWN" ? "LONG" : "SHORT";
    // live crowd stops of the flushed side: entered before this candle, not hit since, <= 48h old
    const live = entries.filter(
      (e) =>
        e.side === flushedSide &&
        e.i < cl.i &&
        cl.i - e.i <= 192 &&
        c
          .slice(e.i + 1, cl.i)
          .every((k) =>
            flushedSide === "LONG" ? k.low > e.stop : k.high < e.stop,
          ),
    );
    const hitNow = live.filter((e) =>
      flushedSide === "LONG" ? x.low <= e.stop : x.high >= e.stop,
    );
    const kinds = [...new Set(hitNow.map((e) => e.kind))];
    const entry = x.close,
      closeTs = x.ts + Q;
    const minRisk = entry * 0.003;
    for (const variant of ["WITH_MOVE", "REVERSAL"] as const) {
      if (closeTs <= busy[variant]) continue;
      // WITH_MOVE: go the way of the flush (crowd longs stopped -> SELL); REVERSAL: fade it
      const long =
        variant === "WITH_MOVE" ? cl.dir === "UP" : cl.dir === "DOWN";
      const slRaw = long ? x.low * (1 - 0.0005) : x.high * (1 + 0.0005);
      const sl = long
        ? Math.min(slRaw, entry - minRisk)
        : Math.max(slRaw, entry + minRisk);
      const risk = Math.abs(entry - sl),
        tp = long ? entry + rr * risk : entry - rr * risk;
      const r = resolve(m1, closeTs, long, entry, sl, tp);
      out.push({
        variant,
        hit: hitNow.length > 0,
        kinds,
        stopsHit: hitNow.length,
        cleaningTs: x.ts,
        side: long ? "LONG" : "SHORT",
        entry,
        sl,
        tp,
        ...r,
      });
      busy[variant] = r.exitTs;
    }
  }
  return out;
}
