// OI MULTI-SCALE STRUCTURE ANALYSIS -- pure OI, no liquidation data,
// no episode boundaries used anywhere in detection. Discards the old
// 8%-of-full-window-range swing threshold entirely. Threshold is now
// derived ONLY from the actual 30-second ΔOI noise distribution.
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
  ["2026-09-20T03:14:00Z", "2026-09-20T03:16:19Z"],
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

/** Generic zigzag/swing detector, parametrized by threshold. Returns
 *  the sequence of turning points (peaks/troughs) on `series`. */
function zigzag(series, thresholdBtc) {
  if (series.length === 0) return [];
  const turningPoints = [
    { idx: 0, ts: series[0].ts, contracts: series[0].contracts, kind: "start" },
  ];
  let direction = null;
  let extremeIdx = 0,
    extremeVal = series[0].contracts;
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
      } else if (extremeVal - v >= thresholdBtc) {
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
      } else if (v - extremeVal >= thresholdBtc) {
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
  return turningPoints;
}
function swingsFromTurningPoints(turningPoints) {
  const swings = [];
  for (let i = 1; i < turningPoints.length; i++) {
    const a = turningPoints[i - 1],
      b = turningPoints[i];
    const deltaBtc = b.contracts - a.contracts;
    const durationMs = b.ts - a.ts;
    const ratePerMin = durationMs > 0 ? (deltaBtc / durationMs) * 60000 : 0;
    swings.push({
      direction: deltaBtc >= 0 ? "UP" : "DOWN",
      startTs: a.ts,
      endTs: b.ts,
      startOi: a.contracts,
      endOi: b.contracts,
      deltaBtc,
      durationMs,
      ratePerMin,
    });
  }
  return swings;
}
function printSwingTable(swings) {
  console.log(
    "DIRECTION | START    | END      | START OI   | END OI     | ΔOI BTC    | DURATION | BTC/min",
  );
  console.log("-".repeat(100));
  for (const s of swings) {
    console.log(
      `${s.direction.padEnd(9)} | ${hhmmss(s.startTs)} | ${hhmmss(s.endTs)} | ${fmtBtc(s.startOi).padEnd(10)} | ${fmtBtc(s.endOi).padEnd(10)} | ${fmtBtcDelta(s.deltaBtc).padEnd(10)} | ${fmtDurationMin(s.durationMs).padEnd(8)} | ${s.ratePerMin.toFixed(2)}`,
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
    `OI MULTI-SCALE STRUCTURE ANALYSIS -- ${isoUtc(RANGE_START_MS)} to ${isoUtc(RANGE_END_MS)}`,
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

  // ============================================================
  // STEP 1: 30-second series with ΔOI 30s/60s/120s + velocities
  // ============================================================
  const bucketStart =
    Math.floor(RANGE_START_MS / (BUCKET_SEC * 1000)) * (BUCKET_SEC * 1000);
  const series = [];
  for (let t = bucketStart; t <= RANGE_END_MS; t += BUCKET_SEC * 1000) {
    const obs = obsAtOrBefore(t);
    if (obs) series.push({ ts: t, contracts: obs.contracts });
  }

  console.log(`\n${"=".repeat(150)}`);
  console.log(`STEP 1 -- 30-SECOND OI SERIES (${series.length} points)`);
  console.log("=".repeat(150));
  console.log(
    "TIME     | OI BTC     | ΔOI 30s   | ΔOI 60s   | ΔOI 120s  | VEL 30s(BTC/min) | VEL 60s(BTC/min) | VEL 120s(BTC/min)",
  );
  console.log("-".repeat(150));
  for (let i = 0; i < series.length; i++) {
    const d30 = i >= 1 ? series[i].contracts - series[i - 1].contracts : null;
    const d60 = i >= 2 ? series[i].contracts - series[i - 2].contracts : null;
    const d120 = i >= 4 ? series[i].contracts - series[i - 4].contracts : null;
    const v30 = d30 !== null ? (d30 / 30) * 60 : null;
    const v60 = d60 !== null ? (d60 / 60) * 60 : null;
    const v120 = d120 !== null ? (d120 / 120) * 60 : null;
    console.log(
      `${hhmmss(series[i].ts)} | ${fmtBtc(series[i].contracts).padEnd(10)} | ${fmtBtcDelta(d30).padEnd(9)} | ${fmtBtcDelta(d60).padEnd(9)} | ${fmtBtcDelta(d120).padEnd(9)} | ${(v30 !== null ? v30.toFixed(2) : "N/A").padEnd(16)} | ${(v60 !== null ? v60.toFixed(2) : "N/A").padEnd(16)} | ${v120 !== null ? v120.toFixed(2) : "N/A"}`,
    );
  }

  // ============================================================
  // STEP 2: local noise scale distribution
  // ============================================================
  const abs30 = [];
  for (let i = 1; i < series.length; i++)
    abs30.push(Math.abs(series[i].contracts - series[i - 1].contracts));
  const sortedAbs30 = [...abs30].sort((a, b) => a - b);
  const m = mean(abs30),
    sd = stddev(abs30, m);

  console.log(`\n${"=".repeat(150)}`);
  console.log(
    "STEP 2 -- DISTRIBUTION OF abs(ΔOI_30s)  (N=" + abs30.length + ")",
  );
  console.log("=".repeat(150));
  console.log(`MIN:    ${fmtBtc(sortedAbs30[0])}`);
  console.log(`P25:    ${fmtBtc(percentile(sortedAbs30, 25))}`);
  console.log(`P50:    ${fmtBtc(percentile(sortedAbs30, 50))}`);
  console.log(`P75:    ${fmtBtc(percentile(sortedAbs30, 75))}`);
  console.log(`P90:    ${fmtBtc(percentile(sortedAbs30, 90))}`);
  console.log(`P95:    ${fmtBtc(percentile(sortedAbs30, 95))}`);
  console.log(`P99:    ${fmtBtc(percentile(sortedAbs30, 99))}`);
  console.log(`MAX:    ${fmtBtc(sortedAbs30[sortedAbs30.length - 1])}`);
  console.log(`MEAN:   ${fmtBtc(m)}`);
  console.log(`STDDEV: ${fmtBtc(sd)}`);

  // ============================================================
  // STEP 3: raw local extremes, NO filtering at all
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log(
    "STEP 3 -- RAW LOCAL EXTREMES (no filtering -- every direction change)",
  );
  console.log("=".repeat(150));
  const rawTurningPoints = zigzag(series, 0.0000001); // effectively zero threshold -- every direction change registers
  console.log(
    `Found ${rawTurningPoints.length} raw candidates (including start/end markers).`,
  );
  console.log(
    "KIND    | TIME     | OI BTC     | ΔOI from prev candidate | DURATION | BTC/min",
  );
  console.log("-".repeat(100));
  for (let i = 0; i < rawTurningPoints.length; i++) {
    const tp = rawTurningPoints[i];
    const prev = i > 0 ? rawTurningPoints[i - 1] : null;
    const delta = prev ? tp.contracts - prev.contracts : null;
    const durMs = prev ? tp.ts - prev.ts : null;
    const rate = delta !== null && durMs > 0 ? (delta / durMs) * 60000 : null;
    console.log(
      `${tp.kind.padEnd(7)} | ${hhmmss(tp.ts)} | ${fmtBtc(tp.contracts).padEnd(10)} | ${fmtBtcDelta(delta).padEnd(23)} | ${durMs !== null ? fmtDurationMin(durMs).padEnd(8) : "N/A".padEnd(8)} | ${rate !== null ? rate.toFixed(2) : "N/A"}`,
    );
  }

  // ============================================================
  // STEP 4: derive MICRO_NOISE_THRESHOLD
  // ============================================================
  const p90 = percentile(sortedAbs30, 90);
  const MICRO_NOISE_THRESHOLD = 3 * p90;
  console.log(`\n${"=".repeat(150)}`);
  console.log("STEP 4 -- MICRO-NOISE FILTER DERIVATION");
  console.log("=".repeat(150));
  console.log(
    `MICRO_NOISE_THRESHOLD = 3 x P90(abs(ΔOI_30s)) = 3 x ${fmtBtc(p90)} = ${fmtBtc(MICRO_NOISE_THRESHOLD)} BTC`,
  );
  console.log(
    `DERIVATION = P90 of single-30s-step absolute changes represents the size of a typical noisy single`,
  );
  console.log(
    `step; requiring a cumulative swing of 3x that (not derived from the full-window OI range at all)`,
  );
  console.log(
    `means a swing must clear roughly three ordinary noise-steps' worth of movement to count as real --`,
  );
  console.log(
    `well below the old 140.55 BTC (8%-of-range) threshold, so genuine 20-100 BTC moves are NOT discarded.`,
  );

  // ============================================================
  // STEP 5: THREE separate structures -- LOCAL, MEDIUM, MAJOR
  // ============================================================
  const MEDIUM_THRESHOLD = MICRO_NOISE_THRESHOLD * 3;
  const MAJOR_THRESHOLD = MICRO_NOISE_THRESHOLD * 10;
  console.log(`\n${"=".repeat(150)}`);
  console.log("STEP 5 -- THREE SEPARATE SWING STRUCTURES");
  console.log("=".repeat(150));
  console.log(
    `LOCAL threshold  = MICRO_NOISE_THRESHOLD        = ${fmtBtc(MICRO_NOISE_THRESHOLD)} BTC`,
  );
  console.log(
    `MEDIUM threshold = 3 x MICRO_NOISE_THRESHOLD    = ${fmtBtc(MEDIUM_THRESHOLD)} BTC`,
  );
  console.log(
    `MAJOR threshold  = 10 x MICRO_NOISE_THRESHOLD   = ${fmtBtc(MAJOR_THRESHOLD)} BTC`,
  );

  const localTP = zigzag(series, MICRO_NOISE_THRESHOLD);
  const mediumTP = zigzag(series, MEDIUM_THRESHOLD);
  const majorTP = zigzag(series, MAJOR_THRESHOLD);
  const localSwings = swingsFromTurningPoints(localTP);
  const mediumSwings = swingsFromTurningPoints(mediumTP);
  const majorSwings = swingsFromTurningPoints(majorTP);

  console.log(`\n--- A) LOCAL SWINGS (N=${localSwings.length}) ---`);
  printSwingTable(localSwings);
  console.log(`\n--- B) MEDIUM SWINGS (N=${mediumSwings.length}) ---`);
  printSwingTable(mediumSwings);
  console.log(`\n--- C) MAJOR SWINGS (N=${majorSwings.length}) ---`);
  printSwingTable(majorSwings);

  // ============================================================
  // STEP 6: special inspection windows + the flagged ~98 BTC move
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log(
    "STEP 6 -- SPECIAL INSPECTION WINDOWS (raw start/end OI, independent of swing detection)",
  );
  console.log("=".repeat(150));
  for (const [fromIso, toIso] of INSPECTION_WINDOWS) {
    const fromMs = Date.parse(fromIso),
      toMs = Date.parse(toIso);
    const startObs = obsAtOrBefore(fromMs);
    const endObs = obsAtOrBefore(toMs);
    const delta =
      startObs && endObs ? endObs.contracts - startObs.contracts : null;
    console.log(
      `${hhmmss(fromMs)} -> ${hhmmss(toMs)}: OI ${fmtBtc(startObs?.contracts)} -> ${fmtBtc(endObs?.contracts)}  (Δ ${fmtBtcDelta(delta)})`,
    );
  }

  const flagStart = obsAtOrBefore(Date.parse("2026-09-20T03:02:30Z"));
  const flagEnd = obsAtOrBefore(Date.parse("2026-09-20T03:07:30Z"));
  const flagDelta =
    flagStart && flagEnd ? flagEnd.contracts - flagStart.contracts : null;
  console.log(
    `\nFLAGGED MOVE 03:02:30 -> 03:07:30: OI ${fmtBtc(flagStart?.contracts)} -> ${fmtBtc(flagEnd?.contracts)}  (Δ ${fmtBtcDelta(flagDelta)})`,
  );
  console.log(
    `Compared to MICRO_NOISE_THRESHOLD (${fmtBtc(MICRO_NOISE_THRESHOLD)}) and MEDIUM_THRESHOLD (${fmtBtc(MEDIUM_THRESHOLD)}):`,
  );
  console.log(
    `  abs(flagged delta) ${Math.abs(flagDelta) > MICRO_NOISE_THRESHOLD ? "EXCEEDS" : "does NOT exceed"} LOCAL threshold.`,
  );
  console.log(
    `  abs(flagged delta) ${Math.abs(flagDelta) > MEDIUM_THRESHOLD ? "EXCEEDS" : "does NOT exceed"} MEDIUM threshold.`,
  );
  console.log(
    `  This move ${Math.abs(flagDelta) > MICRO_NOISE_THRESHOLD ? "DOES register as its own swing at LOCAL scale (check the LOCAL SWINGS table above for its exact entry)." : "is filtered out even at LOCAL scale -- it is within the derived noise floor."}`,
  );

  // ============================================================
  // STEP 7: nested structure -- MAJOR contains MEDIUM contains LOCAL
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log("STEP 7 -- NESTED STRUCTURE (MAJOR > MEDIUM > LOCAL)");
  console.log("=".repeat(150));
  for (const major of majorSwings) {
    console.log(
      `\nMAJOR ${major.direction} MOVE: ${hhmmss(major.startTs)} -> ${hhmmss(major.endTs)}  (${fmtBtcDelta(major.deltaBtc)} BTC)`,
    );
    const mediumInside = mediumSwings.filter(
      (s) => s.startTs >= major.startTs && s.endTs <= major.endTs,
    );
    for (const med of mediumInside) {
      console.log(
        `   MEDIUM ${med.direction}: ${hhmmss(med.startTs)} -> ${hhmmss(med.endTs)}  (${fmtBtcDelta(med.deltaBtc)} BTC)`,
      );
      const localInside = localSwings.filter(
        (s) => s.startTs >= med.startTs && s.endTs <= med.endTs,
      );
      for (const loc of localInside) {
        console.log(
          `      LOCAL ${loc.direction}: ${hhmmss(loc.startTs)} -> ${hhmmss(loc.endTs)}  (${fmtBtcDelta(loc.deltaBtc)} BTC)`,
        );
      }
    }
  }

  // ============================================================
  // FOOTER
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log("SCRIPT CREATED:");
  console.log("scripts/oi-multiscale-structure-analysis.js");
  console.log("");
  console.log("OLD 140.55 BTC THRESHOLD USED:");
  console.log("NO");
  console.log("");
  console.log("FULL-WINDOW 8% ZIGZAG USED:");
  console.log("NO");
  console.log("");
  console.log("LIQUIDATION DATA USED:");
  console.log("NO");
  console.log("");
  console.log("EPISODE BOUNDARIES USED FOR DETECTION:");
  console.log("NO");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
