// Sep 20 2026 (Karo), operator-requested.
//
//   node scripts/btc-lag-velocity-analysis.js "2026-09-20 02:15" "2026-09-20 03:03"
//
// Self-contained (same constraints as window-liquidation-summary.js --
// no project imports, only `mongodb` + Node's native `fetch`).
//
// For the given UTC window:
//   1. BTC's own early velocity: liquidation $/sec and OI change/sec
//      in the first 60s after BTC's OWN first liquidation event in
//      this window.
//   2. For every other symbol: LAG = seconds between BTC's first
//      liquidation event and that symbol's own first liquidation
//      event in the window, plus that symbol's own total liq USD,
//      price change %, and OI change % (window start -> end, Futures
//      only -- Spot dropped per the operator's own note that a 1m
//      boundary candle says nothing meaningful during a fast cascade).
//
// This is a SINGLE-EPISODE illustrative look, not a backtest across
// many episodes -- correlation here is suggestive, not proof.
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
const LEAD_SYMBOL = "BTCUSDT";
const EARLY_WINDOW_SEC = 60;

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
  return new Date(ms).toISOString().replace("T", " ").slice(11, 19) + "Z";
}

async function nearestOiBefore(col, symbol, targetMs) {
  const doc = await col
    .find({ symbol, timestamp: { $lte: new Date(targetMs) } })
    .sort({ timestamp: -1 })
    .limit(1)
    .next();
  return doc ? doc.openInterest : null;
}

async function nearestKlineClose(baseUrl, symbol, targetMs) {
  const url = `${baseUrl}?symbol=${symbol}&interval=1m&endTime=${targetMs}&limit=2`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return Number(rows[rows.length - 1][4]);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      'Usage: node scripts/btc-lag-velocity-analysis.js "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm"  (UTC)',
    );
    process.exit(1);
  }
  const windowStartMs = parseArgTime(args[0]).getTime();
  const windowEndMs = parseArgTime(args[1]).getTime();
  if (windowEndMs <= windowStartMs)
    throw new Error("End time must be after start time");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set in environment/.env");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  const allEvents = await liqCol
    .find({
      symbol: { $in: SYMBOLS },
      timestamp: { $gte: windowStartMs, $lte: windowEndMs },
    })
    .sort({ timestamp: 1 })
    .toArray();

  const bySymbol = new Map(SYMBOLS.map((s) => [s, []]));
  for (const e of allEvents) bySymbol.get(e.symbol)?.push(e);

  const leadEvents = bySymbol.get(LEAD_SYMBOL) ?? [];
  if (leadEvents.length === 0) {
    console.log(
      `No ${LEAD_SYMBOL} liquidations in this window -- nothing to lag against.`,
    );
    await client.close();
    return;
  }
  const leadStartMs = leadEvents[0].timestamp;

  console.log("=".repeat(100));
  console.log(
    `${LEAD_SYMBOL} LAG / VELOCITY ANALYSIS -- window ${fmtTime(windowStartMs)} to ${fmtTime(windowEndMs)}  (single episode, illustrative only)`,
  );
  console.log("=".repeat(100));

  const leadEarlyEndMs = leadStartMs + EARLY_WINDOW_SEC * 1000;
  const leadEarlyEvents = leadEvents.filter(
    (e) => e.timestamp <= leadEarlyEndMs,
  );
  const leadEarlyUsd = leadEarlyEvents.reduce(
    (a, e) => a + (e.quoteQty ?? 0),
    0,
  );
  const [leadOiAtStart, leadOiAtEarlyEnd] = await Promise.all([
    nearestOiBefore(oiCol, LEAD_SYMBOL, leadStartMs),
    nearestOiBefore(oiCol, LEAD_SYMBOL, leadEarlyEndMs),
  ]);
  const leadOiDeltaPerSec =
    leadOiAtStart !== null && leadOiAtEarlyEnd !== null
      ? (leadOiAtEarlyEnd - leadOiAtStart) / EARLY_WINDOW_SEC
      : null;

  console.log(
    `\n${LEAD_SYMBOL} own first liquidation: ${fmtTime(leadStartMs)}`,
  );
  console.log(
    `${LEAD_SYMBOL} early velocity (first ${EARLY_WINDOW_SEC}s): ${fmtUsd(leadEarlyUsd)} liquidated (${fmtUsd(leadEarlyUsd / EARLY_WINDOW_SEC)}/sec), ${leadEarlyEvents.length} event(s)`,
  );
  console.log(
    `${LEAD_SYMBOL} OI velocity (same window): ${leadOiDeltaPerSec !== null ? `${leadOiDeltaPerSec >= 0 ? "+" : ""}${leadOiDeltaPerSec.toFixed(2)} contracts/sec` : "N/A"}`,
  );

  console.log(`\n${"-".repeat(100)}`);
  console.log(
    "SYMBOL      LAG vs BTC   OWN TOTAL USD   EVENTS   PRICE CHANGE   OI CHANGE",
  );
  console.log("-".repeat(100));

  const rows = [];
  for (const symbol of SYMBOLS) {
    if (symbol === LEAD_SYMBOL) continue;
    const events = bySymbol.get(symbol) ?? [];
    if (events.length === 0) {
      console.log(`${symbol.padEnd(11)} no liquidations in this window`);
      continue;
    }
    const ownStartMs = events[0].timestamp;
    const lagSec = (ownStartMs - leadStartMs) / 1000;
    const totalUsd = events.reduce((a, e) => a + (e.quoteQty ?? 0), 0);

    const [futStart, futEnd, oiStart, oiEnd] = await Promise.all([
      nearestKlineClose(
        "https://fapi.binance.com/fapi/v1/klines",
        symbol,
        windowStartMs,
      ),
      nearestKlineClose(
        "https://fapi.binance.com/fapi/v1/klines",
        symbol,
        windowEndMs,
      ),
      nearestOiBefore(oiCol, symbol, windowStartMs),
      nearestOiBefore(oiCol, symbol, windowEndMs),
    ]);
    const priceChangePct =
      futStart !== null && futEnd !== null && futStart !== 0
        ? ((futEnd - futStart) / futStart) * 100
        : null;
    const oiChangePct =
      oiStart !== null && oiEnd !== null && oiStart !== 0
        ? ((oiEnd - oiStart) / oiStart) * 100
        : null;

    rows.push({
      symbol,
      lagSec,
      totalUsd,
      eventCount: events.length,
      priceChangePct,
      oiChangePct,
    });
    console.log(
      `${symbol.padEnd(11)} ${(lagSec >= 0 ? "+" : "") + lagSec.toFixed(0) + "s"}`.padEnd(
        24,
      ) +
        `${fmtUsd(totalUsd)}`.padEnd(16) +
        `${events.length}`.padEnd(9) +
        `${fmtPct(priceChangePct)}`.padEnd(15) +
        `${fmtPct(oiChangePct)}`,
    );
  }

  console.log(`\n${"-".repeat(100)}`);
  console.log("Sorted by lag (fastest-following first):");
  rows.sort((a, b) => a.lagSec - b.lagSec);
  for (const r of rows) {
    console.log(
      `  ${r.symbol.padEnd(10)} lag=${(r.lagSec >= 0 ? "+" : "") + r.lagSec.toFixed(0)}s  price=${fmtPct(r.priceChangePct)}  OI=${fmtPct(r.oiChangePct)}`,
    );
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(
    "NOTE: single episode, illustrative only -- not a backtest. A real lag/velocity->magnitude",
  );
  console.log(
    "relationship needs this same analysis run across many BTC-led episodes before trusting it.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
