// BTC MAGNITUDE-CONSISTENT REVERSAL END -- built from scratch, per
// operator's explicit instruction to discard ALL prior detector
// logic (fixed 10-minute window, post-END scan, OI-chain STOP, f_END,
// raw-tick flip, saturation). Nothing from those is reused.
//
// ============================================================
// MODEL
//
//  CANDIDATE START: while IDLE, the next liquidation event starts a
//  candidate. Direction frozen from that event (LONG->adverse=DOWN,
//  SHORT->adverse=UP). All subsequent liquidation events (either
//  side) before this candidate's END are absorbed as context.
//
//  MOVEMENT (the atomic unit -- NOT a raw tick, NOT a fixed bucket):
//  a maximal run of CONSECUTIVE raw ticks where ΔOI keeps the SAME
//  sign (zero-threshold -- any sign flip ends the run; ΔOI==0 ticks
//  are skipped, neither extending nor breaking a run). This is the
//  only zero-parameter way to "accumulate OI force and price response
//  over the same causal movement" without inventing a fixed window.
//  A movement's |ΔOI| = the summed OI change over the run (all same
//  sign). Its ΔPrice = price at the run's last tick minus price at
//  the run's first tick, using ONLY each observation's OWN price
//  field (never backfilled -- the same fix already established for
//  this research thread).
//
//  CAUSAL MAGNITUDE MODEL: Theil-Sen on |ΔOI| -> |ΔPrice|, trained
//  ONLY on movements whose price direction matched the ORIGINAL
//  (adverse) episode direction, using ONLY movements strictly BEFORE
//  the one currently being evaluated. Direction is NEVER part of the
//  regression -- magnitude only.
//
//  END DETECTION: for each new movement, in chronological order:
//    - if its direction is ADVERSE (matches original): add its
//      (|ΔOI|,|ΔPrice|) point to the training set for FUTURE
//      movements. Continue.
//    - if its direction is FAVORABLE (opposite original): evaluate
//      against the model trained on all PRIOR adverse movements.
//      expected|ΔPrice| = max(0, slope*|ΔOI|+intercept).
//      If the model has >=2 training points AND expected>0 AND
//      actual|ΔPrice| >= expected|ΔPrice|:
//          END DETECTED at this movement's end timestamp.
//      Otherwise: not yet END, continue (this favorable movement is
//      simply weaker than the currently-learned adverse-force scale).
//
//  No fixed time window anywhere in the detection rule itself. A
//  disclosed research safety cap (3 hours from candidate START) only
//  bounds the search computationally -- if END is never detected by
//  then, the candidate is UNRESOLVED (not a market claim).
//
//   node scripts/btc-magnitude-consistent-reversal-end.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EVAL_DAYS = 3;
const RESEARCH_CAP_MIN = 180; // disclosed computational safety bound only, not part of the END rule

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

