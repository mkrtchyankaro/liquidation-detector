// BTC FAST LIQUIDATION DETECTOR -- new, isolated research experiment.
// Philosophy: we do NOT need every liquidation. Many watches DROP
// (timeout). That is the expected, acceptable outcome. We are testing
// whether a FAST OI<->Price regime-break signal exists at all.
//
//   node scripts/btc-fast-liquidation-detector.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;

// ============================================================
// FAST-TRADING POLICY (deliberate operational choice, NOT a market threshold)
// ============================================================
const MAX_WATCH_TIME_MS = 10 * 60 * 1000; // "if it doesn't reveal itself fast, we drop it"

// ============================================================
// NUMERICAL / COMPUTATIONAL parameters (smoothing / sample-size needs,
// not market magnitudes)
// ============================================================
const WARM_START_WINDOW_MS = 30 * 60 * 1000; // how much pre-START context to pool for the k-NN model's cold start
const K_NEIGHBORS = 5; // k-NN neighbor count for the magnitude-aware expected-response model
const MIN_SAMPLE_FOR_TEST = 5; // minimum episode-local residual samples before the sequential t-test can be computed at all

// ============================================================
// STATISTICAL CONFIDENCE parameter (probability-space, not market units)
// ============================================================
const Z_CRITICAL_95_ONE_SIDED = 1.645; // one-sided 95% confidence cutoff for the running t-statistic

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
    : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(5)}%`;
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
function median(arr) {
  return percentile(
    [...arr].sort((a, b) => a - b),
    50,
  );
}
function stddev(arr) {
  const m = mean(arr);
  return arr.length
    ? Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length)
    : null;
}
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}

function priceAtOrBeforeIdx(obs, idx) {
  for (let k = idx; k >= 0; k--) {
    if (obs[k].price !== null) return obs[k].price;
  }
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

/** k-NN magnitude-aware expected response. Prefers episode-local
 *  same-sign neighbors; falls back to warm-start pool only to fill
 *  remaining slots -- "progressively dominates" as the episode grows. */
function predictExpected(episodePool, warmPool, deltaOi) {
  const sign = deltaOi >= 0 ? 1 : -1;
  const epSameSign = episodePool.filter(
    (p) => (p.deltaOi >= 0 ? 1 : -1) === sign,
  );
  let candidates;
  if (epSameSign.length >= K_NEIGHBORS) {
    candidates = epSameSign;
  } else {
    const warmSameSign = warmPool.filter(
      (p) => (p.deltaOi >= 0 ? 1 : -1) === sign,
    );
    candidates = [...epSameSign, ...warmSameSign];
  }
  if (candidates.length < K_NEIGHBORS) return null;
  const nearest = [...candidates]
    .sort(
      (a, b) => Math.abs(a.deltaOi - deltaOi) - Math.abs(b.deltaOi - deltaOi),
    )
    .slice(0, K_NEIGHBORS);
  return mean(nearest.map((p) => p.actualLogRet));
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  // ============================================================
  // FAST DETECTOR DESIGN
  // ============================================================
  console.log("=".repeat(170));
  console.log("FAST DETECTOR DESIGN");
  console.log("=".repeat(170));
  console.log(`
START:
  While IDLE, the next chronological BTC liquidation event starts WATCH.
  The starting event's side freezes the ORIGINAL PRESSURE direction only
  (LONG->adverse=DOWN, SHORT->adverse=UP). After START, liquidation side is
  NEVER used again -- all subsequent liquidation events (either side) are
  absorbed as CONTEXT only into the same active WATCH, with no re-splitting.

OBSERVATION UNIT:
  RAW consecutive oi_second_observations ticks (~1s cadence, the natural
  stored cadence -- no magnitude-cut segmentation, no fixed 60s horizon).
  Each consecutive pair (tick i-1 -> tick i) forms ONE ΔOI observation:
    ΔOI      = contracts[i] - contracts[i-1]
    ΔPRICE   = ln(price_at_or_before[i] / price_at_or_before[i-1])  (log return, causal price alignment)
  Ticks with ΔOI == 0 carry no magnitude information and are skipped (not
  counted as an observation, not fed to the model).

LIQUIDATION MAGNITUDE:
  Tallied as context only (total/LONG/SHORT USD, event count) across the
  whole active WATCH. NEVER used to trigger FINISHED or DROP.

