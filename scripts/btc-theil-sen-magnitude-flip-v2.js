// BTC THEIL-SEN MAGNITUDE-ONLY DIRECTION-FLIP RESEARCH -- v2, FIXED
// TRAINING-PAIR CONSTRUCTION. Fixed 10-minute baseline REUSED
// VERBATIM, unchanged. Magnitude-only Theil-Sen kept, direction
// evaluated separately, production code untouched.
//
// ============================================================
// BUG FOUND (diagnosed and printed below, not just asserted):
//
//   v1 used priceAtOrBeforeIdx(allOi, k), which BACKWARD-FILLS from
//   the nearest EARLIER document whose OWN price field is non-null,
//   whenever the document AT index k itself has price:null. Since
//   oi_second_observations documents can have a null price field even
//   when openInterest is present, a run of several consecutive
//   null-price documents all backfill to the SAME earlier price --
//   so p0 and p1 in the training pair are frequently IDENTICAL even
//   though the OI values differ, producing |ΔPrice|=0 for many pairs
//   while |ΔOI|>0. Theil-Sen's median-of-pairwise-slopes then
//   collapses toward 0 because a large share of the training pairs
//   are (positive x, y=0) points.
//
// FIX: training (and post-END scanning) pairs now use ONLY the
// document's OWN price field at each index -- allOi[k].price directly
// -- and are SKIPPED entirely (not backfilled) if either endpoint's
// own price is null. This guarantees every training/scan pair
// measures the actual price change over the SAME causal interval as
// the OI change, never a stale snapshot.
//
//   node scripts/btc-theil-sen-magnitude-flip-v2.js
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
const SAFETY_CAP_MIN = 60;
const OUTCOME_HORIZONS_MIN = [5, 10, 30];

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
  return { slope, intercept, n: points.length, pairs: slopes.length };
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
    "RESEARCH ONLY. v2: FIXED training-pair construction (own-price-only, no stale backfill).",
  );
  console.log("=".repeat(170));

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs =
    evalEndMs + Math.max(SAFETY_CAP_MIN, ...OUTCOME_HORIZONS_MIN) * 60_000;

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

  // ============================================================
  // DIAGNOSTIC (proving the bug), BEFORE any fix, over the WHOLE loaded range
  // ============================================================
  console.log(
    `\n${"=".repeat(170)}\nDIAGNOSTIC -- WHY SLOPES COLLAPSED TO ~0 (v1 behavior, reproduced here for proof)\n${"=".repeat(170)}`,
  );
  const nullPriceCount = allOi.filter((o) => o.price === null).length;
  console.log(
    `Documents with price===null (own field): ${nullPriceCount} of ${allOi.length} (${((nullPriceCount / allOi.length) * 100).toFixed(2)}%)`,
  );

  let oldZeroDeltaPrice = 0,
    oldTotalPairs = 0,
    oldZeroDeltaOi = 0;
  let backfilledCount = 0,
    ownFieldCount = 0;
  const examplePairs = [];
  for (let k = 1; k < Math.min(allOi.length, 20000); k++) {
    const dOi = allOi[k].contracts - allOi[k - 1].contracts;
    if (dOi === 0) {
      oldZeroDeltaOi++;
      continue;
    }
    oldTotalPairs++;
    const p0Old = priceAtOrBeforeIdx(allOi, k - 1),
      p1Old = priceAtOrBeforeIdx(allOi, k);
    if (p0Old === p1Old) oldZeroDeltaPrice++;
    if (allOi[k].price === null || allOi[k - 1].price === null)
      backfilledCount++;
    else ownFieldCount++;
    if (
      examplePairs.length < 10 &&
      (allOi[k].price === null || allOi[k - 1].price === null)
    ) {
      examplePairs.push({
        tsA: allOi[k - 1].ts,
        priceOwnA: allOi[k - 1].price,
        priceUsedA: p0Old,
        tsB: allOi[k].ts,
        priceOwnB: allOi[k].price,
        priceUsedB: p1Old,
        dOi,
      });
    }
  }
  console.log(
    `Sample scan (first ${Math.min(allOi.length, 20000)} observations): ${oldTotalPairs} pairs with ΔOI!=0.`,
  );
  console.log(
    `  old method: pairs where backfilled p0===p1 (=> |ΔPrice|=0 purely from stale-price collision): ${oldZeroDeltaPrice} (${((oldZeroDeltaPrice / oldTotalPairs) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  pairs requiring backfill (own price null at k or k-1): ${backfilledCount} (${((backfilledCount / oldTotalPairs) * 100).toFixed(1)}%)   pairs with own price present at both: ${ownFieldCount}`,
  );
  console.log(
    `\nExample raw pairs where backfill occurred (own price vs price actually used):`,
  );
  console.log(
    "tsA                       | ownPriceA | usedPriceA | tsB                       | ownPriceB | usedPriceB | ΔOI",
  );
  examplePairs.forEach((e) =>
    console.log(
      `${fmtDate(e.tsA)} | ${e.priceOwnA === null ? "NULL" : fmtPrice(e.priceOwnA)} | ${fmtPrice(e.priceUsedA)} | ${fmtDate(e.tsB)} | ${e.priceOwnB === null ? "NULL" : fmtPrice(e.priceOwnB)} | ${fmtPrice(e.priceUsedB)} | ${e.dOi}`,
    ),
  );
  console.log(
    `\nCONCLUSION: the diagnostic above shows whether stale-price backfill is the dominant cause of |ΔPrice|=0 collisions.\n`,
  );

  // ---- Baseline construction (verbatim) ----
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
  const allCandidates = [...longC, ...shortC]
    .filter((c) => c.liveEvaluable && c.priceStart !== null)
    .sort((a, b) => a.startTs - b.startTs);
  allCandidates.forEach((c, i) => {
    c.id = `E${String(i + 1).padStart(3, "0")}`;
  });
  console.log(`ALL live-evaluable episodes: ${allCandidates.length}\n`);

  // ============================================================
  // FIXED TRAINING-PAIR CONSTRUCTION: own-price-only, no backfill
  // ============================================================
  for (const c of allCandidates) {
    const revUp = c.direction === "LONG";

    const trainPoints = [];
    let skippedNullPrice = 0,
      skippedZeroOi = 0;
    for (let k = c.startIdx + 1; k <= c.endIdx; k++) {
      const dOi = allOi[k].contracts - allOi[k - 1].contracts;
      if (dOi === 0) {
        skippedZeroOi++;
        continue;
      }
      const p0 = allOi[k - 1].price,
        p1 = allOi[k].price; // FIX: own field only, no backfill
      if (p0 === null || p1 === null) {
        skippedNullPrice++;
        continue;
      }
      const dPriceLog = Math.log(p1 / p0) * 100;
      trainPoints.push({ x: Math.abs(dOi), y: Math.abs(dPriceLog) });
    }
    c.trainDiag = { skippedNullPrice, skippedZeroOi, used: trainPoints.length };
    const model = theilSen(trainPoints);
    c.model = model;
    if (!model) {
      c.flip = null;
      continue;
    }

    const capTs = c.endTs + SAFETY_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, c.endIdx);
    let flip = null;
    for (let k = c.endIdx + 1; k <= capIdx; k++) {
      const dOi = allOi[k].contracts - allOi[k - 1].contracts;
      if (dOi === 0) continue;
      const p0 = allOi[k - 1].price,
        p1 = allOi[k].price; // FIX: own field only, no backfill
      if (p0 === null || p1 === null) continue;
      const dPriceLog = Math.log(p1 / p0) * 100;
      const direction = revUp
        ? dPriceLog > 0
          ? "FAVORABLE"
          : "ADVERSE"
        : dPriceLog < 0
          ? "FAVORABLE"
          : "ADVERSE";
      const expectedAbs = Math.max(
        0,
        model.slope * Math.abs(dOi) + model.intercept,
      );
      if (
        direction === "FAVORABLE" &&
        expectedAbs > 0 &&
        Math.abs(dPriceLog) >= expectedAbs
      ) {
        flip = { ts: allOi[k].ts, dOi, dPriceLog, expectedAbs, price: p1 };
        break;
      }
    }
    c.flip = flip;

    if (flip) {
      c.postFlipOutcome = {};
      for (const h of OUTCOME_HORIZONS_MIN) {
        const hEndTs = flip.ts + h * 60000;
        const hEndIdx = nearestObsIdxAtOrBefore(allOi, hEndTs, c.endIdx);
        if (hEndIdx < c.endIdx) {
          c.postFlipOutcome[h] = null;
          continue;
        }
        let fav = null,
          adv = null;
        for (let k = c.endIdx; k <= hEndIdx; k++) {
          const p = priceAtOrBeforeIdx(allOi, k);
          if (p === null || allOi[k].ts < flip.ts) continue;
          if (revUp) {
            if (fav === null || p > fav) fav = p;
            if (adv === null || p < adv) adv = p;
          } else {
            if (fav === null || p < fav) fav = p;
            if (adv === null || p > adv) adv = p;
          }
        }
        if (fav === null) {
          c.postFlipOutcome[h] = null;
          continue;
        }
        const MFE = revUp
          ? (fav / flip.price - 1) * 100
          : (flip.price / fav - 1) * 100;
        const MAE = revUp
          ? (flip.price / adv - 1) * 100
          : (adv / flip.price - 1) * 100;
        c.postFlipOutcome[h] = { MFE, MAE };
      }
    }
  }

  // ============================================================
  // MODEL DISTRIBUTIONS
  // ============================================================
  console.log(
    `${"=".repeat(170)}\nSLOPE / INTERCEPT DISTRIBUTIONS (fixed pairing)\n${"=".repeat(170)}`,
  );
  const withModel = allCandidates.filter((c) => c.model);
  const slopes = withModel.map((c) => c.model.slope).sort((a, b) => a - b);
  const intercepts = withModel
    .map((c) => c.model.intercept)
    .sort((a, b) => a - b);
  console.log(`Episodes with a usable model: ${withModel.length}`);
  console.log(
    `slope: median=${median(slopes)?.toFixed(6)} P25=${percentile(slopes, 25)?.toFixed(6)} P75=${percentile(slopes, 75)?.toFixed(6)} MIN=${slopes[0]?.toFixed(6)} MAX=${slopes[slopes.length - 1]?.toFixed(6)}`,
  );
  console.log(
    `intercept: median=${median(intercepts)?.toFixed(6)} P25=${percentile(intercepts, 25)?.toFixed(6)} P75=${percentile(intercepts, 75)?.toFixed(6)}`,
  );
  console.log(
    `slope===0 exactly: ${withModel.filter((c) => c.model.slope === 0).length} of ${withModel.length}`,
  );
  const avgTrainUsed = median(allCandidates.map((c) => c.trainDiag?.used));
  console.log(
    `median training points actually used per episode (after fix): ${avgTrainUsed}   median skipped(null price): ${median(allCandidates.map((c) => c.trainDiag?.skippedNullPrice))}   median skipped(ΔOI=0): ${median(allCandidates.map((c) => c.trainDiag?.skippedZeroOi))}`,
  );

  // ============================================================
  // 3 REQUESTED CASES
  // ============================================================
  console.log(`\n${"=".repeat(170)}\nREQUESTED CASES\n${"=".repeat(170)}`);
  const caseTs = [
    Date.parse("2026-09-20T02:34:27Z"),
    Date.parse("2026-09-20T02:45:59Z"),
    Date.parse("2026-09-20T03:18:05Z"),
  ];
  for (const ets of caseTs) {
    const c = allCandidates.find(
      (x) => Math.abs(x.endTs - ets) < 2000 && x.direction === "LONG",
    );
    if (!c) {
      console.log(`\nEND=${fmtDate(ets)}: NOT FOUND.`);
      continue;
    }
    console.log(
      `\n${c.id}  END=${fmtDate(c.endTs)}  dirLiq(ref)=${fmtUsd(c.dirLiqUsd)}`,
    );
    if (!c.model) {
      console.log("  No usable model (insufficient training pairs after fix).");
      continue;
    }
    console.log(
      `  Model: slope=${c.model.slope.toFixed(6)} intercept=${c.model.intercept.toFixed(6)}  (n=${c.model.n} points used, ${c.trainDiag.skippedNullPrice} skipped null-price, ${c.trainDiag.skippedZeroOi} skipped ΔOI=0)`,
    );
    if (c.flip) {
      console.log(
        `  FLIP: ${fmtDate(c.flip.ts)}  |ΔOI|=${fmtBtc(Math.abs(c.flip.dOi))}  actualΔPrice=${fmtPct(c.flip.dPriceLog)}  expected|ΔPrice|=${fmtPct(c.flip.expectedAbs)}`,
      );
      for (const h of OUTCOME_HORIZONS_MIN) {
        const o = c.postFlipOutcome[h];
        console.log(
          `  post-flip ${h}m: ${o ? `MFE=${fmtPct(o.MFE)} MAE=${fmtPct(o.MAE)}` : "N/A"}`,
        );
      }
    } else console.log("  No flip detected.");
  }

  // ============================================================
  // ALL FLIPS + SUMMARY
  // ============================================================
  console.log(`\n${"=".repeat(170)}\nALL DETECTED FLIPS\n${"=".repeat(170)}`);
  const withFlip = withModel.filter((c) => c.flip);
  withFlip.forEach((c) => {
    console.log(
      `${c.id} ${c.direction} END=${fmtDate(c.endTs)} FLIP=${fmtDate(c.flip.ts)} |ΔOI|=${fmtBtc(Math.abs(c.flip.dOi))} actual=${fmtPct(c.flip.dPriceLog)} expected=${fmtPct(c.flip.expectedAbs)} MFE30=${c.postFlipOutcome[30] ? fmtPct(c.postFlipOutcome[30].MFE) : "N/A"} MAE30=${c.postFlipOutcome[30] ? fmtPct(c.postFlipOutcome[30].MAE) : "N/A"}`,
    );
  });

  console.log(
    `\nSUMMARY: episodes with model=${withModel.length}  with flip=${withFlip.length} (${((withFlip.length / withModel.length) * 100).toFixed(1)}%)`,
  );
  for (const h of OUTCOME_HORIZONS_MIN) {
    const mfe = withFlip
      .map((c) => c.postFlipOutcome[h]?.MFE)
      .filter((v) => v !== null && v !== undefined);
    const mae = withFlip
      .map((c) => c.postFlipOutcome[h]?.MAE)
      .filter((v) => v !== null && v !== undefined);
    console.log(
      `post-flip ${h}m: median MFE=${fmtPct(median(mfe))}  median MAE=${fmtPct(median(mae))}  N=${mfe.length}`,
    );
  }

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
