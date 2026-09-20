// Sep 20 2026 (Karo), operator-requested. READ-ONLY report, straight
// from ALREADY-PERSISTED liquidation_oi_episode_research documents --
// NO recomputation of OI, Spot, Futures, or timestamps: every value
// below is read verbatim from the stored document's own fields. This
// never touches live strategy or trading logic.
//
//   node scripts/episode-research-report.js 3 30000
//
// (arg1 = days back, default 3; arg2 = BTC_ISOLATION_USD threshold,
// default 30000)
//
// OPERATOR'S OWN RULE (restated to confirm before building this): an
// altcoin's liquidation episode should only be trusted as a signal
// about THAT coin's own dynamics if it did NOT happen while BTC was
// ALSO in its own cascade -- otherwise the altcoin's move may simply
// be BTC dragging the whole market with it, not something specific to
// that coin. So: for each non-BTC episode, check BTCUSDT's own
// liquidation activity (from liq_raw_events, independent of whether
// BTC itself crossed its own Episode Research threshold) within the
// episode's own window (+-5 min padding). If BTC's total liquidated
// USD in that window is >= BTC_ISOLATION_USD, the episode is EXCLUDED
// (BTC-concurrent, not a clean signal). Otherwise it is ISOLATED and
// included in the report.
//
// OUTPUT: prints a summary to the console, then writes the full
// ISOLATED-episode data to two files on disk (this VPS):
//   - episode-research-report-<timestamp>.json  (full structured data,
//     every field copied verbatim from the stored document)
//   - episode-research-report-<timestamp>.txt   (human-readable)
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
const BTC_WINDOW_PADDING_MS = 5 * 60 * 1000;

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

