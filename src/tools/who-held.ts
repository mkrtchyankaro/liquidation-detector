/**
 * WHO DID NOT FALL WITH BTC? (Johnny, Oct 7 2026). Read-only, Binance public 1m klines, no keys, no DB.
 * At --at (UTC, a BTC move, e.g. the 15m candle that dumped), for BTC and every coin of SYMBOLS:
 *   candle   the % change of the --tf candle that starts at --at (open -> close)
 *   window   from that open to the close --mins minutes later, and the worst / best point in between (low / high)
 *   vs BTC   window % minus BTC's window %   (+ = held up better than BTC)
 * Sorted from the strongest to the weakest. "HELD" = the coin's window change is >= 0 or less than a quarter of BTC's drop.
 *
 *   npx tsx src/tools/who-held.ts --at "2026-10-07 01:45"
 *   options: --tf 15  --mins 60
 */
import "dotenv/config";
import { klines } from "../research/binance-history";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sp = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const M = 60_000;

interface Row {
  sym: string;
  candle: number;
  win: number;
  low: number;
  high: number;
}

async function main(): Promise<void> {
  const atS = arg("at", "2026-10-07 01:45"),
    at = Date.parse(`${atS.replace(" ", "T")}:00Z`);
  const tf = Number(arg("tf", "15")),
    mins = Number(arg("mins", "60"));
  if (!Number.isFinite(at))
    throw new Error('use --at "YYYY-MM-DD HH:MM" (UTC)');
  const syms = [
    "BTCUSDT",
    ...(process.env.SYMBOLS ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x && x !== "BTCUSDT"),
  ];
  const rows: Row[] = [];
  for (const s of syms) {
    try {
      const k = await klines(s, "1m", at, at + Math.max(tf, mins) * M);
      if (!k.length || k[0].t !== at) {
        console.log(`${s}: no data at that time`);
        continue;
      }
      const open = k[0].open,
        c = k.filter((x) => x.t < at + tf * M),
        w = k.filter((x) => x.t < at + mins * M);
      rows.push({
        sym: s.replace(/USDT$/, ""),
        candle: (100 * (c[c.length - 1].close - open)) / open,
        win: (100 * (w[w.length - 1].close - open)) / open,
        low: (100 * (Math.min(...w.map((x) => x.low)) - open)) / open,
        high: (100 * (Math.max(...w.map((x) => x.high)) - open)) / open,
      });
    } catch (err) {
      console.log(`${s}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const btc = rows.find((r) => r.sym === "BTC");
  if (!btc) throw new Error("no BTC data");
  console.log(
    `WHO DID NOT FALL WITH BTC · from ${atS} UTC · the ${tf}m candle and the next ${mins} min`,
  );
  console.log(
    `BTC: candle ${sp(btc.candle)}% · ${mins} min ${sp(btc.win)}% (low ${sp(btc.low)}%, high ${sp(btc.high)}%)\n`,
  );
  console.log(
    `  coin     ${tf}m candle   ${String(mins).padStart(3)} min    low      high    vs BTC`,
  );
  for (const r of rows
    .filter((x) => x.sym !== "BTC")
    .sort((a, b) => b.win - a.win)) {
    const held = r.win >= 0 || (btc.win < 0 && r.win > btc.win / 4);
    console.log(
      `  ${r.sym.padEnd(6)} ${sp(r.candle).padStart(8)}%  ${sp(r.win).padStart(8)}%  ${sp(r.low).padStart(7)}%  ${sp(r.high).padStart(7)}%  ${sp(r.win - btc.win).padStart(7)}${held ? "   ✅ HELD" : ""}`,
    );
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
