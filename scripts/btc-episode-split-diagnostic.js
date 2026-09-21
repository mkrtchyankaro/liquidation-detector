// Sep 20 2026 (Karo), operator-requested. Deep diagnostic for ONE
// specific window where 4 separate episodes were detected but the
// operator suspects they should have been ONE continuous cascade.
// Shows EVERY liquidation event (to see the real velocity -- did it
// actually slow down in the "gaps", or stay strong?), every 1m candle
// (to see exactly which candle triggered each declared END), and OI
// observations across the whole window.
//
//   node scripts/btc-episode-split-diagnostic.js "2026-09-20 02:20" "2026-09-20 03:20"
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

async function main() {
  const startArg = process.argv[2];
  const endArg = process.argv[3];
  if (!startArg || !endArg) {
    console.error(
      'Usage: node scripts/btc-episode-split-diagnostic.js "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm"  (UTC)',
    );
    process.exit(1);
  }
  const windowStartMs = parseArgTime(startArg).getTime();
  const windowEndMs = parseArgTime(endArg).getTime();

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(120));
  console.log(
    `BTC EPISODE-SPLIT DIAGNOSTIC -- ${isoUtc(windowStartMs)} to ${isoUtc(windowEndMs)}`,
  );
  console.log("=".repeat(120));

  const events = await liqCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: windowStartMs, $lte: windowEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const btc1m = await fetchKlinesRange(
    "BTCUSDT",
    windowStartMs,
    windowEndMs,
    1,
  );
  const oiDocs = await oiCol
    .find({
      symbol: "BTCUSDT",
      timestamp: { $gte: new Date(windowStartMs), $lte: new Date(windowEndMs) },
    })
    .project({ timestamp: 1, openInterest: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(
    `\nLoaded ${events.length} liquidation events, ${btc1m.length} 1m candles, ${oiDocs.length} OI observations.\n`,
  );

  // Minute-by-minute merged view: candle color, liq $ that minute, event count, OI nearest-at-or-before.
  console.log("MINUTE-BY-MINUTE VELOCITY + CANDLE COLOR + OI");
  console.log("-".repeat(120));
  console.log(
    "TIME      CANDLE(O->C)              COLOR   LIQ $ this min   EVENTS   LONG$/SHORT$              OI (nearest<=)",
  );
  console.log("-".repeat(120));

  function nearestOiAtOrBefore(targetMs) {
    let best = null;
    for (const d of oiDocs) {
      const t =
        d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp;
      if (t <= targetMs) best = d;
      else break;
    }
    return best;
  }

  const minuteStart = Math.floor(windowStartMs / 60000) * 60000;
  for (let m = minuteStart; m <= windowEndMs; m += 60000) {
    const candle = btc1m.find((c) => c.openTimeMs === m);
    const eventsThisMin = events.filter(
      (e) => e.timestamp >= m && e.timestamp < m + 60000,
    );
    const liqUsd = eventsThisMin.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const longUsd = eventsThisMin
      .filter((e) => e.victim === "LONG")
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const shortUsd = eventsThisMin
      .filter((e) => e.victim === "SHORT")
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const oi = nearestOiAtOrBefore(m + 59999);
    const color = candle
      ? candle.close > candle.open
        ? "GREEN"
        : candle.close < candle.open
          ? "RED  "
          : "FLAT "
      : "N/A  ";
    const marker = eventsThisMin.length > 0 ? " *" : "";
    console.log(
      `${hhmmss(m).slice(0, 8)}  ${candle ? `${candle.open.toFixed(1)}->${candle.close.toFixed(1)}` : "N/A".padEnd(20)}`.padEnd(
        35,
      ) +
        ` ${color}   ${fmtUsd(liqUsd).padEnd(16)} ${String(eventsThisMin.length).padEnd(8)} ${fmtUsd(longUsd)}/${fmtUsd(shortUsd)}   ${oi ? oi.openInterest.toFixed(2) : "N/A"}${marker}`,
    );
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    `EVERY LIQUIDATION EVENT (${events.length} total) -- for raw velocity inspection`,
  );
  console.log("=".repeat(120));
  for (const e of events) {
    console.log(
      `  ${hhmmss(e.timestamp)}  price=${e.price}  victim=${e.victim}  usd=${fmtUsd(e.quoteQty)}`,
    );
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    "READING GUIDE: look at the minute-by-minute table. If LIQ $ stays consistently non-zero (or only briefly",
  );
  console.log(
    "drops for 1-2 minutes) across what the algorithm called 4 separate episodes, that supports the operator's",
  );
  console.log(
    "suspicion: this was ONE continuous cascade, and the gap-based/candle-based split was wrong. If there are",
  );
  console.log(
    "genuine multi-minute silent gaps with real green-candle price recovery in between, the split may be correct.",
  );
  console.log(
    "This never touches live strategy or trading logic -- diagnostic only.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
