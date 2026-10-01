/**
 * WHAT IF on the real V9 signals (Johnny, Sep 30 2026): the same entries and stops the live bot really used,
 * only a different TP (in R), a minimum stop distance filter and a max-open limit. Pure, no DB.
 *   - result on 1-minute high/low from the minute after the entry; SL first when SL and TP are in one minute
 *   - time stop after `timeStopH` hours at that minute's close (null = none)
 *   - fees exactly like PAPER: taker entry + maker TP / taker SL (and taker on a time stop)
 *   - max open: signals in time order; a signal is skipped while `maxOpen` trades (with THIS TP's exits) are open
 *   - PROFIT LOCK (Johnny, Oct 1): once the price reaches +lockAtR, the SL moves to +lockToR (default = lockAtR);
 *     the TP stays at tpR. A close on that moved SL = PROFIT_STOP (taker fee, like a stop). Conservative order in
 *     one minute: SL, then TP, then the lock; in the lock minute itself only its CLOSE back at / beyond the moved SL
 *     counts as PROFIT_STOP (its low/high may be from before the lock -- 1-minute bars do not say the order).
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
  lockAtR?: number | null;
  lockToR?: number | null;
}
export interface TpResult {
  trade: TpTrade;
  slPct: number;
  status: "TP" | "SL" | "PROFIT_STOP" | "TIME" | "OPEN";
  locked: boolean;
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
  const lockAt = o.lockAtR ?? null,
    lockTo = o.lockToR ?? lockAt;
  if (
    lockAt !== null &&
    (!(lockAt > 0) || lockAt >= o.tpR || lockTo === null || lockTo > lockAt)
  )
    throw new Error("lock: 0 < lockTo <= lockAt < tp");
  const lockPrice =
    lockAt === null
      ? NaN
      : long
        ? t.entry + lockAt * risk
        : t.entry - lockAt * risk;
  const lockSl =
    lockTo === null
      ? NaN
      : long
        ? t.entry + lockTo * risk
        : t.entry - lockTo * risk;
  let sl = t.sl,
    locked = false;
  const out = (
    status: TpResult["status"],
    exitTs: number,
    r: number,
  ): TpResult => ({ trade: t, slPct, status, exitTs, r, locked });
  for (const b of bars) {
    if (b.t < start) continue;
    if (b.t + M > stopAt) {
      const pnl =
        (long ? b.close - t.entry : t.entry - b.close) * qty - fees.sl;
      return out("TIME", b.t, pnl / o.riskUsd);
    }
    if (long ? b.low <= sl : b.high >= sl) {
      if (!locked)
        return out("SL", b.t + M, (-o.riskUsd - fees.sl) / o.riskUsd);
      return out(
        "PROFIT_STOP",
        b.t + M,
        (lockTo! * o.riskUsd - fees.sl) / o.riskUsd,
      );
    }
    if (long ? b.high >= tp : b.low <= tp)
      return out("TP", b.t + M, (o.tpR * o.riskUsd - fees.tp) / o.riskUsd);
    if (
      !locked &&
      lockAt !== null &&
      (long ? b.high >= lockPrice : b.low <= lockPrice)
    ) {
      locked = true;
      sl = lockSl;
      if (long ? b.close <= sl : b.close >= sl)
        return out(
          "PROFIT_STOP",
          b.t + M,
          (lockTo! * o.riskUsd - fees.sl) / o.riskUsd,
        );
    }
  }
  return out("OPEN", Infinity, 0);
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
