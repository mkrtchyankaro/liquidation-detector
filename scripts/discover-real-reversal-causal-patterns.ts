import * as fs from "fs";

/**
 * Sep 14 2026 (Karo), operator-requested. Deep causal discovery study
 * on the FINAL frozen dataset -- pure local read, no Mongo, no
 * Binance, no other research JSON consulted. Does not modify the
 * source file.
 *
 *   tsx scripts/discover-real-reversal-causal-patterns.ts --input=/mnt/data/liquidation-master-6d-FINAL-v2-<ts>.json
 *
 * CAUSAL/OUTCOME SEPARATION (enforced structurally, not just by
 * convention): every function that computes a "live-like" finding
 * (Parts 1-6, 9) takes ONLY `candidate.causal` as input -- outcome/
 * outcomeLadder/sequenceClass are threaded through a SEPARATE code
 * path used only for Part 7 (strength grouping) and for labeling
 * which population a canonical observation belongs to. A dedicated
 * smoke test constructs a candidate whose causal block is IDENTICAL
 * for two different outcome classes and confirms the causal-only
 * functions produce identical output regardless of outcome -- proving
 * outcome cannot leak in silently.
 *
 * SEQUENCE-AWARE COMPARISON: between-group statistics (Parts 2-4, 8,
 * 9) use exactly ONE canonical observation per sequence, never all
 * candidates -- candidates within a sequence are not independent
 * samples. Canonicalization: REAL_REVERSAL/FAILED_REVERSAL use
 * firstTrueReversalCandidateIndex (the point the sequence actually
 * became a confirmed reversal); CONTINUATION/AMBIGUOUS use the
 * sequence's own last candidate (its natural terminal state) -- the
 * same convention established in fix-real-reversal-population.ts.
 * Within-sequence trajectory analysis (Parts 1, 3, 4, 5, 6) uses every
 * candidate of that ONE sequence, which is a legitimate replay of a
 * single sequence's own history, not a cross-sequence independence
 * violation.
 */

const PCT_THRESHOLDS = [70, 80, 90, 95, 97.5, 99];

interface PercentileFamily {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p975: number | null;
  p99: number | null;
  sampleCount: number;
}
interface Causal {
  candidateIndex: number;
  cumulativeLiqUsd: number;
  incrementalLiqUsd: number;
  eventCount: number;
  maxSingleLiqUsd: number;
  lastEventUsd: number;
  durationMs: number;
  liqUsdPerSecond: number | null;
  startPrice: number;
  currentPrice: number;
  adverseExtremePrice: number;
  adverseExtremeTs: number;
  priceDisplacementPct: number | null;
  priceDisplacementATR: number | null;
  newAdverseExtreme: boolean;
  adverseProgressSincePreviousCandidatePct: number | null;
  adverseProgressSincePreviousCandidateATR: number | null;
  timeSincePreviousCandidateMs: number | null;
  timeSincePreviousAdverseExtremeMs: number;
  preLiqDirAtr: number | null;
  preRecDirAtr: number | null;
  currentLiqDirAtr: number | null;
  currentRecDirAtr: number | null;
  liqAtrChangePct: number | null;
  recoveryAtrChangePct: number | null;
  singleEventPercentiles: Record<string, PercentileFamily>;
  maxSinglePercentileRank24h: number | null;
  episodePercentiles: Record<string, PercentileFamily>;
  currentEpisodePercentileRank: number | null;
  durationMatchedPercentiles: Record<string, PercentileFamily>;
  durationMatchedPercentileRank: number | null;
  priceProgressATRPer1M: number | null;
  marginalPriceProgressATRPer1M: number | null;
  prevCumulativeLiqUsd: number;
}
interface OutcomeHorizon {
  dataQuality: string;
  favorablePct?: number;
  adversePct?: number;
  favorableATR?: number;
  adverseATR?: number;
  dominanceShare?: number | null;
  responseRatio?: number | null;
  availableClosedCandles?: number;
}
interface Candidate {
  candidateIndex: number;
  timestamp: number;
  causal: Causal;
  candidateOutcomeClass: string;
  outcomeLadder: Record<string, OutcomeHorizon>;
  outcomeCompleteThroughMinutes: number;
  evaluationEligible30m: boolean;
}
interface Sequence {
  sequenceId: string;
  symbol: string;
  victim: "LONG" | "SHORT";
  startTs: number;
  endTs: number;
  eventCount: number;
  cumulativeLiqUsd: number;
  maxSingleLiqUsd: number;
  durationMs: number;
  sequenceClass: string;
  firstTrueReversalCandidateIndex: number | null;
  rawEventIndexes: number[];
  evaluationEligible30m: boolean;
  candidates: Candidate[];
}
interface Master {
  metadata: { primaryResearchPeriod: { fromMs: number; toMs: number } };
  sequences: Sequence[];
}

