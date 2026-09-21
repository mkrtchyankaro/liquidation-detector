// Sep 20 2026 (Karo), operator-requested. Groups BTCUSDT liquidation
// events into episodes by DOMINANT SIDE (LONG or SHORT), tolerating
// isolated opposite-side "noise" events without breaking the episode,
// but ending the episode once the opposite side becomes SUSTAINED
// (several in a row) -- exactly the pattern the operator described:
// long,long,long,SHORT(one),long,long... stays one LONG episode; but
// long,long,long,SHORT,SHORT,SHORT,SHORT... is a real flip, and the
// LONG episode ends right before that SHORT run begins.
//
//   node scripts/btc-episodes-by-dominant-side.js 3 10 3
//
// (arg1 = days back, default 3; arg2 = gap-merge minutes for time
// gaps, default 10; arg3 = how many consecutive opposite-side events
// count as a confirmed flip, default 3)
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

async function main() {
  const days = Number(process.argv[2] ?? "3");
  const gapMergeMin = Number(process.argv[3] ?? "10");
  const confirmFlipCount = Number(process.argv[4] ?? "3");
  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(110));
  console.log(
    `BTCUSDT EPISODES BY DOMINANT SIDE -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log(
    `Isolated opposite-side events are tolerated as noise; ${confirmFlipCount}+ consecutive opposite events = confirmed flip (new episode).`,
  );
  console.log("=".repeat(110));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(`\nLoaded ${events.length} total BTCUSDT liquidation events.\n`);
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

  console.log(`Grouped into ${episodes.length} episode(s).\n`);
  console.log(
    "EPISODE   DOMINANT   START (UTC)              END (UTC)                DURATION   EVENTS   LONG$/SHORT$              TOTAL $",
  );
  console.log("-".repeat(130));

  episodes.forEach((e, i) => {
    const startMs = e.events[0].timestamp;
    const endMs = e.events[e.events.length - 1].timestamp;
    const durationMin = (endMs - startMs) / 60000;
    const longUsd = e.events
      .filter((x) => x.victim === "LONG")
      .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
    const shortUsd = e.events
      .filter((x) => x.victim === "SHORT")
      .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
    const totalUsd = longUsd + shortUsd;
    console.log(
      `${String(i + 1).padStart(7)}   ${e.dominantSide.padEnd(9)} ${isoUtc(startMs).padEnd(24)} ${isoUtc(endMs).padEnd(24)} ${durationMin.toFixed(1).padStart(7)}m   ${String(e.events.length).padStart(6)}   ${fmtUsd(longUsd)}/${fmtUsd(shortUsd).padEnd(18)}   ${fmtUsd(totalUsd)}`,
    );
  });

  console.log(`\n${"=".repeat(110)}`);
  console.log(
    `TOTAL: ${episodes.length} episode(s), ${events.length} event(s), in ${days} day(s).`,
  );
  console.log(
    "DOMINANT column = the side that defines this episode. LONG$/SHORT$ shows both -- a LONG-dominant episode",
  );
  console.log(
    "can still contain a few SHORT$ from tolerated noise events; that is expected, not a bug.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
