import "dotenv/config";
import { MongoClientWrapper } from "../src/infrastructure/mongo/mongo.client";
import { formatEpisodeResearchSummary } from "../src/domain/liquidation-oi-strategy/episode-research-summary-formatter";
import type { EpisodeResearchRecord } from "../src/domain/liquidation-oi-strategy/episode-research-recorder";

/**
 * Sep 19 2026 (Karo), operator-requested pre-deploy smoke-test helper.
 *
 *   npx tsx scripts/episode-research-smoke-test.ts [symbol]
 *
 * READ ONLY. Fetches the MOST RECENT persisted Episode Research
 * record (optionally filtered by symbol), prints:
 *   1. The raw Mongo document.
 *   2. The formatted, human-readable summary (same function the live
 *      bot itself logs at episode finalization).
 *   3. An automated checklist confirming what the operator asked to
 *      verify before deploying: non-N/A Spot/Futures bid/ask/mid/basis
 *      at each key moment, OI start/end populated, aggTrade flows
 *      populated, and finalExtreme having moved via a candle/market
 *      tick (not only via a liquidation event's own price).
 */

function hasMarket(
  m:
    | {
        spotMid: number | null;
        futuresMid: number | null;
        basisUsd: number | null;
      }
    | undefined
    | null,
): boolean {
  return (
    m !== null &&
    m !== undefined &&
    m.spotMid !== null &&
    m.futuresMid !== null &&
    m.basisUsd !== null
  );
}

async function main(): Promise<void> {
  const symbolFilter = process.argv[2] ?? null;
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not found in environment/.env");
    process.exit(1);
  }
  const mongo = new MongoClientWrapper({
    enabled: true,
    uri,
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  });
  const col = await mongo.liquidationOiEpisodeResearch();
  if (col === null) {
    console.error("Could not open liquidation_oi_episode_research collection.");
    process.exit(1);
  }

  const query = symbolFilter !== null ? { symbol: symbolFilter } : {};
  const doc = await col.find(query).sort({ createdAtMs: -1 }).limit(1).next();
  if (doc === null) {
    console.log(
      `No Episode Research documents found${symbolFilter ? ` for ${symbolFilter}` : ""} yet -- wait for at least one episode to finish (reach WAIT confirmation or terminal cancel) after deploy, then re-run.`,
    );
    process.exit(0);
  }
  const record = doc as unknown as EpisodeResearchRecord;

  console.log("=".repeat(72));
  console.log("RAW PERSISTED DOCUMENT");
  console.log("=".repeat(72));
  console.log(JSON.stringify(doc, null, 2));

  console.log(`\n${"=".repeat(72)}`);
  console.log("FORMATTED SUMMARY");
  console.log("=".repeat(72));
  console.log(formatEpisodeResearchSummary(record));

  console.log(`\n${"=".repeat(72)}`);
  console.log("AUTOMATED VERIFICATION CHECKLIST");
  console.log("=".repeat(72));

  const checks: Array<{ label: string; pass: boolean; detail: string }> = [
    {
      label: "Episode start: Spot/Futures bid-ask-mid/basis non-N/A",
      pass: hasMarket(record.episodeStartSnapshot?.market),
      detail: JSON.stringify(record.episodeStartSnapshot?.market),
    },
    {
      label: "Final extreme: Spot/Futures bid-ask-mid/basis non-N/A",
      pass: hasMarket(record.finalExtremeSnapshot?.market),
      detail: JSON.stringify(record.finalExtremeSnapshot?.market),
    },
    {
      label: "Episode end: Spot/Futures bid-ask-mid/basis non-N/A",
      pass: hasMarket(record.episodeEndSnapshot?.market),
      detail: JSON.stringify(record.episodeEndSnapshot?.market),
    },
    {
      label: "Every liquidation event snapshot has non-N/A market data",
      pass:
        record.liquidationEventSnapshots.length > 0 &&
        record.liquidationEventSnapshots.every((e) => hasMarket(e.market)),
      detail: `${record.liquidationEventSnapshots.filter((e) => hasMarket(e.market)).length}/${record.liquidationEventSnapshots.length} events have market data`,
    },
    {
      label: "OI start/end populated (Flush Flow)",
      pass:
        record.flushFlow?.oiStart !== null && record.flushFlow?.oiEnd !== null,
      detail: `oiStart=${record.flushFlow?.oiStart?.oiValue ?? "N/A"} oiEnd=${record.flushFlow?.oiEnd?.oiValue ?? "N/A"}`,
    },
    {
      label: "Futures aggTrade flow populated (Flush Flow)",
      pass:
        (record.flushFlow?.futuresBuyUsd ?? 0) +
          (record.flushFlow?.futuresSellUsd ?? 0) >
        0,
      detail: `buy=${record.flushFlow?.futuresBuyUsd} sell=${record.flushFlow?.futuresSellUsd}`,
    },
    {
      label: "Spot aggTrade flow populated (Flush Flow)",
      pass: record.flushFlow?.spotDataAvailable === true,
      detail: `spotDataAvailable=${record.flushFlow?.spotDataAvailable} buy=${record.flushFlow?.spotBuyUsd} sell=${record.flushFlow?.spotSellUsd}`,
    },
    {
      label:
        "finalExtreme differs from episode start price (some movement occurred)",
      pass:
        record.finalExtremeSnapshot !== null &&
        record.finalExtremeSnapshot.price !== record.episodeStartSnapshot.price,
      detail: `start=${record.episodeStartSnapshot.price} finalExtreme=${record.finalExtremeSnapshot?.price}`,
    },
    {
      label:
        "More than 1 extremeSnapshot recorded (extreme moved more than once -- check manually against lox-forensic EXTREME_UPDATE lines to confirm some came from candle/market ticks, not only liquidation events)",
      pass: record.extremeSnapshots.length > 1,
      detail: `${record.extremeSnapshots.length} extreme snapshot(s)`,
    },
  ];

  for (const c of checks) {
    console.log(`  ${c.pass ? "\u2713" : "\u2717"} ${c.label}`);
    if (!c.pass) console.log(`      ${c.detail}`);
  }

  console.log(
    `\nTo cross-check that finalExtreme updates came from REAL market ticks (not just liquidation-event prices), compare this episode's extremeSnapshots timestamps against:`,
  );
  console.log(
    `  pm2 logs liquidation-detector --lines 5000 --nostream | grep "${record.symbol}" | grep "EXTREME_UPDATE\\|LIQ_ACCUMULATED"`,
  );
  console.log(
    `An EXTREME_UPDATE with no LIQ_ACCUMULATED at the exact same timestamp means the extreme moved from a candle/bookTicker-driven tick, not a liquidation event.`,
  );

  await mongo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
