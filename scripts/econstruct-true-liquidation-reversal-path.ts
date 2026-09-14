import "dotenv/config";
import * as fs from "fs";
import { loadBinanceConfig } from "../src/infrastructure/config/binance.config";
import { BinanceRestClient } from "../src/infrastructure/binance/binanceRest.client";

/**
 * Sep 14 2026 (Karo), operator-requested. TRUE candle-by-candle path
 * reconstruction, replacing the earlier pathOrderProxy approximation.
 * READ-ONLY research -- never touches production code, ROTATION
 * logic, P95/history, or any TP/SL constant. Re-fetches historical 1m
 * candles from Binance (the source market-response JSON only stored
 * derived MFE/MAE per horizon, never the raw OHLC needed for true
 * path reconstruction) -- everything else (candidate identity,
 * causal features) is reused unchanged from the existing dataset.
 *
 *   tsx scripts/reconstruct-true-liquidation-reversal-path.ts \
 *     --market-response=/mnt/data/liquidation-market-response-3d-<ts>.json \
 *     --prior-classification=/mnt/data/liquidation-reversal-classification-3d-<ts>.json
 *
 * STRICT SEPARATION (per explicit operator instruction): everything
 * in `response`/path-order fields below is an OUTCOME LABEL, computed
 * from candles strictly AFTER candidateEndTs. It is never mixed into
 * the causal feature set (cumulativeLiqUsd, eventCount, ATR, etc,
 * copied unchanged from the source candidate) and must never be used
 * as a live entry feature in any future phase.
 */

const PATH_MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 30];
const MAX_HORIZON_MIN = 30;

// ---- source dataset shapes (matches research-liquidation-market-response.ts's own output exactly) ----
interface SourceCandidate {
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
}
interface SourceJson {
  windowFromMs: number;
  windowToMs: number;
  candidates: SourceCandidate[];
}
interface PriorClassifiedCandidate {
  symbol: string;
  sequenceId: string;
  candidateIndex: number;
  dominanceShare5m: number;
  pathOrderProxy: string;
}
interface PriorJson {
  scoredCandidates: PriorClassifiedCandidate[];
  methodology: {
    classBoundaries: {
      reversalDominatedAbove: number;
      continuationDominatedBelow: number;
    };
  };
}

export interface HistoricalCandle {
  symbol: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed: true;
}

type OutcomeClass =
  | "REAL_REVERSAL"
  | "LIKELY_REVERSAL"
  | "AMBIGUOUS"
  | "CONTINUATION";
type SequenceClass =
  | "REAL_REVERSAL"
  | "FAILED_REVERSAL"
  | "CONTINUATION"
  | "AMBIGUOUS";

interface PathPoint {
  minute: number;
  favorablePct: number;
  adversePct: number;
  runningMaxFavorablePct: number;
  runningMaxAdversePct: number;
}

