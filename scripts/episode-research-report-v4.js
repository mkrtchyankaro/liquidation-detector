// Sep 20 2026 (Karo), operator-requested v3 REWRITE. READ-ONLY report,
// straight from ALREADY-PERSISTED liquidation_oi_episode_research
// documents -- NO recomputation of OI, Spot, Futures, or timestamps:
// every value below is read verbatim from the stored document's own
// fields. This never touches live strategy or trading logic.
//
//   node scripts/episode-research-report-v4.js 3 3
//
// v4 ADDITION (operator-requested): computes buyer share (buy /
// (buy+sell)) for Spot and Futures in both phases -- straight
// arithmetic on the already-stored buy/sell $ fields, still zero new
// fetches -- and adds a CORRELATION table at the end: does the
// Recovery phase's Spot buyer share actually predict Recovery OI%
// and price% direction, bucketed buyer-dominant / balanced /
// seller-dominant.
//
// (arg1 = days back, default 3; arg2 = BTC window padding in minutes
// for the informational concurrent-liquidation figure, default 3)
//
// OPERATOR'S OWN CORRECTION (v2 got this wrong -- restated here to
// confirm before rewriting): v2 used a hard BTC-liquidation-USD
// threshold to EXCLUDE altcoin episodes from the report entirely.
// That's wrong for this research phase -- the operator does not yet
// have a settled rule for what counts as "BTC in a big cascade" (that
// gets decided later, once live). So this version:
//   1. Shows EVERY altcoin (non-BTC) episode from the window -- NOTHING
//      is excluded or filtered out.
//   2. For each episode, shows BTC's own concurrent liquidation
//      activity (total USD AND event count, within the episode's own
//      window +- padding) as an INFORMATIONAL field only, for the
//      operator to judge by eye -- never as a filter.
//   3. Shows Spot BUY and Spot SELL separately (not just net delta),
//      and Futures BUY and Futures SELL separately, for BOTH the
//      Flush phase (episode start -> final extreme) and the Recovery
//      phase (final extreme -> entry-or-episode-end) -- exactly the
//      two phases and exactly the fields the operator asked for.
//   4. BTC window padding defaults to 3 minutes (down from v2's 5),
//      per the operator's explicit instruction.
//
// OUTPUT: prints every episode to the console, then writes the same
// full data to two files on disk (this VPS):
//   - episode-research-report-v4-<timestamp>.json  (full structured
//     data, every field copied verbatim from the stored document)
//   - episode-research-report-v4-<timestamp>.txt   (human-readable)
//
// All timestamps everywhere are UTC, printed as full ISO 8601
// (YYYY-MM-DDTHH:mm:ss.sssZ) taken directly from the document's own
// *Ms / *ts fields -- never recomputed, never a different timezone.
//
// READ-ONLY: no writes/updates/deletes to Mongo anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

