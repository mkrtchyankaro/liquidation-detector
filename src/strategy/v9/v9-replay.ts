import { analyzeWindow, buildReference, episodeFeatures, selectEpisode, type LiqEvent, type OiObservation, type Victim } from "./v9-core";
import { DEFAULT_V9_ENGINE_SETTINGS, V9CausalEngine, type EpisodeCache, type V9Decision, type V9EngineSettings } from "./v9-causal-engine";
import { MAKER_FEE, TAKER_FEE } from "./v9-fees";

/**
 * Pure causal replay of one symbol (no I/O): feeds rows to the LIVE engine
 * in timestamp order, evaluating every minute at hh:mm:10 (the live
 * schedule), then simulates each tradable decision on the raw poll prices.
 */
export interface Poll { ts: number; price: number }
export interface SimulatedTrade { result: "TP" | "SL" | "OPEN" | "NO_RISK" | "NO_DATA"; r: number; netR?: number; slPct?: number; entry?: number; sl?: number; tp?: number; minutes?: number }
export interface ReplayResult {
  decisions: V9Decision[];
  trades: Array<{ decision: V9Decision; trade: SimulatedTrade }>;
  offlineSelected: Array<{ start: number; victim: Victim; confirmTs: number }>;
}

function lowerBound(arr: readonly Poll[], ts: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].ts < ts) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Fees in R for a trade with this entry and risk distance (Binance model:
 *  taker entry; maker TP, taker SL). Notional/risk = entry / risk distance. */
export function feesInR(entry: number, risk: number, exit: "TP" | "SL"): number {
  const perNotional = exit === "TP" ? TAKER_FEE + MAKER_FEE : 2 * TAKER_FEE;
  return (perNotional * entry) / risk;
}

export function simulateTrade(polls: readonly Poll[], d: Pick<V9Decision, "evaluatedAt" | "tradeSide" | "stopPrice">, rr: number, stopFor?: (entry: number) => number): SimulatedTrade {
  const i0 = lowerBound(polls, d.evaluatedAt);
  if (i0 >= polls.length) return { result: "NO_DATA", r: 0 };
  const long = d.tradeSide === "LONG";
  const entry = polls[i0].price;
  const sl = stopFor ? stopFor(entry) : d.stopPrice;
  const risk = long ? entry - sl : sl - entry;
  if (!(risk > 0)) return { result: "NO_RISK", r: 0, entry, sl };
  const tp = long ? entry + rr * risk : entry - rr * risk;
  const slPct = (risk / entry) * 100;
  for (let i = i0 + 1; i < polls.length; i++) {
    const p = polls[i].price;
    const minutes = Math.round((polls[i].ts - polls[i0].ts) / 60_000);
    if (long ? p <= sl : p >= sl) return { result: "SL", r: -1, netR: -1 - feesInR(entry, risk, "SL"), slPct, entry, sl, tp, minutes };
    if (long ? p >= tp : p <= tp) return { result: "TP", r: rr, netR: rr - feesInR(entry, risk, "TP"), slPct, entry, sl, tp, minutes };
  }
  return { result: "OPEN", r: 0, slPct, entry, sl, tp };
}

/** Mean per-minute high-low of the poll prices in the hour before `ts`. */
export function typicalMinuteRangeBefore(polls: readonly Poll[], ts: number): number {
  const from = ts - 60 * 60_000;
  const byMinute = new Map<number, { lo: number; hi: number }>();
  for (let i = lowerBound(polls, from); i < polls.length && polls[i].ts < ts; i++) {
    const m = Math.floor(polls[i].ts / 60_000);
    const r = byMinute.get(m);
    if (!r) byMinute.set(m, { lo: polls[i].price, hi: polls[i].price });
    else { r.lo = Math.min(r.lo, polls[i].price); r.hi = Math.max(r.hi, polls[i].price); }
  }
  const ranges = [...byMinute.values()].map((r) => r.hi - r.lo);
  return ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;
}

/** SL placements compared from the SAME entry of the SAME signal. */
export const SL_VARIANTS = ["CURRENT", "MIN_0.33%", "PLUS_1_MINUTE_RANGE", "X1.5", "X2"] as const;
export type SlVariant = typeof SL_VARIANTS[number];

