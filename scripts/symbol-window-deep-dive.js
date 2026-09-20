// Sep 20 2026 (Karo), operator-requested. Deep-dive reconstruction for
// ONE symbol over ONE window: merges Spot klines, Futures klines, OI
// history (from oi_second_observations), every raw liquidation event,
// and any overlapping Episode Research document boundaries into a
// single chronological timeline -- so turning points in price can be
// checked against OI and liquidation activity at the same moment.
//
//   node scripts/symbol-window-deep-dive.js LINKUSDT "2026-09-20 08:00" "2026-09-20 10:14"
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. Kline
// fetches are throttled to avoid the rate-limit failure seen earlier
// in this session.

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

function hhmm(ms) {
  return new Date(ms).toISOString().slice(11, 19) + "Z";
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
  return `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchKlines(baseUrl, symbol, startMs, endMs) {
  const url = `${baseUrl}?symbol=${symbol}&interval=1m&startTime=${Math.round(startMs)}&endTime=${Math.round(endMs)}&limit=1000`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status === 418) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({
      openTimeMs: r[0],
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      closeTimeMs: r[6],
    }));
  }
  return [];
}

async function main() {
  const symbol = process.argv[2];
  const startArg = process.argv[3];
  const endArg = process.argv[4];
  if (!symbol || !startArg || !endArg) {
    console.error(
      'Usage: node scripts/symbol-window-deep-dive.js <SYMBOL> "YYYY-MM-DD HH:mm" "YYYY-MM-DD HH:mm"  (UTC)',
    );
    process.exit(1);
  }
  const windowStartMs = parseArgTime(startArg).getTime();
  const windowEndMs = parseArgTime(endArg).getTime();
  if (windowEndMs <= windowStartMs)
    throw new Error("End time must be after start time");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");
  const researchCol = ownDb.collection("liquidation_oi_episode_research");

  console.log("=".repeat(120));
  console.log(
    `DEEP DIVE -- ${symbol} -- ${isoUtc(windowStartMs)} to ${isoUtc(windowEndMs)}`,
  );
  console.log(
    "Merges: Futures 1m klines, Spot 1m klines, OI history, every raw liquidation event, Episode Research boundaries.",
  );
  console.log("=".repeat(120));

  console.log("\nFetching klines...");
  const futuresKlines = await fetchKlines(
    "https://fapi.binance.com/fapi/v1/klines",
    symbol,
    windowStartMs,
    windowEndMs,
  );
  await sleep(200);
  const spotKlines = await fetchKlines(
    "https://api.binance.com/api/v3/klines",
    symbol,
    windowStartMs,
    windowEndMs,
  );

  const oiDocs = await oiCol
    .find({
      symbol,
      timestamp: { $gte: new Date(windowStartMs), $lte: new Date(windowEndMs) },
    })
    .project({ timestamp: 1, openInterest: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  const liqEvents = await liqCol
    .find({ symbol, timestamp: { $gte: windowStartMs, $lte: windowEndMs } })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  const researchDocs = await researchCol
    .find({
      symbol,
      $or: [
        {
          "episodeStartSnapshot.ts": { $gte: windowStartMs, $lte: windowEndMs },
        },
        { createdAtMs: { $gte: windowStartMs, $lte: windowEndMs } },
        { updatedAtMs: { $gte: windowStartMs, $lte: windowEndMs } },
      ],
    })
    .sort({ createdAtMs: 1 })
    .toArray();

  console.log(
    `Loaded: ${futuresKlines.length} futures candle(s), ${spotKlines.length} spot candle(s), ${oiDocs.length} OI observation(s), ${liqEvents.length} liquidation event(s), ${researchDocs.length} Episode Research doc(s).\n`,
  );

  if (researchDocs.length > 0) {
    console.log("=".repeat(120));
    console.log("EPISODE RESEARCH DOCUMENTS OVERLAPPING THIS WINDOW");
    console.log("=".repeat(120));
    for (const doc of researchDocs) {
      const entered =
        doc.entrySnapshot !== null && doc.entrySnapshot !== undefined;
      console.log(
        `\n${doc.episodeId}  victim=${doc.victim}  entered=${entered}  endReason=${doc.endReason ?? "N/A"}  noEntryReason=${doc.noEntryReason ?? "N/A"}`,
      );
      console.log(
        `  episodeStart: ${doc.episodeStartSnapshot ? hhmm(doc.episodeStartSnapshot.ts) : "N/A"}  price=${doc.episodeStartSnapshot?.price ?? "N/A"}`,
      );
      if (doc.finalExtremeSnapshot)
        console.log(
          `  finalExtreme: ${hhmm(doc.finalExtremeSnapshot.ts)}  price=${doc.finalExtremeSnapshot.price}  OI=${doc.finalExtremeSnapshot.oi?.oiValue ?? "N/A"}`,
        );
      const endSnap = entered ? doc.entrySnapshot : doc.episodeEndSnapshot;
      if (endSnap)
        console.log(
          `  ${entered ? "entry" : "end"}: ${hhmm(endSnap.ts)}  price=${endSnap.price}  OI=${endSnap.oi?.oiValue ?? "N/A"}`,
        );
      if (doc.flushFlow) {
        console.log(
          `  FLUSH: Spot BUY ${fmtUsd(doc.flushFlow.spotBuyUsd)} / SELL ${fmtUsd(doc.flushFlow.spotSellUsd)}   Futures BUY ${fmtUsd(doc.flushFlow.futuresBuyUsd)} / SELL ${fmtUsd(doc.flushFlow.futuresSellUsd)}   OI% ${fmtPct(doc.flushFlow.oiDeltaPct)}`,
        );
      }
      if (doc.recoveryFlow) {
        console.log(
          `  RECOVERY: Spot BUY ${fmtUsd(doc.recoveryFlow.spotBuyUsd)} / SELL ${fmtUsd(doc.recoveryFlow.spotSellUsd)}   Futures BUY ${fmtUsd(doc.recoveryFlow.futuresBuyUsd)} / SELL ${fmtUsd(doc.recoveryFlow.futuresSellUsd)}   OI% ${fmtPct(doc.recoveryFlow.oiDeltaPct)}`,
        );
      }
    }
    console.log("");
  }

  console.log("=".repeat(120));
  console.log(
    "MINUTE-BY-MINUTE TIMELINE (Futures close / Spot close / OI at-or-before / liquidation $ that minute)",
  );
  console.log("=".repeat(120));
  console.log(
    "TIME      FUTURES     SPOT        OI (nearest<=)      LIQ $ this min   events   LONG$/SHORT$",
  );
  console.log("-".repeat(120));

  const futByMinute = new Map(futuresKlines.map((k) => [k.openTimeMs, k]));
  const spotByMinute = new Map(spotKlines.map((k) => [k.openTimeMs, k]));

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
    const fut = futByMinute.get(m);
    const spot = spotByMinute.get(m);
    const oi = nearestOiAtOrBefore(m + 59999);
    const eventsThisMin = liqEvents.filter(
      (e) => e.timestamp >= m && e.timestamp < m + 60000,
    );
    const liqUsd = eventsThisMin.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const longUsd = eventsThisMin
      .filter((e) => e.victim === "LONG")
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const shortUsd = eventsThisMin
      .filter((e) => e.victim === "SHORT")
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);

    const marker = eventsThisMin.length > 0 ? " *" : "";
    console.log(
      `${hhmm(m).slice(0, 8)}  ${fut ? fut.close.toFixed(5).padEnd(11) : "N/A".padEnd(11)} ${spot ? spot.close.toFixed(5).padEnd(11) : "N/A".padEnd(11)} ${(oi ? oi.openInterest.toFixed(2) : "N/A").padEnd(20)} ${fmtUsd(liqUsd).padEnd(16)} ${String(eventsThisMin.length).padEnd(8)} ${fmtUsd(longUsd)}/${fmtUsd(shortUsd)}${marker}`,
    );
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(`EVERY LIQUIDATION EVENT (${liqEvents.length} total)`);
  console.log("=".repeat(120));
  for (const e of liqEvents) {
    console.log(
      `  ${hhmm(e.timestamp)}  price=${e.price}  victim=${e.victim}  usd=${fmtUsd(e.quoteQty)}`,
    );
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(
    "NOTE: '*' marks a minute with liquidation activity. OI column uses the nearest observation AT-OR-BEFORE",
  );
  console.log(
    "the end of that minute (oi_second_observations). Klines are Binance's own OHLC; close price shown here",
  );
  console.log(
    "is that candle's close (i.e. price at the end of that minute). All times UTC. Read-only -- no writes.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