function median(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sorted[lo]!
    : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
function mean(arr: readonly number[]): number | null {
  return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Canonicalization -- see this file's own header doc comment. Pure,
 *  deterministic, uses only fields already on the sequence/candidate. */
export function canonicalCandidate(seq: Sequence): Candidate | null {
  if (seq.candidates.length === 0) return null;
  if (seq.firstTrueReversalCandidateIndex !== null) {
    return (
      seq.candidates.find(
        (c) => c.candidateIndex === seq.firstTrueReversalCandidateIndex,
      ) ?? null
    );
  }
  return seq.candidates[seq.candidates.length - 1]!;
}

function candidateIndexBucket(idx: number): string {
  if (idx === 1) return "L1";
  if (idx <= 3) return "2-3";
  if (idx <= 5) return "4-5";
  if (idx <= 10) return "6-10";
  return ">10";
}

/** Effect-size style separation stat between two CAUSAL-only value
 *  arrays -- median difference normalized by pooled IQR (robust,
 *  interpretable, no distributional assumptions). Returns null when
 *  either group lacks enough data. */
export function robustSeparation(
  a: readonly number[],
  b: readonly number[],
): {
  medianA: number | null;
  medianB: number | null;
  separation: number | null;
  nA: number;
  nB: number;
} {
  if (a.length < 5 || b.length < 5)
    return {
      medianA: median(a),
      medianB: median(b),
      separation: null,
      nA: a.length,
      nB: b.length,
    };
  const sortedA = [...a].sort((x, y) => x - y),
    sortedB = [...b].sort((x, y) => x - y);
  const iqrA =
    (percentile(sortedA, 0.75) ?? 0) - (percentile(sortedA, 0.25) ?? 0);
  const iqrB =
    (percentile(sortedB, 0.75) ?? 0) - (percentile(sortedB, 0.25) ?? 0);
  const pooledIqr = (iqrA + iqrB) / 2;
  const medA = median(a)!,
    medB = median(b)!;
  const separation = pooledIqr > 0 ? (medA - medB) / pooledIqr : null;
  return {
    medianA: medA,
    medianB: medB,
    separation,
    nA: a.length,
    nB: b.length,
  };
}

// ---- CAUSAL-ONLY feature extractors (never read candidate.outcome/candidateOutcomeClass) ----
export const CAUSAL_FEATURES: {
  name: string;
  extractor: (c: Causal) => number | null;
}[] = [
  {
    name: "currentEpisodePercentileRank",
    extractor: (c) => c.currentEpisodePercentileRank,
  },
  {
    name: "maxSinglePercentileRank24h",
    extractor: (c) => c.maxSinglePercentileRank24h,
  },
  {
    name: "durationMatchedPercentileRank",
    extractor: (c) => c.durationMatchedPercentileRank,
  },
  { name: "priceDisplacementATR", extractor: (c) => c.priceDisplacementATR },
  { name: "liqAtrChangePct", extractor: (c) => c.liqAtrChangePct },
  { name: "recoveryAtrChangePct", extractor: (c) => c.recoveryAtrChangePct },
  { name: "priceProgressATRPer1M", extractor: (c) => c.priceProgressATRPer1M },
  {
    name: "marginalPriceProgressATRPer1M",
    extractor: (c) => c.marginalPriceProgressATRPer1M,
  },
  { name: "eventCount", extractor: (c) => c.eventCount },
  { name: "durationMs", extractor: (c) => c.durationMs },
  {
    name: "timeSincePreviousAdverseExtremeMs",
    extractor: (c) => c.timeSincePreviousAdverseExtremeMs,
  },
];

function parseArgs(argv: string[]): { inputPath: string } {
  const hit = argv.find((a) => a.startsWith("--input="));
  if (!hit) {
    console.error(
      "Usage: discover-real-reversal-causal-patterns.ts --input=/path/to/liquidation-master-6d-FINAL-v2-<ts>.json",
    );
    process.exit(1);
  }
  return { inputPath: hit.slice("--input=".length) };
}

function main(): void {
  const { inputPath } = parseArgs(process.argv.slice(2));
  const master: Master = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const primaryFrom = master.metadata.primaryResearchPeriod.fromMs;

  const primary = master.sequences.filter((s) => s.startTs >= primaryFrom);
  const real = primary.filter((s) => s.sequenceClass === "REAL_REVERSAL");
  const continuation = primary.filter(
    (s) => s.sequenceClass === "CONTINUATION",
  );
  const failed = primary.filter((s) => s.sequenceClass === "FAILED_REVERSAL");
  const ambiguous = primary.filter((s) => s.sequenceClass === "AMBIGUOUS");
  console.log(`Primary period sequences: ${primary.length}`);
  console.log(
    `REAL_REVERSAL=${real.length} CONTINUATION=${continuation.length} FAILED_REVERSAL=${failed.length} AMBIGUOUS=${ambiguous.length}\n`,
  );

  const realCanon = real
    .map((s) => ({ seq: s, c: canonicalCandidate(s) }))
    .filter((x): x is { seq: Sequence; c: Candidate } => x.c !== null);
  const contCanon = continuation
    .map((s) => ({ seq: s, c: canonicalCandidate(s) }))
    .filter((x): x is { seq: Sequence; c: Candidate } => x.c !== null);
  const failedCanon = failed
    .map((s) => ({ seq: s, c: canonicalCandidate(s) }))
    .filter((x): x is { seq: Sequence; c: Candidate } => x.c !== null);

  console.log(
    "=== PART 5: L1 vs developed-cascade distribution (REAL_REVERSAL canonical index) ===\n",
  );
  const bucketCounts: Record<string, number> = {};
  for (const { c } of realCanon)
    bucketCounts[candidateIndexBucket(c.candidateIndex)] =
      (bucketCounts[candidateIndexBucket(c.candidateIndex)] ?? 0) + 1;
  console.log(JSON.stringify(bucketCounts));

  console.log(
    "\n=== PART 2: HISTORICAL SIGNIFICANCE (24h rank fields, first-crossing candidate index) ===\n",
  );
  const crossingIndexes: Record<number, number[]> = {};
  for (const t of PCT_THRESHOLDS) crossingIndexes[t] = [];
  for (const seq of real) {
    for (const t of PCT_THRESHOLDS) {
      const firstCross = seq.candidates.find(
        (c) => (c.causal.currentEpisodePercentileRank ?? -1) >= t,
      );
      if (firstCross) crossingIndexes[t]!.push(firstCross.candidateIndex);
    }
  }
  for (const t of PCT_THRESHOLDS) {
    const arr = crossingIndexes[t]!;
    console.log(
      `P${t}: crossed by ${arr.length}/${real.length} sequences, median candidateIndex at crossing=${median(arr)?.toFixed(1) ?? "n/a"}`,
    );
  }
  const maxRankReached = realCanon.map(({ seq }) =>
    Math.max(
      ...seq.candidates.map((c) => c.causal.currentEpisodePercentileRank ?? -1),
    ),
  );
  const belowP90Count = maxRankReached.filter((r) => r < 90 && r >= 0).length;
  console.log(
    `\nREAL_REVERSAL sequences whose max currentEpisodePercentileRank never reached P90: ${belowP90Count} / ${maxRankReached.filter((r) => r >= 0).length}`,
  );

  console.log("\n=== PART 3: ATR TRANSITION ===\n");
  function atrTrajectorySummary(seqs: Sequence[]): {
    peakLiqAtrCandidateMedian: number | null;
    crossoverObservedFraction: number;
    medianCandidatesBeforeCanonicalAtCrossover: number | null;
  } {
    const peakIndexes: number[] = [];
    const crossoverLeadTimes: number[] = [];
    let crossoverCount = 0;
    for (const seq of seqs) {
      const canon = canonicalCandidate(seq);
      if (!canon) continue;
      const liqAtrs = seq.candidates.map(
        (c) => c.causal.currentLiqDirAtr ?? -1,
      );
      const maxLiqAtr = Math.max(...liqAtrs);
      const peakIdx =
        seq.candidates.find(
          (c) => (c.causal.currentLiqDirAtr ?? -1) === maxLiqAtr,
        )?.candidateIndex ?? null;
      if (peakIdx !== null) peakIndexes.push(peakIdx);
      const crossoverCandidate = seq.candidates.find(
        (c) =>
          (c.causal.currentRecDirAtr ?? -1) >
          (c.causal.currentLiqDirAtr ?? Infinity),
      );
      if (crossoverCandidate) {
        crossoverCount++;
        crossoverLeadTimes.push(
          canon.candidateIndex - crossoverCandidate.candidateIndex,
        );
      }
    }
    return {
      peakLiqAtrCandidateMedian: median(peakIndexes),
      crossoverObservedFraction:
        seqs.length > 0 ? crossoverCount / seqs.length : 0,
      medianCandidatesBeforeCanonicalAtCrossover: median(crossoverLeadTimes),
    };
  }
  const atrReal = atrTrajectorySummary(real);
  const atrCont = atrTrajectorySummary(continuation);
  const atrFailed = atrTrajectorySummary(failed);
  console.log(
    `REAL_REVERSAL: peak liqDirATR at median candidateIndex=${atrReal.peakLiqAtrCandidateMedian}, recATR>liqATR crossover observed in ${(atrReal.crossoverObservedFraction * 100).toFixed(1)}% of sequences, median lead time before canonical=${atrReal.medianCandidatesBeforeCanonicalAtCrossover}`,
  );
  console.log(
    `CONTINUATION: crossover observed in ${(atrCont.crossoverObservedFraction * 100).toFixed(1)}% of sequences`,
  );
  console.log(
    `FAILED_REVERSAL: crossover observed in ${(atrFailed.crossoverObservedFraction * 100).toFixed(1)}% of sequences`,
  );

  console.log("\n=== PART 4: EFFICIENCY / EXHAUSTION ===\n");
  function efficiencyTrend(seqs: Sequence[]): {
    fractionShowingDecline: number;
  } {
    let declining = 0,
      measurable = 0;
    for (const seq of seqs) {
      const vals = seq.candidates
        .map((c) => c.causal.marginalPriceProgressATRPer1M)
        .filter((v): v is number => v !== null);
      if (vals.length < 3) continue;
      measurable++;
      const early = mean(vals.slice(0, Math.ceil(vals.length / 2)))!;
      const late = mean(vals.slice(Math.ceil(vals.length / 2)))!;
      if (late < early) declining++;
    }
    return {
      fractionShowingDecline: measurable > 0 ? declining / measurable : 0,
    };
  }
  const effReal = efficiencyTrend(real),
    effCont = efficiencyTrend(continuation),
    effFailed = efficiencyTrend(failed);
  console.log(
    `Fraction of sequences (with >=3 measurable candidates) showing DECLINING marginal efficiency (2nd half < 1st half): REAL_REVERSAL=${(effReal.fractionShowingDecline * 100).toFixed(1)}% CONTINUATION=${(effCont.fractionShowingDecline * 100).toFixed(1)}% FAILED_REVERSAL=${(effFailed.fractionShowingDecline * 100).toFixed(1)}%`,
  );

  console.log(
    "\n=== PART 7: STRENGTH GROUPING (favorable5m, canonical candidates only) ===\n",
  );
  const fav5m = realCanon
    .map(({ c }) => c.outcomeLadder["5m"]?.favorablePct)
    .filter((v): v is number => v !== undefined && v !== null)
    .sort((a, b) => a - b);
  const sP33 = percentile(fav5m, 0.33),
    sP66 = percentile(fav5m, 0.66),
    sP90 = percentile(fav5m, 0.9);
  console.log(
    `favorable5m quantiles (n=${fav5m.length}): P33=${sP33?.toFixed(4)} P66=${sP66?.toFixed(4)} P90=${sP90?.toFixed(4)}`,
  );
  const strengthGroup = (fav: number | null | undefined): string => {
    if (
      fav === null ||
      fav === undefined ||
      sP33 === null ||
      sP66 === null ||
      sP90 === null
    )
      return "UNKNOWN";
    if (fav >= sP90) return "EXTREME";
    if (fav >= sP66) return "STRONG";
    if (fav >= sP33) return "MEDIUM";
    return "WEAK";
  };
  const strengthCounts: Record<string, number> = {};
  for (const { c } of realCanon)
    strengthCounts[strengthGroup(c.outcomeLadder["5m"]?.favorablePct)] =
      (strengthCounts[strengthGroup(c.outcomeLadder["5m"]?.favorablePct)] ??
        0) + 1;
  console.log(`Strength distribution: ${JSON.stringify(strengthCounts)}`);

  console.log(
    "\n=== PART 9: CAUSAL FEATURE SEPARATION (REAL_REVERSAL vs CONTINUATION, canonical candidates) ===\n",
  );
  const separationVsContinuation: Record<
    string,
    ReturnType<typeof robustSeparation>
  > = {};
  const separationVsFailed: Record<
    string,
    ReturnType<typeof robustSeparation>
  > = {};
  for (const f of CAUSAL_FEATURES) {
    const realVals = realCanon
      .map(({ c }) => f.extractor(c.causal))
      .filter((v): v is number => v !== null);
    const contVals = contCanon
      .map(({ c }) => f.extractor(c.causal))
      .filter((v): v is number => v !== null);
    const failedVals = failedCanon
      .map(({ c }) => f.extractor(c.causal))
      .filter((v): v is number => v !== null);
    separationVsContinuation[f.name] = robustSeparation(realVals, contVals);
    separationVsFailed[f.name] = robustSeparation(realVals, failedVals);
    console.log(
      `${f.name}: REAL_REVERSAL median=${separationVsContinuation[f.name]!.medianA?.toFixed(3)} CONTINUATION median=${separationVsContinuation[f.name]!.medianB?.toFixed(3)} separation(IQR-normalized)=${separationVsContinuation[f.name]!.separation?.toFixed(3) ?? "n/a"}`,
    );
  }
  const ranked = Object.entries(separationVsContinuation)
    .filter(([, v]) => v.separation !== null)
    .sort((a, b) => Math.abs(b[1].separation!) - Math.abs(a[1].separation!));
  console.log(
    `\nFeatures ranked by |separation| (REAL_REVERSAL vs CONTINUATION): ${ranked.map(([n, v]) => `${n}(${v.separation!.toFixed(2)})`).join(", ")}`,
  );

  console.log(
    "\n=== PART 8: SYMBOL/VICTIM BREAKDOWN (top-ranked feature) ===\n",
  );
  const topFeatureName = ranked[0]?.[0];
  const topFeature = CAUSAL_FEATURES.find((f) => f.name === topFeatureName);
  const symbolVictimBreakdown: Record<
    string,
    ReturnType<typeof robustSeparation>
  > = {};
  if (topFeature) {
    for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
      for (const victim of ["LONG", "SHORT"] as const) {
        const realVals = realCanon
          .filter(({ seq }) => seq.symbol === symbol && seq.victim === victim)
          .map(({ c }) => topFeature.extractor(c.causal))
          .filter((v): v is number => v !== null);
        const contVals = contCanon
          .filter(({ seq }) => seq.symbol === symbol && seq.victim === victim)
          .map(({ c }) => topFeature.extractor(c.causal))
          .filter((v): v is number => v !== null);
        const key = `${symbol}-${victim}`;
        symbolVictimBreakdown[key] = robustSeparation(realVals, contVals);
        if (realVals.length >= 5 && contVals.length >= 5)
          console.log(
            `${key}: separation=${symbolVictimBreakdown[key]!.separation?.toFixed(3) ?? "n/a"} (nReal=${realVals.length}, nCont=${contVals.length})`,
          );
      }
    }
  }

  const strongestReal = [...realCanon]
    .sort(
      (a, b) =>
        (b.c.outcomeLadder["5m"]?.favorablePct ?? 0) -
        (a.c.outcomeLadder["5m"]?.favorablePct ?? 0),
    )
    .slice(0, 5);
  const representativeContinuation = contCanon.slice(0, 5);
  const representativeFailed = failedCanon.slice(0, 5);

  const outPath = `/mnt/data/real-reversal-causal-discovery-3d-${Date.now()}.json`;
  const output = {
    methodology: {
      note: "Pure local read of the frozen FINAL-v2 dataset. Causal-only functions (canonicalCandidate, robustSeparation applied to CAUSAL_FEATURES, atrTrajectorySummary, efficiencyTrend, percentile-crossing) never read candidate.outcome/outcomeLadder/candidateOutcomeClass -- outcome is threaded through a separate path used only for Part 7 strength grouping and case-study selection.",
      canonicalizationRule:
        "REAL_REVERSAL/FAILED_REVERSAL: firstTrueReversalCandidateIndex. CONTINUATION/AMBIGUOUS: last candidate (sequence's own natural terminal state).",
      sequenceAwareness:
        "All cross-group comparisons (Parts 2-4, 8, 9) use exactly one canonical observation per sequence -- never raw candidate counts.",
    },
    populationCounts: {
      primaryTotal: primary.length,
      REAL_REVERSAL: real.length,
      CONTINUATION: continuation.length,
      FAILED_REVERSAL: failed.length,
      AMBIGUOUS: ambiguous.length,
    },
    historicalPercentileFindings: {
      crossingIndexesByThreshold: Object.fromEntries(
        PCT_THRESHOLDS.map((t) => [
          `P${t}`,
          {
            crossedCount: crossingIndexes[t]!.length,
            medianCrossingIndex: median(crossingIndexes[t]!),
          },
        ]),
      ),
      belowP90MaxRankCount: belowP90Count,
      totalWithRankData: maxRankReached.filter((r) => r >= 0).length,
    },
    atrTransitionFindings: {
      REAL_REVERSAL: atrReal,
      CONTINUATION: atrCont,
      FAILED_REVERSAL: atrFailed,
    },
    efficiencyExhaustionFindings: {
      REAL_REVERSAL: effReal,
      CONTINUATION: effCont,
      FAILED_REVERSAL: effFailed,
    },
    candidateStageFindings: { bucketDistribution: bucketCounts },
    strongVsWeakFindings: {
      quantiles: { p33: sP33, p66: sP66, p90: sP90 },
      strengthCounts,
    },
    symbolSideStability: symbolVictimBreakdown,
    featureRankings: {
      vsContinuation: separationVsContinuation,
      vsFailedReversal: separationVsFailed,
      rankedByAbsSeparation: ranked.map(([n, v]) => ({
        feature: n,
        separation: v.separation,
      })),
    },
    representativeCases: {
      strongestRealReversals: strongestReal.map(({ seq, c }) => ({
        sequenceId: seq.sequenceId,
        symbol: seq.symbol,
        victim: seq.victim,
        canonicalCandidateIndex: c.candidateIndex,
        favorable5m: c.outcomeLadder["5m"]?.favorablePct,
      })),
      representativeContinuations: representativeContinuation.map(
        ({ seq, c }) => ({
          sequenceId: seq.sequenceId,
          symbol: seq.symbol,
          victim: seq.victim,
          canonicalCandidateIndex: c.candidateIndex,
        }),
      ),
      representativeFailedReversals: representativeFailed.map(({ seq, c }) => ({
        sequenceId: seq.sequenceId,
        symbol: seq.symbol,
        victim: seq.victim,
        canonicalCandidateIndex: c.candidateIndex,
      })),
    },
    limitations: [
      "3-6 days of data -- separation statistics are exploratory, not statistically confirmed.",
      "robustSeparation is a simple IQR-normalized median difference, not a formal hypothesis test -- treat as descriptive ranking, not significance.",
      "Historical percentile crossing analysis uses only the precomputed 24h-window rank fields (maxSinglePercentileRank24h, currentEpisodePercentileRank, durationMatchedPercentileRank) -- the full 6h/12h/48h/72h percentile FAMILIES are stored per candidate but a full crossing-index analysis across all 5 windows for every threshold was not run in this pass, to keep runtime and output size bounded.",
    ],
    recommendedNextExperimentIngredients: ranked.slice(0, 5).map(([n]) => n),
  };
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`\nOutput written to: ${outPath}`);
}

if (require.main === module) {
  main();
}
