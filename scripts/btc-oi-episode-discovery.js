// BTC OI EPISODE DISCOVERY -- COMPACT MANUAL-REVIEW VERSION.
// Modified from the original (full-dump) version per operator
// request: internally detects the same OI-only episodes (no
// liquidation data, no price-based detection), but prints only a
// short ranked list for manual chart inspection instead of every
// detected episode. Uses the NORMAL scale (Tukey fence on abs(ΔOI
// over 10s) pairs) as the single episode population for ranking.
//
//   node scripts/btc-oi-episode-discovery.js
//
// Price is stored/printed for observation only (from oi_second_
// observations' own price field, same documents as openInterest) --
// it never participates in START/EXTREME/END detection anywhere in
// this file.
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
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
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
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function stddev(arr, m) {
  return arr.length
    ? Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length)
    : null;
}
function tukeyFence(sortedAbsValues) {
  const q1 = percentile(sortedAbsValues, 25);
  const q3 = percentile(sortedAbsValues, 75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, fence: q3 + 1.5 * iqr };
}

/** Paired deltas over a target horizon, using real observation pairs
 *  (two-pointer scan over the sorted raw series) -- not resampled,
 *  not interpolated. tolerance bounds how close to the target horizon
 *  a pair must be to count. */
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
    ) {
      deltas.push(obs[j].contracts - obs[i].contracts);
    }
  }
  return deltas;
}

/** Raw, zero-threshold directional run lengths (descriptive only --
 *  every direction change ends a raw run). Returns run DURATIONS in ms. */
function rawRunDurations(obs) {
  if (obs.length < 2) return [];
  const durations = [];
  let runStartTs = obs[0].ts;
  let direction = null;
  for (let i = 1; i < obs.length; i++) {
    const d = obs[i].contracts - obs[i - 1].contracts;
    if (d === 0) continue;
    const dir = d > 0 ? "UP" : "DOWN";
    if (direction === null) {
      direction = dir;
      continue;
    }
    if (dir !== direction) {
      durations.push(obs[i - 1].ts - runStartTs);
      runStartTs = obs[i - 1].ts;
      direction = dir;
    }
  }
  durations.push(obs[obs.length - 1].ts - runStartTs);
  return durations;
}

/** The core episode detector: directional run with a single-step
 *  significance threshold (Tukey fence at whatever horizon this scale
 *  uses). A counter-step below `sigThreshold` never ends the episode;
 *  only a single step exceeding it does -- cumulative episode size is
 *  never itself checked against any threshold. Tracks the TRUE
 *  extreme (max for BUILD, min for DELEVERAGING) within each episode
 *  explicitly, independent of where the episode technically ends. */
