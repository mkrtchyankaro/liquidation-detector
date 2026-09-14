/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY. Prints every raw
 * liquidation event for BTCUSDT in the exact requested window,
 * unmodified, with totals. No grouping, no P95, no waves, no
 * episodes, no filtering of any kind.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const SYMBOL = "BTCUSDT";
const START_ISO = "2026-09-10T16:30:00.000Z";
const END_ISO = "2026-09-10T16:40:00.000Z";

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const col = db.collection("liq_raw_events");

  const startTs = Date.parse(START_ISO);
  const endTs = Date.parse(END_ISO);

  const events = await col
    .find({ symbol: SYMBOL, timestamp: { $gte: startTs, $lte: endTs } })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(
    SYMBOL +
      " raw liquidation events, " +
      START_ISO +
      " to " +
      END_ISO +
      "  (n=" +
      events.length +
      ")\n",
  );
  console.log("timestamp (UTC) | victim | price | quoteQty");
  console.log("-".repeat(70));

  let longUsd = 0,
    shortUsd = 0,
    longCount = 0,
    shortCount = 0;
  for (const e of events) {
    console.log(
      new Date(e.timestamp).toISOString() +
        " | " +
        e.victim +
        " | " +
        e.price +
        " | " +
        e.quoteQty,
    );
    if (e.victim === "LONG") {
      longUsd += e.quoteQty;
      longCount++;
    } else {
      shortUsd += e.quoteQty;
      shortCount++;
    }
  }

  console.log("\n" + "-".repeat(70));
  console.log("total LONG liquidation USD: " + longUsd.toFixed(4));
  console.log("total SHORT liquidation USD: " + shortUsd.toFixed(4));
  console.log("LONG event count: " + longCount);
  console.log("SHORT event count: " + shortCount);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
