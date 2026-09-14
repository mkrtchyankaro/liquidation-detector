import * as fs from "fs";

/**
 * Sep 14 2026 (Karo), operator-requested. Phase 2 of the liquidation-
 * reversal research -- consumes the JSON already produced by
 * scripts/research-liquidation-market-response.ts, does NOT
 * re-extract any raw data, does NOT touch any production code or
 * collection. Pure local file analysis.
 *
 *   tsx scripts/analyze-liquidation-reversal-classification.ts /path/to/liquidation-market-response-3d-<ts>.json
 *
 * METHODOLOGICAL LIMITATION (flagged explicitly per operator
 * instruction "inspect the output for obvious methodological or
 * coding errors" -- found BEFORE running, not after): the source
 * JSON's own CandidateResponse only stores mfePct/maePct MAGNITUDE
 * per horizon, not the TIMESTAMP within that horizon at which each
 * extreme was reached. True path-order ("which happened first")
 * therefore cannot be reconstructed exactly from this dataset without
 * regenerating it with per-tick timestamps -- which the operator
 * explicitly said not to do this pass. What this script computes
 * instead is a coarser PROXY: since the source data already has
 * NESTED horizons (1m, 2m, 3m, 5m, 10m, 15m, 30m) for the same
 * candidate, comparing how favorablePct/adversePct each evolve as the
 * horizon grows gives an approximate sense of which came first (e.g.
 * adversePct already large at 1-2m while favorablePct only grows
 * large by 15-30m suggests adverse-first). This is clearly labeled
 * "pathOrderProxy" throughout -- never presented as true path order.
 */

interface CandidateResponse {
  horizonMin: number;
  mfePct: number;
  maePct: number;
  mfeAtrNorm: number | null;
  maeAtrNorm: number | null;
}
interface Candidate {
  symbol: string;
  victim: "LONG" | "SHORT";
  sequenceId: string;
  candidateIndex: number;
  candidateStartTs: number;
  candidateEndTs: number;
  candidateStartPrice: number;
  candidateEndPrice: number;
  latestExtremePrice: number;
  cumulativeLiqUsd: number;
  eventCount: number;
  maxSingleLiqUsd: number;
  maxSingleOverCumulative: number;
  durationMs: number;
  avgEventSpacingMs: number;
  medianEventSpacingMs: number;
  lastEventUsd: number;
  liqAmountTrend: string;
  preLiqDirAtr: number | null;
  preRecDirAtr: number | null;
  currentDirAtr: number | null;
  currentRecAtr: number | null;
  comparisonRotationDegApprox: number | null;
  comparisonShockAtrApprox: number | null;
  response: CandidateResponse[];
  bestMfePct: number;
  worstMaePct: number;
}
interface SourceJson {
  generatedAt: string;
  windowFromMs: number;
  windowToMs: number;
  candidates: Candidate[];
}

const HORIZONS = [1, 2, 3, 5, 10, 15, 30];

interface DerivedMetrics {
  horizonMin: number;
  favorablePct: number;
  adversePct: number;
  responseRatio: number; // Infinity when adversePct===0 -- handled explicitly, never silently divided
  netReversalAdvantage: number;
  dominanceShare: number; // 0.5 when both are exactly 0 (no movement at all -- neutral, not "ambiguous evidence")
  favorableAtrNorm: number | null;
  adverseAtrNorm: number | null;
}

function deriveMetrics(r: CandidateResponse): DerivedMetrics {
  const favorablePct = Math.max(0, r.mfePct);
  const adversePct = Math.max(0, -r.maePct);
  const responseRatio =
    adversePct === 0
      ? favorablePct === 0
        ? 1
        : Infinity
      : favorablePct / adversePct;
  const netReversalAdvantage = favorablePct - adversePct;
  const dominanceShare =
    favorablePct + adversePct === 0
      ? 0.5
      : favorablePct / (favorablePct + adversePct);
  return {
    horizonMin: r.horizonMin,
    favorablePct,
    adversePct,
    responseRatio,
    netReversalAdvantage,
    dominanceShare,
    favorableAtrNorm: r.mfeAtrNorm,
    adverseAtrNorm: r.maeAtrNorm !== null ? Math.abs(r.maeAtrNorm) : null,
  };
}

/** Coarse path-order proxy -- see this file's own header doc comment
 *  for exactly why this is NOT true path order. */
