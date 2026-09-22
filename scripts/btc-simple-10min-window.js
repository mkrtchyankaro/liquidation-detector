// BTC SIMPLE 10-MINUTE WINDOW RESEARCH -- deliberately dumb, fully
// standalone. NO structural END detector of any kind. NO Page-Hinkley,
// NO OLS/regression, NO residuals, NO magnitude segmentation, NO
// kNN, NO sequential test, NO gap clustering, NO OI/price-based
// termination logic whatsoever.
//
// A candidate is: first liquidation -> FIXED [start, start+10min]
// window -> close -> causal prior-3-day same-side P90/P100 filter.
// That is the entire state machine.
//
//   node scripts/btc-simple-10min-window.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

// === AUDIT SCAN START === Everything above this line (including this
// file's own descriptive header comment, which necessarily NAMES the
// forbidden concepts in order to disclaim them) is EXCLUDED from the
// mechanical scan below -- otherwise a disclaimer like "NO <term>"
// would still contain the substring "<term>" and trigger a false
// positive against its own negation. Only the executable code from
// here down -- the actual candidate-construction and metrics logic --
// is scanned.

require("dotenv/config");
const { MongoClient } = require("mongodb");
const fs = require("fs");

const SYMBOL = "BTCUSDT";
const EVAL_DAYS = 3;
const BASELINE_DAYS = 3;
const WINDOW_MS = 10 * 60 * 1000; // fixed, never extended, never reset
const MIN_LIVE_SAMPLE = 5;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtDate(ms) {
  return ms === null
    ? "N/A"
    : new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}
