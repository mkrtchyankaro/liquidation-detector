/**
 * V9 WITH OI ATR (Johnny, Oct 2 2026). Pure, no DB, live-safe (every number uses only candles up to that moment).
 *
 * OI as candles: minute_bars grouped into `tf`-minute candles (OI open/high/low/close, price, liquidations).
 * Two ATRs, kept separately:
 *   down-ATR = the normal size of a FALLING OI candle (how much OI usually goes away in one candle)
 *   up-ATR   = the normal size of a RISING OI candle  (how much OI usually comes in in one candle)
 * Each is a Wilder average over its own last `n` candles of that kind; the value used at candle i comes only
 * from candles BEFORE i.
 *
 * The V9 story, in three OI legs (a leg ends when OI turns back by `rev` normal candles of the other kind):
 *   1. CLEANING      OI falls, one side (the victims) is liquidated            size = drop / down-ATR
 *   2. ACCUMULATION  OI rises from the bottom: new positions                    size = rise / up-ATR
 *   3. TURN          OI falls again, now the OTHER side is liquidated          -> signal at the candle where the
 *                    fall from the peak first reaches `rev` down-ATRs (the moment it is known live)
 * Trade WITH the turn's liquidations (shorts liquidated -> LONG) = the cleaning's victims' side.
 * SL at the price extreme of the turn (since the OI peak) -- like live V9 OITURN -- at least `minSlPct` away.
 */

export interface MinBar {
  t: number;
  high: number | null;
  low: number | null;
  close: number | null;
  oiFirst: number | null;
  oiLast: number | null;
  oiMin: number | null;
  oiMax: number | null;
  longLiq: number;
  shortLiq: number;
}
export interface OiCandle {
  t: number;
  end: number;
  oiOpen: number;
  oiHigh: number;
  oiLow: number;
  oiClose: number;
  high: number;
  low: number;
  close: number;
  longLiq: number;
  shortLiq: number;
}
export type Side = "LONG" | "SHORT";
export interface AtrSignal {
  symbol: string;
  side: Side;
  t: number;
  entry: number;
  sl: number;
  slPct: number;
  cleanStart: number;
  bottom: number;
  peak: number;
  cleanAtr: number;
  accAtr: number;
  turnAtr: number;
  regrow: number;
  cleanVictim: Side;
  turnVictim: Side;
}
export interface AtrOpts {
  tf: number;
  n: number;
  rev: number;
  minSlPct: number;
  maxGapCandles: number;
}
export const DEFAULT_ATR_OPTS: AtrOpts = {
  tf: 5,
  n: 14,
  rev: 1,
  minSlPct: 0.33,
  maxGapCandles: 3,
};

const M = 60_000;

/** minute bars -> tf-minute OI/price candles; a candle needs at least one minute with OI and price */
export function buildCandles(bars: readonly MinBar[], tf: number): OiCandle[] {
  const out: OiCandle[] = [];
  const w = tf * M;
  let cur: OiCandle | null = null;
  for (const b of [...bars].sort((a, z) => a.t - z.t)) {
    if (
      !(
        b.oiFirst! > 0 &&
        b.oiLast! > 0 &&
        b.oiMin! > 0 &&
        b.oiMax! > 0 &&
        b.close! > 0 &&
        b.high! > 0 &&
        b.low! > 0
      )
    )
      continue;
    const k = Math.floor(b.t / w) * w;
    if (!cur || cur.t !== k) {
      if (cur) out.push(cur);
      cur = {
        t: k,
        end: k + w,
        oiOpen: b.oiFirst!,
        oiHigh: b.oiMax!,
        oiLow: b.oiMin!,
        oiClose: b.oiLast!,
        high: b.high!,
        low: b.low!,
        close: b.close!,
        longLiq: 0,
        shortLiq: 0,
      };
    } else {
      cur.oiHigh = Math.max(cur.oiHigh, b.oiMax!);
      cur.oiLow = Math.min(cur.oiLow, b.oiMin!);
      cur.oiClose = b.oiLast!;
      cur.high = Math.max(cur.high, b.high!);
      cur.low = Math.min(cur.low, b.low!);
      cur.close = b.close!;
    }
    cur.longLiq += b.longLiq;
    cur.shortLiq += b.shortLiq;
  }
  if (cur) out.push(cur);
  return out;
}

/** up/down ATR known BEFORE each candle (NaN until each side has n candles) */
export function sideAtrs(
  c: readonly OiCandle[],
  n: number,
): Array<{ up: number; down: number }> {
  const out: Array<{ up: number; down: number }> = [];
  const st = {
    up: { v: NaN, seed: [] as number[] },
    down: { v: NaN, seed: [] as number[] },
  };
  const feed = (s: { v: number; seed: number[] }, x: number): void => {
    if (Number.isFinite(s.v)) {
      s.v += (x - s.v) / n;
      return;
    }
    s.seed.push(x);
    if (s.seed.length === n) s.v = s.seed.reduce((a, y) => a + y, 0) / n;
  };
  for (const k of c) {
    out.push({ up: st.up.v, down: st.down.v });
    const d = k.oiClose - k.oiOpen;
    if (d > 0) feed(st.up, d);
    else if (d < 0) feed(st.down, -d);
  }
  return out;
}

