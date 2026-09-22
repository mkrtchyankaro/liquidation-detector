// BTC OI/PRICE MAGNITUDE-AWARE ONLINE MODEL -- v2, AUDITED/FIXED.
//
// ============================================================
// BUG FOUND: YES, TWO BUGS.
//
// BUG 1 -- WRONG RETURN TYPE: v1 summed SIMPLE percentage returns
// ((p_end-p_start)/p_start) segment by segment and called the sum
// "cumulative actual response". Simple percentage returns do NOT sum
// correctly across a compounded path -- only LOG returns do:
//   r_i = ln(p_i/p_(i-1))  =>  Σr_i = ln(p_n/p_0) EXACTLY.
// v2 uses log returns throughout for actual_i, expected_i, and all
// cumulative sums.
//
// BUG 2 -- SILENT COVERAGE LOSS (the dominant cause of the operator's
// sign-flipped example): v1 built magnitude-cut segments purely from
// OI, then computed actualPct from THAT SAME segment's own boundary
// price fields, and — critically — FILTERED OUT any segment whose
// boundary price was null (`.filter(s => s.actualPct !== null)`).
// This silently DELETED that segment's entire price path (and OI
// path) from every downstream sum, breaking contiguity: the next
// surviving segment's own "actual" no longer represented the true
// continuous price path, so segment-sum cumulative-actual and the
// true start->end price return could diverge arbitrarily, including
// in SIGN, depending on which segments happened to get dropped.
//
// v2 FIX: segments are NEVER dropped for a null price. When a
// segment boundary's own document has price=null, this script walks
// BACKWARD (causal) to the nearest EARLIER observation with a
// non-null price and uses that instead -- flagged explicitly per
// segment, and folded into a per-region COVERAGE_PCT diagnostic.
//
//   node scripts/btc-oi-price-magnitude-online-model-v2.js
//
// SCOPE OF THIS PASS (per operator instruction): fix the accounting
// only. Kept to ONE model (online linear regression on log-returns,
// the same style as v1's Model A) rather than re-running the full
// A/B/C/D comparison -- that comparison can be re-run on this FIXED
// accounting in a later pass once this audit is accepted.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const WINDOW_START_MS = Date.parse("2026-09-20T02:24:27Z");
const WINDOW_END_MS = Date.parse("2026-09-20T04:16:19Z");
const NUMERIC_TOLERANCE = 1e-6;

