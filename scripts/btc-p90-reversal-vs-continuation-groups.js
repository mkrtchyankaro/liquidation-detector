// GROUP SPLIT -- reuses the EXACT SAME Method-A discovery + per-side
// P90 filter + PRE60/POST60 pattern classification from
// btc-p90-episode-end-oi-3day-analysis.js, unmodified. No episodes
// merged, no new classification. Output is deliberately minimal:
// just the two groups (reversal vs continuation patterns) with ID,
// direction, start, end, duration, total liquidation USD, pattern.
// No OI values, no stats, no interpretation.
//
//   node scripts/btc-p90-reversal-vs-continuation-groups.js
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

  const events = await liqCol
    .find({
      symbol: SYMBOL,
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

  // ---- Method A discovery (unmodified) ----
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

  // ---- Pattern classification (unmodified from the same script) ----
  const oiCache = new Map();
  async function getObsWindow(endMs) {
    if (oiCache.has(endMs)) return oiCache.get(endMs);
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
    oiCache.set(endMs, obs);
    return obs;
  }

  const results = [];
  for (let idx = 0; idx < qualifying.length; idx++) {
    const ep = qualifying[idx];
    const id = `EP${idx + 1}`;
    const obs = await getObsWindow(ep.endMs);
    const ref = {};
    for (const off of [-60, 0, 60])
      ref[off] = nearestObs(ep.endMs + off * 1000, obs);
    function delta(a, b) {
      return a && b ? b.contracts - a.contracts : null;
    }
    const pre60 = delta(ref[-60], ref[0]);
    const post60 = delta(ref[0], ref[60]);
    let pattern;
    if (pre60 === null || post60 === null) pattern = "N/A";
    else if (pre60 === 0 || post60 === 0) pattern = "FLAT";
    else if (pre60 < 0 && post60 > 0) pattern = "FALL -> RISE";
    else if (pre60 > 0 && post60 < 0) pattern = "RISE -> FALL";
    else if (pre60 < 0 && post60 < 0) pattern = "FALL -> FALL";
    else pattern = "RISE -> RISE";
    results.push({ id, ep, pattern });
  }

  const groupA = results.filter(
    (r) => r.pattern === "FALL -> RISE" || r.pattern === "RISE -> FALL",
  );
  const groupB = results.filter(
    (r) => r.pattern === "FALL -> FALL" || r.pattern === "RISE -> RISE",
  );

  function printGroup(rows) {
    console.log(
      "ID    | DIRECTION | START                    | END                      | DURATION | TOTAL LIQUIDATION USD | PATTERN",
    );
    console.log("-".repeat(130));
    for (const r of rows) {
      const durationSec = (r.ep.endMs - r.ep.startMs) / 1000;
      console.log(
        `${r.id.padEnd(5)} | ${r.ep.dominantSide.padEnd(9)} | ${isoUtc(r.ep.startMs)} | ${isoUtc(r.ep.endMs)} | ${durationSec.toFixed(1)}s`.padEnd(
          10,
        ) + ` | ${fmtUsd(r.ep.totalUsd).padEnd(22)} | ${r.pattern}`,
      );
    }
  }

  console.log(`GROUP A — OI REVERSAL — N=${groupA.length}\n`);
  printGroup(groupA);

  console.log(`\nGROUP B — OI CONTINUATION — N=${groupB.length}\n`);
  printGroup(groupB);

  console.log(`\nGROUP A COUNT: ${groupA.length}`);
  console.log(`GROUP B COUNT: ${groupB.length}`);
  console.log(`TOTAL: ${groupA.length + groupB.length}`);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
