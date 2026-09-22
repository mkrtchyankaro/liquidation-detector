// BTC OI STRUCTURAL SEGMENTATION -- FIXED-WINDOW VISUAL COMPARISON.
// Reuses the EXACT SAME three methods and thresholds from
// btc-oi-structural-episode-segmentation.js, unmodified. Detects
// episodes over the full available series (detection needs the full
// continuous timeline), then prints only the episodes from each
// method that OVERLAP the fixed inspection window below, plus a
// 1-minute raw OI series for the same window.
//
// No ranking, no "best" label, no price, no liquidation data, no
// interpretation.
//
//   node scripts/btc-oi-structural-window-compare.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const WINDOW_START_MS = Date.parse("2026-09-21T08:00:00Z");
const WINDOW_END_MS = Date.parse("2026-09-21T10:00:00Z");

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
function tukeyFence(sortedAbsValues) {
  const q1 = percentile(sortedAbsValues, 25);
  const q3 = percentile(sortedAbsValues, 75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, fence: q3 + 1.5 * iqr };
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

// Identical to the existing script -- unmodified.
function segmentStructuralEpisodes(obs, confirmEnd) {
  if (obs.length < 3) return [];
  const episodes = [];
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
    if (direction === "BUILD" ? v > extremeVal : v < extremeVal) {
      extremeVal = v;
      extremeIdx = i;
      continue;
    }

    const recovery = direction === "BUILD" ? extremeVal - v : v - extremeVal;
    const excursion = Math.abs(extremeVal - obs[startIdx].contracts);
    if (recovery <= 0) continue;
    if (!confirmEnd(recovery, excursion)) continue;

    const startO = obs[startIdx],
      extO = obs[extremeIdx],
      endO = obs[i];
    episodes.push({
      type: direction,
      startTs: startO.ts,
      startOi: startO.contracts,
      extremeTs: extO.ts,
      extremeOi: extO.contracts,
      endTs: endO.ts,
      endOi: endO.contracts,
      deltaStartToExtremeBtc: extO.contracts - startO.contracts,
      extremeToEndRecoveryBtc: endO.contracts - extO.contracts,
      durationToExtremeMs: extO.ts - startO.ts,
      totalDurationMs: endO.ts - startO.ts,
    });

    startIdx = extremeIdx;
    direction = direction === "BUILD" ? "DELEVERAGING" : "BUILD";
    extremeIdx = startIdx;
    extremeVal = obs[startIdx].contracts;
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

  const obsRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: new Date(rangeStartMs), $lte: new Date(rangeEndMs) },
    })
    .project({ timestamp: 1, openInterest: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const obs = obsRaw.map((d) => ({
    ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
    contracts: d.openInterest,
  }));

  console.log("=".repeat(160));
  console.log(
    `FIXED-WINDOW COMPARISON -- ${isoUtc(WINDOW_START_MS)} to ${isoUtc(WINDOW_END_MS)}`,
  );
  console.log(
    `(Detection runs over the full ${DAYS_BACK}-day series, ${obs.length} observations -- only episodes overlapping the window above are printed.)`,
  );
  console.log("=".repeat(160));

  const noiseFence = tukeyFence(
    horizonDeltas(obs, 10000, 3000)
      .map((d) => Math.abs(d))
      .sort((a, b) => a - b),
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

  for (const m of methods) {
    const episodes = segmentStructuralEpisodes(obs, m.confirmEnd);
    const overlapping = episodes.filter(
      (e) => e.startTs <= WINDOW_END_MS && e.endTs >= WINDOW_START_MS,
    );

    console.log(`\n${"=".repeat(160)}`);
    console.log(
      `METHOD: ${m.name}  (${overlapping.length} episode(s) overlap the window)`,
    );
    console.log("=".repeat(160));
    console.log(
      "TYPE         | START UTC                | EXTREME UTC              | END UTC                  | START OI   | EXTREME OI | END OI     | START→EXT ΔOI | EXT→END RECOVERY | DUR START→EXT | TOTAL DUR",
    );
    console.log("-".repeat(190));
    for (const ep of overlapping) {
      console.log(
        `${ep.type.padEnd(12)} | ${isoUtc(ep.startTs)} | ${isoUtc(ep.extremeTs)} | ${isoUtc(ep.endTs)} | ${fmtBtc(ep.startOi).padEnd(10)} | ${fmtBtc(ep.extremeOi).padEnd(10)} | ${fmtBtc(ep.endOi).padEnd(10)} | ${fmtBtcDelta(ep.deltaStartToExtremeBtc).padEnd(13)} | ${fmtBtcDelta(ep.extremeToEndRecoveryBtc).padEnd(17)} | ${fmtDurationMin(ep.durationToExtremeMs).padEnd(13)} | ${fmtDurationMin(ep.totalDurationMs)}`,
      );
    }
  }

  // ---- 1-minute raw OI series for the window ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("RAW OI TIMELINE (1-minute samples, window only)");
  console.log("=".repeat(160));
  console.log("UTC                  | OI");
  console.log("-".repeat(40));
  function nearestObs(targetMs) {
    let best = null;
    for (const o of obs) {
      if (o.ts <= targetMs) best = o;
      else break;
    }
    return best;
  }
  const bucketStart = Math.floor(WINDOW_START_MS / 60000) * 60000;
  for (let t = bucketStart; t <= WINDOW_END_MS; t += 60000) {
    const o = nearestObs(t);
    console.log(`${isoUtc(t)} | ${fmtBtc(o?.contracts)}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