OI->PRICE RELATIONSHIP MODEL:
  Simplest magnitude-aware, non-linear-assuming model: k-NEAREST-NEIGHBOR
  by |ΔOI| magnitude, same sign, k=${K_NEIGHBORS}. Two pools are maintained:
    WARM POOL:    raw ticks from the ${WARM_START_WINDOW_MS / 60000}min BEFORE this WATCH's own START
                  (causal -- only pre-START history, gives the model
                  something to predict from at the very beginning).
    EPISODE POOL: raw ticks observed SINCE this WATCH's own START.
  A prediction for the current ΔOI uses EPISODE POOL neighbors if there are
  already >= ${K_NEIGHBORS} same-sign episode-local ticks (episode-local data
  fully dominates); otherwise episode-local ticks are combined with
  warm-pool ticks to reach k. This implements "progressively dominates".
  If fewer than ${K_NEIGHBORS} same-sign candidates exist even combined, no
  prediction is made yet (remain WATCHING, no fabricated certainty).

INCOMPATIBILITY / FINISHED:
  For each tick with a valid prediction: residual = actual - expected.
  recoveryResidual = direction-adjusted residual (positive = price moving
  in the RECOVERY direction relative to what this watch's own learned
  relationship predicted).
  A running SEQUENTIAL ONE-SAMPLE T-TEST is computed causally over all
  episode-local recoveryResidual values seen so far (H0: mean=0, H1: mean>0):
    t = mean(recoveryResidual) / (stddev(recoveryResidual) / sqrt(n))
  Computed only once n >= ${MIN_SAMPLE_FOR_TEST}. FINISHED fires the FIRST
  time t exceeds the ${Z_CRITICAL_95_ONE_SIDED} one-sided 95%-confidence
  critical value -- i.e., "the cumulative recovery-direction deviation from
  this watch's own learned relationship is no longer plausible under the
  hypothesis that the original relationship still holds, at 95% confidence."
  This uses NO fixed price/OI/time magnitude anywhere.

DROP_TIMEOUT:
  If ${MAX_WATCH_TIME_MS / 60000} minutes elapse from START with no FINISHED,
  output DROP_TIMEOUT and return to IDLE. This is NOT a market claim -- it
  only means this setup did not reveal the fast phenomenon we're testing for.
