/**
 * PARITY CHECK: pine/structure-4h-phase1.pine vs src/research/structure4h.ts.
 * pineEngine() below is a line-by-line transliteration of the Pine engine block (same arrays, same loops, same
 * order, same bar filter / warm-up start), without the drawing calls. It is compared with runStructure() on many
 * random 4h series and settings, at many as-of cut points. This checks the Pine LOGIC; it cannot check the
 * TradingView runtime itself (that is what the on-chart table vs CLI comparison is for).
 */
import assert from "node:assert/strict";
import {
  runStructure,
  DEFAULT_STRUCTURE,
  H4,
  type Candle4h,
  type StructureSettings,
} from "../src/research/structure4h";

const DAY = 86_400_000;
interface PPivot {
  kind: 1 | -1;
  index: number;
  pivotTime: number;
  confirmedAt: number;
  price: number;
  bodyEdge: number;
  promAtr: number;
  meaningful: boolean;
}
interface PZone {
  side: 1 | -1;
  lo: number;
  hi: number;
  createdAt: number;
  nTouches: number;
  touching: boolean;
  state: 0 | 1 | 2;
  endedAt: number | null;
  nSrc: number;
}
interface PEvent {
  at: number;
  from: string;
  to: string;
  protTime: number | null;
}

/** bars = the chart's bars (all closed here); mirrors `engineBar` + the engine block of the Pine script */
function pineEngine(
  bars: Candle4h[],
  s: StructureSettings,
  asOfMs: number,
  months: number,
  warmupDays: number,
) {
  const reportFrom = asOfMs - months * 30 * DAY;
  const startMs = Math.floor((reportFrom - warmupDays * DAY) / H4) * H4;
  const cO: number[] = [],
    cH: number[] = [],
    cL: number[] = [],
    cC: number[] = [],
    cT: number[] = [],
    trA: number[] = [];
  const highs: PPivot[] = [],
    lows: PPivot[] = [],
    zones: PZone[] = [],
    pivots: PPivot[] = [],
    events: PEvent[] = [];
  let trend = "NEUTRAL",
    trendSince = NaN,
    prot: PPivot | null = null,
    lastBreakAt: number | null = null;
  const atrAt = (j: number): number => {
    let r = NaN;
    if (j >= 13) {
      let x = 0;
      for (let k = j - 13; k <= j; k++) x += trA[k];
      r = x / 14;
    }
    return r;
  };
  for (const b of bars) {
    const { openTime: time, open, high, low, close } = b;
    if (!(time >= startMs && time + H4 <= asOfMs)) continue; // engineBar
    const T = time + H4;
    if (cT.length === 0) trendSince = T;
    cO.push(open);
    cH.push(high);
    cL.push(low);
    cC.push(close);
    cT.push(time);
    const j = cT.length - 1;
    trA.push(
      j === 0
        ? high - low
        : Math.max(high, cC[j - 1]) - Math.min(low, cC[j - 1]),
    );
    // 1
    for (const z of zones) {
      if (z.state === 0 && z.createdAt <= time) {
        if (time - z.createdAt >= s.maxAgeBars * H4) {
          z.state = 2;
          z.endedAt = time;
        } else {
          const hit = z.side === 1 ? low <= z.hi : high >= z.lo;
          if (hit && !z.touching) z.nTouches += 1;
          z.touching = hit;
          if (z.side === 1 ? close < z.lo : close > z.hi) {
            z.state = 1;
            z.endedAt = T;
          } else if (s.maxTouches > 0 && z.nTouches >= s.maxTouches && !hit) {
            z.state = 2;
            z.endedAt = T;
          }
        }
      }
    }
    // 2
    if (prot && trend !== "NEUTRAL") {
      const broke =
        trend === "BULL"
          ? s.breakRule === "CLOSE"
            ? close < prot.price
            : low < prot.price
          : s.breakRule === "CLOSE"
            ? close > prot.price
            : high > prot.price;
      if (broke) {
        events.push({
          at: T,
          from: trend,
          to: "NEUTRAL",
          protTime: prot.pivotTime,
        });
        trend = "NEUTRAL";
        trendSince = T;
        prot = null;
        lastBreakAt = T;
      }
    }
    // 3
    const i = j - s.R;
    if (i - s.L >= 0) {
      const atr = atrAt(j);
      let leftH = cH[i - s.L],
        leftL = cL[i - s.L];
      for (let k = i - s.L; k <= i - 1; k++) {
        leftH = Math.max(leftH, cH[k]);
        leftL = Math.min(leftL, cL[k]);
      }
      let rightH = cH[i + 1],
        rightL = cL[i + 1];
      for (let k = i + 1; k <= i + s.R; k++) {
        rightH = Math.max(rightH, cH[k]);
        rightL = Math.min(rightL, cL[k]);
      }
      const winH = Math.max(leftH, rightH, cH[i]),
        winL = Math.min(leftL, rightL, cL[i]);
      const newOnes: PPivot[] = [];
      const ch = cH[i],
        cl = cL[i];
      if (ch > leftH && ch >= rightH) {
        const pa = (ch - winL) / atr;
        newOnes.push({
          kind: 1,
          index: i,
          pivotTime: cT[i],
          confirmedAt: T,
          price: ch,
          bodyEdge: Math.max(cO[i], cC[i]),
          promAtr: pa,
          meaningful: !Number.isNaN(atr) && pa >= s.minProminenceAtr,
        });
      }
      if (cl < leftL && cl <= rightL) {
        const pa = (winH - cl) / atr;
        newOnes.push({
          kind: -1,
          index: i,
          pivotTime: cT[i],
          confirmedAt: T,
          price: cl,
          bodyEdge: Math.min(cO[i], cC[i]),
          promAtr: pa,
          meaningful: !Number.isNaN(atr) && pa >= s.minProminenceAtr,
        });
      }
      let anyMeaningful = false;
      for (const p of newOnes) {
        pivots.push(p);
        if (!p.meaningful) continue;
        anyMeaningful = true;
        (p.kind === 1 ? highs : lows).push(p);
        const side = p.kind === -1 ? 1 : -1;
        let lo = p.kind === -1 ? p.price : p.bodyEdge,
          hi = p.kind === -1 ? p.bodyEdge : p.price;
        const w = s.minWidthAtr * atr;
        if (hi - lo < w) {
          if (p.kind === -1) hi = lo + w;
          else lo = hi - w;
        }
        let near: PZone | null = null;
        for (const z of zones)
          if (
            z.state === 0 &&
            z.side === side &&
            lo - z.hi <= s.mergeAtr * atr &&
            z.lo - hi <= s.mergeAtr * atr
          ) {
            near = z;
            break;
          }
        if (near) {
          near.lo = Math.min(near.lo, lo);
          near.hi = Math.max(near.hi, hi);
          near.nSrc += 1;
        } else
          zones.push({
            side: side as 1 | -1,
            lo,
            hi,
            createdAt: T,
            nTouches: 0,
            touching: false,
            state: 0,
            endedAt: null,
            nSrc: 1,
          });
      }
      if (anyMeaningful) {
        let nxt = "NEUTRAL";
        let H2: PPivot | null = null,
          L2: PPivot | null = null;
        const nH = highs.length,
          nL = lows.length;
        if (nH >= 2 && nL >= 2) {
          const H1 = highs[nH - 2],
            L1 = lows[nL - 2];
          H2 = highs[nH - 1];
          L2 = lows[nL - 1];
          const fresh =
            lastBreakAt === null ||
            H1.confirmedAt > lastBreakAt ||
            H2.confirmedAt > lastBreakAt ||
            L1.confirmedAt > lastBreakAt ||
            L2.confirmedAt > lastBreakAt;
          if (fresh && H2.price > H1.price && L2.price > L1.price) nxt = "BULL";
          else if (fresh && H2.price < H1.price && L2.price < L1.price)
            nxt = "BEAR";
        }
        let np: PPivot | null = null;
        if (nxt === "BULL") {
          if (s.protectedRule === "PL-A") {
            for (let k = nL - 1; k >= 0; k--)
              if (lows[k].pivotTime < H2!.pivotTime) {
                np = lows[k];
                break;
              }
          } else np = L2;
        } else if (nxt === "BEAR") {
          if (s.protectedRule === "PL-A") {
            for (let k = nH - 1; k >= 0; k--)
              if (highs[k].pivotTime < L2!.pivotTime) {
                np = highs[k];
                break;
              }
          } else np = H2;
        }
        if (nxt !== trend) {
          events.push({
            at: T,
            from: trend,
            to: nxt,
            protTime: np?.pivotTime ?? null,
          });
          trend = nxt;
          trendSince = T;
        }
        prot = np;
      }
    }
  }
  return {
    pivots,
    zones,
    events,
    trend,
    trendSince,
    prot,
    startMs,
    reportFrom,
    n: cT.length,
  };
}

