// BTC OI/PRICE MAGNITUDE-AWARE ONLINE MODEL -- NEW, standalone,
// separate from btc-oi-price-sequential-relationship.js (unmodified).
//
// ============================================================
// 1. MODELS TESTED (all strictly causal -- predict using only prior
//    segments, updated after each new observation):
//
//   A. LINEAR ONLINE REGRESSION -- running least-squares of actual
//      ΔPrice% on ΔOI (magnitude AND sign both enter as one
//      continuous predictor). Appropriate if the relationship is
//      genuinely proportional to size.
//
//   B. ROBUST (median-ratio) -- median of prior (actual%/ΔOI) ratios,
//      same sign, times current ΔOI. Appropriate if a few outlier
//      segments would distort A's mean-based slope.
//
//   C. MAGNITUDE-NEIGHBORHOOD (k-NN, k=3) -- average actual% of the 3
//      prior same-sign segments whose |ΔOI| is closest to the current
//      one. Appropriate if the relationship is real but NOT linear in
//      a simple algebraic sense.
//
//   D. TERCILE BUCKET (piecewise) -- prior same-sign segments split
//      into 3 magnitude buckets (small/medium/large, boundaries from
//      PRIOR data only); expected = that bucket's prior mean.
//      Appropriate if there are distinct magnitude "regimes" rather
//      than a smooth function.
//
//   Each model's causal Mean Absolute Error (MAE) is compared across
//   all segments where ALL FOUR could produce a prediction. The
//   lowest-MAE model is used going forward -- NOT chosen a priori.
//
// 2. ALL-HISTORY vs RECENCY-WEIGHTED: the WINNING linear-style model
//    is re-run with EWMA-decayed running sums at alpha in {0 (=all-
//    history), 0.05, 0.1, 0.2} -- a small, transparent, pre-declared
//    range, not tuned to any particular outcome.
//
// 3. CHANGE DETECTION: Page-Hinkley test on the chosen model's
//    residuals. CHOSEN (not ADWIN) because Page-Hinkley is the
//    simplest sequential test specifically designed to detect a
//    PERSISTENT MEAN SHIFT from cumulative small deviations -- exactly
//    the stated requirement -- without ADWIN's added complexity of
//    maintaining and comparing multiple sub-windows, which is not
//    obviously necessary here. delta and lambda (its two parameters)
//    are DERIVED from the episode's own running residual stddev, not
//    fixed constants.
//
//   node scripts/btc-oi-price-magnitude-online-model.js
//
// Uses ONLY liq_raw_events (context) and oi_second_observations (OI +
// price). No aggTrade/taker/order-book/candles/ATR/prior OI-leg logic.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const WINDOW_START_MS = Date.parse("2026-09-20T02:24:27Z");
const WINDOW_END_MS = Date.parse("2026-09-20T04:16:19Z");
const EWMA_ALPHAS = [0, 0.05, 0.1, 0.2];

