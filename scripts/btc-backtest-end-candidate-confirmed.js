// Sep 20 2026 (Karo), operator-requested REDESIGN. The triple-
// timeframe (1m+3m+5m) simultaneous reversal is now an END_CANDIDATE,
// not a confirmed END. Each candidate is tested: does price
// afterward RESUME the cascade's original direction and BREAK the
// extreme that existed at the time of the candidate? If yes, this
// was an internal pullback (the cascade continues) -- the pullback's
// (depth, duration) is recorded into this episode's OWN pullback
// history, and the search for the next END_CANDIDATE resumes from
// the new extreme. If price does NOT re-break the extreme within a
// lookahead window, the candidate is checked against 15m MACRO
// structure (has the 15m swing structure itself broken, not just the
// fine 1m/3m/5m candles) before being confirmed as the true END.
// This is NOT solved by simply requiring a bigger reversal candle --
// confirmation comes from subsequent price action and structure, not
// from raising a size threshold on the triggering candle.
//
//   node scripts/btc-backtest-end-candidate-confirmed.js 1 90
//
// (arg1 = days back, default 1; arg2 = percentile threshold on
// episode totals, default 90)
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

/** Finds the next END_CANDIDATE timestamp (first minute where 1m, 3m,
 *  AND 5m candles are ALL opposite-colored to `direction`) starting
 *  the search at `fromMs`, capped at `fromMs + maxSearchMs`. */
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
  return null; // no candidate found within the cap
}

/** 15m MACRO STRUCTURE CHECK. Finds the most recent 15m swing extreme
 *  (in the cascade's OWN direction) that existed strictly BEFORE
 *  candidateMs -- this is the "structural" extreme a real regime
 *  break must clear, distinct from the immediate 1m/3m/5m local
 *  extreme. Returns true if price, looking forward from candidateMs
 *  up to lookaheadMs, NEVER closes a 15m candle beyond that swing
 *  extreme in the cascade's own direction (i.e. the 15m structure
 *  itself has broken, not just fine candles) -- meaning macro
 *  structure supports a true end. A simple, transparent proxy for
 *  "has the higher-timeframe trend structure itself flipped". */
function macroStructureSupportsEnd(
  candidateMs,
  lookaheadMs,
  direction,
  btc15m,
) {
  const priorCandles = btc15m.filter((c) => c.openTimeMs < candidateMs);
  if (priorCandles.length < 2) return true; // not enough history to judge -- don't block on it
  // Most recent 15m swing extreme before the candidate.
  let swingExtreme = direction === "down" ? Infinity : -Infinity;
  for (const c of priorCandles.slice(-8)) {
    // last ~2h of 15m candles as the "recent structure"
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
    if (isNewExtreme(c, swingExtreme, direction)) return false; // 15m structure itself extended -- NOT a true break
  }
  return true;
}