function mean(arr) {
  const vals = arr.filter(
    (v) => v !== null && v !== undefined && Number.isFinite(v),
  );
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Sep 20 2026 (Karo) -- fixes v1's display bug: an absent snapshot
 *  printed the raw JS field as "undefined" instead of "N/A". Every
 *  print site below now checks .present first. */
function snapLine(snap) {
  if (!snap || !snap.present)
    return `${snap ? snap.label : "snapshot"}: N/A (no snapshot recorded)`;
  return `${snap.label}: ${snap.tsIso}  price=${fmtNum(snap.price)}  spot=${fmtNum(snap.spotMid)}  futures=${fmtNum(snap.futuresMid)}  basis=${fmtNum(snap.basisBps)}bps  OI=${fmtNum(snap.oiValue)} (at ${snap.oiTsIso ?? "N/A"})`;
}

/** Verbatim snapshot -> a flat, clearly-labelled record. No math, no
 *  inference -- only field lookups and formatting. */
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

async function main() {
  const days = Number(process.argv[2] ?? "3");
  const btcIsolationUsd = Number(process.argv[3] ?? "30000");
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(
      "Usage: node scripts/episode-research-report.js <daysBack> <btcIsolationUsd>",
    );

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - days * 86_400_000;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const researchCol = ownDb.collection("liquidation_oi_episode_research");
  const liqCol = ownDb.collection("liq_raw_events");

  console.log("=".repeat(110));
  console.log(
    `EPISODE RESEARCH REPORT (BTC-isolated only) -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log(
    `BTC isolation threshold: BTC's own liquidated USD within episode window (+-5min) must be < ${fmtUsd(btcIsolationUsd)}`,
  );
  console.log("=".repeat(110));

  const btcEvents = await liqCol
    .find({
      symbol: BTC_SYMBOL,
      timestamp: {
        $gte: rangeStartMs - BTC_WINDOW_PADDING_MS,
        $lte: rangeEndMs + BTC_WINDOW_PADDING_MS,
      },
    })
    .project({ timestamp: 1, quoteQty: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  function btcLiquidatedUsdInWindow(startMs, endMs) {
    const from = startMs - BTC_WINDOW_PADDING_MS;
    const to = endMs + BTC_WINDOW_PADDING_MS;
    let sum = 0;
    for (const e of btcEvents) {
      if (e.timestamp >= from && e.timestamp <= to) sum += e.quoteQty ?? 0;
    }
    return sum;
  }

  const docs = await researchCol
    .find({
      symbol: { $in: ALT_SYMBOLS },
      createdAtMs: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .sort({ createdAtMs: 1 })
    .toArray();

  console.log(
    `\nLoaded ${docs.length} Episode Research document(s) for ${ALT_SYMBOLS.join(", ")}.\n`,
  );

  const isolated = [];
  const excluded = [];

  for (const doc of docs) {
    const windowStartMs = doc.episodeStartSnapshot?.ts ?? doc.createdAtMs;
    const windowEndMs =
      doc.episodeEndSnapshot?.ts ??
      doc.lastLiquidationEventSnapshot?.eventTs ??
      doc.finalExtremeSnapshot?.ts ??
      doc.updatedAtMs;
    const btcUsd = btcLiquidatedUsdInWindow(windowStartMs, windowEndMs);
    const isBtcConcurrent = btcUsd >= btcIsolationUsd;

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
      btcConcurrentLiquidatedUsd: btcUsd,
      episodeStart: snapshotRecord("episodeStart", doc.episodeStartSnapshot),
      finalExtreme: snapshotRecord("finalExtreme", doc.finalExtremeSnapshot),
      entryOrEnd: snapshotRecord(
        entered ? "entry" : "episodeEnd",
        entered ? doc.entrySnapshot : doc.episodeEndSnapshot,
      ),
      flushFlow: doc.flushFlow
        ? {
            durationMs: doc.flushFlow.durationMs,
            oiDeltaPct: doc.flushFlow.oiDeltaPct,
            oiStartValue: doc.flushFlow.oiStart?.oiValue ?? null,
            oiEndValue: doc.flushFlow.oiEnd?.oiValue ?? null,
            spotPriceChangePct: doc.flushFlow.spotPriceChangePct,
            futuresPriceChangePct: doc.flushFlow.futuresPriceChangePct,
            spotDelta: doc.flushFlow.spotDelta,
            futuresDelta: doc.flushFlow.futuresDelta,
            spotDataAvailable: doc.flushFlow.spotDataAvailable,
            totalObservedLiquidationUsd:
              doc.flushFlow.totalObservedLiquidationUsd,
            eventCount: doc.flushFlow.eventCount,
          }
        : null,
      recoveryFlow: doc.recoveryFlow
        ? {
            durationMs: doc.recoveryFlow.durationMs,
            oiDeltaPct: doc.recoveryFlow.oiDeltaPct,
            oiStartValue: doc.recoveryFlow.oiStart?.oiValue ?? null,
            oiEndValue: doc.recoveryFlow.oiEnd?.oiValue ?? null,
            spotPriceChangePct: doc.recoveryFlow.spotPriceChangePct,
            futuresPriceChangePct: doc.recoveryFlow.futuresPriceChangePct,
            spotDelta: doc.recoveryFlow.spotDelta,
            futuresDelta: doc.recoveryFlow.futuresDelta,
            spotDataAvailable: doc.recoveryFlow.spotDataAvailable,
          }
        : null,
      basisRecovery: doc.basisRecovery ?? null,
    };

    record.group = isBtcConcurrent ? "BTC_CONCURRENT" : "ISOLATED";
    if (isBtcConcurrent) {
      excluded.push(record);
    } else {
      isolated.push(record);
    }
  }

  console.log(
    `BTC-CONCURRENT (excluded from detailed report, still included in aggregate comparison below): ${excluded.length}`,
  );
  for (const e of excluded) {
    console.log(
      `  ${e.symbol.padEnd(10)} ${e.episodeId}  window ${e.episodeStart.tsIso ?? "N/A"} -> ${e.entryOrEnd.tsIso ?? "N/A"}  entered=${e.entered ? "YES" : "NO"}  BTC liquidated in window: ${fmtUsd(e.btcConcurrentLiquidatedUsd)}`,
    );
  }

  console.log(
    `\nISOLATED (BTC NOT concurrently cascading): ${isolated.length}\n`,
  );
  console.log("=".repeat(110));

  for (const r of isolated) {
    console.log("-".repeat(110));
    console.log(
      `${r.symbol}  ${r.episodeId}  victim=${r.victim}  fade direction: ${r.fadeDirection}`,
    );
    console.log(
      `  entered=${r.entered ? "YES" : "NO"}  entryReason=${r.entryReason ?? "N/A"}  noEntryReason=${r.noEntryReason ?? "N/A"}  endReason=${r.endReason ?? "N/A"}`,
    );
    console.log(
      `  BTC concurrent liquidated (within +-5min of episode): ${fmtUsd(r.btcConcurrentLiquidatedUsd)}  (below ${fmtUsd(btcIsolationUsd)} threshold)`,
    );
    console.log(`  episodeStart:  ${snapLine(r.episodeStart)}`);
    console.log(`  finalExtreme:  ${snapLine(r.finalExtreme)}`);
    console.log(`  ${snapLine(r.entryOrEnd)}`);
    if (r.flushFlow) {
      console.log(
        `  FLUSH (start->extreme, ${(r.flushFlow.durationMs / 1000).toFixed(0)}s): OI ${fmtPct(r.flushFlow.oiDeltaPct)} (${fmtNum(r.flushFlow.oiStartValue)} -> ${fmtNum(r.flushFlow.oiEndValue)})  Spot price ${fmtPct(r.flushFlow.spotPriceChangePct)}  Futures price ${fmtPct(r.flushFlow.futuresPriceChangePct)}  Spot delta ${fmtUsd(r.flushFlow.spotDelta)}  Futures delta ${fmtUsd(r.flushFlow.futuresDelta)}  (spotDataAvailable=${r.flushFlow.spotDataAvailable})`,
      );
    }
    if (r.recoveryFlow) {
      console.log(
        `  RECOVERY (extreme->${r.entryOrEnd.label}, ${(r.recoveryFlow.durationMs / 1000).toFixed(0)}s): OI ${fmtPct(r.recoveryFlow.oiDeltaPct)} (${fmtNum(r.recoveryFlow.oiStartValue)} -> ${fmtNum(r.recoveryFlow.oiEndValue)})  Spot price ${fmtPct(r.recoveryFlow.spotPriceChangePct)}  Futures price ${fmtPct(r.recoveryFlow.futuresPriceChangePct)}  Spot delta ${fmtUsd(r.recoveryFlow.spotDelta)}  Futures delta ${fmtUsd(r.recoveryFlow.futuresDelta)}  (spotDataAvailable=${r.recoveryFlow.spotDataAvailable})`,
      );
    }
    if (r.basisRecovery) {
      console.log(
        `  BASIS RECOVERY: convergenceDirection=${r.basisRecovery.convergenceDirection}  futuresContributionPct=${fmtNum(r.basisRecovery.futuresContributionPct)}  spotContributionPct=${fmtNum(r.basisRecovery.spotContributionPct)}  spotMadeNewExtreme=${r.basisRecovery.spotMadeNewExtreme}`,
      );
    }
  }

  // Sep 20 2026 (Karo), operator-requested addition -- AGGREGATE
  // COMPARISON between the two groups: entry rate, no-entry reason
  // breakdown, and average OI-delta% / Spot delta / Futures delta for
  // both Flush and Recovery phases. Every average here is computed
  // ONLY from the durationMs/oiDeltaPct/spotDelta/futuresDelta fields
  // already stored verbatim in each document -- no new fetches.
  function printGroupStats(label, records) {
    console.log(`\n${label} (N=${records.length}):`);
    if (records.length === 0) {
      console.log("  (none)");
      return;
    }
    const enteredCount = records.filter((r) => r.entered).length;
    console.log(
      `  Entered: ${enteredCount}/${records.length} (${((enteredCount / records.length) * 100).toFixed(1)}%)`,
    );
    const reasonCounts = new Map();
    for (const r of records) {
      if (!r.entered) {
        const reason = r.noEntryReason ?? "(none recorded)";
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    if (reasonCounts.size > 0) {
      console.log("  No-entry reasons:");
      for (const [reason, count] of [...reasonCounts.entries()].sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`    ${reason}: ${count}`);
      }
    }
    const flushOi = mean(records.map((r) => r.flushFlow?.oiDeltaPct));
    const flushSpotDelta = mean(records.map((r) => r.flushFlow?.spotDelta));
    const flushFuturesDelta = mean(
      records.map((r) => r.flushFlow?.futuresDelta),
    );
    const recoveryOi = mean(records.map((r) => r.recoveryFlow?.oiDeltaPct));
    const recoverySpotDelta = mean(
      records.map((r) => r.recoveryFlow?.spotDelta),
    );
    const recoveryFuturesDelta = mean(
      records.map((r) => r.recoveryFlow?.futuresDelta),
    );
    console.log(
      `  Avg FLUSH:    OI% ${fmtPct(flushOi)}   Spot delta ${fmtUsd(flushSpotDelta)}   Futures delta ${fmtUsd(flushFuturesDelta)}`,
    );
    console.log(
      `  Avg RECOVERY: OI% ${fmtPct(recoveryOi)}   Spot delta ${fmtUsd(recoverySpotDelta)}   Futures delta ${fmtUsd(recoveryFuturesDelta)}`,
    );
  }

  console.log(`\n${"=".repeat(110)}`);
  console.log("AGGREGATE COMPARISON -- ISOLATED vs BTC-CONCURRENT");
  console.log("=".repeat(110));
  printGroupStats("ISOLATED", isolated);
  printGroupStats("BTC-CONCURRENT", excluded);

  console.log(`\n${"=".repeat(110)}`);
  console.log(
    `TOTAL: ${docs.length} episodes scanned, ${excluded.length} excluded as BTC-concurrent, ${isolated.length} isolated (this report).`,
  );
  console.log(
    "This never touches live strategy or trading logic. Every value above is read verbatim from the stored",
  );
  console.log(
    "Episode Research document -- no recomputation, no new OI/Spot/Futures fetches.",
  );

  const outDir = process.cwd();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `episode-research-report-${stamp}.json`);
  const txtPath = path.join(outDir, `episode-research-report-${stamp}.txt`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAtUtc: isoUtc(Date.now()),
        rangeStartUtc: isoUtc(rangeStartMs),
        rangeEndUtc: isoUtc(rangeEndMs),
        btcIsolationUsdThreshold: btcIsolationUsd,
        totalScanned: docs.length,
        excludedBtcConcurrentCount: excluded.length,
        isolatedCount: isolated.length,
        excluded,
        isolated,
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
    `EPISODE RESEARCH REPORT (BTC-isolated only) -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log(`BTC isolation threshold: < ${fmtUsd(btcIsolationUsd)}\n`);
  console.log(`EXCLUDED (BTC-concurrent): ${excluded.length}`);
  for (const e of excluded)
    console.log(
      `  ${e.symbol} ${e.episodeId} window ${e.episodeStart.tsIso ?? "N/A"} -> ${e.entryOrEnd.tsIso ?? "N/A"} entered=${e.entered} BTC=${fmtUsd(e.btcConcurrentLiquidatedUsd)}`,
    );
  console.log(`\nISOLATED: ${isolated.length}\n`);
  for (const r of isolated) {
    console.log(
      `${r.symbol}  ${r.episodeId}  victim=${r.victim}  fade=${r.fadeDirection}  entered=${r.entered}`,
    );
    console.log(`  start ${snapLine(r.episodeStart)}`);
    console.log(`  extreme ${snapLine(r.finalExtreme)}`);
    console.log(`  ${snapLine(r.entryOrEnd)}`);
    if (r.flushFlow)
      console.log(
        `  flush: OI% ${fmtPct(r.flushFlow.oiDeltaPct)} spot% ${fmtPct(r.flushFlow.spotPriceChangePct)} futures% ${fmtPct(r.flushFlow.futuresPriceChangePct)}`,
      );
    if (r.recoveryFlow)
      console.log(
        `  recovery: OI% ${fmtPct(r.recoveryFlow.oiDeltaPct)} spot% ${fmtPct(r.recoveryFlow.spotPriceChangePct)} futures% ${fmtPct(r.recoveryFlow.futuresPriceChangePct)}`,
      );
    console.log("");
  }
  printGroupStats("ISOLATED", isolated);
  printGroupStats("BTC-CONCURRENT", excluded);
  console.log = origLog;
  fs.writeFileSync(txtPath, txtBuf);

  console.log(`\nWrote:\n  ${jsonPath}\n  ${txtPath}`);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
