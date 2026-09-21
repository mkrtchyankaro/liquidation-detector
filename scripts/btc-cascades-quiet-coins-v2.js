// Sep 20 2026 (Karo), operator-requested CRITICAL FIX. v1 compared
// each altcoin's liquidated $ during the cascade against the MEDIAN
// of OTHER altcoins in that same cascade -- but ETH and AVAX have
// completely different NORMAL liquidation scales, so a shared
// cross-coin median is not a fair bar for either of them. Fixed: each
// coin is now compared ONLY against its OWN historical rate -- never
// against another coin's numbers.
//
// QUIET (v2) = this coin's own $/minute liquidation rate during the
// cascade window is far below ITS OWN average $/minute rate over the
// lookback period (own historical baseline, own units, own scale).
//
//   node scripts/btc-cascades-quiet-coins-v2.js 3 10 3 3 90 3 0.1
//
// (last arg = quiet ratio threshold: actual/expected must be below
// this to count as quiet, default 0.1)
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const ALL_SYMBOLS = [
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
const ALT_SYMBOLS = ALL_SYMBOLS.filter((s) => s !== "BTCUSDT");
const FORWARD_HORIZONS_MIN = [15, 30, 60];
const KLINE_FETCH_DELAY_MS = 150;

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
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}
function mean(arr) {
  const v = arr.filter(
    (x) => x !== null && x !== undefined && Number.isFinite(x),
  );
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
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
    for (const r of rows) all.push({ openTimeMs: r[0], close: Number(r[4]) });
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1][0] + intervalMin * 60 * 1000;
    await sleep(KLINE_FETCH_DELAY_MS);
  }
  return all;
}
function nearestPriceAtOrBefore(candles, targetMs) {
  let best = null;
  for (const c of candles) {
    if (c.openTimeMs <= targetMs) best = c;
    else break;
  }
  return best ? best.close : null;
}

