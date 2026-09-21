// Sep 20 2026 (Karo), operator-requested. SIMPLE, standalone check --
// pulls ONLY BTCUSDT liquidation events directly from liq_raw_events,
// keeps only the LARGE ones (> P95 of BTC's own event sizes in this
// window), groups them into episodes (start/end, UTC), and prints a
// plain table -- so the operator can open a chart and manually verify
// these episode boundaries make sense, independent of any other
// script in this project.
//
//   node scripts/btc-large-liquidation-episodes.js 3 10
//
// (arg1 = days back, default 3; arg2 = gap-merge minutes between
// large events to count as the same episode, default 10)
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No ATR,
// no OI, no Binance API calls -- purely liq_raw_events, so this can't
// inherit any bug from the other, more complex scripts in this
// session.

require("dotenv/config");
const { MongoClient } = require("mongodb");

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
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

async function main() {
  const days = Number(process.argv[2] ?? "3");
  const gapMergeMin = Number(process.argv[3] ?? "10");
  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(100));
  console.log(
    `BTCUSDT LARGE LIQUIDATION EPISODES (>P95) -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log(
    "Source: liq_raw_events collection, BTCUSDT only. No other script's logic reused.",
  );
  console.log("=".repeat(100));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(
    `\nLoaded ${events.length} total BTCUSDT liquidation events in this window.`,
  );

  const sizes = events.map((e) => e.quoteQty ?? 0).sort((a, b) => a - b);
  const p95 = percentile(sizes, 95);
  console.log(`P95 event size (this window): ${fmtUsd(p95)}`);

  const largeEvents = events.filter((e) => (e.quoteQty ?? 0) > p95);
  console.log(`Large events (> P95): ${largeEvents.length}\n`);

  if (largeEvents.length === 0) {
    console.log("No large events found -- nothing to group into episodes.");
    await client.close();
    return;
  }

  const episodes = [];
  let current = [largeEvents[0]];
  for (let i = 1; i < largeEvents.length; i++) {
    const gapMs = largeEvents[i].timestamp - largeEvents[i - 1].timestamp;
    if (gapMs <= gapMergeMin * 60 * 1000) {
      current.push(largeEvents[i]);
    } else {
      episodes.push(current);
      current = [largeEvents[i]];
    }
  }
  episodes.push(current);

  console.log(
    `Grouped into ${episodes.length} episode(s) (gap-merge <= ${gapMergeMin} min):\n`,
  );
  console.log(
    "EPISODE   START (UTC)              END (UTC)                DURATION   EVENTS   TOTAL $        LONG$/SHORT$          PRICE RANGE",
  );
  console.log("-".repeat(130));

  episodes.forEach((ep, i) => {
    const startMs = ep[0].timestamp;
    const endMs = ep[ep.length - 1].timestamp;
    const durationMin = (endMs - startMs) / 60000;
    const totalUsd = ep.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const longUsd = ep
      .filter((e) => e.victim === "LONG")
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const shortUsd = ep
      .filter((e) => e.victim === "SHORT")
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const prices = ep.map((e) => e.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    console.log(
      `${String(i + 1).padStart(7)}   ${isoUtc(startMs).padEnd(24)} ${isoUtc(endMs).padEnd(24)} ${durationMin.toFixed(1).padStart(7)}m   ${String(ep.length).padStart(6)}   ${fmtUsd(totalUsd).padEnd(14)} ${fmtUsd(longUsd)}/${fmtUsd(shortUsd).padEnd(10)}   ${minPrice} - ${maxPrice}`,
    );
  });

  console.log(`\n${"=".repeat(100)}`);
  console.log(
    `TOTAL: ${episodes.length} large BTCUSDT liquidation episode(s) in ${days} day(s).`,
  );
  console.log(
    "Open a BTC chart for the exact UTC start/end times above and check by eye whether these boundaries match",
  );
  console.log(
    "what you see. This script does nothing but read liq_raw_events, filter by P95, and gap-merge -- no ATR,",
  );
  console.log(
    "no OI, no candle logic, no dependency on any other script in this session.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
