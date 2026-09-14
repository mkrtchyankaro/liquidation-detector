import "dotenv/config";
import * as fs from "fs";
import * as crypto from "crypto";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import { loadBinanceConfig } from "../src/infrastructure/config/binance.config";
import { BinanceRestClient } from "../src/infrastructure/binance/binanceRest.client";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import type { Side, Liquidation, Candle } from "../src/shared/common.types";
import {
  causalPercentileFamily,
  percentileRank,
  reconstructCausalEpisodeTotals,
  durationMatchedSeries,
  LOOKBACK_WINDOWS_MS,
  percentile,
  type HistoricalCandle,
} from "./build-real-reversal-causal-history";
import {
  reconstructTruePath,
  classifyCandidate,
  type TruePathResult,
} from "./reconstruct-true-liquidation-reversal-path-fixed";

/**
 * Sep 14 2026 (Karo), operator-requested. ONE self-contained, frozen
 * 6-day master research dataset. Fetches raw liquidations + candles
 * ONCE per symbol, builds deterministic sequences and their FULL
 * candidate ladders (every prefix, not just canonical points, for
 * BOTH eventual reversal and continuation sequences), computes causal
 * features and future outcomes for every candidate, classifies, hashes
 * the immutable source sections, and validates structural integrity --
 * all in one pass, writing exactly one output file. No future research
 * script should need MongoDB or Binance again for this window.
 *
 * REUSE, NOT REDESIGN: causal percentile/duration-matched/episode
 * formulas are imported unchanged from build-real-reversal-causal-
 * history.ts; true-path reconstruction and candidate classification
 * are imported unchanged from reconstruct-true-liquidation-reversal-
 * path-fixed.ts (the latter's classification logic was extracted into
 * an exported classifyCandidate() function specifically for this
 * reuse, and the original script's own main() now calls that same
 * function too -- verified byte-identical behavior via the existing
 * smoke test, not just asserted).
 *
 *   tsx scripts/build-liquidation-master-6d.ts
 *
 * KNOWN, EXPECTED LIMITATION (not a bug): candidates whose own
 * candidateEndTs falls within the last ~30 minutes of the window will
 * have incomplete future outcome data (dataQuality=NO_DATA/partial
 * path), since toMs is pinned to "now" and no future candles exist
 * beyond it. This is inherent to freezing a dataset at the present
 * moment, not a defect -- flagged in metadata, not hidden.
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const DAYS_TOTAL = 6;
const DAYS_WARMUP = 3;
const DATASET_VERSION = "liquidation-master-6d-v1";

export function sha256(data: unknown): string {
  const json = JSON.stringify(data);
  return crypto.createHash("sha256").update(json).digest("hex");
}

async function fetchLiquidationsInWindow(
  mongo: MongoClientWrapper,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Liquidation[]> {
  const col = await mongo.rawLiquidationEvents();
  if (!col) return [];
  const docs = await col
    .find({ symbol, timestamp: { $gte: fromMs, $lt: toMs } })
    .sort({ timestamp: 1 })
    .toArray();
  return docs.map((d) => ({
    symbol: d.symbol,
    side: d.victim === "LONG" ? ("SELL" as const) : ("BUY" as const),
    price: d.price,
    quoteQty: d.quoteQty,
    quantity: d.price > 0 ? d.quoteQty / d.price : 0,
    timestamp: d.timestamp,
  }));
}

async function fetchCandlesInWindow(
  rest: BinanceRestClient,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
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
    for (const c of candles) if (c.isClosed) out.push(c);
    const lastOpenTime = candles[candles.length - 1]!.openTime;
    if (lastOpenTime <= cursor) break;
    cursor = lastOpenTime + MS_PER_CANDLE;
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

/** Single deterministic pass: maximal same-victim run, hard
 *  victim-flip separator (the SAME segmentation convention every
 *  script in this research thread has used) -- assigns the ONE, FINAL
 *  permanent sequenceId. No future script ever needs to regenerate
 *  this, since exact raw event membership is stored alongside it. */
