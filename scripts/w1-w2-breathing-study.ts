import * as fs from "fs";
import type { Side, Liquidation, Candle } from "../src/shared/common.types";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import {
  causalPercentileFamily,
  percentileRank,
  reconstructCausalEpisodeTotals,
  durationMatchedSeries,
  LOOKBACK_WINDOWS_MS,
} from "./build-real-reversal-causal-history";

/**
 * Sep 14 2026 (Karo), operator-requested. Reconstructs natural
 * liquidation-burst (W1/W2) boundaries from actual event cadence (no
 * fixed 2m/5m/15m timeout), replays the closed 1m candle path between
 * W1 and W2 minute-by-minute, and measures how much of the eventual
 * reversal move had already happened by the time W2 started/ended --
 * the "cost of waiting for confirmation". Pure local read of the
 * frozen master dataset -- no Mongo, no Binance, no relabeling.
 *
 *   tsx scripts/w1-w2-breathing-study.ts --input=/mnt/data/liquidation-master-6d-FINAL-v2-<ts>.json
 *
 * W1 BOUNDARY METHOD (explicitly NOT a fixed threshold): for every
 * split point i within a sequence's own event stream, this computes
 * gapRatio = gapToNextEvent / medianOfRecentIntraWaveGaps. ALL split
 * points and their ratios are preserved in `possibleW1Boundaries` for
 * every sequence -- nothing is hidden. The primary W1 boundary used
 * for Steps 2-6 is the split point with the MAXIMUM gapRatio within
 * that sequence (the most natural-looking pause in ITS OWN cadence,
 * not a fixed number of minutes) -- documented, not silently chosen,
 * and the full candidate list lets any other rule be applied later
 * without re-deriving anything.
 *
 * ATR: reuses DirectionalAtrTracker unchanged (the same class the
 * master builder itself uses) -- no new ATR formula.
 */

interface CausalMin {
  currentLiqDirAtr: number | null;
  currentRecDirAtr: number | null;
  adverseExtremePrice: number;
  startPrice: number;
  durationMs: number;
  cumulativeLiqUsd: number;
}
interface SequenceMin {
  sequenceId: string;
  symbol: string;
  victim: Side;
  startTs: number;
  endTs: number;
  sequenceClass: string;
  firstTrueReversalCandidateIndex: number | null;
  rawEventIndexes: number[];
  candidates: {
    candidateIndex: number;
    timestamp: number;
    causal: CausalMin;
    outcomeLadder: Record<
      string,
      { favorablePct?: number; dataQuality: string }
    >;
  }[];
}
interface Master {
  metadata: { primaryResearchPeriod: { fromMs: number } };
  rawData: {
    liquidations: Record<string, Liquidation[]>;
    candles: Record<string, Candle[]>;
  };
  sequences: SequenceMin[];
}

