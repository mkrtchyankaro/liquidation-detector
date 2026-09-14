import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import { loadBinanceConfig } from "../src/infrastructure/config/binance.config";
import { BinanceRestClient } from "../src/infrastructure/binance/binanceRest.client";
import { RotationEpisodeHistoryRepository } from "../src/infrastructure/mongo/rotation-episode-history.repository";
import {
  replayRotationEpisodes,
  type HistoricalCandle,
} from "../src/domain/cascade/rotation-episode-replay";
import { V5_TRACKED_SYMBOLS } from "../src/strategy/v5/v5.config";
import type { Liquidation } from "../src/shared/common.types";

/**
 * Sep 14 2026 (Karo), operator-requested. Historical ROTATION episode
 * backfill CLI.
 *
 *   npm run backfill:rotation-episodes -- --from=2026-07-01 --to=2026-09-14
 *   npm run backfill:rotation-episodes -- --from=2026-08-01 --to=2026-09-14 --symbols=BTCUSDT,ETHUSDT
 *
 * Replays raw liquidation events (from Mongo's liq_raw_events, bounded
 * by its own 60-day TTL -- see raw-liquidation-event.repository.ts)
 * and historical closed 1m candles (fetched fresh from Binance's own
 * REST klines endpoint, paginated) through replayRotationEpisodes()
 * -- the SAME CandlePhysicsEngine ROTATION logic live production
 * uses, unmodified. Every completed episode is upserted idempotently
 * into rotation_episode_history; rerunning over the same range is
 * always safe.
 *
 * Does NOT touch v5_global_signals at all -- no fake historical
 * CANCEL or ENTRY signals are ever created (see
 * rotation-episode-replay.ts's own doc comment for exactly why ENTRY
 * is structurally impossible during replay).
 */

interface CliArgs {
  fromMs: number;
  toMs: number;
  symbols: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };
  const fromStr = get("from");
  const toStr = get("to");
  if (!fromStr || !toStr) {
    console.error(
      "Usage: backfill-rotation-episodes -- --from=YYYY-MM-DD --to=YYYY-MM-DD [--symbols=BTCUSDT,ETHUSDT]",
    );
    process.exit(1);
  }
  const fromMs = Date.parse(fromStr);
  const toMs = Date.parse(toStr);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    console.error(`Invalid date range: from=${fromStr} to=${toStr}`);
    process.exit(1);
  }
  const symbolsArg = get("symbols");
  const symbols = symbolsArg
    ? symbolsArg.split(",").map((s) => s.trim().toUpperCase())
    : [...V5_TRACKED_SYMBOLS];
  return { fromMs, toMs, symbols };
}

/** Fetch every raw liquidation event for one symbol in [fromMs, toMs),
 *  sorted ascending by timestamp -- straight Mongo range query, no
 *  pagination needed (a single symbol's own liq_raw_events volume
 *  over the TTL window is small enough for one query; if this ever
 *  becomes untrue, page by timestamp the same way klines are below). */
