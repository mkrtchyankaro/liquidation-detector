// FOUR-EPISODE CONTINUOUS TIMELINE -- RESEARCH ONLY.
// Does NOT modify production code, episode detection, macro merge
// logic, or MongoDB data. Pure historical read + print.
//
//   node scripts/four-episodes-continuous-timeline.js
//
// ============================================================
// STEP 1 RESULT -- SCHEMA INSPECTION (done by reading the actual
// source before writing this script, not guessed):
//
//   BTC price (PRIMARY continuous source, ~1s resolution, covers
//   both episodes AND gaps):
//     collection: oi_second_observations
//     field: price  (Number | null)
//     -- CONFIRMED INDEPENDENT, not derived from openInterestUsd /
//        openInterest. Source: src/services/market-data-orchestrator.ts
//        line ~386-389: `openInterestUsd: obs.price !== null ?
//        obs.contracts * obs.price : null, price: obs.price` -- price
//        itself comes from OiTrackerService's own poll (or an
//        orderbook-midprice fallback), openInterestUsd is the
//        DERIVED one, not price.
//
//   raw openInterest (PRIMARY OI metric, per operator instruction):
//     collection: oi_second_observations
//     field: openInterest  (Number, contracts/BTC)
//     timestamp field: timestamp (poll time); a second field
//     oiUpdatedAt exists (exchange-side OI update time) but is not
//     used here -- timestamp is the established convention from
//     every other script this session, kept for consistency.
//     RETENTION: 3-day TTL (OI_SECOND_OBSERVATION_TTL_SECONDS in
//     oi-second-observation.repository.ts) -- if this script is run
//     too long after Sep 20 2026, some/all of this data may have
//     expired; the script reports missing data as N/A, never invents.
//
//   taker BUY/SELL USD, taker imbalance:
//     NOT AVAILABLE as continuous historical data.
//     AggressiveFlowService (src/domain/liquidation/aggressive-flow.
//     service.ts) is explicitly documented "No persistence — RAM
//     only" -- a 5-minute rolling ring buffer, lost on every restart,
//     never written to Mongo as its own time series.
//     The ONLY place taker flow ever reaches Mongo is EMBEDDED inside
//     each liq_raw_events document's marketSnapshot.takerFlow, as
//     SIX OVERLAPPING rolling windows (10s/30s/1m/2m/3m/5m) captured
//     at that ONE liquidation event's own instant -- these windows
//     overlap by construction (the 1m window contains the same trades
//     as the 30s window plus more), so per the operator's own Step 9
//     instruction they must never be summed across events (double-
//     counting), and they simply do not exist at all during GAP
//     periods (no liquidation event = no snapshot written).
//     CONCLUSION: taker BUY/SELL/imbalance is printed as N/A
//     throughout this script, for both episodes and gaps. This is a
//     genuine data-availability limitation, not a bug in this script.
//
//   liquidation events:
//     collection: liq_raw_events
//     fields used: timestamp, price, quoteQty (USD), victim
//     ("LONG"/"SHORT" -- the side that got liquidated)
// ============================================================

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";

