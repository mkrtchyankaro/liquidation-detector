/**
 * Step 1: FIND the big moves of a coin -- price and open interest together. Read-only research, times UTC.
 *
 *   npx tsx src/tools/oi-moves.ts --coins ETH --days 7
 *   npx tsx src/tools/oi-moves.ts --coins ETH,BTC,SOL --days 3
 *
 * Rules (no % thresholds): src/research/oi-moves.ts
 *   - price move = 1h candle bodies stepping one way (at least 3 candles), bigger than the range the market was
 *     swinging in just before, and ending outside it
 *   - only moves where the OI grew; the move ENDS where the OI stops growing (its peak), whatever the price does after
 *   - amounts in COINS (ETH for ETHUSDT, BTC for BTCUSDT ...), from 5-minute OI + price:
 *       short stops/liquidations = OI falling while the price rises (the OI "tails" of an up move), longs mirror
 */
import "dotenv/config";
import {
  findMoves,
  flowBetween,
  type Move,
  type MvBar,
  type MvHour,
} from "../research/oi-moves";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const COINS = arg("coins", arg("coin", "ETH"))
  .split(",")
  .map((x) => x.trim().toUpperCase())
  .filter(Boolean)
  .map((x) => (x.endsWith("USDT") ? x : `${x}USDT`));
const DAYS = Number(arg("days", "7"));
const H = 3_600_000,
  D = 24 * H,
  LOOKBACK = 2 * D; // extra history before the window, for "the range before the move"
const t = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const f2 = (x: number): string => (x >= 0 ? "+" : "") + x.toFixed(2);
const px = (x: number): string =>
  x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toFixed(6);

const n0 = (x: number): string => Math.round(x).toLocaleString("en-US");

function print(
  m: Move,
  h: readonly MvHour[],
  bars: readonly MvBar[],
  coin: string,
): void {
  const p = m.phases[0],
    up = m.dir === "UP";
  const f = flowBetween(bars, p.from, p.to);
  const hi = p.high,
    lo = p.low;
  console.log(
    `${up ? "▲ PRICE UP   + OI UP" : "▼ PRICE DOWN + OI UP"}   (${p.hours}h)`,
  );
  console.log(
    `   start ${t(p.from)} UTC   price ${px(p.priceFrom)}   OI ${n0(p.oiFrom)} ${coin}`,
  );
  console.log(
    `   end   ${t(p.to)} UTC   price ${px(p.priceTo)} (${f2(p.pricePct)}%, ${up ? `high ${px(hi)}` : `low ${px(lo)}`})   OI ${n0(p.oiTo)} ${coin}  = +${n0(p.oiTo - p.oiFrom)} ${coin} (${f2(p.oiPct)}%)   <- after this the OI falls`,
  );
  console.log(
    up
      ? `   SHORT stops/liquidations during the rise: ${n0(f.shortOut)} ${coin}   (longs out ${n0(f.longOut)})   | opened: longs +${n0(f.newLong)}, shorts +${n0(f.newShort)} ${coin}`
      : `   LONG stops/liquidations during the fall:  ${n0(f.longOut)} ${coin}   (shorts out ${n0(f.shortOut)})   | opened: longs +${n0(f.newLong)}, shorts +${n0(f.newShort)} ${coin}`,
  );
  void h;
}

async function run(symbol: string, to: number, winFrom: number): Promise<void> {
  const from = Math.floor((winFrom - LOOKBACK) / D) * D,
    coin = symbol.replace(/USDT$/, "");
  const snap = await oiSnapshots(symbol, from, to);
  const [kl, k5] = [
    await klines(symbol, "1h", from, to),
    await klines(symbol, "5m", from, to),
  ];
  const h: MvHour[] = kl.map((c) => ({
    ...c,
    oi: oiAt(snap, c.t + H),
    oiOpen: oiAt(snap, c.t),
  }));
  const bars: MvBar[] = k5.map((c) => ({
    t: c.t,
    open: c.open,
    close: c.close,
    oi: oiAt(snap, c.t + 5 * 60_000, 5 * 60_000),
  }));
  const moves = findMoves(h).filter(
    (m) => m.phases[0].kind.endsWith("OI UP") && m.phases[0].to > winFrom,
  );
  console.log(
    `\n=== ${symbol}  last ${DAYS} day(s): ${t(winFrom)} .. ${t(to)} UTC  -- price + OI growing together, ends where the OI starts to fall ===`,
  );
  if (!moves.length) console.log("no such moves");
  let lastDay = "";
  for (const m of moves) {
    const d = t(m.phases[0].from).slice(0, 10);
    if (d !== lastDay) {
      console.log(`--- ${d} ---`);
      lastDay = d;
    }
    print(m, h, bars, coin);
  }
  console.log(
    `\n${symbol}: ${moves.length} moves (${moves.filter((m) => m.dir === "UP").length} price up, ${moves.filter((m) => m.dir === "DOWN").length} price down); amounts are estimates from 5-minute OI`,
  );
}

async function main(): Promise<void> {
  const to = Math.floor(Date.now() / H) * H,
    winFrom = to - DAYS * D;
  for (const s of COINS) {
    try {
      await run(s, to, winFrom);
    } catch (err) {
      console.log(
        `\n${s}: FAILED -- ${err instanceof Error ? err.message : String(err)} (wrong coin name?)`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