async function fetchLiquidations(
  mongo: MongoClientWrapper,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Liquidation[]> {
  const col = await mongo.rawLiquidationEvents();
  if (!col) return [];
  const docs = await col
    .find({ symbol, timestamp: { $gte: fromMs, $lt: toMs } })
    .sort({ timestamp: 1 })
    .toArray();
  return docs.map((d) => ({
    symbol: d.symbol,
    side: d.victim === "LONG" ? ("SELL" as const) : ("BUY" as const),
    price: d.price,
    quoteQty: d.quoteQty,
    quantity: d.price > 0 ? d.quoteQty / d.price : 0,
    timestamp: d.timestamp,
  }));
}

/** Fetch every closed 1m candle for one symbol in [fromMs, toMs),
 *  paginated (Binance caps klines at 500/call -- a 60-day range at 1m
 *  is ~86,400 candles, ~173 calls). Sequential, with a small delay
 *  between calls to stay well clear of REST rate limits -- this is an
 *  offline backfill, not a latency-sensitive live path. */
async function fetchHistoricalCandles(
  rest: BinanceRestClient,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<HistoricalCandle[]> {
  const out: HistoricalCandle[] = [];
  let cursor = fromMs;
  const PAGE_LIMIT = 500;
  const MS_PER_CANDLE = 60_000;
  while (cursor < toMs) {
    const pageEnd = Math.min(cursor + PAGE_LIMIT * MS_PER_CANDLE - 1, toMs - 1);
    const candles = await rest.getKlines(
      symbol,
      "1m",
      PAGE_LIMIT,
      cursor,
      pageEnd,
    );
    if (candles.length === 0) break;
    for (const c of candles) {
      if (!c.isClosed) continue; // the most recent candle in a page can be the still-forming current one -- never included
      out.push({
        symbol,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        isClosed: true,
      });
    }
    const lastOpenTime = candles[candles.length - 1]!.openTime;
    if (lastOpenTime <= cursor) break; // safety: no forward progress, avoid an infinite loop on an unexpected API response shape
    cursor = lastOpenTime + MS_PER_CANDLE;
    await new Promise((resolve) => setTimeout(resolve, 150)); // gentle pacing, well under Binance's own REST rate limits
  }
  return out;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sorted[lo]!
    : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

async function main(): Promise<void> {
  const { fromMs, toMs, symbols } = parseArgs(process.argv.slice(2));

  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) {
    console.error("MONGO_URI is not set -- cannot run the backfill.");
    process.exit(1);
  }
  const mongo = new MongoClientWrapper(mongoCfg);
  const rest = new BinanceRestClient(loadBinanceConfig());
  const historyRepo = new RotationEpisodeHistoryRepository(mongo);
  await historyRepo.ensureIndexes();

  console.log(
    `ROTATION historical backfill: ${new Date(fromMs).toISOString()} -> ${new Date(toMs).toISOString()}`,
  );
  console.log(`Symbols: ${symbols.join(", ")}\n`);

  let totalLiqEvents = 0;
  let totalEpisodes = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  const perGroup = new Map<string, number[]>(); // "SYMBOL|VICTIM" -> cumulativeLiqUsd[]
  const skippedGroups: string[] = [];

  for (const symbol of symbols) {
    console.log(`--- ${symbol} ---`);
    const liquidations = await fetchLiquidations(mongo, symbol, fromMs, toMs);
    console.log(`  raw liquidation events: ${liquidations.length}`);
    if (liquidations.length === 0) {
      console.log(
        "  no liquidation activity in this range -- skipping candle fetch",
      );
      continue;
    }
    const candles = await fetchHistoricalCandles(rest, symbol, fromMs, toMs);
    console.log(`  closed 1m candles fetched: ${candles.length}`);
    if (candles.length === 0) {
      console.log(
        "  no candle history available -- skipping (invalid/missing-candle range)",
      );
      skippedGroups.push(`${symbol} (no candles)`);
      continue;
    }

    const { episodes, stats } = replayRotationEpisodes(
      symbol,
      liquidations,
      candles,
    );
    totalLiqEvents += stats.liquidationEventsProcessed;
    totalEpisodes += episodes.length;

    for (const ep of episodes) {
      const doc = {
        symbol: ep.symbol,
        victim: ep.victim,
        episodeStartTs: ep.episodeStartTs,
        episodeEndTs: ep.episodeEndTs,
        cumulativeLiqUsd: ep.cumulativeLiqUsd,
        eventCount: ep.eventCount,
        maxSingleLiqUsd: ep.maxSingleLiqUsd,
        startPrice: ep.startPrice,
        adverseExtremePrice: ep.adverseExtremePrice,
        adverseExtremeTs: ep.adverseExtremeTs,
        preLiqDownAtr: ep.preLiqDownAtr,
        preLiqUpAtr: ep.preLiqUpAtr,
        finalDownAtr: ep.finalDownAtr,
        finalUpAtr: ep.finalUpAtr,
        durationMs: ep.durationMs,
        completionReason: "INACTIVITY" as const,
        entryMode: "ROTATION" as const,
        algorithmVersion: "backfill-v1",
        finalDiagnostics: null,
        source: "backfill" as const,
        createdAt: Date.now(),
      };
      const result = await historyRepo.upsertEpisode(doc);
      if (result === "inserted") totalInserted++;
      else if (result === "duplicate") totalDuplicates++;
      else totalErrors++;

      const groupKey = `${ep.symbol}|${ep.victim}`;
      if (!perGroup.has(groupKey)) perGroup.set(groupKey, []);
      perGroup.get(groupKey)!.push(ep.cumulativeLiqUsd);
    }
    console.log(`  episodes reconstructed: ${episodes.length}\n`);
  }

  console.log("\n=== SUMMARY ===\n");
  console.log(
    `Date range: ${new Date(fromMs).toISOString()} -> ${new Date(toMs).toISOString()}`,
  );
  console.log(`Raw liquidation events processed: ${totalLiqEvents}`);
  console.log(`Completed ROTATION episodes produced: ${totalEpisodes}`);
  console.log(`  inserted: ${totalInserted}`);
  console.log(`  duplicates skipped (already backfilled): ${totalDuplicates}`);
  console.log(`  errors: ${totalErrors}`);
  if (skippedGroups.length > 0)
    console.log(
      `Symbols skipped entirely (no candle history): ${skippedGroups.join(", ")}`,
    );

  console.log("\nPer symbol+victim:\n");
  const rows: string[] = [];
  const lowSampleGroups: string[] = [];
  for (const symbol of symbols) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const key = `${symbol}|${victim}`;
      const values = (perGroup.get(key) ?? []).slice().sort((a, b) => a - b);
      const p50 = percentile(values, 0.5);
      const p90 = percentile(values, 0.9);
      const p95 = percentile(values, 0.95);
      const label = `${symbol.padEnd(9)} ${victim.padEnd(5)}`;
      if (values.length === 0) {
        rows.push(`${label} -> 0 episodes`);
        lowSampleGroups.push(key);
        continue;
      }
      rows.push(
        `${label} -> ${String(values.length).padStart(5)} episodes -> P50 $${p50!.toFixed(0)} · P90 $${p90!.toFixed(0)} · P95 $${p95!.toFixed(0)}`,
      );
      if (values.length < 20) lowSampleGroups.push(`${key} (${values.length})`);
    }
  }
  console.log(rows.join("\n"));
  if (lowSampleGroups.length > 0) {
    console.log(
      `\nGroups with fewer than 20 samples (causal P95 will still be null/unavailable for these until more history accumulates): ${lowSampleGroups.join(", ")}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[BACKFILL_FATAL]", err);
  process.exit(1);
});
