import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import {
  loadRawEvents,
  fetchKlines,
  computeAtrSeries,
  reconstructCompleteEpisodes,
  episodeUsd,
} from "../src/domain/research/displacement-balanced-core";
import {
  computeCausalHistoricalPercentile,
  type CompletedEpisodeRef,
} from "../src/domain/research/episode-historical-percentile";
import { fetchKlinesWithRetry } from "../src/domain/research/research-fetch-retry";
import { LiquidationOiWatchManager } from "../src/domain/liquidation-oi-strategy/liquidation-oi-watch-manager";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
import type { OiHistorySample } from "../src/domain/liquidation-oi-strategy/oi-clearing-detector";

/**
 * Sep 16 2026 (Karo), operator-requested. READ-ONLY forensic replay.
 * Feeds REAL stored data through the ACTUAL production
 * LiquidationOiWatchManager (the exact class market-data-orchestrator.ts
 * drives live) in timestamp order -- not a reimplementation. Prints
 * every state transition and every rejection reason as they occur,
 * plus the ignored-opposite-event log explicitly (to catch the
 * stale-episode-blocking bug directly if it occurred).
 *
 * Requires MONGO_URI and network access to Binance -- run this on the
 * server that actually has the real data, not in an isolated sandbox.
 *
 *   npx tsx scripts/replay-liquidation-oi-episode.ts BTCUSDT "2026-09-16 00:00" "2026-09-16 23:59"
 */

function parseUtcDatetime(input: string): number {
  if (input.trim().toLowerCase() === "now") return Date.now();
  let s = input.trim();
  const hasExplicitOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!hasExplicitOffset) s = s + "Z";
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Could not parse datetime: "${input}"`);
  return ms;
}
function fmt(ms: number): string {
  return new Date(ms).toISOString();
}

function mongoConfig(): MongoDetectorConfig {
  return {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
}

async function loadOiObservations(
  mongo: MongoClientWrapper,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<OiHistorySample[]> {
  const col = await mongo.oiSecondObservations();
  if (!col)
    throw new Error(
      "Could not obtain oi_second_observations collection -- check MONGO_URI",
    );
  const docs = await col
    .find({
      symbol,
      timestamp: { $gte: new Date(fromMs), $lte: new Date(toMs) },
    })
    .sort({ timestamp: 1 })
    .toArray();
  if (docs.length === 0)
    console.log(
      `*** WARNING: zero OI observations found for ${symbol} in [${fmt(fromMs)}, ${fmt(toMs)}] -- either persistence hadn't started yet, or this window predates it. ***`,
    );
  return docs.map((d) => ({
    contracts: d.openInterest,
    fetchedAt:
      d.timestamp instanceof Date
        ? d.timestamp.getTime()
        : new Date(d.timestamp as unknown as string).getTime(),
  }));
}

