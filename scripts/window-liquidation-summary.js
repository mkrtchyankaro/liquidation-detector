// Sep 20 2026 (Karo), operator-requested.
//
//   node scripts/window-liquidation-summary.js "2026-09-20 02:15" "2026-09-20 03:03"
//
// Self-contained (no project imports -- written while the operator's
// local repo checkout was unavailable, per that turn's own explicit
// note. Only dependency: `mongodb`, already a project dependency, and
// Node 20's native `fetch`.)
//
// For EVERY configured symbol, over the given UTC window:
//   - first/last liquidation event timestamp WITHIN the window (from
//     liq_raw_events), total liquidation USD, event count
//   - Open Interest at window start and window end (nearest
//     oi_second_observations sample AT OR BEFORE each boundary --
//     never a future sample, never interpolated), OI delta
//     (contracts) and delta %
//   - Futures price at window start/end (Binance Futures public
//     historical klines, 1m interval -- no auth needed)
//   - Spot price at window start/end (Binance Spot public historical
//     klines, 1m interval -- no auth needed; no persisted Spot price
//     history exists in this project yet, so this is fetched fresh
//     every run)
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

function parseArgTime(s) {
  // Accepts "YYYY-MM-DD HH:mm" (assumed UTC) or any Date-parseable string.
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

function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined) return "N/A";
  return n.toFixed(decimals);
}

function fmtPct(n) {
  if (n === null || n === undefined) return "N/A";
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
}

function fmtTime(d) {
  if (d === null || d === undefined) return "N/A";
  return new Date(d).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** Nearest OI sample AT OR BEFORE targetMs. Never a future sample. */
async function nearestOiBefore(col, symbol, targetMs) {
  const doc = await col
    .find({ symbol, timestamp: { $lte: new Date(targetMs) } })
    .sort({ timestamp: -1 })
    .limit(1)
    .next();
  if (!doc) return null;
  return { contracts: doc.openInterest, timestamp: doc.timestamp.getTime() };
}

/** Binance historical klines (public, no auth). interval "1m".
 *  Returns the CLOSE price of the candle whose open time is <= targetMs
 *  and closest to it (never a future candle). */
async function nearestKlineClose(baseUrl, symbol, targetMs) {
  // Fetch a small window ending at targetMs so the last candle
  // returned is guaranteed to be at-or-before targetMs.
  const url = `${baseUrl}?symbol=${symbol}&interval=1m&endTime=${targetMs}&limit=2`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  // Kline row: [openTime, open, high, low, close, volume, closeTime, ...]
  return { close: Number(last[4]), openTime: last[0] };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      'Usage: node scripts/window-liquidation-summary.js "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm"  (UTC)',
    );
    process.exit(1);
  }
  const windowStart = parseArgTime(args[0]);
  const windowEnd = parseArgTime(args[1]);
  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();
  if (windowEndMs <= windowStartMs)
    throw new Error("End time must be after start time");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set in environment/.env");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(100));
  console.log(
    `WINDOW LIQUIDATION SUMMARY -- ${fmtTime(windowStartMs)}  to  ${fmtTime(windowEndMs)}`,
  );
  console.log("=".repeat(100));

  for (const symbol of SYMBOLS) {
    const events = await liqCol
      .find({ symbol, timestamp: { $gte: windowStartMs, $lte: windowEndMs } })
      .sort({ timestamp: 1 })
      .toArray();

    console.log(`\n${"-".repeat(100)}\n${symbol}\n${"-".repeat(100)}`);

    if (events.length === 0) {
      console.log("  No liquidations in this window.");
      continue;
    }

    const totalUsd = events.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const longUsd = events
      .filter((e) => e.victim === "LONG")
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const shortUsd = events
      .filter((e) => e.victim === "SHORT")
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const firstTs = events[0].timestamp;
    const lastTs = events[events.length - 1].timestamp;

    console.log(
      `  Liquidation start (first event in window): ${fmtTime(firstTs)}`,
    );
    console.log(
      `  Liquidation end   (last event in window):  ${fmtTime(lastTs)}`,
    );
    console.log(
      `  Total liquidation USD: ${fmtUsd(totalUsd)}  (LONG victims ${fmtUsd(longUsd)} / SHORT victims ${fmtUsd(shortUsd)})  across ${events.length} event(s)`,
    );

    // Open Interest at window boundaries (never a future sample).
    const [oiStart, oiEnd] = await Promise.all([
      nearestOiBefore(oiCol, symbol, windowStartMs),
      nearestOiBefore(oiCol, symbol, windowEndMs),
    ]);
    if (oiStart && oiEnd) {
      const oiDelta = oiEnd.contracts - oiStart.contracts;
      const oiDeltaPct =
        oiStart.contracts !== 0 ? (oiDelta / oiStart.contracts) * 100 : null;
      console.log(
        `  OI at window start: ${fmtNum(oiStart.contracts, 2)} contracts (sample at ${fmtTime(oiStart.timestamp)})`,
      );
      console.log(
        `  OI at window end:   ${fmtNum(oiEnd.contracts, 2)} contracts (sample at ${fmtTime(oiEnd.timestamp)})`,
      );
      console.log(
        `  OI delta: ${oiDelta >= 0 ? "+" : ""}${fmtNum(oiDelta, 2)} contracts (${fmtPct(oiDeltaPct)})`,
      );
    } else {
      console.log(
        "  OI: N/A (no oi_second_observations sample at-or-before one or both boundaries)",
      );
    }

    // Futures price at window boundaries (Binance Futures public klines).
    const [futStart, futEnd] = await Promise.all([
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
    ]);
    if (futStart && futEnd) {
      const futChangePct =
        futStart.close !== 0
          ? ((futEnd.close - futStart.close) / futStart.close) * 100
          : null;
      console.log(
        `  Futures price at window start: ${fmtNum(futStart.close, 6)}`,
      );
      console.log(
        `  Futures price at window end:   ${fmtNum(futEnd.close, 6)}  (${fmtPct(futChangePct)})`,
      );
    } else {
      console.log("  Futures price: N/A (kline fetch failed)");
    }

    // Spot price at window boundaries (Binance Spot public klines).
    const [spotStart, spotEnd] = await Promise.all([
      nearestKlineClose(
        "https://api.binance.com/api/v3/klines",
        symbol,
        windowStartMs,
      ),
      nearestKlineClose(
        "https://api.binance.com/api/v3/klines",
        symbol,
        windowEndMs,
      ),
    ]);
    if (spotStart && spotEnd) {
      const spotChangePct =
        spotStart.close !== 0
          ? ((spotEnd.close - spotStart.close) / spotStart.close) * 100
          : null;
      console.log(
        `  Spot price at window start:    ${fmtNum(spotStart.close, 6)}`,
      );
      console.log(
        `  Spot price at window end:      ${fmtNum(spotEnd.close, 6)}  (${fmtPct(spotChangePct)})`,
      );
    } else {
      console.log(
        "  Spot price: N/A (kline fetch failed -- symbol may not have a Spot market)",
      );
    }
  }

  console.log(`\n${"=".repeat(100)}`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
