/**
 * LONG AFTER A FLUSH (Johnny, Oct 4 2026). Pure, live-safe (each decision uses closed candles only).
 *   flush    a fall of more than `minMovePct` % in which OI FELL (positions closed / liquidated), and that OI decrease is
 *            the biggest |OI change| of the moves in the `windowH` hours before it (RANK 1) -- the plain 1-ATR moves
 *            (src/research/dc15.ts turns, no OI condition), known once its 1-ATR reversal closed
 *   the price may then stay low for a while (it does not have to turn at once)
 *   impulse  a GREEN candle whose OI rise is the biggest of every candle of the `windowH` hours before it (RANK 1),
 *            within `lookbackH` hours after the flush's low, the low not broken since -> LONG at its close
 */
import { pastRank, turns, type Candle } from "./dc15";

export interface ImpulseSignal {
  t: number;
  price: number;
  /** the flush: where its fall started (candle open), its low and the low's candle, its price % and OI % */
  startT: number;
  low: number;
  lowT: number;
  fallPct: number;
  fallOiPct: number;
  prior: number;
  /** the impulse candle: its OI % */
  candleOiPct: number;
}

export function impulseLongs(
  c: readonly Candle[],
  opts: {
    k?: number;
    n?: number;
    windowH?: number;
    lookbackH?: number;
    minMovePct?: number;
  } = {},
): ImpulseSignal[] {
  const k = opts.k ?? 1,
    n = opts.n ?? 14,
    windowH = opts.windowH ?? 12,
    lookbackH = opts.lookbackH ?? 12,
    minMove = opts.minMovePct ?? 0;
  const H = 3_600_000,
    out: ImpulseSignal[] = [];
  if (!c.length) return out;
  const W = c[0].end - c[0].t;
  // the flushes: falls with OI down, RANK 1 by |OI change| among the moves of the window, bigger than minMove
  const flushes = pastRank(turns(c, k, n, false), windowH)
    .filter(
      (r) =>
        r.turn.newDir === "UP" &&
        r.turn.moveOiPct < 0 &&
        r.rank === 1 &&
        r.prior > 0 &&
        -r.turn.movePct > minMove,
    )
    .map((r) => ({ ...r.turn, prior: r.prior }));
  const idx = new Map(c.map((x, i) => [x.t, i]));
  const oi = (x: Candle): number => (x.oi0 > 0 ? (x.oi1 - x.oi0) / x.oi0 : NaN);
  let lastT = -Infinity;
  for (let i = 1; i < c.length; i++) {
    const x = c[i];
    if (!(x.close > x.open) || !(oi(x) > 0)) continue;
    // RANK 1 OI rise: bigger than every candle of the window before it (and the window has candles)
    let prior = 0,
      bigger = false;
    for (let j = i - 1; j >= 0 && c[j].end > x.end - windowH * H - W; j--) {
      prior++;
      if (oi(c[j]) >= oi(x)) {
        bigger = true;
        break;
      }
    }
    if (bigger || prior < 2) continue;
    // the latest flush known by now whose low is within lookbackH, its low not broken since
    const f = [...flushes]
      .reverse()
      .find((t) => t.t <= x.end && t.extremeT + W >= x.end - lookbackH * H);
    if (!f) continue;
    const e = idx.get(f.extremeT);
    if (e === undefined || c.slice(e + 1, i + 1).some((y) => y.low < f.extreme))
      continue;
    if (f.extremeT <= lastT) continue; // one LONG per flush
    lastT = f.extremeT;
    out.push({
      t: x.end,
      price: x.close,
      startT: f.moveStartT,
      low: f.extreme,
      lowT: f.extremeT,
      fallPct: f.movePct,
      fallOiPct: f.moveOiPct,
      prior: f.prior,
      candleOiPct: 100 * oi(x),
    });
  }
  return out;
}