async function main(): Promise<void> {
  const [, , symbolArg, fromArg, toArg] = process.argv;
  if (!symbolArg || !fromArg || !toArg) {
    console.error(
      'Usage: npx tsx scripts/replay-liquidation-oi-episode.ts SYMBOL "FROM" "TO"',
    );
    process.exit(1);
  }
  const symbol = symbolArg.toUpperCase();
  const fromMs = parseUtcDatetime(fromArg);
  const toMs = parseUtcDatetime(toArg);
  const priorWindowMs = 3 * 86_400_000; // matches EpisodePercentileService's own rolling-3-day window

  console.log(`Symbol: ${symbol}`);
  console.log(`Replay window: ${fmt(fromMs)} -> ${fmt(toMs)}`);
  console.log(
    `Percentile context window: ${fmt(fromMs - priorWindowMs)} -> ${fmt(fromMs)} (prior 3 days)\n`,
  );

  const mongo = new MongoClientWrapper(mongoConfig());
  const rawEvents = await loadRawEvents(symbol, fromMs - priorWindowMs, toMs);
  const oiHistory = await loadOiObservations(
    mongo,
    symbol,
    fromMs - priorWindowMs,
    toMs,
  );
  await mongo.close();

  console.log(
    `Raw liquidation events loaded: ${rawEvents.length} (including prior-window context)`,
  );
  console.log(`OI observations loaded: ${oiHistory.length}\n`);

  // ---- percentile context: prior completed DISPLACEMENT_BALANCED episodes, matching what EpisodePercentileService actually tracks in production ----
  const priorResult = await reconstructCompleteEpisodes(
    symbol,
    fromMs - priorWindowMs,
    fromMs,
    6 * 3_600_000,
  );
  const priorRefs: CompletedEpisodeRef[] = priorResult.episodes.map((e) => ({
    symbol,
    direction: e.direction,
    endTime: e.endTime!,
    sameDirectionUsd: episodeUsd(e),
  }));
  console.log(
    `Prior completed DISPLACEMENT_BALANCED episodes for percentile context: ${priorRefs.length}`,
  );
  console.log(
    `(left-censored excluded: ${priorResult.leftCensoredExcluded}, right-censored excluded: ${priorResult.rightCensoredExcluded})\n`,
  );

  // ---- candles for the replay window itself (price + a crude ATR proxy) ----
  const c1m = await fetchKlinesWithRetry(
    symbol,
    60_000,
    fromMs - 3_600_000,
    toMs,
  );
  const c3m = await fetchKlines(symbol, 180_000, fromMs - 3_600_000, toMs);
  void computeAtrSeries; // available if a proper Wilder ATR reconstruction is wanted later -- not used for the crude proxy below

  // ---- feed the REAL production LiquidationOiWatchManager, in timestamp order ----
  const manager = new LiquidationOiWatchManager(
    DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
  );
  const eventsInWindow = rawEvents
    .filter((e) => e.timestamp >= fromMs && e.timestamp <= toMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  const oiInWindow = oiHistory
    .filter((o) => o.fetchedAt >= fromMs && o.fetchedAt <= toMs)
    .sort((a, b) => a.fetchedAt - b.fetchedAt);

  type StreamItem = { ts: number; kind: "liq" | "oi_tick" };
  const stream: StreamItem[] = [
    ...eventsInWindow.map((e) => ({ ts: e.timestamp, kind: "liq" as const })),
    ...oiInWindow.map((o) => ({ ts: o.fetchedAt, kind: "oi_tick" as const })),
  ].sort((a, b) => a.ts - b.ts);

  let lastState: string | null = null;
  const oiCursor: OiHistorySample[] = [];
  for (const item of stream) {
    if (item.kind === "liq") {
      const ev = eventsInWindow.find((e) => e.timestamp === item.ts)!;
      manager.onLiquidationEvent(
        {
          symbol,
          victim: ev.victim,
          timestamp: ev.timestamp,
          price: ev.price,
          quoteQty: ev.quoteQty,
        },
        null,
      );
      console.log(
        `[${fmt(ev.timestamp)}] LIQUIDATION ${ev.victim} price=${ev.price} usd=${ev.quoteQty.toFixed(0)}`,
      );
    } else {
      const oi = oiInWindow.find((o) => o.fetchedAt === item.ts)!;
      oiCursor.push(oi);
      const candle = [...c1m]
        .filter((c) => c.closeTime <= oi.fetchedAt)
        .sort((a, b) => b.closeTime - a.closeTime)[0];
      const price = candle?.close ?? null;
      if (price === null) continue;
      const atr3mCandle = [...c3m]
        .filter((c) => c.closeTime <= oi.fetchedAt)
        .sort((a, b) => b.closeTime - a.closeTime)[0];
      const atr3m = atr3mCandle
        ? Math.abs(atr3mCandle.high - atr3mCandle.low)
        : null; // crude proxy -- see report's own caveat
      const atr3mAgeMs = atr3mCandle
        ? oi.fetchedAt - atr3mCandle.closeTime
        : null;

      const lc = manager.getLifecycle(symbol);
      if (lc === null) continue;

      let percentileContext = {
        historicalSampleCount: 0,
        historicalP90: null as number | null,
        historicalP95: null as number | null,
        historicalP99: null as number | null,
        percentileRank: null as number | null,
      };
      if (lc.globalState === "EPISODE_TRACKING") {
        const sameDirUsd = lc.episode.sameDirectionLiqUsd;
        const hist = computeCausalHistoricalPercentile(
          {
            symbol,
            direction: lc.episode.victim,
            endTime: oi.fetchedAt,
            sameDirectionUsd: sameDirUsd,
          },
          priorRefs,
        );
        percentileContext = {
          historicalSampleCount: hist.historicalSampleCount,
          historicalP90: hist.historicalP90,
          historicalP95: hist.historicalP95,
          historicalP99: null,
          percentileRank: hist.percentileRank,
        };
      }

      await manager.onTick(
        symbol,
        percentileContext,
        oiCursor.slice(-60),
        price,
        atr3m,
        atr3mAgeMs,
        oi.fetchedAt,
      );
      const after = manager.getLifecycle(symbol);
      const stateNow = after ? `${after.globalState}` : "IDLE";
      if (stateNow !== lastState) {
        console.log(
          `[${fmt(oi.fetchedAt)}] STATE -> ${stateNow} (price=${price} oi=${oi.contracts})`,
        );
        if (after?.watchResult && !after.watchResult.qualifies)
          console.log(
            `    WATCH rejection: ${after.watchResult.reasonCode} -- ${after.watchResult.detail}`,
          );
        if (after?.entryResult && !after.entryResult.entryReady)
          console.log(
            `    ENTRY rejection: ${after.entryResult.reasonCode} -- ${after.entryResult.detail}`,
          );
        lastState = stateNow;
      }
    }
  }

  console.log(`\n=== FINAL STATE ===`);
  const finalLc = manager.getLifecycle(symbol);
  console.log(
    finalLc
      ? `${finalLc.globalState}`
      : "no tracked lifecycle (IDLE) at end of window",
  );

  console.log(
    `\n=== NO-SIGNAL LOG (${manager.getNoSignalLog().length} entries) ===`,
  );
  for (const n of manager.getNoSignalLog())
    console.log(
      `  [${fmt(n.timestamp)}] ${n.symbol} ${n.victim} ${n.atStage} ${n.reasonCode}: ${n.detail}`,
    );

  console.log(
    `\n=== OPPOSITE-EVENT-IGNORED LOG (${manager.getOppositeEventIgnoredLog().length} entries) -- directly surfaces the stale-episode-blocking bug if it occurred ===`,
  );
  for (const o of manager.getOppositeEventIgnoredLog())
    console.log(
      `  [${fmt(o.timestamp)}] ${o.symbol} tracked=${o.trackedVictim} IGNORED opposite ${o.ignoredVictim} usd=${o.ignoredQuoteQty.toFixed(0)} <-- if near your BOTTOM/TOP timestamps, THIS is why the opposite candidate never got its own episode`,
    );

  console.log(
    `\n*** CAVEAT: ATR3m used above is a crude (high-low) proxy from raw candles, NOT the real bootstrapped ATRTrackerService/DirectionalAtrTracker value the live bot actually used -- this replay cannot reconstruct that exactly offline. Treat ATR-dependent gate values (DISPLACEMENT_ATR, counterMoveAtr, distanceFromExtremeAtr) as approximate; treat WATCH/CLEARING/ENTRY state transitions and the opposite-event-ignored log as exact, since those don't depend on this proxy. ***`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
