// Sep 20 2026 (Karo), operator-requested REDESIGN #2. TEST/RESEARCH
// ONLY -- reads data, prints analysis, never touches live strategy or
// trading logic.
//
//   node scripts/synchronized-stress-analysis-v2.js "2026-09-20 02:15" "2026-09-20 03:03"
//
// CHANGES FROM v1, per the operator's own explicit correction:
//   1. FIXED THE MEDIAN BUG: v1's running median was computed over
//      ALL history including long silent stretches (mostly zeros), so
//      it stayed at $0 and "3x median" degenerated into "first event
//      past the flat $ floor" -- not a real acceleration signal. Now
//      the baseline is the median of NON-ZERO trailing-window
//      readings only (the actual "typical active moment" for that
//      symbol), falling back to 0 only while a symbol has had zero
//      activity for its entire history so far.
//   2. REMOVED the fixed +-15s confirmation window and treats onset
//      detection as open-ended in time. Per the operator's own
//      instruction: a real cascade can take 10 seconds or 25 minutes
//      to become undeniable market-wide, and forcing a short fixed
//      window misses slow-building ones entirely (as v1's own run on
//      this exact episode showed -- a real ~1-hour drawdown, not a
//      burst).
//   3. NEW CASCADE-CONFIRMATION MODEL: each symbol's own onset time is
//      still detected independently. Market-wide "cascade confirmed"
//      is the moment the QUORUM-th symbol (sorted by its own onset
//      time) reaches its own onset -- i.e. "this many independent
//      symbols have now shown their own acceleration; call it real."
//      Every symbol's LAG is reported relative to THAT moment:
//        lag < 0 -> this symbol helped establish the cascade (leader)
//        lag > 0 -> this symbol accelerated only AFTER the market was
//                   already confirmed -- by the time it moved,
//                   confidence was already high. These answer the
//                   operator's own question: would we have been late,
//                   or still in time, for this symbol.
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

const BUCKET_SEC = 10; // resolution only -- NOT a cap on how long onset detection can take
const TRAILING_SEC = 60; // smoothing window before onset detection
const TRAILING_BUCKETS = Math.round(TRAILING_SEC / BUCKET_SEC);
const ONSET_MULTIPLE = 3;
const MIN_ONSET_USD = 500;
const CASCADE_QUORUM = 6; // how many symbols must onset before we call it market-wide confirmed
const FORWARD_HORIZONS_SEC = [60, 300, 900]; // +1m, +5m, +15m -- wider horizons for a slower episode

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

