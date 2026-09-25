/**
 * One-time (safe to re-run): condense the raw rows still in the database
 * (liq_raw_events, oi_second_observations -- a few days) into minute_bars,
 * so the long-term history starts from everything we already have.
 * The running bot keeps minute_bars up to date from then on.
 *
 *   npx tsx src/tools/minute-bars-backfill.ts
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { loadEnv } from "../config/env";
import { ensureMinuteBarIndexes, writeMinuteBars } from "../collector/minute-bars";

const HOUR = 3_600_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const client = new MongoClient(env.mongoUri);
  await client.connect();
  try {
    const db = client.db(env.mongoDb);
    await ensureMinuteBarIndexes(async () => db);
    const until = Math.floor(Date.now() / 60_000) * 60_000;
    for (const symbol of env.symbols) {
      const first = await db.collection("oi_second_observations").findOne({ symbol }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } });
      if (!first) { console.log(`${symbol}: no raw data`); continue; }
      let from = Math.floor(new Date(first.timestamp).getTime() / HOUR) * HOUR;
      let written = 0;
      for (; from < until; from += HOUR) written += await writeMinuteBars(db, symbol, from, Math.min(from + HOUR, until));
      console.log(`${symbol}: ${written} minute bars (${new Date(first.timestamp).toISOString().slice(0, 16)} -> now)`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
