/**
 * "OWN MOVE" DURING THE TRADE (Johnny, Oct 1 2026) -- research only, live-safe.
 * A coin's move = its usual amplification of BTC (beta) x BTC's move + its OWN move. When the profit of a trade
 * comes only from BTC, BTC can take it back; when the coin moves on its own, that is our signal working.
 *   beta     from the 1-minute returns of the coin and BTC in the `betaHours` BEFORE the entry (past only)
 *   own(k)   k minutes after the entry: coin move - beta x BTC move (both in the trade's direction, %)
 *   RULE     at minute k, if the trade is still open and own(k) <= 0 -> close at that minute's close (taker fee);
 *            otherwise the trade runs as before. Compared with the same trades without the rule.
 * No thresholds besides the natural zero; k and betaHours are the tool's parameters.
 */
import {
  simTrade,
  type TpBar,
  type TpOpts,
  type TpResult,
  type TpTrade,
} from "./v9-tp-sim";
import { estimateFeesUsd } from "../strategy/v9/v9-fees";

const M = 60_000,
  H = 3_600_000;
export interface OwnBar extends TpBar {
  t: number;
  close: number;
}

/** slope of coin 1-minute returns on BTC 1-minute returns over [from, to) */
export function betaOf(
  coin: readonly OwnBar[],
  btc: readonly OwnBar[],
  from: number,
  to: number,
): number | null {
  const b = new Map(
    btc
      .filter((x) => x.t >= from && x.t < to && x.close > 0)
      .map((x) => [x.t, x.close]),
  );
  const p = coin
    .filter((x) => x.t >= from && x.t < to && x.close > 0 && b.has(x.t))
    .map((x) => [x.close, b.get(x.t)!] as const);
  if (p.length < 30) return null;
  const rc: number[] = [],
    rb: number[] = [];
  for (let i = 1; i < p.length; i++) {
    rc.push(p[i][0] / p[i - 1][0] - 1);
    rb.push(p[i][1] / p[i - 1][1] - 1);
  }
  const mc = rc.reduce((s, x) => s + x, 0) / rc.length,
    mb = rb.reduce((s, x) => s + x, 0) / rb.length;
  let cov = 0,
    vb = 0;
  for (let i = 0; i < rc.length; i++) {
    cov += (rc[i] - mc) * (rb[i] - mb);
    vb += (rb[i] - mb) ** 2;
  }
  return vb > 0 ? cov / vb : null;
}

export interface OwnCheck {
  trade: TpTrade;
  base: TpResult;
  beta: number;
  openAtK: boolean;
  coinPct: number;
  btcPct: number;
  own: number;
  ruled: { r: number; exitTs: number; closedByRule: boolean };
}

/** baseline result + the rule at minute k (null when there is no beta / no price at k) */
export function ownCheck(
  t: TpTrade,
  coin: readonly OwnBar[],
  btc: readonly OwnBar[],
  k: number,
  betaHours: number,
  o: TpOpts,
): OwnCheck | null {
  const beta = betaOf(coin, btc, t.createdAt - betaHours * H, t.createdAt);
  if (beta === null) return null;
  const base = simTrade(t, coin, o);
  const entryMin = Math.floor(t.createdAt / M) * M,
    kTs = entryMin + k * M;
  const c0 = coin.find((x) => x.t === entryMin)?.close ?? t.entry,
    ck = coin.find((x) => x.t === kTs)?.close;
  const b0 = btc.find((x) => x.t === entryMin)?.close,
    bk = btc.find((x) => x.t === kTs)?.close;
  if (!ck || !b0 || !bk) return null;
  const sgn = t.side === "LONG" ? 1 : -1;
  const coinPct = (sgn * 100 * (ck - c0)) / c0,
    btcPct = (sgn * 100 * (bk - b0)) / b0,
    own = coinPct - beta * btcPct;
  const openAtK = base.exitTs > kTs + M; // still open after minute k closed
  if (!openAtK || own > 0)
    return {
      trade: t,
      base,
      beta,
      openAtK,
      coinPct,
      btcPct,
      own,
      ruled: { r: base.r, exitTs: base.exitTs, closedByRule: false },
    };
  const risk = Math.abs(t.entry - t.sl),
    qty = o.riskUsd / risk,
    fee = estimateFeesUsd(t.entry * qty).sl;
  const r = (sgn * (ck - t.entry) * qty - fee) / o.riskUsd;
  return {
    trade: t,
    base,
    beta,
    openAtK,
    coinPct,
    btcPct,
    own,
    ruled: { r, exitTs: kTs + M, closedByRule: true },
  };
}

/**
 * BEFORE THE ENTRY (Johnny, Oct 1): did BTC bring the coin to this level? Over the signal's own episode
 * (episode start -> entry), with beta from the `betaHours` before the episode start (past only):
 *   coinPct / btcPct   the moves over the episode, in the TRADE's direction (a V9 reversal usually starts negative)
 *   btcPart            beta x btcPct = the part of the coin's move BTC explains;  own = coinPct - btcPart
 *   byBtc              |btcPart| >= |own| -> BTC brought the coin here more than the coin itself (no other threshold)
 * Everything is known at the entry minute.
 */
export interface PreMove {
  beta: number;
  minutes: number;
  coinPct: number;
  btcPct: number;
  btcPart: number;
  own: number;
  byBtc: boolean;
}
export function preMove(
  t: TpTrade,
  coin: readonly OwnBar[],
  btc: readonly OwnBar[],
  episodeStart: number,
  betaHours: number,
): PreMove | null {
  const from = Math.floor(episodeStart / M) * M,
    to = Math.floor(t.createdAt / M) * M;
  if (!(to > from)) return null;
  const beta = betaOf(coin, btc, from - betaHours * H, from);
  if (beta === null) return null;
  const c0 = coin.find((x) => x.t === from)?.close,
    c1 = coin.find((x) => x.t === to)?.close;
  const b0 = btc.find((x) => x.t === from)?.close,
    b1 = btc.find((x) => x.t === to)?.close;
  if (!c0 || !c1 || !b0 || !b1) return null;
  const sgn = t.side === "LONG" ? 1 : -1;
  const coinPct = (sgn * 100 * (c1 - c0)) / c0,
    btcPct = (sgn * 100 * (b1 - b0)) / b0,
    btcPart = beta * btcPct,
    own = coinPct - btcPart;
  return {
    beta,
    minutes: (to - from) / M,
    coinPct,
    btcPct,
    btcPart,
    own,
    byBtc: Math.abs(btcPart) >= Math.abs(own),
  };
}
