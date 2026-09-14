/**
 * Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode only.
 * Ports the research thread's v1 directional-ATR methodology into
 * production: prior-close-referenced DownTR/UpTR, EMA-smoothed at
 * period 14 (alpha = 2/15), fed EXCLUSIVELY by fully-closed 1m
 * candles -- the exact same formula used throughout the research
 * scripts this is ported from.
 *
 *   DownTR_t = max(0, close_{t-1} - low_t)
 *   UpTR_t   = max(0, high_t - close_{t-1})
 *   EMA_t    = alpha * TR_t + (1 - alpha) * EMA_{t-1}
 *
 * Genuinely separate from ATRTrackerService -- does not read or
 * write any of its state, and nothing in ATRTrackerService reads
 * this. Fed at the SAME candle-close site market-data-orchestrator.ts
 * already uses to feed ATRTrackerService.onCandle() (see that file's
 * own onCandle wiring) -- no new candle pipeline, no new market-data
 * subscription. onCandle() rejects any candle that is not fully
 * closed, mirroring ATRTrackerService's own discipline exactly.
 */

const PERIOD = 14;
const ALPHA = 2 / (PERIOD + 1);
const HISTORY_BUFFER_SIZE = 50; // enough for the 3m slope lookback plus margin

export interface ClosedCandle {
  symbol: string;
  openTime: number;
  high: number;
  low: number;
  close: number;
  isClosed: boolean;
}

interface DirState {
  /** Closed candles, oldest-first, capped at HISTORY_BUFFER_SIZE. */
  candles: ClosedCandle[];
  downAtr: number | null;
  upAtr: number | null;
  /** downAtr/upAtr value AS OF each closed candle -- lets slope
   *  lookups go back N minutes without re-deriving from scratch. */
  downHistory: { t: number; v: number }[];
  upHistory: { t: number; v: number }[];
  prevClose: number | null;
}

export interface DirectionalAtrReader {
  getDownAtr(symbol: string): number | null;
  getUpAtr(symbol: string): number | null;
  getDownSlopeNormalized(
    symbol: string,
    windowMinutes: number,
    preDownAtr: number,
  ): number | null;
  getUpSlopeNormalized(
    symbol: string,
    windowMinutes: number,
    preUpAtr: number,
  ): number | null;
}

export class DirectionalAtrTracker implements DirectionalAtrReader {
  private readonly state = new Map<string, DirState>();

  /** Hook called from market-data-orchestrator.ts on every kline
   *  event, at the SAME site ATRTrackerService.onCandle() is already
   *  called -- pass the identical candle object. Silently ignores any
   *  candle that is not fully closed (no forming-candle leakage). */
  onCandle(c: ClosedCandle): void {
    if (!c.isClosed) return;
    let s = this.state.get(c.symbol);
    if (!s) {
      s = {
        candles: [],
        downAtr: null,
        upAtr: null,
        downHistory: [],
        upHistory: [],
        prevClose: null,
      };
      this.state.set(c.symbol, s);
    }

    const last = s.candles[s.candles.length - 1];
    if (last && last.openTime === c.openTime) return; // dedupe, matches ATRTrackerService's own convention

    if (s.prevClose !== null) {
      const downTr = Math.max(0, s.prevClose - c.low);
      const upTr = Math.max(0, c.high - s.prevClose);
      s.downAtr =
        s.downAtr === null ? downTr : ALPHA * downTr + (1 - ALPHA) * s.downAtr;
      s.upAtr = s.upAtr === null ? upTr : ALPHA * upTr + (1 - ALPHA) * s.upAtr;
      s.downHistory.push({ t: c.openTime, v: s.downAtr });
      s.upHistory.push({ t: c.openTime, v: s.upAtr });
      if (s.downHistory.length > HISTORY_BUFFER_SIZE) s.downHistory.shift();
      if (s.upHistory.length > HISTORY_BUFFER_SIZE) s.upHistory.shift();
    }

    s.prevClose = c.close;
    s.candles.push(c);
    if (s.candles.length > HISTORY_BUFFER_SIZE) s.candles.shift();
  }

  /** Current DownATR/UpATR (as of the last fully-closed candle fed
   *  in). Null if fewer than 2 closed candles have been seen yet
   *  (the first candle only seeds prevClose; TR needs a prior close). */
  getDownAtr(symbol: string): number | null {
    return this.state.get(symbol)?.downAtr ?? null;
  }
  getUpAtr(symbol: string): number | null {
    return this.state.get(symbol)?.upAtr ?? null;
  }

  /** Normalized N-minute slope: (current - value N candles back) / N
   *  / preAtr. Null if history doesn't yet reach back N candles, or
   *  preAtr <= 0 (division guard). Looked up by CANDLE COUNT, not
   *  wall-clock distance, matching the 1m-candle cadence this is
   *  built for. */
  getDownSlopeNormalized(
    symbol: string,
    windowMinutes: number,
    preDownAtr: number,
  ): number | null {
    return this.slopeNormalized(
      this.state.get(symbol)?.downHistory,
      windowMinutes,
      preDownAtr,
    );
  }
  getUpSlopeNormalized(
    symbol: string,
    windowMinutes: number,
    preUpAtr: number,
  ): number | null {
    return this.slopeNormalized(
      this.state.get(symbol)?.upHistory,
      windowMinutes,
      preUpAtr,
    );
  }

  private slopeNormalized(
    history: { t: number; v: number }[] | undefined,
    windowMinutes: number,
    preAtr: number,
  ): number | null {
    if (!history || history.length <= windowMinutes || preAtr <= 0) return null;
    const cur = history[history.length - 1]!.v;
    const past = history[history.length - 1 - windowMinutes]!.v;
    return (cur - past) / windowMinutes / preAtr;
  }
}
