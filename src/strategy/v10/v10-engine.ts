/**
 * V10 ENGINE (Johnny, Oct 2-3 2026) -- pure, live-safe. The SAME functions as the backtest
 * (src/research/atr-turn.ts / oi-peak.ts, src/tools/v10-entry-compare.ts), so live signals are exactly the backtested ones.
 * The entry is chosen in users.config.json "v10.entry" (V10Entry below; default "atr"). The "oiPeak" entry:
 *
 * JOHNNY'S RULE, on 15m candles decided at the candle CLOSE (BTC for part 1, the alt itself for part 2):
 *   1  price goes up and OI goes up -- from OI's lowest point to the OI peak; this build-up is RANK 1 (bigger than every
 *      move of the `rankWindowHours` before it; the moves = the 15m directional change, used ONLY for this comparison)
 *   2  after the peak OI falls (green candles may still come)
 *   3  the FIRST red candle with OI down -> entry at its close (SHORT). Mirror: a fall with OI up -> first green -> LONG
 * PART 1 "BTC": the picks = the alts that moved most WITH BTC from OI's low to the entry: R2 of 1-minute moves on BTC's
 *   (upper half), ranked by x = alt % / BTC % (each to its extreme in BTC's direction).
 * PART 2 "ALT": the alt's own signal, only if the build-up (OI low -> OI peak) was NOT BTC's doing (src/research/dc15.ts
 *   ownness: BTC went the other way, or BTC explains less than half of its minute moves).
 * Only bars that closed before the candle end are used (`bars` is cut here, whatever the caller passes).
 */
import { candles, coinInWindow, ownness, priceAt, type MinBar, type Own } from "../../research/dc15";
import { oiPeakSignals, type PeakSignal } from "../../research/oi-peak";
import { atrSignals, type AtrSignal } from "../../research/atr-turn";

export const V10_TF_MIN = 15;
export const V10_K = 1;
export const V10_ATR_N = 14;
/** history used for the moves (RANK 1 comparison) -- long enough to settle into the same moves as the backtest */
export const V10_HISTORY_MS = 10 * 24 * 3_600_000;
const M = 60_000, W = V10_TF_MIN * M;

export type V10Side = "SHORT" | "LONG";

/**
 * Which entry (users.config.json "v10.entry", Oct 3):
 *   "atr"       OI grew with the price (RANK 1), OI is now below its peak, and the 15m candle CLOSES 1 ATR back from
 *               the top made by an earlier candle (src/research/atr-turn.ts) -- the ATR known before that candle
 *   "atrFrozen" the same, with the ATR of the moment the move began
 *   "oiPeak"    OI low -> OI peak (RANK 1) -> the first red candle with OI down, no ATR distance (src/research/oi-peak.ts)
 */
export type V10Entry = "atr" | "atrFrozen" | "oiPeak";
export interface V10Rule { entry: V10Entry; /** atr / atrFrozen: how the OI growth is measured (src/research/atr-turn.ts), default "afterLow" */ growth?: "afterLow" | "biggest" }

/** every signal of these candles by the rule (the backtest and live both call this) */
export function signalsOf(c: Parameters<typeof oiPeakSignals>[0], rankWindowHours: number, rule: V10Rule, why?: (t: number, reason: string) => void): Array<PeakSignal | AtrSignal> {
  return rule.entry === "oiPeak"
    ? oiPeakSignals(c, V10_K, V10_ATR_N, rankWindowHours)
    : atrSignals(c, V10_K, V10_ATR_N, rankWindowHours, { atr: rule.entry === "atrFrozen" ? "frozen" : "live", growth: rule.growth, why });
}

