// Sep 20 2026 (Karo), operator-requested. Same pipeline as
// btc-cascades-full-analysis.js (BTC dominant-side P-percentile
// episodes -> padding -> cross-coin confirm), but the PICK is now
// RISK-ADJUSTED: normalized recovery %% divided by that coin's own
// ATR%% (volatility-normalized), instead of raw %% -- removes the
// known high-beta bias (DOGE/SUI/AVAX dominating just because they
// swing more). Also reports OI delta%% alongside, and a final
// aggregate: does OI delta correlate with the risk-adjusted PICK once
// volatility bias is removed, or not.
//
//   node scripts/btc-cascades-risk-adjusted.js 3 10 3 3 90 3
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
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}
function fmtNum(n) {
  return n === null || n === undefined ? "N/A" : n.toString();
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

  console.log("=".repeat(120));
  console.log(
    `BTC CASCADES -- RISK-ADJUSTED PICK (recovery%% / ATR%%) + OI CHECK`,
  );
  console.log(
    `Display window: ${isoUtc(displayStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(120));

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
      const altEvents = await liqCol
        .find({ symbol, timestamp: { $gte: padStart, $lte: padEnd } })
        .project({ quoteQty: 1, victim: 1 })
        .toArray();
      if (altEvents.length === 0) continue;
      const l = altEvents
        .filter((x) => x.victim === "LONG")
        .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      const s = altEvents
        .filter((x) => x.victim === "SHORT")
        .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      if ((l >= s ? "LONG" : "SHORT") === e.dominantSide) matchingCoins++;
    }
    if (matchingCoins >= 6)
      confirmed.push({ ...e, padStart, padEnd, matchingCoins });
  }

  console.log(`\nConfirmed cascades: ${confirmed.length}\n`);

  const globalRows = []; // { cascadeIdx, symbol, rawPick, riskAdjPick, oiDeltaPct }

  for (let i = 0; i < confirmed.length; i++) {
    const e = confirmed[i];
    console.log("-".repeat(120));
    console.log(
      `CASCADE #${i + 1}: BTC ${e.dominantSide}  ${isoUtc(e.padStart)} -> ${isoUtc(e.padEnd)}  (matched by ${e.matchingCoins}/9)`,
    );
    console.log("-".repeat(120));

    const records = [];
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
      const atrAtEnd = nearestAtrAtOrBefore(atrCandles, atrSeries, e.padEnd);
      const atrPctOfPrice =
        atrAtEnd !== null && endPrice ? (atrAtEnd / endPrice) * 100 : null;

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

      const symEvents = await liqCol
        .find({ symbol, timestamp: { $gte: e.padStart, $lte: e.padEnd } })
        .project({ quoteQty: 1 })
        .toArray();
      const liqUsd = symEvents.reduce((a, x) => a + (x.quoteQty ?? 0), 0);

      const p60 = nearestPriceAtOrBefore(
        priceCandles,
        e.padEnd + 60 * 60 * 1000,
      );
      const raw60 =
        endPrice && p60 ? ((p60 - endPrice) / endPrice) * 100 : null;
      const sign = e.dominantSide === "LONG" ? 1 : -1;
      const normalized60 = raw60 !== null ? raw60 * sign : null;
      const riskAdjusted60 =
        normalized60 !== null && atrPctOfPrice !== null && atrPctOfPrice !== 0
          ? normalized60 / atrPctOfPrice
          : null;

      records.push({
        symbol,
        priceChangePct,
        atrPctOfPrice,
        oiDeltaPct,
        liqUsd,
        normalized60,
        riskAdjusted60,
      });
      console.log(
        `  ${symbol.padEnd(10)} price ${fmtPct(priceChangePct)}  ATR%=${fmtPct(atrPctOfPrice)}  OI%=${fmtPct(oiDeltaPct)}  liq=${fmtUsd(liqUsd)}  norm+60m=${fmtPct(normalized60)}  RISK-ADJ=${riskAdjusted60 !== null ? riskAdjusted60.toFixed(3) : "N/A"}`,
      );
    }

    const nonBtc = records.filter((r) => r.symbol !== "BTCUSDT");
    const rawPick = [...nonBtc].sort(
      (a, b) => (b.normalized60 ?? -Infinity) - (a.normalized60 ?? -Infinity),
    )[0];
    const riskAdjPick = [...nonBtc].sort(
      (a, b) =>
        (b.riskAdjusted60 ?? -Infinity) - (a.riskAdjusted60 ?? -Infinity),
    )[0];

    console.log(
      `\n  RAW PICK (old method):        ${rawPick.symbol}  (norm+60m=${fmtPct(rawPick.normalized60)})`,
    );
    console.log(
      `  RISK-ADJUSTED PICK (new):     ${riskAdjPick.symbol}  (risk-adj=${riskAdjPick.riskAdjusted60 !== null ? riskAdjPick.riskAdjusted60.toFixed(3) : "N/A"})  ${rawPick.symbol === riskAdjPick.symbol ? "SAME as raw pick" : "DIFFERENT from raw pick"}`,
    );
    console.log(
      `  Risk-adjusted pick's OI%: ${fmtPct(riskAdjPick.oiDeltaPct)}\n`,
    );

    globalRows.push({
      cascadeIdx: i + 1,
      rawPickSymbol: rawPick.symbol,
      riskAdjPickSymbol: riskAdjPick.symbol,
      riskAdjPickOiDeltaPct: riskAdjPick.oiDeltaPct,
      sameAsRaw: rawPick.symbol === riskAdjPick.symbol,
    });
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log("SUMMARY -- raw pick vs risk-adjusted pick, per cascade:");
  globalRows.forEach((r) =>
    console.log(
      `  Cascade #${r.cascadeIdx}: raw=${r.rawPickSymbol}  risk-adj=${r.riskAdjPickSymbol}  ${r.sameAsRaw ? "(same)" : "(DIFFERENT)"}`,
    ),
  );
  const sameCount = globalRows.filter((r) => r.sameAsRaw).length;
  console.log(
    `\n${sameCount}/${globalRows.length} cascades: raw pick and risk-adjusted pick AGREE.`,
  );
  console.log(
    `Avg OI delta% of the risk-adjusted pick, across all cascades: ${fmtPct(mean(globalRows.map((r) => r.riskAdjPickOiDeltaPct)))}`,
  );
  console.log("\nThis never touches live strategy or trading logic.");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
