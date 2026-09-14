import "dotenv/config";
import * as fs from "fs";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import { loadBinanceConfig } from "../src/infrastructure/config/binance.config";
import { BinanceRestClient } from "../src/infrastructure/binance/binanceRest.client";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import type { Side, Liquidation } from "../src/shared/common.types";

/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY exploratory
 * research -- writes NOTHING to any production collection, never
 * touches CandlePhysicsEngine/rotation_episode_history/v5_global_signals.
 * Deliberately does NOT assume the current ROTATION rules (15deg,
 * ShockATR>=10, rotationForce>=0.30, P95, 0.30%/0.60%) are correct --
 * those are computed here only as comparison features on the finished
 * dataset, never as sample/label definitions.
 *
 *   tsx scripts/research-liquidation-market-response.ts
 *
 * CAUSALITY: every candidate's own features (cumulative USD, event
 * count, cadence, price-at-end, directional ATR AS OF that instant)
 * use ONLY data at or before the candidate's own endpoint timestamp.
 * Forward response (MFE/MAE per horizon) is computed from candles
 * STRICTLY AFTER the candidate endpoint -- never mixed into the
 * causal feature set, always kept in a separate `response` object.
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const DAYS_BACK = 3;
const HORIZONS_MIN = [1, 2, 3, 5, 10, 15, 30];
const GAP_BUCKETS_MIN = [1, 2, 3, 5, 10, 15, 30];

interface HistoricalCandle {
  symbol: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed: true;
}

interface CandidateResponse {
  horizonMin: number;
  mfePct: number;
  maePct: number;
  mfeAtrNorm: number | null;
  maeAtrNorm: number | null;
}

interface Candidate {
  symbol: string;
  victim: Side;
  sequenceId: string;
  candidateIndex: number; // 1 = L1, 2 = L1+L2, ...
  // ---- causal features (computable at candidateEndTs, no lookahead) ----
  candidateStartTs: number;
  candidateEndTs: number;
  candidateStartPrice: number;
  candidateEndPrice: number;
  latestExtremePrice: number; // furthest price in the liquidation direction seen so far in this sequence
  cumulativeLiqUsd: number;
  eventCount: number;
  maxSingleLiqUsd: number;
  maxSingleOverCumulative: number;
  durationMs: number;
  avgEventSpacingMs: number;
  medianEventSpacingMs: number;
  lastEventUsd: number;
  liqAmountTrend: "increasing" | "decreasing" | "flat" | "n/a"; // last event vs first event size
  preLiqDirAtr: number | null; // directional ATR in the LIQUIDATION direction, as of just before this sequence started
  preRecDirAtr: number | null; // directional ATR in the RECOVERY direction, as of just before this sequence started
  currentDirAtr: number | null; // directional ATR in the liquidation direction, as of candidateEndTs
  currentRecAtr: number | null;
  // ---- comparison-only features (current production rules, NEVER used to define samples) ----
  comparisonRotationDegApprox: number | null;
  comparisonShockAtrApprox: number | null;
  // ---- future outcome labels (NEVER causal, NEVER usable as live features) ----
  response: CandidateResponse[];
  bestMfePct: number; // best MFE across all horizons, for ranking
  worstMaePct: number;
}

