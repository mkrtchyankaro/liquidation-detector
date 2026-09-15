import * as fs from "fs";
import type { Side, Liquidation, Candle } from "../src/shared/common.types";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import {
  causalPercentileFamily,
  percentileRank,
  reconstructCausalEpisodeTotals,
  durationMatchedSeries,
  LOOKBACK_WINDOWS_MS,
  percentile,
} from "./build-real-reversal-causal-history";

/**
 * Sep 14 2026 (Karo), operator-requested. RESET of the episode
 * segmentation layer -- pure chronological reconstruction of
 * directional liquidation bursts and possible inter-burst links from
 * the raw event stream. Does NOT use the earlier W1/W2 breathing-
 * study segmentation, does NOT use REAL_REVERSAL/CONTINUATION/
 * FAILED_REVERSAL labels, does NOT force a single higher-level
 * episode segmentation. Pure local read of the frozen master dataset
 * -- no Mongo, no Binance.
 *
 *   tsx scripts/reconstruct-neutral-liquidation-episodes.ts --input=/mnt/data/liquidation-master-6d-FINAL-v2-<ts>.json
 *
 * TWO DIFFERENT "THRESHOLDS" IN THIS SCRIPT, BOTH EXPLICIT, NEITHER
 * SILENT:
 *
 * 1. BURST_SPLIT_GAP_RATIO_BAR (=2): used only to group RAW EVENTS
 *    into dense same-side "bursts" (Step 4) -- reuses the exact same
 *    self-relative "is this gap a real outlier vs this stream's own
 *    recent cadence" criterion already built and validated in
 *    w1-w2-breathing-study.ts, for methodological consistency. This
 *    is a burst-formation heuristic, not a claim about episode
 *    structure.
 *
 * 2. Descriptive very-close/close/medium/far labels on LINKS (Step
 *    6) are NOT a fixed threshold at all -- they are quartile
 *    boundaries (P25/P50/P75) of the ACTUAL observed gapMs
 *    distribution across all same-side burst-to-burst links,
 *    computed only after every link is built, and the exact boundary
 *    values are printed and stored in the output so the derivation
 *    is fully inspectable, never assumed.
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
const BURST_SPLIT_GAP_RATIO_BAR = 2;

function median(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}
function pctl(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sorted[lo]!
    : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
function gapDistribution(
  values: readonly number[],
): Record<string, number | null> {
  const s = [...values].sort((a, b) => a - b);
  return {
    count: s.length,
    p10: pctl(s, 0.1),
    p25: pctl(s, 0.25),
    p50: pctl(s, 0.5),
    p75: pctl(s, 0.75),
    p90: pctl(s, 0.9),
    p95: pctl(s, 0.95),
    p975: pctl(s, 0.975),
    p99: pctl(s, 0.99),
  } as unknown as Record<string, number | null>;
}
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

interface RawEventRow {
  globalIndex: number;
  timestamp: number;
  symbol: string;
  victim: Side;
  price: number;
  quoteQty: number;
  gapFromPrevAnyMs: number | null;
  gapFromPrevSameMs: number | null;
  gapFromPrevOppositeMs: number | null;
}
interface Burst {
  burstId: string;
  symbol: string;
  victim: Side;
  startTs: number;
  endTs: number;
  eventGlobalIndexes: number[];
  eventCount: number;
  cumulativeLiqUsd: number;
  maxSingleLiqUsd: number;
  adverseExtremePrice: number;
  startPrice: number;
}

function parseArgs(argv: string[]): { inputPath: string } {
  const hit = argv.find((a) => a.startsWith("--input="));
  if (!hit) {
    console.error(
      "Usage: reconstruct-neutral-liquidation-episodes.ts --input=/path/to/liquidation-master-6d-FINAL-v2-<ts>.json",
    );
    process.exit(1);
  }
  return { inputPath: hit.slice("--input=".length) };
}

function main(): void {
  const { inputPath } = parseArgs(process.argv.slice(2));
  const master: Master = JSON.parse(fs.readFileSync(inputPath, "utf8"));

  let totalRawEvents = 0;
  const allEventRows: RawEventRow[] = [];
  const burstsBySymbolVictim = new Map<string, Burst[]>();
  const candlesBySymbol = new Map<string, CausalCandle[]>();

  for (const symbol of SYMBOLS) {
    const rawEvents = master.rawData.liquidations[symbol] ?? [];
    const sorted = [...rawEvents].sort((a, b) => a.timestamp - b.timestamp);
    totalRawEvents += sorted.length;
    candlesBySymbol.set(
      symbol,
      (master.rawData.candles[symbol] ?? []).map((c) => ({
        symbol,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        isClosed: true as const,
      })),
    );

    let lastAnyTs: number | null = null;
    const lastSameTs: Record<Side, number | null> = { LONG: null, SHORT: null };
    const lastOppositeTs: Record<Side, number | null> = {
      LONG: null,
      SHORT: null,
    };

    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i]!;
      const victim: Side = ev.side === "SELL" ? "LONG" : "SHORT";
      const opposite: Side = victim === "LONG" ? "SHORT" : "LONG";
      const row: RawEventRow = {
        globalIndex: i,
        timestamp: ev.timestamp,
        symbol,
        victim,
        price: ev.price,
        quoteQty: ev.quoteQty,
        gapFromPrevAnyMs: lastAnyTs !== null ? ev.timestamp - lastAnyTs : null,
        gapFromPrevSameMs:
          lastSameTs[victim] !== null
            ? ev.timestamp - lastSameTs[victim]!
            : null,
        gapFromPrevOppositeMs:
          lastOppositeTs[opposite] !== null
            ? ev.timestamp - lastOppositeTs[opposite]!
            : null,
      };
      allEventRows.push(row);
      lastAnyTs = ev.timestamp;
      lastSameTs[victim] = ev.timestamp;
      lastOppositeTs[victim] = ev.timestamp;
    }

    for (const victim of ["LONG", "SHORT"] as const) {
      const sameEvents = sorted
        .map((e, idx) => ({ e, globalIndex: idx }))
        .filter(({ e }) => (e.side === "SELL" ? "LONG" : "SHORT") === victim);
      if (sameEvents.length === 0) {
        burstsBySymbolVictim.set(`${symbol}|${victim}`, []);
        continue;
      }
      const bursts: Burst[] = [];
      let current: { e: Liquidation; globalIndex: number }[] = [sameEvents[0]!];
      let burstCounter = 0;
      const finalizeBurst = (): void => {
        const events = current.map((x) => x.e);
        const startPrice = events[0]!.price;
        let extreme = startPrice,
          cum = 0,
          maxSingle = 0;
        for (const ev of events) {
          cum += ev.quoteQty;
          maxSingle = Math.max(maxSingle, ev.quoteQty);
          extreme =
            victim === "LONG"
              ? Math.min(extreme, ev.price)
              : Math.max(extreme, ev.price);
        }
        bursts.push({
          burstId: `${symbol}-${victim}-burst-${burstCounter++}`,
          symbol,
          victim,
          startTs: events[0]!.timestamp,
          endTs: events[events.length - 1]!.timestamp,
          eventGlobalIndexes: current.map((x) => x.globalIndex),
          eventCount: events.length,
          cumulativeLiqUsd: cum,
          maxSingleLiqUsd: maxSingle,
          adverseExtremePrice: extreme,
          startPrice,
        });
      };
      for (let i = 1; i < sameEvents.length; i++) {
        const gap = sameEvents[i]!.e.timestamp - sameEvents[i - 1]!.e.timestamp;
        const recentGaps: number[] = [];
        for (
          let k = Math.max(0, current.length - 4);
          k < current.length - 1;
          k++
        )
          recentGaps.push(
            current[k + 1]!.e.timestamp - current[k]!.e.timestamp,
          );
        const typical = median(recentGaps);
        const gapRatio = typical !== null && typical > 0 ? gap / typical : null;
        if (gapRatio !== null && gapRatio >= BURST_SPLIT_GAP_RATIO_BAR) {
          finalizeBurst();
          current = [sameEvents[i]!];
        } else {
          current.push(sameEvents[i]!);
        }
      }
      finalizeBurst();
      burstsBySymbolVictim.set(`${symbol}|${victim}`, bursts);
    }
  }

  console.log(`Total raw events: ${totalRawEvents}`);
  const totalBursts = [...burstsBySymbolVictim.values()].reduce(
    (s, b) => s + b.length,
    0,
  );
  console.log(`Total same-side bursts: ${totalBursts}`);

  interface LinkRow {
    symbol: string;
    victim: Side;
    burstAId: string;
    burstBId: string;
    aEndTs: number;
    bStartTs: number;
    gapMs: number;
    flow: Record<string, unknown>;
    priceDuringGap: Record<string, unknown>;
    atr: Record<string, unknown>;
    oppositeFlow: Record<string, unknown>;
    historicalContextAtAEnd: Record<string, unknown>;
  }
  const links: LinkRow[] = [];

  for (const symbol of SYMBOLS) {
    const rawEvents = master.rawData.liquidations[symbol] ?? [];
    const candles = candlesBySymbol.get(symbol) ?? [];
    for (const victim of ["LONG", "SHORT"] as const) {
      const bursts = burstsBySymbolVictim.get(`${symbol}|${victim}`) ?? [];
      const allSameVictimEvents = rawEvents.filter(
        (e) => (e.side === "SELL" ? "LONG" : "SHORT") === victim,
      );
      const allSameVictimSeries = allSameVictimEvents.map((e) => ({
        timestamp: e.timestamp,
        value: e.quoteQty,
      }));
      const allOppositeEvents = rawEvents.filter(
        (e) => (e.side === "SELL" ? "LONG" : "SHORT") !== victim,
      );

      for (let i = 0; i < bursts.length - 1; i++) {
        const A = bursts[i]!,
          B = bursts[i + 1]!;
        const gapMs = B.startTs - A.endTs;

        const tracker = new DirectionalAtrTracker();
        let ci = 0;
        const feedTo = (ts: number): void => {
          while (ci < candles.length && candles[ci]!.openTime + 60_000 <= ts) {
            tracker.onCandle(candles[ci]!);
            ci++;
          }
        };
        feedTo(A.endTs);
        const liqAtrAtAEnd =
          victim === "LONG"
            ? tracker.getDownAtr(symbol)
            : tracker.getUpAtr(symbol);
        const recAtrAtAEnd =
          victim === "LONG"
            ? tracker.getUpAtr(symbol)
            : tracker.getDownAtr(symbol);
        feedTo(B.startTs);
        const liqAtrAtBStart =
          victim === "LONG"
            ? tracker.getDownAtr(symbol)
            : tracker.getUpAtr(symbol);
        const recAtrAtBStart =
          victim === "LONG"
            ? tracker.getUpAtr(symbol)
            : tracker.getDownAtr(symbol);

        let maxFavRecoveryPct = 0,
          maxFavRecoveryATR = 0,
          maxAdvExtPct = 0,
          maxAdvExtATR = 0,
          brokeExtreme = false;
        const startIdx = candles.findIndex((c) => c.openTime >= A.endTs);
        if (startIdx !== -1 && liqAtrAtAEnd && liqAtrAtAEnd > 0) {
          for (
            let idx = startIdx;
            idx < candles.length && candles[idx]!.openTime < B.startTs;
            idx++
          ) {
            const c = candles[idx]!;
            const favPrice = victim === "LONG" ? c.high : c.low;
            const advPrice = victim === "LONG" ? c.low : c.high;
            const favPct =
              victim === "LONG"
                ? Math.max(
                    0,
                    (favPrice - A.adverseExtremePrice) / A.adverseExtremePrice,
                  ) * 100
                : Math.max(
                    0,
                    (A.adverseExtremePrice - favPrice) / A.adverseExtremePrice,
                  ) * 100;
            const advPct =
              victim === "LONG"
                ? Math.max(
                    0,
                    (A.adverseExtremePrice - advPrice) / A.adverseExtremePrice,
                  ) * 100
                : Math.max(
                    0,
                    (advPrice - A.adverseExtremePrice) / A.adverseExtremePrice,
                  ) * 100;
            maxFavRecoveryPct = Math.max(maxFavRecoveryPct, favPct);
            maxAdvExtPct = Math.max(maxAdvExtPct, advPct);
            maxFavRecoveryATR = Math.max(
              maxFavRecoveryATR,
              ((favPct / 100) * A.adverseExtremePrice) / liqAtrAtAEnd,
            );
            maxAdvExtATR = Math.max(
              maxAdvExtATR,
              ((advPct / 100) * A.adverseExtremePrice) / liqAtrAtAEnd,
            );
            const broke =
              victim === "LONG"
                ? advPrice < A.adverseExtremePrice
                : advPrice > A.adverseExtremePrice;
            if (broke) brokeExtreme = true;
          }
        }

        const oppositeInGap = allOppositeEvents.filter(
          (e) => e.timestamp > A.endTs && e.timestamp < B.startTs,
        );

        const historicalContextAtAEnd: Record<string, unknown> = {};
        const episodesHist = reconstructCausalEpisodeTotals(
          allSameVictimEvents,
          A.endTs - 1,
        );
        const episodeSeries = episodesHist.map((e) => ({
          timestamp: e.episodeEndTs,
          value: e.cumulativeUsd,
        }));
        const durMatchedAtA = durationMatchedSeries(
          allSameVictimEvents,
          A.endTs,
          A.endTs - A.startTs,
        );
        for (const w of LOOKBACK_WINDOWS_MS.filter((x) => x.label !== "all")) {
          historicalContextAtAEnd[w.label] = {
            single: {
              family: causalPercentileFamily(
                allSameVictimSeries,
                A.endTs,
                w.ms,
              ),
              rank: percentileRank(
                allSameVictimSeries,
                A.endTs,
                w.ms,
                A.maxSingleLiqUsd,
              ),
            },
            episode: {
              family: causalPercentileFamily(episodeSeries, A.endTs, w.ms),
              rank: percentileRank(
                episodeSeries,
                A.endTs,
                w.ms,
                A.cumulativeLiqUsd,
              ),
            },
            durationMatched: {
              family: causalPercentileFamily(durMatchedAtA, A.endTs, w.ms),
              rank:
                A.endTs - A.startTs > 0
                  ? percentileRank(
                      durMatchedAtA,
                      A.endTs,
                      w.ms,
                      A.cumulativeLiqUsd,
                    )
                  : null,
            },
          };
        }

        links.push({
          symbol,
          victim,
          burstAId: A.burstId,
          burstBId: B.burstId,
          aEndTs: A.endTs,
          bStartTs: B.startTs,
          gapMs,
          flow: {
            aLiqUsd: A.cumulativeLiqUsd,
            bLiqUsd: B.cumulativeLiqUsd,
            bOverA:
              A.cumulativeLiqUsd > 0
                ? B.cumulativeLiqUsd / A.cumulativeLiqUsd
                : null,
          },
          priceDuringGap: {
            maxFavorableRecoveryPct: maxFavRecoveryPct,
            maxFavorableRecoveryATR: maxFavRecoveryATR,
            maxAdverseExtensionPct: maxAdvExtPct,
            maxAdverseExtensionATR: maxAdvExtATR,
            aExtremeBrokenBeforeB: brokeExtreme,
          },
          atr: {
            liqAtrAtAEnd,
            liqAtrAtBStart,
            recAtrAtAEnd,
            recAtrAtBStart,
            liqAtrChangePct:
              liqAtrAtAEnd && liqAtrAtAEnd > 0 && liqAtrAtBStart !== null
                ? ((liqAtrAtBStart - liqAtrAtAEnd) / liqAtrAtAEnd) * 100
                : null,
            recAtrChangePct:
              recAtrAtAEnd && recAtrAtAEnd > 0 && recAtrAtBStart !== null
                ? ((recAtrAtBStart - recAtrAtAEnd) / recAtrAtAEnd) * 100
                : null,
          },
          oppositeFlow: {
            count: oppositeInGap.length,
            totalUsd: oppositeInGap.reduce((s, e) => s + e.quoteQty, 0),
            maxSingleUsd:
              oppositeInGap.length > 0
                ? Math.max(...oppositeInGap.map((e) => e.quoteQty))
                : 0,
          },
          historicalContextAtAEnd,
        });
      }
    }
  }
  console.log(`Possible same-side burst links: ${links.length}`);

  const allGapMs = links.map((l) => l.gapMs);
  const overallDist = gapDistribution(allGapMs);
  console.log(
    `\nOverall same-side link gap distribution (ms): ${JSON.stringify(overallDist)}`,
  );
  const bySymbol: Record<string, ReturnType<typeof gapDistribution>> = {};
  for (const s of SYMBOLS)
    bySymbol[s] = gapDistribution(
      links.filter((l) => l.symbol === s).map((l) => l.gapMs),
    );
  const byVictim: Record<string, ReturnType<typeof gapDistribution>> = {};
  for (const v of ["LONG", "SHORT"] as const)
    byVictim[v] = gapDistribution(
      links.filter((l) => l.victim === v).map((l) => l.gapMs),
    );

  const sortedGaps = [...allGapMs].sort((a, b) => a - b);
  const p25 = percentile(sortedGaps, 0.25) ?? 0;
  const p50 = percentile(sortedGaps, 0.5) ?? 0;
  const p75 = percentile(sortedGaps, 0.75) ?? 0;
  console.log(
    `\nDescriptive label boundaries DERIVED from the overall gapMs distribution (not assumed): P25=${p25} P50=${p50} P75=${p75}`,
  );
  const labelFor = (gapMs: number): string =>
    gapMs <= p25
      ? "very close"
      : gapMs <= p50
        ? "close"
        : gapMs <= p75
          ? "medium"
          : "far";
  const linksWithLabels = links.map((l) => ({
    ...l,
    descriptiveProximity: labelFor(l.gapMs),
  }));

  const accountedFor = allEventRows.length;
  const validationPass = accountedFor === totalRawEvents;
  console.log(
    `\nRaw events accounted for in timeline: ${accountedFor} / ${totalRawEvents}`,
  );

  const outPathJson = `/mnt/data/neutral-liquidation-episode-links-6d-${Date.now()}.json`;
  fs.writeFileSync(
    outPathJson,
    JSON.stringify({
      methodology: {
        note: "Pure chronological reconstruction from raw liquidation events. No W1/W2 assumption, no REAL_REVERSAL/CONTINUATION/FAILED_REVERSAL label used anywhere in this file.",
        burstFormation: `Bursts split where gapRatio (gap / median of up to 4 preceding intra-burst gaps) >= ${BURST_SPLIT_GAP_RATIO_BAR}. This is a burst-formation heuristic (same self-relative method validated in w1-w2-breathing-study.ts), not a claim about higher-level episode structure -- higher-level linking between bursts is explicitly left open for descriptive gap-distribution labels only, never forced into a single segmentation.`,
        descriptiveLabelDerivation: `very close/close/medium/far = quartiles (P25/P50/P75) of the ACTUAL observed gapMs distribution across all ${links.length} same-side burst-to-burst links, computed AFTER all links were built. Boundaries used: P25=${p25}ms, P50=${p50}ms, P75=${p75}ms.`,
      },
      rawEventCount: totalRawEvents,
      burstCount: totalBursts,
      possibleLinkCount: links.length,
      gapDistribution: { overall: overallDist, bySymbol, byVictim },
      rawEventTimeline: allEventRows,
      bursts: Object.fromEntries([...burstsBySymbolVictim.entries()]),
      links: linksWithLabels,
      validation: {
        rawEventsAccountedFor: accountedFor,
        rawEventCount: totalRawEvents,
        pass: validationPass,
      },
    }),
  );

  const csvHeaders = [
    "symbol",
    "victim",
    "burstAId",
    "burstBId",
    "aEndTs",
    "bStartTs",
    "gapMs",
    "descriptiveProximity",
    "bOverA",
    "maxFavorableRecoveryATR",
    "maxAdverseExtensionATR",
    "aExtremeBrokenBeforeB",
    "liqAtrChangePct",
    "recAtrChangePct",
    "oppositeFlowCount",
    "oppositeFlowUsd",
  ];
  const csvRows = linksWithLabels.map((l) => [
    l.symbol,
    l.victim,
    l.burstAId,
    l.burstBId,
    l.aEndTs,
    l.bStartTs,
    l.gapMs,
    l.descriptiveProximity,
    (l.flow as { bOverA: number | null }).bOverA,
    (l.priceDuringGap as { maxFavorableRecoveryATR: number })
      .maxFavorableRecoveryATR,
    (l.priceDuringGap as { maxAdverseExtensionATR: number })
      .maxAdverseExtensionATR,
    (l.priceDuringGap as { aExtremeBrokenBeforeB: boolean })
      .aExtremeBrokenBeforeB,
    (l.atr as { liqAtrChangePct: number | null }).liqAtrChangePct,
    (l.atr as { recAtrChangePct: number | null }).recAtrChangePct,
    (l.oppositeFlow as { count: number }).count,
    (l.oppositeFlow as { totalUsd: number }).totalUsd,
  ]);
  const outPathCsv = `/mnt/data/neutral-liquidation-episode-links-summary-6d-${Date.now()}.csv`;
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