function median(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseArgs(argv: string[]): { inputPath: string } {
  const hit = argv.find((a) => a.startsWith("--input="));
  if (!hit) {
    console.error(
      "Usage: w1-w2-breathing-study.ts --input=/path/to/liquidation-master-6d-FINAL-v2-<ts>.json",
    );
    process.exit(1);
  }
  return { inputPath: hit.slice("--input=".length) };
}

function main(): void {
  const { inputPath } = parseArgs(process.argv.slice(2));
  const master: Master = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const primaryFrom = master.metadata.primaryResearchPeriod.fromMs;
  const real = master.sequences.filter(
    (s) => s.startTs >= primaryFrom && s.sequenceClass === "REAL_REVERSAL",
  );
  console.log(`REAL_REVERSAL sequences in primary period: ${real.length}`);

  const episodes: Record<string, unknown>[] = [];
  const csvRows: Record<string, unknown>[] = [];
  let w1OnlyCount = 0,
    w1w2Count = 0;

  for (const seq of real) {
    const rawEvents = master.rawData.liquidations[seq.symbol] ?? [];
    const events = seq.rawEventIndexes.map((i) => rawEvents[i]!);
    if (events.length < 1) continue;
    const allSameVictimEvents = rawEvents.filter(
      (e) => (e.side === "SELL" ? "LONG" : "SHORT") === seq.victim,
    );
    const allSameVictimSeries = allSameVictimEvents.map((e) => ({
      timestamp: e.timestamp,
      value: e.quoteQty,
    }));

    // ---- STEP 1: gap analysis, preserve ALL possible boundaries ----
    const gaps = events
      .slice(1)
      .map((e, idx) => e.timestamp - events[idx]!.timestamp);
    const possibleW1Boundaries = gaps.map((gapToNext, idx) => {
      const recentGaps = gaps.slice(Math.max(0, idx - 4), idx); // up to the 4 gaps preceding this one (intra-wave cadence so far)
      const typicalRecentIntraWaveGap = median(recentGaps);
      const gapRatio =
        typicalRecentIntraWaveGap && typicalRecentIntraWaveGap > 0
          ? gapToNext / typicalRecentIntraWaveGap
          : null;
      return {
        splitAfterEventIndex: idx,
        lastW1LiquidationTs: events[idx]!.timestamp,
        gapToNext,
        typicalRecentIntraWaveGap,
        gapRatio,
      };
    });
    if (possibleW1Boundaries.length === 0) continue; // single-event sequence -- no W1/W2 breathing structure to study

    // primary boundary: max gapRatio split point (see header doc comment)
    const withRatio = possibleW1Boundaries.filter((b) => b.gapRatio !== null);
    const primaryBoundary =
      withRatio.length > 0
        ? withRatio.reduce((a, b) => (b.gapRatio! > a.gapRatio! ? b : a))
        : possibleW1Boundaries[possibleW1Boundaries.length - 1]!;
    const w1Events = events.slice(0, primaryBoundary.splitAfterEventIndex + 1);
    const remainingEvents = events.slice(
      primaryBoundary.splitAfterEventIndex + 1,
    );

    // ---- STEP 2: W1 state ----
    const candles = master.rawData.candles[seq.symbol] ?? [];
    const tracker = new DirectionalAtrTracker();
    let ci = 0;
    const feedTo = (ts: number): void => {
      while (ci < candles.length && candles[ci]!.openTime + 60_000 <= ts) {
        tracker.onCandle({
          symbol: seq.symbol,
          openTime: candles[ci]!.openTime,
          high: candles[ci]!.high,
          low: candles[ci]!.low,
          close: candles[ci]!.close,
          isClosed: true,
        });
        ci++;
      }
    };

    const w1StartTs = w1Events[0]!.timestamp;
    const w1StartPrice = w1Events[0]!.price;
    feedTo(w1StartTs);
    const preLiqAtr =
      seq.victim === "LONG"
        ? tracker.getDownAtr(seq.symbol)
        : tracker.getUpAtr(seq.symbol);
    const preRecAtr =
      seq.victim === "LONG"
        ? tracker.getUpAtr(seq.symbol)
        : tracker.getDownAtr(seq.symbol);

    let cum = 0,
      maxSingle = 0,
      extreme = w1StartPrice;
    for (const ev of w1Events) {
      cum += ev.quoteQty;
      maxSingle = Math.max(maxSingle, ev.quoteQty);
      extreme =
        seq.victim === "LONG"
          ? Math.min(extreme, ev.price)
          : Math.max(extreme, ev.price);
    }
    const w1EndTs = w1Events[w1Events.length - 1]!.timestamp;
    feedTo(w1EndTs);
    const w1LiqAtr =
      seq.victim === "LONG"
        ? tracker.getDownAtr(seq.symbol)
        : tracker.getUpAtr(seq.symbol);
    const w1RecAtr =
      seq.victim === "LONG"
        ? tracker.getUpAtr(seq.symbol)
        : tracker.getDownAtr(seq.symbol);
    const adverseProgressPct =
      w1StartPrice > 0
        ? Math.abs((extreme - w1StartPrice) / w1StartPrice) * 100
        : null;
    const adverseProgressATR =
      preLiqAtr && preLiqAtr > 0
        ? Math.abs(extreme - w1StartPrice) / preLiqAtr
        : null;
    const priceProgressATRPer1M =
      adverseProgressATR !== null && cum > 0
        ? adverseProgressATR / (cum / 1_000_000)
        : null;

    const durationMs = w1EndTs - w1StartTs;
    const episodesHist = reconstructCausalEpisodeTotals(
      allSameVictimEvents,
      w1EndTs - 1,
    );
    const episodeSeries = episodesHist.map((e) => ({
      timestamp: e.episodeEndTs,
      value: e.cumulativeUsd,
    }));
    const durMatched = durationMatchedSeries(
      allSameVictimEvents,
      w1EndTs,
      durationMs,
    );
    const historicalContext: Record<string, unknown> = {};
    for (const w of LOOKBACK_WINDOWS_MS.filter((x) => x.label !== "all")) {
      historicalContext[w.label] = {
        single: {
          family: causalPercentileFamily(allSameVictimSeries, w1EndTs, w.ms),
          rank: percentileRank(allSameVictimSeries, w1EndTs, w.ms, maxSingle),
        },
        episode: {
          family: causalPercentileFamily(episodeSeries, w1EndTs, w.ms),
          rank: percentileRank(episodeSeries, w1EndTs, w.ms, cum),
        },
        durationMatched: {
          family: causalPercentileFamily(durMatched, w1EndTs, w.ms),
          rank:
            durationMs > 0
              ? percentileRank(durMatched, w1EndTs, w.ms, cum)
              : null,
        },
      };
    }

    const w1 = {
      startTs: w1StartTs,
      endTs: w1EndTs,
      durationMs,
      eventCount: w1Events.length,
      cumulativeLiqUsd: cum,
      maxSingleLiqUsd: maxSingle,
      startPrice: w1StartPrice,
      adverseExtremePrice: extreme,
      adverseProgressPct,
      adverseProgressATR,
      preLiqAtr,
      liqAtrAtEnd: w1LiqAtr,
      preRecAtr,
      recAtrAtEnd: w1RecAtr,
      liqAtrChangePct:
        preLiqAtr && preLiqAtr > 0 && w1LiqAtr !== null
          ? ((w1LiqAtr - preLiqAtr) / preLiqAtr) * 100
          : null,
      recoveryAtrChangePct:
        preRecAtr && preRecAtr > 0 && w1RecAtr !== null
          ? ((w1RecAtr - preRecAtr) / preRecAtr) * 100
          : null,
      recoveryVsLiquidationAtrRatio:
        w1LiqAtr && w1LiqAtr > 0 && w1RecAtr !== null
          ? w1RecAtr / w1LiqAtr
          : null,
      priceProgressATRPer1M,
    };

    // ---- STEP 3: breathing period -- replay closed candles minute by minute until W2 starts or sequence ends ----
    const w2StartTs =
      remainingEvents.length > 0 ? remainingEvents[0]!.timestamp : null;
    const breathingEndTs =
      w2StartTs ??
      seq.candidates[seq.candidates.length - 1]!.timestamp + 30 * 60_000; // if no W2, walk up to 30m past the sequence's own last candidate for W1-only milestone measurement
    const startIdx = candles.findIndex((c) => c.openTime >= w1EndTs);
    const breathingPath: Record<string, unknown>[] = [];
    let maxRecoveryATRSoFar = 0,
      maxAdverseExtensionATRSoFar = 0;
    let w1ExtremeBroken = false,
      w1ExtremeBreakATR: number | null = null;
    let recovery025 = null,
      recovery050 = null,
      recovery075 = null,
      recovery100 = null;
    if (startIdx !== -1 && w1LiqAtr && w1LiqAtr > 0) {
      for (
        let idx = startIdx;
        idx < candles.length && candles[idx]!.openTime < breathingEndTs;
        idx++
      ) {
        const c = candles[idx]!;
        const elapsedMsFromW1End = c.openTime + 60_000 - w1EndTs;
        feedTo(c.openTime + 60_000);
        const liqAtrNow =
          seq.victim === "LONG"
            ? tracker.getDownAtr(seq.symbol)
            : tracker.getUpAtr(seq.symbol);
        const recAtrNow =
          seq.victim === "LONG"
            ? tracker.getUpAtr(seq.symbol)
            : tracker.getDownAtr(seq.symbol);
        const favorablePrice = seq.victim === "LONG" ? c.high : c.low;
        const adversePrice = seq.victim === "LONG" ? c.low : c.high;
        const favorableRecoveryATR =
          seq.victim === "LONG"
            ? Math.max(0, favorablePrice - extreme) / w1LiqAtr
            : Math.max(0, extreme - favorablePrice) / w1LiqAtr;
        const adverseExtensionATR =
          seq.victim === "LONG"
            ? Math.max(0, extreme - adversePrice) / w1LiqAtr
            : Math.max(0, adversePrice - extreme) / w1LiqAtr;
        maxRecoveryATRSoFar = Math.max(
          maxRecoveryATRSoFar,
          favorableRecoveryATR,
        );
        maxAdverseExtensionATRSoFar = Math.max(
          maxAdverseExtensionATRSoFar,
          adverseExtensionATR,
        );
        const brokeExtreme =
          seq.victim === "LONG"
            ? adversePrice < extreme
            : adversePrice > extreme;
        if (brokeExtreme) {
          w1ExtremeBroken = true;
          w1ExtremeBreakATR = adverseExtensionATR;
        }
        if (recovery025 === null && maxRecoveryATRSoFar >= 0.25)
          recovery025 = elapsedMsFromW1End;
        if (recovery050 === null && maxRecoveryATRSoFar >= 0.5)
          recovery050 = elapsedMsFromW1End;
        if (recovery075 === null && maxRecoveryATRSoFar >= 0.75)
          recovery075 = elapsedMsFromW1End;
        if (recovery100 === null && maxRecoveryATRSoFar >= 1.0)
          recovery100 = elapsedMsFromW1End;
        breathingPath.push({
          elapsedMsFromW1End,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          favorableRecoveryATR,
          adverseExtensionATR,
          maxRecoveryATRSoFar,
          maxAdverseExtensionATRSoFar,
          liqAtrNow,
          recAtrNow,
          liqAtrChangeVsW1End:
            w1LiqAtr && liqAtrNow !== null
              ? ((liqAtrNow - w1LiqAtr) / w1LiqAtr) * 100
              : null,
          recoveryVsLiquidationAtrRatio:
            liqAtrNow && liqAtrNow > 0 && recAtrNow !== null
              ? recAtrNow / liqAtrNow
              : null,
        });
      }
    }

    // ---- STEP 4: W2 ----
    let w2: Record<string, unknown> | null = null;
    let w2vsW1: Record<string, unknown> | null = null;
    let costOfWaiting: Record<string, unknown> | null = null;
    if (remainingEvents.length > 0) {
      w1w2Count++;
      // W2 spans from its first event to the FULL sequence's own end (remaining events represent the rest of the sequence)
      let w2cum = 0,
        w2max = 0,
        w2extreme = remainingEvents[0]!.price;
      for (const ev of remainingEvents) {
        w2cum += ev.quoteQty;
        w2max = Math.max(w2max, ev.quoteQty);
        w2extreme =
          seq.victim === "LONG"
            ? Math.min(w2extreme, ev.price)
            : Math.max(w2extreme, ev.price);
      }
      const w2StartTsV = remainingEvents[0]!.timestamp,
        w2EndTsV = remainingEvents[remainingEvents.length - 1]!.timestamp;
      feedTo(w2StartTsV);
      const w2LiqAtrStart =
        seq.victim === "LONG"
          ? tracker.getDownAtr(seq.symbol)
          : tracker.getUpAtr(seq.symbol);
      const w2RecAtrStart =
        seq.victim === "LONG"
          ? tracker.getUpAtr(seq.symbol)
          : tracker.getDownAtr(seq.symbol);
      feedTo(w2EndTsV);
      const w2LiqAtrEnd =
        seq.victim === "LONG"
          ? tracker.getDownAtr(seq.symbol)
          : tracker.getUpAtr(seq.symbol);
      const w2RecAtrEnd =
        seq.victim === "LONG"
          ? tracker.getUpAtr(seq.symbol)
          : tracker.getDownAtr(seq.symbol);
      const w2AdverseProgressATR =
        w1LiqAtr && w1LiqAtr > 0
          ? Math.abs(w2extreme - extreme) / w1LiqAtr
          : null;
      const w2SweptW1 =
        seq.victim === "LONG" ? w2extreme < extreme : w2extreme > extreme;
      const w2Efficiency =
        w2AdverseProgressATR !== null && w2cum > 0
          ? w2AdverseProgressATR / (w2cum / 1_000_000)
          : null;

      w2 = {
        startTs: w2StartTsV,
        endTs: w2EndTsV,
        timeFromW1EndMs: w2StartTsV - w1EndTs,
        eventCount: remainingEvents.length,
        cumulativeLiqUsd: w2cum,
        maxSingleLiqUsd: w2max,
        adverseProgressATR: w2AdverseProgressATR,
        liqAtrStart: w2LiqAtrStart,
        liqAtrEnd: w2LiqAtrEnd,
        recAtrStart: w2RecAtrStart,
        recAtrEnd: w2RecAtrEnd,
        priceProgressATRPer1M: w2Efficiency,
        sweptW1Extreme: w2SweptW1,
      };
      w2vsW1 = {
        liqUsdRatio: cum > 0 ? w2cum / cum : null,
        adverseProgressATRRatio:
          adverseProgressATR !== null &&
          adverseProgressATR > 0 &&
          w2AdverseProgressATR !== null
            ? w2AdverseProgressATR / adverseProgressATR
            : null,
        efficiencyRatio:
          priceProgressATRPer1M !== null &&
          priceProgressATRPer1M > 0 &&
          w2Efficiency !== null
            ? w2Efficiency / priceProgressATRPer1M
            : null,
        failedToMakeNewExtreme: !w2SweptW1,
      };

      // ---- STEP 5: cost of waiting ----
      const canonical = seq.candidates.find(
        (c) => c.candidateIndex === seq.firstTrueReversalCandidateIndex,
      );
      const fav5mFinal = canonical?.outcomeLadder["5m"]?.favorablePct ?? null;
      const fav15mFinal = canonical?.outcomeLadder["15m"]?.favorablePct ?? null;
      const atMinute = (targetTs: number): number => {
        let maxFav = 0;
        for (const p of breathingPath) {
          const pt = p as {
            elapsedMsFromW1End: number;
            favorableRecoveryATR: number;
          };
          if (w1EndTs + pt.elapsedMsFromW1End <= targetTs)
            maxFav = Math.max(maxFav, pt.favorableRecoveryATR);
        }
        return maxFav;
      };
      const favAtW2StartATR = atMinute(w2StartTsV);
      const favAtW2EndATR = atMinute(w2EndTsV);
      // convert ATR-based recovery-so-far to a % comparable to favorable5m/15m (both expressed relative to W1 extreme, using w1LiqAtr and startPrice as the common scale)
      const favAtW2StartPct = w1LiqAtr
        ? ((favAtW2StartATR * w1LiqAtr) / extreme) * 100
        : null;
      const favAtW2EndPct = w1LiqAtr
        ? ((favAtW2EndATR * w1LiqAtr) / extreme) * 100
        : null;
      costOfWaiting = {
        favorableRecoveryAtW2StartATR: favAtW2StartATR,
        favorableRecoveryAtW2EndATR: favAtW2EndATR,
        favorableRecoveryAtW2StartPct: favAtW2StartPct,
        favorableRecoveryAtW2EndPct: favAtW2EndPct,
        fractionOf5mMoveAlreadyGoneAtW2Start:
          fav5mFinal && fav5mFinal > 0 && favAtW2StartPct !== null
            ? favAtW2StartPct / fav5mFinal
            : null,
        fractionOf5mMoveAlreadyGoneAtW2End:
          fav5mFinal && fav5mFinal > 0 && favAtW2EndPct !== null
            ? favAtW2EndPct / fav5mFinal
            : null,
        fractionOf15mMoveAlreadyGoneAtW2Start:
          fav15mFinal && fav15mFinal > 0 && favAtW2StartPct !== null
            ? favAtW2StartPct / fav15mFinal
            : null,
        fractionOf15mMoveAlreadyGoneAtW2End:
          fav15mFinal && fav15mFinal > 0 && favAtW2EndPct !== null
            ? favAtW2EndPct / fav15mFinal
            : null,
      };
    } else {
      w1OnlyCount++;
    }

    const w1OnlyMilestones =
      remainingEvents.length === 0
        ? {
            timeToRecovery025Ms: recovery025,
            timeToRecovery050Ms: recovery050,
            timeToRecovery075Ms: recovery075,
            timeToRecovery100Ms: recovery100,
            w1ExtremeBroken,
            w1ExtremeBreakATR,
          }
        : null;

    episodes.push({
      sequenceId: seq.sequenceId,
      symbol: seq.symbol,
      victim: seq.victim,
      possibleW1Boundaries,
      primaryBoundaryUsed: primaryBoundary,
      w1,
      historicalContext,
      breathingPath,
      w2,
      w2vsW1,
      costOfWaiting,
      w1OnlyMilestones,
      hasW2: remainingEvents.length > 0,
    });

    csvRows.push({
      sequenceId: seq.sequenceId,
      symbol: seq.symbol,
      victim: seq.victim,
      hasW2: remainingEvents.length > 0,
      w1EventCount: w1Events.length,
      w1CumulativeLiqUsd: cum,
      w1AdverseProgressATR: adverseProgressATR,
      w1LiqAtrChangePct: w1.liqAtrChangePct,
      w1RecoveryAtrChangePct: w1.recoveryAtrChangePct,
      timeFromW1EndToW2StartMs: w2
        ? (w2 as { timeFromW1EndMs: number }).timeFromW1EndMs
        : null,
      fractionOf5mMoveGoneAtW2Start: costOfWaiting
        ? (
            costOfWaiting as {
              fractionOf5mMoveAlreadyGoneAtW2Start: number | null;
            }
          ).fractionOf5mMoveAlreadyGoneAtW2Start
        : null,
      timeToRecovery050Ms: w1OnlyMilestones
        ? w1OnlyMilestones.timeToRecovery050Ms
        : null,
    });
  }

  // ---- validation ----
  console.log(`\nEpisode count: ${episodes.length}`);
  console.log(`W1-only count: ${w1OnlyCount}`);
  console.log(`W1->W2 count: ${w1w2Count}`);
  const validationPass = episodes.length === w1OnlyCount + w1w2Count;

  const outPathJson = `/mnt/data/w1-w2-breathing-study-3d-${Date.now()}.json`;
  fs.writeFileSync(
    outPathJson,
    JSON.stringify({
      methodology: {
        note: "W1 boundary = split point with maximum gapRatio within each sequence's own event cadence (not a fixed timeout). All possible split points preserved per episode in possibleW1Boundaries. ATR reuses DirectionalAtrTracker unchanged. Future outcome (favorable5m/15m) used only in costOfWaiting, never to define W1/W2 boundaries.",
        knownLimitation_costOfWaitingReferenceFrame:
          "costOfWaiting's favorableRecoveryAtW2Start/EndPct is computed in W1's OWN reference frame (W1's adverse extreme price and W1-end liquidation-direction ATR), then divided by favorable5m/favorable15m, which were computed by the master pipeline in the CANONICAL reversal candidate's own reference frame (its own currentPrice/currentLiqDirAtr, which can differ from W1's if the sequence developed further before reversing). This mismatch can push the fraction fields above 1.0 in a way that reflects the reference-frame difference, not necessarily 'more than 100% of the move already happened'. Treat costOfWaiting fractions as directional/comparative signals across episodes, not as calibrated absolute percentages, until a follow-up pass recomputes favorable5m/15m relative to W1's own extreme specifically.",
      },
      episodeCount: episodes.length,
      w1OnlyCount,
      w1w2Count,
      episodes,
    }),
  );

  const csvHeaders = Object.keys(csvRows[0] ?? {});
  const csvLines = [
    csvHeaders.join(","),
    ...csvRows.map((row) => csvHeaders.map((h) => csvEscape(row[h])).join(",")),
  ];
  const outPathCsv = `/mnt/data/w1-w2-breathing-study-summary-3d-${Date.now()}.csv`;
  fs.writeFileSync(outPathCsv, csvLines.join("\n"));

  console.log(`\nOutput JSON: ${outPathJson}`);
  console.log(`Output CSV: ${outPathCsv}`);
  console.log(`Validation: ${validationPass ? "PASS" : "FAIL"}`);
}

main();