export function stopForVariant(v: SlVariant, side: "LONG" | "SHORT", entry: number, currentStop: number, minuteRange: number): number {
  const dir = side === "LONG" ? -1 : 1; // the stop lies below a LONG, above a SHORT
  const risk = Math.abs(entry - currentStop);
  switch (v) {
    case "CURRENT": return currentStop;
    case "MIN_0.33%": return entry + dir * Math.max(risk, entry * 0.0033); // stop-out fees <= ~0.3R
    case "PLUS_1_MINUTE_RANGE": return currentStop + dir * minuteRange;
    case "X1.5": return entry + dir * risk * 1.5;
    case "X2": return entry + dir * risk * 2;
  }
}

export function replaySymbol(symbol: string, liq: readonly LiqEvent[], oi: readonly OiObservation[], from: number, until: number, rr: number, settings: V9EngineSettings = DEFAULT_V9_ENGINE_SETTINGS): ReplayResult {
  const liqSorted = [...liq].sort((a, b) => a.ts - b.ts);
  const oiSorted = [...oi].sort((a, b) => a.ts - b.ts);
  const polls: Poll[] = oiSorted.filter((x) => x.price > 0).map((x) => ({ ts: x.ts, price: x.price }));
  const engine = new V9CausalEngine(symbol, settings);
  const decisions: V9Decision[] = [];
  let li = 0, oj = 0;
  for (let t = Math.floor(from / 60_000) * 60_000 + 70_000; t <= until; t += 60_000) {
    while (li < liqSorted.length && liqSorted[li].ts <= t) { const e = liqSorted[li++]; engine.store.addLiquidation(e.ts, e.victim, e.usd); }
    while (oj < oiSorted.length && oiSorted[oj].ts <= t) { const o = oiSorted[oj++]; engine.store.addOiObservation(o.ts, o.updated, o.oi, o.price); }
    decisions.push(...engine.evaluate(t));
  }
  const trades = decisions.filter((d) => d.tradable).map((decision) => ({ decision, trade: simulateTrade(polls, decision, rr) }));

  const offlineSelected: ReplayResult["offlineSelected"] = [];
  const offline = analyzeWindow(liqSorted, oiSorted, from, until);
  if (offline) {
    const feats = offline.episodes.map((e) => ({ e, f: episodeFeatures(offline.buckets, e) }));
    const ref = buildReference(feats.filter((x) => x.f.dir).map((x) => x.f));
    for (const x of feats) if (selectEpisode(x.f, ref).selected) offlineSelected.push({ start: x.e.start, victim: x.e.victim, confirmTs: x.e.confirmTs });
  }
  return { decisions, trades, offlineSelected };
}

/** Several variants in ONE pass over the data (lock-step, minute by minute).
 *  Variants that shape episodes the same way share the expensive regime fit,
 *  so N decision-rule variants cost about as much as one. Results are
 *  identical to running replaySymbol() once per variant. */
export function replaySymbolMulti(symbol: string, liq: readonly LiqEvent[], oi: readonly OiObservation[], from: number, until: number,
  variants: ReadonlyArray<{ settings: V9EngineSettings; rr: number }>): Array<Pick<ReplayResult, "decisions" | "trades">> {
  const liqSorted = [...liq].sort((a, b) => a.ts - b.ts);
  const oiSorted = [...oi].sort((a, b) => a.ts - b.ts);
  const polls: Poll[] = oiSorted.filter((x) => x.price > 0).map((x) => ({ ts: x.ts, price: x.price }));
  const cache: EpisodeCache = new Map();
  const engines = variants.map((v) => new V9CausalEngine(symbol, v.settings, cache));
  const decisions: V9Decision[][] = variants.map(() => []);
  let li = 0, oj = 0;
  for (let t = Math.floor(from / 60_000) * 60_000 + 70_000; t <= until; t += 60_000) {
    const liqStart = li, oiStart = oj;
    while (li < liqSorted.length && liqSorted[li].ts <= t) li++;
    while (oj < oiSorted.length && oiSorted[oj].ts <= t) oj++;
    engines.forEach((engine, k) => {
      for (let x = liqStart; x < li; x++) { const e = liqSorted[x]; engine.store.addLiquidation(e.ts, e.victim, e.usd); }
      for (let x = oiStart; x < oj; x++) { const o = oiSorted[x]; engine.store.addOiObservation(o.ts, o.updated, o.oi, o.price); }
      decisions[k].push(...engine.evaluate(t));
    });
    cache.clear();
  }
  return variants.map((v, k) => ({
    decisions: decisions[k],
    trades: decisions[k].filter((d) => d.tradable).map((decision) => ({ decision, trade: simulateTrade(polls, decision, v.rr) })),
  }));
}
