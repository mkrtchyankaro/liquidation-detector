import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  loadRawEvents,
  computeAtrSeries,
  reconstructEpisodesForVariant,
  PRIMARY_VARIANT,
  type Atrs,
  type Episode,
} from "../src/domain/research/displacement-balanced-core";
import {
  fetchKlinesWithRetry,
  getFetchStats,
  resetFetchStats,
} from "../src/domain/research/research-fetch-retry";
import {
  extractOiTrajectory,
  closestWaypoint,
  oiQualityBucket,
  clearingTransitionFeatures,
  computeOiMovementSummary,
  type OiWaypoint,
} from "../src/domain/research/episode-oi-trajectory";
import {
  computeOiPhaseChangeUsd,
  computeOiPhaseChangeQuantity,
  computeOiLiquidationRatios,
  type OiPhaseChangeUsd,
  type OiPhaseChangeQuantity,
  type OiLiquidationRatios,
} from "../src/domain/research/episode-oi-liquidation-ratios";
import {
  computeEpisodeQuantityAccounting,
  type EpisodeQuantityAccounting,
} from "../src/domain/research/episode-oi-liquidation-accounting";
import {
  computeCausalHistoricalPercentile,
  type CompletedEpisodeRef,
  type HistoricalPercentileContext,
} from "../src/domain/research/episode-historical-percentile";
import {
  computeEpisodeOutcomeLabels,
  OUTCOME_HORIZONS_MIN,
  type EpisodeOutcomeLabels,
} from "../src/domain/research/episode-outcome-labels";
import type { Candle } from "../src/shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-approved. STEP 3 research pipeline:
 * completed DISPLACEMENT_BALANCED episodes -> OI trajectory (sparse,
 * quality-tagged waypoints) -> causal historical seriousness ->
 * post-END price outcomes. DISCOVERY ONLY -- no threshold, no filter,
 * no classifier, no score. Does not touch production trading code,
 * EpisodePercentileService, individual-event P95, or PHYSICS.
 *
 * CAUSALITY: episode reconstruction and OI-trajectory extraction never
 * read anything after an episode's own endTime (proven by
 * tests/episode-research-causality.test.ts). Historical percentile
 * rank uses ONLY prior completed episodes (endTime < this episode's
 * own endTime), never itself, never a later episode (also proven by
 * the same test file). Only computeEpisodeOutcomeLabels() reads
 * future candles -- confined to its own module, never imported by
 * any causal-feature code.
 *
 *   npx tsx scripts/research-episode-oi-outcomes.ts --symbols BTCUSDT,ETHUSDT --days 7
 */

interface CliArgs {
  symbols: string[];
  fromMs: number;
  toMs: number;
  paddingMs: number;
}
const DEFAULT_SYMBOLS = [
  "BTCUSDT",
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
function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const symbolsArg = get("--symbols");
  const symbols = symbolsArg
    ? symbolsArg.split(",").map((s) => s.trim().toUpperCase())
    : DEFAULT_SYMBOLS;
  let fromMs: number, toMs: number;
  const hoursArg = get("--hours"),
    daysArg = get("--days");
  if (hoursArg) {
    toMs = Date.now();
    fromMs = toMs - Number(hoursArg) * 3_600_000;
  } else if (daysArg) {
    toMs = Date.now();
    fromMs = toMs - Number(daysArg) * 86_400_000;
  } else {
    const fromArg = get("--from"),
      toArg = get("--to");
    if (!fromArg) {
      console.error("Must provide --hours, --days, or --from/--to");
      process.exit(1);
    }
    fromMs = parseUtcDatetime(fromArg);
    toMs = toArg ? parseUtcDatetime(toArg) : Date.now();
  }
  return {
    symbols,
    fromMs,
    toMs,
    paddingMs: Number(get("--paddingHours") ?? 6) * 3_600_000,
  };
}

