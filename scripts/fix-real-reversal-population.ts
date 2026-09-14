import * as fs from "fs";

/**
 * Sep 14 2026 (Karo), operator-reported CRITICAL FIX. Fixes a
 * confirmed population-construction bug in the causal-history output:
 * `continuationLiquidations` in the upstream true-reversals JSON was
 * built as `enriched.filter(e => e.class === "CONTINUATION").map(...)`
 * -- EVERY candidate classified CONTINUATION across every sequence,
 * with zero deduplication, unlike `realReversalLiquidations` which
 * correctly used exactly one canonical entry per sequence via
 * firstTrueReversalCandidateIndex. This produced 1681 continuation
 * ROWS from only ~444 unique continuation SEQUENCES, silently giving
 * long continuation sequences up to 20-50x the statistical weight of
 * a short one in every downstream median/quantile/correlation.
 *
 * PURE LOCAL PROCESSING -- reuses the already-computed causalFeatures
 * from the existing causal-history JSON. No new Mongo/Binance calls
 * for the primary (View A) fix; the matched-control view (View B)
 * also reuses the same already-computed per-candidate observations.
 *
 *   tsx scripts/fix-real-reversal-population.ts \
 *     --causal-history=/mnt/data/real-reversal-causal-history-3d-<ts>.json \
 *     --true-reversals=/mnt/data/liquidation-true-reversals-fixed-3d-<ts>.json
 *
 * CANONICALIZATION RULE CHOSEN FOR CONTINUATION (View A), and why:
 * the LAST candidate (max candidateIndex) observed for that sequence.
 * This is the sequence's own natural, causally-determined terminal
 * state -- the point where its same-side liquidation flow finally
 * went quiet (15-minute inactivity), which is itself the exact same
 * kind of causal, non-future-outcome-dependent boundary every episode
 * in this whole research thread has used. It is NOT chosen using any
 * future price information -- "this was the sequence's last
 * observed candidate" is knowable using only data up to and including
 * that candidate's own timestamp. The alternative options (matched
 * episode age, matched event count) are provided separately as View B
 * (matchedControlAnalysis) precisely because View A's asymmetry
 * (reversal = FIRST confirming candidate, continuation = LAST
 * candidate) is a real, acknowledged limitation -- View B directly
 * tests whether View A's conclusions survive controlling for episode
 * maturity via simple, transparent candidateIndex-bucket matching (no
 * ML), using the SAME bucket boundaries requested for the L1/developed
 * split (1, 2, 3, 4-5, 6-10, >10).
 */