// ---- STEP 3: exact phase boundaries, as given, unmodified ----
const PHASES = [
  {
    name: "EP31",
    type: "EPISODE",
    startMs: Date.parse("2026-09-20T02:24:27.128Z"),
    endMs: Date.parse("2026-09-20T02:36:15.129Z"),
  },
  {
    name: "GAP31_32",
    type: "GAP",
    startMs: Date.parse("2026-09-20T02:36:15.129Z"),
    endMs: Date.parse("2026-09-20T02:39:21.185Z"),
  },
  {
    name: "EP32",
    type: "EPISODE",
    startMs: Date.parse("2026-09-20T02:39:21.185Z"),
    endMs: Date.parse("2026-09-20T02:45:58.188Z"),
  },
  {
    name: "GAP32_33",
    type: "GAP",
    startMs: Date.parse("2026-09-20T02:45:58.188Z"),
    endMs: Date.parse("2026-09-20T02:54:09.182Z"),
  },
  {
    name: "EP33",
    type: "EPISODE",
    startMs: Date.parse("2026-09-20T02:54:09.182Z"),
    endMs: Date.parse("2026-09-20T03:02:37.147Z"),
  },
  {
    name: "GAP33_34",
    type: "GAP",
    startMs: Date.parse("2026-09-20T03:02:37.147Z"),
    endMs: Date.parse("2026-09-20T03:14:42.177Z"),
  },
  {
    name: "EP34",
    type: "EPISODE",
    startMs: Date.parse("2026-09-20T03:14:42.177Z"),
    endMs: Date.parse("2026-09-20T03:16:19.199Z"),
  },
];
const FULL_START_MS = PHASES[0].startMs;
const FULL_END_MS = PHASES[PHASES.length - 1].endMs;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}
function hhmmssMs(ms) {
  return new Date(ms).toISOString().slice(11, 23);
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
function fmtUsdPlain(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
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
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}
function fmtDurationSec(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}
const TAKER_NA = "N/A";

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(150));
  console.log("FOUR-EPISODE CONTINUOUS TIMELINE (research only)");
  console.log(`Full span: ${isoUtc(FULL_START_MS)} -> ${isoUtc(FULL_END_MS)}`);
  console.log("=".repeat(150));

  // Pre-fetch ALL OI observations and ALL liq events for the full span once.
  const allOi = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(FULL_START_MS - 60000),
        $lte: new Date(FULL_END_MS + 60000),
      },
    })
    .project({ timestamp: 1, openInterest: 1, price: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allLiq = await liqCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: FULL_START_MS, $lte: FULL_END_MS },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(
    `\nLoaded ${allOi.length} OI observations, ${allLiq.length} liquidation events, for the full span.`,
  );
  if (allOi.length === 0) {
    console.log(
      "\nNO OI DATA FOUND for this span -- likely expired past the 3-day TTL. Cannot proceed.",
    );
    await client.close();
    return;
  }

  function oiAtOrBefore(targetMs) {
    let best = null;
    for (const d of allOi) {
      const ts =
        d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp;
      if (ts <= targetMs)
        best = { ts, contracts: d.openInterest, price: d.price };
      else break;
    }
    return best;
  }
  function oiWithinRange(fromMs, toMs) {
    return allOi
      .map((d) => ({
        ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
        contracts: d.openInterest,
        price: d.price,
      }))
      .filter((d) => d.ts >= fromMs && d.ts <= toMs);
  }
  function liqWithinRange(fromMs, toMs) {
    return allLiq.filter((e) => e.timestamp >= fromMs && e.timestamp < toMs);
  }
  function liqTotals(events) {
    let longUsd = 0,
      shortUsd = 0;
    for (const e of events) {
      if (e.victim === "LONG") longUsd += e.quoteQty ?? 0;
      else if (e.victim === "SHORT") shortUsd += e.quoteQty ?? 0;
    }
    return { longUsd, shortUsd, count: events.length };
  }

  // ============================================================
  // STEP 4: PHASE START/END TABLE
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log("STEP 4 -- PHASE TABLE");
  console.log("=".repeat(150));
  console.log(
    "PHASE      | DURATION | PRICE START | PRICE END  | PRICE Δ    | OI START   | OI END     | OI Δ BTC   | CONTRACT Δ$  | LONG LIQ   | SHORT LIQ  | TAKER BUY | TAKER SELL | IMBALANCE",
  );
  console.log("-".repeat(150));

  const phaseStats = [];
  for (const p of PHASES) {
    const startOi = oiAtOrBefore(p.startMs);
    const endOi = oiAtOrBefore(p.endMs);
    const events = liqWithinRange(p.startMs, p.endMs + 1);
    const { longUsd, shortUsd, count } = liqTotals(events);
    const priceDelta = startOi && endOi ? endOi.price - startOi.price : null;
    const oiDeltaBtc =
      startOi && endOi ? endOi.contracts - startOi.contracts : null;
    const contractDeltaUsd =
      oiDeltaBtc !== null && startOi ? oiDeltaBtc * startOi.price : null;

    phaseStats.push({
      ...p,
      startOi,
      endOi,
      priceDelta,
      oiDeltaBtc,
      contractDeltaUsd,
      longUsd,
      shortUsd,
      count,
    });

    console.log(
      `${p.name.padEnd(10)} | ${fmtDurationSec(p.endMs - p.startMs).padEnd(8)} | ${fmtPrice(startOi?.price).padEnd(12)} | ${fmtPrice(endOi?.price).padEnd(10)} | ${fmtPriceDelta(priceDelta).padEnd(10)} | ${fmtBtc(startOi?.contracts).padEnd(10)} | ${fmtBtc(endOi?.contracts).padEnd(10)} | ${fmtBtcDelta(oiDeltaBtc).padEnd(10)} | ${fmtUsd(contractDeltaUsd).padEnd(12)} | ${fmtUsdPlain(longUsd).padEnd(10)} | ${fmtUsdPlain(shortUsd).padEnd(10)} | ${TAKER_NA.padEnd(9)} | ${TAKER_NA.padEnd(10)} | ${TAKER_NA}`,
    );
  }

  // ============================================================
  // STEP 5 + STEP 6: DETAILED SECTIONS + CHRONOLOGICAL TIMELINES
  // (episodes and gaps both use this, per "consistent time resolution")
  // ============================================================
  function printMinuteTimeline(fromMs, toMs) {
    console.log(
      "TIME     | BTC PRICE  | OI BTC     | ΔOI BTC   | TAKER BUY | TAKER SELL | IMBALANCE | LONG LIQ  | SHORT LIQ",
    );
    console.log("-".repeat(110));
    let prevOi = oiAtOrBefore(fromMs)?.contracts ?? null;
    const minuteStart = Math.floor(fromMs / 60000) * 60000;
    for (let m = minuteStart; m <= toMs; m += 60000) {
      if (m < fromMs) continue;
      const oi = oiAtOrBefore(m + 59999);
      const deltaOi = oi && prevOi !== null ? oi.contracts - prevOi : null;
      if (oi) prevOi = oi.contracts;
      const events = liqWithinRange(m, Math.min(m + 60000, toMs + 1));
      const { longUsd, shortUsd } = liqTotals(events);
      console.log(
        `${hhmmss(m)} | ${fmtPrice(oi?.price).padEnd(10)} | ${fmtBtc(oi?.contracts).padEnd(10)} | ${fmtBtcDelta(deltaOi).padEnd(9)} | ${TAKER_NA.padEnd(9)} | ${TAKER_NA.padEnd(10)} | ${TAKER_NA.padEnd(9)} | ${fmtUsdPlain(longUsd).padEnd(9)} | ${fmtUsdPlain(shortUsd)}`,
      );
    }
  }

  for (const p of phaseStats) {
    console.log(`\n${"=".repeat(150)}`);
    console.log(`${p.name}`);
    console.log(`${isoUtc(p.startMs)} -> ${isoUtc(p.endMs)}`);
    console.log("=".repeat(150));

    if (p.type === "GAP") {
      const oiInRange = oiWithinRange(p.startMs, p.endMs);
      const priceVals = oiInRange.map((d) => d.price).filter((v) => v !== null);
      const oiVals = oiInRange.map((d) => d.contracts);
      const minPrice = priceVals.length ? Math.min(...priceVals) : null;
      const maxPrice = priceVals.length ? Math.max(...priceVals) : null;
      const minOiEntry = oiInRange.reduce(
        (best, d) => (best === null || d.contracts < best.contracts ? d : best),
        null,
      );
      const maxOiEntry = oiInRange.reduce(
        (best, d) => (best === null || d.contracts > best.contracts ? d : best),
        null,
      );
      const events = liqWithinRange(p.startMs, p.endMs + 1);
      const { longUsd, shortUsd, count } = liqTotals(events);

      console.log(`\nDuration: ${fmtDurationSec(p.endMs - p.startMs)}`);
      console.log(`\nBTC:`);
      console.log(`Start price: ${fmtPrice(p.startOi?.price)}`);
      console.log(`Lowest price: ${fmtPrice(minPrice)}`);
      console.log(`Highest price: ${fmtPrice(maxPrice)}`);
      console.log(`End price: ${fmtPrice(p.endOi?.price)}`);
      console.log(`Net change: ${fmtPriceDelta(p.priceDelta)}`);
      console.log(`\nOPEN INTEREST:`);
      console.log(`Start OI: ${fmtBtc(p.startOi?.contracts)}`);
      console.log(`Minimum OI: ${fmtBtc(minOiEntry?.contracts)}`);
      console.log(`Maximum OI: ${fmtBtc(maxOiEntry?.contracts)}`);
      console.log(`End OI: ${fmtBtc(p.endOi?.contracts)}`);
      console.log(`Net ΔOI BTC: ${fmtBtcDelta(p.oiDeltaBtc)}`);
      console.log(
        `\nTime of minimum OI: ${minOiEntry ? isoUtc(minOiEntry.ts).slice(11, 23) : "N/A"}`,
      );
      console.log(
        `Time of maximum OI: ${maxOiEntry ? isoUtc(maxOiEntry.ts).slice(11, 23) : "N/A"}`,
      );
      console.log(`\nTAKER FLOW:`);
      console.log(
        `Total taker buy: ${TAKER_NA} -- exact non-overlapping historical flow unavailable (see Step 1 note)`,
      );
      console.log(`Total taker sell: ${TAKER_NA}`);
      console.log(`Net: ${TAKER_NA}`);
      console.log(`Imbalance: ${TAKER_NA}`);
      console.log(`\nLIQUIDATIONS INSIDE GAP:`);
      console.log(`LONG: ${fmtUsdPlain(longUsd)}`);
      console.log(`SHORT: ${fmtUsdPlain(shortUsd)}`);
      console.log(`event count: ${count}`);
      console.log(`\nGAP CHRONOLOGICAL TIMELINE (1-minute rows):`);
      printMinuteTimeline(p.startMs, p.endMs);
    } else {
      console.log(`\nEPISODE CHRONOLOGICAL TIMELINE (1-minute rows):`);
      printMinuteTimeline(p.startMs, p.endMs);
    }
  }

  // ============================================================
  // STEP 7: OI REBUILD / DESTRUCTION ACCOUNTING
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log("STEP 7 -- OI Δ ACCOUNTING PER PHASE");
  console.log("=".repeat(150));
  for (const p of phaseStats) {
    console.log(`${p.name} OI Δ BTC: ${fmtBtcDelta(p.oiDeltaBtc)}`);
  }

  const ep32 = phaseStats.find((p) => p.name === "EP32");
  const ep33 = phaseStats.find((p) => p.name === "EP33");
  const oiRebuildBetween3233 =
    ep33.startOi && ep32.endOi
      ? ep33.startOi.contracts - ep32.endOi.contracts
      : null;
  const oiChangeDuringEp33 =
    ep33.endOi && ep33.startOi
      ? ep33.endOi.contracts - ep33.startOi.contracts
      : null;
  console.log(
    `\nOI_REBUILD_BETWEEN_32_AND_33 = EP33_START_OI - EP32_END_OI = ${fmtBtcDelta(oiRebuildBetween3233)} BTC`,
  );
  console.log(
    `OI_CHANGE_DURING_EP33 = EP33_END_OI - EP33_START_OI = ${fmtBtcDelta(oiChangeDuringEp33)} BTC`,
  );
  console.log(
    "(these two numbers are NOT combined -- printed separately, per instruction)",
  );

  // ============================================================
  // STEP 8: TOP 10 OI INCREASE / DECREASE INTERVALS
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log("STEP 8 -- TOP OI MOVE INTERVALS");
  console.log("=".repeat(150));
  console.log(
    "Interval selected: 60-second buckets. Reason: oi_second_observations polls at ~1s -- comparing",
  );
  console.log(
    "consecutive 1s samples would surface poll-to-poll noise, not meaningful moves. 60s buckets (one",
  );
  console.log(
    "bucket per minute across the whole 02:24:27-03:16:19 span) filter that noise while still resolving",
  );
  console.log("moves at intra-episode granularity.");

  const bucketStart = Math.floor(FULL_START_MS / 60000) * 60000;
  const buckets = [];
  for (let m = bucketStart; m <= FULL_END_MS; m += 60000) {
    const oi = oiAtOrBefore(m + 59999);
    if (oi) buckets.push({ ts: m, contracts: oi.contracts, price: oi.price });
  }
  const intervals = [];
  for (let i = 1; i < buckets.length; i++) {
    const a = buckets[i - 1],
      b = buckets[i];
    intervals.push({
      fromTs: a.ts,
      toTs: b.ts,
      seconds: (b.ts - a.ts) / 1000,
      oiBefore: a.contracts,
      oiAfter: b.contracts,
      deltaOi: b.contracts - a.contracts,
      priceBefore: a.price,
      priceAfter: b.price,
      priceDelta:
        b.price !== null && a.price !== null ? b.price - a.price : null,
    });
  }
  const increases = [...intervals]
    .sort((x, y) => y.deltaOi - x.deltaOi)
    .slice(0, 10);
  const decreases = [...intervals]
    .sort((x, y) => x.deltaOi - y.deltaOi)
    .slice(0, 10);

  console.log("\nTOP 10 OI INCREASE INTERVALS:");
  console.log(
    "TIME FROM   | TIME TO     | SEC | OI BEFORE  | OI AFTER   | ΔOI BTC   | PRICE BEFORE | PRICE AFTER | PRICE Δ",
  );
  for (const iv of increases) {
    console.log(
      `${hhmmss(iv.fromTs)} | ${hhmmss(iv.toTs)} | ${String(iv.seconds).padStart(3)} | ${fmtBtc(iv.oiBefore).padEnd(10)} | ${fmtBtc(iv.oiAfter).padEnd(10)} | ${fmtBtcDelta(iv.deltaOi).padEnd(9)} | ${fmtPrice(iv.priceBefore).padEnd(12)} | ${fmtPrice(iv.priceAfter).padEnd(11)} | ${fmtPriceDelta(iv.priceDelta)}`,
    );
  }
  console.log("\nTOP 10 OI DECREASE INTERVALS:");
  console.log(
    "TIME FROM   | TIME TO     | SEC | OI BEFORE  | OI AFTER   | ΔOI BTC   | PRICE BEFORE | PRICE AFTER | PRICE Δ",
  );
  for (const iv of decreases) {
    console.log(
      `${hhmmss(iv.fromTs)} | ${hhmmss(iv.toTs)} | ${String(iv.seconds).padStart(3)} | ${fmtBtc(iv.oiBefore).padEnd(10)} | ${fmtBtc(iv.oiAfter).padEnd(10)} | ${fmtBtcDelta(iv.deltaOi).padEnd(9)} | ${fmtPrice(iv.priceBefore).padEnd(12)} | ${fmtPrice(iv.priceAfter).padEnd(11)} | ${fmtPriceDelta(iv.priceDelta)}`,
    );
  }

  // ============================================================
  // STEP 9: TAKER FLOW SAFETY -- already handled throughout (N/A everywhere, explained in Step 1).
  // ============================================================

  // ============================================================
  // STEP 10: FINAL SIMPLE STORY TABLE
  // ============================================================
  console.log(`\n${"=".repeat(150)}`);
  console.log("STEP 10 -- FINAL STORY TABLE");
  console.log("=".repeat(150));
  console.log(
    "PHASE      | PRICE Δ    | OI Δ BTC   | LONG LIQ   | SHORT LIQ  | TAKER STATE",
  );
  console.log("-".repeat(90));
  for (const p of phaseStats) {
    console.log(
      `${p.name.padEnd(10)} | ${fmtPriceDelta(p.priceDelta).padEnd(10)} | ${fmtBtcDelta(p.oiDeltaBtc).padEnd(10)} | ${fmtUsdPlain(p.longUsd).padEnd(10)} | ${fmtUsdPlain(p.shortUsd).padEnd(10)} | N/A (unavailable)`,
    );
  }

  console.log(`\nOI PATH:\n`);
  for (const p of phaseStats) {
    console.log(`${p.name}:`);
    console.log(
      `${fmtBtc(p.startOi?.contracts)} -> ${fmtBtc(p.endOi?.contracts)}\n`,
    );
  }

  // ============================================================
  // FOOTER
  // ============================================================
  console.log("=".repeat(150));
  console.log("FILES CREATED:");
  console.log("  scripts/four-episodes-continuous-timeline.js");
  console.log("FILES MODIFIED:");
  console.log("  (none)");
  console.log("");
  console.log("COLLECTIONS USED:");
  console.log("  oi_second_observations, liq_raw_events");
  console.log("FIELDS USED:");
  console.log(
    "  oi_second_observations: symbol, timestamp, openInterest, price",
  );
  console.log("  liq_raw_events: symbol, timestamp, price, quoteQty, victim");
  console.log("");
  console.log("DATA LIMITATIONS:");
  console.log(
    "  - Taker BUY/SELL/imbalance: unavailable as continuous historical data.",
  );
  console.log(
    "    AggressiveFlowService is RAM-only (no Mongo persistence). The only",
  );
  console.log(
    "    taker-flow data ever reaching Mongo is embedded per-liquidation-event",
  );
  console.log(
    "    as 6 OVERLAPPING rolling windows inside liq_raw_events.marketSnapshot",
  );
  console.log(
    "    -- cannot be summed (double-counting) or reconstructed for gap periods",
  );
  console.log(
    "    (no liquidation event = no snapshot). Printed N/A throughout.",
  );
  console.log(
    "  - oi_second_observations has a 3-day TTL -- if run long after Sep 20",
  );
  console.log(
    "    2026, some or all OI/price data for this span may have expired.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
