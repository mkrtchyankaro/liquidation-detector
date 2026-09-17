import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import {
  loadRawEvents,
  fetchKlines,
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
import type { ForensicEvent } from "../src/domain/liquidation-oi-strategy/forensic-events";

/**
 * Sep 16 2026 (Karo), operator-requested THIRD pass: FORENSIC
 * OBSERVABILITY replay. Feeds real stored data through the ACTUAL
 * production LiquidationOiWatchManager, consuming its structured
 * ForensicEvent stream (not per-tick spam) to print a compact,
 * event-driven forensic log plus a per-episode summary and aggregate
 * counts at the end. Strategy behavior/decision logic is completely
 * unchanged from the prior replay pass -- this only adds observability.
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
function n(x: number | null, digits = 2): string {
  return x === null ? "null" : x.toFixed(digits);
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
      `*** WARNING: zero OI observations found for ${symbol} in [${fmt(fromMs)}, ${fmt(toMs)}] ***`,
    );
  return docs.map((d) => ({
    contracts: d.openInterest,
    fetchedAt:
      d.timestamp instanceof Date
        ? d.timestamp.getTime()
        : new Date(d.timestamp as unknown as string).getTime(),
  }));
}

// ---------------- per-episode forensic summary ----------------

interface EpisodeSummary {
  episodeId: string;
  symbol: string;
  victim: string;
  startTime: number;
  endTime: number | null;
  startPrice: number;
  extreme: number;
  totalLiqUsd: number;
  finalPercentileRank: number | null;
  watchQualified: boolean;
  clearingDetected: boolean;
  entryReady: boolean;
  entryReadyTime: number | null;
  entryBlockedReasons: Set<string>;
  terminalReason: string | null;
  lastMeaningfulProgressTrigger: "LIQ" | "EXTREME" | "OI" | null;
  symbolReleased: boolean | null;
}

const aggregate = {
  episodesStarted: 0,
  watchQualified: 0,
  clearingDetected: 0,
  entryReady: 0,
  observationalEntryReady: 0,
  cancelled: 0,
  noProgressDeaths: 0,
  failsafeDeaths: 0,
  marketDataStaleDeaths: 0,
  entryWindowMissed: 0,
  oppositeEventsIgnored: 0,
};
const episodes = new Map<string, EpisodeSummary>();

function forensicHandler(event: ForensicEvent): void {
  const s = episodes.get(event.episodeId);
  switch (event.type) {
    case "EPISODE_START": {
      episodes.set(event.episodeId, {
        episodeId: event.episodeId,
        symbol: event.symbol,
        victim: event.victim,
        startTime: event.ts,
        endTime: null,
        startPrice: event.startPrice,
        extreme: event.startPrice,
        totalLiqUsd: event.triggerUsd,
        finalPercentileRank: null,
        watchQualified: false,
        clearingDetected: false,
        entryReady: false,
        entryReadyTime: null,
        entryBlockedReasons: new Set(),
        terminalReason: null,
        lastMeaningfulProgressTrigger: null,
        symbolReleased: null,
      });
      aggregate.episodesStarted++;
      console.log(
        `[${fmt(event.ts)}] [EPISODE_START] ${event.symbol} ${event.victim} episodeId=${event.episodeId} triggerUsd=${event.triggerUsd.toFixed(0)} triggerPrice=${event.triggerPrice} startPrice=${event.startPrice} startingOi=${event.startingOi}`,
      );
      break;
    }
    case "LIQ_ACCUMULATED":
      if (s) s.totalLiqUsd = event.newTotal;
      console.log(
        `[${fmt(event.ts)}] [LIQ_ACCUMULATED] ${event.symbol} episodeId=${event.episodeId} eventUsd=${event.eventUsd.toFixed(0)} total ${event.previousTotal.toFixed(0)} -> ${event.newTotal.toFixed(0)} meaningfulLiqProgress=${event.meaningfulLiqProgress}`,
      );
      break;
    case "EXTREME_UPDATE":
      if (s) s.extreme = event.newExtreme;
      console.log(
        `[${fmt(event.ts)}] [EXTREME_UPDATE] ${event.symbol} episodeId=${event.episodeId} ${event.previousExtreme} -> ${event.newExtreme} (extension=${event.extensionPrice})`,
      );
      break;
    case "OI_PROGRESS":
      console.log(
        `[${fmt(event.ts)}] [OI_PROGRESS] ${event.symbol} episodeId=${event.episodeId} startingOi=${event.startingOi} currentOi=${event.currentOi} minOi=${event.minOi} destructionFraction=${n(event.destructionFraction, 4)}`,
      );
      break;
    case "MEANINGFUL_PROGRESS_REFRESH":
      if (s) s.lastMeaningfulProgressTrigger = event.trigger;
      console.log(
        `[${fmt(event.ts)}] [MEANINGFUL_PROGRESS_REFRESH] ${event.symbol} episodeId=${event.episodeId} trigger=${event.trigger} oldTs=${fmt(event.oldTimestamp)} newTs=${fmt(event.newTimestamp)} thresholdCrossed="${event.thresholdCrossed}" oldCheckpoint=${JSON.stringify(event.oldCheckpoint)} newCheckpoint=${JSON.stringify(event.newCheckpoint)}`,
      );
      break;
    case "WATCH_EVALUATION": {
      if (event.result === "PASS" && s) {
        s.watchQualified = true;
        s.finalPercentileRank = event.percentileRank;
        aggregate.watchQualified++;
      }
      console.log(
        `[${fmt(event.ts)}] [WATCH_EVALUATION] ${event.symbol} episodeId=${event.episodeId} result=${event.result} reason=${event.reasonCode} totalLiqUsd=${event.totalLiqUsd.toFixed(0)} percentileRank=${n(event.percentileRank, 1)} required=${event.requiredPercentile} displacementAtr=${n(event.displacementAtr, 3)} requiredDisplacement=${event.requiredDisplacement}`,
      );
      break;
    }
    case "STATE_TRANSITION":
      console.log(
        `[${fmt(event.ts)}] [STATE_TRANSITION] ${event.symbol} episodeId=${event.episodeId} ${event.from} -> ${event.to} (${event.reason})`,
      );
      break;
    case "CLEARING_EVALUATION": {
      if (event.result === "PASS" && s) {
        s.clearingDetected = true;
        aggregate.clearingDetected++;
      }
      const windowsStr = event.windows
        .map(
          (w) =>
            `${w.windowSec}s:${n(w.slopeContractsPerSec, 2)}(n=${w.sampleCount})`,
        )
        .join(" ");
      console.log(
        `[${fmt(event.ts)}] [CLEARING_EVALUATION] ${event.symbol} episodeId=${event.episodeId} result=${event.result} windowsPassed=${event.windowsPassed}/${event.windowsRequired} peakSlope=${n(event.peakDestructionSlopeContractsPerSec, 2)} windows=[${windowsStr}]`,
      );
      break;
    }
    case "ENTRY_GATE_EVALUATION": {
      if (s) {
        if (event.final === "NO_ENTRY")
          event.blockedBy.forEach((b) => s.entryBlockedReasons.add(b));
      }
      console.log(
        `[${fmt(event.ts)}] [ENTRY_GATE_EVALUATION] ${event.symbol} episodeId=${event.episodeId} FINAL=${event.final} blockedBy=[${event.blockedBy.join(",")}] ATR_READY=${event.atrReady.pass}(${event.atrReady.detail}) OI_FRESH=${event.oiFresh.pass}(${event.oiFresh.detail}) CLEARING=${event.clearing.pass}(${event.clearing.detail}) COUNTER_MOVE=${event.counterMove.pass}(${event.counterMove.detail}) DISTANCE=${event.distanceFromExtreme.pass}(${event.distanceFromExtreme.detail})`,
      );
      break;
    }
    case "ENTRY_READY": {
      if (s) {
        s.entryReady = true;
        s.entryReadyTime = event.ts;
      }
      aggregate.entryReady++;
      console.log(
        `[${fmt(event.ts)}] [ENTRY_READY] ${event.symbol} episodeId=${event.episodeId} entryRef=${event.entryReferencePrice} extreme=${event.extreme} totalLiqUsd=${event.totalLiqUsd.toFixed(0)} percentileRank=${n(event.percentileRank, 1)} counterMoveAtr=${n(event.counterMoveAtr, 3)} distanceFromExtremeAtr=${n(event.distanceFromExtremeAtr, 3)}`,
      );
      break;
    }
    case "ENTRY_READY_RESOLUTION": {
      if (event.resolution === "CANCELLED" && !event.globalExecutionEnabled)
        aggregate.observationalEntryReady++;
      console.log(
        `[${fmt(event.ts)}] [ENTRY_READY_RESOLUTION] ${event.symbol} episodeId=${event.episodeId} resolution=${event.resolution} terminalReason=${event.terminalReason} observationEnabled=${event.observationEnabled} globalExecutionEnabled=${event.globalExecutionEnabled} eligibleUsers=${event.eligibleUsers} enabledUsers=${event.enabledUsers} attemptedUsers=${event.attemptedUsers} activeUsers=${event.activeUsers} failedUsers=${event.failedUsers}`,
      );
      break;
    }
    case "EPISODE_TERMINAL": {
      if (s) {
        s.endTime = event.ts;
        s.terminalReason = event.reason;
        s.symbolReleased = event.symbolReleased;
        s.finalPercentileRank =
          event.finalPercentileRank ?? s.finalPercentileRank;
      }
      aggregate.cancelled++;
      if (event.reason === "EPISODE_NO_PROGRESS") aggregate.noProgressDeaths++;
      if (event.reason === "PRE_ENTRY_FAILSAFE_MAX_LIFETIME")
        aggregate.failsafeDeaths++;
      if (event.reason === "MARKET_DATA_STALE_TIMEOUT")
        aggregate.marketDataStaleDeaths++;
      if (event.reason === "ENTRY_WINDOW_MISSED") aggregate.entryWindowMissed++;
      console.log(
        `[${fmt(event.ts)}] [EPISODE_TERMINAL] ${event.symbol} episodeId=${event.episodeId} reason=${event.reason} lifetimeMs=${event.lifetimeMs} (${(event.lifetimeMs / 3_600_000).toFixed(2)}h) finalTotalLiqUsd=${event.finalTotalLiqUsd.toFixed(0)} finalPercentileRank=${n(event.finalPercentileRank, 1)} finalExtreme=${event.finalExtreme} symbolReleased=${event.symbolReleased} detail="${event.detail}"`,
      );
      break;
    }
  }
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
  const priorWindowMs = 3 * 86_400_000;

  console.log(`Symbol: ${symbol}`);
  console.log(`Replay window: ${fmt(fromMs)} -> ${fmt(toMs)}\n`);

  const mongo = new MongoClientWrapper(mongoConfig());
  const rawEvents = await loadRawEvents(symbol, fromMs - priorWindowMs, toMs);
  const oiHistory = await loadOiObservations(
    mongo,
    symbol,
    fromMs - priorWindowMs,
    toMs,
  );
  await mongo.close();

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

  const c1m = await fetchKlinesWithRetry(
    symbol,
    60_000,
    fromMs - 3_600_000,
    toMs,
  );
  const c3m = await fetchKlines(symbol, 180_000, fromMs - 3_600_000, toMs);

  const manager = new LiquidationOiWatchManager(
    DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
    undefined,
    undefined,
    forensicHandler,
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
        : null;
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
        const hist = computeCausalHistoricalPercentile(
          {
            symbol,
            direction: lc.episode.victim,
            endTime: oi.fetchedAt,
            sameDirectionUsd: lc.episode.sameDirectionLiqUsd,
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
      manager.onTick(
        symbol,
        percentileContext,
        oiCursor.slice(-60),
        price,
        atr3m,
        atr3mAgeMs,
        oi.fetchedAt,
      );
    }
  }

  console.log(`\n=== AGGREGATE COUNTS ===`);
  console.log(JSON.stringify(aggregate, null, 2));

  console.log(`\n=== PER-EPISODE SUMMARY (${episodes.size} episodes) ===`);
  for (const s of episodes.values()) {
    console.log(
      JSON.stringify({
        episodeId: s.episodeId,
        startTime: fmt(s.startTime),
        endTime:
          s.endTime !== null ? fmt(s.endTime) : "still open at replay end",
        direction: s.victim,
        startPrice: s.startPrice,
        extreme: s.extreme,
        totalLiqUsd: s.totalLiqUsd,
        finalPercentileRank: s.finalPercentileRank,
        watchQualified: s.watchQualified,
        clearingDetected: s.clearingDetected,
        entryReady: s.entryReady,
        entryReadyTime:
          s.entryReadyTime !== null ? fmt(s.entryReadyTime) : null,
        entryBlockedReasons: [...s.entryBlockedReasons],
        terminalReason: s.terminalReason,
        lifetimeSec:
          s.endTime !== null ? (s.endTime - s.startTime) / 1000 : null,
        lastMeaningfulProgressTrigger: s.lastMeaningfulProgressTrigger,
        symbolReleased: s.symbolReleased,
      }),
    );
  }

  console.log(
    `\n*** CAVEAT: ATR3m used above is a crude (high-low) proxy from raw candles, NOT the real bootstrapped ATRTrackerService/DirectionalAtrTracker value the live bot actually used. Treat ATR-dependent values as approximate; treat episode boundaries, state transitions, and termination reasons as exact. ***`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
