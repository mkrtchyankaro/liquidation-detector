/**
 * THE STORY OF AN OI ACCUMULATION (Johnny, Sep 30 2026) -- research only, our own data (minute_bars: 1-minute OI
 * + REAL liquidations), UTC. Built on the moves of oi-moves.ts (price + OI growing together, no % thresholds).
 *
 *   1. ACCUMULATION: start -> the hour where the OI stops growing (followed past the price move if the OI keeps growing).
 *      Every OI drop inside a RISE is shorts closing, inside a FALL longs closing (Johnny) -- not the minute's colour.
 *      The OI drop phase: the same by its own price direction (price fell in it -> longs, rose -> shorts). Who opened / who was closed inside it
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

function part(h: readonly MvHour[], a: number, b: number, bars: readonly MvBar[], rows: readonly MinuteRow[], priceFrom = h[a].open, dir?: "UP" | "DOWN"): StPart {
  const seg = h.slice(a, b + 1), from = h[a].t, to = h[b].t + H;
  const moveDir = dir ?? (h[b].close >= priceFrom ? "UP" : "DOWN"); // who the OI drops hurt: the move's direction
  return {
    from, to, hours: b - a + 1, priceFrom, priceTo: h[b].close, pricePct: pct(priceFrom, h[b].close),
    high: Math.max(...seg.map((c) => c.high)), low: Math.min(...seg.map((c) => c.low)),
    oiFrom: h[a].oiOpen, oiTo: h[b].oi, flow: flowBetween(bars, from, to, moveDir), liq: liqBetween(rows, from, to),
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
    const p = m.phases[0];
    let pk = m.s + p.hours - 1;
    // the accumulation ends where the OI starts to fall -- even if the price move itself ended earlier
    while (pk + 1 < h.length && h[pk + 1].oi > 0 && h[pk + 1].oi >= h[pk].oi) pk++;
    const acc = part(h, m.s, pk, bars, rows, (m as Move).startPrice, m.dir);
    let e = pk;
    while (e + 1 < h.length && h[e + 1].oi > 0 && h[e + 1].oi < h[e].oi) e++;
    if (e === pk) { out.push({ symbol, dir: m.dir, ongoing: pk === h.length - 1, acc, drop: null, after: null }); continue; }
    const d = part(h, pk + 1, e, bars, rows);
    const cleaned = d.liq.longUsd > d.liq.shortUsd ? "LONGS" : d.liq.shortUsd > d.liq.longUsd ? "SHORTS" : "NONE";
    const built = acc.oiTo - acc.oiFrom;
    const drop = { ...d, cleaned, cleanedPct: built > 0 ? (100 * (d.oiFrom - d.oiTo)) / built : NaN } as Story["drop"];
    const dropStillGoing = e === h.length - 1;
    out.push({ symbol, dir: m.dir, ongoing: dropStillGoing, acc, drop, after: dropStillGoing ? null : afterFrom(rows.filter((r) => r.ts < until), d.to, d.priceTo) });
  }
  return out;
}

/** small candles (15m / 5m) between from and to: price, OI change, real liquidations and the OI split */
export interface SmallCandle { t: number; open: number; high: number; low: number; close: number; oiFrom: number; oiTo: number; liq: Liq; flow: MvFlow }
export function smallCandles(rows: readonly MinuteRow[], from: number, to: number, step: number): SmallCandle[] {
  const bars = mvBars(rows), out: SmallCandle[] = [];
  for (let t0 = from; t0 < to; t0 += step) {
    const m = rows.filter((r) => r.ts >= t0 && r.ts < t0 + step && r.close! > 0);
    if (!m.length) continue;
    const withOi = m.filter((r) => r.oiLast! > 0);
    out.push({
      t: t0, open: m[0].open ?? m[0].close!, high: Math.max(...m.map((r) => r.high ?? r.close!)), low: Math.min(...m.map((r) => r.low ?? r.close!)), close: m[m.length - 1].close!,
      oiFrom: withOi.length ? (withOi[0].oiFirst! > 0 ? withOi[0].oiFirst! : withOi[0].oiLast!) : NaN, oiTo: withOi.length ? withOi[withOi.length - 1].oiLast! : NaN,
      liq: liqBetween(m, t0, t0 + step), flow: flowBetween(bars, t0, t0 + step),
    });
  }
  return out;
}

/**
 * WHO IS LEFT after the accumulation and the OI drop (coins, estimate from the 1-minute OI split):
 *   longs left  = longs opened in the accumulation - longs closed in it - longs closed in the drop
 *   shorts left = the same for shorts
 * The side with MORE left is the fuel: its stops are what the market goes for next ->
 *   more shorts left -> the price goes UP for their stops -> LONG;  more longs left -> DOWN -> SHORT.
 */
export interface Balance { longsLeft: number; shortsLeft: number; verdict: "LONG" | "SHORT" }
export function balance(s: Story): Balance | null {
  if (!s.drop) return null;
  const a = s.acc.flow, d = s.drop.flow;
  const longsLeft = a.newLong - a.longOut - d.longOut, shortsLeft = a.newShort - a.shortOut - d.shortOut;
  return { longsLeft, shortsLeft, verdict: shortsLeft > longsLeft ? "LONG" : "SHORT" };
}

/**
 * Trading the verdict AT THAT MOMENT: entry = the drop's last close; SL just beyond the drop's extreme
 * (LONG: below its low, SHORT: above its high); target 2R; else closed after 24h. SL first when both in one minute.
 */
export interface MomentTrade { side: "LONG" | "SHORT"; entryTs: number; entry: number; sl: number; riskPct: number; result: "2R" | "SL" | "24h" | "OPEN"; r: number; hit1R: boolean; minutes: number }
export function tradeAtMoment(rows: readonly MinuteRow[], s: Story, side: "LONG" | "SHORT", feePct = 0.1): MomentTrade | null {
  if (!s.drop) return null;
  const d = s.drop, entry = d.priceTo, long = side === "LONG";
  const sl = long ? d.low : d.high, risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const tp = long ? entry + 2 * risk : entry - 2 * risk, oneR = long ? entry + risk : entry - risk;
  const riskPct = (100 * risk) / entry, fee = feePct / riskPct;
  const path = rows.filter((r) => r.ts >= d.to && r.ts < d.to + 24 * H && r.close! > 0);
  let hit1R = false;
  for (const r of path) {
    const hi = r.high ?? r.close!, lo = r.low ?? r.close!;
    if (long ? lo <= sl : hi >= sl) return { side, entryTs: d.to, entry, sl, riskPct, result: "SL", r: -1 - fee, hit1R, minutes: Math.round((r.ts + 60_000 - d.to) / 60_000) };
    if (long ? hi >= oneR : lo <= oneR) hit1R = true;
    if (long ? hi >= tp : lo <= tp) return { side, entryTs: d.to, entry, sl, riskPct, result: "2R", r: 2 - fee, hit1R, minutes: Math.round((r.ts + 60_000 - d.to) / 60_000) };
  }
  const last = path.at(-1);
  if (!last || last.ts + 60_000 < d.to + 24 * H) return { side, entryTs: d.to, entry, sl, riskPct, result: "OPEN", r: 0, hit1R, minutes: last ? Math.round((last.ts + 60_000 - d.to) / 60_000) : 0 };
  const r = (long ? last.close! - entry : entry - last.close!) / risk - fee;
  return { side, entryTs: d.to, entry, sl, riskPct, result: "24h", r, hit1R, minutes: 24 * 60 };
}
