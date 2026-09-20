// Sep 20 2026 (Karo), operator-requested. TEST/RESEARCH ONLY -- reads
// data, prints analysis, never touches live strategy or trading logic.
//
//   node scripts/epicenter-and-flush-detector-top12.js 3 12
//
// (arg1 = days back, defaults to 3; arg2 = how many of the largest
// confirmed cascades to fully analyze, defaults to 12 -- per the
// operator's own explicit request: 56-59 confirmed cascades in 3 days
// was far too noisy/permissive, closer to the genuinely tradeable
// count -- ranked by total liquidation USD across the whole episode.)
//
// OPERATOR'S OWN HYPOTHESIS (restated to confirm shared understanding
// before building this): when BTC (or whichever symbol is the true
// EPICENTER) starts a cascade, BTC's own OI can plausibly RISE even
// while liquidating -- it's the real battle, fresh positioning keeps
// entering. FOLLOWER symbols that are just being dragged along should
// show OI declining by roughly the SAME amount as their own
// liquidated quantity -- i.e. nothing but forced closes, no fresh
// interest replacing them, no one fighting the move. That "clean
// flush" signature (not raw lag, not raw velocity) is what should
// mark the best momentum-continuation candidate. A follower whose OI
// decline is SMALLER than its own liquidated quantity (or whose OI
// doesn't decline at all) has fresh interest stepping in -- contested,
// less clean.
//
// METHOD:
//   1. DISCOVERY: same as discover-and-analyze-cascades-v2.js -- scan
//      the N-day range, find contiguous multi-symbol-active windows,
//      require CASCADE_QUORUM symbols to independently onset before
//      calling a window a real cascade.
//   2. EPICENTER: the symbol with the EARLIEST onset in that episode
//      (first genuine velocity acceleration relative to its own
//      baseline -- not just the biggest $).
//   3. FOLLOWERS: every OTHER symbol with ANY liquidation activity in
//      the window (a much lower bar than onset -- per the operator's
//      own point, a dragged-along symbol may show no velocity spike
//      of its own at all, since it "wasn't expecting" the move).
//      For each: liquidated base quantity (quoteQty/price, summed),
//      OI delta (contracts, window start->end), and the
//      explained-by-liquidation ratio described above.
//   4. CLASSIFICATION: CLEAN FLUSH (ratio in [0.7, 1.5] -- OI decline
//      is close to what liquidation alone explains), FRESH INTEREST
//      (ratio < 0.7 or OI actually rose -- new positions replacing
//      the liquidated ones), EXTRA CAPITULATION (ratio > 1.5 -- OI
//      fell MORE than liquidation alone explains, additional
//      voluntary closing on top of the forced ones).
//   5. FORWARD RETURN comparison: does CLEAN FLUSH actually correlate
//      with stronger/cleaner same-direction continuation than
//      CONTESTED, aggregated across all episodes?
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
const FOLLOWER_MIN_USD = 200;
const FORWARD_HORIZONS_SEC = [60, 300, 900];
const KLINE_FETCH_DELAY_MS = 120;

const MIN_DISTINCT_SYMBOLS = 3;
const MIN_ACTIVE_RUN_BUCKETS = 4;
const GAP_TOLERANCE_BUCKETS = 20;
const EPISODE_PADDING_SEC = 5 * 60;

const CLEAN_FLUSH_RATIO_MIN = 0.7;
const CLEAN_FLUSH_RATIO_MAX = 1.5;
const TOP_N = Number(process.argv[3] ?? "12"); // Sep 20 2026 (Karo), operator-requested -- only fully analyze the TOP N episodes by total liquidation size, not all discovered candidates (56-59/3days was far too noisy; operator wants roughly 4-6/day equivalent -- the genuinely large ones)

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