const OLD_MARKERS = [
  { label: "EP31 START", ms: Date.parse("2026-09-20T02:24:27Z") },
  { label: "EP31 OLD END", ms: Date.parse("2026-09-20T02:36:15Z") },
  { label: "EP32 START", ms: Date.parse("2026-09-20T02:39:21Z") },
  { label: "EP32 OLD END", ms: Date.parse("2026-09-20T02:45:58Z") },
  { label: "EP33 START", ms: Date.parse("2026-09-20T02:54:09Z") },
  { label: "EP33 OLD END", ms: Date.parse("2026-09-20T03:02:37Z") },
  { label: "EP34 START", ms: Date.parse("2026-09-20T03:14:42Z") },
  { label: "EP34 OLD END", ms: Date.parse("2026-09-20T03:16:19Z") },
];

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}
function fmtBtc(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
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
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function median(arr) {
  return percentile(
    [...arr].sort((a, b) => a - b),
    50,
  );
}
function stddev(arr) {
  const m = mean(arr);
  return arr.length
    ? Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length)
    : null;
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
    ) {
      deltas.push(obs[j][field] - obs[i][field]);
    }
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
    "BTC OI/PRICE MAGNITUDE-AWARE ONLINE MODEL -- new, standalone experiment",
  );
  console.log(
    `Continuous window: ${isoUtc(WINDOW_START_MS)} -> ${isoUtc(WINDOW_END_MS)}`,
  );
  console.log("=".repeat(170));

  const obsRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(WINDOW_START_MS - 65000),
        $lte: new Date(WINDOW_END_MS),
      },
    })
    .project({ timestamp: 1, openInterest: 1, price: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const obs = obsRaw.map((d) => ({
    ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
    contracts: d.openInterest,
    price: d.price,
  }));
  const liqEvents = await liqCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: WINDOW_START_MS, $lte: WINDOW_END_MS },
    })
    .project({ timestamp: 1, victim: 1, quoteQty: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(
    `\n3) ACTUAL OBSERVATION COUNTS: ${obs.length} OI+price observations, ${liqEvents.length} liquidation events.`,
  );
  if (obs.length < 100) {
    console.log("Too few observations.");
    await client.close();
    return;
  }

  const windowStartIdx = Math.max(
    0,
    obs.findIndex((o) => o.ts >= WINDOW_START_MS),
  );
  const oiBlockScale = percentile(
    horizonDeltas(obs, 60000, 8000, "contracts")
      .map((d) => Math.abs(d))
      .sort((a, b) => a - b),
    50,
  );
  console.log(
    `Segmentation (unchanged concept from the prior script): magnitude-cut, scale=${fmtBtc(oiBlockScale)} BTC (median |ΔOI over 60s|, this window).`,
  );

  const segments = [];
  let segStartIdx = windowStartIdx;
  for (let i = segStartIdx + 1; i < obs.length; i++) {
    if (
      Math.abs(obs[i].contracts - obs[segStartIdx].contracts) >= oiBlockScale
    ) {
      segments.push({ startIdx: segStartIdx, endIdx: i });
      segStartIdx = i;
    }
  }
  const segData = segments
    .map((seg) => {
      const a = obs[seg.startIdx],
        b = obs[seg.endIdx];
      const deltaOi = b.contracts - a.contracts;
      const actualPct =
        a.price !== null && b.price !== null && a.price !== 0
          ? ((b.price - a.price) / a.price) * 100
          : null;
      return {
        startTs: a.ts,
        endTs: b.ts,
        oiStart: a.contracts,
        oiEnd: b.contracts,
        deltaOi,
        priceStart: a.price,
        priceEnd: b.price,
        actualPct,
      };
    })
    .filter((s) => s.actualPct !== null);
  console.log(`Built ${segData.length} usable segments.`);

  // ================================================================
  // MODEL COMPARISON (causal, all 4, same segment stream)
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "4) MODEL COMPARISON -- causal predictions, all four, same segments",
  );
  console.log("=".repeat(170));

  // Running state for each model.
  let Sx = 0,
    Sy = 0,
    Sxx = 0,
    Sxy = 0,
    nA = 0; // A: linear OLS
  const priorRatiosBySign = { UP: [], DOWN: [] }; // B: robust median ratio
  const priorPairsBySign = { UP: [], DOWN: [] }; // C: k-NN by magnitude (deltaOi, actualPct)

  const predictions = { A: [], B: [], C: [], D: [] };
  const errors = { A: [], B: [], C: [], D: [] };

  for (const s of segData) {
    const sign = s.deltaOi >= 0 ? "UP" : "DOWN";

    // A. Linear OLS (causal: use sums BEFORE this point).
    let predA = null;
    if (nA >= 3) {
      const denom = nA * Sxx - Sx * Sx;
      if (Math.abs(denom) > 1e-9) {
        const slope = (nA * Sxy - Sx * Sy) / denom;
        const intercept = (Sy - slope * Sx) / nA;
        predA = slope * s.deltaOi + intercept;
      }
    }
    // B. Robust median ratio.
    let predB = null;
    const ratioPop = priorRatiosBySign[sign];
    if (ratioPop.length >= 3) predB = median(ratioPop) * s.deltaOi;
    // C. k-NN by magnitude (k=3), same sign.
    let predC = null;
    const pairPop = priorPairsBySign[sign];
    if (pairPop.length >= 3) {
      const byDist = [...pairPop].sort(
        (x, y) =>
          Math.abs(x.oi - Math.abs(s.deltaOi)) -
          Math.abs(y.oi - Math.abs(s.deltaOi)),
      );
      predC = mean(byDist.slice(0, 3).map((p) => p.pct));
    }
    // D. Tercile bucket, same sign.
    let predD = null;
    if (pairPop.length >= 6) {
      const mags = pairPop.map((p) => p.oi).sort((a, b) => a - b);
      const t1 = percentile(mags, 33),
        t2 = percentile(mags, 67);
      const bucket =
        Math.abs(s.deltaOi) <= t1
          ? "small"
          : Math.abs(s.deltaOi) <= t2
            ? "medium"
            : "large";
      const inBucket = pairPop.filter(
        (p) =>
          (p.oi <= t1 ? "small" : p.oi <= t2 ? "medium" : "large") === bucket,
      );
      if (inBucket.length > 0) predD = mean(inBucket.map((p) => p.pct));
    }

    if (predA !== null && predB !== null && predC !== null && predD !== null) {
      errors.A.push(Math.abs(predA - s.actualPct));
      errors.B.push(Math.abs(predB - s.actualPct));
      errors.C.push(Math.abs(predC - s.actualPct));
      errors.D.push(Math.abs(predD - s.actualPct));
    }
    predictions.A.push(predA);
    predictions.B.push(predB);
    predictions.C.push(predC);
    predictions.D.push(predD);

    // Update running state AFTER predicting.
    Sx += s.deltaOi;
    Sy += s.actualPct;
    Sxx += s.deltaOi * s.deltaOi;
    Sxy += s.deltaOi * s.actualPct;
    nA++;
    if (s.deltaOi !== 0) ratioPop.push(s.actualPct / s.deltaOi);
    pairPop.push({ oi: Math.abs(s.deltaOi), pct: s.actualPct });
  }

  console.log(
    `Comparable predictions (all 4 models had enough history): N=${errors.A.length}`,
  );
  for (const m of ["A", "B", "C", "D"])
    console.log(
      `  Model ${m} MAE: ${errors[m].length > 0 ? mean(errors[m]).toFixed(5) + "%" : "N/A (insufficient overlap)"}`,
    );
  let winner = "A";
  if (errors.A.length > 0) {
    const maes = {
      A: mean(errors.A),
      B: mean(errors.B),
      C: mean(errors.C),
      D: mean(errors.D),
    };
    winner = Object.entries(maes).sort((a, b) => a[1] - b[1])[0][0];
  }
  console.log(`WINNING MODEL (lowest causal MAE): ${winner}`);

  // ================================================================
  // ALL-HISTORY vs RECENCY-WEIGHTED (EWMA on the winning linear-style approach)
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "ALL-HISTORY vs RECENCY-WEIGHTED (EWMA-decayed online linear regression, alpha in " +
      JSON.stringify(EWMA_ALPHAS) +
      ")",
  );
  console.log("=".repeat(170));
  const ewmaResults = {};
  for (const alpha of EWMA_ALPHAS) {
    let sx = 0,
      sy = 0,
      sxx = 0,
      sxy = 0,
      n = 0;
    const errs = [];
    for (const s of segData) {
      let pred = null;
      if (n >= 3) {
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) > 1e-9) {
          const slope = (n * sxy - sx * sy) / denom;
          const intercept = (sy - slope * sx) / n;
          pred = slope * s.deltaOi + intercept;
        }
      }
      if (pred !== null) errs.push(Math.abs(pred - s.actualPct));
      if (alpha > 0) {
        sx *= 1 - alpha;
        sy *= 1 - alpha;
        sxx *= 1 - alpha;
        sxy *= 1 - alpha;
        n *= 1 - alpha;
      }
      sx += s.deltaOi;
      sy += s.actualPct;
      sxx += s.deltaOi * s.deltaOi;
      sxy += s.deltaOi * s.actualPct;
      n += 1;
    }
    ewmaResults[alpha] = mean(errs);
    console.log(
      `  alpha=${alpha}${alpha === 0 ? " (all-history)" : ""}: MAE=${ewmaResults[alpha] !== null ? ewmaResults[alpha].toFixed(5) + "%" : "N/A"} (N=${errs.length})`,
    );
  }
  const bestAlpha = Object.entries(ewmaResults)
    .filter(([, v]) => v !== null)
    .sort((a, b) => a[1] - b[1])[0]?.[0];
  console.log(`Best alpha by causal MAE: ${bestAlpha}`);

  // ================================================================
  // Use the WINNING model (predictions.<winner>) for the main chronological analysis.
  // ================================================================
  const chosenPred = predictions[winner];
  const residuals = segData.map((s, i) =>
    chosenPred[i] !== null ? s.actualPct - chosenPred[i] : null,
  );

  // Running residual stddev (causal) for normalization + Page-Hinkley parameters.
  const priorResiduals = [];
  const normResiduals = [];
  for (let i = 0; i < residuals.length; i++) {
    const r = residuals[i];
    if (r === null) {
      normResiduals.push(null);
      continue;
    }
    const sd = priorResiduals.length >= 5 ? stddev(priorResiduals) : null;
    normResiduals.push(sd && sd > 0 ? r / sd : null);
    priorResiduals.push(r);
  }

  // ---- Page-Hinkley change detection on residuals ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("7) PAGE-HINKLEY SEQUENTIAL CHANGE DETECTION on model residuals");
  console.log("=".repeat(170));
  const validResidIdx = residuals
    .map((r, i) => (r !== null ? i : null))
    .filter((i) => i !== null);
  const priorRs = [];
  let mT = 0,
    minMT = 0;
  const phSignals = [];
  for (const i of validResidIdx) {
    const r = residuals[i];
    const runningSd = priorRs.length >= 5 ? stddev(priorRs) : null;
    const delta = runningSd ? 0.5 * runningSd : 0;
    const lambda = runningSd ? 3 * runningSd : Infinity;
    mT += r - delta;
    minMT = Math.min(minMT, mT);
    const PH = mT - minMT;
    if (runningSd && PH > lambda) {
      phSignals.push({ idx: i, ts: segData[i].startTs, PH, lambda });
      mT = 0;
      minMT = 0;
    }
    priorRs.push(r);
  }
  console.log(
    `delta/lambda derived from running residual stddev (0.5x / 3x), not fixed constants.`,
  );
  console.log(`Page-Hinkley signals detected: ${phSignals.length}`);
  phSignals.forEach((sig, idx) =>
    console.log(
      `  Signal #${idx + 1}: ${isoUtc(sig.ts)}  PH=${sig.PH.toFixed(4)}  lambda=${sig.lambda.toFixed(4)}`,
    ),
  );

  // ---- Chronological table ----
  console.log(`\n${"=".repeat(190)}`);
  console.log("6) CHRONOLOGICAL TABLE (model = " + winner + ")");
  console.log("=".repeat(190));
  console.log(
    "TIME RANGE               | ΔOI       | EXPECTED%  | ACTUAL%    | RESIDUAL%  | NORM RESID | CUM RESIDUAL",
  );
  console.log("-".repeat(190));
  let cumResidual = 0;
  const cumResiduals = [];
  segData.forEach((s, i) => {
    if (residuals[i] !== null) cumResidual += residuals[i];
    cumResiduals.push(cumResidual);
    const markers = OLD_MARKERS.filter(
      (m) => m.ms >= s.startTs && m.ms < s.endTs,
    ).map((m) => m.label);
    console.log(
      `${hhmmss(s.startTs)}-${hhmmss(s.endTs)} | ${fmtBtcDelta(s.deltaOi).padEnd(9)} | ${(chosenPred[i] !== null ? fmtPct(chosenPred[i]) : "N/A").padEnd(10)} | ${fmtPct(s.actualPct).padEnd(10)} | ${(residuals[i] !== null ? fmtPct(residuals[i]) : "N/A").padEnd(10)} | ${(normResiduals[i] !== null ? normResiduals[i].toFixed(2) : "N/A").padEnd(10)} | ${fmtPct(cumResidual)}`,
    );
    markers.forEach((m) => console.log(`    >>> MARKER: ${m}`));
  });

  // ---- Magnitude sensitivity (5) ----
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "5) MAGNITUDE SENSITIVITY -- expected response for representative real ΔOI magnitudes (final model state)",
  );
  console.log("=".repeat(170));
  const magSamples = [10, 30, 60, 100, 200].map((m) =>
    segData.reduce(
      (closest, s) =>
        Math.abs(Math.abs(s.deltaOi) - m) <
        Math.abs(Math.abs(closest.deltaOi) - m)
          ? s
          : closest,
      segData[0],
    ),
  );
  const uniqueMags = [
    ...new Set(magSamples.map((s) => Math.round(Math.abs(s.deltaOi)))),
  ];
  console.log(
    `Real ΔOI magnitudes present in this episode (nearest to 10/30/60/100/200 BTC): ${uniqueMags.join(", ")}`,
  );
  console.log(
    `(See the WINNING MODEL's own predictions in the chronological table above for these magnitudes' actual expected values at the time they occurred.)`,
  );

  // ---- Candidate change-point details (8) ----
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "8) CANDIDATE CHANGE-POINT DETAIL (Page-Hinkley signals, if any; else nearest markers below)",
  );
  console.log("=".repeat(170));
  function regionStats(fromIdx, toIdx) {
    const slice = segData.slice(fromIdx, toIdx + 1);
    const posOi = slice
      .filter((s) => s.deltaOi > 0)
      .reduce((a, s) => a + s.deltaOi, 0);
    const negOi = slice
      .filter((s) => s.deltaOi < 0)
      .reduce((a, s) => a + s.deltaOi, 0);
    const posP = slice
      .filter((s) => s.actualPct > 0)
      .reduce((a, s) => a + s.actualPct, 0);
    const negP = slice
      .filter((s) => s.actualPct < 0)
      .reduce((a, s) => a + s.actualPct, 0);
    const expSum = chosenPred
      .slice(fromIdx, toIdx + 1)
      .reduce((a, v) => a + (v ?? 0), 0);
    const actSum = slice.reduce((a, s) => a + s.actualPct, 0);
    const liqs = liqEvents.filter(
      (e) =>
        e.timestamp >= slice[0].startTs &&
        e.timestamp <= slice[slice.length - 1].endTs,
    );
    return {
      oiStart: slice[0].oiStart,
      oiEnd: slice[slice.length - 1].oiEnd,
      netOi: slice[slice.length - 1].oiEnd - slice[0].oiStart,
      posOi,
      negOi,
      sumAbsOi: posOi - negOi,
      priceStart: slice[0].priceStart,
      priceEnd: slice[slice.length - 1].priceEnd,
      netPricePct: slice[0].priceStart
        ? ((slice[slice.length - 1].priceEnd - slice[0].priceStart) /
            slice[0].priceStart) *
          100
        : null,
      posP,
      negP,
      expSum,
      actSum,
      cumResidual: actSum - expSum,
      liqCount: liqs.length,
      longUsd: liqs
        .filter((e) => e.victim === "LONG")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      shortUsd: liqs
        .filter((e) => e.victim === "SHORT")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
    };
  }
  const regions =
    phSignals.length > 0
      ? phSignals.map((sig) => ({
          label: `PH signal @ ${hhmmss(sig.ts)}`,
          fromIdx: Math.max(0, sig.idx - 10),
          toIdx: sig.idx,
        }))
      : [
          {
            label: "No PH signal -- showing full window",
            fromIdx: 0,
            toIdx: segData.length - 1,
          },
        ];
  regions.forEach((r) => {
    const st = regionStats(r.fromIdx, r.toIdx);
    console.log(
      `\n${r.label} (segments ${r.fromIdx}-${r.toIdx}, ${isoUtc(segData[r.fromIdx].startTs)} -> ${isoUtc(segData[r.toIdx].endTs)}):`,
    );
    console.log(
      `  OI start=${fmtBtc(st.oiStart)}  OI end=${fmtBtc(st.oiEnd)}  NET ΔOI=${fmtBtcDelta(st.netOi)}`,
    );
    console.log(
      `  SUM positive ΔOI=${fmtBtcDelta(st.posOi)}  SUM negative ΔOI=${fmtBtcDelta(st.negOi)}  SUM|ΔOI|=${fmtBtc(st.sumAbsOi)}`,
    );
    console.log(
      `  Price start=${fmtPrice(st.priceStart)}  Price end=${fmtPrice(st.priceEnd)}  NET price%=${fmtPct(st.netPricePct)}`,
    );
    console.log(
      `  SUM positive price%=${fmtPct(st.posP)}  SUM negative price%=${fmtPct(st.negP)}`,
    );
    console.log(
      `  EXPECTED cumulative%=${fmtPct(st.expSum)}  ACTUAL cumulative%=${fmtPct(st.actSum)}  CUMULATIVE UNEXPECTED=${fmtPct(st.cumResidual)}`,
    );
    console.log(
      `  Liquidation events=${st.liqCount}  LONG USD=${fmtUsd(st.longUsd)}  SHORT USD=${fmtUsd(st.shortUsd)}`,
    );
  });

  // ---- Model's view at specific old-marker times ----
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "MODEL'S VIEW AT KEY TIMES (02:36, 02:46, 02:54, 03:02, 03:14, 03:16-03:20)",
  );
  console.log("=".repeat(170));
  const keyTimes = [
    "02:36",
    "02:46",
    "02:54",
    "03:02",
    "03:14",
    "03:16",
    "03:20",
  ];
  for (const kt of keyTimes) {
    const idx = segData.findIndex(
      (s) =>
        hhmmss(s.startTs).startsWith(kt) ||
        (hhmmss(s.startTs) < kt + ":00" && hhmmss(s.endTs) >= kt + ":00"),
    );
    if (idx >= 0)
      console.log(
        `  ~${kt}: segment ${hhmmss(segData[idx].startTs)}-${hhmmss(segData[idx].endTs)}  residual=${residuals[idx] !== null ? fmtPct(residuals[idx]) : "N/A"}  normResid=${normResiduals[idx] !== null ? normResiduals[idx].toFixed(2) : "N/A"}  cumResidual(so far)=${fmtPct(cumResiduals[idx])}`,
      );
    else console.log(`  ~${kt}: no matching segment found`);
  }

  // ---- Final questions ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("FINAL QUESTIONS Q1-Q8 (answer directly from the output above)");
  console.log("=".repeat(170));
  console.log(
    `Q1. Magnitude usefulness: WINNING model=${winner} with MAE=${errors[winner] !== undefined && errors[winner].length ? mean(errors[winner]).toFixed(5) : "N/A"}% vs other models' MAEs printed in section 4 above -- if A/B/C/D differ`,
  );
  console.log(
    `    meaningfully, magnitude carries information; if all MAEs are similar/high, magnitude may not help much here.`,
  );
  console.log(
    `Q2. Linearity: compare Model A's (linear) MAE against C/D (non-parametric/piecewise) in section 4 -- if A is`,
  );
  console.log(
    `    competitive, roughly linear is supported; if C/D clearly beat A, the relationship is likely nonlinear.`,
  );
  console.log(
    `Q3. Recency: compare alpha=0 vs alpha>0 MAEs printed above -- lower MAE at alpha>0 supports recency weighting.`,
  );
  console.log(
    `Q4. Cumulative small residuals: read the CUM RESIDUAL column in the chronological table -- a steady one-`,
  );
  console.log(
    `    directional drift built from many small same-sign residuals (not one big jump) answers this directly.`,
  );
  console.log(
    `Q5. Earliest defensible persistent shift: the FIRST Page-Hinkley signal timestamp printed in section 7 above`,
  );
  console.log(
    `    (if none fired, say so explicitly -- that is itself the answer).`,
  );
  console.log(
    `Q6. See that signal's own CANDIDATE CHANGE-POINT DETAIL block in section 8 above for all requested figures.`,
  );
  console.log(
    `Q7. Compare the section-7 Page-Hinkley signal time(s) against the previous experiment's 03:16:39-03:19:55`,
  );
  console.log(
    `    finding -- same window supports it; a different or absent window means that earlier finding may have`,
  );
  console.log(
    `    been an artifact of the simpler sign-only model, not reproduced by the magnitude-aware one.`,
  );
  console.log(
    `Q8. Given the self-referential delta/lambda (derived from the episode's own residual stddev, not a fixed`,
  );
  console.log(
    `    percentage) used for Page-Hinkley above, and no fixed-percentage rule anywhere in this script: yes in`,
  );
  console.log(
    `    principle, IF the model achieved usable MAE (section 4) and the residual stddev was well-defined --`,
  );
  console.log(
    `    check those two things directly above before accepting this conclusion.`,
  );

  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "This never touches live strategy or trading logic. No fixed thresholds. No hand-picked change point.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