function pathOrderProxy(
  metricsByHorizon: DerivedMetrics[],
): "favorable-first-likely" | "adverse-first-likely" | "concurrent-or-unclear" {
  const early = metricsByHorizon.filter((m) => m.horizonMin <= 2);
  const late = metricsByHorizon.filter((m) => m.horizonMin >= 15);
  if (early.length === 0 || late.length === 0) return "concurrent-or-unclear";
  const earlyDom = early[early.length - 1]!.dominanceShare;
  const lateDom = late[late.length - 1]!.dominanceShare;
  if (earlyDom >= 0.6) return "favorable-first-likely";
  if (earlyDom <= 0.4 && lateDom >= 0.6) return "adverse-first-likely"; // adverse dominated early, favorable only caught up later
  return "concurrent-or-unclear";
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sorted[lo]!
    : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
function mean(arr: number[]): number | null {
  return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
}
function finite(arr: number[]): number[] {
  return arr.filter((v) => Number.isFinite(v));
}

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error(
      "Usage: analyze-liquidation-reversal-classification.ts /path/to/liquidation-market-response-3d-<ts>.json",
    );
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }
  const source: SourceJson = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const candidates = source.candidates;
  console.log(
    `Loaded ${candidates.length} candidates from ${inputPath} (window ${new Date(source.windowFromMs).toISOString()} -> ${new Date(source.windowToMs).toISOString()})\n`,
  );

  // Precompute derived metrics for every candidate x horizon.
  const derived = candidates.map((c) => ({
    candidate: c,
    byHorizon: c.response.map(deriveMetrics),
  }));
  for (const d of derived) {
    (d as unknown as { pathOrderProxy: string }).pathOrderProxy =
      pathOrderProxy(d.byHorizon);
  }

  // ---- STEP 2: distributions per horizon, per symbol+victim, and pooled ----
  console.log("=== STEP 2: RESPONSE DISTRIBUTIONS BY HORIZON ===\n");
  const symbols = [...new Set(candidates.map((c) => c.symbol))];
  const groupKeys = [
    ...symbols.flatMap((s) => [`${s}|LONG`, `${s}|SHORT`]),
    "POOLED",
  ];
  const distributionSummary: Record<string, Record<number, unknown>> = {};

  for (const groupKey of groupKeys) {
    distributionSummary[groupKey] = {};
    for (const h of [2, 3, 5, 10, 15, 30]) {
      const rows = derived.filter((d) => {
        if (groupKey === "POOLED") return true;
        const [sym, vic] = groupKey.split("|");
        return d.candidate.symbol === sym && d.candidate.victim === vic;
      });
      const metricsAtH = rows
        .map((d) => d.byHorizon.find((m) => m.horizonMin === h))
        .filter((m): m is DerivedMetrics => m !== undefined);
      if (metricsAtH.length < 5) continue;
      const favSorted = metricsAtH
        .map((m) => m.favorablePct)
        .sort((a, b) => a - b);
      const advSorted = metricsAtH
        .map((m) => m.adversePct)
        .sort((a, b) => a - b);
      const ratioSorted = finite(metricsAtH.map((m) => m.responseRatio)).sort(
        (a, b) => a - b,
      );
      const netSorted = metricsAtH
        .map((m) => m.netReversalAdvantage)
        .sort((a, b) => a - b);
      const domSorted = metricsAtH
        .map((m) => m.dominanceShare)
        .sort((a, b) => a - b);
      distributionSummary[groupKey]![h] = {
        n: metricsAtH.length,
        favorablePct: {
          p50: percentile(favSorted, 0.5),
          p90: percentile(favSorted, 0.9),
        },
        adversePct: {
          p50: percentile(advSorted, 0.5),
          p90: percentile(advSorted, 0.9),
        },
        responseRatio: {
          p50: percentile(ratioSorted, 0.5),
          p90: percentile(ratioSorted, 0.9),
        },
        netReversalAdvantage: {
          p50: percentile(netSorted, 0.5),
          p90: percentile(netSorted, 0.9),
        },
        dominanceShare: {
          p10: percentile(domSorted, 0.1),
          p50: percentile(domSorted, 0.5),
          p90: percentile(domSorted, 0.9),
        },
      };
      if (groupKey === "POOLED" || rows.length > 30) {
        const ds = distributionSummary[groupKey]![h] as {
          dominanceShare: { p10: number; p50: number; p90: number };
        };
        console.log(
          `${groupKey.padEnd(14)} h=${String(h).padStart(2)}m n=${String(metricsAtH.length).padStart(4)}  dominanceShare P10=${ds.dominanceShare.p10?.toFixed(2)} P50=${ds.dominanceShare.p50?.toFixed(2)} P90=${ds.dominanceShare.p90?.toFixed(2)}`,
        );
      }
    }
  }

  // ---- STEP 3: propose outcome classes from the OBSERVED pooled distribution (never hard-coded first) ----
  console.log(
    "\n=== STEP 3: OUTCOME CLASSIFICATION (derived from observed dominanceShare distribution, horizon=5m) ===\n",
  );
  const pooled5m = derived.map(
    (d) => d.byHorizon.find((m) => m.horizonMin === 5)!,
  );
  const domSorted5m = pooled5m
    .map((m) => m.dominanceShare)
    .sort((a, b) => a - b);
  const p25 = percentile(domSorted5m, 0.25)!;
  const p75 = percentile(domSorted5m, 0.75)!;
  console.log(
    `Pooled dominanceShare@5m: P25=${p25.toFixed(3)} P50=${percentile(domSorted5m, 0.5)!.toFixed(3)} P75=${p75.toFixed(3)}`,
  );
  console.log(
    `Proposed data-derived boundaries (quartile-based, NOT arbitrary fixed %): REVERSAL-DOMINATED = dominanceShare > ${p75.toFixed(3)}, CONTINUATION-DOMINATED = dominanceShare < ${p25.toFixed(3)}, AMBIGUOUS = between.`,
  );
  const classify = (
    dom: number,
  ): "REVERSAL_DOMINATED" | "CONTINUATION_DOMINATED" | "AMBIGUOUS" =>
    dom > p75
      ? "REVERSAL_DOMINATED"
      : dom < p25
        ? "CONTINUATION_DOMINATED"
        : "AMBIGUOUS";
  const classCounts = {
    REVERSAL_DOMINATED: 0,
    CONTINUATION_DOMINATED: 0,
    AMBIGUOUS: 0,
  };
  for (const m of pooled5m) classCounts[classify(m.dominanceShare)]++;
  console.log(
    `Counts @5m: REVERSAL_DOMINATED=${classCounts.REVERSAL_DOMINATED} CONTINUATION_DOMINATED=${classCounts.CONTINUATION_DOMINATED} AMBIGUOUS=${classCounts.AMBIGUOUS}`,
  );

  // ---- STEP 5: best horizon -- label stability across horizons ----
  console.log("\n=== STEP 5: LABEL STABILITY ACROSS HORIZONS ===\n");
  const labelStability: Record<string, number> = {};
  for (const h of [5, 10, 15, 30]) {
    if (h === 5) continue;
    let stable = 0,
      total = 0;
    for (const d of derived) {
      const m5 = d.byHorizon.find((m) => m.horizonMin === 5);
      const mh = d.byHorizon.find((m) => m.horizonMin === h);
      if (!m5 || !mh) continue;
      total++;
      if (classify(m5.dominanceShare) === classify(mh.dominanceShare)) stable++;
    }
    labelStability[`5m_vs_${h}m`] = total > 0 ? stable / total : 0;
    console.log(
      `5m label still matches ${h}m label: ${((stable / Math.max(total, 1)) * 100).toFixed(1)}% (n=${total})`,
    );
  }

  // ---- STEP 6/7: per-sequence transition analysis ----
  console.log(
    "\n=== STEP 6/7: PER-SEQUENCE TRANSITION ANALYSIS (5m horizon) ===\n",
  );
  const sequenceIds = [...new Set(candidates.map((c) => c.sequenceId))];
  interface Transition {
    sequenceId: string;
    symbol: string;
    victim: string;
    fromIdx: number;
    toIdx: number;
    fromDom: number;
    toDom: number;
    fromClass: string;
    toClass: string;
    addedLiqUsd: number;
    addedEventUsd: number;
  }
  const transitions: Transition[] = [];
  const sequenceOutcomes: {
    sequenceId: string;
    neverReversal: boolean;
    firstReversalIdx: number | null;
    peakThenFailed: boolean;
  }[] = [];

  for (const sid of sequenceIds) {
    const seq = derived
      .filter((d) => d.candidate.sequenceId === sid)
      .sort((a, b) => a.candidate.candidateIndex - b.candidate.candidateIndex);
    if (seq.length === 0) continue;
    let firstReversalIdx: number | null = null;
    let sawReversal = false;
    let laterFailed = false;
    for (let k = 0; k < seq.length; k++) {
      const m5 = seq[k]!.byHorizon.find((m) => m.horizonMin === 5)!;
      const cls = classify(m5.dominanceShare);
      if (cls === "REVERSAL_DOMINATED") {
        if (firstReversalIdx === null)
          firstReversalIdx = seq[k]!.candidate.candidateIndex;
        sawReversal = true;
      } else if (sawReversal && cls === "CONTINUATION_DOMINATED") {
        laterFailed = true;
      }
      if (k > 0) {
        const prev = seq[k - 1]!.byHorizon.find((m) => m.horizonMin === 5)!;
        const prevCls = classify(prev.dominanceShare);
        if (prevCls !== "REVERSAL_DOMINATED" && cls === "REVERSAL_DOMINATED") {
          transitions.push({
            sequenceId: sid,
            symbol: seq[k]!.candidate.symbol,
            victim: seq[k]!.candidate.victim,
            fromIdx: seq[k - 1]!.candidate.candidateIndex,
            toIdx: seq[k]!.candidate.candidateIndex,
            fromDom: prev.dominanceShare,
            toDom: m5.dominanceShare,
            fromClass: prevCls,
            toClass: cls,
            addedLiqUsd:
              seq[k]!.candidate.cumulativeLiqUsd -
              seq[k - 1]!.candidate.cumulativeLiqUsd,
            addedEventUsd: seq[k]!.candidate.lastEventUsd,
          });
        }
      }
    }
    sequenceOutcomes.push({
      sequenceId: sid,
      neverReversal: !sawReversal,
      firstReversalIdx,
      peakThenFailed: laterFailed,
    });
  }
  console.log(`Total sequences: ${sequenceIds.length}`);
  console.log(
    `Sequences that never became reversal-dominated (5m): ${sequenceOutcomes.filter((s) => s.neverReversal).length}`,
  );
  console.log(
    `Sequences that became reversal-dominated on L1 (first candidate): ${sequenceOutcomes.filter((s) => s.firstReversalIdx === 1).length}`,
  );
  console.log(
    `Sequences that became reversal-dominated only on a LATER candidate (L2+): ${sequenceOutcomes.filter((s) => s.firstReversalIdx !== null && s.firstReversalIdx > 1).length}`,
  );
  console.log(
    `Sequences that looked reversal-like then later failed (continuation after): ${sequenceOutcomes.filter((s) => s.peakThenFailed).length}`,
  );
  console.log(
    `Sharp continuation->reversal transitions detected: ${transitions.length}`,
  );

  // ---- STEP 9: magnitude question ----
  console.log(
    "\n=== STEP 9: DOES LIQUIDATION MAGNITUDE PREDICT REVERSAL DOMINANCE? (5m, pooled) ===\n",
  );
  const withCumUsd = derived.map((d) => ({
    cumUsd: d.candidate.cumulativeLiqUsd,
    dom: d.byHorizon.find((m) => m.horizonMin === 5)!.dominanceShare,
  }));
  const sortedByCum = [...withCumUsd].sort((a, b) => a.cumUsd - b.cumUsd);
  const quantileCount = 5;
  for (let q = 0; q < quantileCount; q++) {
    const lo = Math.floor((q / quantileCount) * sortedByCum.length);
    const hi = Math.floor(((q + 1) / quantileCount) * sortedByCum.length);
    const slice = sortedByCum.slice(lo, hi);
    if (slice.length === 0) continue;
    const avgDom = mean(slice.map((s) => s.dom))!;
    const minCum = slice[0]!.cumUsd,
      maxCum = slice[slice.length - 1]!.cumUsd;
    console.log(
      `Size quantile ${q + 1}/${quantileCount} ($${minCum.toFixed(0)}-$${maxCum.toFixed(0)}, n=${slice.length}): avg dominanceShare=${avgDom.toFixed(3)}`,
    );
  }

  // ---- STEP 10: research-only reversal quality score ----
  console.log(
    "\n=== STEP 10: REVERSAL QUALITY SCORE (research-only, 5m horizon) ===\n",
  );
  console.log(
    "Formula A (simple): score = favorablePct - adversePct  (= netReversalAdvantage)",
  );
  console.log(
    "Formula B (ratio-based): score = dominanceShare * 2 - 1  (rescaled to [-1,+1], symmetric around 0)",
  );
  const scored = derived.map((d) => {
    const m5 = d.byHorizon.find((m) => m.horizonMin === 5)!;
    return {
      candidate: d.candidate,
      scoreA: m5.netReversalAdvantage,
      scoreB: m5.dominanceShare * 2 - 1,
      dom: m5.dominanceShare,
      pathOrder: (d as unknown as { pathOrderProxy: string }).pathOrderProxy,
    };
  });

  // ---- STEP 11: real examples ----
  console.log("\n=== STEP 11: EXAMPLES ===\n");
  const byScoreA = [...scored].sort((a, b) => b.scoreA - a.scoreA);
  const byScoreAAsc = [...scored].sort((a, b) => a.scoreA - b.scoreA);
  const ambiguous = scored
    .filter((s) => s.dom > 0.45 && s.dom < 0.55)
    .sort((a, b) => Math.abs(a.dom - 0.5) - Math.abs(b.dom - 0.5));

  function printExample(s: (typeof scored)[number]): void {
    const c = s.candidate;
    console.log(
      `  ${c.symbol} ${c.victim} seq=${c.sequenceId} idx=${c.candidateIndex} ` +
        `start=${new Date(c.candidateStartTs).toISOString()} end=${new Date(c.candidateEndTs).toISOString()} ` +
        `cumUsd=$${c.cumulativeLiqUsd.toFixed(0)} events=${c.eventCount} lastEventUsd=$${c.lastEventUsd.toFixed(0)} ` +
        `maxSingle=$${c.maxSingleLiqUsd.toFixed(0)} durationMs=${c.durationMs} ` +
        `dominanceShare@5m=${s.dom.toFixed(3)} scoreA=${s.scoreA.toFixed(3)} pathOrderProxy=${s.pathOrder}`,
    );
  }
  console.log("Top 10 strongest reversal-dominated:");
  byScoreA.slice(0, 10).forEach(printExample);
  console.log("\nTop 10 strongest continuation-dominated:");
  byScoreAAsc.slice(0, 10).forEach(printExample);
  console.log("\n10 ambiguous examples (dominanceShare near 0.5):");
  ambiguous.slice(0, 10).forEach(printExample);
  console.log("\nTop 10 sharpest continuation->reversal transitions:");
  transitions
    .sort((a, b) => b.toDom - b.fromDom - (a.toDom - a.fromDom))
    .slice(0, 10)
    .forEach((t) =>
      console.log(
        `  ${t.symbol} ${t.victim} seq=${t.sequenceId} L${t.fromIdx}(dom=${t.fromDom.toFixed(3)}) -> L${t.toIdx}(dom=${t.toDom.toFixed(3)}) addedLiqUsd=$${t.addedLiqUsd.toFixed(0)} addedEventUsd=$${t.addedEventUsd.toFixed(0)}`,
      ),
    );

  // ---- output JSON ----
  const outPath = `/mnt/data/liquidation-reversal-classification-3d-${Date.now()}.json`;
  const output = {
    methodology: {
      sourceFile: inputPath,
      note: "Outcome classes derived from OBSERVED pooled dominanceShare quartiles at 5m horizon, not arbitrary fixed thresholds. pathOrderProxy is an APPROXIMATION from nested-horizon comparison, NOT true intra-horizon path order -- see this script's own header doc comment for why.",
      classBoundaries: {
        reversalDominatedAbove: p75,
        continuationDominatedBelow: p25,
      },
    },
    distributionSummary,
    labelStability,
    sequenceOutcomes,
    transitions,
    classCounts5m: classCounts,
    scoredCandidates: scored.map((s) => ({
      ...s.candidate,
      scoreA: s.scoreA,
      scoreB: s.scoreB,
      dominanceShare5m: s.dom,
      pathOrderProxy: s.pathOrder,
    })),
  };
  try {
    fs.mkdirSync("/mnt/data", { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nFull analysis written to: ${outPath}`);
  } catch (err) {
    console.error(`Failed to write JSON output to ${outPath}:`, err);
  }
}

main();