interface EpisodeResearchRecord {
  symbol: string;
  direction: Episode["direction"];
  startTs: number;
  extremeTs: number;
  endTs: number;
  durationMs: number;
  sameDirectionLiqUsd: number;
  oppositeDirectionLiqUsd: number;
  sameDirectionEventCount: number;
  oppositeDirectionEventCount: number;
  episodeDisplacement: number | null;
  episodeDisplacementAtr3m: number | null;
  recoveryAtEnd: number | null;
  recoveryAtr3mAtEnd: number | null;
  recoveryFractionAtEnd: number | null;
  historical: HistoricalPercentileContext;
  belowP90: boolean | null;
  betweenP90P95: boolean | null;
  atOrAboveP95: boolean | null;
  oiTrajectory: OiWaypoint[];
  oiAtStart: OiWaypoint | null;
  oiNearExtreme: {
    waypoint: OiWaypoint;
    offsetMs: number;
    quality: string;
  } | null;
  oiAtEnd: { waypoint: OiWaypoint; offsetMs: number; quality: string } | null;
  oiMovement: ReturnType<typeof computeOiMovementSummary>;
  oiPhaseChangeUsd: OiPhaseChangeUsd;
  oiPhaseChangeQuantity: OiPhaseChangeQuantity;
  oiLiquidationRatios: OiLiquidationRatios;
  quantityAccounting: EpisodeQuantityAccounting;
  clearingTransitionAtEnd: ReturnType<typeof clearingTransitionFeatures>;
  outcomes: EpisodeOutcomeLabels["outcomes"];
  madeAdverseNewExtremeAfterEnd: boolean | null;
  inspectWindow: { fromIso: string; toIso: string; suggestedCommand: string };
}

function episodeUsd(events: { quoteQty: number }[]): number {
  return events.reduce((s, e) => s + e.quoteQty, 0);
}