function fmtUsd(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtBtc(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
function fmtLogPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(4)}%`;
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
function percentileRank(sortedPop, x) {
  if (sortedPop.length === 0) return null;
  let c = 0;
  for (const v of sortedPop) if (v <= x) c++;
  return (c / sortedPop.length) * 100;
}
function priceAtOrBeforeIdx(obs, idx) {
  for (let k = idx; k >= 0; k--) if (obs[k].price !== null) return obs[k].price;
  return null;
}
function nearestObsIdxAtOrBefore(obs, targetMs, fromIdx = 0) {
  let best = -1;
  for (let k = fromIdx; k < obs.length; k++) {
    if (obs[k].ts <= targetMs) best = k;
    else break;
  }
  return best;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;

  const allLiq = await liqCol
    .find({ symbol: SYMBOL, timestamp: { $gte: loadStartMs, $lte: evalEndMs } })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allOiRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(loadStartMs - 65000),
        $lte: new Date(evalEndMs + WINDOW_MS),
      },
    })
    .project({ timestamp: 1, openInterest: 1, price: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allOi = allOiRaw.map((d) => ({
    ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
    contracts: d.openInterest,
    price: d.price,
  }));

  console.log("=".repeat(170));
  console.log(
    `Load window: ${isoUtc(loadStartMs)} -> ${isoUtc(evalEndMs)}   Evaluation period: ${isoUtc(evalStartMs)} -> ${isoUtc(evalEndMs)}`,
  );
  console.log(
    `Raw liquidation events: ${allLiq.length}   OI+price observations: ${allOi.length}`,
  );
  console.log("=".repeat(170));
  if (allLiq.length === 0 || allOi.length < 10) {
    console.log("Insufficient data.");
    await client.close();
    return;
  }

  // ---- THE ENTIRE CANDIDATE CONSTRUCTION: fixed 10-minute window, nothing else ----
  const candidates = [];
  let liqIdx = 0;
  while (liqIdx < allLiq.length) {
    const startEvent = allLiq[liqIdx];
    const direction = startEvent.victim;
    const startTs = startEvent.timestamp;
    const endTs = startTs + WINDOW_MS;

    const events = [];
    while (liqIdx < allLiq.length && allLiq[liqIdx].timestamp <= endTs) {
      events.push(allLiq[liqIdx]);
      liqIdx++;
    }

    const startIdx = nearestObsIdxAtOrBefore(allOi, startTs);
    const endIdx = nearestObsIdxAtOrBefore(allOi, endTs);
    let priceStart = null,
      priceEnd = null,
      oiStart = null,
      oiEnd = null,
      netOi = null,
      posOi = null,
      negOi = null,
      grossOi = null,
      netPriceLog = null;
    if (startIdx >= 0 && endIdx >= 0 && endIdx >= startIdx) {
      priceStart = priceAtOrBeforeIdx(allOi, startIdx);
      priceEnd = priceAtOrBeforeIdx(allOi, endIdx);
      oiStart = allOi[startIdx].contracts;
      oiEnd = allOi[endIdx].contracts;
      netOi = oiEnd - oiStart;
      let pos = 0,
        neg = 0;
      for (let k = startIdx + 1; k <= endIdx; k++) {
        const d = allOi[k].contracts - allOi[k - 1].contracts;
        if (d > 0) pos += d;
        else neg += d;
      }
      posOi = pos;
      negOi = neg;
      grossOi = pos - neg;
      netPriceLog =
        priceStart !== null && priceEnd !== null
          ? Math.log(priceEnd / priceStart)
          : null;
    }

    const dirLiqUsd = events
      .filter((e) => e.victim === direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const oppLiqUsd = events
      .filter((e) => e.victim !== direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);

    candidates.push({
      direction,
      startTs,
      endTs,
      dirLiqUsd,
      oppLiqUsd,
      totalLiqUsd: dirLiqUsd + oppLiqUsd,
      eventCount: events.length,
      priceStart,
      priceEnd,
      netPriceLog,
      oiStart,
      oiEnd,
      netOi,
      posOi,
      negOi,
      grossOi,
    });
  }
  console.log(
    `\nCandidates constructed (fixed 10-minute windows): ${candidates.length}`,
  );

  // ---- Causal prior-3-day same-side P90/P100 ----
  const longC = candidates
    .filter((c) => c.direction === "LONG")
    .sort((a, b) => a.endTs - b.endTs);
  const shortC = candidates
    .filter((c) => c.direction === "SHORT")
    .sort((a, b) => a.endTs - b.endTs);
  function applyRolling(cs) {
    cs.forEach((c, idx) => {
      const prior = cs
        .slice(0, idx)
        .filter(
          (p) =>
            p.endTs >= c.endTs - BASELINE_DAYS * 86_400_000 &&
            p.endTs < c.endTs,
        );
      c.priorCount = prior.length;
      c.liveEvaluable = c.endTs >= evalStartMs;
      if (prior.length < MIN_LIVE_SAMPLE) {
        c.status = "INSUFFICIENT_HISTORY";
        c.causalP90 = null;
        c.causalP100 = null;
        c.pctRank = null;
        c.decision = null;
        return;
      }
      const vals = prior.map((p) => p.dirLiqUsd).sort((a, b) => a - b);
      c.causalP90 = percentile(vals, 90);
      c.causalP100 = Math.max(...vals);
      c.pctRank = percentileRank(vals, c.dirLiqUsd);
      c.decision = c.dirLiqUsd >= c.causalP90 ? "KEEP_P90" : "DROP_BELOW_P90";
      c.abovePriorP100 = c.dirLiqUsd > c.causalP100;
      c.status = "LIVE";
    });
  }
  applyRolling(longC);
  applyRolling(shortC);

  // ---- Output every live-evaluable candidate ----
  console.log(`\n${"=".repeat(190)}`);
  console.log("EVERY EVALUATION CANDIDATE, CHRONOLOGICAL");
  console.log("=".repeat(190));
  const liveSorted = [...longC, ...shortC]
    .filter((c) => c.liveEvaluable)
    .sort((a, b) => a.startTs - b.startTs);
  liveSorted.forEach((c, idx) => {
    console.log(`\nCandidate #${idx + 1}`);
    console.log(`Direction: ${c.direction}`);
    console.log(`START: ${fmtDate(c.startTs)}`);
    console.log(`END: ${fmtDate(c.endTs)}`);
    console.log(
      `Direction liquidation USD: ${fmtUsd(c.dirLiqUsd)}   Opposite: ${fmtUsd(c.oppLiqUsd)}   Total: ${fmtUsd(c.totalLiqUsd)}   Events: ${c.eventCount}`,
    );
    console.log(`Prior 3d same-side candidate count: ${c.priorCount}`);
    console.log(
      `Causal P90: ${c.status === "LIVE" ? fmtUsd(c.causalP90) : `N/A (${c.status})`}   Causal P100: ${c.status === "LIVE" ? fmtUsd(c.causalP100) : "N/A"}`,
    );
    console.log(
      `Current/P90: ${c.status === "LIVE" ? (c.dirLiqUsd / c.causalP90).toFixed(2) + "x" : "N/A"}   Current/P100: ${c.status === "LIVE" ? (c.dirLiqUsd / c.causalP100).toFixed(2) + "x" : "N/A"}`,
    );
    console.log(
      `ABOVE_P90: ${c.decision === "KEEP_P90" ? "YES" : c.decision === "DROP_BELOW_P90" ? "NO" : "N/A"}   ABOVE_PRIOR_P100: ${c.abovePriorP100 !== undefined ? (c.abovePriorP100 ? "YES" : "NO") : "N/A"}`,
    );
    console.log(`Decision: ${c.decision ?? c.status}`);
    console.log(
      `PRICE: start=${fmtPrice(c.priceStart)} end=${fmtPrice(c.priceEnd)} log-return=${fmtLogPct(c.netPriceLog)}`,
    );
    console.log(
      `OI: start=${fmtBtc(c.oiStart)} end=${fmtBtc(c.oiEnd)} net=${fmtBtcDelta(c.netOi)} positive=${fmtBtcDelta(c.posOi)} negative=${fmtBtcDelta(c.negOi)} gross=${fmtBtc(c.grossOi)}`,
    );
  });

  // ---- Summary ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("SUMMARY");
  console.log("=".repeat(170));
  for (const [label, cs] of [
    ["LONG", longC],
    ["SHORT", shortC],
  ]) {
    const live = cs.filter((c) => c.liveEvaluable);
    const keep = live.filter((c) => c.decision === "KEEP_P90");
    const drop = live.filter((c) => c.decision === "DROP_BELOW_P90");
    const insuff = live.filter((c) => c.status === "INSUFFICIENT_HISTORY");
    const aboveP100 = live.filter((c) => c.abovePriorP100);
    console.log(
      `\n${label}: total candidates=${cs.length}  live-evaluable=${live.length}  KEEP_P90=${keep.length}  DROP_BELOW_P90=${drop.length}  insufficient-history=${insuff.length}  ABOVE_PRIOR_P100=${aboveP100.length}  keep-rate=${live.length - insuff.length > 0 ? ((keep.length / (live.length - insuff.length)) * 100).toFixed(1) + "%" : "N/A"}`,
    );
    const vals = cs.map((c) => c.dirLiqUsd).sort((a, b) => a - b);
    console.log(
      `  diagnostic distribution (all ${label} candidates' dirLiqUsd): P50=${fmtUsd(percentile(vals, 50))}  P75=${fmtUsd(percentile(vals, 75))}  P90=${fmtUsd(percentile(vals, 90))}  P95=${fmtUsd(percentile(vals, 95))}  MAX=${fmtUsd(vals[vals.length - 1])}`,
    );
  }

  // ---- Manual inspection ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("MANUAL INSPECTION");
  console.log("=".repeat(170));
  function line(c) {
    return `${c.direction} ${fmtDate(c.startTs)} -> ${fmtDate(c.endTs)}  dirLiq=${fmtUsd(c.dirLiqUsd)}  P90=${fmtUsd(c.causalP90)}  pctRank=${c.pctRank?.toFixed(1)}`;
  }
  console.log("\nALL ABOVE_PRIOR_P100:");
  [...longC, ...shortC]
    .filter((c) => c.liveEvaluable && c.abovePriorP100)
    .forEach((c) => console.log("  " + line(c)));
  console.log("\nTop 5 KEEP_P90 LONG:");
  longC
    .filter((c) => c.decision === "KEEP_P90")
    .sort((a, b) => b.dirLiqUsd - a.dirLiqUsd)
    .slice(0, 5)
    .forEach((c) => console.log("  " + line(c)));
  console.log("\nTop 5 KEEP_P90 SHORT:");
  shortC
    .filter((c) => c.decision === "KEEP_P90")
    .sort((a, b) => b.dirLiqUsd - a.dirLiqUsd)
    .slice(0, 5)
    .forEach((c) => console.log("  " + line(c)));
  console.log("\n3 LONG immediately below P90:");
  longC
    .filter((c) => c.decision === "DROP_BELOW_P90")
    .sort((a, b) => (b.pctRank ?? 0) - (a.pctRank ?? 0))
    .slice(0, 3)
    .forEach((c) => console.log("  " + line(c)));
  console.log("\n3 SHORT immediately below P90:");
  shortC
    .filter((c) => c.decision === "DROP_BELOW_P90")
    .sort((a, b) => (b.pctRank ?? 0) - (a.pctRank ?? 0))
    .slice(0, 3)
    .forEach((c) => console.log("  " + line(c)));

  console.log(`\n${"=".repeat(170)}`);
  console.log("RUN COMPLETED SUCCESSFULLY");

  await client.close();
}

