/**
 * PAIR TRADING (statistical arbitrage) on 1m closes (Johnny, Sep 29 2026). Pure, no I/O, always looking back.
 *
 * Every minute t, over the last W minutes (default 120), for every coin i (BTC is the market factor):
 *   r_i          = log return of the minute
 *   beta_i       = cov(r_i, r_BTC) / var(r_BTC)            (window ending at t-1: known before t)
 *   e_i          = r_i - beta_i * r_BTC                     (the coin's own move, BTC removed)
 *   E_i(t)       = running sum of e_i                       (a "residual price")
 *   sigma_i      = std of e_i over the window
 * For a pair (a, b):
 *   corr         = correlation of the raw 1m returns over the window (they must move together)
 *   spread(t)    = E_a / sigma_a - E_b / sigma_b            (each coin measured in its own volatility)
 *   Z            = (spread - mean(spread over W)) / std(spread over W)
 * ENTRY (at the minute close): corr >= 0.80, |Z| >= 2 and |Z| smaller than a minute ago (stopped expanding).
 *   Z > 0: a ran ahead of b -> SHORT a, LONG b.   Z < 0: LONG a, SHORT b.
 * EXIT: |Z| <= 0.5 (TP) | |Z| >= 3 (STOP) | corr < 0.60 (BROKEN) | held 240 min (TIME).
 * SIZE: each leg's notional ~ 1 / its 1m volatility, the two legs together = 2 units (1 per leg on average).
 * P&L in % of one leg's unit; fees = taker 0.05% on each of the 4 fills.
 */
export interface PairSettings {
  window: number;
  corrMin: number;
  corrBreak: number;
  zIn: number;
  zOut: number;
  zStop: number;
  maxHold: number;
  fee: number;
}
export const DEFAULT_PAIRS: PairSettings = {
  window: 120,
  corrMin: 0.8,
  corrBreak: 0.6,
  zIn: 2,
  zOut: 0.5,
  zStop: 3,
  maxHold: 240,
  fee: 0.0005,
};

export interface PairTrade {
  a: string;
  b: string;
  shortLeg: string;
  longLeg: string;
  entryTs: number;
  exitTs: number;
  minutes: number;
  zIn: number;
  zOut: number;
  corr: number;
  exit: "TP" | "STOP" | "BROKEN" | "TIME" | "OPEN";
  grossPct: number;
  netPct: number;
  wA: number;
  wB: number;
  pa0: number;
  pb0: number;
  pa1: number;
  pb1: number;
}
export interface PairNow {
  a: string;
  b: string;
  z: number;
  corr: number;
  hint: string;
}

class Roll {
  private buf: number[] = [];
  private i = 0;
  n = 0;
  s = 0;
  s2 = 0;
  constructor(private readonly w: number) {}
  push(x: number): void {
    if (this.n === this.w) {
      const old = this.buf[this.i];
      this.s -= old;
      this.s2 -= old * old;
    } else this.n++;
    this.buf[this.i] = x;
    this.s += x;
    this.s2 += x * x;
    this.i = (this.i + 1) % this.w;
  }
  mean(): number {
    return this.s / this.n;
  }
  std(): number {
    const m = this.s / this.n;
    return Math.sqrt(Math.max(0, this.s2 / this.n - m * m));
  }
  full(): boolean {
    return this.n === this.w;
  }
}
class RollXY {
  private bx: number[] = [];
  private by: number[] = [];
  private i = 0;
  n = 0;
  sx = 0;
  sy = 0;
  sxx = 0;
  syy = 0;
  sxy = 0;
  constructor(private readonly w: number) {}
  push(x: number, y: number): void {
    if (this.n === this.w) {
      const ox = this.bx[this.i],
        oy = this.by[this.i];
      this.sx -= ox;
      this.sy -= oy;
      this.sxx -= ox * ox;
      this.syy -= oy * oy;
      this.sxy -= ox * oy;
    } else this.n++;
    this.bx[this.i] = x;
    this.by[this.i] = y;
    this.sx += x;
    this.sy += y;
    this.sxx += x * x;
    this.syy += y * y;
    this.sxy += x * y;
    this.i = (this.i + 1) % this.w;
  }
  private cov(): number {
    return this.sxy / this.n - (this.sx / this.n) * (this.sy / this.n);
  }
  private vx(): number {
    return this.sxx / this.n - (this.sx / this.n) ** 2;
  }
  private vy(): number {
    return this.syy / this.n - (this.sy / this.n) ** 2;
  }
  beta(): number {
    const v = this.vy();
    return v > 0 ? this.cov() / v : 0;
  } // x on y
  corr(): number {
    const d = Math.sqrt(this.vx() * this.vy());
    return d > 0 ? this.cov() / d : 0;
  }
  full(): boolean {
    return this.n === this.w;
  }
}

/**
 * `ts` = the common minute times, `px[coin]` = the close of each minute (same length), `btc` = the factor key.
 * Returns every trade (entryTs >= tradeFrom) and the pairs' state at the last minute.
 */
