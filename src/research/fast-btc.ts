/**
 * FAST TRADE: BTC's 15-minute candle -> trade a coin that follows BTC (Johnny, Oct 1 2026). Research only, live-safe.
 * At the close of every 15-minute BTC candle (built from our 1-minute bars):
 *   price DOWN + OI DOWN + LONG liquidations > SHORT liquidations  -> longs are being pushed out -> SHORT the coin
 *   price UP   + OI DOWN + SHORT liquidations > LONG liquidations  -> shorts are being pushed out -> LONG the coin
 * Entry = the coin's last 1-minute close of that 15 minutes; SL = the coin's own 15-minute candle extreme (high for a
 * SHORT, low for a LONG); TP = tpR x risk. One trade at a time (signals while a trade is open are skipped).
 * No thresholds besides the directions themselves.
 */
import {
  simTrade,
  type TpOpts,
  type TpResult,
  type TpTrade,
} from "./v9-tp-sim";

const M = 60_000,
  Q = 15 * M;
export interface FBar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oiFirst: number;
  oiLast: number;
  longLiq: number;
  shortLiq: number;
}
export interface Candle15 {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oiFrom: number;
  oiTo: number;
  longLiq: number;
  shortLiq: number;
  minutes: number;
}

export function candles15(bars: readonly FBar[]): Candle15[] {
  const g = new Map<number, FBar[]>();
  for (const b of bars) {
    const k = Math.floor(b.t / Q) * Q;
    (g.get(k) ?? g.set(k, []).get(k)!).push(b);
  }
  const out: Candle15[] = [];
  for (const [t, bs] of [...g].sort((a, b) => a[0] - b[0])) {
    bs.sort((a, b) => a.t - b.t);
    const oi = bs.filter((b) => b.oiLast > 0);
    out.push({
      t,
      open: bs[0].open,
      close: bs[bs.length - 1].close,
      high: Math.max(...bs.map((b) => b.high)),
      low: Math.min(...bs.map((b) => b.low)),
      oiFrom: oi.length
        ? oi[0].oiFirst > 0
          ? oi[0].oiFirst
          : oi[0].oiLast
        : NaN,
      oiTo: oi.length ? oi[oi.length - 1].oiLast : NaN,
      longLiq: bs.reduce((s, b) => s + (b.longLiq || 0), 0),
      shortLiq: bs.reduce((s, b) => s + (b.shortLiq || 0), 0),
      minutes: bs.length,
    });
  }
  return out;
}

/** the BTC rule on one 15-minute candle (only full candles) */
export function sideOf(c: Candle15): "LONG" | "SHORT" | null {
  if (c.minutes < 15 || !(c.oiFrom > 0) || !(c.oiTo < c.oiFrom)) return null;
  if (c.close < c.open && c.longLiq > c.shortLiq) return "SHORT";
  if (c.close > c.open && c.shortLiq > c.longLiq) return "LONG";
  return null;
}

export interface FastTrade {
  btc: Candle15;
  side: "LONG" | "SHORT";
  trade: TpTrade;
  res: TpResult;
}
/** coin trades from BTC's 15-minute candles; `forceSide` = baseline (every candle, that side) */
export function fastTrades(
  btc: readonly Candle15[],
  coinBars: readonly FBar[],
  o: TpOpts,
  forceSide?: "LONG" | "SHORT",
): { trades: FastTrade[]; skippedBusy: number } {
  const coin15 = new Map(candles15(coinBars).map((c) => [c.t, c]));
  const trades: FastTrade[] = [];
  let busyUntil = -Infinity,
    skippedBusy = 0;
  for (const b of btc) {
    const side = forceSide ?? sideOf(b);
    if (!side || (forceSide && b.minutes < 15)) continue;
    const c = coin15.get(b.t);
    if (!c || c.minutes < 15) continue;
    const entryTs = b.t + Q;
    if (entryTs < busyUntil) {
      skippedBusy++;
      continue;
    }
    const sl = side === "SHORT" ? c.high : c.low;
    if (side === "SHORT" ? !(sl > c.close) : !(sl < c.close)) continue; // closed at its own extreme -> no room for a stop
    const trade: TpTrade = {
      id: `${b.t}`,
      symbol: "",
      side,
      createdAt: entryTs - 1,
      entry: c.close,
      sl,
    };
    const res = simTrade(trade, coinBars, o);
    trades.push({ btc: b, side, trade, res });
    busyUntil = res.exitTs;
  }
  return { trades, skippedBusy };
}
