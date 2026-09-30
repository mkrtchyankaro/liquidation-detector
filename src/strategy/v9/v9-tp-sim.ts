/**
 * WHAT IF on the real V9 signals (Johnny, Sep 30 2026): the same entries and stops the live bot really used,
 * only a different TP (in R), a minimum stop distance filter and a max-open limit. Pure, no DB.
 *   - result on 1-minute high/low from the minute after the entry; SL first when SL and TP are in one minute
 *   - time stop after `timeStopH` hours at that minute's close (null = none)
 *   - fees exactly like PAPER: taker entry + maker TP / taker SL (and taker on a time stop)
 *   - max open: signals in time order; a signal is skipped while `maxOpen` trades (with THIS TP's exits) are open
 */
import { estimateFeesUsd } from "../strategy/v9/v9-fees";

const M = 60_000,
  H = 3_600_000;
export interface TpTrade {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  createdAt: number;
  entry: number;
  sl: number;
}
export interface TpBar {
  t: number;
  high: number;
  low: number;
  close: number;
}
export interface TpOpts {
  tpR: number;
  minSlPct: number;
  maxOpen: number | null;
  timeStopH: number | null;
  riskUsd: number;
}
export interface TpResult {
  trade: TpTrade;
  slPct: number;
  status: "TP" | "SL" | "TIME" | "OPEN";
  exitTs: number;
  r: number;
}

export function simTrade(
  t: TpTrade,
  bars: readonly TpBar[],
  o: TpOpts,
): TpResult {
  const long = t.side === "LONG",
    risk = Math.abs(t.entry - t.sl),
    slPct = (100 * risk) / t.entry;
  const tp = long ? t.entry + o.tpR * risk : t.entry - o.tpR * risk;
  const qty = o.riskUsd / risk,
    fees = estimateFeesUsd(t.entry * qty);
  const start = Math.floor(t.createdAt / M) * M + M,
    stopAt = o.timeStopH ? t.createdAt + o.timeStopH * H : Infinity;
  for (const b of bars) {
    if (b.t < start) continue;
    if (b.t + M > stopAt) {
      const pnl =
        (long ? b.close - t.entry : t.entry - b.close) * qty - fees.sl;
      return {
        trade: t,
        slPct,
        status: "TIME",
        exitTs: b.t,
        r: pnl / o.riskUsd,
      };
    }
    if (long ? b.low <= t.sl : b.high >= t.sl)
      return {
        trade: t,
        slPct,
        status: "SL",
        exitTs: b.t + M,
        r: (-o.riskUsd - fees.sl) / o.riskUsd,
      };
    if (long ? b.high >= tp : b.low <= tp)
      return {
        trade: t,
        slPct,
        status: "TP",
        exitTs: b.t + M,
        r: (o.tpR * o.riskUsd - fees.tp) / o.riskUsd,
      };
  }
  return { trade: t, slPct, status: "OPEN", exitTs: Infinity, r: 0 };
}

/** all signals in time order -> the ones taken (filter + max open) with their results, and the skipped ones */
export function simPortfolio(
  trades: readonly TpTrade[],
  barsOf: (symbol: string) => readonly TpBar[],
  o: TpOpts,
): {
  taken: TpResult[];
  skipped: Array<{ trade: TpTrade; why: "MIN_SL" | "MAX_OPEN" }>;
} {
  const taken: TpResult[] = [],
    skipped: Array<{ trade: TpTrade; why: "MIN_SL" | "MAX_OPEN" }> = [];
  for (const t of [...trades].sort((a, b) => a.createdAt - b.createdAt)) {
    if ((100 * Math.abs(t.entry - t.sl)) / t.entry <= o.minSlPct) {
      skipped.push({ trade: t, why: "MIN_SL" });
      continue;
    }
    if (
      o.maxOpen !== null &&
      taken.filter((x) => x.exitTs > t.createdAt).length >= o.maxOpen
    ) {
      skipped.push({ trade: t, why: "MAX_OPEN" });
      continue;
    }
    taken.push(simTrade(t, barsOf(t.symbol), o));
  }
  return { taken, skipped };
}
