/**
 * WHO MOVES WITH BTC TODAY? (Johnny, Oct 1 2026) Read-only, straight from Binance 1-minute candles (works for coins
 * we do not collect yet). For every coin over the last --hours:
 *   x BTC     the coin's usual amplification of BTC (BTC +1% -> coin +x%), from the 1-minute moves
 *   R2        how much of the coin's minute-by-minute moves BTC explains (1 = only follows BTC, 0 = its own way)
 *   coin/BTC  the moves over the whole window; own = coin - x * BTC (the part BTC does not explain)
 * Sorted from the most BTC-bound to the most independent. No thresholds.
 *
 *   npx tsx src/tools/btc-link.ts                       (the 24 coins, last 24h)
 *   npx tsx src/tools/btc-link.ts --hours 4 --coins DOGE,AVAX,HYPE
 */
import "dotenv/config";
import { klines } from "../research/binance-history";
import { blameOf } from "../research/v9-btc-blame";
import { betaOf } from "../research/v9-own-move";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DEFAULT =
  "ETH,SOL,XRP,BNB,DOGE,ADA,LINK,AVAX,SUI,HYPE,LTC,BCH,DOT,NEAR,UNI,ENA,ALGO,XTZ,WLD,STRK,HBAR,ZEC,XLM,ONDO";
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

async function main(): Promise<void> {
  const hours = Number(arg("hours", "24"));
  if (!(hours > 0) || hours > 72)
    throw new Error("--hours must be between 1 and 72");
  const coins = arg("coins", DEFAULT)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const to = Math.floor(Date.now() / 60_000) * 60_000,
    from = to - hours * 3_600_000;
  const bars = async (s: string) =>
    (await klines(s, "1m", from, to)).map((k) => ({
      t: k.t,
      close: k.close,
      high: k.high,
      low: k.low,
    }));
  const btc = await bars("BTCUSDT");
  const btcPct =
    btc.length > 1
      ? (100 * (btc[btc.length - 1].close - btc[0].close)) / btc[0].close
      : NaN;
  const rows: Array<{
    s: string;
    beta: number;
    r2: number;
    coin: number;
    own: number;
  }> = [];
  for (const s of coins) {
    try {
      const c = await bars(s);
      const beta = betaOf(c, btc, from, to + 60_000),
        b = blameOf("LONG", c, btc, from, to);
      if (beta === null || !b || b.r2 === null) {
        console.log(`  ${s}: not enough data`);
        continue;
      }
      rows.push({
        s,
        beta,
        r2: b.r2,
        coin: b.coinPct,
        own: b.coinPct - beta * b.btcPct,
      });
    } catch (err) {
      console.log(
        `  ${s}: failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  rows.sort((a, z) => z.r2 - a.r2);
  console.log(
    `\nWho moves with BTC · last ${hours}h · 1-minute Binance candles · BTC ${sp(btcPct)} · most BTC-bound first\n`,
  );
  console.log(
    `  coin        x BTC   R2    BTC explains                     coin move   own part`,
  );
  for (const r of rows) {
    const bar = "█".repeat(Math.round(r.r2 * 20)).padEnd(20, "·");
    console.log(
      `  ${r.s.replace(/USDT$/, "").padEnd(8)} ${r.beta.toFixed(2).padStart(6)}  ${r.r2.toFixed(2)}  ${bar} ${String(Math.round(r.r2 * 100)).padStart(3)}%   ${sp(r.coin).padStart(8)}   ${sp(r.own).padStart(8)}`,
    );
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
