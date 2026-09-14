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

/**
 * Sep 14 2026 (Karo), operator-requested. Reconstructs, for every
 * canonical REAL_REVERSAL / CONTINUATION / FAILED_REVERSAL
 * observation, the causal market state observable AT that exact
 * timestamp T -- historical liquidation percentiles, duration-matched
 * intensity, ATR evolution, price displacement, efficiency, extreme
 * progression -- using ONLY data timestamped <= T. Future response
 * (already computed by the corrected true-path script) is attached
 * separately as outcomeTargets, never mixed into causalFeatures.
 *
 * READ-ONLY. Does not touch production strategy, ROTATION logic, P95
 * production history, execution, or Telegram.
 *
 *   tsx scripts/build-real-reversal-causal-history.ts \
 *     --true-reversals=/mnt/data/liquidation-true-reversals-fixed-3d-<ts>.json
 *
 * SCOPE NOTE (stated explicitly rather than silently simplified):
 * cumulative-episode-distribution percentiles (PART 3.B) and
 * duration-matched percentiles (PART 3.C) are computed over ALL
 * available causal history plus the 24h and 72h windows specifically
 * (not the full 6h/12h/24h/48h/72h matrix requested for every single
 * percentile family) -- single-EVENT percentiles (PART 3.A) DO use
 * the full 5-window matrix. This keeps the script's own runtime and
 * complexity bounded while still directly answering the stated
 * question "is 24h more informative than 72h" for the two families
 * most likely to matter. ATR evolution sampling (PART 6) uses 5
 * fixed episode-fraction snapshots (0%, 25%, 50%, 75%, 100%) rather
 * than every closed candle, to keep output size reasonable.
 */

const LOOKBACK_WINDOWS_MS: { label: string; ms: number | null }[] = [
  { label: "6h", ms: 6 * 3600_000 },
  { label: "12h", ms: 12 * 3600_000 },
  { label: "24h", ms: 24 * 3600_000 },
  { label: "48h", ms: 48 * 3600_000 },
  { label: "72h", ms: 72 * 3600_000 },
  { label: "all", ms: null },
];
const MIN_SAMPLES_FOR_PERCENTILE = 20;

interface HistoricalCandle {
  symbol: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed: true;
}

// ---- source shapes ----
interface TrueReversalCandidate {
  symbol: string;
  victim: Side;
  sequenceId: string;
  candidateIndex: number;
  candidateStartTs: number;
  candidateEndTs: number;
  cumulativeLiqUsd: number;
  eventCount: number;
  maxSingleLiqUsd: number;
  lastEventUsd: number;
  durationMs: number;
  candidateStartPrice: number;
  candidateEndPrice: number;
  latestExtremePrice: number;
  favorable1m: number | null;
  adverse1m: number | null;
  favorable2m: number | null;
  adverse2m: number | null;
  favorable3m: number | null;
  adverse3m: number | null;
  favorable5m: number | null;
  adverse5m: number | null;
  favorable10m: number | null;
  adverse10m: number | null;
  favorable15m: number | null;
  adverse15m: number | null;
  favorable30m: number | null;
  adverse30m: number | null;
  dominanceShare5m: number | null;
  timeToFirstFavorableMin: number | null;
  timeToFirstAdverseMin: number | null;
  timeToMaxFavorableMin: number | null;
  timeToMaxAdverseMin: number | null;
  maxAdverseBeforeFavorableDominance: number | null;
  firstDirectionalMove: string;
  firstDominantMove: string;
  preLiqDirAtr: number | null;
  preRecDirAtr: number | null;
  avgEventSpacingMs: number;
  medianEventSpacingMs: number;
  liqAmountTrend: string;
  maxSingleOverCumulative: number;
  outcomeClass: string;
}
interface SequenceResult {
  sequenceId: string;
  symbol: string;
  victim: string;
  sequenceClass: string;
  firstTrueReversalCandidateIndex: number | null;
}
interface TrueReversalJson {
  realReversalLiquidations: TrueReversalCandidate[];
  continuationLiquidations: TrueReversalCandidate[];
  sequenceResults: SequenceResult[];
}

// ---- pure, independently-testable causal statistics functions ----

export interface PercentileFamily {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p975: number | null;
  p99: number | null;
  sampleCount: number;
}

