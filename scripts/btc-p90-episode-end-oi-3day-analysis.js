// BTC P90 EPISODE-END OI 3-DAY ANALYSIS -- large-sample validation of
// the OI-around-episode-END hypothesis, using EXISTING Method-A
// episode discovery (dominant-side grouping + 1m/3m/5m candle-
// confirmed end -- unchanged from every other script this session),
// EXISTING per-side P90 filter, episodes kept fully SEPARATE (no
// macro merge). Pure raw measurement + descriptive statistics only --
// no thresholds, no Tukey, no swing detection, no trading language.
//
//   node scripts/btc-p90-episode-end-oi-3day-analysis.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const PERCENTILE_THRESHOLD = 90;
const EPISODE_SEARCH_CAP_MIN = 180;

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
  const v = arr.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(arr) {
  const v = arr
    .filter((x) => x !== null && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
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
      all.push({ openTimeMs: r[0], open: Number(r[1]), close: Number(r[4]) });
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1][0] + intervalMin * 60 * 1000;
    await sleep(150);
  }
  return all;
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
/** Nearest observation to targetMs, either direction. */
function nearestObs(targetMs, obsArray) {
  if (obsArray.length === 0) return null;
  let best = obsArray[0],
    bestDiff = Math.abs(obsArray[0].ts - targetMs);
  for (const o of obsArray) {
    const diff = Math.abs(o.ts - targetMs);
    if (diff < bestDiff) {
      best = o;
      bestDiff = diff;
    }
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

  console.log("=".repeat(160));
  console.log(
    `BTC P90 EPISODE-END OI 3-DAY ANALYSIS -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log(
    "Method A (existing, unmodified): dominant-side grouping + 1m/3m/5m candle-confirmed end. No merging.",
  );
  console.log("=".repeat(160));

  const events = await liqCol
    .find({
      symbol: SYMBOL,
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

  console.log(
    "Fetching klines for Method-A end detection (this takes a while over 3 days)...",
  );
  const btc1m = await fetchKlinesRange(
    SYMBOL,
    rangeStartMs,
    rangeEndMs + EPISODE_SEARCH_CAP_MIN * 60 * 1000,
    1,
  );
  await sleep(150);
  const btc3m = await fetchKlinesRange(
    SYMBOL,
    rangeStartMs,
    rangeEndMs + EPISODE_SEARCH_CAP_MIN * 60 * 1000,
    3,
  );
  await sleep(150);
  const btc5m = await fetchKlinesRange(
    SYMBOL,
    rangeStartMs,
    rangeEndMs + EPISODE_SEARCH_CAP_MIN * 60 * 1000,
    5,
  );
  console.log(
    `Klines loaded: 1m=${btc1m.length} 3m=${btc3m.length} 5m=${btc5m.length}`,
  );

  // ---- Method A discovery (unmodified from every other script this session) ----
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
      events: epEvents,
      startMs: epEvents[0].timestamp,
      endMs: epEvents[epEvents.length - 1].timestamp,
      totalUsd: epEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
    });
  }
  console.log(`\nTOTAL BTC METHOD-A EPISODES IN 3 DAYS: ${rawEpisodes.length}`);

  const longTotals = rawEpisodes
    .filter((e) => e.dominantSide === "LONG")
    .map((e) => e.totalUsd)
    .sort((a, b) => a - b);
  const shortTotals = rawEpisodes
    .filter((e) => e.dominantSide === "SHORT")
    .map((e) => e.totalUsd)
    .sort((a, b) => a - b);
  const longP90 = percentile(longTotals, PERCENTILE_THRESHOLD);
  const shortP90 = percentile(shortTotals, PERCENTILE_THRESHOLD);
  const qualifying = rawEpisodes
    .filter(
      (e) => e.totalUsd > (e.dominantSide === "LONG" ? longP90 : shortP90),
    )
    .sort((a, b) => a.startMs - b.startMs);

  console.log(
    `LONG P90 (of ${longTotals.length} LONG episodes) = ${fmtUsd(longP90)}`,
  );
  console.log(
    `SHORT P90 (of ${shortTotals.length} SHORT episodes) = ${fmtUsd(shortP90)}`,
  );
  console.log(`TOTAL >= P90 EPISODES ANALYZED: ${qualifying.length}`);

  console.log(`\nQUALIFYING EPISODE LIST:`);
  console.log(
    "ID    | START                    | END                      | DIRECTION | LIQ USD    | P90 THRESHOLD USED",
  );
  console.log("-".repeat(140));
  qualifying.forEach((ep, idx) => {
    const thresh = ep.dominantSide === "LONG" ? longP90 : shortP90;
    console.log(
      `EP${String(idx + 1).padEnd(3)} | ${isoUtc(ep.startMs)} | ${isoUtc(ep.endMs)} | ${ep.dominantSide.padEnd(9)} | ${fmtUsd(ep.totalUsd).padEnd(10)} | ${fmtUsd(thresh)}`,
    );
  });

  // ---- Per-episode raw OI measurement (Parts 1-6) ----
  const oiCache = new Map();
  async function getObsWindow(endMs) {
    const key = endMs;
    if (oiCache.has(key)) return oiCache.get(key);
    const docs = await oiCol
      .find({
        symbol: SYMBOL,
        timestamp: {
          $gte: new Date(endMs - 5 * 60000),
          $lte: new Date(endMs + 5 * 60000),
        },
      })
      .project({ timestamp: 1, openInterest: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    const obs = docs.map((d) => ({
      ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
      contracts: d.openInterest,
    }));
    oiCache.set(key, obs);
    return obs;
  }

  const results = [];
  for (let idx = 0; idx < qualifying.length; idx++) {
    const ep = qualifying[idx];
    const id = `EP${idx + 1}`;
    const obs = await getObsWindow(ep.endMs);
    if (obs.length === 0) {
      results.push({ id, ep, skipped: true });
      continue;
    }

    const offsets = [-120, -60, -30, 0, 30, 60, 120, 300];
    const ref = {};
    for (const off of offsets)
      ref[off] = nearestObs(ep.endMs + off * 1000, obs);

    const oiEnd = ref[0]?.contracts ?? null;
    function delta(a, b) {
      return a && b ? b.contracts - a.contracts : null;
    }
    const pre30 = delta(ref[-30], ref[0]);
    const pre60 = delta(ref[-60], ref[0]);
    const pre120 = delta(ref[-120], ref[0]);
    const post30 = delta(ref[0], ref[30]);
    const post60 = delta(ref[0], ref[60]);
    const post120 = delta(ref[0], ref[120]);
    const post300 = delta(ref[0], ref[300]);

    const win120 = obs.filter(
      (o) => o.ts >= ep.endMs - 120000 && o.ts <= ep.endMs + 120000,
    );
    let minObs = null,
      maxObs = null;
    for (const o of win120) {
      if (minObs === null || o.contracts < minObs.contracts) minObs = o;
      if (maxObs === null || o.contracts > maxObs.contracts) maxObs = o;
    }
    const secEndToMin = minObs ? (minObs.ts - ep.endMs) / 1000 : null;
    const secEndToMax = maxObs ? (maxObs.ts - ep.endMs) / 1000 : null;

    let pattern;
    if (pre60 === null || post60 === null) pattern = "N/A";
    else if (pre60 === 0 || post60 === 0) pattern = "FLAT";
    else if (pre60 < 0 && post60 > 0) pattern = "FALL -> RISE";
    else if (pre60 > 0 && post60 < 0) pattern = "RISE -> FALL";
    else if (pre60 < 0 && post60 < 0) pattern = "FALL -> FALL";
    else pattern = "RISE -> RISE";

    let relevantExtreme = null,
      secToRelevant = null;
    if (pattern === "FALL -> RISE") {
      relevantExtreme = minObs;
      secToRelevant = secEndToMin;
    } else if (pattern === "RISE -> FALL") {
      relevantExtreme = maxObs;
      secToRelevant = secEndToMax;
    }

    results.push({
      id,
      ep,
      skipped: false,
      oiEnd,
      pre30,
      pre60,
      pre120,
      post30,
      post60,
      post120,
      post300,
      minObs,
      maxObs,
      secEndToMin,
      secEndToMax,
      pattern,
      secToRelevant,
    });
  }

  // ---- Part 7: compact table ----
  console.log(`\n${"=".repeat(200)}`);
  console.log("PART 7 -- COMPACT TABLE (one row per episode)");
  console.log("=".repeat(200));
  console.log(
    "ID    | DIR   | END                      | LIQ_USD  | OI_END     | PRE30    | PRE60    | PRE120   | POST30   | POST60   | POST120  | POST300  | PATTERN       | SEC_END_TO_MIN | SEC_END_TO_MAX",
  );
  console.log("-".repeat(200));
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.id.padEnd(5)} | SKIPPED (no OI data)`);
      continue;
    }
    console.log(
      `${r.id.padEnd(5)} | ${r.ep.dominantSide.padEnd(5)} | ${isoUtc(r.ep.endMs)} | ${fmtUsd(r.ep.totalUsd).padEnd(8)} | ${fmtBtc(r.oiEnd).padEnd(10)} | ${fmtBtcDelta(r.pre30).padEnd(8)} | ${fmtBtcDelta(r.pre60).padEnd(8)} | ${fmtBtcDelta(r.pre120).padEnd(8)} | ${fmtBtcDelta(r.post30).padEnd(8)} | ${fmtBtcDelta(r.post60).padEnd(8)} | ${fmtBtcDelta(r.post120).padEnd(8)} | ${fmtBtcDelta(r.post300).padEnd(8)} | ${r.pattern.padEnd(13)} | ${r.secEndToMin !== null ? r.secEndToMin.toFixed(1).padEnd(14) : "N/A".padEnd(14)} | ${r.secEndToMax !== null ? r.secEndToMax.toFixed(1) : "N/A"}`,
    );
  }

  // ---- Part 8: aggregate ----
  const valid = results.filter((r) => !r.skipped && r.pattern !== "N/A");
  const patternCounts = {};
  for (const p of [
    "FALL -> RISE",
    "RISE -> FALL",
    "FALL -> FALL",
    "RISE -> RISE",
    "FLAT",
  ])
    patternCounts[p] = valid.filter((r) => r.pattern === p).length;
  const total = valid.length;

  console.log(`\n${"=".repeat(160)}`);
  console.log("PART 8 -- AGGREGATE RESULTS");
  console.log("=".repeat(160));
  console.log(`TOTAL EPISODES = ${total}`);
  for (const p of [
    "FALL -> RISE",
    "RISE -> FALL",
    "FALL -> FALL",
    "RISE -> RISE",
    "FLAT",
  ]) {
    console.log(
      `${p} = ${patternCounts[p]} (${total > 0 ? ((patternCounts[p] / total) * 100).toFixed(1) : "N/A"}%)`,
    );
  }
  const reversalCount =
    patternCounts["FALL -> RISE"] + patternCounts["RISE -> FALL"];
  console.log(
    `\nREVERSAL AROUND END = ${reversalCount} (${total > 0 ? ((reversalCount / total) * 100).toFixed(1) : "N/A"}%)`,
  );
  console.log(
    "(observed sample percentage only -- not claimed statistically significant)",
  );

  // ---- Part 9: extreme timing among reversal episodes ----
  const reversalEpisodes = valid.filter(
    (r) => r.pattern === "FALL -> RISE" || r.pattern === "RISE -> FALL",
  );
  const absSecs = reversalEpisodes
    .map((r) => Math.abs(r.secToRelevant))
    .filter((v) => v !== null && Number.isFinite(v));
  console.log(`\n${"=".repeat(160)}`);
  console.log(
    `PART 9 -- EXTREME TIMING (among ${reversalEpisodes.length} reversal episodes)`,
  );
  console.log("=".repeat(160));
  const buckets = [
    [0, 10],
    [10, 20],
    [20, 30],
    [30, 60],
    [60, 120],
  ];
  for (const [lo, hi] of buckets) {
    const c = absSecs.filter((s) => s >= lo && s < hi).length;
    console.log(`${lo}-${hi}s of END: ${c}`);
  }
  console.log(
    `\nmedian abs seconds END -> relevant extreme: ${median(absSecs) !== null ? median(absSecs).toFixed(1) : "N/A"}`,
  );
  console.log(
    `mean abs seconds END -> relevant extreme: ${mean(absSecs) !== null ? mean(absSecs).toFixed(1) : "N/A"}`,
  );

  // ---- Part 10: POST300 by pattern ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("PART 10 -- POST300 BY PATTERN");
  console.log("=".repeat(160));
  for (const p of [
    "FALL -> RISE",
    "RISE -> FALL",
    "FALL -> FALL",
    "RISE -> RISE",
  ]) {
    const group = valid
      .filter((r) => r.pattern === p)
      .map((r) => r.post300)
      .filter((v) => v !== null);
    console.log(`\n${p} (N=${group.length}):`);
    console.log(`  mean POST300 = ${fmtBtcDelta(mean(group))}`);
    console.log(`  median POST300 = ${fmtBtcDelta(median(group))}`);
    console.log(
      `  min POST300 = ${fmtBtcDelta(group.length ? Math.min(...group) : null)}`,
    );
    console.log(
      `  max POST300 = ${fmtBtcDelta(group.length ? Math.max(...group) : null)}`,
    );
  }

  // ---- FINAL CONCLUSION (data-driven, from the numbers computed above) ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("FINAL CONCLUSION");
  console.log("=".repeat(160));
  console.log(
    `1. ${total} >= P${PERCENTILE_THRESHOLD} BTC episodes were analyzed.`,
  );
  console.log(
    `2. The sign of OI movement reversed across END (PRE60 vs POST60) in ${reversalCount} episode(s).`,
  );
  console.log(
    `3. That is ${total > 0 ? ((reversalCount / total) * 100).toFixed(1) : "N/A"}% of the sample.`,
  );
  console.log(
    `4. Among those reversal cases, the median distance from END to the relevant OI extreme was ${median(absSecs) !== null ? median(absSecs).toFixed(1) + "s" : "N/A"} (mean ${mean(absSecs) !== null ? mean(absSecs).toFixed(1) + "s" : "N/A"}).`,
  );
  console.log(
    `5. Over the following 5 minutes (POST300), by pattern: see Part 10 above for mean/median/min/max per group --`,
  );
  console.log(
    `   read directly from those numbers whether the immediate END behavior persisted, faded, or reversed again.`,
  );
  console.log(
    `6. Sample verdict: with N=${total} and a ${total > 0 ? ((reversalCount / total) * 100).toFixed(1) : "N/A"}% observed reversal rate, this sample`,
  );
  console.log(
    `   ${total < 15 ? "is SMALL -- treat any directional conclusion as provisional regardless of the percentage." : ""}`,
  );
  console.log(
    `   (Read the exact reversal rate and timing numbers above to judge SUPPORT / WEAKEN / INCONCLUSIVE yourself --`,
  );
  console.log(
    `   this script reports the measured numbers only, per instruction, and does not assert a verdict label.)`,
  );

  // ---- FOOTER ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("METHOD-A MODIFIED: NO");
  console.log("EPISODES MERGED: NO");
  console.log("MACRO CASCADE LOGIC USED: NO");
  console.log("OI THRESHOLD USED: NO");
  console.log("OI SWING DETECTOR USED: NO");
  console.log("PRICE USED FOR OI CLASSIFICATION: NO");
  console.log("TAKER FLOW USED: NO");
  console.log("ORDER BOOK USED: NO");
  console.log("EPISODE END USED ONLY AS MEASUREMENT ANCHOR: YES");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