async function main() {
  const days = Number(process.argv[2] ?? "1");
  const percentileThreshold = Number(process.argv[3] ?? "90");
  const EXTREME_BREAK_LOOKAHEAD_MIN = 60;
  const MAX_CANDIDATE_SEARCH_MIN = 180;

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(110));
  console.log(
    `BTC BACKTEST -- END_CANDIDATE + extreme-break + 15m macro-structure confirmation -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(110));

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

  const tail =
    (EXTREME_BREAK_LOOKAHEAD_MIN + MAX_CANDIDATE_SEARCH_MIN) * 60 * 1000;
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

  const episodes = [];
  let i = 0;
  while (i < events.length) {
    const startMs = events[i].timestamp;
    const startVictim = events[i].victim;
    const direction = startVictim === "LONG" ? "down" : "up";

    // Track this episode's own extreme-so-far and its pullback history.
    const startCandle1m = candleCovering(btc1m, startMs, 60 * 1000);
    let extremeSoFar = startCandle1m
      ? extremeValue(startCandle1m, direction)
      : null;
    const priorPullbacks = []; // { depthPct, durationMin } for pullbacks THIS episode already survived
    let searchFrom = startMs;
    let confirmedEndMs = null;
    let candidateAttempts = 0;

    while (confirmedEndMs === null) {
      candidateAttempts++;
      const candidateMs = findNextEndCandidate(
        searchFrom,
        MAX_CANDIDATE_SEARCH_MIN * 60 * 1000,
        direction,
        btc1m,
        btc3m,
        btc5m,
      );
      if (candidateMs === null) {
        // No more candidates found within the cap -- close the episode here defensively.
        confirmedEndMs = searchFrom + MAX_CANDIDATE_SEARCH_MIN * 60 * 1000;
        break;
      }

      const lookaheadEndMs =
        candidateMs + EXTREME_BREAK_LOOKAHEAD_MIN * 60 * 1000;
      const forwardCandles = btc1m.filter(
        (c) => c.openTimeMs >= candidateMs && c.openTimeMs <= lookaheadEndMs,
      );
      let brokeExtreme = false;
      let newExtremeMs = null;
      let newExtremeVal = extremeSoFar;
      for (const c of forwardCandles) {
        if (extremeSoFar !== null && isNewExtreme(c, extremeSoFar, direction)) {
          brokeExtreme = true;
          newExtremeVal = extremeValue(c, direction);
          newExtremeMs = c.openTimeMs;
          break;
        }
      }

      if (brokeExtreme) {
        // Internal pullback, NOT a true end -- record it and continue past the new extreme.
        const candidatePrice = extremeValue(
          candleCovering(btc1m, candidateMs, 60 * 1000) ?? {
            high: extremeSoFar,
            low: extremeSoFar,
          },
          direction === "down" ? "up" : "down",
        );
        const depthPct =
          extremeSoFar !== 0 && extremeSoFar !== null
            ? (Math.abs(candidatePrice - extremeSoFar) / extremeSoFar) * 100
            : null;
        priorPullbacks.push({
          depthPct,
          durationMin: (newExtremeMs - candidateMs) / 60000,
        });
        extremeSoFar = newExtremeVal;
        searchFrom = newExtremeMs + 60 * 1000;
        continue;
      }

      // No extreme break within the lookahead -- check 15m macro structure before confirming.
      const macroOk = macroStructureSupportsEnd(
        candidateMs,
        EXTREME_BREAK_LOOKAHEAD_MIN * 60 * 1000,
        direction,
        btc15m,
      );
      if (macroOk) {
        confirmedEndMs = candidateMs;
      } else {
        // Macro structure still extending -- this candidate is not trustworthy either; keep searching past the lookahead window.
        searchFrom = lookaheadEndMs + 60 * 1000;
      }
    }

    const epEvents = [];
    while (i < events.length && events[i].timestamp <= confirmedEndMs) {
      epEvents.push(events[i]);
      i++;
    }
    const totalUsd = epEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    episodes.push({
      dominantSide: startVictim,
      direction,
      startMs,
      endMs: confirmedEndMs,
      totalUsd,
      eventCount: epEvents.length,
      pullbacksSurvived: priorPullbacks.length,
      candidateAttempts,
    });
  }

  console.log(
    `Grouped into ${episodes.length} episode(s) (END_CANDIDATE + extreme-break + macro-structure confirmed).\n`,
  );

  const totals = episodes.map((e) => e.totalUsd).sort((a, b) => a - b);
  const p90 = percentile(totals, percentileThreshold);
  const bigEpisodes = episodes.filter((e) => e.totalUsd > p90);

  console.log(`P${percentileThreshold} of episode totals: ${fmtUsd(p90)}`);
  console.log(
    `Big episodes (> P${percentileThreshold}): ${bigEpisodes.length}\n`,
  );

  console.log(
    "EPISODE   SIDE     START (UTC)              END (UTC)                DURATION   EVENTS   PULLBACKS-SURVIVED   TOTAL $",
  );
  console.log("-".repeat(120));
  bigEpisodes.forEach((e, idx) => {
    const durationMin = (e.endMs - e.startMs) / 60000;
    console.log(
      `${String(idx + 1).padStart(7)}   ${e.dominantSide.padEnd(8)} ${isoUtc(e.startMs).padEnd(24)} ${isoUtc(e.endMs).padEnd(24)} ${durationMin.toFixed(1).padStart(7)}m   ${String(e.eventCount).padStart(6)}   ${String(e.pullbacksSurvived).padStart(18)}   ${fmtUsd(e.totalUsd)}`,
    );
  });

  console.log(`\n${"=".repeat(110)}`);
  console.log(
    `TOTAL: ${bigEpisodes.length} big episode(s), of ${episodes.length} total, in ${days} day(s).`,
  );
  console.log(
    "PULLBACKS-SURVIVED = how many END_CANDIDATEs this episode had that were later invalidated by an extreme-break",
  );
  console.log(
    "before the final, confirmed end. Open a BTC chart for the UTC times above to verify.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