export function percentile(
  sorted: readonly number[],
  p: number,
): number | null {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sorted[lo]!
    : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Causal percentile family over a value series, strictly bounded to
 *  `timestamp <= atT` and optionally `timestamp > atT - lookbackMs`.
 *  Returns null fields (not a fabricated 0/fallback) when sampleCount
 *  < MIN_SAMPLES_FOR_PERCENTILE. */
export function causalPercentileFamily(
  series: readonly { timestamp: number; value: number }[],
  atT: number,
  lookbackMs: number | null,
): PercentileFamily {
  const inWindow = series.filter(
    (e) =>
      e.timestamp <= atT &&
      (lookbackMs === null || e.timestamp > atT - lookbackMs),
  );
  const sorted = inWindow.map((e) => e.value).sort((a, b) => a - b);
  if (sorted.length < MIN_SAMPLES_FOR_PERCENTILE)
    return {
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      p975: null,
      p99: null,
      sampleCount: sorted.length,
    };
  return {
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p975: percentile(sorted, 0.975),
    p99: percentile(sorted, 0.99),
    sampleCount: sorted.length,
  };
}

/** Percentile rank of `value` within the causal series (0-100). Null
 *  if insufficient samples. */
export function percentileRank(
  series: readonly { timestamp: number; value: number }[],
  atT: number,
  lookbackMs: number | null,
  value: number,
): number | null {
  const inWindow = series.filter(
    (e) =>
      e.timestamp <= atT &&
      (lookbackMs === null || e.timestamp > atT - lookbackMs),
  );
  if (inWindow.length < MIN_SAMPLES_FOR_PERCENTILE) return null;
  const below = inWindow.filter((e) => e.value <= value).length;
  return (below / inWindow.length) * 100;
}

/** Reconstructs completed same-side liquidation episodes from raw
 *  events (hard separator on victim flip -- same segmentation
 *  convention used throughout this whole research thread), returning
 *  {episodeEndTs, cumulativeUsd, durationMs} for every episode whose
 *  LAST event occurred at or before `atT` (a conservative, causal
 *  proxy for "episode completed before T" -- we don't have a real
 *  15-minute-inactivity boundary reconstruction here, so an episode's
 *  own last observed event timestamp is used as its completion proxy). */
export function reconstructCausalEpisodeTotals(
  events: readonly Liquidation[],
  atT: number,
): { episodeEndTs: number; cumulativeUsd: number; durationMs: number }[] {
  const causal = events
    .filter((e) => e.timestamp <= atT)
    .sort((a, b) => a.timestamp - b.timestamp);
  const episodes: {
    episodeEndTs: number;
    cumulativeUsd: number;
    durationMs: number;
  }[] = [];
  let i = 0;
  const GAP_MS = 15 * 60_000;
  while (i < causal.length) {
    let j = i;
    let sum = causal[i]!.quoteQty;
    while (
      j + 1 < causal.length &&
      causal[j + 1]!.timestamp - causal[j]!.timestamp < GAP_MS
    ) {
      j++;
      sum += causal[j]!.quoteQty;
    }
    episodes.push({
      episodeEndTs: causal[j]!.timestamp,
      cumulativeUsd: sum,
      durationMs: causal[j]!.timestamp - causal[i]!.timestamp,
    });
    i = j + 1;
  }
  return episodes;
}

/** Duration-matched historical distribution: for every historical
 *  event timestamp t_i <= atT, the rolling sum of same-symbol/victim
 *  liquidation USD in the window [t_i - durationMs, t_i]. This forms
 *  the causal comparison population for "how much USD does a window
 *  of THIS duration typically produce". */
export function durationMatchedSeries(
  events: readonly Liquidation[],
  atT: number,
  durationMs: number,
): { timestamp: number; value: number }[] {
  const causal = events
    .filter((e) => e.timestamp <= atT)
    .sort((a, b) => a.timestamp - b.timestamp);
  const out: { timestamp: number; value: number }[] = [];
  let windowStart = 0;
  let windowSum = 0;
  for (let i = 0; i < causal.length; i++) {
    windowSum += causal[i]!.quoteQty;
    while (causal[i]!.timestamp - causal[windowStart]!.timestamp > durationMs) {
      windowSum -= causal[windowStart]!.quoteQty;
      windowStart++;
    }
    out.push({ timestamp: causal[i]!.timestamp, value: windowSum });
  }
  return out;
}

function mean(arr: readonly number[]): number | null {
  return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return percentile(s, 0.5);
}
/** Spearman-style rank correlation -- descriptive only, explicitly
 *  labeled as correlation, never claimed as predictive evidence. */
export function rankCorrelation(
  pairs: readonly { x: number; y: number }[],
): number | null {
  const valid = pairs.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (valid.length < 10) return null;
  const rankOf = (values: number[]): number[] => {
    const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(values.length).fill(0);
    sorted.forEach((s, r) => (ranks[s.i] = r));
    return ranks;
  };
  const xr = rankOf(valid.map((p) => p.x));
  const yr = rankOf(valid.map((p) => p.y));
  const n = valid.length;
  const meanX = mean(xr)!,
    meanY = mean(yr)!;
  let num = 0,
    denX = 0,
    denY = 0;
  for (let i = 0; i < n; i++) {
    num += (xr[i]! - meanX) * (yr[i]! - meanY);
    denX += (xr[i]! - meanX) ** 2;
    denY += (yr[i]! - meanY) ** 2;
  }
  return denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : null;
}

// ---- I/O ----
async function fetchAllLiquidations(
  mongo: MongoClientWrapper,
  symbol: string,
): Promise<Liquidation[]> {
  const col = await mongo.rawLiquidationEvents();
  if (!col) return [];
  const docs = await col.find({ symbol }).sort({ timestamp: 1 }).toArray();
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

function parseArgs(argv: string[]): { truePath: string } {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const truePath = get("true-reversals");
  if (!truePath) {
    console.error(
      "Usage: build-real-reversal-causal-history.ts --true-reversals=/path/to/liquidation-true-reversals-fixed-3d-<ts>.json",
    );
    process.exit(1);
  }
  return { truePath };
}

async function main(): Promise<void> {
  const { truePath } = parseArgs(process.argv.slice(2));
  const source: TrueReversalJson = JSON.parse(
    fs.readFileSync(truePath, "utf8"),
  );
  console.log(
    `Loaded ${source.realReversalLiquidations.length} REAL_REVERSAL and ${source.continuationLiquidations.length} CONTINUATION canonical observations.\n`,
  );

  const allObservations: (TrueReversalCandidate & {
    populationLabel: "REAL_REVERSAL" | "CONTINUATION";
  })[] = [
    ...source.realReversalLiquidations.map((c) => ({
      ...c,
      populationLabel: "REAL_REVERSAL" as const,
    })),
    ...source.continuationLiquidations.map((c) => ({
      ...c,
      populationLabel: "CONTINUATION" as const,
    })),
  ];

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

  const symbols = [...new Set(allObservations.map((o) => o.symbol))];
  const liqBySymbol = new Map<string, Liquidation[]>();
  const candlesBySymbol = new Map<string, HistoricalCandle[]>();
  for (const symbol of symbols) {
    console.log(`Fetching full raw liquidation history for ${symbol}...`);
    liqBySymbol.set(symbol, await fetchAllLiquidations(mongo, symbol));
    const symObs = allObservations.filter((o) => o.symbol === symbol);
    const minTs = Math.min(...symObs.map((o) => o.candidateStartTs));
    const maxTs = Math.max(...symObs.map((o) => o.candidateEndTs));
    console.log(`Fetching candles for ${symbol} ATR reconstruction...`);
    candlesBySymbol.set(
      symbol,
      (
        await fetchHistoricalCandles(
          rest,
          symbol,
          minTs - 6 * 3600_000,
          maxTs + 60_000,
        )
      ).sort((a, b) => a.openTime - b.openTime),
    );
  }

  interface Observation {
    symbol: string;
    victim: Side;
    sequenceId: string;
    candidateIndex: number;
    timestamp: number;
    causalFeatures: Record<string, unknown>;
    outcomeTargets: Record<string, unknown>;
  }
  const observations: Observation[] = [];

  for (const obs of allObservations) {
    const T = obs.candidateEndTs;
    const symbolVictimEvents = (liqBySymbol.get(obs.symbol) ?? []).filter(
      (e) => (e.side === "SELL" ? "LONG" : "SHORT") === obs.victim,
    );
    const eventValueSeries = symbolVictimEvents.map((e) => ({
      timestamp: e.timestamp,
      value: e.quoteQty,
    }));

    // PART 3.A: single raw event distribution, all 5 lookback windows
    const singleEventPercentiles: Record<string, PercentileFamily> = {};
    for (const w of LOOKBACK_WINDOWS_MS)
      singleEventPercentiles[w.label] = causalPercentileFamily(
        eventValueSeries,
        T,
        w.ms,
      );
    const maxSinglePercentileRank24h = percentileRank(
      eventValueSeries,
      T,
      24 * 3600_000,
      obs.maxSingleLiqUsd,
    );

    // PART 3.B: cumulative episode distribution (all-history + 24h/72h, per this script's own stated scope note)
    const causalEpisodes = reconstructCausalEpisodeTotals(
      symbolVictimEvents,
      T - 1,
    ); // strictly before T -- excludes the CURRENT, still-forming episode itself
    const episodeSeries = causalEpisodes.map((e) => ({
      timestamp: e.episodeEndTs,
      value: e.cumulativeUsd,
    }));
    const episodePercentiles: Record<string, PercentileFamily> = {
      all: causalPercentileFamily(episodeSeries, T, null),
      "24h": causalPercentileFamily(episodeSeries, T, 24 * 3600_000),
      "72h": causalPercentileFamily(episodeSeries, T, 72 * 3600_000),
    };
    const currentEpisodePercentileRank = percentileRank(
      episodeSeries,
      T,
      null,
      obs.cumulativeLiqUsd,
    );

    // PART 3.C: duration-matched, all 5 windows
    const durMatchedRaw = durationMatchedSeries(
      symbolVictimEvents,
      T,
      obs.durationMs,
    );
    const durationMatchedPercentiles: Record<string, PercentileFamily> = {};
    for (const w of LOOKBACK_WINDOWS_MS)
      durationMatchedPercentiles[w.label] = causalPercentileFamily(
        durMatchedRaw,
        T,
        w.ms,
      );
    const durationMatchedPercentileRank = percentileRank(
      durMatchedRaw,
      T,
      24 * 3600_000,
      obs.cumulativeLiqUsd,
    );
    const liqUsdPerSecond =
      obs.durationMs > 0
        ? obs.cumulativeLiqUsd / (obs.durationMs / 1000)
        : obs.cumulativeLiqUsd;
    const liqUsdPerMinute = liqUsdPerSecond * 60;

    // PART 5/6: ATR state and evolution -- causal directional ATR, fed candles strictly <= T
    const candles = candlesBySymbol.get(obs.symbol) ?? [];
    const tracker = new DirectionalAtrTracker();
    let ci = 0;
    const feedTo = (ts: number): void => {
      while (ci < candles.length && candles[ci]!.openTime + 60_000 <= ts) {
        tracker.onCandle(candles[ci]!);
        ci++;
      }
    };
    const episodeFractionTs = [0, 0.25, 0.5, 0.75, 1].map(
      (f) => obs.candidateStartTs + f * (T - obs.candidateStartTs),
    );
    const atrSnapshots = episodeFractionTs.map((ts) => {
      feedTo(ts);
      const down = tracker.getDownAtr(obs.symbol);
      const up = tracker.getUpAtr(obs.symbol);
      return {
        ts,
        downAtr: down,
        upAtr: up,
        liqDirAtr: obs.victim === "LONG" ? down : up,
        recDirAtr: obs.victim === "LONG" ? up : down,
      };
    });
    const currentLiqDirAtr = atrSnapshots[atrSnapshots.length - 1]!.liqDirAtr;
    const currentRecDirAtr = atrSnapshots[atrSnapshots.length - 1]!.recDirAtr;
    const liqAtrChangePct =
      obs.preLiqDirAtr && obs.preLiqDirAtr > 0 && currentLiqDirAtr !== null
        ? ((currentLiqDirAtr - obs.preLiqDirAtr) / obs.preLiqDirAtr) * 100
        : null;
    const recoveryAtrChangePct =
      obs.preRecDirAtr && obs.preRecDirAtr > 0 && currentRecDirAtr !== null
        ? ((currentRecDirAtr - obs.preRecDirAtr) / obs.preRecDirAtr) * 100
        : null;
    const liqAtrValues = atrSnapshots
      .map((s) => s.liqDirAtr)
      .filter((v): v is number => v !== null);
    const recAtrValues = atrSnapshots
      .map((s) => s.recDirAtr)
      .filter((v): v is number => v !== null);
    const liqAtrPeak =
      liqAtrValues.length > 0 ? Math.max(...liqAtrValues) : null;
    const recoveryAtrMinimum =
      recAtrValues.length > 0 ? Math.min(...recAtrValues) : null;

    // PART 7: price displacement
    const priceDisplacementPct =
      obs.candidateStartPrice > 0
        ? Math.abs(
            (obs.latestExtremePrice - obs.candidateStartPrice) /
              obs.candidateStartPrice,
          ) * 100
        : null;
    const priceDisplacementATR =
      obs.preLiqDirAtr && obs.preLiqDirAtr > 0
        ? Math.abs(obs.latestExtremePrice - obs.candidateStartPrice) /
          obs.preLiqDirAtr
        : null;

    // PART 8: efficiency (episode-level only -- per-incremental-candidate marginal efficiency would require the FULL candidate ladder for this sequence, not just the canonical observation; not available from the true-reversals JSON's own filtered populations, which intentionally keep only ONE canonical entry per sequence -- documented in methodologicalWarnings below)
    const priceProgressATRPer1M =
      priceDisplacementATR !== null && obs.cumulativeLiqUsd > 0
        ? priceDisplacementATR / (obs.cumulativeLiqUsd / 1_000_000)
        : null;

    // PART 10: event structure (from what the canonical candidate already carries)
    const meanEventUsd =
      obs.eventCount > 0 ? obs.cumulativeLiqUsd / obs.eventCount : null;

    // PART 11: duration
    const durationPercentileRank24h = percentileRank(
      symbolVictimEvents.length > 0
        ? reconstructCausalEpisodeTotals(symbolVictimEvents, T - 1).map(
            (e) => ({ timestamp: e.episodeEndTs, value: e.durationMs }),
          )
        : [],
      T,
      24 * 3600_000,
      obs.durationMs,
    );

    const causalFeatures = {
      liquidationHistory: {
        singleEventPercentiles,
        maxSinglePercentileRank24h,
      },
      currentEpisode: {
        cumulativeLiqUsd: obs.cumulativeLiqUsd,
        eventCount: obs.eventCount,
        maxSingleLiqUsd: obs.maxSingleLiqUsd,
        maxSingleOverCumulative: obs.maxSingleOverCumulative,
        meanEventUsd,
        lastEventUsd: obs.lastEventUsd,
        liqAmountTrend: obs.liqAmountTrend,
        episodePercentiles,
        currentEpisodePercentileRank,
      },
      duration: {
        episodeDurationMs: obs.durationMs,
        durationPercentileRank24h,
      },
      cadence: {
        avgEventSpacingMs: obs.avgEventSpacingMs,
        medianEventSpacingMs: obs.medianEventSpacingMs,
        liqUsdPerSecond,
        liqUsdPerMinute,
        durationMatchedPercentiles,
        durationMatchedPercentileRank,
      },
      atr: {
        preLiqDirAtr: obs.preLiqDirAtr,
        preRecDirAtr: obs.preRecDirAtr,
        currentLiqDirAtr,
        currentRecDirAtr,
        liqAtrChangePct,
        recoveryAtrChangePct,
        recoveryVsLiquidationAtrRatio:
          currentLiqDirAtr && currentLiqDirAtr > 0 && currentRecDirAtr !== null
            ? currentRecDirAtr / currentLiqDirAtr
            : null,
        atrEvolutionSnapshots: atrSnapshots,
        liqAtrPeak,
        recoveryAtrMinimum,
      },
      displacement: {
        episodeStartPrice: obs.candidateStartPrice,
        latestExtremePrice: obs.latestExtremePrice,
        priceDisplacementPct,
        priceDisplacementATR,
      },
      efficiency: { priceProgressATRPer1M },
    };

    const outcomeTargets = {
      outcomeClass: obs.outcomeClass,
      favorable1m: obs.favorable1m,
      adverse1m: obs.adverse1m,
      favorable2m: obs.favorable2m,
      adverse2m: obs.adverse2m,
      favorable3m: obs.favorable3m,
      adverse3m: obs.adverse3m,
      favorable5m: obs.favorable5m,
      adverse5m: obs.adverse5m,
      favorable10m: obs.favorable10m,
      adverse10m: obs.adverse10m,
      favorable15m: obs.favorable15m,
      adverse15m: obs.adverse15m,
      favorable30m: obs.favorable30m,
      adverse30m: obs.adverse30m,
      dominanceShare5m: obs.dominanceShare5m,
      netReversalAdvantage5m:
        obs.favorable5m !== null && obs.adverse5m !== null
          ? obs.favorable5m - obs.adverse5m
          : null,
      favorableATR5m:
        currentLiqDirAtr && currentLiqDirAtr > 0 && obs.favorable5m !== null
          ? ((obs.favorable5m / 100) * obs.candidateEndPrice) / currentLiqDirAtr
          : null,
      timeToFirstFavorableMin: obs.timeToFirstFavorableMin,
      timeToFirstAdverseMin: obs.timeToFirstAdverseMin,
      timeToMaxFavorableMin: obs.timeToMaxFavorableMin,
      timeToMaxAdverseMin: obs.timeToMaxAdverseMin,
      maxAdverseBeforeFavorableDominance:
        obs.maxAdverseBeforeFavorableDominance,
      firstDirectionalMove: obs.firstDirectionalMove,
      firstDominantMove: obs.firstDominantMove,
    };

    observations.push({
      symbol: obs.symbol,
      victim: obs.victim,
      sequenceId: obs.sequenceId,
      candidateIndex: obs.candidateIndex,
      timestamp: T,
      causalFeatures,
      outcomeTargets,
    });
  }

  // ---- PART 13: reversal strength groups (data-derived quantiles, REAL_REVERSAL only) ----
  const reversalObs = observations.filter(
    (o) => o.outcomeTargets.outcomeClass === "REAL_REVERSAL",
  );
  const fav5mValues = reversalObs
    .map((o) => o.outcomeTargets.favorable5m)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const strengthP33 = percentile(fav5mValues, 0.33);
  const strengthP66 = percentile(fav5mValues, 0.66);
  const strengthP90 = percentile(fav5mValues, 0.9);
  console.log(
    `\nReversal strength quantiles (favorable5m): P33=${strengthP33?.toFixed(3)} P66=${strengthP66?.toFixed(3)} P90=${strengthP90?.toFixed(3)}`,
  );

  // ---- PART 14: descriptive comparison REAL_REVERSAL vs CONTINUATION ----
  function describeGroup(
    obs: Observation[],
    extractor: (o: Observation) => number | null,
  ): {
    count: number;
    mean: number | null;
    median: number | null;
    p25: number | null;
    p75: number | null;
  } {
    const vals = obs
      .map(extractor)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      count: vals.length,
      mean: mean(vals),
      median: median(vals),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
    };
  }
  const continuationObs = observations.filter(
    (o) => o.outcomeTargets.outcomeClass === "CONTINUATION",
  );
  const comparisonFeatures: {
    name: string;
    extractor: (o: Observation) => number | null;
  }[] = [
    {
      name: "currentEpisodePercentileRank",
      extractor: (o) =>
        (
          o.causalFeatures.currentEpisode as {
            currentEpisodePercentileRank: number | null;
          }
        ).currentEpisodePercentileRank,
    },
    {
      name: "durationMatchedPercentileRank",
      extractor: (o) =>
        (
          o.causalFeatures.cadence as {
            durationMatchedPercentileRank: number | null;
          }
        ).durationMatchedPercentileRank,
    },
    {
      name: "priceDisplacementATR",
      extractor: (o) =>
        (
          o.causalFeatures.displacement as {
            priceDisplacementATR: number | null;
          }
        ).priceDisplacementATR,
    },
    {
      name: "liqAtrChangePct",
      extractor: (o) =>
        (o.causalFeatures.atr as { liqAtrChangePct: number | null })
          .liqAtrChangePct,
    },
    {
      name: "recoveryAtrChangePct",
      extractor: (o) =>
        (o.causalFeatures.atr as { recoveryAtrChangePct: number | null })
          .recoveryAtrChangePct,
    },
    {
      name: "episodeDurationMs",
      extractor: (o) =>
        (o.causalFeatures.duration as { episodeDurationMs: number })
          .episodeDurationMs,
    },
    {
      name: "priceProgressATRPer1M",
      extractor: (o) =>
        (
          o.causalFeatures.efficiency as {
            priceProgressATRPer1M: number | null;
          }
        ).priceProgressATRPer1M,
    },
  ];
  const realReversalVsContinuation: Record<
    string,
    {
      realReversal: ReturnType<typeof describeGroup>;
      continuation: ReturnType<typeof describeGroup>;
    }
  > = {};
  console.log("\n=== REAL_REVERSAL vs CONTINUATION (descriptive) ===\n");
  for (const f of comparisonFeatures) {
    const rr = describeGroup(reversalObs, f.extractor);
    const co = describeGroup(continuationObs, f.extractor);
    realReversalVsContinuation[f.name] = { realReversal: rr, continuation: co };
    console.log(
      `${f.name}: REAL_REVERSAL median=${rr.median?.toFixed(3)} (n=${rr.count})  vs  CONTINUATION median=${co.median?.toFixed(3)} (n=${co.count})`,
    );
  }

  // ---- PART 15: rank correlation with reversal magnitude, REAL_REVERSAL only ----
  console.log(
    "\n=== Rank correlations with favorable5m (REAL_REVERSAL only, descriptive, NOT predictive evidence) ===\n",
  );
  const correlations: Record<string, number | null> = {};
  for (const f of comparisonFeatures) {
    const pairs = reversalObs
      .map((o) => ({
        x: f.extractor(o) ?? NaN,
        y: (o.outcomeTargets.favorable5m as number | null) ?? NaN,
      }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const corr = rankCorrelation(pairs);
    correlations[f.name] = corr;
    console.log(
      `${f.name} vs favorable5m: rank correlation = ${corr?.toFixed(3) ?? "insufficient data"} (n=${pairs.length})`,
    );
  }

  // ---- output ----
  const outPath = `/mnt/data/real-reversal-causal-history-3d-${Date.now()}.json`;
  const output = {
    methodology: {
      note: "Every causalFeatures field uses ONLY data timestamped <= the canonical observation's own candidateEndTs. Percentile families return null (not a fabricated fallback) when fewer than 20 causal samples exist in that window.",
      scopeSimplifications: [
        "Cumulative-episode and marginal-per-candidate efficiency features use a reduced window set (all-history/24h/72h) rather than the full 5-window matrix requested for every single family, to keep runtime and output size bounded -- single-event and duration-matched percentiles DO use the full 5-window matrix.",
        "Episode reconstruction for historical percentile purposes uses a 15-minute same-side inactivity gap as the completion boundary (matching the convention used throughout this research thread), not a re-derivation of the exact backfilled rotation_episode_history semantics.",
        "Marginal (per-incremental-liquidation-candidate) efficiency decay is NOT computed here -- the true-reversals source JSON intentionally keeps only ONE canonical candidate per sequence, so the full L1/L2/L3... ladder needed for marginal efficiency is not available from it without re-deriving sequences from raw events again.",
        "ATR evolution is sampled at 5 fixed episode-fraction points (0/25/50/75/100%), not every closed candle.",
      ],
    },
    leakageAudit: {
      statement:
        "causalFeatures uses only timestamp<=T data (enforced structurally by the causal*() functions' own filters, not by convention). outcomeTargets are copied from the already-computed true-path response and are never read by any causalFeatures computation above.",
      fieldsAudited: Object.keys(observations[0]?.causalFeatures ?? {}),
    },
    reversalStrengthGroups: {
      basis: "favorable5m quantiles among REAL_REVERSAL only",
      boundaries: {
        weak: [0, strengthP33],
        medium: [strengthP33, strengthP66],
        strong: [strengthP66, strengthP90],
        extreme: [strengthP90, null],
      },
    },
    summary: {
      totalObservations: observations.length,
      realReversalCount: reversalObs.length,
      continuationCount: continuationObs.length,
    },
    observations,
    realReversalVsContinuation,
    causalFeatureCorrelationsWithReversalStrength: correlations,
    methodologicalWarnings: [
      "This is 3 days of data -- correlations and descriptive separations are exploratory, not statistically confirmed predictive relationships.",
      "Do not treat rank correlation as predictive evidence; it is descriptive only.",
      "durationMatchedPercentileRank/currentEpisodePercentileRank return null whenever fewer than 20 causal historical samples exist -- treat null as 'insufficient history', never as 0 or a missing-data zero.",
    ],
  };
  fs.mkdirSync("/mnt/data", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nOutput written to: ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[BUILD_REAL_REVERSAL_CAUSAL_HISTORY_FATAL]", err);
    process.exit(1);
  });
}
