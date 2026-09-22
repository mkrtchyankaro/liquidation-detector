// FOUR EXACT EPISODES -- USD-ONLY OI TIMELINE. Historical MongoDB
// only, no live connections, no theory, minimal columns per operator
// instruction.
//
// Uses the stored `openInterestUsd` field from oi_second_observations
// (NOT the raw contract-count `openInterest` field), time-aligned to
// each liquidation event (nearest OI observation strictly at-or-
// before the event's own timestamp -- never future OI).
//
//   node scripts/four-episodes-oi-usd-simple.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EPISODES = [
  {
    num: 31,
    startMs: Date.parse("2026-09-20T02:24:27.128Z"),
    endMs: Date.parse("2026-09-20T02:36:15.129Z"),
  },
  {
    num: 32,
    startMs: Date.parse("2026-09-20T02:39:21.185Z"),
    endMs: Date.parse("2026-09-20T02:45:58.188Z"),
  },
  {
    num: 33,
    startMs: Date.parse("2026-09-20T02:54:09.182Z"),
    endMs: Date.parse("2026-09-20T03:02:37.147Z"),
  },
  {
    num: 34,
    startMs: Date.parse("2026-09-20T03:14:42.177Z"),
    endMs: Date.parse("2026-09-20T03:16:19.199Z"),
  },
];

function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}
function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  async function nearestOiUsdAtOrBefore(targetMs) {
    const doc = await oiCol
      .find({ symbol: SYMBOL, timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    if (!doc) return null;
    if (doc.openInterestUsd === undefined) return { missing: true };
    return { missing: false, value: doc.openInterestUsd };
  }

  for (const ep of EPISODES) {
    console.log(
      `\nEPISODE ${ep.num}: ${isoUtc(ep.startMs)} -> ${isoUtc(ep.endMs)}`,
    );
    console.log("-".repeat(50));

    const events = await liqCol
      .find({ symbol: SYMBOL, timestamp: { $gte: ep.startMs, $lte: ep.endMs } })
      .project({ timestamp: 1, quoteQty: 1 })
      .sort({ timestamp: 1 })
      .toArray();

    if (events.length === 0) {
      console.log("NO EVENTS FOUND.");
      continue;
    }

    console.log("#  | TIME     | LIQUIDATION | OI USD   | ΔOI USD");
    console.log("-".repeat(50));

    let prevOiUsd = null;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const oi = await nearestOiUsdAtOrBefore(e.timestamp);

      let oiCell = "N/A";
      let deltaCell = "—";
      if (oi && oi.missing) {
        oiCell = "FIELD NOT STORED";
      } else if (oi && !oi.missing) {
        oiCell = fmtUsd(oi.value);
        if (prevOiUsd !== null) deltaCell = fmtUsd(oi.value - prevOiUsd);
        prevOiUsd = oi.value;
      }

      console.log(
        `${String(i + 1).padStart(2)} | ${hhmmss(e.timestamp)} | ${fmtUsd(e.quoteQty).padEnd(11)} | ${oiCell.padEnd(8)} | ${deltaCell}`,
      );
    }
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
