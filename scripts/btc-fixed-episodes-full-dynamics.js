// Sep 20 2026 (Karo), operator-requested. Takes the operator's OWN,
// already-confirmed 4 episodes as FIXED INPUT (no re-segmentation, no
// recomputation of boundaries -- exactly the timestamps already
// validated). For EACH one, computes every variable the operator
// asked for:
//   - OI at the episode's first event, OI at its last event (extreme),
//     and the delta between them
//   - ATR(14, 15m) at the last event / extreme, and its change from
//     the episode's own start
//   - VELOCITY within the episode: for each consecutive event pair,
//     time gap and $ size -- to see whether liquidation kept
//     accelerating while price stopped making new extremes (the
//     "growing but can't move price" pattern)
//   - RECOVERY (1m+3m+5m simultaneous opposite candle, searched from
//     this episode's own given end) -- OI, ATR, and price AT that
//     recovery point
//   - Price change from extreme to recovery, and a forward check
//
// Edit EPISODES below to reuse this for any other confirmed set.
//
//   node scripts/btc-fixed-episodes-full-dynamics.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

// Sep 20 2026 (Karo) -- the operator's own, already-confirmed 4 episodes.
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
    `BTC FIXED EPISODES -- FULL DYNAMICS (${EPISODES.length} operator-confirmed episodes, no re-segmentation)`,
  );
  console.log("=".repeat(130));

  console.log("\nFetching klines (1m, 3m, 5m for recovery; 15m for ATR)...");
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
    return doc ? doc.openInterest : null;
  }

  for (let idx = 0; idx < EPISODES.length; idx++) {
    const { startMs, endMs } = EPISODES[idx];
    const events = await liqCol
      .find({ symbol: "BTCUSDT", timestamp: { $gte: startMs, $lte: endMs } })
      .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    if (events.length === 0) {
      console.log(
        `EPISODE #${idx + 1}: no events found in [${isoUtc(startMs)}, ${isoUtc(endMs)}] -- skipped.\n`,
      );
      continue;
    }
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const direction = firstEvent.victim === "LONG" ? "down" : "up";

    console.log("-".repeat(130));
    console.log(
      `EPISODE #${idx + 1}: ${firstEvent.victim} cascade, ${events.length} event(s), ${hhmmss(startMs)} -> ${hhmmss(endMs)}, total=${fmtUsd(events.reduce((a, e) => a + (e.quoteQty ?? 0), 0))}`,
    );
    console.log("-".repeat(130));

    // OI: first event vs last event.
    const oiAtFirst = await nearestOiAtOrBefore(firstEvent.timestamp);
    const oiAtLast = await nearestOiAtOrBefore(lastEvent.timestamp);
    console.log(
      `  OI at first event: ${oiAtFirst !== null ? oiAtFirst.toFixed(2) : "N/A"}   OI at last event (extreme): ${oiAtLast !== null ? oiAtLast.toFixed(2) : "N/A"}   delta: ${oiAtFirst !== null && oiAtLast !== null ? (oiAtLast - oiAtFirst >= 0 ? "+" : "") + (oiAtLast - oiAtFirst).toFixed(2) : "N/A"}`,
    );

    // ATR: at first event vs at last event (extreme).
    const atrAtFirst = nearestAtrAtOrBefore(
      btc15m,
      atr15mSeries,
      firstEvent.timestamp,
    );
    const atrAtLast = nearestAtrAtOrBefore(
      btc15m,
      atr15mSeries,
      lastEvent.timestamp,
    );
    console.log(
      `  ATR(14,15m) at first event: ${fmtNum(atrAtFirst)}   at last event (extreme): ${fmtNum(atrAtLast)}   change: ${atrAtFirst !== null && atrAtLast !== null ? fmtPct(((atrAtLast - atrAtFirst) / atrAtFirst) * 100) : "N/A"}`,
    );

    // Velocity + "growing liquidation, shrinking price impact" check, event by event.
    console.log(
      `  VELOCITY (event-by-event, is liquidation growing while price movement per event shrinks?):`,
    );
    let runningExtremePrice = firstEvent.price;
    for (let e = 1; e < events.length; e++) {
      const prev = events[e - 1],
        cur = events[e];
      const gapSec = (cur.timestamp - prev.timestamp) / 1000;
      const priceMoveSincePrev = ((cur.price - prev.price) / prev.price) * 100;
      const newExtreme =
        direction === "down"
          ? cur.price < runningExtremePrice
          : cur.price > runningExtremePrice;
      if (newExtreme) runningExtremePrice = cur.price;
      console.log(
        `    event ${e}: gap=${gapSec.toFixed(1)}s  usd=${fmtUsd(cur.quoteQty)}  price=${cur.price}  moveSincePrev=${fmtPct(priceMoveSincePrev)}  ${newExtreme ? "(NEW EXTREME)" : "(no new extreme -- liquidation without further price progress)"}`,
      );
    }

    // Recovery: search FROM this episode's own given end (fixed input, not re-derived).
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
        `  RECOVERY: not confirmed within 60min of this episode's given end.\n`,
      );
      continue;
    }
    const oiAtRecovery = await nearestOiAtOrBefore(recoveryMs);
    const atrAtRecovery = nearestAtrAtOrBefore(
      btc15m,
      atr15mSeries,
      recoveryMs,
    );
    const priceAtRecovery = priceAtOrBefore(btc1m, recoveryMs);
    const priceChangeExtremeToRecovery = lastEvent.price
      ? ((priceAtRecovery - lastEvent.price) / lastEvent.price) * 100
      : null;
    console.log(
      `  RECOVERY confirmed: ${hhmmss(recoveryMs)}  price=${priceAtRecovery}  OI=${oiAtRecovery !== null ? oiAtRecovery.toFixed(2) : "N/A"}  ATR=${fmtNum(atrAtRecovery)}`,
    );
    console.log(
      `  OI delta (last-event->recovery): ${oiAtLast !== null && oiAtRecovery !== null ? (oiAtRecovery - oiAtLast >= 0 ? "+" : "") + (oiAtRecovery - oiAtLast).toFixed(2) : "N/A"}   ATR change (last-event->recovery): ${atrAtLast !== null && atrAtRecovery !== null ? fmtPct(((atrAtRecovery - atrAtLast) / atrAtLast) * 100) : "N/A"}   Price change: ${fmtPct(priceChangeExtremeToRecovery)}`,
    );

    const sign = direction === "down" ? 1 : -1;
    const forward15 = priceAtOrBefore(btc1m, recoveryMs + 15 * 60 * 1000);
    const forward60 = priceAtOrBefore(btc1m, recoveryMs + 60 * 60 * 1000);
    const fwd15pct =
      priceAtRecovery && forward15
        ? ((forward15 - priceAtRecovery) / priceAtRecovery) * 100 * sign
        : null;
    const fwd60pct =
      priceAtRecovery && forward60
        ? ((forward60 - priceAtRecovery) / priceAtRecovery) * 100 * sign
        : null;
    console.log(
      `  FORWARD from recovery: +15m=${fmtPct(fwd15pct)}  +60m=${fmtPct(fwd60pct)}\n`,
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