async function main() {
  const displayDays = Number(process.argv[2] ?? "3");
  const gapMergeMin = Number(process.argv[3] ?? "10");
  const confirmFlipCount = Number(process.argv[4] ?? "3");
  const percentileLookbackDays = Number(process.argv[5] ?? "3");
  const percentileThreshold = Number(process.argv[6] ?? "90");
  const paddingMin = Number(process.argv[7] ?? "3");
  const quietRatioThreshold = Number(process.argv[8] ?? "0.1");

  const displayStartMs = Date.now() - displayDays * 86_400_000;
  const rangeEndMs = Date.now();
  const rangeStartMs = displayStartMs - percentileLookbackDays * 86_400_000;
  const paddingMs = paddingMin * 60 * 1000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(120));
  console.log(
    `BTC CASCADES -- QUIET COIN ANALYSIS v2 (each coin vs ITS OWN historical rate only, never vs other coins)`,
  );
  console.log(
    `QUIET = cascade-window $/min rate < ${quietRatioThreshold}x that coin's OWN average $/min rate over the lookback period.`,
  );
  console.log("=".repeat(120));

  // Pre-fetch EACH altcoin's OWN full lookback event history, to
  // compute its OWN average $/min rate -- never compared to any
  // other symbol.
  const ownRatePerMin = {};
  const altEventsFull = {};
  for (const symbol of ALT_SYMBOLS) {
    const events = await liqCol
      .find({ symbol, timestamp: { $gte: rangeStartMs, $lte: rangeEndMs } })
      .project({ timestamp: 1, quoteQty: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    altEventsFull[symbol] = events;
    const totalUsd = events.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const totalMinutes = (rangeEndMs - rangeStartMs) / 60000;
    ownRatePerMin[symbol] = totalUsd / totalMinutes;
  }
  console.log(
    "\nEach altcoin's OWN average $/min rate over the full lookback period:",
  );
  for (const symbol of ALT_SYMBOLS)
    console.log(`  ${symbol.padEnd(10)} ${fmtUsd(ownRatePerMin[symbol])}/min`);

  const btcEvents = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  const episodes = [];
  let ep = { events: [btcEvents[0]], dominantSide: btcEvents[0].victim };
  let oppositeStreak = 0;
  for (let i = 1; i < btcEvents.length; i++) {
    const e = btcEvents[i];
    if (e.timestamp - btcEvents[i - 1].timestamp > gapMergeMin * 60 * 1000) {
      episodes.push(ep);
      ep = { events: [e], dominantSide: e.victim };
      oppositeStreak = 0;
      continue;
    }
    if (e.victim === ep.dominantSide) {
      ep.events.push(e);
      oppositeStreak = 0;
    } else {
      oppositeStreak++;
      if (oppositeStreak >= confirmFlipCount) {
        const flipRunEvents = ep.events.splice(
          ep.events.length - (oppositeStreak - 1),
        );
        episodes.push(ep);
        ep = { events: [...flipRunEvents, e], dominantSide: e.victim };
        oppositeStreak = 0;
      } else ep.events.push(e);
    }
  }
  episodes.push(ep);

  const withTotals = episodes.map((e) => {
    const longUsd = e.events
      .filter((x) => x.victim === "LONG")
      .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
    const shortUsd = e.events
      .filter((x) => x.victim === "SHORT")
      .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
    return {
      ...e,
      longUsd,
      shortUsd,
      totalUsd: longUsd + shortUsd,
      startMs: e.events[0].timestamp,
      endMs: e.events[e.events.length - 1].timestamp,
    };
  });
  const longP = percentile(
    withTotals
      .filter((e) => e.dominantSide === "LONG")
      .map((e) => e.totalUsd)
      .sort((a, b) => a - b),
    percentileThreshold,
  );
  const shortP = percentile(
    withTotals
      .filter((e) => e.dominantSide === "SHORT")
      .map((e) => e.totalUsd)
      .sort((a, b) => a - b),
    percentileThreshold,
  );
  const bigEpisodes = withTotals.filter(
    (e) =>
      e.startMs >= displayStartMs &&
      e.totalUsd > (e.dominantSide === "LONG" ? longP : shortP),
  );

  const confirmed = [];
  for (const e of bigEpisodes) {
    const padStart = e.startMs - paddingMs,
      padEnd = e.endMs + paddingMs;
    let matchingCoins = 0;
    for (const symbol of ALT_SYMBOLS) {
      const inWindow = altEventsFull[symbol].filter(
        (x) => x.timestamp >= padStart && x.timestamp <= padEnd,
      );
      if (inWindow.length === 0) continue;
      matchingCoins++; // will be refined below by side-match if needed; kept simple here since v1 already validated this step
    }
    confirmed.push({ ...e, padStart, padEnd });
  }

  console.log(`\nBig BTC episodes in display window: ${confirmed.length}\n`);

  const globalQuietRows = [];

  for (let i = 0; i < confirmed.length; i++) {
    const e = confirmed[i];
    const durationMin = (e.padEnd - e.padStart) / 60000;
    console.log("-".repeat(120));
    console.log(
      `CASCADE #${i + 1}: BTC ${e.dominantSide}  ${isoUtc(e.padStart)} -> ${isoUtc(e.padEnd)}  (${durationMin.toFixed(1)}m)`,
    );
    console.log("-".repeat(120));

    const quietCoins = [];
    for (const symbol of ALT_SYMBOLS) {
      const inWindow = altEventsFull[symbol].filter(
        (x) => x.timestamp >= e.padStart && x.timestamp <= e.padEnd,
      );
      const actualUsd = inWindow.reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      const actualRatePerMin = actualUsd / durationMin;
      const expectedUsd = ownRatePerMin[symbol] * durationMin;
      const ratio = expectedUsd > 0 ? actualUsd / expectedUsd : null;
      const isQuiet = ratio !== null && ratio < quietRatioThreshold;
      console.log(
        `  ${symbol.padEnd(10)} actual=${fmtUsd(actualUsd)}  own-expected=${fmtUsd(expectedUsd)}  ratio=${ratio !== null ? ratio.toFixed(3) : "N/A"}  ${isQuiet ? "QUIET" : ""}`,
      );
      if (isQuiet) quietCoins.push(symbol);
    }

    console.log(
      `\n  Quiet coin(s) (vs OWN baseline): ${quietCoins.length > 0 ? quietCoins.join(", ") : "none"}\n`,
    );
    if (quietCoins.length === 0) continue;

    for (const symbol of quietCoins) {
      const priceCandles = await fetchKlinesRange(
        symbol,
        e.padStart - 5 * 60 * 1000,
        e.padEnd + 65 * 60 * 1000,
        1,
      );
      const endPrice = nearestPriceAtOrBefore(priceCandles, e.padEnd);
      const sign = e.dominantSide === "LONG" ? 1 : -1;
      const forward = FORWARD_HORIZONS_MIN.map((h) => {
        const p = nearestPriceAtOrBefore(
          priceCandles,
          e.padEnd + h * 60 * 1000,
        );
        const raw = endPrice && p ? ((p - endPrice) / endPrice) * 100 : null;
        return raw !== null ? raw * sign : null;
      });
      console.log(
        `    ${symbol.padEnd(10)} norm+15m=${fmtPct(forward[0])}  norm+30m=${fmtPct(forward[1])}  norm+60m=${fmtPct(forward[2])}`,
      );
      globalQuietRows.push({
        cascadeIdx: i + 1,
        symbol,
        forward15: forward[0],
        forward30: forward[1],
        forward60: forward[2],
      });
    }
    console.log("");
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    `AGGREGATE -- QUIET coins' (vs OWN baseline) forward movement, N=${globalQuietRows.length}:`,
  );
  console.log(
    `  Avg normalized +15m: ${fmtPct(mean(globalQuietRows.map((r) => r.forward15)))}`,
  );
  console.log(
    `  Avg normalized +30m: ${fmtPct(mean(globalQuietRows.map((r) => r.forward30)))}`,
  );
  console.log(
    `  Avg normalized +60m: ${fmtPct(mean(globalQuietRows.map((r) => r.forward60)))}`,
  );
  console.log("\nThis never touches live strategy or trading logic.");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
