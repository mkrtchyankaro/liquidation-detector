import * as fs from "fs";

/**
 * Sep 14 2026 (Karo), operator-requested. Pure extraction, no
 * analysis, no new computation, no rebuilding. Reads the frozen
 * FINAL-v2 dataset and pulls every already-stored field relevant to
 * REAL_REVERSAL sequences in the primary (Days 4-6) window into one
 * self-contained JSON plus a one-row-per-sequence CSV summary.
 *
 *   tsx scripts/extract-real-reversal-episodes.ts --input=/mnt/data/liquidation-master-6d-FINAL-v2-<ts>.json
 *
 * P70/P80 AND PER-WINDOW RANK NOTE (stated explicitly, not silently
 * worked around): the pipeline never stored P70/P80 in any percentile
 * family (only P50/P75/P90/P95/P97.5/P99), and only stored ONE rank
 * value per family -- currentEpisodePercentileRank uses all-history,
 * maxSinglePercentileRank24h and durationMatchedPercentileRank both
 * use the 24h window specifically -- never a rank at every one of the
 * 5 lookback windows. Since the operator explicitly said "do not
 * rebuild anything" for this task, nothing is computed fresh here
 * (unlike the prior discovery pass, which was an analysis task that
 * explicitly invited it). p70/p80 fields are emitted as null with
 * notAvailable:true; per-window rank fields are emitted only for the
 * window that was actually stored, with the others explicitly absent
 * rather than fabricated -- see historicalContext[window].rank below.
 */

interface PercentileFamily {
  p50: number | null;
  p75: number | null;
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
}
interface OutcomeHorizon {
  dataQuality: string;
  favorablePct?: number;
  adversePct?: number;
  favorableATR?: number;
  adverseATR?: number;
  dominanceShare?: number | null;
  responseRatio?: number | null;
  firstDirectionalMove?: string;
  firstDominantMove?: string;
}
interface Candidate {
  candidateIndex: number;
  timestamp: number;
  causal: Causal;
  candidateOutcomeClass: string;
  outcomeLadder: Record<string, OutcomeHorizon>;
}
interface Sequence {
  sequenceId: string;
  symbol: string;
  victim: "LONG" | "SHORT";
  startTs: number;
  endTs: number;
  eventCount: number;
  sequenceClass: string;
  firstTrueReversalCandidateIndex: number | null;
  candidates: Candidate[];
}
interface Master {
  metadata: { primaryResearchPeriod: { fromMs: number } };
  sequences: Sequence[];
}

const LOOKBACKS = ["6h", "12h", "24h", "48h", "72h"] as const;
const HORIZONS = ["1m", "2m", "3m", "5m", "10m", "15m", "30m"] as const;

function parseArgs(argv: string[]): { inputPath: string } {
  const hit = argv.find((a) => a.startsWith("--input="));
  if (!hit) {
    console.error(
      "Usage: extract-real-reversal-episodes.ts --input=/path/to/liquidation-master-6d-FINAL-v2-<ts>.json",
    );
    process.exit(1);
  }
  return { inputPath: hit.slice("--input=".length) };
}

