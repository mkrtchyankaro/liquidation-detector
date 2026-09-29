/**
 * PHASE 1 -- 4h STRUCTURE: swings, trend state, wick-to-body zones (Johnny, Sep 29 2026).
 * Spec: docs/phase1-4h-structure-spec.md. Pure, no I/O. Only CLOSED 4h candles are ever passed in.
 * No entries, exits, take profit or P&L here.
 *
 * TIME. Every candle is known only at its closeTime (= openTime + 4h). The engine walks the candles in order;
 * step j happens at T = closeTime(j) and may use only candles 0..j and objects whose "known" time <= T.
 *
 * ATR (one formula everywhere):
 *   TR(k)  = max(high[k], close[k-1]) - min(low[k], close[k-1])        (k = 0: high[0] - low[0])
 *   ATR(j) = (TR(j-13) + ... + TR(j)) / 14                              simple mean of the last 14 TRs,
 *            candle j included -> known at closeTime(j). Undefined for j < 13.
 *   A pivot confirmed at step j uses ATR(j); a zone created at step j uses ATR(j).
 *
 * PIVOTS (L left, R right; default 2/2). Candidate i = j - R is checked at step j:
 *   HIGH: high[i] >  max(high[i-L..i-1])  and  high[i] >= max(high[i+1..i+R])
 *   LOW : low[i]  <  min(low[i-L..i-1])   and  low[i]  <= min(low[i+1..i+R])
 *   confirmedAt = closeTime(j) = closeTime(i + R); the pivot does not exist for the engine before that.
 *   prominence(HIGH) = high[i] - min(low[i-L..i+R]);  prominence(LOW) = max(high[i-L..i+R]) - low[i]
 *   meaningful if prominence / ATR(j) >= minProminenceAtr.
 *
 * ORDER INSIDE ONE STEP j (all at T = closeTime(j)):
 *   1. candle j is checked against the zones that already existed BEFORE T (touch, broken, expiry);
 *   2. candle j is checked against the protected level that existed before T (structural break);
 *   3. pivots confirmed at T are added -> new zones (createdAt = T), trend re-evaluated.
 *   So candle j can never "touch" a zone born at its own close; the first possible touch is candle j+1,
 *   which opens exactly at T.
 *
 * TREND (meaningful pivots only; H1 < H2 and L1 < L2 by pivot time):
 *   BULL if H2 > H1 and L2 > L1; BEAR if H2 < H1 and L2 < L1; else NEUTRAL.
 *   After a structural break at time B the trend is NEUTRAL, and a new BULL/BEAR needs at least one of the four
 *   pivots to be confirmed after B (fresh evidence) -- the old pivots alone cannot restore the old trend.
 *   PROTECTED level:  PL-A (default): BULL -> the last LOW whose pivotTime < H2.pivotTime (the low the last higher
 *   high started from); BEAR -> the last HIGH whose pivotTime < L2.pivotTime.   PL-B: BULL -> L2, BEAR -> H2.
 *   BREAK: CLOSE (default): close[j] < protected (BULL) / > protected (BEAR);  WICK: low[j] < / high[j] >.
 *
 * ZONES (from meaningful pivots, at confirmedAt):
 *   LOW  -> SUPPORT    [low, min(open, close)]         HIGH -> RESISTANCE [max(open, close), high]
 *   minimum height minWidthAtr * ATR (widened away from the wick tip).
 *   merge: same side, ACTIVE, overlapping or gap <= mergeAtr * ATR -> the older zone grows (its createdAt, the
 *   moment it FIRST became usable, stays; the growth is logged with its own time).
 *   touch: a candle that opened at/after the zone existed and reached it (SUPPORT: low <= hi; RESISTANCE: high >= lo);
 *   consecutive touching candles = one touch.  BROKEN: close beyond the far edge (SUPPORT close < lo, RESISTANCE
 *   close > hi).  EXPIRED: older than maxAgeBars, or maxTouches reached (0 = off).  No flip in v1.
 */
