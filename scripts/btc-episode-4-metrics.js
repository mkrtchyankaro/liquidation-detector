// Sep 20 2026 (Karo), operator-specified framework. Computes exactly
// four metrics per fixed episode:
//
//   1. PRESSURE = liquidation USD/second, in the FINAL BURST window
//      only (not the whole episode) -- the last FINAL_BURST_WINDOW_SEC
//      seconds of events before the episode's last event.
//
//   2. FAILURE TO EXTEND = given the final burst's $ size, how little
//      NEW price extreme it produced. Expressed as USD spent per 1%
//      of price extension achieved DURING the burst -- a large number
//      means heavy forced selling that barely moved price further.
//
//   3. REJECTION = extreme -> recovery distance (% price move) +
//      whether ATR stayed FROZEN (flat, not expanding) across that
//      same stretch + how FAST the recovery was confirmed (minutes
//      from the extreme to the 1m+3m+5m recovery signal).
//
//   4. OI STATE NEAR END = OI delta AND rate (per minute), computed
//      specifically from the START of the final burst through to the
//      recovery point -- NOT the whole episode's OI change.
//
// Uses the operator's own already-confirmed 4 episodes as fixed
// input (edit EPISODES to reuse for any other confirmed set).
//
//   node scripts/btc-episode-4-metrics.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const EPISODES = [
  {
    startMs: Date.parse("2026-09-20T02:24:27.128Z"),
    endMs: Date.parse("2026-09-20T02:36:27.128Z"),
  },
  {
    startMs: Date.parse("2026-09-20T02:39:21.185Z"),
    endMs: Date.parse("2026-09-20T02:46:21.185Z"),
  },
  {
    startMs: Date.parse("2026-09-20T02:54:09.182Z"),
    endMs: Date.parse("2026-09-20T03:03:09.182Z"),
  },
  {
    startMs: Date.parse("2026-09-20T03:14:42.177Z"),
    endMs: Date.parse("2026-09-20T03:16:42.177Z"),
  },
];

