// BTC OI/PRICE RELATIONSHIP BLOCKS -- RESET, primitive research only.
// Only two observable variables: OI change, PRICE change. No
// "destruction/rebuild/attempt/liquidation" labels anywhere -- only
// OI_UP/OI_DOWN x PRICE_UP/PRICE_DOWN/PRICE_FLAT.
//
// Blocks are MAGNITUDE-CUT (like volume/tick bars), not reversal-
// triggered: a new block starts every time cumulative |ΔOI| since the
// current block's start reaches a data-derived scale. This lets
// consecutive blocks share the same OI direction (matching the
// illustration), unlike a reversal-based segmenter.
//
// Does NOT use the old HYBRID episode boundaries as ground truth --
// region anchors are found independently, at a coarser version of the
// SAME magnitude-block algorithm.
//
//   node scripts/btc-oi-price-relationship-blocks.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const NUM_REGIONS = 10;
const MAX_BLOCK_ROWS = 18;

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
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
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

/** Magnitude-cut blocks (like volume/tick bars): a new block starts
 *  whenever cumulative |ΔOI| since the current block's start reaches
 *  `oiScale`. Consecutive blocks may share the same OI direction. */
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

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const oiCol = ownDb.collection("oi_second_observations");

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - DAYS_BACK * 86_400_000;

  console.log("=".repeat(150));
  console.log(
    "BTC OI/PRICE RELATIONSHIP BLOCKS -- primitive research (OI_DIR x PRICE_DIR only, no other labels)",
  );
  console.log("=".repeat(150));

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

  // ---- Data-derived scales (median of 60s paired deltas -- "typical
  // chunk of movement over about a minute", used ONLY to suppress
  // micro-noise, not as a reversal/significance test). ----
  const oiDeltas60s = horizonDeltas(obs, 60000, 8000, "contracts")
    .map((d) => Math.abs(d))
    .sort((a, b) => a - b);
  const priceDeltas60s = horizonDeltas(obs, 60000, 8000, "price")
    .map((d) => Math.abs(d))
    .sort((a, b) => a - b);
  const oiBlockScale = percentile(oiDeltas60s, 50); // block-cutting magnitude for fine blocks
  const regionScale = oiBlockScale * 10; // coarser magnitude, same algorithm, used only to find region anchors
  const priceNoiseScale = percentile(priceDeltas60s, 50); // FLAT vs UP/DOWN cutoff for a block's net price move

  console.log(
    `\nOI block scale (median |ΔOI over 60s|): ${fmtBtc(oiBlockScale)} BTC -- fine blocks are cut every time this much cumulative OI moves.`,
  );
  console.log(
    `Region scale (10x the above, same algorithm, coarser): ${fmtBtc(regionScale)} BTC -- used only to find region anchors.`,
  );
  console.log(
    `Price noise scale (median |Δprice over 60s|): $${priceNoiseScale.toFixed(2)} -- a block's net price move within this is called FLAT.`,
  );

  // ---- Region anchors: coarse magnitude blocks, top by |ΔOI|, mixed UP/DOWN. ----
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
    `\nSelected ${regions.length} region(s) (${upRegions.length} OI-UP, ${downRegions.length} OI-DOWN), by |ΔOI| among coarse magnitude blocks.\n`,
  );

  regions.forEach((reg, idx) => {
    const startO = obs[reg.startIdx],
      endO = obs[reg.endIdx];
    console.log(`\n${"=".repeat(150)}`);
    console.log(
      `R${idx + 1}: ${isoUtc(startO.ts)} -> ${isoUtc(endO.ts)}  OI ${fmtBtc(startO.contracts)} -> ${fmtBtc(endO.contracts)} (${fmtBtcDelta(reg.deltaOi)})`,
    );
    console.log("=".repeat(150));

    const fineBlocks = buildMagnitudeBlocks(
      obs,
      reg.startIdx,
      reg.endIdx,
      oiBlockScale,
    ).slice(0, MAX_BLOCK_ROWS);

    console.log(
      "TIME RANGE               | OI START   | OI END     | ΔOI       | PRICE START  | PRICE END    | ΔPRICE      | OI DIR | PRICE DIR | RELATIONSHIP           | NEW EXTREME",
    );
    console.log("-".repeat(170));

    let regionPriceExtreme = startO.price;
    const regionPriceDirGuess =
      (obs[reg.endIdx].price ?? 0) - (startO.price ?? 0) >= 0 ? 1 : -1;

    const sequence = [];
    for (const b of fineBlocks) {
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
      const relationship = `${oiDir}/${priceDir}`;

      let newExtreme = false;
      if (bEnd.price !== null) {
        if (regionPriceDirGuess === 1 && bEnd.price > regionPriceExtreme) {
          regionPriceExtreme = bEnd.price;
          newExtreme = true;
        }
        if (regionPriceDirGuess === -1 && bEnd.price < regionPriceExtreme) {
          regionPriceExtreme = bEnd.price;
          newExtreme = true;
        }
      }

      console.log(
        `${hhmmss(bStart.ts)}-${hhmmss(bEnd.ts)} | ${fmtBtc(bStart.contracts).padEnd(10)} | ${fmtBtc(bEnd.contracts).padEnd(10)} | ${fmtBtcDelta(deltaOi).padEnd(9)} | ${fmtPrice(bStart.price).padEnd(12)} | ${fmtPrice(bEnd.price).padEnd(12)} | ${fmtPriceDelta(deltaPrice).padEnd(11)} | ${oiDir.padEnd(6)} | ${priceDir.padEnd(9)} | ${relationship.padEnd(23)} | ${newExtreme ? "YES" : "no"}`,
      );
      sequence.push(relationship);
    }
    if (fineBlocks.length >= MAX_BLOCK_ROWS)
      console.log(`  (truncated at ${MAX_BLOCK_ROWS} blocks)`);

    console.log(`\nR${idx + 1} relationship sequence:`);
    console.log("  " + sequence.join("\n  -> "));
  });

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
