// Sep 20 2026 (Karo), operator-requested. TEST/RESEARCH ONLY -- reads
// data, prints analysis, never touches live strategy or trading logic.
//
//   node scripts/synchronized-stress-analysis.js "2026-09-20 02:15" "2026-09-20 03:03"
//
// Self-contained (no project imports -- only `mongodb` + Node's
// native `fetch`).
//
// WHAT THIS TESTS (operator's own hypothesis): a heavy, slow-moving
// symbol (BTC) is not necessarily the best "lead" signal -- its own
// inertia means ITS acceleration is often confirmation of a move
// already under way elsewhere. A lighter, faster symbol may show
// velocity onset FIRST. The question this script investigates: when
// ANY symbol's own liquidation velocity suddenly accelerates, does
// checking whether OTHER symbols are ALSO accelerating at the same
// moment ("confirmation") distinguish onsets that keep moving
// (momentum continuation) from onsets that don't (isolated/reverting)?
//
// METHOD:
//   1. Load every liquidation event for all 10 symbols in the window.
//      Each event already carries its own OI snapshot
//      (marketSnapshot.openInterest.openInterest) -- no extra query
//      needed for per-event OI delta.
//   2. Bucket into BUCKET_SEC-wide buckets, per symbol: liq $ sum,
//      event count, per-event OI delta (vs the immediately preceding
//      event of the SAME symbol).
//   3. ONSET per symbol = the first bucket where the trailing
//      TRAILING_SEC window's liq $ exceeds ONSET_MULTIPLE times that
//      symbol's OWN running median trailing-window $ up to that point
//      (adaptive per-symbol threshold -- no cross-episode history
//      needed, appropriate for a single-episode test).
//   4. CONFIRMATION at an onset = how many OTHER symbols also have an
//      elevated trailing window within CONFIRM_WINDOW_SEC of it.
//   5. FORWARD RETURN from each onset's own price, at +30s/+60s/+120s/
//      +300s (via Binance Futures historical klines, close price of
//      the nearest at-or-before candle).
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