/** Segment raw ticks [fromIdx, capIdx] into MOVEMENTS: maximal runs of
 *  same-sign ΔOI. Skips ΔOI==0 and any tick pair with a null own-price
 *  field (never backfilled). */
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
    // sign flip -- close the previous run at k-1 (its last same-sign tick), start a new one at k-1.
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
    "BUILT FROM SCRATCH. No fixed 10min window, no post-END scan, no OI-chain STOP, no f_END, no raw-tick flip, no saturation logic reused.",
  );
  console.log("=".repeat(170));

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - EVAL_DAYS * 86_400_000;
  const loadEndMs = rangeEndMs + RESEARCH_CAP_MIN * 60_000;

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
        $gte: new Date(rangeStartMs - 65000),
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

  // ============================================================
  // CANDIDATE CONSTRUCTION: liquidation START only, END discovered by this model
  // ============================================================
  const episodes = [];
  let liqIdx = 0;
  while (liqIdx < allLiq.length) {
    const startEvent = allLiq[liqIdx];
    const direction = startEvent.victim;
    const adverseDir = direction === "LONG" ? "down" : "up";
    const startTs = startEvent.timestamp;
    const startIdx = nearestObsIdxAtOrBefore(allOi, startTs);
    if (startIdx < 0) {
      liqIdx++;
      continue;
    }

    const capTs = startTs + RESEARCH_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, startIdx);
    if (capIdx <= startIdx) {
      liqIdx++;
      continue;
    }

    const movements = buildMovements(allOi, startIdx, capIdx);

    let trainPoints = [];
    let endResult = null;
    const evolvingStates = [];
    for (const mv of movements) {
      const isAdverse =
        adverseDir === "down" ? mv.dPriceLog < 0 : mv.dPriceLog > 0;
      const modelBefore = theilSen(trainPoints);
      let expected = null,
        triggeredEnd = false;
      if (!isAdverse && modelBefore) {
        expected = Math.max(
          0,
          modelBefore.slope * mv.absOi + modelBefore.intercept,
        );
        if (expected > 0 && Math.abs(mv.dPriceLog) >= expected)
          triggeredEnd = true;
      }
      evolvingStates.push({
        mv,
        isAdverse,
        modelBefore,
        expected,
        triggeredEnd,
      });
      if (triggeredEnd) {
        endResult = { movement: mv, model: modelBefore, expected };
        break;
      }
      if (isAdverse)
        trainPoints.push({ x: mv.absOi, y: Math.abs(mv.dPriceLog) });
    }

    const endBoundaryTs = endResult ? endResult.movement.endTs : capTs;
    const episodeEvents = [];
    while (
      liqIdx < allLiq.length &&
      allLiq[liqIdx].timestamp <= endBoundaryTs
    ) {
      episodeEvents.push(allLiq[liqIdx]);
      liqIdx++;
    }
    if (episodeEvents.length === 0) {
      liqIdx++;
      continue;
    }

    episodes.push({
      direction,
      startTs,
      endResult,
      endBoundaryTs,
      movements,
      evolvingStates,
      dirLiqUsd: episodeEvents
        .filter((e) => e.victim === direction)
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
    });
  }
  episodes.forEach((e, i) => {
    e.id = `M${String(i + 1).padStart(3, "0")}`;
  });
  console.log(`\nEpisodes constructed: ${episodes.length}`);
  const detected = episodes.filter((e) => e.endResult);
  console.log(
    `DETECTED_END: ${detected.length}   UNRESOLVED: ${episodes.length - detected.length}\n`,
  );

  // ============================================================
  // PER-EPISODE OUTPUT
  // ============================================================
  console.log(`${"=".repeat(200)}\nPER-EPISODE RESULT\n${"=".repeat(200)}`);
  episodes.forEach((e) => {
    console.log(
      `\n${e.id}  ${e.direction}  START=${fmtDate(e.startTs)}  dirLiq(ref)=${fmtUsd(e.dirLiqUsd)}`,
    );
    if (e.endResult) {
      const dur = e.endResult.movement.endTs - e.startTs;
      console.log(
        `  DETECTED END: ${fmtDate(e.endResult.movement.endTs)}   duration=${fmtSec(dur)}`,
      );
      console.log(
        `  learned magnitude relationship before END: slope=${e.endResult.model.slope.toFixed(6)} intercept=${e.endResult.model.intercept.toFixed(6)}`,
      );
      console.log(
        `  OI magnitude producing final response: |ΔOI|=${fmtBtc(e.endResult.movement.absOi)}   expected|ΔPrice|=${fmtPct(e.endResult.expected)}   actual signed ΔPrice=${fmtPct(e.endResult.movement.dPriceLog)}`,
      );
      console.log(
        `  previous direction: ADVERSE(${e.direction === "LONG" ? "DOWN" : "UP"})   new direction: FAVORABLE(${e.direction === "LONG" ? "UP" : "DOWN"})`,
      );
    } else
      console.log(
        `  UNRESOLVED within ${RESEARCH_CAP_MIN}min research cap. Movements observed: ${e.movements.length}`,
      );
  });

  // ============================================================
  // EVOLVING STATES FOR THE 3 REQUESTED SEP-20 CASES
  // ============================================================
  console.log(
    `\n${"=".repeat(200)}\nFULL EVOLVING OI->PRICE STATES -- Sep-20 02:24 / 02:35 / 03:08 area\n${"=".repeat(200)}`,
  );
  const windows = [
    {
      label: "~02:24",
      from: Date.parse("2026-09-20T02:20:00Z"),
      to: Date.parse("2026-09-20T02:30:00Z"),
    },
    {
      label: "~02:35",
      from: Date.parse("2026-09-20T02:32:00Z"),
      to: Date.parse("2026-09-20T02:40:00Z"),
    },
    {
      label: "~03:08",
      from: Date.parse("2026-09-20T03:04:00Z"),
      to: Date.parse("2026-09-20T03:12:00Z"),
    },
  ];
  for (const w of windows) {
    const e = episodes.find((x) => x.startTs >= w.from && x.startTs <= w.to);
    if (!e) {
      console.log(`\n${w.label}: no episode START found in this window.`);
      continue;
    }
    console.log(
      `\n${w.label} -> ${e.id}  ${e.direction}  START=${fmtDate(e.startTs)}`,
    );
    console.log(
      "MOVEMENT#  | startTs                   | endTs                     | |ΔOI|      | ΔPrice     | isAdverse | slope(before) | intercept(before) | expected   | END?",
    );
    e.evolvingStates.forEach((s, idx) => {
      console.log(
        `${String(idx + 1).padEnd(10)} | ${fmtDate(s.mv.startTs)} | ${fmtDate(s.mv.endTs)} | ${fmtBtc(s.mv.absOi).padEnd(10)} | ${fmtPct(s.mv.dPriceLog).padEnd(10)} | ${String(s.isAdverse).padEnd(9)} | ${(s.modelBefore ? s.modelBefore.slope.toFixed(6) : "N/A").padEnd(14)} | ${(s.modelBefore ? s.modelBefore.intercept.toFixed(6) : "N/A").padEnd(18)} | ${(s.expected !== null ? fmtPct(s.expected) : "N/A").padEnd(10)} | ${s.triggeredEnd ? "*** END ***" : ""}`,
      );
    });
  }

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
