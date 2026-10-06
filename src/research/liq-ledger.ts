/**
 * THE POSITION LEDGER -- where the open positions sit and where they get liquidated (Johnny, Oct 6 2026). Pure.
 * Start N days back with the OI of that moment and walk minute by minute to now, keeping a book of the open positions
 * by ENTRY price (longs and shorts; every open long has an open short against it, so both books hold the same amount):
 *
 *   start      the OI at the start, spread over the prices of the day before by volume (a volume profile) -- we don't
 *              know their real entries
 *   OI up      new positions at this minute's price: N longs AND N shorts
 *   closes     whoever closes, the positions that close are the ones the price moved AWAY from:
 *                price went UP this minute   -> positions entered BELOW close (longs take profit, shorts stop out)
 *                price went DOWN this minute -> positions entered ABOVE close
 *              (only if there are not enough of those, the rest closes evenly from everyone)
 *   hand-over  (Johnny) the price rises, OI stays: the longs from below took profit and NEW buyers took their place --
 *              OI shows nothing, the volume shows it. Model "vol": every minute opens N = (V + dOI)/2 and closes
 *              C = (V - dOI)/2 per side, so with dOI = 0 the volume moves positions from below/above to the price.
 *              Model "oi": only N = max(0, dOI), C = max(0, -dOI) (what the usual heatmaps do).
 *   liquidated every book is split over the leverage tiers (10/25/50/100x the same share, like the public tools); a
 *              long at entry e dies at e*(1 - 1/L + mmr), a short at e*(1 + 1/L - mmr). When the price reaches it, it is
 *              BURNED (moved to the burned book at that liquidation price); a real liquidation also lowers OI, so that
 *              part is not closed a second time.
 * Quantities are in coins (contracts).
 */
export type LedgerKind = "oi" | "vol";
export interface LedgerMinute {
  t: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  oi: number;
  dOi: number;
}
export const LEDGER_TIERS = [10, 25, 50, 100] as const;

export class LiqLedger {
  /** [tier][bin] open quantity by entry price */
  readonly long: Float64Array[];
  readonly short: Float64Array[];
  /** burned (estimated liquidated) quantity by liquidation price, since the start */
  readonly burnedLong: Float64Array;
  readonly burnedShort: Float64Array;
  private readonly k: number;
  private prevClose = NaN;

  constructor(
    readonly base: number,
    readonly bins: number,
    readonly kind: LedgerKind,
    readonly binPct = 0.1,
    readonly tiers: readonly number[] = LEDGER_TIERS,
    readonly mmr = 0,
  ) {
    this.k = Math.log(1 + binPct / 100);
    this.long = tiers.map(() => new Float64Array(bins));
    this.short = tiers.map(() => new Float64Array(bins));
    this.burnedLong = new Float64Array(bins);
    this.burnedShort = new Float64Array(bins);
  }

  idx(p: number): number {
    return Math.floor(Math.log(p / this.base) / this.k);
  }
  price(i: number): number {
    return this.base * Math.exp((i + 0.5) * this.k);
  }
  liqLong(i: number, lev: number): number {
    return this.price(i) * (1 - 1 / lev + this.mmr);
  }
  liqShort(i: number, lev: number): number {
    return this.price(i) * (1 + 1 / lev - this.mmr);
  }

  private add(i: number, q: number): void {
    if (!(i >= 0 && i < this.bins) || !(q > 0)) return;
    const part = q / this.tiers.length;
    for (let j = 0; j < this.tiers.length; j++) {
      this.long[j][i] += part;
      this.short[j][i] += part;
    }
  }

  /** the OI at the start, spread by a volume profile: [price, volume] */
  seed(
    oi: number,
    profile: ReadonlyArray<[number, number]>,
    lastClose: number,
  ): void {
    const tot = profile.reduce((a, [, v]) => a + v, 0);
    if (tot > 0)
      for (const [p, v] of profile) this.add(this.idx(p), (oi * v) / tot);
    else this.add(this.idx(lastClose), oi);
    this.prevClose = lastClose;
  }

