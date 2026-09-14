import * as fs from "fs";
import type { Side, Liquidation, Candle } from "../src/shared/common.types";
import { sha256, segmentSequences } from "./build-liquidation-master-6d";
import {
  reconstructTruePath,
  type HistoricalCandle,
} from "./reconstruct-true-liquidation-reversal-path-fixed";

/**
 * Sep 14 2026 (Karo), operator-requested. FINAL dataset integrity
 * pass on the already-frozen compact master JSON. Pure local
 * processing -- rawData.liquidations and rawData.candles are already
 * fully present in the input file; nothing is refetched, recomputed
 * causally, or reclassified. No Mongo, no Binance.
 *
 *   tsx scripts/finalize-liquidation-master-6d.ts --input=/mnt/data/liquidation-master-6d-compact-<ts>.json
 *
 * SEQUENCE MEMBERSHIP RECOVERY METHOD (why this is safe, unlike the
 * earlier ladder-backfill bug): that earlier bug came from RE-FETCHING
 * raw liquidations with a different (unbounded) time window than the
 * original segmentation used, so positional IDs stopped lining up.
 * Here there is no re-fetch at all -- segmentSequences() is re-run
 * against the EXACT SAME rawData.liquidations[symbol] array already
 * frozen inside this file (verified immutable via the unchanged
 * rawLiquidations hash, checked below BEFORE anything else runs).
 * Identical input, identical deterministic algorithm, therefore
 * identical sequenceIds and identical membership by construction --
 * still explicitly verified against every stored sequence's own
 * aggregate fields (startTs/endTs/eventCount/cumulativeLiqUsd/
 * maxSingleLiqUsd/victim) before being trusted, per the operator's
 * own "1,864/1,864 or STOP" requirement.
 *
 * PER-HORIZON OUTCOME LADDER: reconstructTruePath() already computes
 * a per-minute path (favorable/adverse running-max) covering exactly
 * the 7 requested horizons (1,2,3,5,10,15,30 all included in its own
 * PATH_MINUTES). No new path-walking logic is written here -- horizon
 * summaries are derived by reading that existing output at each
 * requested minute, never by re-deriving the walk itself.
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const HORIZONS = [1, 2, 3, 5, 10, 15, 30] as const;
const FLOAT_TOL = 0.01;

interface CompactCandidate {
  candidateIndex: number;
  timestamp: number;
  causal: Record<string, unknown>;
  outcome: { dominanceShare5m: number | null; dataQuality: string } | null;
  candidateOutcomeClass: string;
}
interface CompactSequence {
  sequenceId: string;
  symbol: string;
  victim: Side;
  startTs: number;
  endTs: number;
  eventCount: number;
  cumulativeLiqUsd: number;
  maxSingleLiqUsd: number;
  durationMs: number;
  sequenceClass: string;
  firstTrueReversalCandidateIndex: number | null;
  candidates: CompactCandidate[];
}
interface CompactMaster {
  metadata: {
    datasetVersion: string;
    window: { fromMs: number; toMs: number };
    primaryResearchPeriod: { fromMs: number; toMs: number };
    [k: string]: unknown;
  };
  hashes: { rawLiquidations: string; rawCandles: string; [k: string]: string };
  rawData: {
    liquidations: Record<string, Liquidation[]>;
    candles: Record<string, Candle[]>;
  };
  sequences: CompactSequence[];
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= FLOAT_TOL * Math.max(1, Math.abs(b));
}

function parseArgs(argv: string[]): { inputPath: string } {
  const hit = argv.find((a) => a.startsWith("--input="));
  if (!hit) {
    console.error(
      "Usage: finalize-liquidation-master-6d.ts --input=/path/to/liquidation-master-6d-compact-<ts>.json",
    );
    process.exit(1);
  }
  return { inputPath: hit.slice("--input=".length) };
}

function main(): void {
  const { inputPath } = parseArgs(process.argv.slice(2));
  console.log(`Reading compact master dataset: ${inputPath}`);
  const source: CompactMaster = JSON.parse(fs.readFileSync(inputPath, "utf8"));

  const rawLiquidationsForHash = SYMBOLS.map((s) => ({
    symbol: s,
    events: [...(source.rawData.liquidations[s] ?? [])].sort(
      (a, b) => a.timestamp - b.timestamp,
    ),
  }));
  const rawCandlesForHash = SYMBOLS.map((s) => ({
    symbol: s,
    candles: [...(source.rawData.candles[s] ?? [])].sort(
      (a, b) => a.openTime - b.openTime,
    ),
  }));
  const recomputedLiqHash = sha256(rawLiquidationsForHash);
  const recomputedCandleHash = sha256(rawCandlesForHash);
  const liqHashUnchanged = recomputedLiqHash === source.hashes.rawLiquidations;
  const candleHashUnchanged = recomputedCandleHash === source.hashes.rawCandles;
  console.log(
    `\nrawLiquidations hash unchanged: ${liqHashUnchanged ? "YES" : "NO"}`,
  );
  console.log(
    `rawCandles hash unchanged: ${candleHashUnchanged ? "YES" : "NO"}`,
  );
  if (!liqHashUnchanged || !candleHashUnchanged) {
    console.error(
      "FATAL: raw data hash mismatch -- refusing to proceed. The frozen raw data may have been altered.",
    );
    process.exit(1);
  }

  console.log("\n=== SEQUENCE MEMBERSHIP RECOVERY ===\n");
  const membershipMismatches: string[] = [];
  const sequenceIndexes = new Map<string, number[]>();

  for (const symbol of SYMBOLS) {
    const rawEvents = source.rawData.liquidations[symbol] ?? [];
    for (let i = 1; i < rawEvents.length; i++) {
      if (rawEvents[i]!.timestamp < rawEvents[i - 1]!.timestamp)
        membershipMismatches.push(
          `${symbol}: rawData.liquidations not chronologically sorted at index ${i}`,
        );
    }
    const regenerated = segmentSequences(symbol, rawEvents);
    let cursor = 0;
    for (const seq of regenerated) {
      const indexes: number[] = [];
      for (const ev of seq.events) {
        if (
          cursor >= rawEvents.length ||
          rawEvents[cursor]!.timestamp !== ev.timestamp ||
          rawEvents[cursor]!.quoteQty !== ev.quoteQty
        ) {
          membershipMismatches.push(
            `${seq.sequenceId}: position-alignment failed at cursor ${cursor}`,
          );
          break;
        }
        indexes.push(cursor);
        cursor++;
      }
      sequenceIndexes.set(seq.sequenceId, indexes);
    }
  }

  let exactMemberships = 0;
  for (const seq of source.sequences) {
    const indexes = sequenceIndexes.get(seq.sequenceId);
    if (!indexes) {
      membershipMismatches.push(
        `${seq.sequenceId}: no regenerated sequence found`,
      );
      continue;
    }
    const rawEvents = source.rawData.liquidations[seq.symbol] ?? [];
    const resolved = indexes.map((i) => rawEvents[i]!);
    const checks: boolean[] = [
      indexes.length === seq.eventCount,
      resolved.length > 0 && resolved[0]!.timestamp === seq.startTs,
      resolved.length > 0 &&
        resolved[resolved.length - 1]!.timestamp === seq.endTs,
      resolved.every(
        (e) => (e.side === "SELL" ? "LONG" : "SHORT") === seq.victim,
      ),
      closeEnough(
        resolved.reduce((s, e) => s + e.quoteQty, 0),
        seq.cumulativeLiqUsd,
      ),
      closeEnough(
        Math.max(...resolved.map((e) => e.quoteQty)),
        seq.maxSingleLiqUsd,
      ),
    ];
    if (checks.every(Boolean)) exactMemberships++;
    else
      membershipMismatches.push(
        `${seq.sequenceId}: aggregate cross-check failed (${checks
          .map((c, i) => (c ? "" : `check${i}`))
          .filter(Boolean)
          .join(",")})`,
      );
  }
  console.log(
    `Exact sequence memberships: ${exactMemberships} / ${source.sequences.length}`,
  );
  if (exactMemberships !== source.sequences.length) {
    console.error(
      `${membershipMismatches.length} membership mismatches -- STOPPING, not writing output:`,
    );
    membershipMismatches.slice(0, 30).forEach((m) => console.error(`  ${m}`));
    process.exit(1);
  }

  console.log("\n=== OUTCOME LADDER RECONSTRUCTION ===\n");
  const historicalCandlesBySymbol = new Map<string, HistoricalCandle[]>();
  for (const symbol of SYMBOLS) {
    const candles = (source.rawData.candles[symbol] ?? []).map((c) => ({
      symbol,
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      isClosed: true as const,
    }));
    historicalCandlesBySymbol.set(symbol, candles);
  }

  let dom5MatchCount = 0,
    dom5CompareCount = 0;
  let primaryCandidatesEligible30m = 0,
    primaryCandidatesTotal = 0;
  const finalSequences = source.sequences.map((seq) => {
    const candles = historicalCandlesBySymbol.get(seq.symbol) ?? [];
    const isPrimary =
      seq.startTs >= source.metadata.primaryResearchPeriod.fromMs;

    const finalCandidates = seq.candidates.map((c) => {
      const refPrice = (c.causal as { currentPrice: number }).currentPrice;
      const currentLiqDirAtr = (c.causal as { currentLiqDirAtr: number | null })
        .currentLiqDirAtr;
      const latestExtremePrice = (c.causal as { adverseExtremePrice: number })
        .adverseExtremePrice;
      const truePath = reconstructTruePath(
        candles,
        c.timestamp,
        refPrice,
        seq.victim,
        latestExtremePrice,
      );

      const outcomeLadder: Record<string, unknown> = {};
      for (const h of HORIZONS) {
        if (
          truePath.dataQuality === "NO_DATA" ||
          truePath.candlesConsumed < h
        ) {
          outcomeLadder[`${h}m`] = {
            dataQuality:
              truePath.candlesConsumed === 0 ? "NO_DATA" : "INCOMPLETE",
            availableClosedCandles: truePath.candlesConsumed,
          };
          continue;
        }
        const p = truePath.path.find((pt) => pt.minute === h)!;
        const dom =
          p.favorablePct + p.adversePct === 0
            ? null
            : p.favorablePct / (p.favorablePct + p.adversePct);
        const responseRatio =
          p.adversePct > 0
            ? p.favorablePct / p.adversePct
            : p.favorablePct === 0
              ? 1
              : null;
        const favorableATR =
          currentLiqDirAtr && currentLiqDirAtr > 0
            ? ((p.favorablePct / 100) * refPrice) / currentLiqDirAtr
            : null;
        const adverseATR =
          currentLiqDirAtr && currentLiqDirAtr > 0
            ? ((p.adversePct / 100) * refPrice) / currentLiqDirAtr
            : null;
        const firstMoveMin =
          [truePath.timeToFirstFavorableMin, truePath.timeToFirstAdverseMin]
            .filter((m): m is number => m !== null)
            .sort((a, b) => a - b)[0] ?? null;
        const withinHorizon = firstMoveMin !== null && firstMoveMin <= h;
        outcomeLadder[`${h}m`] = {
          dataQuality:
            p.favorablePct === 0 && p.adversePct === 0 ? "NO_MOVE" : "VALID",
          favorablePct: p.favorablePct,
          adversePct: p.adversePct,
          favorableATR,
          adverseATR,
          dominanceShare: dom,
          responseRatio,
          firstDirectionalMove: withinHorizon
            ? truePath.firstDirectionalMove
            : "FLAT",
          firstDominantMove: withinHorizon
            ? truePath.firstDominantMove
            : "NONE",
          availableClosedCandles: truePath.candlesConsumed,
        };
      }

      const outcomeCompleteThroughMinutes = Math.min(
        truePath.candlesConsumed,
        30,
      );
      const evaluationEligible30m = truePath.candlesConsumed >= 30;

      if (c.outcome !== null && c.outcome.dominanceShare5m !== null) {
        const recon5m = outcomeLadder["5m"] as {
          dominanceShare?: number | null;
        };
        dom5CompareCount++;
        if (
          recon5m.dominanceShare !== undefined &&
          recon5m.dominanceShare !== null &&
          closeEnough(recon5m.dominanceShare, c.outcome.dominanceShare5m)
        )
          dom5MatchCount++;
      }

      if (isPrimary) {
        primaryCandidatesTotal++;
        if (evaluationEligible30m) primaryCandidatesEligible30m++;
      }

      return {
        candidateIndex: c.candidateIndex,
        timestamp: c.timestamp,
        causal: c.causal,
        candidateOutcomeClass: c.candidateOutcomeClass,
        outcomeLadder,
        outcomeCompleteThroughMinutes,
        evaluationEligible30m,
      };
    });

    const canonicalCandidate =
      seq.firstTrueReversalCandidateIndex !== null
        ? finalCandidates.find(
            (c) => c.candidateIndex === seq.firstTrueReversalCandidateIndex,
          )
        : finalCandidates[finalCandidates.length - 1];
    const sequenceEvaluationEligible30m =
      canonicalCandidate?.evaluationEligible30m ?? false;

    return {
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
      rawEventIndexes: sequenceIndexes.get(seq.sequenceId)!,
      evaluationEligible30m: sequenceEvaluationEligible30m,
      candidates: finalCandidates,
    };
  });

  console.log(
    `5m dominanceShare cross-check: ${dom5MatchCount} / ${dom5CompareCount} match`,
  );
  if (dom5CompareCount > 0 && dom5MatchCount !== dom5CompareCount) {
    console.error(
      `STOPPING: ${dom5CompareCount - dom5MatchCount} existing 5m outcome values did not reproduce -- refusing to silently overwrite.`,
    );
    process.exit(1);
  }

  const primarySequences = finalSequences.filter(
    (s) => s.startTs >= source.metadata.primaryResearchPeriod.fromMs,
  );
  const primarySequenceClassCounts: Record<string, number> = {};
  for (const s of primarySequences)
    primarySequenceClassCounts[s.sequenceClass] =
      (primarySequenceClassCounts[s.sequenceClass] ?? 0) + 1;
  const primaryCandidatesIncomplete30m =
    primaryCandidatesTotal - primaryCandidatesEligible30m;

  const membershipForHash = [...finalSequences]
    .sort((a, b) => a.sequenceId.localeCompare(b.sequenceId))
    .map((s) => ({
      sequenceId: s.sequenceId,
      rawEventIndexes: s.rawEventIndexes,
    }));
  const finalSequenceMembershipHash = sha256(membershipForHash);

  console.log("\n=== FINAL VALIDATION ===\n");
  const totalCandidates = finalSequences.reduce(
    (sum, s) => sum + s.candidates.length,
    0,
  );
  const violations: string[] = [];
  for (const s of finalSequences) {
    const indexes = s.candidates.map((c) => c.candidateIndex);
    const expected = Array.from({ length: s.eventCount }, (_, i) => i + 1);
    if (JSON.stringify(indexes) !== JSON.stringify(expected))
      violations.push(`${s.sequenceId}: candidate ladder incomplete`);
    const final = s.candidates[s.candidates.length - 1];
    if (final && final.candidateIndex !== s.eventCount)
      violations.push(
        `${s.sequenceId}: final candidate does not equal full sequence event count`,
      );
    for (const idx of s.rawEventIndexes)
      if (
        idx < 0 ||
        idx >= (source.rawData.liquidations[s.symbol] ?? []).length
      )
        violations.push(
          `${s.sequenceId}: rawEventIndexes reference out of range`,
        );
    for (const c of s.candidates) {
      if (c.evaluationEligible30m && c.outcomeCompleteThroughMinutes < 30)
        violations.push(
          `${s.sequenceId} candidate ${c.candidateIndex}: marked evaluationEligible30m but outcomeCompleteThroughMinutes < 30`,
        );
    }
  }
  if (violations.length > 0) {
    console.error(
      `${violations.length} FINAL VALIDATION FAILURES -- NOT writing output:`,
    );
    violations.slice(0, 30).forEach((v) => console.error(`  ${v}`));
    process.exit(1);
  }
  console.log("All final validation checks passed.\n");

  const outPath = `/mnt/data/liquidation-master-6d-FINAL-v2-${Date.now()}.json`;
  const output = {
    metadata: {
      ...source.metadata,
      datasetVersion: "liquidation-master-6d-final-v2",
      storageFormatVersion: "compact-v2",
      finalizedFrom: inputPath,
      finalizedAt: new Date().toISOString(),
      primarySequenceCount: primarySequences.length,
      primaryCandidateCount: primaryCandidatesTotal,
      primaryCandidatesEligible30m,
      primaryCandidatesIncomplete30m,
      primarySequenceClassCounts,
    },
    hashes: {
      ...source.hashes,
      finalSequenceMembership: finalSequenceMembershipHash,
    },
    rawData: source.rawData,
    sequences: finalSequences,
  };
  fs.writeFileSync(outPath, JSON.stringify(output));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);

  console.log(`File size: ${sizeMB} MB`);
  console.log(`Sequences: ${finalSequences.length}`);
  console.log(`Candidates: ${totalCandidates}`);
  console.log(
    `Primary candidates total: ${primaryCandidatesTotal}, eligible for full 30m: ${primaryCandidatesEligible30m}`,
  );
  console.log(
    `Primary sequence class counts: ${JSON.stringify(primarySequenceClassCounts)}`,
  );
  console.log(`Output written to: ${outPath}`);
}

main();
