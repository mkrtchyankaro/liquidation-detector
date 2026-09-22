// BTC LIQUIDATION 3-DAY END STUDY -- large research/visual-validation
// tool. Reuses the CORRECTED v2 causal OI/price model (log returns,
// causal price alignment, no dropped segments, accounting
// assertions) from btc-oi-price-magnitude-online-model-v2.js,
// unmodified mathematically, applied to EVERY BTC liquidation episode
// over the last 3 days.
//
// ============================================================
// EXPLICIT DESIGN CHOICES (stated, not hidden):
//
//  1. CHARTS ARE SVG, NOT PNG. Reason: no native canvas/image
//     dependency is required on the VPS this way (no `canvas`/`sharp`
//     package, no system libs to install) -- SVG renders natively in
//     any browser and embeds directly into the HTML gallery. If a
//     true PNG is specifically needed later, that requires adding a
//     native rendering dependency, which was avoided here.
//
//  2. LIQUIDATION CHAINING (the process START): reuses the SAME
//     dominant-side / gap-merge(10min) / isolated-opposite-side-noise
//     -tolerant grouping validated EARLIER in this research thread --
//     this is event GROUPING (a starting point), not the rejected
//     END-detection logic (candle-confirmation/ATR/33%/HYBRID/OI-legs
//     are NOT used anywhere in this file for END).
//
//  3. PROVISIONAL_END CONFIRMATION WINDOW: after a recovery candidate
//     fires (Page-Hinkley recovery-side signal), the NEXT 5 segments
//     are watched causally. If NONE of them show price making a new
//     extreme in the ORIGINAL adverse direction, the candidate is
//     CONFIRMED at the 5th segment (CONFIRMATION_TIME, kept separate
//     from RECOVERY_START_TIME). If any of the 5 does, the candidate
//     is invalidated and the search for further candidates continues.
//     "5" is a stated, modest structural choice -- not tuned to these
//     charts, not optimized.
//
//  4. FORWARD SEARCH CAP per episode: max(10x the liquidation chain's
//     own duration, 30min), capped at 3 hours -- self-referential,
//     not a single fixed number for every episode.
//
//   node scripts/btc-liquidation-3day-end-study.js
//
// READ-ONLY on the database: no writes/updates/deletes to MongoDB.
// Writes ONLY to the local research output directory below.

