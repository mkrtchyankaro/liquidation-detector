// BTC OI ADAPTIVE LEGS -- RESET#2, still primitive research only.
// Replaces magnitude-cut fine blocks with proper OI LEGS: persistent
// cumulative directional movement where small counter-moves are
// absorbed as internal noise, with the reversal TOLERANCE adaptive to
// TWO local factors (not a single global constant, not fixed BTC/%):
//
//   tolerance = max(
//     10 x localNoiseEstimate,   -- rolling mean |single-step ΔOI|
//                                   over the trailing ~60 observations
//                                   RIGHT BEFORE this point (LOCAL,
//                                   re-estimated continuously -- a
//                                   fast/large OI shock naturally
//                                   raises this, a slow/calm period
//                                   naturally lowers it)
//     0.33 x excursionSoFar      -- excursion-relative, same
//                                   convention as the prior HYBRID
//                                   method, scale-invariant to leg size
//   )
//
// HONEST FLAG: the multipliers (10x, 0.33) are themselves an EMPIRICAL
// convention carried over from earlier work in this research thread,
// not re-derived from this run's own data. They are applied to a
// LOCAL, adaptive base (not a fixed absolute number), which is the
// specific problem being fixed here -- but the multipliers themselves
// would need separate validation before being treated as final.
//
// OI legs are detected from OI ALONE. Price is attached afterward, at
// the SAME timestamps the OI leg already determined -- never used to
// decide leg boundaries.
//
//   node scripts/btc-oi-legs-adaptive.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const NUM_REGIONS = 10;
const MAX_BLOCK_ROWS = 18;
const LOCAL_WINDOW_SIZE = 60; // observations (~1min at ~1/s) for the rolling local noise estimate
const NOISE_MULTIPLIER = 10;
const EXCURSION_MULTIPLIER = 0.33;

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
function fmtPriceDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
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
function horizonDeltas(obs, horizonMs, toleranceMs, field) {
  const deltas = [];
  let j = 0;
  for (let i = 0; i < obs.length; i++) {
    if (j < i + 1) j = i + 1;
    while (j < obs.length && obs[j].ts - obs[i].ts < horizonMs - toleranceMs)
      j++;
    if (
      j < obs.length &&
      Math.abs(obs[j].ts - obs[i].ts - horizonMs) <= toleranceMs &&
      obs[j][field] !== null &&
      obs[i][field] !== null
    ) {
      deltas.push(obs[j][field] - obs[i][field]);
    }
  }
  return deltas;
}
function buildMagnitudeBlocks(obs, fromIdx, toIdx, oiScale) {
  const blocks = [];
  let blockStartIdx = fromIdx;
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const cumDelta = obs[i].contracts - obs[blockStartIdx].contracts;
    if (Math.abs(cumDelta) >= oiScale) {
      blocks.push({ startIdx: blockStartIdx, endIdx: i });
      blockStartIdx = i;
    }
  }
  return blocks;
}

/** Adaptive OI leg detector. Tolerance is LOCAL (rolling mean of the
 *  last LOCAL_WINDOW_SIZE single-step |ΔOI|, recomputed continuously)
 *  combined with excursion-relative (33% of the current leg's own
 *  excursion). EXTREME_TIME (the true peak/trough) is kept separate
 *  from CONFIRMATION_TIME (when the tolerance was actually cleared). */
