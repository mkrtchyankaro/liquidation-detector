// P90 -> MACRO CASCADE, FULL DATASET RUN.
//
// Applies the SAME continuation filter already established (no new
// filter invented here):
//   MERGE only if BOTH:
//     1. recoveryATR < 1   (price still unresolved / near N's extreme)
//     2. pressureRatio >= 1 (liquidation pressure re-accelerated)
//   OI_delta and failureToExtend-change are printed as CONTEXT only,
//   never part of the MERGE/SPLIT decision, no fixed OI sign required.
//   gapSeconds is diagnostic only, never decisive.
//   LONG->SHORT / SHORT->LONG pairs are automatic SPLIT (not scored).
//
// Then performs TRANSITIVE merging across the full P90 episode
// sequence (consecutive MERGE decisions chain into one macro
// cascade), and prints full results + top 20 macro cascades by $.
//
//   node scripts/p90-macro-cascade-full-run.js <daysBack=5> <percentile=90>
//
// NO forward return. NO profitability language. NO live changes.
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const EPISODE_SEARCH_CAP_MIN = 180;
const ATR_PERIOD = 14;
const ATR_INTERVAL_MIN = 15;
const FINAL_BURST_WINDOW_SEC = 90;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}
function fmtNum(n) {
  return n === null || n === undefined ? "N/A" : n.toFixed(4);
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchKlinesRange(symbol, startMs, endMs, intervalMin) {
  const all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${intervalMin}m&startTime=${Math.round(cursor)}&endTime=${Math.round(endMs)}&limit=1000`;
    let rows = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 418) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        rows = [];
        break;
      }
      rows = await res.json();
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows)
      all.push({
        openTimeMs: r[0],
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      });
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1][0] + intervalMin * 60 * 1000;
    await sleep(150);
  }
  return all;
}
function computeAtrSeries(candles, period) {
  const atr = new Array(candles.length).fill(null);
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].high - candles[i].low);
      continue;
    }
    const pc = candles[i - 1].close;
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - pc),
        Math.abs(candles[i].low - pc),
      ),
    );
  }
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tr[j];
    atr[i] = sum / period;
  }
  return atr;
}
function nearestAtrAtOrBefore(candles, atrSeries, targetMs) {
  let bestIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].openTimeMs <= targetMs) bestIdx = i;
    else break;
  }
  return bestIdx === -1 ? null : atrSeries[bestIdx];
}
function isOppositeCandle(candle, direction) {
  return direction === "down"
    ? candle.close > candle.open
    : candle.close < candle.open;
}
function candleCovering(candles, atMs, intervalMs) {
  for (const c of candles) {
    if (atMs >= c.openTimeMs && atMs < c.openTimeMs + intervalMs) return c;
  }
  return null;
}
function findNextEndCandidate(
  fromMs,
  maxSearchMs,
  direction,
  btc1m,
  btc3m,
  btc5m,
) {
  const searchEnd = fromMs + maxSearchMs;
  for (let t = fromMs; t <= searchEnd; t += 60 * 1000) {
    const c1 = candleCovering(btc1m, t, 60 * 1000);
    const c3 = candleCovering(btc3m, t, 3 * 60 * 1000);
    const c5 = candleCovering(btc5m, t, 5 * 60 * 1000);
    if (!c1 || !c3 || !c5) continue;
    if (
      isOppositeCandle(c1, direction) &&
      isOppositeCandle(c3, direction) &&
      isOppositeCandle(c5, direction)
    )
      return t;
  }
  return null;
}
function finalPressure(epEvents) {
  const lastEvent = epEvents[epEvents.length - 1];
  const burstStartMs = lastEvent.timestamp - FINAL_BURST_WINDOW_SEC * 1000;
  const burstEvents = epEvents.filter((e) => e.timestamp >= burstStartMs);
  const usd = burstEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
  const durationSec = Math.max(
    1,
    (lastEvent.timestamp - burstEvents[0].timestamp) / 1000,
  );
  return usd / durationSec;
}
function initialPressure(epEvents) {
  const firstEvent = epEvents[0];
  const windowEndMs = firstEvent.timestamp + FINAL_BURST_WINDOW_SEC * 1000;
  const windowEvents = epEvents.filter((e) => e.timestamp <= windowEndMs);
  const usd = windowEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
  const durationSec = Math.max(
    1,
    (windowEvents[windowEvents.length - 1].timestamp - firstEvent.timestamp) /
      1000,
  );
  return usd / durationSec;
}
function failureToExtend(epEvents) {
  const startPrice = epEvents[0].price;
  const lastPrice = epEvents[epEvents.length - 1].price;
  const extensionPct = startPrice
    ? ((lastPrice - startPrice) / startPrice) * 100
    : null;
  const totalUsd = epEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
  return extensionPct !== null && Math.abs(extensionPct) > 0.0001
    ? totalUsd / Math.abs(extensionPct)
    : null;
}
function avgCadenceSec(epEvents) {
  if (epEvents.length < 2) return null;
  return (
    (epEvents[epEvents.length - 1].timestamp - epEvents[0].timestamp) /
    1000 /
    (epEvents.length - 1)
  );
}

async function main() {
  const days = Number(process.argv[2] ?? "5");
  const percentileThreshold = Number(process.argv[3] ?? "90");
  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(150));
  console.log(
    `P90 -> MACRO CASCADE FULL RUN -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)} (${days}d, P${percentileThreshold})`,
  );
  console.log("=".repeat(150));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  if (events.length === 0) {
    await client.close();
    return;
  }

  const btc1m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs,
    rangeEndMs + EPISODE_SEARCH_CAP_MIN * 60 * 1000,
    1,
  );
  await sleep(150);
  const btc3m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs,
    rangeEndMs + EPISODE_SEARCH_CAP_MIN * 60 * 1000,
    3,
  );
  await sleep(150);
  const btc5m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs,
    rangeEndMs + EPISODE_SEARCH_CAP_MIN * 60 * 1000,
    5,
  );
  await sleep(150);
  const atrLookbackMs = (ATR_PERIOD + 2) * ATR_INTERVAL_MIN * 60 * 1000;
  const btc15m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs - atrLookbackMs,
    rangeEndMs + EPISODE_SEARCH_CAP_MIN * 60 * 1000,
    15,
  );
  const atr15mSeries = computeAtrSeries(btc15m, ATR_PERIOD);

  async function nearestOiAtOrBefore(targetMs) {
    const doc = await oiCol
      .find({ symbol: "BTCUSDT", timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    return doc ? doc.openInterest : null;
  }

  const rawEpisodes = [];
  let i = 0;
  while (i < events.length) {
    const startEvent = events[i];
    const direction = startEvent.victim === "LONG" ? "down" : "up";
    const candidateEndMs =
      findNextEndCandidate(
        startEvent.timestamp,
        EPISODE_SEARCH_CAP_MIN * 60 * 1000,
        direction,
        btc1m,
        btc3m,
        btc5m,
      ) ?? startEvent.timestamp + EPISODE_SEARCH_CAP_MIN * 60 * 1000;
    const epEvents = [];
    while (i < events.length && events[i].timestamp <= candidateEndMs) {
      epEvents.push(events[i]);
      i++;
    }
    rawEpisodes.push({
      dominantSide: startEvent.victim,
      direction,
      events: epEvents,
      startMs: epEvents[0].timestamp,
      endMs: epEvents[epEvents.length - 1].timestamp,
      totalUsd: epEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
    });
  }
  const longP = percentile(
    rawEpisodes
      .filter((e) => e.dominantSide === "LONG")
      .map((e) => e.totalUsd)
      .sort((a, b) => a - b),
    percentileThreshold,
  );
  const shortP = percentile(
    rawEpisodes
      .filter((e) => e.dominantSide === "SHORT")
      .map((e) => e.totalUsd)
      .sort((a, b) => a - b),
    percentileThreshold,
  );
  const p90Episodes = rawEpisodes
    .filter((e) => e.totalUsd > (e.dominantSide === "LONG" ? longP : shortP))
    .sort((a, b) => a.startMs - b.startMs);

  console.log(`\nP90 EPISODES: ${p90Episodes.length}\n`);

  async function computeTransitionMetrics(N, NEXT) {
    const direction = N.direction;
    const gapSeconds = (NEXT.startMs - N.endMs) / 1000;
    const extremePrice = N.events[N.events.length - 1].price;
    const nextStartPrice = NEXT.events[0].price;
    const atrAtExtreme = nearestAtrAtOrBefore(btc15m, atr15mSeries, N.endMs);
    const recoveryATR =
      atrAtExtreme !== null && atrAtExtreme !== 0
        ? Math.abs(nextStartPrice - extremePrice) / atrAtExtreme
        : null;

    const oiEnd = await nearestOiAtOrBefore(N.endMs);
    const oiNextStart = await nearestOiAtOrBefore(NEXT.startMs);
    const oiDelta =
      oiEnd !== null && oiNextStart !== null ? oiNextStart - oiEnd : null;

    const previousPressure = finalPressure(N.events);
    const nextInitialPressure = initialPressure(NEXT.events);
    const pressureRatio =
      previousPressure > 0 ? nextInitialPressure / previousPressure : null;
    const prevCadence = avgCadenceSec(N.events.slice(-5));
    const nextCadence = avgCadenceSec(NEXT.events.slice(0, 5));
    const eventCadenceChangePct =
      prevCadence !== null && nextCadence !== null && prevCadence !== 0
        ? ((nextCadence - prevCadence) / prevCadence) * 100
        : null;

    const prevF2E = failureToExtend(N.events);
    const nextF2E = failureToExtend(NEXT.events);
    const f2eChangePct =
      prevF2E !== null && nextF2E !== null && prevF2E !== 0
        ? ((nextF2E - prevF2E) / prevF2E) * 100
        : null;

    const unresolved = recoveryATR !== null ? recoveryATR < 1 : null;
    const reaccelerated = pressureRatio !== null ? pressureRatio >= 1 : null;
    const decision =
      unresolved === true && reaccelerated === true
        ? "MERGE"
        : unresolved === null || reaccelerated === null
          ? "SPLIT(insufficient data)"
          : "SPLIT";
    const reason = decision.startsWith("MERGE")
      ? `recoveryATR=${recoveryATR.toFixed(2)}<1 AND pressureRatio=${pressureRatio.toFixed(2)}>=1`
      : `recoveryATR=${recoveryATR !== null ? recoveryATR.toFixed(2) : "N/A"} (unresolved=${unresolved}), pressureRatio=${pressureRatio !== null ? pressureRatio.toFixed(2) : "N/A"} (reaccelerated=${reaccelerated})`;

    return {
      gapSeconds,
      recoveryATR,
      oiDelta,
      pressureRatio,
      eventCadenceChangePct,
      f2eChangePct,
      decision,
      reason,
    };
  }

  // Evaluate EVERY consecutive pair (same-direction scored; direction-mismatch auto-SPLIT).
  const pairDecisions = [];
  for (let k = 0; k < p90Episodes.length - 1; k++) {
    const N = p90Episodes[k],
      NEXT = p90Episodes[k + 1];
    if (N.dominantSide !== NEXT.dominantSide) {
      pairDecisions.push({
        N,
        NEXT,
        decision: "SPLIT",
        reason: "direction mismatch (LONG<->SHORT) -- automatic split",
        gapSeconds: (NEXT.startMs - N.endMs) / 1000,
        recoveryATR: null,
        oiDelta: null,
        pressureRatio: null,
        eventCadenceChangePct: null,
        f2eChangePct: null,
      });
      continue;
    }
    const m = await computeTransitionMetrics(N, NEXT);
    pairDecisions.push({ N, NEXT, ...m });
  }

  console.log(
    `SAME-DIRECTION PAIRS TESTED: ${pairDecisions.filter((p) => p.N.dominantSide === p.NEXT.dominantSide).length}\n`,
  );

  console.log("=".repeat(150));
  console.log("PER-PAIR RESULTS");
  console.log("=".repeat(150));
  console.log(
    "PREV start->end                                    NEXT start->end                                   DIR    recATR   OIdelta      pressRatio  cadChg%    F2Echg%   DECISION",
  );
  console.log("-".repeat(150));
  for (const p of pairDecisions) {
    console.log(
      `${isoUtc(p.N.startMs)}->${isoUtc(p.N.endMs)}  ${isoUtc(p.NEXT.startMs)}->${isoUtc(p.NEXT.endMs)}  ${p.N.dominantSide.padEnd(5)}  ${fmtNum(p.recoveryATR).padStart(7)}  ${p.oiDelta !== null ? (p.oiDelta >= 0 ? "+" : "") + p.oiDelta.toFixed(2) : "N/A"}`.padEnd(
        150,
      ),
    );
    console.log(
      `    pressureRatio=${p.pressureRatio !== null ? p.pressureRatio.toFixed(3) : "N/A"}  cadenceChange=${fmtPct(p.eventCadenceChangePct)}  F2Echange=${fmtPct(p.f2eChangePct)}  gapSec=${p.gapSeconds.toFixed(0)}  ==> ${p.decision}  (${p.reason})`,
    );
  }

  const mergeCount = pairDecisions.filter((p) => p.decision === "MERGE").length;
  const splitCount = pairDecisions.length - mergeCount;

  // Transitive merge.
  const macroCascades = [];
  let currentGroup = [p90Episodes[0]];
  for (const p of pairDecisions) {
    if (p.decision === "MERGE") currentGroup.push(p.NEXT);
    else {
      macroCascades.push(currentGroup);
      currentGroup = [p.NEXT];
    }
  }
  macroCascades.push(currentGroup);

  console.log(`\n${"=".repeat(150)}`);
  console.log("SUMMARY");
  console.log("=".repeat(150));
  console.log(`P90 EPISODES: ${p90Episodes.length}`);
  console.log(
    `SAME-DIRECTION PAIRS TESTED: ${pairDecisions.filter((p) => p.N.dominantSide === p.NEXT.dominantSide).length}`,
  );
  console.log(`MERGE: ${mergeCount}`);
  console.log(`SPLIT: ${splitCount}`);
  console.log(`FINAL MACRO CASCADES: ${macroCascades.length}`);

  const macroWithStats = macroCascades.map((group) => {
    const dominantSide = group[0].dominantSide;
    const startMs = group[0].startMs;
    const endMs = group[group.length - 1].endMs;
    const totalUsd = group.reduce((a, ep) => a + ep.totalUsd, 0);
    return { dominantSide, startMs, endMs, episodes: group, totalUsd };
  });

  console.log(`\n${"=".repeat(150)}`);
  console.log("ALL MACRO CASCADES");
  console.log("=".repeat(150));
  macroWithStats.forEach((m, idx) => {
    console.log(
      `\nMACRO #${idx + 1}: ${m.dominantSide}  ${isoUtc(m.startMs)} -> ${isoUtc(m.endMs)}  episodes=${m.episodes.length}  total=${fmtUsd(m.totalUsd)}`,
    );
    m.episodes.forEach((ep) =>
      console.log(
        `    - ${isoUtc(ep.startMs)} -> ${isoUtc(ep.endMs)}  (${fmtUsd(ep.totalUsd)})`,
      ),
    );
  });

  const top20 = [...macroWithStats]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 20);
  console.log(`\n${"=".repeat(150)}`);
  console.log("TOP 20 MACRO CASCADES BY LIQUIDATION USD");
  console.log("=".repeat(150));
  top20.forEach((m, idx) => {
    console.log(
      `  ${String(idx + 1).padStart(3)}. ${m.dominantSide.padEnd(6)} ${isoUtc(m.startMs)} -> ${isoUtc(m.endMs)}  episodes=${m.episodes.length}  total=${fmtUsd(m.totalUsd)}`,
    );
  });

  console.log(`\n${"=".repeat(150)}`);
  console.log(
    "NO forward return computed. NO profitability language. Diagnostic only.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