interface TruePathResult {
  path: PathPoint[];
  timeToFirstFavorableMin: number | null;
  timeToFirstAdverseMin: number | null;
  timeToMaxFavorableMin: number | null;
  timeToMaxAdverseMin: number | null;
  maxFavorablePct: number;
  maxAdversePct: number;
  adverseBeforeMaxFavorablePct: number; // max adverse seen strictly before the minute max favorable was reached
  favorableBeforeMaxAdversePct: number; // max favorable seen strictly before the minute max adverse was reached
  firstDirectionalMove: "FAVORABLE" | "ADVERSE" | "FLAT";
  firstDominantMove: "REVERSAL" | "CONTINUATION" | "NONE";
  newAdverseExtremeCount: number; // number of minutes that set a new running-adverse high-water mark
  createdNewLiqDirectionExtremeBeyondCandidate: boolean; // whether price ever went beyond the candidate's own latestExtremePrice
  largestAdverseBeforeRecovery: number; // max adverse reached before the first minute favorable overtakes cumulative adverse-so-far ("recovery" point); equals maxAdversePct if favorable never overtakes
  timeToFirstMeaningfulRejectionMin: number | null; // first minute where runningMaxFavorable >= runningMaxAdverse-so-far (data-relative, not a fixed %)
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

async function fetchHistoricalCandles(
  rest: BinanceRestClient,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<HistoricalCandle[]> {
  const out: HistoricalCandle[] = [];
  let cursor = fromMs;
  const PAGE_LIMIT = 500;
  const MS_PER_CANDLE = 60_000;
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
    for (const c of candles) {
      if (!c.isClosed) continue;
      out.push({
        symbol,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        isClosed: true,
      });
    }
    const lastOpenTime = candles[candles.length - 1]!.openTime;
    if (lastOpenTime <= cursor) break;
    cursor = lastOpenTime + MS_PER_CANDLE;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return out;
}

/** TRUE, minute-by-minute path reconstruction from real candles --
 *  replaces the earlier pathOrderProxy approximation entirely. Never
 *  reads any candle with openTime < candidateEndTs (no lookahead into
 *  the candidate's own formation). */
export function reconstructTruePath(
  candles: HistoricalCandle[],
  startIdx: number,
  candidateEndTs: number,
  refPrice: number,
  victim: "LONG" | "SHORT",
  candidateLatestExtreme: number,
): TruePathResult {
  const path: PathPoint[] = [];
  let runningFavExtreme = refPrice;
  let runningAdvExtreme = refPrice;
  let newAdverseExtremeCount = 0;
  let createdNewLiqDirectionExtremeBeyondCandidate = false;
  let firstFavMin: number | null = null;
  let firstAdvMin: number | null = null;

  // walk minute-by-minute, one closed candle per minute
  let ci = startIdx;
  for (let m = 1; m <= MAX_HORIZON_MIN; m++) {
    const minuteEndTs = candidateEndTs + m * 60_000;
    while (
      ci < candles.length &&
      candles[ci]!.openTime + 60_000 <= minuteEndTs &&
      candles[ci]!.openTime >= candidateEndTs
    ) {
      const c = candles[ci]!;
      const priorAdv = runningAdvExtreme;
      if (victim === "LONG") {
        if (c.high > runningFavExtreme) runningFavExtreme = c.high;
        if (c.low < runningAdvExtreme) runningAdvExtreme = c.low;
        if (c.low < candidateLatestExtreme)
          createdNewLiqDirectionExtremeBeyondCandidate = true;
      } else {
        if (c.low < runningFavExtreme) runningFavExtreme = c.low;
        if (c.high > runningAdvExtreme) runningAdvExtreme = c.high;
        if (c.high > candidateLatestExtreme)
          createdNewLiqDirectionExtremeBeyondCandidate = true;
      }
      if (runningAdvExtreme !== priorAdv) newAdverseExtremeCount++;
      ci++;
    }
    const favorablePct =
      victim === "LONG"
        ? ((runningFavExtreme - refPrice) / refPrice) * 100
        : ((refPrice - runningFavExtreme) / refPrice) * 100;
    const adversePct =
      victim === "LONG"
        ? ((refPrice - runningAdvExtreme) / refPrice) * 100
        : ((runningAdvExtreme - refPrice) / refPrice) * 100;
    if (firstFavMin === null && favorablePct > 0) firstFavMin = m;
    if (firstAdvMin === null && adversePct > 0) firstAdvMin = m;
    if (PATH_MINUTES.includes(m)) {
      path.push({
        minute: m,
        favorablePct: Math.max(0, favorablePct),
        adversePct: Math.max(0, adversePct),
        runningMaxFavorablePct: Math.max(0, favorablePct),
        runningMaxAdversePct: Math.max(0, adversePct),
      });
    }
  }

  const maxFavorablePct = Math.max(0, ...path.map((p) => p.favorablePct));
  const maxAdversePct = Math.max(0, ...path.map((p) => p.adversePct));
  const timeToMaxFavorableMin =
    path.find((p) => p.favorablePct === maxFavorablePct)?.minute ?? null;
  const timeToMaxAdverseMin =
    path.find((p) => p.adversePct === maxAdversePct)?.minute ?? null;

  const beforeMinute = (
    targetMin: number | null,
    key: "favorablePct" | "adversePct",
  ): number => {
    if (targetMin === null) return 0;
    const before = path.filter((p) => p.minute < targetMin);
    return before.length === 0 ? 0 : Math.max(...before.map((p) => p[key]));
  };
  const adverseBeforeMaxFavorablePct = beforeMinute(
    timeToMaxFavorableMin,
    "adversePct",
  );
  const favorableBeforeMaxAdversePct = beforeMinute(
    timeToMaxAdverseMin,
    "favorablePct",
  );

  let firstDirectionalMove: TruePathResult["firstDirectionalMove"] = "FLAT";
  if (
    firstFavMin !== null &&
    (firstAdvMin === null || firstFavMin < firstAdvMin)
  )
    firstDirectionalMove = "FAVORABLE";
  else if (
    firstAdvMin !== null &&
    (firstFavMin === null || firstAdvMin < firstFavMin)
  )
    firstDirectionalMove = "ADVERSE";

  const m1 = path.find((p) => p.minute === 1);
  let firstDominantMove: TruePathResult["firstDominantMove"] = "NONE";
  if (m1) {
    if (m1.favorablePct > m1.adversePct) firstDominantMove = "REVERSAL";
    else if (m1.adversePct > m1.favorablePct)
      firstDominantMove = "CONTINUATION";
  }

  // "recovery point": first minute where running favorable >= running adverse accumulated so far (data-relative "meaningful rejection", not a fixed %)
  let recoveryMinute: number | null = null;
  let largestAdverseBeforeRecovery = maxAdversePct;
  for (const p of path) {
    if (p.favorablePct >= p.adversePct && p.favorablePct > 0) {
      recoveryMinute = p.minute;
      largestAdverseBeforeRecovery = beforeMinute(p.minute, "adversePct");
      break;
    }
  }

  return {
    path,
    timeToFirstFavorableMin: firstFavMin,
    timeToFirstAdverseMin: firstAdvMin,
    timeToMaxFavorableMin,
    timeToMaxAdverseMin,
    maxFavorablePct,
    maxAdversePct,
    adverseBeforeMaxFavorablePct,
    favorableBeforeMaxAdversePct,
    firstDirectionalMove,
    firstDominantMove,
    newAdverseExtremeCount,
    createdNewLiqDirectionExtremeBeyondCandidate,
    largestAdverseBeforeRecovery,
    timeToFirstMeaningfulRejectionMin: recoveryMinute,
  };
}

function parseArgs(argv: string[]): {
  marketResponsePath: string;
  priorClassificationPath: string | null;
} {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };
  const marketResponsePath = get("market-response");
  if (!marketResponsePath) {
    console.error(
      "Usage: reconstruct-true-liquidation-reversal-path.ts --market-response=/path/to/liquidation-market-response-3d-<ts>.json [--prior-classification=/path/to/liquidation-reversal-classification-3d-<ts>.json]",
    );
    process.exit(1);
  }
  return {
    marketResponsePath,
    priorClassificationPath: get("prior-classification") ?? null,
  };
}

async function main(): Promise<void> {
  const { marketResponsePath, priorClassificationPath } = parseArgs(
    process.argv.slice(2),
  );
  const source: SourceJson = JSON.parse(
    fs.readFileSync(marketResponsePath, "utf8"),
  );
  const prior: PriorJson | null = priorClassificationPath
    ? JSON.parse(fs.readFileSync(priorClassificationPath, "utf8"))
    : null;

  console.log(
    `Loaded ${source.candidates.length} candidates from ${marketResponsePath}`,
  );
  if (prior)
    console.log(
      `Loaded prior classification (${prior.scoredCandidates.length} scored candidates) from ${priorClassificationPath}`,
    );

  const rest = new BinanceRestClient(loadBinanceConfig());
  const symbols = [...new Set(source.candidates.map((c) => c.symbol))];
  const candlesBySymbol = new Map<string, HistoricalCandle[]>();
  for (const symbol of symbols) {
    const symCandidates = source.candidates.filter((c) => c.symbol === symbol);
    const minEnd = Math.min(...symCandidates.map((c) => c.candidateEndTs));
    const maxEnd = Math.max(...symCandidates.map((c) => c.candidateEndTs));
    console.log(
      `Fetching candles for ${symbol}: ${new Date(minEnd).toISOString()} -> ${new Date(maxEnd + MAX_HORIZON_MIN * 60_000).toISOString()}`,
    );
    const candles = await fetchHistoricalCandles(
      rest,
      symbol,
      minEnd,
      maxEnd + (MAX_HORIZON_MIN + 5) * 60_000,
    );
    candles.sort((a, b) => a.openTime - b.openTime);
    candlesBySymbol.set(symbol, candles);
    console.log(`  fetched ${candles.length} candles`);
  }

  interface Enriched {
    candidate: SourceCandidate;
    truePath: TruePathResult;
    dominanceShare5m: number;
    dominanceShare10m: number;
    class: OutcomeClass;
  }
  const enriched: Enriched[] = [];

  for (const c of source.candidates) {
    const candles = candlesBySymbol.get(c.symbol)!;
    const startIdx = candles.findIndex(
      (cc) => cc.openTime + 60_000 > c.candidateEndTs,
    );
    const truePath = reconstructTruePath(
      candles,
      startIdx === -1 ? candles.length : startIdx,
      c.candidateEndTs,
      c.candidateEndPrice,
      c.victim,
      c.latestExtremePrice,
    );
    const p5 = truePath.path.find((p) => p.minute === 5);
    const p10 = truePath.path.find((p) => p.minute === 10);
    const dom5 = p5
      ? p5.favorablePct + p5.adversePct === 0
        ? 0.5
        : p5.favorablePct / (p5.favorablePct + p5.adversePct)
      : 0.5;
    const dom10 = p10
      ? p10.favorablePct + p10.adversePct === 0
        ? 0.5
        : p10.favorablePct / (p10.favorablePct + p10.adversePct)
      : 0.5;
    enriched.push({
      candidate: c,
      truePath,
      dominanceShare5m: dom5,
      dominanceShare10m: dom10,
      class: "AMBIGUOUS",
    });
  }

  // ---- STEP 3: data-derived classification, combining dominance AND true path order ----
  const domSorted = enriched
    .map((e) => e.dominanceShare5m)
    .sort((a, b) => a - b);
  const p25 = percentile(domSorted, 0.25)!;
  const p75 = percentile(domSorted, 0.75)!;
  const p90 = percentile(domSorted, 0.9)!;
  console.log(
    `\nObserved dominanceShare@5m quartiles: P25=${p25.toFixed(3)} P75=${p75.toFixed(3)} P90=${p90.toFixed(3)}`,
  );

  for (const e of enriched) {
    const { dominanceShare5m: dom, truePath: tp } = e;
    // A candidate is REAL_REVERSAL only if dominance is high AND the
    // path order supports it (favorable led, or adverse-before-max-
    // favorable stayed small relative to the eventual favorable move)
    // -- this is exactly what fixes Example B from the operator's own
    // prompt (large adverse first, big favorable only later, would
    // previously have scored as reversal on dominance alone).
    const pathSupportsReversal =
      tp.firstDominantMove !== "CONTINUATION" &&
      tp.adverseBeforeMaxFavorablePct <= tp.maxFavorablePct * 0.5;
    if (dom >= p90 && pathSupportsReversal) e.class = "REAL_REVERSAL";
    else if (
      dom >= p75 &&
      (tp.firstDominantMove === "REVERSAL" || pathSupportsReversal)
    )
      e.class = "LIKELY_REVERSAL";
    else if (dom <= p25 || tp.firstDominantMove === "CONTINUATION")
      e.class = "CONTINUATION";
    else e.class = "AMBIGUOUS";
  }

  const classCounts: Record<OutcomeClass, number> = {
    REAL_REVERSAL: 0,
    LIKELY_REVERSAL: 0,
    AMBIGUOUS: 0,
    CONTINUATION: 0,
  };
  for (const e of enriched) classCounts[e.class]++;
  console.log(
    `\nCandidate-level classification: ${JSON.stringify(classCounts)}`,
  );

  // ---- STEP 4/5: sequence-level rollup, one canonical reversal point per sequence ----
  interface SequenceResult {
    sequenceId: string;
    symbol: string;
    victim: string;
    sequenceClass: SequenceClass;
    firstTrueReversalCandidateIndex: number | null;
    remainedStable: boolean;
    laterFailed: boolean;
    laterImproved: boolean;
  }
  const sequenceIds = [...new Set(enriched.map((e) => e.candidate.sequenceId))];
  const sequenceResults: SequenceResult[] = [];

  for (const sid of sequenceIds) {
    const seq = enriched
      .filter((e) => e.candidate.sequenceId === sid)
      .sort((a, b) => a.candidate.candidateIndex - b.candidate.candidateIndex);
    const firstReal = seq.find(
      (e) => e.class === "REAL_REVERSAL" || e.class === "LIKELY_REVERSAL",
    );
    let sequenceClass: SequenceClass = "AMBIGUOUS";
    let remainedStable = false,
      laterFailed = false,
      laterImproved = false;
    if (firstReal) {
      const afterIdx = seq.filter(
        (e) => e.candidate.candidateIndex > firstReal.candidate.candidateIndex,
      );
      const afterFailed = afterIdx.some((e) => e.class === "CONTINUATION");
      const afterImproved = afterIdx.some(
        (e) =>
          e.class === "REAL_REVERSAL" && firstReal.class !== "REAL_REVERSAL",
      );
      remainedStable = !afterFailed;
      laterFailed = afterFailed;
      laterImproved = afterImproved;
      sequenceClass = afterFailed ? "FAILED_REVERSAL" : "REAL_REVERSAL";
    } else if (seq.every((e) => e.class === "CONTINUATION")) {
      sequenceClass = "CONTINUATION";
    }
    sequenceResults.push({
      sequenceId: sid,
      symbol: seq[0]!.candidate.symbol,
      victim: seq[0]!.candidate.victim,
      sequenceClass,
      firstTrueReversalCandidateIndex:
        firstReal?.candidate.candidateIndex ?? null,
      remainedStable,
      laterFailed,
      laterImproved,
    });
  }
  const seqClassCounts: Record<SequenceClass, number> = {
    REAL_REVERSAL: 0,
    FAILED_REVERSAL: 0,
    CONTINUATION: 0,
    AMBIGUOUS: 0,
  };
  for (const s of sequenceResults) seqClassCounts[s.sequenceClass]++;
  console.log(
    `\nSequence-level classification (one canonical point per sequence): ${JSON.stringify(seqClassCounts)}`,
  );

  // ---- STEP 6/7: final filtered populations -- one canonical entry per REAL_REVERSAL sequence ----
  function buildPopulationEntry(e: Enriched) {
    const c = e.candidate;
    const getMin = (m: number) => e.truePath.path.find((p) => p.minute === m);
    return {
      symbol: c.symbol,
      victim: c.victim,
      sequenceId: c.sequenceId,
      sequenceStartTs: c.candidateStartTs,
      candidateStartTs: c.candidateStartTs,
      candidateEndTs: c.candidateEndTs,
      candidateIndex: c.candidateIndex,
      cumulativeLiqUsd: c.cumulativeLiqUsd,
      eventCount: c.eventCount,
      maxSingleLiqUsd: c.maxSingleLiqUsd,
      lastEventUsd: c.lastEventUsd,
      durationMs: c.durationMs,
      candidateStartPrice: c.candidateStartPrice,
      candidateEndPrice: c.candidateEndPrice,
      latestExtremePrice: c.latestExtremePrice,
      favorable5m: getMin(5)?.favorablePct ?? null,
      adverse5m: getMin(5)?.adversePct ?? null,
      favorable10m: getMin(10)?.favorablePct ?? null,
      adverse10m: getMin(10)?.adversePct ?? null,
      favorable15m: getMin(15)?.favorablePct ?? null,
      adverse15m: getMin(15)?.adversePct ?? null,
      favorable30m: getMin(30)?.favorablePct ?? null,
      adverse30m: getMin(30)?.adversePct ?? null,
      dominanceShare5m: e.dominanceShare5m,
      timeToMaxFavorableMin: e.truePath.timeToMaxFavorableMin,
      timeToMaxAdverseMin: e.truePath.timeToMaxAdverseMin,
      maxAdverseBeforeReversal: e.truePath.largestAdverseBeforeRecovery,
      firstDirectionalMove: e.truePath.firstDirectionalMove,
      firstDominantMove: e.truePath.firstDominantMove,
      outcomeClass: e.class,
      // causal features, unchanged from source, never mixed with the outcome fields above
      preLiqDirAtr: c.preLiqDirAtr,
      preRecDirAtr: c.preRecDirAtr,
      currentDirAtr: c.currentDirAtr,
      currentRecAtr: c.currentRecAtr,
      comparisonRotationDegApprox: c.comparisonRotationDegApprox,
      comparisonShockAtrApprox: c.comparisonShockAtrApprox,
      avgEventSpacingMs: c.avgEventSpacingMs,
      medianEventSpacingMs: c.medianEventSpacingMs,
      liqAmountTrend: c.liqAmountTrend,
      maxSingleOverCumulative: c.maxSingleOverCumulative,
    };
  }

  const realReversalLiquidations = sequenceResults
    .filter(
      (s) =>
        s.sequenceClass === "REAL_REVERSAL" &&
        s.firstTrueReversalCandidateIndex !== null,
    )
    .map(
      (s) =>
        enriched.find(
          (e) =>
            e.candidate.sequenceId === s.sequenceId &&
            e.candidate.candidateIndex === s.firstTrueReversalCandidateIndex,
        )!,
    )
    .map(buildPopulationEntry);

  const continuationSeqIds = new Set(
    sequenceResults
      .filter((s) => s.sequenceClass === "CONTINUATION")
      .map((s) => s.sequenceId),
  );
  const continuationLiquidations = enriched
    .filter(
      (e) =>
        continuationSeqIds.has(e.candidate.sequenceId) &&
        e.candidate.candidateIndex ===
          Math.max(
            ...enriched
              .filter(
                (e2) => e2.candidate.sequenceId === e.candidate.sequenceId,
              )
              .map((e2) => e2.candidate.candidateIndex),
          ),
    )
    .map(buildPopulationEntry);

  const ambiguousSeqIds = new Set(
    sequenceResults
      .filter((s) => s.sequenceClass === "AMBIGUOUS")
      .map((s) => s.sequenceId),
  );
  const ambiguousLiquidations = enriched
    .filter(
      (e) =>
        ambiguousSeqIds.has(e.candidate.sequenceId) &&
        e.candidate.candidateIndex ===
          Math.max(
            ...enriched
              .filter(
                (e2) => e2.candidate.sequenceId === e.candidate.sequenceId,
              )
              .map((e2) => e2.candidate.candidateIndex),
          ),
    )
    .map(buildPopulationEntry);

  console.log(
    `\nFinal filtered populations: realReversalLiquidations=${realReversalLiquidations.length}, continuationLiquidations=${continuationLiquidations.length}, ambiguousLiquidations=${ambiguousLiquidations.length}`,
  );

  // ---- STEP 9: compare against prior classification ----
  let labelChanges: unknown = null;
  if (prior) {
    let remainedReversal = 0,
      downgraded = 0,
      upgraded = 0,
      remainedAmbiguous = 0;
    for (const e of enriched) {
      const priorMatch = prior.scoredCandidates.find(
        (p) =>
          p.symbol === e.candidate.symbol &&
          p.sequenceId === e.candidate.sequenceId &&
          p.candidateIndex === e.candidate.candidateIndex,
      );
      if (!priorMatch) continue;
      const priorWasReversal =
        priorMatch.dominanceShare5m >
        prior.methodology.classBoundaries.reversalDominatedAbove;
      const nowIsReversal =
        e.class === "REAL_REVERSAL" || e.class === "LIKELY_REVERSAL";
      if (priorWasReversal && nowIsReversal) remainedReversal++;
      else if (priorWasReversal && !nowIsReversal) downgraded++;
      else if (!priorWasReversal && nowIsReversal) upgraded++;
      else remainedAmbiguous++;
    }
    labelChanges = {
      remainedReversal,
      downgradedByTruePathOrder: downgraded,
      upgradedByTruePathOrder: upgraded,
      remainedNonReversal: remainedAmbiguous,
    };
    console.log(
      `\nLabel changes vs prior pathOrderProxy classification: ${JSON.stringify(labelChanges)}`,
    );
  }

  // ---- STEP 8: manual inspection examples ----
  function printPath(e: Enriched): void {
    console.log(
      `  ${e.candidate.symbol} ${e.candidate.victim} seq=${e.candidate.sequenceId} idx=${e.candidate.candidateIndex} class=${e.class} firstDominant=${e.truePath.firstDominantMove}`,
    );
    for (const p of e.truePath.path) {
      console.log(
        `    +${p.minute}m favorable ${p.favorablePct.toFixed(2)} / adverse ${p.adversePct.toFixed(2)}`,
      );
    }
  }
  console.log("\n=== STEP 8: MANUAL INSPECTION EXAMPLES ===\n");
  const longReversals = enriched
    .filter((e) => e.candidate.victim === "LONG" && e.class === "REAL_REVERSAL")
    .sort((a, b) => b.dominanceShare5m - a.dominanceShare5m)
    .slice(0, 10);
  const shortReversals = enriched
    .filter(
      (e) => e.candidate.victim === "SHORT" && e.class === "REAL_REVERSAL",
    )
    .sort((a, b) => b.dominanceShare5m - a.dominanceShare5m)
    .slice(0, 10);
  const continuations = enriched
    .filter((e) => e.class === "CONTINUATION")
    .sort((a, b) => a.dominanceShare5m - b.dominanceShare5m)
    .slice(0, 10);
  const ambiguous = enriched
    .filter((e) => e.class === "AMBIGUOUS")
    .sort(
      (a, b) =>
        Math.abs(a.dominanceShare5m - 0.5) - Math.abs(b.dominanceShare5m - 0.5),
    )
    .slice(0, 10);
  console.log("10 strongest LONG-victim true reversals:");
  longReversals.forEach(printPath);
  console.log("\n10 strongest SHORT-victim true reversals:");
  shortReversals.forEach(printPath);
  console.log("\n10 obvious continuations:");
  continuations.forEach(printPath);
  console.log("\n10 difficult ambiguous cases:");
  ambiguous.forEach(printPath);

  // ---- output ----
  const outPath = `/mnt/data/liquidation-true-reversals-3d-${Date.now()}.json`;
  const output = {
    methodology: {
      note: "TRUE candle-by-candle path reconstruction from real 1m OHLC (re-fetched from Binance), replacing the earlier pathOrderProxy approximation. Classification combines observed dominanceShare quartiles WITH true path order (firstDominantMove, adverseBeforeMaxFavorable) so a candidate with large early adverse continuation and only later favorable movement (operator's own 'Example B') is never misclassified as a clean reversal purely on eventual MFE.",
      classificationRulesDerivedFromData: {
        dominanceP25: p25,
        dominanceP75: p75,
        dominanceP90: p90,
      },
    },
    summary: {
      totalSequences: sequenceIds.length,
      sequenceClassCounts: seqClassCounts,
      candidateClassCounts: classCounts,
    },
    realReversalLiquidations,
    continuationLiquidations,
    ambiguousLiquidations,
    sequenceResults,
    labelChangesFromPreviousAnalysis: labelChanges,
    strongestExamples: {
      longReversals: longReversals.map((e) => buildPopulationEntry(e)),
      shortReversals: shortReversals.map((e) => buildPopulationEntry(e)),
      continuations: continuations.map((e) => buildPopulationEntry(e)),
      ambiguous: ambiguous.map((e) => buildPopulationEntry(e)),
    },
    methodologicalWarnings: [
      "Classification thresholds (P25/P75/P90 of dominanceShare) are derived from THIS dataset's own observed distribution -- they will shift if re-run on a different date range and should not be treated as universal constants.",
      "firstDominantMove/adverseBeforeMaxFavorable are computed from 1m candle high/low, which can slightly overstate true intra-minute extremes (candle wicks) compared to tick-level data -- acceptable for this research phase, worth revisiting if tick-level precision is later required.",
      "Sample size after sequence-level deduplication is meaningfully smaller than the raw candidate count -- treat per-symbol/per-victim breakdowns with appropriate caution given a 3-day window.",
    ],
  };
  fs.mkdirSync("/mnt/data", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nFull output written to: ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[RECONSTRUCT_TRUE_LIQUIDATION_REVERSAL_PATH_FATAL]", err);
    process.exit(1);
  });
}