// ---- random 4h series: volatility regimes + trend legs + gaps + flat stretches ----
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
function series(seed: number, n: number, start: number): Candle4h[] {
  const r = rng(seed);
  const out: Candle4h[] = [];
  let px = 50 + r() * 50000,
    vol = 0.01,
    drift = 0;
  for (let k = 0; k < n; k++) {
    if (r() < 0.03) vol = 0.003 + r() * 0.03;
    if (r() < 0.02) drift = (r() - 0.5) * 0.01;
    const o = px,
      c = o * (1 + drift + (r() - 0.5) * 2 * vol);
    const flat = r() < 0.02;
    const h = flat ? Math.max(o, c) : Math.max(o, c) * (1 + r() * vol),
      l = flat ? Math.min(o, c) : Math.min(o, c) * (1 - r() * vol);
    const q = (v: number): number => Math.round(v * 100) / 100; // tick 0.01 -> exact ties happen
    out.push({
      openTime: start + k * H4,
      closeTime: start + (k + 1) * H4,
      open: q(o),
      high: q(Math.max(h, o, c)),
      low: q(Math.min(l, o, c)),
      close: q(c),
    });
    px = c;
  }
  return out;
}

let checks = 0,
  cases = 0;
const START = Date.UTC(2025, 6, 1);
const variants: Array<Partial<StructureSettings>> = [
  {},
  { L: 1, R: 1 },
  { L: 3, R: 2 },
  { L: 2, R: 3 },
  { minProminenceAtr: 0 },
  { minProminenceAtr: 2 },
  { mergeAtr: 0 },
  { mergeAtr: 1.5 },
  { minWidthAtr: 0.5 },
  { maxAgeBars: 30 },
  { maxTouches: 2 },
  { protectedRule: "PL-B" },
  { breakRule: "WICK" },
  { protectedRule: "PL-B", breakRule: "WICK", L: 1, R: 3 },
];
for (let seed = 1; seed <= 40; seed++) {
  const bars = series(seed, 1400, START);
  for (const v of variants) {
    const s = { ...DEFAULT_STRUCTURE, ...v };
    for (const months of [1, 2, 3]) {
      // as-of: a few odd moments (not on a 4h boundary) inside the series
      for (const frac of [0.55, 0.8, 1.0]) {
        const asOf =
          START +
          Math.floor(1400 * frac) * H4 -
          37 * 60_000 +
          ((seed % 3) * H4) / 2;
        // CLI: from = floor((asOf - months*30d - 60d)/4h)*4h, candles with openTime >= from and closeTime <= asOf
        const reportFrom = asOf - months * 30 * DAY,
          from = Math.floor((reportFrom - 60 * DAY) / H4) * H4;
        const c = bars.filter((k) => k.openTime >= from && k.closeTime <= asOf);
        const ts = runStructure("X", c, s);
        const pn = pineEngine(bars, s, asOf, months, 60);
        cases++;
        const tag = `seed ${seed} ${JSON.stringify(v)} m${months} f${frac}`;
        assert.equal(pn.n, c.length, `${tag}: same candles`);
        assert.equal(pn.pivots.length, ts.pivots.length, `${tag}: pivot count`);
        pn.pivots.forEach((p, k) => {
          const q = ts.pivots[k];
          assert.ok(
            p.pivotTime === q.pivotTime &&
              (p.kind === 1) === (q.kind === "HIGH") &&
              p.confirmedAt === q.confirmedAt &&
              p.meaningful === q.meaningful &&
              p.price === q.price,
            `${tag}: pivot ${k}`,
          );
        });
        assert.equal(pn.zones.length, ts.zones.length, `${tag}: zone count`);
        pn.zones.forEach((z, k) => {
          const q = ts.zones[k];
          const st = ["ACTIVE", "BROKEN", "EXPIRED"][z.state];
          assert.ok(
            (z.side === 1) === (q.side === "SUPPORT") &&
              z.lo === q.lo &&
              z.hi === q.hi &&
              z.createdAt === q.createdAt &&
              st === q.state &&
              z.endedAt === q.endedAt &&
              z.nTouches === q.touches.length &&
              z.nSrc === q.sourcePivotIds.length,
            `${tag}: zone ${k} ${JSON.stringify(z)} vs ${JSON.stringify({ ...q, updates: undefined, touches: q.touches.length })}`,
          );
        });
        const tsEv = ts.events.filter((e) => e.from !== e.to);
        assert.equal(pn.events.length, tsEv.length, `${tag}: trend events`);
        pn.events.forEach((e, k) => {
          const q = tsEv[k];
          assert.ok(
            e.at === q.at &&
              e.from === q.from &&
              e.to === q.to &&
              e.protTime === (q.protected?.pivotTime ?? null),
            `${tag}: event ${k}`,
          );
        });
        assert.equal(pn.trend, ts.trend);
        assert.equal(pn.trendSince, ts.trendSince);
        assert.equal(
          pn.prot?.pivotTime ?? null,
          ts.protected?.pivotTime ?? null,
          `${tag}: protected`,
        );
        checks += 1 + pn.pivots.length + pn.zones.length + pn.events.length;
      }
    }
  }
}
console.log(
  `Pine-engine parity: ${cases} cases (40 series x ${variants.length} settings x 3 periods x 3 as-of), ${checks} objects compared, 0 differences`,
);
