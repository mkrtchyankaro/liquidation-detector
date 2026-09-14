import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import { RotationEpisodeHistoryRepository } from "../src/infrastructure/mongo/rotation-episode-history.repository";
import type { Side } from "../src/shared/common.types";

/**
 * Sep 14 2026 (Karo), operator-requested. Read-only diagnostic --
 * NEVER writes, updates, or deletes anything. Purely for manually
 * spot-checking the largest reconstructed ROTATION episodes (e.g.
 * confirming a huge P95-driving episode is a real, sustained
 * liquidation cascade over a plausible span, not an accidentally
 * merged multi-hour/multi-day segment).
 *
 *   tsx scripts/inspect-rotation-episodes.ts --symbol=BTCUSDT --victim=LONG --limit=10
 *   tsx scripts/inspect-rotation-episodes.ts --symbol=ETHUSDT --victim=LONG --limit=10
 */

interface CliArgs {
  symbol: string;
  victim: Side;
  limit: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };
  const symbol = get("symbol");
  const victimRaw = get("victim");
  const limitRaw = get("limit");
  if (!symbol || !victimRaw) {
    console.error(
      "Usage: inspect-rotation-episodes -- --symbol=BTCUSDT --victim=LONG [--limit=10]",
    );
    process.exit(1);
  }
  const victim = victimRaw.toUpperCase();
  if (victim !== "LONG" && victim !== "SHORT") {
    console.error(`--victim must be LONG or SHORT, got: ${victimRaw}`);
    process.exit(1);
  }
  const limit = limitRaw ? Number(limitRaw) : 10;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`--limit must be a positive number, got: ${limitRaw}`);
    process.exit(1);
  }
  return { symbol: symbol.toUpperCase(), victim, limit };
}

function fmtTs(ms: number): string {
  return `${new Date(ms).toISOString()} (${ms})`;
}

function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return hours > 0
    ? `${hours}h ${minutes}m (${ms}ms)`
    : `${minutes}m (${ms}ms)`;
}

async function main(): Promise<void> {
  const { symbol, victim, limit } = parseArgs(process.argv.slice(2));

  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) {
    console.error("MONGO_URI is not set -- cannot query.");
    process.exit(1);
  }
  const mongo = new MongoClientWrapper(mongoCfg);
  const repo = new RotationEpisodeHistoryRepository(mongo);

  console.log(
    `Top ${limit} ROTATION episodes for ${symbol} ${victim}, ordered by cumulativeLiqUsd descending (read-only, no data modified)\n`,
  );

  const episodes = await repo.findTopEpisodesByLiqUsd(symbol, victim, limit);
  if (episodes.length === 0) {
    console.log("No episodes found for this symbol+victim.");
    process.exit(0);
  }

  episodes.forEach((ep, i) => {
    console.log(`#${i + 1}`);
    console.log(`  episodeStartTs:     ${fmtTs(ep.episodeStartTs)}`);
    console.log(`  episodeEndTs:       ${fmtTs(ep.episodeEndTs)}`);
    console.log(`  durationMs:         ${fmtDuration(ep.durationMs)}`);
    console.log(
      `  cumulativeLiqUsd:   $${ep.cumulativeLiqUsd.toLocaleString()}`,
    );
    console.log(`  eventCount:         ${ep.eventCount}`);
    console.log(
      `  maxSingleLiqUsd:    $${ep.maxSingleLiqUsd.toLocaleString()}`,
    );
    console.log(`  adverseExtremePrice:${ep.adverseExtremePrice}`);
    console.log(`  algorithmVersion:   ${ep.algorithmVersion}`);
    console.log("");
  });

  process.exit(0);
}

main().catch((err) => {
  console.error("[INSPECT_ROTATION_EPISODES_FATAL]", err);
  process.exit(1);
});
