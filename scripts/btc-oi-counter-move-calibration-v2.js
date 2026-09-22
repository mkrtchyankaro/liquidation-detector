// BTC OI COUNTER-MOVE CALIBRATION STUDY -- v2, FIXED SAMPLING.
//
// v1 BUG (operator-caught): a "directional process" was created from
// ANY single tick-flip, so originalExcursion was often near-zero,
// making FAILED_TO_RESUME trigger almost instantly and trivially.
// Only 2 candidates emerged from 253k observations.
//
// v2 FIX: a process must clear a CONSERVATIVE, multi-criterion
// ESTABLISHMENT bar -- (a) excursion >= 20x its own since-start local
// noise, (b) at least 5 distinct new-same-direction-extreme ticks,
// (c) at least 30s of duration -- BEFORE any of its counter-moves are
// eligible for calibration. Establishment criteria are DELIBERATELY
// SEPARATE from, and do not reuse, the SURVIVED/FAILED resolution
// logic we are trying to calibrate (no circularity). Before
// establishment, counter-moves are simply ignored (not sampled); if a
// pre-establishment counter-move itself grows past the pre-
// establishment process's own start level, the seed is abandoned and
// a fresh process starts from there.
//
// OI ONLY. No price. Not the final live detector.
//
//   node scripts/btc-oi-counter-move-calibration-v2.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const LOCAL_WINDOW_SIZE = 60;
const MAX_SEARCH_CAP_MS = 2 * 60 * 60 * 1000;
const MIN_N_FOR_ANALYSIS = 10;

