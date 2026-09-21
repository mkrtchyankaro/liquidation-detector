// P90 EPISODE TRANSITION DYNAMICS -- DEBUG (3 transitions only).
//
// No fixed time-gap threshold anywhere in the decision. Computes, for
// each N -> N+1 transition between consecutive SAME-DIRECTION P90
// episodes:
//   PRICE NORMALIZATION: recoveryPct, recoveryATR, distanceFromPrior
//     ExtremeATR, priceVelocity
//   OI DYNAMICS: OI_END, OI_NEXT_START, OI_delta, OI_velocity
//   LIQUIDATION RE-ACCELERATION: previousPressure, nextInitialPressure,
//     pressureRatio, eventCadenceChange
//   FAILURE-TO-EXTEND: previousFailureToExtend, nextFailureToExtend,
//     noProgressLiqShare
// Prints all raw metrics for operator inspection, plus a PROVISIONAL
// MERGE/SPLIT read with the specific metrics cited as reasons -- not
// a locked rule, for review before running the full dataset.
//
//   node scripts/p90-transition-dynamics-debug.js <daysBack=5> <percentile=90>
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const FINAL_BURST_WINDOW_SEC = 90;
const EPISODE_SEARCH_CAP_MIN = 180;
const ATR_PERIOD = 14;
const ATR_INTERVAL_MIN = 15;

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

/** Liquidation intensity ($/sec) in the final FINAL_BURST_WINDOW_SEC
 *  of an episode's OWN events. */
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
/** Liquidation intensity ($/sec) in the FIRST FINAL_BURST_WINDOW_SEC
 *  of an episode's OWN events. */
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
/** Failure-to-extend for a whole episode: $ spent per 1% of the
 *  episode's own total directional price extension. */
