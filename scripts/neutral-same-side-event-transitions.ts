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
 * Sep 14 2026 (Karo), operator-requested. Replaces the burst-based
 * reconstruction entirely -- the operator correctly rejected
 * BURST_SPLIT_GAP_RATIO_BAR=2 as an unproven segmentation rule. This
 * script performs NO grouping of any kind: every same-side liquidation
 * event A is linked directly to the NEXT same-side liquidation event
 * B of the same symbol+victim, however far apart, with zero judgment
 * about whether that gap is "small" or "large". Pure local read of
 * the frozen master dataset -- no Mongo, no Binance.
 *
 *   tsx scripts/neutral-same-side-event-transitions.ts --input=/mnt/data/liquidation-master-6d-FINAL-v2-<ts>.json
 *
 * By construction, a symbol+victim stream with N same-side events
 * produces exactly N-1 transitions -- no threshold, no cutoff, no
 * class label anywhere in this file.
 */

interface CausalCandle {
  symbol: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed: true;
}
interface Master {
  rawData: {
    liquidations: Record<string, Liquidation[]>;
    candles: Record<string, Candle[]>;
  };
}

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;

function pctl(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sorted[lo]!
    : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseArgs(argv: string[]): { inputPath: string } {
  const hit = argv.find((a) => a.startsWith("--input="));
  if (!hit) {
    console.error(
      "Usage: neutral-same-side-event-transitions.ts --input=/path/to/liquidation-master-6d-FINAL-v2-<ts>.json",
    );
    process.exit(1);
  }
  return { inputPath: hit.slice("--input=".length) };
}

function main(): void {
  const { inputPath } = parseArgs(process.argv.slice(2));
  const master: Master = JSON.parse(fs.readFileSync(inputPath, "utf8"));

  let totalRawEvents = 0;
  const rawTimeline: {
    globalIndex: number;
    timestamp: number;
    symbol: string;
    victim: Side;
    price: number;
    quoteQty: number;
  }[] = [];
  const transitions: Record<string, unknown>[] = [];
  const countByStream: Record<string, number> = {};
  const expectedByStream: Record<string, number> = {};

  for (const symbol of SYMBOLS) {
    const rawEvents = master.rawData.liquidations[symbol] ?? [];
    const sorted = [...rawEvents].sort((a, b) => a.timestamp - b.timestamp);
    totalRawEvents += sorted.length;
    const candles: CausalCandle[] = (master.rawData.candles[symbol] ?? []).map(
      (c) => ({
        symbol,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        isClosed: true as const,
      }),
    );

    sorted.forEach((e, idx) => {
      rawTimeline.push({
        globalIndex: idx,
        timestamp: e.timestamp,
        symbol,
        victim: e.side === "SELL" ? "LONG" : "SHORT",
        price: e.price,
        quoteQty: e.quoteQty,
      });
    });

    for (const victim of ["LONG", "SHORT"] as const) {
      const sameEvents = sorted.filter(
        (e) => (e.side === "SELL" ? "LONG" : "SHORT") === victim,
      );
      const allOppositeEvents = sorted.filter(
        (e) => (e.side === "SELL" ? "LONG" : "SHORT") !== victim,
      );
      const streamKey = `${symbol}|${victim}`;
      expectedByStream[streamKey] = Math.max(0, sameEvents.length - 1);
      countByStream[streamKey] = 0;

      const allSameVictimSeries = sameEvents.map((e) => ({
        timestamp: e.timestamp,
        value: e.quoteQty,
      }));

      for (let i = 0; i < sameEvents.length - 1; i++) {
        const A = sameEvents[i]!,
          B = sameEvents[i + 1]!;
        const gapMs = B.timestamp - A.timestamp;
        const anySideBetween = sorted.filter(
          (e) => e.timestamp > A.timestamp && e.timestamp < B.timestamp,
        ).length;
        const oppositeBetween = allOppositeEvents.filter(
          (e) => e.timestamp > A.timestamp && e.timestamp < B.timestamp,
        );

        const tracker = new DirectionalAtrTracker();
        let ci = 0;
        const feedTo = (ts: number): void => {
          while (ci < candles.length && candles[ci]!.openTime + 60_000 <= ts) {
            tracker.onCandle(candles[ci]!);
            ci++;
          }
        };
        feedTo(A.timestamp);
        const liqAtrAtA =
          victim === "LONG"
            ? tracker.getDownAtr(symbol)
            : tracker.getUpAtr(symbol);
        const recAtrAtA =
          victim === "LONG"
            ? tracker.getUpAtr(symbol)
            : tracker.getDownAtr(symbol);
        feedTo(B.timestamp);
        const liqAtrAtB =
          victim === "LONG"
            ? tracker.getDownAtr(symbol)
            : tracker.getUpAtr(symbol);
        const recAtrAtB =
          victim === "LONG"
            ? tracker.getUpAtr(symbol)
            : tracker.getDownAtr(symbol);

        let maxFavPct = 0,
          maxFavATR = 0,
          maxAdvPct = 0,
          maxAdvATR = 0,
          brokeExtreme = false;
        let timeToMaxFavMs: number | null = null,
          timeToMaxAdvMs: number | null = null;
        const startIdx = candles.findIndex((c) => c.openTime >= A.timestamp);
        if (startIdx !== -1 && liqAtrAtA && liqAtrAtA > 0) {
          for (
            let idx = startIdx;
            idx < candles.length && candles[idx]!.openTime < B.timestamp;
            idx++
          ) {
            const c = candles[idx]!;
            const favPrice = victim === "LONG" ? c.high : c.low;
            const advPrice = victim === "LONG" ? c.low : c.high;
            const favPct =
              victim === "LONG"
                ? Math.max(0, (favPrice - A.price) / A.price) * 100
                : Math.max(0, (A.price - favPrice) / A.price) * 100;
            const advPct =
              victim === "LONG"
                ? Math.max(0, (A.price - advPrice) / A.price) * 100
                : Math.max(0, (advPrice - A.price) / A.price) * 100;
            if (favPct > maxFavPct) {
              maxFavPct = favPct;
              timeToMaxFavMs = c.openTime + 60_000 - A.timestamp;
            }
            if (advPct > maxAdvPct) {
              maxAdvPct = advPct;
              timeToMaxAdvMs = c.openTime + 60_000 - A.timestamp;
            }
            maxFavATR = Math.max(
              maxFavATR,
              ((favPct / 100) * A.price) / liqAtrAtA,
            );
            maxAdvATR = Math.max(
              maxAdvATR,
              ((advPct / 100) * A.price) / liqAtrAtA,
            );
            const broke =
              victim === "LONG" ? advPrice < A.price : advPrice > A.price;
            if (broke) brokeExtreme = true;
          }
        }

        const historicalContextAtA: Record<string, unknown> = {};
        const episodesHist = reconstructCausalEpisodeTotals(
          sameEvents,
          A.timestamp - 1,
        );
        const episodeSeries = episodesHist.map((e) => ({
          timestamp: e.episodeEndTs,
          value: e.cumulativeUsd,
        }));
        const durMatchedAtA = durationMatchedSeries(sameEvents, A.timestamp, 0);
        for (const w of LOOKBACK_WINDOWS_MS.filter((x) => x.label !== "all")) {
          historicalContextAtA[w.label] = {
            single: {
              family: causalPercentileFamily(
                allSameVictimSeries,
                A.timestamp,
                w.ms,
              ),
              rank: percentileRank(
                allSameVictimSeries,
                A.timestamp,
                w.ms,
                A.quoteQty,
              ),
            },
            episode: {
              family: causalPercentileFamily(episodeSeries, A.timestamp, w.ms),
              rank: null,
            },
            durationMatched: {
              family: causalPercentileFamily(durMatchedAtA, A.timestamp, w.ms),
              rank: null,
            },
          };
        }

        transitions.push({
          symbol,
          victim,
          A: {
            timestamp: A.timestamp,
            price: A.price,
            liquidationUsd: A.quoteQty,
          },
          B: {
            timestamp: B.timestamp,
            price: B.price,
            liquidationUsd: B.quoteQty,
          },
          gapMs,
          anySideEventsBetween: anySideBetween,
          oppositeFlow: {
            count: oppositeBetween.length,
            totalUsd: oppositeBetween.reduce((s, e) => s + e.quoteQty, 0),
            maxSingleUsd:
              oppositeBetween.length > 0
                ? Math.max(...oppositeBetween.map((e) => e.quoteQty))
                : 0,
            timestamps: oppositeBetween.map((e) => e.timestamp),
          },
          priceCandlePath: {
            maxFavorableRecoveryPct: maxFavPct,
            maxFavorableRecoveryATR: maxFavATR,
            maxAdverseExtensionPct: maxAdvPct,
            maxAdverseExtensionATR: maxAdvATR,
            aExtremeBroken: brokeExtreme,
            timeToMaxFavorableMs: timeToMaxFavMs,
            timeToMaxAdverseMs: timeToMaxAdvMs,
          },
          atr: {
            liqAtrAtA,
            liqAtrAtB,
            recAtrAtA,
            recAtrAtB,
            liqAtrChangePct:
              liqAtrAtA && liqAtrAtA > 0 && liqAtrAtB !== null
                ? ((liqAtrAtB - liqAtrAtA) / liqAtrAtA) * 100
                : null,
            recAtrChangePct:
              recAtrAtA && recAtrAtA > 0 && recAtrAtB !== null
                ? ((recAtrAtB - recAtrAtA) / recAtrAtA) * 100
                : null,
            recoveryVsLiquidationAtrRatioAtA:
              liqAtrAtA && liqAtrAtA > 0 && recAtrAtA !== null
                ? recAtrAtA / liqAtrAtA
                : null,
            recoveryVsLiquidationAtrRatioAtB:
              liqAtrAtB && liqAtrAtB > 0 && recAtrAtB !== null
                ? recAtrAtB / liqAtrAtB
                : null,
          },
          historicalContextAtA,
        });
        countByStream[streamKey]!++;
      }
    }
  }

  console.log(`Raw event count: ${totalRawEvents}`);
  console.log(`Transition count: ${transitions.length}`);
  console.log(`Count by symbol/victim: ${JSON.stringify(countByStream)}`);
  console.log(`Expected (N-1 per stream): ${JSON.stringify(expectedByStream)}`);

  const gapMsSorted = transitions
    .map((t) => (t as { gapMs: number }).gapMs)
    .sort((a, b) => a - b);
  const gapDist = {
    p10: pctl(gapMsSorted, 0.1),
    p25: pctl(gapMsSorted, 0.25),
    p50: pctl(gapMsSorted, 0.5),
    p75: pctl(gapMsSorted, 0.75),
    p90: pctl(gapMsSorted, 0.9),
    p95: pctl(gapMsSorted, 0.95),
    p975: pctl(gapMsSorted, 0.975),
    p99: pctl(gapMsSorted, 0.99),
  };
  console.log(`\ngapMs distribution: ${JSON.stringify(gapDist)}`);

  const streamCountMatch = Object.keys(expectedByStream).every(
    (k) => countByStream[k] === expectedByStream[k],
  );
  const rawEventsAccounted = rawTimeline.length === totalRawEvents;
  const validationPass = streamCountMatch && rawEventsAccounted;
  console.log(
    `\nStream transition counts match N-1: ${streamCountMatch ? "YES" : "NO"}`,
  );
  console.log(
    `Raw events accounted for: ${rawEventsAccounted ? "YES" : "NO"} (${rawTimeline.length}/${totalRawEvents})`,
  );

  const outPathJson = `/mnt/data/neutral-same-side-event-transitions-6d-${Date.now()}.json`;
  fs.writeFileSync(
    outPathJson,
    JSON.stringify({
      methodology: {
        note: "Pure A -> next-same-side-B transition table. No burst, wave, episode, gapRatio cutoff, semantic proximity class, or REAL/FAILED/CONTINUATION label anywhere in this file. Every same-side event links to exactly its own next same-side event, regardless of distance.",
      },
      rawEventCount: totalRawEvents,
      transitionCount: transitions.length,
      countByStream,
      expectedByStream,
      gapMsDistribution: gapDist,
      rawTimeline,
      transitions,
      validation: {
        streamCountMatch,
        rawEventsAccounted,
        pass: validationPass,
      },
    }),
  );

  const csvHeaders = [
    "symbol",
    "victim",
    "aTimestamp",
    "aPrice",
    "aLiquidationUsd",
    "bTimestamp",
    "bPrice",
    "bLiquidationUsd",
    "gapMs",
    "anySideEventsBetween",
    "oppositeCount",
    "oppositeTotalUsd",
    "maxFavorableRecoveryATR",
    "maxAdverseExtensionATR",
    "aExtremeBroken",
    "liqAtrChangePct",
    "recAtrChangePct",
  ];
  const csvRows = transitions.map((t) => {
    const tt = t as {
      symbol: string;
      victim: string;
      A: { timestamp: number; price: number; liquidationUsd: number };
      B: { timestamp: number; price: number; liquidationUsd: number };
      gapMs: number;
      anySideEventsBetween: number;
      oppositeFlow: { count: number; totalUsd: number };
      priceCandlePath: {
        maxFavorableRecoveryATR: number;
        maxAdverseExtensionATR: number;
        aExtremeBroken: boolean;
      };
      atr: { liqAtrChangePct: number | null; recAtrChangePct: number | null };
    };
    return [
      tt.symbol,
      tt.victim,
      tt.A.timestamp,
      tt.A.price,
      tt.A.liquidationUsd,
      tt.B.timestamp,
      tt.B.price,
      tt.B.liquidationUsd,
      tt.gapMs,
      tt.anySideEventsBetween,
      tt.oppositeFlow.count,
      tt.oppositeFlow.totalUsd,
      tt.priceCandlePath.maxFavorableRecoveryATR,
      tt.priceCandlePath.maxAdverseExtensionATR,
      tt.priceCandlePath.aExtremeBroken,
      tt.atr.liqAtrChangePct,
      tt.atr.recAtrChangePct,
    ];
  });
  const outPathCsv = `/mnt/data/neutral-same-side-event-transitions-6d-${Date.now()}.csv`;
  fs.writeFileSync(
    outPathCsv,
    [
      csvHeaders.join(","),
      ...csvRows.map((row) => row.map(csvEscape).join(",")),
    ].join("\n"),
  );

  console.log(`\nOutput JSON: ${outPathJson}`);
  console.log(`Output CSV: ${outPathCsv}`);
  console.log(`Validation: ${validationPass ? "PASS" : "FAIL"}`);
}

main();
