import * as fs from "fs";
import type { Side, Candle } from "../src/shared/common.types";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import {
  causalPercentileFamily,
  percentileRank,
  LOOKBACK_WINDOWS_MS,
  percentile,
} from "./build-real-reversal-causal-history";
import {
  reconstructTruePath,
  classifyCandidate,
  type HistoricalCandle,
} from "./reconstruct-true-liquidation-reversal-path-fixed";

/**
 * Sep 14 2026 (Karo), operator-requested. Treats each frozen
 * directional group as one complete directional episode. Freezes
 * causal ATR at group start/end, measures the post-group multi-
 * horizon outcome path (reusing reconstructTruePath unchanged),
 * builds causal historical percentile context for GROUP TOTAL USD,
 * derives outcome label definitions from the OBSERVED distribution,
 * and isolates the reversal population only after outcome measurement
 * is complete. Pure local read of two already-frozen files.
 *
 *   tsx scripts/directional-group-reversal-study.ts \
 *     --groups=/mnt/data/directional-liquidation-groups-6d-<ts>.json \
 *     --master=/mnt/data/liquidation-master-6d-FINAL-v2-<ts>.json
 *
 * DUAL REFERENCE: post-group outcome ATR/pct values use the GROUP-END
 * liquidation price as refPrice. Excursion from the group's own
 * liquidation extreme is a separate field, never mixed in.
 *
 * ATR NORMALIZATION: post-group outcome ATR normalized by
 * liquidationDirectionAtrAtEnd (causal at group finish).
 * liquidationDirectionMoveATR (group-internal) uses
 * liquidationDirectionAtrAtStart, per operator spec.
 *
 * GROUP-TOTAL HISTORICAL PERCENTILE: built from the frozen groups
 * list's own totalLiquidationUsd + endTimestamp, reusing
 * causalPercentileFamily/percentileRank unchanged, filtered to
 * timestamp <= (endTimestamp - 1) -- excludes the current group from
 * its own history by construction.
 */

interface RawGroupEvent {
  globalIndex: number;
  timestamp: number;
  price: number;
  quoteQty: number;
  gapFromPreviousEventInGroupMs: number | null;
}
interface RawGroup {
  groupId: string;
  symbol: string;
  victim: Side;
  groupIndexWithinSymbol: number;
  startTimestamp: number;
  endTimestamp: number;
  durationMs: number;
  eventCount: number;
  totalLiquidationUsd: number;
  maxSingleLiquidationUsd: number;
  events: RawGroupEvent[];
  nextGroupId: string | null;
  nextGroupVictim: Side | null;
  nextGroupStartTimestamp: number | null;
  nextGroupTotalLiquidationUsd: number | null;
}
interface GroupsFile {
  summary: { rawEventCount: number; totalGroupCount: number };
  groups: RawGroup[];
}
interface MasterFile {
  rawData: {
    liquidations: Record<string, unknown[]>;
    candles: Record<string, Candle[]>;
  };
}

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const HORIZONS = [1, 2, 3, 5, 10, 15, 30] as const;
const EPSILON = 1e-9;

function median(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}
function distSummary(values: readonly number[]): Record<string, number | null> {
  const s = [...values].sort((a, b) => a - b);
  const p = (q: number): number | null => percentile(s, q);
  return {
    count: s.length,
    p10: p(0.1),
    p25: p(0.25),
    p50: p(0.5),
    p70: p(0.7),
    p75: p(0.75),
    p80: p(0.8),
    p90: p(0.9),
    p95: p(0.95),
    p975: p(0.975),
    p99: p(0.99),
  };
}
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseArgs(argv: string[]): { groupsPath: string; masterPath: string } {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const groupsPath = get("groups"),
    masterPath = get("master");
  if (!groupsPath || !masterPath) {
    console.error(
      "Usage: directional-group-reversal-study.ts --groups=<path> --master=<path>",
    );
    process.exit(1);
  }
  return { groupsPath, masterPath };
}

