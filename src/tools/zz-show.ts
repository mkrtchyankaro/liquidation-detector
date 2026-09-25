/**
 * ZZ PAPER decisions from the database (zz_paper_trades): every A/B episode
 * the live service saw, traded or skipped, with entry / TP / SL and result.
 *
 *   npx tsx src/tools/zz-show.ts              # last 20
 *   npx tsx src/tools/zz-show.ts --n 50 --symbol SOL
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { loadEnv } from "../config/env";
import { ZZ_TRADES, type ZzTradeDoc } from "../strategy/zz/zz-paper.service";
import { fmtPrice } from "../strategy/v9/v9-telegram";

const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const utc = (ms: number | null): string => (ms ? new Date(ms).toISOString().slice(5, 16).replace("T", " ") : "-");

async function main(): Promise<void> {
  const env = loadEnv();
  const client = new MongoClient(env.mongoUri);
  await client.connect();
  try {
    const sym = arg("symbol", "");
    const q = sym ? { symbol: sym.toUpperCase().endsWith("USDT") ? sym.toUpperCase() : `${sym.toUpperCase()}USDT` } : {};
    const docs = await client.db(env.mongoDb).collection<ZzTradeDoc>(ZZ_TRADES).find(q).sort({ decidedTs: -1 }).limit(Number(arg("n", "20"))).toArray();
    const pct = (p: number | null, e: number): string => (p === null ? "-" : `${p >= e ? "+" : "-"}${((100 * Math.abs(p - e)) / e).toFixed(2)}%`);
    console.log("TIME (UTC)   SYMBOL     GR SIDE  ENTRY        TP (dist)                SL (dist)                STATE    RESULT  netR   reason");
    for (const d of docs.reverse()) {
      console.log(`${utc(d.decidedTs)}  ${d.symbol.padEnd(9)}  ${d.grade}  ${(d.side === "LONG" ? "BUY" : d.side === "SHORT" ? "SELL" : "-").padEnd(4)}  ${fmtPrice(d.entry).padEnd(11)}  ${`${fmtPrice(d.tpPrice)} (${pct(d.tpPrice, d.entry)})`.padEnd(23)}  ${`${fmtPrice(d.slPrice)} (${pct(d.slPrice, d.entry)})`.padEnd(23)}  ${d.state.padEnd(7)}  ${(d.result ?? "-").padEnd(6)}  ${d.netR !== null ? d.netR.toFixed(2) : "-".padEnd(4)}   ${d.skipReason ?? ""}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