const FINAL_BURST_WINDOW_SEC = 90; // last 1.5min of events before the episode's own last event
const ATR_FROZEN_TOLERANCE_PCT = 3; // ATR change within +-3% counts as "frozen" for the REJECTION metric

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
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  const overallStart =
    Math.min(...EPISODES.map((e) => e.startMs)) - 30 * 60 * 1000;
  const overallEnd =
    Math.max(...EPISODES.map((e) => e.endMs)) + 3 * 3600 * 1000;

  console.log("=".repeat(130));
  console.log(
    "BTC EPISODE 4-METRIC FRAMEWORK -- PRESSURE / FAILURE-TO-EXTEND / REJECTION / OI-STATE-NEAR-END",
  );
  console.log("=".repeat(130));

  const btc1m = await fetchKlinesRange("BTCUSDT", overallStart, overallEnd, 1);
  await sleep(150);
  const btc3m = await fetchKlinesRange("BTCUSDT", overallStart, overallEnd, 3);
  await sleep(150);
  const btc5m = await fetchKlinesRange("BTCUSDT", overallStart, overallEnd, 5);
  await sleep(150);
  const atrLookbackMs = 16 * 15 * 60 * 1000;
  const btc15m = await fetchKlinesRange(
    "BTCUSDT",
    overallStart - atrLookbackMs,
    overallEnd,
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

  for (let idx = 0; idx < EPISODES.length; idx++) {
    const { startMs, endMs } = EPISODES[idx];
    const events = await liqCol
      .find({ symbol: "BTCUSDT", timestamp: { $gte: startMs, $lte: endMs } })
      .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    if (events.length === 0) {
      console.log(`EPISODE #${idx + 1}: no events -- skipped.\n`);
      continue;
    }
    const lastEvent = events[events.length - 1];
    const direction = events[0].victim === "LONG" ? "down" : "up";

    console.log("=".repeat(130));
    console.log(
      `EPISODE #${idx + 1}: ${events[0].victim}  ${hhmmss(startMs)} -> ${hhmmss(endMs)}  (${events.length} events, total ${fmtUsd(events.reduce((a, e) => a + (e.quoteQty ?? 0), 0))})`,
    );
    console.log("=".repeat(130));

    // Final burst window: events within FINAL_BURST_WINDOW_SEC of the episode's last event.
    const burstStartMs = lastEvent.timestamp - FINAL_BURST_WINDOW_SEC * 1000;
    const burstEvents = events.filter((e) => e.timestamp >= burstStartMs);
    const burstUsd = burstEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const burstDurationSec = Math.max(
      1,
      (lastEvent.timestamp - burstEvents[0].timestamp) / 1000,
    );

    // 1. PRESSURE
    const pressureUsdPerSec = burstUsd / burstDurationSec;
    console.log(
      `\n1. PRESSURE (final ${FINAL_BURST_WINDOW_SEC}s burst): ${burstEvents.length} event(s), ${fmtUsd(burstUsd)} over ${burstDurationSec.toFixed(1)}s -> ${fmtUsd(pressureUsdPerSec)}/sec`,
    );

    // 2. FAILURE TO EXTEND
    const burstStartPrice = burstEvents[0].price;
    const extensionPct = burstStartPrice
      ? ((lastEvent.price - burstStartPrice) / burstStartPrice) * 100
      : null;
    const usdPer1PctExtension =
      extensionPct !== null && Math.abs(extensionPct) > 0.0001
        ? burstUsd / Math.abs(extensionPct)
        : null;
    console.log(
      `2. FAILURE TO EXTEND: burst moved price ${fmtPct(extensionPct)} on ${fmtUsd(burstUsd)} -> ${usdPer1PctExtension !== null ? fmtUsd(usdPer1PctExtension) + "/1% extension" : "N/A (near-zero extension -- burst produced almost no new extreme)"}`,
    );

    // Recovery point, searched from this episode's given end.
    const recoveryMs = findNextEndCandidate(
      endMs,
      60 * 60 * 1000,
      direction,
      btc1m,
      btc3m,
      btc5m,
    );
    if (recoveryMs === null) {
      console.log(
        `3. REJECTION: recovery not confirmed within 60min -- cannot compute.`,
      );
      console.log(
        `4. OI STATE NEAR END: recovery not confirmed -- cannot compute.\n`,
      );
      continue;
    }

    // 3. REJECTION
    const priceAtRecovery = priceAtOrBefore(btc1m, recoveryMs);
    const rejectionDistancePct = lastEvent.price
      ? ((priceAtRecovery - lastEvent.price) / lastEvent.price) * 100
      : null;
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
    console.log(
      `3. REJECTION: extreme->recovery distance=${fmtPct(rejectionDistancePct)}  ATR ${fmtNum(atrAtExtreme)}->${fmtNum(atrAtRecovery)} (${fmtPct(atrChangePct)}, ${atrFrozen === null ? "N/A" : atrFrozen ? "FROZEN" : "still expanding"})  recovery speed=${recoverySpeedMin.toFixed(1)}min`,
    );

    // 4. OI STATE NEAR END -- from START OF FINAL BURST through recovery, not whole episode.
    const oiAtBurstStart = await nearestOiAtOrBefore(burstEvents[0].timestamp);
    const oiAtRecovery = await nearestOiAtOrBefore(recoveryMs);
    const oiDelta =
      oiAtBurstStart !== null && oiAtRecovery !== null
        ? oiAtRecovery.value - oiAtBurstStart.value
        : null;
    const oiWindowMin =
      oiAtBurstStart !== null ? (recoveryMs - oiAtBurstStart.ts) / 60000 : null;
    const oiRatePerMin =
      oiDelta !== null && oiWindowMin > 0 ? oiDelta / oiWindowMin : null;
    console.log(
      `4. OI STATE NEAR END (burst-start->recovery, NOT whole episode): OI ${oiAtBurstStart !== null ? oiAtBurstStart.value.toFixed(2) : "N/A"} -> ${oiAtRecovery !== null ? oiAtRecovery.value.toFixed(2) : "N/A"}  delta=${oiDelta !== null ? (oiDelta >= 0 ? "+" : "") + oiDelta.toFixed(2) : "N/A"}  rate=${oiRatePerMin !== null ? (oiRatePerMin >= 0 ? "+" : "") + oiRatePerMin.toFixed(2) + "/min" : "N/A"}`,
    );

    const sign = direction === "down" ? 1 : -1;
    const fwd60 = priceAtOrBefore(btc1m, recoveryMs + 60 * 60 * 1000);
    const fwd60pct =
      priceAtRecovery && fwd60
        ? ((fwd60 - priceAtRecovery) / priceAtRecovery) * 100 * sign
        : null;
    console.log(
      `\n   OUTCOME: forward+60m from recovery = ${fmtPct(fwd60pct)}\n`,
    );
  }

  console.log(`${"=".repeat(130)}`);
  console.log(
    "This never touches live strategy or trading logic -- diagnostic only.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