function main(): void {
  const { groupsPath, masterPath } = parseArgs(process.argv.slice(2));
  const groupsFile: GroupsFile = JSON.parse(
    fs.readFileSync(groupsPath, "utf8"),
  );
  const masterFile: MasterFile = JSON.parse(
    fs.readFileSync(masterPath, "utf8"),
  );
  const sourceGroups = groupsFile.groups;
  console.log(`Source group count: ${sourceGroups.length}`);

  const candlesBySymbol = new Map<string, HistoricalCandle[]>();
  for (const symbol of SYMBOLS) {
    candlesBySymbol.set(
      symbol,
      (masterFile.rawData.candles[symbol] ?? []).map((c) => ({
        symbol,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        isClosed: true as const,
      })),
    );
  }

  const groupTotalSeriesByStream = new Map<
    string,
    { timestamp: number; value: number }[]
  >();
  const groupTotalSeriesBySymbol = new Map<
    string,
    { timestamp: number; value: number }[]
  >();
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const key = `${symbol}|${victim}`;
      groupTotalSeriesByStream.set(
        key,
        sourceGroups
          .filter((g) => g.symbol === symbol && g.victim === victim)
          .map((g) => ({
            timestamp: g.endTimestamp,
            value: g.totalLiquidationUsd,
          })),
      );
    }
    groupTotalSeriesBySymbol.set(
      symbol,
      sourceGroups
        .filter((g) => g.symbol === symbol)
        .map((g) => ({
          timestamp: g.endTimestamp,
          value: g.totalLiquidationUsd,
        })),
    );
  }

  interface Enriched {
    group: RawGroup;
    startAtr: {
      liqAtr: number | null;
      recAtr: number | null;
      ratio: number | null;
    };
    endAtr: {
      liqAtr: number | null;
      recAtr: number | null;
      ratio: number | null;
    };
    atrChange: {
      liqAtrChangePct: number | null;
      recoveryAtrChangePct: number | null;
      atrRatioChangePct: number | null;
    };
    liquidationPhysics: {
      firstPrice: number;
      lastPrice: number;
      extremePrice: number;
      moveATR: number | null;
      efficiency: number | null;
    };
    postGroupHorizons: Record<
      string,
      {
        favorableATR: number;
        adverseATR: number;
        netDirectionalOutcomeATR: number;
        reversalDominanceRatio: number;
        timeToFavorableExtremeMs: number | null;
        timeToAdverseExtremeMs: number | null;
        dataQuality: string;
      }
    >;
    excursionFromLiquidationExtreme: { newExtremeBeyondGroup: boolean };
    pathOrder: {
      firstDirectionalMove: string;
      firstDominantMove: string;
      dataQuality: string;
    };
    historicalContext: Record<
      string,
      {
        sameStream: {
          rank: number | null;
          sampleCount: number;
          family: ReturnType<typeof causalPercentileFamily>;
          lowSample: boolean;
        };
        sameSymbolBothDirections: {
          rank: number | null;
          sampleCount: number;
          family: ReturnType<typeof causalPercentileFamily>;
          lowSample: boolean;
        };
      }
    >;
  }

  const MIN_SAMPLES_RELIABLE = 20;
  const enriched: Enriched[] = [];
  const incompleteHorizonCounts: Record<string, number> = {
    "1m": 0,
    "2m": 0,
    "3m": 0,
    "5m": 0,
    "10m": 0,
    "15m": 0,
    "30m": 0,
  };

  for (const group of sourceGroups) {
    const candles = candlesBySymbol.get(group.symbol) ?? [];
    const tracker = new DirectionalAtrTracker();
    let ci = 0;
    const feedTo = (ts: number): void => {
      while (ci < candles.length && candles[ci]!.openTime + 60_000 <= ts) {
        tracker.onCandle(candles[ci]!);
        ci++;
      }
    };

    feedTo(group.startTimestamp);
    const startLiqAtr =
      group.victim === "LONG"
        ? tracker.getDownAtr(group.symbol)
        : tracker.getUpAtr(group.symbol);
    const startRecAtr =
      group.victim === "LONG"
        ? tracker.getUpAtr(group.symbol)
        : tracker.getDownAtr(group.symbol);
    const startAtr = {
      liqAtr: startLiqAtr,
      recAtr: startRecAtr,
      ratio:
        startLiqAtr && startLiqAtr > 0 && startRecAtr !== null
          ? startRecAtr / startLiqAtr
          : null,
    };

    feedTo(group.endTimestamp);
    const endLiqAtr =
      group.victim === "LONG"
        ? tracker.getDownAtr(group.symbol)
        : tracker.getUpAtr(group.symbol);
    const endRecAtr =
      group.victim === "LONG"
        ? tracker.getUpAtr(group.symbol)
        : tracker.getDownAtr(group.symbol);
    const endAtr = {
      liqAtr: endLiqAtr,
      recAtr: endRecAtr,
      ratio:
        endLiqAtr && endLiqAtr > 0 && endRecAtr !== null
          ? endRecAtr / endLiqAtr
          : null,
    };

    const atrChange = {
      liqAtrChangePct:
        startAtr.liqAtr && startAtr.liqAtr > 0 && endAtr.liqAtr !== null
          ? ((endAtr.liqAtr - startAtr.liqAtr) / startAtr.liqAtr) * 100
          : null,
      recoveryAtrChangePct:
        startAtr.recAtr && startAtr.recAtr > 0 && endAtr.recAtr !== null
          ? ((endAtr.recAtr - startAtr.recAtr) / startAtr.recAtr) * 100
          : null,
      atrRatioChangePct:
        startAtr.ratio && startAtr.ratio > 0 && endAtr.ratio !== null
          ? ((endAtr.ratio - startAtr.ratio) / startAtr.ratio) * 100
          : null,
    };

    const firstPrice = group.events[0]!.price;
    const lastPrice = group.events[group.events.length - 1]!.price;
    const extremePrice =
      group.victim === "LONG"
        ? Math.min(...group.events.map((e) => e.price))
        : Math.max(...group.events.map((e) => e.price));
    const moveATR =
      startAtr.liqAtr && startAtr.liqAtr > 0
        ? Math.abs(extremePrice - firstPrice) / startAtr.liqAtr
        : null;
    const efficiency =
      moveATR !== null && group.totalLiquidationUsd > 0
        ? moveATR / (group.totalLiquidationUsd / 1_000_000)
        : null;

    const truePath = reconstructTruePath(
      candles,
      group.endTimestamp,
      lastPrice,
      group.victim,
      extremePrice,
    );
    const postGroupHorizons: Enriched["postGroupHorizons"] = {};
    for (const h of HORIZONS) {
      const key = `${h}m`;
      if (truePath.dataQuality === "NO_DATA" || truePath.candlesConsumed < h) {
        incompleteHorizonCounts[key] = (incompleteHorizonCounts[key] ?? 0) + 1;
        continue;
      }
      const p = truePath.path.find((pt) => pt.minute === h)!;
      const favATR =
        endAtr.liqAtr && endAtr.liqAtr > 0
          ? ((p.favorablePct / 100) * lastPrice) / endAtr.liqAtr
          : 0;
      const advATR =
        endAtr.liqAtr && endAtr.liqAtr > 0
          ? ((p.adversePct / 100) * lastPrice) / endAtr.liqAtr
          : 0;
      const before = truePath.path.filter((pt) => pt.minute <= h);
      const favMaxSoFar = Math.max(...before.map((pt) => pt.favorablePct));
      const advMaxSoFar = Math.max(...before.map((pt) => pt.adversePct));
      const timeToFav =
        before.find((pt) => pt.favorablePct === favMaxSoFar)?.minute ?? null;
      const timeToAdv =
        before.find((pt) => pt.adversePct === advMaxSoFar)?.minute ?? null;
      postGroupHorizons[key] = {
        favorableATR: favATR,
        adverseATR: advATR,
        netDirectionalOutcomeATR: favATR - advATR,
        reversalDominanceRatio: favATR / Math.max(advATR, EPSILON),
        timeToFavorableExtremeMs:
          timeToFav !== null ? timeToFav * 60_000 : null,
        timeToAdverseExtremeMs: timeToAdv !== null ? timeToAdv * 60_000 : null,
        dataQuality:
          p.favorablePct === 0 && p.adversePct === 0 ? "NO_MOVE" : "VALID",
      };
    }

    const streamKey = `${group.symbol}|${group.victim}`;
    const historicalContext: Enriched["historicalContext"] = {};
    for (const w of LOOKBACK_WINDOWS_MS.filter((x) => x.label !== "all")) {
      const streamSeries = groupTotalSeriesByStream.get(streamKey) ?? [];
      const symbolSeries = groupTotalSeriesBySymbol.get(group.symbol) ?? [];
      const streamFam = causalPercentileFamily(
        streamSeries,
        group.endTimestamp - 1,
        w.ms,
      );
      const symbolFam = causalPercentileFamily(
        symbolSeries,
        group.endTimestamp - 1,
        w.ms,
      );
      historicalContext[w.label] = {
        sameStream: {
          rank: percentileRank(
            streamSeries,
            group.endTimestamp - 1,
            w.ms,
            group.totalLiquidationUsd,
          ),
          sampleCount: streamFam.sampleCount,
          family: streamFam,
          lowSample: streamFam.sampleCount < MIN_SAMPLES_RELIABLE,
        },
        sameSymbolBothDirections: {
          rank: percentileRank(
            symbolSeries,
            group.endTimestamp - 1,
            w.ms,
            group.totalLiquidationUsd,
          ),
          sampleCount: symbolFam.sampleCount,
          family: symbolFam,
          lowSample: symbolFam.sampleCount < MIN_SAMPLES_RELIABLE,
        },
      };
    }

    enriched.push({
      group,
      startAtr,
      endAtr,
      atrChange,
      liquidationPhysics: {
        firstPrice,
        lastPrice,
        extremePrice,
        moveATR,
        efficiency,
      },
      postGroupHorizons,
      excursionFromLiquidationExtreme: {
        newExtremeBeyondGroup:
          (
            truePath as unknown as {
              createdNewLiqDirectionExtremeBeyondCandidate?: boolean;
            }
          ).createdNewLiqDirectionExtremeBeyondCandidate ?? false,
      },
      pathOrder: {
        firstDirectionalMove: truePath.firstDirectionalMove,
        firstDominantMove: truePath.firstDominantMove,
        dataQuality: truePath.dataQuality,
      },
      historicalContext,
    });
  }

  console.log(
    "\n=== EMPIRICAL DISTRIBUTIONS (5m horizon, before any label is chosen) ===\n",
  );
  const dom5Values = enriched
    .map((e) => e.postGroupHorizons["5m"]?.reversalDominanceRatio)
    .filter((v): v is number => v !== undefined);
  const net5Values = enriched
    .map((e) => e.postGroupHorizons["5m"]?.netDirectionalOutcomeATR)
    .filter((v): v is number => v !== undefined);
  console.log(
    `reversalDominanceRatio@5m: ${JSON.stringify(distSummary(dom5Values))}`,
  );
  console.log(
    `netDirectionalOutcomeATR@5m: ${JSON.stringify(distSummary(net5Values))}`,
  );

  const domShareValues = enriched
    .map((e) => {
      const h = e.postGroupHorizons["5m"];
      return h
        ? h.favorableATR / Math.max(h.favorableATR + h.adverseATR, EPSILON)
        : null;
    })
    .filter((v): v is number => v !== null);
  const domShareSorted = [...domShareValues].sort((a, b) => a - b);
  const p25 = percentile(domShareSorted, 0.25),
    p75 = percentile(domShareSorted, 0.75),
    p90 = percentile(domShareSorted, 0.9);
  console.log(
    `\nlabelDefinitionA (dominance-share quantiles, 5m): P25=${p25?.toFixed(3)} P75=${p75?.toFixed(3)} P90=${p90?.toFixed(3)}`,
  );
  const net5Sorted = [...net5Values].sort((a, b) => a - b);
  const netP25 = percentile(net5Sorted, 0.25),
    netP75 = percentile(net5Sorted, 0.75);
  console.log(
    `labelDefinitionB (netDirectionalOutcomeATR quantiles, 5m): P25=${netP25?.toFixed(3)} P75=${netP75?.toFixed(3)}`,
  );
  console.log(
    `labelDefinitionC: labelDefinitionA's dominance-share test AND path order (firstDominantMove != CONTINUATION), reuses classifyCandidate() unchanged from Phase-3.`,
  );

  type OutcomeLabel =
    | "REAL_REVERSAL"
    | "CONTINUATION"
    | "AMBIGUOUS"
    | "NO_MOVE"
    | "NO_DATA";
  const labelA = (e: Enriched): OutcomeLabel => {
    const h = e.postGroupHorizons["5m"];
    if (e.pathOrder.dataQuality === "NO_DATA" || !h) return "NO_DATA";
    if (h.dataQuality === "NO_MOVE") return "NO_MOVE";
    const share =
      h.favorableATR / Math.max(h.favorableATR + h.adverseATR, EPSILON);
    if (p90 !== null && share >= p90) return "REAL_REVERSAL";
    if (p25 !== null && share <= p25) return "CONTINUATION";
    return "AMBIGUOUS";
  };
  const labelB = (e: Enriched): OutcomeLabel => {
    const h = e.postGroupHorizons["5m"];
    if (e.pathOrder.dataQuality === "NO_DATA" || !h) return "NO_DATA";
    if (h.dataQuality === "NO_MOVE") return "NO_MOVE";
    if (netP75 !== null && h.netDirectionalOutcomeATR >= netP75)
      return "REAL_REVERSAL";
    if (netP25 !== null && h.netDirectionalOutcomeATR <= netP25)
      return "CONTINUATION";
    return "AMBIGUOUS";
  };
  const labelC = (e: Enriched): OutcomeLabel => {
    if (e.pathOrder.dataQuality === "NO_DATA") return "NO_DATA";
    const h = e.postGroupHorizons["5m"];
    if (!h) return "NO_DATA";
    const share =
      h.favorableATR / Math.max(h.favorableATR + h.adverseATR, EPSILON);
    const truePathLike = {
      dataQuality: h.dataQuality,
      firstDominantMove: e.pathOrder.firstDominantMove,
      maxAdverseBeforeFavorableDominance: null,
      maxFavorablePct: h.favorableATR,
    } as Parameters<typeof classifyCandidate>[1];
    const cls = classifyCandidate(share, truePathLike, p25, p75, p90);
    return cls === "LIKELY_REVERSAL" ? "AMBIGUOUS" : (cls as OutcomeLabel);
  };

  const countsFor = (
    labelFn: (e: Enriched) => OutcomeLabel,
  ): Record<OutcomeLabel, number> => {
    const counts: Record<OutcomeLabel, number> = {
      REAL_REVERSAL: 0,
      CONTINUATION: 0,
      AMBIGUOUS: 0,
      NO_MOVE: 0,
      NO_DATA: 0,
    };
    for (const e of enriched) counts[labelFn(e)]++;
    return counts;
  };
  const countsA = countsFor(labelA),
    countsB = countsFor(labelB),
    countsC = countsFor(labelC);
  console.log(`\nlabelDefinitionA counts: ${JSON.stringify(countsA)}`);
  console.log(`labelDefinitionB counts: ${JSON.stringify(countsB)}`);
  console.log(`labelDefinitionC counts: ${JSON.stringify(countsC)}`);

  const realReversals = enriched.filter((e) => labelC(e) === "REAL_REVERSAL");
  const continuations = enriched.filter((e) => labelC(e) === "CONTINUATION");
  console.log(
    `\n=== REAL_REVERSAL group-total USD distribution (labelDefinitionC, n=${realReversals.length}) ===`,
  );
  const usdDist = distSummary(
    realReversals.map((e) => e.group.totalLiquidationUsd),
  );
  console.log(JSON.stringify(usdDist));

  const fractionAbove = (
    lookback: string,
    threshold: "p50" | "p70" | "p75" | "p80" | "p90" | "p95" | "p975" | "p99",
  ): number | null => {
    const withRank = realReversals.filter(
      (e) =>
        e.historicalContext[lookback]?.sameStream.rank !== null &&
        !e.historicalContext[lookback]?.sameStream.lowSample,
    );
    if (withRank.length === 0) return null;
    const values = withRank.map((e) => e.group.totalLiquidationUsd);
    const historicalFam =
      withRank[withRank.length - 1]!.historicalContext[lookback]!.sameStream
        .family;
    const thresholdVal = historicalFam[
      threshold as keyof typeof historicalFam
    ] as number | null;
    if (thresholdVal === null) return null;
    return values.filter((v) => v >= thresholdVal).length / values.length;
  };
  console.log(
    `\nFraction of REAL_REVERSAL groups above historical percentile thresholds, by lookback:`,
  );
  for (const w of LOOKBACK_WINDOWS_MS.filter((x) => x.label !== "all")) {
    const row: Record<string, number | null> = {};
    for (const t of [
      "p50",
      "p70",
      "p75",
      "p80",
      "p90",
      "p95",
      "p975",
      "p99",
    ] as const)
      row[t] = fractionAbove(w.label, t);
    console.log(`  ${w.label}: ${JSON.stringify(row)}`);
  }

  console.log("\n=== COMPARISON: REAL_REVERSAL vs CONTINUATION ===\n");
  const compareFields: {
    name: string;
    extractor: (e: Enriched) => number | null;
  }[] = [
    {
      name: "totalLiquidationUsd",
      extractor: (e) => e.group.totalLiquidationUsd,
    },
    {
      name: "maxSingleLiquidationUsd",
      extractor: (e) => e.group.maxSingleLiquidationUsd,
    },
    { name: "eventCount", extractor: (e) => e.group.eventCount },
    { name: "durationMs", extractor: (e) => e.group.durationMs },
    {
      name: "liquidationDirectionMoveATR",
      extractor: (e) => e.liquidationPhysics.moveATR,
    },
    {
      name: "liquidationEfficiency",
      extractor: (e) => e.liquidationPhysics.efficiency,
    },
    { name: "liqAtrChangePct", extractor: (e) => e.atrChange.liqAtrChangePct },
    {
      name: "recoveryAtrChangePct",
      extractor: (e) => e.atrChange.recoveryAtrChangePct,
    },
  ];
  for (const f of compareFields) {
    const rv = realReversals
      .map(f.extractor)
      .filter((v): v is number => v !== null);
    const cv = continuations
      .map(f.extractor)
      .filter((v): v is number => v !== null);
    console.log(
      `${f.name}: REAL median=${median(rv)?.toFixed(3)} (n=${rv.length})  CONTINUATION median=${median(cv)?.toFixed(3)} (n=${cv.length})`,
    );
  }

  console.log("\n=== VALIDATION ===\n");
  const violations: string[] = [];
  if (sourceGroups.length !== groupsFile.summary.totalGroupCount)
    violations.push(
      `Group count mismatch: processed ${sourceGroups.length}, source summary says ${groupsFile.summary.totalGroupCount}`,
    );
  const totalEventsInGroups = sourceGroups.reduce(
    (s, g) => s + g.eventCount,
    0,
  );
  if (totalEventsInGroups !== groupsFile.summary.rawEventCount)
    violations.push(
      `Event count mismatch: groups sum to ${totalEventsInGroups}, source says ${groupsFile.summary.rawEventCount}`,
    );
  const validationPass = violations.length === 0;
  console.log(`Validation: ${validationPass ? "PASS" : "FAIL"}`);
  violations.forEach((v) => console.error(`  ${v}`));
  console.log(
    `Incomplete future-window counts (near dataset end, NOT labeled negative): ${JSON.stringify(incompleteHorizonCounts)}`,
  );

  const outPathJson = `/mnt/data/directional-group-reversal-study-6d-${Date.now()}.json`;
  fs.writeFileSync(
    outPathJson,
    JSON.stringify({
      methodology: {
        dualReference:
          "postGroupHorizons use the GROUP-END liquidation price as refPrice. excursionFromLiquidationExtreme is a separate field, never mixed in.",
        atrNormalizationChoice:
          "Post-group outcome ATR values normalized by liquidationDirectionAtrAtEnd. Group-internal liquidationDirectionMoveATR normalized by liquidationDirectionAtrAtStart, per operator spec.",
        labelDefinitions: {
          A: "dominanceShare@5m quantiles (P25/P75/P90 of the OBSERVED distribution)",
          B: "netDirectionalOutcomeATR@5m quantiles (P25/P75 of the OBSERVED distribution)",
          C: "A's dominance-share test combined with path order (firstDominantMove != CONTINUATION), reusing classifyCandidate() unchanged from Phase-3",
        },
        historicalPercentileCausality:
          "Group-total historical series filtered strictly to timestamp <= (group.endTimestamp - 1), which structurally excludes the current group from its own history by construction of causalPercentileFamily's own <= atT filter.",
      },
      summary: {
        groupCount: sourceGroups.length,
        incompleteHorizonCounts,
        labelCountsA: countsA,
        labelCountsB: countsB,
        labelCountsC: countsC,
      },
      dominanceDistribution5m: distSummary(dom5Values),
      netDirectionalOutcomeDistribution5m: distSummary(net5Values),
      reversalOnlyUsdDistribution: usdDist,
      groups: enriched,
      validation: { violations, pass: validationPass },
    }),
  );

  const csvHeaders = [
    "groupId",
    "symbol",
    "victim",
    "totalLiquidationUsd",
    "eventCount",
    "durationMs",
    "liquidationDirectionMoveATR",
    "liquidationEfficiency",
    "liqAtrChangePct",
    "recoveryAtrChangePct",
    "labelA",
    "labelB",
    "labelC",
    "favorable5mATR",
    "adverse5mATR",
    "netDirectionalOutcomeATR5m",
  ];
  const csvRows = enriched.map((e) => {
    const h = e.postGroupHorizons["5m"];
    return [
      e.group.groupId,
      e.group.symbol,
      e.group.victim,
      e.group.totalLiquidationUsd,
      e.group.eventCount,
      e.group.durationMs,
      e.liquidationPhysics.moveATR,
      e.liquidationPhysics.efficiency,
      e.atrChange.liqAtrChangePct,
      e.atrChange.recoveryAtrChangePct,
      labelA(e),
      labelB(e),
      labelC(e),
      h?.favorableATR ?? null,
      h?.adverseATR ?? null,
      h?.netDirectionalOutcomeATR ?? null,
    ];
  });
  const outPathCsv = `/mnt/data/directional-group-reversal-study-summary-6d-${Date.now()}.csv`;
  fs.writeFileSync(
    outPathCsv,
    [
      csvHeaders.join(","),
      ...csvRows.map((r) => r.map(csvEscape).join(",")),
    ].join("\n"),
  );

  console.log(`\nOutput JSON: ${outPathJson}`);
  console.log(`Output CSV: ${outPathCsv}`);
}

main();
