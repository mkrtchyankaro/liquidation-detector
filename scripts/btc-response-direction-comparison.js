// BTC RESPONSE_DIRECTION COMPARISON -- new, standalone. Baseline
// candidate construction, NET_OI, and f_END (recentEfficiencyEnd)
// REUSED VERBATIM, byte-identical to btc-net-oi-implied-move-fixed-end.js.
// NO new detector, NO new threshold, NO change to any existing formula.
//
// Splits the existing episodes ONLY by RESPONSE_DIRECTION at fixed
// episode END (FAVORABLE-LEANING / ADVERSE-CONTINUING / FLAT) and
// compares their empirical post-END outcome distributions.
//
//   node scripts/btc-response-direction-comparison.js
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
const RECENT_WINDOW_FRACTION = 0.25;
const OUTCOME_HORIZONS_MIN = [5, 10, 15, 30, 60];
const FAV_CHECK_PCT = [0.1, 0.2, 0.3];
const ADV_CHECK_PCT = [0.1, 0.2, 0.3];

function fmtDate(ms) {
  return ms === null || ms === undefined
    ? "N/A"
    : new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
function fmtUsd(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
        c.causalP90 = null;
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
  console.log(`ALL live-evaluable episodes: ${allCandidates.length}\n`);

  // ---- NET_OI, f_END, RESPONSE_DIRECTION (verbatim) + extended outcome capture ----
  for (const c of allCandidates) {
    const revUp = c.direction === "LONG";
    const oiStart = allOi[c.startIdx].contracts;
    const oiEnd = allOi[c.endIdx].contracts;
    c.oiStart = oiStart;
    c.oiEnd = oiEnd;
    c.netOi = oiEnd - oiStart;

    let cumGrossOI = 0,
      cumDirProgress = 0;
    const cumGrossArr = [],
      cumProgArr = [];
    for (let k = c.startIdx; k <= c.endIdx; k++) {
      const p = priceAtOrBeforeIdx(allOi, k);
      if (p === null) continue;
      if (k > c.startIdx) {
        const dOi = allOi[k].contracts - allOi[k - 1].contracts;
        cumGrossOI += Math.abs(dOi);
      }
      const dirProgressRaw = revUp ? c.priceStart - p : p - c.priceStart;
      cumDirProgress = (dirProgressRaw / c.priceStart) * 100;
      cumGrossArr.push(cumGrossOI);
      cumProgArr.push(cumDirProgress);
    }
    let recentEfficiencyEnd = null;
    if (cumGrossArr.length > 1) {
      const n = cumGrossArr.length;
      const finalGross = cumGrossArr[n - 1],
        finalProg = cumProgArr[n - 1];
      const target = (1 - RECENT_WINDOW_FRACTION) * finalGross;
      let refIdx = 0;
      while (refIdx < n - 1 && cumGrossArr[refIdx] < target) refIdx++;
      const recentGross = finalGross - cumGrossArr[refIdx];
      const recentProg = finalProg - cumProgArr[refIdx];
      recentEfficiencyEnd = recentGross > 0 ? recentProg / recentGross : null;
    }
    c.recentEfficiencyEnd = recentEfficiencyEnd;
    c.responseDirectionAtEnd =
      recentEfficiencyEnd === null
        ? "N/A"
        : recentEfficiencyEnd < 0
          ? "FAVORABLE-LEANING"
          : recentEfficiencyEnd > 0
            ? "ADVERSE-CONTINUING"
            : "FLAT";

    // Extended (descriptive-only) per-horizon outcome: MFE, MAE, timeToMFE, threshold-reached flags.
    c.horizons = {};
    const maxHorizonEndTs = c.endTs + Math.max(...OUTCOME_HORIZONS_MIN) * 60000;
    const maxHorizonEndIdx = nearestObsIdxAtOrBefore(
      allOi,
      maxHorizonEndTs,
      c.endIdx,
    );
    if (maxHorizonEndIdx < c.endIdx) continue;
    for (const h of OUTCOME_HORIZONS_MIN) {
      const hEndIdx = nearestObsIdxAtOrBefore(
        allOi,
        c.endTs + h * 60000,
        c.endIdx,
      );
      if (hEndIdx < c.endIdx) {
        c.horizons[h] = null;
        continue;
      }
      let fav = null,
        favTs = null,
        adv = null;
      for (let k = c.endIdx; k <= hEndIdx; k++) {
        const p = priceAtOrBeforeIdx(allOi, k);
        if (p === null) continue;
        if (revUp) {
          if (fav === null || p > fav) {
            fav = p;
            favTs = allOi[k].ts;
          }
          if (adv === null || p < adv) adv = p;
        } else {
          if (fav === null || p < fav) {
            fav = p;
            favTs = allOi[k].ts;
          }
          if (adv === null || p > adv) adv = p;
        }
      }
      const MFE = revUp
        ? (fav / c.priceEnd - 1) * 100
        : (c.priceEnd / fav - 1) * 100;
      const MAE = revUp
        ? (c.priceEnd / adv - 1) * 100
        : (adv / c.priceEnd - 1) * 100;
      const minutesToMFE = (favTs - c.endTs) / 60000;
      const favHit = {};
      FAV_CHECK_PCT.forEach((t) => {
        favHit[t] = MFE >= t;
      });
      const advHit = {};
      ADV_CHECK_PCT.forEach((t) => {
        advHit[t] = MAE >= t;
      });
      c.horizons[h] = { MFE, MAE, minutesToMFE, favHit, advHit };
    }
  }

  // ============================================================
  // COMPARISON TABLE, by RESPONSE_DIRECTION, split LONG/SHORT
  // ============================================================
  function printGroup(label, cs) {
    console.log(`\n${label}: N=${cs.length}`);
    if (cs.length === 0) return;
    for (const h of OUTCOME_HORIZONS_MIN) {
      const withH = cs.filter((c) => c.horizons[h]);
      const mfe = withH.map((c) => c.horizons[h].MFE).sort((a, b) => a - b);
      const mae = withH.map((c) => c.horizons[h].MAE).sort((a, b) => a - b);
      const t2mfe = withH.map((c) => c.horizons[h].minutesToMFE);
      const mfeGtMae = withH.filter(
        (c) => c.horizons[h].MFE > c.horizons[h].MAE,
      ).length;
      console.log(`  --- ${h}m --- N=${withH.length}`);
      console.log(
        `    MFE: median=${fmtPct(median(mfe))} P25=${fmtPct(percentile(mfe, 25))} P75=${fmtPct(percentile(mfe, 75))}`,
      );
      console.log(
        `    MAE: median=${fmtPct(median(mae))} P25=${fmtPct(percentile(mae, 25))} P75=${fmtPct(percentile(mae, 75))}`,
      );
      console.log(
        `    MFE/MAE ratio (median MFE / median MAE): ${median(mae) ? (median(mfe) / median(mae)).toFixed(2) : "N/A"}`,
      );
      console.log(`    time-to-MFE median: ${fmtMin(median(t2mfe))}`);
      console.log(
        `    % MFE>MAE: ${withH.length ? ((mfeGtMae / withH.length) * 100).toFixed(1) : "N/A"}%`,
      );
      for (const t of FAV_CHECK_PCT) {
        const n = withH.filter((c) => c.horizons[h].favHit[t]).length;
        console.log(
          `    % reaching +${t}% favorable: ${withH.length ? ((n / withH.length) * 100).toFixed(1) : "N/A"}%`,
        );
      }
      for (const t of ADV_CHECK_PCT) {
        const n = withH.filter((c) => c.horizons[h].advHit[t]).length;
        console.log(
          `    % hitting -${t}% adverse: ${withH.length ? ((n / withH.length) * 100).toFixed(1) : "N/A"}%`,
        );
      }
    }
  }

  const withHorizons = allCandidates.filter(
    (c) => Object.keys(c.horizons ?? {}).length > 0,
  );
  console.log(
    `${"=".repeat(170)}\nRESPONSE_DIRECTION COMPARISON\n${"=".repeat(170)}`,
  );
  for (const dirLabel of ["ALL (LONG+SHORT)", "LONG", "SHORT"]) {
    const base =
      dirLabel === "ALL (LONG+SHORT)"
        ? withHorizons
        : withHorizons.filter((c) => c.direction === dirLabel);
    console.log(`\n${"#".repeat(80)}\n${dirLabel}\n${"#".repeat(80)}`);
    printGroup(
      "FAVORABLE-LEANING",
      base.filter((c) => c.responseDirectionAtEnd === "FAVORABLE-LEANING"),
    );
    printGroup(
      "ADVERSE-CONTINUING",
      base.filter((c) => c.responseDirectionAtEnd === "ADVERSE-CONTINUING"),
    );
    printGroup(
      "FLAT",
      base.filter((c) => c.responseDirectionAtEnd === "FLAT"),
    );
  }

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
