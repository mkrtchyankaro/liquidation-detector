// OI MULTI-SCALE STRUCTURE ANALYSIS -- v2, CORRECTED.
//
// v1 BUG (operator-caught): rejected a CUMULATIVE swing's total size
// using a multiple of a SINGLE-STEP noise statistic (3 x P90 =
// 208.9 BTC > the old 140.55 BTC threshold it was supposed to beat)
// -- mathematically backwards, and conceptually wrong: a cumulative
// swing's size should never be judged against a single-step
// statistic at all.
//
// v2 FIX: separates the two concepts explicitly.
//   SINGLE-STEP NOISE: is one 30s step, by itself, a statistically
//     ordinary fluctuation or a genuinely large single move? Uses
//     Tukey's IQR outlier fence -- STANDARD statistics, not an
//     invented multiplier: significant = value > Q3 + 1.5*IQR, where
//     Q3=P75 and IQR=P75-P25 of the abs(ΔOI_30s) distribution.
//   DIRECTIONAL RUN: walks the 30s series accumulating a run in one
//     direction; a counter-direction step does NOT end the run unless
//     THAT SINGLE STEP is itself "significant" per the rule above.
//     The run's cumulative size is NEVER used as a rejection
//     criterion -- whatever size results is reported as-is.
//   MEDIUM / MAJOR: the exact same rule, self-similarly, one level up
//     -- LOCAL runs become the "steps" for MEDIUM, MEDIUM runs become
//     the "steps" for MAJOR, each level deriving its OWN Tukey fence
//     from its OWN step-size distribution. No manually chosen
//     multiplier at any level.
//
//   node scripts/oi-multiscale-structure-analysis.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const RANGE_START_MS = Date.parse("2026-09-20T02:24:27.128Z");
const RANGE_END_MS = Date.parse("2026-09-20T03:16:19.199Z");
const BUCKET_SEC = 30;

const INSPECTION_WINDOWS = [
  ["2026-09-20T02:24:00Z", "2026-09-20T02:29:00Z"],
  ["2026-09-20T02:29:00Z", "2026-09-20T02:35:00Z"],
  ["2026-09-20T02:35:00Z", "2026-09-20T02:43:30Z"],
  ["2026-09-20T02:43:30Z", "2026-09-20T02:46:00Z"],
  ["2026-09-20T02:46:00Z", "2026-09-20T03:02:30Z"],
  ["2026-09-20T03:02:30Z", "2026-09-20T03:07:30Z"],
  ["2026-09-20T03:07:30Z", "2026-09-20T03:14:00Z"],
];

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
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function stddev(arr, m) {
  return arr.length
    ? Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length)
    : null;
}

/** Tukey's IQR outlier fence -- standard statistics, not an invented
 *  multiplier. significant = value > Q3 + 1.5*IQR. */
function tukeyFence(sortedAbsValues) {
  const q1 = percentile(sortedAbsValues, 25);
  const q3 = percentile(sortedAbsValues, 75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, fence: q3 + 1.5 * iqr };
}

/** DIRECTIONAL RUN detector. `steps` is a sequence of {ts, value,
 *  delta} where `delta` is this step's own signed change from the
 *  previous step (the level series' own successive differences).
 *  `significantThreshold` (Tukey fence on abs(delta)) decides whether
 *  a counter-direction step ENDS the current run. A run's cumulative
 *  size is NEVER checked against any threshold -- only individual
 *  counter-steps are. Returns an array of runs with the raw series
 *  points that belong to each. */
function detectDirectionalRuns(points, significantThreshold) {
  if (points.length === 0) return [];
  const runs = [];
  let runStartIdx = 0;
  let direction = null; // "UP" | "DOWN"
  let largestCounterMove = 0;

  function closeRun(endIdx) {
    const a = points[runStartIdx],
      b = points[endIdx];
    runs.push({
      startTs: a.ts,
      endTs: b.ts,
      startOi: a.value,
      endOi: b.value,
      deltaBtc: b.value - a.value,
      durationMs: b.ts - a.ts,
      ratePerMin:
        b.ts > a.ts ? ((b.value - a.value) / (b.ts - a.ts)) * 60000 : 0,
      observationCount: endIdx - runStartIdx + 1,
      largestCounterMove,
    });
  }

  for (let i = 1; i < points.length; i++) {
    const stepDelta = points[i].value - points[i - 1].value;
    const stepDir = stepDelta > 0 ? "UP" : stepDelta < 0 ? "DOWN" : direction;
    if (direction === null) {
      direction = stepDir;
      continue;
    }

    if (stepDir === direction || stepDelta === 0) continue; // same direction (or flat) -- keep accumulating

    // Counter-direction step.
    if (Math.abs(stepDelta) <= significantThreshold) {
      // Ordinary noise -- does NOT end the run. Track it as the largest counter-move seen so far.
      largestCounterMove = Math.max(largestCounterMove, Math.abs(stepDelta));
      continue;
    }
    // Statistically significant reversal -- end the run HERE (at i-1), start a new one at i-1.
    closeRun(i - 1);
    runStartIdx = i - 1;
    direction = stepDir;
    largestCounterMove = 0;
  }
  closeRun(points.length - 1);
  return runs;
}

