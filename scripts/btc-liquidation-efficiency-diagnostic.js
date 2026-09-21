// Sep 20 2026 (Karo), operator-requested. Tests the operator's own
// hypothesis: when liquidation $ keeps GROWING episode-to-episode but
// price fails to move proportionally, that "liquidation efficiency"
// declining is a warning sign the cascade will CONTINUE, not reverse
// -- i.e. a reason NOT to go long yet. Computes, for a sequence of
// sub-episodes within one window: total $ liquidated, the price move
// achieved, the ratio ($ per 1% price move -- "cost per % move"), and
// OI change both WITHIN each sub-episode and in the GAP between
// consecutive sub-episodes (what was OI doing while price was
// "paused" between episodes).
//
//   node scripts/btc-liquidation-efficiency-diagnostic.js "2026-09-20 02:20" "2026-09-20 03:20" 10
//
// (arg3 = gap-merge minutes to split sub-episodes within the window,
// default 10 -- same simple time-gap grouping, kept deliberately
// separate from the candle-based end logic so this diagnostic is
// self-contained and easy to reason about)
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

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
function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19) + "Z";
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}

async function main() {
  const startArg = process.argv[2];
  const endArg = process.argv[3];
  const gapMergeMin = Number(process.argv[4] ?? "10");
  if (!startArg || !endArg) {
    console.error(
      'Usage: node scripts/btc-liquidation-efficiency-diagnostic.js "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm" [gapMergeMin]',
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
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(120));
  console.log(
    `BTC LIQUIDATION-EFFICIENCY DIAGNOSTIC -- ${isoUtc(windowStartMs)} to ${isoUtc(windowEndMs)}`,
  );
  console.log(
    "Tests: is liquidation $ growing while price impact shrinks (a continuation warning), episode to episode?",
  );
  console.log("=".repeat(120));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: windowStartMs, $lte: windowEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(`\nLoaded ${events.length} liquidation events.\n`);
  if (events.length === 0) {
    await client.close();
    return;
  }

  async function nearestOiAtOrBefore(targetMs) {
    const doc = await oiCol
      .find({ symbol: "BTCUSDT", timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    return doc ? doc.openInterest : null;
  }

  // Simple time-gap grouping (self-contained, not reusing the
  // candle-based logic, per the operator's own request to isolate
  // this diagnostic).
  const subEpisodes = [];
  let cur = [events[0]];
  for (let i = 1; i < events.length; i++) {
    if (
      events[i].timestamp - events[i - 1].timestamp >
      gapMergeMin * 60 * 1000
    ) {
      subEpisodes.push(cur);
      cur = [events[i]];
    } else cur.push(events[i]);
  }
  subEpisodes.push(cur);

  console.log(
    `Split into ${subEpisodes.length} sub-episode(s) by ${gapMergeMin}min time-gap.\n`,
  );
  console.log(
    "SUB-EP   START->END (UTC)                                PRICE START->END        MOVE%       LIQ $        $-per-1%-move       OI START->END (delta)",
  );
  console.log("-".repeat(150));

  const rows = [];
  for (let i = 0; i < subEpisodes.length; i++) {
    const ep = subEpisodes[i];
    const startMs = ep[0].timestamp,
      endMs = ep[ep.length - 1].timestamp;
    const startPrice = ep[0].price,
      endPrice = ep[ep.length - 1].price;
    const movePct = ((endPrice - startPrice) / startPrice) * 100;
    const liqUsd = ep.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const costPer1PctMove =
      Math.abs(movePct) > 0.0001 ? liqUsd / Math.abs(movePct) : null;
    const oiStart = await nearestOiAtOrBefore(startMs);
    const oiEnd = await nearestOiAtOrBefore(endMs);
    const oiDelta = oiStart !== null && oiEnd !== null ? oiEnd - oiStart : null;

    console.log(
      `${String(i + 1).padStart(6)}   ${hhmmss(startMs)} -> ${hhmmss(endMs)}   ${startPrice.toFixed(1).padEnd(10)}->${endPrice.toFixed(1).padEnd(10)} ${fmtPct(movePct).padEnd(11)} ${fmtUsd(liqUsd).padEnd(12)} ${costPer1PctMove !== null ? fmtUsd(costPer1PctMove) + "/1%" : "N/A".padEnd(14)}      ${oiStart !== null ? oiStart.toFixed(2) : "N/A"} -> ${oiEnd !== null ? oiEnd.toFixed(2) : "N/A"}  (${oiDelta !== null ? (oiDelta >= 0 ? "+" : "") + oiDelta.toFixed(2) : "N/A"})`,
    );
    rows.push({
      idx: i + 1,
      startMs,
      endMs,
      movePct,
      liqUsd,
      costPer1PctMove,
      oiStart,
      oiEnd,
      oiDelta,
    });

    // The GAP to the next sub-episode, if any -- what was OI/price doing while liquidation was silent?
    if (i < subEpisodes.length - 1) {
      const nextEp = subEpisodes[i + 1];
      const gapStartMs = endMs,
        gapEndMs = nextEp[0].timestamp;
      const gapOiStart = oiEnd;
      const gapOiEnd = await nearestOiAtOrBefore(gapEndMs);
      const gapOiDelta =
        gapOiStart !== null && gapOiEnd !== null ? gapOiEnd - gapOiStart : null;
      console.log(
        `         [GAP ${((gapEndMs - gapStartMs) / 60000).toFixed(1)}m: OI ${gapOiStart !== null ? gapOiStart.toFixed(2) : "N/A"} -> ${gapOiEnd !== null ? gapOiEnd.toFixed(2) : "N/A"}  (${gapOiDelta !== null ? (gapOiDelta >= 0 ? "+" : "") + gapOiDelta.toFixed(2) : "N/A"})]`,
      );
    }
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    "TREND CHECK -- is $-per-1%-move RISING episode to episode (operator's hypothesis: rising = continuation warning)?",
  );
  console.log("=".repeat(120));
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1],
      cur = rows[i];
    if (prev.costPer1PctMove === null || cur.costPer1PctMove === null) {
      console.log(
        `  Ep${prev.idx}->Ep${cur.idx}: N/A (no price move to divide by in one of them)`,
      );
      continue;
    }
    const direction =
      cur.costPer1PctMove > prev.costPer1PctMove
        ? "RISING (more $ needed for less move -- continuation warning)"
        : "falling (liquidation getting MORE efficient at moving price)";
    console.log(
      `  Ep${prev.idx} (${fmtUsd(prev.costPer1PctMove)}/1%) -> Ep${cur.idx} (${fmtUsd(cur.costPer1PctMove)}/1%): ${direction}`,
    );
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    "This never touches live strategy or trading logic -- diagnostic only.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
