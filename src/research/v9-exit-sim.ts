/**
 * EXIT RULES AFTER A V9 ENTRY (Johnny, Sep 28 2026). Pure simulation, no I/O.
 *
 * Idea: after our signal, if the market builds the SAME story against us -- it cleans the other side, new
 * positions open, and it turns (= V9 itself would now give the OPPOSITE signal) -- we get out instead of
 * waiting for the SL. Compared from the SAME entries:
 *   BASE        TP 2.2R / SL only (what we trade now)
 *   OPP_CLOSE   + close at market when the engine gives an OPPOSITE V9 signal (all 5 checks); the opposite
 *               signal itself is NOT taken
 *   OPP_FLIP    + close at market on an opposite V9 signal AND take that signal (reverse)
 *   OPP_PROFIT  + close on an opposite V9 signal only while the trade is in profit (else keep the SL)
 *   ANY_CLOSE   + close at market on ANY opposite confirmed episode (also those that failed V9's checks)
 *   BE_1R       no opposite exit; once the price went +1R our way the SL moves to the entry (break-even)
 * Fees: taker entry; TP maker; SL / market exit taker. One trade per coin at a time (like live).
 */
import type { Poll } from "../strategy/v9/v9-replay";
import { MAKER_FEE, TAKER_FEE } from "../strategy/v9/v9-fees";

export const EXIT_VARIANTS = [
  "BASE",
  "OPP_CLOSE",
  "OPP_FLIP",
  "OPP_PROFIT",
  "ANY_CLOSE",
  "BE_1R",
] as const;
export type ExitVariant = (typeof EXIT_VARIANTS)[number];