async function buildRecordsForSymbol(
  symbol: string,
  args: CliArgs,
): Promise<{ records: EpisodeResearchRecord[]; episodeCount: number }> {
  const paddedFrom = args.fromMs - args.paddingMs;
  const maxOutcomeHorizonMs = Math.max(...OUTCOME_HORIZONS_MIN) * 60_000;
  // Sep 16 2026 (Karo), operator-requested (429 fix). The 1m fetch
  // now extends past args.toMs by the full outcome-horizon buffer, in
  // ONE call, so computeEpisodeOutcomeLabels below never needs its
  // own network call per episode -- this was the actual root cause of
  // the 429s (162 redundant, heavily-overlapping per-episode fetches
  // across just 3 symbols in the first real run).
  const c1m = await fetchKlinesWithRetry(
    symbol,
    60_000,
    paddedFrom,
    args.toMs + maxOutcomeHorizonMs,
  );
  const c3m = await fetchKlinesWithRetry(
    symbol,
    180_000,
    paddedFrom,
    args.toMs,
  );
  const c5m = await fetchKlinesWithRetry(
    symbol,
    300_000,
    paddedFrom,
    args.toMs,
  );
  const atrs: Atrs = {
    c1m,
    c3m,
    c5m,
    series1m: computeAtrSeries(c1m),
    series3m: computeAtrSeries(c3m),
    series5m: computeAtrSeries(c5m),
  };
  const events = await loadRawEvents(symbol, paddedFrom, args.toMs);
  const allEpisodes = reconstructEpisodesForVariant(
    events,
    atrs,
    PRIMARY_VARIANT,
    args.toMs,
  );
  const complete = allEpisodes.filter(
    (e) =>
      e.startTime >= args.fromMs &&
      e.endTime !== null &&
      e.endTime <= args.toMs,
  );

  const refs: CompletedEpisodeRef[] = complete.map((e) => ({
    symbol,
    direction: e.direction,
    endTime: e.endTime!,
    sameDirectionUsd: episodeUsd(e.sameDirectionEvents),
  }));

  const records: EpisodeResearchRecord[] = [];
  for (const e of complete) {
    const sameDirUsd = episodeUsd(e.sameDirectionEvents);
    const oppUsd = episodeUsd(e.oppositeSideEvents);
    const confirmed = [...e.transitions]
      .reverse()
      .find((t) => t.type === "RECOVERY_CONFIRMED");

    const trajectory = extractOiTrajectory(e);
    const startWp = trajectory.length > 0 ? trajectory[0]! : null;
    const nearExtreme = closestWaypoint(trajectory, e.extremeTime);
    const atEnd = closestWaypoint(trajectory, e.endTime!);

    const historical = computeCausalHistoricalPercentile(
      {
        symbol,
        direction: e.direction,
        endTime: e.endTime!,
        sameDirectionUsd: sameDirUsd,
      },
      refs,
    );
    // no longer async -- computeEpisodeOutcomeLabels reads from the
    // already-fetched c1m pool (which already covers the outcome
    // horizon), zero additional network calls here.
    const outcomeLabels = computeEpisodeOutcomeLabels(
      symbol,
      e.direction,
      e.endTime!,
      confirmed?.price ?? e.extremePrice,
      e.extremePrice,
      confirmed?.atr3m ?? null,
      args.toMs + maxOutcomeHorizonMs,
      c1m,
    );

    const inspectFrom = new Date(e.startTime - 15 * 60_000).toISOString();
    const inspectTo = new Date(e.endTime! + 30 * 60_000).toISOString();

    records.push({
      symbol,
      direction: e.direction,
      startTs: e.startTime,
      extremeTs: e.extremeTime,
      endTs: e.endTime!,
      durationMs: e.endTime! - e.startTime,
      sameDirectionLiqUsd: sameDirUsd,
      oppositeDirectionLiqUsd: oppUsd,
      sameDirectionEventCount: e.sameDirectionEvents.length,
      oppositeDirectionEventCount: e.oppositeSideEvents.length,
      episodeDisplacement: confirmed?.episodeDisplacement ?? null,
      episodeDisplacementAtr3m: confirmed?.episodeDisplacementAtr3m ?? null,
      recoveryAtEnd: confirmed?.recovery ?? null,
      recoveryAtr3mAtEnd: confirmed?.atr3m ?? null,
      recoveryFractionAtEnd: confirmed?.recoveryFraction ?? null,
      historical,
      belowP90:
        historical.historicalP90 !== null
          ? sameDirUsd < historical.historicalP90
          : null,
      betweenP90P95:
        historical.historicalP90 !== null && historical.historicalP95 !== null
          ? sameDirUsd >= historical.historicalP90 &&
            sameDirUsd < historical.historicalP95
          : null,
      atOrAboveP95:
        historical.historicalP95 !== null
          ? sameDirUsd >= historical.historicalP95
          : null,
      oiTrajectory: trajectory,
      oiAtStart: startWp,
      oiNearExtreme: nearExtreme
        ? { ...nearExtreme, quality: oiQualityBucket(nearExtreme.offsetMs) }
        : null,
      oiAtEnd: atEnd
        ? { ...atEnd, quality: oiQualityBucket(atEnd.offsetMs) }
        : null,
      oiMovement: computeOiMovementSummary(
        trajectory,
        startWp,
        nearExtreme?.waypoint ?? null,
        atEnd?.waypoint ?? null,
      ),
      oiPhaseChangeUsd: computeOiPhaseChangeUsd(
        startWp,
        nearExtreme?.waypoint ?? null,
        atEnd?.waypoint ?? null,
      ),
      oiPhaseChangeQuantity: computeOiPhaseChangeQuantity(
        startWp,
        nearExtreme?.waypoint ?? null,
        atEnd?.waypoint ?? null,
      ),
      oiLiquidationRatios: computeOiLiquidationRatios(
        sameDirUsd,
        computeOiPhaseChangeUsd(
          startWp,
          nearExtreme?.waypoint ?? null,
          atEnd?.waypoint ?? null,
        ).oiStartToEndUsd,
      ),
      quantityAccounting: computeEpisodeQuantityAccounting(
        e.sameDirectionEvents,
        startWp,
        nearExtreme?.waypoint ?? null,
        atEnd?.waypoint ?? null,
        e.extremeTime,
        e.endTime,
      ),
      clearingTransitionAtEnd: clearingTransitionFeatures(
        atEnd?.waypoint ?? null,
      ),
      outcomes: outcomeLabels.outcomes,
      madeAdverseNewExtremeAfterEnd:
        outcomeLabels.madeAdverseNewExtremeAfterEnd,
      inspectWindow: {
        fromIso: inspectFrom,
        toIso: inspectTo,
        suggestedCommand: `npx tsx scripts/inspect-liquidation-period.ts ${symbol} "${inspectFrom}" "${inspectTo}" 1m`,
      },
    });
  }
  return { records, episodeCount: complete.length };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}
function iqr(values: readonly number[]): {
  p25: number | null;
  p75: number | null;
} {
  if (values.length === 0) return { p25: null, p75: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const idx = q * (s.length - 1);
    const lo = Math.floor(idx),
      hi = Math.ceil(idx);
    return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
  };
  return { p25: at(0.25), p75: at(0.75) };
}