async function main() {
  const days = Number(process.argv[2] ?? "3");
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(
      "Usage: node scripts/epicenter-and-flush-detector.js <daysBack>",
    );

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set in environment/.env");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(118));
  console.log(
    `EPICENTER + FLUSH DETECTION -- scanning ${fmtTime(rangeStartMs)} to ${fmtTime(rangeEndMs)} (${days} day(s))`,
  );
  console.log("=".repeat(118));

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
        quantity: e.price > 0 ? (e.quoteQty ?? 0) / e.price : 0,
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

  console.log(`Discovered ${runs.length} candidate episode window(s).\n`);

  function trailingAt(symbol, idx) {
    const arr = bucketUsd.get(symbol);
    let sum = 0;
    for (let i = Math.max(0, idx - TRAILING_BUCKETS + 1); i <= idx; i++)
      sum += arr[i];
    return sum;
  }

  async function nearestOiBefore(symbol, targetMs) {
    const doc = await oiCol
      .find({ symbol, timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    return doc ? doc.openInterest : null;
  }

  const flushAggregate = [];
  let confirmedEpisodeCount = 0;

  // Phase A: cheap discovery + onset-quorum check + total-$ ranking,
  // NO OI/kline calls yet (those are the expensive part).
  const candidateEpisodes = [];
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
          onsets.push({
            symbol,
            onsetMs: rangeStartMs + idx * BUCKET_SEC * 1000,
          });
          break;
        }
        if (trailing > 0) nonZeroHistory.push(trailing);
      }
    }
    if (onsets.length < CASCADE_QUORUM) continue;
    onsets.sort((a, b) => a.onsetMs - b.onsetMs);

    // Total $ across ALL symbols with any activity in this window --
    // the "how big/real was this cascade" ranking key.
    let totalUsd = 0;
    for (const symbol of SYMBOLS) {
      totalUsd += eventsBySymbol
        .get(symbol)
        .filter((e) => e.ts >= winStartMs && e.ts <= winEndMs)
        .reduce((a, e) => a + e.usd, 0);
    }

    candidateEpisodes.push({ winStartMs, winEndMs, onsets, totalUsd });
  }

  candidateEpisodes.sort((a, b) => b.totalUsd - a.totalUsd);
  const topEpisodes = candidateEpisodes.slice(0, TOP_N);

  console.log(
    `Discovered ${candidateEpisodes.length} confirmed cascade(s) (quorum >= ${CASCADE_QUORUM}); analyzing the TOP ${topEpisodes.length} by total liquidation USD.\n`,
  );
  console.log(
    "RANKING (all confirmed cascades, sorted by size -- only the top ones below get full analysis):",
  );
  candidateEpisodes.forEach((e, i) => {
    console.log(
      `  ${(i + 1).toString().padStart(3)}. ${fmtTime(e.winStartMs)}  total=${fmtUsd(e.totalUsd)}  onsetSymbols=${e.onsets.length}${i < TOP_N ? "  <-- ANALYZED BELOW" : ""}`,
    );
  });
  console.log("");

  // Phase B: full epicenter + follower + OI + kline analysis, ONLY for the top episodes.
  for (const ep of topEpisodes) {
    const { winStartMs, winEndMs, onsets } = ep;
    confirmedEpisodeCount++;
    const epicenter = onsets[0];

    console.log("-".repeat(118));
    console.log(
      `EPISODE #${confirmedEpisodeCount}: window ${fmtTime(winStartMs)} -> ${fmtTime(winEndMs)}  (total liquidated: ${fmtUsd(ep.totalUsd)})`,
    );
    console.log(
      `  EPICENTER: ${epicenter.symbol} (first onset at ${fmtTime(epicenter.onsetMs)})`,
    );
    console.log("-".repeat(118));

    const [epiOiStart, epiOiEnd] = await Promise.all([
      nearestOiBefore(epicenter.symbol, winStartMs),
      nearestOiBefore(epicenter.symbol, winEndMs),
    ]);
    const epiLiqQty = eventsBySymbol
      .get(epicenter.symbol)
      .filter((e) => e.ts >= winStartMs && e.ts <= winEndMs)
      .reduce((a, e) => a + e.quantity, 0);
    const epiOiDelta =
      epiOiStart !== null && epiOiEnd !== null ? epiOiEnd - epiOiStart : null;
    console.log(
      `  Epicenter OI: start=${epiOiStart !== null ? epiOiStart.toFixed(2) : "N/A"} end=${epiOiEnd !== null ? epiOiEnd.toFixed(2) : "N/A"} delta=${epiOiDelta !== null ? (epiOiDelta >= 0 ? "+" : "") + epiOiDelta.toFixed(2) : "N/A"} | own liquidated qty=${epiLiqQty.toFixed(2)}`,
    );
    if (epiOiDelta !== null)
      console.log(
        `  -> Epicenter OI ${epiOiDelta >= 0 ? "ROSE despite liquidating (fresh positioning -- consistent with being the real battle)" : "fell (even the epicenter is de-risking, not just fighting)"}`,
      );
    console.log("");

    console.log("  FOLLOWERS:");
    for (const symbol of SYMBOLS) {
      if (symbol === epicenter.symbol) continue;
      const events = eventsBySymbol
        .get(symbol)
        .filter((e) => e.ts >= winStartMs && e.ts <= winEndMs);
      const liqUsd = events.reduce((a, e) => a + e.usd, 0);
      if (liqUsd < FOLLOWER_MIN_USD) continue;
      const liqQty = events.reduce((a, e) => a + e.quantity, 0);
      const [oiStart, oiEnd] = await Promise.all([
        nearestOiBefore(symbol, winStartMs),
        nearestOiBefore(symbol, winEndMs),
      ]);
      if (oiStart === null || oiEnd === null || liqQty === 0) {
        console.log(
          `    ${symbol.padEnd(10)} liq=${fmtUsd(liqUsd).padEnd(10)} OI data unavailable -- skipped`,
        );
        continue;
      }
      const actualOiDelta = oiEnd - oiStart;
      const explainedByLiquidation = -liqQty;
      const ratio =
        explainedByLiquidation !== 0
          ? actualOiDelta / explainedByLiquidation
          : null;
      let classification;
      if (ratio === null) classification = "UNKNOWN";
      else if (ratio >= CLEAN_FLUSH_RATIO_MIN && ratio <= CLEAN_FLUSH_RATIO_MAX)
        classification = "CLEAN FLUSH";
      else if (ratio < CLEAN_FLUSH_RATIO_MIN) classification = "FRESH INTEREST";
      else classification = "EXTRA CAPITULATION";

      const sign = continuationSign(
        symbol,
        winStartMs,
        winEndMs,
        eventsBySymbol,
      );
      const anchorPrice =
        events.length > 0 ? events[events.length - 1].price : null;
      let returns = [null, null, null];
      if (anchorPrice !== null) {
        const forwardPrices = [];
        for (const s of FORWARD_HORIZONS_SEC) {
          forwardPrices.push(
            await nearestKlineClose(symbol, winEndMs + s * 1000),
          );
          await sleep(KLINE_FETCH_DELAY_MS);
        }
        returns = forwardPrices.map((p) =>
          p !== null ? ((p - anchorPrice) / anchorPrice) * 100 * sign : null,
        );
      }
      console.log(
        `    ${symbol.padEnd(10)} liq=${fmtUsd(liqUsd).padEnd(10)} liqQty=${liqQty.toFixed(2).padEnd(12)} oiDelta=${(actualOiDelta >= 0 ? "+" : "") + actualOiDelta.toFixed(2)}   ratio=${ratio !== null ? ratio.toFixed(2) : "N/A"}   [${classification}]   cont+1m=${fmtPct(returns[0])} cont+5m=${fmtPct(returns[1])} cont+15m=${fmtPct(returns[2])}`,
      );
      flushAggregate.push({ classification, returns });
    }
    console.log("");
  }

  console.log(`\n${"=".repeat(118)}`);
  console.log(
    `AGGREGATE (TOP ${topEpisodes.length} episodes only): ${confirmedEpisodeCount} episode(s), ${flushAggregate.length} follower classification(s)`,
  );
  console.log("=".repeat(118));
  console.log(
    "CLASSIFICATION            N     CONT +1m mean(+-sd)    CONT +5m mean(+-sd)    CONT +15m mean(+-sd)",
  );
  console.log("-".repeat(118));
  for (const cls of ["CLEAN FLUSH", "FRESH INTEREST", "EXTRA CAPITULATION"]) {
    const rows = flushAggregate.filter((r) => r.classification === cls);
    const cell = (hi) => {
      const vals = rows.map((r) => r.returns[hi]).filter((v) => v !== null);
      const m = mean(vals);
      const sd = stddev(vals);
      return m !== null
        ? `${fmtPct(m)} (+-${sd !== null ? sd.toFixed(3) : "N/A"})`
        : "N/A";
    };
    console.log(
      `${cls.padEnd(26)} ${String(rows.length).padEnd(5)} ${cell(0).padEnd(23)} ${cell(1).padEnd(23)} ${cell(2)}`,
    );
  }

  console.log(`\n${"=".repeat(118)}`);
  console.log(
    "NOTE: illustrative, exploratory only. CLASSIFICATION thresholds (CLEAN_FLUSH_RATIO_MIN/MAX),",
  );
  console.log(
    "FOLLOWER_MIN_USD, and cascade-discovery thresholds are UNTUNED guesses. No control-random-sampling",
  );
  console.log(
    "in this run. This never touches live strategy or trading logic.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