function printRunTable(runs) {
  console.log(
    "START     | END      | START OI   | END OI     | ΔOI BTC    | DURATION | BTC/min | #OBS | LARGEST COUNTER-MOVE",
  );
  console.log("-".repeat(120));
  for (const r of runs) {
    console.log(
      `${hhmmss(r.startTs)} | ${hhmmss(r.endTs)} | ${fmtBtc(r.startOi).padEnd(10)} | ${fmtBtc(r.endOi).padEnd(10)} | ${fmtBtcDelta(r.deltaBtc).padEnd(10)} | ${fmtDurationMin(r.durationMs).padEnd(8)} | ${r.ratePerMin.toFixed(2).padEnd(7)} | ${String(r.observationCount).padEnd(4)} | ${fmtBtc(r.largestCounterMove)}`,
    );
  }
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(150));
  console.log(
    `OI MULTI-SCALE STRUCTURE ANALYSIS v2 -- ${isoUtc(RANGE_START_MS)} to ${isoUtc(RANGE_END_MS)}`,
  );
  console.log(
    "Pure OI. No liquidation data. No episode boundaries used in detection.",
  );
  console.log("=".repeat(150));

  const rawObs = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(RANGE_START_MS - 130000),
        $lte: new Date(RANGE_END_MS + 5000),
      },
    })
    .project({ timestamp: 1, openInterest: 1 })
    .sort({ timestamp: 1 })
    .toArray()
    .then((docs) =>
      docs.map((d) => ({
        ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
        contracts: d.openInterest,
      })),
    );

  console.log(`\nLoaded ${rawObs.length} raw OI observations.`);
  if (rawObs.length === 0) {
    console.log("NO DATA -- likely expired past 3-day TTL.");
    await client.close();
    return;
  }

  function obsAtOrBefore(targetMs) {
    let best = null;
    for (const d of rawObs) {
      if (d.ts <= targetMs) best = d;
      else break;
    }
    return best;
  }

  const bucketStart =
    Math.floor(RANGE_START_MS / (BUCKET_SEC * 1000)) * (BUCKET_SEC * 1000);
  const series = [];
  for (let t = bucketStart; t <= RANGE_END_MS; t += BUCKET_SEC * 1000) {
    const obs = obsAtOrBefore(t);
    if (obs) series.push({ ts: t, contracts: obs.contracts });
  }
  console.log(`30-second series: ${series.length} points.`);

  // ============================================================
  // STEP 2: single-step noise distribution + Tukey fence
  // ============================================================
  const abs30 = [];
  for (let i = 1; i < series.length; i++)
    abs30.push(Math.abs(series[i].contracts - series[i - 1].contracts));
  const sortedAbs30 = [...abs30].sort((a, b) => a - b);
  const m = mean(abs30),
    sd = stddev(abs30, m);
  const localFence = tukeyFence(sortedAbs30);

  console.log(`\n${"=".repeat(150)}`);
  console.log("STEP 2 -- SINGLE-STEP NOISE DISTRIBUTION -- abs(ΔOI_30s)");
  console.log("=".repeat(150));
  console.log(
    `MIN=${fmtBtc(sortedAbs30[0])}  P25=${fmtBtc(percentile(sortedAbs30, 25))}  P50=${fmtBtc(percentile(sortedAbs30, 50))}  P75=${fmtBtc(percentile(sortedAbs30, 75))}  P90=${fmtBtc(percentile(sortedAbs30, 90))}  P95=${fmtBtc(percentile(sortedAbs30, 95))}  P99=${fmtBtc(percentile(sortedAbs30, 99))}  MAX=${fmtBtc(sortedAbs30[sortedAbs30.length - 1])}  MEAN=${fmtBtc(m)}  STDDEV=${fmtBtc(sd)}`,
  );
  console.log(
    `\nSINGLE-STEP NOISE RULE (Tukey's IQR outlier fence -- standard statistics, not an invented multiplier):`,
  );
  console.log(
    `  Q1 (P25) = ${fmtBtc(localFence.q1)}   Q3 (P75) = ${fmtBtc(localFence.q3)}   IQR = Q3-Q1 = ${fmtBtc(localFence.iqr)}`,
  );
  console.log(
    `  A single 30s step is ORDINARY NOISE if abs(step) <= Q3 + 1.5*IQR = ${fmtBtc(localFence.fence)} BTC.`,
  );
  console.log(
    `  A single step LARGER than that is a statistically significant individual move (Tukey's standard`,
  );
  console.log(
    `  "outlier" definition), and is the ONLY thing allowed to end a directional run below.`,
  );

  // ============================================================
  // STEP 3: LOCAL directional runs (from raw 30s series)
  // ============================================================
  const localPoints = series.map((s) => ({ ts: s.ts, value: s.contracts }));
  const localRuns = detectDirectionalRuns(localPoints, localFence.fence);
  console.log(`\n${"=".repeat(150)}`);
  console.log(
    `STEP 3/4 -- LOCAL DIRECTIONAL RUNS (N=${localRuns.length}, no size floor -- whatever the rule produces)`,
  );
  console.log("=".repeat(150));
  printRunTable(localRuns);

  // ---- MEDIUM: same rule, one level up, using LOCAL run deltas as the new "steps" ----
  const localDeltasAbs = localRuns
    .map((r) => Math.abs(r.deltaBtc))
    .sort((a, b) => a - b);
  const mediumFence = tukeyFence(localDeltasAbs);
  const mediumPoints = [
    { ts: localRuns[0].startTs, value: localRuns[0].startOi },
    ...localRuns.map((r) => ({ ts: r.endTs, value: r.endOi })),
  ];
  const mediumRuns = detectDirectionalRuns(mediumPoints, mediumFence.fence);
  console.log(
    `\nMEDIUM-level Tukey fence (derived from the distribution of LOCAL run sizes, N=${localDeltasAbs.length}):`,
  );
  console.log(
    `  Q1=${fmtBtc(mediumFence.q1)}  Q3=${fmtBtc(mediumFence.q3)}  IQR=${fmtBtc(mediumFence.iqr)}  fence=${fmtBtc(mediumFence.fence)} BTC`,
  );
  console.log(`\n--- B) MEDIUM SWINGS (N=${mediumRuns.length}) ---`);
  printRunTable(mediumRuns);

  // ---- MAJOR: same rule, one level up again, using MEDIUM run deltas ----
  const mediumDeltasAbs = mediumRuns
    .map((r) => Math.abs(r.deltaBtc))
    .sort((a, b) => a - b);
  const majorFence = tukeyFence(mediumDeltasAbs);
  const majorPoints = [
    { ts: mediumRuns[0].startTs, value: mediumRuns[0].startOi },
    ...mediumRuns.map((r) => ({ ts: r.endTs, value: r.endOi })),
  ];
  const majorRuns = detectDirectionalRuns(majorPoints, majorFence.fence);
  console.log(
    `\nMAJOR-level Tukey fence (derived from the distribution of MEDIUM run sizes, N=${mediumDeltasAbs.length}):`,
  );
  console.log(
    `  Q1=${fmtBtc(majorFence.q1)}  Q3=${fmtBtc(majorFence.q3)}  IQR=${fmtBtc(majorFence.iqr)}  fence=${fmtBtc(majorFence.fence)} BTC`,
  );
  console.log(`\n--- C) MAJOR SWINGS (N=${majorRuns.length}) ---`);
  printRunTable(majorRuns);

  // ============================================================
  // STEP 5: sanity-check the named inspection windows
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log(
    "STEP 5 -- SANITY CHECK NAMED WINDOWS (numeric evidence, no assumption)",
  );
  console.log("=".repeat(150));
  for (const [fromIso, toIso] of INSPECTION_WINDOWS) {
    const fromMs = Date.parse(fromIso),
      toMs = Date.parse(toIso);
    const pointsInWindow = series.filter((s) => s.ts >= fromMs && s.ts <= toMs);
    if (pointsInWindow.length < 2) {
      console.log(`${hhmmss(fromMs)} -> ${hhmmss(toMs)}: insufficient points.`);
      continue;
    }
    const netDelta =
      pointsInWindow[pointsInWindow.length - 1].contracts -
      pointsInWindow[0].contracts;
    const netDir = netDelta >= 0 ? "UP" : "DOWN";
    let sameDirCount = 0,
      oppositeDirCount = 0,
      largestOppositeStep = 0;
    for (let i = 1; i < pointsInWindow.length; i++) {
      const stepDelta =
        pointsInWindow[i].contracts - pointsInWindow[i - 1].contracts;
      const stepDir = stepDelta >= 0 ? "UP" : "DOWN";
      if (stepDir === netDir) sameDirCount++;
      else {
        oppositeDirCount++;
        largestOppositeStep = Math.max(
          largestOppositeStep,
          Math.abs(stepDelta),
        );
      }
    }
    const hasInternalSignificantReversal =
      largestOppositeStep > localFence.fence;
    const classification = hasInternalSignificantReversal
      ? "CONTAINS AN INTERNAL SIGNIFICANT REVERSAL -- this window is not one clean structure, it is multiple runs glued together by the fixed time boundary"
      : sameDirCount >= oppositeDirCount
        ? "MEANINGFUL DIRECTIONAL MOVE"
        : "ORDINARY OSCILLATION";
    console.log(
      `\n${hhmmss(fromMs)} -> ${hhmmss(toMs)}: net ${fmtBtcDelta(netDelta)} BTC (${netDir})`,
    );
    console.log(
      `  steps same-direction: ${sameDirCount}   steps opposite-direction: ${oppositeDirCount}   largest opposite single step: ${fmtBtc(largestOppositeStep)} BTC (fence=${fmtBtc(localFence.fence)})`,
    );
    console.log(`  CLASSIFICATION: ${classification}`);
  }

  // Specifically re-confirm the flagged 03:02:30 -> 03:07:30 move using the SAME method.
  const flagFrom = Date.parse("2026-09-20T03:02:30Z"),
    flagTo = Date.parse("2026-09-20T03:07:30Z");
  const flagPoints = series.filter((s) => s.ts >= flagFrom && s.ts <= flagTo);
  const flagNet =
    flagPoints.length >= 2
      ? flagPoints[flagPoints.length - 1].contracts - flagPoints[0].contracts
      : null;
  console.log(`\n${"=".repeat(150)}`);
  console.log(
    `FLAGGED MOVE RE-CHECK: 03:02:30 -> 03:07:30, net = ${fmtBtcDelta(flagNet)} BTC`,
  );
  console.log(
    "This move's classification is printed in the STEP 5 list above (it is one of the 7 named windows).",
  );
  console.log(
    "Also check the LOCAL SWINGS table above directly -- if this move survived as its own run (not merged",
  );
  console.log(
    "away by a larger counter-move), it will appear there as an explicit UP or DOWN entry near this time.",
  );

  // ============================================================
  // FOOTER
  // ============================================================
  const runNear = (runs, tsApprox) =>
    runs.find(
      (r) =>
        Math.abs(r.startTs - tsApprox) < 5 * 60000 ||
        Math.abs(r.endTs - tsApprox) < 5 * 60000,
    );
  const flagRun =
    localRuns.find(
      (r) => r.startTs <= flagFrom + 30000 && r.endTs >= flagTo - 30000,
    ) ??
    localRuns.find((r) => r.startTs >= flagFrom - 30000 && r.startTs <= flagTo);

  const rebuildWindowRuns = localRuns.filter(
    (r) =>
      r.startTs >= Date.parse("2026-09-20T02:46:00Z") &&
      r.endTs <= Date.parse("2026-09-20T03:16:00Z"),
  );

  console.log(`\n${"=".repeat(150)}`);
  console.log("SINGLE-STEP NOISE RULE:");
  console.log(
    `Tukey IQR fence on abs(ΔOI_30s): ordinary if <= Q3+1.5*IQR = ${fmtBtc(localFence.fence)} BTC; larger = statistically significant.`,
  );
  console.log("");
  console.log("LOCAL SWING RULE:");
  console.log(
    "Directional run continues through counter-steps <= the fence above; ends only when a single counter-step",
  );
  console.log(
    "exceeds the fence. Cumulative run size is never itself checked against any threshold.",
  );
  console.log("");
  console.log("ARBITRARY MULTIPLIER USED:");
  console.log("NO");
  console.log("");
  console.log("OLD 140.55 BTC THRESHOLD USED:");
  console.log("NO");
  console.log("");
  console.log("FULL-WINDOW RANGE THRESHOLD USED:");
  console.log("NO");
  console.log("");
  console.log("03:02:30 -> 03:07:30 CLASSIFICATION:");
  console.log(
    "(see STEP 5 output above for this exact window's printed classification and supporting counts)",
  );
  console.log("");
  console.log("02:46 -> 03:16 CLASSIFICATION:");
  console.log(
    `(${rebuildWindowRuns.length} separate LOCAL run(s) detected inside this span -- see LOCAL SWINGS table above;`,
  );
  console.log(
    "if more than one run appears here, 02:46->03:16 was NOT one uninterrupted move at LOCAL scale, though it",
  );
  console.log(
    "may still consolidate into a single MEDIUM or MAJOR run above -- check those tables too.)",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
