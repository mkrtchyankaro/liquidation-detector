// Sep 20 2026 (Karo), operator-requested. THE COMPLETE DATASET --
// merges everything built in this session into one report: BTC
// dominant-side cascade discovery (P90/P95 per side, cross-coin
// confirmation), then for EVERY one of the 10 coins in EVERY
// confirmed cascade: ATR at start/end, OI at start/end, that coin's
// own P90/P95 (event-size baseline), how much IT liquidated during
// the window, and where it went afterward (forward %, normalized to
// whether it moved in the cascade's own reversal direction).
// No single hypothesis is tested here -- this is raw, complete data
// for every coin, every confirmed cascade, all in one place.
//
//   node scripts/btc-cascades-complete-data.js 3 10 3 3 90 3
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
const ATR_PERIOD = 14;
const ATR_INTERVAL_MIN = 15;
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
    : `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
}
function fmtNum(n) {
  return n === null || n === undefined
    ? "N/A"
    : typeof n === "number"
      ? n.toFixed(4)
      : n;
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
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      });
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

async function main() {
  const displayDays = Number(process.argv[2] ?? "3");
  const gapMergeMin = Number(process.argv[3] ?? "10");
  const confirmFlipCount = Number(process.argv[4] ?? "3");
  const percentileLookbackDays = Number(process.argv[5] ?? "3");
  const percentileThreshold = Number(process.argv[6] ?? "90");
  const paddingMin = Number(process.argv[7] ?? "3");

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
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(150));
  console.log(
    `BTC CASCADES -- COMPLETE DATASET (ATR, OI, P90/P95, liquidation $, forward direction -- every coin, every confirmed cascade)`,
  );
  console.log(
    `Display window: ${isoUtc(displayStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(150));

  // Pre-fetch every symbol's full lookback event history (for P90/P95 and window totals).
  const eventsFull = {};
  for (const symbol of ALL_SYMBOLS) {
    eventsFull[symbol] = await liqCol
      .find({ symbol, timestamp: { $gte: rangeStartMs, $lte: rangeEndMs } })
      .project({ timestamp: 1, quoteQty: 1, victim: 1 })
      .sort({ timestamp: 1 })
      .toArray();
  }

  const btcEvents = eventsFull["BTCUSDT"];
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
      const inWindow = eventsFull[symbol].filter(
        (x) => x.timestamp >= padStart && x.timestamp <= padEnd,
      );
      if (inWindow.length === 0) continue;
      const l = inWindow
        .filter((x) => x.victim === "LONG")
        .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      const s = inWindow
        .filter((x) => x.victim === "SHORT")
        .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      if ((l >= s ? "LONG" : "SHORT") === e.dominantSide) matchingCoins++;
    }
    if (matchingCoins >= 6)
      confirmed.push({ ...e, padStart, padEnd, matchingCoins });
  }

  console.log(`\nConfirmed cascades: ${confirmed.length}\n`);

  for (let i = 0; i < confirmed.length; i++) {
    const e = confirmed[i];
    console.log("=".repeat(150));
    console.log(
      `CASCADE #${i + 1}: BTC ${e.dominantSide}  ${isoUtc(e.padStart)} -> ${isoUtc(e.padEnd)}  (matched by ${e.matchingCoins}/9 altcoins)`,
    );
    console.log("=".repeat(150));
    console.log(
      "SYMBOL      PRICE START->END (%)        ATR START->END          OI START->END (%)              P90/P95 (own, 24h)      LIQ THIS WINDOW      FWD+15m     FWD+30m     FWD+60m",
    );
    console.log("-".repeat(150));

    for (const symbol of ALL_SYMBOLS) {
      const priceCandles = await fetchKlinesRange(
        symbol,
        e.padStart - 5 * 60 * 1000,
        e.padEnd + 65 * 60 * 1000,
        1,
      );
      const atrLookbackMs = (ATR_PERIOD + 2) * ATR_INTERVAL_MIN * 60 * 1000;
      const atrCandles = await fetchKlinesRange(
        symbol,
        e.padStart - atrLookbackMs,
        e.padEnd,
        ATR_INTERVAL_MIN,
      );
      const atrSeries = computeAtrSeries(atrCandles, ATR_PERIOD);

      const startPrice = nearestPriceAtOrBefore(priceCandles, e.padStart);
      const endPrice = nearestPriceAtOrBefore(priceCandles, e.padEnd);
      const priceChangePct =
        startPrice && endPrice
          ? ((endPrice - startPrice) / startPrice) * 100
          : null;
      const atrStart = nearestAtrAtOrBefore(atrCandles, atrSeries, e.padStart);
      const atrEnd = nearestAtrAtOrBefore(atrCandles, atrSeries, e.padEnd);

      const oiStartDoc = await oiCol
        .find({ symbol, timestamp: { $lte: new Date(e.padStart) } })
        .sort({ timestamp: -1 })
        .limit(1)
        .next();
      const oiEndDoc = await oiCol
        .find({ symbol, timestamp: { $lte: new Date(e.padEnd) } })
        .sort({ timestamp: -1 })
        .limit(1)
        .next();
      const oiStart = oiStartDoc?.openInterest ?? null;
      const oiEnd = oiEndDoc?.openInterest ?? null;
      const oiDeltaPct =
        oiStart !== null && oiEnd !== null && oiStart !== 0
          ? ((oiEnd - oiStart) / oiStart) * 100
          : null;

      // Own P90/P95: individual event sizes, trailing 24h before this cascade's start.
      const lookback24h = e.padStart - 24 * 3600 * 1000;
      const priorSizes = eventsFull[symbol]
        .filter((x) => x.timestamp >= lookback24h && x.timestamp < e.padStart)
        .map((x) => x.quoteQty ?? 0)
        .sort((a, b) => a - b);
      const p90 = percentile(priorSizes, 90);
      const p95 = percentile(priorSizes, 95);

      const inWindow = eventsFull[symbol].filter(
        (x) => x.timestamp >= e.padStart && x.timestamp <= e.padEnd,
      );
      const liqUsd = inWindow.reduce((a, x) => a + (x.quoteQty ?? 0), 0);

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
        `${symbol.padEnd(11)} ${fmtNum(startPrice).padEnd(12)}->${fmtNum(endPrice).padEnd(12)} (${fmtPct(priceChangePct).padEnd(9)}) ${fmtNum(atrStart).padEnd(10)}->${fmtNum(atrEnd).padEnd(10)} ${fmtNum(oiStart).padEnd(13)}->${fmtNum(oiEnd).padEnd(13)} (${fmtPct(oiDeltaPct).padEnd(9)}) ${fmtUsd(p90).padEnd(10)}/${fmtUsd(p95).padEnd(10)} ${fmtUsd(liqUsd).padEnd(12)} ${fmtPct(forward[0]).padEnd(11)} ${fmtPct(forward[1]).padEnd(11)} ${fmtPct(forward[2])}`,
      );
    }
    console.log("");
  }

  console.log(`\n${"=".repeat(150)}`);
  console.log(
    `TOTAL: ${confirmed.length} confirmed cascade(s), ${confirmed.length * 10} coin-cascade row(s) of complete data printed above.`,
  );
  console.log(
    "No hypothesis is scored here -- this is the raw, complete dataset for manual review.",
  );
  console.log("This never touches live strategy or trading logic.");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
