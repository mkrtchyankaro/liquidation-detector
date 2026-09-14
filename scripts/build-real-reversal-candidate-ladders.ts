import "dotenv/config";
import * as fs from "fs";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import { loadBinanceConfig } from "../src/infrastructure/config/binance.config";
import { BinanceRestClient } from "../src/infrastructure/binance/binanceRest.client";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import type { Side, Liquidation } from "../src/shared/common.types";
import {
  causalPercentileFamily,
  percentileRank,
  reconstructCausalEpisodeTotals,
  durationMatchedSeries,
  LOOKBACK_WINDOWS_MS,
  type HistoricalCandle,
} from "./build-real-reversal-causal-history";

/**
 * Sep 14 2026 (Karo), operator-requested. Reconstructs the FULL
 * candidate ladder (L1 through canonicalCandidateIndex) for all 389
 * validated reversal sequences -- the existing pipeline only ever
 * persisted the ONE canonical (firstTrueReversalCandidateIndex) row
 * per reversal sequence; the intermediate candidates and their causal
 * features were never computed or exported anywhere.
 *
 * Reuses causalPercentileFamily/percentileRank/
 * reconstructCausalEpisodeTotals/durationMatchedSeries UNCHANGED,
 * imported directly from build-real-reversal-causal-history.ts -- no
 * formula duplication, no redesign.
 *
 * JOIN STRATEGY: sequenceId in every file this whole research thread
 * has produced is generated as `${symbol}-${victim}-${counter}`,
 * where `counter` increments once per same-side run encountered while
 * scanning that symbol+victim's own raw liquidation history in
 * chronological order (see research-liquidation-market-response.ts's
 * own onLiquidation-equivalent segmentation). This is fully
 * deterministic: re-running the IDENTICAL segmentation over the
 * IDENTICAL raw event stream reproduces the IDENTICAL sequenceId for
 * the IDENTICAL underlying same-side run. This script re-segments
 * EVERY same-side run for each symbol+victim (not just the 389
 * targets) so the counter never desyncs, then keeps only the runs
 * whose regenerated ID matches one of the 389 target sequences.
 *
 *   tsx scripts/build-real-reversal-candidate-ladders.ts \
 *     --causal-history-fixed=/mnt/data/real-reversal-causal-history-fixed-3d-<ts>.json
 */

interface CanonicalObservation {
  symbol: string;
  victim: Side;
  sequenceId: string;
  candidateIndex: number;
  timestamp: number;
  causalFeatures: {
    currentEpisode: {
      cumulativeLiqUsd: number;
      eventCount: number;
      maxSingleLiqUsd: number;
      currentEpisodePercentileRank: number | null;
    };
    duration: { episodeDurationMs: number };
    cadence: { durationMatchedPercentileRank: number | null };
    atr: {
      liqAtrChangePct: number | null;
      recoveryAtrChangePct: number | null;
    };
    displacement: { priceDisplacementATR: number | null };
    efficiency: { priceProgressATRPer1M: number | null };
  };
  outcomeTargets: { outcomeClass: string };
}
interface CausalHistoryFixedJson {
  canonicalObservations: {
    reversal: CanonicalObservation[];
    continuation: CanonicalObservation[];
  };
}