`);

  // ============================================================
  // ALL REMAINING PARAMETERS
  // ============================================================
  console.log("=".repeat(170));
  console.log("ALL REMAINING PARAMETERS");
  console.log("=".repeat(170));
  const params = [
    {
      name: "MAX_WATCH_TIME",
      value: "10 minutes",
      purpose:
        "Deliberate research/trading-policy time budget for a FAST setup",
      category: "FAST-TRADING POLICY",
    },
    {
      name: "WARM_START_WINDOW",
      value: "30 minutes",
      purpose:
        "How much pre-START tick history to pool for the model's cold start",
      category: "NUMERICAL/COMPUTATIONAL",
    },
    {
      name: "K_NEIGHBORS",
      value: "5",
      purpose:
        "k-NN neighbor count for the magnitude-aware expected-response model",
      category: "NUMERICAL/COMPUTATIONAL",
    },
    {
      name: "MIN_SAMPLE_FOR_TEST",
      value: "5",
      purpose:
        "Minimum episode-local residual samples before the t-test is computed at all (cannot compute stddev meaningfully below this)",
      category: "NUMERICAL/COMPUTATIONAL",
    },
    {
      name: "Z_CRITICAL_95_ONE_SIDED",
      value: "1.645",
      purpose:
        "One-sided 95%-confidence critical value for the sequential t-test that triggers FINISHED",
      category: "STATISTICAL CONFIDENCE",
    },
    {
      name: "DAYS_BACK",
      value: "3 days",
      purpose: "Historical data range used for this run",
      category: "DATA AVAILABILITY",
    },
    {
      name: "OI-at-START availability",
      value: "must find an OI observation at-or-before START",
      purpose:
        "A liquidation event with no nearby OI data cannot start a WATCH",
      category: "DATA AVAILABILITY",
    },
  ];
  console.log("NAME | VALUE | PURPOSE | CATEGORY");
  console.log("-".repeat(170));
  params.forEach((p) =>
    console.log(`${p.name} | ${p.value} | ${p.purpose} | ${p.category}`),
  );
  const marketThresholds = params.filter(
    (p) => p.category === "MARKET THRESHOLD",
  );
  console.log(
    `\nHARD-CODED MARKET THRESHOLDS IN THIS PARAMETER LIST: ${marketThresholds.length}`,
  );

  // ============================================================
  // RUN THE EXPERIMENT
  // ============================================================
  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - DAYS_BACK * 86_400_000;

  const allLiq = await liqCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allOiRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(rangeStartMs - WARM_START_WINDOW_MS - 60000),
        $lte: new Date(rangeEndMs + MAX_WATCH_TIME_MS),
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

  console.log(`\n${"=".repeat(170)}`);
  console.log("RUNNING EXPERIMENT");
  console.log("=".repeat(170));
  console.log(`RAW BTC LIQUIDATION EVENTS: ${allLiq.length}`);
  console.log(`OI+price observations loaded: ${allOi.length}`);

  if (allLiq.length === 0 || allOi.length < 50) {
    console.log("Insufficient data -- cannot proceed.");
    await client.close();
    return;
  }

  const watches = [];
  let liqIdx = 0;
  let invalidCount = 0;

  while (liqIdx < allLiq.length) {
    const startEvent = allLiq[liqIdx];
    const direction = startEvent.victim;
    const adverseDir = direction === "LONG" ? "down" : "up";
    const startTs = startEvent.timestamp;

    const startIdx = nearestObsIdxAtOrBefore(allOi, startTs);
    if (startIdx < 0) {
      invalidCount++;
      liqIdx++;
      continue;
    }

    // Build warm-start pool from raw ticks BEFORE startTs.
    const warmPool = [];
    for (let k = 1; k < allOi.length; k++) {
      if (allOi[k].ts >= startTs) break;
      if (allOi[k].ts < startTs - WARM_START_WINDOW_MS) continue;
      const d = allOi[k].contracts - allOi[k - 1].contracts;
      if (d === 0) continue;
      const p0 = priceAtOrBeforeIdx(allOi, k - 1),
        p1 = priceAtOrBeforeIdx(allOi, k);
      if (p0 === null || p1 === null) continue;
      warmPool.push({ deltaOi: d, actualLogRet: Math.log(p1 / p0) });
    }

    const episodePool = [];
    const episodeResiduals = [];
    const watchEndCapTs = startTs + MAX_WATCH_TIME_MS;

    let result = "DROP_TIMEOUT";
    let resolutionTs = watchEndCapTs;
    let decisionExpected = null,
      decisionActual = null,
      decisionResidual = null;
    const traceRows = [];

    for (let k = startIdx + 1; k < allOi.length; k++) {
      if (allOi[k].ts > watchEndCapTs) break;
      const d = allOi[k].contracts - allOi[k - 1].contracts;
      if (d === 0) continue;
      const p0 = priceAtOrBeforeIdx(allOi, k - 1),
        p1 = priceAtOrBeforeIdx(allOi, k);
      if (p0 === null || p1 === null) continue;
      const actualLogRet = Math.log(p1 / p0);

      const expected = predictExpected(episodePool, warmPool, d);
      let tStat = null,
        pVal = null,
        recoveryR = null;
      if (expected !== null) {
        const residual = actualLogRet - expected;
        recoveryR = adverseDir === "down" ? residual : -residual;
        episodeResiduals.push(recoveryR);
        if (episodeResiduals.length >= MIN_SAMPLE_FOR_TEST) {
          const m = mean(episodeResiduals),
            sd = stddev(episodeResiduals);
          tStat = sd > 0 ? m / (sd / Math.sqrt(episodeResiduals.length)) : null;
          pVal = tStat !== null ? 1 - normalCdf(tStat) : null;
        }
        traceRows.push({
          ts: allOi[k].ts,
          deltaOi: d,
          actualLogRet,
          expected,
          residual,
          tStat,
          pVal,
        });
        if (traceRows.length > 12) traceRows.shift();

        if (tStat !== null && tStat > Z_CRITICAL_95_ONE_SIDED) {
          result = "FINISHED";
          resolutionTs = allOi[k].ts;
          decisionExpected = expected;
          decisionActual = actualLogRet;
          decisionResidual = residual;
          episodePool.push({ deltaOi: d, actualLogRet });
          break;
        }
      }
      episodePool.push({ deltaOi: d, actualLogRet });
    }

    const startPrice = priceAtOrBeforeIdx(allOi, startIdx);
    const resolutionIdx = nearestObsIdxAtOrBefore(
      allOi,
      resolutionTs,
      startIdx,
    );
    const resolutionPrice =
      resolutionIdx >= 0 ? priceAtOrBeforeIdx(allOi, resolutionIdx) : null;
    const oiAtStart = allOi[startIdx].contracts;
    const oiAtResolution =
      resolutionIdx >= 0 ? allOi[resolutionIdx].contracts : null;
    const posOi = episodePool
      .filter((p) => p.deltaOi > 0)
      .reduce((a, p) => a + p.deltaOi, 0);
    const negOi = episodePool
      .filter((p) => p.deltaOi < 0)
      .reduce((a, p) => a + p.deltaOi, 0);

    // Absorb liquidation events (any side) up to resolutionTs.
    const watchEvents = [];
    while (liqIdx < allLiq.length && allLiq[liqIdx].timestamp <= resolutionTs) {
      watchEvents.push(allLiq[liqIdx]);
      liqIdx++;
    }
    if (watchEvents.length === 0) {
      liqIdx++;
    } // safety

    watches.push({
      direction,
      adverseDir,
      startTs,
      result,
      resolutionTs: result === "FINISHED" ? resolutionTs : null,
      startPrice,
      resolutionPrice,
      oiAtStart,
      oiAtResolution,
      netOi: oiAtResolution !== null ? oiAtResolution - oiAtStart : null,
      posOi,
      negOi,
      grossOi: posOi - negOi,
      totalLiqUsd: watchEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      longLiqUsd: watchEvents
        .filter((e) => e.victim === "LONG")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      shortLiqUsd: watchEvents
        .filter((e) => e.victim === "SHORT")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      eventCount: watchEvents.length,
      observationCount: episodePool.length,
      decisionExpected,
      decisionActual,
      decisionResidual,
      traceRows,
    });
  }

  // ============================================================
  // AGGREGATE SUMMARY
  // ============================================================
  const finished = watches.filter((w) => w.result === "FINISHED");
  const dropped = watches.filter((w) => w.result === "DROP_TIMEOUT");
  const durations = finished
    .map((w) => w.resolutionTs - w.startTs)
    .sort((a, b) => a - b);

  console.log(`\nWATCHES STARTED: ${watches.length}`);
  console.log(`FINISHED: ${finished.length}`);
  console.log(`DROP_TIMEOUT: ${dropped.length}`);
  console.log(`OTHER DROPS/INVALID DATA: ${invalidCount}`);
  console.log(
    `FINISHED RATE: ${watches.length > 0 ? ((finished.length / watches.length) * 100).toFixed(1) : "N/A"}%`,
  );
  console.log(
    `MEDIAN TIME TO FINISHED: ${durations.length ? (median(durations) / 60000).toFixed(2) + "min" : "N/A"}`,
  );
  console.log(
    `P25/P75 TIME TO FINISHED: ${durations.length ? (percentile(durations, 25) / 60000).toFixed(2) + "min / " + (percentile(durations, 75) / 60000).toFixed(2) + "min" : "N/A"}`,
  );
  console.log(
    `MIN/MAX TIME TO FINISHED: ${durations.length ? (durations[0] / 60000).toFixed(2) + "min / " + (durations[durations.length - 1] / 60000).toFixed(2) + "min" : "N/A"}`,
  );

  // ============================================================
  // EVERY WATCH, CHRONOLOGICALLY
  // ============================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log("EVERY WATCH, CHRONOLOGICALLY");
  console.log("=".repeat(170));
  watches.forEach((w, idx) => {
    console.log(`\nWATCH ${String(idx + 1).padStart(3, "0")}`);
    console.log(`    Starting direction: ${w.direction}`);
    console.log(`    START UTC: ${fmtDate(w.startTs)}`);
    console.log(`    RESULT: ${w.result}`);
    console.log(
      `    FINISHED UTC: ${w.resolutionTs !== null ? fmtDate(w.resolutionTs) : "N/A"}`,
    );
    console.log(
      `    Duration: ${((w.resolutionTs ?? w.startTs + MAX_WATCH_TIME_MS) - w.startTs) / 60000}min`,
    );
    console.log(`    Start price: ${fmtPrice(w.startPrice)}`);
    console.log(`    Finish/drop price: ${fmtPrice(w.resolutionPrice)}`);
    console.log(
      `    Total liquidation USD during watch: ${fmtUsd(w.totalLiqUsd)}`,
    );
    console.log(`    LONG liquidation USD: ${fmtUsd(w.longLiqUsd)}`);
    console.log(`    SHORT liquidation USD: ${fmtUsd(w.shortLiqUsd)}`);
    console.log(`    Event count: ${w.eventCount}`);
    console.log(`    OI at start: ${fmtBtc(w.oiAtStart)}`);
    console.log(`    OI at finish/drop: ${fmtBtc(w.oiAtResolution)}`);
    console.log(`    Net ΔOI: ${fmtBtcDelta(w.netOi)}`);
    console.log(`    Positive ΔOI: ${fmtBtcDelta(w.posOi)}`);
    console.log(`    Negative ΔOI: ${fmtBtcDelta(w.negOi)}`);
    console.log(`    Gross Σ|ΔOI|: ${fmtBtc(w.grossOi)}`);
    console.log(
      `    Price net move: ${w.startPrice && w.resolutionPrice ? fmtLogPct(Math.log(w.resolutionPrice / w.startPrice)) : "N/A"}`,
    );
    console.log(`    Number of OI->Price observations: ${w.observationCount}`);
    console.log(
      `    Learned expected response at decision: ${w.decisionExpected !== null ? fmtLogPct(w.decisionExpected) : "N/A"}`,
    );
    console.log(
      `    Actual response at decision: ${w.decisionActual !== null ? fmtLogPct(w.decisionActual) : "N/A"}`,
    );
    console.log(
      `    Deviation/surprise at decision: ${w.decisionResidual !== null ? fmtLogPct(w.decisionResidual) : "N/A"}`,
    );
    const explanation =
      w.result === "FINISHED"
        ? `The cumulative recovery-direction residual t-statistic exceeded the ${Z_CRITICAL_95_ONE_SIDED} (95% one-sided) critical value after ${w.observationCount} observations, indicating the price response was no longer statistically compatible with this watch's own learned ${w.direction}-liquidation OI->price relationship.`
        : `${MAX_WATCH_TIME_MS / 60000} minutes elapsed without the recovery-direction t-statistic ever exceeding ${Z_CRITICAL_95_ONE_SIDED}; this setup did not reveal a fast, statistically detectable regime break.`;
    console.log(`    Explanation: ${explanation}`);
  });

  // ============================================================
  // DIAGNOSTIC TRACE for FINISHED watches
  // ============================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "DIAGNOSTIC: FINAL OBSERVATIONS BEFORE DETECTION (FINISHED watches only)",
  );
  console.log("=".repeat(170));
  finished.forEach((w, idx) => {
    console.log(`\nWATCH (FINISHED) -- START ${fmtDate(w.startTs)}`);
    console.log(
      "TIMESTAMP             | ΔOI       | expected  | actual    | residual  | t-stat  | p-value | STATE",
    );
    w.traceRows.forEach((t, i) => {
      const isLast = i === w.traceRows.length - 1;
      console.log(
        `${isoUtc(t.ts)} | ${fmtBtcDelta(t.deltaOi).padEnd(9)} | ${fmtLogPct(t.expected).padEnd(9)} | ${fmtLogPct(t.actualLogRet).padEnd(9)} | ${fmtLogPct(t.residual).padEnd(9)} | ${(t.tStat !== null ? t.tStat.toFixed(3) : "N/A").padEnd(7)} | ${(t.pVal !== null ? t.pVal.toFixed(4) : "N/A").padEnd(7)} | ${isLast ? "FINISHED" : "WATCHING"}`,
      );
    });
  });

  console.log(`\n${"=".repeat(170)}`);
  console.log("DROP_TIMEOUT WATCHES -- compact summary");
  console.log("=".repeat(170));
  dropped.forEach((w) =>
    console.log(
      `${fmtDate(w.startTs)}  ${w.direction}  observations=${w.observationCount}  totalLiq=${fmtUsd(w.totalLiqUsd)}`,
    ),
  );

  // ============================================================
  // FINAL SUMMARY
  // ============================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log("FINAL SUMMARY");
  console.log("=".repeat(170));
  console.log(
    `HARD-CODED MARKET THRESHOLDS REMAINING: ${marketThresholds.length}`,
  );
  if (marketThresholds.length > 0)
    marketThresholds.forEach((p) => console.log(`  - ${p.name} = ${p.value}`));
  console.log(`\nFAST-TRADING POLICY PARAMETERS:`);
  console.log(`  MAX_WATCH_TIME = 10 minutes`);
  console.log(`\nRUN COMPLETED SUCCESSFULLY`);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
