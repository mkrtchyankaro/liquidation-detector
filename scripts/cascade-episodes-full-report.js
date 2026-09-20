// Sep 20 2026 (Karo), operator-requested. TEST/RESEARCH ONLY -- reads
// data, prints analysis, never touches live strategy or trading logic.
//
//   node scripts/cascade-episodes-full-report.js 3 9
//
// (arg1 = days back, default 3; arg2 = minimum distinct symbols active
// at once to call it a market-wide cascade, default 9 out of 10 --
// per the operator's own words: majority participated, BTC not
// mandatory)
//
// WHAT THIS DOES (no recovery methodology yet, by operator's explicit
// instruction -- just the raw picture):
//   1. DISCOVERY: scans liq_raw_events across all 10 tracked symbols,
//      buckets into 30s buckets, finds contiguous stretches where at
//      least MIN_DISTINCT_SYMBOLS symbols have liquidation activity
//      at the same time (gap-tolerance merged) -- each stretch is one
//      cascade episode, with its own start/end in UTC.
//   2. PER-COIN METRICS for every symbol that participated in that
//      cascade: price % change (cascade start -> cascade end),
//      OI at start/end + delta%, total liquidated USD, ATR(14, 15m)
//      at cascade start and at cascade end.
//   3. FORWARD PRICE MOVEMENT after the cascade ends: price % change
//      at +15m, +30m, +60m past cascade end, per coin -- so the
//      operator can see, unfiltered, how much (and whether) each coin
//      moved back afterward, before any recovery-quality logic is
//      layered on top.
//
// All timestamps UTC, ISO 8601, taken directly from event/kline
// timestamps -- never recomputed into a different timezone.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];

const BUCKET_SEC = 30;
const MIN_ACTIVE_RUN_BUCKETS = 4;
const GAP_TOLERANCE_BUCKETS = 20;
const EPISODE_PADDING_SEC = 2 * 60;
const ATR_PERIOD = 14;
const ATR_INTERVAL_MIN = 15;
const FORWARD_HORIZONS_MIN = [15, 30, 60];
const KLINE_FETCH_DELAY_MS = 150;

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000)
    return `${n < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000).toFixed(1)}K`;
  return `${n < 0 ? "-" : ""}$${abs.toFixed(2)}`;
}
function fmtPct(n) {
  if (n === null || n === undefined) return "N/A";
  return `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}
function fmtNum(n) {
  if (n === null || n === undefined) return "N/A";
  return typeof n === "number" ? n.toFixed(4) : String(n);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchKlinesRange(symbol, startMs, endMs, intervalMin) {
  const intervalStr = `${intervalMin}m`;
  const all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${intervalStr}&startTime=${Math.round(cursor)}&endTime=${Math.round(endMs)}&limit=1000`;
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
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      });
    const lastOpen = rows[rows.length - 1][0];
    if (rows.length < 1000) break;
    cursor = lastOpen + intervalMin * 60 * 1000;
    await sleep(KLINE_FETCH_DELAY_MS);
  }
  return all;
}

function computeAtrSeries(candles, period) {
  const atr = new Array(candles.length).fill(null);
  const trueRanges = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trueRanges.push(candles[i].high - candles[i].low);
      continue;
    }
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
    trueRanges.push(tr);
  }
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += trueRanges[j];
    atr[i] = sum / period;
  }
  return atr;
}

function nearestAtOrBefore(candles, atrSeries, targetMs) {
  let bestIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].openTimeMs <= targetMs) bestIdx = i;
    else break;
  }
  if (bestIdx === -1) return { price: null, atr: null };
  return { price: candles[bestIdx].close, atr: atrSeries[bestIdx] };
}

