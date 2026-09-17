import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";

/**
 * Sep 17 2026 (Karo), operator-requested retention pass.
 *
 *   npx tsx scripts/retention-audit.ts
 *
 * READ ONLY -- no write/delete/index call anywhere in this file, only
 * countDocuments() and listIndexes(). Run this BEFORE and AFTER
 * applying the retention changes to get real proof from the actual
 * Mongo instance, not just source inspection.
 */

function mongoConfig(): MongoDetectorConfig {
  return {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
}

interface Target {
  collection: string;
  db: "shared" | "own";
  timestampField: string;
}
const TARGETS: Target[] = [
  { collection: "liq_raw_events", db: "own", timestampField: "eventTimeDate" },
  {
    collection: "liq_minute_aggregates",
    db: "shared",
    timestampField: "createdAt",
  },
  {
    collection: "oi_second_observations",
    db: "own",
    timestampField: "timestamp",
  },
];

async function main(): Promise<void> {
  const cfg = mongoConfig();
  const mongo = new MongoClientWrapper(cfg);
  const sharedDb = await mongo.ensureShared();
  const ownDb = await mongo.ensureOwn();
  if (sharedDb === null || ownDb === null) {
    console.error("MONGO_URI not set or Mongo unavailable.");
    await mongo.close();
    process.exit(1);
  }

  console.log(`Shared DB (MONGO_SHARED_DB): ${cfg.sharedMarketDataDb}`);
  console.log(`Own DB (MONGO_OWN_DB): ${cfg.ownDb}\n`);

  for (const t of TARGETS) {
    const db = t.db === "shared" ? sharedDb : ownDb;
    const dbName = t.db === "shared" ? cfg.sharedMarketDataDb : cfg.ownDb;
    const coll = db.collection(t.collection);
    const count = await coll.countDocuments({});
    const indexes = await coll.listIndexes().toArray();

    console.log(`${t.collection}  (db: ${dbName})`);
    console.log(`  document count: ${count}`);
    console.log(`  intended TTL field: ${t.timestampField}`);
    console.log("  indexes:");
    for (const ix of indexes) {
      const ttl =
        typeof (ix as { expireAfterSeconds?: number }).expireAfterSeconds ===
        "number"
          ? `  TTL expireAfterSeconds=${(ix as { expireAfterSeconds: number }).expireAfterSeconds} (${((ix as { expireAfterSeconds: number }).expireAfterSeconds / 86400).toFixed(2)} days)`
          : "";
      console.log(`    ${ix.name}: ${JSON.stringify(ix.key)}${ttl}`);
    }
    const sample = await coll.findOne({
      [t.timestampField]: { $exists: true },
    } as Record<string, unknown>);
    const val = sample
      ? (sample as Record<string, unknown>)[t.timestampField]
      : undefined;
    console.log(
      `  sample ${t.timestampField} BSON type: ${val instanceof Date ? "Date" : typeof val}`,
    );
    console.log("");
  }

  await mongo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
