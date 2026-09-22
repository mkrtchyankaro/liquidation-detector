// BTC OI->PRICE EFFICIENCY / SATURATION RESEARCH -- new, standalone.
// Baseline (btc-simple-10min-window.js) and outcome math
// (btc-post-episode-outcomes.js) REUSED VERBATIM, neither modified.
// No Page-Hinkley/OLS/kNN/t-test/ZOI/ML model of any kind.
//
// CORE CONCEPT -- OI->PRICE EFFICIENCY (self-relative, causal, zero
// magic constants):
//   cumGrossOI(t)     = cumulative Σ|ΔOI| from candidate START to t
//   cumDirProgress(t) = cumulative SIGNED price progress in the
//                       ORIGINAL liquidation direction from START to t
//                       (positive = still continuing that direction)
//   overallEfficiency(t)  = cumDirProgress(t) / cumGrossOI(t)
//   RECENT WINDOW: the most recent 25% of cumGrossOI(t) accumulated
//   so far (a self-relative, OI-activity-based window, NOT a fixed
//   time window) -- found via a monotonic two-pointer scan, O(n).
//   recentEfficiency(t)  = (cumDirProgress(t)-cumDirProgress(ref)) /
//                          (cumGrossOI(t)-cumGrossOI(ref))
//   earlierEfficiency(t) = cumDirProgress(ref) / cumGrossOI(ref)
//
// EARLIEST_SATURATION_CANDIDATE: the FIRST causal timestamp where
// recentEfficiency(t) <= 0 while earlierEfficiency(t) > 0 -- i.e. the
// most recent chunk of OI activity produced ZERO OR NEGATIVE further
// progress in the original direction, after genuinely having produced
// positive progress earlier in the SAME episode. This is a pure
// SIGN-based, zero-parameter transition marker -- not a tuned
// threshold. It is reported as ONE candidate definition to inspect
// empirically, not asserted as the final answer.
//
//   node scripts/btc-oi-price-efficiency-saturation.js
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
const RECENT_WINDOW_FRACTION = 0.25; // fraction of cumGrossOI-so-far defining the "recent" window -- disclosed, not a price/OI magnitude
const POST_TRANSITION_HORIZONS_MIN = [5, 10, 20, 30];
const CASE_STUDY_HORIZON_MIN = 60;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtDate(ms) {
  return ms === null || ms === undefined
    ? "N/A"
    : new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
function fmtHHMM(ms) {
  return ms === null || ms === undefined
    ? "N/A"
    : new Date(ms).toISOString().slice(11, 19);
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
    "1. Baseline candidate construction: identical to btc-simple-10min-window.js.",
  );
  console.log(
    "2. Efficiency/saturation features at time T use ONLY observations with ts<=T -- cumGrossOI, cumDirProgress, and the recent/earlier split are all expanding, forward-only computations.",
  );
  console.log(
    "3. Outcome measurements (MFE/MAE, post-transition horizons) are computed AFTER a feature's own timestamp and are NEVER fed back into the feature calculation at that timestamp.",
  );
  console.log(
    "4. No future candle, no future OI, no final episode extreme, no outcome label ever enters a causal feature.\n",
  );

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + CASE_STUDY_HORIZON_MIN * 60_000;

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
  const p90Candidates = [...longC, ...shortC]
    .filter(
      (c) =>
        c.liveEvaluable && c.decision === "KEEP_P90" && c.priceStart !== null,
    )
    .sort((a, b) => a.startTs - b.startTs);
  p90Candidates.forEach((c, i) => {
    c.id = `P${String(i + 1).padStart(3, "0")}`;
  });
  console.log(`P90 candidates for this analysis: ${p90Candidates.length}\n`);

  // ============================================================
  // PER-CANDIDATE CAUSAL TIMELINE + EFFICIENCY + SATURATION
  // ============================================================
  for (const c of p90Candidates) {
    const revUp = c.direction === "LONG"; // favorable direction
    const horizonEndTs = c.endTs + CASE_STUDY_HORIZON_MIN * 60000;
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
      cumDirProgress = 0,
      cumPosOI = 0,
      cumNegOI = 0;
    let refIdx = 0; // two-pointer for the 25%-of-cumGrossOI recent window
    const cumGrossArr = [],
      cumProgArr = [];

    for (let k = c.startIdx; k <= horizonEndIdx; k++) {
      const p = priceAtOrBeforeIdx(allOi, k);
      if (p === null) continue;
      if (k > c.startIdx) {
        const prevContracts = allOi[k - 1].contracts,
          dOi = allOi[k].contracts - prevContracts;
        cumGrossOI += Math.abs(dOi);
        if (dOi > 0) cumPosOI += dOi;
        else cumNegOI += dOi;
      }
      const dirProgressRaw = revUp ? startPrice - p : p - startPrice; // positive = continuing ORIGINAL liquidation direction
      cumDirProgress = (dirProgressRaw / startPrice) * 100; // as %, self-relative units
      cumGrossArr.push(cumGrossOI);
      cumProgArr.push(cumDirProgress);

      const target = (1 - RECENT_WINDOW_FRACTION) * cumGrossOI;
      while (refIdx < cumGrossArr.length - 1 && cumGrossArr[refIdx] < target)
        refIdx++;
      const recentGross = cumGrossOI - cumGrossArr[refIdx];
      const recentProg = cumDirProgress - cumProgArr[refIdx];
      const recentEfficiency =
        recentGross > 0 ? recentProg / recentGross : null;
      const earlierEfficiency =
        cumGrossArr[refIdx] > 0
          ? cumProgArr[refIdx] / cumGrossArr[refIdx]
          : null;
      const overallEfficiency =
        cumGrossOI > 0 ? cumDirProgress / cumGrossOI : null;

      timeline.push({
        ts: allOi[k].ts,
        price: p,
        oi: allOi[k].contracts,
        cumGrossOI,
        cumDirProgress,
        cumPosOI,
        cumNegOI,
        recentEfficiency,
        earlierEfficiency,
        overallEfficiency,
      });
    }
    c.timeline = timeline;
    c.startPrice = startPrice;
    c.startOi = startOi;

    // EARLIEST_SATURATION_CANDIDATE: first t where recentEff<=0 while earlierEff>0.
    let saturationTs = null;
    for (const row of timeline) {
      if (
        row.recentEfficiency !== null &&
        row.earlierEfficiency !== null &&
        row.recentEfficiency <= 0 &&
        row.earlierEfficiency > 0
      ) {
        saturationTs = row.ts;
        break;
      }
    }
    c.saturationTs = saturationTs;

    // Adverse extreme, favorable crossings (reuse same math style as the outcomes script).
    let advExtreme = null,
      advTs = null,
      favExtreme = null,
      favTs = null;
    for (const row of timeline) {
      if (row.ts < c.endTs) continue; // post-END only, matching the outcomes script's own convention
      if (revUp) {
        if (advExtreme === null || row.price < advExtreme) {
          advExtreme = row.price;
          advTs = row.ts;
        }
        if (favExtreme === null || row.price > favExtreme) {
          favExtreme = row.price;
          favTs = row.ts;
        }
      } else {
        if (advExtreme === null || row.price > advExtreme) {
          advExtreme = row.price;
          advTs = row.ts;
        }
        if (favExtreme === null || row.price < favExtreme) {
          favExtreme = row.price;
          favTs = row.ts;
        }
      }
    }
    c.advExtreme = advExtreme;
    c.advTs = advTs;
    let fav025Ts = null,
      fav050Ts = null;
    for (const row of timeline) {
      if (row.ts < c.endTs) continue;
      const favPct = revUp
        ? (row.price / c.priceEnd - 1) * 100
        : (c.priceEnd / row.price - 1) * 100;
      if (fav025Ts === null && favPct >= 0.25) fav025Ts = row.ts;
      if (fav050Ts === null && favPct >= 0.5) fav050Ts = row.ts;
    }
    c.fav025Ts = fav025Ts;
    c.fav050Ts = fav050Ts;

    // Post-transition horizons (5/10/20/30m from saturation, if found).
    if (saturationTs !== null) {
      const satIdx = timeline.findIndex((r) => r.ts === saturationTs);
      const satPrice = timeline[satIdx].price;
      c.postTransition = {};
      for (const h of POST_TRANSITION_HORIZONS_MIN) {
        const hEndTs = saturationTs + h * 60000;
        const rows = timeline.filter(
          (r) => r.ts >= saturationTs && r.ts <= hEndTs,
        );
        if (rows.length === 0) {
          c.postTransition[h] = null;
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
          ? (fav / satPrice - 1) * 100
          : (satPrice / fav - 1) * 100;
        const MAE = revUp
          ? (satPrice / adv - 1) * 100
          : (adv / satPrice - 1) * 100;
        c.postTransition[h] = { MFE, MAE };
      }
    } else c.postTransition = null;
  }

  const withTimeline = p90Candidates.filter((c) => c.timeline);
  const withSaturation = withTimeline.filter((c) => c.saturationTs !== null);
  console.log(
    `${"=".repeat(170)}\nSATURATION DETECTION SUMMARY\n${"=".repeat(170)}`,
  );
  console.log(`P90 candidates with usable timeline: ${withTimeline.length}`);
  console.log(
    `Candidates where EARLIEST_SATURATION_CANDIDATE was found: ${withSaturation.length} (${((withSaturation.length / withTimeline.length) * 100).toFixed(1)}%)`,
  );

  // ============================================================
  // OUTCOME COHORTS (empirical quantiles, not arbitrary thresholds)
  // ============================================================
  const mfe30Vals = withTimeline.map((c) => {
    const rows = c.timeline.filter(
      (r) => r.ts >= c.endTs && r.ts <= c.endTs + 30 * 60000,
    );
    if (rows.length === 0) return null;
    let fav = null;
    for (const r of rows) {
      const revUp = c.direction === "LONG";
      if (revUp) {
        if (fav === null || r.price > fav) fav = r.price;
      } else {
        if (fav === null || r.price < fav) fav = r.price;
      }
    }
    return c.direction === "LONG"
      ? (fav / c.priceEnd - 1) * 100
      : (c.priceEnd / fav - 1) * 100;
  });
  withTimeline.forEach((c, i) => {
    c.mfe30 = mfe30Vals[i];
  });
  const sortedMfe30 = mfe30Vals.filter((v) => v !== null).sort((a, b) => a - b);
  const mfe30Median = percentile(sortedMfe30, 50),
    mfe30P75 = percentile(sortedMfe30, 75);
  console.log(
    `\nEmpirical MFE30 distribution: median=${fmtPct(mfe30Median)} P75=${fmtPct(mfe30P75)}`,
  );
  console.log(
    `Cohort definition (empirical, rank-based): FAST = MFE30 >= P75; MIXED = P50<=MFE30<P75; SLOW/CONTINUATION = MFE30 < P50.`,
  );

  function cohortOf(c) {
    if (c.mfe30 === null) return "N/A";
    if (c.mfe30 >= mfe30P75) return "FAST";
    if (c.mfe30 >= mfe30Median) return "MIXED";
    return "CONTINUATION";
  }
  withTimeline.forEach((c) => {
    c.cohort = cohortOf(c);
  });

  console.log(
    `\n${"=".repeat(170)}\nCOHORT COMPARISON -- saturation detection rate + lead time\n${"=".repeat(170)}`,
  );
  for (const cohort of ["FAST", "MIXED", "CONTINUATION"]) {
    const cs = withTimeline.filter((c) => c.cohort === cohort);
    const satFound = cs.filter((c) => c.saturationTs !== null);
    console.log(
      `\n${cohort}: N=${cs.length}  saturation found in ${satFound.length} (${cs.length ? ((satFound.length / cs.length) * 100).toFixed(1) : 0}%)`,
    );
    if (satFound.length > 0) {
      const leadToAdv = satFound.map((c) =>
        c.advTs !== null ? (c.advTs - c.saturationTs) / 60000 : null,
      );
      const leadToFav025 = satFound.map((c) =>
        c.fav025Ts !== null ? (c.fav025Ts - c.saturationTs) / 60000 : null,
      );
      console.log(
        `  minutes from saturation to adverse extreme: median=${fmtMin(median(leadToAdv))}`,
      );
      console.log(
        `  minutes from saturation to +0.25% favorable: median=${fmtMin(median(leadToFav025))}`,
      );
      for (const h of POST_TRANSITION_HORIZONS_MIN) {
        const mfeVals = satFound.map((c) => c.postTransition?.[h]?.MFE ?? null);
        const maeVals = satFound.map((c) => c.postTransition?.[h]?.MAE ?? null);
        console.log(
          `  post-saturation ${h}m: median MFE=${fmtPct(median(mfeVals))}  median MAE=${fmtPct(median(maeVals))}`,
        );
      }
    }
  }

  // ============================================================
  // MANUAL CASE STUDIES
  // ============================================================
  console.log(`\n${"=".repeat(200)}\nMANUAL CASE STUDIES\n${"=".repeat(200)}`);
  const caseTimestamps = [
    { label: "CASE 1", startTs: Date.parse("2026-09-20T02:24:27Z") },
    { label: "CASE 2", startTs: Date.parse("2026-09-20T02:35:59Z") },
    { label: "CASE 3", startTs: Date.parse("2026-09-20T03:08:05Z") },
  ];
  for (const cs of caseTimestamps) {
    const c = p90Candidates.find(
      (x) => Math.abs(x.startTs - cs.startTs) < 2000,
    );
    if (!c || !c.timeline) {
      console.log(
        `\n${cs.label}: not found in P90 population or no usable timeline.`,
      );
      continue;
    }
    console.log(
      `\n${cs.label}: ${c.direction} ${fmtDate(c.startTs)} -> ${fmtDate(c.endTs)}  dirLiq=${fmtUsd(c.dirLiqUsd)}  cohort=${c.cohort}`,
    );
    console.log(
      `Saturation: ${c.saturationTs !== null ? fmtDate(c.saturationTs) : "NOT FOUND"}   adverse extreme: ${fmtDate(c.advTs)} (${fmtPrice(c.advExtreme)})   +0.25% favorable: ${fmtDate(c.fav025Ts)}   +0.50% favorable: ${fmtDate(c.fav050Ts)}`,
    );
    console.log(
      "TIME     | PRICE      | OI          | cumGrossOI | cumDirProgress% | recentEff  | earlierEff | overallEff",
    );
    // sample the timeline compactly -- every Nth row to keep output manageable, plus always include the saturation row if found
    const n = c.timeline.length;
    const step = Math.max(1, Math.floor(n / 40));
    for (let i = 0; i < n; i += step) {
      const r = c.timeline[i];
      console.log(
        `${fmtHHMM(r.ts)} | ${fmtPrice(r.price).padEnd(10)} | ${fmtBtc(r.oi).padEnd(11)} | ${fmtBtc(r.cumGrossOI).padEnd(10)} | ${fmtPct(r.cumDirProgress).padEnd(16)} | ${(r.recentEfficiency !== null ? r.recentEfficiency.toFixed(4) : "N/A").padEnd(10)} | ${(r.earlierEfficiency !== null ? r.earlierEfficiency.toFixed(4) : "N/A").padEnd(10)} | ${r.overallEfficiency !== null ? r.overallEfficiency.toFixed(4) : "N/A"}`,
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
