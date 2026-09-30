/**
 * THE STORY OF AN OI ACCUMULATION (Johnny, Sep 30 2026) -- research only, our own data (minute_bars: 1-minute OI
 * + REAL liquidations), UTC. Built on the moves of oi-moves.ts (price + OI growing together, no % thresholds).
 *
 *   1. ACCUMULATION: start -> the hour where the OI stops growing. Who opened / who was closed inside it
 *      (1-minute OI split by the price direction of that minute) + the REAL long / short liquidations.
 *   2. THE OI DROP right after it: the hours in a row whose OI closes lower than the hour before. Who was cleaned
 *      there: the real liquidations (long vs short) and the OI split, and which way the price went.
 *   3. AFTER THE DROP: where the price went from the drop's last close (+1h, +4h, +12h, +24h, best up / down in 24h).
 */
import { hoursFromMinutes, type MinuteRow } from "./oi-accumulation";
import { accumulation, findMoves, flowBetween, type Move, type MvBar, type MvFlow, type MvHour } from "./oi-moves";

const H = 3_600_000;
const pct = (a: number, b: number): number => (100 * (b - a)) / a;

export interface Liq { longUsd: number; shortUsd: number; longCoin: number; shortCoin: number }
export interface StPart { from: number; to: number; hours: number; priceFrom: number; priceTo: number; pricePct: number; high: number; low: number; oiFrom: number; oiTo: number; flow: MvFlow; liq: Liq }
export interface StAfter { h1: number | null; h4: number | null; h12: number | null; h24: number | null; up24: number; down24: number; hoursSeen: number }
export interface Story {
  symbol: string; dir: "UP" | "DOWN"; ongoing: boolean;
  acc: StPart;
  drop: (StPart & { cleaned: "LONGS" | "SHORTS" | "NONE"; cleanedPct: number }) | null; // null = the OI has not started to fall yet
  after: StAfter | null;
}

export function liqBetween(rows: readonly MinuteRow[], from: number, to: number): Liq {
  const l: Liq = { longUsd: 0, shortUsd: 0, longCoin: 0, shortCoin: 0 };
  for (const r of rows) {
    if (r.ts < from || r.ts >= to || !(r.close! > 0)) continue;
    l.longUsd += r.longLiqUsd || 0; l.shortUsd += r.shortLiqUsd || 0;
    l.longCoin += (r.longLiqUsd || 0) / r.close!; l.shortCoin += (r.shortLiqUsd || 0) / r.close!;
  }
  return l;
}

export function mvHours(rows: readonly MinuteRow[], until: number): MvHour[] {
  return hoursFromMinutes(rows, until).map((k) => ({ t: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, oi: k.complete ? k.oiClose : NaN, oiOpen: k.complete ? k.oiOpen : NaN }));
}

export function mvBars(rows: readonly MinuteRow[]): MvBar[] {
  return rows.filter((r) => r.close! > 0).map((r) => ({ t: r.ts, open: r.open ?? r.close!, close: r.close!, oi: r.oiLast ?? NaN }));
}

function part(h: readonly MvHour[], a: number, b: number, bars: readonly MvBar[], rows: readonly MinuteRow[], priceFrom = h[a].open): StPart {
  const seg = h.slice(a, b + 1), from = h[a].t, to = h[b].t + H;
  return {
    from, to, hours: b - a + 1, priceFrom, priceTo: h[b].close, pricePct: pct(priceFrom, h[b].close),
    high: Math.max(...seg.map((c) => c.high)), low: Math.min(...seg.map((c) => c.low)),
    oiFrom: h[a].oiOpen, oiTo: h[b].oi, flow: flowBetween(bars, from, to), liq: liqBetween(rows, from, to),
  };
}

function afterFrom(rows: readonly MinuteRow[], t0: number, p0: number): StAfter {
  const at = (x: number): number | null => { const r = rows.filter((q) => q.ts < t0 + x * H && q.close! > 0).at(-1); return r && r.ts >= t0 + x * H - 5 * 60_000 ? pct(p0, r.close!) : null; };
  const w = rows.filter((r) => r.ts >= t0 && r.ts < t0 + 24 * H && r.close! > 0);
  return {
    h1: at(1), h4: at(4), h12: at(12), h24: at(24),
    up24: w.length ? pct(p0, Math.max(...w.map((r) => r.high ?? r.close!))) : 0,
    down24: w.length ? pct(p0, Math.min(...w.map((r) => r.low ?? r.close!))) : 0,
    hoursSeen: w.length ? Math.ceil((w[w.length - 1].ts + 60_000 - t0) / H) : 0,
  };
}

export function stories(symbol: string, rows: readonly MinuteRow[], until: number): Story[] {
  const h = mvHours(rows, until), bars = mvBars(rows.filter((r) => r.ts < until));
  const out: Story[] = [];
  for (const m of findMoves(h)) {
    const a = accumulation(h, m);
    if (!a.ok) continue;
    const p = m.phases[0], pk = m.s + p.hours - 1;
    const acc = part(h, m.s, pk, bars, rows, (m as Move).startPrice);
    let e = pk;
    while (e + 1 < h.length && h[e + 1].oi > 0 && h[e + 1].oi < h[e].oi) e++;
    if (e === pk) { out.push({ symbol, dir: m.dir, ongoing: a.ongoing, acc, drop: null, after: null }); continue; }
    const d = part(h, pk + 1, e, bars, rows);
    const cleaned = d.liq.longUsd > d.liq.shortUsd ? "LONGS" : d.liq.shortUsd > d.liq.longUsd ? "SHORTS" : "NONE";
    const built = acc.oiTo - acc.oiFrom;
    const drop = { ...d, cleaned, cleanedPct: built > 0 ? (100 * (d.oiFrom - d.oiTo)) / built : NaN } as Story["drop"];
    const dropStillGoing = e === h.length - 1;
    out.push({ symbol, dir: m.dir, ongoing: dropStillGoing, acc, drop, after: dropStillGoing ? null : afterFrom(rows.filter((r) => r.ts < until), d.to, d.priceTo) });
  }
  return out;
}
