// P90 EPISODE-TO-MACRO-CASCADE MERGE EXPERIMENT.
//
// Step 1: discover raw dominant-side BTC episodes (isolated
//         opposite-side noise tolerated, sustained flip = new
//         episode; candle-confirmed end via 1m+3m+5m simultaneous
//         reversal).
// Step 2: filter to P90 (per dominant side, episode-total $).
// Step 3: MERGE consecutive same-side P90 episodes into one
//         macro-cascade whenever the RAW liquidation event stream
//         between them has no genuine silence gap exceeding
//         MERGE_GAP_MIN minutes (checked directly against
//         liq_raw_events, not the filtered P90 list).
// Step 4: print P90 episodes (pre-merge) and macro-cascades
//         (post-merge) side by side.
//
//   node scripts/p90-macro-cascade-merge.js <daysBack=5> <percentile=90> <mergeGapMin=10>
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

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
  const mergeGapMin = Number(process.argv[4] ?? "10");
  const EPISODE_SEARCH_CAP_MIN = 180;

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
    `P90 EPISODE-TO-MACRO-CASCADE MERGE -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)} (${days}d, P${percentileThreshold}, mergeGap=${mergeGapMin}min)`,
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

  // Step 1: raw dominant-side episodes, candle-confirmed end.
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
  console.log(`Step 1: ${rawEpisodes.length} raw dominant-side episode(s).`);

  // Step 2: P90 filter, per dominant side.
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
    `Step 2: P${percentileThreshold} per side (LONG=${fmtUsd(longP)}, SHORT=${fmtUsd(shortP)}) -> ${p90Episodes.length} P90 episode(s).\n`,
  );

  console.log("P90 EPISODES (pre-merge):");
  console.log("-".repeat(120));
  p90Episodes.forEach((e, idx) => {
    console.log(
      `  ${String(idx + 1).padStart(3)}. ${e.dominantSide.padEnd(6)} ${isoUtc(e.startMs)} -> ${isoUtc(e.endMs)}  (${((e.endMs - e.startMs) / 60000).toFixed(1)}m)  ${fmtUsd(e.totalUsd)}`,
    );
  });

  // Step 3: merge consecutive same-side P90 episodes if the RAW event
  // stream between them has no silence gap > mergeGapMin.
  const macroCascades = [];
  let macro = null;
  for (const ep of p90Episodes) {
    if (macro === null) {
      macro = {
        dominantSide: ep.dominantSide,
        episodes: [ep],
        allEvents: [...ep.events],
      };
      continue;
    }
    if (ep.dominantSide !== macro.dominantSide) {
      macroCascades.push(macro);
      macro = {
        dominantSide: ep.dominantSide,
        episodes: [ep],
        allEvents: [...ep.events],
      };
      continue;
    }
    // Check the raw event stream between macro's current end and ep's start for a silence gap.
    const macroEndMs = macro.episodes[macro.episodes.length - 1].endMs;
    const betweenEvents = events.filter(
      (e) => e.timestamp > macroEndMs && e.timestamp < ep.startMs,
    );
    let maxGapMs = ep.startMs - macroEndMs;
    let lastTs = macroEndMs;
    for (const e of betweenEvents) {
      maxGapMs = Math.max(0, e.timestamp - lastTs);
      lastTs = e.timestamp;
    }
    maxGapMs = Math.max(maxGapMs, ep.startMs - lastTs);
    // Recompute the actual max single gap across the whole between-stretch (including endpoints).
    const stretch = [
      macroEndMs,
      ...betweenEvents.map((e) => e.timestamp),
      ep.startMs,
    ];
    let realMaxGapMs = 0;
    for (let k = 1; k < stretch.length; k++)
      realMaxGapMs = Math.max(realMaxGapMs, stretch[k] - stretch[k - 1]);

    if (realMaxGapMs <= mergeGapMin * 60 * 1000) {
      macro.episodes.push(ep);
      macro.allEvents.push(...betweenEvents, ...ep.events);
    } else {
      macroCascades.push(macro);
      macro = {
        dominantSide: ep.dominantSide,
        episodes: [ep],
        allEvents: [...ep.events],
      };
    }
  }
  if (macro !== null) macroCascades.push(macro);

  console.log(
    `\nStep 3: merged into ${macroCascades.length} macro-cascade(s) (gap<=${mergeGapMin}min triggers merge).\n`,
  );
  console.log("MACRO-CASCADES (post-merge):");
  console.log("-".repeat(120));
  macroCascades.forEach((m, idx) => {
    const startMs = m.episodes[0].startMs;
    const endMs = m.episodes[m.episodes.length - 1].endMs;
    const totalUsd = m.allEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    console.log(
      `  ${String(idx + 1).padStart(3)}. ${m.dominantSide.padEnd(6)} ${isoUtc(startMs)} -> ${isoUtc(endMs)}  (${((endMs - startMs) / 60000).toFixed(1)}m, merged ${m.episodes.length} P90 episode(s))  ${fmtUsd(totalUsd)}`,
    );
  });

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    `RESULT: ${p90Episodes.length} P90 episodes -> ${macroCascades.length} macro-cascades (${p90Episodes.length - macroCascades.length} merge(s) performed).`,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
