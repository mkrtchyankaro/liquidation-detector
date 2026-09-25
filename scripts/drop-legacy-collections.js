#!/usr/bin/env node
/**
 * One-time cleanup of MongoDB collections the old bot (LOX / V5 / research)
 * used to write. The V9 bot only uses the collections in KEEP.
 *
 *   node scripts/drop-legacy-collections.js            # dry run: lists what WOULD be dropped
 *   node scripts/drop-legacy-collections.js --confirm  # actually drops them
 *
 * Only the bot's own database (MONGO_OWN_DB) is touched.
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");

const KEEP = new Set(["liq_raw_events", "oi_second_observations", "v9_decisions", "v9_trades", "v9_episode_timeline", "market_positioning_5m", "market_premium_1m", "minute_bars"]);
const confirm = process.argv.includes("--confirm");

(async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const dbName = process.env.MONGO_OWN_DB ?? "liquidation_detector";
    const db = client.db(dbName);
    const all = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
    const drop = all.filter((n) => !KEEP.has(n)).sort();
    console.log(`database: ${dbName}`);
    console.log(`keep (${[...KEEP].filter((n) => all.includes(n)).length}): ${[...KEEP].filter((n) => all.includes(n)).join(", ")}`);
    for (const n of drop) console.log(`${confirm ? "dropping" : "would drop"}: ${n} (${await db.collection(n).estimatedDocumentCount()} docs)`);
    if (!confirm) { console.log("\nDry run. Re-run with --confirm to drop."); return; }
    for (const n of drop) await db.collection(n).drop();
    console.log(`\ndropped ${drop.length} collection(s).`);
  } finally {
    await client.close();
  }
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
