/**
 * OI ACCUMULATIONS per coin (Johnny, Sep 28 2026): where the open interest grew minute after minute,
 * last N days, only our minute_bars. Prints the list and writes a TradingView script with circles.
 *
 *   npx tsx src/tools/v9-oi-runs.ts ADA                     (last 5 days)
 *   npx tsx src/tools/v9-oi-runs.ts ADA BTC --days 5 --top 15 --times 3 --pause 3 --pine oi-runs.pine
 */
import "dotenv/config";
import * as fs from "fs";
import { MongoClient } from "mongodb";
import { findRuns, markRuns, runsPine, type OiRow, type OiRun } from "../research/oi-runs";

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
  const days = Number(arg("days", "5")), topN = Number(arg("top", "15")), times = Number(arg("times", "3")), pause = Number(arg("pause", "3"));
  const pineOut = arg("pine", "oi-runs.pine");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const now = Date.now();
  const pine: Array<{ symbol: string; runs: OiRun[] }> = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const s of symbols()) {
      const raw = await db.collection("minute_bars").find({ symbol: s, ts: { $gte: new Date(now - days * DAY) } })
        .project({ ts: 1, high: 1, low: 1, close: 1, oiLast: 1 }).sort({ ts: 1 }).toArray();
      const rows: OiRow[] = raw.map((r) => ({ ts: num(r.ts), high: Number(r.high ?? 0), low: Number(r.low ?? 0), close: Number(r.close ?? 0), oi: Number(r.oiLast ?? 0) }));
      const coin = s.replace("USDT", "");
      if (rows.length < 300) { console.log(`\n${coin}: not enough data`); continue; }
      const runs = markRuns(findRuns(rows, pause), topN, times);
      const shown = runs.filter((x) => x.top || x.big).sort((a, b) => a.from - b.from);
      const med = [...runs].sort((a, b) => a.usd - b.usd)[runs.length >> 1]?.usd ?? 0;
      console.log(`\n=== ${coin}  now ${fp(rows[rows.length - 1].close)}  ${runs.length} OI runs in ${days} days, a normal run ${usd(med)}; shown: top ${topN} (T) and >= ${times}x normal (x) ===`);
      console.log("  start (Yerevan)   end    min   price where added   range              OI added          price   ");
      for (const x of shown) {
        const tag = `${x.top ? "T" : " "}${x.big ? "x" : " "}`;
        console.log(`  ${tag} ${yvn(x.from)}  ${yvn(x.to).slice(6)}  ${String(x.minutes).padStart(4)}   ${fp(x.price).padEnd(12)}  ${`${fp(x.lo)}-${fp(x.hi)}`.padEnd(20)} +${usd(x.usd).padEnd(8)} (${x.xNormal.toFixed(1)}x, +${x.oiPct.toFixed(2)}%)  ${x.movePct >= 0 ? "+" : ""}${x.movePct.toFixed(2)}% ${x.dir}`);
      }
      pine.push({ symbol: s, runs });
    }
  } finally {
    await client.close();
  }
  fs.writeFileSync(pineOut, runsPine(pine, now, times, topN));
  console.log(`\nRun = the OI grew minute after minute (pauses up to ${pause} min allowed; ends when 30% of the gain is given back).`);
  console.log(`T = one of the ${topN} largest, x = at least ${times}x the coin's normal run. In TradingView pick "show": top / ${times}x / both.`);
  console.log(`TradingView script: ${pineOut}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
