/**
 * V9 WHAT-IF: other TP / min stop / max open on the REAL live signals (Johnny, Sep 30 2026). Read-only.
 * Takes the trades the live bot really opened for a user (default main = every V9 signal, PAPER), keeps their
 * exact entry and stop, and re-runs them on minute_bars with each TP. See src/research/v9-tp-sim.ts.
 *
 *   npx tsx src/tools/v9-tp.ts --days 7 --tp 1.5,2.2 --minsl 0.7 --maxopen 2
 *   options: --user main  --risk 10  --timestop 24 (0 = none)  --list (every trade)
 * Note: the symbol lock is as it was live (with 2.2R exits) -- with an earlier TP some locked signals would have
 * come, those are not in the data.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  simPortfolio,
  type TpBar,
  type TpOpts,
  type TpTrade,
} from "../research/v9-tp-sim";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"),
    days = Number(arg("days", "7")),
    risk = Number(arg("risk", "10"));
  const tps = arg("tp", "1.5,2.2").split(",").map(Number),
    minSl = Number(arg("minsl", "0"));
  const maxOpen =
      arg("maxopen", "0") === "0" ? null : Number(arg("maxopen", "0")),
    ts = Number(arg("timestop", "24"));
  if (tps.some((x) => !(x > 0)) || !(days > 0) || !(risk > 0))
    throw new Error("bad --tp / --days / --risk");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const since = Date.now() - days * 86_400_000;
    const docs = await db
      .collection("v9_trades")
      .find({
        userId: user,
        entryPrice: { $ne: null },
        state: { $in: ["OPEN", "CLOSED"] },
      })
      .toArray();
    const trades: TpTrade[] = docs
      .map((d) => ({
        id: String(d.tradeId),
        symbol: String(d.symbol),
        side: d.side,
        createdAt: num(d.createdAt),
        entry: Number(d.entryPrice),
        sl: Number(d.slPrice),
      }))
      .filter(
        (t) =>
          t.createdAt >= since && t.entry > 0 && t.sl > 0 && t.entry !== t.sl,
      );
    const bars = new Map<string, TpBar[]>();
    for (const s of new Set(trades.map((t) => t.symbol))) {
      const rows = await db
        .collection(MINUTE_BARS)
        .find({
          symbol: s,
          ts: { $gte: new Date(since - 3_600_000) },
          high: { $ne: null },
        })
        .sort({ ts: 1 })
        .toArray();
      bars.set(
        s,
        rows.map((r) => ({
          t: num(r.ts),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
        })),
      );
    }
    const dayKeys = [
      ...new Set(
        trades.map((t) => new Date(t.createdAt).toISOString().slice(0, 10)),
      ),
    ].sort();
    console.log(
      `V9 what-if · user ${user} · ${trades.length} signals · last ${days} days · risk $${risk} · min SL > ${minSl}% · max open ${maxOpen ?? "none"} · time stop ${ts || "none"}h · UTC\n`,
    );
    for (const tpR of tps) {
      const o: TpOpts = {
        tpR,
        minSlPct: minSl,
        maxOpen,
        timeStopH: ts > 0 ? ts : null,
        riskUsd: risk,
      };
      const { taken, skipped } = simPortfolio(
        trades,
        (s) => bars.get(s) ?? [],
        o,
      );
      const done = taken.filter((x) => x.status !== "OPEN"),
        R = done.reduce((a, x) => a + x.r, 0);
      const c = (s: string): number =>
        taken.filter((x) => x.status === s).length;
      const nDays = Math.max(1, dayKeys.length);
      console.log(
        `TP ${tpR}R: taken ${taken.length} (skipped: min SL ${skipped.filter((x) => x.why === "MIN_SL").length}, max open ${skipped.filter((x) => x.why === "MAX_OPEN").length})`,
      );
      console.log(
        `   TP ${c("TP")} · SL ${c("SL")} · time stop ${c("TIME")} · still open ${c("OPEN")} · win ${done.length ? ((100 * c("TP")) / done.length).toFixed(0) : 0}%`,
      );
      console.log(
        `   total ${sR(R)} = $${(R * risk).toFixed(0)} · per day (${nDays} days) ${sR(R / nDays)} = $${((R * risk) / nDays).toFixed(1)}`,
      );
      console.log(
        `   by day: ${dayKeys.map((d) => `${d.slice(5)} ${sR(done.filter((x) => new Date(x.trade.createdAt).toISOString().startsWith(d)).reduce((a, x) => a + x.r, 0))}`).join(" · ")}`,
      );
      if (argv.includes("--list"))
        for (const x of taken)
          console.log(
            `     ${utc(x.trade.createdAt)} ${x.trade.symbol.padEnd(9)} ${x.trade.side.padEnd(5)} SL ${x.slPct.toFixed(2)}%  ${x.status.padEnd(4)} ${sR(x.r)}`,
          );
      console.log("");
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
