// Sep 20 2026 (Karo), operator-requested. GENERAL framework -- not
// tuned to one example. Uses the already-validated 1m+3m+5m candle
// END_CANDIDATE detection to segment a window into candidate signal
// points, and for EACH candidate gathers the full dynamic dataset the
// operator described: OI at the episode's own start event, OI+price+
// velocity at the episode's own last event (the extreme), the
// recovery-confirmation timestamp (same triple-timeframe candle
// logic), OI+price AT that recovery confirmation, and a FORWARD check
// (what price actually did afterward) so multiple candidates can be
// compared side by side to find a real pattern, not assumed from one
// case.
//
//   node scripts/btc-signal-candidates-dynamic-data.js "2026-09-20 02:20" "2026-09-20 03:20"
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

function parseArgTime(s) {
  const iso = s.includes("T")
    ? s
    : s.replace(" ", "T") + (s.length <= 16 ? ":00Z" : "Z");
  const d = new Date(iso);
  if (isNaN(d.getTime()))
    throw new Error(
      `Could not parse time: "${s}" -- use "YYYY-MM-DD HH:mm" (UTC)`,
    );
  return d;
}
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
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
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
  const startArg = process.argv[2];
  const endArg = process.argv[3];
  if (!startArg || !endArg) {
    console.error(
      'Usage: node scripts/btc-signal-candidates-dynamic-data.js "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm"',
    );
    process.exit(1);
  }
  const windowStartMs = parseArgTime(startArg).getTime();
  const windowEndMs = parseArgTime(endArg).getTime();
  const MAX_SEARCH_MIN = 60;
  const FORWARD_CHECK_MIN = [15, 30, 60];

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(130));
  console.log(
    `BTC SIGNAL-CANDIDATES DYNAMIC DATA -- ${isoUtc(windowStartMs)} to ${isoUtc(windowEndMs)}`,
  );
  console.log("=".repeat(130));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: windowStartMs, $lte: windowEndMs + 3600000 },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(`\nLoaded ${events.length} liquidation events.\n`);
  if (events.length === 0) {
    await client.close();
    return;
  }

  const tail = (MAX_SEARCH_MIN + Math.max(...FORWARD_CHECK_MIN)) * 60 * 1000;
  const btc1m = await fetchKlinesRange(
    "BTCUSDT",
    windowStartMs,
    windowEndMs + tail,
    1,
  );
  await sleep(150);
  const btc3m = await fetchKlinesRange(
    "BTCUSDT",
    windowStartMs,
    windowEndMs + tail,
    3,
  );
  await sleep(150);
  const btc5m = await fetchKlinesRange(
    "BTCUSDT",
    windowStartMs,
    windowEndMs + tail,
    5,
  );

  async function nearestOiAtOrBefore(targetMs) {
    const doc = await oiCol
      .find({ symbol: "BTCUSDT", timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    return doc ? doc.openInterest : null;
  }
  function priceAtOrBefore(candles, targetMs) {
    let best = null;
    for (const c of candles) {
      if (c.openTimeMs <= targetMs) best = c;
      else break;
    }
    return best ? best.close : null;
  }

  // Segment the window into candidate sub-episodes using the SAME
  // triple-timeframe candle logic already validated -- general,
  // reusable, not tuned to this one example.
  let i = 0;
  let candidateNum = 0;
  while (i < events.length && events[i].timestamp <= windowEndMs) {
    candidateNum++;
    const startEvent = events[i];
    const direction = startEvent.victim === "LONG" ? "down" : "up";
    const searchFrom = startEvent.timestamp;
    const candidateEndMs =
      findNextEndCandidate(
        searchFrom,
        MAX_SEARCH_MIN * 60 * 1000,
        direction,
        btc1m,
        btc3m,
        btc5m,
      ) ?? searchFrom + MAX_SEARCH_MIN * 60 * 1000;

    const epEvents = [];
    while (i < events.length && events[i].timestamp <= candidateEndMs) {
      epEvents.push(events[i]);
      i++;
    }
    const lastEvent = epEvents[epEvents.length - 1];

    console.log("-".repeat(130));
    console.log(
      `CANDIDATE #${candidateNum}: ${startEvent.victim} cascade, ${epEvents.length} event(s), ${hhmmss(startEvent.timestamp)} -> ${hhmmss(lastEvent.timestamp)}`,
    );
    console.log("-".repeat(130));

    const oiAtStart = await nearestOiAtOrBefore(startEvent.timestamp);
    const oiAtLast = await nearestOiAtOrBefore(lastEvent.timestamp);
    const avgVelocitySec =
      epEvents.length > 1
        ? (lastEvent.timestamp - startEvent.timestamp) /
          1000 /
          (epEvents.length - 1)
        : null;
    const totalUsd = epEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);

    console.log(
      `  START event: ${hhmmss(startEvent.timestamp)}  price=${startEvent.price}  OI=${oiAtStart !== null ? oiAtStart.toFixed(2) : "N/A"}`,
    );
    console.log(
      `  LAST event (extreme):  ${hhmmss(lastEvent.timestamp)}  price=${lastEvent.price}  OI=${oiAtLast !== null ? oiAtLast.toFixed(2) : "N/A"}`,
    );
    console.log(
      `  Total liquidated: ${fmtUsd(totalUsd)}  Avg time between events: ${avgVelocitySec !== null ? avgVelocitySec.toFixed(1) + "s" : "N/A"}`,
    );
    console.log(
      `  OI delta (start->last): ${oiAtStart !== null && oiAtLast !== null ? (oiAtLast - oiAtStart >= 0 ? "+" : "") + (oiAtLast - oiAtStart).toFixed(2) : "N/A"}`,
    );

    // Recovery confirmation: same triple-timeframe logic, searched from the extreme.
    const recoveryMs = findNextEndCandidate(
      lastEvent.timestamp,
      MAX_SEARCH_MIN * 60 * 1000,
      direction,
      btc1m,
      btc3m,
      btc5m,
    );
    if (recoveryMs === null) {
      console.log(
        `  RECOVERY: not confirmed within ${MAX_SEARCH_MIN}min -- no signal this candidate.\n`,
      );
      continue;
    }
    const oiAtRecovery = await nearestOiAtOrBefore(recoveryMs);
    const priceAtRecovery = priceAtOrBefore(btc1m, recoveryMs);
    const priceChangeExtremeToRecovery = lastEvent.price
      ? ((priceAtRecovery - lastEvent.price) / lastEvent.price) * 100
      : null;
    console.log(
      `  RECOVERY confirmed: ${hhmmss(recoveryMs)}  price=${priceAtRecovery}  OI=${oiAtRecovery !== null ? oiAtRecovery.toFixed(2) : "N/A"}`,
    );
    console.log(
      `  OI delta (last-event->recovery): ${oiAtLast !== null && oiAtRecovery !== null ? (oiAtRecovery - oiAtLast >= 0 ? "+" : "") + (oiAtRecovery - oiAtLast).toFixed(2) : "N/A"}   Price change (extreme->recovery): ${fmtPct(priceChangeExtremeToRecovery)}`,
    );

    // Forward check: if we HAD signaled LONG (or SHORT) here, what actually happened?
    const sign = direction === "down" ? 1 : -1; // LONG-victim (down) cascade -> a long signal profits if price goes UP after
    const forward = FORWARD_CHECK_MIN.map((h) => {
      const p = priceAtOrBefore(btc1m, recoveryMs + h * 60 * 1000);
      const raw =
        priceAtRecovery && p
          ? ((p - priceAtRecovery) / priceAtRecovery) * 100
          : null;
      return raw !== null ? raw * sign : null;
    });
    console.log(
      `  FORWARD from recovery signal: +15m=${fmtPct(forward[0])}  +30m=${fmtPct(forward[1])}  +60m=${fmtPct(forward[2])}`,
    );
    console.log(
      `  ${forward[2] !== null && forward[2] > 0 ? "-> Would have been a GOOD long signal (price kept going up)." : forward[2] !== null ? "-> Would have been a BAD long signal (price did not follow through / reversed back down)." : ""}\n`,
    );
  }

  console.log(`\n${"=".repeat(130)}`);
  console.log(
    "This never touches live strategy or trading logic -- diagnostic only. Compare the candidates above by eye:",
  );
  console.log(
    "look at OI delta (start->last, last->recovery), velocity, and total$ across the GOOD vs BAD forward outcomes",
  );
  console.log(
    "to find what actually distinguishes them, rather than assuming a rule from a single case.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
