/**
 * DC ON 15-MINUTE CANDLES + THE OI RULE (Johnny, Oct 2 2026). Pure, live-safe.
 *
 * Directional change decided at each tf-candle CLOSE: a move ends when a candle CLOSES k x ATR (Wilder, n candles,
 * from the candles BEFORE it) back from the move's extreme (high of an up move / low of a down move).
 *
 * OI RULE (Johnny): the end is accepted only if, in that reversal candle, OI goes the OPPOSITE way to how the move
 * was built:  move built with OI up (new positions) -> the candle's OI must fall (they close, the market stopped);
 * move built with OI down (closing / liquidations) -> the candle's OI must rise (new positions the other way).
 * Otherwise "not the end": the move goes on, its extreme stays, and the next candles are checked again.
 * The move's OI = OI at the extreme candle's close - OI at the close of the candle where the move started.
 */
export interface MinBar {
  t: number;
  high: number;
  low: number;
  close: number;
  oiFirst: number;
  oiLast: number;
}
export interface Candle {
  t: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oi0: number;
  oi1: number;
}
export type Dir = "UP" | "DOWN";
export interface Turn {
  t: number;
  newDir: Dir;
  price: number;
  extreme: number;
  extremeT: number;
  moveOiPct: number;
  candleOiPct: number;
  label: string;
  accepted: boolean;
  atr: number;
}

const M = 60_000;

export function candles(bars: readonly MinBar[], tfMin: number): Candle[] {
  const w = tfMin * M,
    out: Candle[] = [];
  let cur: Candle | null = null;
  for (const b of [...bars].sort((a, z) => a.t - z.t)) {
    if (
      !(b.close > 0 && b.high > 0 && b.low > 0 && b.oiFirst > 0 && b.oiLast > 0)
    )
      continue;
    const k = Math.floor(b.t / w) * w;
    if (!cur || cur.t !== k) {
      if (cur) out.push(cur);
      cur = {
        t: k,
        end: k + w,
        open: b.close,
        high: b.high,
        low: b.low,
        close: b.close,
        oi0: b.oiFirst,
        oi1: b.oiLast,
      };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.oi1 = b.oiLast;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** ATR known BEFORE each candle (NaN until n candles) */
export function atrBefore(c: readonly Candle[], n: number): number[] {
  const out: number[] = [];
  let atr = NaN;
  const seed: number[] = [];
  for (let i = 0; i < c.length; i++) {
    out.push(atr);
    const p = i > 0 ? c[i - 1].close : c[i].open;
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - p),
      Math.abs(c[i].low - p),
    );
    if (Number.isFinite(atr)) atr += (tr - atr) / n;
    else {
      seed.push(tr);
      if (seed.length === n) atr = seed.reduce((a, b) => a + b, 0) / n;
    }
  }
  return out;
}

export function label(c: Candle): string {
  const up = c.close >= c.open,
    oiUp = c.oi1 >= c.oi0;
  return up
    ? oiUp
      ? "NEW LONGS"
      : "SHORTS OUT"
    : oiUp
      ? "NEW SHORTS"
      : "LONGS OUT";
}

/** every reversal candle: accepted ones change the direction; with useOi, rejected ones are returned too */
export function turns(
  c: readonly Candle[],
  k: number,
  n: number,
  useOi: boolean,
): Turn[] {
  const atr = atrBefore(c, n),
    out: Turn[] = [];
  let dir: Dir | null = null,
    ext = -1,
    start = -1;
  for (let i = 0; i < c.length; i++) {
    const a = atr[i];
    if (!(a > 0)) continue;
    const x = c[i];
    if (dir === null) {
      dir = x.close >= x.open ? "UP" : "DOWN";
      ext = start = i;
      continue;
    }
    // a new extreme -- also inside the reversal candle itself (a wick to a new high, then a close far below it)
    if (dir === "UP" ? x.high >= c[ext].high : x.low <= c[ext].low) ext = i;
    const back = dir === "UP" ? c[ext].high - x.close : x.close - c[ext].low;
    if (back < k * a) continue;
    // the move's OI ends where the reversal starts: the extreme candle's close, or this candle's open if it made the extreme
    const moveOi = (ext === i ? x.oi0 : c[ext].oi1) - c[start].oi1,
      candleOi = x.oi1 - x.oi0;
    // a move with no OI change at all has no story to check -> plain DC
    const accepted =
      !useOi ||
      moveOi === 0 ||
      (candleOi !== 0 && Math.sign(candleOi) === -Math.sign(moveOi));
    out.push({
      t: x.end,
      newDir: dir === "UP" ? "DOWN" : "UP",
      price: x.close,
      extreme: dir === "UP" ? c[ext].high : c[ext].low,
      extremeT: c[ext].t,
      moveOiPct: (100 * moveOi) / c[start].oi1,
      candleOiPct: (100 * candleOi) / x.oi0,
      label: label(x),
      accepted,
      atr: a,
    });
    if (accepted) {
      start = ext;
      ext = i;
      dir = dir === "UP" ? "DOWN" : "UP";
    }
  }
  return out;
}

/** after a signal at time t (price p, direction dir): % in the signal's direction after h hours, best and worst within maxH */
export function outcome(
  bars: readonly MinBar[],
  t: number,
  p: number,
  dir: Dir,
  hours: number[],
  maxH: number,
): { at: number[]; best: number; worst: number } {
  const sg = dir === "UP" ? 1 : -1;
  const at = hours.map((h) => {
    const target = t + h * 3_600_000;
    let v = NaN;
    for (const b of bars) {
      if (b.t >= target) break;
      if (b.t >= t) v = b.close;
    }
    return Number.isFinite(v) &&
      bars.length &&
      bars[bars.length - 1].t + M >= target
      ? (sg * 100 * (v - p)) / p
      : NaN;
  });
  let best = -Infinity,
    worst = Infinity;
  for (const b of bars) {
    if (b.t < t) continue;
    if (b.t >= t + maxH * 3_600_000) break;
    const fav = (sg * 100 * ((dir === "UP" ? b.high : b.low) - p)) / p,
      adv = (sg * 100 * ((dir === "UP" ? b.low : b.high) - p)) / p;
    best = Math.max(best, fav);
    worst = Math.min(worst, adv);
  }
  return {
    at,
    best: Number.isFinite(best) ? best : NaN,
    worst: Number.isFinite(worst) ? worst : NaN,
  };
}