interface GapRecord {
  symbol: string;
  victim: Side;
  gapMs: number;
  priceMovedFavorablyBeforeNext: boolean;
  oppositeSideEventOccurredDuringGap: boolean;
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

async function fetchLiquidations(
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

/** Causal price lookup: the candle CLOSE of the last fully-closed
 *  candle strictly before `ts`. Never the candle containing `ts`
 *  itself (that candle may not have closed yet at `ts`). */
function causalPriceAt(candles: HistoricalCandle[], ts: number): number | null {
  let lo = 0,
    hi = candles.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.openTime + 60_000 <= ts) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 ? candles[ans]!.close : null;
}

/** Forward response for one candidate: scans candles strictly AFTER
 *  candidateEndTs, up to horizonMin later, tracking the running
 *  favorable/adverse extremes. LONG victim: favorable=UP, adverse=DOWN.
 *  SHORT victim: favorable=DOWN, adverse=UP. */
function computeForwardResponse(
  candles: HistoricalCandle[],
  startIdx: number,
  endTs: number,
  startPrice: number,
  victim: Side,
  horizonMin: number,
  atrAtEnd: number | null,
): CandidateResponse {
  const horizonEndTs = endTs + horizonMin * 60_000;
  let favExtreme = startPrice;
  let advExtreme = startPrice;
  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i]!;
    if (c.openTime < endTs) continue; // strictly after candidate endpoint -- no lookahead into the candidate's own formation
    if (c.openTime + 60_000 > horizonEndTs) break;
    if (victim === "LONG") {
      if (c.high > favExtreme) favExtreme = c.high;
      if (c.low < advExtreme) advExtreme = c.low;
    } else {
      if (c.low < favExtreme) favExtreme = c.low;
      if (c.high > advExtreme) advExtreme = c.high;
    }
  }
  const mfePct =
    victim === "LONG"
      ? ((favExtreme - startPrice) / startPrice) * 100
      : ((startPrice - favExtreme) / startPrice) * 100;
  const maePct =
    victim === "LONG"
      ? ((advExtreme - startPrice) / startPrice) * 100
      : ((startPrice - advExtreme) / startPrice) * 100; // negative value = adverse continuation
  return {
    horizonMin,
    mfePct,
    maePct,
    mfeAtrNorm:
      atrAtEnd && atrAtEnd > 0
        ? Math.abs(favExtreme - startPrice) / atrAtEnd
        : null,
    maeAtrNorm:
      atrAtEnd && atrAtEnd > 0
        ? Math.abs(advExtreme - startPrice) / atrAtEnd
        : null,
  };
}

