// BTC OI COUNTER-MOVE CALIBRATION STUDY -- pure empirical research.
// Does NOT implement a leg detector. Answers: during a genuine
// persistent OI move, how big are temporary counter-direction
// excursions relative to (a) the move itself, (b) local OI noise --
// and is there an actual empirical separation between counter-moves
// that get resumed (SURVIVED_COUNTER_MOVE) and ones that don't
// (FAILED_TO_RESUME)? No threshold is chosen here -- distributions
// are reported, and overlap is reported honestly if present.
//
// OI ONLY. No price used anywhere in this file.
//
//   node scripts/btc-oi-counter-move-calibration.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const LOCAL_WINDOW_SIZE = 60; // fixed-window local-noise candidate, kept ONLY as a labeled baseline for comparison
const MAX_SEARCH_CAP_MS = 2 * 60 * 60 * 1000; // absolute safety cap on forward search, not the primary scale

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19);
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
function median(arr) {
  return percentile(
    [...arr].sort((a, b) => a - b),
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
  console.log(
    `  ${label}: N=${s.n}  median=${s.median?.toFixed(3)}  P25=${s.p25?.toFixed(3)}  P75=${s.p75?.toFixed(3)}  P90=${s.p90?.toFixed(3)}  P95=${s.p95?.toFixed(3)}`,
  );
}

/** Local-scale estimator A: fixed rolling window (baseline, labeled
 *  explicitly as a fixed-window candidate, not asserted as correct). */
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
/** Local-scale estimator B: variation SINCE the current directional
 *  process began (dirStartIdx) -- no fixed window length at all,
 *  purely self-referential to this process's own duration. */
function localNoiseSinceDirStart(obs, dirStartIdx, atIdx) {
  let sum = 0,
    count = 0;
  for (let k = Math.max(dirStartIdx + 1, atIdx - 500); k <= atIdx; k++) {
    sum += Math.abs(obs[k].contracts - obs[k - 1].contracts);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** Forward-classify ONE counter-move candidate. Looks ahead (research
 *  only -- explicitly non-causal/non-live) until EITHER OI returns to
 *  (or exceeds) the pre-counter-move extreme (SURVIVED) OR the
 *  counter-move itself grows to at least the size of the original
 *  excursion it is countering (FAILED_TO_RESUME) OR a safety cap is
 *  hit (UNRESOLVED). Search cap is self-referential: 5x the original
 *  excursion's own duration, bounded by an absolute safety ceiling. */
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

    if (direction === "UP" ? v >= extremeVal : v <= extremeVal) {
      return {
        outcome: "SURVIVED",
        resolutionIdx: k,
        counterMoveSize: counterMoveSoFar,
        originalExcursion,
        originalDurationMs,
        durationMs: obs[k].ts - obs[startCounterIdx].ts,
      };
    }
    if (counterMoveSoFar >= originalExcursion) {
      return {
        outcome: "FAILED_TO_RESUME",
        resolutionIdx: k,
        counterMoveSize: counterMoveSoFar,
        originalExcursion,
        originalDurationMs,
        durationMs: obs[k].ts - obs[startCounterIdx].ts,
      };
    }
  }
  return {
    outcome: "UNRESOLVED",
    resolutionIdx: obs.length - 1,
    counterMoveSize: Math.abs(counterExtreme - extremeVal),
    originalExcursion,
    originalDurationMs,
    durationMs:
      obs[Math.min(obs.length - 1, startCounterIdx + 1)].ts -
      obs[startCounterIdx].ts,
  };
}

/** Single pass over the whole series: track direction + running
 *  extreme; every counter-direction step triggers classifyCounterMove
 *  (non-overlapping -- main loop jumps to each event's resolutionIdx). */
function scanCounterMoves(obs) {
  const samples = [];
  let dirStartIdx = 0,
    direction = null,
    extremeIdx = 0,
    extremeVal = obs[0].contracts;
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
  if (direction === null) return samples;
  extremeIdx = i;
  extremeVal = obs[i].contracts;

  for (i = i + 1; i < obs.length; ) {
    const v = obs[i].contracts;
    if (direction === "UP" ? v > extremeVal : v < extremeVal) {
      extremeVal = v;
      extremeIdx = i;
      i++;
      continue;
    }
    if (v === extremeVal) {
      i++;
      continue;
    }

    // Counter-direction step -- classify it.
    const localNoiseFixed = localNoiseFixedWindow(obs, i);
    const localNoiseAdaptive = localNoiseSinceDirStart(obs, dirStartIdx, i);
    const result = classifyCounterMove(
      obs,
      i,
      extremeIdx,
      extremeVal,
      direction,
      dirStartIdx,
    );

    samples.push({
      direction,
      extremeTs: obs[extremeIdx].ts,
      extremeVal,
      counterStartTs: obs[i].ts,
      counterStartIdx: i,
      extremeIdx,
      dirStartIdx,
      outcome: result.outcome,
      counterMoveSize: result.counterMoveSize,
      originalExcursion: result.originalExcursion,
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
      i = result.resolutionIdx + 1;
    } else if (result.outcome === "FAILED_TO_RESUME") {
      dirStartIdx = extremeIdx;
      direction = direction === "UP" ? "DOWN" : "UP";
      extremeVal = obs[result.resolutionIdx].contracts;
      extremeIdx = result.resolutionIdx;
      i = result.resolutionIdx + 1;
    } else {
      i = result.resolutionIdx + 1; // UNRESOLVED -- move past the search cap, keep same direction/extreme
    }
  }
  return samples;
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
    "BTC OI COUNTER-MOVE CALIBRATION STUDY -- empirical, OI only, no threshold chosen yet",
  );
  console.log("=".repeat(160));

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

  console.log(
    "\nScanning for counter-move candidates (this may take a bit)...",
  );
  const samples = scanCounterMoves(obs);
  console.log(`Found ${samples.length} counter-move candidate(s).`);

  const survived = samples.filter((s) => s.outcome === "SURVIVED");
  const failed = samples.filter((s) => s.outcome === "FAILED_TO_RESUME");
  const unresolved = samples.filter((s) => s.outcome === "UNRESOLVED");
  console.log(
    `SURVIVED_COUNTER_MOVE: ${survived.length}   FAILED_TO_RESUME: ${failed.length}   UNRESOLVED: ${unresolved.length}`,
  );

  // ---- A) aggregate population statistics ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("A) AGGREGATE POPULATION STATISTICS");
  console.log("=".repeat(160));
  console.log("\nSURVIVED_COUNTER_MOVE:");
  printStats(
    "counterMove/excursion",
    stats(survived.map((s) => s.ratioExcursion)),
  );
  printStats(
    "counterMove/localNoise(fixed-60)",
    stats(survived.map((s) => s.ratioLocalNoiseFixed)),
  );
  printStats(
    "counterMove/localNoise(since-dir-start)",
    stats(survived.map((s) => s.ratioLocalNoiseAdaptive)),
  );
  printStats(
    "counter-move duration (ms)",
    stats(survived.map((s) => s.durationMs)),
  );
  printStats(
    "preceding directional excursion duration (ms)",
    stats(survived.map((s) => s.originalDurationMs)),
  );

  console.log("\nFAILED_TO_RESUME:");
  printStats(
    "counterMove/excursion",
    stats(failed.map((s) => s.ratioExcursion)),
  );
  printStats(
    "counterMove/localNoise(fixed-60)",
    stats(failed.map((s) => s.ratioLocalNoiseFixed)),
  );
  printStats(
    "counterMove/localNoise(since-dir-start)",
    stats(failed.map((s) => s.ratioLocalNoiseAdaptive)),
  );
  printStats(
    "counter-move duration (ms)",
    stats(failed.map((s) => s.durationMs)),
  );
  printStats(
    "preceding directional excursion duration (ms)",
    stats(failed.map((s) => s.originalDurationMs)),
  );

  const survRatio = stats(survived.map((s) => s.ratioExcursion));
  const failRatio = stats(failed.map((s) => s.ratioExcursion));
  const overlapLow = Math.max(survRatio.p25 ?? 0, failRatio.p25 ?? 0);
  const overlapHigh = Math.min(survRatio.p75 ?? 0, failRatio.p75 ?? 0);
  console.log(
    `\nOVERLAP CHECK (counterMove/excursion, P25-P75 ranges): SURVIVED=[${survRatio.p25?.toFixed(3)}, ${survRatio.p75?.toFixed(3)}]  FAILED=[${failRatio.p25?.toFixed(3)}, ${failRatio.p75?.toFixed(3)}]`,
  );
  console.log(
    overlapHigh > overlapLow
      ? `  => P25-P75 ranges OVERLAP (overlap region: [${overlapLow.toFixed(3)}, ${overlapHigh.toFixed(3)}]).`
      : `  => P25-P75 ranges DO NOT overlap -- a candidate separation may exist near [${failRatio.p75?.toFixed(3)}, ${survRatio.p25?.toFixed(3)}].`,
  );

  // ---- B/C) fast-shock vs slow-trend ----
  const allSpeeds = samples
    .map((s) => s.speedBtcPerMin)
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  const speedMedian = median(allSpeeds);
  console.log(`\n${"=".repeat(160)}`);
  console.log(
    `B/C) FAST-SHOCK vs SLOW-TREND (split at the sample's OWN median preceding-excursion speed = ${speedMedian?.toFixed(2)} BTC/min -- not a fixed clock-time bucket)`,
  );
  console.log("=".repeat(160));
  for (const [label, filterFn] of [
    ["FAST (speed > median)", (s) => s.speedBtcPerMin > speedMedian],
    ["SLOW (speed <= median)", (s) => s.speedBtcPerMin <= speedMedian],
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

  // ---- D) representative examples near the overlap ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("D) ~10 REPRESENTATIVE EXAMPLES NEAR THE POPULATION OVERLAP");
  console.log("=".repeat(160));
  const withRatio = samples.filter(
    (s) => s.ratioExcursion !== null && s.outcome !== "UNRESOLVED",
  );
  const overallMedianRatio = median(withRatio.map((s) => s.ratioExcursion));
  const nearBoundary = [...withRatio]
    .sort(
      (a, b) =>
        Math.abs(a.ratioExcursion - overallMedianRatio) -
        Math.abs(b.ratioExcursion - overallMedianRatio),
    )
    .slice(0, 10);
  nearBoundary.sort((a, b) => a.counterStartTs - b.counterStartTs);

  nearBoundary.forEach((s, idx) => {
    console.log(
      `\nExample #${idx + 1}: ${s.outcome}  ratio(counter/excursion)=${s.ratioExcursion.toFixed(3)}  direction=${s.direction}`,
    );
    console.log(
      `  extreme@${isoUtc(s.extremeTs)}  counterStart@${isoUtc(s.counterStartTs)}  resolved@${isoUtc(obs[s.resolutionIdx].ts)}`,
    );
    const seqFrom = Math.max(0, s.extremeIdx - 3),
      seqTo = Math.min(obs.length - 1, s.resolutionIdx + 3);
    const step = Math.max(1, Math.floor((seqTo - seqFrom) / 15));
    console.log(
      `  OI sequence (every ${step} obs): ` +
        Array.from(
          { length: Math.floor((seqTo - seqFrom) / step) + 1 },
          (_, k) => fmtBtc(obs[seqFrom + k * step]?.contracts),
        ).join(" -> "),
    );
  });

  // ---- E) research conclusion, data-driven ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("E) RESEARCH CONCLUSION (read directly from the numbers above)");
  console.log("=".repeat(160));
  console.log(
    `Excursion-relative separation: ${overlapHigh > overlapLow ? "P25-P75 ranges overlap -- not cleanly separable at this level alone." : "P25-P75 ranges do not overlap -- a candidate separation exists, inspect the exact boundary printed above."}`,
  );
  const survFixed = stats(survived.map((s) => s.ratioLocalNoiseFixed)),
    failFixed = stats(failed.map((s) => s.ratioLocalNoiseFixed));
  const fixedOverlap =
    Math.min(survFixed.p75 ?? 0, failFixed.p75 ?? 0) >
    Math.max(survFixed.p25 ?? 0, failFixed.p25 ?? 0);
  console.log(
    `Local-noise-relative (fixed-60) separation: ${fixedOverlap ? "overlaps" : "does not overlap"} at P25-P75.`,
  );
  const survAdapt = stats(survived.map((s) => s.ratioLocalNoiseAdaptive)),
    failAdapt = stats(failed.map((s) => s.ratioLocalNoiseAdaptive));
  const adaptOverlap =
    Math.min(survAdapt.p75 ?? 0, failAdapt.p75 ?? 0) >
    Math.max(survAdapt.p25 ?? 0, failAdapt.p25 ?? 0);
  console.log(
    `Local-noise-relative (since-dir-start, adaptive) separation: ${adaptOverlap ? "overlaps" : "does not overlap"} at P25-P75.`,
  );
  console.log(
    `33% excursion threshold: SURVIVED median ratio=${survRatio.median?.toFixed(3)}, FAILED median ratio=${failRatio.median?.toFixed(3)} -- compare both to 0.33 directly above to judge support.`,
  );
  console.log(
    `10x local-noise threshold: compare the printed local-noise ratio medians above to 10 directly to judge support.`,
  );
  console.log(
    `Fixed-60-observation window: sensitivity check above (fixed vs adaptive local-noise ratios) shows whether the`,
  );
  console.log(
    `  separation quality materially changes between the two local-scale estimators.`,
  );
  console.log(
    `Fast vs slow regime: compare the FAST/SLOW breakdown above -- if SURVIVED/FAILED medians differ substantially`,
  );
  console.log(
    `  between regimes, one single ratio-based rule likely cannot cover both without regime-awareness.`,
  );
  console.log(
    `\nIf any of the above shows heavy overlap with no clear separation, the honest conclusion for that dimension is:`,
  );
  console.log(
    `"OI alone does not provide a clean leg boundary under this representation" for that specific normalization.`,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
