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
 *   liquidated a long at entry e with leverage L dies at e*(1 - 1/L + mmr), a short at e*(1 + 1/L - mmr).
 *     NOT calibrated (the public tools): every book split evenly over the tiers; a level the price reaches BURNS whole.
 *     CALIBRATED (Oct 6 -- the even split burned ~100x more than our real liquidations: most OI is low leverage):
 *              the leverage is unknown, so every new position starts at the HIGHEST tier; when the price reaches its
 *              liquidation price, only as much dies as OUR REAL liquidations of that side in that minute (liqL / liqS,
 *              coins); the rest SURVIVED -> it had less leverage -> moves to the next lower tier (same entry). The last
 *              tier never dies (it is "low leverage, far away"). Per tier we count what reached its level (tested) and
 *              what died -> the learned chance to die there; liqMap() spreads every position over its remaining tiers
 *              with those chances = the EXPECTED liquidations (same scale as our real ones); what would survive even
 *              the last tier is not drawn (it is not expected to be liquidated anywhere near).
 *   A real liquidation also lowers OI, so the burned part is not closed a second time.
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
  /** our real liquidations in this minute (coins): longs liquidated / shorts liquidated -- used when calibrated */
  liqL?: number;
  liqS?: number;
}
export const LEDGER_TIERS = [10, 25, 50, 100] as const;
export const LEDGER_TIERS_CAL = [100, 50, 25, 10, 5] as const;

export class LiqLedger {
  /** [tier][bin] open quantity by entry price */
  readonly long: Float64Array[];
  readonly short: Float64Array[];
  /** burned (liquidated) quantity by liquidation price, since the start */
  readonly burnedLong: Float64Array;
  readonly burnedShort: Float64Array;
  /** calibrated: per tier, what reached its liquidation price and what died there */
  readonly tested: number[];
  readonly died: number[];
  private readonly k: number;
  private prevClose = NaN;

  constructor(
    readonly base: number,
    readonly bins: number,
    readonly kind: LedgerKind,
    readonly binPct = 0.1,
    readonly tiers: readonly number[] = LEDGER_TIERS,
    readonly mmr = 0,
    readonly calibrated = false,
  ) {
    this.k = Math.log(1 + binPct / 100);
    this.long = tiers.map(() => new Float64Array(bins));
    this.short = tiers.map(() => new Float64Array(bins));
    this.burnedLong = new Float64Array(bins);
    this.burnedShort = new Float64Array(bins);
    this.tested = tiers.map(() => 0);
    this.died = tiers.map(() => 0);
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
    if (this.calibrated) {
      this.long[0][i] += q;
      this.short[0][i] += q;
      return;
    }
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

  /** the learned chance to die when the price reaches tier j's level (pooled over all tiers when j was never tested) */
  pDie(j: number): number {
    if (!this.calibrated) return 1;
    if (this.tested[j] > 0) return this.died[j] / this.tested[j];
    const t = this.tested.reduce((a, v) => a + v, 0),
      d = this.died.reduce((a, v) => a + v, 0);
    return t > 0 ? d / t : 1;
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

  /** the liquidation prices reached this minute; returns the quantity that died */
  private burn(side: "long" | "short", m: LedgerMinute): number {
    const book = this[side],
      burned = side === "long" ? this.burnedLong : this.burnedShort;
    const liq = (i: number, lev: number): number =>
      side === "long" ? this.liqLong(i, lev) : this.liqShort(i, lev);
    const hit = (p: number): boolean =>
      side === "long" ? p >= m.low : p <= m.high;
    if (!this.calibrated) {
      let b = 0;
      this.tiers.forEach((lev, j) => {
        for (let i = 0; i < this.bins; i++) {
          const v = book[j][i];
          if (v > 0) {
            const lp = liq(i, lev);
            if (hit(lp)) {
              const z = this.idx(lp);
              if (z >= 0 && z < this.bins) burned[z] += v;
              b += v;
              book[j][i] = 0;
            }
          }
        }
      });
      return b;
    }
    // calibrated: everything that reached its level, then only the real liquidations die, the rest moves a tier down
    const last = this.tiers.length - 1;
    let reached = 0;
    for (let j = 0; j < last; j++)
      for (let i = 0; i < this.bins; i++)
        if (book[j][i] > 0 && hit(liq(i, this.tiers[j]))) reached += book[j][i];
    if (!(reached > 0)) return 0;
    const real = Math.max(0, (side === "long" ? m.liqL : m.liqS) ?? 0),
      d = Math.min(1, real / reached);
    let b = 0;
    // from the lowest tier up, so a survivor moved down is not handled twice in this minute
    for (let j = last - 1; j >= 0; j--) {
      const lev = this.tiers[j];
      for (let i = 0; i < this.bins; i++) {
        const v = book[j][i];
        if (!(v > 0)) continue;
        const lp = liq(i, lev);
        if (!hit(lp)) continue;
        this.tested[j] += v;
        this.died[j] += v * d;
        const z = this.idx(lp);
        if (z >= 0 && z < this.bins) burned[z] += v * d;
        b += v * d;
        book[j + 1][i] += v * (1 - d);
        book[j][i] = 0;
      }
    }
    return b;
  }

  step(m: LedgerMinute): void {
    // 1. liquidated
    const bL = this.burn("long", m),
      bS = this.burn("short", m);
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

  /** the expected liquidation quantity by liquidation-price bin: long (below) and short (above) */
  liqMap(): { long: Float64Array; short: Float64Array } {
    const L = new Float64Array(this.bins),
      S = new Float64Array(this.bins);
    const p = this.tiers.map((_, j) => this.pDie(j));
    const spread = (
      book: Float64Array[],
      out: Float64Array,
      liq: (i: number, lev: number) => number,
    ): void => {
      this.tiers.forEach((_, j) => {
        for (let i = 0; i < this.bins; i++) {
          let mass = book[j][i];
          if (!(mass > 0)) continue;
          const end = this.calibrated ? this.tiers.length : j + 1;
          for (let k = j; k < end; k++) {
            const share = this.calibrated ? mass * p[k] : mass;
            const z = this.idx(liq(i, this.tiers[k]));
            if (z >= 0 && z < this.bins) out[z] += share;
            mass -= share;
            if (!(mass > 0)) break;
          }
        }
      });
    };
    spread(this.long, L, (i, lev) => this.liqLong(i, lev));
    spread(this.short, S, (i, lev) => this.liqShort(i, lev));
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
