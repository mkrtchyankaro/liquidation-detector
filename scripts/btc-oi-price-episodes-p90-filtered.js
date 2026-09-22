// BTC OI->PRICE EPISODES, P90-FILTERED -- new wrapper script.
//
// REUSES AS-IS (verbatim, unchanged) the segmentation + online-OLS +
// Page-Hinkley START/ACTIVE/END_CONFIRMED logic from
// btc-liquidation-3day-simple-list-v2.js -- identified in this run's
// code-inspection step as the current "meaningful OI movement" (NOT
// raw-tick) structural-change detector. See the inspection notes
// printed at the top of this script's output for full disclosure,
// including which hard-coded constants (already audited earlier)
// carry over UNCHANGED by reusing this logic as-is.
//
// NEW in this script: P90 plays NO role in START/ACTIVE/END. It is
// applied ONLY after an episode is already END_CONFIRMED, as a
// causal, side-specific, rolling-PRIOR-3-day quality filter.
//
//   node scripts/btc-oi-price-episodes-p90-filtered.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EVAL_DAYS = 3; // evaluation period
const BASELINE_DAYS = 3; // additional PRIOR days loaded purely to populate the causal 3-day baseline
const CONFIRMATION_WINDOW_SEGMENTS = 5; // CARRIED OVER UNCHANGED from btc-liquidation-3day-simple-list-v2.js
const NUMERIC_TOLERANCE = 1e-6; // CARRIED OVER UNCHANGED

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtDate(ms) {
  return ms === null
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
function fmtLogPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(4)}%`;
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
function percentileRank(sortedPop, x) {
  if (sortedPop.length === 0) return null;
  let count = 0;
  for (const v of sortedPop) if (v <= x) count++;
  return (count / sortedPop.length) * 100;
}
function median(arr) {
  const s = [...arr].filter((v) => v !== null).sort((a, b) => a - b);
  return percentile(s, 50);
}
function stddev(arr) {
  const m = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  return arr.length
    ? Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length)
    : null;
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
function horizonDeltas(obs, horizonMs, toleranceMs, field) {
  const deltas = [];
  let j = 0;
  for (let i = 0; i < obs.length; i++) {
    if (j < i + 1) j = i + 1;
    while (j < obs.length && obs[j].ts - obs[i].ts < horizonMs - toleranceMs)
      j++;
    if (
      j < obs.length &&
      Math.abs(obs[j].ts - obs[i].ts - horizonMs) <= toleranceMs &&
      obs[j][field] !== null &&
      obs[i][field] !== null
    )
      deltas.push(obs[j][field] - obs[i][field]);
  }
  return deltas;
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
    "CODE INSPECTION SUMMARY (also see full disclosure above this script's source)",
  );
  console.log("=".repeat(170));
  console.log(
    `Reused AS-IS from btc-liquidation-3day-simple-list-v2.js: magnitude-cut OI segmentation,`,
  );
  console.log(
    `causal log-return online OLS regression, direction-aware Page-Hinkley (no reset),`,
  );
  console.log(
    `${CONFIRMATION_WINDOW_SEGMENTS}-segment confirmation window. These constants CARRY OVER UNCHANGED`,
  );
  console.log(
    `(previously audited, never revised): 60s/±8s block-scale horizon, P50 block-scale percentile,`,
  );
  console.log(
    `Page-Hinkley delta=0.5x/lambda=3x running stddev, candidate dedupe gap=2 segments, 3h search cap.`,
  );
  console.log(
    `P90 is NOT part of any of the above -- it is applied only after END_CONFIRMED, below.\n`,
  );

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000; // extra PRIOR days for the causal 3-day baseline

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
        $lte: new Date(evalEndMs + 3 * 3600 * 1000),
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
    `Load window: ${isoUtc(loadStartMs)} -> ${isoUtc(evalEndMs)} (${BASELINE_DAYS}d baseline + ${EVAL_DAYS}d evaluation)`,
  );
  console.log(
    `Evaluation period: ${isoUtc(evalStartMs)} -> ${isoUtc(evalEndMs)}`,
  );
  console.log(
    `Raw liquidation events loaded: ${allLiq.length}   OI+price observations: ${allOi.length}`,
  );
  if (allLiq.length === 0 || allOi.length < 100) {
    console.log("Insufficient data.");
    await client.close();
    return;
  }

  const oiBlockScale = percentile(
    horizonDeltas(allOi, 60000, 8000, "contracts")
      .map((d) => Math.abs(d))
      .sort((a, b) => a - b),
    50,
  );
  console.log(
    `oiBlockScale (median |ΔOI over 60s|, whole load window): ${fmtBtc(oiBlockScale)} BTC\n`,
  );

  // ---- REUSED AS-IS: coupled START/ACTIVE/END_CONFIRMED construction ----
  const episodes = [];
  let liqIdx = 0,
    invalidCount = 0;
  while (liqIdx < allLiq.length) {
    const startEvent = allLiq[liqIdx];
    const direction = startEvent.victim;
    const adverseDir = direction === "LONG" ? "down" : "up";
    const startTs = startEvent.timestamp;

    const startIdx = nearestObsIdxAtOrBefore(allOi, startTs);
    if (startIdx < 0) {
      invalidCount++;
      liqIdx++;
      continue;
    }
    const searchCapTs = startTs + 3 * 3600 * 1000;
    let endIdxCap = startIdx;
    for (let k = startIdx; k < allOi.length; k++) {
      if (allOi[k].ts <= searchCapTs) endIdxCap = k;
      else break;
    }
    if (endIdxCap - startIdx < 5) {
      liqIdx++;
      continue;
    }

    const segs = [];
    let segStart = startIdx;
    for (let i = segStart + 1; i <= endIdxCap; i++) {
      if (
        Math.abs(allOi[i].contracts - allOi[segStart].contracts) >= oiBlockScale
      ) {
        segs.push({ startIdx: segStart, endIdx: i });
        segStart = i;
      }
    }
    if (segs.length < 5) {
      liqIdx++;
      continue;
    }

    const segData = segs.map((seg) => {
      const spi = priceAtOrBeforeIdx(allOi, seg.startIdx),
        epi = priceAtOrBeforeIdx(allOi, seg.endIdx);
      const a = allOi[seg.startIdx],
        b = allOi[seg.endIdx];
      const actualLogRet =
        spi !== null && epi !== null ? Math.log(epi / spi) : null;
      return {
        startTs: a.ts,
        endTs: b.ts,
        oiStart: a.contracts,
        oiEnd: b.contracts,
        deltaOi: b.contracts - a.contracts,
        priceStart: spi,
        priceEnd: epi,
        actualLogRet,
      };
    });
    const usable = segData.filter((s) => s.actualLogRet !== null);
    if (usable.length < 5) {
      liqIdx++;
      continue;
    }

    let Sx = 0,
      Sy = 0,
      Sxx = 0,
      Sxy = 0,
      n = 0;
    const rsForPH = [];
    let mtRec = 0,
      minRec = 0;
    const recoveryCandidatesRaw = [];
    for (let i = 0; i < usable.length; i++) {
      const s = usable[i];
      let pred = null;
      if (n >= 3) {
        const denom = n * Sxx - Sx * Sx;
        if (Math.abs(denom) > 1e-12) {
          const slope = (n * Sxy - Sx * Sy) / denom;
          const intercept = (Sy - slope * Sx) / n;
          pred = slope * s.deltaOi + intercept;
        }
      }
      const r = pred !== null ? s.actualLogRet - pred : null;
      const recoveryR = r !== null ? (adverseDir === "down" ? r : -r) : null;
      if (recoveryR !== null) {
        const sd = rsForPH.length >= 5 ? stddev(rsForPH) : null;
        const delta = sd ? 0.5 * sd : 0,
          lambda = sd ? 3 * sd : Infinity;
        mtRec += recoveryR - delta;
        minRec = Math.min(minRec, mtRec);
        const PH = mtRec - minRec;
        if (sd && PH > lambda)
          recoveryCandidatesRaw.push({ idx: i, ts: s.startTs });
        rsForPH.push(recoveryR);
      }
      Sx += s.deltaOi;
      Sy += s.actualLogRet;
      Sxx += s.deltaOi * s.deltaOi;
      Sxy += s.deltaOi * s.actualLogRet;
      n++;
    }
    const recoveryCandidates = [];
    for (const c of recoveryCandidatesRaw)
      if (
        recoveryCandidates.length === 0 ||
        c.idx - recoveryCandidates[recoveryCandidates.length - 1].idx > 2
      )
        recoveryCandidates.push(c);

    let provisionalEndConfirmation = null;
    for (const cand of recoveryCandidates) {
      let invalidated = false;
      let extremeAtCand =
        adverseDir === "down"
          ? Math.min(
              ...usable
                .slice(0, cand.idx + 1)
                .map((s) => s.priceEnd ?? Infinity),
            )
          : Math.max(
              ...usable
                .slice(0, cand.idx + 1)
                .map((s) => s.priceEnd ?? -Infinity),
            );
      const watchEnd = Math.min(
        usable.length - 1,
        cand.idx + CONFIRMATION_WINDOW_SEGMENTS,
      );
      for (let k = cand.idx + 1; k <= watchEnd; k++) {
        const p = usable[k].priceEnd;
        if (p === null) continue;
        if (adverseDir === "down" && p < extremeAtCand) {
          invalidated = true;
          break;
        }
        if (adverseDir === "up" && p > extremeAtCand) {
          invalidated = true;
          break;
        }
      }
      if (
        !invalidated &&
        watchEnd === cand.idx + CONFIRMATION_WINDOW_SEGMENTS
      ) {
        provisionalEndConfirmation = usable[watchEnd].endTs;
        break;
      }
    }

    const fullSumActual = usable.reduce((a, s) => a + s.actualLogRet, 0);
    const trueStartToEnd = Math.log(
      usable[usable.length - 1].priceEnd / usable[0].priceStart,
    );
    if (
      Math.abs(fullSumActual - trueStartToEnd) >=
      NUMERIC_TOLERANCE * usable.length
    ) {
      liqIdx++;
      continue;
    }

    const boundaryTs =
      provisionalEndConfirmation !== null
        ? provisionalEndConfirmation
        : searchCapTs;
    const episodeEvents = [];
    while (liqIdx < allLiq.length && allLiq[liqIdx].timestamp <= boundaryTs) {
      episodeEvents.push(allLiq[liqIdx]);
      liqIdx++;
    }
    if (episodeEvents.length === 0) {
      liqIdx++;
      continue;
    }

    if (provisionalEndConfirmation === null) continue; // NEW: only END_CONFIRMED episodes are completed episodes for this experiment (UNCONFIRMED episodes have no END, so cannot be evaluated/kept)

    // ---- NEW (post-episode only): direction-specific liquidation USD, OI, price stats ----
    const dirLiqUsd = episodeEvents
      .filter((e) => e.victim === direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const oppositeLiqUsd = episodeEvents
      .filter((e) => e.victim !== direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const posOi = usable.reduce((a, s) => a + Math.max(0, s.deltaOi), 0);
    const negOi = usable.reduce((a, s) => a + Math.min(0, s.deltaOi), 0);

    episodes.push({
      direction,
      startTs,
      endTs: provisionalEndConfirmation,
      durationMs: provisionalEndConfirmation - startTs,
      dirLiqUsd,
      oppositeLiqUsd,
      totalLiqUsd: dirLiqUsd + oppositeLiqUsd,
      eventCount: episodeEvents.length,
      priceStart: usable[0].priceStart,
      priceEnd: usable[usable.length - 1].priceEnd,
      netPriceLog: Math.log(
        usable[usable.length - 1].priceEnd / usable[0].priceStart,
      ),
      oiStart: usable[0].oiStart,
      oiEnd: usable[usable.length - 1].oiEnd,
      netOi: usable[usable.length - 1].oiEnd - usable[0].oiStart,
      posOi,
      negOi,
      grossOi: posOi - negOi,
    });
  }

  console.log(
    `END_CONFIRMED episodes constructed: ${episodes.length}   (other candidates: DROP_TIMEOUT/UNCONFIRMED or invalid, not completed episodes -- excluded from P90 evaluation entirely)`,
  );
  console.log(`OTHER (OI-unavailable) skips: ${invalidCount}`);

  // ---- NEW: causal, side-specific rolling-PRIOR-3-day P90, applied ONLY post-END ----
  const longEps = episodes
    .filter((e) => e.direction === "LONG")
    .sort((a, b) => a.endTs - b.endTs);
  const shortEps = episodes
    .filter((e) => e.direction === "SHORT")
    .sort((a, b) => a.endTs - b.endTs);

  function applyRollingP90(eps) {
    eps.forEach((e, idx) => {
      const priorSameSide = eps
        .slice(0, idx)
        .filter(
          (p) =>
            p.endTs >= e.endTs - BASELINE_DAYS * 86_400_000 &&
            p.endTs < e.endTs,
        );
      e.priorCount = priorSameSide.length;
      e.liveEvaluable = e.endTs >= evalStartMs; // only episodes within the evaluation period are reported as decisions
      if (priorSameSide.length < 5) {
        e.status = "INSUFFICIENT_HISTORY";
        e.causalP90 = null;
        e.pctRank = null;
        e.decision = null;
        return;
      }
      const priorVals = priorSameSide
        .map((p) => p.dirLiqUsd)
        .sort((a, b) => a - b);
      e.causalP90 = percentile(priorVals, 90);
      e.pctRank = percentileRank(priorVals, e.dirLiqUsd);
      e.decision = e.dirLiqUsd >= e.causalP90 ? "KEEP_P90" : "DROP_BELOW_P90";
      e.status = "LIVE";
    });
  }
  applyRollingP90(longEps);
  applyRollingP90(shortEps);

  // Diagnostic-only retrospective percentile.
  function addRetrospective(eps) {
    const sorted = eps.map((e) => e.dirLiqUsd).sort((a, b) => a - b);
    eps.forEach((e) => {
      e.retrospectivePct = percentileRank(sorted, e.dirLiqUsd);
    });
  }
  addRetrospective(longEps);
  addRetrospective(shortEps);

  // ---- STEP 13: chronological table, live-evaluable only ----
  console.log(`\n${"=".repeat(190)}`);
  console.log("LIVE-EVALUABLE EPISODES, CHRONOLOGICAL");
  console.log("=".repeat(190));
  const allSorted = [...longEps, ...shortEps]
    .filter((e) => e.liveEvaluable)
    .sort((a, b) => a.startTs - b.startTs);
  allSorted.forEach((e, idx) => {
    console.log(`\nEP ${idx + 1}`);
    console.log(`Direction: ${e.direction}`);
    console.log(`Start: ${fmtDate(e.startTs)}`);
    console.log(`End: ${fmtDate(e.endTs)}`);
    console.log(`Duration: ${fmtSec(e.durationMs)}`);
    console.log(
      `Direction Liq USD: ${fmtUsd(e.dirLiqUsd)}   Opposite Liq USD: ${fmtUsd(e.oppositeLiqUsd)}`,
    );
    console.log(`Prior 3d same-side episode count: ${e.priorCount}`);
    console.log(
      `Causal P90: ${e.status === "LIVE" ? fmtUsd(e.causalP90) : `N/A (${e.status})`}`,
    );
    console.log(
      `Percentile rank: ${e.pctRank !== null ? e.pctRank.toFixed(2) : "N/A"}  (retrospective, diagnostic-only: ${e.retrospectivePct.toFixed(2)} -- RETROSPECTIVE ONLY, NOT LIVE-SAFE)`,
    );
    console.log(`Decision: ${e.decision ?? e.status}`);
    console.log(
      `Price: start=${fmtPrice(e.priceStart)} end=${fmtPrice(e.priceEnd)} move=${fmtLogPct(e.netPriceLog)}`,
    );
    console.log(
      `OI: start=${fmtBtc(e.oiStart)} end=${fmtBtc(e.oiEnd)} net=${fmtBtcDelta(e.netOi)} positive=${fmtBtcDelta(e.posOi)} negative=${fmtBtcDelta(e.negOi)} gross=${fmtBtc(e.grossOi)}`,
    );
  });

  // ---- STEP 14: summary ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("SUMMARY");
  console.log("=".repeat(170));
  for (const [label, eps] of [
    ["LONG", longEps],
    ["SHORT", shortEps],
  ]) {
    const live = eps.filter((e) => e.liveEvaluable);
    const insuff = live.filter((e) => e.status === "INSUFFICIENT_HISTORY");
    const keep = live.filter((e) => e.decision === "KEEP_P90");
    const drop = live.filter((e) => e.decision === "DROP_BELOW_P90");
    console.log(
      `\n${label}: completed=${eps.length}  live-evaluable=${live.length}  insufficient-history=${insuff.length}  KEEP_P90=${keep.length}  DROP_BELOW_P90=${drop.length}  keep-rate=${live.length - insuff.length > 0 ? ((keep.length / (live.length - insuff.length)) * 100).toFixed(1) + "%" : "N/A"}`,
    );
    if (keep.length > 0) {
      console.log(
        `  median duration (KEEP): ${fmtSec(median(keep.map((e) => e.durationMs)))}`,
      );
      console.log(
        `  median liq USD (KEEP): ${fmtUsd(median(keep.map((e) => e.dirLiqUsd)))}`,
      );
      console.log(
        `  median price move (KEEP): ${fmtLogPct(median(keep.map((e) => e.netPriceLog)))}`,
      );
      console.log(
        `  median net OI (KEEP): ${fmtBtcDelta(median(keep.map((e) => e.netOi)))}`,
      );
      console.log(
        `  median gross OI (KEEP): ${fmtBtc(median(keep.map((e) => e.grossOi)))}`,
      );
    }
  }

  // ---- STEP 15: manual inspection cases ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("MANUAL INSPECTION CASES");
  console.log("=".repeat(170));
  function line(e) {
    return `${e.direction} ${fmtDate(e.startTs)} -> ${fmtDate(e.endTs)}  dirLiq=${fmtUsd(e.dirLiqUsd)}  P90=${fmtUsd(e.causalP90)}  pctRank=${e.pctRank?.toFixed(1)}`;
  }
  console.log("\n5 KEEP_P90 LONG:");
  longEps
    .filter((e) => e.decision === "KEEP_P90")
    .slice(0, 5)
    .forEach((e) => console.log("  " + line(e)));
  console.log("\n5 KEEP_P90 SHORT:");
  shortEps
    .filter((e) => e.decision === "KEEP_P90")
    .slice(0, 5)
    .forEach((e) => console.log("  " + line(e)));
  console.log("\n3 LONG just below causal P90:");
  longEps
    .filter((e) => e.decision === "DROP_BELOW_P90")
    .sort((a, b) => (b.pctRank ?? 0) - (a.pctRank ?? 0))
    .slice(0, 3)
    .forEach((e) => console.log("  " + line(e)));
  console.log("\n3 SHORT just below causal P90:");
  shortEps
    .filter((e) => e.decision === "DROP_BELOW_P90")
    .sort((a, b) => (b.pctRank ?? 0) - (a.pctRank ?? 0))
    .slice(0, 3)
    .forEach((e) => console.log("  " + line(e)));

  // ---- STEP 16: parameter audit ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("PARAMETER AUDIT");
  console.log("=".repeat(170));
  const audit = [
    {
      n: "oiBlockScale horizon",
      v: "60000ms, ±8000ms tolerance",
      src: "CARRIED OVER from btc-liquidation-3day-simple-list-v2.js, unchanged",
      fx: "FIXED",
      cat: "STATISTICAL/OPERATIONAL",
    },
    {
      n: "oiBlockScale percentile",
      v: "P50 (median)",
      src: "same",
      fx: "FIXED methodology, DATA-DERIVED value",
      cat: "STATISTICAL",
    },
    {
      n: "Min segments/observations",
      v: "5 / 5 / 3(OLS)",
      src: "same",
      fx: "FIXED",
      cat: "OPERATIONAL",
    },
    {
      n: "Page-Hinkley delta",
      v: "0.5 x running stddev",
      src: "same",
      fx: "FIXED multiplier, DATA-DERIVED scale",
      cat: "STATISTICAL",
    },
    {
      n: "Page-Hinkley lambda",
      v: "3 x running stddev",
      src: "same",
      fx: "FIXED multiplier, DATA-DERIVED scale",
      cat: "STATISTICAL",
    },
    {
      n: "Candidate dedupe gap",
      v: "2 segments",
      src: "same",
      fx: "FIXED",
      cat: "OPERATIONAL",
    },
    {
      n: "CONFIRMATION_WINDOW_SEGMENTS",
      v: "5",
      src: "same",
      fx: "FIXED",
      cat: "OPERATIONAL",
    },
    {
      n: "3h search cap",
      v: "3 hours",
      src: "same",
      fx: "FIXED (research safety cap, not an END rule)",
      cat: "OPERATIONAL",
    },
    {
      n: "MIN_LIVE_SAMPLE (P90 baseline)",
      v: "5 prior same-side episodes",
      src: "NEW, this script",
      fx: "FIXED",
      cat: "STATISTICAL",
    },
    {
      n: "Rolling baseline window",
      v: "prior 3 calendar days",
      src: "NEW, this script -- exactly as specified",
      fx: "FIXED",
      cat: "OPERATIONAL",
    },
    {
      n: "P90 cut point",
      v: "90th percentile",
      src: "NEW, this script",
      fx: "FIXED convention",
      cat: "STATISTICAL",
    },
    {
      n: "Price/OI alignment",
      v: "nearest at-or-before",
      src: "same",
      fx: "FIXED methodological rule",
      cat: "DATA AVAILABILITY",
    },
  ];
  console.log("NAME | VALUE | SOURCE | FIXED/DATA-DERIVED | CATEGORY");
  audit.forEach((a) =>
    console.log(`${a.n} | ${a.v} | ${a.src} | ${a.fx} | ${a.cat}`),
  );

  console.log(`\n${"=".repeat(170)}`);
  console.log("RUN COMPLETED SUCCESSFULLY");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
