// BTC OI/PRICE RESPONSE DIAGNOSTIC -- RESEARCH ONLY, NOT the final
// detector. Investigates whether "does price still progress in the
// original direction while new OI is being created" is visible in
// real data, using a CONTINUOUS representation (ratchet-extreme
// tracking, no discrete attempt boundaries required), with discrete
// REBUILD_ATTEMPT boundaries computed separately, only for visual
// comparison.
//
//   node scripts/btc-oi-price-response-diagnostic.js
//
// No liquidation data, no future-return optimization, no fixed
// minute/BTC/percentage thresholds except where explicitly derived
// from the observed data and labeled as such.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const NUM_REGIONS = 8;
const MAX_TRACE_ROWS = 25;

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
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n) {
  return n === null || n === undefined ? "N/A" : `${n.toFixed(1)}%`;
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

// Region discovery (data-derived "large") -- exact same structural
// segmentation as the previous script (HYBRID method), reused only to
// FIND anchors, not to declare final episode boundaries.
function segmentStructuralEpisodes(obs, confirmEnd) {
  if (obs.length < 3) return [];
  const episodes = [];
  let startIdx = 0,
    direction = null,
    i = 1;
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
  let extremeIdx = startIdx,
    extremeVal = obs[startIdx].contracts;
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
      startIdx,
      extremeIdx,
      endIdx: i,
      startTs: startO.ts,
      startOi: startO.contracts,
      extremeTs: extO.ts,
      extremeOi: extO.contracts,
      endTs: endO.ts,
      endOi: endO.contracts,
      deltaStartToExtremeBtc: extO.contracts - startO.contracts,
      totalDurationMs: endO.ts - startO.ts,
      durationToExtremeMs: extO.ts - startO.ts,
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

/** REPRESENTATION A: discrete rebuild-attempt boundaries within a
 *  region, using local OI-direction flips (noise-fence-based) --
 *  computed for comparison only. */
function findDiscreteAttempts(obs, fromIdx, toIdx, oiDir, noiseFence) {
  const attempts = [];
  let localDir = -oiDir; // rebuild direction opposite the region's own destruction/build direction
  let segStartIdx = fromIdx;
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const stepDelta = obs[i].contracts - obs[i - 1].contracts;
    const stepDir = stepDelta > 0 ? 1 : stepDelta < 0 ? -1 : 0;
    if (stepDir === 0) continue;
    if (stepDir === localDir) continue; // still extending current segment
    if (Math.abs(stepDelta) <= noiseFence.fence) continue; // ordinary noise, doesn't flip
    // Real flip.
    if (localDir === -oiDir) {
      // A rebuild segment just ended.
      attempts.push({
        startTs: obs[segStartIdx].ts,
        startOi: obs[segStartIdx].contracts,
        endTs: obs[i - 1].ts,
        endOi: obs[i - 1].contracts,
        oiAdded: obs[i - 1].contracts - obs[segStartIdx].contracts,
      });
    }
    localDir = stepDir;
    segStartIdx = i - 1;
  }
  return attempts;
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
    "BTC OI/PRICE RESPONSE DIAGNOSTIC -- research only, not the final detector",
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
  console.log(`\nLoaded ${obs.length} raw OI+price observations.`);
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
    `Local OI noise fence (Tukey, abs(ΔOI over 10s)): ${fmtBtc(noiseFence.fence)} BTC (used only to find discrete attempt boundaries for comparison, NOT the continuous trace).`,
  );

  // ---- 1. Region discovery ("large" = top-N |ΔOI| among HYBRID structural episodes) ----
  const hybridEpisodes = segmentStructuralEpisodes(
    obs,
    (recovery, excursion) =>
      recovery >= Math.max(0.33 * excursion, 10 * noiseFence.fence),
  );
  const regions = [...hybridEpisodes]
    .sort(
      (a, b) =>
        Math.abs(b.deltaStartToExtremeBtc) - Math.abs(a.deltaStartToExtremeBtc),
    )
    .slice(0, NUM_REGIONS);
  regions.sort((a, b) => a.startTs - b.startTs);

  console.log(`\n${"=".repeat(160)}`);
  console.log(
    `1. SELECTED ${regions.length} LARGE OI REGIONS ("large" = top-${NUM_REGIONS} by |Start->Extreme ΔOI| among HYBRID structural episodes -- data-derived, see previous script for HYBRID's own derivation)`,
  );
  console.log("=".repeat(160));
  console.log(
    "ID   | PRICE DIR | ANCHOR START             | OI EXTREME TIME          | OI DESTROYED/BUILT | PRICE DISPLACEMENT",
  );
  console.log("-".repeat(140));

  const regionInfo = regions.map((r, idx) => {
    const priceDir =
      (obs[r.extremeIdx].price ?? 0) - (obs[r.startIdx].price ?? 0) >= 0
        ? 1
        : -1;
    const priceDisp =
      obs[r.extremeIdx].price !== null && obs[r.startIdx].price !== null
        ? obs[r.extremeIdx].price - obs[r.startIdx].price
        : null;
    return { id: `R${idx + 1}`, region: r, priceDir, priceDisp };
  });
  regionInfo.forEach((ri) => {
    console.log(
      `${ri.id.padEnd(4)} | ${(ri.priceDir === 1 ? "UP" : "DOWN").padEnd(9)} | ${isoUtc(ri.region.startTs)} | ${isoUtc(ri.region.extremeTs)} | ${fmtBtcDelta(ri.region.deltaStartToExtremeBtc).padEnd(19)} | ${ri.priceDisp !== null ? fmtPrice(ri.priceDisp) : "N/A"}`,
    );
  });

  // ---- 2/3/4. Continuous trace + discrete attempts, per region ----
  for (const ri of regionInfo) {
    const r = ri.region;
    const oiDir = r.type === "BUILD" ? 1 : -1;
    const priceDir = ri.priceDir;

    // Self-referential extension: keep tracing past the HYBRID end,
    // up to 3x the region's own destruction-phase duration, or until
    // the row cap forces a stop.
    const extendMs = Math.min(3 * r.durationToExtremeMs, 60 * 60 * 1000);
    const traceEndTs = r.endTs + extendMs;
    const startIdx = r.startIdx;
    let endIdxInObs = startIdx;
    for (let k = startIdx; k < obs.length; k++) {
      if (obs[k].ts <= traceEndTs) endIdxInObs = k;
      else break;
    }

    console.log(`\n${"=".repeat(180)}`);
    console.log(
      `${ri.id}: ${r.type} region, price moved ${priceDir === 1 ? "UP" : "DOWN"} during it -- REPRESENTATION B (continuous trace)`,
    );
    console.log(
      `Anchor: ${isoUtc(r.startTs)}   HYBRID extreme: ${isoUtc(r.extremeTs)}   Traced through: ${isoUtc(obs[endIdxInObs].ts)}`,
    );
    console.log("=".repeat(180));
    console.log(
      "TIME     | OI         | ΔOI(local) | OI DESTROYED(cum) | OI REBUILT(cum) | REBUILD% | PRICE      | ORIG EXTREME | ORIG PROGRESS | COUNTER PROGRESS | RECOVERY% | PHASE",
    );
    console.log("-".repeat(200));

    const startOi = obs[startIdx].contracts,
      startPrice = obs[startIdx].price;
    let deepestOi = startOi,
      deepestPrice = startPrice;
    let lastEmittedDeepestOi = null,
      lastEmittedDeepestPrice = null,
      lastEmittedRebuilt = -Infinity,
      lastEmittedCounter = -Infinity;
    let rowsEmitted = 0;
    let prevOi = startOi;

    for (
      let k = startIdx;
      k <= endIdxInObs && rowsEmitted < MAX_TRACE_ROWS;
      k++
    ) {
      const o = obs[k];
      if (oiDir === 1) deepestOi = Math.max(deepestOi, o.contracts);
      else deepestOi = Math.min(deepestOi, o.contracts);
      if (o.price !== null) {
        if (priceDir === 1) deepestPrice = Math.max(deepestPrice, o.price);
        else deepestPrice = Math.min(deepestPrice, o.price);
      }

      const oiDestroyedCum = Math.abs(deepestOi - startOi);
      const oiRebuiltCum = Math.abs(o.contracts - deepestOi);
      const rebuildPct =
        oiDestroyedCum > 0 ? (oiRebuiltCum / oiDestroyedCum) * 100 : null;
      const origProgress =
        priceDir === 1 ? deepestPrice - startPrice : startPrice - deepestPrice;
      const counterProgress =
        o.price !== null
          ? priceDir === 1
            ? deepestPrice - o.price
            : o.price - deepestPrice
          : null;
      const recoveryPct =
        origProgress > 0 && counterProgress !== null
          ? (counterProgress / origProgress) * 100
          : null;

      const newOiRecord = deepestOi !== lastEmittedDeepestOi;
      const newPriceRecord = deepestPrice !== lastEmittedDeepestPrice;
      const newRebuiltHigh =
        oiRebuiltCum > lastEmittedRebuilt + noiseFence.fence * 0.5;
      const newCounterHigh =
        counterProgress !== null && counterProgress > lastEmittedCounter;

      if (
        k === startIdx ||
        newOiRecord ||
        newPriceRecord ||
        newRebuiltHigh ||
        newCounterHigh
      ) {
        const phase =
          newOiRecord || newPriceRecord
            ? "DESTRUCTION/BUILD"
            : "REBUILD/RECOVERY";
        console.log(
          `${hhmmss(o.ts)} | ${fmtBtc(o.contracts).padEnd(10)} | ${fmtBtcDelta(o.contracts - prevOi).padEnd(10)} | ${fmtBtc(oiDestroyedCum).padEnd(18)} | ${fmtBtc(oiRebuiltCum).padEnd(16)} | ${(rebuildPct !== null ? fmtPct(rebuildPct) : "N/A").padEnd(8)} | ${fmtPrice(o.price).padEnd(10)} | ${fmtPrice(deepestPrice).padEnd(12)} | ${fmtPrice(origProgress).padEnd(14)} | ${(counterProgress !== null ? fmtPrice(counterProgress) : "N/A").padEnd(17)} | ${(recoveryPct !== null ? fmtPct(recoveryPct) : "N/A").padEnd(9)} | ${phase}`,
        );
        lastEmittedDeepestOi = deepestOi;
        lastEmittedDeepestPrice = deepestPrice;
        lastEmittedRebuilt = oiRebuiltCum;
        lastEmittedCounter = counterProgress ?? lastEmittedCounter;
        rowsEmitted++;
      }
      prevOi = o.contracts;
    }
    if (rowsEmitted >= MAX_TRACE_ROWS)
      console.log(`  (truncated at ${MAX_TRACE_ROWS} rows)`);

    // REPRESENTATION A: discrete attempts, same region, for comparison only.
    const attempts = findDiscreteAttempts(
      obs,
      startIdx,
      endIdxInObs,
      oiDir,
      noiseFence,
    );
    console.log(
      `\n${ri.id}: REPRESENTATION A (discrete rebuild attempts, for comparison only) -- ${attempts.length} attempt(s) found`,
    );
    attempts.forEach((a, idx) => {
      console.log(
        `  attempt#${idx + 1}: ${hhmmss(a.startTs)} -> ${hhmmss(a.endTs)}  OI added: ${fmtBtcDelta(a.oiAdded)}`,
      );
    });
  }

  // ---- 5. Comparison summary ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("COMPARISON SUMMARY (descriptive only)");
  console.log("=".repeat(160));
  console.log(`Regions examined: ${regionInfo.length}`);
  console.log(
    "Does continuous OI-vs-price response show visible regime changes? -- inspect the REBUILD% / RECOVERY% columns",
  );
  console.log(
    "above per region: a durable rise in RECOVERY% while REBUILD% is also rising (price giving back MORE than OI",
  );
  console.log(
    "alone would suggest) is the empirical signature the model predicts; its presence/absence is visible directly",
  );
  console.log("in the printed rows above, not asserted here.");
  console.log(
    "Do discrete attempt boundaries preserve or distort those changes? -- compare each region's Representation A",
  );
  console.log(
    "attempt count/timing against Representation B's DESTRUCTION/BUILD vs REBUILD/RECOVERY phase tags above.",
  );
  console.log(
    "No cross-example statistical claim is made here -- read the per-region tables to judge this yourself.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
