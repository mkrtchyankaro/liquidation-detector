/**
 * ON WHICH CHART TO COMPARE A COIN WITH BTC? (Johnny, Oct 2 2026) Read-only, Binance 1-minute candles.
 * For every coin and each timeframe (1m 5m 15m 1h 4h, grouped from 1-minute candles over the same --hours):
 *   x BTC   BTC's candle +1% -> the coin's candle +x%
 *   R2      how much of the coin's candles BTC explains (1 = only follows BTC, 0 = its own way)
 *   late    R2 when the coin is compared with BTC's PREVIOUS candle (does it follow one candle later?)
 * BEST = the timeframe with the highest R2 among those with at least 30 candles (fewer = R2 not reliable).
 * Open BTC and the coin side by side on that timeframe. See src/research/btc-tf.ts.
 *
 *   npx tsx src/tools/btc-tf.ts                    (24 coins, last 72h)
 *   npx tsx src/tools/btc-tf.ts --hours 168 --coins DOGE,AVAX
 */
import "dotenv/config";
import { klines } from "../research/binance-history";
import { bestTf, tfStat, type TfStat } from "../research/btc-tf";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DEFAULT = "ETH,SOL,XRP,BNB,DOGE,ADA,LINK,AVAX,SUI,HYPE,LTC,BCH,DOT,NEAR,UNI,ENA,ALGO,XTZ,WLD,STRK,HBAR,ZEC,XLM,ONDO";
const TFS = [1, 5, 15, 60, 240];
const MIN_N = 30;
const name = (tf: number): string => (tf < 60 ? `${tf}m` : `${tf / 60}h`);
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "  - ");

async function main(): Promise<void> {
  const hours = Number(arg("hours", "72"));
  if (!(hours >= 6) || hours > 168) throw new Error("--hours must be between 6 and 168");
  const coins = arg("coins", DEFAULT).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const to = Math.floor(Date.now() / 3_600_000) * 3_600_000, from = to - hours * 3_600_000;
  const bars = async (s: string) => (await klines(s, "1m", from, to)).map((k) => ({ t: k.t, close: k.close }));
  const btc = await bars("BTCUSDT");
  const rows: Array<{ s: string; st: TfStat[]; best: TfStat | null }> = [];
  for (const s of coins) {
    try {
      const c = await bars(s);
      const st = TFS.map((tf) => tfStat(c, btc, tf));
      rows.push({ s, st, best: bestTf(st, MIN_N) });
    } catch (err) {
      console.log(`  ${s}: failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  rows.sort((a, z) => (z.best?.r2 ?? -1) - (a.best?.r2 ?? -1));
  console.log(`\nCoin vs BTC per timeframe · last ${hours}h · UTC · x = BTC +1% -> coin +x% · R2 = how much BTC explains (late = coin one candle after BTC)`);
  console.log(`candles per timeframe: ${TFS.map((tf) => `${name(tf)} ${Math.floor((hours * 60) / tf)}`).join(" · ")} (BEST only from ${MIN_N}+ candles)\n`);
  console.log(`coin     ${TFS.map((tf) => `| ${name(tf).padEnd(3)}  x     R2   late`).join(" ")} | BEST`);
  for (const r of rows) {
    const cells = r.st.map((s) => `| ${" ".repeat(3)} ${f2(s.beta).padStart(5)} ${f2(s.r2)} ${f2(s.lagR2)}${s.n < MIN_N ? "*" : " "}`).join("");
    const b = r.best;
    const tail = b ? `${name(b.tf)}: BTC 1% -> ${r.s.replace(/USDT$/, "")} ${b.beta.toFixed(2)}%, ${b.lagR2 > b.r2 ? "ONE CANDLE LATER" : "same candle"}` : "not enough data";
    console.log(`${r.s.replace(/USDT$/, "").padEnd(8)} ${cells} | ${tail}`);
  }
  console.log(`\n* = fewer than ${MIN_N} candles, R2 not reliable. Open BTC and the coin side by side on the BEST timeframe.`);
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