function buildAdaptiveLegs(obs, fromIdx, toIdx) {
  const legs = [];
  if (toIdx - fromIdx < 2) return legs;

  const window = [];
  let windowSum = 0;
  function pushStep(absStep) {
    window.push(absStep);
    windowSum += absStep;
    if (window.length > LOCAL_WINDOW_SIZE) windowSum -= window.shift();
  }

  let startIdx = fromIdx,
    direction = null,
    extremeIdx = fromIdx,
    extremeVal = obs[fromIdx].contracts;
  let maxInternalOpposite = 0;

  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const stepDelta = obs[i].contracts - obs[i - 1].contracts;
    pushStep(Math.abs(stepDelta));
    const localNoise = window.length > 0 ? windowSum / window.length : 0;

    const v = obs[i].contracts;
    if (direction === null) {
      if (v > extremeVal) {
        direction = "UP";
        extremeVal = v;
        extremeIdx = i;
      } else if (v < extremeVal) {
        direction = "DOWN";
        extremeVal = v;
        extremeIdx = i;
      }
      continue;
    }

    if (direction === "UP" ? v > extremeVal : v < extremeVal) {
      extremeVal = v;
      extremeIdx = i;
      maxInternalOpposite = 0;
      continue;
    }

    const counterMove = Math.abs(v - extremeVal);
    maxInternalOpposite = Math.max(maxInternalOpposite, counterMove);
    const excursionSoFar = Math.abs(extremeVal - obs[startIdx].contracts);
    const tolerance = Math.max(
      NOISE_MULTIPLIER * localNoise,
      EXCURSION_MULTIPLIER * excursionSoFar,
    );
    if (counterMove < tolerance) continue; // absorbed as internal noise

    legs.push({
      direction,
      startIdx,
      extremeIdx,
      confirmationIdx: i,
      startTs: obs[startIdx].ts,
      startOi: obs[startIdx].contracts,
      extremeTs: obs[extremeIdx].ts,
      extremeOi: extremeVal,
      confirmationTs: obs[i].ts,
      confirmationOi: v,
      deltaOi: extremeVal - obs[startIdx].contracts,
      durationToExtremeMs: obs[extremeIdx].ts - obs[startIdx].ts,
      maxInternalOpposite,
    });

    startIdx = extremeIdx;
    direction = direction === "UP" ? "DOWN" : "UP";
    extremeVal = obs[startIdx].contracts;
    extremeIdx = startIdx;
    maxInternalOpposite = 0;
    if (direction === "UP" ? v > extremeVal : v < extremeVal) {
      extremeVal = v;
      extremeIdx = i;
    }
  }
  return legs;
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
    "BTC OI ADAPTIVE LEGS -- fine blocks (A, sequence only) vs adaptive legs (B, full table)",
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

  const oiDeltas60s = horizonDeltas(obs, 60000, 8000, "contracts")
    .map((d) => Math.abs(d))
    .sort((a, b) => a - b);
  const priceDeltas60s = horizonDeltas(obs, 60000, 8000, "price")
    .map((d) => Math.abs(d))
    .sort((a, b) => a - b);
  const oiBlockScale = percentile(oiDeltas60s, 50);
  const regionScale = oiBlockScale * 10;
  const priceNoiseScale = percentile(priceDeltas60s, 50);

  console.log(
    `\nFine block scale (median |ΔOI over 60s|): ${fmtBtc(oiBlockScale)} BTC (unchanged from previous script -- Representation A)`,
  );
  console.log(`Region scale: ${fmtBtc(regionScale)} BTC`);
  console.log(`Price noise scale: $${priceNoiseScale.toFixed(2)}`);
  console.log(
    `\nAdaptive leg tolerance = max(${NOISE_MULTIPLIER}x LOCAL rolling mean |single-step ΔOI| over last ${LOCAL_WINDOW_SIZE} obs, ${EXCURSION_MULTIPLIER * 100}% of current leg's own excursion).`,
  );
  console.log(
    `NOTE: the ${NOISE_MULTIPLIER}x / ${EXCURSION_MULTIPLIER * 100}% multipliers are an empirical convention carried over from earlier work, not re-derived here -- flagged honestly, not hidden.`,
  );

  const coarseBlocks = buildMagnitudeBlocks(
    obs,
    0,
    obs.length - 1,
    regionScale,
  );
  const withDelta = coarseBlocks.map((b) => ({
    ...b,
    deltaOi: obs[b.endIdx].contracts - obs[b.startIdx].contracts,
  }));
  const upRegions = withDelta
    .filter((b) => b.deltaOi > 0)
    .sort((a, b) => b.deltaOi - a.deltaOi)
    .slice(0, Math.ceil(NUM_REGIONS / 2));
  const downRegions = withDelta
    .filter((b) => b.deltaOi < 0)
    .sort((a, b) => a.deltaOi - b.deltaOi)
    .slice(0, Math.floor(NUM_REGIONS / 2));
  const regions = [...upRegions, ...downRegions].sort(
    (a, b) => obs[a.startIdx].ts - obs[b.startIdx].ts,
  );

  console.log(
    `\nSelected ${regions.length} region(s) (same selection method as previous script).\n`,
  );

  const allFineBlockCounts = [],
    allLegCounts = [],
    allLegDeltas = [],
    allLegDurations = [],
    allLegOpposites = [];

  regions.forEach((reg, idx) => {
    const startO = obs[reg.startIdx],
      endO = obs[reg.endIdx];
    console.log(`\n${"=".repeat(160)}`);
    console.log(
      `R${idx + 1}: ${isoUtc(startO.ts)} -> ${isoUtc(endO.ts)}  OI ${fmtBtc(startO.contracts)} -> ${fmtBtc(endO.contracts)} (${fmtBtcDelta(reg.deltaOi)})  region duration=${fmtDurationMin(endO.ts - startO.ts)}`,
    );
    console.log("=".repeat(160));

    // ---- A) fine blocks, sequence only ----
    const fineBlocks = buildMagnitudeBlocks(
      obs,
      reg.startIdx,
      reg.endIdx,
      oiBlockScale,
    ).slice(0, MAX_BLOCK_ROWS);
    const fineSeq = fineBlocks.map((b) => {
      const bStart = obs[b.startIdx],
        bEnd = obs[b.endIdx];
      const deltaOi = bEnd.contracts - bStart.contracts;
      const deltaPrice =
        bStart.price !== null && bEnd.price !== null
          ? bEnd.price - bStart.price
          : null;
      const oiDir = deltaOi >= 0 ? "OI_UP" : "OI_DOWN";
      const priceDir =
        deltaPrice === null
          ? "PRICE_N/A"
          : Math.abs(deltaPrice) < priceNoiseScale
            ? "PRICE_FLAT"
            : deltaPrice > 0
              ? "PRICE_UP"
              : "PRICE_DOWN";
      return `${oiDir}/${priceDir}`;
    });
    console.log(
      `A) FINE BLOCKS (N=${fineBlocks.length}) relationship sequence:`,
    );
    console.log("  " + fineSeq.join(" -> "));
    allFineBlockCounts.push(fineBlocks.length);

    // ---- B) adaptive legs, full table ----
    const legs = buildAdaptiveLegs(obs, reg.startIdx, reg.endIdx);
    console.log(`\nB) ADAPTIVE OI LEGS (N=${legs.length}):`);
    console.log(
      "DIR  | START                    | EXTREME                  | CONFIRM                  | START OI   | EXTREME OI | ΔOI        | DUR TO EXT | MAX INT OPP | PRICE@START | PRICE@EXT   | ΔPRICE      | PRICE DIR  | RELATIONSHIP",
    );
    console.log("-".repeat(200));

    let regionPriceExtreme = startO.price;
    const regionPriceDirGuess =
      (endO.price ?? 0) - (startO.price ?? 0) >= 0 ? 1 : -1;

    legs.forEach((leg) => {
      const priceStart = obs[leg.startIdx].price,
        priceExt = obs[leg.extremeIdx].price;
      const deltaPrice =
        priceStart !== null && priceExt !== null ? priceExt - priceStart : null;
      const priceDir =
        deltaPrice === null
          ? "N/A"
          : Math.abs(deltaPrice) < priceNoiseScale
            ? "FLAT"
            : deltaPrice > 0
              ? "UP"
              : "DOWN";
      const relationship = `OI_${leg.direction}/PRICE_${priceDir}`;

      let newExtreme = false;
      if (priceExt !== null) {
        if (regionPriceDirGuess === 1 && priceExt > regionPriceExtreme) {
          regionPriceExtreme = priceExt;
          newExtreme = true;
        }
        if (regionPriceDirGuess === -1 && priceExt < regionPriceExtreme) {
          regionPriceExtreme = priceExt;
          newExtreme = true;
        }
      }

      console.log(
        `${leg.direction.padEnd(4)} | ${isoUtc(leg.startTs)} | ${isoUtc(leg.extremeTs)} | ${isoUtc(leg.confirmationTs)} | ${fmtBtc(leg.startOi).padEnd(10)} | ${fmtBtc(leg.extremeOi).padEnd(10)} | ${fmtBtcDelta(leg.deltaOi).padEnd(10)} | ${fmtDurationMin(leg.durationToExtremeMs).padEnd(10)} | ${fmtBtc(leg.maxInternalOpposite).padEnd(11)} | ${fmtPrice(priceStart).padEnd(12)} | ${fmtPrice(priceExt).padEnd(11)} | ${fmtPriceDelta(deltaPrice).padEnd(11)} | ${priceDir.padEnd(10)} | ${relationship}${newExtreme ? "  [NEW PRICE EXTREME]" : ""}`,
      );

      allLegDeltas.push(Math.abs(leg.deltaOi));
      allLegDurations.push(leg.durationToExtremeMs);
      allLegOpposites.push(leg.maxInternalOpposite);
    });
    allLegCounts.push(legs.length);

    const compressionRatio =
      fineBlocks.length > 0
        ? (fineBlocks.length / Math.max(legs.length, 1)).toFixed(2)
        : "N/A";
    console.log(
      `\nR${idx + 1} compression: ${fineBlocks.length} fine blocks -> ${legs.length} adaptive legs (ratio ${compressionRatio}x)`,
    );
  });

  // ---- Aggregate report ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("AGGREGATE REPORT");
  console.log("=".repeat(160));
  const totalFine = allFineBlockCounts.reduce((a, b) => a + b, 0);
  const totalLegs = allLegCounts.reduce((a, b) => a + b, 0);
  console.log(`Fine blocks count (total across all regions): ${totalFine}`);
  console.log(
    `Adaptive OI legs count (total across all regions): ${totalLegs}`,
  );
  console.log(
    `Compression ratio (overall): ${totalLegs > 0 ? (totalFine / totalLegs).toFixed(2) : "N/A"}x`,
  );
  console.log(`Median leg |ΔOI|: ${fmtBtc(median(allLegDeltas))} BTC`);
  console.log(
    `Median leg duration (to extreme): ${fmtDurationMin(median(allLegDurations) ?? 0)}`,
  );
  console.log(
    `Median internal opposite OI excursion: ${fmtBtc(median(allLegOpposites))} BTC`,
  );

  console.log(
    `\nPer-region leg counts (for inspecting whether fast/large regions and slow/persistent regions both stayed compact):`,
  );
  regions.forEach((reg, idx) => {
    const regionDurationMin =
      (obs[reg.endIdx].ts - obs[reg.startIdx].ts) / 60000;
    console.log(
      `  R${idx + 1}: region duration=${regionDurationMin.toFixed(1)}min, |ΔOI|=${fmtBtc(Math.abs(reg.deltaOi))}, legs=${allLegCounts[idx]}, fine blocks=${allFineBlockCounts[idx]}`,
    );
  });

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