async function main() {
  const days = Number(process.argv[2] ?? "3");
  const minDistinctSymbols = Number(process.argv[3] ?? "9");
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(
      "Usage: node scripts/cascade-episodes-full-report.js <daysBack> <minDistinctSymbols>",
    );

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(118));
  console.log(
    `CASCADE EPISODES FULL REPORT -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}  (${days} day(s))`,
  );
  console.log(
    `Cascade definition: >= ${minDistinctSymbols}/${SYMBOLS.length} symbols with simultaneous liquidation activity.`,
  );
  console.log("=".repeat(118));

  const rawEvents = await liqCol
    .find({
      symbol: { $in: SYMBOLS },
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ symbol: 1, price: 1, quoteQty: 1, timestamp: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(`\nLoaded ${rawEvents.length} liquidation events.`);

  const eventsBySymbol = new Map(SYMBOLS.map((s) => [s, []]));
  for (const e of rawEvents)
    eventsBySymbol
      .get(e.symbol)
      ?.push({ ts: e.timestamp, price: e.price, usd: e.quoteQty ?? 0 });

  const numBuckets = Math.ceil(
    (rangeEndMs - rangeStartMs) / (BUCKET_SEC * 1000),
  );
  const bucketActive = new Map(
    SYMBOLS.map((s) => [s, new Uint8Array(numBuckets)]),
  );
  for (const symbol of SYMBOLS) {
    for (const e of eventsBySymbol.get(symbol)) {
      const idx = Math.floor((e.ts - rangeStartMs) / (BUCKET_SEC * 1000));
      if (idx >= 0 && idx < numBuckets) bucketActive.get(symbol)[idx] = 1;
    }
  }
  const distinctActive = new Uint8Array(numBuckets);
  for (let idx = 0; idx < numBuckets; idx++) {
    let count = 0;
    for (const symbol of SYMBOLS)
      if (bucketActive.get(symbol)[idx] === 1) count++;
    distinctActive[idx] = count;
  }

  const rawRuns = [];
  let runStart = null;
  let lastActiveIdx = null;
  for (let idx = 0; idx < numBuckets; idx++) {
    const active = distinctActive[idx] >= minDistinctSymbols;
    if (active) {
      if (runStart === null) runStart = idx;
      lastActiveIdx = idx;
    } else if (
      runStart !== null &&
      idx - lastActiveIdx > GAP_TOLERANCE_BUCKETS
    ) {
      rawRuns.push([runStart, lastActiveIdx]);
      runStart = null;
    }
  }
  if (runStart !== null) rawRuns.push([runStart, lastActiveIdx]);
  const runs = rawRuns.filter(([s, e]) => e - s + 1 >= MIN_ACTIVE_RUN_BUCKETS);

  console.log(
    `Discovered ${runs.length} cascade episode(s) meeting the >= ${minDistinctSymbols}-symbol threshold.\n`,
  );

  if (runs.length === 0) {
    console.log(
      "No cascades found at this threshold in this window. Try a longer range or a lower minDistinctSymbols.",
    );
    await client.close();
    return;
  }

  const atrLookbackMs = (ATR_PERIOD + 2) * ATR_INTERVAL_MIN * 60 * 1000;
  const forwardTailMs =
    Math.max(...FORWARD_HORIZONS_MIN) * 60 * 1000 +
    ATR_INTERVAL_MIN * 60 * 1000;
  console.log(
    "Fetching 15m klines per symbol (for ATR + forward price tracking)...\n",
  );
  const klinesBySymbol = new Map();
  const atrBySymbol = new Map();
  for (const symbol of SYMBOLS) {
    const candles = await fetchKlinesRange(
      symbol,
      rangeStartMs - atrLookbackMs,
      rangeEndMs + forwardTailMs,
      ATR_INTERVAL_MIN,
    );
    klinesBySymbol.set(symbol, candles);
    atrBySymbol.set(symbol, computeAtrSeries(candles, ATR_PERIOD));
    await sleep(KLINE_FETCH_DELAY_MS);
  }

  for (let epIdx = 0; epIdx < runs.length; epIdx++) {
    const [startBucket, endBucket] = runs[epIdx];
    const cascadeStartMs = Math.max(
      rangeStartMs,
      rangeStartMs +
        startBucket * BUCKET_SEC * 1000 -
        EPISODE_PADDING_SEC * 1000,
    );
    const cascadeEndMs = Math.min(
      rangeEndMs,
      rangeStartMs + endBucket * BUCKET_SEC * 1000 + EPISODE_PADDING_SEC * 1000,
    );

    const participating = SYMBOLS.filter((s) =>
      eventsBySymbol
        .get(s)
        .some((e) => e.ts >= cascadeStartMs && e.ts <= cascadeEndMs),
    );

    console.log("-".repeat(118));
    console.log(
      `CASCADE #${epIdx + 1}: ${isoUtc(cascadeStartMs)} -> ${isoUtc(cascadeEndMs)}  (${((cascadeEndMs - cascadeStartMs) / 60000).toFixed(1)}m, ${participating.length}/${SYMBOLS.length} symbols)`,
    );
    console.log("-".repeat(118));

    for (const symbol of SYMBOLS) {
      const events = eventsBySymbol
        .get(symbol)
        .filter((e) => e.ts >= cascadeStartMs && e.ts <= cascadeEndMs);
      const candles = klinesBySymbol.get(symbol);
      const atrSeries = atrBySymbol.get(symbol);

      const atStart = nearestAtOrBefore(candles, atrSeries, cascadeStartMs);
      const atEnd = nearestAtOrBefore(candles, atrSeries, cascadeEndMs);
      const priceChangePct =
        atStart.price && atEnd.price
          ? ((atEnd.price - atStart.price) / atStart.price) * 100
          : null;

      const oiStartDoc = await oiCol
        .find({ symbol, timestamp: { $lte: new Date(cascadeStartMs) } })
        .sort({ timestamp: -1 })
        .limit(1)
        .next();
      const oiEndDoc = await oiCol
        .find({ symbol, timestamp: { $lte: new Date(cascadeEndMs) } })
        .sort({ timestamp: -1 })
        .limit(1)
        .next();
      const oiStart = oiStartDoc?.openInterest ?? null;
      const oiEnd = oiEndDoc?.openInterest ?? null;
      const oiDeltaPct =
        oiStart !== null && oiEnd !== null && oiStart !== 0
          ? ((oiEnd - oiStart) / oiStart) * 100
          : null;

      const liqUsd = events.reduce((a, e) => a + e.usd, 0);

      const forward = FORWARD_HORIZONS_MIN.map((h) => {
        const target = nearestAtOrBefore(
          candles,
          atrSeries,
          cascadeEndMs + h * 60 * 1000,
        );
        const pct =
          atEnd.price && target.price
            ? ((target.price - atEnd.price) / atEnd.price) * 100
            : null;
        return { h, pct };
      });

      if (!participating.includes(symbol) && liqUsd === 0) {
        console.log(
          `  ${symbol.padEnd(10)} did not participate in this cascade`,
        );
        continue;
      }

      console.log(
        `  ${symbol.padEnd(10)} price ${fmtNum(atStart.price)} -> ${fmtNum(atEnd.price)}  (${fmtPct(priceChangePct)})   liq=${fmtUsd(liqUsd)} (${events.length} events)`,
      );
      console.log(
        `    OI: ${fmtNum(oiStart)} -> ${fmtNum(oiEnd)}  (${fmtPct(oiDeltaPct)})   ATR(14,15m): start=${fmtNum(atStart.atr)} end=${fmtNum(atEnd.atr)}`,
      );
      console.log(
        `    Forward from cascade end: ${forward.map((f) => `+${f.h}m=${fmtPct(f.pct)}`).join("   ")}`,
      );
    }
    console.log("");
  }

  console.log(`\n${"=".repeat(118)}`);
  console.log(
    `TOTAL: ${runs.length} cascade episode(s) in ${days} day(s) at >= ${minDistinctSymbols}/${SYMBOLS.length} symbol threshold.`,
  );
  console.log(
    "No recovery-quality scoring applied -- raw price/OI/liquidation/ATR data only, per operator's instruction.",
  );
  console.log("This never touches live strategy or trading logic.");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
