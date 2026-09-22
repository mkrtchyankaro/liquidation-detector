// FOUR EXACT EPISODES -- USD-ONLY OI TIMELINE, v2. Historical MongoDB
// only. Adds ΔOI FROM START and TIME FROM PREV, plus a simple
// per-episode summary. All deltas computed from RAW (unrounded)
// openInterestUsd values -- rounding happens only at display time.
//
//   node scripts/four-episodes-oi-usd-v2.js
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
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
function fmtUsdPlain(n) {
  // Same as fmtUsd but no forced +, used for absolute quantities (LIQ, OI level, start/end).
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}
function fmtSec(ms) {
  return `${(ms / 1000).toFixed(0)}s`;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  async function rawOiUsdAtOrBefore(targetMs) {
    const doc = await oiCol
      .find({ symbol: SYMBOL, timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    if (!doc) return null;
    if (doc.openInterestUsd === undefined) return null;
    return doc.openInterestUsd; // RAW, unrounded value -- all math below uses this directly.
  }

  for (const ep of EPISODES) {
    console.log(
      `\nEPISODE ${ep.num}: ${isoUtc(ep.startMs)} -> ${isoUtc(ep.endMs)}`,
    );
    console.log("-".repeat(90));

    const events = await liqCol
      .find({ symbol: SYMBOL, timestamp: { $gte: ep.startMs, $lte: ep.endMs } })
      .project({ timestamp: 1, quoteQty: 1 })
      .sort({ timestamp: 1 })
      .toArray();

    if (events.length === 0) {
      console.log("NO EVENTS FOUND.");
      continue;
    }

    console.log(
      "#  | TIME     | LIQ USD | OI USD | ΔOI FROM PREV | ΔOI FROM START | TIME FROM PREV",
    );
    console.log("-".repeat(90));

    let totalLiq = 0;
    let prevOiRaw = null; // raw OI USD of the previous event (for FROM PREV)
    let startOiRaw = null; // raw OI USD of the FIRST valid OI observation in this episode (for FROM START)
    let prevTsMs = null;
    let minOi = null,
      maxOi = null;
    let firstOiRaw = null,
      lastOiRaw = null;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      totalLiq += e.quoteQty ?? 0;
      const oiRaw = await rawOiUsdAtOrBefore(e.timestamp);

      let oiCell = "N/A";
      let fromPrevCell = "—";
      let fromStartCell = "—";
      let fromPrevTimeCell =
        prevTsMs === null ? "—" : fmtSec(e.timestamp - prevTsMs);

      if (oiRaw !== null) {
        oiCell = fmtUsdPlain(oiRaw);
        lastOiRaw = oiRaw;
        if (firstOiRaw === null) firstOiRaw = oiRaw;
        minOi = minOi === null ? oiRaw : Math.min(minOi, oiRaw);
        maxOi = maxOi === null ? oiRaw : Math.max(maxOi, oiRaw);

        if (startOiRaw === null) {
          startOiRaw = oiRaw; // this IS the first valid OI observation of the episode
          fromStartCell = "$0";
        } else {
          fromStartCell = fmtUsd(oiRaw - startOiRaw);
        }

        if (prevOiRaw !== null) {
          fromPrevCell = fmtUsd(oiRaw - prevOiRaw);
        }
        prevOiRaw = oiRaw;
      }

      prevTsMs = e.timestamp;

      console.log(
        `${String(i + 1).padStart(2)} | ${hhmmss(e.timestamp)} | ${fmtUsdPlain(e.quoteQty).padEnd(7)} | ${oiCell.padEnd(6)} | ${fromPrevCell.padEnd(13)} | ${fromStartCell.padEnd(14)} | ${fromPrevTimeCell}`,
      );
    }

    console.log("-".repeat(90));
    console.log("EPISODE SUMMARY");
    console.log("");
    console.log(`Total liquidation: ${fmtUsdPlain(totalLiq)}`);
    console.log(
      `Start OI: ${firstOiRaw !== null ? fmtUsdPlain(firstOiRaw) : "N/A"}`,
    );
    console.log(
      `End OI: ${lastOiRaw !== null ? fmtUsdPlain(lastOiRaw) : "N/A"}`,
    );
    if (firstOiRaw !== null && lastOiRaw !== null) {
      const change = lastOiRaw - firstOiRaw;
      const changePct = firstOiRaw !== 0 ? (change / firstOiRaw) * 100 : null;
      console.log(`TOTAL OI CHANGE: ${fmtUsd(change)}`);
      console.log(
        `TOTAL OI CHANGE %: ${changePct !== null ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "N/A"}`,
      );
    } else {
      console.log(`TOTAL OI CHANGE: N/A`);
      console.log(`TOTAL OI CHANGE %: N/A`);
    }
    console.log(`Maximum OI: ${maxOi !== null ? fmtUsdPlain(maxOi) : "N/A"}`);
    console.log(`Minimum OI: ${minOi !== null ? fmtUsdPlain(minOi) : "N/A"}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