function fmtDuration(sec) {
  const sign = sec < 0 ? "-" : "+";
  const abs = Math.abs(sec);
  if (abs < 90) return `${sign}${abs.toFixed(0)}s`;
  return `${sign}${(abs / 60).toFixed(1)}m`;
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
      'Usage: node scripts/synchronized-stress-analysis-v2.js "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm"  (UTC)',
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

  console.log("=".repeat(112));
  console.log(
    "PER-EVENT OI DELTA SUMMARY (is leverage actually clearing, event by event?)",
  );
  console.log("=".repeat(112));
  console.log(
    "SYMBOL      EVENTS   OI DOWN   OI UP   OI FLAT/N-A   NET OI DELTA (contracts)",
  );
  console.log("-".repeat(112));
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
    const nonZeroHistory = [];
    for (let idx = 0; idx < numBuckets; idx++) {
      const trailing = trailingAt(symbol, idx);
      const baseline = nonZeroHistory.length > 0 ? median(nonZeroHistory) : 0;
      const threshold = Math.max(MIN_ONSET_USD, ONSET_MULTIPLE * baseline);
      if (trailing >= threshold && trailing > 0) {
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
          baseline,
          anchorPrice,
        });
        break;
      }
      if (trailing > 0) nonZeroHistory.push(trailing);
    }
  }
  onsets.sort((a, b) => a.onsetMs - b.onsetMs);

  console.log(`\n${"=".repeat(112)}`);
  console.log(
    `ONSET DETECTION (trailing ${TRAILING_SEC}s $ >= max(${fmtUsd(MIN_ONSET_USD)}, ${ONSET_MULTIPLE}x own non-zero median) -- no fixed time cap)`,
  );
  console.log("=".repeat(112));
  if (onsets.length === 0) {
    console.log("No symbol crossed its own onset threshold in this window.");
  }
  for (const o of onsets) {
    console.log(
      `  ${o.symbol.padEnd(10)} onset at ${fmtTime(o.onsetMs)}  (${((o.onsetMs - windowStartMs) / 60000).toFixed(1)}m into window)  trailing-${TRAILING_SEC}s=${fmtUsd(o.trailingUsd)}  own non-zero median=${fmtUsd(o.baseline)}`,
    );
  }

  let cascadeConfirmedAt = null;
  let cascadeConfirmedBy = null;
  if (onsets.length >= CASCADE_QUORUM) {
    cascadeConfirmedAt = onsets[CASCADE_QUORUM - 1].onsetMs;
    cascadeConfirmedBy = onsets[CASCADE_QUORUM - 1].symbol;
  }

  console.log(`\n${"=".repeat(112)}`);
  console.log(
    `CASCADE CONFIRMATION (quorum = ${CASCADE_QUORUM} of ${SYMBOLS.length} symbols must have shown their own onset)`,
  );
  console.log("=".repeat(112));
  if (cascadeConfirmedAt === null) {
    console.log(
      `Only ${onsets.length}/${SYMBOLS.length} symbols reached onset in this window -- quorum of ${CASCADE_QUORUM} never reached. Cascade NOT confirmed market-wide.`,
    );
  } else {
    console.log(
      `Cascade CONFIRMED at ${fmtTime(cascadeConfirmedAt)} (${((cascadeConfirmedAt - windowStartMs) / 60000).toFixed(1)}m into window) -- the ${CASCADE_QUORUM}th symbol to onset was ${cascadeConfirmedBy}.`,
    );
    console.log(
      "\nPer-symbol lag vs that confirmed moment (negative = helped establish it / leader; positive = accelerated only AFTER confirmation / late-but-confirmed):",
    );
    for (const o of onsets) {
      const lagSec = (o.onsetMs - cascadeConfirmedAt) / 1000;
      console.log(
        `  ${o.symbol.padEnd(10)} lag=${fmtDuration(lagSec).padEnd(8)} own onset=${fmtTime(o.onsetMs)}`,
      );
    }
  }

  console.log(`\n${"=".repeat(112)}`);
  console.log(
    "FORWARD RETURN FROM EACH SYMBOL'S OWN ONSET (Futures close price, at-or-before each horizon)",
  );
  console.log("=".repeat(112));
  console.log(
    `SYMBOL      LAG vs CASCADE   ANCHOR PRICE   ${FORWARD_HORIZONS_SEC.map((s) => (s >= 60 ? `+${s / 60}m` : `+${s}s`).padEnd(10)).join("")}`,
  );
  console.log("-".repeat(112));
  for (const o of onsets) {
    if (o.anchorPrice === null) {
      console.log(`${o.symbol.padEnd(11)} N/A`);
      continue;
    }
    const lagSec =
      cascadeConfirmedAt !== null
        ? (o.onsetMs - cascadeConfirmedAt) / 1000
        : null;
    const forwardPrices = await Promise.all(
      FORWARD_HORIZONS_SEC.map((s) =>
        nearestKlineClose(o.symbol, o.onsetMs + s * 1000),
      ),
    );
    const returns = forwardPrices.map((p) =>
      p !== null ? ((p - o.anchorPrice) / o.anchorPrice) * 100 : null,
    );
    console.log(
      `${o.symbol.padEnd(11)} ${(lagSec !== null ? fmtDuration(lagSec) : "N/A").padEnd(16)} ${o.anchorPrice.toFixed(6).padEnd(14)} ${returns.map((r) => fmtPct(r).padEnd(10)).join("")}`,
    );
  }

  console.log(`\n${"=".repeat(112)}`);
  console.log(
    "NOTE: single episode, illustrative only. ONSET_MULTIPLE/MIN_ONSET_USD/CASCADE_QUORUM/TRAILING_SEC",
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
