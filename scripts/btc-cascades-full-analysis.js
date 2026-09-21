// Sep 20 2026 (Karo), operator-requested. Full pipeline: BTC
// dominant-side P-percentile episodes -> +-3min padding -> cross-coin
// confirmation (>=6/9 altcoins matching BTC's side) -> for CONFIRMED
// episodes only, full per-coin analysis (OI start/end, price extreme,
// forward recovery) and a PICK (best coin) with a WHY explanation.
//
//   node scripts/btc-cascades-full-analysis.js 3 10 3 3 90 3
//
// (arg1=displayDays, arg2=gapMergeMin, arg3=confirmFlipCount,
//  arg4=percentileLookbackDays, arg5=percentile, arg6=paddingMin)
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
function fmtNum(n) {
  return n === null || n === undefined ? "N/A" : n.toString();
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
    `BTC CASCADES -- FULL PIPELINE (episodes -> +-${paddingMin}min pad -> cross-coin confirm -> per-coin PICK)`,
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
    const bigTimeGap =
      e.timestamp - btcEvents[i - 1].timestamp > gapMergeMin * 60 * 1000;
    if (bigTimeGap) {
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

  console.log(
    `\nFound ${bigEpisodes.length} big BTC episode(s) (P${percentileThreshold} per side).`,
  );

  // Cross-coin confirm, with +-padding on the window.
  const confirmed = [];
  for (const e of bigEpisodes) {
    const padStart = e.startMs - paddingMs;
    const padEnd = e.endMs + paddingMs;
    let matchingCoins = 0;
    for (const symbol of ALT_SYMBOLS) {
      const altEvents = await liqCol
        .find({ symbol, timestamp: { $gte: padStart, $lte: padEnd } })
        .project({ quoteQty: 1, victim: 1 })
        .toArray();
      if (altEvents.length === 0) continue;
      const longUsd = altEvents
        .filter((x) => x.victim === "LONG")
        .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      const shortUsd = altEvents
        .filter((x) => x.victim === "SHORT")
        .reduce((a, x) => a + (x.quoteQty ?? 0), 0);
      if ((longUsd >= shortUsd ? "LONG" : "SHORT") === e.dominantSide)
        matchingCoins++;
    }
    if (matchingCoins >= 6)
      confirmed.push({ ...e, padStart, padEnd, matchingCoins });
  }

  console.log(
    `Confirmed (>=6/9 altcoins matching, +-${paddingMin}min padding): ${confirmed.length}\n`,
  );

  for (let i = 0; i < confirmed.length; i++) {
    const e = confirmed[i];
    console.log("-".repeat(120));
    console.log(
      `CASCADE #${i + 1}: BTC ${e.dominantSide}  ${isoUtc(e.padStart)} -> ${isoUtc(e.padEnd)}  (matched by ${e.matchingCoins}/9 altcoins)`,
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
      const startPrice = nearestPriceAtOrBefore(priceCandles, e.padStart);
      const endPrice = nearestPriceAtOrBefore(priceCandles, e.padEnd);
      const priceChangePct =
        startPrice && endPrice
          ? ((endPrice - startPrice) / startPrice) * 100
          : null;

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

      const forward = [];
      for (const h of FORWARD_HORIZONS_MIN) {
        const p = nearestPriceAtOrBefore(
          priceCandles,
          e.padEnd + h * 60 * 1000,
        );
        forward.push(endPrice && p ? ((p - endPrice) / endPrice) * 100 : null);
      }
      const sign = e.dominantSide === "LONG" ? 1 : -1; // LONG victims = bearish flush -> recovery = price UP = positive raw is favorable
      const normalizedForward = forward.map((v) =>
        v !== null ? v * sign : null,
      );

      records.push({
        symbol,
        startPrice,
        endPrice,
        priceChangePct,
        oiStart,
        oiEnd,
        oiDeltaPct,
        liqUsd,
        forward,
        normalizedForward,
      });
      console.log(
        `  ${symbol.padEnd(10)} price ${fmtNum(startPrice)} -> ${fmtNum(endPrice)} (${fmtPct(priceChangePct)})  OI ${fmtNum(oiStart)} -> ${fmtNum(oiEnd)} (${fmtPct(oiDeltaPct)})  liq=${fmtUsd(liqUsd)}  fwd+60m(norm)=${fmtPct(normalizedForward[2])}`,
      );
    }

    const nonBtc = records.filter((r) => r.symbol !== "BTCUSDT");
    const pick = [...nonBtc].sort((a, b) => {
      if (a.normalizedForward[2] === null) return 1;
      if (b.normalizedForward[2] === null) return -1;
      return b.normalizedForward[2] - a.normalizedForward[2];
    })[0];
    const btcRec = records.find((r) => r.symbol === "BTCUSDT");
    console.log(
      `\n  PICK: ${pick.symbol}  normalized +60m recovery: ${fmtPct(pick.normalizedForward[2])}  (BTC's own: ${fmtPct(btcRec.normalizedForward[2])})`,
    );
    console.log(
      `  WHY: ${pick.symbol} price move ${fmtPct(pick.priceChangePct)}, OI% ${fmtPct(pick.oiDeltaPct)}, liq ${fmtUsd(pick.liqUsd)}`,
    );
    console.log("");
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    `TOTAL: ${confirmed.length} confirmed cascade(s) fully analyzed, of ${bigEpisodes.length} big BTC episodes found.`,
  );
  console.log("This never touches live strategy or trading logic.");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
