// BTC OI STRUCTURAL EPISODE SEGMENTATION -- hysteresis-based, NOT
// single-step reversal detection. An episode is a complete
// directional excursion: local extreme -> sustained departure ->
// new extreme (tracked continuously) -> CUMULATIVE recovery from
// that extreme confirms END (not one big opposite tick). START of
// the next episode = the previous episode's EXTREME (a real local
// high/low), so segmentation is continuous with no gaps.
//
// THREE CANDIDATE END-CONFIRMATION METHODS (compared on real data,
// none chosen blindly, no fixed BTC number anywhere):
//   EXCURSION_33  -- cumulative recovery from extreme >= 33% of the
//                    excursion size (start->extreme). Scale-invariant:
//                    a bigger move needs proportionally bigger
//                    recovery to confirm reversal.
//   NOISE_10X     -- cumulative recovery >= 10x the LOCAL single-step
//                    noise fence (Tukey IQR fence on abs(ΔOI over
//                    10s) pairs, derived from the actual series).
//   HYBRID        -- recovery >= max(EXCURSION_33's bar, NOISE_10X's
//                    bar) -- requires BOTH a meaningful fraction of
//                    the excursion AND a noise-relative minimum.
//
//   node scripts/btc-oi-structural-episode-segmentation.js
//
// Price is attached to START/EXTREME/END afterward for chart
// inspection ONLY -- never used to select START, EXTREME, or END.
// No liquidation data, no taker flow, no order book used anywhere.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtBtc(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDurationMin(ms) {
  return `${(ms / 60000).toFixed(2)}min`;
}
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function median(arr) {
  return percentile(
    [...arr].sort((a, b) => a - b),
    50,
  );
}
function tukeyFence(sortedAbsValues) {
  const q1 = percentile(sortedAbsValues, 25);
  const q3 = percentile(sortedAbsValues, 75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, fence: q3 + 1.5 * iqr };
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function horizonDeltas(obs, horizonMs, toleranceMs) {
  const deltas = [];
  let j = 0;
  for (let i = 0; i < obs.length; i++) {
    if (j < i + 1) j = i + 1;
    while (j < obs.length && obs[j].ts - obs[i].ts < horizonMs - toleranceMs)
      j++;
    if (
      j < obs.length &&
      Math.abs(obs[j].ts - obs[i].ts - horizonMs) <= toleranceMs
    )
      deltas.push(obs[j].contracts - obs[i].contracts);
  }
  return deltas;
}

/** Hysteresis segmentation. `confirmEnd(recoveryBtc, excursionBtc)`
 *  decides whether cumulative recovery from the tracked extreme is
 *  enough to confirm the episode has ended. The extreme is tracked
 *  CONTINUOUSLY (every new extreme extends the same episode); small
 *  and medium counter-moves never split it -- only a confirmed
 *  cumulative recovery does. The next episode's START is exactly the
 *  previous episode's EXTREME (a real local high/low), so the
 *  segmentation has no gaps. */
function segmentStructuralEpisodes(obs, confirmEnd) {
  if (obs.length < 3) return [];
  const episodes = [];

  // Establish initial direction from the first real departure.
  let startIdx = 0;
  let direction = null;
  let i = 1;
  for (; i < obs.length; i++) {
    if (obs[i].contracts > obs[startIdx].contracts) {
      direction = "BUILD";
      break;
    }
    if (obs[i].contracts < obs[startIdx].contracts) {
      direction = "DELEVERAGING";
      break;
    }
  }
  if (direction === null) return [];

  let extremeIdx = startIdx;
  let extremeVal = obs[startIdx].contracts;
  if (
    direction === "BUILD"
      ? obs[i].contracts > extremeVal
      : obs[i].contracts < extremeVal
  ) {
    extremeVal = obs[i].contracts;
    extremeIdx = i;
  }

  for (i = i + 1; i < obs.length; i++) {
    const v = obs[i].contracts;
    // Extend extreme if a new one is reached.
    if (direction === "BUILD" ? v > extremeVal : v < extremeVal) {
      extremeVal = v;
      extremeIdx = i;
      continue;
    }

    // Otherwise, measure cumulative recovery from the current extreme.
    const recovery = direction === "BUILD" ? extremeVal - v : v - extremeVal;
    const excursion = Math.abs(extremeVal - obs[startIdx].contracts);
    if (recovery <= 0) continue; // not moving against the extreme at all
    if (!confirmEnd(recovery, excursion)) continue; // recovering, but not yet enough to confirm END

    // CONFIRMED END at i.
    const startO = obs[startIdx],
      extO = obs[extremeIdx],
      endO = obs[i];
    episodes.push({
      type: direction,
      startTs: startO.ts,
      startOi: startO.contracts,
      startPrice: startO.price,
      extremeTs: extO.ts,
      extremeOi: extO.contracts,
      extremePrice: extO.price,
      endTs: endO.ts,
      endOi: endO.contracts,
      endPrice: endO.price,
      deltaStartToExtremeBtc: extO.contracts - startO.contracts,
      extremeToEndRecoveryBtc: endO.contracts - extO.contracts,
      durationToExtremeMs: extO.ts - startO.ts,
      totalDurationMs: endO.ts - startO.ts,
    });

    // Next episode starts exactly at the previous EXTREME, opposite direction.
    startIdx = extremeIdx;
    direction = direction === "BUILD" ? "DELEVERAGING" : "BUILD";
    extremeIdx = startIdx;
    extremeVal = obs[startIdx].contracts;
    // Re-incorporate the current point i into the NEW episode's extreme tracking.
    if (direction === "BUILD" ? v > extremeVal : v < extremeVal) {
      extremeVal = v;
      extremeIdx = i;
    }
  }
  return episodes;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const oiCol = ownDb.collection("oi_second_observations");

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - DAYS_BACK * 86_400_000;

  console.log("=".repeat(160));
  console.log(
    `BTC OI STRUCTURAL EPISODE SEGMENTATION (hysteresis) -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(160));

  const obsRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: new Date(rangeStartMs), $lte: new Date(rangeEndMs) },
    })
    .project({ timestamp: 1, openInterest: 1, price: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const obs = obsRaw.map((d) => ({
    ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
    contracts: d.openInterest,
    price: d.price,
  }));
  console.log(`\nLoaded ${obs.length} raw OI observations.`);
  if (obs.length < 100) {
    console.log("Too few observations.");
    await client.close();
    return;
  }

  const noiseFence = tukeyFence(
    horizonDeltas(obs, 10000, 3000)
      .map((d) => Math.abs(d))
      .sort((a, b) => a - b),
  );
  console.log(
    `\nLocal noise fence (Tukey IQR fence on abs(ΔOI over 10s) pairs): ${fmtBtc(noiseFence.fence)} BTC`,
  );

  const methods = [
    {
      name: "EXCURSION_33",
      confirmEnd: (recovery, excursion) =>
        excursion > 0 && recovery >= 0.33 * excursion,
    },
    {
      name: "NOISE_10X",
      confirmEnd: (recovery) => recovery >= 10 * noiseFence.fence,
    },
    {
      name: "HYBRID",
      confirmEnd: (recovery, excursion) =>
        recovery >= Math.max(0.33 * excursion, 10 * noiseFence.fence),
    },
  ];

  console.log(`\n${"=".repeat(160)}`);
  console.log("METHOD COMPARISON");
  console.log("=".repeat(160));
  console.log(
    "METHOD        | TOTAL | BUILD | DELEVER | MEDIAN DUR | P90 DUR   | MEDIAN |ΔOI| | P90 |ΔOI|",
  );
  console.log("-".repeat(120));

  const methodResults = {};
  for (const m of methods) {
    const episodes = segmentStructuralEpisodes(obs, m.confirmEnd);
    methodResults[m.name] = episodes;
    const durations = episodes
      .map((e) => e.totalDurationMs)
      .sort((a, b) => a - b);
    const absDeltas = episodes
      .map((e) => Math.abs(e.deltaStartToExtremeBtc))
      .sort((a, b) => a - b);
    console.log(
      `${m.name.padEnd(13)} | ${String(episodes.length).padEnd(5)} | ${String(episodes.filter((e) => e.type === "BUILD").length).padEnd(5)} | ${String(episodes.filter((e) => e.type === "DELEVERAGING").length).padEnd(7)} | ${fmtDurationMin(median(durations) ?? 0).padEnd(10)} | ${fmtDurationMin(percentile(durations, 90) ?? 0).padEnd(9)} | ${fmtBtc(median(absDeltas)).padEnd(13)} | ${fmtBtc(percentile(absDeltas, 90))}`,
    );
  }

  // Most reasonable candidate = HYBRID (combines both considerations).
  const chosen = methodResults["HYBRID"];
  const top10 = [...chosen]
    .sort(
      (a, b) =>
        Math.abs(b.deltaStartToExtremeBtc) - Math.abs(a.deltaStartToExtremeBtc),
    )
    .slice(0, 10);

  console.log(`\n${"=".repeat(200)}`);
  console.log(
    `TOP 10 STRUCTURAL EPISODES -- HYBRID method (most reasonable candidate: combines excursion-relative AND noise-relative confirmation)`,
  );
  console.log("=".repeat(200));
  console.log(
    "ID    | TYPE         | START UTC                | EXTREME UTC              | END UTC                  | START OI   | EXTREME OI | END OI     | START→EXT ΔOI | EXT→END RECOVERY | DUR TO EXTREME | TOTAL DUR | START PRICE  | EXTREME PRICE | END PRICE",
  );
  console.log("-".repeat(220));
  top10.forEach((ep, idx) => {
    console.log(
      `EP${String(idx + 1).padEnd(4)} | ${ep.type.padEnd(12)} | ${isoUtc(ep.startTs)} | ${isoUtc(ep.extremeTs)} | ${isoUtc(ep.endTs)} | ${fmtBtc(ep.startOi).padEnd(10)} | ${fmtBtc(ep.extremeOi).padEnd(10)} | ${fmtBtc(ep.endOi).padEnd(10)} | ${fmtBtcDelta(ep.deltaStartToExtremeBtc).padEnd(13)} | ${fmtBtcDelta(ep.extremeToEndRecoveryBtc).padEnd(17)} | ${fmtDurationMin(ep.durationToExtremeMs).padEnd(15)} | ${fmtDurationMin(ep.totalDurationMs).padEnd(9)} | ${fmtPrice(ep.startPrice).padEnd(12)} | ${fmtPrice(ep.extremePrice).padEnd(13)} | ${fmtPrice(ep.endPrice)}`,
    );
  });

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
