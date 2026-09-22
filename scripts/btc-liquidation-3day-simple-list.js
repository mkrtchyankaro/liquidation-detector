// BTC LIQUIDATION 3-DAY SIMPLE LIST -- reuses the EXACT SAME,
// unmodified episode-detection algorithm (liquidation chaining +
// v2 causal OI/price model + direction-aware Page-Hinkley + 5-segment
// confirmation window) from btc-liquidation-3day-end-study.js. NO
// charts, NO SVG, NO HTML, NO CSV/JSON files, NO recovery-candidate
// detail, NO analysis/recommendation. Prints ONLY a plain chronological
// list, then the same list sorted by TOTAL_LIQUIDATION_USD descending.
//
//   node scripts/btc-liquidation-3day-simple-list.js
//
// END = the detector's PROVISIONAL_END_CONFIRMATION if one was
// confirmed; otherwise "UNCONFIRMED" (this detector's only notion of
// an episode end -- unchanged from the full study script).
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const GAP_MERGE_MIN = 10;
const CONFIRM_FLIP_COUNT = 3;
const CONFIRMATION_WINDOW_SEGMENTS = 5;
const NUMERIC_TOLERANCE = 1e-6;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
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
      return { price: obs[k].price, filled: k !== idx };
  }
  return { price: null, filled: true };
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

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - DAYS_BACK * 86_400_000;

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

  // ---- Liquidation chaining (unchanged) ----
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

  // ---- Per-chain causal model (unchanged) ----
  const episodes = [];
  for (const chain of chains) {
    const direction = chain.dominantSide;
    const adverseDir = direction === "LONG" ? "down" : "up";
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
        deltaOi: b.contracts - a.contracts,
        priceStart: spi.price,
        priceEnd: epi.price,
        actualLogRet,
      };
    });
    const usable = segData.filter((s) => s.actualLogRet !== null);
    if (usable.length < 5) continue;

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
        const delta = sd ? 0.5 * sd : 0;
        const lambda = sd ? 3 * sd : Infinity;
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
    for (const c of recoveryCandidatesRaw) {
      if (
        recoveryCandidates.length === 0 ||
        c.idx - recoveryCandidates[recoveryCandidates.length - 1].idx > 2
      )
        recoveryCandidates.push(c);
    }

    let provisionalEndConfirmation = null,
      endPrice = null;
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
        endPrice = usable[watchEnd].priceEnd;
        break;
      }
    }

    // Accounting assertion (unchanged) -- silently skip invalid episodes, same as the full study.
    const fullSumActual = usable.reduce((a, s) => a + s.actualLogRet, 0);
    const trueStartToEnd = Math.log(
      usable[usable.length - 1].priceEnd / usable[0].priceStart,
    );
    if (
      Math.abs(fullSumActual - trueStartToEnd) >=
      NUMERIC_TOLERANCE * usable.length
    )
      continue;
    const fullSumOi = usable.reduce((a, s) => a + s.deltaOi, 0); // unused, kept only if needed later

    episodes.push({
      direction,
      startTs,
      chain,
      startPrice: usable[0].priceStart,
      endTs: provisionalEndConfirmation,
      endPrice,
      totalLiqUsd: chain.events.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      longLiqUsd: chain.events
        .filter((e) => e.victim === "LONG")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      shortLiqUsd: chain.events
        .filter((e) => e.victim === "SHORT")
        .reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      eventCount: chain.events.length,
    });
  }

  function printEpisode(ep, idLabel) {
    console.log(idLabel);
    console.log(`Direction: ${ep.direction}`);
    console.log(`START: ${fmtDate(ep.startTs)}`);
    console.log(
      `END:   ${ep.endTs !== null ? fmtDate(ep.endTs) : "UNCONFIRMED"}`,
    );
    console.log(`Start price: ${fmtPrice(ep.startPrice)}`);
    console.log(
      `End price:   ${ep.endPrice !== null ? fmtPrice(ep.endPrice) : "N/A"}`,
    );
    console.log(`Total liquidation: ${fmtUsd(ep.totalLiqUsd)}`);
    console.log(`Long liquidation:  ${fmtUsd(ep.longLiqUsd)}`);
    console.log(`Short liquidation: ${fmtUsd(ep.shortLiqUsd)}`);
    console.log(`Events: ${ep.eventCount}`);
    console.log("");
  }

  console.log("=".repeat(80));
  console.log(
    `CHRONOLOGICAL LIST (${episodes.length} episodes, ordered by START)`,
  );
  console.log("=".repeat(80));
  console.log("");
  const chrono = [...episodes].sort((a, b) => a.startTs - b.startTs);
  chrono.forEach((ep, idx) =>
    printEpisode(ep, `EP${String(idx + 1).padStart(3, "0")}`),
  );

  console.log("=".repeat(80));
  console.log(`SORTED BY TOTAL_LIQUIDATION_USD DESCENDING`);
  console.log("=".repeat(80));
  console.log("");
  const bySize = [...episodes].sort((a, b) => b.totalLiqUsd - a.totalLiqUsd);
  bySize.forEach((ep, idx) => printEpisode(ep, `#${idx + 1} (size rank)`));

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
