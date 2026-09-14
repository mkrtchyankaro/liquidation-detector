import * as fs from "fs";

/**
 * Sep 14 2026 (Karo), operator-requested. PURE, LOCAL storage-format
 * transformation of an existing liquidation-master-6d-*.json --
 * reads it, does not refetch or recompute ANY research value, and
 * writes a compact equivalent. No Mongo, no Binance.
 *
 *   tsx scripts/compact-liquidation-master-6d.ts --input=/mnt/data/liquidation-master-6d-<ts>.json
 *
 * DECISIONS MADE, STATED EXPLICITLY (not silently):
 *
 * 1. outcome.path is dropped entirely, replaced with the summarized
 *    fields the operator listed. This is the dominant size driver
 *    (a 12-14-element array of objects per candidate, times 13,177
 *    candidates) -- the underlying 1m candles it was derived from
 *    already exist once in rawData.candles, so path is fully
 *    reconstructible from raw data + candidateEndTs if ever needed
 *    again, just not cheap to re-derive casually.
 *
 * 2/3. rawData.liquidations / rawData.candles were ALREADY stored
 *    exactly once globally in the source file (verified by reading
 *    the source master script's own output structure, not assumed)
 *    -- untouched here, no duplication existed to remove.
 *
 * 4. candidate.rawEventIndexes is DROPPED. Traced the source script:
 *    it is always exactly [0, 1, ..., candidateIndex-1] by
 *    construction (a candidate always contains its own sequence's
 *    first N events) -- fully redundant with candidateIndex, which
 *    is retained. Reconstruction rule: candidate N's raw events are
 *    the first N liquidation events (by timestamp) of that
 *    candidate's own sequenceId, filtered from rawData.liquidations
 *    by symbol+victim and ordered chronologically within
 *    [sequence.startTs, sequence.endTs].
 *
 * 5. Two causal fields dropped as trivially derivable from other
 *    already-stored fields, and ONLY these two (conservative, to
 *    avoid removing anything a future research phase might need):
 *      - liqUsdPerMinute = liqUsdPerSecond * 60
 *      - recoveryVsLiquidationAtrRatio = currentRecDirAtr / currentLiqDirAtr
 *    Both trivially reconstructible in one line from fields that remain.
 *
 * 7. Hashes are NOT recomputed -- copied byte-identical from the
 *    source file's own `hashes` object, since the underlying raw
 *    liquidations/candles/sequence-membership data is provably
 *    unchanged (this script never touches rawData or sequence
 *    start/end/event-count fields). Copying rather than recomputing
 *    eliminates any risk of an accidental divergent hash from a
 *    subtly different recomputation path.
 */

interface OutcomePath {
  minute: number;
  favorablePct: number;
  adversePct: number;
}
interface FullOutcome {
  dataQuality: string;
  path: OutcomePath[];
  timeToFirstFavorableMin: number | null;
  timeToFirstAdverseMin: number | null;
  timeToMaxFavorableMin: number | null;
  timeToMaxAdverseMin: number | null;
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  maxAdverseBeforeFavorableDominance: number | null;
  maxFavorableBeforeAdverseDominance: number | null;
  firstDirectionalMove: string;
  firstDominantMove: string;
  dominanceShare5m: number | null;
}
interface FullCausal {
  liqUsdPerSecond: number | null;
  liqUsdPerMinute: number | null;
  currentLiqDirAtr: number | null;
  currentRecDirAtr: number | null;
  recoveryVsLiquidationAtrRatio: number | null;
  currentPrice: number;
  [k: string]: unknown;
}
interface FullCandidate {
  candidateIndex: number;
  timestamp: number;
  rawEventIndexes: number[];
  causal: FullCausal;
  outcome: FullOutcome | null;
  candidateOutcomeClass: string;
}
interface FullSequence {
  sequenceId: string;
  symbol: string;
  victim: string;
  startTs: number;
  endTs: number;
  eventCount: number;
  cumulativeLiqUsd: number;
  maxSingleLiqUsd: number;
  durationMs: number;
  sequenceClass: string;
  firstTrueReversalCandidateIndex: number | null;
  candidates: FullCandidate[];
}
interface FullMaster {
  metadata: Record<string, unknown>;
  hashes: Record<string, string>;
  rawData: unknown;
  sequences: FullSequence[];
}

