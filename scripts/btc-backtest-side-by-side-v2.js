// Sep 20 2026 (Karo), operator-requested. Runs BOTH cascade-end
// methods on the SAME window and prints them side by side:
//   A) PURE-CANDLE: triple-timeframe (1m+3m+5m) simultaneous reversal
//      = END, no further checks.
//   B) EXTREME-BREAK-CONFIRMED: same trigger, but treated as
//      END_CANDIDATE -- confirmed only if price does NOT later
//      re-break the extreme (60min lookahead) AND 15m macro
//      structure agrees.
// Prints each method's episode list, then a diff: which episodes
// match, which got merged/extended by method B's pullback-filtering.
//
//   node scripts/btc-backtest-side-by-side.js 3 90
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

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
function extremeValue(candle, direction) {
  return direction === "down" ? candle.low : candle.high;
}
function isNewExtreme(candle, currentExtreme, direction) {
  return direction === "down"
    ? candle.low < currentExtreme
    : candle.high > currentExtreme;
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
function macroStructureSupportsEnd(
  candidateMs,
  lookaheadMs,
  direction,
  btc15m,
) {
  const priorCandles = btc15m.filter((c) => c.openTimeMs < candidateMs);
  if (priorCandles.length < 2) return true;
  let swingExtreme = direction === "down" ? Infinity : -Infinity;
  for (const c of priorCandles.slice(-8)) {
    const v = extremeValue(c, direction);
    swingExtreme =
      direction === "down"
        ? Math.min(swingExtreme, v)
        : Math.max(swingExtreme, v);
  }
  const forwardCandles = btc15m.filter(
    (c) =>
      c.openTimeMs >= candidateMs && c.openTimeMs <= candidateMs + lookaheadMs,
  );
  for (const c of forwardCandles) {
    if (isNewExtreme(c, swingExtreme, direction)) return false;
  }
  return true;
}

function buildPureCandleEpisodes(events, btc1m, btc3m, btc5m, maxSearchMs) {
  const episodes = [];
  let i = 0;
  while (i < events.length) {
    const startMs = events[i].timestamp;
    const direction = events[i].victim === "LONG" ? "down" : "up";
    let endMs = findNextEndCandidate(
      startMs,
      maxSearchMs,
      direction,
      btc1m,
      btc3m,
      btc5m,
    );
    if (endMs === null) endMs = startMs + maxSearchMs;
    const epEvents = [];
    while (i < events.length && events[i].timestamp <= endMs) {
      epEvents.push(events[i]);
      i++;
    }
    episodes.push({
      dominantSide: epEvents[0]?.victim ?? events[i - 1]?.victim ?? "LONG",
      startMs,
      endMs,
      totalUsd: epEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
    });
  }
  return episodes;
}

function buildConfirmedEpisodes(
  events,
  btc1m,
  btc3m,
  btc5m,
  btc15m,
  lookaheadMin,
  maxSearchMin,
) {
  const episodes = [];
  let i = 0;
  while (i < events.length) {
    const startMs = events[i].timestamp;
    const direction = events[i].victim === "LONG" ? "down" : "up";
    const startCandle1m = candleCovering(btc1m, startMs, 60 * 1000);
    let extremeSoFar = startCandle1m
      ? extremeValue(startCandle1m, direction)
      : null;
    let searchFrom = startMs;
    let confirmedEndMs = null;
    let pullbacks = 0;
    while (confirmedEndMs === null) {
      const candidateMs = findNextEndCandidate(
        searchFrom,
        maxSearchMin * 60 * 1000,
        direction,
        btc1m,
        btc3m,
        btc5m,
      );
      if (candidateMs === null) {
        confirmedEndMs = searchFrom + maxSearchMin * 60 * 1000;
        break;
      }
      const lookaheadEndMs = candidateMs + lookaheadMin * 60 * 1000;
      const forwardCandles = btc1m.filter(
        (c) => c.openTimeMs >= candidateMs && c.openTimeMs <= lookaheadEndMs,
      );
      let brokeExtreme = false,
        newExtremeMs = null,
        newExtremeVal = extremeSoFar;
      for (const c of forwardCandles) {
        if (extremeSoFar !== null && isNewExtreme(c, extremeSoFar, direction)) {
          brokeExtreme = true;
          newExtremeVal = extremeValue(c, direction);
          newExtremeMs = c.openTimeMs;
          break;
        }
      }
      if (brokeExtreme) {
        pullbacks++;
        extremeSoFar = newExtremeVal;
        searchFrom = newExtremeMs + 60 * 1000;
        continue;
      }
      const macroOk = macroStructureSupportsEnd(
        candidateMs,
        lookaheadMin * 60 * 1000,
        direction,
        btc15m,
      );
      if (macroOk) confirmedEndMs = candidateMs;
      else searchFrom = lookaheadEndMs + 60 * 1000;
    }
    const epEvents = [];
    while (i < events.length && events[i].timestamp <= confirmedEndMs) {
      epEvents.push(events[i]);
      i++;
    }
    episodes.push({
      dominantSide: epEvents[0]?.victim ?? "LONG",
      startMs,
      endMs: confirmedEndMs,
      totalUsd: epEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      pullbacks,
    });
  }
  return episodes;
}

async function main() {
  const days = Number(process.argv[2] ?? "3");
  const percentileThreshold = Number(process.argv[3] ?? "90");
  const LOOKAHEAD_MIN = 60,
    MAX_SEARCH_MIN = 180;

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(120));
  console.log(
    `BTC SIDE-BY-SIDE -- PURE-CANDLE vs EXTREME-BREAK-CONFIRMED -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(120));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(`\nLoaded ${events.length} BTCUSDT liquidation events.`);
  if (events.length === 0) {
    await client.close();
    return;
  }

  const tail = (LOOKAHEAD_MIN + MAX_SEARCH_MIN) * 60 * 1000;
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
  const btc15m = await fetchKlinesRange(
    "BTCUSDT",
    rangeStartMs - 2 * 3600 * 1000,
    rangeEndMs + tail,
    15,
  );

  console.log("\nBuilding PURE-CANDLE episodes...");
  const pureEpisodes = buildPureCandleEpisodes(
    events,
    btc1m,
    btc3m,
    btc5m,
    MAX_SEARCH_MIN * 60 * 1000,
  );
  console.log("Building EXTREME-BREAK-CONFIRMED episodes...");
  const confirmedEpisodes = buildConfirmedEpisodes(
    events,
    btc1m,
    btc3m,
    btc5m,
    btc15m,
    LOOKAHEAD_MIN,
    MAX_SEARCH_MIN,
  );

  // Sep 20 2026 (Karo), operator-reported REGRESSION FIX -- this
  // script had reverted to a SINGLE, combined P90 across LONG and
  // SHORT episodes mixed together (the exact bug fixed earlier this
  // session in btc-episodes-by-dominant-side-v2.js, then
  // accidentally dropped when these newer candle-based scripts were
  // written). If SHORT episodes in this window run bigger than LONG
  // ones on average, a combined bar is dominated by SHORT and no LONG
  // episode can clear it, even a large one by LONG's own standards.
  // Fixed: separate P90 per side, for BOTH methods.
  function sideSpecificBig(episodes, threshold) {
    const longTotals = episodes
      .filter((e) => e.dominantSide === "LONG")
      .map((e) => e.totalUsd)
      .sort((a, b) => a - b);
    const shortTotals = episodes
      .filter((e) => e.dominantSide === "SHORT")
      .map((e) => e.totalUsd)
      .sort((a, b) => a - b);
    const longP = percentile(longTotals, threshold);
    const shortP = percentile(shortTotals, threshold);
    const big = episodes.filter(
      (e) => e.totalUsd > (e.dominantSide === "LONG" ? longP : shortP),
    );
    return { big, longP, shortP };
  }
  const pureResult = sideSpecificBig(pureEpisodes, percentileThreshold);
  const confirmedResult = sideSpecificBig(
    confirmedEpisodes,
    percentileThreshold,
  );
  const pureBig = pureResult.big;
  const confirmedBig = confirmedResult.big;
  console.log(
    `\nMethod A per-side P${percentileThreshold}: LONG=${fmtUsd(pureResult.longP)}  SHORT=${fmtUsd(pureResult.shortP)}`,
  );
  console.log(
    `Method B per-side P${percentileThreshold}: LONG=${fmtUsd(confirmedResult.longP)}  SHORT=${fmtUsd(confirmedResult.shortP)}`,
  );

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    `METHOD A -- PURE-CANDLE: ${pureEpisodes.length} total episodes, ${pureBig.length} big (per-side P${percentileThreshold}, see above)`,
  );
  console.log("=".repeat(120));
  pureBig.forEach((e, idx) =>
    console.log(
      `  ${String(idx + 1).padStart(3)}. ${e.dominantSide.padEnd(6)} ${isoUtc(e.startMs)} -> ${isoUtc(e.endMs)}  (${((e.endMs - e.startMs) / 60000).toFixed(1)}m)  ${fmtUsd(e.totalUsd)}`,
    ),
  );

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    `METHOD B -- EXTREME-BREAK-CONFIRMED: ${confirmedEpisodes.length} total episodes, ${confirmedBig.length} big (per-side P${percentileThreshold}, see above)`,
  );
  console.log("=".repeat(120));
  confirmedBig.forEach((e, idx) =>
    console.log(
      `  ${String(idx + 1).padStart(3)}. ${e.dominantSide.padEnd(6)} ${isoUtc(e.startMs)} -> ${isoUtc(e.endMs)}  (${((e.endMs - e.startMs) / 60000).toFixed(1)}m)  pullbacks=${e.pullbacks}  ${fmtUsd(e.totalUsd)}`,
    ),
  );

  console.log(`\n${"=".repeat(120)}`);
  console.log("SUMMARY:");
  console.log(
    `  Method A (pure-candle):            ${pureEpisodes.length} episodes total, ${pureBig.length} big`,
  );
  console.log(
    `  Method B (extreme-break-confirmed): ${confirmedEpisodes.length} episodes total, ${confirmedBig.length} big`,
  );
  const totalPullbacks = confirmedEpisodes.reduce((a, e) => a + e.pullbacks, 0);
  const episodesWithPullbacks = confirmedEpisodes.filter(
    (e) => e.pullbacks > 0,
  ).length;
  console.log(
    `  Total pullbacks filtered by Method B: ${totalPullbacks}, across ${episodesWithPullbacks}/${confirmedEpisodes.length} episodes.`,
  );
  if (totalPullbacks === 0) {
    console.log(
      "  -> Method B never differed from Method A in this window. The extra complexity added NO value here.",
    );
  } else {
    console.log(
      "  -> Method B's pullback-filtering was ACTIVE and changed episode boundaries. Compare episode counts/durations above.",
    );
  }
  console.log("This never touches live strategy or trading logic.");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