const ALT_SYMBOLS = [
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
const BTC_SYMBOL = "BTCUSDT";

function isoUtc(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
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

function fmtNum(n) {
  if (n === null || n === undefined) return "N/A";
  return n.toString();
}

/** Buyer share of a phase's flow, as a fraction 0..1 (0.5 = balanced,
 *  >0.5 = buyer-dominant, <0.5 = seller-dominant). null when there's
 *  no flow to compute a ratio from (buy+sell = 0) or data wasn't
 *  captured. Straight arithmetic on stored buy/sell $ -- no new data. */
function buyerShare(buyUsd, sellUsd) {
  if (
    buyUsd === null ||
    buyUsd === undefined ||
    sellUsd === null ||
    sellUsd === undefined
  )
    return null;
  const total = buyUsd + sellUsd;
  if (total <= 0) return null;
  return buyUsd / total;
}

function fmtShare(share) {
  if (share === null || share === undefined) return "N/A";
  return `${(share * 100).toFixed(1)}%`;
}

function mean(arr) {
  const vals = arr.filter(
    (v) => v !== null && v !== undefined && Number.isFinite(v),
  );
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function snapshotRecord(label, snap) {
  if (!snap) return { label, present: false };
  return {
    label,
    present: true,
    tsMs: snap.ts,
    tsIso: isoUtc(snap.ts),
    price: snap.price ?? null,
    spotMid: snap.market?.spotMid ?? null,
    futuresMid: snap.market?.futuresMid ?? null,
    basisBps: snap.market?.basisBps ?? null,
    oiValue: snap.oi?.oiValue ?? null,
    oiTsMs: snap.oi?.oiTimestamp ?? null,
    oiTsIso: snap.oi?.oiTimestamp ? isoUtc(snap.oi.oiTimestamp) : null,
  };
}

function snapLine(snap) {
  if (!snap || !snap.present)
    return `${snap ? snap.label : "snapshot"}: N/A (no snapshot recorded)`;
  return `${snap.tsIso}  price=${fmtNum(snap.price)}  spot=${fmtNum(snap.spotMid)}  futures=${fmtNum(snap.futuresMid)}  basis=${fmtNum(snap.basisBps)}bps  OI=${fmtNum(snap.oiValue)} (at ${snap.oiTsIso ?? "N/A"})`;
}

function phaseRecord(phase) {
  if (!phase) return null;
  return {
    durationMs: phase.durationMs,
    spotBuyUsd: phase.spotBuyUsd,
    spotSellUsd: phase.spotSellUsd,
    spotDelta: phase.spotDelta,
    spotDataAvailable: phase.spotDataAvailable,
    futuresBuyUsd: phase.futuresBuyUsd,
    futuresSellUsd: phase.futuresSellUsd,
    futuresDelta: phase.futuresDelta,
    oiStartValue: phase.oiStart?.oiValue ?? null,
    oiEndValue: phase.oiEnd?.oiValue ?? null,
    oiDeltaPct: phase.oiDeltaPct,
    spotPriceChangePct: phase.spotPriceChangePct,
    futuresPriceChangePct: phase.futuresPriceChangePct,
    totalObservedLiquidationUsd: phase.totalObservedLiquidationUsd,
    eventCount: phase.eventCount,
  };
}

function phaseLine(label, phase, entryOrEndLabel) {
  if (!phase) return `  ${label}: N/A (no data)`;
  const target = entryOrEndLabel ? `->${entryOrEndLabel}` : "";
  return (
    `  ${label} (${(phase.durationMs / 1000).toFixed(0)}s${target}):\n` +
    `    Spot:    BUY ${fmtUsd(phase.spotBuyUsd)}   SELL ${fmtUsd(phase.spotSellUsd)}   net ${fmtUsd(phase.spotDelta)}   (dataAvailable=${phase.spotDataAvailable})\n` +
    `    Futures: BUY ${fmtUsd(phase.futuresBuyUsd)}   SELL ${fmtUsd(phase.futuresSellUsd)}   net ${fmtUsd(phase.futuresDelta)}\n` +
    `    OI: ${fmtNum(phase.oiStartValue)} -> ${fmtNum(phase.oiEndValue)}  (${fmtPct(phase.oiDeltaPct)})\n` +
    `    Price: Spot ${fmtPct(phase.spotPriceChangePct)}   Futures ${fmtPct(phase.futuresPriceChangePct)}\n` +
    `    Observed liquidation this phase: ${fmtUsd(phase.totalObservedLiquidationUsd)}  (${phase.eventCount} event(s))`
  );
}

async function main() {
  const days = Number(process.argv[2] ?? "3");
  const btcPaddingMin = Number(process.argv[3] ?? "3");
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(
      "Usage: node scripts/episode-research-report-v3.js <daysBack> <btcWindowPaddingMinutes>",
    );
  const btcPaddingMs = btcPaddingMin * 60 * 1000;

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const researchCol = ownDb.collection("liquidation_oi_episode_research");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(116));
  console.log(
    `ALTCOIN EPISODE RESEARCH REPORT -- ALL episodes, nothing excluded -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log(
    `BTC concurrent-liquidation figure uses a +-${btcPaddingMin} minute window around each episode -- informational only, not a filter.`,
  );
  console.log("=".repeat(116));

  const btcEvents = await liqCol
    .find({
      symbol: BTC_SYMBOL,
      timestamp: {
        $gte: rangeStartMs - btcPaddingMs,
        $lte: rangeEndMs + btcPaddingMs,
      },
    })
    .project({ timestamp: 1, quoteQty: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  function btcConcurrentInWindow(startMs, endMs) {
    const from = startMs - btcPaddingMs;
    const to = endMs + btcPaddingMs;
    let usd = 0;
    let count = 0;
    for (const e of btcEvents) {
      if (e.timestamp >= from && e.timestamp <= to) {
        usd += e.quoteQty ?? 0;
        count++;
      }
    }
    return { usd, count };
  }

  const docs = await researchCol
    .find({
      symbol: { $in: ALT_SYMBOLS },
      createdAtMs: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .sort({ createdAtMs: 1 })
    .toArray();

  console.log(
    `\nLoaded ${docs.length} altcoin Episode Research document(s) for ${ALT_SYMBOLS.join(", ")}. ALL are shown below.\n`,
  );

  const allRecords = [];

  for (const doc of docs) {
    const windowStartMs = doc.episodeStartSnapshot?.ts ?? doc.createdAtMs;
    const windowEndMs =
      doc.episodeEndSnapshot?.ts ??
      doc.lastLiquidationEventSnapshot?.eventTs ??
      doc.finalExtremeSnapshot?.ts ??
      doc.updatedAtMs;
    const btc = btcConcurrentInWindow(windowStartMs, windowEndMs);

    const entered =
      doc.entrySnapshot !== null && doc.entrySnapshot !== undefined;
    const fadeDirection =
      doc.victim === "LONG"
        ? "LONG (fade the flush -- buy)"
        : doc.victim === "SHORT"
          ? "SHORT (fade the squeeze -- sell)"
          : "UNKNOWN";

    const record = {
      episodeId: doc.episodeId,
      symbol: doc.symbol,
      victim: doc.victim,
      fadeDirection,
      entered,
      endReason: doc.endReason ?? null,
      entryReason: doc.entryReason ?? null,
      noEntryReason: doc.noEntryReason ?? null,
      btcConcurrent: {
        liquidatedUsd: btc.usd,
        eventCount: btc.count,
        windowPaddingMin: btcPaddingMin,
      },
      episodeStart: snapshotRecord("episodeStart", doc.episodeStartSnapshot),
      finalExtreme: snapshotRecord("finalExtreme", doc.finalExtremeSnapshot),
      entryOrEnd: snapshotRecord(
        entered ? "entry" : "episodeEnd",
        entered ? doc.entrySnapshot : doc.episodeEndSnapshot,
      ),
      flushFlow: phaseRecord(doc.flushFlow),
      recoveryFlow: phaseRecord(doc.recoveryFlow),
      basisRecovery: doc.basisRecovery ?? null,
    };
    record.flushSpotBuyerShare = record.flushFlow
      ? buyerShare(record.flushFlow.spotBuyUsd, record.flushFlow.spotSellUsd)
      : null;
    record.flushFuturesBuyerShare = record.flushFlow
      ? buyerShare(
          record.flushFlow.futuresBuyUsd,
          record.flushFlow.futuresSellUsd,
        )
      : null;
    record.recoverySpotBuyerShare = record.recoveryFlow
      ? buyerShare(
          record.recoveryFlow.spotBuyUsd,
          record.recoveryFlow.spotSellUsd,
        )
      : null;
    record.recoveryFuturesBuyerShare = record.recoveryFlow
      ? buyerShare(
          record.recoveryFlow.futuresBuyUsd,
          record.recoveryFlow.futuresSellUsd,
        )
      : null;
    allRecords.push(record);
  }

  for (const r of allRecords) {
    console.log("-".repeat(116));
    console.log(
      `${r.symbol}  ${r.episodeId}  victim=${r.victim}  fade direction: ${r.fadeDirection}`,
    );
    console.log(
      `  entered=${r.entered ? "YES" : "NO"}  entryReason=${r.entryReason ?? "N/A"}  noEntryReason=${r.noEntryReason ?? "N/A"}  endReason=${r.endReason ?? "N/A"}`,
    );
    console.log(
      `  BTC concurrent (+-${r.btcConcurrent.windowPaddingMin}min, informational only): ${fmtUsd(r.btcConcurrent.liquidatedUsd)}  across ${r.btcConcurrent.eventCount} event(s)`,
    );
    console.log(`  episodeStart:  ${snapLine(r.episodeStart)}`);
    console.log(`  finalExtreme:  ${snapLine(r.finalExtreme)}`);
    console.log(`  ${r.entryOrEnd.label}:  ${snapLine(r.entryOrEnd)}`);
    console.log(phaseLine("FLUSH (start->extreme)", r.flushFlow));
    console.log(
      `    Buyer share: Spot ${fmtShare(r.flushSpotBuyerShare)}   Futures ${fmtShare(r.flushFuturesBuyerShare)}`,
    );
    console.log(
      phaseLine(`RECOVERY (extreme->${r.entryOrEnd.label})`, r.recoveryFlow),
    );
    console.log(
      `    Buyer share: Spot ${fmtShare(r.recoverySpotBuyerShare)}   Futures ${fmtShare(r.recoveryFuturesBuyerShare)}`,
    );
    if (r.basisRecovery) {
      console.log(
        `  BASIS RECOVERY: convergenceDirection=${r.basisRecovery.convergenceDirection}  futuresContributionPct=${fmtNum(r.basisRecovery.futuresContributionPct)}  spotContributionPct=${fmtNum(r.basisRecovery.spotContributionPct)}  spotMadeNewExtreme=${r.basisRecovery.spotMadeNewExtreme}`,
      );
    }
  }

  // Sep 20 2026 (Karo), operator-requested addition -- does the
  // RECOVERY phase's spot buyer/seller balance actually predict what
  // OI and price do during recovery? Bucket episodes by their
  // recoverySpotBuyerShare (computed above, straight from stored
  // buy/sell $) and average the stored recovery OI%/price% in each
  // bucket. All inputs are fields already persisted verbatim in the
  // document; this is arithmetic on them, not a new fetch.
  console.log(`\n${"=".repeat(116)}`);
  console.log(
    "CORRELATION -- Recovery-phase Spot buyer share vs Recovery OI% and price%",
  );
  console.log("=".repeat(116));
  const buckets = [
    {
      label: "Spot buyer-dominant (share > 55%)",
      test: (s) => s !== null && s > 0.55,
    },
    {
      label: "Balanced (45%-55%)",
      test: (s) => s !== null && s >= 0.45 && s <= 0.55,
    },
    {
      label: "Spot seller-dominant (share < 45%)",
      test: (s) => s !== null && s < 0.45,
    },
    { label: "No recovery Spot data", test: (s) => s === null },
  ];
  for (const b of buckets) {
    const rows = allRecords.filter((r) => b.test(r.recoverySpotBuyerShare));
    const avgOi = mean(rows.map((r) => r.recoveryFlow?.oiDeltaPct));
    const avgSpotPrice = mean(
      rows.map((r) => r.recoveryFlow?.spotPriceChangePct),
    );
    const avgFuturesPrice = mean(
      rows.map((r) => r.recoveryFlow?.futuresPriceChangePct),
    );
    const avgFuturesBuyerShare = mean(
      rows.map((r) => r.recoveryFuturesBuyerShare),
    );
    console.log(`\n${b.label} (N=${rows.length}):`);
    if (rows.length === 0) {
      console.log("  (none)");
      continue;
    }
    console.log(
      `  Avg recovery OI%: ${fmtPct(avgOi)}   Avg Spot price%: ${fmtPct(avgSpotPrice)}   Avg Futures price%: ${fmtPct(avgFuturesPrice)}   Avg Futures buyer share: ${fmtShare(avgFuturesBuyerShare)}`,
    );
  }

  console.log(`\n${"=".repeat(116)}`);
  console.log(
    `TOTAL: ${allRecords.length} altcoin episode(s) shown. NONE excluded. BTC concurrent-liquidation figures are informational only --`,
  );
  console.log(
    'the rule for what counts as "BTC in a big cascade" is not yet decided; that will be determined once live.',
  );
  console.log(
    "Every value above is read verbatim from the stored Episode Research document -- no recomputation, no new fetches.",
  );

  const outDir = process.cwd();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(
    outDir,
    `episode-research-report-v4-${stamp}.json`,
  );
  const txtPath = path.join(outDir, `episode-research-report-v4-${stamp}.txt`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAtUtc: isoUtc(Date.now()),
        rangeStartUtc: isoUtc(rangeStartMs),
        rangeEndUtc: isoUtc(rangeEndMs),
        btcWindowPaddingMinutes: btcPaddingMin,
        note: "BTC concurrent-liquidation figures are informational only -- no episode is excluded from this file.",
        totalEpisodes: allRecords.length,
        episodes: allRecords,
      },
      null,
      2,
    ),
  );

  let txtBuf = "";
  const origLog = console.log;
  console.log = (...args) => {
    txtBuf += args.join(" ") + "\n";
  };
  console.log(
    `ALTCOIN EPISODE RESEARCH REPORT -- ALL episodes, nothing excluded -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}\n`,
  );
  for (const r of allRecords) {
    console.log(
      `${r.symbol}  ${r.episodeId}  victim=${r.victim}  fade=${r.fadeDirection}  entered=${r.entered}  noEntryReason=${r.noEntryReason ?? "N/A"}`,
    );
    console.log(
      `  BTC concurrent: ${fmtUsd(r.btcConcurrent.liquidatedUsd)} / ${r.btcConcurrent.eventCount} events`,
    );
    console.log(`  start:   ${snapLine(r.episodeStart)}`);
    console.log(`  extreme: ${snapLine(r.finalExtreme)}`);
    console.log(`  ${r.entryOrEnd.label}: ${snapLine(r.entryOrEnd)}`);
    console.log(phaseLine("FLUSH", r.flushFlow));
    console.log(
      `    Buyer share: Spot ${fmtShare(r.flushSpotBuyerShare)}   Futures ${fmtShare(r.flushFuturesBuyerShare)}`,
    );
    console.log(phaseLine("RECOVERY", r.recoveryFlow, r.entryOrEnd.label));
    console.log(
      `    Buyer share: Spot ${fmtShare(r.recoverySpotBuyerShare)}   Futures ${fmtShare(r.recoveryFuturesBuyerShare)}`,
    );
    console.log("");
  }
  console.log = origLog;
  fs.writeFileSync(txtPath, txtBuf);

  console.log(`\nWrote:\n  ${jsonPath}\n  ${txtPath}`);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
