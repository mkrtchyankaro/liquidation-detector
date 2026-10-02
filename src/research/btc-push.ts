/**
 * WHEN BTC PUSHES WITH NEW POSITIONS, WHAT DOES EACH COIN'S OI DO? (Johnny, Oct 2 2026) Pure.
 *
 * A BTC move = an oi-pair episode on BTC's 1h candles: the price moves one way AND BTC's OI grows (new positions),
 * from its start to BTC's OI peak (several hours, not one candle). Over that same window, for every coin:
 *   follows   R2 of the coin's 1h moves on BTC's in the 3 days BEFORE the move (1 = only follows BTC; past only)
 *   price %   the coin's move in the window, and x BTC = coin % / BTC %
 *   OI %      the coin's OI change start -> end, and the lowest OI inside the window (OI dip)
 *   liq       long / short liquidations in the window (our DB, only coins we collect)
 * OI DOWN while the coin moves with BTC = no new positions there: the move is closing / forced liquidations.
 */
export interface Hour {
  t: number;
  open: number;
  close: number;
}
export interface CoinData {
  hours: readonly Hour[];
  oi: (ts: number) => number;
  oiPoints: ReadonlyArray<[number, number]>;
  liq?: (from: number, to: number) => { long: number; short: number } | null;
}
export interface CoinInMove {
  symbol: string;
  r2: number;
  pricePct: number;
  xBtc: number;
  oiPct: number;
  oiDipPct: number;
  longLiq: number | null;
  shortLiq: number | null;
}

const H = 3_600_000;
const pct = (a: number, b: number): number =>
  a > 0 && b > 0 ? (100 * (b - a)) / a : NaN;

export function r2Of(
  coin: readonly Hour[],
  btc: readonly Hour[],
  from: number,
  to: number,
): number {
  const b = new Map(btc.map((h) => [h.t, h]));
  const x: number[] = [],
    y: number[] = [];
  for (const c of coin) {
    if (c.t < from || c.t >= to) continue;
    const k = b.get(c.t);
    if (k) {
      x.push(pct(k.open, k.close));
      y.push(pct(c.open, c.close));
    }
  }
  const n = x.length;
  if (n < 10) return NaN;
  const mx = x.reduce((s, v) => s + v, 0) / n,
    my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN;
}

/** price at ts = the open of the hour starting at ts (or the close of the hour before) */
export function priceAt(h: readonly Hour[], ts: number): number {
  const a = h.find((x) => x.t === ts);
  if (a) return a.open;
  const b = h.find((x) => x.t + H === ts);
  return b ? b.close : NaN;
}

export function coinInMove(
  symbol: string,
  d: CoinData,
  btc: readonly Hour[],
  start: number,
  end: number,
  btcPct: number,
): CoinInMove {
  const p = pct(priceAt(d.hours, start), priceAt(d.hours, end));
  const o0 = d.oi(start),
    o1 = d.oi(end);
  let lo = o0;
  for (const [t, v] of d.oiPoints)
    if (t > start && t <= end && v > 0) lo = Math.min(lo, v);
  const l = d.liq ? d.liq(start, end) : null;
  return {
    symbol,
    r2: r2Of(d.hours, btc, start - 72 * H, start),
    pricePct: p,
    xBtc: btcPct !== 0 ? p / btcPct : NaN,
    oiPct: pct(o0, o1),
    oiDipPct: pct(o0, lo),
    longLiq: l ? l.long : null,
    shortLiq: l ? l.short : null,
  };
}
