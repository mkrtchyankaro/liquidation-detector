// FOUR EXACT EPISODES -- HISTORICAL MONGODB ONLY, NO LIVE CONNECTIONS.
//
// Pure read of already-stored data for EXACTLY these 4 BTCUSDT LONG
// episodes. No Binance connection (live or historical), no wall
// logic, no theory, no conclusions -- chronological event-by-event
// data only.
//
// STEP 0 (per operator's explicit instruction): inspects the ACTUAL
// stored schema of oi_second_observations and liq_raw_events before
// printing anything, so no field is assumed or invented -- only
// what is truly present is used.
//
//   node scripts/four-episodes-oi-timeline.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EPISODES = [
  {
    num: 31,
    startMs: Date.parse("2026-09-20T02:24:27.128Z"),
    endMs: Date.parse("2026-09-20T02:36:15.129Z"),
  },
  {
    num: 32,
    startMs: Date.parse("2026-09-20T02:39:21.185Z"),
    endMs: Date.parse("2026-09-20T02:45:58.188Z"),
  },
  {
    num: 33,
    startMs: Date.parse("2026-09-20T02:54:09.182Z"),
    endMs: Date.parse("2026-09-20T03:02:37.147Z"),
  },
  {
    num: 34,
    startMs: Date.parse("2026-09-20T03:14:42.177Z"),
    endMs: Date.parse("2026-09-20T03:16:19.199Z"),
  },
];

const OPTIONAL_FIELD_NAMES = [
  "bidDepthUsd",
  "askDepthUsd",
  "bookImbalance",
  "nearestBidWallPrice",
  "nearestBidWallUsd",
  "nearestAskWallPrice",
  "nearestAskWallUsd",
  "wallsPulled1m",
  "orderBookAgeMs",
];

function hhmmssMs(ms) {
  return new Date(ms).toISOString().slice(11, 23);
}
function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(3)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}

/** Looks for a field anywhere at the top level OR inside a
 *  marketSnapshot sub-object (both patterns seen elsewhere in this
 *  codebase's Mongo documents). Returns { found, value, path } --
 *  never invents a value if not present. */
