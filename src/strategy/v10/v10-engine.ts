/**
 * V10 ENGINE (Johnny, Oct 2 2026) -- pure, live-safe. The SAME functions as the research (src/research/dc15.ts,
 * src/tools/dc15-trades.ts "A1"), so live signals are exactly the backtested ones.
 *
 *   1. BTC 15m candles from minute bars, decided at the candle CLOSE
 *   2. a turn: the close is 1 x ATR(14) back from the move's extreme (directional change)
 *   3. the OI rule: in that reversal candle OI goes the opposite way to how the move was built
 *   4. RANK 1: the move's |OI change| is bigger than every accepted BTC move of the `rankWindowHours` before it
 *   5. the picks: over BTC's move (its start -> the extreme candle's close), every alt's move to its extreme in BTC's
 *      direction, x = alt % / BTC %, follow = R2 of 1-minute moves on BTC's. The upper half by follow, ranked by x.
 * A BTC top (the new direction DOWN) -> SHORT the picks; a BTC bottom (UP) -> LONG the picks.
 *
 * PART 2 "ALT" (the alt's own move, research "B"): steps 1-4 on the ALT's own bars; then, over the alt's move window,
 * the alt must have moved ON ITS OWN (src/research/dc15.ts ownness: BTC went the other way, or BTC explains less than
 * half of its minute moves). Its top -> SHORT it, its bottom -> LONG it.
 * Only bars that closed before the candle end are used (`bars` is cut here, whatever the caller passes).
 */
import { candles, coinInWindow, ownness, pastRank, priceAt, turns, type MinBar, type Own, type Turn } from "../../research/dc15";

export const V10_TF_MIN = 15;
export const V10_K = 1;
export const V10_ATR_N = 14;
/** BTC history used for the turns -- long enough for the DC to settle into the same turns as the research */
export const V10_HISTORY_MS = 10 * 24 * 3_600_000;
const M = 60_000, W = V10_TF_MIN * M;

export type V10Side = "SHORT" | "LONG";

/** a RANK 1 turn of one symbol (BTC for part 1, the alt itself for part 2) */
export interface V10Turn {
  candleEnd: number; side: V10Side; price: number;
  moveStartT: number; extremeT: number; extreme: number; movePct: number;
  moveOiPct: number; candleOiPct: number; label: string;
  /** how many accepted BTC moves it was compared with (RANK 1 = bigger than all of them) */
  prior: number;
}

export interface V10Pick { symbol: string; rank: number; x: number; follow: number; coinPct: number; btcPct: number; price: number }

export type V10BtcTurn = V10Turn;

/** The turn of `bars` (any symbol) decided at `candleEnd` if it is a RANK 1 accepted turn, else null. */
export function rank1At(bars: readonly MinBar[], candleEnd: number, rankWindowHours: number): V10Turn | null {
  const cut = bars.filter((b) => b.t < candleEnd);
  const all = turns(candles(cut, V10_TF_MIN), V10_K, V10_ATR_N, true);
  const r = pastRank(all, rankWindowHours).find((x) => x.turn.t === candleEnd);
  if (!r || r.rank !== 1 || r.prior === 0) return null;
  return toBtcTurn(r.turn, r.prior);
}

/** BTC's RANK 1 turn at `candleEnd` (part 1) */
export const btcRank1At = rank1At;

function toBtcTurn(t: Turn, prior: number): V10Turn {
  return {
    candleEnd: t.t, side: t.newDir === "DOWN" ? "SHORT" : "LONG", price: t.price,
    moveStartT: t.moveStartT, extremeT: t.extremeT, extreme: t.extreme, movePct: t.movePct,
    moveOiPct: t.moveOiPct, candleOiPct: t.candleOiPct, label: t.label, prior,
  };
}

/** The alts that moved most with BTC over its move (see the header). `closes` = each alt's minute closes. */
export function pickAlts(turn: V10Turn, btcCloses: ReadonlyMap<number, number>, closes: ReadonlyMap<string, ReadonlyMap<number, number>>, picks: number): V10Pick[] {
  const up = turn.side === "SHORT"; // a SHORT ends an UP move
  const fromT = turn.moveStartT, toT = turn.extremeT + W;
  const rows: Array<Omit<V10Pick, "rank">> = [];
  for (const [symbol, m] of closes) {
    const w = coinInWindow(m, btcCloses, fromT, toT, up);
    const price = priceAt(m, turn.candleEnd);
    if (Number.isFinite(w.x) && Number.isFinite(w.follow) && price > 0) rows.push({ symbol, x: w.x, follow: w.follow, coinPct: w.pct, btcPct: w.btcPct, price });
  }
  if (!rows.length) return [];
  const med = [...rows].map((r) => r.follow).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  return rows.filter((r) => r.follow >= med).sort((a, b) => b.x - a.x).slice(0, picks).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** PART 2: did the alt make this move ON ITS OWN? Over its move window (start -> the extreme candle's close), close to
 *  close, exactly like the research. null = it moved with BTC (not a part-2 signal). */
export interface V10OwnMove { how: Exclude<Own, "WITH BTC">; follow: number; coinPct: number; btcPct: number }
export function ownMove(turn: V10Turn, altCloses: ReadonlyMap<number, number>, btcCloses: ReadonlyMap<number, number>): V10OwnMove | null {
  const w = coinInWindow(altCloses, btcCloses, turn.moveStartT, turn.extremeT + W);
  if (!Number.isFinite(w.follow) || !Number.isFinite(w.pct)) return null;
  const how = ownness(w.follow, w.pct, w.btcPct);
  return how === "WITH BTC" ? null : { how, follow: w.follow, coinPct: w.pct, btcPct: w.btcPct };
}

/** SL / TP prices for a side, from the entry and this user's percents */
export function levels(side: V10Side, entry: number, slPct: number, tpPct: number): { sl: number; tp: number } {
  return side === "SHORT"
    ? { sl: entry * (1 + slPct / 100), tp: entry * (1 - tpPct / 100) }
    : { sl: entry * (1 - slPct / 100), tp: entry * (1 + tpPct / 100) };
}

/** the 15m candle end a moment `now` belongs after (the last closed candle) */
export const lastCandleEnd = (now: number): number => Math.floor(now / W) * W;
export const V10_CANDLE_MS = W;