function detectOiEpisodes(obs, sigThreshold) {
  if (obs.length < 2) return [];
  const episodes = [];
  let startIdx = 0;
  let direction = null; // "UP" | "DOWN"
  let extremeIdx = 0,
    extremeVal = obs[0].contracts;

  function closeEpisode(endIdx) {
    // Find the TRUE extreme within [startIdx, endIdx], independent of
    // the running extreme tracked during accumulation (belt & braces).
    let trueExtremeIdx = startIdx;
    for (let k = startIdx; k <= endIdx; k++) {
      if (
        direction === "UP"
          ? obs[k].contracts > obs[trueExtremeIdx].contracts
          : obs[k].contracts < obs[trueExtremeIdx].contracts
      )
        trueExtremeIdx = k;
    }
    const startO = obs[startIdx],
      extO = obs[trueExtremeIdx],
      endO = obs[endIdx];

    // Max OI speed BTC/min: largest single-step rate within the episode.
    let maxSpeed = 0;
    for (let k = startIdx + 1; k <= endIdx; k++) {
      const dtMin = (obs[k].ts - obs[k - 1].ts) / 60000;
      if (dtMin > 0)
        maxSpeed = Math.max(
          maxSpeed,
          Math.abs((obs[k].contracts - obs[k - 1].contracts) / dtMin),
        );
    }

    episodes.push({
      type: direction === "UP" ? "BUILD" : "DELEVERAGING",
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
      deltaStartToExtremePct:
        startO.contracts !== 0
          ? ((extO.contracts - startO.contracts) / startO.contracts) * 100
          : null,
      durationToExtremeMs: extO.ts - startO.ts,
      totalDurationMs: endO.ts - startO.ts,
      avgSpeedBtcPerMin:
        extO.ts - startO.ts > 0
          ? ((extO.contracts - startO.contracts) / (extO.ts - startO.ts)) *
            60000
          : 0,
      maxSpeedBtcPerMin: maxSpeed,
    });
  }

  for (let i = 1; i < obs.length; i++) {
    const v = obs[i].contracts;
    if (direction === null) {
      if (v > extremeVal) {
        extremeVal = v;
        extremeIdx = i;
        direction = "UP";
      } else if (v < extremeVal) {
        extremeVal = v;
        extremeIdx = i;
        direction = "DOWN";
      }
      continue;
    }
    const stepDelta = v - obs[i - 1].contracts;
    const stepDir = stepDelta > 0 ? "UP" : stepDelta < 0 ? "DOWN" : direction;
    if (stepDir === direction || stepDelta === 0) {
      if (direction === "UP" ? v > extremeVal : v < extremeVal) {
        extremeVal = v;
        extremeIdx = i;
      }
      continue;
    }
    if (Math.abs(stepDelta) <= sigThreshold) continue; // ordinary counter-noise -- does not end the episode
    // Significant single-step reversal -- close episode at i-1, start new one there.
    closeEpisode(i - 1);
    startIdx = i - 1;
    direction = stepDir;
    extremeVal = obs[i - 1].contracts;
    extremeIdx = i - 1;
  }
  closeEpisode(obs.length - 1);
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
    `BTC OI EPISODE DISCOVERY -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log(
    "Pure OI structure. No liquidation data, no price-based detection, no previous P90 logic.",
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
    console.log(
      "Too few observations -- likely near the 3-day TTL edge or data gap.",
    );
    await client.close();
    return;
  }

  // ============================================================
  // Internal detection -- NORMAL scale only (Tukey fence on abs(ΔOI
  // over 10s) pairs), the middle of the three scales from the
  // previous version. Not printed in full -- used only to build the
  // episode population for ranking below.
  // ============================================================
  const horizonForScale = horizonDeltas(obs, 10000, 3000)
    .map((d) => Math.abs(d))
    .sort((a, b) => a - b);
  const scaleFence = tukeyFence(horizonForScale);
  const episodes = detectOiEpisodes(obs, scaleFence.fence);

  // ============================================================
  // Percentile ranks across the detected population, thresholds
  // derived from that population (not invented).
  // ============================================================
  const absDeltas = episodes
    .map((e) => Math.abs(e.deltaStartToExtremeBtc))
    .sort((a, b) => a - b);
  const absSpeeds = episodes
    .map((e) => Math.abs(e.avgSpeedBtcPerMin))
    .sort((a, b) => a - b);
  const deltaP90 = percentile(absDeltas, 90);
  const speedP90 = percentile(absSpeeds, 90);

  for (const ep of episodes) {
    ep.inGroupA = Math.abs(ep.deltaStartToExtremeBtc) >= deltaP90;
    ep.inGroupB = Math.abs(ep.avgSpeedBtcPerMin) >= speedP90;
    ep.inGroupC = ep.inGroupA && ep.inGroupB;
    ep.groupLabel = ep.inGroupC
      ? "C"
      : ep.inGroupA
        ? "A"
        : ep.inGroupB
          ? "B"
          : "-";
  }

  const groupACount = episodes.filter((e) => e.inGroupA).length;
  const groupBCount = episodes.filter((e) => e.inGroupB).length;
  const groupCCount = episodes.filter((e) => e.inGroupC).length;

  const buildEpisodes = episodes
    .filter((e) => e.type === "BUILD")
    .sort(
      (a, b) =>
        Math.abs(b.deltaStartToExtremeBtc) - Math.abs(a.deltaStartToExtremeBtc),
    )
    .slice(0, 10);
  const deleverEpisodes = episodes
    .filter((e) => e.type === "DELEVERAGING")
    .sort(
      (a, b) =>
        Math.abs(b.deltaStartToExtremeBtc) - Math.abs(a.deltaStartToExtremeBtc),
    )
    .slice(0, 10);

  console.log(
    `\nDetection scale used: NORMAL (Tukey fence on abs(ΔOI over 10s) pairs) = ${fmtBtc(scaleFence.fence)} BTC single-step significance threshold.`,
  );
  console.log(`\nTOTAL RAW OI EPISODES: ${episodes.length}`);
  console.log(
    `BUILD COUNT: ${episodes.filter((e) => e.type === "BUILD").length}`,
  );
  console.log(
    `DELEVERAGING COUNT: ${episodes.filter((e) => e.type === "DELEVERAGING").length}`,
  );
  console.log(`\nTOP-10% ΔOI THRESHOLD: ${fmtBtc(deltaP90)} BTC`);
  console.log(`TOP-10% SPEED THRESHOLD: ${speedP90.toFixed(2)} BTC/min`);
  console.log(`\nGROUP A COUNT (top 10% by |ΔOI|): ${groupACount}`);
  console.log(`GROUP B COUNT (top 10% by |avg speed|): ${groupBCount}`);
  console.log(`GROUP C COUNT (both): ${groupCCount}`);

  console.log(`\n${"=".repeat(180)}`);
  console.log(
    `MANUAL-REVIEW LIST -- top ${buildEpisodes.length} BUILD + top ${deleverEpisodes.length} DELEVERAGING, ranked by |ΔOI BTC|`,
  );
  console.log("=".repeat(180));
  console.log(
    "ID       | TYPE         | GRP | START UTC                | EXTREME UTC              | END UTC                  | ΔOI BTC    | ΔOI %      | DUR TO EXTREME | AVG SPEED  | START PRICE  | EXTREME PRICE | END PRICE",
  );
  console.log("-".repeat(200));
  [...buildEpisodes, ...deleverEpisodes].forEach((ep, idx) => {
    console.log(
      `EP${String(idx + 1).padEnd(6)} | ${ep.type.padEnd(12)} | ${ep.groupLabel.padEnd(3)} | ${isoUtc(ep.startTs)} | ${isoUtc(ep.extremeTs)} | ${isoUtc(ep.endTs)} | ${fmtBtcDelta(ep.deltaStartToExtremeBtc).padEnd(10)} | ${fmtPct(ep.deltaStartToExtremePct).padEnd(10)} | ${fmtDurationMin(ep.durationToExtremeMs).padEnd(14)} | ${ep.avgSpeedBtcPerMin.toFixed(2).padEnd(10)} | ${fmtPrice(ep.startPrice).padEnd(12)} | ${fmtPrice(ep.extremePrice).padEnd(13)} | ${fmtPrice(ep.endPrice)}`,
    );
  });

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