function findField(doc, fieldName) {
  if (doc[fieldName] !== undefined)
    return { found: true, value: doc[fieldName], path: fieldName };
  if (doc.marketSnapshot && doc.marketSnapshot[fieldName] !== undefined) {
    return {
      found: true,
      value: doc.marketSnapshot[fieldName],
      path: `marketSnapshot.${fieldName}`,
    };
  }
  if (
    doc.marketSnapshot?.orderBook &&
    doc.marketSnapshot.orderBook[fieldName] !== undefined
  ) {
    return {
      found: true,
      value: doc.marketSnapshot.orderBook[fieldName],
      path: `marketSnapshot.orderBook.${fieldName}`,
    };
  }
  return { found: false, value: undefined, path: null };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(140));
  console.log(
    "FOUR EXACT EPISODES -- HISTORICAL MONGODB TIMELINE (no live connections, no theory, no conclusions)",
  );
  console.log("=".repeat(140));

  // ---- STEP 0: schema inspection (real, not assumed) ----
  console.log("\n--- STEP 0: SCHEMA INSPECTION ---\n");

  const sampleOiDoc = await oiCol.findOne(
    { symbol: SYMBOL, timestamp: { $lte: new Date(EPISODES[0].startMs) } },
    { sort: { timestamp: -1 } },
  );
  console.log(
    "Sample oi_second_observations document (nearest before episode 31 start):",
  );
  console.log(
    sampleOiDoc ? JSON.stringify(sampleOiDoc, null, 2) : "NONE FOUND",
  );
  const oiHasUsdField = sampleOiDoc
    ? Object.keys(sampleOiDoc).find((k) => /usd|notional/i.test(k))
    : null;
  console.log(
    `\n==> OI USD-denominated field found in oi_second_observations: ${oiHasUsdField ?? "NONE -- only raw contract-count OI is stored, will print that only"}`,
  );

  const sampleLiqDoc = await liqCol.findOne({
    symbol: SYMBOL,
    timestamp: { $gte: EPISODES[0].startMs, $lte: EPISODES[0].endMs },
  });
  console.log("\nSample liq_raw_events document (first event of Episode 31):");
  console.log(
    sampleLiqDoc ? JSON.stringify(sampleLiqDoc, null, 2) : "NONE FOUND",
  );

  const presentOptionalFields = [];
  for (const f of OPTIONAL_FIELD_NAMES) {
    const r = findField(sampleLiqDoc ?? {}, f);
    if (r.found) presentOptionalFields.push({ field: f, path: r.path });
  }
  console.log(
    `\n==> Optional order-book-aggregate fields ACTUALLY present in liq_raw_events: ${presentOptionalFields.length > 0 ? presentOptionalFields.map((p) => p.path).join(", ") : "NONE -- these fields are not stored on liq_raw_events documents"}`,
  );

  async function nearestOiAtOrBefore(targetMs) {
    const doc = await oiCol
      .find({ symbol: SYMBOL, timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    if (!doc) return null;
    const ts =
      doc.timestamp instanceof Date ? doc.timestamp.getTime() : doc.timestamp;
    return { value: doc.openInterest, ts, ageMs: targetMs - ts };
  }

  // ---- PER-EPISODE TIMELINES ----
  for (const ep of EPISODES) {
    console.log(`\n${"=".repeat(140)}`);
    console.log(
      `EPISODE ${ep.num}: ${isoUtc(ep.startMs)} -> ${isoUtc(ep.endMs)}`,
    );
    console.log("=".repeat(140));

    const events = await liqCol
      .find({ symbol: SYMBOL, timestamp: { $gte: ep.startMs, $lte: ep.endMs } })
      .project({
        timestamp: 1,
        price: 1,
        quoteQty: 1,
        victim: 1,
        marketSnapshot: 1,
        ...Object.fromEntries(OPTIONAL_FIELD_NAMES.map((f) => [f, 1])),
      })
      .sort({ timestamp: 1 })
      .toArray();

    if (events.length === 0) {
      console.log("NO EVENTS FOUND in this exact window.");
      continue;
    }

    const header =
      presentOptionalFields.length > 0
        ? `#  | LIQ TIME     | LIQ USD  | LIQ PRICE | OI TIME      | OI AGE MS | OI (contracts)${oiHasUsdField ? " / OI USD" : ""} | ΔOI       | ΔOI%      | CUM LIQ USD  | ${presentOptionalFields.map((p) => p.field).join(" | ")}`
        : `#  | LIQ TIME     | LIQ USD  | LIQ PRICE | OI TIME      | OI AGE MS | OI (contracts)${oiHasUsdField ? " / OI USD" : ""} | ΔOI       | ΔOI%      | CUM LIQ USD`;
    console.log(header);
    console.log("-".repeat(140));

    let cumulativeLiqUsd = 0;
    let baseOi = null;
    let prevOi = null;
    let minOi = Infinity,
      maxOi = -Infinity;
    let firstOi = null,
      lastOi = null;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      cumulativeLiqUsd += e.quoteQty ?? 0;
      const oi = await nearestOiAtOrBefore(e.timestamp);
      const oiVal = oi ? oi.value : null;
      if (oiVal !== null) {
        if (firstOi === null) firstOi = oiVal;
        lastOi = oiVal;
        minOi = Math.min(minOi, oiVal);
        maxOi = Math.max(maxOi, oiVal);
      }

      let deltaOi = null,
        deltaOiPct = null,
        deltaLabel = "BASE";
      if (baseOi === null && oiVal !== null) {
        baseOi = oiVal;
        prevOi = oiVal;
      } else if (oiVal !== null && prevOi !== null) {
        deltaOi = oiVal - prevOi;
        deltaOiPct = prevOi !== 0 ? (deltaOi / prevOi) * 100 : null;
        deltaLabel = null;
        prevOi = oiVal;
      }

      const optionalVals = presentOptionalFields.map((p) => {
        const r = findField(e, p.field);
        return r.found ? r.value : "N/A";
      });

      const row =
        `${String(i + 1).padStart(3)} | ${hhmmssMs(e.timestamp)} | ${fmtUsd(e.quoteQty).padEnd(8)} | ${(e.price ?? "N/A").toString().padEnd(9)} | ` +
        `${oi ? hhmmssMs(oi.ts) : "N/A".padEnd(12)} | ${oi ? String(oi.ageMs).padStart(9) + "ms" : "N/A".padStart(11)} | ` +
        `${oiVal !== null ? oiVal.toFixed(2) : "N/A"} | ` +
        `${deltaOi !== null ? (deltaOi >= 0 ? "+" : "") + deltaOi.toFixed(2) : deltaLabel} | ` +
        `${deltaOiPct !== null ? fmtPct(deltaOiPct) : deltaLabel} | ` +
        `${fmtUsd(cumulativeLiqUsd)}` +
        (presentOptionalFields.length > 0
          ? " | " + optionalVals.join(" | ")
          : "");
      console.log(row);
    }

    console.log("-".repeat(140));
    console.log(`Events: ${events.length}`);
    console.log(`Total liquidation USD: ${fmtUsd(cumulativeLiqUsd)}`);
    console.log(`OI first: ${firstOi !== null ? firstOi.toFixed(2) : "N/A"}`);
    console.log(`OI last: ${lastOi !== null ? lastOi.toFixed(2) : "N/A"}`);
    console.log(
      `Net ΔOI: ${firstOi !== null && lastOi !== null ? (lastOi - firstOi >= 0 ? "+" : "") + (lastOi - firstOi).toFixed(2) : "N/A"}`,
    );
    console.log(
      `Net ΔOI%: ${firstOi !== null && lastOi !== null && firstOi !== 0 ? fmtPct(((lastOi - firstOi) / firstOi) * 100) : "N/A"}`,
    );
    console.log(`Minimum OI: ${minOi !== Infinity ? minOi.toFixed(2) : "N/A"}`);
    console.log(
      `Maximum OI: ${maxOi !== -Infinity ? maxOi.toFixed(2) : "N/A"}`,
    );
  }

  console.log(`\n${"=".repeat(140)}`);
  console.log(
    "Historical data only. No live connections, no wall logic, no theory. Raw chronological readout as stored.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
