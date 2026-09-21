// Sep 20 2026 (Karo), operator-requested. Combines the confirmed
// dominant-side episode grouping (isolated opposite-side noise
// tolerated, sustained flip = new episode) with SIDE-SPECIFIC P95
// filtering: LONG-dominant episodes are compared against the P95 of
// OTHER LONG episode totals; SHORT-dominant episodes against the P95
// of OTHER SHORT episode totals -- never mixed. The P95 baseline is
// computed over a LONGER lookback than the displayed window (extra
// days before the display start), so the percentile isn't calibrated
// on too small a sample.
//
//   node scripts/btc-episodes-by-dominant-side-v2.js 3 10 3 3 95
//
// (arg1 = days to DISPLAY, default 3; arg2 = gap-merge minutes,
// default 10; arg3 = consecutive-opposite-events to confirm a flip,
// default 3; arg4 = EXTRA days further back for the P95 baseline,
// default 3; arg5 = percentile threshold, default 95)
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

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
  const displayDays = Number(process.argv[2] ?? "3");
  const gapMergeMin = Number(process.argv[3] ?? "10");
  const confirmFlipCount = Number(process.argv[4] ?? "3");
  const percentileLookbackDays = Number(process.argv[5] ?? "3");
  const percentileThreshold = Number(process.argv[6] ?? "95");

  const displayStartMs = Date.now() - displayDays * 86_400_000;
  const rangeEndMs = Date.now();
  const rangeStartMs = displayStartMs - percentileLookbackDays * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(114));
  console.log(
    `BTCUSDT EPISODES, dominant-side, P${percentileThreshold}-filtered PER SIDE`,
  );
  console.log(
    `Percentile baseline window: ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)} (${displayDays + percentileLookbackDays} days)`,
  );
  console.log(
    `Display window: ${isoUtc(displayStartMs)} to ${isoUtc(rangeEndMs)} (last ${displayDays} days)`,
  );
  console.log("=".repeat(114));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(
    `\nLoaded ${events.length} total BTCUSDT liquidation events over the full (extended) window.\n`,
  );
  if (events.length === 0) {
    await client.close();
    return;
  }

  const episodes = [];
  let ep = { events: [events[0]], dominantSide: events[0].victim };
  let oppositeStreak = 0;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const gapMs = e.timestamp - events[i - 1].timestamp;
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

  console.log(
    `Grouped into ${withTotals.length} episode(s) over the full extended window.`,
  );

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
  console.log(
    `  LONG episodes: ${longEpisodes.length} total, P${percentileThreshold} = ${fmtUsd(longP)}`,
  );
  console.log(
    `  SHORT episodes: ${shortEpisodes.length} total, P${percentileThreshold} = ${fmtUsd(shortP)}\n`,
  );

  const bigInDisplay = withTotals.filter((e) => {
    if (e.startMs < displayStartMs) return false;
    const bar = e.dominantSide === "LONG" ? longP : shortP;
    return e.totalUsd > bar;
  });

  console.log(
    `BIG episodes in the display window (last ${displayDays} days), each side vs its OWN P${percentileThreshold}: ${bigInDisplay.length}\n`,
  );

  if (bigInDisplay.length === 0) {
    console.log(
      "None cleared the bar in the display window -- try a lower percentile (arg6) or a longer display window (arg1).",
    );
    await client.close();
    return;
  }

  console.log(
    "EPISODE   SIDE     START (UTC)              END (UTC)                DURATION   EVENTS   LONG$/SHORT$              TOTAL $",
  );
  console.log("-".repeat(130));
  bigInDisplay.forEach((e, i) => {
    const durationMin = (e.endMs - e.startMs) / 60000;
    console.log(
      `${String(i + 1).padStart(7)}   ${e.dominantSide.padEnd(8)} ${isoUtc(e.startMs).padEnd(24)} ${isoUtc(e.endMs).padEnd(24)} ${durationMin.toFixed(1).padStart(7)}m   ${String(e.events.length).padStart(6)}   ${fmtUsd(e.longUsd)}/${fmtUsd(e.shortUsd).padEnd(18)}   ${fmtUsd(e.totalUsd)}`,
    );
  });

  console.log(`\n${"=".repeat(114)}`);
  console.log(
    `TOTAL: ${bigInDisplay.length} big episode(s) shown, of ${withTotals.length} total episodes found over the full extended window.`,
  );
  console.log(
    "Each episode's total is compared ONLY against other episodes of the SAME dominant side (LONG vs LONG P95,",
  );
  console.log(
    "SHORT vs SHORT P95) -- never mixed. Percentile baseline uses extra lookback days beyond the display window.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