export function segmentSequences(
  symbol: string,
  liquidations: readonly Liquidation[],
): {
  sequenceId: string;
  symbol: string;
  victim: Side;
  events: Liquidation[];
}[] {
  const sorted = [...liquidations].sort((a, b) => a.timestamp - b.timestamp);
  const out: {
    sequenceId: string;
    symbol: string;
    victim: Side;
    events: Liquidation[];
  }[] = [];
  const counters: Record<Side, number> = { LONG: 0, SHORT: 0 };
  let i = 0;
  while (i < sorted.length) {
    const victim: Side = sorted[i]!.side === "SELL" ? "LONG" : "SHORT";
    let j = i;
    while (
      j < sorted.length &&
      (sorted[j]!.side === "SELL" ? "LONG" : "SHORT") === victim
    )
      j++;
    out.push({
      sequenceId: `${symbol}-${victim}-${counters[victim]++}`,
      symbol,
      victim,
      events: sorted.slice(i, j),
    });
    i = j;
  }
  return out;
}

interface CandidateOutput {
  candidateIndex: number;
  timestamp: number;
  rawEventIndexes: number[];
  causal: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  candidateOutcomeClass: string;
}

async function main(): Promise<void> {
  const toMs = Math.floor(Date.now() / 60_000) * 60_000;
  const fromMs = toMs - DAYS_TOTAL * 24 * 3600_000;
  const warmupEnd = fromMs + DAYS_WARMUP * 24 * 3600_000;
  console.log(
    `Master dataset window: ${new Date(fromMs).toISOString()} -> ${new Date(toMs).toISOString()}`,
  );
  console.log(
    `Warmup (Days 1-3): ${new Date(fromMs).toISOString()} -> ${new Date(warmupEnd).toISOString()}`,
  );
  console.log(
    `Primary research (Days 4-6): ${new Date(warmupEnd).toISOString()} -> ${new Date(toMs).toISOString()}\n`,
  );

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

  const rawLiquidationsBySymbol = new Map<string, Liquidation[]>();
  const rawCandlesBySymbol = new Map<string, Candle[]>();
  const historicalCandlesBySymbol = new Map<string, HistoricalCandle[]>();

  for (const symbol of SYMBOLS) {
    console.log(
      `Fetching raw liquidations for ${symbol} (once, bounded to the exact 6-day window)...`,
    );
    const liqs = await fetchLiquidationsInWindow(mongo, symbol, fromMs, toMs);
    for (const l of liqs) {
      if (l.timestamp < fromMs || l.timestamp >= toMs)
        throw new Error(
          `ASSERTION FAILED: fetched liquidation for ${symbol} at ts=${l.timestamp} outside window [${fromMs}, ${toMs})`,
        );
    }
    rawLiquidationsBySymbol.set(symbol, liqs);
    console.log(`  ${liqs.length} raw liquidation events`);

    console.log(`Fetching closed 1m candles for ${symbol} (once)...`);
    const candles = await fetchCandlesInWindow(rest, symbol, fromMs, toMs);
    candles.sort((a, b) => a.openTime - b.openTime);
    rawCandlesBySymbol.set(symbol, candles);
    historicalCandlesBySymbol.set(
      symbol,
      candles.map((c) => ({
        symbol,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        isClosed: true as const,
      })),
    );
    console.log(`  ${candles.length} closed 1m candles\n`);
  }

  interface SeqInternal {
    sequenceId: string;
    symbol: string;
    victim: Side;
    events: Liquidation[];
    candidates: CandidateOutput[];
  }
  const allSequences: SeqInternal[] = [];
  for (const symbol of SYMBOLS) {
    const segs = segmentSequences(
      symbol,
      rawLiquidationsBySymbol.get(symbol) ?? [],
    );
    for (const s of segs) allSequences.push({ ...s, candidates: [] });
  }
  console.log(`Total sequences constructed: ${allSequences.length}\n`);

  interface PendingClassification {
    seq: SeqInternal;
    candidate: CandidateOutput;
    dom5: number | null;
    truePath: TruePathResult;
  }
  const pending: PendingClassification[] = [];

  for (const seq of allSequences) {
    const candles = historicalCandlesBySymbol.get(seq.symbol) ?? [];
    const allSameVictimEvents = (
      rawLiquidationsBySymbol.get(seq.symbol) ?? []
    ).filter((e) => (e.side === "SELL" ? "LONG" : "SHORT") === seq.victim);
    const allSameVictimSeries = allSameVictimEvents.map((e) => ({
      timestamp: e.timestamp,
      value: e.quoteQty,
    }));

    const tracker = new DirectionalAtrTracker();
    let ci = 0;
    const feedTo = (ts: number): void => {
      while (ci < candles.length && candles[ci]!.openTime + 60_000 <= ts) {
        tracker.onCandle(candles[ci]!);
        ci++;
      }
    };

    const episodeStartTs = seq.events[0]!.timestamp;
    const episodeStartPrice = seq.events[0]!.price;
    feedTo(episodeStartTs);
    const preLiqDirAtr =
      seq.victim === "LONG"
        ? tracker.getDownAtr(seq.symbol)
        : tracker.getUpAtr(seq.symbol);
    const preRecDirAtr =
      seq.victim === "LONG"
        ? tracker.getUpAtr(seq.symbol)
        : tracker.getDownAtr(seq.symbol);

    let cumulativeLiqUsd = 0,
      maxSingleLiqUsd = 0;
    let latestExtremePrice = episodeStartPrice;
    let latestExtremeTs = episodeStartTs;
    let prevExtremeTsForGap = episodeStartTs;
    let prevPriceDisplacementATR: number | null = null;

    for (let idx = 0; idx < seq.events.length; idx++) {
      const ev = seq.events[idx]!;
      const prevCumulative = cumulativeLiqUsd;
      cumulativeLiqUsd += ev.quoteQty;
      maxSingleLiqUsd = Math.max(maxSingleLiqUsd, ev.quoteQty);
      const priorExtreme = latestExtremePrice;
      const newAdverseExtreme =
        seq.victim === "LONG"
          ? ev.price < latestExtremePrice
          : ev.price > latestExtremePrice;
      if (newAdverseExtreme) {
        latestExtremePrice = ev.price;
        latestExtremeTs = ev.timestamp;
      }

      const T = ev.timestamp;
      feedTo(T);
      const currentLiqDirAtr =
        seq.victim === "LONG"
          ? tracker.getDownAtr(seq.symbol)
          : tracker.getUpAtr(seq.symbol);
      const currentRecDirAtr =
        seq.victim === "LONG"
          ? tracker.getUpAtr(seq.symbol)
          : tracker.getDownAtr(seq.symbol);
      const episodeDurationMs = T - episodeStartTs;

      const singleEventPercentiles: Record<
        string,
        ReturnType<typeof causalPercentileFamily>
      > = {};
      for (const w of LOOKBACK_WINDOWS_MS)
        singleEventPercentiles[w.label] = causalPercentileFamily(
          allSameVictimSeries,
          T,
          w.ms,
        );
      const maxSinglePercentileRank24h = percentileRank(
        allSameVictimSeries,
        T,
        24 * 3600_000,
        maxSingleLiqUsd,
      );

      const causalEpisodes = reconstructCausalEpisodeTotals(
        allSameVictimEvents,
        T - 1,
      );
      const episodeSeries = causalEpisodes.map((e) => ({
        timestamp: e.episodeEndTs,
        value: e.cumulativeUsd,
      }));
      const episodePercentiles: Record<
        string,
        ReturnType<typeof causalPercentileFamily>
      > = {};
      for (const w of LOOKBACK_WINDOWS_MS)
        episodePercentiles[w.label] = causalPercentileFamily(
          episodeSeries,
          T,
          w.ms,
        );
      const currentEpisodePercentileRank = percentileRank(
        episodeSeries,
        T,
        null,
        cumulativeLiqUsd,
      );

      const durMatchedRaw = durationMatchedSeries(
        allSameVictimEvents,
        T,
        episodeDurationMs,
      );
      const durationMatchedPercentiles: Record<
        string,
        ReturnType<typeof causalPercentileFamily>
      > = {};
      for (const w of LOOKBACK_WINDOWS_MS)
        durationMatchedPercentiles[w.label] = causalPercentileFamily(
          durMatchedRaw,
          T,
          w.ms,
        );
      const durationMatchedPercentileRank =
        episodeDurationMs > 0
          ? percentileRank(durMatchedRaw, T, 24 * 3600_000, cumulativeLiqUsd)
          : null;

      const liqUsdPerSecond =
        episodeDurationMs > 0
          ? cumulativeLiqUsd / (episodeDurationMs / 1000)
          : null;
      const liqUsdPerMinute =
        liqUsdPerSecond !== null ? liqUsdPerSecond * 60 : null;

      const priceDisplacementPct =
        episodeStartPrice > 0
          ? Math.abs(
              (latestExtremePrice - episodeStartPrice) / episodeStartPrice,
            ) * 100
          : null;
      const priceDisplacementATR =
        preLiqDirAtr && preLiqDirAtr > 0
          ? Math.abs(latestExtremePrice - episodeStartPrice) / preLiqDirAtr
          : null;
      const priceProgressATRPer1M =
        priceDisplacementATR !== null && cumulativeLiqUsd > 0
          ? priceDisplacementATR / (cumulativeLiqUsd / 1_000_000)
          : null;

      const liqAtrChangePct =
        preLiqDirAtr && preLiqDirAtr > 0 && currentLiqDirAtr !== null
          ? ((currentLiqDirAtr - preLiqDirAtr) / preLiqDirAtr) * 100
          : null;
      const recoveryAtrChangePct =
        preRecDirAtr && preRecDirAtr > 0 && currentRecDirAtr !== null
          ? ((currentRecDirAtr - preRecDirAtr) / preRecDirAtr) * 100
          : null;
      const recoveryVsLiquidationAtrRatio =
        currentLiqDirAtr && currentLiqDirAtr > 0 && currentRecDirAtr !== null
          ? currentRecDirAtr / currentLiqDirAtr
          : null;

      const incrementalLiqUsd = ev.quoteQty;
      const adverseProgressSincePreviousCandidatePct =
        idx === 0
          ? null
          : priceDisplacementPct !== null
            ? priceDisplacementPct -
              (episodeStartPrice > 0
                ? Math.abs(
                    (priorExtreme - episodeStartPrice) / episodeStartPrice,
                  ) * 100
                : 0)
            : null;
      const adverseProgressSincePreviousCandidateATR =
        idx === 0 ||
        priceDisplacementATR === null ||
        prevPriceDisplacementATR === null
          ? null
          : priceDisplacementATR - prevPriceDisplacementATR;
      const marginalPriceProgressATRPer1M =
        adverseProgressSincePreviousCandidateATR !== null &&
        incrementalLiqUsd > 0
          ? adverseProgressSincePreviousCandidateATR /
            (incrementalLiqUsd / 1_000_000)
          : null;
      prevPriceDisplacementATR = priceDisplacementATR;

      const timeSincePreviousCandidateMs =
        idx === 0 ? null : T - seq.events[idx - 1]!.timestamp;
      const timeSincePreviousAdverseExtremeMs = T - prevExtremeTsForGap;
      if (newAdverseExtreme) prevExtremeTsForGap = T;

      const causal = {
        candidateIndex: idx + 1,
        cumulativeLiqUsd,
        incrementalLiqUsd,
        eventCount: idx + 1,
        maxSingleLiqUsd,
        lastEventUsd: ev.quoteQty,
        durationMs: episodeDurationMs,
        liqUsdPerSecond,
        liqUsdPerMinute,
        startPrice: episodeStartPrice,
        currentPrice: ev.price,
        adverseExtremePrice: latestExtremePrice,
        adverseExtremeTs: latestExtremeTs,
        priceDisplacementPct,
        priceDisplacementATR,
        newAdverseExtreme,
        adverseProgressSincePreviousCandidatePct,
        adverseProgressSincePreviousCandidateATR,
        timeSincePreviousCandidateMs,
        timeSincePreviousAdverseExtremeMs,
        preLiqDirAtr,
        preRecDirAtr,
        currentLiqDirAtr,
        currentRecDirAtr,
        liqAtrChangePct,
        recoveryAtrChangePct,
        recoveryVsLiquidationAtrRatio,
        singleEventPercentiles,
        maxSinglePercentileRank24h,
        episodePercentiles,
        currentEpisodePercentileRank,
        durationMatchedPercentiles,
        durationMatchedPercentileRank,
        priceProgressATRPer1M,
        marginalPriceProgressATRPer1M,
        prevCumulativeLiqUsd: prevCumulative,
      };

      const truePath = reconstructTruePath(
        candles,
        T,
        ev.price,
        seq.victim,
        latestExtremePrice,
      );
      const p5 = truePath.path.find((p) => p.minute === 5);
      const dom5 = p5
        ? p5.favorablePct + p5.adversePct === 0
          ? null
          : p5.favorablePct / (p5.favorablePct + p5.adversePct)
        : null;

      const outcome =
        truePath.dataQuality === "NO_DATA"
          ? null
          : {
              dataQuality: truePath.dataQuality,
              path: truePath.path,
              timeToFirstFavorableMin: truePath.timeToFirstFavorableMin,
              timeToFirstAdverseMin: truePath.timeToFirstAdverseMin,
              timeToMaxFavorableMin: truePath.timeToMaxFavorableMin,
              timeToMaxAdverseMin: truePath.timeToMaxAdverseMin,
              maxFavorablePct: truePath.maxFavorablePct,
              maxAdversePct: truePath.maxAdversePct,
              maxAdverseBeforeFavorableDominance:
                truePath.maxAdverseBeforeFavorableDominance,
              maxFavorableBeforeAdverseDominance:
                truePath.maxFavorableBeforeAdverseDominance,
              firstDirectionalMove: truePath.firstDirectionalMove,
              firstDominantMove: truePath.firstDominantMove,
              dominanceShare5m: dom5,
            };

      const candidate: CandidateOutput = {
        candidateIndex: idx + 1,
        timestamp: T,
        rawEventIndexes: Array.from({ length: idx + 1 }, (_, k) => k),
        causal,
        outcome,
        candidateOutcomeClass: "PENDING",
      };
      seq.candidates.push(candidate);
      pending.push({ seq, candidate, dom5, truePath });
    }
  }

  const validDom = pending
    .filter((p) => p.truePath.dataQuality === "VALID" && p.dom5 !== null)
    .map((p) => p.dom5!)
    .sort((a, b) => a - b);
  const p25 = percentile(validDom, 0.25),
    p75 = percentile(validDom, 0.75),
    p90 = percentile(validDom, 0.9);
  console.log(
    `Classification boundaries (derived from ${validDom.length} valid directional observations): P25=${p25?.toFixed(3)} P75=${p75?.toFixed(3)} P90=${p90?.toFixed(3)}\n`,
  );
  for (const p of pending) {
    p.candidate.candidateOutcomeClass = classifyCandidate(
      p.dom5,
      p.truePath,
      p25,
      p75,
      p90,
    );
  }

  interface SequenceRollup {
    sequenceId: string;
    symbol: string;
    victim: Side;
    sequenceClass: string;
    firstTrueReversalCandidateIndex: number | null;
  }
  const sequenceRollups: SequenceRollup[] = [];
  for (const seq of allSequences) {
    const firstReal = seq.candidates.find(
      (c) =>
        c.candidateOutcomeClass === "REAL_REVERSAL" ||
        c.candidateOutcomeClass === "LIKELY_REVERSAL",
    );
    const validCandidates = seq.candidates.filter(
      (c) =>
        pending.find((p) => p.candidate === c)?.truePath.dataQuality ===
        "VALID",
    );
    let sequenceClass: string;
    if (seq.candidates.every((c) => c.candidateOutcomeClass === "NO_DATA"))
      sequenceClass = "NO_DATA";
    else if (firstReal) {
      const afterFailed = seq.candidates
        .filter((c) => c.candidateIndex > firstReal.candidateIndex)
        .some((c) => c.candidateOutcomeClass === "CONTINUATION");
      sequenceClass = afterFailed ? "FAILED_REVERSAL" : "REAL_REVERSAL";
    } else if (
      validCandidates.length > 0 &&
      validCandidates.every((c) => c.candidateOutcomeClass === "CONTINUATION")
    ) {
      sequenceClass = "CONTINUATION";
    } else {
      sequenceClass = "AMBIGUOUS";
    }
    sequenceRollups.push({
      sequenceId: seq.sequenceId,
      symbol: seq.symbol,
      victim: seq.victim,
      sequenceClass,
      firstTrueReversalCandidateIndex: firstReal?.candidateIndex ?? null,
    });
  }

  const primarySequences = sequenceRollups.filter(
    (s) =>
      allSequences.find((seq) => seq.sequenceId === s.sequenceId)!.events[0]!
        .timestamp >= warmupEnd,
  );
  const days4to6ClassCounts: Record<string, number> = {
    REAL_REVERSAL: 0,
    FAILED_REVERSAL: 0,
    CONTINUATION: 0,
    AMBIGUOUS: 0,
    NO_DATA: 0,
  };
  for (const s of primarySequences)
    days4to6ClassCounts[s.sequenceClass] =
      (days4to6ClassCounts[s.sequenceClass] ?? 0) + 1;
  console.log(
    `Days 4-6 sequence class counts: ${JSON.stringify(days4to6ClassCounts)}\n`,
  );

  console.log("=== VALIDATION ===\n");
  const violations: string[] = [];

  if (toMs - fromMs !== DAYS_TOTAL * 24 * 3600_000)
    violations.push("ASSERTION 1 FAILED: window is not exactly 6 days");
  for (const s of SYMBOLS)
    if (!rawLiquidationsBySymbol.has(s))
      violations.push(`ASSERTION 2 FAILED: missing symbol ${s}`);

  for (const symbol of SYMBOLS) {
    const candles = rawCandlesBySymbol.get(symbol) ?? [];
    for (let i = 1; i < candles.length; i++) {
      if (candles[i]!.openTime <= candles[i - 1]!.openTime)
        violations.push(
          `ASSERTION 3/4 FAILED: ${symbol} candles not strictly chronological or duplicated at index ${i}`,
        );
    }
  }

  for (const seq of allSequences) {
    for (const c of seq.candidates) {
      for (const idx of c.rawEventIndexes) {
        if (idx < 0 || idx >= seq.events.length)
          violations.push(
            `ASSERTION 6 FAILED: ${seq.sequenceId} candidate ${c.candidateIndex} references out-of-range event index ${idx}`,
          );
      }
      if (c.rawEventIndexes.length !== c.candidateIndex)
        violations.push(
          `ASSERTION 7 FAILED: ${seq.sequenceId} candidate ${c.candidateIndex} does not contain exactly events 1..${c.candidateIndex}`,
        );
    }
    const finalCandidate = seq.candidates[seq.candidates.length - 1];
    if (finalCandidate && finalCandidate.candidateIndex !== seq.events.length)
      violations.push(
        `ASSERTION 8 FAILED: ${seq.sequenceId} final candidate does not equal the full sequence`,
      );
    const indexes = seq.candidates.map((c) => c.candidateIndex);
    const expected = Array.from({ length: seq.events.length }, (_, i) => i + 1);
    if (JSON.stringify(indexes) !== JSON.stringify(expected))
      violations.push(
        `ASSERTION 9 FAILED: ${seq.sequenceId} has missing/duplicate candidate indexes`,
      );
  }

  for (const seq of allSequences) {
    for (const c of seq.candidates) {
      if (c.timestamp < seq.events[0]!.timestamp)
        violations.push(
          `ASSERTION 10/11 FAILED: ${seq.sequenceId} candidate ${c.candidateIndex} timestamp precedes its own sequence start`,
        );
    }
  }

  // ASSERTION 12 (fixed): structural, exact-key-name leakage check --
  // not a substring search, which previously false-flagged legitimate
  // causal fields like adverseExtremePrice/newAdverseExtreme simply
  // for containing the word "adverse". This checks the causal
  // object's own key names (recursively, since singleEventPercentiles
  // etc. are nested) against the EXACT set of keys that only ever
  // appear in the outcome/future-response schema -- never a prefix or
  // substring match.
  const FORBIDDEN_OUTCOME_KEYS = new Set([
    "path",
    "timeToFirstFavorableMin",
    "timeToFirstAdverseMin",
    "timeToMaxFavorableMin",
    "timeToMaxAdverseMin",
    "maxFavorablePct",
    "maxAdversePct",
    "maxAdverseBeforeFavorableDominance",
    "maxFavorableBeforeAdverseDominance",
    "firstDirectionalMove",
    "firstDominantMove",
    "dominanceShare5m",
    "dataQuality",
    "candidateOutcomeClass",
    "sequenceClass",
    "sequenceOutcomeClass",
    "favorablePct",
    "adversePct",
    "responseRatio",
    "minute",
  ]);
  function collectKeysRecursively(obj: unknown, acc: Set<string>): void {
    if (obj === null || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      acc.add(k);
      if (Array.isArray(v)) {
        for (const item of v) collectKeysRecursively(item, acc);
      } else collectKeysRecursively(v, acc);
    }
  }
  for (const seq of allSequences) {
    for (const c of seq.candidates) {
      const keysInCausal = new Set<string>();
      collectKeysRecursively(c.causal, keysInCausal);
      for (const key of keysInCausal) {
        if (FORBIDDEN_OUTCOME_KEYS.has(key))
          violations.push(
            `ASSERTION 12 FAILED: ${seq.sequenceId} candidate ${c.candidateIndex} causal block contains exact outcome-schema key "${key}"`,
          );
      }
      // independent T-boundary re-verification (per operator request):
      // every raw event this candidate references, and its own
      // recorded adverse-extreme timestamp, must not exceed T.
      for (const idx of c.rawEventIndexes) {
        if (seq.events[idx]!.timestamp > c.timestamp)
          violations.push(
            `ASSERTION 12 FAILED: ${seq.sequenceId} candidate ${c.candidateIndex} references a raw event timestamped after T`,
          );
      }
      const cf = c.causal as { adverseExtremeTs?: number };
      if (
        cf.adverseExtremeTs !== undefined &&
        cf.adverseExtremeTs > c.timestamp
      )
        violations.push(
          `ASSERTION 12 FAILED: ${seq.sequenceId} candidate ${c.candidateIndex} adverseExtremeTs exceeds T`,
        );
    }
  }

  if (violations.length > 0) {
    console.error(
      `${violations.length} VALIDATION FAILURES -- NOT writing output:`,
    );
    violations.slice(0, 30).forEach((v) => console.error(`  ${v}`));
    process.exit(1);
  }
  console.log("All structural validation assertions passed.\n");

  const rawLiquidationsForHash = SYMBOLS.map((s) => ({
    symbol: s,
    events: [...(rawLiquidationsBySymbol.get(s) ?? [])].sort(
      (a, b) => a.timestamp - b.timestamp,
    ),
  }));
  const rawCandlesForHash = SYMBOLS.map((s) => ({
    symbol: s,
    candles: [...(rawCandlesBySymbol.get(s) ?? [])].sort(
      (a, b) => a.openTime - b.openTime,
    ),
  }));
  const sequenceMembershipForHash = [...allSequences]
    .sort((a, b) => a.sequenceId.localeCompare(b.sequenceId))
    .map((s) => ({
      sequenceId: s.sequenceId,
      symbol: s.symbol,
      victim: s.victim,
      eventTimestamps: s.events.map((e) => e.timestamp),
    }));
  const hashes = {
    rawLiquidations: sha256(rawLiquidationsForHash),
    rawCandles: sha256(rawCandlesForHash),
    sequenceMembership: sha256(sequenceMembershipForHash),
  };
  console.log(
    `Hashes computed: rawLiquidations=${hashes.rawLiquidations.slice(0, 12)}... rawCandles=${hashes.rawCandles.slice(0, 12)}... sequenceMembership=${hashes.sequenceMembership.slice(0, 12)}...\n`,
  );

  const candidateClassCounts: Record<string, number> = {};
  for (const seq of allSequences)
    for (const c of seq.candidates)
      candidateClassCounts[c.candidateOutcomeClass] =
        (candidateClassCounts[c.candidateOutcomeClass] ?? 0) + 1;
  const sequenceClassCounts: Record<string, number> = {};
  for (const s of sequenceRollups)
    sequenceClassCounts[s.sequenceClass] =
      (sequenceClassCounts[s.sequenceClass] ?? 0) + 1;

  const outPath = `/mnt/data/liquidation-master-6d-${Date.now()}.json`;
  const output = {
    metadata: {
      datasetVersion: DATASET_VERSION,
      generatedAt: new Date().toISOString(),
      window: {
        fromMs,
        toMs,
        fromIso: new Date(fromMs).toISOString(),
        toIso: new Date(toMs).toISOString(),
      },
      warmupPeriod: {
        fromMs,
        toMs: warmupEnd,
        fromIso: new Date(fromMs).toISOString(),
        toIso: new Date(warmupEnd).toISOString(),
      },
      primaryResearchPeriod: {
        fromMs: warmupEnd,
        toMs,
        fromIso: new Date(warmupEnd).toISOString(),
        toIso: new Date(toMs).toISOString(),
      },
      symbols: SYMBOLS,
      rawLiquidationCounts: Object.fromEntries(
        SYMBOLS.map((s) => [s, (rawLiquidationsBySymbol.get(s) ?? []).length]),
      ),
      candleCounts: Object.fromEntries(
        SYMBOLS.map((s) => [s, (rawCandlesBySymbol.get(s) ?? []).length]),
      ),
      sequenceCounts: Object.fromEntries(
        SYMBOLS.flatMap((s) =>
          (["LONG", "SHORT"] as const).map((v) => [
            `${s}-${v}`,
            allSequences.filter((seq) => seq.symbol === s && seq.victim === v)
              .length,
          ]),
        ),
      ),
      candidateCount: allSequences.reduce(
        (sum, s) => sum + s.candidates.length,
        0,
      ),
      sequenceClassCounts,
      candidateClassCounts,
      knownLimitations: [
        "Candidates within ~30 minutes of toMs have incomplete/NO_DATA future outcome, since no future candles exist beyond the frozen window -- inherent, not a bug.",
      ],
    },
    hashes,
    rawData: {
      liquidations: Object.fromEntries(
        SYMBOLS.map((s) => [s, rawLiquidationsBySymbol.get(s) ?? []]),
      ),
      candles: Object.fromEntries(
        SYMBOLS.map((s) => [s, rawCandlesBySymbol.get(s) ?? []]),
      ),
    },
    sequences: allSequences.map((seq) => ({
      sequenceId: seq.sequenceId,
      symbol: seq.symbol,
      victim: seq.victim,
      startTs: seq.events[0]!.timestamp,
      endTs: seq.events[seq.events.length - 1]!.timestamp,
      eventCount: seq.events.length,
      cumulativeLiqUsd: seq.events.reduce((s, e) => s + e.quoteQty, 0),
      maxSingleLiqUsd: Math.max(...seq.events.map((e) => e.quoteQty)),
      durationMs:
        seq.events[seq.events.length - 1]!.timestamp - seq.events[0]!.timestamp,
      sequenceClass: sequenceRollups.find(
        (r) => r.sequenceId === seq.sequenceId,
      )!.sequenceClass,
      firstTrueReversalCandidateIndex: sequenceRollups.find(
        (r) => r.sequenceId === seq.sequenceId,
      )!.firstTrueReversalCandidateIndex,
      candidates: seq.candidates,
    })),
  };
  fs.mkdirSync("/mnt/data", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Master dataset written to: ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[BUILD_LIQUIDATION_MASTER_6D_FATAL]", err);
    process.exit(1);
  });
}
