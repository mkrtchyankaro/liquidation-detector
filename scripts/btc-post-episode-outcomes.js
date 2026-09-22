// BTC POST-EPISODE OUTCOME RESEARCH -- new, standalone script.
// Baseline candidate construction REUSED VERBATIM from
// btc-simple-10min-window.js. No structural END detector. No
// Page-Hinkley/OLS/kNN/t-test/ZOI/ATR. No WIN/LOSS/GOOD/BAD labels
// anywhere. Pure descriptive outcome measurement (MFE/MAE/OI path)
// after each fixed 10-minute liquidation candidate.
//
//   node scripts/btc-post-episode-outcomes.js
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
const HORIZONS_MIN = [30, 60, 120];
const FAV_THRESHOLDS_PCT = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
const ADV_THRESHOLDS_PCT = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];

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
    : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
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
function percentileRank(sortedPop, x) {
  if (sortedPop.length === 0) return null;
  let c = 0;
  for (const v of sortedPop) if (v <= x) c++;
  return (c / sortedPop.length) * 100;
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
function distStats(label, arr) {
  const s = [...arr]
    .filter((v) => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  return `${label}: N=${s.length} P25=${percentile(s, 25)?.toFixed(3)} median=${percentile(s, 50)?.toFixed(3)} P75=${percentile(s, 75)?.toFixed(3)} P90=${percentile(s, 90)?.toFixed(3)}`;
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
  console.log("METHODOLOGY");
  console.log("=".repeat(170));
  console.log(
    "Candidate construction: REUSED VERBATIM from btc-simple-10min-window.js (fixed 10min window, frozen direction, no structural END detector, causal prior-3-day same-side P90/P100).",
  );
  console.log(
    "Post-candidate outcome: MFE/MAE from candidateEndPrice, recovery from the candidate's own internal extreme, threshold-crossing chronology, OI path -- for 30/60/120min horizons.",
  );
  console.log(
    "No WIN/LOSS/GOOD/BAD labels anywhere in this script. No TP/SL. No model fitting.\n",
  );

  console.log("CAUSALITY AUDIT");
  console.log("1. Candidate construction identical to the baseline script.");
  console.log(
    "2. Post-candidate measurements use ONLY observations AFTER the candidate's own END -- never influence candidate START/END/decision.",
  );
  console.log(
    "3. MFE/MAE/OI-path are annotations computed strictly after the candidate is already finalized.\n",
  );

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + Math.max(...HORIZONS_MIN) * 60_000; // extra buffer for the longest post-candidate horizon

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
    `DATASET: raw liquidation events=${allLiq.length}  OI+price observations=${allOi.length}  load window=${isoUtc(loadStartMs)} -> ${isoUtc(loadEndMs)}`,
  );
  if (allLiq.length === 0 || allOi.length < 10) {
    console.log("Insufficient data.");
    await client.close();
    return;
  }

  // ============================================================
  // BASELINE CANDIDATE CONSTRUCTION -- VERBATIM
  // ============================================================
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
      priceEnd = null,
      oiStart = null,
      oiEnd = null,
      netOi = null,
      posOi = null,
      negOi = null,
      grossOi = null;
    let extremePrice = null,
      extremeTs = null,
      extremeIdx = null;
    if (startIdx >= 0 && endIdx >= 0 && endIdx >= startIdx) {
      priceStart = priceAtOrBeforeIdx(allOi, startIdx);
      priceEnd = priceAtOrBeforeIdx(allOi, endIdx);
      oiStart = allOi[startIdx].contracts;
      oiEnd = allOi[endIdx].contracts;
      netOi = oiEnd - oiStart;
      let pos = 0,
        neg = 0;
      for (let k = startIdx + 1; k <= endIdx; k++) {
        const d = allOi[k].contracts - allOi[k - 1].contracts;
        if (d > 0) pos += d;
        else neg += d;
      }
      posOi = pos;
      negOi = neg;
      grossOi = pos - neg;
      for (let k = startIdx; k <= endIdx; k++) {
        const p = priceAtOrBeforeIdx(allOi, k);
        if (p === null) continue;
        if (
          extremePrice === null ||
          (direction === "LONG" ? p < extremePrice : p > extremePrice)
        ) {
          extremePrice = p;
          extremeTs = allOi[k].ts;
          extremeIdx = k;
        }
      }
    }
    const dirLiqUsd = events
      .filter((e) => e.victim === direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const oppLiqUsd = events
      .filter((e) => e.victim !== direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const frozenDirEventCount = events.filter(
      (e) => e.victim === direction,
    ).length;
    candidates.push({
      direction,
      startTs,
      endTs,
      dirLiqUsd,
      oppLiqUsd,
      totalLiqUsd: dirLiqUsd + oppLiqUsd,
      eventCount: events.length,
      frozenDirEventCount,
      priceStart,
      priceEnd,
      oiStart,
      oiEnd,
      netOi,
      posOi,
      negOi,
      grossOi,
      extremePrice,
      extremeTs,
      extremeIdx,
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
      `${chk.label}: found dirLiqUsd=${fmtUsd(match.dirLiqUsd)} expected=${fmtUsd(chk.expectedUsd)} diff=${fmtUsd(diff)} ${ok ? "PASS" : "FAIL"}`,
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
      c.priorCount = prior.length;
      c.liveEvaluable = c.endTs >= evalStartMs;
      if (prior.length < MIN_LIVE_SAMPLE) {
        c.status = "INSUFFICIENT_HISTORY";
        c.decision = null;
        return;
      }
      const vals = prior.map((p) => p.dirLiqUsd).sort((a, b) => a - b);
      c.causalP90 = percentile(vals, 90);
      c.causalP100 = Math.max(...vals);
      c.pctRank = percentileRank(vals, c.dirLiqUsd);
      c.decision = c.dirLiqUsd >= c.causalP90 ? "KEEP_P90" : "DROP_BELOW_P90";
      c.abovePriorP100 = c.dirLiqUsd > c.causalP100;
      c.status = "LIVE";
    });
  }
  applyRolling(longC);
  applyRolling(shortC);
  const liveCandidates = [...longC, ...shortC]
    .filter((c) => c.liveEvaluable && c.priceStart !== null)
    .sort((a, b) => a.startTs - b.startTs);
  liveCandidates.forEach((c, i) => {
    c.id = `C${String(i + 1).padStart(3, "0")}`;
  });
  console.log(
    `Live-evaluable candidates with valid price data: ${liveCandidates.length}\n`,
  );

  // ============================================================
  // POST-CANDIDATE OUTCOME MEASUREMENT
  // ============================================================
  for (const c of liveCandidates) {
    const dir = c.direction;
    const revUp = dir === "LONG"; // hypothetical reversal direction
    c.horizons = {};
    const maxHorizonEndTs = c.endTs + Math.max(...HORIZONS_MIN) * 60000;
    const maxHorizonEndIdx = nearestObsIdxAtOrBefore(
      allOi,
      maxHorizonEndTs,
      c.endIdx,
    );

    // Threshold crossing chronology, scanned once over the full max horizon.
    const favCrossings = {},
      advCrossings = {};
    FAV_THRESHOLDS_PCT.forEach((t) => {
      favCrossings[t] = null;
    });
    ADV_THRESHOLDS_PCT.forEach((t) => {
      advCrossings[t] = null;
    });

    for (let k = c.endIdx; k <= maxHorizonEndIdx && k < allOi.length; k++) {
      const p = priceAtOrBeforeIdx(allOi, k);
      if (p === null) continue;
      const favPct = revUp
        ? (p / c.priceEnd - 1) * 100
        : (c.priceEnd / p - 1) * 100;
      const advPct = revUp
        ? (c.priceEnd / p - 1) * 100
        : (p / c.priceEnd - 1) * 100;
      for (const t of FAV_THRESHOLDS_PCT)
        if (favCrossings[t] === null && favPct >= t)
          favCrossings[t] = allOi[k].ts;
      for (const t of ADV_THRESHOLDS_PCT)
        if (advCrossings[t] === null && advPct >= t)
          advCrossings[t] = allOi[k].ts;
    }
    c.favCrossings = favCrossings;
    c.advCrossings = advCrossings;

    for (const h of HORIZONS_MIN) {
      const horizonEndTs = c.endTs + h * 60000;
      const horizonEndIdx = nearestObsIdxAtOrBefore(
        allOi,
        horizonEndTs,
        c.endIdx,
      );
      if (horizonEndIdx < c.endIdx) {
        c.horizons[h] = null;
        continue;
      }

      let favExtreme = null,
        favTs = null,
        advExtreme = null,
        advTs = null;
      let recExtreme = null,
        recTs = null; // running max/min from candidate's OWN extreme forward through this horizon
      const recStartIdx = c.extremeIdx;
      for (let k = c.endIdx; k <= horizonEndIdx; k++) {
        const p = priceAtOrBeforeIdx(allOi, k);
        if (p === null) continue;
        if (revUp) {
          if (favExtreme === null || p > favExtreme) {
            favExtreme = p;
            favTs = allOi[k].ts;
          }
          if (advExtreme === null || p < advExtreme) {
            advExtreme = p;
            advTs = allOi[k].ts;
          }
        } else {
          if (favExtreme === null || p < favExtreme) {
            favExtreme = p;
            favTs = allOi[k].ts;
          }
          if (advExtreme === null || p > advExtreme) {
            advExtreme = p;
            advTs = allOi[k].ts;
          }
        }
      }
      for (let k = recStartIdx; k <= horizonEndIdx; k++) {
        const p = priceAtOrBeforeIdx(allOi, k);
        if (p === null) continue;
        if (revUp) {
          if (recExtreme === null || p > recExtreme) {
            recExtreme = p;
            recTs = allOi[k].ts;
          }
        } else {
          if (recExtreme === null || p < recExtreme) {
            recExtreme = p;
            recTs = allOi[k].ts;
          }
        }
      }

      const MFE = revUp
        ? (favExtreme / c.priceEnd - 1) * 100
        : (c.priceEnd / favExtreme - 1) * 100;
      const MAE = revUp
        ? (c.priceEnd / advExtreme - 1) * 100
        : (advExtreme / c.priceEnd - 1) * 100;
      const recoveryFromExtreme = revUp
        ? (recExtreme / c.extremePrice - 1) * 100
        : (c.extremePrice / recExtreme - 1) * 100;
      const minutesToMFE = (favTs - c.endTs) / 60000,
        minutesToMAE = (advTs - c.endTs) / 60000;
      const order =
        minutesToMFE < minutesToMAE
          ? "FAVORABLE_FIRST"
          : minutesToMAE < minutesToMFE
            ? "ADVERSE_FIRST"
            : "SIMULTANEOUS";

      // OI path for this horizon.
      const priceEndOi = c.oiEnd;
      const horizonOi = allOi[horizonEndIdx].contracts;
      let postInc = 0,
        postDec = 0,
        oiMaxAbove = priceEndOi,
        oiMaxAboveTs = c.endTs,
        oiMaxBelow = priceEndOi,
        oiMaxBelowTs = c.endTs;
      for (let k = c.endIdx + 1; k <= horizonEndIdx; k++) {
        const d = allOi[k].contracts - allOi[k - 1].contracts;
        if (d > 0) postInc += d;
        else postDec += d;
        if (allOi[k].contracts > oiMaxAbove) {
          oiMaxAbove = allOi[k].contracts;
          oiMaxAboveTs = allOi[k].ts;
        }
        if (allOi[k].contracts < oiMaxBelow) {
          oiMaxBelow = allOi[k].contracts;
          oiMaxBelowTs = allOi[k].ts;
        }
      }

      c.horizons[h] = {
        MFE,
        MAE,
        favExtreme,
        favTs,
        advExtreme,
        advTs,
        minutesToMFE,
        minutesToMAE,
        order,
        recoveryFromExtreme,
        recExtreme,
        recTs,
        oiAtCandidateEnd: priceEndOi,
        oiAtHorizonEnd: horizonOi,
        netPostOIChange: horizonOi - priceEndOi,
        postOIIncreaseSum: postInc,
        postOIDecreaseSum: postDec,
        postGrossOI: postInc - postDec,
        oiMaxAbove,
        oiMaxAboveTs,
        oiMaxBelow,
        oiMaxBelowTs,
        minutesToOiMaxAbove: (oiMaxAboveTs - c.endTs) / 60000,
        minutesToOiMaxBelow: (oiMaxBelowTs - c.endTs) / 60000,
      };
    }
  }

  // ============================================================
  // GROUP DISTRIBUTIONS
  // ============================================================
  function printGroupStats(label, cs) {
    console.log(`\n${label}: N=${cs.length}`);
    for (const h of HORIZONS_MIN) {
      console.log(`  --- ${h}m horizon ---`);
      console.log(
        `  ${distStats(
          "MFE",
          cs.map((c) => c.horizons[h]?.MFE),
        )}`,
      );
      console.log(
        `  ${distStats(
          "MAE",
          cs.map((c) => c.horizons[h]?.MAE),
        )}`,
      );
      console.log(
        `  ${distStats(
          "recoveryFromExtreme",
          cs.map((c) => c.horizons[h]?.recoveryFromExtreme),
        )}`,
      );
      console.log(
        `  ${distStats(
          "minutesToMFE",
          cs.map((c) => c.horizons[h]?.minutesToMFE),
        )}`,
      );
      console.log(
        `  ${distStats(
          "netPostOIChange",
          cs.map((c) => c.horizons[h]?.netPostOIChange),
        )}`,
      );
      console.log(
        `  ${distStats(
          "postGrossOI",
          cs.map((c) => c.horizons[h]?.postGrossOI),
        )}`,
      );
    }
  }
  console.log(`${"=".repeat(170)}\nGROUP DISTRIBUTIONS\n${"=".repeat(170)}`);
  for (const [groupLabel, filterFn] of [
    ["ALL", () => true],
    ["KEEP_P90", (c) => c.decision === "KEEP_P90"],
    ["ABOVE_PRIOR_P100", (c) => c.abovePriorP100],
  ]) {
    for (const dir of ["LONG", "SHORT"]) {
      printGroupStats(
        `${groupLabel} / ${dir}`,
        liveCandidates.filter((c) => c.direction === dir && filterFn(c)),
      );
    }
  }

  // ============================================================
  // EVERY KEEP_P90 CANDIDATE
  // ============================================================
  console.log(
    `\n${"=".repeat(170)}\nEVERY KEEP_P90 CANDIDATE\n${"=".repeat(170)}`,
  );
  liveCandidates
    .filter((c) => c.decision === "KEEP_P90")
    .forEach((c) => {
      console.log("\n" + "-".repeat(60));
      console.log(`${c.id}  ${c.direction} LIQUIDATION`);
      console.log(`START ${fmtDate(c.startTs)}   END ${fmtDate(c.endTs)}`);
      console.log(
        `\ndirLiq: ${fmtUsd(c.dirLiqUsd)}   oppLiq: ${fmtUsd(c.oppLiqUsd)}   events: ${c.eventCount} (${c.frozenDirEventCount} frozen-dir)`,
      );
      console.log(
        `P90: ${fmtUsd(c.causalP90)}   strength: ${(c.dirLiqUsd / c.causalP90).toFixed(2)}x P90   priorP100: ${fmtUsd(c.causalP100)}   ${(c.dirLiqUsd / c.causalP100).toFixed(2)}x P100   pctRank: ${c.pctRank?.toFixed(1)}`,
      );
      console.log(
        `\ncandidate price: start=${fmtPrice(c.priceStart)} extreme=${fmtPrice(c.extremePrice)}@${fmtDate(c.extremeTs)} end=${fmtPrice(c.priceEnd)}`,
      );
      console.log(
        `\nOI during candidate: net=${fmtBtcDelta(c.netOi)} (${((c.netOi / c.oiStart) * 100).toFixed(3)}%)  positive=${fmtBtcDelta(c.posOi)}  negative=${fmtBtcDelta(c.negOi)}  gross=${fmtBtc(c.grossOi)} (${((c.grossOi / c.oiStart) * 100).toFixed(3)}%)`,
      );
      for (const h of HORIZONS_MIN) {
        const hh = c.horizons[h];
        if (!hh) {
          console.log(`\nPOST ${h}m: N/A (insufficient data)`);
          continue;
        }
        console.log(`\nPOST ${h}m:`);
        console.log(
          `  MFE ${fmtPct(hh.MFE)} @ ${fmtMin(hh.minutesToMFE)}   MAE ${fmtPct(hh.MAE)} @ ${fmtMin(hh.minutesToMAE)}   order=${hh.order}`,
        );
        console.log(
          `  recoveryFromExtreme ${fmtPct(hh.recoveryFromExtreme)} @ ${fmtDate(hh.recTs)}`,
        );
        console.log(
          `  OI: end=${fmtBtc(hh.oiAtCandidateEnd)} horizonEnd=${fmtBtc(hh.oiAtHorizonEnd)} net=${fmtBtcDelta(hh.netPostOIChange)} gross=${fmtBtc(hh.postGrossOI)} maxAbove=${fmtBtc(hh.oiMaxAbove)}@${fmtMin(hh.minutesToOiMaxAbove)} maxBelow=${fmtBtc(hh.oiMaxBelow)}@${fmtMin(hh.minutesToOiMaxBelow)}`,
        );
      }
      console.log(`\nthreshold chronology:`);
      const events = [];
      for (const t of FAV_THRESHOLDS_PCT)
        events.push({ ts: c.favCrossings[t], label: `+${t}% favorable` });
      for (const t of ADV_THRESHOLDS_PCT)
        events.push({ ts: c.advCrossings[t], label: `${t}% adverse` });
      events.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
      events.forEach((e) => {
        console.log(
          `  ${e.label}: ${e.ts !== null ? "reached after " + fmtMin((e.ts - c.endTs) / 60000) : "never reached (within 120m)"}`,
        );
      });
    });

  // ============================================================
  // CROSS-TABLES (data-derived buckets, quartiles)
  // ============================================================
  console.log(
    `\n${"=".repeat(170)}\nCROSS-TABLES (quartile buckets from observed distribution)\n${"=".repeat(170)}`,
  );
  function crossTable(label, valueFn) {
    const withVal = liveCandidates.filter(
      (c) =>
        valueFn(c) !== null && Number.isFinite(valueFn(c)) && c.horizons[60],
    );
    if (withVal.length < 8) {
      console.log(`\n${label}: insufficient N (${withVal.length})`);
      return;
    }
    const vals = withVal.map(valueFn).sort((a, b) => a - b);
    const q1 = percentile(vals, 25),
      q2 = percentile(vals, 50),
      q3 = percentile(vals, 75);
    const buckets = { Q1: [], Q2: [], Q3: [], Q4: [] };
    withVal.forEach((c) => {
      const v = valueFn(c);
      const b = v <= q1 ? "Q1" : v <= q2 ? "Q2" : v <= q3 ? "Q3" : "Q4";
      buckets[b].push(c);
    });
    console.log(
      `\n${label} (cut points: Q1<=${q1.toFixed(3)}, Q2<=${q2.toFixed(3)}, Q3<=${q3.toFixed(3)}):`,
    );
    for (const b of ["Q1", "Q2", "Q3", "Q4"]) {
      const cs = buckets[b];
      const mfe60 = cs.map((c) => c.horizons[60].MFE).sort((a, b) => a - b);
      const mae60 = cs.map((c) => c.horizons[60].MAE).sort((a, b) => a - b);
      console.log(
        `  ${b}: N=${cs.length}  median MFE60=${percentile(mfe60, 50)?.toFixed(3)}  median MAE60=${percentile(mae60, 50)?.toFixed(3)}`,
      );
      if (b === "Q1" || b === "Q4")
        console.log(`    candidates: ${cs.map((c) => c.id).join(", ")}`);
    }
  }
  crossTable("Liquidation strength (dirLiqUsd/P90 ratio)", (c) =>
    c.causalP90 ? c.dirLiqUsd / c.causalP90 : null,
  );
  crossTable("OI net-change % (netOi/oiStart*100)", (c) =>
    c.oiStart ? (c.netOi / c.oiStart) * 100 : null,
  );
  crossTable("OI gross-activity % (grossOi/oiStart*100)", (c) =>
    c.oiStart ? (c.grossOi / c.oiStart) * 100 : null,
  );

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
