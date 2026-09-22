// BTC NET-OI-REMAINING / IMPLIED-MOVE RESEARCH -- new, standalone.
// Baseline (btc-simple-10min-window.js) and post-episode outcome math
// (btc-post-episode-outcomes.js) REUSED VERBATIM, neither modified.
// Builds on the same causal timeline / self-relative efficiency
// concept from btc-oi-price-efficiency-saturation.js (not modified),
// extended with netOIRemaining, REVERSAL_CONFIRMATION, and the
// implied-vs-actual price-move comparison.
//
// P90/P95 remain in output as DESCRIPTIVE/REFERENCE fields only --
// never the explanation for reversal in this script.
//
// ============================================================
// KEY DEFINITIONS (causal, self-relative, disclosed):
//
//  netOIRemaining(T) = OI(T) - episodeStartOI  (signed, raw BTC)
//
//  Same recentEfficiency(T)/earlierEfficiency(T) machinery as the
//  prior saturation script (recent = most recent 25% of cumGrossOI
//  accumulated so far, via monotonic two-pointer -- see that file for
//  the full derivation). cumDirProgress is positive while price
//  continues the ORIGINAL liquidation direction, negative once price
//  moves favorably.
//
//  REVERSAL_CONFIRMATION(T): the FIRST causal timestamp where
//  recentEfficiency(T) < 0 (strictly negative -- the most recent
//  chunk of OI activity is now associated with NET favorable-
//  direction price movement, not just zero/flat). This is a
//  continuation of the same sign-based, zero-parameter framework used
//  for "saturation" in the prior script -- reused consistently, not
//  reinvented.
//
//  impliedFavorableMovePct(T) = |recentEfficiency(T)| x
//  |netOIRemaining(T)|. This assumes the CURRENT locally-observed
//  price-per-unit-OI ratio (from the recent window) applies uniformly
//  to the remaining net OI magnitude -- a DISCLOSED, explicitly-local-
//  linear assumption, not validated as globally linear. Testing
//  whether this implied number matches ACTUAL subsequent price
//  movement is the entire point of this experiment.
//
//   node scripts/btc-oi-remaining-implied-move.js
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
const RECENT_WINDOW_FRACTION = 0.25; // same as the prior saturation script, reused consistently
const OUTCOME_HORIZONS_MIN = [5, 10, 15, 30, 60];
const TIMELINE_HORIZON_MIN = 60;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
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
    : n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 3 })}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
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

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(170));
  console.log("CAUSALITY AUDIT");
  console.log("=".repeat(170));
  console.log(
    "1. Baseline candidate construction identical to btc-simple-10min-window.js.",
  );
  console.log(
    "2. netOIRemaining(T), recentEfficiency(T), REVERSAL_CONFIRMATION(T), and impliedFavorableMovePct(T) use ONLY observations with ts<=T.",
  );
  console.log(
    "3. Actual MFE/MAE outcome horizons are computed strictly AFTER T and are never fed back into the confirmation timestamp or the implied-move calculation.",
  );
  console.log(
    "4. P90/P95 appear only as descriptive/reference fields -- never used to explain or detect reversal in this script.\n",
  );

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + TIMELINE_HORIZON_MIN * 60_000;

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
        c.causalP90 = null;
        return;
      }
      const vals = prior.map((p) => p.dirLiqUsd).sort((a, b) => a - b);
      c.causalP90 = percentile(vals, 90);
      c.causalP95 = percentile(vals, 95);
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
    `P90 candidates for this analysis: ${p90Candidates.length} (P90/P95 shown as descriptive reference only)\n`,
  );

  // ============================================================
  // PER-CANDIDATE TIMELINE, netOIRemaining, REVERSAL_CONFIRMATION
  // ============================================================
  for (const c of p90Candidates) {
    const revUp = c.direction === "LONG";
    const horizonEndTs = c.endTs + TIMELINE_HORIZON_MIN * 60000;
    const horizonEndIdx = nearestObsIdxAtOrBefore(
      allOi,
      horizonEndTs,
      c.startIdx,
    );
    if (horizonEndIdx < c.startIdx) {
      c.timeline = null;
      continue;
    }

    const startPrice = priceAtOrBeforeIdx(allOi, c.startIdx);
    const startOi = allOi[c.startIdx].contracts;
    const timeline = [];
    let cumGrossOI = 0,
      cumDirProgress = 0;
    let refIdx = 0;
    const cumGrossArr = [],
      cumProgArr = [];
    let runningExtremePrice = startPrice; // running adverse-direction extreme up to each point

    for (let k = c.startIdx; k <= horizonEndIdx; k++) {
      const p = priceAtOrBeforeIdx(allOi, k);
      if (p === null) continue;
      if (k > c.startIdx) {
        const dOi = allOi[k].contracts - allOi[k - 1].contracts;
        cumGrossOI += Math.abs(dOi);
      }
      const dirProgressRaw = revUp ? startPrice - p : p - startPrice;
      cumDirProgress = (dirProgressRaw / startPrice) * 100;
      cumGrossArr.push(cumGrossOI);
      cumProgArr.push(cumDirProgress);

      const target = (1 - RECENT_WINDOW_FRACTION) * cumGrossOI;
      while (refIdx < cumGrossArr.length - 1 && cumGrossArr[refIdx] < target)
        refIdx++;
      const recentGross = cumGrossOI - cumGrossArr[refIdx];
      const recentProg = cumDirProgress - cumProgArr[refIdx];
      const recentEfficiency =
        recentGross > 0 ? recentProg / recentGross : null;

      if (revUp ? p < runningExtremePrice : p > runningExtremePrice)
        runningExtremePrice = p;
      const netOIRemaining = allOi[k].contracts - startOi;

      timeline.push({
        ts: allOi[k].ts,
        price: p,
        oi: allOi[k].contracts,
        cumGrossOI,
        cumDirProgress,
        recentEfficiency,
        netOIRemaining,
        runningExtremePrice,
      });
    }
    c.timeline = timeline;
    c.startPrice = startPrice;
    c.startOi = startOi;

    // REVERSAL_CONFIRMATION: first T with recentEfficiency < 0 (strict).
    let confirmTs = null,
      confirmRow = null;
    for (const row of timeline) {
      if (row.recentEfficiency !== null && row.recentEfficiency < 0) {
        confirmTs = row.ts;
        confirmRow = row;
        break;
      }
    }
    c.confirmTs = confirmTs;
    c.confirmRow = confirmRow;

    if (confirmTs !== null) {
      c.netOIRemainingAtConfirm = confirmRow.netOIRemaining;
      c.netOIRemainingPctAtConfirm =
        (confirmRow.netOIRemaining / startOi) * 100;
      c.responseDirection = revUp ? "UP" : "DOWN";
      c.impliedMovePct =
        Math.abs(confirmRow.recentEfficiency) *
        Math.abs(confirmRow.netOIRemaining);

      // Price already moved, before confirmation.
      const dropAlready = revUp
        ? ((startPrice - confirmRow.runningExtremePrice) / startPrice) * 100
        : ((confirmRow.runningExtremePrice - startPrice) / startPrice) * 100;
      const recoveryAlready = revUp
        ? ((confirmRow.price - confirmRow.runningExtremePrice) /
            confirmRow.runningExtremePrice) *
          100
        : ((confirmRow.runningExtremePrice - confirmRow.price) /
            confirmRow.runningExtremePrice) *
          100;
      const remainingToStart = revUp
        ? ((startPrice - confirmRow.price) / confirmRow.price) * 100
        : ((confirmRow.price - startPrice) / startPrice) * 100;
      c.dropAlready = dropAlready;
      c.recoveryAlready = recoveryAlready;
      c.remainingToStart = remainingToStart;

      // Actual outcome horizons from confirmation.
      c.actualOutcome = {};
      for (const h of OUTCOME_HORIZONS_MIN) {
        const hEndTs = confirmTs + h * 60000;
        const rows = timeline.filter(
          (r) => r.ts >= confirmTs && r.ts <= hEndTs,
        );
        if (rows.length === 0) {
          c.actualOutcome[h] = null;
          continue;
        }
        let fav = null,
          adv = null;
        for (const r of rows) {
          if (revUp) {
            if (fav === null || r.price > fav) fav = r.price;
            if (adv === null || r.price < adv) adv = r.price;
          } else {
            if (fav === null || r.price < fav) fav = r.price;
            if (adv === null || r.price > adv) adv = r.price;
          }
        }
        const MFE = revUp
          ? (fav / confirmRow.price - 1) * 100
          : (confirmRow.price / fav - 1) * 100;
        const MAE = revUp
          ? (confirmRow.price / adv - 1) * 100
          : (adv / confirmRow.price - 1) * 100;
        c.actualOutcome[h] = {
          MFE,
          MAE,
          errorVsImplied: MFE - c.impliedMovePct,
          ratioVsImplied: c.impliedMovePct > 0 ? MFE / c.impliedMovePct : null,
        };
      }
    }

    // OI extremes during the whole tracked window (start->end of timeline).
    c.oiMaxDuringProcess = Math.max(...timeline.map((r) => r.oi));
    c.oiMinDuringProcess = Math.min(...timeline.map((r) => r.oi));
    c.oiAtEnd = timeline.find((r) => r.ts >= c.endTs)?.oi ?? null;
    c.netOIStartToEnd = c.oiAtEnd !== null ? c.oiAtEnd - startOi : null;
  }

  const withConfirm = p90Candidates.filter(
    (c) => c.timeline && c.confirmTs !== null,
  );
  console.log(
    `${"=".repeat(170)}\nREVERSAL_CONFIRMATION SUMMARY\n${"=".repeat(170)}`,
  );
  console.log(
    `P90 candidates with usable timeline: ${p90Candidates.filter((c) => c.timeline).length}`,
  );
  console.log(
    `Candidates where REVERSAL_CONFIRMATION was found: ${withConfirm.length}\n`,
  );

  // ============================================================
  // COHORTS (empirical, reused approach: MFE30-from-END rank split)
  // ============================================================
  function mfe30FromEnd(c) {
    const revUp = c.direction === "LONG";
    const rows = c.timeline.filter(
      (r) => r.ts >= c.endTs && r.ts <= c.endTs + 30 * 60000,
    );
    if (rows.length === 0) return null;
    let fav = null;
    for (const r of rows) {
      if (revUp) {
        if (fav === null || r.price > fav) fav = r.price;
      } else {
        if (fav === null || r.price < fav) fav = r.price;
      }
    }
    return revUp ? (fav / c.priceEnd - 1) * 100 : (c.priceEnd / fav - 1) * 100;
  }
  withConfirm.forEach((c) => {
    c.mfe30 = mfe30FromEnd(c);
  });
  const sortedMfe30 = withConfirm
    .map((c) => c.mfe30)
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  const mfe30Median = percentile(sortedMfe30, 50),
    mfe30P75 = percentile(sortedMfe30, 75);
  console.log(
    `Cohort split (empirical, MFE30): FAST=MFE30>=P75(${fmtPct(mfe30P75)}), MIXED=P50-P75, CONTINUATION=<P50(${fmtPct(mfe30Median)})\n`,
  );
  function cohortOf(c) {
    if (c.mfe30 === null) return "N/A";
    if (c.mfe30 >= mfe30P75) return "FAST";
    if (c.mfe30 >= mfe30Median) return "MIXED";
    return "CONTINUATION";
  }
  withConfirm.forEach((c) => {
    c.cohort = cohortOf(c);
  });

  for (const cohort of ["FAST", "MIXED", "CONTINUATION"]) {
    const cs = withConfirm.filter((c) => c.cohort === cohort);
    console.log(`${cohort}: N=${cs.length}`);
    console.log(
      `  netOIRemainingPct at confirm: ${median(cs.map((c) => c.netOIRemainingPctAtConfirm))?.toFixed(3)}% (median)`,
    );
    console.log(
      `  impliedMovePct: ${median(cs.map((c) => c.impliedMovePct))?.toFixed(4)}% (median)`,
    );
    for (const h of OUTCOME_HORIZONS_MIN) {
      const mfeVals = cs.map((c) => c.actualOutcome[h]?.MFE ?? null);
      const errVals = cs.map((c) => c.actualOutcome[h]?.errorVsImplied ?? null);
      const ratioVals = cs.map(
        (c) => c.actualOutcome[h]?.ratioVsImplied ?? null,
      );
      console.log(
        `  ${h}m: actual MFE median=${fmtPct(median(mfeVals))}  error(actual-implied) median=${fmtPct(median(errVals))}  ratio median=${median(ratioVals)?.toFixed(2) ?? "N/A"}`,
      );
    }
    console.log("");
  }

  // ============================================================
  // CASE STUDIES
  // ============================================================
  console.log(`${"=".repeat(170)}\nCASE STUDIES\n${"=".repeat(170)}`);
  const caseTimestamps = [
    {
      label: "CASE A (continued adversely)",
      startTs: Date.parse("2026-09-20T02:24:27Z"),
    },
    { label: "CASE B", startTs: Date.parse("2026-09-20T02:35:59Z") },
    {
      label: "CASE C (clean immediate recovery)",
      startTs: Date.parse("2026-09-20T03:08:05Z"),
    },
  ];
  for (const cs of caseTimestamps) {
    const c = p90Candidates.find(
      (x) => Math.abs(x.startTs - cs.startTs) < 2000,
    );
    if (!c || !c.timeline) {
      console.log(`\n${cs.label}: not found or no usable timeline.`);
      continue;
    }
    console.log(
      `\n${cs.label}: ${c.direction} ${fmtDate(c.startTs)} -> ${fmtDate(c.endTs)}  dirLiq=${fmtUsd(c.dirLiqUsd)}  P90(ref)=${fmtUsd(c.causalP90)}  cohort=${c.cohort ?? "N/A"}`,
    );
    console.log(
      `Start OI: ${fmtBtc(c.startOi)}   Max OI during process: ${fmtBtc(c.oiMaxDuringProcess)}   Min OI: ${fmtBtc(c.oiMinDuringProcess)}   OI at candidate END: ${fmtBtc(c.oiAtEnd)}`,
    );
    console.log(`Net OI START->END: ${fmtBtcDelta(c.netOIStartToEnd)}`);
    if (c.confirmTs === null) {
      console.log(
        `REVERSAL_CONFIRMATION: NOT FOUND within ${TIMELINE_HORIZON_MIN}m.`,
      );
      continue;
    }
    console.log(
      `REVERSAL_CONFIRMATION: ${fmtDate(c.confirmTs)}   OI at confirmation: ${fmtBtc(c.confirmRow.oi)}`,
    );
    console.log(
      `Net OI remaining (confirmation - start): ${fmtBtcDelta(c.netOIRemainingAtConfirm)} (${fmtPct(c.netOIRemainingPctAtConfirm)})`,
    );
    console.log(
      `Current learned response direction: ${c.responseDirection}   recentEfficiency at confirm: ${c.confirmRow.recentEfficiency.toFixed(5)}`,
    );
    console.log(`Implied move from remaining OI: ${fmtPct(c.impliedMovePct)}`);
    console.log(
      `Price already moved before confirmation: dropFromStart=${fmtPct(c.dropAlready)}  recoveryAlready=${fmtPct(c.recoveryAlready)}  remainingDistanceToStartPrice=${fmtPct(c.remainingToStart)}`,
    );
    console.log(`Actual subsequent path:`);
    for (const h of OUTCOME_HORIZONS_MIN) {
      const o = c.actualOutcome[h];
      if (!o) {
        console.log(`  ${h}m: N/A`);
        continue;
      }
      console.log(
        `  ${h}m: MFE=${fmtPct(o.MFE)}  MAE=${fmtPct(o.MAE)}  error(actual-implied)=${fmtPct(o.errorVsImplied)}  ratio=${o.ratioVsImplied?.toFixed(2) ?? "N/A"}`,
      );
    }
  }

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