// ================================================================
// === AUDIT SCAN END === only source code BETWEEN "AUDIT SCAN
// START" and this line is mechanically scanned for forbidden
// concepts. The forbidden-keyword list itself lives below this line
// so it cannot trigger a false positive against itself.
// ================================================================

function runSourceAudit() {
  const src = fs.readFileSync(__filename, "utf8");
  const startIdx = src.indexOf("=== AUDIT SCAN START ===");
  const endIdx = src.indexOf("=== AUDIT SCAN END ===");
  const scanned = src.slice(startIdx, endIdx).toLowerCase();
  const forbidden = [
    ["Page-Hinkley", "page-hinkley"],
    ["OLS", "ols"],
    ["regression", "regression"],
    ["residual", "residual"],
    ["residual STD", "residual std"],
    ["0.5 x STD", "0.5 * "],
    ["3 x STD", "3 * stddev"],
    ["60-second OI block scale", "oiblockscale"],
    ["±8-second tolerance", "8000"],
    ["magnitude-cut segmentation", "magnitude-cut"],
    ["minimum segment count", "min.{0,3}segment"],
    ["5-segment confirmation", "confirmation_window"],
    ["2-segment dedupe", "dedupe"],
    ["PH candidate logic", "recoverycandidate"],
    ["structural-change statistics", "structural"],
    ["3-hour cap", "3 \\* 3600"],
    ["ATR", "atr"],
    ["price-recovery threshold", "pricerecovery"],
    ["adaptive OI threshold", "adaptivethreshold"],
    ["kNN", "knn"],
    ["sequential t-test", "t-test"],
    ["raw-tick statistical detector", "rawtickdetector"],
    ["empirical gap clustering", "gapthreshold"],
    ["biggest proportional gap", "biggest.{0,3}jump"],
  ];
  console.log("=".repeat(170));
  console.log(
    "MANDATORY SOURCE-CODE AUDIT (mechanical scan of this file, business-logic section only)",
  );
  console.log("=".repeat(170));
  let anyFound = false;
  for (const [label, pattern] of forbidden) {
    const re = new RegExp(pattern, "i");
    const found = re.test(scanned);
    console.log(`${label}: ${found ? "FOUND -- STOP" : "NOT PRESENT"}`);
    if (found) anyFound = true;
  }
  return anyFound;
}

const audit = runSourceAudit();
if (audit) {
  console.log(
    "\nFORBIDDEN CONCEPT DETECTED IN SOURCE. STOPPING. Experiment NOT run.",
  );
  process.exit(1);
}
console.log("\nAll checks NOT PRESENT. Proceeding.\n");

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
