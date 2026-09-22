// BTC OI EPISODE DISCOVERY -- pure Open Interest structure, no
// liquidation data, no price-based detection, no previous P90 logic.
// Research/measurement tool only.
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
  // PART 1: descriptive distributions
  // ============================================================
  console.log(`\n${"=".repeat(160)}`);
  console.log(
    "PART 1 -- DESCRIPTIVE OI CHANGE DISTRIBUTIONS (absolute BTC, by horizon)",
  );
  console.log("=".repeat(160));

  const horizonDefs = [
    { label: "1s", ms: 1000, tol: 500 },
    { label: "5s", ms: 5000, tol: 1500 },
    { label: "10s", ms: 10000, tol: 3000 },
    { label: "30s", ms: 30000, tol: 5000 },
    { label: "60s", ms: 60000, tol: 8000 },
  ];
  const horizonStats = {};
  for (const h of horizonDefs) {
    const deltas = horizonDeltas(obs, h.ms, h.tol)
      .map((d) => Math.abs(d))
      .sort((a, b) => a - b);
    const m = mean(deltas),
      sd = stddev(deltas, m);
    horizonStats[h.label] = { deltas, m, sd };
    console.log(
      `\n${h.label} horizon (N=${deltas.length} paired observations, tolerance ±${h.tol}ms):`,
    );
    console.log(
      `  MIN=${fmtBtc(deltas[0])}  P25=${fmtBtc(percentile(deltas, 25))}  P50=${fmtBtc(percentile(deltas, 50))}  P75=${fmtBtc(percentile(deltas, 75))}  P90=${fmtBtc(percentile(deltas, 90))}  P95=${fmtBtc(percentile(deltas, 95))}  P99=${fmtBtc(percentile(deltas, 99))}  MAX=${fmtBtc(deltas[deltas.length - 1])}  MEAN=${fmtBtc(m)}  STDDEV=${fmtBtc(sd)}`,
    );
  }

  console.log(
    `\nDIRECTIONAL RUN LENGTHS (raw, zero-threshold -- every direction flip ends a run, descriptive only):`,
  );
  const rawDurationsSec = rawRunDurations(obs)
    .map((ms) => ms / 1000)
    .sort((a, b) => a - b);
  console.log(
    `  N=${rawDurationsSec.length}  MIN=${rawDurationsSec[0]?.toFixed(1)}s  P50=${percentile(rawDurationsSec, 50)?.toFixed(1)}s  P90=${percentile(rawDurationsSec, 90)?.toFixed(1)}s  MAX=${rawDurationsSec[rawDurationsSec.length - 1]?.toFixed(1)}s  MEAN=${mean(rawDurationsSec)?.toFixed(1)}s`,
  );

  // ============================================================
  // PART 2/3: multiple candidate scales, each derived from the data
  // ============================================================
  console.log(`\n${"=".repeat(160)}`);
  console.log(
    "PART 2/3 -- CANDIDATE SCALES (each derived from its OWN horizon's observed distribution)",
  );
  console.log("=".repeat(160));

  const sensitiveFence = tukeyFence(horizonStats["1s"].deltas);
  const normalFence = tukeyFence(horizonStats["10s"].deltas);
  const strongFence = tukeyFence(horizonStats["60s"].deltas);

  const scales = [
    {
      name: "SENSITIVE",
      derivation: "Tukey IQR fence on abs(ΔOI over 1s) pairs",
      fence: sensitiveFence,
    },
    {
      name: "NORMAL",
      derivation: "Tukey IQR fence on abs(ΔOI over 10s) pairs",
      fence: normalFence,
    },
    {
      name: "STRONG",
      derivation: "Tukey IQR fence on abs(ΔOI over 60s) pairs",
      fence: strongFence,
    },
  ];

  for (const scale of scales) {
    console.log(`\n${scale.name}: ${scale.derivation}`);
    console.log(
      `  Q1=${fmtBtc(scale.fence.q1)}  Q3=${fmtBtc(scale.fence.q3)}  IQR=${fmtBtc(scale.fence.iqr)}  significance threshold (single-step) = ${fmtBtc(scale.fence.fence)} BTC`,
    );
  }
  console.log(
    `\nNote: "significance threshold" above is a standard statistical outlier fence (Tukey, Q3+1.5*IQR) on real`,
  );
  console.log(
    `observed step-size distributions -- not labeled "statistically significant" in the hypothesis-testing sense,`,
  );
  console.log(
    `since no significance test was performed; it is only the conventional IQR-based outlier boundary.`,
  );

  const scaleResults = {};
  for (const scale of scales) {
    const episodes = detectOiEpisodes(obs, scale.fence.fence);
    scaleResults[scale.name] = episodes;
  }

  // ============================================================
  // PART 4: output for manual chart review, per scale
  // ============================================================
  for (const scale of scales) {
    const episodes = scaleResults[scale.name];
    console.log(`\n${"=".repeat(160)}`);
    console.log(
      `${scale.name} SCALE -- ${episodes.length} episode(s) detected`,
    );
    console.log("=".repeat(160));

    episodes.forEach((ep, idx) => {
      console.log(`\n${scale.name}-EP${idx + 1}`);
      console.log(`TYPE: ${ep.type}`);
      console.log(
        `START UTC: ${isoUtc(ep.startTs)}   EXTREME UTC: ${isoUtc(ep.extremeTs)}   END UTC: ${isoUtc(ep.endTs)}`,
      );
      console.log(
        `START OI: ${fmtBtc(ep.startOi)}   EXTREME OI: ${fmtBtc(ep.extremeOi)}   END OI: ${fmtBtc(ep.endOi)}`,
      );
      console.log(
        `START -> EXTREME ΔOI BTC: ${fmtBtcDelta(ep.deltaStartToExtremeBtc)}   ΔOI %: ${fmtPct(ep.deltaStartToExtremePct)}`,
      );
      console.log(
        `DURATION TO EXTREME: ${fmtDurationMin(ep.durationToExtremeMs)}   TOTAL EPISODE DURATION: ${fmtDurationMin(ep.totalDurationMs)}`,
      );
      console.log(
        `AVERAGE OI SPEED: ${ep.avgSpeedBtcPerMin.toFixed(2)} BTC/min   MAX OI SPEED: ${ep.maxSpeedBtcPerMin.toFixed(2)} BTC/min`,
      );
      console.log(
        `PRICE AT START: ${fmtPrice(ep.startPrice)}   PRICE AT EXTREME: ${fmtPrice(ep.extremePrice)}   PRICE AT END: ${fmtPrice(ep.endPrice)}   (observational only, not used in detection)`,
      );
    });

    console.log(`\n${scale.name} COMPACT TABLE (chronological):`);
    console.log(
      "ID              | TYPE         | START                    | EXTREME                  | END                      | ΔOI BTC    | DURATION | START PRICE  | EXTREME PRICE | END PRICE",
    );
    console.log("-".repeat(180));
    episodes.forEach((ep, idx) => {
      console.log(
        `${scale.name}-EP${String(idx + 1).padEnd(3)} | ${ep.type.padEnd(12)} | ${isoUtc(ep.startTs)} | ${isoUtc(ep.extremeTs)} | ${isoUtc(ep.endTs)} | ${fmtBtcDelta(ep.deltaStartToExtremeBtc).padEnd(10)} | ${fmtDurationMin(ep.totalDurationMs).padEnd(8)} | ${fmtPrice(ep.startPrice).padEnd(12)} | ${fmtPrice(ep.extremePrice).padEnd(13)} | ${fmtPrice(ep.endPrice)}`,
      );
    });
  }

  // ============================================================
  // PART 5: validation
  // ============================================================
  console.log(`\n${"=".repeat(160)}`);
  console.log("PART 5 -- VALIDATION");
  console.log("=".repeat(160));
  for (const scale of scales) {
    const episodes = scaleResults[scale.name];
    let allValid = true;
    let overlapCount = 0;
    for (let idx = 0; idx < episodes.length; idx++) {
      const ep = episodes[idx];
      const extremeOk =
        ep.type === "BUILD"
          ? ep.extremeOi >= ep.startOi
          : ep.extremeOi <= ep.startOi;
      if (!extremeOk) {
        allValid = false;
        console.log(
          `  ${scale.name}-EP${idx + 1}: FAILED extreme validation (type=${ep.type}, start=${ep.startOi}, extreme=${ep.extremeOi})`,
        );
      }
      if (idx > 0 && ep.startTs < episodes[idx - 1].endTs) overlapCount++;
    }
    console.log(
      `${scale.name}: ${episodes.length} episode(s), extreme-validation ${allValid ? "PASSED for all" : "FAILED for some (see above)"}, overlap count=${overlapCount} (episodes are sequential by construction -- each new episode starts exactly where the previous one's significant reversal was detected, so overlap should be 0 unless noted).`,
    );
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
