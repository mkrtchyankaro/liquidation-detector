/**
 * BTC's BIG MOVES: did each coin's OI go WITH BTC's OI or AGAINST it, and what came after? (Johnny, Oct 2 2026)
 * Read-only, Binance (15m candles + 5-minute OI). See src/research/btc-oi-moves.ts.
 *   - the --top biggest BTC candles (by |price %|) of the last --days, each with BTC's OI % (OI up = new positions)
 *   - per coin in that candle: price %, OI %, then 1h / 4h later vs BTC (+ continued, - came back)
 *   - SUMMARY: BTC OI up / down  x  coin OI up / down -> how often the coin came back, average
 *
 *   npx tsx src/tools/btc-oi-moves.ts                 (7 days, 15m candles, top 20)
 *   options: --days 7  --tf 15 (5|15|60)  --top 20  --coins DOGE,AVAX  --quiet (summary only)
 */
import "dotenv/config";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";
import {
  btcMoves,
  type BtcMove,
  type CoinAtMove,
  type Series,
} from "../research/btc-oi-moves";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DEFAULT =
  "ETH,SOL,XRP,BNB,DOGE,ADA,LINK,AVAX,SUI,HYPE,LTC,BCH,DOT,NEAR,UNI,ENA,ALGO,XTZ,WLD,STRK,HBAR,ZEC,XLM,ONDO";
const D = 86_400_000;
const sp = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "   n/a";
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const word = (v: number): string =>
  !Number.isFinite(v) ? "" : v >= 0 ? "continued" : "came back";

async function series(
  symbol: string,
  tf: "5m" | "15m" | "1h",
  from: number,
  to: number,
): Promise<Series> {
  const [k, snap] = [
    await klines(symbol, tf, from, to),
    await oiSnapshots(symbol, from, to, "5m"),
  ];
  return {
    candles: k.map((c) => ({ t: c.t, open: c.open, close: c.close })),
    oi: (ts: number) => oiAt(snap, ts),
  };
}

function summary(title: string, moves: BtcMove[]): void {
  console.log(title);
  for (const [name, pick] of [
    ["coin OI UP   (opens with BTC)", (c: CoinAtMove) => c.oiPct > 0],
    ["coin OI DOWN (only closing)", (c: CoinAtMove) => c.oiPct < 0],
  ] as const) {
    const cs = moves.flatMap((m) => m.coins).filter(pick);
    for (const h of ["1h", "4h"] as const) {
      const v = cs
        .map((c) => (h === "1h" ? c.rel1h : c.rel4h))
        .filter(Number.isFinite);
      const raw = cs
        .map((c) => (h === "1h" ? c.raw1h : c.raw4h))
        .filter(Number.isFinite);
      const back = v.filter((x) => x < 0).length;
      const avg = (a: number[]): number =>
        a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
      console.log(
        `   ${name} · ${h} later: ${String(v.length).padStart(4)} cases · came back vs BTC ${String(back).padStart(3)} (${v.length ? Math.round((100 * back) / v.length) : 0}%) · avg vs BTC ${sp(avg(v))} · coin alone avg ${sp(avg(raw))}`,
      );
    }
  }
  console.log("");
}

async function main(): Promise<void> {
  const days = Number(arg("days", "7")),
    tfMin = Number(arg("tf", "15")),
    top = Number(arg("top", "20"));
  if (![5, 15, 60].includes(tfMin) || !(days > 0 && days <= 25) || !(top > 0))
    throw new Error("--tf 5|15|60, --days 1..25, --top > 0");
  const tf = tfMin === 5 ? "5m" : tfMin === 15 ? "15m" : "1h";
  const coins = arg("coins", DEFAULT)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const to = Math.floor(Date.now() / (tfMin * 60_000)) * tfMin * 60_000,
    start = to - days * D,
    from = start - D; // +1 day for beta
  const btc = await series("BTCUSDT", tf, from, to);
  const cs = new Map<string, Series>();
  for (const s of coins) {
    try {
      cs.set(s.replace(/USDT$/, ""), await series(s, tf, from, to));
    } catch (err) {
      console.log(
        `  ${s}: failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  const moves = btcMoves(btc, cs, tfMin, top, start);
  console.log(
    `\nBTC's ${top} biggest ${tf} candles · last ${days} days · UTC · coin "after" = 1h / 4h later vs BTC (beta from the 24h before): + continued, - came back\n`,
  );
  if (!argv.includes("--quiet")) {
    for (const m of moves) {
      console.log(
        `BTC ${utc(m.t)} · price ${sp(m.pricePct)} · OI ${sp(m.oiPct)} ${m.oiPct > 0 ? "(new positions)" : "(closing / liquidations)"}`,
      );
      console.log(
        `   coin    price     OI      1h vs BTC              4h vs BTC`,
      );
      for (const c of [...m.coins].sort((a, z) => a.oiPct - z.oiPct)) {
        console.log(
          `   ${c.symbol.padEnd(6)} ${sp(c.pricePct).padStart(7)} ${sp(c.oiPct).padStart(7)}  ${sp(c.rel1h).padStart(7)} ${word(c.rel1h).padEnd(10)}  ${sp(c.rel4h).padStart(7)} ${word(c.rel4h)}`,
        );
      }
      console.log("");
    }
  }
  summary(
    "SUMMARY · BTC moves with OI UP (new positions):",
    moves.filter((m) => m.oiPct > 0),
  );
  summary(
    "SUMMARY · BTC moves with OI DOWN (closing / liquidations):",
    moves.filter((m) => m.oiPct < 0),
  );
  console.log(
    `BTC moves: ${moves.length} (OI up ${moves.filter((m) => m.oiPct > 0).length}, OI down ${moves.filter((m) => m.oiPct < 0).length}). n/a = not 1h / 4h of data after it yet.`,
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