/** a RANK 1 signal of one symbol (BTC for part 1, the alt itself for part 2) */
export interface V10Turn {
  /** 3: the entry candle's close, the price then, the candle */
  candleEnd: number; side: V10Side; price: number; candleOiPct: number; label: string;
  /** 1: the moment OI was lowest (a candle close) and the OI peak moment; the build-up in % */
  moveStartT: number; peakT: number; moveOiPct: number;
  /** the price's extreme so far (high / low) and its candle (open time), the price move from 1 to it */
  extreme: number; extremeT: number; movePct: number;
  /** 2: OI from the peak to the entry */
  fromPeakOiPct: number;
  /** RANK 1 against how many earlier moves */
  prior: number;
  /** the ATR entries only: the ATR used and how far (%) the close came back from the extreme; the picks' window end */
  atr?: number; backPct?: number;
  /** which entry made it */
  entry?: V10Entry;
}

export interface V10Pick { symbol: string; rank: number; x: number; follow: number; coinPct: number; btcPct: number; price: number }

export type V10BtcTurn = V10Turn;

const toTurn = (s: PeakSignal | AtrSignal, entry: V10Entry): V10Turn => ({
  candleEnd: s.t, side: s.side, price: s.price, candleOiPct: s.candleOiPct, label: s.label,
  moveStartT: s.startT, peakT: s.peakT, moveOiPct: s.buildOiPct,
  extreme: s.extreme, extremeT: s.extremeT, movePct: s.movePct, fromPeakOiPct: s.fromPeakOiPct, prior: s.prior,
  ...("atr" in s ? { atr: s.atr, backPct: s.backPct } : {}), entry,
});

/** The signal of `bars` (any symbol) at `candleEnd` by the rule (RANK 1), else null. */
export function rank1At(bars: readonly MinBar[], candleEnd: number, rankWindowHours: number, rule: V10Rule): V10Turn | null {
  const cut = bars.filter((b) => b.t < candleEnd);
  const s = signalsOf(candles(cut, V10_TF_MIN), rankWindowHours, rule).find((x) => x.t === candleEnd);
  return s ? toTurn(s, rule.entry) : null;
}

/** BTC's signal at `candleEnd` (part 1) */
export const btcRank1At = rank1At;

/** PART 1: the alts that moved most with BTC over BTC's move from OI's low (the build-up's start) to the entry. `closes` = each alt's minute closes. */
export function pickAlts(turn: V10Turn, btcCloses: ReadonlyMap<number, number>, closes: ReadonlyMap<string, ReadonlyMap<number, number>>, picks: number): V10Pick[] {
  const up = turn.side === "SHORT"; // a SHORT ends an UP move
  const rows: Array<Omit<V10Pick, "rank">> = [];
  for (const [symbol, m] of closes) {
    const w = coinInWindow(m, btcCloses, turn.moveStartT, turn.candleEnd, up);
    const price = priceAt(m, turn.candleEnd);
    if (Number.isFinite(w.x) && Number.isFinite(w.follow) && price > 0) rows.push({ symbol, x: w.x, follow: w.follow, coinPct: w.pct, btcPct: w.btcPct, price });
  }
  if (!rows.length) return [];
  const med = [...rows].map((r) => r.follow).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  return rows.filter((r) => r.follow >= med).sort((a, b) => b.x - a.x).slice(0, picks).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** PART 2: was the alt's build-up its OWN move? null = BTC's doing (not a part-2 signal).
 *  r2Minutes (Oct 3): the R2 on 15m closes (Johnny: what the chart shows) or on 1-minute returns (the old way). */
export interface V10OwnMove { how: Exclude<Own, "WITH BTC">; follow: number; coinPct: number; btcPct: number; r2Minutes?: number }
export function ownMove(turn: V10Turn, altCloses: ReadonlyMap<number, number>, btcCloses: ReadonlyMap<number, number>, r2Minutes: number): V10OwnMove | null {
  // from where the build-up started (OI's low) to the entry (Johnny Oct 3: look from there to the entry)
  const w = coinInWindow(altCloses, btcCloses, turn.moveStartT, turn.candleEnd, undefined, r2Minutes);
  // a move too short to measure (fewer than 10 steps) is not "own"
  if (!Number.isFinite(w.follow) || !Number.isFinite(w.pct)) return null;
  const how = ownness(w.follow, w.pct, w.btcPct);
  return how === "WITH BTC" ? null : { how, follow: w.follow, coinPct: w.pct, btcPct: w.btcPct, r2Minutes };
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
