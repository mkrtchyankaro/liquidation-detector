// BTC LEARNED |ΔOI|->|ΔPrice| FUNCTION -- PROOF ONLY, no END detector.
// Fixed 10-minute baseline (START, liquidation aggregation, P90)
// REUSED VERBATIM, untouched. This script does ONLY ONE thing: fit
// Theil-Sen on adverse-direction (|ΔOI|, signed ΔPrice) pairs from
// [START, fixed-END], then evaluate that fixed function f(X) on
// several NEW observations (movements occurring AFTER fixed-END,
// never used in training) -- printing X, f(X), the signed
// continuation target, the actual signed response, and the signed
// reversal target. NO searching for a matching X. NO accumulation.
// NO crossing logic. NO END decision of any kind.
//
//   node scripts/btc-learned-function-proof.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EVAL_DAYS = 3;
const BASELINE_DAYS = 3;
const WINDOW_MS = 10 * 60 * 1000;
const MIN_LIVE_SAMPLE = 5;
const NEW_OBS_SEARCH_CAP_MIN = 60; // disclosed bound only, purely to gather "several new observations" to print -- not a decision window

function fmtDate(ms) {
  return ms === null || ms === undefined
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
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(5)}%`;
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

function theilSen(points) {
  if (points.length < 2) return null;
  const slopes = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (dx === 0) continue;
      slopes.push((points[j].y - points[i].y) / dx);
    }
  if (slopes.length === 0) return null;
  slopes.sort((a, b) => a - b);
  const slope = percentile(slopes, 50);
  const intercepts = points.map((p) => p.y - slope * p.x).sort((a, b) => a - b);
  const intercept = percentile(intercepts, 50);
  return { slope, intercept };
}

/** Same movement primitive established earlier: maximal same-sign-ΔOI
 *  run, own-price-field only (never backfilled). */
function buildMovements(allOi, fromIdx, capIdx) {
  const movements = [];
  let runStartIdx = null,
    runSign = null,
    runOiSum = 0;
  function closeRun(endIdx) {
    if (runStartIdx === null) return;
    const p0 = allOi[runStartIdx].price,
      p1 = allOi[endIdx].price;
    if (p0 !== null && p1 !== null) {
      const dPriceLog = Math.log(p1 / p0) * 100;
      movements.push({
        startTs: allOi[runStartIdx].ts,
        endTs: allOi[endIdx].ts,
        absOi: Math.abs(runOiSum),
        dPriceLog,
      });
    }
    runStartIdx = null;
    runSign = null;
    runOiSum = 0;
  }
  for (let k = fromIdx + 1; k <= capIdx; k++) {
    const dOi = allOi[k].contracts - allOi[k - 1].contracts;
    if (dOi === 0) continue;
    const sign = dOi > 0 ? 1 : -1;
    if (runSign === null) {
      runStartIdx = k - 1;
      runSign = sign;
      runOiSum = dOi;
      continue;
    }
    if (sign === runSign) {
      runOiSum += dOi;
      continue;
    }
    closeRun(k - 1);
    runStartIdx = k - 1;
    runSign = sign;
    runOiSum = dOi;
  }
  if (runStartIdx !== null) closeRun(capIdx);
  return movements;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(170));
  console.log(
    "FIXED 10-MINUTE BASELINE UNCHANGED. This script proves ONLY the learned |ΔOI|->|ΔPrice| function. NO END detector. NO full dataset run.",
  );
  console.log("=".repeat(170));

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + NEW_OBS_SEARCH_CAP_MIN * 60_000;

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
        $lte: new Date(loadEndMs),
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
  console.log(
    `DATASET: raw liquidation events=${allLiq.length}  OI+price observations=${allOi.length}`,
  );
  if (allLiq.length === 0 || allOi.length < 10) {
    console.log("Insufficient data.");
    await client.close();
    return;
  }

  // ---- FIXED 10-MINUTE BASELINE (verbatim, untouched) ----
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
      priceEnd = null;
    if (startIdx >= 0 && endIdx >= 0 && endIdx >= startIdx) {
      priceStart = priceAtOrBeforeIdx(allOi, startIdx);
      priceEnd = priceAtOrBeforeIdx(allOi, endIdx);
    }
    const dirLiqUsd = events
      .filter((e) => e.victim === direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    candidates.push({
      direction,
      startTs,
      endTs,
      dirLiqUsd,
      eventCount: events.length,
      priceStart,
      priceEnd,
      startIdx,
      endIdx,
    });
  }

  console.log(
    `${"=".repeat(170)}\nSTRICT BASELINE SELF-VERIFICATION\n${"=".repeat(170)}`,
  );
  const knownChecks = [
    {
      label: "EP31 (02:24:27->02:34:27 LONG)",
      startTs: Date.parse("2026-09-20T02:24:27Z"),
      endTs: Date.parse("2026-09-20T02:34:27Z"),
      direction: "LONG",
      expectedUsd: 933038.8,
    },
    {
      label: "EP32 (02:35:59->02:45:59 LONG)",
      startTs: Date.parse("2026-09-20T02:35:59Z"),
      endTs: Date.parse("2026-09-20T02:45:59Z"),
      direction: "LONG",
      expectedUsd: 1138305.8,
    },
    {
      label: "EP33 (03:08:05->03:18:05 LONG)",
      startTs: Date.parse("2026-09-20T03:08:05Z"),
      endTs: Date.parse("2026-09-20T03:18:05Z"),
      direction: "LONG",
      expectedUsd: 557426.62,
    },
  ];
  let verificationFailed = false;
  for (const chk of knownChecks) {
    const match = candidates.find(
      (c) =>
        c.direction === chk.direction &&
        Math.abs(c.startTs - chk.startTs) < 2000 &&
        Math.abs(c.endTs - chk.endTs) < 2000,
    );
    if (!match) {
      console.log(`${chk.label}: NOT FOUND -- FAIL`);
      verificationFailed = true;
      continue;
    }
    const diff = Math.abs(match.dirLiqUsd - chk.expectedUsd);
    const ok = diff < 500;
    console.log(
      `${chk.label}: found dirLiqUsd=${fmtUsd(match.dirLiqUsd)} expected=${fmtUsd(chk.expectedUsd)} ${ok ? "PASS" : "FAIL"}`,
    );
    if (!ok) verificationFailed = true;
  }
  if (verificationFailed) {
    console.log("\nBASELINE VERIFICATION FAILED. STOPPING.");
    await client.close();
    return;
  }
  console.log("\nBaseline verification PASSED.\n");

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
      c.liveEvaluable = c.endTs >= evalStartMs;
      if (prior.length < MIN_LIVE_SAMPLE) {
        c.decision = null;
        return;
      }
      const vals = prior.map((p) => p.dirLiqUsd).sort((a, b) => a - b);
      c.causalP90 = percentile(vals, 90);
      c.decision = c.dirLiqUsd >= c.causalP90 ? "KEEP_P90" : "DROP_BELOW_P90";
    });
  }
  applyRolling(longC);
  applyRolling(shortC);
  const p90Candidates = [...longC, ...shortC]
    .filter(
      (c) =>
        c.liveEvaluable && c.decision === "KEEP_P90" && c.priceStart !== null,
    )
    .sort((a, b) => a.startTs - b.startTs);
  console.log(
    `KEEP_P90 candidates (baseline unchanged): ${p90Candidates.length}\n`,
  );

  // ============================================================
  // 3 REQUESTED TRACES -- learned function only
  // ============================================================
  console.log(
    `${"=".repeat(200)}\nLEARNED FUNCTION PROOF -- 3 REQUESTED CANDIDATES\n${"=".repeat(200)}`,
  );
  const traceTargets = [
    Date.parse("2026-09-20T02:24:27Z"),
    Date.parse("2026-09-20T02:35:59Z"),
    Date.parse("2026-09-20T03:08:05Z"),
  ];
  for (const ts of traceTargets) {
    const c = p90Candidates.find((x) => Math.abs(x.startTs - ts) < 2000);
    if (!c) {
      console.log(`\nSTART=${fmtDate(ts)}: NOT in KEEP_P90 set.`);
      continue;
    }
    const adverseDir = c.direction === "LONG" ? "down" : "up";

    // TRAINING: adverse movements within [START, fixed-END] only.
    const trainMovements = buildMovements(allOi, c.startIdx, c.endIdx).filter(
      (mv) => (adverseDir === "down" ? mv.dPriceLog < 0 : mv.dPriceLog > 0),
    );
    const trainPoints = trainMovements.map((mv) => ({
      x: mv.absOi,
      y: Math.abs(mv.dPriceLog),
    }));
    const model = theilSen(trainPoints);

    console.log(`\n${"#".repeat(80)}`);
    console.log(
      `${c.direction}  START=${fmtDate(c.startTs)}  fixed-10m END=${fmtDate(c.endTs)}  dirLiq(ref)=${fmtUsd(c.dirLiqUsd)}`,
    );
    console.log(
      `\n1. ALL ADVERSE TRAINING PAIRS (|ΔOI| -> signed ΔPrice), N=${trainMovements.length}:`,
    );
    trainMovements.forEach((mv) =>
      console.log(
        `   ${fmtBtc(mv.absOi)} BTC -> ${fmtPct(mv.dPriceLog)}   (${fmtDate(mv.startTs)} -> ${fmtDate(mv.endTs)})`,
      ),
    );

    console.log(`\n2. LEARNED MODEL:`);
    if (!model) {
      console.log(
        "   Insufficient training pairs (fewer than 2) -- no function learned.",
      );
      continue;
    }
    console.log(
      `   f(X) = ${model.slope.toFixed(6)} * X + ${model.intercept.toFixed(6)}   (Theil-Sen, magnitude only, |ΔOI| -> |ΔPrice|)`,
    );

    // NEW OBSERVATIONS: movements AFTER fixed-END, never used in training.
    const capTs = c.endTs + NEW_OBS_SEARCH_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, c.endIdx);
    const newMovements = buildMovements(allOi, c.endIdx, capIdx);

    console.log(
      `\n3. SEVERAL NEW OBSERVATIONS (movements after fixed-END, NOT used in training), N=${newMovements.length}:`,
    );
    newMovements.forEach((mv, idx) => {
      const X = mv.absOi;
      const Yexp = Math.max(0, model.slope * X + model.intercept);
      const continuationTarget = adverseDir === "down" ? -Yexp : Yexp;
      const reversalTarget = -continuationTarget;
      console.log(
        `\n   New observation #${idx + 1}: ${fmtDate(mv.startTs)} -> ${fmtDate(mv.endTs)}`,
      );
      console.log(`     current |ΔOI| = X = ${fmtBtc(X)} BTC`);
      console.log(`     model prediction f(X) = Y_expected = ${fmtPct(Yexp)}`);
      console.log(
        `     expected adverse (continuation) response = ${fmtPct(continuationTarget)}`,
      );
      console.log(
        `     actual signed price response = ${fmtPct(mv.dPriceLog)}`,
      );
      console.log(`     opposite/reversal target = ${fmtPct(reversalTarget)}`);
    });
  }

  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "Per instruction: this is the function-learning proof ONLY. No END detector implemented. Full dataset NOT run.",
  );
  console.log("=".repeat(170));

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