function compactOutcome(
  o: FullOutcome | null,
  currentLiqDirAtr: number | null,
  currentPrice: number,
): Record<string, unknown> | null {
  if (o === null) return null;
  const responseRatio =
    o.maxAdversePct !== null &&
    o.maxAdversePct > 0 &&
    o.maxFavorablePct !== null
      ? o.maxFavorablePct / o.maxAdversePct
      : o.maxFavorablePct !== null && o.maxFavorablePct === 0
        ? 1
        : null;
  return {
    dataQuality: o.dataQuality,
    maxFavorablePct: o.maxFavorablePct,
    maxAdversePct: o.maxAdversePct,
    favorableATR:
      currentLiqDirAtr && currentLiqDirAtr > 0 && o.maxFavorablePct !== null
        ? ((o.maxFavorablePct / 100) * currentPrice) / currentLiqDirAtr
        : null,
    adverseATR:
      currentLiqDirAtr && currentLiqDirAtr > 0 && o.maxAdversePct !== null
        ? ((o.maxAdversePct / 100) * currentPrice) / currentLiqDirAtr
        : null,
    responseRatio,
    dominanceShare5m: o.dominanceShare5m,
    firstDirectionalMove: o.firstDirectionalMove,
    firstDominantMove: o.firstDominantMove,
    timeToFirstFavorableMin: o.timeToFirstFavorableMin,
    timeToFirstAdverseMin: o.timeToFirstAdverseMin,
    timeToMaxFavorableMin: o.timeToMaxFavorableMin,
    timeToMaxAdverseMin: o.timeToMaxAdverseMin,
    maxAdverseBeforeFavorableDominance: o.maxAdverseBeforeFavorableDominance,
    maxFavorableBeforeAdverseDominance: o.maxFavorableBeforeAdverseDominance,
  };
}

function parseArgs(argv: string[]): { inputPath: string } {
  const hit = argv.find((a) => a.startsWith("--input="));
  if (!hit) {
    console.error(
      "Usage: compact-liquidation-master-6d.ts --input=/path/to/liquidation-master-6d-<ts>.json",
    );
    process.exit(1);
  }
  return { inputPath: hit.slice("--input=".length) };
}

