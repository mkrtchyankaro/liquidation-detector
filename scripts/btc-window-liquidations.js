// Sep 20 2026 (Karo), operator-requested. Lists EVERY BTCUSDT
// liquidation event (LONG and SHORT victims both) in a specific UTC
// window, straight from liq_raw_events. READ-ONLY.
//
//   node scripts/btc-window-liquidations.js "2026-09-21 01:00" "2026-09-21 01:55"
//
// NOTE ON ORDER BOOK DEPTH: this project does not store historical
// order-book depth anywhere (no depth-snapshot collection exists),
// and Binance's public API only exposes CURRENT depth, not
// historical -- there is no way to retroactively ask "what was the
// depth at 01:00 UTC". This script covers liquidations only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

function parseArgTime(s) {
  const iso = s.includes("T")
    ? s
    : s.replace(" ", "T") + (s.length <= 16 ? ":00Z" : "Z");
  const d = new Date(iso);
  if (isNaN(d.getTime()))
    throw new Error(
      `Could not parse time: "${s}" -- use "YYYY-MM-DD HH:mm" (UTC)`,
    );
  return d;
}
function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}

async function main() {
  const startArg = process.argv[2];
  const endArg = process.argv[3];
  if (!startArg || !endArg) {
    console.error(
      'Usage: node scripts/btc-window-liquidations.js "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm"  (UTC)',
    );
    process.exit(1);
  }
  const windowStartMs = parseArgTime(startArg).getTime();
  const windowEndMs = parseArgTime(endArg).getTime();

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(100));
  console.log(
    `BTCUSDT LIQUIDATIONS -- ${isoUtc(windowStartMs)} to ${isoUtc(windowEndMs)}`,
  );
  console.log("=".repeat(100));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: windowStartMs, $lte: windowEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(`\nTotal events: ${events.length}\n`);

  if (events.length === 0) {
    console.log("No BTCUSDT liquidations in this window.");
    await client.close();
    return;
  }

  console.log("TIME (UTC)               SIDE     PRICE          USD");
  console.log("-".repeat(70));
  let longUsd = 0;
  let shortUsd = 0;
  let longCount = 0;
  let shortCount = 0;
  for (const e of events) {
    console.log(
      `${isoUtc(e.timestamp).padEnd(25)} ${(e.victim ?? "?").padEnd(8)} ${String(e.price).padEnd(14)} ${fmtUsd(e.quoteQty)}`,
    );
    if (e.victim === "LONG") {
      longUsd += e.quoteQty ?? 0;
      longCount++;
    } else if (e.victim === "SHORT") {
      shortUsd += e.quoteQty ?? 0;
      shortCount++;
    }
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`TOTAL: ${events.length} event(s)`);
  console.log(
    `  LONG victims (price falling, longs force-closed):  ${longCount} event(s), ${fmtUsd(longUsd)}`,
  );
  console.log(
    `  SHORT victims (price rising, shorts force-closed): ${shortCount} event(s), ${fmtUsd(shortUsd)}`,
  );
  console.log(`  Combined total: ${fmtUsd(longUsd + shortUsd)}`);
  console.log(
    "\nOrder book depth is NOT available (no historical depth data stored anywhere, and Binance's public API",
  );
  console.log(
    "only exposes current depth, not historical) -- this covers liquidations only.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