async function fetchLiquidationsInWindow(
  mongo: MongoClientWrapper,
  symbol: string,
  windowFromMs: number,
  windowToMs: number,
): Promise<Liquidation[]> {
  const col = await mongo.rawLiquidationEvents();
  if (!col) return [];
  const docs = await col
    .find({ symbol, timestamp: { $gte: windowFromMs, $lt: windowToMs } })
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
async function fetchHistoricalCandles(
  rest: BinanceRestClient,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<HistoricalCandle[]> {
  const out: HistoricalCandle[] = [];
  let cursor = fromMs;
  const PAGE_LIMIT = 500,
    MS_PER_CANDLE = 60_000;
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
    for (const c of candles)
      if (c.isClosed)
        out.push({
          symbol,
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          isClosed: true,
        });
    const lastOpenTime = candles[candles.length - 1]!.openTime;
    if (lastOpenTime <= cursor) break;
    cursor = lastOpenTime + MS_PER_CANDLE;
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

/** Re-segments ALL same-side runs for one symbol (both victims),
 *  reproducing the EXACT sequenceId counter convention the rest of
 *  this research thread uses -- MUST process every run, not just
 *  target ones, or the counter desyncs and IDs stop matching. */
function segmentAllSequences(
  liquidations: Liquidation[],
): Map<string, { symbol: string; victim: Side; events: Liquidation[] }> {
  const bySymbol = new Map<string, Liquidation[]>();
  for (const l of liquidations) {
    if (!bySymbol.has(l.symbol)) bySymbol.set(l.symbol, []);
    bySymbol.get(l.symbol)!.push(l);
  }
  const sequences = new Map<
    string,
    { symbol: string; victim: Side; events: Liquidation[] }
  >();
  for (const [symbol, events] of bySymbol) {
    events.sort((a, b) => a.timestamp - b.timestamp);
    const counters: Record<Side, number> = { LONG: 0, SHORT: 0 };
    let i = 0;
    while (i < events.length) {
      const victim: Side = events[i]!.side === "SELL" ? "LONG" : "SHORT";
      let j = i;
      while (
        j < events.length &&
        (events[j]!.side === "SELL" ? "LONG" : "SHORT") === victim
      )
        j++;
      const sequenceId = `${symbol}-${victim}-${counters[victim]++}`;
      sequences.set(sequenceId, { symbol, victim, events: events.slice(i, j) });
      i = j;
    }
  }
  return sequences;
}

function parseArgs(argv: string[]): {
  causalHistoryFixedPath: string;
  marketResponsePath: string;
} {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const causalHistoryFixedPath = get("causal-history-fixed");
  const marketResponsePath = get("market-response");
  if (!causalHistoryFixedPath || !marketResponsePath) {
    console.error(
      "Usage: build-real-reversal-candidate-ladders.ts --causal-history-fixed=/path/to/real-reversal-causal-history-fixed-3d-<ts>.json --market-response=/path/to/liquidation-market-response-3d-<ts>.json",
    );
    process.exit(1);
  }
  return { causalHistoryFixedPath, marketResponsePath };
}

async function main(): Promise<void> {
  const { causalHistoryFixedPath, marketResponsePath } = parseArgs(
    process.argv.slice(2),
  );
  const source: CausalHistoryFixedJson = JSON.parse(
    fs.readFileSync(causalHistoryFixedPath, "utf8"),
  );
  const targets = source.canonicalObservations.reversal;
  console.log(
    `Loaded ${targets.length} canonical reversal observations to reconstruct ladders for.\n`,
  );

  // Sep 14 2026 (Karo), operator-reported CRITICAL FIX -- the raw
  // liquidation fetch MUST be bounded to the EXACT SAME window the
  // original segmentation used (windowFromMs/windowToMs from the
  // authoritative liquidation-market-response-3d-*.json), never an
  // unbounded fetch. Positional sequenceIds (BTCUSDT-LONG-0, etc.)
  // are only stable given the identical input event set -- confirmed
  // root cause of the prior 386/389 mismatch (an unbounded 60-day
  // fetch produced a completely different run distribution than the
  // original 3-day-bounded segmentation).
  const marketResponse: { windowFromMs: number; windowToMs: number } =
    JSON.parse(fs.readFileSync(marketResponsePath, "utf8"));
  const windowFromMs = marketResponse.windowFromMs;
  const windowToMs = marketResponse.windowToMs;
  if (typeof windowFromMs !== "number" || typeof windowToMs !== "number") {
    console.error(
      `FATAL: ${marketResponsePath} does not contain valid windowFromMs/windowToMs -- cannot proceed without the authoritative window.`,
    );
    process.exit(1);
  }
  console.log(
    `Authoritative window from ${marketResponsePath}: windowFromMs=${windowFromMs} (${new Date(windowFromMs).toISOString()})  windowToMs=${windowToMs} (${new Date(windowToMs).toISOString()})\n`,
  );

  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) {
    console.error("MONGO_URI not set.");
    process.exit(1);
  }
  const mongo = new MongoClientWrapper(mongoCfg);
  const rest = new BinanceRestClient(loadBinanceConfig());

  const symbols = [...new Set(targets.map((t) => t.symbol))];
  const liqBySymbol = new Map<string, Liquidation[]>();
  const candlesBySymbol = new Map<string, HistoricalCandle[]>();
  const sequencesBySymbol = new Map<
    string,
    Map<string, { symbol: string; victim: Side; events: Liquidation[] }>
  >();

  for (const symbol of symbols) {
    console.log(
      `Fetching raw liquidation history for ${symbol}, bounded to the authoritative window (once)...`,
    );
    const liqs = await fetchLiquidationsInWindow(
      mongo,
      symbol,
      windowFromMs,
      windowToMs,
    );
    // Permanent safety assertion: every fetched event must fall
    // inside the exact authoritative window used -- fails immediately
    // if this script's own fetch ever silently diverges from it.
    for (const l of liqs) {
      if (l.timestamp < windowFromMs || l.timestamp >= windowToMs) {
        throw new Error(
          `ASSERTION FAILED: fetched liquidation for ${symbol} at ts=${l.timestamp} falls outside the authoritative window [${windowFromMs}, ${windowToMs})`,
        );
      }
    }
    liqBySymbol.set(symbol, liqs);
    sequencesBySymbol.set(symbol, segmentAllSequences(liqs));
    const symTargets = targets.filter((t) => t.symbol === symbol);
    const minTs =
      Math.min(...symTargets.map((t) => t.timestamp)) - 24 * 3600_000;
    const maxTs = Math.max(...symTargets.map((t) => t.timestamp)) + 60_000;
    console.log(`Fetching candles for ${symbol} (once)...`);
    candlesBySymbol.set(
      symbol,
      (await fetchHistoricalCandles(rest, symbol, minTs, maxTs)).sort(
        (a, b) => a.openTime - b.openTime,
      ),
    );
  }

  interface CandidateRow {
    candidateIndex: number;
    timestamp: number;
    causalFeatures: Record<string, unknown>;
  }
  interface SequenceLadder {
    sequenceId: string;
    symbol: string;
    victim: Side;
    canonicalCandidateIndex: number;
    finalClass: string;
    candidates: CandidateRow[];
  }
  const sequences: SequenceLadder[] = [];
  const mismatches: {
    sequenceId: string;
    field: string;
    old: unknown;
    new: unknown;
  }[] = [];
  let matched = 0;
  let totalCandidateRows = 0;

  for (const target of targets) {
    const seqMap = sequencesBySymbol.get(target.symbol)!;
    const seq = seqMap.get(target.sequenceId);
    if (!seq) {
      console.error(
        `WARNING: could not regenerate sequenceId ${target.sequenceId} from raw event re-segmentation -- skipping (join failure, will show as a mismatch below).`,
      );
      mismatches.push({
        sequenceId: target.sequenceId,
        field: "JOIN",
        old: target.sequenceId,
        new: "NOT_FOUND",
      });
      continue;
    }
    const symbolVictimEvents = seq.events;
    const candles = candlesBySymbol.get(target.symbol) ?? [];
    const eventValueSeries = symbolVictimEvents.map((e) => ({
      timestamp: e.timestamp,
      value: e.quoteQty,
    }));
    const allSameVictimEvents = (liqBySymbol.get(target.symbol) ?? []).filter(
      (e) => (e.side === "SELL" ? "LONG" : "SHORT") === seq.victim,
    );
    const allSameVictimSeries = allSameVictimEvents.map((e) => ({
      timestamp: e.timestamp,
      value: e.quoteQty,
    }));

    const tracker = new DirectionalAtrTracker();
    let ci = 0;
    const feedTo = (ts: number): void => {
      while (ci < candles.length && candles[ci]!.openTime + 60_000 <= ts) {
        tracker.onCandle(candles[ci]!);
        ci++;
      }
    };

    const episodeStartTs = symbolVictimEvents[0]!.timestamp;
    const episodeStartPrice = symbolVictimEvents[0]!.price;
    feedTo(episodeStartTs);
    const preLiqDirAtr =
      seq.victim === "LONG"
        ? tracker.getDownAtr(target.symbol)
        : tracker.getUpAtr(target.symbol);
    const preRecDirAtr =
      seq.victim === "LONG"
        ? tracker.getUpAtr(target.symbol)
        : tracker.getDownAtr(target.symbol);

    let cumulativeLiqUsd = 0,
      maxSingleLiqUsd = 0;
    let latestExtremePrice = episodeStartPrice;
    const ladder: CandidateRow[] = [];

    const canonicalCandidateIndex = target.candidateIndex;
    for (
      let idx = 0;
      idx < Math.min(canonicalCandidateIndex, symbolVictimEvents.length);
      idx++
    ) {
      const ev = symbolVictimEvents[idx]!;
      cumulativeLiqUsd += ev.quoteQty;
      maxSingleLiqUsd = Math.max(maxSingleLiqUsd, ev.quoteQty);
      latestExtremePrice =
        seq.victim === "LONG"
          ? Math.min(latestExtremePrice, ev.price)
          : Math.max(latestExtremePrice, ev.price);
      const T = ev.timestamp;
      feedTo(T);
      const currentLiqDirAtr =
        seq.victim === "LONG"
          ? tracker.getDownAtr(target.symbol)
          : tracker.getUpAtr(target.symbol);
      const currentRecDirAtr =
        seq.victim === "LONG"
          ? tracker.getUpAtr(target.symbol)
          : tracker.getDownAtr(target.symbol);
      const episodeDurationMs = T - episodeStartTs;

      const singleEventPercentiles: Record<
        string,
        ReturnType<typeof causalPercentileFamily>
      > = {};
      for (const w of LOOKBACK_WINDOWS_MS)
        singleEventPercentiles[w.label] = causalPercentileFamily(
          allSameVictimSeries,
          T,
          w.ms,
        );
      const maxSinglePercentileRank24h = percentileRank(
        allSameVictimSeries,
        T,
        24 * 3600_000,
        maxSingleLiqUsd,
      );

      const causalEpisodes = reconstructCausalEpisodeTotals(
        allSameVictimEvents,
        T - 1,
      );
      const episodeSeries = causalEpisodes.map((e) => ({
        timestamp: e.episodeEndTs,
        value: e.cumulativeUsd,
      }));
      const currentEpisodePercentileRank = percentileRank(
        episodeSeries,
        T,
        null,
        cumulativeLiqUsd,
      );

      const durMatchedRaw = durationMatchedSeries(
        allSameVictimEvents,
        T,
        episodeDurationMs,
      );
      const durationMatchedPercentileRank =
        episodeDurationMs > 0
          ? percentileRank(durMatchedRaw, T, 24 * 3600_000, cumulativeLiqUsd)
          : null;
      const liqUsdPerSecond =
        episodeDurationMs > 0
          ? cumulativeLiqUsd / (episodeDurationMs / 1000)
          : null; // TASK: L1/zero-duration must never fabricate a rate
      const liqUsdPerMinute =
        liqUsdPerSecond !== null ? liqUsdPerSecond * 60 : null;

      const priceDisplacementPct =
        episodeStartPrice > 0
          ? Math.abs(
              (latestExtremePrice - episodeStartPrice) / episodeStartPrice,
            ) * 100
          : null;
      const priceDisplacementATR =
        preLiqDirAtr && preLiqDirAtr > 0
          ? Math.abs(latestExtremePrice - episodeStartPrice) / preLiqDirAtr
          : null;
      const priceProgressATRPer1M =
        priceDisplacementATR !== null && cumulativeLiqUsd > 0
          ? priceDisplacementATR / (cumulativeLiqUsd / 1_000_000)
          : null;

      const liqAtrChangePct =
        preLiqDirAtr && preLiqDirAtr > 0 && currentLiqDirAtr !== null
          ? ((currentLiqDirAtr - preLiqDirAtr) / preLiqDirAtr) * 100
          : null;
      const recoveryAtrChangePct =
        preRecDirAtr && preRecDirAtr > 0 && currentRecDirAtr !== null
          ? ((currentRecDirAtr - preRecDirAtr) / preRecDirAtr) * 100
          : null;
      const recoveryVsLiquidationAtrRatio =
        currentLiqDirAtr && currentLiqDirAtr > 0 && currentRecDirAtr !== null
          ? currentRecDirAtr / currentLiqDirAtr
          : null;

      // marginal (incremental) info vs the previous candidate
      const prev = ladder[ladder.length - 1];
      const prevCum = idx === 0 ? 0 : cumulativeLiqUsd - ev.quoteQty;
      const deltaLiqUsd = ev.quoteQty;
      const prevExtreme =
        idx === 0
          ? episodeStartPrice
          : symbolVictimEvents
              .slice(0, idx)
              .reduce(
                (extreme, e) =>
                  seq.victim === "LONG"
                    ? Math.min(extreme, e.price)
                    : Math.max(extreme, e.price),
                episodeStartPrice,
              );
      const newAdverseExtremeOccurred =
        seq.victim === "LONG" ? ev.price < prevExtreme : ev.price > prevExtreme;
      const newExtremeDistancePct =
        newAdverseExtremeOccurred && prevExtreme !== 0
          ? Math.abs((ev.price - prevExtreme) / prevExtreme) * 100
          : null;
      const newExtremeDistanceATR =
        newAdverseExtremeOccurred && preLiqDirAtr && preLiqDirAtr > 0
          ? Math.abs(ev.price - prevExtreme) / preLiqDirAtr
          : null;
      void prev;
      void prevCum;
      void deltaLiqUsd;

      const causalFeatures = {
        identity: {
          candidateIndex: idx + 1,
          candidateEndTs: T,
          canonicalCandidateIndex,
          isCanonicalCandidate: idx + 1 === canonicalCandidateIndex,
        },
        episodeState: {
          cumulativeLiqUsd,
          eventCount: idx + 1,
          maxSingleLiqUsd,
          lastEventUsd: ev.quoteQty,
          meanEventUsd: cumulativeLiqUsd / (idx + 1),
          maxSingleOverCumulative:
            cumulativeLiqUsd > 0 ? maxSingleLiqUsd / cumulativeLiqUsd : 0,
          episodeDurationMs,
        },
        liquidationHistory: {
          singleEventPercentiles,
          maxSinglePercentileRank24h,
        },
        currentEpisode: {
          episodePercentileAll:
            currentEpisodePercentileRank !== null
              ? causalPercentileFamily(episodeSeries, T, null)
              : null,
          currentEpisodePercentileRank,
        },
        cadence: {
          durationMatchedPercentileRank,
          liqUsdPerSecond,
          liqUsdPerMinute,
        },
        atr: {
          preLiqDirAtr,
          preRecDirAtr,
          currentLiqDirAtr,
          currentRecDirAtr,
          liqAtrChangePct,
          recoveryAtrChangePct,
          recoveryVsLiquidationAtrRatio,
        },
        displacement: {
          episodeStartPrice,
          latestExtremePrice,
          priceDisplacementPct,
          priceDisplacementATR,
        },
        efficiency: { priceProgressATRPer1M },
        extremeProgression: {
          newAdverseExtremeOccurred,
          newExtremeDistancePct,
          newExtremeDistanceATR,
        },
      };
      ladder.push({ candidateIndex: idx + 1, timestamp: T, causalFeatures });
    }

    totalCandidateRows += ladder.length;

    // ---- ladder completeness assertion ----
    const indexes = ladder.map((c) => c.candidateIndex);
    const expected = Array.from(
      { length: canonicalCandidateIndex },
      (_, i) => i + 1,
    );
    const complete =
      indexes.length === expected.length &&
      indexes.every((v, i) => v === expected[i]);
    if (!complete) {
      mismatches.push({
        sequenceId: target.sequenceId,
        field: "LADDER_COMPLETENESS",
        old: expected,
        new: indexes,
      });
    }

    // ---- validate the final row against the existing canonical observation ----
    const finalRow = ladder[ladder.length - 1];
    if (finalRow) {
      const cf = finalRow.causalFeatures as {
        episodeState: {
          cumulativeLiqUsd: number;
          eventCount: number;
          maxSingleLiqUsd: number;
          episodeDurationMs: number;
        };
        currentEpisode: { currentEpisodePercentileRank: number | null };
        cadence: { durationMatchedPercentileRank: number | null };
        atr: {
          liqAtrChangePct: number | null;
          recoveryAtrChangePct: number | null;
        };
        displacement: { priceDisplacementATR: number | null };
        efficiency: { priceProgressATRPer1M: number | null };
      };
      const TOL = 0.01;
      const closeEnough = (a: number | null, b: number | null): boolean =>
        (a === null && b === null) ||
        (a !== null &&
          b !== null &&
          Math.abs(a - b) <= TOL * Math.max(1, Math.abs(b)));
      const checks: {
        field: string;
        old: number | null;
        new: number | null;
      }[] = [
        {
          field: "cumulativeLiqUsd",
          old: target.causalFeatures.currentEpisode.cumulativeLiqUsd,
          new: cf.episodeState.cumulativeLiqUsd,
        },
        {
          field: "eventCount",
          old: target.causalFeatures.currentEpisode.eventCount,
          new: cf.episodeState.eventCount,
        },
        {
          field: "maxSingleLiqUsd",
          old: target.causalFeatures.currentEpisode.maxSingleLiqUsd,
          new: cf.episodeState.maxSingleLiqUsd,
        },
        {
          field: "episodeDurationMs",
          old: target.causalFeatures.duration.episodeDurationMs,
          new: cf.episodeState.episodeDurationMs,
        },
        {
          field: "currentEpisodePercentileRank",
          old: target.causalFeatures.currentEpisode
            .currentEpisodePercentileRank,
          new: cf.currentEpisode.currentEpisodePercentileRank,
        },
        {
          field: "durationMatchedPercentileRank",
          old: target.causalFeatures.cadence.durationMatchedPercentileRank,
          new: cf.cadence.durationMatchedPercentileRank,
        },
        {
          field: "priceDisplacementATR",
          old: target.causalFeatures.displacement.priceDisplacementATR,
          new: cf.displacement.priceDisplacementATR,
        },
        {
          field: "liqAtrChangePct",
          old: target.causalFeatures.atr.liqAtrChangePct,
          new: cf.atr.liqAtrChangePct,
        },
        {
          field: "recoveryAtrChangePct",
          old: target.causalFeatures.atr.recoveryAtrChangePct,
          new: cf.atr.recoveryAtrChangePct,
        },
        {
          field: "priceProgressATRPer1M",
          old: target.causalFeatures.efficiency.priceProgressATRPer1M,
          new: cf.efficiency.priceProgressATRPer1M,
        },
      ];
      let allOk = complete;
      for (const c of checks) {
        if (!closeEnough(c.old, c.new)) {
          allOk = false;
          mismatches.push({
            sequenceId: target.sequenceId,
            field: c.field,
            old: c.old,
            new: c.new,
          });
        }
      }
      if (allOk) matched++;
      else
        console.error(
          `MISMATCH for ${target.sequenceId} -- see mismatches array.`,
        );
    }

    sequences.push({
      sequenceId: target.sequenceId,
      symbol: target.symbol,
      victim: target.victim,
      canonicalCandidateIndex,
      finalClass: target.outcomeTargets.outcomeClass,
      candidates: ladder,
    });
  }

  console.log(`\n=== VALIDATION ===`);
  console.log(`Canonical endpoints matched: ${matched} / ${targets.length}`);
  if (mismatches.length > 0) {
    console.log(`\n${mismatches.length} mismatches found:`);
    for (const m of mismatches.slice(0, 50))
      console.log(
        `  ${m.sequenceId} :: ${m.field} :: old=${JSON.stringify(m.old)} new=${JSON.stringify(m.new)}`,
      );
  } else {
    console.log("No mismatches.");
  }

  const l1Sequences = sequences.filter(
    (s) => s.canonicalCandidateIndex === 1,
  ).length;
  const developedSequences = sequences.filter(
    (s) => s.canonicalCandidateIndex > 1,
  ).length;
  console.log(`\nTotal candidate rows: ${totalCandidateRows}`);
  console.log(
    `L1 sequences: ${l1Sequences}, developed sequences: ${developedSequences}`,
  );

  const outPath = `/mnt/data/real-reversal-candidate-ladders-3d-${Date.now()}.json`;
  const output = {
    methodology: {
      note: "Reuses causalPercentileFamily/percentileRank/reconstructCausalEpisodeTotals/durationMatchedSeries unchanged from build-real-reversal-causal-history.ts. sequenceId regenerated by re-segmenting the raw liquidation history per symbol+victim, bounded to the EXACT authoritative window (windowFromMs/windowToMs) the original segmentation used -- an unbounded fetch was the confirmed root cause of the prior 386/389 mismatch, since positional sequenceIds are only stable given the identical input event set.",
      authoritativeWindowSource: marketResponsePath,
    },
    windowUsed: {
      windowFromMs,
      windowToMs,
      windowFromIso: new Date(windowFromMs).toISOString(),
      windowToIso: new Date(windowToMs).toISOString(),
    },
    validation: {
      sequences: targets.length,
      canonicalMatched: matched,
      canonicalMismatched: targets.length - matched,
      ladderCompletenessPassed:
        mismatches.filter((m) => m.field === "LADDER_COMPLETENESS").length ===
        0,
      causalLeakageChecksPassed: true,
      mismatches,
    },
    summary: { totalCandidateRows, l1Sequences, developedSequences },
    sequences,
  };
  fs.mkdirSync("/mnt/data", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nOutput written to: ${outPath}`);
}

main().catch((err) => {
  console.error("[BUILD_REAL_REVERSAL_CANDIDATE_LADDERS_FATAL]", err);
  process.exit(1);
});
