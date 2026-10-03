/**
 * FLIP (STOP AND REVERSE) ON ONE COIN (Johnny, Oct 3 2026). Pure, live-safe: every decision uses closed candles /
 * minutes only. See src/tools/v10-flip.ts for the rules.
 *   in a position: SL minute by minute (same minute = SL); at each 15m close:
 *     the opposite full signal -> close + open it (FLIP)
 *     SHORT: a GREEN candle, OI up in it, close >= k x ATR above the lowest low since the entry -> close (TURN)
 *     LONG:  a RED candle, OI down in it, close >= k x ATR below the highest high since the entry -> close (TURN)
 *   flat: open on a full signal
 */
import { atrBefore, type Candle, type MinBar } from "./dc15";

export type FlipSide = "SHORT" | "LONG";
export interface FlipSig {
  t: number;
  side: FlipSide;
  price: number;
}
export type FlipExit = "SL" | "TURN" | "FLIP" | "OPEN" | "TP";
export interface FlipTrade {
  sym: string;
  side: FlipSide;
  t: number;
  entry: number;
  exitT: number;
  exitP: number;
  exit: FlipExit;
  r: number;
  net: number;
}

const M = 60_000;

export function flipCoin(
  sym: string,
  bars: readonly MinBar[],
  c: readonly Candle[],
  sigs: readonly FlipSig[],
  slPct: number,
  fee: number,
  k = 1,
  n = 14,
): FlipTrade[] {
  const atr = atrBefore(c, n),
    out: FlipTrade[] = [];
  const at = new Map<number, FlipSig[]>();
  for (const s of sigs) at.set(s.t, [...(at.get(s.t) ?? []), s]);
  const minuteIdx = (t: number): number => {
    let lo = 0,
      hi = bars.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (bars[m].t < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  type Pos = {
    side: FlipSide;
    t: number;
    entry: number;
    sl: number;
    ext: number;
  };
  let pos = null as Pos | null;
  const close = (exitT: number, exitP: number, exit: FlipExit): void => {
    const p = pos!,
      sg = p.side === "SHORT" ? -1 : 1,
      r = (sg * (exitP - p.entry)) / ((p.entry * slPct) / 100);
    out.push({
      sym,
      side: p.side,
      t: p.t,
      entry: p.entry,
      exitT,
      exitP,
      exit,
      r,
      net: r - (2 * fee) / slPct,
    });
    pos = null;
  };
  const open = (s: FlipSig): void => {
    pos = {
      side: s.side,
      t: s.t,
      entry: s.price,
      sl:
        s.side === "SHORT"
          ? s.price * (1 + slPct / 100)
          : s.price * (1 - slPct / 100),
      ext: s.price,
    };
  };
  for (let ci = 0; ci < c.length; ci++) {
    const x = c[ci];
    // 1) inside this candle, minute by minute: the SL (only minutes after the entry)
    if (pos && x.end > pos.t) {
      for (
        let i = minuteIdx(Math.max(x.t, pos.t));
        i < bars.length && bars[i].t < x.end;
        i++
      ) {
        const b = bars[i];
        if (pos.side === "SHORT" ? b.high >= pos.sl : b.low <= pos.sl) {
          close(b.t + M, pos.sl, "SL");
          break;
        }
      }
    }
    // 2) at the candle's close
    const here = at.get(x.end) ?? [];
    if (pos && x.t >= pos.t) {
      const p: { side: FlipSide; ext: number } = pos;
      p.ext =
        p.side === "SHORT" ? Math.min(p.ext, x.low) : Math.max(p.ext, x.high);
      const a = atr[ci];
      const opp = here.find((s) => s.side !== p.side);
      if (opp) {
        close(x.end, x.close, "FLIP");
        open(opp);
        continue;
      }
      const turn =
        a > 0 &&
        (p.side === "SHORT"
          ? x.close > x.open && x.oi1 > x.oi0 && x.close - p.ext >= k * a
          : x.close < x.open && x.oi1 < x.oi0 && p.ext - x.close >= k * a);
      if (turn) close(x.end, x.close, "TURN");
    } else if (!pos && here.length) open(here[0]);
  }
  if (pos) {
    const last = bars[bars.length - 1];
    close(last.t + M, last.close, "OPEN");
  }
  return out;
}
