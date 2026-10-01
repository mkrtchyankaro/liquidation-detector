/**
 * V9: HOW MUCH WAS BTC TO BLAME for each closed trade (Johnny, Oct 1 2026). Read-only, our own minute_bars.
 * For every closed V9 trade of a user (default main = every signal): what the coin did in the trade's direction,
 * what BTC did over the same minutes, how strongly the coin amplified BTC, and how much of the coin's minute moves
 * BTC explains (R2). Then the same numbers per result (TP / SL / other). See src/research/v9-btc-blame.ts.
 *
 *   npx tsx src/tools/v9-btc-blame.ts --days 8
 *   options: --user main
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { blameOf, type Blame, type BlameBar } from "../research/v9-btc-blame";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const M = 60_000;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"),
    days = Number(arg("days", "8"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const since = Date.now() - days * 86_400_000;
    const trades = (
      await db
        .collection("v9_trades")
        .find({ userId: user, state: "CLOSED", entryPrice: { $ne: null } })
        .toArray()
    )
      .filter((t) => num(t.createdAt) >= since && t.closedAt)
      .sort((a, b) => num(a.createdAt) - num(b.createdAt));
    const bars = new Map<string, BlameBar[]>();
    const load = async (s: string): Promise<BlameBar[]> => {
      if (!bars.has(s)) {
        const rows = await db
          .collection(MINUTE_BARS)
          .find({
            symbol: s,
            ts: { $gte: new Date(since - 3_600_000) },
            close: { $ne: null },
          })
          .sort({ ts: 1 })
          .toArray();
        bars.set(
          s,
          rows.map((r) => ({ t: num(r.ts), close: Number(r.close) })),
        );
      }
      return bars.get(s)!;
    };
    const btc = await load("BTCUSDT");
    console.log(
      `V9 · how much was BTC to blame · user ${user} · ${trades.length} closed trades · last ${days} days · UTC`,
    );
    console.log(
      `coin / BTC = the move in the TRADE's direction (- = against the trade) · x = coin move / BTC move · R2 = share of the coin's minute moves explained by BTC\n`,
    );
    const rows: Array<{ res: string; b: Blame }> = [];
    for (const t of trades) {
      const res =
        t.closeReason === "TP_FILLED"
          ? "TP"
          : t.closeReason === "SL_FILLED"
            ? "SL"
            : String(t.closeReason ?? "?");
      const from = Math.floor(num(t.createdAt) / M) * M,
        to = Math.floor(num(t.closedAt) / M) * M;
      const coin = t.symbol === "BTCUSDT" ? btc : await load(String(t.symbol));
      const b = blameOf(t.side, coin, btc, from, to);
      if (!b) {
        console.log(
          `  ${utc(from)} ${String(t.symbol).padEnd(9)} ${String(t.side).padEnd(5)} ${res.padEnd(9)} (no minute data)`,
        );
        continue;
      }
      if (t.symbol !== "BTCUSDT") rows.push({ res, b });
      console.log(
        `  ${utc(from)} ${String(t.symbol).padEnd(9)} ${String(t.side).padEnd(5)} ${res.padEnd(9)} ${String(Math.round(b.minutes)).padStart(4)} min  coin ${sp(b.coinPct).padStart(7)}  BTC ${sp(b.btcPct).padStart(7)}${b.btcPct < 0 ? " against" : "        "}  x${b.ratio === null ? " n/a" : b.ratio.toFixed(2).padStart(5)}  R2 ${b.r2 === null ? "n/a" : b.r2.toFixed(2)}${t.symbol === "BTCUSDT" ? "  (BTC itself)" : ""}`,
      );
    }
    console.log(`\nSUMMARY (BTC's own trades left out)`);
    const avg = (v: number[]): string =>
      v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : "n/a";
    for (const res of [...new Set(rows.map((r) => r.res))]) {
      const g = rows.filter((r) => r.res === res);
      const against = g.filter((r) => r.b.btcPct < 0).length;
      console.log(
        `  ${res.padEnd(9)} ${String(g.length).padStart(3)} trades · BTC went against the trade in ${against} (${Math.round((100 * against) / g.length)}%) · avg BTC ${avg(g.map((r) => r.b.btcPct))}% · avg coin ${avg(g.map((r) => r.b.coinPct))}% · avg R2 ${avg(g.map((r) => r.b.r2 ?? NaN).filter(Number.isFinite))}`,
      );
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
