// Sep 20 2026 (Karo). Decisive next step, per operator's explicit
// instruction to stop asking and propose one concrete thing: uses
// ONLY OI history (oi_second_observations, continuous) and
// liquidation event history (liq_raw_events) -- no Spot, no Futures
// buy/sell tape, no backtest framework. Tests two things:
//
//   1. OI-FLATTENING LAG: for each episode, does the OI decline's
//      RATE flatten out (stop declining, start net non-negative for a
//      sustained stretch) BEFORE, AT, or AFTER the price's own final
//      extreme? If OI flattening consistently LEADS the price
//      extreme, that is a real, spot-independent early signal worth
//      building into entry logic. If it lags or is random, this
//      specific idea is dead and should be dropped, not iterated on
//      further.
//   2. OPPOSITE-SIDE LIQUIDATION CLUSTER: after a LONG-victim
//      episode's extreme, does a cluster of SHORT liquidations follow
//      (direct evidence the market actually reversed and started
//      squeezing the other side) -- and the mirror case for
//      SHORT-victim episodes. This is liquidation-history-only,
//      immune to the spot/arbitrage contamination problem.
//
//   node scripts/oi-rate-and-reversal-signal.js 7
//
// (argument = days back, default 7)
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

const OI_BUCKET_SEC = 30;
const FLATTEN_LOOKBACK_BUCKETS = 3;
const REVERSAL_WINDOW_MIN = 10;

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
function fmtDuration(sec) {
  const sign = sec < 0 ? "-" : "+";
  const abs = Math.abs(sec);
  if (abs < 90) return `${sign}${abs.toFixed(0)}s`;
  return `${sign}${(abs / 60).toFixed(1)}m`;
}
function mean(arr) {
  const vals = arr.filter(
    (v) => v !== null && v !== undefined && Number.isFinite(v),
  );
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function main() {
  const days = Number(process.argv[2] ?? "7");
  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const researchCol = ownDb.collection("liquidation_oi_episode_research");
  const oiCol = ownDb.collection("oi_second_observations");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(114));
  console.log(
    `OI-RATE FLATTENING vs PRICE EXTREME + OPPOSITE-SIDE LIQUIDATION CLUSTER -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log(
    "Uses ONLY OI history and liquidation event history. No Spot, no Futures buy/sell tape, no backtest framework.",
  );
  console.log("=".repeat(114));

  const docs = await researchCol
    .find({
      symbol: { $in: SYMBOLS },
      createdAtMs: { $gte: rangeStartMs, $lte: rangeEndMs },
      finalExtremeSnapshot: { $ne: null },
    })
    .sort({ createdAtMs: 1 })
    .toArray();

  console.log(
    `\nLoaded ${docs.length} episode(s) with a recorded final extreme.\n`,
  );

  const lagResults = [];

  for (const doc of docs) {
    const startMs = doc.episodeStartSnapshot?.ts;
    const extremeMs = doc.finalExtremeSnapshot?.ts;
    if (!startMs || !extremeMs) continue;

    const oiFetchEndMs = extremeMs + REVERSAL_WINDOW_MIN * 60 * 1000;
    const oiDocs = await oiCol
      .find({
        symbol: doc.symbol,
        timestamp: { $gte: new Date(startMs), $lte: new Date(oiFetchEndMs) },
      })
      .project({ timestamp: 1, openInterest: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    if (oiDocs.length < FLATTEN_LOOKBACK_BUCKETS + 2) continue;

    const bucketed = [];
    let lastVal = null;
    for (let t = startMs; t <= oiFetchEndMs; t += OI_BUCKET_SEC * 1000) {
      let val = lastVal;
      for (const d of oiDocs) {
        const ts =
          d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp;
        if (ts <= t + OI_BUCKET_SEC * 1000) val = d.openInterest;
        else break;
      }
      bucketed.push({ t, val });
      lastVal = val;
    }

    let sawDecline = false;
    let flattenMs = null;
    for (let i = 1; i < bucketed.length; i++) {
      const prev = bucketed[i - 1].val;
      const cur = bucketed[i].val;
      if (prev === null || cur === null) continue;
      const delta = cur - prev;
      if (delta < 0) sawDecline = true;
      if (sawDecline && i >= FLATTEN_LOOKBACK_BUCKETS) {
        let allNonNegative = true;
        for (let j = i - FLATTEN_LOOKBACK_BUCKETS + 1; j <= i; j++) {
          const a = bucketed[j - 1]?.val;
          const b = bucketed[j]?.val;
          if (a === null || b === null || b - a < 0) {
            allNonNegative = false;
            break;
          }
        }
        if (allNonNegative) {
          flattenMs = bucketed[i - FLATTEN_LOOKBACK_BUCKETS + 1].t;
          break;
        }
      }
    }

    if (flattenMs === null) continue;

    const lagSec = (flattenMs - extremeMs) / 1000;
    lagResults.push({
      symbol: doc.symbol,
      episodeId: doc.episodeId,
      victim: doc.victim,
      extremeMs,
      flattenMs,
      lagSec,
    });

    const oppositeSide = doc.victim === "LONG" ? "SHORT" : "LONG";
    const oppEvents = await liqCol
      .find({
        symbol: doc.symbol,
        timestamp: {
          $gte: extremeMs,
          $lte: extremeMs + REVERSAL_WINDOW_MIN * 60 * 1000,
        },
        victim: oppositeSide,
      })
      .project({ quoteQty: 1 })
      .toArray();
    const oppUsd = oppEvents.reduce((a, e) => a + (e.quoteQty ?? 0), 0);

    console.log(
      `${doc.symbol.padEnd(10)} ${doc.episodeId}  victim=${doc.victim}  extreme=${hhmm(extremeMs)}  OI-flatten=${hhmm(flattenMs)}  lag=${fmtDuration(lagSec)}  opposite-side(${oppositeSide}) liq in +${REVERSAL_WINDOW_MIN}min: ${fmtUsd(oppUsd)} (${oppEvents.length} event(s))`,
    );
  }

  console.log(`\n${"=".repeat(114)}`);
  console.log("AGGREGATE -- OI-flattening lag vs price extreme");
  console.log("=".repeat(114));
  const leading = lagResults.filter((r) => r.lagSec < 0);
  const coincident = lagResults.filter((r) => r.lagSec >= 0 && r.lagSec <= 30);
  const lagging = lagResults.filter((r) => r.lagSec > 30);
  console.log(
    `Total episodes with a detectable OI-flattening point: ${lagResults.length}`,
  );
  console.log(
    `  LEADING (OI flattened BEFORE price extreme): ${leading.length}  avg lag ${fmtDuration(mean(leading.map((r) => r.lagSec)) ?? 0)}`,
  );
  console.log(`  COINCIDENT (within 30s of extreme): ${coincident.length}`);
  console.log(
    `  LAGGING (OI flattened AFTER price extreme): ${lagging.length}  avg lag ${fmtDuration(mean(lagging.map((r) => r.lagSec)) ?? 0)}`,
  );

  console.log(`\n${"=".repeat(114)}`);
  console.log(
    "READING: if LEADING is the dominant group with a meaningfully negative average lag, OI-flattening is a real,",
  );
  console.log(
    "early, spot-independent signal worth building into entry logic. If LAGGING dominates or the split is roughly",
  );
  console.log(
    "even, OI-flattening does not lead price here and this specific idea should be dropped, not iterated further.",
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
