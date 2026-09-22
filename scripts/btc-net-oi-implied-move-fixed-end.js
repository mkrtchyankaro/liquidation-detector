// BTC NET_OI / IMPLIED_MOVE AT FIXED EPISODE END -- new, standalone.
// Replaces (discards) the REVERSAL_CONFIRMATION version. NO
// intermediate timestamp search. Baseline candidate construction
// REUSED VERBATIM from btc-simple-10min-window.js, unmodified.
//
// ============================================================
// THE ENTIRE CALCULATION, per episode:
//
//  1. NET_OI = OI_END - OI_START   (the ONLY "remaining OI" concept
//     used here -- a single fixed-boundary value, not an intermediate
//     search).
//
//  2. f_END: the causal ΔOI->ΔPrice regime AS IT EXISTS AT END, using
//     ONLY observations from episode START through END (nothing after
//     END). Concretely: recentEfficiencyEnd = the SAME self-relative
//     ratio used in the prior efficiency script (recent = the most
//     recent 25% of cumulative gross OI activity accumulated WITHIN
//     [START,END], via a monotonic two-pointer scan) -- evaluated
//     ONCE, at the single observation closest to END. This ratio's
//     OWN SIGN determines the "current observed price-response
//     direction" at END, from data available up to END only.
//
//  3. IMPLIED_MOVE (favorable-positive convention) =
//         -1 x recentEfficiencyEnd x NET_OI
//     If recentEfficiencyEnd is undefined (near-zero recent gross OI
//     activity denominator), IMPLIED_MOVE is reported as N/A rather
//     than an unstable number from a near-zero denominator.
//
//  4. Compare IMPLIED_MOVE against ACTUAL post-END MFE/MAE at
//     5/10/15/30/60m (same math as btc-post-episode-outcomes.js).
//
// P90/P95 appear only as descriptive reference fields -- NOT used to
// filter which episodes are analyzed (ALL live-evaluable episodes are
// included) and NOT used anywhere in the NET_OI/f_END/IMPLIED_MOVE
// calculation itself.
//
//   node scripts/btc-net-oi-implied-move-fixed-end.js
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
const RECENT_WINDOW_FRACTION = 0.25; // same convention as the prior efficiency script, reused consistently
const OUTCOME_HORIZONS_MIN = [5, 10, 15, 30, 60];

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
    "1. Baseline candidate construction identical to btc-simple-10min-window.js. No intermediate confirmation timestamp anywhere.",
  );
  console.log(
    "2. NET_OI = OI_END - OI_START only. f_END is computed using ONLY [START,END] observations -- nothing after END.",
  );
  console.log(
    "3. IMPLIED_MOVE is computed strictly from f_END and NET_OI, both fixed at/before END.",
  );
  console.log(
    "4. Actual MFE/MAE horizons are computed strictly AFTER END and never feed back into NET_OI or f_END.",
  );
  console.log(
    "5. P90/P95 are descriptive reference only -- not used to select episodes or in the NET_OI/f_END/IMPLIED_MOVE math.\n",
  );

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
        c.causalP95 = null;
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
  const allCandidates = [...longC, ...shortC]
    .filter((c) => c.liveEvaluable && c.priceStart !== null)
    .sort((a, b) => a.startTs - b.startTs);
  allCandidates.forEach((c, i) => {
    c.id = `E${String(i + 1).padStart(3, "0")}`;
  });
  console.log(`ALL live-evaluable episodes: ${allCandidates.length}\n`);

  // ============================================================
  // PER-EPISODE: NET_OI, f_END, IMPLIED_MOVE, ACTUAL OUTCOME
  // ============================================================
  for (const c of allCandidates) {
    const revUp = c.direction === "LONG";
    const oiStart = allOi[c.startIdx].contracts;
    const oiEnd = allOi[c.endIdx].contracts;
    c.oiStart = oiStart;
    c.oiEnd = oiEnd;
    c.netOi = oiEnd - oiStart;

    // f_END: recentEfficiency evaluated ONCE, at END, using only [START,END].
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
    // FIX: recentEfficiencyEnd's denominator (recentGross) is always
    // >=0 (a sum of |ΔOI|), while NET_OI is SIGNED -- multiplying a
    // signed value by an unsigned-denominator ratio mixes units and
    // can flip sign unpredictably when NET_OI<0. Magnitude and
    // direction are now computed SEPARATELY and then combined
    // explicitly, per the operator's audit.
    c.impliedMoveMagnitude =
      recentEfficiencyEnd !== null
        ? Math.abs(recentEfficiencyEnd) * Math.abs(c.netOi)
        : null;
    c.impliedFavorableMove =
      c.impliedMoveMagnitude === null
        ? null
        : c.responseDirectionAtEnd === "FAVORABLE-LEANING"
          ? c.impliedMoveMagnitude
          : c.responseDirectionAtEnd === "ADVERSE-CONTINUING"
            ? -c.impliedMoveMagnitude
            : 0; // FLAT
    c.impliedMove = c.impliedFavorableMove; // kept for downstream error/ratio calc below, now sign-consistent

    // Actual post-END outcome, same math as btc-post-episode-outcomes.js.
    const maxHorizonEndTs = c.endTs + Math.max(...OUTCOME_HORIZONS_MIN) * 60000;
    const maxHorizonEndIdx = nearestObsIdxAtOrBefore(
      allOi,
      maxHorizonEndTs,
      c.endIdx,
    );
    c.actualOutcome = {};
    if (maxHorizonEndIdx >= c.endIdx) {
      for (const h of OUTCOME_HORIZONS_MIN) {
        const hEndTs = c.endTs + h * 60000;
        const hEndIdx = nearestObsIdxAtOrBefore(allOi, hEndTs, c.endIdx);
        if (hEndIdx < c.endIdx) {
          c.actualOutcome[h] = null;
          continue;
        }
        let fav = null,
          adv = null;
        for (let k = c.endIdx; k <= hEndIdx; k++) {
          const p = priceAtOrBeforeIdx(allOi, k);
          if (p === null) continue;
          if (revUp) {
            if (fav === null || p > fav) fav = p;
            if (adv === null || p < adv) adv = p;
          } else {
            if (fav === null || p < fav) fav = p;
            if (adv === null || p > adv) adv = p;
          }
        }
        const MFE = revUp
          ? (fav / c.priceEnd - 1) * 100
          : (c.priceEnd / fav - 1) * 100;
        const MAE = revUp
          ? (c.priceEnd / adv - 1) * 100
          : (adv / c.priceEnd - 1) * 100;
        c.actualOutcome[h] = {
          MFE,
          MAE,
          error: c.impliedMove !== null ? MFE - c.impliedMove : null,
          ratio:
            c.impliedMove && c.impliedMove !== 0 ? MFE / c.impliedMove : null,
        };
      }
    }
  }

  // ============================================================
  // TABLE -- ALL EPISODES (compact)
  // ============================================================
  console.log(
    `${"=".repeat(200)}\nALL EPISODES -- NET_OI / IMPLIED_MOVE vs ACTUAL\n${"=".repeat(200)}`,
  );
  console.log(
    "ID    | DIR   | END                      | OI_START   | OI_END     | NET_OI     | f_END(recentEff) | RESPONSE_DIRECTION | IMPLIED_MAGNITUDE | IMPLIED_FAVORABLE | MFE30    | err30    | MFE60    | err60",
  );
  allCandidates.forEach((c) => {
    const o30 = c.actualOutcome[30],
      o60 = c.actualOutcome[60];
    console.log(
      `${c.id} | ${c.direction.padEnd(5)} | ${fmtDate(c.endTs)} | ${fmtBtc(c.oiStart).padEnd(10)} | ${fmtBtc(c.oiEnd).padEnd(10)} | ${fmtBtcDelta(c.netOi).padEnd(10)} | ${(c.recentEfficiencyEnd !== null ? c.recentEfficiencyEnd.toFixed(5) : "N/A").padEnd(17)} | ${c.responseDirectionAtEnd.padEnd(19)} | ${(c.impliedMoveMagnitude !== null ? fmtPct(c.impliedMoveMagnitude) : "N/A").padEnd(18)} | ${(c.impliedFavorableMove !== null ? fmtPct(c.impliedFavorableMove) : "N/A").padEnd(18)} | ${(o30 ? fmtPct(o30.MFE) : "N/A").padEnd(8)} | ${(o30 ? fmtPct(o30.error) : "N/A").padEnd(8)} | ${(o60 ? fmtPct(o60.MFE) : "N/A").padEnd(8)} | ${o60 ? fmtPct(o60.error) : "N/A"}`,
    );
  });

  // ============================================================
  // SUMMARY STATISTICS
  // ============================================================
  console.log(`\n${"=".repeat(170)}\nSUMMARY STATISTICS\n${"=".repeat(170)}`);
  const withImplied = allCandidates.filter((c) => c.impliedMove !== null);
  console.log(
    `Episodes with a valid f_END (non-degenerate recent-window denominator): ${withImplied.length} of ${allCandidates.length}`,
  );
  console.log(
    `NET_OI positive: ${allCandidates.filter((c) => c.netOi > 0).length}   negative: ${allCandidates.filter((c) => c.netOi < 0).length}   ~zero: ${allCandidates.filter((c) => c.netOi === 0).length}`,
  );
  console.log(
    `response direction at END: FAVORABLE-LEANING=${withImplied.filter((c) => c.responseDirectionAtEnd === "FAVORABLE-LEANING").length}  ADVERSE-CONTINUING=${withImplied.filter((c) => c.responseDirectionAtEnd === "ADVERSE-CONTINUING").length}`,
  );
  for (const h of OUTCOME_HORIZONS_MIN) {
    const errs = withImplied
      .map((c) => c.actualOutcome[h]?.error)
      .filter((v) => v !== null && v !== undefined);
    const ratios = withImplied
      .map((c) => c.actualOutcome[h]?.ratio)
      .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    console.log(
      `${h}m: median error(actual-implied)=${fmtPct(median(errs))}  median ratio(actual/implied)=${median(ratios)?.toFixed(2) ?? "N/A"}  N(error)=${errs.length}`,
    );
  }

  // ============================================================
  // 3 REQUESTED CASES, DETAILED
  // ============================================================
  console.log(`\n${"=".repeat(170)}\nDETAILED CASES\n${"=".repeat(170)}`);
  const caseTimestamps = [
    Date.parse("2026-09-20T02:24:27Z"),
    Date.parse("2026-09-20T02:35:59Z"),
    Date.parse("2026-09-20T03:08:05Z"),
  ];
  for (const ts of caseTimestamps) {
    const c = allCandidates.find(
      (x) => Math.abs(x.startTs - ts) < 2000 && x.direction === "LONG",
    );
    if (!c) {
      console.log(`\n${fmtDate(ts)}: NOT FOUND.`);
      continue;
    }
    console.log(
      `\n${c.direction} ${fmtDate(c.startTs)} -> ${fmtDate(c.endTs)}  dirLiq(ref)=${fmtUsd(allLiq.filter((e) => e.timestamp >= c.startTs && e.timestamp <= c.endTs && e.victim === c.direction).reduce((a, e) => a + (e.quoteQty ?? 0), 0))}  P90(ref)=${fmtUsd(c.causalP90)}`,
    );
    console.log(
      `OI_START=${fmtBtc(c.oiStart)}   OI_END=${fmtBtc(c.oiEnd)}   NET_OI=${fmtBtcDelta(c.netOi)}`,
    );
    console.log(
      `recentEfficiencyEnd (f_END): ${c.recentEfficiencyEnd !== null ? c.recentEfficiencyEnd.toFixed(6) : "N/A"}   RESPONSE_DIRECTION: ${c.responseDirectionAtEnd}`,
    );
    console.log(
      `IMPLIED_MOVE_MAGNITUDE: ${c.impliedMoveMagnitude !== null ? fmtPct(c.impliedMoveMagnitude) : "N/A"}   IMPLIED_FAVORABLE_MOVE: ${c.impliedFavorableMove !== null ? fmtPct(c.impliedFavorableMove) : "N/A"}`,
    );
    console.log(`Actual subsequent path:`);
    for (const h of OUTCOME_HORIZONS_MIN) {
      const o = c.actualOutcome[h];
      if (!o) {
        console.log(`  ${h}m: N/A`);
        continue;
      }
      console.log(
        `  ${h}m: MFE=${fmtPct(o.MFE)}  MAE=${fmtPct(o.MAE)}  error(actual-implied)=${fmtPct(o.error)}  ratio=${o.ratio !== null && Number.isFinite(o.ratio) ? o.ratio.toFixed(2) : "N/A"}`,
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