  total(side: "long" | "short"): number {
    let s = 0;
    for (const a of this[side]) for (let i = 0; i < this.bins; i++) s += a[i];
    return s;
  }

  /** close q from one side's book: first from the entries the price moved away from */
  private close(
    book: Float64Array[],
    q: number,
    cut: number,
    up: boolean,
  ): void {
    if (!(q > 0)) return;
    const away = (i: number): boolean => (up ? i < cut : i > cut);
    let avail = 0,
      all = 0;
    for (const a of book)
      for (let i = 0; i < this.bins; i++) {
        all += a[i];
        if (away(i)) avail += a[i];
      }
    const f1 = avail > 0 ? Math.min(1, q / avail) : 0,
      rest = q - f1 * avail,
      left = all - f1 * avail;
    const f2 = rest > 0 && left > 0 ? Math.min(1, rest / left) : 0;
    for (const a of book)
      for (let i = 0; i < this.bins; i++) {
        if (away(i)) a[i] *= 1 - f1;
        a[i] *= 1 - f2;
      }
  }

  step(m: LedgerMinute): void {
    // 1. burned: the liquidation prices the price reached this minute
    let bL = 0,
      bS = 0;
    this.tiers.forEach((lev, j) => {
      for (let i = 0; i < this.bins; i++) {
        if (this.long[j][i] > 0) {
          const lp = this.liqLong(i, lev);
          if (lp >= m.low) {
            const b = this.idx(lp);
            if (b >= 0 && b < this.bins) this.burnedLong[b] += this.long[j][i];
            bL += this.long[j][i];
            this.long[j][i] = 0;
          }
        }
        if (this.short[j][i] > 0) {
          const lp = this.liqShort(i, lev);
          if (lp <= m.high) {
            const b = this.idx(lp);
            if (b >= 0 && b < this.bins)
              this.burnedShort[b] += this.short[j][i];
            bS += this.short[j][i];
            this.short[j][i] = 0;
          }
        }
      }
    });
    // 2. opens / closes per side
    const [n, c] =
      this.kind === "oi"
        ? [Math.max(0, m.dOi), Math.max(0, -m.dOi)]
        : [Math.max(0, (m.vol + m.dOi) / 2), Math.max(0, (m.vol - m.dOi) / 2)];
    const up = !(m.close < this.prevClose),
      cut = this.idx(m.close);
    // a liquidation lowers the OI too -- what burned is already gone, don't close it twice
    this.close(this.long, c - bL, cut, up);
    this.close(this.short, c - bS, cut, up);
    // 3. new positions at the close
    this.add(cut, n);
    this.prevClose = m.close;
  }

  /** the alive liquidation quantity by liquidation-price bin: long (below) and short (above) */
  liqMap(): { long: Float64Array; short: Float64Array } {
    const L = new Float64Array(this.bins),
      S = new Float64Array(this.bins);
    this.tiers.forEach((lev, j) => {
      for (let i = 0; i < this.bins; i++) {
        if (this.long[j][i] > 0) {
          const b = this.idx(this.liqLong(i, lev));
          if (b >= 0 && b < this.bins) L[b] += this.long[j][i];
        }
        if (this.short[j][i] > 0) {
          const b = this.idx(this.liqShort(i, lev));
          if (b >= 0 && b < this.bins) S[b] += this.short[j][i];
        }
      }
    });
    return { long: L, short: S };
  }

  /** the open positions by entry bin (longs = shorts in amount, but they can sit at different prices) */
  entries(): { long: Float64Array; short: Float64Array } {
    const L = new Float64Array(this.bins),
      S = new Float64Array(this.bins);
    for (const a of this.long) for (let i = 0; i < this.bins; i++) L[i] += a[i];
    for (const a of this.short)
      for (let i = 0; i < this.bins; i++) S[i] += a[i];
    return { long: L, short: S };
  }
}
