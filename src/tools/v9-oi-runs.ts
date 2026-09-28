/**
 * OI ACCUMULATIONS per coin (Johnny, Sep 28 2026): where the open interest grew minute after minute,
 * last N days, only our minute_bars. Prints the list and writes a TradingView script with circles.
 *
 *   npx tsx src/tools/v9-oi-runs.ts ADA                     (last 5 days)
 *   npx tsx src/tools/v9-oi-runs.ts ADA BTC --days 5 --per-day 10 --pause 3 --pine oi-runs.pine
 */
import "dotenv/config";
import * as fs from "fs";
import { MongoClient } from "mongodb";
import { findLiqBursts, findRuns, rankRuns, runsPine, type LiqBurst, type OiRow, type OiRun } from "../research/oi-runs";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const DAY = 86_400_000;
const num = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const fp = (v: number): string => (v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toFixed(5));
const yvn = (ms: number): string => new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const usd = (v: number): string => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);

function symbols(): string[] {
  const named = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  if (named.length) return named.map((a) => (a.toUpperCase().endsWith("USDT") ? a.toUpperCase() : `${a.toUpperCase()}USDT`));
  try {
    const cfg = JSON.parse(fs.readFileSync("users.config.json", "utf8")) as { v9?: { symbols?: string[] } };
    if (cfg.v9?.symbols?.length) return cfg.v9.symbols;
  } catch { /* default */ }
  return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "SUIUSDT"];
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const days = Number(arg("days", "5")), perDay = Number(arg("per-day", "10")), pause = Number(arg("pause", "3"));
  const pineOut = arg("pine", "oi-runs.pine");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const now = Date.now();
  const pine: Array<{ symbol: string; runs: OiRun[]; liqs: LiqBurst[] }> = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const s of symbols()) {
      const raw = await db.collection("minute_bars").find({ symbol: s, ts: { $gte: new Date(now - days * DAY) } })
        .project({ ts: 1, high: 1, low: 1, close: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 }).sort({ ts: 1 }).toArray();
      const rows: OiRow[] = raw.map((r) => ({ ts: num(r.ts), high: Number(r.high ?? 0), low: Number(r.low ?? 0), close: Number(r.close ?? 0), oi: Number(r.oiLast ?? 0), liqLong: Number(r.longLiqUsd ?? 0), liqShort: Number(r.shortLiqUsd ?? 0) }));
      const coin = s.replace("USDT", "");
      if (rows.length < 300) { console.log(`\n${coin}: not enough data`); continue; }
      const runs = rankRuns(findRuns(rows, pause));
      const shown = runs.filter((x) => x.rank <= perDay).sort((a, b) => a.at - b.at);
      const med = [...runs].sort((a, b) => a.usd - b.usd)[runs.length >> 1]?.usd ?? 0;
      const price = rows[rows.length - 1].close;
      console.log(`\n=== ${coin}  now ${fp(price)}  ${runs.length} OI runs in ${days} days (a normal one ${usd(med)}); the ${perDay} largest of every UTC day ===`);
      let day = "";
      for (const x of shown) {
        const d = new Date(x.at).toISOString().slice(0, 10);
        if (d !== day) { day = d; console.log(`  --- ${d} (UTC day) ---   #  start (Yerevan)  end    min  price where added  vs now       OI added              price during`); }
        const vs = x.price > price ? "above" : "below";
        console.log(`                          ${String(x.rank).padStart(2)}  ${yvn(x.from)}  ${yvn(x.to).slice(6)}  ${String(x.minutes).padStart(3)}  ${fp(x.price).padEnd(12)}      ${vs.padEnd(6)} ${`+${usd(x.usd)}`.padEnd(9)} (${x.xNormal.toFixed(0)}x normal)  ${x.movePct >= 0 ? "+" : ""}${x.movePct.toFixed(2)}% ${x.dir}`);
      }
      const liqs = [...findLiqBursts(rows, "LONG"), ...findLiqBursts(rows, "SHORT")];
      const top = liqs.filter((b) => b.rank <= perDay).sort((a, b) => a.at - b.at);
      console.log(`  LIQUIDATIONS: the ${perDay} largest bursts of every UTC day, each side`);
      day = "";
      for (const b of top) {
        const d = new Date(b.at).toISOString().slice(0, 10);
        if (d !== day) { day = d; console.log(`  --- ${d} (UTC day) ---   #  start (Yerevan)  end    min  price            vs now  liquidated`); }
        console.log(`                          ${String(b.rank).padStart(2)}  ${yvn(b.from)}  ${yvn(b.to).slice(6)}  ${String(b.minutes).padStart(3)}  ${fp(b.price).padEnd(12)}     ${(b.price > price ? "above" : "below").padEnd(6)}  ${b.side === "LONG" ? "LONGS " : "SHORTS"} ${usd(b.usd)}`);
      }
      pine.push({ symbol: s, runs, liqs });
    }
  } finally {
    await client.close();
  }
  fs.writeFileSync(pineOut, runsPine(pine, now, perDay));
  console.log(`\nRun = the OI grew minute after minute (pauses up to ${pause} min allowed; ends when 30% of the gain is given back).`);
  console.log(`Every UTC day its ${perDay} largest (#1 = the largest). In TradingView you can show fewer per day (settings). The circle sits on the candle of the run's strongest minute.`);
  console.log(`Liquidations: orange = longs liquidated, blue = shorts liquidated; darker = more $ that day.`);
  console.log(`TradingView script: ${pineOut}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