export function runPairs(
  ts: readonly number[],
  px: Readonly<Record<string, readonly number[]>>,
  btc: string,
  tradeFrom: number,
  s: PairSettings = DEFAULT_PAIRS,
): { trades: PairTrade[]; now: PairNow[] } {
  const coins = Object.keys(px).filter((c) => c !== btc);
  const W = s.window;
  const beta = new Map(coins.map((c) => [c, new RollXY(W)])); // (r_c, r_btc)
  const resid = new Map(coins.map((c) => [c, new Roll(W)])); // e_c
  const E = new Map(coins.map((c) => [c, 0]));
  const rawVol = new Map(coins.map((c) => [c, new Roll(W)])); // r_c (for sizing)
  const pairs: Array<{
    a: string;
    b: string;
    corr: RollXY;
    spread: Roll;
    prevZ: number;
    open: null | {
      i: number;
      z: number;
      corr: number;
      short: "a" | "b";
      wA: number;
      wB: number;
    };
  }> = [];
  for (let x = 0; x < coins.length; x++)
    for (let y = x + 1; y < coins.length; y++)
      pairs.push({
        a: coins[x],
        b: coins[y],
        corr: new RollXY(W),
        spread: new Roll(W),
        prevZ: NaN,
        open: null,
      });
  const trades: PairTrade[] = [];
  const now: PairNow[] = [];
  const close = (
    p: (typeof pairs)[number],
    i: number,
    z: number,
    exit: PairTrade["exit"],
  ): void => {
    const o = p.open!;
    const ra = px[p.a][i] / px[p.a][o.i] - 1,
      rb = px[p.b][i] / px[p.b][o.i] - 1;
    const dirA = o.short === "a" ? -1 : 1,
      dirB = -dirA;
    const gross = 100 * (o.wA * dirA * ra + o.wB * dirB * rb);
    const fees = exit === "OPEN" ? 0 : 100 * 2 * s.fee * (o.wA + o.wB);
    trades.push({
      a: p.a,
      b: p.b,
      shortLeg: o.short === "a" ? p.a : p.b,
      longLeg: o.short === "a" ? p.b : p.a,
      entryTs: ts[o.i],
      exitTs: ts[i],
      minutes: i - o.i,
      zIn: o.z,
      zOut: z,
      corr: o.corr,
      exit,
      grossPct: gross,
      netPct: gross - fees,
      wA: o.wA,
      wB: o.wB,
      pa0: px[p.a][o.i],
      pb0: px[p.b][o.i],
      pa1: px[p.a][i],
      pb1: px[p.b][i],
    });
    p.open = null;
  };
  for (let i = 1; i < ts.length; i++) {
    const rB = Math.log(px[btc][i] / px[btc][i - 1]);
    if (!Number.isFinite(rB)) continue;
    const rr = new Map<string, number>();
    for (const c of coins) {
      const r = Math.log(px[c][i] / px[c][i - 1]);
      if (!Number.isFinite(r)) continue;
      rr.set(c, r);
      const bw = beta.get(c)!;
      const b = bw.full() ? bw.beta() : 1; // beta from the window BEFORE this minute
      const e = r - b * rB;
      E.set(c, E.get(c)! + e);
      resid.get(c)!.push(e);
      rawVol.get(c)!.push(r);
      bw.push(r, rB);
    }
    for (const p of pairs) {
      const ra = rr.get(p.a),
        rb = rr.get(p.b);
      if (ra === undefined || rb === undefined) continue;
      p.corr.push(ra, rb);
      const sa = resid.get(p.a)!,
        sb = resid.get(p.b)!;
      if (!sa.full() || !sb.full() || !p.corr.full()) continue;
      const va = sa.std(),
        vb = sb.std();
      if (!(va > 0) || !(vb > 0)) continue;
      const spread = E.get(p.a)! / va - E.get(p.b)! / vb;
      p.spread.push(spread);
      if (!p.spread.full()) continue;
      const sd = p.spread.std();
      if (!(sd > 0)) continue;
      const z = (spread - p.spread.mean()) / sd,
        corr = p.corr.corr();
      if (p.open) {
        const az = Math.abs(z);
        if (az <= s.zOut) close(p, i, z, "TP");
        else if (az >= s.zStop) close(p, i, z, "STOP");
        else if (corr < s.corrBreak) close(p, i, z, "BROKEN");
        else if (i - p.open.i >= s.maxHold) close(p, i, z, "TIME");
      } else if (
        ts[i] >= tradeFrom &&
        corr >= s.corrMin &&
        Math.abs(z) >= s.zIn &&
        Math.abs(z) < s.zStop &&
        Number.isFinite(p.prevZ) &&
        Math.abs(z) < Math.abs(p.prevZ)
      ) {
        const ia = 1 / (rawVol.get(p.a)!.std() || 1),
          ib = 1 / (rawVol.get(p.b)!.std() || 1);
        const k = 2 / (ia + ib);
        p.open = {
          i,
          z,
          corr,
          short: z > 0 ? "a" : "b",
          wA: ia * k,
          wB: ib * k,
        };
      }
      p.prevZ = z;
      if (i === ts.length - 1) {
        now.push({
          a: p.a,
          b: p.b,
          z,
          corr,
          hint:
            Math.abs(z) >= s.zIn && corr >= s.corrMin
              ? z > 0
                ? `${p.a} ran ahead: SHORT ${p.a} / LONG ${p.b}`
                : `${p.b} ran ahead: SHORT ${p.b} / LONG ${p.a}`
              : "",
        });
      }
    }
  }
  for (const p of pairs) if (p.open) close(p, ts.length - 1, NaN, "OPEN");
  return { trades, now };
}