function failureToExtend(epEvents, direction) {
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
/** Share of this episode's total $ that came from events which did
 *  NOT extend the running directional extreme any further. */
function noProgressLiqShare(epEvents, direction) {
  let extreme = epEvents[0].price;
  let noProgressUsd = 0;
  const totalUsd = epEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
  for (const e of epEvents) {
    const isNew = direction === "down" ? e.price < extreme : e.price > extreme;
    if (isNew) extreme = e.price;
    else noProgressUsd += e.quoteQty ?? 0;
  }
  return totalUsd > 0 ? (noProgressUsd / totalUsd) * 100 : null;
}
/** Average time between consecutive events, in seconds, over the
 *  episode's own events. */
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

  console.log("=".repeat(120));
  console.log(
    `P90 TRANSITION DYNAMICS DEBUG -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)} (${days}d, P${percentileThreshold})`,
  );
  console.log(
    "Debugging ONLY transitions #31->#32, #32->#33, #33->#34. No fixed time-gap threshold used anywhere below.",
  );
  console.log("=".repeat(120));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(`\nLoaded ${events.length} BTCUSDT liquidation events.`);
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

  // Discover raw dominant-side episodes (candle-confirmed end), same validated builder.
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
  const p90Episodes = rawEpisodes.filter(
    (e) => e.totalUsd > (e.dominantSide === "LONG" ? longP : shortP),
  );

  console.log(
    `\n${p90Episodes.length} P90 episode(s) found. Debugging transitions at index 31->32, 32->33, 33->34 (1-indexed).\n`,
  );
  if (p90Episodes.length < 34) {
    console.log(
      `ERROR: only ${p90Episodes.length} P90 episodes found -- cannot debug transition #33->#34. Adjust <daysBack> and re-run.`,
    );
    await client.close();
    return;
  }

  const transitionPairs = [
    [31, 32],
    [32, 33],
    [33, 34],
  ];

  for (const [nIdx, nextIdx] of transitionPairs) {
    const N = p90Episodes[nIdx - 1];
    const NEXT = p90Episodes[nextIdx - 1];

    console.log("=".repeat(120));
    console.log(`TRANSITION #${nIdx} -> #${nextIdx}`);
    console.log(
      `  #${nIdx}: ${N.dominantSide} ${isoUtc(N.startMs)} -> ${isoUtc(N.endMs)}  total=${fmtUsd(N.totalUsd)}`,
    );
    console.log(
      `  #${nextIdx}: ${NEXT.dominantSide} ${isoUtc(NEXT.startMs)} -> ${isoUtc(NEXT.endMs)}  total=${fmtUsd(NEXT.totalUsd)}`,
    );
    console.log("=".repeat(120));

    const direction = N.direction; // "down" for LONG-victim, "up" for SHORT-victim
    const gapSeconds = (NEXT.startMs - N.endMs) / 1000;

    // -- PRICE NORMALIZATION --
    const extremePrice = N.events[N.events.length - 1].price; // N's own directional extreme
    const nextStartPrice = NEXT.events[0].price;
    const rawRecoveryPct = extremePrice
      ? ((nextStartPrice - extremePrice) / extremePrice) * 100
      : null;
    const recoveryPct =
      rawRecoveryPct !== null
        ? rawRecoveryPct * (direction === "down" ? 1 : -1)
        : null; // positive = moved AWAY from stress
    const atrAtExtreme = nearestAtrAtOrBefore(btc15m, atr15mSeries, N.endMs);
    const recoveryATR =
      recoveryPct !== null &&
      atrAtExtreme !== null &&
      atrAtExtreme !== 0 &&
      extremePrice
        ? Math.abs(nextStartPrice - extremePrice) / atrAtExtreme
        : null;
    const distanceFromPriorExtremeATR = recoveryATR; // same quantity, named per spec (distance from N's extreme at N+1 start, in ATR units)
    const priceVelocity =
      recoveryPct !== null && gapSeconds > 0 ? recoveryPct / gapSeconds : null; // %/sec

    console.log(`\n  gapSeconds: ${gapSeconds.toFixed(1)}`);
    console.log(`  -- PRICE NORMALIZATION --`);
    console.log(
      `  recoveryPct (away from stress, +=good): ${fmtPct(recoveryPct)}`,
    );
    console.log(
      `  recoveryATR (ATR(14,15m) at N's extreme = ${fmtNum(atrAtExtreme)}): ${fmtNum(recoveryATR)}`,
    );
    console.log(
      `  distanceFromPriorExtremeATR: ${fmtNum(distanceFromPriorExtremeATR)}`,
    );
    console.log(
      `  priceVelocity (%/sec): ${priceVelocity !== null ? priceVelocity.toFixed(6) : "N/A"}`,
    );

    // -- OI DYNAMICS --
    const oiEnd = await nearestOiAtOrBefore(N.endMs);
    const oiNextStart = await nearestOiAtOrBefore(NEXT.startMs);
    const oiDelta =
      oiEnd !== null && oiNextStart !== null ? oiNextStart - oiEnd : null;
    const oiVelocity =
      oiDelta !== null && gapSeconds > 0 ? oiDelta / gapSeconds : null;

    console.log(`\n  -- OI DYNAMICS --`);
    console.log(`  OI_END: ${oiEnd !== null ? oiEnd.toFixed(2) : "N/A"}`);
    console.log(
      `  OI_NEXT_START: ${oiNextStart !== null ? oiNextStart.toFixed(2) : "N/A"}`,
    );
    console.log(
      `  OI_delta: ${oiDelta !== null ? (oiDelta >= 0 ? "+" : "") + oiDelta.toFixed(2) : "N/A"}`,
    );
    console.log(
      `  OI_velocity (/sec): ${oiVelocity !== null ? oiVelocity.toFixed(4) : "N/A"}`,
    );

    // -- LIQUIDATION RE-ACCELERATION --
    const previousPressure = finalPressure(N.events);
    const nextInitialPressure = initialPressure(NEXT.events);
    const pressureRatio =
      previousPressure > 0 ? nextInitialPressure / previousPressure : null;
    const prevCadence = avgCadenceSec(N.events.slice(-5)); // last up-to-5 events of N
    const nextCadence = avgCadenceSec(NEXT.events.slice(0, 5)); // first up-to-5 events of NEXT
    const eventCadenceChange =
      prevCadence !== null && nextCadence !== null && prevCadence !== 0
        ? ((nextCadence - prevCadence) / prevCadence) * 100
        : null;

    console.log(`\n  -- LIQUIDATION RE-ACCELERATION --`);
    console.log(
      `  previousPressure ($/sec, N's final ${FINAL_BURST_WINDOW_SEC}s): ${fmtUsd(previousPressure)}`,
    );
    console.log(
      `  nextInitialPressure ($/sec, NEXT's first ${FINAL_BURST_WINDOW_SEC}s): ${fmtUsd(nextInitialPressure)}`,
    );
    console.log(
      `  pressureRatio (next/previous): ${pressureRatio !== null ? pressureRatio.toFixed(3) : "N/A"}`,
    );
    console.log(
      `  eventCadenceChange (N's last-5 avg gap vs NEXT's first-5 avg gap): ${fmtPct(eventCadenceChange)}`,
    );

    // -- FAILURE-TO-EXTEND / PRICE EFFICIENCY --
    const prevF2E = failureToExtend(N.events, direction);
    const nextF2E = failureToExtend(NEXT.events, direction);
    const prevNoProgressShare = noProgressLiqShare(N.events, direction);
    const nextNoProgressShare = noProgressLiqShare(NEXT.events, direction);

    console.log(`\n  -- FAILURE-TO-EXTEND / PRICE EFFICIENCY --`);
    console.log(
      `  previousFailureToExtend ($/1% extension, N): ${prevF2E !== null ? fmtUsd(prevF2E) : "N/A"}`,
    );
    console.log(
      `  nextFailureToExtend ($/1% extension, NEXT): ${nextF2E !== null ? fmtUsd(nextF2E) : "N/A"}`,
    );
    console.log(
      `  noProgressLiqShare N: ${prevNoProgressShare !== null ? prevNoProgressShare.toFixed(1) + "%" : "N/A"}   NEXT: ${nextNoProgressShare !== null ? nextNoProgressShare.toFixed(1) + "%" : "N/A"}`,
    );

    // -- PROVISIONAL READ (for inspection, not a locked rule) --
    const reasons = [];
    let leanMerge = 0,
      leanSplit = 0;
    if (recoveryATR !== null) {
      if (recoveryATR < 1) {
        leanMerge++;
        reasons.push(
          `recoveryATR=${recoveryATR.toFixed(2)} < 1 ATR -- price stayed inside the stressed region`,
        );
      } else {
        leanSplit++;
        reasons.push(
          `recoveryATR=${recoveryATR.toFixed(2)} >= 1 ATR -- price moved a meaningful distance from N's extreme`,
        );
      }
    }
    if (oiDelta !== null) {
      if (oiDelta <= 0) {
        leanMerge++;
        reasons.push(
          `OI_delta=${oiDelta.toFixed(2)} <= 0 -- no net fresh positioning built before NEXT ignited`,
        );
      } else {
        leanSplit++;
        reasons.push(
          `OI_delta=${oiDelta.toFixed(2)} > 0 -- fresh OI built during the gap, consistent with an independent new event`,
        );
      }
    }
    if (pressureRatio !== null) {
      if (pressureRatio >= 0.75) {
        leanMerge++;
        reasons.push(
          `pressureRatio=${pressureRatio.toFixed(2)} -- NEXT re-ignited at comparable or greater intensity than N's final burst`,
        );
      } else {
        leanSplit++;
        reasons.push(
          `pressureRatio=${pressureRatio.toFixed(2)} -- NEXT started much weaker than N's final burst`,
        );
      }
    }

    console.log(
      `\n  PROVISIONAL: ${leanMerge > leanSplit ? "MERGE" : leanSplit > leanMerge ? "SPLIT" : "AMBIGUOUS (tied)"}  (leanMerge=${leanMerge}, leanSplit=${leanSplit})`,
    );
    console.log(`  REASONS:`);
    reasons.forEach((r) => console.log(`    - ${r}`));
    console.log("");
  }

  console.log(`${"=".repeat(120)}`);
  console.log(
    "Full dataset NOT run. Inspect the three transitions above before proceeding.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
