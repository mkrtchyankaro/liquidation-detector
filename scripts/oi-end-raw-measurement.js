// OI END RAW MEASUREMENT -- pure measurement tool, NOT a decision
// algorithm. No thresholds, no Tukey, no percentiles, no swing
// detection, no classification of any kind anywhere in this file.
//
//   node scripts/oi-end-raw-measurement.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EPISODES = [
  { name: "EP31", endMs: Date.parse("2026-09-20T02:36:15.129Z") },
  { name: "EP32", endMs: Date.parse("2026-09-20T02:45:58.188Z") },
  { name: "EP33", endMs: Date.parse("2026-09-20T03:02:37.147Z") },
  { name: "EP34", endMs: Date.parse("2026-09-20T03:16:19.199Z") },
];

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

/** Nearest observation to targetMs, either direction, from a
 *  pre-sorted array of {ts, contracts}. Returns null if array empty. */
function nearestObs(targetMs, obsArray) {
  if (obsArray.length === 0) return null;
  let best = obsArray[0];
  let bestDiff = Math.abs(obsArray[0].ts - targetMs);
  for (const o of obsArray) {
    const diff = Math.abs(o.ts - targetMs);
    if (diff < bestDiff) {
      best = o;
      bestDiff = diff;
    }
  }
  return best;
}

