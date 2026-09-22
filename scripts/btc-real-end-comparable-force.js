// BTC REAL-END DISCOVERY (COMPARABLE OI FORCE) -- new, standalone.
// The FIXED 10-minute liquidation baseline (candidate construction,
// START, liquidation aggregation, P90 qualification, one-active-
// candidate behavior) is REUSED VERBATIM, completely untouched. This
// script adds a SEPARATE, post-qualification REAL-END discovery layer
// -- it does NOT create new episodes, does NOT split the 10-minute
// candidate, does NOT touch P90.
//
// ============================================================
// FIX vs the prior (rejected) implementation: "COMPARABLE OI FORCE"
//
//  The earlier version could trigger on a tiny favorable movement
//  (e.g. |ΔOI|=1 BTC) whose tiny model-predicted expected|ΔPrice| was
//  trivially exceeded by an equally tiny actual move (+0.003%),
//  nowhere near the LEARNED SCALE (e.g. "100 BTC -> -0.13%"). That is
//  extrapolating the model far below the range it was actually
//  trained on.
//
//  FIX: a favorable movement can only trigger REAL END if its OWN
//  |ΔOI| is AT LEAST as large as the SMALLEST |ΔOI| among the
//  adverse-direction movements used to train the current model so
//  far (a zero-parameter "in-range" check -- not a new threshold,
//  just refusing to extrapolate below the model's own training
//  range). This directly enforces "comparable OI force", exactly as
//  specified.
//
// MODEL (movement-based, unchanged in spirit from before):
//  MOVEMENT = maximal same-sign-ΔOI run (zero-threshold). Training
//  set = ONLY adverse-direction movements' (|ΔOI|,|ΔPrice|), causal.
//  Theil-Sen: magnitude only, direction tracked separately.
//  REAL END = first favorable movement where BOTH:
//    (a) movement.absOi >= min(training absOi so far)   [comparable force]
//    (b) actual|ΔPrice| >= expected|ΔPrice| from the model, expected>0
//
//  Search runs from candidate START, continuously, NOT bounded by the
//  fixed 10-minute END (that boundary remains only the qualification/
//  P90 anchor). A disclosed 3-hour research safety cap bounds the
//  search computationally only.
//
//   node scripts/btc-real-end-comparable-force.js
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
const SEARCH_CAP_MIN = 180; // disclosed computational safety bound only

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
function fmtSec(ms) {
  return ms === null ? "N/A" : `${(ms / 1000).toFixed(1)}s`;
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
  const s = [...arr]
    .filter((v) => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  return percentile(s, 50);
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
        startIdx: runStartIdx,
        endIdx,
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

/** Runs the movement-based causal search for REAL END, returning the
 *  full evolving trace (for the manual-trace print) plus the result. */
function findRealEnd(allOi, startIdx, adverseDir, searchCapIdx) {
  const movements = buildMovements(allOi, startIdx, searchCapIdx);
  let trainPoints = [];
  const trace = [];
  let result = null;
  for (const mv of movements) {
    const isAdverse =
      adverseDir === "down" ? mv.dPriceLog < 0 : mv.dPriceLog > 0;
    const model = theilSen(trainPoints);
    let expected = null,
      inRange = null,
      magnitudeOk = null,
      isEnd = false,
      reason = "";
    if (!isAdverse) {
      if (!model) {
        reason = "no model yet (fewer than 2 adverse training points)";
      } else {
        const minTrainOi = Math.min(...trainPoints.map((p) => p.x));
        inRange = mv.absOi >= minTrainOi;
        expected = Math.max(0, model.slope * mv.absOi + model.intercept);
        magnitudeOk = expected > 0 && Math.abs(mv.dPriceLog) >= expected;
        if (!inRange)
          reason = `|ΔOI|=${mv.absOi.toFixed(3)} BTC is BELOW the training range (min trained |ΔOI|=${minTrainOi.toFixed(3)} BTC) -- not comparable force, rejected`;
        else if (!magnitudeOk)
          reason = `in-range but actual|ΔPrice|(${Math.abs(mv.dPriceLog).toFixed(5)}%) < expected(${expected.toFixed(5)}%) -- does not yet match learned magnitude`;
        else {
          reason = "MATCHED: in-range AND actual>=expected -- REAL END";
          isEnd = true;
        }
      }
    }
    trace.push({
      mv,
      isAdverse,
      model,
      minTrainOi: trainPoints.length
        ? Math.min(...trainPoints.map((p) => p.x))
        : null,
      expected,
      inRange,
      magnitudeOk,
      isEnd,
      reason,
    });
    if (isEnd) {
      result = { movement: mv, model, expected };
      break;
    }
    if (isAdverse) trainPoints.push({ x: mv.absOi, y: Math.abs(mv.dPriceLog) });
  }
  return { trace, result };
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
    "FIXED 10-MINUTE BASELINE UNCHANGED. REAL-END discovery is a SEPARATE layer applied only AFTER P90 qualification.",
  );
  console.log("=".repeat(170));

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + SEARCH_CAP_MIN * 60_000;

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
  p90Candidates.forEach((c, i) => {
    c.id = `P${String(i + 1).padStart(3, "0")}`;
  });
  console.log(
    `KEEP_P90 candidates (baseline unchanged): ${p90Candidates.length}\n`,
  );

  // ============================================================
  // MANUAL TRACE -- 3 requested candidates, FIRST
  // ============================================================
  console.log(
    `${"=".repeat(200)}\nMANUAL TRACE -- 3 REQUESTED CANDIDATES\n${"=".repeat(200)}`,
  );
  const traceTargets = [
    Date.parse("2026-09-20T02:24:27Z"),
    Date.parse("2026-09-20T02:35:59Z"),
    Date.parse("2026-09-20T03:08:05Z"),
  ];
  for (const ts of traceTargets) {
    const c = p90Candidates.find((x) => Math.abs(x.startTs - ts) < 2000);
    if (!c) {
      console.log(
        `\nSTART=${fmtDate(ts)}: NOT in KEEP_P90 set (check baseline output).`,
      );
      continue;
    }
    const adverseDir = c.direction === "LONG" ? "down" : "up";
    const capTs = c.startTs + SEARCH_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, c.startIdx);
    const { trace, result } = findRealEnd(
      allOi,
      c.startIdx,
      adverseDir,
      capIdx,
    );
    c.realEndTrace = trace;
    c.realEndResult = result;

    console.log(`\n${"#".repeat(80)}`);
    console.log(`1. START: ${fmtDate(c.startTs)}`);
    console.log(`2. Fixed-10m candidate END: ${fmtDate(c.endTs)}`);
    console.log(
      `3. Total liquidation USD (frozen direction): ${fmtUsd(c.dirLiqUsd)}`,
    );
    console.log(
      `4/5. Evolving learned OI->SIGNED-price response (adverse-direction movements only):`,
    );
    let mvNum = 0;
    trace.forEach((s) => {
      mvNum++;
      if (s.isAdverse) {
        console.log(
          `   adverse movement #${mvNum}: ${fmtDate(s.mv.startTs)}->${fmtDate(s.mv.endTs)}  |ΔOI|=${fmtBtc(s.mv.absOi)}  ΔPrice=${fmtPct(s.mv.dPriceLog)}  [added to training]`,
        );
      } else {
        console.log(
          `   6/7/8/9. FAVORABLE candidate #${mvNum}: ${fmtDate(s.mv.startTs)}->${fmtDate(s.mv.endTs)}  |ΔOI|(comparable force)=${fmtBtc(s.mv.absOi)}  actual ΔPrice=${fmtPct(s.mv.dPriceLog)}`,
        );
        console.log(
          `        learned model at this point: ${s.model ? `slope=${s.model.slope.toFixed(6)} intercept=${s.model.intercept.toFixed(6)}  min trained |ΔOI|=${s.minTrainOi?.toFixed(3)} BTC` : "no model yet"}`,
        );
        console.log(
          `        expected|ΔPrice| for this |ΔOI|: ${s.expected !== null ? fmtPct(s.expected) : "N/A"}`,
        );
        console.log(`        REASON: ${s.reason}`);
      }
    });
    if (result) {
      console.log(
        `\n10. REAL END: ${fmtDate(result.movement.endTs)}  |ΔOI|=${fmtBtc(result.movement.absOi)}  actual=${fmtPct(result.movement.dPriceLog)}  matched expected=${fmtPct(result.expected)}`,
      );
    } else {
      console.log(
        `\n10. REAL END: not found within ${SEARCH_CAP_MIN}min search cap (UNRESOLVED).`,
      );
    }
  }

  // ============================================================
  // FULL DATASET
  // ============================================================
  console.log(
    `\n${"=".repeat(200)}\nFULL DATASET -- ALL KEEP_P90 CANDIDATES\n${"=".repeat(200)}`,
  );
  for (const c of p90Candidates) {
    if (c.realEndResult !== undefined) continue; // already traced above
    const adverseDir = c.direction === "LONG" ? "down" : "up";
    const capTs = c.startTs + SEARCH_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, c.startIdx);
    const { result } = findRealEnd(allOi, c.startIdx, adverseDir, capIdx);
    c.realEndResult = result;
  }
  p90Candidates.forEach((c) => {
    if (c.realEndResult) {
      console.log(
        `${c.id} ${c.direction} START=${fmtDate(c.startTs)}  fixedEND=${fmtDate(c.endTs)}  REAL_END=${fmtDate(c.realEndResult.movement.endTs)}  dur=${fmtSec(c.realEndResult.movement.endTs - c.startTs)}  |ΔOI|=${fmtBtc(c.realEndResult.movement.absOi)}  actual=${fmtPct(c.realEndResult.movement.dPriceLog)}  expected=${fmtPct(c.realEndResult.expected)}`,
      );
    } else {
      console.log(
        `${c.id} ${c.direction} START=${fmtDate(c.startTs)}  fixedEND=${fmtDate(c.endTs)}  REAL_END=UNRESOLVED`,
      );
    }
  });

  const resolved = p90Candidates.filter((c) => c.realEndResult);
  console.log(
    `\nSUMMARY: KEEP_P90=${p90Candidates.length}  REAL_END found=${resolved.length} (${((resolved.length / p90Candidates.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `median duration START->REAL_END: ${fmtSec(median(resolved.map((c) => c.realEndResult.movement.endTs - c.startTs)))}`,
  );

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
