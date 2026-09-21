// Sep 20 2026 (Karo), operator-requested. Runs the validated 4-METRIC
// FRAMEWORK (PRESSURE, FAILURE-TO-EXTEND, REJECTION, OI-STATE-NEAR-
// END) across EVERY confirmed BTC episode in a multi-day window --
// not one hand-picked example. Uses the same dominant-side episode
// discovery + per-side P90 filter already validated this session.
// For each confirmed episode: computes all 4 metrics, checks whether
// all 4 "good entry" conditions hold, and compares the forward+60m
// outcome between the ALL-4-GOOD group and everyone else -- an
// auto-computed aggregate (never hand-read), with N shown for every
// bucket so no single episode can silently dominate the result the
// way Cascade #2 once did earlier in this session.
//
//   node scripts/btc-4-metrics-aggregate.js 5 90
//
// (arg1 = days back, default 5; arg2 = percentile threshold for
// "big" episodes, default 90)
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const FINAL_BURST_WINDOW_SEC = 90;
const ATR_FROZEN_TOLERANCE_PCT = 3;
const RECOVERY_SEARCH_CAP_MIN = 60;
const EPISODE_SEARCH_CAP_MIN = 180;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19) + "Z";
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
function mean(arr) {
  const v = arr.filter(
    (x) => x !== null && x !== undefined && Number.isFinite(x),
  );
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
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
function priceAtOrBefore(candles, targetMs) {
  let best = null;
  for (const c of candles) {
    if (c.openTimeMs <= targetMs) best = c;
    else break;
  }
  return best ? best.close : null;
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

  console.log("=".repeat(130));
  console.log(
    `BTC 4-METRIC AGGREGATE -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)} (${days} days)`,
  );
  console.log("=".repeat(130));

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

  const tail =
    (EPISODE_SEARCH_CAP_MIN + RECOVERY_SEARCH_CAP_MIN + 60) * 60 * 1000;
  console.log("Fetching klines...");
  const btc1m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs,
    rangeEndMs + tail,
    1,
  );
  await sleep(150);
  const btc3m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs,
    rangeEndMs + tail,
    3,
  );
  await sleep(150);
  const btc5m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs,
    rangeEndMs + tail,
    5,
  );
  await sleep(150);
  const atrLookbackMs = 16 * 15 * 60 * 1000;
  const btc15m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs - atrLookbackMs,
    rangeEndMs + tail,
    15,
  );
  const atr15mSeries = computeAtrSeries(btc15m, 14);

  async function nearestOiAtOrBefore(targetMs) {
    const doc = await oiCol
      .find({ symbol: "BTCUSDT", timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    return doc
      ? {
          value: doc.openInterest,
          ts:
            doc.timestamp instanceof Date
              ? doc.timestamp.getTime()
              : doc.timestamp,
        }
      : null;
  }

  // Discovery: dominant-side grouping (validated), then per-side P90 filter.
  const rawEpisodes = [];
  let cur = { events: [events[0]], dominantSide: events[0].victim };
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const direction = cur.dominantSide;
    const searchEnd = findNextEndCandidate(
      cur.events[cur.events.length - 1].timestamp,
      EPISODE_SEARCH_CAP_MIN * 60 * 1000,
      direction === "LONG" ? "down" : "up",
      btc1m,
      btc3m,
      btc5m,
    );
    if (
      e.timestamp - cur.events[cur.events.length - 1].timestamp >
        10 * 60 * 1000 ||
      (searchEnd !== null && e.timestamp > searchEnd)
    ) {
      rawEpisodes.push(cur);
      cur = { events: [e], dominantSide: e.victim };
    } else {
      cur.events.push(e);
    }
  }
  rawEpisodes.push(cur);
  const withTotals = rawEpisodes.map((e) => ({
    ...e,
    totalUsd: e.events.reduce((a, x) => a + (x.quoteQty ?? 0), 0),
    startMs: e.events[0].timestamp,
    endMs: e.events[e.events.length - 1].timestamp,
  }));
  const longP = percentile(
    withTotals
      .filter((e) => e.dominantSide === "LONG")
      .map((e) => e.totalUsd)
      .sort((a, b) => a - b),
    percentileThreshold,
  );
  const shortP = percentile(
    withTotals
      .filter((e) => e.dominantSide === "SHORT")
      .map((e) => e.totalUsd)
      .sort((a, b) => a - b),
    percentileThreshold,
  );
  const bigEpisodes = withTotals.filter(
    (e) => e.totalUsd > (e.dominantSide === "LONG" ? longP : shortP),
  );

  console.log(
    `\nDiscovered ${withTotals.length} total episode(s), ${bigEpisodes.length} big (per-side P${percentileThreshold}).\n`,
  );

  const globalRows = [];

  for (let idx = 0; idx < bigEpisodes.length; idx++) {
    const ep = bigEpisodes[idx];
    const lastEvent = ep.events[ep.events.length - 1];
    const direction = ep.dominantSide === "LONG" ? "down" : "up";

    const burstStartMs = lastEvent.timestamp - FINAL_BURST_WINDOW_SEC * 1000;
    const burstEvents = ep.events.filter((e) => e.timestamp >= burstStartMs);
    if (burstEvents.length === 0) continue;
    const burstUsd = burstEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const burstDurationSec = Math.max(
      1,
      (lastEvent.timestamp - burstEvents[0].timestamp) / 1000,
    );
    const pressure = burstUsd / burstDurationSec;

    const burstStartPrice = burstEvents[0].price;
    const extensionPct = burstStartPrice
      ? ((lastEvent.price - burstStartPrice) / burstStartPrice) * 100
      : null;
    const failureToExtend =
      extensionPct !== null && Math.abs(extensionPct) > 0.0001
        ? burstUsd / Math.abs(extensionPct)
        : null;

    const recoveryMs = findNextEndCandidate(
      ep.endMs,
      RECOVERY_SEARCH_CAP_MIN * 60 * 1000,
      direction,
      btc1m,
      btc3m,
      btc5m,
    );
    if (recoveryMs === null) continue;

    const priceAtRecovery = priceAtOrBefore(btc1m, recoveryMs);
    const atrAtExtreme = nearestAtrAtOrBefore(
      btc15m,
      atr15mSeries,
      lastEvent.timestamp,
    );
    const atrAtRecovery = nearestAtrAtOrBefore(
      btc15m,
      atr15mSeries,
      recoveryMs,
    );
    const atrChangePct =
      atrAtExtreme !== null && atrAtExtreme !== 0 && atrAtRecovery !== null
        ? ((atrAtRecovery - atrAtExtreme) / atrAtExtreme) * 100
        : null;
    const atrFrozen =
      atrChangePct !== null
        ? Math.abs(atrChangePct) <= ATR_FROZEN_TOLERANCE_PCT
        : null;
    const recoverySpeedMin = (recoveryMs - lastEvent.timestamp) / 60000;

    const oiAtBurstStart = await nearestOiAtOrBefore(burstEvents[0].timestamp);
    const oiAtRecovery = await nearestOiAtOrBefore(recoveryMs);
    const oiDelta =
      oiAtBurstStart !== null && oiAtRecovery !== null
        ? oiAtRecovery.value - oiAtBurstStart.value
        : null;
    const oiFlatOrNegative = oiDelta !== null ? oiDelta <= 0 : null;

    const sign = direction === "down" ? 1 : -1;
    const fwd60raw = priceAtOrBefore(btc1m, recoveryMs + 60 * 60 * 1000);
    const fwd60 =
      priceAtRecovery && fwd60raw
        ? ((fwd60raw - priceAtRecovery) / priceAtRecovery) * 100 * sign
        : null;

    const allFourGood = atrFrozen === true && oiFlatOrNegative === true;
    // NOTE: PRESSURE and FAILURE-TO-EXTEND are magnitude metrics without an obvious universal
    // "good" threshold on their own (they need comparison against a symbol's own recent
    // episodes, as in the single-example analysis) -- this aggregate uses ATR-frozen and
    // OI-flat/negative as the two BINARY conditions, and reports PRESSURE/FAILURE-TO-EXTEND
    // as continuous variables to correlate against, rather than forcing an arbitrary cutoff.

    console.log(
      `Episode #${idx + 1}: ${ep.dominantSide}  ${hhmmss(ep.startMs)}->${hhmmss(ep.endMs)}  PRESSURE=${fmtUsd(pressure)}/s  F2E=${failureToExtend !== null ? fmtUsd(failureToExtend) + "/1%" : "N/A"}  ATR-frozen=${atrFrozen}  OI-flat/neg=${oiFlatOrNegative}  fwd+60m=${fmtPct(fwd60)}`,
    );

    globalRows.push({
      pressure,
      failureToExtend,
      atrFrozen,
      oiFlatOrNegative,
      allFourGood,
      fwd60,
    });
  }

  console.log(`\n${"=".repeat(130)}`);
  console.log(
    `AUTO-COMPUTED AGGREGATE -- N=${globalRows.length} confirmed big episodes`,
  );
  console.log("=".repeat(130));

  const goodGroup = globalRows.filter((r) => r.allFourGood);
  const otherGroup = globalRows.filter((r) => !r.allFourGood);
  console.log(
    `\nALL CONDITIONS GOOD (ATR-frozen AND OI-flat/negative): N=${goodGroup.length}  avg fwd+60m=${fmtPct(mean(goodGroup.map((r) => r.fwd60)))}`,
  );
  console.log(
    `EVERYONE ELSE:                                         N=${otherGroup.length}  avg fwd+60m=${fmtPct(mean(otherGroup.map((r) => r.fwd60)))}`,
  );

  console.log(`\nPRESSURE vs fwd+60m (correlation check, terciles):`);
  const byPressure = [...globalRows].sort(
    (a, b) => (a.pressure ?? 0) - (b.pressure ?? 0),
  );
  const third = Math.floor(byPressure.length / 3);
  console.log(
    `  low pressure:  N=${third}  avg fwd+60m=${fmtPct(mean(byPressure.slice(0, third).map((r) => r.fwd60)))}`,
  );
  console.log(
    `  mid pressure:  N=${byPressure.length - 2 * third}  avg fwd+60m=${fmtPct(mean(byPressure.slice(third, byPressure.length - third).map((r) => r.fwd60)))}`,
  );
  console.log(
    `  high pressure: N=${third}  avg fwd+60m=${fmtPct(mean(byPressure.slice(byPressure.length - third).map((r) => r.fwd60)))}`,
  );

  console.log(`\n${"=".repeat(130)}`);
  console.log(
    "This never touches live strategy or trading logic. N is shown for every bucket -- check it before trusting any row.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
