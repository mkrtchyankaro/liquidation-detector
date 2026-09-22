// PURE CONTINUOUS OI STORY -- no liquidation events used anywhere in
// this script. TIME -> RAW OI BTC -> PHASE, independent of episode
// boundaries. Episode markers are overlaid ONLY at the end, against
// phases detected purely from the OI series itself.
//
//   node scripts/oi-continuous-phase-analysis.js
//
// METHOD: a standard zigzag/swing detector on the 30s-bucketed OI
// series. A new turning point (peak or trough) is only registered
// once OI has moved by at least MIN_SWING_BTC from the last extreme
// -- MIN_SWING_BTC is DATA-DERIVED (a percentage of the observed
// OI range over the whole window), not an arbitrary fixed number,
// and is printed below before any phase is shown. This prevents
// every small noise wiggle from being counted as its own phase,
// without forcing phases to align with episodes in any way.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const RANGE_START_MS = Date.parse("2026-09-20T02:24:27.128Z");
const RANGE_END_MS = Date.parse("2026-09-20T03:16:19.199Z");
const BUCKET_SEC = 30;
const MIN_SWING_FRACTION_OF_RANGE = 0.08; // 8% of the observed OI range this window -- data-derived, printed below
const PAUSE_RATE_THRESHOLD_BTC_PER_MIN = 5; // |rate| below this counts as PAUSE regardless of sign