// Establishment bar (conservative, explicit, separate from calibration logic).
const ESTABLISH_NOISE_MULTIPLIER = 20;
const ESTABLISH_MIN_EXTREME_COUNT = 5;
const ESTABLISH_MIN_DURATION_MS = 30_000;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtBtc(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, { maximumFractionDigits: 3 });
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
    [...arr]
      .filter((v) => v !== null && Number.isFinite(v))
      .sort((a, b) => a - b),
    50,
  );
}
function stats(arr) {
  const s = [...arr]
    .filter((v) => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (s.length === 0) return { n: 0 };
  return {
    n: s.length,
    median: percentile(s, 50),
    p25: percentile(s, 25),
    p75: percentile(s, 75),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
  };
}
function printStats(label, s) {
  if (s.n < MIN_N_FOR_ANALYSIS) {
    console.log(
      `  ${label}: N=${s.n} -- INSUFFICIENT SAMPLE FOR SEPARATION ANALYSIS (minimum ${MIN_N_FOR_ANALYSIS})`,
    );
    return;
  }
  console.log(
    `  ${label}: N=${s.n}  median=${s.median?.toFixed(3)}  P25=${s.p25?.toFixed(3)}  P75=${s.p75?.toFixed(3)}  P90=${s.p90?.toFixed(3)}  P95=${s.p95?.toFixed(3)}`,
  );
}

function localNoiseFixedWindow(obs, atIdx) {
  const from = Math.max(0, atIdx - LOCAL_WINDOW_SIZE);
  let sum = 0,
    count = 0;
  for (let k = from + 1; k <= atIdx; k++) {
    sum += Math.abs(obs[k].contracts - obs[k - 1].contracts);
    count++;
  }
  return count > 0 ? sum / count : 0;
}
function localNoiseSinceDirStart(obs, dirStartIdx, atIdx) {
  let sum = 0,
    count = 0;
  for (let k = Math.max(dirStartIdx + 1, atIdx - 500); k <= atIdx; k++) {
    sum += Math.abs(obs[k].contracts - obs[k - 1].contracts);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function classifyCounterMove(
  obs,
  startCounterIdx,
  extremeIdx,
  extremeVal,
  direction,
  dirStartIdx,
) {
  const originalExcursion = Math.abs(extremeVal - obs[dirStartIdx].contracts);
  const originalDurationMs = obs[extremeIdx].ts - obs[dirStartIdx].ts;
  const searchCapMs = Math.min(
    Math.max(5 * originalDurationMs, 5 * 60 * 1000),
    MAX_SEARCH_CAP_MS,
  );
  const searchCapTs = obs[startCounterIdx].ts + searchCapMs;

  let counterExtreme = obs[startCounterIdx].contracts;
  for (
    let k = startCounterIdx + 1;
    k < obs.length && obs[k].ts <= searchCapTs;
    k++
  ) {
    const v = obs[k].contracts;
    counterExtreme =
      direction === "UP"
        ? Math.min(counterExtreme, v)
        : Math.max(counterExtreme, v);
    const counterMoveSoFar = Math.abs(counterExtreme - extremeVal);
    if (direction === "UP" ? v >= extremeVal : v <= extremeVal)
      return {
        outcome: "SURVIVED",
        resolutionIdx: k,
        counterMoveSize: counterMoveSoFar,
        originalExcursion,
        originalDurationMs,
        durationMs: obs[k].ts - obs[startCounterIdx].ts,
      };
    if (counterMoveSoFar >= originalExcursion)
      return {
        outcome: "FAILED_TO_RESUME",
        resolutionIdx: k,
        counterMoveSize: counterMoveSoFar,
        originalExcursion,
        originalDurationMs,
        durationMs: obs[k].ts - obs[startCounterIdx].ts,
      };
  }
  return {
    outcome: "UNRESOLVED",
    resolutionIdx: Math.min(obs.length - 1, startCounterIdx + 1),
    counterMoveSize: Math.abs(counterExtreme - extremeVal),
    originalExcursion,
    originalDurationMs,
    durationMs: 0,
  };
}

function scanWithEstablishment(obs) {
  const samples = [];
  const processLog = []; // every established process, for diagnostics (smallest examples)

  let processStartIdx = 0,
    direction = null,
    extremeIdx = 0,
    extremeVal = obs[0].contracts,
    extremeCount = 1,
    established = false;
  let i = 1;
  for (; i < obs.length; i++) {
    if (obs[i].contracts > obs[0].contracts) {
      direction = "UP";
      break;
    }
    if (obs[i].contracts < obs[0].contracts) {
      direction = "DOWN";
      break;
    }
  }
  if (direction === null) return { samples, processLog };
  extremeIdx = i;
  extremeVal = obs[i].contracts;

  function checkEstablishment(atIdx) {
    if (established) return;
    const excursion = Math.abs(extremeVal - obs[processStartIdx].contracts);
    const localNoise = localNoiseSinceDirStart(obs, processStartIdx, atIdx);
    const durationMs = obs[atIdx].ts - obs[processStartIdx].ts;
    if (
      excursion >= ESTABLISH_NOISE_MULTIPLIER * localNoise &&
      extremeCount >= ESTABLISH_MIN_EXTREME_COUNT &&
      durationMs >= ESTABLISH_MIN_DURATION_MS
    ) {
      established = true;
      processLog.push({
        direction,
        startTs: obs[processStartIdx].ts,
        establishedTs: obs[atIdx].ts,
        excursionAtEstablishment: excursion,
        extremeCountAtEstablishment: extremeCount,
        durationMsAtEstablishment: durationMs,
      });
    }
  }

  for (i = i + 1; i < obs.length; ) {
    const v = obs[i].contracts;
    if (direction === "UP" ? v > extremeVal : v < extremeVal) {
      extremeVal = v;
      extremeIdx = i;
      extremeCount++;
      checkEstablishment(i);
      i++;
      continue;
    }
    if (v === extremeVal) {
      i++;
      continue;
    }

    // Counter-direction step.
    if (!established) {
      // Pre-establishment: ignore small counter-dips; abandon the seed
      // only if the counter-move itself clearly falsifies this process
      // (grows past the process's OWN start level -- not the
      // reversal-tolerance we are trying to learn).
      const processStartVal = obs[processStartIdx].contracts;
      if (direction === "UP" ? v <= processStartVal : v >= processStartVal) {
        // Seed falsified -- restart fresh from here, opposite direction.
        processStartIdx = i;
        direction = direction === "UP" ? "DOWN" : "UP";
        extremeVal = v;
        extremeIdx = i;
        extremeCount = 1;
        established = false;
        i++;
        continue;
      }
      // Otherwise just ignore this dip and keep hoping the original
      // direction resumes toward establishment; extreme/extremeCount
      // are NOT updated by a counter-dip.
      i++;
      continue;
    }

    // Established -- this counter-move is a real calibration sample.
    const localNoiseFixed = localNoiseFixedWindow(obs, i);
    const localNoiseAdaptive = localNoiseSinceDirStart(obs, processStartIdx, i);
    const result = classifyCounterMove(
      obs,
      i,
      extremeIdx,
      extremeVal,
      direction,
      processStartIdx,
    );

    samples.push({
      direction,
      establishedExcursion: result.originalExcursion,
      priorExtremeCount: extremeCount,
      outcome: result.outcome,
      counterMoveSize: result.counterMoveSize,
      ratioExcursion:
        result.originalExcursion > 0
          ? result.counterMoveSize / result.originalExcursion
          : null,
      ratioLocalNoiseFixed:
        localNoiseFixed > 0 ? result.counterMoveSize / localNoiseFixed : null,
      ratioLocalNoiseAdaptive:
        localNoiseAdaptive > 0
          ? result.counterMoveSize / localNoiseAdaptive
          : null,
      durationMs: result.durationMs,
      originalDurationMs: result.originalDurationMs,
      speedBtcPerMin:
        result.originalDurationMs > 0
          ? (result.originalExcursion / result.originalDurationMs) * 60000
          : null,
      resolutionIdx: result.resolutionIdx,
    });

    if (result.outcome === "SURVIVED") {
      extremeVal = obs[result.resolutionIdx].contracts;
      extremeIdx = result.resolutionIdx;
      extremeCount++;
      i = result.resolutionIdx + 1;
    } else if (result.outcome === "FAILED_TO_RESUME") {
      processStartIdx = extremeIdx;
      direction = direction === "UP" ? "DOWN" : "UP";
      extremeVal = obs[result.resolutionIdx].contracts;
      extremeIdx = result.resolutionIdx;
      extremeCount = 1;
      established = false;
      i = result.resolutionIdx + 1;
    } else {
      i = result.resolutionIdx + 1; // UNRESOLVED
    }
  }
  return { samples, processLog };
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
    "BTC OI COUNTER-MOVE CALIBRATION v2 -- FIXED SAMPLING (established processes only)",
  );
  console.log("=".repeat(160));
  console.log(
    `\nEstablishment bar: excursion >= ${ESTABLISH_NOISE_MULTIPLIER}x since-start local noise, >= ${ESTABLISH_MIN_EXTREME_COUNT} distinct new-extreme ticks, >= ${ESTABLISH_MIN_DURATION_MS / 1000}s duration.`,
  );
  console.log(
    "(Deliberately conservative and SEPARATE from the SURVIVED/FAILED resolution logic being calibrated -- no circularity.)",
  );

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
  console.log(`\nLoaded ${obs.length} raw OI observations.`);
  if (obs.length < 1000) {
    console.log("Too few observations.");
    await client.close();
    return;
  }

  console.log("\nScanning (this may take a bit)...");
  const { samples, processLog } = scanWithEstablishment(obs);

  const survived = samples.filter((s) => s.outcome === "SURVIVED");
  const failed = samples.filter((s) => s.outcome === "FAILED_TO_RESUME");
  const unresolved = samples.filter((s) => s.outcome === "UNRESOLVED");

  // ---- Sanity diagnostics (per operator's explicit request, BEFORE any stats) ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("SANITY DIAGNOSTICS");
  console.log("=".repeat(160));
  console.log(
    `Established directional processes: ${processLog.length}  (UP=${processLog.filter((p) => p.direction === "UP").length}, DOWN=${processLog.filter((p) => p.direction === "DOWN").length})`,
  );
  console.log(
    `Total counter-moves observed inside established processes: ${samples.length}`,
  );
  console.log(
    `SURVIVED: ${survived.length}   FAILED_TO_RESUME: ${failed.length}   UNRESOLVED: ${unresolved.length}`,
  );
  console.log(
    `Median established excursion BEFORE counter-move: ${fmtBtc(median(samples.map((s) => s.establishedExcursion)))} BTC`,
  );
  console.log(
    `Median number of prior same-direction extremes: ${median(samples.map((s) => s.priorExtremeCount))?.toFixed(1)}`,
  );
  console.log(
    `Median counter-move size: ${fmtBtc(median(samples.map((s) => s.counterMoveSize)))} BTC`,
  );

  console.log(
    `\n5 SMALLEST established directional processes accepted (sanity check against micro-moves):`,
  );
  const smallest5 = [...processLog]
    .sort((a, b) => a.excursionAtEstablishment - b.excursionAtEstablishment)
    .slice(0, 5);
  smallest5.forEach((p, idx) => {
    console.log(
      `  #${idx + 1}: ${p.direction}  start=${isoUtc(p.startTs)}  established=${isoUtc(p.establishedTs)}  excursion=${fmtBtc(p.excursionAtEstablishment)} BTC  extremeCount=${p.extremeCountAtEstablishment}  duration=${fmtDurationMin(p.durationMsAtEstablishment)}`,
    );
  });

  if (samples.length === 0) {
    console.log(
      "\nNo counter-moves were observed inside any established process. Calibration is impossible from this dataset under this establishment bar.",
    );
    await client.close();
    return;
  }

  // ---- Distributional comparison, WITH the statistical guard ----
  console.log(`\n${"=".repeat(160)}`);
  console.log(
    `DISTRIBUTIONAL COMPARISON (minimum N=${MIN_N_FOR_ANALYSIS} required per population before any separation claim)`,
  );
  console.log("=".repeat(160));

  console.log("\nSURVIVED_COUNTER_MOVE:");
  printStats(
    "counterMove/establishedExcursion",
    stats(survived.map((s) => s.ratioExcursion)),
  );
  printStats(
    "counterMove/localNoise(fixed-60)",
    stats(survived.map((s) => s.ratioLocalNoiseFixed)),
  );
  printStats(
    "counterMove/localNoise(since-process-start)",
    stats(survived.map((s) => s.ratioLocalNoiseAdaptive)),
  );

  console.log("\nFAILED_TO_RESUME:");
  printStats(
    "counterMove/establishedExcursion",
    stats(failed.map((s) => s.ratioExcursion)),
  );
  printStats(
    "counterMove/localNoise(fixed-60)",
    stats(failed.map((s) => s.ratioLocalNoiseFixed)),
  );
  printStats(
    "counterMove/localNoise(since-process-start)",
    stats(failed.map((s) => s.ratioLocalNoiseAdaptive)),
  );

  const survRatio = stats(survived.map((s) => s.ratioExcursion));
  const failRatio = stats(failed.map((s) => s.ratioExcursion));
  console.log(`\nOVERLAP CHECK (counterMove/establishedExcursion):`);
  if (survRatio.n < MIN_N_FOR_ANALYSIS || failRatio.n < MIN_N_FOR_ANALYSIS) {
    console.log(
      `  INSUFFICIENT SAMPLE FOR SEPARATION ANALYSIS (SURVIVED N=${survRatio.n}, FAILED N=${failRatio.n}, minimum ${MIN_N_FOR_ANALYSIS} each).`,
    );
  } else {
    const overlapLow = Math.max(survRatio.p25, failRatio.p25);
    const overlapHigh = Math.min(survRatio.p75, failRatio.p75);
    console.log(
      `  SURVIVED P25-P75=[${survRatio.p25.toFixed(3)}, ${survRatio.p75.toFixed(3)}]  FAILED P25-P75=[${failRatio.p25.toFixed(3)}, ${failRatio.p75.toFixed(3)}]`,
    );
    console.log(
      overlapHigh > overlapLow
        ? `  => Ranges OVERLAP: [${overlapLow.toFixed(3)}, ${overlapHigh.toFixed(3)}].`
        : `  => Ranges DO NOT overlap -- candidate separation near [${failRatio.p75.toFixed(3)}, ${survRatio.p25.toFixed(3)}].`,
    );
  }

  // ---- Fast vs slow, with the same guard ----
  const allSpeeds = samples
    .map((s) => s.speedBtcPerMin)
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  const speedMedian = median(allSpeeds);
  console.log(`\n${"=".repeat(160)}`);
  console.log(
    `FAST vs SLOW (split at sample's own median speed = ${speedMedian?.toFixed(2)} BTC/min)`,
  );
  console.log("=".repeat(160));
  for (const [label, filterFn] of [
    ["FAST", (s) => s.speedBtcPerMin > speedMedian],
    ["SLOW", (s) => s.speedBtcPerMin <= speedMedian],
  ]) {
    const survSub = survived.filter(filterFn),
      failSub = failed.filter(filterFn);
    console.log(
      `\n${label}: SURVIVED N=${survSub.length}, FAILED N=${failSub.length}`,
    );
    printStats(
      "  SURVIVED counterMove/excursion",
      stats(survSub.map((s) => s.ratioExcursion)),
    );
    printStats(
      "  FAILED counterMove/excursion",
      stats(failSub.map((s) => s.ratioExcursion)),
    );
  }

  console.log(`\n${"=".repeat(160)}`);
  console.log(
    "This never touches live strategy or trading logic. No threshold chosen. No price used.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