function main(): void {
  const { inputPath } = parseArgs(process.argv.slice(2));
  console.log(`Reading source master dataset: ${inputPath}`);
  const statBefore = fs.statSync(inputPath);
  const oldSizeBytes = statBefore.size;
  const source: FullMaster = JSON.parse(fs.readFileSync(inputPath, "utf8"));

  let candidateCountBefore = 0,
    sequenceCountBefore = source.sequences.length;
  const classCountsBefore: Record<string, number> = {};
  for (const seq of source.sequences) {
    classCountsBefore[seq.sequenceClass] =
      (classCountsBefore[seq.sequenceClass] ?? 0) + 1;
    candidateCountBefore += seq.candidates.length;
  }

  const compactSequences = source.sequences.map((seq) => ({
    sequenceId: seq.sequenceId,
    symbol: seq.symbol,
    victim: seq.victim,
    startTs: seq.startTs,
    endTs: seq.endTs,
    eventCount: seq.eventCount,
    cumulativeLiqUsd: seq.cumulativeLiqUsd,
    maxSingleLiqUsd: seq.maxSingleLiqUsd,
    durationMs: seq.durationMs,
    sequenceClass: seq.sequenceClass,
    firstTrueReversalCandidateIndex: seq.firstTrueReversalCandidateIndex,
    candidates: seq.candidates.map((c) => {
      const { liqUsdPerMinute, recoveryVsLiquidationAtrRatio, ...restCausal } =
        c.causal;
      void liqUsdPerMinute;
      void recoveryVsLiquidationAtrRatio;
      const finalOutcome = compactOutcome(
        c.outcome,
        c.causal.currentLiqDirAtr,
        c.causal.currentPrice,
      );
      return {
        candidateIndex: c.candidateIndex,
        timestamp: c.timestamp,
        causal: restCausal,
        outcome: finalOutcome,
        candidateOutcomeClass: c.candidateOutcomeClass,
      };
    }),
  }));

  let candidateCountAfter = 0;
  const classCountsAfter: Record<string, number> = {};
  for (const seq of compactSequences) {
    classCountsAfter[seq.sequenceClass] =
      (classCountsAfter[seq.sequenceClass] ?? 0) + 1;
    candidateCountAfter += seq.candidates.length;
  }

  const countsUnchanged =
    candidateCountBefore === candidateCountAfter &&
    sequenceCountBefore === compactSequences.length &&
    JSON.stringify(classCountsBefore) === JSON.stringify(classCountsAfter);
  console.log(
    `\nCandidate count: before=${candidateCountBefore} after=${candidateCountAfter}`,
  );
  console.log(
    `Sequence count: before=${sequenceCountBefore} after=${compactSequences.length}`,
  );
  console.log(`Class counts unchanged: ${countsUnchanged ? "YES" : "NO"}`);
  if (!countsUnchanged) {
    console.error(
      "FATAL: counts diverged during transformation -- refusing to write output.",
    );
    console.error(`before=${JSON.stringify(classCountsBefore)}`);
    console.error(`after=${JSON.stringify(classCountsAfter)}`);
    process.exit(1);
  }

  // ---- re-run the structural validations that remain meaningful on the transformed shape ----
  const violations: string[] = [];
  for (const seq of compactSequences) {
    const indexes = seq.candidates.map((c) => c.candidateIndex);
    const expected = Array.from({ length: seq.eventCount }, (_, i) => i + 1);
    if (JSON.stringify(indexes) !== JSON.stringify(expected))
      violations.push(
        `${seq.sequenceId}: candidate indexes incomplete/out of order after compaction`,
      );
  }
  const FORBIDDEN_OUTCOME_KEYS = new Set(["path", "minute"]);
  for (const seq of compactSequences) {
    for (const c of seq.candidates) {
      for (const k of Object.keys(c.causal))
        if (FORBIDDEN_OUTCOME_KEYS.has(k))
          violations.push(
            `${seq.sequenceId} candidate ${c.candidateIndex}: causal block still contains outcome-shaped key ${k}`,
          );
    }
  }
  if (violations.length > 0) {
    console.error(
      `${violations.length} VALIDATION FAILURES -- NOT writing output:`,
    );
    violations.slice(0, 20).forEach((v) => console.error(`  ${v}`));
    process.exit(1);
  }
  console.log(
    "Validation PASS: candidate completeness intact, no outcome-shaped keys leaked into causal blocks.\n",
  );

  const output = {
    metadata: {
      ...source.metadata,
      storageFormatVersion: "compact-v1",
      compactedFrom: inputPath,
      compactedAt: new Date().toISOString(),
    },
    hashes: source.hashes, // copied byte-identical, not recomputed -- see header doc comment
    rawData: source.rawData, // unchanged, already stored once globally in the source
    sequences: compactSequences,
  };

  const outPath = `/mnt/data/liquidation-master-6d-compact-${Date.now()}.json`;
  const json = JSON.stringify(output); // compact, no indentation
  fs.writeFileSync(outPath, json);
  const newSizeBytes = fs.statSync(outPath).size;

  console.log(`Old file size: ${(oldSizeBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`New file size: ${(newSizeBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(
    `Reduction: ${(100 * (1 - newSizeBytes / oldSizeBytes)).toFixed(1)}%`,
  );
  console.log(`Output written to: ${outPath}`);
}

main();