require("dotenv/config");
const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const OUTPUT_DIR = path.join(
  process.cwd(),
  "research",
  "btc-liquidation-3day-end-study",
);
const GAP_MERGE_MIN = 10;
const CONFIRM_FLIP_COUNT = 3;
const CONFIRMATION_WINDOW_SEGMENTS = 5;
const NUMERIC_TOLERANCE = 1e-6;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}
function dateStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function timeStamp(ms) {
  return new Date(ms).toISOString().slice(11, 19).replace(/:/g, "");
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
  return n === null || n === undefined ? "N/A" : n.toFixed(2);
}
function fmtLogPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(4)}%`;
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
function priceAtOrBeforeIdx(obs, idx) {
  for (let k = idx; k >= 0; k--) {
    if (obs[k].price !== null)
      return {
        price: obs[k].price,
        sourceIdx: k,
        filled: k !== idx,
        ageMs: obs[idx].ts - obs[k].ts,
      };
  }
  return { price: null, sourceIdx: -1, filled: true, ageMs: null };
}
function nearestObsIdxAtOrBefore(obs, targetMs, fromIdx = 0) {
  let best = -1;
  for (let k = fromIdx; k < obs.length; k++) {
    if (obs[k].ts <= targetMs) best = k;
    else break;
  }
  return best;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Simple, dependency-free SVG chart generator: 3 stacked panels
 *  (price+liquidations, OI, cumulative residual), same time axis. */
function renderEpisodeSvg(ep) {
  const W = 1100,
    H = 780,
    marginL = 70,
    marginR = 30,
    panelH = 220,
    gap = 20;
  const plotW = W - marginL - marginR;
  const tMin = ep.chartStartMs,
    tMax = ep.chartEndMs;
  const x = (t) => marginL + ((t - tMin) / (tMax - tMin)) * plotW;

  function panel(yTop, values, colorFn, label, extraMarks) {
    const vMin = Math.min(...values.map((v) => v.y));
    const vMax = Math.max(...values.map((v) => v.y));
    const pad = (vMax - vMin) * 0.1 || 1;
    const yScale = (v) =>
      yTop +
      panelH -
      ((v - (vMin - pad)) / (vMax + pad - (vMin - pad))) * panelH;
    let path = "";
    values.forEach((pt, i) => {
      path += `${i === 0 ? "M" : "L"} ${x(pt.t).toFixed(1)} ${yScale(pt.y).toFixed(1)} `;
    });
    let svg = `<text x="${marginL}" y="${yTop - 5}" font-size="12" fill="#333">${escapeXml(label)}</text>`;
    svg += `<rect x="${marginL}" y="${yTop}" width="${plotW}" height="${panelH}" fill="none" stroke="#ccc"/>`;
    svg += `<path d="${path}" fill="none" stroke="${colorFn}" stroke-width="1.5"/>`;
    if (extraMarks) svg += extraMarks(x, yScale, yTop);
    return svg;
  }

  const priceVals = ep.chartObs
    .filter((o) => o.price !== null)
    .map((o) => ({ t: o.ts, y: o.price }));
  const oiVals = ep.chartObs.map((o) => ({ t: o.ts, y: o.contracts }));
  const cumResidVals = ep.cumResidTrace.map((c) => ({ t: c.t, y: c.v }));

  let liqMarks = "";
  ep.chartLiqs.forEach((e) => {
    const r = Math.max(2, Math.min(14, Math.sqrt(e.quoteQty) / 15));
    const yOff = e.victim === "LONG" ? 15 : -15;
    const priceAt = priceAtOrBeforeIdx(
      ep.chartObs,
      nearestObsIdxAtOrBefore(ep.chartObs, e.timestamp),
    );
    const yBase =
      priceAt.price !== null ? priceAt.price : (priceVals[0]?.y ?? 0);
    liqMarks += `<circle cx="${x(e.timestamp).toFixed(1)}" cy="${marginL /*placeholder, fixed below*/}" r="${r.toFixed(1)}" fill="${e.victim === "LONG" ? "rgba(220,50,50,0.5)" : "rgba(50,120,220,0.5)"}"/>`;
  });

  const priceMarkFn = (xf, yf, yTop) => {
    let m = "";
    const startPt = ep.chartObs.find(
      (o) => o.ts >= ep.startTs && o.price !== null,
    );
    if (startPt)
      m += `<line x1="${xf(ep.startTs)}" x2="${xf(ep.startTs)}" y1="${yTop}" y2="${yTop + panelH}" stroke="green" stroke-dasharray="4"/><text x="${xf(ep.startTs) + 2}" y="${yTop + 12}" font-size="10" fill="green">START</text>`;
    if (ep.extremeTs)
      m += `<line x1="${xf(ep.extremeTs)}" x2="${xf(ep.extremeTs)}" y1="${yTop}" y2="${yTop + panelH}" stroke="orange" stroke-dasharray="4"/><text x="${xf(ep.extremeTs) + 2}" y="${yTop + 24}" font-size="10" fill="orange">EXTREME</text>`;
    ep.recoveryCandidates.forEach((c, i) => {
      m += `<line x1="${xf(c.ts)}" x2="${xf(c.ts)}" y1="${yTop}" y2="${yTop + panelH}" stroke="purple" stroke-dasharray="2"/><text x="${xf(c.ts) + 2}" y="${yTop + 36 + i * 10}" font-size="9" fill="purple">CAND#${i + 1}</text>`;
    });
    if (ep.provisionalRecoveryStart)
      m += `<line x1="${xf(ep.provisionalRecoveryStart)}" x2="${xf(ep.provisionalRecoveryStart)}" y1="${yTop}" y2="${yTop + panelH}" stroke="blue" stroke-width="2"/><text x="${xf(ep.provisionalRecoveryStart) + 2}" y="${yTop + panelH - 20}" font-size="10" fill="blue">RECOVERY START</text>`;
    if (ep.provisionalEndConfirmation)
      m += `<line x1="${xf(ep.provisionalEndConfirmation)}" x2="${xf(ep.provisionalEndConfirmation)}" y1="${yTop}" y2="${yTop + panelH}" stroke="black" stroke-width="2"/><text x="${xf(ep.provisionalEndConfirmation) + 2}" y="${yTop + panelH - 5}" font-size="10" fill="black">END CONFIRM</text>`;
    if (ep.provisionalEndConfirmation)
      m += `<rect x="${xf(ep.provisionalEndConfirmation)}" y="${yTop}" width="${(xf(tMax) - xf(ep.provisionalEndConfirmation)).toFixed(1)}" height="${panelH}" fill="rgba(200,200,200,0.25)"/><text x="${xf(ep.provisionalEndConfirmation) + 5}" y="${yTop + panelH / 2}" font-size="10" fill="#666">POST-END VISUAL CONTEXT (not used causally)</text>`;
    return m;
  };

  const panel1 = panel(
    30,
    priceVals.length ? priceVals : [{ t: tMin, y: 0 }],
    "#111",
    `PRICE + LIQUIDATIONS  (${ep.direction} episode)`,
    priceMarkFn,
  );
  const panel2 = panel(30 + panelH + gap, oiVals, "#1a7", "OPEN INTEREST");
  const panel3 = panel(
    30 + 2 * (panelH + gap),
    cumResidVals.length ? cumResidVals : [{ t: tMin, y: 0 }],
    "#a17",
    "CUMULATIVE RESIDUAL (recovery evidence)",
  );

  // Liquidation markers positioned on the price panel's own y-scale.
  const pMin = Math.min(
    ...(priceVals.length ? priceVals.map((v) => v.y) : [0]),
  );
  const pMax = Math.max(
    ...(priceVals.length ? priceVals.map((v) => v.y) : [1]),
  );
  const pPad = (pMax - pMin) * 0.1 || 1;
  const yPriceScale = (v) =>
    30 +
    panelH -
    ((v - (pMin - pPad)) / (pMax + pPad - (pMin - pPad))) * panelH;
  let liqMarksFixed = "";
  ep.chartLiqs.forEach((e) => {
    const r = Math.max(2, Math.min(12, Math.sqrt(e.quoteQty) / 20));
    const idx = nearestObsIdxAtOrBefore(ep.chartObs, e.timestamp);
    const pi =
      idx >= 0 ? priceAtOrBeforeIdx(ep.chartObs, idx) : { price: null };
    const yv = pi.price !== null ? yPriceScale(pi.price) : 30 + panelH / 2;
    liqMarksFixed += `<circle cx="${x(e.timestamp).toFixed(1)}" cy="${(yv + (e.victim === "LONG" ? 10 : -10)).toFixed(1)}" r="${r.toFixed(1)}" fill="${e.victim === "LONG" ? "rgba(210,40,40,0.55)" : "rgba(40,110,210,0.55)"}"/>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif">
    <rect width="${W}" height="${H}" fill="white"/>
    ${panel1}${liqMarksFixed}${panel2}${panel3}
    <text x="${marginL}" y="${H - 5}" font-size="10" fill="#888">${isoUtc(tMin)} -&gt; ${isoUtc(tMax)}</text>
  </svg>`;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - DAYS_BACK * 86_400_000;

  console.log("=".repeat(170));
  console.log(
    `BTC LIQUIDATION 3-DAY END STUDY -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(170));

  const allLiq = await liqCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allOiRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(rangeStartMs - 65000),
        $lte: new Date(rangeEndMs + 3 * 3600 * 1000),
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

  const totalLongUsd = allLiq
    .filter((e) => e.victim === "LONG")
    .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
  const totalShortUsd = allLiq
    .filter((e) => e.victim === "SHORT")
    .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
  console.log(`\nTotal BTC liquidation events: ${allLiq.length}`);
  console.log(
    `Total raw LONG liquidation USD: ${fmtUsd(totalLongUsd)}   Total raw SHORT liquidation USD: ${fmtUsd(totalShortUsd)}`,
  );
  console.log(`OI+price observations loaded: ${allOi.length}`);

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
    `Global OI segmentation scale (median |ΔOI over 60s|): ${fmtBtc(oiBlockScale)} BTC.`,
  );

  // ---- Liquidation chaining (event grouping, reused from earlier validated logic) ----
  const chains = [];
  let cur = { events: [allLiq[0]], dominantSide: allLiq[0].victim };
  let oppStreak = 0;
  for (let i = 1; i < allLiq.length; i++) {
    const e = allLiq[i];
    if (e.timestamp - allLiq[i - 1].timestamp > GAP_MERGE_MIN * 60 * 1000) {
      chains.push(cur);
      cur = { events: [e], dominantSide: e.victim };
      oppStreak = 0;
      continue;
    }
    if (e.victim === cur.dominantSide) {
      cur.events.push(e);
      oppStreak = 0;
    } else {
      oppStreak++;
      if (oppStreak >= CONFIRM_FLIP_COUNT) {
        const flipRunEvents = cur.events.splice(
          cur.events.length - (oppStreak - 1),
        );
        chains.push(cur);
        cur = { events: [...flipRunEvents, e], dominantSide: e.victim };
        oppStreak = 0;
      } else cur.events.push(e);
    }
  }
  chains.push(cur);
  console.log(
    `\nConstructed ${chains.length} liquidation chains (LONG=${chains.filter((c) => c.dominantSide === "LONG").length}, SHORT=${chains.filter((c) => c.dominantSide === "SHORT").length}).`,
  );

  // ---- Process each chain with the v2 causal OI/price model ----
  const episodes = [];
  let invalidCount = 0;

  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    const direction = chain.dominantSide; // LONG => down-pressure episode; SHORT => up-pressure episode
    const adverseDir = direction === "LONG" ? "down" : "up"; // price direction the liquidation itself pushes
    const startTs = chain.events[0].timestamp;
    const chainEndTs = chain.events[chain.events.length - 1].timestamp;
    const ownDurationMs = Math.max(1000, chainEndTs - startTs);
    const searchCapMs = Math.min(
      Math.max(10 * ownDurationMs, 30 * 60 * 1000),
      3 * 3600 * 1000,
    );
    const searchEndTs = startTs + searchCapMs;

    const startIdx = nearestObsIdxAtOrBefore(allOi, startTs);
    if (startIdx < 0) continue;
    let endIdxCap = startIdx;
    for (let k = startIdx; k < allOi.length; k++) {
      if (allOi[k].ts <= searchEndTs) endIdxCap = k;
      else break;
    }
    if (endIdxCap - startIdx < 5) continue;

    // Magnitude-cut segments for THIS episode's window.
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
    if (segs.length < 5) continue;

    const segData = segs.map((seg) => {
      const spi = priceAtOrBeforeIdx(allOi, seg.startIdx),
        epi = priceAtOrBeforeIdx(allOi, seg.endIdx);
      const a = allOi[seg.startIdx],
        b = allOi[seg.endIdx];
      const actualLogRet =
        spi.price !== null && epi.price !== null
          ? Math.log(epi.price / spi.price)
          : null;
      return {
        startTs: a.ts,
        endTs: b.ts,
        oiStart: a.contracts,
        oiEnd: b.contracts,
        deltaOi: b.contracts - a.contracts,
        priceStart: spi.price,
        priceEnd: epi.price,
        priceStartFilled: spi.filled,
        priceEndFilled: epi.filled,
        fillAgeMs: Math.max(spi.ageMs ?? 0, epi.ageMs ?? 0),
        actualLogRet,
      };
    });
    const usable = segData.filter((s) => s.actualLogRet !== null);
    if (usable.length < 5) continue;

    // Online linear regression (v2 model, unmodified math), + direction-aware recovery Page-Hinkley (no reset).
    let Sx = 0,
      Sy = 0,
      Sxx = 0,
      Sxy = 0,
      n = 0;
    const expected = [],
      residual = [];
    const priorResiduals = [];
    let mtRec = 0,
      minRec = 0;
    const rsForPH = [];
    const recoveryCandidatesRaw = [];

    let runningExtremePrice = usable[0].priceStart;
    let extremeTs = usable[0].startTs;

    const cumResidTrace = [];
    let cumResid = 0;

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
      expected.push(pred);
      const r = pred !== null ? s.actualLogRet - pred : null;
      residual.push(r);
      if (r !== null) {
        cumResid += r;
      }
      cumResidTrace.push({ t: s.endTs, v: cumResid });

      // Direction-aware recovery residual: for LONG (adverse=down), recovery = price higher than expected => r>0 is recovery.
      // For SHORT (adverse=up), recovery = price lower than expected => -r>0 is recovery.
      const recoveryR = r !== null ? (adverseDir === "down" ? r : -r) : null;
      if (recoveryR !== null) {
        const sd = rsForPH.length >= 5 ? stddev(rsForPH) : null;
        const delta = sd ? 0.5 * sd : 0;
        const lambda = sd ? 3 * sd : Infinity;
        mtRec += recoveryR - delta;
        minRec = Math.min(minRec, mtRec);
        const PH = mtRec - minRec;
        if (sd && PH > lambda)
          recoveryCandidatesRaw.push({ idx: i, ts: s.startTs });
        rsForPH.push(recoveryR);
      }

      // Track price extreme in the ADVERSE direction.
      if (s.priceEnd !== null) {
        if (adverseDir === "down" && s.priceEnd < runningExtremePrice) {
          runningExtremePrice = s.priceEnd;
          extremeTs = s.endTs;
        }
        if (adverseDir === "up" && s.priceEnd > runningExtremePrice) {
          runningExtremePrice = s.priceEnd;
          extremeTs = s.endTs;
        }
      }

      Sx += s.deltaOi;
      Sy += s.actualLogRet;
      Sxx += s.deltaOi * s.deltaOi;
      Sxy += s.deltaOi * s.actualLogRet;
      n++;
      priorResiduals.push(r);
    }

    // De-duplicate consecutive candidates into distinct events.
    const recoveryCandidates = [];
    for (const c of recoveryCandidatesRaw) {
      if (
        recoveryCandidates.length === 0 ||
        c.idx - recoveryCandidates[recoveryCandidates.length - 1].idx > 2
      )
        recoveryCandidates.push(c);
    }
    recoveryCandidates.forEach((c) => {
      c.ts = usable[c.idx].startTs;
    });

    // Provisional END confirmation: watch CONFIRMATION_WINDOW_SEGMENTS after each candidate for adverse-direction new extreme.
    let provisionalRecoveryStart = null,
      provisionalEndConfirmation = null,
      chosenCandidateIdx = null;
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
        provisionalRecoveryStart = cand.ts;
        provisionalEndConfirmation = usable[watchEnd].endTs;
        chosenCandidateIdx = cand.idx;
        break;
      }
    }

    // Accounting assertions (v2 math, unmodified) over the usable segments.
    const fullSumActual = usable.reduce((a, s) => a + s.actualLogRet, 0);
    const trueStartToEnd = Math.log(
      usable[usable.length - 1].priceEnd / usable[0].priceStart,
    );
    const priceAssertOk =
      Math.abs(fullSumActual - trueStartToEnd) <
      NUMERIC_TOLERANCE * usable.length;
    const fullSumOi = usable.reduce((a, s) => a + s.deltaOi, 0);
    const trueNetOi = usable[usable.length - 1].oiEnd - usable[0].oiStart;
    const oiAssertOk = Math.abs(fullSumOi - trueNetOi) < 1e-6;
    const pairedIdx = residual
      .map((r, i) => (r !== null ? i : null))
      .filter((i) => i !== null);
    const sumResid = pairedIdx.reduce((a, i) => a + residual[i], 0);
    const sumActualPaired = pairedIdx.reduce(
      (a, i) => a + usable[i].actualLogRet,
      0,
    );
    const sumExpectedPaired = pairedIdx.reduce((a, i) => a + expected[i], 0);
    const residAssertOk =
      Math.abs(sumResid - (sumActualPaired - sumExpectedPaired)) <
      NUMERIC_TOLERANCE * pairedIdx.length;
    const valid = priceAssertOk && oiAssertOk && residAssertOk;
    if (!valid) invalidCount++;

    const filledCount = usable.filter(
      (s) => s.priceStartFilled || s.priceEndFilled,
    ).length;
    const maxFillAge = Math.max(0, ...usable.map((s) => s.fillAgeMs));
    const coveragePct = ((usable.length - filledCount) / usable.length) * 100;

    const posOi = usable.reduce((a, s) => a + Math.max(0, s.deltaOi), 0);
    const negOi = usable.reduce((a, s) => a + Math.min(0, s.deltaOi), 0);

    episodes.push({
      id: null,
      direction,
      startTs,
      chain,
      usable,
      expected,
      residual,
      recoveryCandidates,
      provisionalRecoveryStart,
      provisionalEndConfirmation,
      chosenCandidateIdx,
      extremeTs,
      extremePrice: runningExtremePrice,
      cumResidTrace,
      totalLiqUsd: chain.events.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      longLiqUsd: chain.events
        .filter((e) => e.victim === "LONG")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      shortLiqUsd: chain.events
        .filter((e) => e.victim === "SHORT")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      liqEventCount: chain.events.length,
      oiStart: usable[0].oiStart,
      oiAtExtreme: null,
      oiAtRecovery: null,
      oiAtConfirmation: null,
      netOi: fullSumOi,
      posOi,
      negOi,
      grossOi: posOi - negOi,
      cumExpected: sumExpectedPaired,
      cumActual: sumActualPaired,
      cumResidual: sumResid,
      coveragePct,
      filledCount,
      maxFillAge,
      priceAssertOk,
      oiAssertOk,
      residAssertOk,
      valid,
    });
  }

  console.log(
    `\nConstructed ${episodes.length} episode candidates (>=5 usable segments); ${invalidCount} failed accounting assertions and are marked INVALID.`,
  );
  const validEpisodes = episodes.filter((e) => e.valid);
  console.log(
    `Valid episode count: ${validEpisodes.length}   Invalid: ${invalidCount}`,
  );
  const withCandidates = validEpisodes.filter(
    (e) => e.recoveryCandidates.length > 0,
  ).length;
  const withConfirmation = validEpisodes.filter(
    (e) => e.provisionalEndConfirmation,
  ).length;
  console.log(
    `Episodes with recovery candidates: ${withCandidates}   Episodes with provisional END confirmation: ${withConfirmation}`,
  );

  validEpisodes.forEach((ep, idx) => {
    ep.id = `EP${String(idx + 1).padStart(3, "0")}`;
  });

  // ---- Output directory ----
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`\nWriting research output to: ${OUTPUT_DIR}`);

  const summaryRows = validEpisodes.map((ep) => ({
    EPISODE_ID: ep.id,
    DIRECTION: ep.direction,
    START_TIME: isoUtc(ep.startTs),
    FIRST_RECOVERY_CANDIDATE_TIME: ep.recoveryCandidates[0]
      ? isoUtc(ep.recoveryCandidates[0].ts)
      : null,
    ALL_RECOVERY_CANDIDATE_TIMES: ep.recoveryCandidates
      .map((c) => isoUtc(c.ts))
      .join("; "),
    PROVISIONAL_RECOVERY_START: ep.provisionalRecoveryStart
      ? isoUtc(ep.provisionalRecoveryStart)
      : null,
    PROVISIONAL_END_CONFIRMATION: ep.provisionalEndConfirmation
      ? isoUtc(ep.provisionalEndConfirmation)
      : null,
    DURATION_TO_RECOVERY_MIN: ep.provisionalRecoveryStart
      ? ((ep.provisionalRecoveryStart - ep.startTs) / 60000).toFixed(2)
      : null,
    DURATION_TO_CONFIRMATION_MIN: ep.provisionalEndConfirmation
      ? ((ep.provisionalEndConfirmation - ep.startTs) / 60000).toFixed(2)
      : null,
    START_PRICE: ep.usable[0].priceStart,
    EXTREME_PRICE: ep.extremePrice,
    TOTAL_LIQ_USD: ep.totalLiqUsd,
    LONG_LIQ_USD: ep.longLiqUsd,
    SHORT_LIQ_USD: ep.shortLiqUsd,
    LIQ_EVENT_COUNT: ep.liqEventCount,
    OI_START: ep.oiStart,
    NET_OI: ep.netOi,
    POSITIVE_OI: ep.posOi,
    NEGATIVE_OI: ep.negOi,
    GROSS_OI_ACTIVITY: ep.grossOi,
    CUM_EXPECTED_RETURN: ep.cumExpected,
    CUM_ACTUAL_RETURN: ep.cumActual,
    CUM_RESIDUAL: ep.cumResidual,
    PRICE_PATH_COVERAGE_PCT: ep.coveragePct.toFixed(2),
    BACKWARD_FILL_COUNT: ep.filledCount,
    MAX_BACKWARD_FILL_AGE_MS: ep.maxFillAge,
    PRICE_ASSERTION: ep.priceAssertOk ? "PASS" : "FAIL",
    OI_ASSERTION: ep.oiAssertOk ? "PASS" : "FAIL",
    RESIDUAL_ASSERTION: ep.residAssertOk ? "PASS" : "FAIL",
  }));

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary.json"),
    JSON.stringify(summaryRows, null, 2),
  );
  const csvHeader = Object.keys(summaryRows[0] ?? {}).join(",");
  const csvRows = summaryRows.map((r) =>
    Object.values(r)
      .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
      .join(","),
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary.csv"),
    [csvHeader, ...csvRows].join("\n"),
  );

  // ---- Charts (SVG) + HTML gallery ----
  const galleryCards = [];
  for (const ep of validEpisodes) {
    const fileBase = `${ep.id}_${ep.direction}_${dateStamp(ep.startTs)}_${timeStamp(ep.startTs)}`;
    const chartStartMs = ep.startTs - 5 * 60 * 1000;
    const chartEndMs = Math.min(
      ep.usable[ep.usable.length - 1].endTs + 30 * 60 * 1000,
      rangeEndMs + 3 * 3600 * 1000,
    );
    const chartObsStartIdx = Math.max(
      0,
      nearestObsIdxAtOrBefore(allOi, chartStartMs),
    ); // Sep 22 2026 (Karo), operator-reported CRASH FIX -- nearestObsIdxAtOrBefore returns -1 when chartStartMs falls before the earliest loaded observation (episodes near the very start of the 3-day window); the unguarded -1 made allOi[-1].ts throw "Cannot read properties of undefined (reading 'ts')". Clamped to 0 (earliest available observation) instead.
    let chartObsEndIdx = chartObsStartIdx;
    for (let k = chartObsStartIdx; k < allOi.length; k++) {
      if (allOi[k].ts <= chartEndMs) chartObsEndIdx = k;
      else break;
    }
    const chartObs = allOi.slice(
      Math.max(0, chartObsStartIdx),
      chartObsEndIdx + 1,
    );
    const chartLiqs = allLiq.filter(
      (e) => e.timestamp >= chartStartMs && e.timestamp <= chartEndMs,
    );

    const svg = renderEpisodeSvg({
      ...ep,
      chartStartMs,
      chartEndMs,
      chartObs,
      chartLiqs,
    });
    fs.writeFileSync(path.join(OUTPUT_DIR, `${fileBase}.svg`), svg);

    const liqSeqLines = [];
    let lastPrinted = null;
    ep.chain.events.forEach((e) => {
      if (
        !lastPrinted ||
        e.timestamp - lastPrinted > 30000 ||
        ep.chain.events.length <= 30
      ) {
        liqSeqLines.push(
          `${hhmmss(e.timestamp)} ${e.victim} ${fmtUsd(e.quoteQty)}`,
        );
        lastPrinted = e.timestamp;
      }
    });

    galleryCards.push({ ep, fileBase, liqSeqLines });
  }

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>BTC Liquidation 3-Day END Study</title>
<style>body{font-family:sans-serif;max-width:1200px;margin:20px auto;} .card{border:1px solid #ccc;margin-bottom:30px;padding:15px;} .flag{color:red;font-weight:bold;} table{border-collapse:collapse;} td,th{padding:3px 8px;border:1px solid #ddd;font-size:13px;}</style>
</head><body><h1>BTC Liquidation 3-Day END Study</h1><p>${validEpisodes.length} valid episodes, ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}</p>`;
  for (const { ep, fileBase, liqSeqLines } of galleryCards) {
    html += `<div class="card" id="${ep.id}"><h2>${ep.id} -- ${ep.direction} -- ${isoUtc(ep.startTs)}</h2>`;
    html += `<img src="${fileBase}.svg" width="1100"/>`;
    html += `<table>
      <tr><td>TOTAL_LIQ_USD</td><td>${fmtUsd(ep.totalLiqUsd)}</td><td>LONG/SHORT</td><td>${fmtUsd(ep.longLiqUsd)} / ${fmtUsd(ep.shortLiqUsd)}</td></tr>
      <tr><td>RECOVERY CANDIDATES</td><td colspan="3">${ep.recoveryCandidates.map((c) => isoUtc(c.ts)).join(", ") || "none"}</td></tr>
      <tr><td>PROVISIONAL RECOVERY START</td><td>${ep.provisionalRecoveryStart ? isoUtc(ep.provisionalRecoveryStart) : "N/A"}</td><td>END CONFIRMATION</td><td>${ep.provisionalEndConfirmation ? isoUtc(ep.provisionalEndConfirmation) : "N/A"}</td></tr>
      <tr><td>CUM_RESIDUAL</td><td>${fmtLogPct(ep.cumResidual)}</td><td>COVERAGE</td><td>${ep.coveragePct < 95 ? '<span class="flag">' : ""}${ep.coveragePct.toFixed(1)}%${ep.coveragePct < 95 ? "</span>" : ""}</td></tr>
      <tr><td>ASSERTIONS</td><td colspan="3">PRICE=${ep.priceAssertOk ? "PASS" : "FAIL"} OI=${ep.oiAssertOk ? "PASS" : "FAIL"} RESIDUAL=${ep.residAssertOk ? "PASS" : "FAIL"}</td></tr>
    </table>
    <pre style="max-height:200px;overflow:auto;background:#f7f7f7;padding:8px;">${liqSeqLines.map(escapeXml).join("\n")}</pre>
    </div>`;
  }
  html += "</body></html>";
  fs.writeFileSync(path.join(OUTPUT_DIR, "index.html"), html);

  // ---- Final terminal summary ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("VIEW A -- CHRONOLOGICAL");
  console.log("=".repeat(170));
  console.log(
    "ID      | DIR   | START                    | RECOVERY START           | END CONFIRM              | TOTAL LIQ  | COVERAGE",
  );
  [...validEpisodes]
    .sort((a, b) => a.startTs - b.startTs)
    .forEach((ep) => {
      console.log(
        `${ep.id} | ${ep.direction.padEnd(5)} | ${isoUtc(ep.startTs)} | ${(ep.provisionalRecoveryStart ? isoUtc(ep.provisionalRecoveryStart) : "N/A").padEnd(24)} | ${(ep.provisionalEndConfirmation ? isoUtc(ep.provisionalEndConfirmation) : "N/A").padEnd(24)} | ${fmtUsd(ep.totalLiqUsd).padEnd(10)} | ${ep.coveragePct.toFixed(1)}%`,
      );
    });

  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "VIEW B -- DESCRIPTIVE SIZE VIEW (TOTAL_LIQ_USD descending, NOT a quality ranking)",
  );
  console.log("=".repeat(170));
  [...validEpisodes]
    .sort((a, b) => b.totalLiqUsd - a.totalLiqUsd)
    .forEach((ep) => {
      console.log(
        `${ep.id} | ${ep.direction.padEnd(5)} | ${isoUtc(ep.startTs)} | TOTAL_LIQ=${fmtUsd(ep.totalLiqUsd).padEnd(10)} | RECOVERY_CANDIDATES=${ep.recoveryCandidates.length} | CONFIRMED=${ep.provisionalEndConfirmation ? "YES" : "no"}`,
      );
    });

  console.log(`\n${"=".repeat(170)}`);
  console.log(`3-day range: ${isoUtc(rangeStartMs)} -> ${isoUtc(rangeEndMs)}`);
  console.log(`Total BTC liquidation events: ${allLiq.length}`);
  console.log(
    `Total raw LONG liquidation USD: ${fmtUsd(totalLongUsd)}   Total raw SHORT liquidation USD: ${fmtUsd(totalShortUsd)}`,
  );
  console.log(
    `Constructed episodes: ${episodes.length}   LONG=${episodes.filter((e) => e.direction === "LONG").length}   SHORT=${episodes.filter((e) => e.direction === "SHORT").length}`,
  );
  console.log(`Valid: ${validEpisodes.length}   Invalid: ${invalidCount}`);
  console.log(
    `With recovery candidates: ${withCandidates}   With provisional END confirmation: ${withConfirmation}`,
  );
  console.log(`\nOutput written to: ${OUTPUT_DIR}`);
  console.log(
    `  summary.csv, summary.json, index.html, and one .svg per valid episode.`,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
