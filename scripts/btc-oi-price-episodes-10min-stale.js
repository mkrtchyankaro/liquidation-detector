// BTC OI->PRICE EPISODES, 10-MINUTE STALE TIMEOUT -- new standalone
// script, corrects btc-oi-price-episodes-p90-filtered.js.
//
// CORRECTION: the 3-hour operational cap is replaced by
// STALE_TIMEOUT = 10 minutes, measured from the ORIGINAL candidate
// START, NEVER reset by new liquidation events. Reaching the timeout
// without a valid OI->Price structural END produces DROP_STALE, which
// is NOT END_CONFIRMED and is NEVER a market claim. DROP_STALE
// candidates are EXCLUDED from the P90/P100 historical baseline --
// only END_CONFIRMED episodes are eligible.
//
// The structural END detector itself (magnitude-cut segmentation +
// causal log-return online OLS + direction-aware Page-Hinkley, no
// reset, 5-segment confirmation) is REUSED UNCHANGED from the prior
// scripts -- only the operational cap changed, per instruction.
//
//   node scripts/btc-oi-price-episodes-10min-stale.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EVAL_DAYS = 3;
const BASELINE_DAYS = 3;
const STALE_TIMEOUT_MS = 10 * 60 * 1000; // NEW -- replaces the old 3-hour cap
const CONFIRMATION_WINDOW_SEGMENTS = 5; // CARRIED OVER UNCHANGED
const NUMERIC_TOLERANCE = 1e-6; // CARRIED OVER UNCHANGED
const MIN_LIVE_SAMPLE = 5;

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
  let c = 0;
  for (const v of sortedPop) if (v <= x) c++;
  return (c / sortedPop.length) * 100;
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

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;

  console.log("=".repeat(170));
  console.log(
    `STALE_TIMEOUT = ${STALE_TIMEOUT_MS / 60000} minutes, measured from ORIGINAL candidate START, never reset by new liquidations.`,
  );
  console.log(
    `DROP_STALE != END_CONFIRMED. DROP_STALE candidates are EXCLUDED from the P90/P100 baseline entirely.`,
  );
  console.log(
    `Structural END detector (segmentation + OLS + Page-Hinkley) reused UNCHANGED -- only the operational cap changed (3h -> 10min).`,
  );
  console.log("=".repeat(170));

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
        $lte: new Date(evalEndMs + STALE_TIMEOUT_MS),
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
    `\nLoad window: ${isoUtc(loadStartMs)} -> ${isoUtc(evalEndMs)}   Evaluation period: ${isoUtc(evalStartMs)} -> ${isoUtc(evalEndMs)}`,
  );
  console.log(
    `Raw liquidation events: ${allLiq.length}   OI+price observations: ${allOi.length}`,
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
    `oiBlockScale (median |ΔOI over 60s|): ${fmtBtc(oiBlockScale)} BTC\n`,
  );

  const episodes = []; // END_CONFIRMED only
  const dropStale = []; // DROP_STALE only
  let invalidCount = 0;
  let liqIdx = 0;

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
    const staleTs = startTs + STALE_TIMEOUT_MS;
    let endIdxCap = startIdx;
    for (let k = startIdx; k < allOi.length; k++) {
      if (allOi[k].ts <= staleTs) endIdxCap = k;
      else break;
    }

    function absorbAsDropStale() {
      const boundaryTs = staleTs;
      const evs = [];
      while (liqIdx < allLiq.length && allLiq[liqIdx].timestamp <= boundaryTs) {
        evs.push(allLiq[liqIdx]);
        liqIdx++;
      }
      if (evs.length === 0) {
        liqIdx++;
        return;
      }
      const dirLiqUsd = evs
        .filter((e) => e.victim === direction)
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
      const oppLiqUsd = evs
        .filter((e) => e.victim !== direction)
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
      // price/OI stats using whatever OI data exists in [startIdx, endIdxCap]
      let priceMove = null,
        netOi = null,
        grossOi = null;
      if (endIdxCap > startIdx) {
        const p0 = priceAtOrBeforeIdx(allOi, startIdx),
          p1 = priceAtOrBeforeIdx(allOi, endIdxCap);
        priceMove = p0 !== null && p1 !== null ? Math.log(p1 / p0) : null;
        let pos = 0,
          neg = 0;
        for (let k = startIdx + 1; k <= endIdxCap; k++) {
          const d = allOi[k].contracts - allOi[k - 1].contracts;
          if (d > 0) pos += d;
          else neg += d;
        }
        netOi = allOi[endIdxCap].contracts - allOi[startIdx].contracts;
        grossOi = pos - neg;
      }
      dropStale.push({
        direction,
        startTs,
        dropTs: boundaryTs,
        dirLiqUsd,
        oppLiqUsd,
        eventCount: evs.length,
        priceMove,
        netOi,
        grossOi,
        reason: "DROP_STALE_NO_STRUCTURAL_END_WITHIN_10M",
      });
    }

    if (endIdxCap - startIdx < 5) {
      absorbAsDropStale();
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
      absorbAsDropStale();
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
      absorbAsDropStale();
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

    if (provisionalEndConfirmation === null) {
      absorbAsDropStale();
      continue;
    }

    const fullSumActual = usable.reduce((a, s) => a + s.actualLogRet, 0);
    const trueStartToEnd = Math.log(
      usable[usable.length - 1].priceEnd / usable[0].priceStart,
    );
    if (
      Math.abs(fullSumActual - trueStartToEnd) >=
      NUMERIC_TOLERANCE * usable.length
    ) {
      invalidCount++;
      liqIdx++;
      continue;
    }

    const boundaryTs = provisionalEndConfirmation;
    const episodeEvents = [];
    while (liqIdx < allLiq.length && allLiq[liqIdx].timestamp <= boundaryTs) {
      episodeEvents.push(allLiq[liqIdx]);
      liqIdx++;
    }
    if (episodeEvents.length === 0) {
      liqIdx++;
      continue;
    }

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

  console.log(`END_CONFIRMED episodes: ${episodes.length}`);
  console.log(`DROP_STALE candidates: ${dropStale.length}`);
  console.log(
    `INVALID_DATA (OI unavailable or accounting-assertion failure): ${invalidCount}`,
  );

  // ---- Duration sanity check (must be <=10min for every END_CONFIRMED) ----
  const overLimit = episodes.filter((e) => e.durationMs > STALE_TIMEOUT_MS);
  console.log(
    `\nDURATION SANITY CHECK: ${overLimit.length} END_CONFIRMED episode(s) exceed ${STALE_TIMEOUT_MS / 60000}min (should be 0).`,
  );
  if (overLimit.length > 0)
    overLimit.forEach((e) =>
      console.log(
        `  VIOLATION: ${e.direction} ${fmtDate(e.startTs)} duration=${fmtSec(e.durationMs)}`,
      ),
    );

  // ---- Rolling P90/P100, END_CONFIRMED only ----
  const longEps = episodes
    .filter((e) => e.direction === "LONG")
    .sort((a, b) => a.endTs - b.endTs);
  const shortEps = episodes
    .filter((e) => e.direction === "SHORT")
    .sort((a, b) => a.endTs - b.endTs);
  function applyRolling(eps) {
    eps.forEach((e, idx) => {
      const prior = eps
        .slice(0, idx)
        .filter(
          (p) =>
            p.endTs >= e.endTs - BASELINE_DAYS * 86_400_000 &&
            p.endTs < e.endTs,
        );
      e.priorCount = prior.length;
      e.liveEvaluable = e.endTs >= evalStartMs;
      if (prior.length < MIN_LIVE_SAMPLE) {
        e.status = "INSUFFICIENT_HISTORY";
        e.causalP90 = null;
        e.causalP100 = null;
        e.pctRank = null;
        e.decision = null;
        return;
      }
      const vals = prior.map((p) => p.dirLiqUsd).sort((a, b) => a - b);
      e.causalP90 = percentile(vals, 90);
      e.causalP100 = Math.max(...vals);
      e.pctRank = percentileRank(vals, e.dirLiqUsd);
      e.decision = e.dirLiqUsd >= e.causalP90 ? "KEEP_P90" : "DROP_BELOW_P90";
      e.abovePriorP100 = e.dirLiqUsd > e.causalP100;
      e.status = "LIVE";
    });
  }
  applyRolling(longEps);
  applyRolling(shortEps);

  // ---- STEP 13: DROP_STALE output ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("DROP_STALE CANDIDATES");
  console.log("=".repeat(170));
  dropStale
    .filter((d) => d.startTs >= evalStartMs)
    .forEach((d, idx) => {
      console.log(`\nCandidate #${idx + 1}`);
      console.log(`Direction: ${d.direction}`);
      console.log(`START: ${fmtDate(d.startTs)}`);
      console.log(`DROP timestamp: ${fmtDate(d.dropTs)}`);
      console.log(`Duration: ${fmtSec(d.dropTs - d.startTs)}`);
      console.log(
        `Direction liq USD: ${fmtUsd(d.dirLiqUsd)}   Opposite liq USD: ${fmtUsd(d.oppLiqUsd)}`,
      );
      console.log(`Event count: ${d.eventCount}`);
      console.log(
        `Price move: ${d.priceMove !== null ? fmtLogPct(d.priceMove) : "N/A"}   Net OI: ${d.netOi !== null ? fmtBtcDelta(d.netOi) : "N/A"}   Gross OI: ${d.grossOi !== null ? fmtBtc(d.grossOi) : "N/A"}`,
      );
      console.log(`Reason: ${d.reason}`);
    });

  // ---- STEP 14: END_CONFIRMED output ----
  console.log(`\n${"=".repeat(190)}`);
  console.log("END_CONFIRMED EPISODES (live-evaluable)");
  console.log("=".repeat(190));
  const allSorted = [...longEps, ...shortEps]
    .filter((e) => e.liveEvaluable)
    .sort((a, b) => a.startTs - b.startTs);
  allSorted.forEach((e, idx) => {
    console.log(`\nEP ${idx + 1}`);
    console.log(`Direction: ${e.direction}`);
    console.log(`START: ${fmtDate(e.startTs)}`);
    console.log(`END: ${fmtDate(e.endTs)}`);
    console.log(`Duration: ${fmtSec(e.durationMs)}`);
    console.log(
      `Direction Liq USD: ${fmtUsd(e.dirLiqUsd)}   Opposite Liq USD: ${fmtUsd(e.oppositeLiqUsd)}   Total: ${fmtUsd(e.totalLiqUsd)}   Events: ${e.eventCount}`,
    );
    console.log(`Prior 3d same-side END_CONFIRMED count: ${e.priorCount}`);
    console.log(
      `Causal P90: ${e.status === "LIVE" ? fmtUsd(e.causalP90) : `N/A (${e.status})`}   Causal P100: ${e.status === "LIVE" ? fmtUsd(e.causalP100) : "N/A"}`,
    );
    console.log(
      `Current/P90: ${e.status === "LIVE" ? (e.dirLiqUsd / e.causalP90).toFixed(2) + "x" : "N/A"}   Current/P100: ${e.status === "LIVE" ? (e.dirLiqUsd / e.causalP100).toFixed(2) + "x" : "N/A"}`,
    );
    console.log(
      `ABOVE_P90: ${e.decision === "KEEP_P90" ? "YES" : e.decision === "DROP_BELOW_P90" ? "NO" : "N/A"}   ABOVE_PRIOR_P100: ${e.abovePriorP100 !== undefined ? (e.abovePriorP100 ? "YES" : "NO") : "N/A"}`,
    );
    console.log(`Decision: ${e.decision ?? e.status}`);
    console.log(
      `Price: start=${fmtPrice(e.priceStart)} end=${fmtPrice(e.priceEnd)} move=${fmtLogPct(e.netPriceLog)}`,
    );
    console.log(
      `OI: start=${fmtBtc(e.oiStart)} end=${fmtBtc(e.oiEnd)} net=${fmtBtcDelta(e.netOi)} positive=${fmtBtcDelta(e.posOi)} negative=${fmtBtcDelta(e.negOi)} gross=${fmtBtc(e.grossOi)}`,
    );
  });

  // ---- STEP 15: summary ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("SUMMARY");
  console.log("=".repeat(170));
  for (const [label, eps, stale] of [
    ["LONG", longEps, dropStale.filter((d) => d.direction === "LONG")],
    ["SHORT", shortEps, dropStale.filter((d) => d.direction === "SHORT")],
  ]) {
    const started = eps.length + stale.length;
    const completionRate =
      started > 0 ? ((eps.length / started) * 100).toFixed(1) + "%" : "N/A";
    console.log(
      `\n${label}: candidates started=${started}  END_CONFIRMED=${eps.length}  DROP_STALE=${stale.length}  structural completion rate=${completionRate}`,
    );
    const live = eps.filter((e) => e.liveEvaluable);
    const insuff = live.filter((e) => e.status === "INSUFFICIENT_HISTORY");
    const keep = live.filter((e) => e.decision === "KEEP_P90");
    const drop = live.filter((e) => e.decision === "DROP_BELOW_P90");
    const aboveP100 = live.filter((e) => e.abovePriorP100);
    console.log(
      `  live-evaluable=${live.length}  insufficient-history=${insuff.length}  KEEP_P90=${keep.length}  DROP_BELOW_P90=${drop.length}  ABOVE_PRIOR_P100=${aboveP100.length}`,
    );
    const durs = eps.map((e) => e.durationMs).sort((a, b) => a - b);
    if (durs.length)
      console.log(
        `  duration: median=${fmtSec(median(durs))}  P75=${fmtSec(percentile(durs, 75))}  P90=${fmtSec(percentile(durs, 90))}  max=${fmtSec(durs[durs.length - 1])}`,
      );
  }

  // ---- STEP 16: parameter audit ----
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "PARAMETER AUDIT -- structural END detector parameters (all CARRIED OVER UNCHANGED except the operational cap)",
  );
  console.log("=".repeat(170));
  const audit = [
    {
      n: "STALE_TIMEOUT (operational cap)",
      v: "10 minutes from ORIGINAL START",
      old: "was 3 hours",
      fx: "FIXED (research policy, not a market rule)",
    },
    {
      n: "oiBlockScale horizon",
      v: "60000ms, ±8000ms tolerance",
      old: "unchanged",
      fx: "FIXED",
    },
    {
      n: "oiBlockScale percentile",
      v: "P50 (median)",
      old: "unchanged",
      fx: "FIXED methodology, DATA-DERIVED value",
    },
    {
      n: "Min segments/observations",
      v: "5 / 5 / 3(OLS)",
      old: "unchanged",
      fx: "FIXED",
    },
    {
      n: "Page-Hinkley delta",
      v: "0.5 x running stddev",
      old: "unchanged",
      fx: "FIXED multiplier, DATA-DERIVED scale",
    },
    {
      n: "Page-Hinkley lambda",
      v: "3 x running stddev",
      old: "unchanged",
      fx: "FIXED multiplier, DATA-DERIVED scale",
    },
    {
      n: "Candidate dedupe gap",
      v: "2 segments",
      old: "unchanged",
      fx: "FIXED",
    },
    {
      n: "CONFIRMATION_WINDOW_SEGMENTS",
      v: "5",
      old: "unchanged",
      fx: "FIXED",
    },
    {
      n: "MIN_LIVE_SAMPLE (P90 baseline)",
      v: "5 prior same-side episodes",
      old: "unchanged",
      fx: "FIXED",
    },
    {
      n: "Rolling baseline window",
      v: "prior 3 calendar days",
      old: "unchanged",
      fx: "FIXED",
    },
    {
      n: "Price/OI alignment",
      v: "nearest at-or-before",
      old: "unchanged",
      fx: "FIXED methodological rule",
    },
  ];
  console.log(
    "NAME | VALUE | CHANGE FROM PREVIOUS SCRIPT | FIXED/DATA-DERIVED",
  );
  audit.forEach((a) => console.log(`${a.n} | ${a.v} | ${a.old} | ${a.fx}`));

  console.log(`\n${"=".repeat(170)}`);
  console.log("RUN COMPLETED SUCCESSFULLY");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
