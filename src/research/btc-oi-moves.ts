/**
 * BTC's BIG MOVES and what each coin's OI did meanwhile (Johnny, Oct 2 2026). Pure.
 *
 * Idea: a big BTC move WITH rising OI = someone big opening positions and pushing. The coins move with BTC, but
 * a coin whose OI FALLS in that same candle is not opening anything -- its move is only closing / liquidations.
 * Such a move may come back; a coin whose OI rises with BTC's may go on.
 *
 * For every BTC candle (tf minutes): price % and OI %. The biggest |price| candles of the window are taken
 * (ranked, no threshold). In each, for every coin: price %, OI %, and AFTER the candle (1h and 4h) the coin's move
 * vs BTC:  rel = (coin after - beta x BTC after), signed by the coin's move in the candle:
 *   rel > 0  the coin went on further than BTC explains  ("continued")
 *   rel < 0  the coin came back against its move         ("came back")
 * beta = the coin's usual amplification of BTC from the tf-candles of the 24h BEFORE that candle (past only).
 */
export interface Candle {
  t: number;
  open: number;
  close: number;
}
export interface Series {
  candles: readonly Candle[];
  oi: (ts: number) => number;
}
export interface CoinAtMove {
  symbol: string;
  pricePct: number;
  oiPct: number;
  beta: number;
  rel1h: number;
  rel4h: number; // vs BTC, signed by the coin's move (+ continued, - came back)
  raw1h: number;
  raw4h: number; // the coin alone, signed the same way
}
export interface BtcMove {
  t: number;
  pricePct: number;
  oiPct: number;
  coins: CoinAtMove[];
}

const pct = (a: number, b: number): number =>
  a > 0 && b > 0 ? (100 * (b - a)) / a : NaN;

function slope(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  const mx = x.reduce((s, v) => s + v, 0) / n,
    my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : NaN;
}

/** close at the first candle starting at or after ts (the price `ts` later) */
function closeAt(m: Map<number, Candle>, ts: number): number {
  return m.get(ts)?.open ?? NaN;
}

export function btcMoves(
  btc: Series,
  coins: ReadonlyMap<string, Series>,
  tfMin: number,
  top: number,
  from: number,
): BtcMove[] {
  const w = tfMin * 60_000,
    H = 3_600_000;
  const bMap = new Map(btc.candles.map((c) => [c.t, c]));
  const ranked = btc.candles
    .filter((c) => c.t >= from)
    .map((c) => ({
      c,
      p: pct(c.open, c.close),
      o: pct(btc.oi(c.t), btc.oi(c.t + w)),
    }))
    .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.o))
    .sort((a, z) => Math.abs(z.p) - Math.abs(a.p))
    .slice(0, top)
    .sort((a, z) => a.c.t - z.c.t);
  const out: BtcMove[] = [];
  for (const { c, p, o } of ranked) {
    const end = c.t + w;
    const btcAfter = (h: number): number =>
      pct(c.close, closeAt(bMap, end + h * H));
    const list: CoinAtMove[] = [];
    for (const [symbol, s] of coins) {
      const m = new Map(s.candles.map((k) => [k.t, k]));
      const k = m.get(c.t);
      if (!k) continue;
      const cp = pct(k.open, k.close),
        co = pct(s.oi(c.t), s.oi(end));
      // beta from the 24h of candles before this one
      const xs: number[] = [],
        ys: number[] = [];
      for (let t = c.t - 24 * H; t < c.t; t += w) {
        const a = m.get(t),
          b = bMap.get(t);
        if (a && b) {
          xs.push(pct(b.open, b.close));
          ys.push(pct(a.open, a.close));
        }
      }
      const beta = slope(xs, ys);
      if (!Number.isFinite(cp) || cp === 0 || !Number.isFinite(beta)) continue;
      const sg = Math.sign(cp);
      const after = (h: number): { raw: number; rel: number } => {
        const raw = pct(k.close, closeAt(m, end + h * H)),
          b = btcAfter(h);
        return { raw: sg * raw, rel: sg * (raw - beta * b) };
      };
      const a1 = after(1),
        a4 = after(4);
      list.push({
        symbol,
        pricePct: cp,
        oiPct: co,
        beta,
        rel1h: a1.rel,
        rel4h: a4.rel,
        raw1h: a1.raw,
        raw4h: a4.raw,
      });
    }
    out.push({ t: c.t, pricePct: p, oiPct: o, coins: list });
  }
  return out;
}
