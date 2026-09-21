// ONE-OFF DATABASE INSPECTION ONLY. No architecture, no new streams,
// no implementation -- just reads and prints the REAL stored document
// structure for BTCUSDT liquidation events from the last 3 days.
//
//   node scripts/inspect-liq-doc-structure.js
//
// READ-ONLY.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const ORDER_BOOK_FIELD_HINTS = [
  "bid",
  "ask",
  "depth",
  "level",
  "wall",
  "orderbook",
  "order_book",
  "book",
];

function isoUtc(ms) {
  return new Date(ms).toISOString();
}

/** Recursively scans an object's OWN key names (not values) for
 *  anything that looks order-book-related, returning the dotted
 *  paths found. */
function scanKeysForOrderBookHints(obj, pathPrefix = "", found = []) {
  if (obj === null || typeof obj !== "object") return found;
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (ORDER_BOOK_FIELD_HINTS.some((hint) => lower.includes(hint)))
      found.push(path);
    const val = obj[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val))
      scanKeysForOrderBookHints(val, path, found);
    else if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object")
      scanKeysForOrderBookHints(val[0], `${path}[0]`, found);
  }
  return found;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - 3 * 86_400_000;

  console.log("=".repeat(110));
  console.log(
    `BTCUSDT liq_raw_events DOCUMENT STRUCTURE INSPECTION -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(110));

  // Fetch a handful of full, raw documents (no projection -- every field as stored).
  const sampleDocs = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .sort({ timestamp: -1 })
    .limit(3)
    .toArray();

  console.log(
    `\nFetched ${sampleDocs.length} raw document(s) (most recent first). Printing COMPLETE structure, no projection.\n`,
  );

  let anyOrderBookFieldFoundAnywhere = false;

  sampleDocs.forEach((doc, idx) => {
    console.log("-".repeat(110));
    console.log(`DOCUMENT #${idx + 1}`);
    console.log(`  timestamp: ${doc.timestamp} (${isoUtc(doc.timestamp)})`);
    console.log(`  side/victim: ${doc.victim ?? doc.side ?? "N/A"}`);
    console.log(`  price: ${doc.price}`);
    console.log(`  quoteQty (USD): ${doc.quoteQty}`);
    console.log("-".repeat(110));
    console.log("FULL RAW DOCUMENT:");
    console.log(JSON.stringify(doc, null, 2));

    const hints = scanKeysForOrderBookHints(doc);
    console.log(
      `\nORDER-BOOK-RELATED KEY NAMES FOUND (case-insensitive substring match on 'bid','ask','depth','level','wall','book'): ${hints.length > 0 ? hints.join(", ") : "NONE"}`,
    );
    if (hints.length > 0) anyOrderBookFieldFoundAnywhere = true;
    console.log("");
  });

  console.log(`${"=".repeat(110)}`);
  console.log(
    "ALSO SCANNING ACROSS A LARGER SAMPLE (200 docs) IN CASE THE FIELD IS SPARSE/OPTIONAL:",
  );
  const widerSample = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .limit(200)
    .toArray();
  const allKeysEverSeen = new Set();
  for (const d of widerSample)
    scanKeysForOrderBookHints(d).forEach((k) => allKeysEverSeen.add(k));
  console.log(
    `Order-book-related keys seen anywhere across ${widerSample.length} sampled documents: ${allKeysEverSeen.size > 0 ? [...allKeysEverSeen].join(", ") : "NONE"}`,
  );
  if (allKeysEverSeen.size > 0) anyOrderBookFieldFoundAnywhere = true;

  // Also print the full set of TOP-LEVEL field names actually present, for a complete picture.
  const topLevelKeys = new Set();
  for (const d of widerSample)
    Object.keys(d).forEach((k) => topLevelKeys.add(k));
  console.log(
    `\nALL top-level field names present across the sample: ${[...topLevelKeys].join(", ")}`,
  );

  console.log(`\n${"=".repeat(110)}`);
  console.log("ANSWER:");
  if (anyOrderBookFieldFoundAnywhere) {
    console.log(
      "Order-book-related field name(s) WERE found -- inspect the printed raw document(s) and key list above to",
    );
    console.log(
      "determine whether they actually contain individual [price, quantity] resting levels, or only aggregate",
    );
    console.log("figures (bestBid/bestAsk/depth totals/imbalance).");
  } else {
    console.log(
      "NO -- historical MongoDB liquidation events do not contain individual order-book levels, so we cannot",
    );
    console.log(
      'retrospectively see a specific wall such as "180 BTC resting at $60,500". The top-level fields actually',
    );
    console.log(
      "present are listed above -- compare against what would be needed for individual bid/ask levels.",
    );
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