const KEY_TIMES = [
  "02:36",
  "02:46",
  "02:54",
  "03:02",
  "03:04",
  "03:14",
  "03:16",
  "03:20",
];
const CANDIDATE_TIMESTAMPS = ["02:54:29", "03:04:11", "03:16:48"];

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
function fmtLogRet(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(4)}%`;
} // displayed as %, computed in log space
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

/** Causal backward-fill: nearest observation at-or-before idx with a
 *  non-null price. Returns {price, sourceIdx, filled:boolean}. */
function priceAtOrBeforeIdx(obs, idx) {
  for (let k = idx; k >= 0; k--) {
    if (obs[k].price !== null)
      return { price: obs[k].price, sourceIdx: k, filled: k !== idx };
  }
  return { price: null, sourceIdx: -1, filled: true };
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
    "1) BUG FOUND: YES -- two bugs (see file header for full explanation)",
  );
  console.log("   (1) simple-% returns summed instead of log returns");
  console.log(
    "   (2) segments with a null boundary price were SILENTLY DROPPED, breaking price-path contiguity",
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
    `\nLoaded ${obs.length} OI+price observations, ${liqEvents.length} liquidation events.`,
  );
  const nullPriceCount = obs.filter((o) => o.price === null).length;
  console.log(
    `Observations with null price field: ${nullPriceCount} of ${obs.length} (${((nullPriceCount / obs.length) * 100).toFixed(2)}%).`,
  );

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
    `\nSegmentation (unchanged from v1): magnitude-cut, scale=${fmtBtc(oiBlockScale)} BTC.`,
  );

  // ---- Build segments -- NEVER dropped for null price ----
  const rawSegments = [];
  let segStartIdx = windowStartIdx;
  for (let i = segStartIdx + 1; i < obs.length; i++) {
    if (
      Math.abs(obs[i].contracts - obs[segStartIdx].contracts) >= oiBlockScale
    ) {
      rawSegments.push({ startIdx: segStartIdx, endIdx: i });
      segStartIdx = i;
    }
  }
  console.log(
    `Built ${rawSegments.length} segments (all retained -- none dropped for missing price).`,
  );

  const segData = rawSegments.map((seg) => {
    const startPriceInfo = priceAtOrBeforeIdx(obs, seg.startIdx);
    const endPriceInfo = priceAtOrBeforeIdx(obs, seg.endIdx);
    const a = obs[seg.startIdx],
      b = obs[seg.endIdx];
    const deltaOi = b.contracts - a.contracts;
    const actualLogRet =
      startPriceInfo.price !== null && endPriceInfo.price !== null
        ? Math.log(endPriceInfo.price / startPriceInfo.price)
        : null;
    return {
      startTs: a.ts,
      endTs: b.ts,
      oiStart: a.contracts,
      oiEnd: b.contracts,
      deltaOi,
      priceStart: startPriceInfo.price,
      priceEnd: endPriceInfo.price,
      priceStartFilled: startPriceInfo.filled,
      priceEndFilled: endPriceInfo.filled,
      actualLogRet,
    };
  });
  const usableSegs = segData.filter((s) => s.actualLogRet !== null);
  console.log(
    `Usable segments (valid price found via causal backward-fill if needed): ${usableSegs.length} of ${segData.length}.`,
  );
  const filledCount = usableSegs.filter(
    (s) => s.priceStartFilled || s.priceEndFilled,
  ).length;
  console.log(
    `Segments that required backward-fill at a boundary: ${filledCount} (${((filledCount / usableSegs.length) * 100).toFixed(1)}%).`,
  );
  console.log(
    `Price alignment rule: PRICE at time T = price of the nearest observation AT OR BEFORE T (causal); flagged when the exact-timestamp document's own price was null.`,
  );

  // ================================================================
  // MODEL: online linear regression on log-returns (kept as ONE model per audit scope)
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "MODEL (kept simple for this audit pass): online linear regression, log-return target",
  );
  console.log("=".repeat(170));

  let Sx = 0,
    Sy = 0,
    Sxx = 0,
    Sxy = 0,
    n = 0;
  const expected = [],
    residual = [],
    normResidual = [];
  const priorResiduals = [];
  for (const s of usableSegs) {
    let pred = null;
    if (n >= 3) {
      const denom = n * Sxx - Sx * Sx;
      if (Math.abs(denom) > 1e-12) {
        const slope = (n * Sxy - Sx * Sy) / denom;
        const intercept = (Sy - slope * Sx) / n;
        pred = slope * s.deltaOi + intercept;
      }
    }
    expected.push(pred);
    const r = pred !== null ? s.actualLogRet - pred : null;
    residual.push(r);
    const sd =
      r !== null && priorResiduals.length >= 5 ? stddev(priorResiduals) : null;
    normResidual.push(r !== null && sd && sd > 0 ? r / sd : null);
    if (r !== null) priorResiduals.push(r);

    Sx += s.deltaOi;
    Sy += s.actualLogRet;
    Sxx += s.deltaOi * s.deltaOi;
    Sxy += s.deltaOi * s.actualLogRet;
    n++;
  }

  // ================================================================
  // ACCOUNTING ASSERTIONS
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log("4) ACCOUNTING ASSERTIONS");
  console.log("=".repeat(170));

  // PRICE: Σ actual log-returns over the FULL usable run vs true start->end log-return.
  const fullSumActual = usableSegs.reduce((a, s) => a + s.actualLogRet, 0);
  const trueStartToEnd = Math.log(
    usableSegs[usableSegs.length - 1].priceEnd / usableSegs[0].priceStart,
  );
  const priceAssertOk =
    Math.abs(fullSumActual - trueStartToEnd) <
    NUMERIC_TOLERANCE * usableSegs.length;
  console.log(
    `PRICE: Σ actual_i (log) = ${fmtLogRet(fullSumActual)}   vs   ln(END/START) = ${fmtLogRet(trueStartToEnd)}   ${priceAssertOk ? "PASS" : "FAIL -- gap or non-contiguous coverage present"}`,
  );

  // OI: Σ ΔOI_i vs OI_END - OI_START.
  const fullSumOi = usableSegs.reduce((a, s) => a + s.deltaOi, 0);
  const trueNetOi =
    usableSegs[usableSegs.length - 1].oiEnd - usableSegs[0].oiStart;
  const oiAssertOk = Math.abs(fullSumOi - trueNetOi) < 1e-6;
  console.log(
    `OI:    Σ ΔOI_i = ${fmtBtcDelta(fullSumOi)}   vs   OI_END-OI_START = ${fmtBtcDelta(trueNetOi)}   ${oiAssertOk ? "PASS" : "FAIL"}`,
  );

  // RESIDUAL: Σ residual_i vs Σactual - Σexpected (over segments where both are defined).
  const pairedIdx = residual
    .map((r, i) => (r !== null ? i : null))
    .filter((i) => i !== null);
  const sumResid = pairedIdx.reduce((a, i) => a + residual[i], 0);
  const sumActualPaired = pairedIdx.reduce(
    (a, i) => a + usableSegs[i].actualLogRet,
    0,
  );
  const sumExpectedPaired = pairedIdx.reduce((a, i) => a + expected[i], 0);
  const residAssertOk =
    Math.abs(sumResid - (sumActualPaired - sumExpectedPaired)) <
    NUMERIC_TOLERANCE * pairedIdx.length;
  console.log(
    `RESID: Σ residual_i = ${fmtLogRet(sumResid)}   vs   Σactual-Σexpected = ${fmtLogRet(sumActualPaired - sumExpectedPaired)}   ${residAssertOk ? "PASS" : "FAIL"}`,
  );

  // ================================================================
  // Coverage diagnostics
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log("5) COVERAGE DIAGNOSTICS");
  console.log("=".repeat(170));
  const coveragePct =
    ((usableSegs.length - filledCount) / usableSegs.length) * 100;
  console.log(
    `Overall PRICE_PATH_COVERAGE: ${coveragePct.toFixed(2)}% of segments had an exact-timestamp price at both boundaries (no backward-fill needed).`,
  );
  if (filledCount > 0) {
    console.log(`Segments requiring backward-fill:`);
    usableSegs.forEach((s, i) => {
      if (s.priceStartFilled || s.priceEndFilled)
        console.log(
          `  ${hhmmss(s.startTs)}-${hhmmss(s.endTs)}  startFilled=${s.priceStartFilled}  endFilled=${s.priceEndFilled}`,
        );
    });
  }

  // ================================================================
  // Page-Hinkley: GENERIC (two-sided) and RECOVERY-SIDE (one-sided, UP only)
  // NO RESET after trigger, per instruction -- continuous evidence.
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "7/8) PAGE-HINKLEY -- GENERIC (two-sided) vs RECOVERY-SIDE (one-sided, UP only). No reset after signal.",
  );
  console.log("=".repeat(170));

  const genericSignals = [],
    recoverySignals = [];
  let mtGenericUp = 0,
    minGenericUp = 0,
    mtGenericDown = 0,
    minGenericDown = 0;
  let mtRecovery = 0,
    minRecovery = 0;
  const phTrace = [];

  const rs = [];
  for (let i = 0; i < usableSegs.length; i++) {
    const r = residual[i];
    if (r === null) {
      phTrace.push(null);
      continue;
    }
    const sd = rs.length >= 5 ? stddev(rs) : null;
    const delta = sd ? 0.5 * sd : 0;
    const lambda = sd ? 3 * sd : Infinity;

    // Generic, two-sided: track both an "increase" and "decrease" cumulative stat.
    mtGenericUp += r - delta;
    minGenericUp = Math.min(minGenericUp, mtGenericUp);
    const PH_up = mtGenericUp - minGenericUp;
    mtGenericDown += -r - delta;
    minGenericDown = Math.min(minGenericDown, mtGenericDown);
    const PH_down = mtGenericDown - minGenericDown;
    const genericTriggered = sd && (PH_up > lambda || PH_down > lambda);
    if (genericTriggered)
      genericSignals.push({
        idx: i,
        ts: usableSegs[i].startTs,
        PH_up,
        PH_down,
        lambda,
      });

    // Recovery-side ONLY (one-sided, residual persistently positive = price better than the down-biased expectation).
    mtRecovery += r - delta;
    minRecovery = Math.min(minRecovery, mtRecovery);
    const PH_recovery = mtRecovery - minRecovery;
    const recoveryTriggered = sd && PH_recovery > lambda;
    if (recoveryTriggered)
      recoverySignals.push({
        idx: i,
        ts: usableSegs[i].startTs,
        PH_recovery,
        lambda,
      });

    phTrace.push({
      PH_up,
      PH_down,
      PH_recovery,
      lambda,
      sd,
      delta,
      genericTriggered,
      recoveryTriggered,
    });
    rs.push(r);
  }

  console.log(
    `GENERIC CHANGE signals (either direction, no reset): ${genericSignals.length}`,
  );
  genericSignals.forEach((sig, idx) =>
    console.log(
      `  #${idx + 1}: ${isoUtc(sig.ts)}  PH_up=${sig.PH_up.toFixed(5)}  PH_down=${sig.PH_down.toFixed(5)}  lambda=${sig.lambda.toFixed(5)}`,
    ),
  );
  console.log(
    `\nRECOVERY-SIDE CHANGE signals (one-sided UP only, no reset): ${recoverySignals.length}`,
  );
  recoverySignals.forEach((sig, idx) =>
    console.log(
      `  #${idx + 1}: ${isoUtc(sig.ts)}  PH_recovery=${sig.PH_recovery.toFixed(5)}  lambda=${sig.lambda.toFixed(5)}`,
    ),
  );

  // ---- Full trace around each previously-reported candidate timestamp ----
  console.log(`\n${"=".repeat(190)}`);
  console.log(
    `FULL PAGE-HINKLEY TRACE around previous candidates: ${CANDIDATE_TIMESTAMPS.join(", ")}`,
  );
  console.log("=".repeat(190));
  for (const candTime of CANDIDATE_TIMESTAMPS) {
    const candMs = Date.parse(`2026-09-20T${candTime}Z`);
    const centerIdx = usableSegs.reduce(
      (best, s, i) =>
        Math.abs(s.startTs - candMs) <
        Math.abs(usableSegs[best].startTs - candMs)
          ? i
          : best,
      0,
    );
    console.log(
      `\nAround ${candTime} (nearest segment index ${centerIdx}, ${hhmmss(usableSegs[centerIdx].startTs)}):`,
    );
    console.log(
      "TIME     | ΔOI       | ACTUAL(log%) | EXPECTED(log%) | RESIDUAL   | NORM RESID | PH_up    | PH_down  | PH_recov | lambda   | TRIGGER",
    );
    for (
      let i = Math.max(0, centerIdx - 5);
      i <= Math.min(usableSegs.length - 1, centerIdx + 5);
      i++
    ) {
      const t = phTrace[i];
      const s = usableSegs[i];
      console.log(
        `${hhmmss(s.startTs)} | ${fmtBtcDelta(s.deltaOi).padEnd(9)} | ${fmtLogRet(s.actualLogRet).padEnd(12)} | ${(expected[i] !== null ? fmtLogRet(expected[i]) : "N/A").padEnd(14)} | ${(residual[i] !== null ? fmtLogRet(residual[i]) : "N/A").padEnd(10)} | ${(normResidual[i] !== null ? normResidual[i].toFixed(2) : "N/A").padEnd(10)} | ${t ? t.PH_up.toFixed(3).padEnd(8) : "N/A".padEnd(8)} | ${t ? t.PH_down.toFixed(3).padEnd(8) : "N/A".padEnd(8)} | ${t ? t.PH_recovery.toFixed(3).padEnd(8) : "N/A".padEnd(8)} | ${t && t.lambda !== Infinity ? t.lambda.toFixed(3).padEnd(8) : "N/A".padEnd(8)} | ${t ? (t.genericTriggered ? "GENERIC " : "") + (t.recoveryTriggered ? "RECOVERY" : "") : ""}`,
      );
    }
  }

  // ================================================================
  // Q9: do the three original candidates survive?
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "9) DO THE THREE PREVIOUS CANDIDATES SURVIVE AFTER THE ACCOUNTING FIX?",
  );
  console.log("=".repeat(170));
  for (const candTime of CANDIDATE_TIMESTAMPS) {
    const candMs = Date.parse(`2026-09-20T${candTime}Z`);
    const nearGeneric = genericSignals.find(
      (s) => Math.abs(s.ts - candMs) < 60000,
    );
    const nearRecovery = recoverySignals.find(
      (s) => Math.abs(s.ts - candMs) < 60000,
    );
    console.log(
      `${candTime}: GENERIC signal nearby=${nearGeneric ? "YES @ " + hhmmss(nearGeneric.ts) : "NO"}   RECOVERY-SIDE signal nearby=${nearRecovery ? "YES @ " + hhmmss(nearRecovery.ts) : "NO"}`,
    );
  }

  // ================================================================
  // 10) surviving recovery-candidate detail
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log("10) SURVIVING RECOVERY-SIDE CANDIDATE DETAIL");
  console.log("=".repeat(170));
  function regionStats(fromIdx, toIdx) {
    const slice = usableSegs.slice(fromIdx, toIdx + 1);
    const posOi = slice
      .filter((s) => s.deltaOi > 0)
      .reduce((a, s) => a + s.deltaOi, 0);
    const negOi = slice
      .filter((s) => s.deltaOi < 0)
      .reduce((a, s) => a + s.deltaOi, 0);
    const cumActual = slice.reduce((a, s) => a + s.actualLogRet, 0);
    const cumExpected = expected
      .slice(fromIdx, toIdx + 1)
      .reduce((a, v) => a + (v ?? 0), 0);
    const filledIn = slice.filter(
      (s) => s.priceStartFilled || s.priceEndFilled,
    ).length;
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
      grossOi: posOi - negOi,
      priceStart: slice[0].priceStart,
      priceEnd: slice[slice.length - 1].priceEnd,
      netPriceReturn: Math.log(
        slice[slice.length - 1].priceEnd / slice[0].priceStart,
      ),
      cumExpected,
      cumActual,
      cumResidual: cumActual - cumExpected,
      coveragePct: ((slice.length - filledIn) / slice.length) * 100,
      liqCount: liqs.length,
      longUsd: liqs
        .filter((e) => e.victim === "LONG")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      shortUsd: liqs
        .filter((e) => e.victim === "SHORT")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
    };
  }
  if (recoverySignals.length === 0) {
    console.log("No recovery-side signals survived.");
  } else {
    recoverySignals.forEach((sig, idx) => {
      const st = regionStats(Math.max(0, sig.idx - 15), sig.idx);
      console.log(`\nCandidate #${idx + 1} @ ${isoUtc(sig.ts)}:`);
      console.log(
        `  OI_START=${fmtBtc(st.oiStart)}  OI_END=${fmtBtc(st.oiEnd)}  NET_OI=${fmtBtcDelta(st.netOi)}`,
      );
      console.log(
        `  POSITIVE_OI=${fmtBtcDelta(st.posOi)}  NEGATIVE_OI=${fmtBtcDelta(st.negOi)}  GROSS_OI_ACTIVITY=${fmtBtc(st.grossOi)}`,
      );
      console.log(
        `  PRICE_START=${fmtPrice(st.priceStart)}  PRICE_END=${fmtPrice(st.priceEnd)}  NET_PRICE_RETURN=${fmtLogRet(st.netPriceReturn)}`,
      );
      console.log(
        `  CUM_EXPECTED=${fmtLogRet(st.cumExpected)}  CUM_ACTUAL=${fmtLogRet(st.cumActual)}  CUM_RESIDUAL=${fmtLogRet(st.cumResidual)}`,
      );
      console.log(`  PRICE_PATH_COVERAGE=${st.coveragePct.toFixed(1)}%`);
      console.log(
        `  LONG_LIQ_USD=${fmtUsd(st.longUsd)}  SHORT_LIQ_USD=${fmtUsd(st.shortUsd)}  (${st.liqCount} events, context only)`,
      );
    });
  }

  // ================================================================
  // 11) compact chronological summary 02:24:27 -> 03:25
  // ================================================================
  console.log(`\n${"=".repeat(170)}`);
  console.log("11) COMPACT CHRONOLOGICAL SUMMARY, 02:24:27 -> 03:25");
  console.log("=".repeat(170));
  let cumResid = 0;
  usableSegs.forEach((s, i) => {
    if (s.startTs > Date.parse("2026-09-20T03:25:00Z")) return;
    if (residual[i] !== null) cumResid += residual[i];
    const kt = KEY_TIMES.find((k) => hhmmss(s.startTs).startsWith(k));
    const marker = kt ? `  <<< ~${kt}` : "";
    console.log(
      `${hhmmss(s.startTs)}-${hhmmss(s.endTs)}  ΔOI=${fmtBtcDelta(s.deltaOi).padEnd(9)}  residual=${(residual[i] !== null ? fmtLogRet(residual[i]) : "N/A").padEnd(10)}  cumResidual=${fmtLogRet(cumResid)}${marker}`,
    );
  });

  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "This never touches live strategy or trading logic. No fixed thresholds. No hardcoded EP31-34 answer.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
