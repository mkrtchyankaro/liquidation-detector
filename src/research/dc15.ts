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
  longLiq?: number;
  shortLiq?: number;
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
  liqL: number;
  liqS: number;
}
export type Dir = "UP" | "DOWN";
export interface Turn {
  t: number;
  newDir: Dir;
  price: number;
  extreme: number;
  extremeT: number;
  /** where the move that just ended started (its start candle's open time) -- for the coins' window */
  moveStartT: number;
  /** the move's price change %: the start candle's close -> the extreme (high of an up move / low of a down move) */
  movePct: number;
  moveOiPct: number;
  candleOiPct: number;
  label: string;
  accepted: boolean;
  atr: number;
  /** LIQUIDATIONS (Johnny, Oct 2), our DB: USD in the move (after its start, up to the reversal candle) and in the reversal candle */
  moveLiqL: number;
  moveLiqS: number;
  candleLiqL: number;
  candleLiqS: number;
  /** in the move: SQUEEZE = the side AGAINST the move was liquidated more (shorts in a rise), AGAINST = the move's own
   *  side more, NONE = no liquidations */
  moveLiq: "SQUEEZE" | "AGAINST" | "NONE";
  /** in the reversal candle: LOSERS = the side the new direction hurts was liquidated more (longs at a top),
   *  WINNERS = the other side more, NONE */
  candleLiq: "LOSERS" | "WINNERS" | "NONE";
  /** forced share: the losers' liquidations / |the candle's OI change in USD| (NaN when OI did not change) */
  forced: number;
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
        liqL: 0,
        liqS: 0,
      };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.oi1 = b.oiLast;
    }
    cur.liqL += b.longLiq ?? 0;
    cur.liqS += b.shortLiq ?? 0;
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

function liqOf(
  c: readonly Candle[],
  start: number,
  ext: number,
  i: number,
  newDir: Dir,
): Pick<
  Turn,
  | "moveLiqL"
  | "moveLiqS"
  | "candleLiqL"
  | "candleLiqS"
  | "moveLiq"
  | "candleLiq"
  | "forced"
> {
  let L = 0,
    S = 0;
  for (let j = start + 1; j < i && j <= ext; j++) {
    L += c[j].liqL;
    S += c[j].liqS;
  }
  const x = c[i],
    moveUp = newDir === "DOWN";
  const moveLiq =
    L === S ? "NONE" : (moveUp ? S > L : L > S) ? "SQUEEZE" : "AGAINST";
  const losers = newDir === "DOWN" ? x.liqL : x.liqS,
    winners = newDir === "DOWN" ? x.liqS : x.liqL;
  const candleLiq =
    losers === winners ? "NONE" : losers > winners ? "LOSERS" : "WINNERS";
  const dOiUsd = Math.abs(x.oi1 - x.oi0) * x.close;
  return {
    moveLiqL: L,
    moveLiqS: S,
    candleLiqL: x.liqL,
    candleLiqS: x.liqS,
    moveLiq,
    candleLiq,
    forced: dOiUsd > 0 ? losers / dOiUsd : NaN,
  };
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
      moveStartT: c[start].t,
      extreme: dir === "UP" ? c[ext].high : c[ext].low,
      extremeT: c[ext].t,
      movePct:
        (100 * ((dir === "UP" ? c[ext].high : c[ext].low) - c[start].close)) /
        c[start].close,
      moveOiPct: (100 * moveOi) / c[start].oi1,
      candleOiPct: (100 * candleOi) / x.oi0,
      label: label(x),
      accepted,
      atr: a,
      ...liqOf(c, start, ext, i, dir === "UP" ? "DOWN" : "UP"),
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

/**
 * HOW BIG WAS THIS MOVE'S OI, COMPARED WITH THE MOVES BEFORE IT? (Johnny, Oct 2) No threshold: each accepted turn's
 * |move OI %| (or another `key`, e.g. the move's price %) against the accepted turns of the `windowH` hours BEFORE it (known at the signal -> live-safe).
 *   rank   1 = bigger than every move of that window, 2 = one was bigger, ...
 *   share  part of those earlier moves that were smaller (1 = all of them)
 *   prior  how many earlier moves there were (0 = nothing to compare with -> rank 1, share NaN)
 */
export interface Ranked {
  turn: Turn;
  rank: number;
  share: number;
  prior: number;
}
export function pastRank(
  list: readonly Turn[],
  windowH: number,
  key: (t: Turn) => number = (t) => t.moveOiPct,
): Ranked[] {
  const acc = list.filter((t) => t.accepted);
  return acc.map((t) => {
    const before = acc.filter(
      (p) => p.t < t.t && p.t >= t.t - windowH * 3_600_000,
    );
    const me = Math.abs(key(t)),
      bigger = before.filter((p) => Math.abs(key(p)) >= me).length;
    return {
      turn: t,
      rank: bigger + 1,
      share: before.length ? (before.length - bigger) / before.length : NaN,
      prior: before.length,
    };
  });
}

/**
 * THE COINS IN THE MOVE (Johnny, Oct 2): over the BTC move window [from, to] -- known at the signal:
 *   pct     the coin's move (close at `from` -> close at `to`), x = pct / BTC's pct
 *   follow  R2 of the coin's 1-minute returns on BTC's inside the window (1 = moved exactly with BTC)
 */
export interface Close {
  t: number;
  close: number;
}
export function priceAt(bars: ReadonlyMap<number, number>, t: number): number {
  for (let k = Math.floor(t / M) * M - M; k >= t - 6 * M; k -= M) {
    const v = bars.get(k);
    if (v) return v;
  }
  return NaN;
}
export function coinInWindow(
  coin: ReadonlyMap<number, number>,
  btc: ReadonlyMap<number, number>,
  from: number,
  to: number,
): { pct: number; btcPct: number; x: number; follow: number } {
  const pct = 100 * (priceAt(coin, to) / priceAt(coin, from) - 1),
    btcPct = 100 * (priceAt(btc, to) / priceAt(btc, from) - 1);
  const xs: number[] = [],
    ys: number[] = [];
  for (let t = Math.floor(from / M) * M + M; t < to; t += M) {
    const c0 = coin.get(t - M),
      c1 = coin.get(t),
      b0 = btc.get(t - M),
      b1 = btc.get(t);
    if (c0 && c1 && b0 && b1) {
      xs.push(b1 / b0 - 1);
      ys.push(c1 / c0 - 1);
    }
  }
  let follow = NaN;
  if (xs.length >= 10) {
    const n = xs.length,
      mx = xs.reduce((a, b) => a + b, 0) / n,
      my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0,
      sxx = 0,
      syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    follow = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN;
  }
  return { pct, btcPct, x: btcPct !== 0 ? pct / btcPct : NaN, follow };
}

/** OI change % of a coin between two times, from its minute OI (the last known OI at each time -- live-safe) */
export function oiChange(
  oi: ReadonlyMap<number, number>,
  from: number,
  to: number,
): number {
  const a = priceAt(oi, from),
    b = priceAt(oi, to);
  return a > 0 && b > 0 ? 100 * (b / a - 1) : NaN;
}
