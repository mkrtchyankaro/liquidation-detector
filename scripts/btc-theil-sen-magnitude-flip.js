// BTC THEIL-SEN MAGNITUDE-ONLY DIRECTION-FLIP RESEARCH -- new,
// standalone. Fixed 10-minute baseline REUSED VERBATIM. Discards all
// prior post-END logic (no f_END, no consecutive-ΔOI-chain STOP, no
// fixed minutes).
//
// ============================================================
// MODEL: Theil-Sen on |ΔOI| -> |ΔPrice| (MAGNITUDE ONLY)
//
//  Training data (per episode, from its OWN [START,END] window,
//  causal to that episode): raw consecutive-tick pairs
//  (|ΔOI_i|, |ΔPrice_i|), skipping ΔOI==0 ticks (no information).
//
//  Theil-Sen slope = median of ALL pairwise slopes (y_j-y_i)/(x_j-x_i)
//  over i<j. Theil-Sen intercept = median of (y_i - slope*x_i). This
//  is the standard robust Theil-Sen estimator -- no direction is
//  learned here at all, only expected RESPONSE SIZE per unit |ΔOI|.
//
//  expectedAbsPriceMove(|ΔOI|) = max(0, slope*|ΔOI| + intercept)
//
// POST-END DIRECTION-FLIP DETECTION:
//  Walking forward from END (raw ticks, ΔOI==0 skipped), for each
//  tick compute:
//    direction = FAVORABLE (opposite the episode's own original/
//                adverse direction) or ADVERSE (continuing it)
//    expectedAbsPriceMove from the SAME episode's own Theil-Sen model
//  FLIP EVENT (first occurrence): direction==FAVORABLE AND
//    |actual ΔPrice| >= expectedAbsPriceMove AND expectedAbsPriceMove>0
//  -- i.e. the market responded with AT LEAST the learned expected
//  force for that OI size, but in the opposite direction. No
//  multiplier/tolerance invented -- a plain >= comparison. HONEST
//  CAVEAT (disclosed, not hidden): this is evaluated on SINGLE raw
//  ticks, so it can be sensitive to single-tick noise -- the output
//  itself is the evidence for whether that is a problem in practice.
//
//   node scripts/btc-theil-sen-magnitude-flip.js
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
const SAFETY_CAP_MIN = 60; // disclosed computation/data-loading bound only, not part of the flip rule
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
function fmtMin(n) {
  return n === null || n === undefined ? "N/A" : `${n.toFixed(1)}m`;
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

/** Standard Theil-Sen: median of all pairwise slopes, then median of
 *  residual intercepts. O(n^2) -- fine for the small per-episode
 *  training sets used here (a few hundred points). */
function theilSen(points) {
  if (points.length < 2) return null;
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (dx === 0) continue;
      slopes.push((points[j].y - points[i].y) / dx);
    }
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
    "RESEARCH ONLY. Theil-Sen learns |ΔOI|->|ΔPrice| MAGNITUDE only, per-episode, from [START,END]. Direction evaluated separately, post-END.",
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
  // PER-EPISODE: TRAIN THEIL-SEN, THEN SCAN POST-END FOR FLIP
  // ============================================================
  for (const c of allCandidates) {
    const revUp = c.direction === "LONG"; // favorable = price up

    // Training pairs from [START,END], raw consecutive ticks, skip ΔOI==0.
    const trainPoints = [];
    for (let k = c.startIdx + 1; k <= c.endIdx; k++) {
      const p0 = priceAtOrBeforeIdx(allOi, k - 1),
        p1 = priceAtOrBeforeIdx(allOi, k);
      if (p0 === null || p1 === null) continue;
      const dOi = allOi[k].contracts - allOi[k - 1].contracts;
      if (dOi === 0) continue;
      const dPriceLog = Math.log(p1 / p0) * 100;
      trainPoints.push({ x: Math.abs(dOi), y: Math.abs(dPriceLog) });
    }
    const model = theilSen(trainPoints);
    c.model = model;
    if (!model) {
      c.flip = null;
      continue;
    }

    // Post-END scan for the FIRST flip event.
    const capTs = c.endTs + SAFETY_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, c.endIdx);
    let flip = null;
    for (let k = c.endIdx + 1; k <= capIdx; k++) {
      const p0 = priceAtOrBeforeIdx(allOi, k - 1),
        p1 = priceAtOrBeforeIdx(allOi, k);
      if (p0 === null || p1 === null) continue;
      const dOi = allOi[k].contracts - allOi[k - 1].contracts;
      if (dOi === 0) continue;
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
  // PER-EPISODE OUTPUT
  // ============================================================
  console.log(
    `${"=".repeat(200)}\nPER-EPISODE THEIL-SEN MODEL + FLIP DETECTION\n${"=".repeat(200)}`,
  );
  allCandidates.forEach((c) => {
    console.log(`\n${c.id}  ${c.direction}  END=${fmtDate(c.endTs)}`);
    if (!c.model) {
      console.log("  Theil-Sen model: insufficient training data.");
      return;
    }
    console.log(
      `  Theil-Sen model: slope=${c.model.slope.toFixed(6)}  intercept=${c.model.intercept.toFixed(6)}  (trained on ${c.model.n} points, ${c.model.pairs} pairs)`,
    );
    if (c.flip) {
      console.log(
        `  FLIP DETECTED: ${fmtDate(c.flip.ts)}  |ΔOI|=${fmtBtc(Math.abs(c.flip.dOi))}  actual ΔPrice=${fmtPct(c.flip.dPriceLog)}  expected|ΔPrice|=${fmtPct(c.flip.expectedAbs)}  price=${fmtPrice(c.flip.price)}`,
      );
      for (const h of OUTCOME_HORIZONS_MIN) {
        const o = c.postFlipOutcome[h];
        console.log(
          `  post-flip ${h}m: ${o ? `MFE=${fmtPct(o.MFE)}  MAE=${fmtPct(o.MAE)}` : "N/A"}`,
        );
      }
    } else console.log("  No flip event detected within the research window.");
  });

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log(`\n${"=".repeat(170)}\nSUMMARY\n${"=".repeat(170)}`);
  const withModel = allCandidates.filter((c) => c.model);
  const withFlip = withModel.filter((c) => c.flip);
  console.log(`Episodes with a usable Theil-Sen model: ${withModel.length}`);
  console.log(
    `Episodes with a detected FLIP event: ${withFlip.length} (${((withFlip.length / withModel.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Median slope: ${median(withModel.map((c) => c.model.slope))?.toFixed(6)}   Median intercept: ${median(withModel.map((c) => c.model.intercept))?.toFixed(6)}`,
  );
  console.log(
    `Median minutes END->FLIP: ${median(withFlip.map((c) => (c.flip.ts - c.endTs) / 60000))?.toFixed(2)}`,
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
