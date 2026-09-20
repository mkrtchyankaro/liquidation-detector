// Sep 20 2026 (Karo), operator-requested. TEST/RESEARCH ONLY -- reads
// data, prints analysis, never touches live strategy or trading logic.
//
//   node scripts/discover-and-analyze-cascades-v2.js 3
//
// v2 CHANGE (operator-reported): raw price-change % was being
// averaged across episodes regardless of direction, which can cancel
// out a real same-direction-continuation effect when bearish and
// bullish cascades are mixed together. Returns are now sign-
// normalized per symbol-within-episode (continuationSign()) so a
// positive value always means "price continued in the same direction
// as that symbol's own dominant liquidation side", regardless of
// whether that was a flush-down or a squeeze-up.
//
// (argument = days back from now; defaults to 3)
//
// Self-contained (no project imports -- only `mongodb` + Node's
// native `fetch`).
//
// WHAT THIS DOES:
//   1. DISCOVERY: scans the full N-day range, buckets liq_raw_events
//      into 30s buckets across ALL symbols, and finds contiguous
//      stretches where >= MIN_DISTINCT_SYMBOLS symbols are
//      simultaneously active (with a gap-tolerance merge) -- each
//      surviving stretch (padded) becomes a candidate episode window.
//      This replaces manually picking dates.
//   2. PER-EPISODE ANALYSIS: for each candidate window, runs the same
//      per-symbol onset detection + CASCADE_QUORUM confirmation logic
//      as synchronized-stress-analysis-v3.js. Windows that never reach
//      quorum are skipped (not a real multi-coin cascade).
//   3. AGGREGATION: every onset across every confirmed episode is
//      bucketed by its LAG vs that episode's own cascade-confirmed
//      moment (leader / near-confirm / early-follower / late-follower)
//      and its forward return (+1m/+5m/+15m) is recorded. The final
//      table averages forward return per lag-bucket ACROSS ALL
//      episodes -- this is what actually tests whether the
//      "middle-zone timing beats extremes" pattern seen in the first
//      two manually-picked episodes holds up, or was a coincidence.
//
// NOTE: control-random-sampling (added in v3) is DELIBERATELY omitted
// here to keep the total Binance API call volume reasonable across
// potentially many episodes. Add it back for a specific episode found
// here via synchronized-stress-analysis-v3.js itself.
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
const TRAILING_SEC = 60;
const TRAILING_BUCKETS = Math.round(TRAILING_SEC / BUCKET_SEC);
const ONSET_MULTIPLE = 3;
const MIN_ONSET_USD = 500;
const CASCADE_QUORUM = 6;
const FORWARD_HORIZONS_SEC = [60, 300, 900];
const KLINE_FETCH_DELAY_MS = 120;

const MIN_DISTINCT_SYMBOLS = 3;
const MIN_ACTIVE_RUN_BUCKETS = 4;
const GAP_TOLERANCE_BUCKETS = 20;
const EPISODE_PADDING_SEC = 5 * 60;

const LAG_CATEGORIES = [
  { label: "leader (< -5m)", test: (s) => s < -300 },
  { label: "near-confirm (-5m..+5m)", test: (s) => s >= -300 && s <= 300 },
  { label: "early-follower (+5m..+20m)", test: (s) => s > 300 && s <= 1200 },
  { label: "late-follower (> +20m)", test: (s) => s > 1200 },
];

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
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
}

