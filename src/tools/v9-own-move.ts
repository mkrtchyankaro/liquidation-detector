/**
 * V9: is the trade's profit the coin's OWN move or just BTC? (Johnny, Oct 1 2026) Read-only, live-safe.
 * For every real V9 signal of a user (default main) with SL > --minsl: beta to BTC from the hours before the entry,
 * then at k minutes after the entry the coin's own move (coin - beta x BTC). Shows how the final results split by
 * own > 0 / own <= 0, and what the rule "close at k when own <= 0" would have given. See src/research/v9-own-move.ts.
 *
 *   npx tsx src/tools/v9-own-move.ts --days 8 --at 15,30,60,120 --tp 1.5 --minsl 0.7
 *   options: --user main  --betah 24 (hours before the entry for beta)  --risk 10  --timestop 24  --list
 * Note: no max-open limit here (every signal counted on its own).
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { ownCheck, type OwnBar, type OwnCheck } from "../research/v9-own-move";
import type { TpOpts, TpTrade } from "../research/v9-tp-sim";

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
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"),
    days = Number(arg("days", "8")),
    betaH = Number(arg("betah", "24"));
  const ks = arg("at", "15,30,60,120").split(",").map(Number),
    ts = Number(arg("timestop", "24"));
  const o: TpOpts = {
    tpR: Number(arg("tp", "1.5")),
    minSlPct: Number(arg("minsl", "0.7")),
    maxOpen: null,
    timeStopH: ts > 0 ? ts : null,
    riskUsd: Number(arg("risk", "10")),
  };
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
        sl: Number(d.slInitial ?? d.slPrice),
      }))
      .filter(
        (t) =>
          t.createdAt >= since &&
          t.entry > 0 &&
          t.sl > 0 &&
          t.entry !== t.sl &&
          t.symbol !== "BTCUSDT" &&
          (100 * Math.abs(t.entry - t.sl)) / t.entry > o.minSlPct,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const cache = new Map<string, OwnBar[]>();
    const load = async (s: string): Promise<OwnBar[]> => {
      if (!cache.has(s)) {
        const rows = await db
          .collection(MINUTE_BARS)
          .find({
            symbol: s,
            ts: { $gte: new Date(since - (betaH + 2) * 3_600_000) },
            close: { $ne: null },
          })
          .sort({ ts: 1 })
          .toArray();
        cache.set(
          s,
          rows.map((r) => ({
            t: num(r.ts),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.close),
          })),
        );
      }
      return cache.get(s)!;
    };
    const btc = await load("BTCUSDT");
    console.log(
      `V9 · OWN move vs BTC during the trade · user ${user} · ${trades.length} signals (no BTC, SL > ${o.minSlPct}%) · last ${days} days · TP ${o.tpR}R · beta from ${betaH}h before the entry · UTC\n`,
    );
    for (const k of ks) {
      const rows: OwnCheck[] = [];
      for (const t of trades) {
        const c = ownCheck(t, await load(t.symbol), btc, k, betaH, o);
        if (c && c.base.status !== "OPEN") rows.push(c);
      }
      const open = rows.filter((r) => r.openAtK);
      const grp = (g: OwnCheck[]): string =>
        `${String(g.length).padStart(2)} trades: TP ${g.filter((x) => x.base.status === "TP").length} · SL ${g.filter((x) => x.base.status === "SL").length} · other ${g.filter((x) => x.base.status !== "TP" && x.base.status !== "SL").length} · ${sR(g.reduce((s, x) => s + x.base.r, 0))}`;
      const base = rows.reduce((s, x) => s + x.base.r, 0),
        ruled = rows.reduce((s, x) => s + x.ruled.r, 0);
      console.log(
        `AT ${k} min after the entry: ${open.length} of ${rows.length} trades still open`,
      );
      console.log(
        `   own > 0  (coin ahead of what BTC explains)  ${grp(open.filter((x) => x.own > 0))}`,
      );
      console.log(
        `   own <= 0 (only BTC, or the coin lags)        ${grp(open.filter((x) => x.own <= 0))}`,
      );
      console.log(
        `   RULE close at ${k} min when own <= 0: ${sR(ruled)} vs without the rule ${sR(base)}  (${ruled - base >= 0 ? "+" : ""}${(ruled - base).toFixed(2)}R = $${((ruled - base) * o.riskUsd).toFixed(0)})`,
      );
      if (argv.includes("--list"))
        for (const x of open)
          console.log(
            `     ${utc(x.trade.createdAt)} ${x.trade.symbol.padEnd(9)} ${x.trade.side.padEnd(5)} beta ${x.beta.toFixed(2)} coin ${sp(x.coinPct)} BTC ${sp(x.btcPct)} own ${sp(x.own)} -> ${x.base.status} ${sR(x.base.r)}${x.ruled.closedByRule ? `  | rule: closed ${sR(x.ruled.r)}` : ""}`,
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
