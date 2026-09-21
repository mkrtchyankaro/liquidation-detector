// Sep 20 2026 (Karo), operator-requested. Takes the SAME BTC
// dominant-side, P95-filtered big episodes as
// btc-episodes-by-dominant-side-v2.js, then for EACH episode checks
// all 9 OTHER symbols' liquidation activity within that exact
// [start, end] window -- total $, LONG$/SHORT$ split, and whether
// each coin's own dominant side matches BTC's. Answers directly:
// was this a real market-wide cascade, or BTC-isolated?
//
//   node scripts/btc-episodes-cross-coin-check.js 3 10 3 3 90
//
// (same args as btc-episodes-by-dominant-side-v2.js: displayDays,
// gapMergeMin, confirmFlipCount, percentileLookbackDays, percentile)
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const ALT_SYMBOLS = [
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];

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
  const displayDays = Number(process.argv[2] ?? "3");
  const gapMergeMin = Number(process.argv[3] ?? "10");
  const confirmFlipCount = Number(process.argv[4] ?? "3");
  const percentileLookbackDays = Number(process.argv[5] ?? "3");
  const percentileThreshold = Number(process.argv[6] ?? "90");

  const displayStartMs = Date.now() - displayDays * 86_400_000;
  const rangeEndMs = Date.now();
  const rangeStartMs = displayStartMs - percentileLookbackDays * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(120));
  console.log(`BTC BIG EPISODES -- CROSS-COIN CONFIRMATION CHECK`);
  console.log(
    `Display window: ${isoUtc(displayStartMs)} to ${isoUtc(rangeEndMs)} (last ${displayDays} days)`,
  );
  console.log("=".repeat(120));

  // Step 1: rebuild the same BTC dominant-side big episodes.
  const btcEvents = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  const episodes = [];
  let ep = { events: [btcEvents[0]], dominantSide: btcEvents[0].victim };
  let oppositeStreak = 0;
  for (let i = 1; i < btcEvents.length; i++) {
    const e = btcEvents[i];
    const gapMs = e.timestamp - btcEvents[i - 1].timestamp;
    const bigTimeGap = gapMs > gapMergeMin * 60 * 1000;
    if (bigTimeGap) {
      episodes.push(ep);
      ep = { events: [e], dominantSide: e.victim };
      oppositeStreak = 0;
      continue;
    }
    if (e.victim === ep.dominantSide) {
      ep.events.push(e);
      oppositeStreak = 0;
    } else {
      oppositeStreak++;
      if (oppositeStreak >= confirmFlipCount) {
        const flipRunStartIdx = ep.events.length - (oppositeStreak - 1);
        const flipRunEvents = ep.events.splice(flipRunStartIdx);
        episodes.push(ep);
        ep = { events: [...flipRunEvents, e], dominantSide: e.victim };
        oppositeStreak = 0;
      } else {
        ep.events.push(e);
      }
    }
  }
  episodes.push(ep);

  const withTotals = episodes.map((e) => {
    const longUsd = e.events
      .filter((x) => x.victim === "LONG")
      .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
    const shortUsd = e.events
      .filter((x) => x.victim === "SHORT")
      .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
    return {
      ...e,
      longUsd,
      shortUsd,
      totalUsd: longUsd + shortUsd,
      startMs: e.events[0].timestamp,
      endMs: e.events[e.events.length - 1].timestamp,
    };
  });

  const longEpisodes = withTotals.filter((e) => e.dominantSide === "LONG");
  const shortEpisodes = withTotals.filter((e) => e.dominantSide === "SHORT");
  const longP = percentile(
    [...longEpisodes.map((e) => e.totalUsd)].sort((a, b) => a - b),
    percentileThreshold,
  );
  const shortP = percentile(
    [...shortEpisodes.map((e) => e.totalUsd)].sort((a, b) => a - b),
    percentileThreshold,
  );

  const bigInDisplay = withTotals.filter((e) => {
    if (e.startMs < displayStartMs) return false;
    const bar = e.dominantSide === "LONG" ? longP : shortP;
    return e.totalUsd > bar;
  });

  console.log(
    `\nFound ${bigInDisplay.length} big BTC episode(s) (P${percentileThreshold} per side). Checking cross-coin confirmation for each...\n`,
  );

  // Step 2: for each big BTC episode, pull ALL other symbols'
  // liquidations in the SAME exact window.
  let confirmedCount = 0;
  for (let i = 0; i < bigInDisplay.length; i++) {
    const e = bigInDisplay[i];
    console.log("-".repeat(120));
    console.log(
      `EPISODE #${i + 1}: BTC ${e.dominantSide}  ${isoUtc(e.startMs)} -> ${isoUtc(e.endMs)}  (BTC total: ${fmtUsd(e.totalUsd)})`,
    );
    console.log("-".repeat(120));

    let matchingCoins = 0;
    let anyActivityCoins = 0;
    for (const symbol of ALT_SYMBOLS) {
      const altEvents = await liqCol
        .find({ symbol, timestamp: { $gte: e.startMs, $lte: e.endMs } })
        .project({ quoteQty: 1, victim: 1 })
        .toArray();
      if (altEvents.length === 0) {
        console.log(
          `  ${symbol.padEnd(10)} NO liquidation activity in this window`,
        );
        continue;
      }
      anyActivityCoins++;
      const longUsd = altEvents
        .filter((x) => x.victim === "LONG")
        .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      const shortUsd = altEvents
        .filter((x) => x.victim === "SHORT")
        .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      const altDominant = longUsd >= shortUsd ? "LONG" : "SHORT";
      const matches = altDominant === e.dominantSide;
      if (matches) matchingCoins++;
      console.log(
        `  ${symbol.padEnd(10)} ${altEvents.length} event(s)  LONG$=${fmtUsd(longUsd)}  SHORT$=${fmtUsd(shortUsd)}  dominant=${altDominant}  ${matches ? "MATCHES BTC" : "does NOT match BTC"}`,
      );
    }

    console.log(
      `\n  SUMMARY: ${anyActivityCoins}/9 altcoins had ANY liquidation activity; ${matchingCoins}/9 had the SAME dominant side as BTC (${e.dominantSide}).`,
    );
    if (matchingCoins >= 6) {
      console.log(
        `  -> Looks like a REAL market-wide cascade (majority of altcoins agree with BTC's direction).`,
      );
      confirmedCount++;
    } else if (matchingCoins >= 3) {
      console.log(
        `  -> PARTIAL confirmation -- some altcoins agree, not a clear majority.`,
      );
    } else {
      console.log(
        `  -> Looks BTC-ISOLATED -- most altcoins did not show the same directional liquidation.`,
      );
    }
    console.log("");
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    `TOTAL: ${bigInDisplay.length} big BTC episode(s) checked. ${confirmedCount} look like real market-wide cascades (>=6/9 altcoins matching BTC's side).`,
  );
  console.log(
    "This never touches live strategy or trading logic -- diagnostic only.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
