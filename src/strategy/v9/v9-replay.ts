import {
  analyzeWindow,
  buildReference,
  episodeFeatures,
  selectEpisode,
  type LiqEvent,
  type OiObservation,
  type Victim,
} from "./v9-core";
import {
  DEFAULT_V9_ENGINE_SETTINGS,
  V9CausalEngine,
  type V9Decision,
  type V9EngineSettings,
} from "./v9-causal-engine";

/**
 * Pure causal replay of one symbol (no I/O): feeds rows to the LIVE engine
 * in timestamp order, evaluating every minute at hh:mm:10 (the live
 * schedule), then simulates each tradable decision on the raw poll prices.
 */
export interface Poll {
  ts: number;
  price: number;
}
export interface SimulatedTrade {
  result: "TP" | "SL" | "OPEN" | "NO_RISK" | "NO_DATA";
  r: number;
  entry?: number;
  sl?: number;
  tp?: number;
  minutes?: number;
}
export interface ReplayResult {
  decisions: V9Decision[];
  trades: Array<{ decision: V9Decision; trade: SimulatedTrade }>;
  offlineSelected: Array<{ start: number; victim: Victim; confirmTs: number }>;
}

function lowerBound(arr: readonly Poll[], ts: number): number {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function simulateTrade(
  polls: readonly Poll[],
  d: Pick<V9Decision, "evaluatedAt" | "tradeSide" | "stopPrice">,
  rr: number,
): SimulatedTrade {
  const i0 = lowerBound(polls, d.evaluatedAt);
  if (i0 >= polls.length) return { result: "NO_DATA", r: 0 };
  const long = d.tradeSide === "LONG";
  const entry = polls[i0].price;
  const sl = d.stopPrice;
  const risk = long ? entry - sl : sl - entry;
  if (!(risk > 0)) return { result: "NO_RISK", r: 0, entry, sl };
  const tp = long ? entry + rr * risk : entry - rr * risk;
  for (let i = i0 + 1; i < polls.length; i++) {
    const p = polls[i].price;
    const minutes = Math.round((polls[i].ts - polls[i0].ts) / 60_000);
    if (long ? p <= sl : p >= sl)
      return { result: "SL", r: -1, entry, sl, tp, minutes };
    if (long ? p >= tp : p <= tp)
      return { result: "TP", r: rr, entry, sl, tp, minutes };
  }
  return { result: "OPEN", r: 0, entry, sl, tp };
}

export function replaySymbol(
  symbol: string,
  liq: readonly LiqEvent[],
  oi: readonly OiObservation[],
  from: number,
  until: number,
  rr: number,
  settings: V9EngineSettings = DEFAULT_V9_ENGINE_SETTINGS,
): ReplayResult {
  const liqSorted = [...liq].sort((a, b) => a.ts - b.ts);
  const oiSorted = [...oi].sort((a, b) => a.ts - b.ts);
  const polls: Poll[] = oiSorted
    .filter((x) => x.price > 0)
    .map((x) => ({ ts: x.ts, price: x.price }));
  const engine = new V9CausalEngine(symbol, settings);
  const decisions: V9Decision[] = [];
  let li = 0,
    oj = 0;
  for (
    let t = Math.floor(from / 60_000) * 60_000 + 70_000;
    t <= until;
    t += 60_000
  ) {
    while (li < liqSorted.length && liqSorted[li].ts <= t) {
      const e = liqSorted[li++];
      engine.store.addLiquidation(e.ts, e.victim, e.usd);
    }
    while (oj < oiSorted.length && oiSorted[oj].ts <= t) {
      const o = oiSorted[oj++];
      engine.store.addOiObservation(o.ts, o.updated, o.oi, o.price);
    }
    decisions.push(...engine.evaluate(t));
  }
  const trades = decisions
    .filter((d) => d.tradable)
    .map((decision) => ({
      decision,
      trade: simulateTrade(polls, decision, rr),
    }));

  const offlineSelected: ReplayResult["offlineSelected"] = [];
  const offline = analyzeWindow(liqSorted, oiSorted, from, until);
  if (offline) {
    const feats = offline.episodes.map((e) => ({
      e,
      f: episodeFeatures(offline.buckets, e),
    }));
    const ref = buildReference(feats.filter((x) => x.f.dir).map((x) => x.f));
    for (const x of feats)
      if (selectEpisode(x.f, ref).selected)
        offlineSelected.push({
          start: x.e.start,
          victim: x.e.victim,
          confirmTs: x.e.confirmTs,
        });
  }
  return { decisions, trades, offlineSelected };
}