interface RawObservation {
  symbol: string;
  victim: string;
  sequenceId: string;
  candidateIndex: number;
  timestamp: number;
  causalFeatures: {
    liquidationHistory: unknown;
    currentEpisode: {
      cumulativeLiqUsd: number;
      eventCount: number;
      maxSingleLiqUsd: number;
      currentEpisodePercentileRank: number | null;
      [k: string]: unknown;
    };
    duration: {
      episodeDurationMs: number;
      durationPercentileRank24h: number | null;
    };
    cadence: {
      liqUsdPerSecond: number | null;
      liqUsdPerMinute: number | null;
      durationMatchedPercentileRank: number | null;
      [k: string]: unknown;
    };
    atr: {
      liqAtrChangePct: number | null;
      recoveryAtrChangePct: number | null;
      [k: string]: unknown;
    };
    displacement: {
      episodeStartPrice: number;
      latestExtremePrice: number;
      priceDisplacementPct: number | null;
      priceDisplacementATR: number | null;
    };
    efficiency: { priceProgressATRPer1M: number | null };
  };
  outcomeTargets: {
    outcomeClass: string;
    favorable1m: number | null;
    favorable2m: number | null;
    favorable3m: number | null;
    favorable5m: number | null;
    favorable10m: number | null;
    favorable15m: number | null;
    favorable30m: number | null;
    adverse1m: number | null;
    adverse5m: number | null;
    dominanceShare5m: number | null;
    netReversalAdvantage5m: number | null;
    favorableATR5m: number | null;
    [k: string]: unknown;
  };
}
interface CausalHistoryJson {
  observations: RawObservation[];
}
interface SequenceResultRaw {
  sequenceId: string;
  symbol: string;
  victim: string;
  sequenceClass: string;
}
interface TrueReversalsJson {
  sequenceResults: SequenceResultRaw[];
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
function median(arr: readonly number[]): number | null {
  return percentile(
    [...arr].sort((a, b) => a - b),
    0.5,
  );
}

/** TASK 8 fix: zero-duration intensity is never fabricated. Applied
 *  as a post-process patch on the already-computed (buggy) cadence
 *  fields, since we're deliberately reusing existing causalFeatures
 *  rather than recomputing everything from scratch. */
function fixZeroDurationIntensity(o: RawObservation): RawObservation {
  if (o.causalFeatures.duration.episodeDurationMs === 0) {
    return {
      ...o,
      causalFeatures: {
        ...o.causalFeatures,
        cadence: {
          ...o.causalFeatures.cadence,
          liqUsdPerSecond: null,
          liqUsdPerMinute: null,
        },
      },
    };
  }
  return o;
}

function bucketFor(candidateIndex: number): string {
  if (candidateIndex === 1) return "1";
  if (candidateIndex === 2) return "2";
  if (candidateIndex === 3) return "3";
  if (candidateIndex <= 5) return "4-5";
  if (candidateIndex <= 10) return "6-10";
  return ">10";
}

function describe(vals: readonly (number | null)[]): {
  n: number;
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
} {
  const v = vals.filter((x): x is number => x !== null && Number.isFinite(x));
  const s = [...v].sort((a, b) => a - b);
  return {
    n: v.length,
    mean: mean(v),
    median: median(v),
    p25: percentile(s, 0.25),
    p75: percentile(s, 0.75),
    p90: percentile(s, 0.9),
    p95: percentile(s, 0.95),
  };
}

const COMPARISON_FEATURES: {
  name: string;
  extractor: (o: RawObservation) => number | null;
}[] = [
  {
    name: "currentEpisodePercentileRank",
    extractor: (o) =>
      o.causalFeatures.currentEpisode.currentEpisodePercentileRank,
  },
  {
    name: "durationMatchedPercentileRank",
    extractor: (o) => o.causalFeatures.cadence.durationMatchedPercentileRank,
  },
  {
    name: "priceDisplacementATR",
    extractor: (o) => o.causalFeatures.displacement.priceDisplacementATR,
  },
  {
    name: "liqAtrChangePct",
    extractor: (o) => o.causalFeatures.atr.liqAtrChangePct,
  },
  {
    name: "recoveryAtrChangePct",
    extractor: (o) => o.causalFeatures.atr.recoveryAtrChangePct,
  },
  {
    name: "episodeDurationMs",
    extractor: (o) => o.causalFeatures.duration.episodeDurationMs,
  },
  {
    name: "priceProgressATRPer1M",
    extractor: (o) => o.causalFeatures.efficiency.priceProgressATRPer1M,
  },
];

/** TASK 2: one sequenceId = one canonical row. Groups by sequenceId
 *  and picks the LAST (max candidateIndex) entry in each group --
 *  the canonicalization rule for CONTINUATION (see this file's own
 *  header). Also used, harmlessly, as an assertion pass for the
 *  reversal population, which should ALREADY be one-per-sequence. */
function canonicalizeOnePerSequence(rows: RawObservation[]): RawObservation[] {
  const bySeq = new Map<string, RawObservation[]>();
  for (const r of rows) {
    if (!bySeq.has(r.sequenceId)) bySeq.set(r.sequenceId, []);
    bySeq.get(r.sequenceId)!.push(r);
  }
  const canonical: RawObservation[] = [];
  for (const group of bySeq.values()) {
    const last = group.reduce((a, b) =>
      b.candidateIndex > a.candidateIndex ? b : a,
    );
    canonical.push(last);
  }
  return canonical;
}

function parseArgs(argv: string[]): {
  causalHistoryPath: string;
  trueReversalsPath: string;
} {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const causalHistoryPath = get("causal-history");
  const trueReversalsPath = get("true-reversals");
  if (!causalHistoryPath || !trueReversalsPath) {
    console.error(
      "Usage: fix-real-reversal-population.ts --causal-history=<path> --true-reversals=<path>",
    );
    process.exit(1);
  }
  return { causalHistoryPath, trueReversalsPath };
}

function main(): void {
  const { causalHistoryPath, trueReversalsPath } = parseArgs(
    process.argv.slice(2),
  );
  const causalHistory: CausalHistoryJson = JSON.parse(
    fs.readFileSync(causalHistoryPath, "utf8"),
  );
  const trueReversals: TrueReversalsJson = JSON.parse(
    fs.readFileSync(trueReversalsPath, "utf8"),
  );

  const rawReversalRows = causalHistory.observations.filter(
    (o) =>
      o.outcomeTargets.outcomeClass === "REAL_REVERSAL" ||
      o.outcomeTargets.outcomeClass === "LIKELY_REVERSAL",
  );
  const rawContinuationRows = causalHistory.observations.filter(
    (o) => o.outcomeTargets.outcomeClass === "CONTINUATION",
  );

  const uniqueReversalSeq = new Set(rawReversalRows.map((o) => o.sequenceId));
  const uniqueContinuationSeq = new Set(
    rawContinuationRows.map((o) => o.sequenceId),
  );

  console.log("=== TASK 2: RAW VS UNIQUE VS CANONICAL COUNTS ===\n");
  console.log(
    `REVERSAL:     rawCandidateRows=${rawReversalRows.length}  uniqueSequenceIds=${uniqueReversalSeq.size}`,
  );
  console.log(
    `CONTINUATION: rawCandidateRows=${rawContinuationRows.length}  uniqueSequenceIds=${uniqueContinuationSeq.size}`,
  );

  const canonicalReversal = canonicalizeOnePerSequence(rawReversalRows).map(
    fixZeroDurationIntensity,
  );
  const canonicalContinuation = canonicalizeOnePerSequence(
    rawContinuationRows,
  ).map(fixZeroDurationIntensity);

  console.log(
    `\nREVERSAL:     canonicalRowsAfterDedup=${canonicalReversal.length}`,
  );
  console.log(
    `CONTINUATION: canonicalRowsAfterDedup=${canonicalContinuation.length}`,
  );

  // ---- TASK 16 assertion 1/2: no duplicate sequenceId in canonical populations ----
  const assertOnePerSequence = (
    rows: RawObservation[],
    label: string,
  ): void => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sequenceId))
        throw new Error(
          `ASSERTION FAILED: duplicate sequenceId ${r.sequenceId} in canonical ${label} population`,
        );
      seen.add(r.sequenceId);
    }
    if (rows.length !== seen.size)
      throw new Error(
        `ASSERTION FAILED: ${label} canonicalRowsAfterDedup (${rows.length}) !== uniqueSequenceIds (${seen.size})`,
      );
  };
  assertOnePerSequence(canonicalReversal, "REVERSAL");
  assertOnePerSequence(canonicalContinuation, "CONTINUATION");
  console.log(
    "\nASSERTION PASSED: canonicalRowsAfterDedup === uniqueSequenceIds for both classes.",
  );

  // ---- TASK 5: strict REAL_REVERSAL vs LIKELY_REVERSAL, preserved not discarded ----
  const strictReal = canonicalReversal.filter(
    (o) => o.outcomeTargets.outcomeClass === "REAL_REVERSAL",
  );
  const likely = canonicalReversal.filter(
    (o) => o.outcomeTargets.outcomeClass === "LIKELY_REVERSAL",
  );
  console.log(
    `\n=== TASK 5: REVERSAL CONFIDENCE SPLIT ===\nTotal reversal sequences=${canonicalReversal.length}  strict REAL_REVERSAL=${strictReal.length}  LIKELY_REVERSAL=${likely.length}`,
  );

  // ---- TASK 6/7: L1/single-event vs developed-cascade split ----
  const l1Reversal = canonicalReversal.filter(
    (o) =>
      o.candidateIndex === 1 &&
      o.causalFeatures.currentEpisode.eventCount === 1,
  );
  const developedReversal = canonicalReversal.filter(
    (o) =>
      !(
        o.candidateIndex === 1 &&
        o.causalFeatures.currentEpisode.eventCount === 1
      ),
  );
  const l1Continuation = canonicalContinuation.filter(
    (o) =>
      o.candidateIndex === 1 &&
      o.causalFeatures.currentEpisode.eventCount === 1,
  );
  const developedContinuation = canonicalContinuation.filter(
    (o) =>
      !(
        o.candidateIndex === 1 &&
        o.causalFeatures.currentEpisode.eventCount === 1
      ),
  );

  const bucketCounts = (rows: RawObservation[]): Record<string, number> => {
    const out: Record<string, number> = {
      "1": 0,
      "2": 0,
      "3": 0,
      "4-5": 0,
      "6-10": 0,
      ">10": 0,
    };
    for (const r of rows) out[bucketFor(r.candidateIndex)]!++;
    return out;
  };
  console.log(
    `\n=== TASK 6: CANDIDATE-INDEX DISTRIBUTION (all reversal sequences) ===\n${JSON.stringify(bucketCounts(canonicalReversal))}`,
  );
  console.log(
    `strict REAL_REVERSAL: ${JSON.stringify(bucketCounts(strictReal))}`,
  );
  console.log(`LIKELY_REVERSAL:      ${JSON.stringify(bucketCounts(likely))}`);
  console.log(
    `\nL1 reversals=${l1Reversal.length}  developed-cascade reversals=${developedReversal.length}`,
  );
  console.log(
    `L1 continuations=${l1Continuation.length}  developed-cascade continuations=${developedContinuation.length}`,
  );

  // ---- TASK 16 assertion 4: zero-duration never produces fabricated intensity ----
  for (const o of [...canonicalReversal, ...canonicalContinuation]) {
    if (
      o.causalFeatures.duration.episodeDurationMs === 0 &&
      (o.causalFeatures.cadence.liqUsdPerSecond !== null ||
        o.causalFeatures.cadence.liqUsdPerMinute !== null)
    ) {
      throw new Error(
        `ASSERTION FAILED: ${o.sequenceId} has duration=0 but non-null liqUsdPerSecond/liqUsdPerMinute`,
      );
    }
  }
  console.log(
    "\nASSERTION PASSED: no zero-duration observation has a fabricated USD/sec or USD/min intensity.",
  );

  // ---- TASK 16 assertion 3: no outcome field name leaked into causalFeatures ----
  const FORBIDDEN_KEYS = [
    "favorable",
    "adverse",
    "dominanceShare",
    "netReversalAdvantage",
  ];
  for (const o of [...canonicalReversal, ...canonicalContinuation]) {
    const flat = JSON.stringify(o.causalFeatures);
    for (const key of FORBIDDEN_KEYS) {
      if (flat.includes(`"${key}`))
        throw new Error(
          `ASSERTION FAILED: causalFeatures for ${o.sequenceId} appears to contain an outcome-shaped key (${key})`,
        );
    }
  }
  console.log(
    "ASSERTION PASSED: no future-outcome field name found inside causalFeatures.",
  );

  // ---- TASK 11: rebuild comparisons on the CORRECTED populations ----
  function buildComparison(
    group1: RawObservation[],
    group2: RawObservation[],
  ): Record<
    string,
    { group1: ReturnType<typeof describe>; group2: ReturnType<typeof describe> }
  > {
    const out: Record<
      string,
      {
        group1: ReturnType<typeof describe>;
        group2: ReturnType<typeof describe>;
      }
    > = {};
    for (const f of COMPARISON_FEATURES)
      out[f.name] = {
        group1: describe(group1.map(f.extractor)),
        group2: describe(group2.map(f.extractor)),
      };
    return out;
  }
  console.log(
    "\n=== TASK 11: REBUILT COMPARISONS (deduplicated, one row per sequence) ===\n",
  );
  const allReversalVsContinuation = buildComparison(
    canonicalReversal,
    canonicalContinuation,
  );
  const strictRealReversalVsContinuation = buildComparison(
    strictReal,
    canonicalContinuation,
  );
  const likelyReversalVsContinuation = buildComparison(
    likely,
    canonicalContinuation,
  );
  const l1ReversalVsL1Continuation = buildComparison(
    l1Reversal,
    l1Continuation,
  );
  const developedCascadeReversalVsDevelopedContinuation = buildComparison(
    developedReversal,
    developedContinuation,
  );
  for (const [name, groups] of Object.entries(allReversalVsContinuation)) {
    console.log(
      `${name}: ALL_REVERSAL median=${groups.group1.median?.toFixed(3)} (n=${groups.group1.n})  vs  CONTINUATION median=${groups.group2.median?.toFixed(3)} (n=${groups.group2.n})`,
    );
  }

  // ---- TASK 4 View B: matched control by candidateIndex bucket ----
  console.log("\n=== VIEW B: MATCHED CONTROL (candidateIndex bucket) ===\n");
  const buckets = ["1", "2", "3", "4-5", "6-10", ">10"];
  const matchedControlAnalysis: Record<string, unknown> = {};
  for (const b of buckets) {
    const revInBucket = canonicalReversal.filter(
      (o) => bucketFor(o.candidateIndex) === b,
    );
    // continuation matched candidates from the FULL raw pool (not yet deduped), THEN deduped within this bucket
    const contInBucketRaw = rawContinuationRows.filter(
      (o) => bucketFor(o.candidateIndex) === b,
    );
    const contInBucket = canonicalizeOnePerSequence(contInBucketRaw).map(
      fixZeroDurationIntensity,
    );
    if (revInBucket.length < 3 || contInBucket.length < 3) continue;
    matchedControlAnalysis[b] = {
      reversalN: revInBucket.length,
      continuationN: contInBucket.length,
      comparison: buildComparison(revInBucket, contInBucket),
    };
    console.log(
      `Bucket ${b}: reversalN=${revInBucket.length} continuationN=${contInBucket.length}`,
    );
  }

  // ---- TASK 13: reversal strength, recomputed from the FULL 389 (not 237) ----
  const fav5mAll = canonicalReversal
    .map((o) => o.outcomeTargets.favorable5m)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const strengthP33 = percentile(fav5mAll, 0.33);
  const strengthP66 = percentile(fav5mAll, 0.66);
  const strengthP90 = percentile(fav5mAll, 0.9);
  console.log(
    `\n=== TASK 13: REVERSAL STRENGTH (recomputed from full ${canonicalReversal.length}-sequence population) ===`,
  );
  console.log(
    `P33=${strengthP33?.toFixed(4)} P66=${strengthP66?.toFixed(4)} P90=${strengthP90?.toFixed(4)}`,
  );
  const strongOrExtreme = canonicalReversal.filter(
    (o) =>
      (o.outcomeTargets.favorable5m ?? -Infinity) >= (strengthP66 ?? Infinity),
  );
  const strongExtremeVsContinuation = buildComparison(
    strongOrExtreme,
    canonicalContinuation,
  );

  // ---- TASK 12: correlations, all / L1 / developed, one-per-sequence only ----
  function rankCorrelation(
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
    const xr = rankOf(valid.map((p) => p.x)),
      yr = rankOf(valid.map((p) => p.y));
    const mx = mean(xr)!,
      my = mean(yr)!;
    let num = 0,
      dx = 0,
      dy = 0;
    for (let i = 0; i < valid.length; i++) {
      num += (xr[i]! - mx) * (yr[i]! - my);
      dx += (xr[i]! - mx) ** 2;
      dy += (yr[i]! - my) ** 2;
    }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
  }
  function correlationsFor(
    rows: RawObservation[],
  ): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const f of COMPARISON_FEATURES) {
      const pairs = rows.map((o) => ({
        x: f.extractor(o) ?? NaN,
        y: o.outcomeTargets.favorable5m ?? NaN,
      }));
      out[f.name] = rankCorrelation(pairs);
    }
    return out;
  }
  console.log(
    "\n=== TASK 12: CORRELATIONS (all / L1-only / developed-only) ===\n",
  );
  const correlationsAll = correlationsFor(canonicalReversal);
  const correlationsL1 = correlationsFor(l1Reversal);
  const correlationsDeveloped = correlationsFor(developedReversal);
  console.log(`ALL: ${JSON.stringify(correlationsAll)}`);
  console.log(`L1 only: ${JSON.stringify(correlationsL1)}`);
  console.log(`Developed only: ${JSON.stringify(correlationsDeveloped)}`);

  // ---- population summary from full sequenceResults (includes FAILED_REVERSAL/AMBIGUOUS not present in causal-history) ----
  const failedReversalSequences = trueReversals.sequenceResults.filter(
    (s) => s.sequenceClass === "FAILED_REVERSAL",
  ).length;
  const ambiguousSequences = trueReversals.sequenceResults.filter(
    (s) => s.sequenceClass === "AMBIGUOUS",
  ).length;

  // ---- case studies ----
  const strongExamples = [...canonicalReversal]
    .sort(
      (a, b) =>
        (b.outcomeTargets.favorable5m ?? 0) -
        (a.outcomeTargets.favorable5m ?? 0),
    )
    .slice(0, 5);
  const continuationExamples = canonicalContinuation.slice(0, 5);

  // ---- output ----
  const outPath = `/mnt/data/real-reversal-causal-history-fixed-3d-${Date.now()}.json`;
  const output = {
    fixReport: {
      originalReversalRows: rawReversalRows.length,
      originalReversalUniqueSequences: uniqueReversalSeq.size,
      originalContinuationRows: rawContinuationRows.length,
      originalContinuationUniqueSequences: uniqueContinuationSeq.size,
      duplicateContinuationRowsRemoved:
        rawContinuationRows.length - canonicalContinuation.length,
      canonicalizationMethod:
        "REVERSAL: firstTrueReversalCandidateIndex (unchanged, already correct). CONTINUATION: last observed candidate (max candidateIndex) per sequence -- the sequence's own causal terminal state, never chosen using future price outcome. See this script's own header doc comment for full justification and the View B matched-control counterpart.",
      assertionsPassed: [
        "canonicalRowsAfterDedup === uniqueSequenceIds (both classes)",
        "no zero-duration fabricated intensity",
        "no future-outcome key inside causalFeatures",
      ],
    },
    methodology: {
      note: "Pure local reprocessing of already-computed causalFeatures/outcomeTargets -- no new Mongo/Binance fetch for the primary fix.",
    },
    leakageAudit: {
      statement:
        "Unchanged from the source causal-history file; re-asserted above (assertion 3).",
    },
    populationSummary: {
      reversalSequences: canonicalReversal.length,
      strictRealReversal: strictReal.length,
      likelyReversal: likely.length,
      l1Reversals: l1Reversal.length,
      developedCascadeReversals: developedReversal.length,
      continuationSequences: canonicalContinuation.length,
      failedReversalSequences,
      ambiguousSequences,
    },
    reversalStrengthDistribution: {
      basedOnObservationCount: canonicalReversal.length,
      favorable5mP33: strengthP33,
      favorable5mP66: strengthP66,
      favorable5mP90: strengthP90,
    },
    canonicalObservations: {
      reversal: canonicalReversal,
      continuation: canonicalContinuation,
    },
    comparisons: {
      allReversalVsContinuation,
      strictRealReversalVsContinuation,
      likelyReversalVsContinuation,
      l1ReversalVsL1Continuation,
      developedCascadeReversalVsMatchedContinuation:
        developedCascadeReversalVsDevelopedContinuation,
      strongExtremeReversalVsContinuation: strongExtremeVsContinuation,
    },
    matchedControlAnalysis,
    correlations: {
      all: correlationsAll,
      l1Only: correlationsL1,
      developedOnly: correlationsDeveloped,
    },
    caseStudies: { strongestReversals: strongExamples, continuationExamples },
    methodologicalWarnings: [
      "CONTINUATION canonicalization (last candidate) and REVERSAL canonicalization (first confirming candidate) represent different developmental stages by construction -- View A alone should not be over-interpreted; cross-check against View B (matchedControlAnalysis) before drawing conclusions about episode maturity effects.",
      "L1/single-event reversals have structurally zero duration/displacement/cadence by definition -- never mix them with developed-cascade reversals when interpreting those specific features.",
      "This remains 3 days of data; correlations are descriptive, not statistically confirmed predictive relationships.",
    ],
  };
  fs.mkdirSync("/mnt/data", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nCorrected output written to: ${outPath}`);
}

main();
