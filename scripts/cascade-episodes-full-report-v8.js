// Sep 20 2026 (Karo), operator-requested. TEST/RESEARCH ONLY -- reads
// data, prints analysis, never touches live strategy or trading logic.
//
//   node scripts/cascade-episodes-full-report-v8.js 10 6
//
// v8 CHANGES (operator's explicit instructions):
//   - OI showed no reliable effect across two independent test runs
//     (v6's 9-cascade run and v7's clean 3-day run) and only has
//     ~4 days of retention in oi_second_observations (confirmed via
//     verify-timestamp-integrity.js -- OI observations before ~Sep 17
//     are simply missing). OI is NOT removed from the output (still
//     shown where available, for reference), but it never gated
//     anything in this script to begin with -- the real fix here is
//     simply: default days back raised from 4 to 10, since
//     liq_raw_events itself has much longer history and nothing else
//     in this script depends on OI being present.
//   - Default quorum lowered 9 -> 6 (operator: "too few episodes" --
//     the quorum threshold, not the day range, is the main lever for
//     episode count; still overridable via arg2).
//   - CASCADE TRIGGERED BY / CASCADE END CONFIRMED BY: names the
//     actual coin(s) and exact timestamp(s) of the first and last raw
//     liquidation events in the window -- not just an abstract
//     aggregate $ number. Answers "which coin's data said the cascade
//     started/ended" literally.
//   - ANTI-PICK: mirrors PICK, but for the WORST-performing non-BTC
//     coin (went most against our thesis) in every cascade, with the
//     same OI%/ATR%/move%/liquidation WHY breakdown -- so both "why
//     did the market go our way" and "why did it go against us" are
//     answered, per cascade, by the script itself.
//   - ANTI-PICK vs OTHERS aggregate added alongside PICK vs OTHERS,
//     so the two can be compared for opposite-sign confirmation.
//   - CASCADE END is now explained in the output: prints the actual
//     market-wide peak $/30s and the 5%-of-peak threshold used to
//     detect where this specific cascade ended.
//   - Added a PICK block to every cascade: the best-performing
//     non-BTC coin by normalized +60m recovery, with its own OI%,
//     ATR expansion%, cascade move%, and liquidation-vs-P95 printed
//     directly against BOTH BTC's own numbers and the average of the
//     other coins in that same cascade -- the "why this coin" answer,
//     computed by the script.
//   - Added a cross-cascade PICK vs OTHERS aggregate at the end:
//     averages (PICK's OI%/ATR%/move% minus the field average) across
//     every cascade, to show directly whether the pick is
//     systematically different from the field on any variable.
//   - v4's exhaustion-extension was computed INDEPENDENTLY inside the
//     per-cascade loop for each quorum run. Two nearby quorum runs
//     each extended forward and ended up covering the SAME real-world
//     event, reported as two separate cascades (confirmed: a 7-day
//     run showed "CASCADE #1 17:33-18:16" and "CASCADE #2 18:01-18:16"
//     -- same BTC/ETH/... prices, same event, counted twice). Fixed:
//     all quorum runs' exhaustion-extended windows are computed FIRST,
//     then MERGED wherever they overlap or touch, before any analysis
//     -- each real event is now counted exactly once.
//   - Default days back back down to 4 (operator's explicit
//     instruction: don't reach further back than the last few days).
//   - CASCADE END is no longer a fixed silence-timeout. It's now
//     found by extending forward from the quorum run's own end using
//     MARKET-WIDE (all 10 symbols summed) $ per 30s bucket, relative
//     to THAT cascade's OWN peak aggregate intensity: end = the last
//     bucket with aggregate $ >= 5% of this cascade's own peak,
//     before a sustained 10-minute stretch stays below that. This
//     scales the cutoff to each cascade's own size instead of using
//     one fixed timer for a $10M cascade and a $50K one alike.
//   - Default days back raised to 7 (more cascades per run, per the
//     operator's explicit request to stop being limited to 3 days).
//   - FIXED a real bug: v1 used 15m candles for BOTH price lookup and
//     ATR. Any cascade shorter than one 15m candle had start and end
//     fall in the SAME candle, so both got the same close price --
//     spurious +0.0000% every time, a measurement artifact. Price
//     lookups (start/end/forward) now use 1m candles; ATR stays on
//     its own natural 15m timeframe.
//   - ADDED: each coin's own trailing-24h liquidation EVENT-SIZE
//     P90/P95 (in USD), computed from its own liq_raw_events history
//     ending right before the cascade starts -- shown next to that
//     coin's cascade data, plus the largest single event size THIS
//     cascade produced, so it's visible at a glance whether this
//     cascade's events were unusual for that coin recently or not.
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
const PERCENTILE_LOOKBACK_HOURS = 24;
const CLASSIFY_THRESHOLD_PCT = 0.1; // operator-requested reversal/continuation classification threshold on normalized +60m recovery // operator-requested: trailing 24h of this symbol's own liquidation EVENT sizes, as P90/P95 context next to each coin

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
function mean(arr) {
  const vals = arr.filter(
    (v) => v !== null && v !== undefined && Number.isFinite(v),
  );
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
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
  return {
    price: candles[bestIdx].close,
    atr: atrSeries ? atrSeries[bestIdx] : null,
  };
}