function fmtTime(ms) {
  if (ms === null || ms === undefined) return "N/A";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function fmtDuration(sec) {
  const sign = sec < 0 ? "-" : "+";
  const abs = Math.abs(sec);
  if (abs < 90) return `${sign}${abs.toFixed(0)}s`;
  return `${sign}${(abs / 60).toFixed(1)}m`;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(
    arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sep 20 2026 (Karo), operator-requested CRITICAL FIX -- sign
 *  normalization. Averaging RAW price-change % across episodes mixes
 *  bearish (LONG-victim-dominant) and bullish (SHORT-victim-dominant)
 *  cascades, which can cancel out a real same-direction-continuation
 *  effect (a -0.3% bearish continuation and a +0.3% bullish one
 *  average to ~0%, even if BOTH are genuine momentum). This computes,
 *  for THIS symbol within THIS episode's own window, which victim
 *  side dominates ($ liquidated), and returns the sign that converts
 *  a raw return into a "continuation-positive" one: LONG-victim-
 *  dominant (a downward flush) -> -1 (price continuing DOWN is
 *  "positive" continuation); SHORT-victim-dominant (a squeeze up) ->
 *  +1 (price continuing UP is "positive"). Ties/no data default to +1
 *  (no flip) since there's nothing to normalize against. */
function continuationSign(symbol, winStartMs, winEndMs, eventsBySymbol) {
  const events = eventsBySymbol
    .get(symbol)
    .filter((e) => e.ts >= winStartMs && e.ts <= winEndMs);
  let longUsd = 0;
  let shortUsd = 0;
  for (const e of events) {
    if (e.victim === "LONG") longUsd += e.usd;
    else if (e.victim === "SHORT") shortUsd += e.usd;
  }
  if (longUsd === shortUsd) return 1;
  return longUsd > shortUsd ? -1 : 1;
}

async function nearestKlineClose(symbol, targetMs) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&endTime=${Math.round(targetMs)}&limit=2`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status === 418) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return Number(rows[rows.length - 1][4]);
  }
  return null;
}

async function main() {
  const days = Number(process.argv[2] ?? "3");
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(
      "Usage: node scripts/discover-and-analyze-cascades.js <daysBack>",
    );

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set in environment/.env");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(112));
  console.log(
    `CASCADE DISCOVERY -- scanning ${fmtTime(rangeStartMs)} to ${fmtTime(rangeEndMs)} (${days} day(s))`,
  );
  console.log("=".repeat(112));

  const rawEvents = await liqCol
    .find({
      symbol: { $in: SYMBOLS },
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ symbol: 1, price: 1, quoteQty: 1, timestamp: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(
    `Loaded ${rawEvents.length} liquidation events across ${SYMBOLS.length} symbols.\n`,
  );

  const eventsBySymbol = new Map(SYMBOLS.map((s) => [s, []]));
  for (const e of rawEvents)
    eventsBySymbol
      .get(e.symbol)
      ?.push({
        ts: e.timestamp,
        price: e.price,
        usd: e.quoteQty ?? 0,
        victim: e.victim,
      });

  const numBuckets = Math.ceil(
    (rangeEndMs - rangeStartMs) / (BUCKET_SEC * 1000),
  );
  const bucketUsd = new Map(
    SYMBOLS.map((s) => [s, new Float64Array(numBuckets)]),
  );
  for (const symbol of SYMBOLS) {
    for (const e of eventsBySymbol.get(symbol)) {
      const idx = Math.floor((e.ts - rangeStartMs) / (BUCKET_SEC * 1000));
      if (idx >= 0 && idx < numBuckets) bucketUsd.get(symbol)[idx] += e.usd;
    }
  }

  const distinctActive = new Uint8Array(numBuckets);
  for (let idx = 0; idx < numBuckets; idx++) {
    let count = 0;
    for (const symbol of SYMBOLS) if (bucketUsd.get(symbol)[idx] > 0) count++;
    distinctActive[idx] = count;
  }

  const rawRuns = [];
  let runStart = null;
  let lastActiveIdx = null;
  for (let idx = 0; idx < numBuckets; idx++) {
    const active = distinctActive[idx] >= MIN_DISTINCT_SYMBOLS;
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
    `Discovered ${runs.length} candidate episode window(s) (>= ${MIN_DISTINCT_SYMBOLS} symbols active, >= ${(MIN_ACTIVE_RUN_BUCKETS * BUCKET_SEC) / 60}min, gap-merged within ${(GAP_TOLERANCE_BUCKETS * BUCKET_SEC) / 60}min).\n`,
  );

  function trailingAt(symbol, idx) {
    const arr = bucketUsd.get(symbol);
    let sum = 0;
    for (let i = Math.max(0, idx - TRAILING_BUCKETS + 1); i <= idx; i++)
      sum += arr[i];
    return sum;
  }

  const aggregate = [];
  let confirmedEpisodeCount = 0;

  for (let runIdx = 0; runIdx < runs.length; runIdx++) {
    const [startBucket, endBucket] = runs[runIdx];
    const winStartMs = Math.max(
      rangeStartMs,
      rangeStartMs +
        startBucket * BUCKET_SEC * 1000 -
        EPISODE_PADDING_SEC * 1000,
    );
    const winEndMs = Math.min(
      rangeEndMs,
      rangeStartMs + endBucket * BUCKET_SEC * 1000 + EPISODE_PADDING_SEC * 1000,
    );
    const winStartIdx = Math.floor(
      (winStartMs - rangeStartMs) / (BUCKET_SEC * 1000),
    );
    const winEndIdx = Math.min(
      numBuckets - 1,
      Math.floor((winEndMs - rangeStartMs) / (BUCKET_SEC * 1000)),
    );

    const onsets = [];
    for (const symbol of SYMBOLS) {
      const nonZeroHistory = [];
      for (let idx = winStartIdx; idx <= winEndIdx; idx++) {
        const trailing = trailingAt(symbol, idx);
        const baseline = nonZeroHistory.length > 0 ? median(nonZeroHistory) : 0;
        const threshold = Math.max(MIN_ONSET_USD, ONSET_MULTIPLE * baseline);
        if (trailing >= threshold && trailing > 0) {
          const onsetMs = rangeStartMs + idx * BUCKET_SEC * 1000;
          const priorEvents = eventsBySymbol
            .get(symbol)
            .filter(
              (e) => e.ts <= onsetMs + BUCKET_SEC * 1000 && e.ts >= winStartMs,
            );
          const anchorPrice =
            priorEvents.length > 0
              ? priorEvents[priorEvents.length - 1].price
              : null;
          onsets.push({ symbol, onsetMs, anchorPrice });
          break;
        }
        if (trailing > 0) nonZeroHistory.push(trailing);
      }
    }
    onsets.sort((a, b) => a.onsetMs - b.onsetMs);

    if (onsets.length < CASCADE_QUORUM) continue;
    confirmedEpisodeCount++;
    const cascadeConfirmedAt = onsets[CASCADE_QUORUM - 1].onsetMs;

    console.log("-".repeat(112));
    console.log(
      `EPISODE #${confirmedEpisodeCount}: window ${fmtTime(winStartMs)} -> ${fmtTime(winEndMs)}`,
    );
    console.log(
      `  Cascade confirmed at ${fmtTime(cascadeConfirmedAt)} (${onsets.length}/${SYMBOLS.length} symbols onset)`,
    );
    console.log("-".repeat(112));

    for (const o of onsets) {
      if (o.anchorPrice === null) continue;
      const lagSec = (o.onsetMs - cascadeConfirmedAt) / 1000;
      const forwardPrices = [];
      for (const s of FORWARD_HORIZONS_SEC) {
        forwardPrices.push(
          await nearestKlineClose(o.symbol, o.onsetMs + s * 1000),
        );
        await sleep(KLINE_FETCH_DELAY_MS);
      }
      const sign = continuationSign(
        o.symbol,
        winStartMs,
        winEndMs,
        eventsBySymbol,
      );
      const rawReturns = forwardPrices.map((p) =>
        p !== null ? ((p - o.anchorPrice) / o.anchorPrice) * 100 : null,
      );
      const returns = rawReturns.map((r) => (r !== null ? r * sign : null));
      console.log(
        `  ${o.symbol.padEnd(10)} lag=${fmtDuration(lagSec).padEnd(8)} side=${sign > 0 ? "SHORT-dom" : "LONG-dom "} cont+1m=${fmtPct(returns[0]).padEnd(10)} cont+5m=${fmtPct(returns[1]).padEnd(10)} cont+15m=${fmtPct(returns[2])}`,
      );
      aggregate.push({
        lagSec,
        returns,
        symbol: o.symbol,
        episodeIdx: confirmedEpisodeCount,
      });
    }
    console.log("");
  }

  console.log(`\n${"=".repeat(112)}`);
  console.log(
    `AGGREGATE: ${confirmedEpisodeCount} confirmed multi-coin cascade episode(s) found in ${days} day(s), ${aggregate.length} onset(s) total`,
  );
  console.log("=".repeat(112));
  if (confirmedEpisodeCount === 0) {
    console.log(
      "No episodes reached quorum -- nothing to aggregate. Try more days or lower CASCADE_QUORUM/MIN_DISTINCT_SYMBOLS.",
    );
  } else {
    console.log(
      "LAG CATEGORY                  N     CONT +1m mean(+-sd)    CONT +5m mean(+-sd)    CONT +15m mean(+-sd)",
    );
    console.log(
      "(CONT = sign-normalized so + always means price continued in the SAME direction as that symbol's own dominant liquidation side within the episode)",
    );
    console.log("-".repeat(112));
    for (const cat of LAG_CATEGORIES) {
      const rows = aggregate.filter((r) => cat.test(r.lagSec));
      const cell = (hi) => {
        const vals = rows.map((r) => r.returns[hi]).filter((v) => v !== null);
        const m = mean(vals);
        const sd = stddev(vals);
        return m !== null
          ? `${fmtPct(m)} (+-${sd !== null ? sd.toFixed(3) : "N/A"})`
          : "N/A";
      };
      console.log(
        `${cat.label.padEnd(30)} ${String(rows.length).padEnd(5)} ${cell(0).padEnd(23)} ${cell(1).padEnd(23)} ${cell(2)}`,
      );
    }
  }

  console.log(`\n${"=".repeat(112)}`);
  console.log(
    "NOTE: illustrative, exploratory only. Discovery thresholds (MIN_DISTINCT_SYMBOLS, MIN_ACTIVE_RUN_BUCKETS,",
  );
  console.log(
    "GAP_TOLERANCE_BUCKETS) and onset thresholds are UNTUNED guesses. No control-random-sampling in this",
  );
  console.log(
    "aggregate run -- treat the lag-category averages as a first look, not a validated edge. This never",
  );
  console.log("touches live strategy or trading logic.");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
