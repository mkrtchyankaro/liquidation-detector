/**
 * V9: did BTC bring the coin to the signal level? (Johnny, Oct 1 2026) Read-only, LIVE-SAFE (only data up to the entry).
 * For every real V9 signal of a user (default main, no BTC itself, SL > --minsl): over the signal's episode
 * (episode start -> entry) how much of the coin's move BTC explains (beta from the hours before the episode), and
 * the final result of the trade (re-run with --tp on minute bars) split by "BTC brought it" / "the coin itself".
 * See preMove() in src/research/v9-own-move.ts.
 *
 *   npx tsx src/tools/v9-pre-btc.ts --days 8 --tp 1.5 --minsl 0.7
 *   options: --user main  --betah 24  --risk 10  --timestop 24  --list
 * Note: no max-open limit here (every signal counted on its own).
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { preMove, type OwnBar, type PreMove } from "../research/v9-own-move";
import {
  simTrade,
  type TpOpts,
  type TpResult,
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
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"),
    days = Number(arg("days", "8")),
    betaH = Number(arg("betah", "24")),
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
    const list = docs
      .map((d) => ({
        signalId: String(d.signalId),
        t: {
          id: String(d.tradeId),
          symbol: String(d.symbol),
          side: d.side,
          createdAt: num(d.createdAt),
          entry: Number(d.entryPrice),
          sl: Number(d.slInitial ?? d.slPrice),
        } as TpTrade,
      }))
      .filter(
        ({ t }) =>
          t.createdAt >= since &&
          t.entry > 0 &&
          t.sl > 0 &&
          t.entry !== t.sl &&
          t.symbol !== "BTCUSDT" &&
          (100 * Math.abs(t.entry - t.sl)) / t.entry > o.minSlPct,
      )
      .sort((a, b) => a.t.createdAt - b.t.createdAt);
    const cache = new Map<string, OwnBar[]>();
    const load = async (s: string): Promise<OwnBar[]> => {
      if (!cache.has(s)) {
        const rows = await db
          .collection(MINUTE_BARS)
          .find({
            symbol: s,
            ts: { $gte: new Date(since - (betaH + 48) * 3_600_000) },
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
    const rows: Array<{ t: TpTrade; p: PreMove; res: TpResult }> = [];
    let skipped = 0;
    for (const { signalId, t } of list) {
      const dec = await db.collection("v9_decisions").findOne({ signalId });
      const coin = await load(t.symbol);
      const p = dec
        ? preMove(t, coin, btc, num(dec.episodeStart), betaH)
        : null;
      const res = simTrade(t, coin, o);
      if (!p || res.status === "OPEN") {
        skipped++;
        continue;
      }
      rows.push({ t, p, res });
    }
    console.log(
      `V9 · did BTC bring the coin to the signal? (episode start -> entry, known at the entry) · user ${user} · ${rows.length} signals (${skipped} skipped: no data / still open) · last ${days} days · TP ${o.tpR}R · beta from ${betaH}h before the episode · UTC\n`,
    );
    const grp = (name: string, g: typeof rows): void => {
      console.log(
        `   ${name} ${String(g.length).padStart(2)} signals: TP ${g.filter((x) => x.res.status === "TP").length} · SL ${g.filter((x) => x.res.status === "SL").length} · other ${g.filter((x) => x.res.status !== "TP" && x.res.status !== "SL").length} · ${sR(g.reduce((s, x) => s + x.res.r, 0))}`,
      );
    };
    grp(
      "BTC brought it (BTC part >= own part)",
      rows.filter((x) => x.p.byBtc),
    );
    grp(
      "the coin itself (own part > BTC part)",
      rows.filter((x) => !x.p.byBtc),
    );
    grp("all                                  ", rows);
    if (argv.includes("--list")) {
      console.log("");
      for (const x of rows)
        console.log(
          `     ${utc(x.t.createdAt)} ${x.t.symbol.padEnd(9)} ${x.t.side.padEnd(5)} ${String(x.p.minutes).padStart(4)}m beta ${x.p.beta.toFixed(2)} coin ${sp(x.p.coinPct).padStart(7)} BTC ${sp(x.p.btcPct).padStart(7)} -> BTC part ${sp(x.p.btcPart).padStart(7)} own ${sp(x.p.own).padStart(7)} ${x.p.byBtc ? "BTC " : "COIN"} -> ${x.res.status} ${sR(x.res.r)}`,
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