function printDelta(label, startObs, endObs) {
  if (!startObs || !endObs) {
    console.log(`${label}: N/A (missing observation)`);
    return;
  }
  const deltaBtc = endObs.contracts - startObs.contracts;
  const durationSec = (endObs.ts - startObs.ts) / 1000;
  const btcPerMin = durationSec !== 0 ? (deltaBtc / durationSec) * 60 : null;
  console.log(`${label}:`);
  console.log(`  start timestamp: ${isoUtc(startObs.ts)}`);
  console.log(`  end timestamp:   ${isoUtc(endObs.ts)}`);
  console.log(
    `  start OI: ${fmtBtc(startObs.contracts)}   end OI: ${fmtBtc(endObs.contracts)}`,
  );
  console.log(
    `  ΔOI BTC: ${fmtBtcDelta(deltaBtc)}   duration: ${durationSec.toFixed(1)}s   BTC/min: ${btcPerMin !== null ? btcPerMin.toFixed(3) : "N/A"}`,
  );
  return { deltaBtc, durationSec, btcPerMin };
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
    "OI END RAW MEASUREMENT -- pure measurement, no classification anywhere in this script",
  );
  console.log("=".repeat(140));

  const finalTableRows = [];

  for (const ep of EPISODES) {
    // Query window per episode: END-5min to END+10min. Computed fresh
    // per episode (EP34's query is its own new query, not reused from
    // any earlier window).
    const queryStartMs = ep.endMs - 5 * 60 * 1000;
    const queryEndMs = ep.endMs + 10 * 60 * 1000;

    console.log(`\n${"=".repeat(140)}`);
    console.log(`${ep.name}  END = ${isoUtc(ep.endMs)}`);
    console.log(
      `Query window: ${isoUtc(queryStartMs)} to ${isoUtc(queryEndMs)}`,
    );
    console.log("=".repeat(140));

    const obsRaw = await oiCol
      .find({
        symbol: SYMBOL,
        timestamp: { $gte: new Date(queryStartMs), $lte: new Date(queryEndMs) },
      })
      .project({ timestamp: 1, openInterest: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    const obs = obsRaw.map((d) => ({
      ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
      contracts: d.openInterest,
    }));
    console.log(`\nLoaded ${obs.length} raw observations in this window.`);

    // ============================================================
    // 1. RAW DATA: END-120s to END+300s
    // ============================================================
    const rawWindowStart = ep.endMs - 120_000;
    const rawWindowEnd = ep.endMs + 300_000;
    const rawWindowObs = obs.filter(
      (o) => o.ts >= rawWindowStart && o.ts <= rawWindowEnd,
    );
    console.log(
      `\n1. RAW DATA (END-120s to END+300s), ${rawWindowObs.length} observation(s):`,
    );
    console.log("timestamp                | openInterest");
    console.log("-".repeat(50));
    for (const o of rawWindowObs)
      console.log(`${isoUtc(o.ts)} | ${fmtBtc(o.contracts)}`);

    // ============================================================
    // 2. EXACT REFERENCE POINTS
    // ============================================================
    const offsetsSec = [-120, -60, -30, 0, 30, 60, 120, 300];
    console.log(`\n2. EXACT REFERENCE POINTS:`);
    console.log(
      "OFFSET  | REQUESTED TIMESTAMP      | ACTUAL OBSERVATION TIMESTAMP | DIFF (ms)  | OI",
    );
    console.log("-".repeat(110));
    const refPoints = {};
    for (const off of offsetsSec) {
      const targetMs = ep.endMs + off * 1000;
      const nearest = nearestObs(targetMs, obs);
      refPoints[off] = nearest;
      if (nearest) {
        console.log(
          `${String(off).padStart(6)}s | ${isoUtc(targetMs)} | ${isoUtc(nearest.ts)} | ${(nearest.ts - targetMs).toString().padStart(9)} | ${fmtBtc(nearest.contracts)}`,
        );
      } else {
        console.log(
          `${String(off).padStart(6)}s | ${isoUtc(targetMs)} | NO OBSERVATION FOUND | N/A | N/A`,
        );
      }
    }

    // ============================================================
    // 3. SIMPLE DELTAS
    // ============================================================
    console.log(`\n3. SIMPLE DELTAS:`);
    printDelta("ΔOI [-120s -> END]", refPoints[-120], refPoints[0]);
    printDelta("ΔOI [-60s -> END]", refPoints[-60], refPoints[0]);
    printDelta("ΔOI [-30s -> END]", refPoints[-30], refPoints[0]);
    printDelta("ΔOI [END -> +30s]", refPoints[0], refPoints[30]);
    printDelta("ΔOI [END -> +60s]", refPoints[0], refPoints[60]);
    printDelta("ΔOI [END -> +120s]", refPoints[0], refPoints[120]);
    printDelta("ΔOI [END -> +300s]", refPoints[0], refPoints[300]);

    // ============================================================
    // 4. PRE VS POST SLOPE
    // ============================================================
    function slope(a, b) {
      if (!a || !b) return null;
      const durationSec = (b.ts - a.ts) / 1000;
      return durationSec !== 0
        ? ((b.contracts - a.contracts) / durationSec) * 60
        : null;
    }
    const pre30 = slope(refPoints[-30], refPoints[0]);
    const post30 = slope(refPoints[0], refPoints[30]);
    const pre60 = slope(refPoints[-60], refPoints[0]);
    const post60 = slope(refPoints[0], refPoints[60]);
    const pre120 = slope(refPoints[-120], refPoints[0]);
    const post120 = slope(refPoints[0], refPoints[120]);

    console.log(`\n4. PRE VS POST SLOPE (BTC/min):`);
    console.log(
      `PRE30=${pre30 !== null ? pre30.toFixed(3) : "N/A"}   POST30=${post30 !== null ? post30.toFixed(3) : "N/A"}`,
    );
    console.log(
      `PRE60=${pre60 !== null ? pre60.toFixed(3) : "N/A"}   POST60=${post60 !== null ? post60.toFixed(3) : "N/A"}`,
    );
    console.log(
      `PRE120=${pre120 !== null ? pre120.toFixed(3) : "N/A"}   POST120=${post120 !== null ? post120.toFixed(3) : "N/A"}`,
    );
    console.log(
      `POST60-PRE60 = ${post60 !== null && pre60 !== null ? (post60 - pre60).toFixed(3) : "N/A"}`,
    );
    console.log(
      `POST120-PRE120 = ${post120 !== null && pre120 !== null ? (post120 - pre120).toFixed(3) : "N/A"}`,
    );

    // ============================================================
    // 5. LOCAL MINIMUM AND MAXIMUM (END-120s to END+300s, literal)
    // ============================================================
    console.log(
      `\n5. LOCAL MINIMUM AND MAXIMUM (END-120s to END+300s, literal, not classified):`,
    );
    let minObs = null,
      maxObs = null;
    for (const o of rawWindowObs) {
      if (minObs === null || o.contracts < minObs.contracts) minObs = o;
      if (maxObs === null || o.contracts > maxObs.contracts) maxObs = o;
    }
    console.log(
      `MIN OI: ${fmtBtc(minObs?.contracts)} at ${minObs ? isoUtc(minObs.ts) : "N/A"}   (${minObs ? ((minObs.ts - ep.endMs) / 1000).toFixed(1) : "N/A"}s from END)`,
    );
    console.log(
      `MAX OI: ${fmtBtc(maxObs?.contracts)} at ${maxObs ? isoUtc(maxObs.ts) : "N/A"}   (${maxObs ? ((maxObs.ts - ep.endMs) / 1000).toFixed(1) : "N/A"}s from END)`,
    );

    finalTableRows.push({
      name: ep.name,
      endMs: ep.endMs,
      oiAtEnd: refPoints[0]?.contracts ?? null,
      pre30,
      post30,
      pre60,
      post60,
      pre120,
      post120,
      minObs,
      maxObs,
    });

    // ============================================================
    // 6. SPECIAL EP32 MEASUREMENT
    // ============================================================
    if (ep.name === "EP32") {
      console.log(`\n6. SPECIAL EP32 MEASUREMENT:`);
      const win = obs.filter(
        (o) => o.ts >= ep.endMs - 120_000 && o.ts <= ep.endMs + 120_000,
      );
      let localMin = null;
      for (const o of win)
        if (localMin === null || o.contracts < localMin.contracts) localMin = o;
      console.log(`EP32 END timestamp: ${isoUtc(ep.endMs)}`);
      console.log(
        `minimum timestamp: ${localMin ? isoUtc(localMin.ts) : "N/A"}`,
      );
      console.log(`minimum OI: ${fmtBtc(localMin?.contracts)}`);
      console.log(
        `seconds between END and minimum: ${localMin ? ((localMin.ts - ep.endMs) / 1000).toFixed(1) : "N/A"}`,
      );
      if (localMin) {
        for (const off of [30, 60, 120, 300]) {
          const target = nearestObs(localMin.ts + off * 1000, obs);
          printDelta(`MIN -> +${off}s`, localMin, target);
        }
      }
    }

    // ============================================================
    // 7. SPECIAL EP33 MEASUREMENT
    // ============================================================
    if (ep.name === "EP33") {
      console.log(`\n7. SPECIAL EP33 MEASUREMENT:`);
      const win = obs.filter(
        (o) => o.ts >= ep.endMs - 120_000 && o.ts <= ep.endMs + 120_000,
      );
      let localMax = null;
      for (const o of win)
        if (localMax === null || o.contracts > localMax.contracts) localMax = o;
      console.log(`EP33 END timestamp: ${isoUtc(ep.endMs)}`);
      console.log(
        `maximum timestamp: ${localMax ? isoUtc(localMax.ts) : "N/A"}`,
      );
      console.log(`maximum OI: ${fmtBtc(localMax?.contracts)}`);
      console.log(
        `seconds between END and maximum: ${localMax ? ((localMax.ts - ep.endMs) / 1000).toFixed(1) : "N/A"}`,
      );
      if (localMax) {
        for (const off of [30, 60, 120, 300]) {
          const target = nearestObs(localMax.ts + off * 1000, obs);
          printDelta(`MAX -> +${off}s`, localMax, target);
        }
      }
    }

    // ============================================================
    // 8. EP34 POST-END (30s buckets, display only)
    // ============================================================
    if (ep.name === "EP34") {
      console.log(
        `\n8. EP34 POST-END, 30-second buckets, full 10 minutes after END (display only):`,
      );
      console.log(
        "TIME                     | OI BTC     | ΔOI from previous 30s point",
      );
      console.log("-".repeat(70));
      let prev = null;
      const bucketStart = Math.ceil(ep.endMs / 30000) * 30000;
      for (let t = bucketStart; t <= ep.endMs + 600_000; t += 30_000) {
        const o = nearestObs(t, obs);
        const delta = prev && o ? o.contracts - prev.contracts : null;
        console.log(
          `${isoUtc(t)} | ${fmtBtc(o?.contracts).padEnd(10)} | ${fmtBtcDelta(delta)}`,
        );
        if (o) prev = o;
      }
    }
  }

  // ============================================================
  // 9. FINAL TABLE
  // ============================================================
  console.log(`\n${"=".repeat(160)}`);
  console.log("9. FINAL TABLE");
  console.log("=".repeat(160));
  console.log(
    "EPISODE | END                      | OI@END     | PRE30   | POST30  | PRE60   | POST60  | PRE120  | POST120 | MIN_TIME                 | MIN_OI     | MAX_TIME                 | MAX_OI",
  );
  console.log("-".repeat(220));
  for (const r of finalTableRows) {
    console.log(
      `${r.name.padEnd(7)} | ${isoUtc(r.endMs)} | ${fmtBtc(r.oiAtEnd).padEnd(10)} | ` +
        `${(r.pre30 !== null ? r.pre30.toFixed(2) : "N/A").padEnd(7)} | ${(r.post30 !== null ? r.post30.toFixed(2) : "N/A").padEnd(7)} | ` +
        `${(r.pre60 !== null ? r.pre60.toFixed(2) : "N/A").padEnd(7)} | ${(r.post60 !== null ? r.post60.toFixed(2) : "N/A").padEnd(7)} | ` +
        `${(r.pre120 !== null ? r.pre120.toFixed(2) : "N/A").padEnd(7)} | ${(r.post120 !== null ? r.post120.toFixed(2) : "N/A").padEnd(7)} | ` +
        `${(r.minObs ? isoUtc(r.minObs.ts) : "N/A").padEnd(25)} | ${fmtBtc(r.minObs?.contracts).padEnd(10)} | ${(r.maxObs ? isoUtc(r.maxObs.ts) : "N/A").padEnd(25)} | ${fmtBtc(r.maxObs?.contracts)}`,
    );
  }

  // ============================================================
  // FOOTER
  // ============================================================
  console.log(`\n${"=".repeat(140)}`);
  console.log("THRESHOLDS USED: NO");
  console.log("SWING DETECTION USED: NO");
  console.log("NOISE CLASSIFICATION USED: NO");
  console.log("LIQUIDATION DATA USED: NO");
  console.log("PRICE USED: NO");
  console.log("EPISODE END TIMESTAMPS USED ONLY AS MEASUREMENT ANCHORS: YES");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
