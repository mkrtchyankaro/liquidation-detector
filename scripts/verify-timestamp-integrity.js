// Sep 20 2026 (Karo), operator-requested. TIMESTAMP INTEGRITY CHECK --
// verifies that liq_raw_events, oi_second_observations, and Binance
// klines all agree on UTC time, EMPIRICALLY rather than by assertion.
//
//   node scripts/verify-timestamp-integrity.js 4
//
// (argument = days back, default 4)
//
// METHOD:
//   1. PRICE CROSS-CHECK: for a sample of liq_raw_events across all 10
//      symbols, fetch the Binance 1m FUTURES kline whose
//      [openTime, openTime+60s) window contains that event's own
//      timestamp, and check whether the event's own `price` field
//      falls within that candle's [low, high] (small tolerance for
//      slippage). If our stored timestamp were offset from Binance's
//      real UTC clock, this would fail systematically (price would
//      belong to an ADJACENT candle, not the one our timestamp
//      claims) -- this is an empirical, not assumed, integrity check.
//   2. OI STALENESS: for the same sample, looks up the nearest
//      oi_second_observations document AT-OR-BEFORE the event's
//      timestamp and reports its age in ms. Consistently small ages
//      (matching the OI polling interval) indicate healthy alignment;
//      large or erratic ages indicate a gap or clock issue.
//   3. VERDICT: prints a pass/fail rate for each check, and flags any
//      individual mismatches with full detail for manual inspection.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];
const SAMPLE_PER_SYMBOL = 15;
const PRICE_TOLERANCE_PCT = 0.15;
const KLINE_FETCH_DELAY_MS = 150;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchKline1m(symbol, targetMs) {
  const openTime = Math.floor(targetMs / 60000) * 60000;
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${openTime}&limit=1`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status === 418) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0];
    return {
      openTimeMs: r[0],
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
    };
  }
  return null;
}

async function main() {
  const days = Number(process.argv[2] ?? "4");
  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(114));
  console.log(
    `TIMESTAMP INTEGRITY CHECK -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(114));

  let priceChecked = 0;
  let priceOk = 0;
  const priceMismatches = [];

  let oiChecked = 0;
  const oiAgesMs = [];
  const oiMissing = [];

  for (const symbol of SYMBOLS) {
    const events = await liqCol
      .find({ symbol, timestamp: { $gte: rangeStartMs, $lte: rangeEndMs } })
      .project({ timestamp: 1, price: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    if (events.length === 0) continue;

    const step = Math.max(1, Math.floor(events.length / SAMPLE_PER_SYMBOL));
    const sample = [];
    for (
      let i = 0;
      i < events.length && sample.length < SAMPLE_PER_SYMBOL;
      i += step
    )
      sample.push(events[i]);

    for (const e of sample) {
      const kline = await fetchKline1m(symbol, e.timestamp);
      await sleep(KLINE_FETCH_DELAY_MS);
      if (kline === null) continue;
      priceChecked++;
      const bandLow = kline.low * (1 - PRICE_TOLERANCE_PCT / 100);
      const bandHigh = kline.high * (1 + PRICE_TOLERANCE_PCT / 100);
      const inBand = e.price >= bandLow && e.price <= bandHigh;
      if (inBand) {
        priceOk++;
      } else {
        priceMismatches.push({
          symbol,
          eventTs: e.timestamp,
          eventPrice: e.price,
          klineOpenTimeMs: kline.openTimeMs,
          klineLow: kline.low,
          klineHigh: kline.high,
        });
      }

      const oiDoc = await oiCol
        .find({ symbol, timestamp: { $lte: new Date(e.timestamp) } })
        .sort({ timestamp: -1 })
        .limit(1)
        .next();
      oiChecked++;
      if (!oiDoc) {
        oiMissing.push({ symbol, eventTs: e.timestamp });
      } else {
        const oiTs =
          oiDoc.timestamp instanceof Date
            ? oiDoc.timestamp.getTime()
            : oiDoc.timestamp;
        oiAgesMs.push(e.timestamp - oiTs);
      }
    }
  }

  console.log(
    `\nPRICE CROSS-CHECK (event price vs Binance 1m kline [low,high] for the SAME minute, by our stored timestamp):`,
  );
  console.log(
    `  Checked: ${priceChecked}   In-band: ${priceOk} (${priceChecked > 0 ? ((priceOk / priceChecked) * 100).toFixed(1) : "N/A"}%)   Mismatches: ${priceMismatches.length}`,
  );
  if (priceMismatches.length > 0) {
    console.log(`\n  Mismatch detail (first 20):`);
    for (const m of priceMismatches.slice(0, 20)) {
      console.log(
        `    ${m.symbol}  event@${isoUtc(m.eventTs)}  price=${m.eventPrice}  vs kline[${isoUtc(m.klineOpenTimeMs)}] low=${m.klineLow} high=${m.klineHigh}`,
      );
    }
  }

  console.log(
    `\nOI STALENESS (age of the nearest-at-or-before OI observation, at each sampled event's timestamp):`,
  );
  console.log(
    `  Checked: ${oiChecked}   Missing entirely: ${oiMissing.length}`,
  );
  if (oiAgesMs.length > 0) {
    const sorted = [...oiAgesMs].sort((a, b) => a - b);
    const mean = oiAgesMs.reduce((a, b) => a + b, 0) / oiAgesMs.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = sorted[sorted.length - 1];
    console.log(
      `  Age (ms): mean=${mean.toFixed(0)}  median=${median}  max=${max}  (negative would mean the OI doc is somehow AFTER the event -- should never happen with $lte)`,
    );
    const negativeAges = oiAgesMs.filter((a) => a < 0).length;
    if (negativeAges > 0)
      console.log(
        `  WARNING: ${negativeAges} negative age(s) found -- this should be impossible with a $lte query; investigate immediately.`,
      );
  }
  if (oiMissing.length > 0) {
    console.log(`\n  Missing detail (first 20):`);
    for (const m of oiMissing.slice(0, 20))
      console.log(
        `    ${m.symbol}  event@${isoUtc(m.eventTs)}  -- no OI observation at or before this time`,
      );
  }

  console.log(`\n${"=".repeat(114)}`);
  console.log("VERDICT:");
  const priceOkRate = priceChecked > 0 ? priceOk / priceChecked : null;
  if (priceOkRate === null) {
    console.log(
      "  Could not verify price alignment (no klines fetched successfully).",
    );
  } else if (priceOkRate > 0.98) {
    console.log(
      `  PRICE TIMESTAMPS: HEALTHY (${(priceOkRate * 100).toFixed(1)}% in-band). liq_raw_events and Binance klines agree on UTC time.`,
    );
  } else if (priceOkRate > 0.9) {
    console.log(
      `  PRICE TIMESTAMPS: MOSTLY OK but ${priceMismatches.length} mismatch(es) -- review the mismatch detail above; could be isolated data issues, not necessarily a clock problem.`,
    );
  } else {
    console.log(
      `  PRICE TIMESTAMPS: SUSPECT (only ${(priceOkRate * 100).toFixed(1)}% in-band). This pattern is consistent with a systematic clock offset -- do NOT trust downstream analysis until resolved.`,
    );
  }
  if (oiAgesMs.length > 0) {
    const medianAge = [...oiAgesMs].sort((a, b) => a - b)[
      Math.floor(oiAgesMs.length / 2)
    ];
    if (medianAge < 5000)
      console.log(
        `  OI TIMESTAMPS: HEALTHY (median staleness ${medianAge}ms at event time).`,
      );
    else if (medianAge < 60000)
      console.log(
        `  OI TIMESTAMPS: usable but noticeably stale (median ${medianAge}ms) -- consider this when reading OI deltas over short windows.`,
      );
    else
      console.log(
        `  OI TIMESTAMPS: STALE (median ${medianAge}ms) -- OI deltas over short windows are not reliable; this is a data-freshness gap, separate from the clock-alignment question.`,
      );
  }
  console.log(
    "This never touches live strategy or trading logic -- diagnostic only.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