const MARKERS = [
  { label: "EP31 END", ms: Date.parse("2026-09-20T02:36:15.129Z") },
  { label: "EP32 START", ms: Date.parse("2026-09-20T02:39:21.185Z") },
  { label: "EP32 END", ms: Date.parse("2026-09-20T02:45:58.188Z") },
  { label: "EP33 START", ms: Date.parse("2026-09-20T02:54:09.182Z") },
  { label: "EP33 END", ms: Date.parse("2026-09-20T03:02:37.147Z") },
  { label: "EP34 START", ms: Date.parse("2026-09-20T03:14:42.177Z") },
  { label: "EP34 END", ms: Date.parse("2026-09-20T03:16:19.199Z") },
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

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(140));
  console.log(
    `PURE CONTINUOUS OI STORY -- ${isoUtc(RANGE_START_MS)} to ${isoUtc(RANGE_END_MS)}`,
  );
  console.log(
    "No liquidation events used. OI-only, continuous, phases detected independently of episode boundaries.",
  );
  console.log("=".repeat(140));

  const rawObs = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(RANGE_START_MS - 60000),
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
    console.log(
      "NO OI DATA -- likely expired past the 3-day TTL. Cannot proceed.",
    );
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

  // ---- 30-second bucketed timeline ----
  const bucketStart =
    Math.floor(RANGE_START_MS / (BUCKET_SEC * 1000)) * (BUCKET_SEC * 1000);
  const series = [];
  for (let t = bucketStart; t <= RANGE_END_MS; t += BUCKET_SEC * 1000) {
    const obs = obsAtOrBefore(t);
    if (obs) series.push({ ts: t, contracts: obs.contracts });
  }

  console.log(`\n${"=".repeat(140)}`);
  console.log(`30-SECOND OI TIMELINE (${series.length} points)`);
  console.log("=".repeat(140));
  console.log("TIME     | OI BTC");
  console.log("-".repeat(30));
  for (const pt of series)
    console.log(`${hhmmss(pt.ts)} | ${fmtBtc(pt.contracts)}`);

  // ---- Data-derived swing threshold ----
  const values = series.map((s) => s.contracts);
  const rangeMin = Math.min(...values),
    rangeMax = Math.max(...values);
  const minSwingBtc = (rangeMax - rangeMin) * MIN_SWING_FRACTION_OF_RANGE;
  console.log(`\n${"=".repeat(140)}`);
  console.log(
    `SWING THRESHOLD: observed OI range over full window = ${fmtBtc(rangeMin)} to ${fmtBtc(rangeMax)} (${fmtBtc(rangeMax - rangeMin)} BTC span).`,
  );
  console.log(
    `MIN_SWING_BTC = ${(MIN_SWING_FRACTION_OF_RANGE * 100).toFixed(0)}% of that span = ${fmtBtc(minSwingBtc)} BTC (data-derived, not an arbitrary fixed number).`,
  );

  // ---- Zigzag turning-point detection ----
  const turningPoints = [
    { idx: 0, ts: series[0].ts, contracts: series[0].contracts, kind: "start" },
  ];
  let direction = null; // "up" | "down" | null
  let extremeIdx = 0;
  let extremeVal = series[0].contracts;
  for (let i = 1; i < series.length; i++) {
    const v = series[i].contracts;
    if (direction === null) {
      if (v > extremeVal) {
        extremeVal = v;
        extremeIdx = i;
        direction = "up";
      } else if (v < extremeVal) {
        extremeVal = v;
        extremeIdx = i;
        direction = "down";
      }
      continue;
    }
    if (direction === "up") {
      if (v >= extremeVal) {
        extremeVal = v;
        extremeIdx = i;
      } else if (extremeVal - v >= minSwingBtc) {
        turningPoints.push({
          idx: extremeIdx,
          ts: series[extremeIdx].ts,
          contracts: extremeVal,
          kind: "peak",
        });
        direction = "down";
        extremeVal = v;
        extremeIdx = i;
      }
    } else {
      if (v <= extremeVal) {
        extremeVal = v;
        extremeIdx = i;
      } else if (v - extremeVal >= minSwingBtc) {
        turningPoints.push({
          idx: extremeIdx,
          ts: series[extremeIdx].ts,
          contracts: extremeVal,
          kind: "trough",
        });
        direction = "up";
        extremeVal = v;
        extremeIdx = i;
      }
    }
  }
  turningPoints.push({
    idx: series.length - 1,
    ts: series[series.length - 1].ts,
    contracts: series[series.length - 1].contracts,
    kind: "end",
  });

  // ---- Build phases between consecutive turning points ----
  const phases = [];
  let hasSeenMajorDecline = false;
  for (let i = 1; i < turningPoints.length; i++) {
    const a = turningPoints[i - 1],
      b = turningPoints[i];
    const deltaBtc = b.contracts - a.contracts;
    const durationMs = b.ts - a.ts;
    const ratePerMin = durationMs > 0 ? (deltaBtc / durationMs) * 60000 : 0;
    let label;
    if (Math.abs(ratePerMin) < PAUSE_RATE_THRESHOLD_BTC_PER_MIN)
      label = "PAUSE";
    else if (deltaBtc > 0) label = hasSeenMajorDecline ? "REBUILD" : "BUILD";
    else {
      label = hasSeenMajorDecline ? "DECLINE AGAIN" : "DECLINE / DELEVERAGING";
      hasSeenMajorDecline = true;
    }
    phases.push({
      label,
      startTs: a.ts,
      endTs: b.ts,
      startOi: a.contracts,
      endOi: b.contracts,
      deltaBtc,
      durationMs,
      ratePerMin,
    });
  }

  console.log(`\n${"=".repeat(140)}`);
  console.log(
    `DETECTED PHASES (independent of episode boundaries, N=${phases.length})`,
  );
  console.log("=".repeat(140));
  console.log(
    "PHASE                  | START    | END      | START OI   | END OI     | ΔOI BTC    | DURATION | RATE (BTC/min)",
  );
  console.log("-".repeat(140));
  for (const ph of phases) {
    console.log(
      `${ph.label.padEnd(23)} | ${hhmmss(ph.startTs)} | ${hhmmss(ph.endTs)} | ${fmtBtc(ph.startOi).padEnd(10)} | ${fmtBtc(ph.endOi).padEnd(10)} | ${fmtBtcDelta(ph.deltaBtc).padEnd(10)} | ${fmtDurationMin(ph.durationMs).padEnd(8)} | ${ph.ratePerMin.toFixed(2)}`,
    );
  }

  // ---- Major collapse identification ----
  const declinePhases = phases.filter((p) => p.label.startsWith("DECLINE"));
  const majorCollapse =
    declinePhases.length > 0
      ? declinePhases.reduce((worst, p) =>
          p.deltaBtc < worst.deltaBtc ? p : worst,
        )
      : null;

  console.log(`\n${"=".repeat(140)}`);
  console.log("MAJOR COLLAPSE IDENTIFICATION");
  console.log("=".repeat(140));
  if (majorCollapse) {
    console.log(
      `Peak before collapse: ${hhmmss(majorCollapse.startTs)}  OI=${fmtBtc(majorCollapse.startOi)} BTC`,
    );
    console.log(
      `Trough after collapse: ${hhmmss(majorCollapse.endTs)}  OI=${fmtBtc(majorCollapse.endOi)} BTC`,
    );
    console.log(
      `Peak -> trough OI destroyed: ${fmtBtcDelta(majorCollapse.deltaBtc)} BTC`,
    );

    const collapseEndIdx = phases.indexOf(majorCollapse);
    const nextRebuild = phases
      .slice(collapseEndIdx + 1)
      .find((p) => p.label === "REBUILD");
    if (nextRebuild) {
      console.log(`\nSustained rebuild begins: ${hhmmss(nextRebuild.startTs)}`);
      console.log(
        `Trough -> next major peak rebuild: ${fmtBtcDelta(nextRebuild.deltaBtc)} BTC (ends ${hhmmss(nextRebuild.endTs)}, OI=${fmtBtc(nextRebuild.endOi)})`,
      );
      const afterRebuildIdx = phases.indexOf(nextRebuild);
      const afterPhase = phases[afterRebuildIdx + 1];
      console.log(
        `\nAfter that peak: ${afterPhase ? `${afterPhase.label} (${hhmmss(afterPhase.startTs)} -> ${hhmmss(afterPhase.endTs)}, ${fmtBtcDelta(afterPhase.deltaBtc)} BTC)` : "no further phase detected (end of window)"}`,
      );
    } else {
      console.log(
        "\nNo REBUILD phase detected after the major collapse within this window.",
      );
    }
  } else {
    console.log(
      "No DECLINE phase detected at all in this window (OI did not swing down by the threshold amount).",
    );
  }

  // ---- Overlay episode markers ----
  console.log(`\n${"=".repeat(140)}`);
  console.log(
    "EPISODE MARKER OVERLAY (checked against phases detected purely from OI, above)",
  );
  console.log("=".repeat(140));
  const TURNING_POINT_TOLERANCE_MS = 30_000; // within one bucket width of a detected turning point
  for (const m of MARKERS) {
    const containingPhase = phases.find(
      (p) => m.ms >= p.startTs && m.ms <= p.endTs,
    );
    const nearTurningPoint = turningPoints.find(
      (tp) => Math.abs(tp.ts - m.ms) <= TURNING_POINT_TOLERANCE_MS,
    );
    let verdict;
    if (nearTurningPoint)
      verdict = `COINCIDES with a detected OI turning point (${nearTurningPoint.kind} @ ${hhmmss(nearTurningPoint.ts)}, within ${(Math.abs(nearTurningPoint.ts - m.ms) / 1000).toFixed(1)}s)`;
    else if (containingPhase)
      verdict = `occurs in the MIDDLE of phase "${containingPhase.label}" (${hhmmss(containingPhase.startTs)} -> ${hhmmss(containingPhase.endTs)}) -- OI regime continues through this marker`;
    else verdict = "outside all detected phase ranges (edge of data)";
    console.log(`${m.label.padEnd(12)} (${hhmmss(m.ms)}): ${verdict}`);
  }

  // ---- Final simple visual story ----
  console.log(`\n${"=".repeat(140)}`);
  console.log("SIMPLE VISUAL STORY");
  console.log("=".repeat(140));
  for (const ph of phases) {
    console.log(
      `${hhmmss(ph.startTs)} -> ${hhmmss(ph.endTs)}   ${ph.label.padEnd(23)} ${fmtBtcDelta(ph.deltaBtc)} BTC`,
    );
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