/** Sep 20 2026 (Karo), operator-requested fix -- v1 used 15m candles
 *  for BOTH price lookup and ATR. For any cascade shorter than one
 *  15m candle (several in the first run: 13.0m, 7.0m, 6.5m), start
 *  and end fell in the SAME candle, so the same close price was
 *  returned for both, producing a spurious +0.0000% every time --
 *  a measurement artifact, not a real "price didn't move". Fixed by
 *  looking up price from 1m candles (fine enough resolution for any
 *  cascade duration seen so far) while ATR stays on 15m (its own
 *  natural timeframe, matches what LOX itself uses per
 *  learnings-and-constraints.md). */
function nearestPriceAtOrBefore(candles1m, targetMs) {
  let bestIdx = -1;
  for (let i = 0; i < candles1m.length; i++) {
    if (candles1m[i].openTimeMs <= targetMs) bestIdx = i;
    else break;
  }
  return bestIdx === -1 ? null : candles1m[bestIdx].close;
}

/** Linear-interpolated percentile of a SORTED numeric array. */
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

async function main() {
  const days = Number(process.argv[2] ?? "10"); // Sep 20 2026 (Karo), operator-requested -- OI has ~4 days of history and is now treated as optional/best-effort everywhere below (never gates the analysis), so days back can safely go beyond OI's own retention window. liq_raw_events itself goes back much further; this pushes to 10 days by default -- try more if the data supports it.
  const minDistinctSymbols = Number(process.argv[3] ?? "6");
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(
      "Usage: node scripts/cascade-episodes-full-report.js <daysBack> <minDistinctSymbols>  (v2)",
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
      timestamp: {
        $gte: rangeStartMs - PERCENTILE_LOOKBACK_HOURS * 3600 * 1000,
        $lte: rangeEndMs,
      },
    })
    .project({ symbol: 1, price: 1, quoteQty: 1, timestamp: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(
    `\nLoaded ${rawEvents.length} liquidation events (includes ${PERCENTILE_LOOKBACK_HOURS}h lookback before the range start, for the P90/P95 context).`,
  );

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
  const bucketUsdAgg = new Float64Array(numBuckets); // Sep 20 2026 (Karo) -- market-wide (all-symbol) $ per bucket, for exhaustion-based cascade-end detection
  for (const symbol of SYMBOLS) {
    for (const e of eventsBySymbol.get(symbol)) {
      const idx = Math.floor((e.ts - rangeStartMs) / (BUCKET_SEC * 1000));
      if (idx >= 0 && idx < numBuckets) {
        bucketActive.get(symbol)[idx] = 1;
        bucketUsdAgg[idx] += e.usd;
      }
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
  const globalCoinCascadeRows = []; // operator-requested: cross-cascade reversal-vs-continuation comparison
  const globalPickRows = []; // operator-requested: cross-cascade PICK-vs-field comparison
  const globalAntiPickRows = []; // operator-requested: cross-cascade ANTI-PICK-vs-field comparison (went against our thesis)

  // Sep 20 2026 (Karo), operator-requested fix -- v3's cascade END was
  // just "the quorum run's last active bucket + a fixed 2min pad",
  // effectively a fixed silence-timeout, not tied to what the market
  // was actually doing. Fixed: extend forward from the quorum run's
  // own end using MARKET-WIDE (all-symbol) aggregate $/bucket,
  // relative to THAT cascade's OWN peak intensity -- end is the last
  // bucket where aggregate $ was still >= EXHAUSTION_FRACTION of the
  // cascade's own peak, before a sustained (EXHAUSTION_QUIET_BUCKETS)
  // stretch of aggregate activity staying below that. This scales to
  // each cascade's own size instead of using one fixed timeout for a
  // huge cascade and a tiny one alike.
  const EXHAUSTION_FRACTION = 0.05;
  const EXHAUSTION_QUIET_BUCKETS = GAP_TOLERANCE_BUCKETS;
  const MAX_EXTENSION_BUCKETS = 240; // cap the forward search at 2h
  function findExhaustionEndBucket(startBucket, coreEndBucket) {
    let peakUsd = 0;
    for (let i = startBucket; i <= coreEndBucket; i++)
      peakUsd = Math.max(peakUsd, bucketUsdAgg[i]);
    const threshold = peakUsd * EXHAUSTION_FRACTION;
    let lastHotIdx = coreEndBucket;
    let quietStreak = 0;
    const searchEnd = Math.min(
      numBuckets - 1,
      coreEndBucket + MAX_EXTENSION_BUCKETS,
    );
    for (let i = coreEndBucket + 1; i <= searchEnd; i++) {
      if (bucketUsdAgg[i] >= threshold && bucketUsdAgg[i] > 0) {
        lastHotIdx = i;
        quietStreak = 0;
      } else {
        quietStreak++;
        if (quietStreak >= EXHAUSTION_QUIET_BUCKETS) break;
      }
    }
    return lastHotIdx;
  }

  // Sep 20 2026 (Karo), operator-reported CRITICAL BUG FIX -- v4
  // computed the exhaustion-extended end INSIDE the per-cascade loop,
  // independently for each quorum run. Two quorum runs close together
  // (e.g. one nested inside a 3min gap of another) each extended
  // forward and ended up covering the SAME real-world time range --
  // the same liquidation event got reported as two separate
  // "cascades" (confirmed live: #1 17:33-18:16 and #2 18:01-18:16
  // were the same event). Fixed: compute every run's exhaustion end
  // FIRST, then MERGE any runs whose extended windows overlap (or are
  // back-to-back) into one cascade before any analysis runs -- so
  // each real-world event is counted exactly once.
  const extendedRuns = runs.map(([s, e]) => [s, findExhaustionEndBucket(s, e)]);
  extendedRuns.sort((a, b) => a[0] - b[0]);
  const mergedRuns = [];
  for (const [s, e] of extendedRuns) {
    if (mergedRuns.length > 0 && s <= mergedRuns[mergedRuns.length - 1][1]) {
      mergedRuns[mergedRuns.length - 1][1] = Math.max(
        mergedRuns[mergedRuns.length - 1][1],
        e,
      );
    } else {
      mergedRuns.push([s, e]);
    }
  }

  console.log(
    `Discovered ${runs.length} raw quorum run(s) -> merged into ${mergedRuns.length} distinct cascade episode(s) after de-duplicating overlapping/adjacent windows.\n`,
  );

  if (mergedRuns.length === 0) {
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
    "Fetching klines per symbol (1m for price lookups, 15m for ATR)...\n",
  );
  const priceCandlesBySymbol = new Map();
  const atrCandlesBySymbol = new Map();
  const atrBySymbol = new Map();
  for (const symbol of SYMBOLS) {
    const priceCandles = await fetchKlinesRange(
      symbol,
      rangeStartMs - 5 * 60 * 1000,
      rangeEndMs + forwardTailMs,
      1,
    );
    priceCandlesBySymbol.set(symbol, priceCandles);
    await sleep(KLINE_FETCH_DELAY_MS);
    const atrCandles = await fetchKlinesRange(
      symbol,
      rangeStartMs - atrLookbackMs,
      rangeEndMs + forwardTailMs,
      ATR_INTERVAL_MIN,
    );
    atrCandlesBySymbol.set(symbol, atrCandles);
    atrBySymbol.set(symbol, computeAtrSeries(atrCandles, ATR_PERIOD));
    await sleep(KLINE_FETCH_DELAY_MS);
  }

  for (let epIdx = 0; epIdx < mergedRuns.length; epIdx++) {
    const [startBucket, exhaustionEndBucket] = mergedRuns[epIdx];
    const cascadeStartMs = Math.max(
      rangeStartMs,
      rangeStartMs +
        startBucket * BUCKET_SEC * 1000 -
        EPISODE_PADDING_SEC * 1000,
    );
    const cascadeEndMs = Math.min(
      rangeEndMs,
      rangeStartMs +
        exhaustionEndBucket * BUCKET_SEC * 1000 +
        EPISODE_PADDING_SEC * 1000,
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

    // Operator-requested: EXPLAIN, from data, why the cascade was
    // judged to have ended where it did -- not just report a
    // timestamp. Recomputes the peak aggregate $/bucket and the 5%
    // exhaustion threshold actually used for THIS merged window.
    {
      let peakUsd = 0;
      let peakBucketMs = null;
      for (let i = startBucket; i <= exhaustionEndBucket; i++) {
        if (bucketUsdAgg[i] > peakUsd) {
          peakUsd = bucketUsdAgg[i];
          peakBucketMs = rangeStartMs + i * BUCKET_SEC * 1000;
        }
      }
      const threshold = peakUsd * EXHAUSTION_FRACTION;
      console.log(
        `  CASCADE END DETECTED: market-wide (all-symbol) peak was ${fmtUsd(peakUsd)}/30s at ${peakBucketMs !== null ? isoUtc(peakBucketMs) : "N/A"}.`,
      );
      console.log(
        `  End = last 30s bucket with aggregate $ >= ${fmtUsd(threshold)} (5% of peak), before a sustained 10-minute drop below that.`,
      );
    }

    // Operator-requested: name the ACTUAL coin(s), not an abstract
    // aggregate number, that triggered the start and confirmed the
    // end -- the first and last real liquidation events in this
    // window, by symbol and exact UTC timestamp.
    {
      const allWindowEvents = [];
      for (const symbol of SYMBOLS) {
        for (const e of eventsBySymbol.get(symbol)) {
          if (e.ts >= cascadeStartMs && e.ts <= cascadeEndMs)
            allWindowEvents.push({ symbol, ts: e.ts, usd: e.usd });
        }
      }
      allWindowEvents.sort((a, b) => a.ts - b.ts);
      const first3 = allWindowEvents.slice(0, 3);
      const last3 = allWindowEvents.slice(-3);
      console.log(
        `  CASCADE TRIGGERED BY (first event(s)):    ${first3.map((e) => `${e.symbol}@${isoUtc(e.ts).slice(11, 19)}(${fmtUsd(e.usd)})`).join("  ")}`,
      );
      console.log(
        `  CASCADE END CONFIRMED BY (last event(s)): ${last3.map((e) => `${e.symbol}@${isoUtc(e.ts).slice(11, 19)}(${fmtUsd(e.usd)})`).join("  ")}`,
      );
    }

    const records = [];
    for (const symbol of SYMBOLS) {
      const events = eventsBySymbol
        .get(symbol)
        .filter((e) => e.ts >= cascadeStartMs && e.ts <= cascadeEndMs);
      const priceCandles = priceCandlesBySymbol.get(symbol);
      const atrCandles = atrCandlesBySymbol.get(symbol);
      const atrSeries = atrBySymbol.get(symbol);

      const startPrice = nearestPriceAtOrBefore(priceCandles, cascadeStartMs);
      const endPrice = nearestPriceAtOrBefore(priceCandles, cascadeEndMs);
      const priceChangePct =
        startPrice && endPrice
          ? ((endPrice - startPrice) / startPrice) * 100
          : null;
      const atrAtStart = nearestAtOrBefore(
        atrCandles,
        atrSeries,
        cascadeStartMs,
      ).atr;
      const atrAtEnd = nearestAtOrBefore(
        atrCandles,
        atrSeries,
        cascadeEndMs,
      ).atr;
      const atrExpansionPct =
        atrAtStart !== null && atrAtEnd !== null && atrAtStart !== 0
          ? ((atrAtEnd - atrAtStart) / atrAtStart) * 100
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

      const lookbackFrom =
        cascadeStartMs - PERCENTILE_LOOKBACK_HOURS * 3600 * 1000;
      const priorEventSizes = eventsBySymbol
        .get(symbol)
        .filter((e) => e.ts >= lookbackFrom && e.ts < cascadeStartMs)
        .map((e) => e.usd)
        .sort((a, b) => a - b);
      const p90 = percentile(priorEventSizes, 90);
      const p95 = percentile(priorEventSizes, 95);

      const forwardRaw = FORWARD_HORIZONS_MIN.map((h) => {
        const targetPrice = nearestPriceAtOrBefore(
          priceCandles,
          cascadeEndMs + h * 60 * 1000,
        );
        return endPrice && targetPrice
          ? ((targetPrice - endPrice) / endPrice) * 100
          : null;
      });

      records.push({
        symbol,
        events,
        startPrice,
        endPrice,
        priceChangePct,
        atrAtStart,
        atrAtEnd,
        atrExpansionPct,
        oiStart,
        oiEnd,
        oiDeltaPct,
        liqUsd,
        p90,
        p95,
        priorEventSizes,
        forwardRaw,
      });
    }

    // Operator-requested RANKING: which coin was the best pick, in
    // PERCENTAGE terms, for the direction opposite the cascade's own
    // (BTC-led) move -- i.e. which coin recovered the most. Uses
    // BTC's OWN price direction during the cascade as the reference:
    // if BTC fell (bearish cascade), "recovery" = price going back UP
    // (raw forward% as-is is already favorable-positive); if BTC rose
    // (bullish/short-squeeze cascade), "recovery" = price going back
    // DOWN (raw forward% sign-flipped so favorable is still positive).
    // This is exactly the "-- % terms, not $ terms, not a trade
    // outcome --" framing the operator asked for.
    const btcRecord = records.find((r) => r.symbol === "BTCUSDT");
    const cascadeSign =
      btcRecord &&
      btcRecord.priceChangePct !== null &&
      btcRecord.priceChangePct < 0
        ? 1
        : -1;
    for (const r of records) {
      r.normalizedForward = r.forwardRaw.map((v) =>
        v !== null ? v * cascadeSign : null,
      );
    }
    const btcNorm60 = btcRecord ? btcRecord.normalizedForward[2] : null;
    const btcCascadeMovePct =
      btcRecord && btcRecord.priceChangePct !== null
        ? -btcRecord.priceChangePct * cascadeSign
        : null;

    // Operator-requested: classify each NON-BTC coin as REVERSAL
    // (recovered meaningfully in the favorable direction),
    // CONTINUATION (kept moving WITH the cascade, no real bounce), or
    // FLAT (neither) -- using +60m normalized recovery vs a small
    // threshold -- then record every field already computed
    // (cascade move %, OI%, ATR expansion%, liq$, P90/P95 context,
    // vs-BTC deltas) so the aggregate below can show what actually
    // distinguishes the two groups, across ALL cascades combined.
    for (const r of records) {
      if (r.symbol === "BTCUSDT") continue;
      if (r.normalizedForward[2] === null) continue;
      const classification =
        r.normalizedForward[2] > CLASSIFY_THRESHOLD_PCT
          ? "REVERSAL"
          : r.normalizedForward[2] < -CLASSIFY_THRESHOLD_PCT
            ? "CONTINUATION"
            : "FLAT";
      const cascadeConsistentMovePct =
        r.priceChangePct !== null ? -r.priceChangePct * cascadeSign : null;
      const vsBtcMovePct =
        cascadeConsistentMovePct !== null && btcCascadeMovePct !== null
          ? cascadeConsistentMovePct - btcCascadeMovePct
          : null;
      const vsBtcOiDeltaPct =
        r.oiDeltaPct !== null &&
        btcRecord?.oiDeltaPct !== null &&
        btcRecord?.oiDeltaPct !== undefined
          ? r.oiDeltaPct - btcRecord.oiDeltaPct
          : null;
      const largestEvent =
        r.events.length > 0 ? Math.max(...r.events.map((e) => e.usd)) : null;
      const largestVsP95 =
        largestEvent !== null && r.p95 !== null && r.p95 !== 0
          ? largestEvent / r.p95
          : null;
      globalCoinCascadeRows.push({
        cascadeIdx: epIdx + 1,
        symbol: r.symbol,
        classification,
        normalizedForward60: r.normalizedForward[2],
        cascadeConsistentMovePct,
        oiDeltaPct: r.oiDeltaPct,
        atrExpansionPct: r.atrExpansionPct,
        liqUsd: r.liqUsd,
        vsBtcMovePct,
        vsBtcOiDeltaPct,
        largestVsP95,
      });
    }

    const ranked = [...records].sort((a, b) => {
      const av = a.normalizedForward[2];
      const bv = b.normalizedForward[2];
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });

    console.log(
      `  BTC cascade direction: ${cascadeSign > 0 ? "DOWN (bearish flush -- recovery = price going back UP)" : "UP (bullish squeeze -- recovery = price going back DOWN)"}`,
    );
    console.log(
      `\n  RANKING by normalized +60m recovery (% terms, sign-adjusted to the cascade's own direction -- NOT a trade outcome):`,
    );
    console.log(
      `  RANK  SYMBOL      CASCADE %   OI %        ATR expand%   LIQ           +15m norm   +30m norm   +60m norm   vs BTC @60m`,
    );
    console.log("  " + "-".repeat(114));
    ranked.forEach((r, i) => {
      const vsBtc =
        r.normalizedForward[2] !== null && btcNorm60 !== null
          ? r.normalizedForward[2] - btcNorm60
          : null;
      const marker = r.symbol === "BTCUSDT" ? " <- BTC" : "";
      console.log(
        `  ${String(i + 1).padStart(3)}.  ${r.symbol.padEnd(10)} ${fmtPct(r.priceChangePct).padEnd(11)} ${fmtPct(r.oiDeltaPct).padEnd(11)} ${fmtPct(r.atrExpansionPct).padEnd(13)} ${fmtUsd(r.liqUsd).padEnd(13)} ${fmtPct(r.normalizedForward[0]).padEnd(11)} ${fmtPct(r.normalizedForward[1]).padEnd(11)} ${fmtPct(r.normalizedForward[2]).padEnd(11)} ${fmtPct(vsBtc)}${marker}`,
      );
    });

    // Operator-requested: this is the actual answer, computed and
    // printed BY THE SCRIPT, not left for narration afterward -- "if
    // we were live right now, which coin would we pick, and why,
    // backed by the variables". Picks the non-BTC coin with the best
    // normalized +60m recovery (BTC itself is the cascade trigger,
    // not a follower candidate), and explains it by comparing that
    // coin's own OI%, ATR expansion%, cascade move%, and
    // liquidation-size-vs-its-own-P95 against BOTH BTC's own values
    // AND the average of the other (non-BTC, non-pick) coins in this
    // same cascade.
    const nonBtcRecords = records.filter((r) => r.symbol !== "BTCUSDT");
    const pick = [...nonBtcRecords].sort((a, b) => {
      const av = a.normalizedForward[2];
      const bv = b.normalizedForward[2];
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    })[0];

    console.log(`\n  PICK (if live right now): ${pick ? pick.symbol : "N/A"}`);
    if (pick) {
      const others = nonBtcRecords.filter((r) => r.symbol !== pick.symbol);
      const othersAvgOi = mean(others.map((r) => r.oiDeltaPct));
      const othersAvgAtr = mean(others.map((r) => r.atrExpansionPct));
      const othersAvgMove = mean(others.map((r) => r.priceChangePct));
      const pickLargestEvent =
        pick.events.length > 0
          ? Math.max(...pick.events.map((e) => e.usd))
          : null;
      const pickLargestVsP95 =
        pickLargestEvent !== null && pick.p95 !== null && pick.p95 !== 0
          ? pickLargestEvent / pick.p95
          : null;
      console.log(
        `  Normalized +60m recovery: ${fmtPct(pick.normalizedForward[2])}  (vs BTC's own ${fmtPct(btcNorm60)})`,
      );
      console.log(
        `  WHY -- ${pick.symbol}'s own numbers vs BTC (the trigger) vs the OTHER ${others.length} coins' average this same cascade:`,
      );
      console.log(
        `    OI delta%:      ${pick.symbol}=${fmtPct(pick.oiDeltaPct).padEnd(10)}  BTC=${fmtPct(btcRecord?.oiDeltaPct).padEnd(10)}  others avg=${fmtPct(othersAvgOi)}`,
      );
      console.log(
        `    ATR expansion%: ${pick.symbol}=${fmtPct(pick.atrExpansionPct).padEnd(10)}  BTC=${fmtPct(btcRecord?.atrExpansionPct).padEnd(10)}  others avg=${fmtPct(othersAvgAtr)}`,
      );
      console.log(
        `    Cascade move%:  ${pick.symbol}=${fmtPct(pick.priceChangePct).padEnd(10)}  BTC=${fmtPct(btcRecord?.priceChangePct).padEnd(10)}  others avg=${fmtPct(othersAvgMove)}`,
      );
      console.log(
        `    Liquidation:    ${pick.symbol}=${fmtUsd(pick.liqUsd)} (${pick.events.length} events), largest event = ${pickLargestVsP95 !== null ? pickLargestVsP95.toFixed(2) + "x" : "N/A"} this coin's own trailing-24h P95`,
      );
      globalPickRows.push({
        cascadeIdx: epIdx + 1,
        symbol: pick.symbol,
        oiDeltaPct: pick.oiDeltaPct,
        atrExpansionPct: pick.atrExpansionPct,
        priceChangePct: pick.priceChangePct,
        othersAvgOi,
        othersAvgAtr,
        othersAvgMove,
        oiVsOthers:
          pick.oiDeltaPct !== null && othersAvgOi !== null
            ? pick.oiDeltaPct - othersAvgOi
            : null,
        atrVsOthers:
          pick.atrExpansionPct !== null && othersAvgAtr !== null
            ? pick.atrExpansionPct - othersAvgAtr
            : null,
        moveVsOthers:
          pick.priceChangePct !== null && othersAvgMove !== null
            ? pick.priceChangePct - othersAvgMove
            : null,
      });
    }

    // Operator-requested: the MIRROR question -- which coin went
    // AGAINST our thesis the most (worst normalized +60m among
    // non-BTC coins), and why, using the exact same comparison
    // structure as PICK above. This is what "the market went the
    // wrong way, why" looks like, computed from data.
    const antiPick = [...nonBtcRecords].sort((a, b) => {
      const av = a.normalizedForward[2];
      const bv = b.normalizedForward[2];
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    })[0];

    console.log(
      `\n  ANTI-PICK (went AGAINST our thesis the most): ${antiPick ? antiPick.symbol : "N/A"}`,
    );
    if (antiPick) {
      const others2 = nonBtcRecords.filter((r) => r.symbol !== antiPick.symbol);
      const othersAvgOi2 = mean(others2.map((r) => r.oiDeltaPct));
      const othersAvgAtr2 = mean(others2.map((r) => r.atrExpansionPct));
      const othersAvgMove2 = mean(others2.map((r) => r.priceChangePct));
      const antiLargestEvent =
        antiPick.events.length > 0
          ? Math.max(...antiPick.events.map((e) => e.usd))
          : null;
      const antiLargestVsP95 =
        antiLargestEvent !== null && antiPick.p95 !== null && antiPick.p95 !== 0
          ? antiLargestEvent / antiPick.p95
          : null;
      console.log(
        `  Normalized +60m recovery: ${fmtPct(antiPick.normalizedForward[2])}  (vs BTC's own ${fmtPct(btcNorm60)})`,
      );
      console.log(
        `  WHY -- ${antiPick.symbol}'s own numbers vs BTC (the trigger) vs the OTHER ${others2.length} coins' average this same cascade:`,
      );
      console.log(
        `    OI delta%:      ${antiPick.symbol}=${fmtPct(antiPick.oiDeltaPct).padEnd(10)}  BTC=${fmtPct(btcRecord?.oiDeltaPct).padEnd(10)}  others avg=${fmtPct(othersAvgOi2)}`,
      );
      console.log(
        `    ATR expansion%: ${antiPick.symbol}=${fmtPct(antiPick.atrExpansionPct).padEnd(10)}  BTC=${fmtPct(btcRecord?.atrExpansionPct).padEnd(10)}  others avg=${fmtPct(othersAvgAtr2)}`,
      );
      console.log(
        `    Cascade move%:  ${antiPick.symbol}=${fmtPct(antiPick.priceChangePct).padEnd(10)}  BTC=${fmtPct(btcRecord?.priceChangePct).padEnd(10)}  others avg=${fmtPct(othersAvgMove2)}`,
      );
      console.log(
        `    Liquidation:    ${antiPick.symbol}=${fmtUsd(antiPick.liqUsd)} (${antiPick.events.length} events), largest event = ${antiLargestVsP95 !== null ? antiLargestVsP95.toFixed(2) + "x" : "N/A"} this coin's own trailing-24h P95`,
      );
      globalAntiPickRows.push({
        cascadeIdx: epIdx + 1,
        symbol: antiPick.symbol,
        oiDeltaPct: antiPick.oiDeltaPct,
        atrExpansionPct: antiPick.atrExpansionPct,
        priceChangePct: antiPick.priceChangePct,
        oiVsOthers:
          antiPick.oiDeltaPct !== null && othersAvgOi2 !== null
            ? antiPick.oiDeltaPct - othersAvgOi2
            : null,
        atrVsOthers:
          antiPick.atrExpansionPct !== null && othersAvgAtr2 !== null
            ? antiPick.atrExpansionPct - othersAvgAtr2
            : null,
        moveVsOthers:
          antiPick.priceChangePct !== null && othersAvgMove2 !== null
            ? antiPick.priceChangePct - othersAvgMove2
            : null,
      });
    }

    console.log(`\n  Per-coin detail:`);
    for (const r of records) {
      if (!participating.includes(r.symbol) && r.liqUsd === 0) {
        console.log(
          `  ${r.symbol.padEnd(10)} did not participate in this cascade`,
        );
        continue;
      }
      console.log(
        `  ${r.symbol.padEnd(10)} price ${fmtNum(r.startPrice)} -> ${fmtNum(r.endPrice)}  (${fmtPct(r.priceChangePct)})   liq=${fmtUsd(r.liqUsd)} (${r.events.length} events)`,
      );
      console.log(
        `    OI: ${fmtNum(r.oiStart)} -> ${fmtNum(r.oiEnd)}  (${fmtPct(r.oiDeltaPct)})   ATR(14,15m): start=${fmtNum(r.atrAtStart)} end=${fmtNum(r.atrAtEnd)}  (${fmtPct(r.atrExpansionPct)})`,
      );
      console.log(
        `    Prior ${PERCENTILE_LOOKBACK_HOURS}h event-size P90/P95: ${fmtUsd(r.p90)} / ${fmtUsd(r.p95)}  (n=${r.priorEventSizes.length})   largest event this cascade: ${fmtUsd(r.events.length > 0 ? Math.max(...r.events.map((e) => e.usd)) : null)}`,
      );
      console.log(
        `    Forward (raw): ${FORWARD_HORIZONS_MIN.map((h, i) => `+${h}m=${fmtPct(r.forwardRaw[i])}`).join("   ")}`,
      );
    }
    console.log("");
  }

  // Operator-requested aggregate: across ALL cascades, what actually
  // distinguishes REVERSAL coins from CONTINUATION coins? Every field
  // averaged here was already computed per-coin above from real,
  // stored data (price, OI, ATR, liquidation $, P90/P95) -- this is
  // arithmetic on it, not a new fetch or a backtest.
  console.log(`\n${"=".repeat(118)}`);
  console.log(
    "AGGREGATE -- REVERSAL vs CONTINUATION vs FLAT, across all cascades (non-BTC coins only)",
  );
  console.log(
    `Classification uses +-${CLASSIFY_THRESHOLD_PCT}% on the normalized +60m recovery figure shown in each cascade's ranking table above.`,
  );
  console.log("=".repeat(118));
  function printClassGroup(label) {
    const rows = globalCoinCascadeRows.filter(
      (r) => r.classification === label,
    );
    console.log(`\n${label} (N=${rows.length}):`);
    if (rows.length === 0) {
      console.log("  (none)");
      return;
    }
    const avg = (key) => mean(rows.map((r) => r[key]));
    console.log(
      `  Avg cascade move (with the cascade, %): ${fmtPct(avg("cascadeConsistentMovePct"))}`,
    );
    console.log(`  Avg OI delta% during cascade: ${fmtPct(avg("oiDeltaPct"))}`);
    console.log(
      `  Avg ATR expansion% during cascade: ${fmtPct(avg("atrExpansionPct"))}`,
    );
    console.log(`  Avg liquidation $ during cascade: ${fmtUsd(avg("liqUsd"))}`);
    console.log(
      `  Avg move vs BTC's own move (percentage points): ${fmtPct(avg("vsBtcMovePct"))}`,
    );
    console.log(
      `  Avg OI delta vs BTC's own OI delta (percentage points): ${fmtPct(avg("vsBtcOiDeltaPct"))}`,
    );
    console.log(
      `  Avg (largest event this cascade / this coin's own trailing-24h P95): ${avg("largestVsP95") !== null ? avg("largestVsP95").toFixed(2) + "x" : "N/A"}`,
    );
  }
  printClassGroup("REVERSAL");
  printClassGroup("CONTINUATION");
  printClassGroup("FLAT");

  console.log(`\n${"=".repeat(118)}`);
  console.log(
    "READING: compare the REVERSAL vs CONTINUATION rows above line by line. If REVERSAL coins consistently show a",
  );
  console.log(
    "bigger (or smaller) cascade move%, a different OI direction, more ATR expansion, or a bigger largest-event-vs-P95",
  );
  console.log(
    "ratio than CONTINUATION coins, THAT feature is a candidate for picking which coin to trade after a cascade.",
  );
  console.log(
    "If the two groups look similar on a field, that field does not distinguish reversal from continuation here.",
  );

  // Operator-requested: does the PICK (best-performing non-BTC coin,
  // chosen the same way every single cascade above) systematically
  // differ from the other coins in the SAME cascade, on average,
  // across ALL cascades? This is the direct, aggregate answer to
  // "what made the picks good" -- computed from the same per-cascade
  // numbers already printed above, not a new fetch.
  console.log(`\n${"=".repeat(118)}`);
  console.log(
    `PICK vs OTHERS -- aggregate across all ${globalPickRows.length} cascade(s) (each cascade's best non-BTC performer vs that cascade's other coins)`,
  );
  console.log("=".repeat(118));
  console.log(
    `Avg PICK OI delta% - others avg:       ${fmtPct(mean(globalPickRows.map((r) => r.oiVsOthers)))}`,
  );
  console.log(
    `Avg PICK ATR expansion% - others avg:  ${fmtPct(mean(globalPickRows.map((r) => r.atrVsOthers)))}`,
  );
  console.log(
    `Avg PICK cascade move% - others avg:   ${fmtPct(mean(globalPickRows.map((r) => r.moveVsOthers)))}`,
  );
  console.log(
    "\nIf any of these three is consistently and meaningfully non-zero, that variable distinguishes the PICK from the",
  );
  console.log(
    "field on average, across the whole dataset -- a genuine candidate signal. If all three are near zero, the",
  );
  console.log(
    "picks are not distinguishable from the field on these variables in this dataset.",
  );

  console.log(`\n${"=".repeat(118)}`);
  console.log(
    `ANTI-PICK vs OTHERS -- aggregate across all ${globalAntiPickRows.length} cascade(s) (each cascade's WORST non-BTC performer vs that cascade's other coins)`,
  );
  console.log("=".repeat(118));
  console.log(
    `Avg ANTI-PICK OI delta% - others avg:       ${fmtPct(mean(globalAntiPickRows.map((r) => r.oiVsOthers)))}`,
  );
  console.log(
    `Avg ANTI-PICK ATR expansion% - others avg:  ${fmtPct(mean(globalAntiPickRows.map((r) => r.atrVsOthers)))}`,
  );
  console.log(
    `Avg ANTI-PICK cascade move% - others avg:   ${fmtPct(mean(globalAntiPickRows.map((r) => r.moveVsOthers)))}`,
  );
  console.log(
    "\nIf PICK and ANTI-PICK show OPPOSITE signs on the same variable (e.g. PICK's cascade move is above the field",
  );
  console.log(
    "average while ANTI-PICK's is below), that variable genuinely separates good from bad outcomes in both",
  );
  console.log(
    "directions -- the strongest kind of evidence this dataset can offer. If they point the same way or both",
  );
  console.log("look like noise, the variable is not a reliable separator.");

  console.log(`\n${"=".repeat(118)}`);
  console.log(
    `TOTAL: ${mergedRuns.length} cascade episode(s) in ${days} day(s) at >= ${minDistinctSymbols}/${SYMBOLS.length} symbol threshold.`,
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
