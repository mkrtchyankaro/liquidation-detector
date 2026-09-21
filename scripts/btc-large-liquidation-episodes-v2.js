// Sep 20 2026 (Karo), operator-requested CRITICAL FIX -- v1 compared
// each INDIVIDUAL liquidation event's own size against P95 of all
// individual event sizes. That's structurally wrong: exactly 5% of
// events always pass, regardless of whether anything unusual is
// actually happening, and a real cascade's own individual events can
// each be perfectly ordinary-sized while the EPISODE as a whole is
// huge. This is NOT how production evaluates episodes.
//
// FIXED, matching production logic: group ALL events (not just
// "large" ones) into episodes first (simple gap-merge -- this is the
// actual episode, the whole thing, small events included), THEN sum
// each episode's TOTAL liquidated $, THEN compare that EPISODE TOTAL
// against the percentile distribution of ALL episode totals in this
// window. An episode is "big" only if its own total stands out
// against OTHER EPISODES -- never by filtering individual events.
//
//   node scripts/btc-large-liquidation-episodes-v2.js 3 10 95
//
// (arg1 = days back, default 3; arg2 = gap-merge minutes to group raw
// events into one episode, default 10; arg3 = percentile of EPISODE
// TOTALS an episode's own total must clear to be shown, default 95)
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No ATR,
// no OI, no Binance API calls -- purely liq_raw_events.

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
  const episodePercentile = Number(process.argv[4] ?? "95");
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
    `BTCUSDT EPISODES, filtered by EPISODE-TOTAL percentile (not individual events) -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("Source: liq_raw_events collection, BTCUSDT only.");
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
  if (events.length === 0) {
    console.log("No events -- nothing to group.");
    await client.close();
    return;
  }

  // Step 1: group ALL events (every single one) into episodes via
  // gap-merge. This is the WHOLE episode, small events included --
  // exactly what would be tracked live.
  const allEpisodes = [];
  let current = [events[0]];
  for (let i = 1; i < events.length; i++) {
    const gapMs = events[i].timestamp - events[i - 1].timestamp;
    if (gapMs <= gapMergeMin * 60 * 1000) {
      current.push(events[i]);
    } else {
      allEpisodes.push(current);
      current = [events[i]];
    }
  }
  allEpisodes.push(current);
  console.log(
    `Step 1 -- grouped into ${allEpisodes.length} total episode(s) (gap-merge <= ${gapMergeMin} min), ALL sizes included.`,
  );

  // Step 2: each episode's TOTAL liquidated $.
  const episodeTotals = allEpisodes.map((ep) =>
    ep.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
  );

  // Step 3: percentile of EPISODE TOTALS (not individual events).
  const sortedTotals = [...episodeTotals].sort((a, b) => a - b);
  const totalsP = percentile(sortedTotals, episodePercentile);
  console.log(
    `Step 2 -- P${episodePercentile} of EPISODE TOTALS (across all ${allEpisodes.length} episodes): ${fmtUsd(totalsP)}`,
  );

  // Step 4: keep only episodes whose OWN total clears that bar.
  const bigEpisodes = allEpisodes.filter((ep, i) => episodeTotals[i] > totalsP);
  console.log(
    `Step 3 -- episodes whose OWN total > P${episodePercentile} of episode totals: ${bigEpisodes.length}\n`,
  );

  if (bigEpisodes.length === 0) {
    console.log(
      "No episodes cleared the bar -- try a lower percentile (arg3) or a longer gap-merge (arg2).",
    );
    await client.close();
    return;
  }

  console.log(
    "EPISODE   START (UTC)              END (UTC)                DURATION   EVENTS   TOTAL $        LONG$/SHORT$          PRICE RANGE",
  );
  console.log("-".repeat(130));

  bigEpisodes.forEach((ep, i) => {
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
    `TOTAL: ${bigEpisodes.length} BIG BTCUSDT episode(s) (of ${allEpisodes.length} total episodes) in ${days} day(s).`,
  );
  console.log(
    "Filtered by EPISODE TOTAL vs the percentile of ALL episode totals -- not by individual event size.",
  );
  console.log(
    "Open a BTC chart for the exact UTC start/end times above and check by eye whether these boundaries match.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