function groupStats(
  records: readonly EpisodeResearchRecord[],
  horizon: number,
  predicate: (r: EpisodeResearchRecord) => boolean,
) {
  const group = records.filter(predicate);
  const mfe = group
    .map((r) => r.outcomes[horizon as keyof typeof r.outcomes]?.mfePct)
    .filter((v): v is number => v !== null && v !== undefined);
  const mae = group
    .map((r) => r.outcomes[horizon as keyof typeof r.outcomes]?.maePct)
    .filter((v): v is number => v !== null && v !== undefined);
  return {
    n: group.length,
    medianMfePct: median(mfe),
    medianMaePct: median(mae),
    mfeIqr: iqr(mfe),
    maeIqr: iqr(mae),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  resetFetchStats();
  console.log(`Symbols: ${args.symbols.join(", ")}`);
  console.log(
    `Window: ${new Date(args.fromMs).toISOString()} -> ${new Date(args.toMs).toISOString()}`,
  );

  let allRecords: EpisodeResearchRecord[] = [];
  const perSymbolCounts: Record<string, number> = {};
  for (const symbol of args.symbols) {
    console.log(`\n=== ${symbol} ===`);
    try {
      const { records, episodeCount } = await buildRecordsForSymbol(
        symbol,
        args,
      );
      allRecords = allRecords.concat(records);
      perSymbolCounts[symbol] = episodeCount;
      console.log(`Complete episodes: ${episodeCount}`);
    } catch (err) {
      console.error(
        `  FAILED for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
      perSymbolCounts[symbol] = 0;
    }
  }

  console.log(`\n=== TOTAL: ${allRecords.length} episodes ===`);
  console.log(`By symbol: ${JSON.stringify(perSymbolCounts)}`);
  console.log(
    `By direction: LONG=${allRecords.filter((r) => r.direction === "LONG").length} SHORT=${allRecords.filter((r) => r.direction === "SHORT").length}`,
  );

  const fetchStats = getFetchStats();
  console.log(`\n=== FETCH STATS (429 fix verification) ===`);
  console.log(
    `Total REST request attempts: ${fetchStats.totalRequestAttempts}`,
  );
  console.log(`Total retries triggered by 429/418: ${fetchStats.totalRetries}`);
  console.log(
    `(Per-episode outcome fetching eliminated -- outcome labels now read from the same per-symbol candle pool used for episode reconstruction)`,
  );

  console.log(`\n=== OI WAYPOINT QUALITY DISTRIBUTION (at END) ===`);
  const qualityBuckets = [
    "<=10s",
    "<=30s",
    "<=60s",
    "<=2m",
    ">2m",
    "no_waypoint",
  ];
  for (const b of qualityBuckets) {
    const n = allRecords.filter(
      (r) => (r.oiAtEnd?.quality ?? "no_waypoint") === b,
    ).length;
    console.log(`  ${b}: n=${n}`);
  }

  console.log(
    `\n=== DESCRIPTIVE COMPARISON: percentile band vs 5m outcome (ALL quality, all symbols) ===`,
  );
  for (const [label, pred] of [
    ["below P90", (r: EpisodeResearchRecord) => r.belowP90 === true],
    ["P90-P95", (r: EpisodeResearchRecord) => r.betweenP90P95 === true],
    [">=P95", (r: EpisodeResearchRecord) => r.atOrAboveP95 === true],
  ] as const) {
    const s = groupStats(allRecords, 5, pred);
    console.log(
      `  ${label}: n=${s.n} medianMFE5m=${s.medianMfePct?.toFixed(3)}% medianMAE5m=${s.medianMaePct?.toFixed(3)}%`,
    );
  }

  console.log(
    `\n=== DESCRIPTIVE COMPARISON: clearing-then-stabilization pattern at END vs 5m outcome (high-quality waypoints only, offset<=30s) ===`,
  );
  const highQuality = allRecords.filter(
    (r) => r.oiAtEnd !== null && Math.abs(r.oiAtEnd.offsetMs) <= 30_000,
  );
  for (const [label, pred] of [
    [
      "pattern present",
      (r: EpisodeResearchRecord) =>
        r.clearingTransitionAtEnd.clearingThenStabilizationPattern === true,
    ],
    [
      "pattern absent",
      (r: EpisodeResearchRecord) =>
        r.clearingTransitionAtEnd.clearingThenStabilizationPattern === false,
    ],
  ] as const) {
    const s = groupStats(highQuality, 5, pred);
    console.log(
      `  ${label} (high-quality only): n=${s.n} medianMFE5m=${s.medianMfePct?.toFixed(3)}% medianMAE5m=${s.medianMaePct?.toFixed(3)}%`,
    );
  }

  console.log(
    `\n=== OI-CHANGE-TO-LIQUIDATION RATIO vs OUTCOME (quantile buckets, LONG and SHORT separately, high-quality OI-at-END only i.e. offset<=60s) ===`,
  );
  const ratioHighQuality = allRecords.filter(
    (r) =>
      r.oiAtEnd !== null &&
      Math.abs(r.oiAtEnd.offsetMs) <= 60_000 &&
      r.oiLiquidationRatios.oiNetChangeToLiqRatio !== null,
  );
  for (const direction of ["LONG", "SHORT"] as const) {
    const dirRecords = ratioHighQuality
      .filter((r) => r.direction === direction)
      .sort(
        (a, b) =>
          a.oiLiquidationRatios.oiNetChangeToLiqRatio! -
          b.oiLiquidationRatios.oiNetChangeToLiqRatio!,
      );
    console.log(
      `  ${direction} (n=${dirRecords.length} with usable ratio + high-quality OI-at-END):`,
    );
    if (dirRecords.length === 0) {
      console.log(`    (no episodes meet the high-quality threshold)`);
      continue;
    }
    const bucketCount = Math.min(4, dirRecords.length);
    const bucketSize = Math.ceil(dirRecords.length / bucketCount);
    for (let b = 0; b < bucketCount; b++) {
      const bucket = dirRecords.slice(b * bucketSize, (b + 1) * bucketSize);
      if (bucket.length === 0) continue;
      const ratios = bucket.map(
        (r) => r.oiLiquidationRatios.oiNetChangeToLiqRatio!,
      );
      const mfe5 = bucket
        .map((r) => r.outcomes[5]?.mfePct)
        .filter((v): v is number => v !== null && v !== undefined);
      const mae5 = bucket
        .map((r) => r.outcomes[5]?.maePct)
        .filter((v): v is number => v !== null && v !== undefined);
      console.log(
        `    ratio ${median(ratios)?.toFixed(2)} (n=${bucket.length}): medianMFE5m=${median(mfe5)?.toFixed(3)}% medianMAE5m=${median(mae5)?.toFixed(3)}%`,
      );
    }
  }

  console.log(
    `\n=== START->EXTREME vs EXTREME->END OI phase behavior, split by direction and quality (n=${allRecords.length}) ===`,
  );
  const phaseHorizons = [3, 5, 10, 15, 30] as const;
  function printPhasePattern(
    label: string,
    records: readonly EpisodeResearchRecord[],
  ): void {
    console.log(`  ${label}: n=${records.length}`);
    if (records.length === 0) return;
    const ranks = records
      .map((r) => r.historical.percentileRank)
      .filter((v): v is number => v !== null);
    console.log(
      `    median historical percentile rank: ${median(ranks)?.toFixed(1) ?? "n/a"} (n=${ranks.length} with history)`,
    );
    console.log(
      `    median liquidation USD: ${median(records.map((r) => r.sameDirectionLiqUsd))?.toFixed(0)}`,
    );
    for (const h of phaseHorizons) {
      const mfe = records
        .map((r) => r.outcomes[h]?.mfePct)
        .filter((v): v is number => v !== null && v !== undefined);
      const mae = records
        .map((r) => r.outcomes[h]?.maePct)
        .filter((v): v is number => v !== null && v !== undefined);
      console.log(
        `    ${h}m: medianMFE=${median(mfe)?.toFixed(3) ?? "n/a"}% (n=${mfe.length}) medianMAE=${median(mae)?.toFixed(3) ?? "n/a"}% (n=${mae.length})`,
      );
    }
  }
  for (const direction of ["LONG", "SHORT"] as const) {
    const dirAll = allRecords.filter(
      (r) =>
        r.direction === direction &&
        r.oiPhaseChangeUsd.oiStartToExtremeUsd !== null &&
        r.oiPhaseChangeUsd.oiExtremeToEndUsd !== null,
    );
    const dirHighQ = dirAll.filter(
      (r) => r.oiAtEnd !== null && Math.abs(r.oiAtEnd.offsetMs) <= 30_000,
    );
    printPhasePattern(
      `${direction} contraction->stabilize/rebuild (ALL quality)`,
      dirAll.filter(
        (r) =>
          r.oiPhaseChangeUsd.oiStartToExtremeUsd! < 0 &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd! >= 0,
      ),
    );
    printPhasePattern(
      `${direction} contraction->continued contraction (ALL quality)`,
      dirAll.filter(
        (r) =>
          r.oiPhaseChangeUsd.oiStartToExtremeUsd! < 0 &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd! < 0,
      ),
    );
    printPhasePattern(
      `${direction} contraction->stabilize/rebuild (HIGH quality, offset<=30s)`,
      dirHighQ.filter(
        (r) =>
          r.oiPhaseChangeUsd.oiStartToExtremeUsd! < 0 &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd! >= 0,
      ),
    );
    printPhasePattern(
      `${direction} contraction->continued contraction (HIGH quality, offset<=30s)`,
      dirHighQ.filter(
        (r) =>
          r.oiPhaseChangeUsd.oiStartToExtremeUsd! < 0 &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd! < 0,
      ),
    );
  }
  const phaseAvailable = allRecords.filter(
    (r) =>
      r.oiPhaseChangeUsd.oiStartToExtremeUsd !== null &&
      r.oiPhaseChangeUsd.oiExtremeToEndUsd !== null,
  );

  console.log(
    `\n=== IMPLIED REPLACEMENT / RESIDUAL ACCOUNTING (START->END, quantity-based, high-quality only offset<=60s) ===`,
  );
  for (const direction of ["LONG", "SHORT"] as const) {
    const dirRecords = ratioHighQuality.filter(
      (r) => r.direction === direction,
    );
    const withReplacement = dirRecords.filter(
      (r) =>
        r.quantityAccounting.startToEnd.impliedReplacementQuantity !== null,
    );
    const withResidual = dirRecords.filter(
      (r) =>
        r.quantityAccounting.startToEnd.residualContractionBeyondLiquidation !==
        null,
    );
    console.log(
      `  ${direction}: n_withImpliedReplacement=${withReplacement.length} n_withResidualContraction=${withResidual.length}`,
    );
    if (withReplacement.length > 0) {
      const ratios = withReplacement.map(
        (r) =>
          r.quantityAccounting.startToEnd.impliedReplacementToLiquidationRatio!,
      );
      console.log(
        `    implied replacement ratio: median=${median(ratios)?.toFixed(2)}x n=${ratios.length}`,
      );
    }
  }

  console.log(
    `\n=== DENOMINATOR / SMALL-EPISODE AUDIT: ratio distribution stratified by liquidation size ===`,
  );
  const withRatio = allRecords.filter(
    (r) => r.oiLiquidationRatios.oiNetChangeToLiqRatio !== null,
  );
  console.log(
    `  median liquidation USD (all with a ratio): ${median(withRatio.map((r) => r.sameDirectionLiqUsd))?.toFixed(0)}`,
  );
  console.log(
    `  median liquidation quantity, START->END (all with a ratio): ${median(withRatio.map((r) => r.quantityAccounting.startToEnd.liquidatedQuantity ?? NaN).filter((v) => !Number.isNaN(v)))?.toFixed(6)}`,
  );
  const sortedByAbsRatio = [...withRatio].sort(
    (a, b) =>
      Math.abs(b.oiLiquidationRatios.oiNetChangeToLiqRatio!) -
      Math.abs(a.oiLiquidationRatios.oiNetChangeToLiqRatio!),
  );
  console.log(`  Top 5 most extreme |ratio| episodes -- raw components:`);
  for (const r of sortedByAbsRatio.slice(0, 5)) {
    console.log(
      `  --- ${r.symbol} ${r.direction} end=${new Date(r.endTs).toISOString()} ---`,
    );
    console.log(
      `      sameDirectionLiqUsd=${r.sameDirectionLiqUsd.toFixed(0)} sameDirectionEventCount=${r.sameDirectionEventCount}`,
    );
    console.log(
      `      oiStartUsd=${r.oiPhaseChangeUsd.oiStartUsd?.toFixed(0)} oiNearEndUsd=${r.oiPhaseChangeUsd.oiNearEndUsd?.toFixed(0)} oiStartToEndUsd=${r.oiPhaseChangeUsd.oiStartToEndUsd?.toFixed(0)}`,
    );
    console.log(
      `      oiAtEnd offsetMs=${r.oiAtEnd?.offsetMs} quality=${r.oiAtEnd?.quality}`,
    );
    console.log(
      `      quantityAccounting.startToEnd: liquidatedQuantity=${r.quantityAccounting.startToEnd.liquidatedQuantity?.toFixed(6)} observedOiQuantityChange=${r.quantityAccounting.startToEnd.observedOiQuantityChange?.toFixed(6)}`,
    );
    console.log(
      `      oiNetChangeToLiqRatio=${r.oiLiquidationRatios.oiNetChangeToLiqRatio?.toFixed(3)} impliedReplacementQuantity=${r.quantityAccounting.startToEnd.impliedReplacementQuantity?.toFixed(6) ?? "n/a"}`,
    );
    console.log(`      ${r.inspectWindow.suggestedCommand}`);
  }

  console.log(
    `\n=== PERCENTILE BAND AUDIT: episodes with historicalSampleCount > 0, near the P90/P95 boundary ===`,
  );
  const withHistory = allRecords
    .filter((r) => r.historical.historicalSampleCount > 0)
    .sort(
      (a, b) =>
        (a.historical.percentileRank ?? 0) - (b.historical.percentileRank ?? 0),
    );
  for (const r of withHistory.slice(-10)) {
    console.log(
      `  ${r.symbol} ${r.direction} liqUsd=${r.sameDirectionLiqUsd.toFixed(0)} n=${r.historical.historicalSampleCount} P90=${r.historical.historicalP90?.toFixed(0)} P95=${r.historical.historicalP95?.toFixed(0)} rank=${r.historical.percentileRank?.toFixed(1)} band=${r.atOrAboveP95 ? ">=P95" : r.betweenP90P95 ? "P90-P95" : "below P90"}`,
    );
  }

  const outDir = path.join(process.cwd(), "research-output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const tag = `${new Date(args.fromMs).toISOString().slice(0, 10)}_to_${new Date(args.toMs).toISOString().slice(0, 10)}`;

  fs.writeFileSync(
    path.join(outDir, `episode-research-${tag}.json`),
    JSON.stringify(
      {
        metadata: {
          generatedAt: new Date().toISOString(),
          args,
          note: "DISCOVERY ONLY -- no production threshold implied",
        },
        records: allRecords,
      },
      null,
      2,
    ),
  );

  const csvHeader = [
    "symbol",
    "direction",
    "startTs",
    "extremeTs",
    "endTs",
    "durationMs",
    "sameDirectionLiqUsd",
    "historicalPercentileRank",
    "historicalSampleCount",
    "belowP90",
    "betweenP90P95",
    "atOrAboveP95",
    "oiAtEndQuality",
    "oiAtEndOffsetMs",
    "oiStartToEndUsd",
    "oiStartToEndPct",
    "oiQuantityStartToEndPct",
    "oiNetChangeToLiqRatio",
    "oiClearingRatio",
    "oiStartToExtremeUsd",
    "oiExtremeToEndUsd",
    "liquidatedQuantityStartToEnd",
    "observedOiQuantityChangeStartToEnd",
    "impliedReplacementQuantityStartToEnd",
    "impliedReplacementRatioStartToEnd",
    "residualContractionStartToEnd",
    "clearingThenStabilization",
    "mfe5mPct",
    "mae5mPct",
    "mfe15mPct",
    "mae15mPct",
  ];
  const csvRows = allRecords.map((r) =>
    [
      r.symbol,
      r.direction,
      r.startTs,
      r.extremeTs,
      r.endTs,
      r.durationMs,
      r.sameDirectionLiqUsd.toFixed(0),
      r.historical.percentileRank?.toFixed(1) ?? "",
      r.historical.historicalSampleCount,
      r.belowP90 ?? "",
      r.betweenP90P95 ?? "",
      r.atOrAboveP95 ?? "",
      r.oiAtEnd?.quality ?? "no_waypoint",
      r.oiAtEnd?.offsetMs ?? "",
      r.oiPhaseChangeUsd.oiStartToEndUsd?.toFixed(0) ?? "",
      r.oiPhaseChangeUsd.oiStartToEndPct?.toFixed(3) ?? "",
      r.oiPhaseChangeQuantity.oiQuantityStartToEndPct?.toFixed(3) ?? "",
      r.oiLiquidationRatios.oiNetChangeToLiqRatio?.toFixed(4) ?? "",
      r.oiLiquidationRatios.oiClearingRatio?.toFixed(4) ?? "",
      r.oiPhaseChangeUsd.oiStartToExtremeUsd?.toFixed(0) ?? "",
      r.oiPhaseChangeUsd.oiExtremeToEndUsd?.toFixed(0) ?? "",
      r.quantityAccounting.startToEnd.liquidatedQuantity?.toFixed(6) ?? "",
      r.quantityAccounting.startToEnd.observedOiQuantityChange?.toFixed(6) ??
        "",
      r.quantityAccounting.startToEnd.impliedReplacementQuantity?.toFixed(6) ??
        "",
      r.quantityAccounting.startToEnd.impliedReplacementToLiquidationRatio?.toFixed(
        3,
      ) ?? "",
      r.quantityAccounting.startToEnd.residualContractionBeyondLiquidation?.toFixed(
        6,
      ) ?? "",
      r.clearingTransitionAtEnd.clearingThenStabilizationPattern ?? "",
      r.outcomes[5]?.mfePct?.toFixed(3) ?? "",
      r.outcomes[5]?.maePct?.toFixed(3) ?? "",
      r.outcomes[15]?.mfePct?.toFixed(3) ?? "",
      r.outcomes[15]?.maePct?.toFixed(3) ?? "",
    ].join(","),
  );
  fs.writeFileSync(
    path.join(outDir, `episode-research-${tag}.csv`),
    [csvHeader.join(","), ...csvRows].join("\n"),
  );

  const summary = {
    totalEpisodes: allRecords.length,
    perSymbolCounts,
    qualityDistribution: Object.fromEntries(
      qualityBuckets.map((b) => [
        b,
        allRecords.filter((r) => (r.oiAtEnd?.quality ?? "no_waypoint") === b)
          .length,
      ]),
    ),
    percentileBandVs5mOutcome: Object.fromEntries(
      (["below P90", "P90-P95", ">=P95"] as const).map((label, i) => [
        label,
        groupStats(
          allRecords,
          5,
          [
            (r: EpisodeResearchRecord) => r.belowP90 === true,
            (r: EpisodeResearchRecord) => r.betweenP90P95 === true,
            (r: EpisodeResearchRecord) => r.atOrAboveP95 === true,
          ][i]!,
        ),
      ]),
    ),
    oiLiquidationRatioDistribution: (["LONG", "SHORT"] as const).reduce(
      (acc, direction) => {
        const values = allRecords
          .filter(
            (r) =>
              r.direction === direction &&
              r.oiLiquidationRatios.oiNetChangeToLiqRatio !== null,
          )
          .map((r) => r.oiLiquidationRatios.oiNetChangeToLiqRatio!);
        acc[direction] = {
          n: values.length,
          median: median(values),
          ...iqr(values),
        };
        return acc;
      },
      {} as Record<
        string,
        {
          n: number;
          median: number | null;
          p25: number | null;
          p75: number | null;
        }
      >,
    ),
    startToExtremeVsExtremeToEndPhaseCounts: {
      contractionThenStabilize: allRecords.filter(
        (r) =>
          r.oiPhaseChangeUsd.oiStartToExtremeUsd !== null &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd !== null &&
          r.oiPhaseChangeUsd.oiStartToExtremeUsd < 0 &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd >= 0,
      ).length,
      contractionThenContinuedContraction: allRecords.filter(
        (r) =>
          r.oiPhaseChangeUsd.oiStartToExtremeUsd !== null &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd !== null &&
          r.oiPhaseChangeUsd.oiStartToExtremeUsd < 0 &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd < 0,
      ).length,
      measurableBothPhases: allRecords.filter(
        (r) =>
          r.oiPhaseChangeUsd.oiStartToExtremeUsd !== null &&
          r.oiPhaseChangeUsd.oiExtremeToEndUsd !== null,
      ).length,
    },
  };
  fs.writeFileSync(
    path.join(outDir, `episode-research-summary-${tag}.json`),
    JSON.stringify(summary, null, 2),
  );

  const interesting = {
    atOrAboveP95WeakReversal: allRecords
      .filter(
        (r) => r.atOrAboveP95 === true && (r.outcomes[5]?.mfePct ?? 0) < 0.3,
      )
      .map((r) => r.inspectWindow),
    belowP90StrongReversal: allRecords
      .filter((r) => r.belowP90 === true && (r.outcomes[5]?.mfePct ?? 0) > 1.0)
      .map((r) => r.inspectWindow),
    clearingStabilizationStrongReversal: allRecords
      .filter(
        (r) =>
          r.clearingTransitionAtEnd.clearingThenStabilizationPattern === true &&
          (r.outcomes[5]?.mfePct ?? 0) > 1.0,
      )
      .map((r) => r.inspectWindow),
    clearingStabilizationFailedReversal: allRecords
      .filter(
        (r) =>
          r.clearingTransitionAtEnd.clearingThenStabilizationPattern === true &&
          (r.outcomes[5]?.mfePct ?? 0) < 0.3,
      )
      .map((r) => r.inspectWindow),
    highQualityOiAtEnd: allRecords
      .filter(
        (r) => r.oiAtEnd !== null && Math.abs(r.oiAtEnd.offsetMs) <= 10_000,
      )
      .map((r) => r.inspectWindow),
    poorQualityOiAtEnd: allRecords
      .filter(
        (r) => r.oiAtEnd === null || Math.abs(r.oiAtEnd.offsetMs) > 120_000,
      )
      .map((r) => r.inspectWindow),
  };
  fs.writeFileSync(
    path.join(outDir, `episode-research-interesting-${tag}.json`),
    JSON.stringify(interesting, null, 2),
  );

  console.log(`\nJSON: research-output/episode-research-${tag}.json`);
  console.log(`CSV: research-output/episode-research-${tag}.csv`);
  console.log(`Summary: research-output/episode-research-summary-${tag}.json`);
  console.log(
    `Interesting: research-output/episode-research-interesting-${tag}.json`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