async function main(): Promise<void> {
  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) {
    console.error("MONGO_URI is not set -- cannot run this research script.");
    process.exit(1);
  }
  const mongo = new MongoClientWrapper(mongoCfg);
  const rest = new BinanceRestClient(loadBinanceConfig());

  const toMs = Date.now();
  const fromMs = toMs - DAYS_BACK * 24 * 60 * 60_000;
  // Forward response for the longest horizon (30min) needs candles
  // PAST toMs -- fetch a little extra so the last few candidates in
  // the window aren't artificially truncated.
  const candleToMs = toMs + 35 * 60_000;

  console.log(
    `Liquidation market-response research: ${new Date(fromMs).toISOString()} -> ${new Date(toMs).toISOString()}`,
  );
  console.log(`Symbols: ${SYMBOLS.join(", ")}\n`);

  const dataQuality: Record<
    string,
    {
      rawEvents: number;
      longCount: number;
      shortCount: number;
      candleCount: number;
      missingCandleWarning: boolean;
    }
  > = {};
  const allCandidates: Candidate[] = [];
  const allGaps: GapRecord[] = [];

  for (const symbol of SYMBOLS) {
    console.log(`--- ${symbol} ---`);
    const liquidations = await fetchLiquidations(mongo, symbol, fromMs, toMs);
    const candles = await fetchHistoricalCandles(
      rest,
      symbol,
      fromMs,
      candleToMs,
    );
    candles.sort((a, b) => a.openTime - b.openTime);
    liquidations.sort((a, b) => a.timestamp - b.timestamp); // ORDER IS PART OF THE RESEARCH -- explicit chronological sort, never trusted implicitly

    const longCount = liquidations.filter((l) => l.side === "SELL").length;
    const shortCount = liquidations.filter((l) => l.side === "BUY").length;
    const expectedCandles = Math.floor((candleToMs - fromMs) / 60_000);
    const missingCandleWarning = candles.length < expectedCandles * 0.95;
    dataQuality[symbol] = {
      rawEvents: liquidations.length,
      longCount,
      shortCount,
      candleCount: candles.length,
      missingCandleWarning,
    };
    console.log(
      `  raw events: ${liquidations.length} (LONG=${longCount}, SHORT=${shortCount}), candles: ${candles.length}${missingCandleWarning ? " -- WARNING: candle coverage looks incomplete" : ""}`,
    );

    const directionalAtr = new DirectionalAtrTracker();
    let candleCursor = 0;
    const feedAtrUpTo = (ts: number): void => {
      while (
        candleCursor < candles.length &&
        candles[candleCursor]!.openTime + 60_000 <= ts
      ) {
        directionalAtr.onCandle(candles[candleCursor]!);
        candleCursor++;
      }
    };

    // ---- Build direction-aware same-side sequences (hard separator on victim flip) ----
    let seqIdCounter = 0;
    let i = 0;
    while (i < liquidations.length) {
      const victim: Side = liquidations[i]!.side === "SELL" ? "LONG" : "SHORT";
      const runStart = i;
      let j = i;
      while (
        j < liquidations.length &&
        (liquidations[j]!.side === "SELL" ? "LONG" : "SHORT") === victim
      )
        j++;
      const run = liquidations.slice(runStart, j);

      // gap analysis within this run (item B)
      for (let k = 1; k < run.length; k++) {
        const gapMs = run[k]!.timestamp - run[k - 1]!.timestamp;
        const priceBefore = run[k - 1]!.price;
        const priceAtNext = run[k]!.price;
        const movedFavorably =
          victim === "LONG"
            ? priceAtNext > priceBefore
            : priceAtNext < priceBefore;
        allGaps.push({
          symbol,
          victim,
          gapMs,
          priceMovedFavorablyBeforeNext: movedFavorably,
          oppositeSideEventOccurredDuringGap: false,
        });
      }

      // freeze pre-liquidation directional ATR baseline, causally, before this run's first event
      feedAtrUpTo(run[0]!.timestamp);
      const preLiqDirAtr =
        victim === "LONG"
          ? directionalAtr.getDownAtr(symbol)
          : directionalAtr.getUpAtr(symbol);
      const preRecDirAtr =
        victim === "LONG"
          ? directionalAtr.getUpAtr(symbol)
          : directionalAtr.getDownAtr(symbol);
      const sequenceId = `${symbol}-${victim}-${seqIdCounter++}`;

      let cumulativeLiqUsd = 0;
      let maxSingleLiqUsd = 0;
      let latestExtremePrice = run[0]!.price;
      const startPrice = run[0]!.price;
      const startTs = run[0]!.timestamp;

      for (let idx = 0; idx < run.length; idx++) {
        const ev = run[idx]!;
        cumulativeLiqUsd += ev.quoteQty;
        maxSingleLiqUsd = Math.max(maxSingleLiqUsd, ev.quoteQty);
        latestExtremePrice =
          victim === "LONG"
            ? Math.min(latestExtremePrice, ev.price)
            : Math.max(latestExtremePrice, ev.price);

        feedAtrUpTo(ev.timestamp);
        const currentDirAtr =
          victim === "LONG"
            ? directionalAtr.getDownAtr(symbol)
            : directionalAtr.getUpAtr(symbol);
        const currentRecAtr =
          victim === "LONG"
            ? directionalAtr.getUpAtr(symbol)
            : directionalAtr.getDownAtr(symbol);

        const spans = run.slice(0, idx + 1).map((e) => e.timestamp);
        const spacings: number[] = [];
        for (let s = 1; s < spans.length; s++)
          spacings.push(spans[s]! - spans[s - 1]!);
        const sortedSpacings = [...spacings].sort((a, b) => a - b);

        const firstUsd = run[0]!.quoteQty;
        const lastUsd = ev.quoteQty;
        const trend: Candidate["liqAmountTrend"] =
          idx === 0
            ? "n/a"
            : lastUsd > firstUsd * 1.1
              ? "increasing"
              : lastUsd < firstUsd * 0.9
                ? "decreasing"
                : "flat";

        // comparison-only approximations of current production rules -- NEVER used to define samples
        const theta =
          currentDirAtr !== null && currentRecAtr !== null
            ? Math.atan2(currentRecAtr, currentDirAtr) * (180 / Math.PI)
            : null;
        const thetaPre =
          preLiqDirAtr !== null && preRecDirAtr !== null && preLiqDirAtr > 0
            ? Math.atan2(preRecDirAtr, preLiqDirAtr) * (180 / Math.PI)
            : null;
        const rotationDegApprox =
          theta !== null && thetaPre !== null ? theta - thetaPre : null;
        const shockAtrApprox =
          preLiqDirAtr !== null && preLiqDirAtr > 0
            ? Math.abs(startPrice - latestExtremePrice) / preLiqDirAtr
            : null;

        const candidateEndTs = ev.timestamp;
        const candidateEndPrice = ev.price;

        const candleStartIdx = candles.findIndex(
          (c) => c.openTime + 60_000 > candidateEndTs,
        );
        const response: CandidateResponse[] = HORIZONS_MIN.map((h) =>
          computeForwardResponse(
            candles,
            candleStartIdx === -1 ? candles.length : candleStartIdx,
            candidateEndTs,
            candidateEndPrice,
            victim,
            h,
            currentDirAtr,
          ),
        );

        allCandidates.push({
          symbol,
          victim,
          sequenceId,
          candidateIndex: idx + 1,
          candidateStartTs: startTs,
          candidateEndTs,
          candidateStartPrice: startPrice,
          candidateEndPrice,
          latestExtremePrice,
          cumulativeLiqUsd,
          eventCount: idx + 1,
          maxSingleLiqUsd,
          maxSingleOverCumulative:
            cumulativeLiqUsd > 0 ? maxSingleLiqUsd / cumulativeLiqUsd : 0,
          durationMs: candidateEndTs - startTs,
          avgEventSpacingMs: mean(spacings) ?? 0,
          medianEventSpacingMs: percentile(sortedSpacings, 0.5) ?? 0,
          lastEventUsd: lastUsd,
          liqAmountTrend: trend,
          preLiqDirAtr,
          preRecDirAtr,
          currentDirAtr,
          currentRecAtr,
          comparisonRotationDegApprox: rotationDegApprox,
          comparisonShockAtrApprox: shockAtrApprox,
          response,
          bestMfePct: Math.max(...response.map((r) => r.mfePct)),
          worstMaePct: Math.min(...response.map((r) => r.maePct)),
        });
      }
      i = j;
    }
    console.log(
      `  candidates generated: ${allCandidates.filter((c) => c.symbol === symbol).length}\n`,
    );
  }

  // ---- B: event gap analysis ----
  console.log(
    "\n=== B. EVENT GAP ANALYSIS (same-side consecutive events) ===\n",
  );
  const gapSummary: Record<string, unknown> = {};
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const gaps = allGaps
        .filter((g) => g.symbol === symbol && g.victim === victim)
        .map((g) => g.gapMs);
      const sorted = [...gaps].sort((a, b) => a - b);
      const key = `${symbol}|${victim}`;
      const p = (q: number): number | null => percentile(sorted, q);
      const conditionalResume: Record<string, number> = {};
      for (const m of GAP_BUCKETS_MIN) {
        const withinBucket = gaps.filter((g) => g <= m * 60_000).length;
        conditionalResume[`within_${m}m`] =
          gaps.length > 0 ? withinBucket / gaps.length : 0;
      }
      gapSummary[key] = {
        count: gaps.length,
        p50Ms: p(0.5),
        p75Ms: p(0.75),
        p90Ms: p(0.9),
        p95Ms: p(0.95),
        p99Ms: p(0.99),
        conditionalResumeFraction: conditionalResume,
      };
      if (sorted.length > 5) {
        console.log(
          `${key}: n=${sorted.length} P50=${(p(0.5)! / 1000).toFixed(0)}s P90=${(p(0.9)! / 1000).toFixed(0)}s P95=${(p(0.95)! / 1000).toFixed(0)}s P99=${(p(0.99)! / 1000).toFixed(0)}s`,
        );
      }
    }
  }

  // ---- C: sequence/candidate stats ----
  const sequenceIds = new Set(allCandidates.map((c) => c.sequenceId));
  const seqLengths = [...sequenceIds].map(
    (sid) => allCandidates.filter((c) => c.sequenceId === sid).length,
  );
  console.log(`\n=== C. SEQUENCE / CANDIDATE STATS ===\n`);
  console.log(
    `Total sequences: ${sequenceIds.size}, total candidates: ${allCandidates.length}`,
  );
  console.log(
    `Sequence length: P50=${percentile(
      [...seqLengths].sort((a, b) => a - b),
      0.5,
    )} P90=${percentile(
      [...seqLengths].sort((a, b) => a - b),
      0.9,
    )} max=${Math.max(...seqLengths, 0)}`,
  );

  // ---- D: market response distributions ----
  console.log(
    `\n=== D. MARKET RESPONSE DISTRIBUTIONS (by symbol+victim, horizon=5m shown; full detail in JSON) ===\n`,
  );
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const group = allCandidates.filter(
        (c) => c.symbol === symbol && c.victim === victim,
      );
      const r5 = group
        .map((c) => c.response.find((r) => r.horizonMin === 5)!.mfePct)
        .sort((a, b) => a - b);
      if (r5.length < 5) continue;
      console.log(
        `${symbol} ${victim} (n=${group.length}): MFE@5m P50=${percentile(r5, 0.5)!.toFixed(3)}% P90=${percentile(r5, 0.9)!.toFixed(3)}%`,
      );
    }
  }

  // ---- E: reversal transition analysis ----
  console.log(
    `\n=== E. REVERSAL TRANSITION ANALYSIS (5m horizon, threshold-free: watching for a jump in MFE as candidateIndex grows) ===\n`,
  );
  let transitionCount = 0;
  for (const sid of sequenceIds) {
    const seq = allCandidates
      .filter((c) => c.sequenceId === sid)
      .sort((a, b) => a.candidateIndex - b.candidateIndex);
    for (let k = 1; k < seq.length; k++) {
      const prevMfe = seq[k - 1]!.response.find(
        (r) => r.horizonMin === 5,
      )!.mfePct;
      const curMfe = seq[k]!.response.find((r) => r.horizonMin === 5)!.mfePct;
      if (curMfe > prevMfe * 2 && curMfe - prevMfe > 0.2) transitionCount++;
    }
  }
  console.log(
    `Sharp MFE@5m transitions detected (>2x jump, >0.2pp absolute): ${transitionCount} out of ${allCandidates.length - sequenceIds.size} possible expansions`,
  );

  // ---- G: real examples ----
  const byBestMfe = [...allCandidates].sort(
    (a, b) => b.bestMfePct - a.bestMfePct,
  );
  const byWorstMae = [...allCandidates].sort(
    (a, b) => a.worstMaePct - b.worstMaePct,
  );
  console.log(`\n=== G. EXAMPLES ===\n`);
  console.log("Top 5 strongest reversal candidates overall (by bestMfePct):");
  for (const c of byBestMfe.slice(0, 5)) {
    console.log(
      `  ${c.symbol} ${c.victim} seq=${c.sequenceId} idx=${c.candidateIndex} endTs=${new Date(c.candidateEndTs).toISOString()} cumUsd=$${c.cumulativeLiqUsd.toFixed(0)} events=${c.eventCount} bestMFE=${c.bestMfePct.toFixed(3)}%`,
    );
  }
  console.log("\nTop 5 clearest continuation candidates (by worstMaePct):");
  for (const c of byWorstMae.slice(0, 5)) {
    console.log(
      `  ${c.symbol} ${c.victim} seq=${c.sequenceId} idx=${c.candidateIndex} endTs=${new Date(c.candidateEndTs).toISOString()} cumUsd=$${c.cumulativeLiqUsd.toFixed(0)} events=${c.eventCount} worstMAE=${c.worstMaePct.toFixed(3)}%`,
    );
  }

  // ---- persist full JSON ----
  const outPath = `/mnt/data/liquidation-market-response-3d-${Date.now()}.json`;
  const output = {
    generatedAt: new Date().toISOString(),
    windowFromMs: fromMs,
    windowToMs: toMs,
    dataQuality,
    gapSummary,
    sequenceStats: {
      totalSequences: sequenceIds.size,
      totalCandidates: allCandidates.length,
      sequenceLengths: seqLengths,
    },
    candidates: allCandidates,
  };
  try {
    fs.mkdirSync("/mnt/data", { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nFull dataset written to: ${outPath}`);
  } catch (err) {
    console.error(`Failed to write JSON output to ${outPath}:`, err);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[RESEARCH_LIQUIDATION_MARKET_RESPONSE_FATAL]", err);
  process.exit(1);
});