export interface Candle4h {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export type PivotKind = "HIGH" | "LOW";
export interface Pivot {
  id: string;
  kind: PivotKind;
  index: number;
  pivotTime: number;
  confirmedAt: number;
  price: number;
  bodyEdge: number;
  prominenceAtr: number;
  meaningful: boolean;
  candle: Candle4h;
}
export type ZoneSide = "SUPPORT" | "RESISTANCE";
export interface Touch {
  candleOpenTime: number;
  knownAt: number;
  depth: number;
}
export interface ZoneUpdate {
  at: number;
  lo: number;
  hi: number;
  pivotId: string;
  kind: "CREATED" | "MERGED";
}
export interface Zone {
  id: string;
  side: ZoneSide;
  lo: number;
  hi: number;
  sourcePivotIds: string[];
  createdAt: number;
  atrAtCreation: number;
  touches: Touch[];
  state: "ACTIVE" | "BROKEN" | "EXPIRED";
  endedAt: number | null;
  endReason: string | null;
  updates: ZoneUpdate[];
}
export type Trend = "BULL" | "BEAR" | "NEUTRAL";
export interface Protected {
  pivotId: string;
  price: number;
  pivotTime: number;
  confirmedAt: number;
}
export interface TrendEvent {
  at: number;
  from: Trend;
  to: Trend;
  reason: string;
  protected: Protected | null;
  pivots: { H1?: Pivot; H2?: Pivot; L1?: Pivot; L2?: Pivot };
}
export interface StructureSettings {
  L: number;
  R: number;
  minProminenceAtr: number;
  mergeAtr: number;
  minWidthAtr: number;
  maxAgeBars: number;
  maxTouches: number;
  protectedRule: "PL-A" | "PL-B";
  breakRule: "CLOSE" | "WICK";
}
export const DEFAULT_STRUCTURE: StructureSettings = {
  L: 2,
  R: 2,
  minProminenceAtr: 1.0,
  mergeAtr: 0.25,
  minWidthAtr: 0.1,
  maxAgeBars: 180,
  maxTouches: 0,
  protectedRule: "PL-A",
  breakRule: "CLOSE",
};
export const H4 = 4 * 3_600_000;

export interface StructureResult {
  pivots: Pivot[]; // every pivot (meaningful or not), in confirmation order
  zones: Zone[]; // every zone ever created (with its final state as of the last candle)
  events: TrendEvent[]; // trend changes, in time order
  trend: Trend;
  trendSince: number;
  protected: Protected | null;
  lastBreakAt: number | null;
  atr: number; // ATR of the last candle
  asOf: number; // closeTime of the last candle used
}

export function trueRanges(c: readonly Candle4h[]): number[] {
  return c.map((k, i) =>
    i === 0
      ? k.high - k.low
      : Math.max(k.high, c[i - 1].close) - Math.min(k.low, c[i - 1].close),
  );
}

export function runStructure(
  symbol: string,
  c: readonly Candle4h[],
  s: StructureSettings = DEFAULT_STRUCTURE,
): StructureResult {
  const tr = trueRanges(c);
  const atrAt = (j: number): number => {
    if (j < 13) return NaN;
    let x = 0;
    for (let k = j - 13; k <= j; k++) x += tr[k];
    return x / 14;
  };
  const pivots: Pivot[] = [],
    zones: Zone[] = [],
    events: TrendEvent[] = [];
  const highs: Pivot[] = [],
    lows: Pivot[] = []; // meaningful, confirmed
  let trend: Trend = "NEUTRAL",
    trendSince = c[0]?.closeTime ?? 0,
    prot: Protected | null = null,
    lastBreakAt: number | null = null;
  const touching = new Map<string, boolean>(); // zone id -> previous candle touched it
  const toProt = (p: Pivot): Protected => ({
    pivotId: p.id,
    price: p.price,
    pivotTime: p.pivotTime,
    confirmedAt: p.confirmedAt,
  });

  for (let j = 0; j < c.length; j++) {
    const k = c[j],
      T = k.closeTime;
    // 1. candle j vs zones that existed before T
    for (const z of zones) {
      if (z.state !== "ACTIVE" || z.createdAt > k.openTime) continue; // created at T (or later): not this candle's business
      if ((k.openTime - z.createdAt) / H4 >= s.maxAgeBars) {
        z.state = "EXPIRED";
        z.endedAt = k.openTime;
        z.endReason = `older than ${s.maxAgeBars} bars`;
        continue;
      }
      const hit = z.side === "SUPPORT" ? k.low <= z.hi : k.high >= z.lo;
      if (hit) {
        const h = z.hi - z.lo || 1e-12;
        const depth =
          z.side === "SUPPORT" ? (z.hi - k.low) / h : (k.high - z.lo) / h;
        if (!touching.get(z.id))
          z.touches.push({ candleOpenTime: k.openTime, knownAt: T, depth });
        else {
          const last = z.touches[z.touches.length - 1];
          last.depth = Math.max(last.depth, depth);
        }
      }
      touching.set(z.id, hit);
      if (z.side === "SUPPORT" ? k.close < z.lo : k.close > z.hi) {
        z.state = "BROKEN";
        z.endedAt = T;
        z.endReason = `4h close ${k.close} beyond ${z.side === "SUPPORT" ? "lo" : "hi"}`;
        continue;
      }
      if (s.maxTouches > 0 && z.touches.length >= s.maxTouches && !hit) {
        z.state = "EXPIRED";
        z.endedAt = T;
        z.endReason = `${s.maxTouches} touches`;
      }
    }
    // 2. structural break vs the protected level known before T
    if (prot && trend !== "NEUTRAL") {
      const broke =
        trend === "BULL"
          ? s.breakRule === "CLOSE"
            ? k.close < prot.price
            : k.low < prot.price
          : s.breakRule === "CLOSE"
            ? k.close > prot.price
            : k.high > prot.price;
      if (broke) {
        events.push({
          at: T,
          from: trend,
          to: "NEUTRAL",
          reason: `${s.breakRule === "CLOSE" ? "4h close" : "4h wick"} ${trend === "BULL" ? "below" : "above"} protected ${prot.price} (candle ${k.openTime})`,
          protected: prot,
          pivots: {},
        });
        trend = "NEUTRAL";
        trendSince = T;
        prot = null;
        lastBreakAt = T;
      }
    }
    // 3. pivots confirmed at T
    const i = j - s.R;
    if (i - s.L < 0) continue;
    const atr = atrAt(j);
    const cand = c[i];
    const win = c.slice(i - s.L, i + s.R + 1);
    const leftH = Math.max(...c.slice(i - s.L, i).map((x) => x.high)),
      rightH = Math.max(...c.slice(i + 1, i + s.R + 1).map((x) => x.high));
    const leftL = Math.min(...c.slice(i - s.L, i).map((x) => x.low)),
      rightL = Math.min(...c.slice(i + 1, i + s.R + 1).map((x) => x.low));
    const newOnes: Pivot[] = [];
    if (cand.high > leftH && cand.high >= rightH) {
      const prom = cand.high - Math.min(...win.map((x) => x.low));
      newOnes.push({
        id: `${symbol}:HIGH:${cand.openTime}`,
        kind: "HIGH",
        index: i,
        pivotTime: cand.openTime,
        confirmedAt: T,
        price: cand.high,
        bodyEdge: Math.max(cand.open, cand.close),
        prominenceAtr: prom / atr,
        meaningful: Number.isFinite(atr) && prom / atr >= s.minProminenceAtr,
        candle: cand,
      });
    }
    if (cand.low < leftL && cand.low <= rightL) {
      const prom = Math.max(...win.map((x) => x.high)) - cand.low;
      newOnes.push({
        id: `${symbol}:LOW:${cand.openTime}`,
        kind: "LOW",
        index: i,
        pivotTime: cand.openTime,
        confirmedAt: T,
        price: cand.low,
        bodyEdge: Math.min(cand.open, cand.close),
        prominenceAtr: prom / atr,
        meaningful: Number.isFinite(atr) && prom / atr >= s.minProminenceAtr,
        candle: cand,
      });
    }
    for (const p of newOnes) {
      pivots.push(p);
      if (!p.meaningful) continue;
      (p.kind === "HIGH" ? highs : lows).push(p);
      // zone
      const side: ZoneSide = p.kind === "LOW" ? "SUPPORT" : "RESISTANCE";
      let lo = p.kind === "LOW" ? p.price : p.bodyEdge,
        hi = p.kind === "LOW" ? p.bodyEdge : p.price;
      const w = s.minWidthAtr * atr;
      if (hi - lo < w) {
        if (p.kind === "LOW") hi = lo + w;
        else lo = hi - w;
      }
      const near = zones.find(
        (z) =>
          z.state === "ACTIVE" &&
          z.side === side &&
          lo - z.hi <= s.mergeAtr * atr &&
          z.lo - hi <= s.mergeAtr * atr,
      );
      if (near) {
        near.lo = Math.min(near.lo, lo);
        near.hi = Math.max(near.hi, hi);
        near.sourcePivotIds.push(p.id);
        near.updates.push({
          at: T,
          lo: near.lo,
          hi: near.hi,
          pivotId: p.id,
          kind: "MERGED",
        });
      } else {
        zones.push({
          id: `${p.id}:Z`,
          side,
          lo,
          hi,
          sourcePivotIds: [p.id],
          createdAt: T,
          atrAtCreation: atr,
          touches: [],
          state: "ACTIVE",
          endedAt: null,
          endReason: null,
          updates: [{ at: T, lo, hi, pivotId: p.id, kind: "CREATED" }],
        });
      }
    }
    if (!newOnes.some((p) => p.meaningful)) continue;
    // trend re-evaluation
    const [H1, H2] = highs.slice(-2),
      [L1, L2] = lows.slice(-2);
    let next: Trend = "NEUTRAL";
    if (H1 && H2 && L1 && L2) {
      const fresh =
        lastBreakAt === null ||
        [H1, H2, L1, L2].some((p) => p.confirmedAt > lastBreakAt!);
      if (fresh && H2.price > H1.price && L2.price > L1.price) next = "BULL";
      else if (fresh && H2.price < H1.price && L2.price < L1.price)
        next = "BEAR";
    }
    let nextProt: Protected | null = null;
    if (next === "BULL") {
      const p =
        s.protectedRule === "PL-A"
          ? [...lows].reverse().find((x) => x.pivotTime < H2.pivotTime)
          : L2;
      nextProt = p ? toProt(p) : null;
    } else if (next === "BEAR") {
      const p =
        s.protectedRule === "PL-A"
          ? [...highs].reverse().find((x) => x.pivotTime < L2.pivotTime)
          : H2;
      nextProt = p ? toProt(p) : null;
    }
    if (next !== trend) {
      events.push({
        at: T,
        from: trend,
        to: next,
        reason:
          next === "NEUTRAL"
            ? "pivots no longer HH+HL / LH+LL"
            : next === "BULL"
              ? "higher high + higher low"
              : "lower high + lower low",
        protected: nextProt,
        pivots: { H1, H2, L1, L2 },
      });
      trend = next;
      trendSince = T;
    } else if (
      next !== "NEUTRAL" &&
      nextProt &&
      prot &&
      nextProt.pivotId !== prot.pivotId
    ) {
      events.push({
        at: T,
        from: trend,
        to: trend,
        reason: "protected level moved",
        protected: nextProt,
        pivots: { H1, H2, L1, L2 },
      });
    }
    prot = nextProt;
  }
  const last = c.length - 1;
  return {
    pivots,
    zones,
    events,
    trend,
    trendSince,
    protected: prot,
    lastBreakAt,
    atr: atrAt(last),
    asOf: c[last]?.closeTime ?? 0,
  };
}