interface Leg {
  dir: "UP" | "DOWN";
  s: number;
  e: number;
}

const victimOf = (
  c: readonly OiCandle[],
  from: number,
  to: number,
): Side | null => {
  let l = 0,
    s = 0;
  for (let i = from; i <= to; i++) {
    l += c[i].longLiq;
    s += c[i].shortLiq;
  }
  return l > s ? "LONG" : s > l ? "SHORT" : null;
};

/** every 3-leg CLEANING -> ACCUMULATION -> TURN with the turn's liquidations on the other side */
export function atrSignals(
  symbol: string,
  c: readonly OiCandle[],
  o: AtrOpts = DEFAULT_ATR_OPTS,
): AtrSignal[] {
  const atr = sideAtrs(c, o.n);
  const out: AtrSignal[] = [];
  const atrAfter = (i: number): { up: number; down: number } =>
    atr[Math.min(i + 1, c.length - 1)];
  let dir: "UP" | "DOWN" | null = null,
    sIdx = -1,
    ext = -1,
    hi = -1,
    lo = -1;
  let prev: Leg | null = null;
  for (let i = 0; i < c.length; i++) {
    const a = atr[i],
      x = c[i].oiClose;
    if (i > 0 && c[i].t - c[i - 1].t > (o.maxGapCandles + 1) * o.tf * M) {
      dir = null;
      prev = null;
      hi = lo = -1;
    }
    if (!(a.up > 0 && a.down > 0)) {
      hi = lo = -1;
      continue;
    }
    if (dir === null) {
      if (hi < 0 || x > c[hi].oiClose) hi = i;
      if (lo < 0 || x < c[lo].oiClose) lo = i;
      if (x - c[lo].oiClose >= o.rev * a.up) {
        dir = "UP";
        sIdx = lo;
        ext = i;
      } else if (c[hi].oiClose - x >= o.rev * a.down) {
        dir = "DOWN";
        sIdx = hi;
        ext = i;
      }
      continue;
    }
    if (dir === "DOWN") {
      if (x < c[ext].oiClose) ext = i;
      else if (x - c[ext].oiClose >= o.rev * a.up) {
        prev = { dir: "DOWN", s: sIdx, e: ext };
        dir = "UP";
        sIdx = ext;
        ext = i;
      }
      continue;
    }
    if (x > c[ext].oiClose) {
      ext = i;
      continue;
    }
    if (c[ext].oiClose - x < o.rev * a.down) continue;
    // UP leg (accumulation) just confirmed: the turn (OI falling from the peak) is now known
    const clean = prev,
      peak = ext,
      bottom = sIdx;
    prev = { dir: "UP", s: sIdx, e: ext };
    dir = "DOWN";
    sIdx = ext;
    ext = i;
    if (!clean || clean.e !== bottom || clean.s >= clean.e || peak >= i)
      continue;
    const cleanVictim = victimOf(c, clean.s + 1, clean.e),
      turnVictim = victimOf(c, peak + 1, i);
    if (!cleanVictim || !turnVictim || cleanVictim === turnVictim) continue;
    const side: Side = turnVictim === "SHORT" ? "LONG" : "SHORT";
    const entry = c[i].close;
    let ex = side === "LONG" ? Infinity : -Infinity;
    for (let j = peak + 1; j <= i; j++)
      ex = side === "LONG" ? Math.min(ex, c[j].low) : Math.max(ex, c[j].high);
    const minD = (entry * o.minSlPct) / 100;
    const sl =
      side === "LONG" ? Math.min(ex, entry - minD) : Math.max(ex, entry + minD);
    const cleanDrop = c[clean.s].oiClose - c[bottom].oiClose,
      rise = c[peak].oiClose - c[bottom].oiClose;
    out.push({
      symbol,
      side,
      t: c[i].end,
      entry,
      sl,
      slPct: (100 * Math.abs(entry - sl)) / entry,
      cleanStart: c[clean.s].end,
      bottom: c[bottom].end,
      peak: c[peak].end,
      cleanAtr: cleanDrop / atrAfter(clean.s).down,
      accAtr: rise / atrAfter(bottom).up,
      turnAtr: (c[peak].oiClose - x) / atrAfter(peak).down,
      regrow: cleanDrop > 0 ? rise / cleanDrop : NaN,
      cleanVictim,
      turnVictim,
    });
  }
  return out;
}

/** bucket label for a size in ATRs */
export function atrBucket(v: number): string {
  if (!Number.isFinite(v)) return "?";
  return v < 1 ? "<1" : v < 2 ? "1-2" : v < 3 ? "2-3" : v < 5 ? "3-5" : "5+";
}
export const ATR_BUCKETS = ["<1", "1-2", "2-3", "3-5", "5+"];
export function regrowBucket(v: number): string {
  if (!Number.isFinite(v)) return "?";
  return v < 0.5
    ? "rebuilt < half"
    : v < 1
      ? "rebuilt half..all"
      : "rebuilt > cleaned";
}
export const REGROW_BUCKETS = [
  "rebuilt < half",
  "rebuilt half..all",
  "rebuilt > cleaned",
];
