// Sep 20 2026 (Karo), operator-requested. READ-ONLY lookup of ONE
// specific Episode Research document by episodeId (not just "most
// recent" like the smoke-test script).
//
//   node scripts/lookup-episode-research.js ep-1789893587288-y36gnw

require("dotenv/config");
const { MongoClient } = require("mongodb");

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

async function main() {
  const episodeId = process.argv[2];
  if (!episodeId) {
    console.error("Usage: node scripts/lookup-episode-research.js <episodeId>");
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const col = ownDb.collection("liquidation_oi_episode_research");

  const doc = await col.findOne({ episodeId });
  if (!doc) {
    console.log(
      `No Episode Research document found for episodeId=${episodeId}.`,
    );
    console.log(
      "Possible reasons: the episode started/ended before the Episode Research feature (or the OI-dedup fix) was deployed, or Mongo persistence failed.",
    );
    await client.close();
    return;
  }

  console.log("=".repeat(100));
  console.log(
    `EPISODE RESEARCH -- ${doc.symbol} / ${doc.victim} -- ${episodeId}`,
  );
  console.log("=".repeat(100));

  console.log("\n--- RAW DOCUMENT ---");
  console.log(JSON.stringify(doc, null, 2));

  console.log("\n--- SUMMARY ---");
  const entered = doc.entrySnapshot !== null && doc.entrySnapshot !== undefined;
  console.log(
    `Start: ${new Date(doc.episodeStartSnapshot.ts).toISOString()}  price=${doc.episodeStartSnapshot.price}`,
  );
  console.log(
    `  Spot: ${doc.episodeStartSnapshot.market?.spotMid ?? "N/A"}  Futures: ${doc.episodeStartSnapshot.market?.futuresMid ?? "N/A"}  basis: ${doc.episodeStartSnapshot.market?.basisBps ?? "N/A"} bps`,
  );
  if (doc.finalExtremeSnapshot) {
    console.log(
      `Final extreme: ${new Date(doc.finalExtremeSnapshot.ts).toISOString()}  price=${doc.finalExtremeSnapshot.price}`,
    );
    console.log(
      `  Spot: ${doc.finalExtremeSnapshot.market?.spotMid ?? "N/A"}  Futures: ${doc.finalExtremeSnapshot.market?.futuresMid ?? "N/A"}  basis: ${doc.finalExtremeSnapshot.market?.basisBps ?? "N/A"} bps`,
    );
    console.log(
      `  OI at extreme: ${doc.finalExtremeSnapshot.oi?.oiValue ?? "N/A"} (age ${doc.finalExtremeSnapshot.oi?.oiAgeMs ?? "N/A"}ms)`,
    );
  }
  const endOrEntry = entered ? doc.entrySnapshot : doc.episodeEndSnapshot;
  if (endOrEntry) {
    console.log(
      `${entered ? "Entry" : "End"}: ${new Date(endOrEntry.ts).toISOString()}  price=${endOrEntry.price}`,
    );
    console.log(
      `  Spot: ${endOrEntry.market?.spotMid ?? "N/A"}  Futures: ${endOrEntry.market?.futuresMid ?? "N/A"}  basis: ${endOrEntry.market?.basisBps ?? "N/A"} bps`,
    );
  }
  console.log(
    `\nEnd reason: ${doc.endReason ?? "N/A"}  |  Entry: ${entered ? "YES" : "NO"}  |  No-entry reason: ${doc.noEntryReason ?? "N/A"}`,
  );
  console.log(
    `Liquidation events: ${doc.liquidationEventSnapshots?.length ?? 0}`,
  );
  console.log(`Extreme updates: ${doc.extremeSnapshots?.length ?? 0}`);

  if (doc.flushFlow) {
    console.log(`\nFLUSH FLOW (episode start -> final extreme):`);
    console.log(
      `  Futures: Buy ${fmtUsd(doc.flushFlow.futuresBuyUsd)} / Sell ${fmtUsd(doc.flushFlow.futuresSellUsd)} / Delta ${fmtUsd(doc.flushFlow.futuresDelta)}`,
    );
    console.log(
      `  Spot:    ${doc.flushFlow.spotDataAvailable ? `Buy ${fmtUsd(doc.flushFlow.spotBuyUsd)} / Sell ${fmtUsd(doc.flushFlow.spotSellUsd)} / Delta ${fmtUsd(doc.flushFlow.spotDelta)}` : "N/A"}`,
    );
    console.log(
      `  OI: start=${doc.flushFlow.oiStart?.oiValue ?? "N/A"} end=${doc.flushFlow.oiEnd?.oiValue ?? "N/A"} deltaPct=${fmtPct(doc.flushFlow.oiDeltaPct)}`,
    );
    console.log(
      `  Basis: start=${doc.flushFlow.basisStartBps ?? "N/A"}bps end=${doc.flushFlow.basisEndBps ?? "N/A"}bps change=${doc.flushFlow.basisChangeBps ?? "N/A"}bps`,
    );
    console.log(
      `  Total liquidation: ${fmtUsd(doc.flushFlow.totalObservedLiquidationUsd)}  events=${doc.flushFlow.eventCount}`,
    );
  }

  if (doc.recoveryFlow) {
    console.log(
      `\nRECOVERY FLOW (final extreme -> ${entered ? "entry" : "episode end"}):`,
    );
    console.log(
      `  Futures: Buy ${fmtUsd(doc.recoveryFlow.futuresBuyUsd)} / Sell ${fmtUsd(doc.recoveryFlow.futuresSellUsd)} / Delta ${fmtUsd(doc.recoveryFlow.futuresDelta)}`,
    );
    console.log(
      `  Spot:    ${doc.recoveryFlow.spotDataAvailable ? `Buy ${fmtUsd(doc.recoveryFlow.spotBuyUsd)} / Sell ${fmtUsd(doc.recoveryFlow.spotSellUsd)} / Delta ${fmtUsd(doc.recoveryFlow.spotDelta)}` : "N/A"}`,
    );
    console.log(
      `  OI: start=${doc.recoveryFlow.oiStart?.oiValue ?? "N/A"} end=${doc.recoveryFlow.oiEnd?.oiValue ?? "N/A"} deltaPct=${fmtPct(doc.recoveryFlow.oiDeltaPct)}`,
    );
    console.log(
      `  Basis: start=${doc.recoveryFlow.basisStartBps ?? "N/A"}bps end=${doc.recoveryFlow.basisEndBps ?? "N/A"}bps change=${doc.recoveryFlow.basisChangeBps ?? "N/A"}bps`,
    );
    console.log(
      `  Duration: ${((doc.recoveryFlow.endAt - doc.recoveryFlow.startAt) / 1000).toFixed(0)}s`,
    );
  }

  if (doc.recoveryFlowHistory && doc.recoveryFlowHistory.length > 0) {
    console.log(
      `\n(${doc.recoveryFlowHistory.length} earlier Recovery Flow computation(s) superseded by a later extreme -- see raw document's recoveryFlowHistory[])`,
    );
  }

  if (doc.basisRecovery) {
    console.log(`\nBASIS RECOVERY:`);
    console.log(
      `  At extreme: ${fmtUsd(doc.basisRecovery.basisAtExtremeUsd)} (${doc.basisRecovery.basisAtExtremeBps ?? "N/A"}bps)`,
    );
    console.log(
      `  At ${entered ? "entry" : "end"}:   ${fmtUsd(doc.basisRecovery.basisAtEntryOrEndUsd)} (${doc.basisRecovery.basisAtEntryOrEndBps ?? "N/A"}bps)`,
    );
    console.log(
      `  Closed: ${fmtUsd(doc.basisRecovery.basisClosedUsd)} (${fmtPct(doc.basisRecovery.basisClosedPct)})`,
    );
    console.log(
      `  Futures contribution: ${fmtPct(doc.basisRecovery.futuresContributionPct)}  Spot contribution: ${fmtPct(doc.basisRecovery.spotContributionPct)}`,
    );
    console.log(
      `  Convergence direction: ${doc.basisRecovery.convergenceDirection}`,
    );
    console.log(
      `  Spot held after extreme: ${doc.basisRecovery.spotHeldAfterExtreme}  Spot made new extreme: ${doc.basisRecovery.spotMadeNewExtreme}  Futures made recovery: ${doc.basisRecovery.futuresMadeRecovery}`,
    );
  }

  console.log(
    `\n${entered ? `Entry reason: ${doc.entryReason}` : `No-entry reason: ${doc.noEntryReason}`}`,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
