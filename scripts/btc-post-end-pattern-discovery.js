// BTC POST-END PATTERN DISCOVERY -- new, standalone, PURELY
// EXPLORATORY RESEARCH (not production). Fixed 10-minute baseline
// REUSED VERBATIM. Does NOT impose or assert a confirmation rule.
//
// METHOD:
//  1. Fixed episode END = T0 (unchanged from the baseline).
//  2. RETROSPECTIVE outcome cohorts (FAST vs CONTINUATION), built from
//     ACTUAL post-END MFE30, purely for RESEARCH GROUPING -- never a
//     causal feature, computed only to compare what the causal
//     candidate signals below looked like for each group.
//  3. At a small, DISCLOSED, fixed set of TIME-BASED OBSERVATION
//     CHECKPOINTS post-END (1/2/3/5/10/15/20/30 min) -- used ONLY as
//     a measurement grid for descriptive comparison, NOT as a
//     decision rule -- compute several CAUSAL candidate signals (each
//     using only data <= that checkpoint):
//       cumDirProgress since END (%)
//       netOI since END (BTC, %)
//       grossOI since END (BTC)
//       sign of cumDirProgress (adverse-continuing vs favorable)
//       whether a NEW adverse extreme beyond priceEnd has occurred
//       raw efficiency ratio cumDirProgress/grossOI (descriptive only)
//  4. Print, PER CHECKPOINT, the FAST vs CONTINUATION comparison for
//     every signal. Print sample chronological paths for extreme
//     cases. NO single rule is asserted anywhere in this file.
//
//   node scripts/btc-post-end-pattern-discovery.js
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
const CHECKPOINTS_MIN = [1, 2, 3, 5, 10, 15, 20, 30]; // measurement grid ONLY, not a decision rule
const OUTCOME_HORIZONS_MIN = [30, 60];

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
  console.log(
    "EXPLORATORY RESEARCH ONLY -- no rule is imposed or asserted anywhere in this script.",
  );
  console.log("=".repeat(170));

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + Math.max(...OUTCOME_HORIZONS_MIN) * 60_000;

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
  // BUILD POST-END TIMELINE + CHECKPOINT SIGNALS + OUTCOME (for cohorting)
  // ============================================================
  for (const c of allCandidates) {
    const revUp = c.direction === "LONG";
    const maxCapTs = c.endTs + Math.max(...OUTCOME_HORIZONS_MIN) * 60000;
    const maxCapIdx = nearestObsIdxAtOrBefore(allOi, maxCapTs, c.endIdx);
    if (maxCapIdx < c.endIdx) {
      c.timeline = null;
      continue;
    }

    let cumGrossOI = 0;
    let newAdverseExtremeMade = false;
    let runningExtreme = c.priceEnd;
    const checkpointData = {};
    let cpi = 0;

    const rows = [];
    for (let k = c.endIdx; k <= maxCapIdx; k++) {
      const p = priceAtOrBeforeIdx(allOi, k);
      if (p === null) continue;
      if (k > c.endIdx) {
        const dOi = allOi[k].contracts - allOi[k - 1].contracts;
        cumGrossOI += Math.abs(dOi);
      }
      const netOi = allOi[k].contracts - allOi[c.endIdx].contracts;
      const dirProgressRaw = revUp ? c.priceEnd - p : p - c.priceEnd;
      const cumDirProgress = (dirProgressRaw / c.priceEnd) * 100;
      if (revUp ? p < runningExtreme : p > runningExtreme) {
        runningExtreme = p;
        newAdverseExtremeMade = true;
      }
      rows.push({
        ts: allOi[k].ts,
        price: p,
        oi: allOi[k].contracts,
        cumGrossOI,
        netOi,
        cumDirProgress,
        newAdverseExtremeMade,
      });

      const minutesElapsed = (allOi[k].ts - c.endTs) / 60000;
      while (
        cpi < CHECKPOINTS_MIN.length &&
        minutesElapsed >= CHECKPOINTS_MIN[cpi]
      ) {
        checkpointData[CHECKPOINTS_MIN[cpi]] = {
          cumDirProgress,
          netOi,
          netOiPct: (netOi / allOi[c.endIdx].contracts) * 100,
          cumGrossOI,
          newAdverseExtremeMade,
          efficiencyRatio: cumGrossOI > 0 ? cumDirProgress / cumGrossOI : null,
        };
        cpi++;
      }
    }
    c.timeline = rows;
    c.checkpointData = checkpointData;

    // Outcome (research grouping ONLY -- actual, retrospective).
    c.outcome = {};
    for (const h of OUTCOME_HORIZONS_MIN) {
      const hRows = rows.filter((r) => r.ts <= c.endTs + h * 60000);
      if (hRows.length === 0) {
        c.outcome[h] = null;
        continue;
      }
      let fav = null,
        adv = null;
      for (const r of hRows) {
        if (revUp) {
          if (fav === null || r.price > fav) fav = r.price;
          if (adv === null || r.price < adv) adv = r.price;
        } else {
          if (fav === null || r.price < fav) fav = r.price;
          if (adv === null || r.price > adv) adv = r.price;
        }
      }
      const MFE = revUp
        ? (fav / c.priceEnd - 1) * 100
        : (c.priceEnd / fav - 1) * 100;
      const MAE = revUp
        ? (c.priceEnd / adv - 1) * 100
        : (adv / c.priceEnd - 1) * 100;
      c.outcome[h] = { MFE, MAE };
    }
  }

  // ---- Research cohorts (retrospective, MFE30-based rank split) ----
  const withOutcome = allCandidates.filter((c) => c.timeline && c.outcome[30]);
  const mfe30Vals = withOutcome
    .map((c) => c.outcome[30].MFE)
    .sort((a, b) => a - b);
  const mfe30Median = percentile(mfe30Vals, 50),
    mfe30P75 = percentile(mfe30Vals, 75),
    mfe30P25 = percentile(mfe30Vals, 25);
  console.log(
    `Research cohort definition (RETROSPECTIVE, for grouping only -- never causal): FAST = MFE30 >= P75(${fmtPct(mfe30P75)}); CONTINUATION = MFE30 < P25(${fmtPct(mfe30P25)}); MIDDLE = everything between (excluded from the FAST/CONTINUATION contrast below).\n`,
  );
  withOutcome.forEach((c) => {
    c.cohort =
      c.outcome[30].MFE >= mfe30P75
        ? "FAST"
        : c.outcome[30].MFE < mfe30P25
          ? "CONTINUATION"
          : "MIDDLE";
  });
  const fastEps = withOutcome.filter((c) => c.cohort === "FAST");
  const contEps = withOutcome.filter((c) => c.cohort === "CONTINUATION");
  console.log(
    `FAST: N=${fastEps.length}   CONTINUATION: N=${contEps.length}\n`,
  );

  // ============================================================
  // OUTCOME EVIDENCE (MFE/MAE) BY COHORT
  // ============================================================
  console.log(
    `${"=".repeat(170)}\nOUTCOME EVIDENCE BY COHORT (actual MFE/MAE)\n${"=".repeat(170)}`,
  );
  for (const [label, cs] of [
    ["FAST", fastEps],
    ["CONTINUATION", contEps],
  ]) {
    console.log(`\n${label}: N=${cs.length}`);
    for (const h of OUTCOME_HORIZONS_MIN) {
      const mfe = cs
        .map((c) => c.outcome[h]?.MFE)
        .filter((v) => v !== null && v !== undefined);
      const mae = cs
        .map((c) => c.outcome[h]?.MAE)
        .filter((v) => v !== null && v !== undefined);
      console.log(
        `  ${h}m: median MFE=${fmtPct(median(mfe))}  median MAE=${fmtPct(median(mae))}`,
      );
    }
  }

  // ============================================================
  // CANDIDATE CAUSAL SIGNALS, PER CHECKPOINT, BY COHORT
  // ============================================================
  console.log(
    `\n${"=".repeat(170)}\nCANDIDATE CAUSAL SIGNALS PER CHECKPOINT (measurement grid only, no rule imposed)\n${"=".repeat(170)}`,
  );
  for (const cp of CHECKPOINTS_MIN) {
    console.log(`\n--- Checkpoint: ${cp}m after END ---`);
    for (const [label, cs] of [
      ["FAST", fastEps],
      ["CONTINUATION", contEps],
    ]) {
      const withCp = cs.filter((c) => c.checkpointData[cp]);
      if (withCp.length === 0) {
        console.log(`  ${label}: N=0`);
        continue;
      }
      const cumDirVals = withCp.map((c) => c.checkpointData[cp].cumDirProgress);
      const netOiVals = withCp.map((c) => c.checkpointData[cp].netOi);
      const netOiPctVals = withCp.map((c) => c.checkpointData[cp].netOiPct);
      const grossOiVals = withCp.map((c) => c.checkpointData[cp].cumGrossOI);
      const effVals = withCp
        .map((c) => c.checkpointData[cp].efficiencyRatio)
        .filter((v) => v !== null);
      const pctAdverseContinuing =
        (withCp.filter((c) => c.checkpointData[cp].cumDirProgress > 0).length /
          withCp.length) *
        100;
      const pctNewAdverseExtreme =
        (withCp.filter((c) => c.checkpointData[cp].newAdverseExtremeMade)
          .length /
          withCp.length) *
        100;
      console.log(
        `  ${label}: N=${withCp.length}  cumDirProgress median=${fmtPct(median(cumDirVals))}  netOI median=${fmtBtcDelta(median(netOiVals))} (${median(netOiPctVals)?.toFixed(4)}%)  grossOI median=${fmtBtc(median(grossOiVals))}  efficiencyRatio median=${median(effVals)?.toFixed(5) ?? "N/A"}  %stillAdverseSign=${pctAdverseContinuing.toFixed(1)}%  %madeNewAdverseExtreme=${pctNewAdverseExtreme.toFixed(1)}%`,
      );
    }
  }

  // ============================================================
  // SAMPLE CHRONOLOGICAL PATHS -- extreme cases
  // ============================================================
  console.log(
    `\n${"=".repeat(200)}\nSAMPLE CHRONOLOGICAL PATHS -- 3 most extreme FAST, 3 most extreme CONTINUATION\n${"=".repeat(200)}`,
  );
  const topFast = [...fastEps]
    .sort((a, b) => b.outcome[30].MFE - a.outcome[30].MFE)
    .slice(0, 3);
  const topCont = [...contEps]
    .sort((a, b) => a.outcome[30].MFE - b.outcome[30].MFE)
    .slice(0, 3);
  for (const [label, cs] of [
    ["FAST", topFast],
    ["CONTINUATION", topCont],
  ]) {
    for (const c of cs) {
      console.log(
        `\n${label} -- ${c.direction} END=${fmtDate(c.endTs)}  MFE30=${fmtPct(c.outcome[30].MFE)}  MAE30=${fmtPct(c.outcome[30].MAE)}`,
      );
      console.log(
        "checkpoint(m) | cumDirProgress% | netOI      | grossOI    | effRatio   | newAdverseExtreme",
      );
      for (const cp of CHECKPOINTS_MIN) {
        const d = c.checkpointData[cp];
        if (!d) continue;
        console.log(
          `${String(cp).padEnd(13)} | ${fmtPct(d.cumDirProgress).padEnd(16)} | ${fmtBtcDelta(d.netOi).padEnd(10)} | ${fmtBtc(d.cumGrossOI).padEnd(10)} | ${(d.efficiencyRatio !== null ? d.efficiencyRatio.toFixed(5) : "N/A").padEnd(10)} | ${d.newAdverseExtremeMade}`,
        );
      }
    }
  }

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