/** The minimum a signal needs: when it was decided, which way, where the stop is. */
export interface Sig {
  evaluatedAt: number;
  side: "LONG" | "SHORT";
  stop: number;
  id: string;
}
export interface ExitTrade {
  sig: Sig;
  result: "TP" | "SL" | "BE" | "EXIT" | "OPEN" | "NO_DATA" | "NO_RISK";
  entry: number;
  sl: number;
  tp: number;
  exit: number;
  entryTs: number;
  exitTs: number;
  netR: number;
  mfeR: number;
  maeR: number;
  exitBy?: string;
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

/**
 * One trade from `sig`. `triggers` = opposite-side signals that may close it (sorted by time), each checked
 * at its decision time; `onlyInProfit` keeps the trade when the price is not better than the entry then.
 */
export function simulateExit(
  polls: readonly Poll[],
  sig: Sig,
  rr: number,
  triggers: readonly Sig[],
  opts: { onlyInProfit?: boolean; breakEvenAtR?: number } = {},
): ExitTrade {
  const i0 = lowerBound(polls, sig.evaluatedAt);
  const empty = {
    entry: NaN,
    sl: sig.stop,
    tp: NaN,
    exit: NaN,
    entryTs: NaN,
    exitTs: NaN,
    netR: 0,
    mfeR: 0,
    maeR: 0,
  };
  if (i0 >= polls.length) return { sig, result: "NO_DATA", ...empty };
  const long = sig.side === "LONG",
    dir = long ? 1 : -1;
  const entry = polls[i0].price,
    entryTs = polls[i0].ts;
  const risk = (entry - sig.stop) * dir;
  if (!(risk > 0)) return { sig, result: "NO_RISK", ...empty, entry, entryTs };
  const tp = entry + dir * rr * risk;
  let sl = sig.stop,
    mfe = 0,
    mae = 0,
    movedToBe = false;
  const fee = (exitFee: number): number =>
    ((TAKER_FEE + exitFee) * entry) / risk;
  const trig = triggers
    .filter((t) => t.side !== sig.side && t.evaluatedAt > sig.evaluatedAt)
    .sort((a, b) => a.evaluatedAt - b.evaluatedAt);
  let k = 0;
  for (let i = i0 + 1; i < polls.length; i++) {
    const p = polls[i].price,
      ts = polls[i].ts;
    // an opposite signal decided before this poll: exit at this price (the first one after the decision)
    while (k < trig.length && trig[k].evaluatedAt <= ts) {
      const t = trig[k++];
      const r = ((p - entry) * dir) / risk;
      if (opts.onlyInProfit && !(r > 0)) continue;
      return {
        sig,
        result: "EXIT",
        entry,
        sl,
        tp,
        exit: p,
        entryTs,
        exitTs: ts,
        netR: r - fee(TAKER_FEE),
        mfeR: mfe,
        maeR: mae,
        exitBy: t.id,
      };
    }
    const r = ((p - entry) * dir) / risk;
    mfe = Math.max(mfe, r);
    mae = Math.min(mae, r);
    if ((p - sl) * dir <= 0) {
      if (movedToBe)
        return {
          sig,
          result: "BE",
          entry,
          sl,
          tp,
          exit: sl,
          entryTs,
          exitTs: ts,
          netR: -fee(TAKER_FEE),
          mfeR: mfe,
          maeR: mae,
        };
      return {
        sig,
        result: "SL",
        entry,
        sl,
        tp,
        exit: sl,
        entryTs,
        exitTs: ts,
        netR: -1 - fee(TAKER_FEE),
        mfeR: mfe,
        maeR: mae,
      };
    }
    if ((p - tp) * dir >= 0)
      return {
        sig,
        result: "TP",
        entry,
        sl,
        tp,
        exit: tp,
        entryTs,
        exitTs: ts,
        netR: rr - fee(MAKER_FEE),
        mfeR: mfe,
        maeR: mae,
      };
    if (
      opts.breakEvenAtR !== undefined &&
      !movedToBe &&
      r >= opts.breakEvenAtR
    ) {
      sl = entry;
      movedToBe = true;
    }
  }
  return {
    sig,
    result: "OPEN",
    entry,
    sl,
    tp,
    exit: NaN,
    entryTs,
    exitTs: Infinity,
    netR: 0,
    mfeR: mfe,
    maeR: mae,
  };
}

/**
 * A whole coin under one variant. `v9` = the V9 signals (entries), `anyOpp` = every confirmed episode
 * (for ANY_CLOSE). One trade at a time; OPP_FLIP may open the opposite signal right at the exit.
 */
export function runVariant(
  v: ExitVariant,
  polls: readonly Poll[],
  v9: readonly Sig[],
  anyOpp: readonly Sig[],
  rr: number,
): ExitTrade[] {
  const sigs = [...v9].sort((a, b) => a.evaluatedAt - b.evaluatedAt);
  const out: ExitTrade[] = [];
  let freeFrom = -Infinity,
    flipTo: string | null = null,
    closedBy: string | null = null;
  for (const s of sigs) {
    const flipped = flipTo === s.id;
    if (s.id === closedBy && !flipped) continue; // the opposite signal that closed us is not taken (only OPP_FLIP takes it)
    if (s.evaluatedAt < freeFrom && !flipped) continue; // busy: one trade per coin at a time
    flipTo = null;
    const t =
      v === "BASE"
        ? simulateExit(polls, s, rr, [])
        : v === "BE_1R"
          ? simulateExit(polls, s, rr, [], { breakEvenAtR: 1 })
          : v === "ANY_CLOSE"
            ? simulateExit(polls, s, rr, anyOpp)
            : simulateExit(polls, s, rr, v9, {
                onlyInProfit: v === "OPP_PROFIT",
              });
    out.push(t);
    if (t.result === "OPEN") {
      freeFrom = Infinity;
      continue;
    }
    if (t.result === "NO_DATA" || t.result === "NO_RISK") continue;
    freeFrom = t.exitTs;
    closedBy = t.result === "EXIT" ? (t.exitBy ?? null) : null;
    if (v === "OPP_FLIP" && closedBy) flipTo = closedBy;
  }
  return out;
}