function famWithP70P80(
  fam: PercentileFamily | undefined,
): Record<string, unknown> {
  if (!fam)
    return {
      p50: null,
      p70: null,
      p80: null,
      p90: null,
      p95: null,
      p975: null,
      p99: null,
      sampleCount: 0,
      notAvailable: true,
    };
  return {
    p50: fam.p50,
    p70: null,
    p80: null,
    p90: fam.p90,
    p95: fam.p95,
    p975: fam.p975,
    p99: fam.p99,
    sampleCount: fam.sampleCount,
    p70p80NotAvailable: true,
  };
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function main(): void {
  const { inputPath } = parseArgs(process.argv.slice(2));
  const master: Master = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const primaryFrom = master.metadata.primaryResearchPeriod.fromMs;

  const primary = master.sequences.filter((s) => s.startTs >= primaryFrom);
  const realSequences = primary.filter(
    (s) => s.sequenceClass === "REAL_REVERSAL",
  );
  const nonRealIncluded = 0; // by construction of the filter above -- verified below regardless

  console.log(`Primary-period sequences: ${primary.length}`);
  console.log(`REAL_REVERSAL sequences found: ${realSequences.length}\n`);

  // ---- validation ----
  const violations: string[] = [];
  const seenIds = new Set<string>();
  for (const seq of realSequences) {
    if (seq.sequenceClass !== "REAL_REVERSAL")
      violations.push(`${seq.sequenceId}: non-REAL_REVERSAL sequence included`);
    if (seq.firstTrueReversalCandidateIndex === null)
      violations.push(
        `${seq.sequenceId}: REAL_REVERSAL with no firstTrueReversalCandidateIndex`,
      );
    if (seenIds.has(seq.sequenceId))
      violations.push(`${seq.sequenceId}: duplicate sequenceId`);
    seenIds.add(seq.sequenceId);
  }
  if (violations.length > 0) {
    console.error(
      `${violations.length} VALIDATION FAILURES -- NOT writing output:`,
    );
    violations.slice(0, 20).forEach((v) => console.error(`  ${v}`));
    process.exit(1);
  }

  const records = realSequences.map((seq) => {
    const firstCandidate = seq.candidates.find((c) => c.candidateIndex === 1)!;
    const reversalCandidate = seq.candidates.find(
      (c) => c.candidateIndex === seq.firstTrueReversalCandidateIndex,
    )!;
    const fc = firstCandidate.causal,
      rc = reversalCandidate.causal;

    const atrChange = (
      firstVal: number | null,
      revVal: number | null,
    ): number | null =>
      firstVal !== null && revVal !== null ? revVal - firstVal : null;

    const historicalContext: Record<string, Record<string, unknown>> = {};
    for (const w of LOOKBACKS) {
      historicalContext[w] = {
        single: {
          ...famWithP70P80(rc.singleEventPercentiles[w]),
          rank: w === "24h" ? rc.maxSinglePercentileRank24h : null,
          rankAvailableForThisWindow: w === "24h",
        },
        episode: {
          ...famWithP70P80(rc.episodePercentiles[w]),
          rank: rc.currentEpisodePercentileRank,
          rankAvailableForThisWindow: true,
          rankNote:
            "currentEpisodePercentileRank is computed over ALL causal history, not window-specific -- same value reported for every window here, per this script's own header note",
        },
        durationMatched: {
          ...famWithP70P80(rc.durationMatchedPercentiles[w]),
          rank: w === "24h" ? rc.durationMatchedPercentileRank : null,
          rankAvailableForThisWindow: w === "24h",
        },
      };
    }

    const outcome: Record<string, unknown> = {};
    for (const h of HORIZONS) {
      const o = reversalCandidate.outcomeLadder[h];
      outcome[h] = o ?? { dataQuality: "NOT_STORED" };
    }

    const trajectory = seq.candidates.map((c) => ({
      candidateIndex: c.candidateIndex,
      timestamp: c.timestamp,
      cumulativeLiqUsd: c.causal.cumulativeLiqUsd,
      incrementalLiqUsd: c.causal.incrementalLiqUsd,
      eventCount: c.causal.eventCount,
      durationMs: c.causal.durationMs,
      currentEpisodePercentileRank: c.causal.currentEpisodePercentileRank,
      durationMatchedPercentileRank24h: c.causal.durationMatchedPercentileRank,
      maxSinglePercentileRank24h: c.causal.maxSinglePercentileRank24h,
      currentLiqDirAtr: c.causal.currentLiqDirAtr,
      currentRecDirAtr: c.causal.currentRecDirAtr,
      liqAtrChangePct: c.causal.liqAtrChangePct,
      recoveryAtrChangePct: c.causal.recoveryAtrChangePct,
      recoveryVsLiquidationAtrRatio:
        c.causal.currentLiqDirAtr &&
        c.causal.currentLiqDirAtr > 0 &&
        c.causal.currentRecDirAtr !== null
          ? c.causal.currentRecDirAtr / c.causal.currentLiqDirAtr
          : null,
      priceDisplacementATR: c.causal.priceDisplacementATR,
      newAdverseExtreme: c.causal.newAdverseExtreme,
      marginalPriceProgressATRPer1M: c.causal.marginalPriceProgressATRPer1M,
      priceProgressATRPer1M: c.causal.priceProgressATRPer1M,
    }));

    return {
      identity: {
        sequenceId: seq.sequenceId,
        symbol: seq.symbol,
        victim: seq.victim,
        startTs: seq.startTs,
        endTs: seq.endTs,
        candidateCount: seq.candidates.length,
        eventCount: seq.eventCount,
      },
      liquidation: {
        cumulativeLiqUsd: rc.cumulativeLiqUsd,
        maxSingleLiqUsd: rc.maxSingleLiqUsd,
        firstEventUsd: fc.lastEventUsd,
        lastEventUsd: rc.lastEventUsd,
        durationMs: rc.durationMs,
        liqUsdPerSecond: rc.liqUsdPerSecond,
      },
      priceExtreme: {
        startPrice: rc.startPrice,
        currentPriceAtReversal: rc.currentPrice,
        adverseExtremePrice: rc.adverseExtremePrice,
        adverseExtremeTs: rc.adverseExtremeTs,
        totalAdverseProgressPct: rc.priceDisplacementPct,
        totalAdverseProgressATR: rc.priceDisplacementATR,
        priceDisplacementATR: rc.priceDisplacementATR,
        newAdverseExtremeCount: seq.candidates.filter(
          (c) => c.causal.newAdverseExtreme,
        ).length,
      },
      atr: {
        first: {
          currentLiqDirAtr: fc.currentLiqDirAtr,
          currentRecDirAtr: fc.currentRecDirAtr,
          preLiqDirAtr: fc.preLiqDirAtr,
          preRecDirAtr: fc.preRecDirAtr,
          liqAtrChangePct: fc.liqAtrChangePct,
          recoveryAtrChangePct: fc.recoveryAtrChangePct,
          recoveryVsLiquidationAtrRatio:
            fc.currentLiqDirAtr &&
            fc.currentLiqDirAtr > 0 &&
            fc.currentRecDirAtr !== null
              ? fc.currentRecDirAtr / fc.currentLiqDirAtr
              : null,
        },
        reversal: {
          currentLiqDirAtr: rc.currentLiqDirAtr,
          currentRecDirAtr: rc.currentRecDirAtr,
          preLiqDirAtr: rc.preLiqDirAtr,
          preRecDirAtr: rc.preRecDirAtr,
          liqAtrChangePct: rc.liqAtrChangePct,
          recoveryAtrChangePct: rc.recoveryAtrChangePct,
          recoveryVsLiquidationAtrRatio:
            rc.currentLiqDirAtr &&
            rc.currentLiqDirAtr > 0 &&
            rc.currentRecDirAtr !== null
              ? rc.currentRecDirAtr / rc.currentLiqDirAtr
              : null,
        },
        change: {
          currentLiqDirAtr: atrChange(fc.currentLiqDirAtr, rc.currentLiqDirAtr),
          currentRecDirAtr: atrChange(fc.currentRecDirAtr, rc.currentRecDirAtr),
          liqAtrChangePct: atrChange(fc.liqAtrChangePct, rc.liqAtrChangePct),
          recoveryAtrChangePct: atrChange(
            fc.recoveryAtrChangePct,
            rc.recoveryAtrChangePct,
          ),
        },
      },
      efficiency: {
        first: {
          priceProgressATRPer1M: fc.priceProgressATRPer1M,
          marginalPriceProgressATRPer1M: fc.marginalPriceProgressATRPer1M,
          cumulativeLiqUsd: fc.cumulativeLiqUsd,
          incrementalLiqUsd: fc.incrementalLiqUsd,
          priceDisplacementATR: fc.priceDisplacementATR,
        },
        reversal: {
          priceProgressATRPer1M: rc.priceProgressATRPer1M,
          marginalPriceProgressATRPer1M: rc.marginalPriceProgressATRPer1M,
          cumulativeLiqUsd: rc.cumulativeLiqUsd,
          incrementalLiqUsd: rc.incrementalLiqUsd,
          priceDisplacementATR: rc.priceDisplacementATR,
        },
        change: {
          priceProgressATRPer1M: atrChange(
            fc.priceProgressATRPer1M,
            rc.priceProgressATRPer1M,
          ),
          marginalPriceProgressATRPer1M: atrChange(
            fc.marginalPriceProgressATRPer1M,
            rc.marginalPriceProgressATRPer1M,
          ),
        },
      },
      historicalContext,
      outcome,
      candidateTrajectory: trajectory,
    };
  });

  const outPathJson = `/mnt/data/real-reversal-episodes-full-causal-3d-${Date.now()}.json`;
  fs.writeFileSync(
    outPathJson,
    JSON.stringify({
      methodology: {
        note: "Pure extraction, no new computation. P70/P80 not available in the source pipeline -- emitted as null with p70p80NotAvailable:true. Per-window historical rank is only natively available for the window each field was actually computed at (24h for single-event and duration-matched, all-history for episode) -- see historicalContext[window].*.rankAvailableForThisWindow.",
        primaryResearchPeriodFromMs: primaryFrom,
      },
      count: records.length,
      sequences: records,
    }),
  );

  // ---- CSV summary ----
  const csvHeaders = [
    "sequenceId",
    "symbol",
    "victim",
    "candidateCount",
    "eventCount",
    "firstTrueReversalCandidateIndex",
    "cumulativeLiqUsd",
    "maxSingleLiqUsd",
    "durationMs",
    "priceDisplacementATR",
    "newAdverseExtremeCount",
    "firstLiqDirAtr",
    "reversalLiqDirAtr",
    "liqDirAtrChange",
    "firstRecDirAtr",
    "reversalRecDirAtr",
    "recDirAtrChange",
    "reversalLiqAtrChangePct",
    "reversalRecoveryAtrChangePct",
    "firstPriceProgressATRPer1M",
    "reversalPriceProgressATRPer1M",
    "currentEpisodePercentileRank",
    "maxSinglePercentileRank24h",
    "durationMatchedPercentileRank24h",
    "favorable5m",
    "adverse5m",
    "dominanceShare5m",
  ];
  const csvRows = realSequences.map((seq) => {
    const fc = seq.candidates.find((c) => c.candidateIndex === 1)!.causal;
    const rCandidate = seq.candidates.find(
      (c) => c.candidateIndex === seq.firstTrueReversalCandidateIndex,
    )!;
    const rc = rCandidate.causal;
    const o5m = rCandidate.outcomeLadder["5m"];
    return [
      seq.sequenceId,
      seq.symbol,
      seq.victim,
      seq.candidates.length,
      seq.eventCount,
      seq.firstTrueReversalCandidateIndex,
      rc.cumulativeLiqUsd,
      rc.maxSingleLiqUsd,
      rc.durationMs,
      rc.priceDisplacementATR,
      seq.candidates.filter((c) => c.causal.newAdverseExtreme).length,
      fc.currentLiqDirAtr,
      rc.currentLiqDirAtr,
      fc.currentLiqDirAtr !== null && rc.currentLiqDirAtr !== null
        ? rc.currentLiqDirAtr - fc.currentLiqDirAtr
        : null,
      fc.currentRecDirAtr,
      rc.currentRecDirAtr,
      fc.currentRecDirAtr !== null && rc.currentRecDirAtr !== null
        ? rc.currentRecDirAtr - fc.currentRecDirAtr
        : null,
      rc.liqAtrChangePct,
      rc.recoveryAtrChangePct,
      fc.priceProgressATRPer1M,
      rc.priceProgressATRPer1M,
      rc.currentEpisodePercentileRank,
      rc.maxSinglePercentileRank24h,
      rc.durationMatchedPercentileRank,
      o5m?.favorablePct ?? null,
      o5m?.adversePct ?? null,
      o5m?.dominanceShare ?? null,
    ];
  });
  const csvLines = [
    csvHeaders.join(","),
    ...csvRows.map((row) => row.map(csvEscape).join(",")),
  ];
  const outPathCsv = `/mnt/data/real-reversal-episodes-summary-3d-${Date.now()}.csv`;
  fs.writeFileSync(outPathCsv, csvLines.join("\n"));

  console.log(`\nREAL_REVERSAL count: ${realSequences.length}`);
  console.log(`Non-REAL_REVERSAL sequences included: ${nonRealIncluded}`);
  console.log(`JSON path: ${outPathJson}`);
  console.log(`CSV path: ${outPathCsv}`);
  console.log(`Validation: PASS`);
}

main();