const BUCKET_SEC = 10;
const TRAILING_SEC = 30;
const TRAILING_BUCKETS = Math.round(TRAILING_SEC / BUCKET_SEC);
const ONSET_MULTIPLE = 3;
const MIN_ONSET_USD = 500;
const CONFIRM_WINDOW_SEC = 15;
const FORWARD_HORIZONS_SEC = [30, 60, 120, 300];

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

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function nearestKlineClose(symbol, targetMs) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&endTime=${targetMs}&limit=2`;
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
      'Usage: node scripts/synchronized-stress-analysis.js "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm"  (UTC)',
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

  const rawEvents = await liqCol
    .find({
      symbol: { $in: SYMBOLS },
      timestamp: { $gte: windowStartMs, $lte: windowEndMs },
    })
    .project({
      symbol: 1,
      victim: 1,
      price: 1,
      quoteQty: 1,
      timestamp: 1,
      "marketSnapshot.openInterest.openInterest": 1,
    })
    .sort({ timestamp: 1 })
    .toArray();

  const eventsBySymbol = new Map(SYMBOLS.map((s) => [s, []]));
  const lastOiBySymbol = new Map();
  for (const e of rawEvents) {
    const oi = e.marketSnapshot?.openInterest?.openInterest ?? null;
    const prevOi = lastOiBySymbol.get(e.symbol) ?? null;
    const oiDelta = oi !== null && prevOi !== null ? oi - prevOi : null;
    if (oi !== null) lastOiBySymbol.set(e.symbol, oi);
    eventsBySymbol
      .get(e.symbol)
      .push({
        ts: e.timestamp,
        price: e.price,
        usd: e.quoteQty ?? 0,
        victim: e.victim,
        oi,
        oiDelta,
      });
  }

  console.log("=".repeat(110));
  console.log(
    "PER-EVENT OI DELTA SUMMARY (is leverage actually clearing, event by event?)",
  );
  console.log("=".repeat(110));
  console.log(
    "SYMBOL      EVENTS   OI DOWN   OI UP   OI FLAT/N-A   NET OI DELTA (contracts)",
  );
  console.log("-".repeat(110));
  for (const symbol of SYMBOLS) {
    const events = eventsBySymbol.get(symbol);
    if (events.length === 0) continue;
    const withDelta = events.filter((e) => e.oiDelta !== null);
    const down = withDelta.filter((e) => e.oiDelta < 0).length;
    const up = withDelta.filter((e) => e.oiDelta > 0).length;
    const flatOrNa = events.length - down - up;
    const netDelta = withDelta.reduce((a, e) => a + e.oiDelta, 0);
    console.log(
      `${symbol.padEnd(11)} ${String(events.length).padEnd(8)} ${String(down).padEnd(9)} ${String(up).padEnd(7)} ${String(flatOrNa).padEnd(13)} ${netDelta >= 0 ? "+" : ""}${netDelta.toFixed(2)}`,
    );
  }

  const numBuckets = Math.ceil(
    (windowEndMs - windowStartMs) / (BUCKET_SEC * 1000),
  );
  const bucketUsd = new Map(
    SYMBOLS.map((s) => [s, new Array(numBuckets).fill(0)]),
  );
  for (const symbol of SYMBOLS) {
    for (const e of eventsBySymbol.get(symbol)) {
      const idx = Math.floor((e.ts - windowStartMs) / (BUCKET_SEC * 1000));
      if (idx >= 0 && idx < numBuckets) bucketUsd.get(symbol)[idx] += e.usd;
    }
  }

  function trailingAt(symbol, idx) {
    const arr = bucketUsd.get(symbol);
    let sum = 0;
    for (let i = Math.max(0, idx - TRAILING_BUCKETS + 1); i <= idx; i++)
      sum += arr[i];
    return sum;
  }

  const onsets = [];
  for (const symbol of SYMBOLS) {
    const trailingHistory = [];
    for (let idx = 0; idx < numBuckets; idx++) {
      const trailing = trailingAt(symbol, idx);
      const runningMedian = median(
        trailingHistory.length > 0 ? trailingHistory : [0],
      );
      if (
        trailing >= MIN_ONSET_USD &&
        trailing >= ONSET_MULTIPLE * Math.max(runningMedian, 1)
      ) {
        const onsetMs = windowStartMs + idx * BUCKET_SEC * 1000;
        const priorEvents = eventsBySymbol
          .get(symbol)
          .filter((e) => e.ts <= onsetMs + BUCKET_SEC * 1000);
        const anchorPrice =
          priorEvents.length > 0
            ? priorEvents[priorEvents.length - 1].price
            : null;
        onsets.push({
          symbol,
          idx,
          onsetMs,
          trailingUsd: trailing,
          runningMedian,
          anchorPrice,
        });
        break;
      }
      trailingHistory.push(trailing);
    }
  }
  onsets.sort((a, b) => a.onsetMs - b.onsetMs);

  console.log(`\n${"=".repeat(110)}`);
  console.log(
    `ONSET DETECTION (trailing ${TRAILING_SEC}s $ >= ${ONSET_MULTIPLE}x own running median, floor ${fmtUsd(MIN_ONSET_USD)})`,
  );
  console.log("=".repeat(110));
  if (onsets.length === 0) {
    console.log("No symbol crossed its own onset threshold in this window.");
  }
  for (const o of onsets) {
    console.log(
      `  ${o.symbol.padEnd(10)} onset at ${fmtTime(o.onsetMs)}  trailing-${TRAILING_SEC}s=${fmtUsd(o.trailingUsd)} (own median was ${fmtUsd(o.runningMedian)})`,
    );
  }

  console.log(`\n${"=".repeat(110)}`);
  console.log(
    `CONFIRMATION (other symbols also elevated within +-${CONFIRM_WINDOW_SEC}s of each onset)`,
  );
  console.log("=".repeat(110));
  for (const o of onsets) {
    let confirmCount = 0;
    const confirmedSymbols = [];
    for (const other of SYMBOLS) {
      if (other === o.symbol) continue;
      const otherIdx = Math.floor(
        (o.onsetMs - windowStartMs) / (BUCKET_SEC * 1000),
      );
      const rangeBuckets = Math.ceil(CONFIRM_WINDOW_SEC / BUCKET_SEC);
      let elevated = false;
      let peakTrailing = 0;
      for (let j = 0; j < numBuckets; j++)
        peakTrailing = Math.max(peakTrailing, trailingAt(other, j));
      for (let di = -rangeBuckets; di <= rangeBuckets; di++) {
        const idx = otherIdx + di;
        if (idx < 0 || idx >= numBuckets) continue;
        const trailing = trailingAt(other, idx);
        if (
          peakTrailing > 0 &&
          trailing >= 0.5 * peakTrailing &&
          trailing >= MIN_ONSET_USD
        )
          elevated = true;
      }
      if (elevated) {
        confirmCount++;
        confirmedSymbols.push(other);
      }
    }
    o.confirmCount = confirmCount;
    o.confirmedSymbols = confirmedSymbols;
    console.log(
      `  ${o.symbol.padEnd(10)} confirmed by ${confirmCount}/${SYMBOLS.length - 1} other symbols: [${confirmedSymbols.join(", ") || "none"}]`,
    );
  }

  console.log(`\n${"=".repeat(110)}`);
  console.log(
    "FORWARD RETURN FROM ONSET (Futures close price, at-or-before each horizon)",
  );
  console.log("=".repeat(110));
  console.log(
    `SYMBOL      CONFIRM   ANCHOR PRICE   ${FORWARD_HORIZONS_SEC.map((s) => `+${s}s`.padEnd(10)).join("")}`,
  );
  console.log("-".repeat(110));
  for (const o of onsets) {
    if (o.anchorPrice === null) {
      console.log(
        `${o.symbol.padEnd(11)} ${String(o.confirmCount).padEnd(9)} N/A`,
      );
      continue;
    }
    const forwardPrices = await Promise.all(
      FORWARD_HORIZONS_SEC.map((s) =>
        nearestKlineClose(o.symbol, o.onsetMs + s * 1000),
      ),
    );
    const returns = forwardPrices.map((p) =>
      p !== null ? ((p - o.anchorPrice) / o.anchorPrice) * 100 : null,
    );
    console.log(
      `${o.symbol.padEnd(11)} ${String(o.confirmCount).padEnd(9)} ${o.anchorPrice.toFixed(6).padEnd(14)} ${returns.map((r) => fmtPct(r).padEnd(10)).join("")}`,
    );
  }

  console.log(`\n${"=".repeat(110)}`);
  console.log(
    "NOTE: single episode, illustrative only. Thresholds (ONSET_MULTIPLE, CONFIRM_WINDOW_SEC, MIN_ONSET_USD)",
  );
  console.log(
    "are UNTUNED guesses -- meaningful only once run across MANY episodes and compared against outcomes.",
  );
  console.log("This never touches live strategy or trading logic.");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
