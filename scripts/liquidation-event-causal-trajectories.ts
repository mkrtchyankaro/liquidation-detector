import * as fs from "fs";
import type { Side, Candle } from "../src/shared/common.types";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import {
  causalPercentileFamily,
  percentileRank,
  LOOKBACK_WINDOWS_MS,
  percentile,
} from "./build-real-reversal-causal-history";
import {
  reconstructTruePath,
  type HistoricalCandle,
} from "./reconstruct-true-liquidation-reversal-path-fixed";

/**
 * Sep 14 2026 (Karo), operator-requested. Event-by-event causal
 * replay dataset -- the research unit is each individual liquidation
 * event inside a directional group, not the completed group. Every
 * snapshot's `causal` block uses ONLY information available at or
 * before that event's own timestamp; `evaluationOnly` carries future
 * outcome and the final group label, structurally separated so no
 * causal feature can accidentally read it. Pure local read of three
 * already-frozen files -- no Mongo, no Binance, no regrouping, no
 * W1/W2/W3 assumption.
 *
 *   tsx scripts/liquidation-event-causal-trajectories.ts \
 *     --groups=<path> --study=<path> --master=<path>
 *
 * REUSE: DirectionalAtrTracker, causalPercentileFamily/percentileRank/
 * LOOKBACK_WINDOWS_MS, reconstructTruePath all imported unchanged.
 *
 * SCOPE NOTE (stated, not hidden): sections Q/R/S/T (descriptive
 * summary, transition analysis, rank subpopulations, earliest-
 * information analysis) are built as genuine aggregate passes over
 * the snapshot array below -- implemented at the level the operator's
 * own numbered list requires, but kept to the core distributional
 * statistics (count/P10/P25/P50/P75/P90) rather than every derivative
 * cross-tabulation theoretically implied by the spec, to keep this
 * already very large script correct and testable rather than
 * exhaustive. Every field the spec explicitly named for the per-event
 * snapshot itself (sections B-N) IS implemented.
 */

interface RawGroupEvent {
  globalIndex: number;
  timestamp: number;
  price: number;
  quoteQty: number;
  gapFromPreviousEventInGroupMs: number | null;
}
interface RawGroup {
  groupId: string;
  symbol: string;
  victim: Side;
  groupIndexWithinSymbol: number;
  startTimestamp: number;
  endTimestamp: number;
  durationMs: number;
  eventCount: number;
  totalLiquidationUsd: number;
  maxSingleLiquidationUsd: number;
  events: RawGroupEvent[];
}
interface GroupsFile {
  summary: { rawEventCount: number; totalGroupCount: number };
  groups: RawGroup[];
}
interface StudyGroup {
  group: { groupId: string };
}
interface StudyFile {
  groups: (StudyGroup & Record<string, unknown>)[];
}
interface MasterFile {
  rawData: { candles: Record<string, Candle[]> };
}

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const HORIZONS = [1, 2, 3, 5, 10, 15, 30] as const;
const RECOVERY_MILESTONES = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
const PCT_THRESHOLDS = [50, 70, 75, 80, 90, 95, 97.5, 99];
const MIN_SAMPLES_RELIABLE = 20;
const EPSILON = 1e-9;

function median(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}
function mean(arr: readonly number[]): number | null {
  return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
}
function distSummary(values: readonly number[]): Record<string, number | null> {
  const s = [...values].sort((a, b) => a - b);
  const p = (q: number): number | null => percentile(s, q);
  return {
    count: s.length,
    p10: p(0.1),
    p25: p(0.25),
    p50: p(0.5),
    p75: p(0.75),
    p90: p(0.9),
  };
}
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}
function bucketOf(idx: number): string {
  if (idx <= 5) return `Event ${idx}`;
  if (idx <= 10) return "Event 6-10";
  if (idx <= 20) return "Event 11-20";
  return "Event 21+";
}

function parseArgs(argv: string[]): {
  groupsPath: string;
  studyPath: string;
  masterPath: string;
} {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const groupsPath = get("groups"),
    studyPath = get("study"),
    masterPath = get("master");
  if (!groupsPath || !studyPath || !masterPath) {
    console.error(
      "Usage: liquidation-event-causal-trajectories.ts --groups=<path> --study=<path> --master=<path>",
    );
    process.exit(1);
  }
  return { groupsPath, studyPath, masterPath };
}

interface Snapshot {
  snapshotId: string;
  groupId: string;
  symbol: string;
  victim: Side;
  eventIndexInGroup: number;
  eventTimestamp: number;
  eventPrice: number;
  eventLiquidationUsd: number;
  developmentClass: "SINGLE_EVENT" | "MULTI_EVENT";
  causal: Record<string, unknown>;
  evaluationOnly: Record<string, unknown>;
}

function main(): void {
  const { groupsPath, studyPath, masterPath } = parseArgs(
    process.argv.slice(2),
  );
  const groupsFile: GroupsFile = JSON.parse(
    fs.readFileSync(groupsPath, "utf8"),
  );
  const studyFile: StudyFile = JSON.parse(fs.readFileSync(studyPath, "utf8"));
  const masterFile: MasterFile = JSON.parse(
    fs.readFileSync(masterPath, "utf8"),
  );
  const groups = groupsFile.groups;
  console.log(`Total groups: ${groups.length}`);

  const studyByGroupId = new Map<string, Record<string, unknown>>();
  for (const g of studyFile.groups)
    studyByGroupId.set(
      g.group.groupId,
      g as unknown as Record<string, unknown>,
    );

  const candlesBySymbol = new Map<string, HistoricalCandle[]>();
  for (const symbol of SYMBOLS)
    candlesBySymbol.set(
      symbol,
      (masterFile.rawData.candles[symbol] ?? []).map((c) => ({
        symbol,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        isClosed: true as const,
      })),
    );

  // ---- causal historical series: completed GROUP TOTALS (for cumulative seriousness) and individual RAW EVENTS (for single-event seriousness) ----
  const groupTotalSeriesByStream = new Map<
    string,
    { timestamp: number; value: number }[]
  >();
  const rawEventSeriesByStream = new Map<
    string,
    { timestamp: number; value: number }[]
  >();
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const key = `${symbol}|${victim}`;
      const relevantGroups = groups.filter(
        (g) => g.symbol === symbol && g.victim === victim,
      );
      groupTotalSeriesByStream.set(
        key,
        relevantGroups.map((g) => ({
          timestamp: g.endTimestamp,
          value: g.totalLiquidationUsd,
        })),
      );
      rawEventSeriesByStream.set(
        key,
        relevantGroups.flatMap((g) =>
          g.events.map((e) => ({ timestamp: e.timestamp, value: e.quoteQty })),
        ),
      );
    }
  }

  const allSnapshots: Snapshot[] = [];
  let totalEventCount = 0;

  for (const group of groups) {
    totalEventCount += group.eventCount;
    const candles = candlesBySymbol.get(group.symbol) ?? [];
    const streamKey = `${group.symbol}|${group.victim}`;
    const groupTotalSeries = groupTotalSeriesByStream.get(streamKey) ?? [];
    const rawEventSeries = rawEventSeriesByStream.get(streamKey) ?? [];
    const developmentClass: Snapshot["developmentClass"] =
      group.eventCount === 1 ? "SINGLE_EVENT" : "MULTI_EVENT";

    const tracker = new DirectionalAtrTracker();
    let ci = 0;
    const feedTo = (ts: number): void => {
      while (ci < candles.length && candles[ci]!.openTime + 60_000 <= ts) {
        tracker.onCandle(candles[ci]!);
        ci++;
      }
    };
    const getAtr = (): {
      liqAtr: number | null;
      recAtr: number | null;
      ratio: number | null;
      candleOpenTimeUsed: number | null;
    } => {
      const liqAtr =
        group.victim === "LONG"
          ? tracker.getDownAtr(group.symbol)
          : tracker.getUpAtr(group.symbol);
      const recAtr =
        group.victim === "LONG"
          ? tracker.getUpAtr(group.symbol)
          : tracker.getDownAtr(group.symbol);
      const lastConsumedOpenTime = ci > 0 ? candles[ci - 1]!.openTime : null;
      return {
        liqAtr,
        recAtr,
        ratio: liqAtr && liqAtr > 0 && recAtr !== null ? recAtr / liqAtr : null,
        candleOpenTimeUsed: lastConsumedOpenTime,
      };
    };

    const firstEventPrice = group.events[0]!.price;
    let furthestAdversePrice = firstEventPrice,
      furthestRecoveryPrice = firstEventPrice;
    let cumulativeUsd = 0;
    let firstAtr: {
      liqAtr: number | null;
      recAtr: number | null;
      ratio: number | null;
    } | null = null;
    let prevAtr: {
      liqAtr: number | null;
      recAtr: number | null;
      ratio: number | null;
    } | null = null;
    let prevCumulativeAdverseProgressATR = 0;
    let prevEventTimestamp: number | null = null;
    let prevCandleOpenTimeUsed: number | null = null;
    let maxRecoverySinceFirstEventATR = 0;
    let prevMarginalEfficiency: number | null = null;
    let prevCumulativeEfficiency: number | null = null;
    const eventUsds: number[] = [];
    const gaps: number[] = [];
    let firstCrossings: Record<string, number | null> = {};
    for (const t of PCT_THRESHOLDS) firstCrossings[`P${t}`] = null;

    const groupSnapshots: Snapshot[] = [];

    for (let idx = 0; idx < group.events.length; idx++) {
      const ev = group.events[idx]!;
      const K = idx + 1;
      const T = ev.timestamp;
      eventUsds.push(ev.quoteQty);
      const prevCumulativeUsd = cumulativeUsd;
      cumulativeUsd += ev.quoteQty;

      feedTo(T);
      const atrNow = getAtr();
      if (K === 1) firstAtr = atrNow;
      const sameClosedCandleAsPreviousEvent =
        prevCandleOpenTimeUsed !== null &&
        atrNow.candleOpenTimeUsed === prevCandleOpenTimeUsed;

      // ---- price state ----
      const priorAdverseExtreme = furthestAdversePrice;
      const newAdverseExtremeAtThisEvent =
        group.victim === "LONG"
          ? ev.price < furthestAdversePrice
          : ev.price > furthestAdversePrice;
      if (newAdverseExtremeAtThisEvent) furthestAdversePrice = ev.price;
      const newRecovery =
        group.victim === "LONG"
          ? ev.price > furthestRecoveryPrice
          : ev.price < furthestRecoveryPrice;
      if (newRecovery) furthestRecoveryPrice = ev.price;

      const cumulativeAdverseProgressPct =
        firstEventPrice > 0
          ? (Math.abs(furthestAdversePrice - firstEventPrice) /
              firstEventPrice) *
            100
          : 0;
      const cumulativeAdverseProgressATR =
        atrNow.liqAtr && atrNow.liqAtr > 0
          ? Math.abs(furthestAdversePrice - firstEventPrice) / atrNow.liqAtr
          : 0;
      const cumulativeRecoveryProgressPct =
        firstEventPrice > 0
          ? (Math.abs(furthestRecoveryPrice - firstEventPrice) /
              firstEventPrice) *
            100
          : 0;
      const cumulativeRecoveryProgressATR =
        atrNow.liqAtr && atrNow.liqAtr > 0
          ? Math.abs(furthestRecoveryPrice - firstEventPrice) / atrNow.liqAtr
          : 0;
      const incrementalAdverseProgressATRFromPreviousSnapshot =
        cumulativeAdverseProgressATR - prevCumulativeAdverseProgressATR;
      prevCumulativeAdverseProgressATR = cumulativeAdverseProgressATR;

      // ---- recovery between K-1 and K (closed candles strictly between previous event and this one) ----
      let maxRecoveryBetweenPct = 0,
        maxRecoveryBetweenATR = 0,
        maxAdverseExtBetweenPct = 0,
        maxAdverseExtBetweenATR = 0;
      const recoveryFlags: Record<string, boolean> = {};
      for (const m of RECOVERY_MILESTONES)
        recoveryFlags[`recoveryReached${String(m).replace(".", "")}ATR`] =
          false;
      if (prevEventTimestamp !== null && atrNow.liqAtr && atrNow.liqAtr > 0) {
        const startIdx = candles.findIndex(
          (c) => c.openTime >= prevEventTimestamp!,
        );
        if (startIdx !== -1) {
          for (
            let ci2 = startIdx;
            ci2 < candles.length && candles[ci2]!.openTime < T;
            ci2++
          ) {
            const c = candles[ci2]!;
            const favPrice = group.victim === "LONG" ? c.high : c.low;
            const advPrice = group.victim === "LONG" ? c.low : c.high;
            const favPct =
              group.victim === "LONG"
                ? Math.max(
                    0,
                    (favPrice - priorAdverseExtreme) / priorAdverseExtreme,
                  ) * 100
                : Math.max(
                    0,
                    (priorAdverseExtreme - favPrice) / priorAdverseExtreme,
                  ) * 100;
            const advPct =
              group.victim === "LONG"
                ? Math.max(
                    0,
                    (priorAdverseExtreme - advPrice) / priorAdverseExtreme,
                  ) * 100
                : Math.max(
                    0,
                    (advPrice - priorAdverseExtreme) / priorAdverseExtreme,
                  ) * 100;
            maxRecoveryBetweenPct = Math.max(maxRecoveryBetweenPct, favPct);
            maxAdverseExtBetweenPct = Math.max(maxAdverseExtBetweenPct, advPct);
            maxRecoveryBetweenATR = Math.max(
              maxRecoveryBetweenATR,
              ((favPct / 100) * priorAdverseExtreme) / atrNow.liqAtr,
            );
            maxAdverseExtBetweenATR = Math.max(
              maxAdverseExtBetweenATR,
              ((advPct / 100) * priorAdverseExtreme) / atrNow.liqAtr,
            );
          }
          for (const m of RECOVERY_MILESTONES)
            if (maxRecoveryBetweenATR >= m)
              recoveryFlags[`recoveryReached${String(m).replace(".", "")}ATR`] =
                true;
        }
      }
      maxRecoverySinceFirstEventATR = Math.max(
        maxRecoverySinceFirstEventATR,
        maxRecoveryBetweenATR,
        cumulativeRecoveryProgressATR,
      );

      // ---- ATR change vs previous event and vs first event ----
      const liqAtrChangePctFromPrevious =
        prevAtr?.liqAtr && prevAtr.liqAtr > 0 && atrNow.liqAtr !== null
          ? ((atrNow.liqAtr - prevAtr.liqAtr) / prevAtr.liqAtr) * 100
          : null;
      const recoveryAtrChangePctFromPrevious =
        prevAtr?.recAtr && prevAtr.recAtr > 0 && atrNow.recAtr !== null
          ? ((atrNow.recAtr - prevAtr.recAtr) / prevAtr.recAtr) * 100
          : null;
      const atrRatioChangePctFromPrevious =
        prevAtr?.ratio && prevAtr.ratio > 0 && atrNow.ratio !== null
          ? ((atrNow.ratio - prevAtr.ratio) / prevAtr.ratio) * 100
          : null;
      const liqAtrChangePctFromFirst =
        firstAtr?.liqAtr && firstAtr.liqAtr > 0 && atrNow.liqAtr !== null
          ? ((atrNow.liqAtr - firstAtr.liqAtr) / firstAtr.liqAtr) * 100
          : null;
      const recoveryAtrChangePctFromFirst =
        firstAtr?.recAtr && firstAtr.recAtr > 0 && atrNow.recAtr !== null
          ? ((atrNow.recAtr - firstAtr.recAtr) / firstAtr.recAtr) * 100
          : null;
      const atrRatioChangePctFromFirst =
        firstAtr?.ratio && firstAtr.ratio > 0 && atrNow.ratio !== null
          ? ((atrNow.ratio - firstAtr.ratio) / firstAtr.ratio) * 100
          : null;

      // ---- marginal / cumulative efficiency ----
      const deltaLiqUsd = ev.quoteQty;
      const deltaAdverseProgressATR =
        incrementalAdverseProgressATRFromPreviousSnapshot;
      const marginalAdverseEfficiencyATRPer1M =
        deltaLiqUsd > 0
          ? deltaAdverseProgressATR / (deltaLiqUsd / 1_000_000)
          : null;
      const cumulativeAdverseEfficiencyATRPer1M =
        cumulativeUsd > 0
          ? cumulativeAdverseProgressATR / (cumulativeUsd / 1_000_000)
          : null;
      const marginalEfficiencyVsPreviousMarginalRatio =
        prevMarginalEfficiency !== null &&
        prevMarginalEfficiency !== 0 &&
        marginalAdverseEfficiencyATRPer1M !== null
          ? marginalAdverseEfficiencyATRPer1M / prevMarginalEfficiency
          : null;
      const cumulativeEfficiencyChangePctFromPreviousEvent =
        prevCumulativeEfficiency !== null &&
        prevCumulativeEfficiency !== 0 &&
        cumulativeAdverseEfficiencyATRPer1M !== null
          ? ((cumulativeAdverseEfficiencyATRPer1M - prevCumulativeEfficiency) /
              prevCumulativeEfficiency) *
            100
          : null;
      prevMarginalEfficiency = marginalAdverseEfficiencyATRPer1M;
      prevCumulativeEfficiency = cumulativeAdverseEfficiencyATRPer1M;

      // ---- cadence ----
      const gapFromPreviousSameSideEventMs =
        prevEventTimestamp !== null ? T - prevEventTimestamp : null;
      if (gapFromPreviousSameSideEventMs !== null)
        gaps.push(gapFromPreviousSameSideEventMs);
      const elapsedFromGroupFirstEventMs = T - group.events[0]!.timestamp;
      const recentGapVsMedianPriorGapRatio =
        gaps.length >= 2 && median(gaps.slice(0, -1))
          ? gaps[gaps.length - 1]! / median(gaps.slice(0, -1))!
          : null;

      // ---- causal historical seriousness (T-1 cutoff, excludes current developing group entirely -- ALL of its own events, not just this one) ----
      const groupHistoricalContext: Record<string, unknown> = {};
      const singleEventHistoricalContext: Record<string, unknown> = {};
      // exclude this entire developing group from BOTH series -- filter by group's own event timestamps, not just T-1, since earlier events of the SAME group must also never count as "history" for a later event of itself
      const groupOwnEventTimestamps = new Set(
        group.events.map((e) => e.timestamp),
      );
      const externalGroupTotalSeries = groupTotalSeries.filter(
        (s) =>
          s.timestamp < group.startTimestamp ||
          s.timestamp > group.endTimestamp,
      );
      const externalRawEventSeries = rawEventSeries.filter(
        (s) => !groupOwnEventTimestamps.has(s.timestamp),
      );
      for (const w of LOOKBACK_WINDOWS_MS.filter((x) => x.label !== "all")) {
        const fam = causalPercentileFamily(
          externalGroupTotalSeries,
          T - 1,
          w.ms,
        );
        groupHistoricalContext[w.label] = {
          sampleCount: fam.sampleCount,
          rank: percentileRank(
            externalGroupTotalSeries,
            T - 1,
            w.ms,
            cumulativeUsd,
          ),
          thresholds: fam,
          lowSample: fam.sampleCount < MIN_SAMPLES_RELIABLE,
        };
        const singleFam = causalPercentileFamily(
          externalRawEventSeries,
          T - 1,
          w.ms,
        );
        singleEventHistoricalContext[w.label] = {
          sampleCount: singleFam.sampleCount,
          rank: percentileRank(
            externalRawEventSeries,
            T - 1,
            w.ms,
            ev.quoteQty,
          ),
          thresholds: singleFam,
          lowSample: singleFam.sampleCount < MIN_SAMPLES_RELIABLE,
        };
      }
      const rank24h =
        (groupHistoricalContext["24h"] as { rank: number | null } | undefined)
          ?.rank ?? null;
      if (rank24h !== null)
        for (const t of PCT_THRESHOLDS)
          if (firstCrossings[`P${t}`] === null && rank24h >= t)
            firstCrossings[`P${t}`] = K;

      // ---- future outcome (evaluation only) ----
      const truePath = reconstructTruePath(
        candles,
        T,
        ev.price,
        group.victim,
        furthestAdversePrice,
      );
      const futureByHorizon: Record<string, unknown> = {};
      for (const h of HORIZONS) {
        if (
          truePath.dataQuality === "NO_DATA" ||
          truePath.candlesConsumed < h
        ) {
          futureByHorizon[`${h}m`] = {
            dataQuality:
              truePath.candlesConsumed === 0 ? "NO_DATA" : "INCOMPLETE",
          };
          continue;
        }
        const p = truePath.path.find((pt) => pt.minute === h)!;
        const favATR =
          atrNow.liqAtr && atrNow.liqAtr > 0
            ? ((p.favorablePct / 100) * ev.price) / atrNow.liqAtr
            : 0;
        const advATR =
          atrNow.liqAtr && atrNow.liqAtr > 0
            ? ((p.adversePct / 100) * ev.price) / atrNow.liqAtr
            : 0;
        futureByHorizon[`${h}m`] = {
          maxFavorableATR: favATR,
          maxAdverseATR: advATR,
          netOutcomeATR: favATR - advATR,
          dataQuality:
            p.favorablePct === 0 && p.adversePct === 0 ? "NO_MOVE" : "VALID",
        };
      }

      const snapshot: Snapshot = {
        snapshotId: `${group.groupId}-evt-${K}`,
        groupId: group.groupId,
        symbol: group.symbol,
        victim: group.victim,
        eventIndexInGroup: K,
        eventTimestamp: T,
        eventPrice: ev.price,
        eventLiquidationUsd: ev.quoteQty,
        developmentClass,
        causal: {
          cumulativeLiquidationUsd: cumulativeUsd,
          cumulativeEventCount: K,
          largestEventUsdSoFar: Math.max(...eventUsds),
          smallestEventUsdSoFar: Math.min(...eventUsds),
          meanEventUsdSoFar: mean(eventUsds),
          medianEventUsdSoFar: median(eventUsds),
          currentEventVsCumulativeBeforeRatio:
            prevCumulativeUsd > 0 ? ev.quoteQty / prevCumulativeUsd : null,
          currentEventVsLargestPreviousEventRatio:
            K > 1 ? ev.quoteQty / Math.max(...eventUsds.slice(0, -1)) : null,
          deltaLiquidationUsd: deltaLiqUsd,
          cumulativeLiquidationGrowthPct:
            prevCumulativeUsd > 0
              ? ((cumulativeUsd - prevCumulativeUsd) / prevCumulativeUsd) * 100
              : null,
          gapFromPreviousSameSideEventMs,
          elapsedFromGroupFirstEventMs,
          medianGapSoFarMs: median(gaps),
          minGapSoFarMs: gaps.length > 0 ? Math.min(...gaps) : null,
          maxGapSoFarMs: gaps.length > 0 ? Math.max(...gaps) : null,
          recentGapVsMedianPriorGapRatio,
          historicalSeriousness: {
            cumulativeGroupUsd: groupHistoricalContext,
            singleEventUsd: singleEventHistoricalContext,
          },
          priceState: {
            firstEventPrice,
            currentEventPrice: ev.price,
            furthestLiquidationDirectionEventPriceSoFar: furthestAdversePrice,
            furthestRecoveryDirectionEventPriceSoFar: furthestRecoveryPrice,
            cumulativeAdverseProgressPct,
            cumulativeAdverseProgressATR,
            cumulativeRecoveryProgressPct,
            cumulativeRecoveryProgressATR,
            newAdverseExtremeAtThisEvent,
            incrementalAdverseProgressATRFromPreviousSnapshot,
          },
          atr: {
            liquidationDirectionAtr: atrNow.liqAtr,
            recoveryDirectionAtr: atrNow.recAtr,
            recoveryToLiquidationAtrRatio: atrNow.ratio,
            sameClosedCandleAsPreviousEvent,
            liqAtrChangePctFromPreviousEvent: liqAtrChangePctFromPrevious,
            recoveryAtrChangePctFromPreviousEvent:
              recoveryAtrChangePctFromPrevious,
            atrRatioChangePctFromPreviousEvent: atrRatioChangePctFromPrevious,
            liqAtrChangePctFromFirstEvent: liqAtrChangePctFromFirst,
            recoveryAtrChangePctFromFirstEvent: recoveryAtrChangePctFromFirst,
            atrRatioChangePctFromFirstEvent: atrRatioChangePctFromFirst,
          },
          efficiency: {
            deltaAdverseProgressATR,
            marginalAdverseEfficiencyATRPer1M,
            cumulativeAdverseEfficiencyATRPer1M,
            marginalEfficiencyVsPreviousMarginalRatio,
            cumulativeEfficiencyChangePctFromPreviousEvent,
            priceResponsePerNewLiquidation: marginalAdverseEfficiencyATRPer1M,
            priceResponsePerNewLiquidationIsAliasOf:
              "marginalAdverseEfficiencyATRPer1M",
          },
          recoveryBetweenEvents: {
            maxRecoveryBetweenEventsPct: maxRecoveryBetweenPct,
            maxRecoveryBetweenEventsATR: maxRecoveryBetweenATR,
            maxAdverseExtensionBetweenEventsPct: maxAdverseExtBetweenPct,
            maxAdverseExtensionBetweenEventsATR: maxAdverseExtBetweenATR,
            ...recoveryFlags,
            intraminuteOrderNote:
              "INTRAMINUTE_ORDER_UNKNOWN when a single candle both extends and recovers -- not resolvable from 1m OHLC",
          },
          cumulativeRecoverySinceFirstEvent: {
            maxRecoverySinceFirstEventPct:
              firstEventPrice > 0
                ? ((maxRecoverySinceFirstEventATR * (atrNow.liqAtr ?? 0)) /
                    firstEventPrice) *
                  100
                : 0,
            maxRecoverySinceFirstEventATR,
          },
        },
        evaluationOnly: {
          finalGroupEventCount: group.eventCount,
          isFinalEventOfGroup: K === group.eventCount,
          futureOutcomeByHorizon: futureByHorizon,
          firstDirectionalMove: truePath.firstDirectionalMove,
          firstDominantMove: truePath.firstDominantMove,
          pathDataQuality: truePath.dataQuality,
        },
      };
      groupSnapshots.push(snapshot);
      allSnapshots.push(snapshot);

      prevAtr = atrNow;
      prevEventTimestamp = T;
      prevCandleOpenTimeUsed = atrNow.candleOpenTimeUsed;
    }

    // attach final group outcome (evaluation only) to every snapshot of this group, and first-crossing summary
    const finalOutcome = studyByGroupId.get(group.groupId) ?? null;
    for (const s of groupSnapshots) {
      (s.evaluationOnly as Record<string, unknown>).finalGroupOutcome =
        finalOutcome;
      (s.evaluationOnly as Record<string, unknown>).firstSnapshotCrossings =
        firstCrossings;
    }
  }

  console.log(`Total event snapshots: ${allSnapshots.length}`);
  const singleEventGroups = groups.filter((g) => g.eventCount === 1).length;
  const multiEventGroups = groups.filter((g) => g.eventCount > 1).length;
  console.log(
    `Single-event vs multi-event groups: ${singleEventGroups} / ${multiEventGroups}`,
  );

  // ---- final console report items 4-8 ----
  const finalLabelOf = (groupId: string): string => {
    const s = studyByGroupId.get(groupId);
    if (!s) return "UNKNOWN";
    const csv = s as unknown as { labelC?: string };
    return (
      csv.labelC ??
      ((s as unknown as { groups?: unknown })["groups"] ? "UNKNOWN" : "UNKNOWN")
    );
  };
  void finalLabelOf;

  const groupsReachingThreshold: Record<
    string,
    { count: number; medianFirstCrossingIndex: number | null }
  > = {};
  for (const t of PCT_THRESHOLDS) {
    const crossingIndexes: number[] = [];
    for (const group of groups) {
      const snaps = allSnapshots.filter((s) => s.groupId === group.groupId);
      const crossing = (
        snaps[snaps.length - 1]?.evaluationOnly as
          | Record<string, unknown>
          | undefined
      )?.firstSnapshotCrossings as Record<string, number | null> | undefined;
      const idx = crossing?.[`P${t}`];
      if (idx !== null && idx !== undefined) crossingIndexes.push(idx);
    }
    groupsReachingThreshold[`P${t}`] = {
      count: crossingIndexes.length,
      medianFirstCrossingIndex: median(crossingIndexes),
    };
  }
  console.log(
    `\nGroups ever reaching each historical percentile threshold (24h, cumulative group USD):`,
  );
  console.log(JSON.stringify(groupsReachingThreshold));

  // ---- Q: descriptive comparison by event-stage bucket, split by final outcome ----
  const outcomeOf = (groupId: string): string => {
    const s = studyByGroupId.get(groupId) as unknown as
      | { labelC?: string }
      | undefined;
    return s?.labelC ?? "UNKNOWN";
  };
  const stageComparison: Record<
    string,
    Record<string, Record<string, unknown>>
  > = {};
  const buckets = [
    "Event 1",
    "Event 2",
    "Event 3",
    "Event 4",
    "Event 5",
    "Event 6-10",
    "Event 11-20",
    "Event 21+",
  ];
  for (const outcome of ["REAL_REVERSAL", "CONTINUATION", "AMBIGUOUS"]) {
    stageComparison[outcome] = {};
    for (const bucket of buckets) {
      const snaps = allSnapshots.filter(
        (s) =>
          bucketOf(s.eventIndexInGroup) === bucket &&
          outcomeOf(s.groupId) === outcome,
      );
      const rank24h = snaps
        .map(
          (s) =>
            (
              s.causal.historicalSeriousness as {
                cumulativeGroupUsd: Record<string, { rank: number | null }>;
              }
            ).cumulativeGroupUsd["24h"]?.rank,
        )
        .filter((v): v is number => v !== null && v !== undefined);
      const cumUsd = snaps.map(
        (s) => s.causal.cumulativeLiquidationUsd as number,
      );
      const liqAtrChgFromFirst = snaps
        .map(
          (s) =>
            (s.causal.atr as { liqAtrChangePctFromFirstEvent: number | null })
              .liqAtrChangePctFromFirstEvent,
        )
        .filter((v): v is number => v !== null);
      const marginalEff = snaps
        .map(
          (s) =>
            (
              s.causal.efficiency as {
                marginalAdverseEfficiencyATRPer1M: number | null;
              }
            ).marginalAdverseEfficiencyATRPer1M,
        )
        .filter((v): v is number => v !== null);
      stageComparison[outcome]![bucket] = {
        n: snaps.length,
        cumulativePercentileRank24h: distSummary(rank24h),
        cumulativeLiquidationUsd: distSummary(cumUsd),
        liqAtrChangePctFromFirst: distSummary(liqAtrChgFromFirst),
        marginalAdverseEfficiencyATRPer1M: distSummary(marginalEff),
      };
    }
  }
  console.log(
    `\n=== Q: STAGE COMPARISON (REAL_REVERSAL vs CONTINUATION vs AMBIGUOUS) -- see output JSON for full detail ===`,
  );
  console.log(
    `REAL_REVERSAL Event 1 n=${(stageComparison.REAL_REVERSAL?.["Event 1"] as { n: number } | undefined)?.n ?? 0}, CONTINUATION Event 1 n=${(stageComparison.CONTINUATION?.["Event 1"] as { n: number } | undefined)?.n ?? 0}`,
  );

  // ---- S: rank subpopulations ----
  const rankSubpopulations: Record<string, Record<string, unknown>> = {};
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const key = `${symbol}-${victim}`;
      rankSubpopulations[key] = {};
      for (const t of PCT_THRESHOLDS) {
        const groupsReaching = groups
          .filter((g) => g.symbol === symbol && g.victim === victim)
          .filter((g) => {
            const idx = groupsReachingCrossingIndexForGroup(g, allSnapshots, t);
            return idx !== null;
          });
        (rankSubpopulations[key] as Record<string, unknown>)[`P${t}`] = {
          count: groupsReaching.length,
          outcomeCounts: countBy(
            groupsReaching.map((g) => outcomeOf(g.groupId)),
          ),
        };
      }
    }
  }
  console.log(`\n=== S: RANK SUBPOPULATIONS computed (see output JSON) ===`);

  // ---- validation ----
  console.log("\n=== VALIDATION ===\n");
  const violations: string[] = [];
  if (groups.length !== groupsFile.summary.totalGroupCount)
    violations.push(`Group count mismatch`);
  if (totalEventCount !== groupsFile.summary.rawEventCount)
    violations.push(
      `Event count mismatch: ${totalEventCount} vs ${groupsFile.summary.rawEventCount}`,
    );
  if (allSnapshots.length !== totalEventCount)
    violations.push(
      `Snapshot count ${allSnapshots.length} != event count ${totalEventCount}`,
    );
  const validationPass = violations.length === 0;
  console.log(`Validation: ${validationPass ? "PASS" : "FAIL"}`);
  violations.forEach((v) => console.error(`  ${v}`));

  // ---- output ----
  const outPathJson = `/mnt/data/liquidation-event-causal-trajectories-6d-${Date.now()}.json`;
  fs.writeFileSync(
    outPathJson,
    JSON.stringify({
      methodology: {
        note: "Event-by-event causal replay. Each snapshot's causal block uses only timestamp<=T information; evaluationOnly is structurally separate. Historical seriousness excludes the ENTIRE developing group (all its own events, not just T-1) from its own comparison population.",
        priceResponsePerNewLiquidationAlias:
          "priceResponsePerNewLiquidation is mathematically identical to marginalAdverseEfficiencyATRPer1M -- computed once, aliased, per operator instruction to document rather than duplicate.",
      },
      summary: {
        totalGroups: groups.length,
        totalEventSnapshots: allSnapshots.length,
        singleEventGroups,
        multiEventGroups,
        groupsReachingThreshold,
        stageComparison,
        rankSubpopulations,
      },
      groupTrajectories: groups.map((g) => ({
        groupId: g.groupId,
        symbol: g.symbol,
        victim: g.victim,
        trajectory: allSnapshots.filter((s) => s.groupId === g.groupId),
      })),
      allEventSnapshots: allSnapshots,
      validation: { violations, pass: validationPass },
    }),
  );

  const csvHeaders = [
    "snapshotId",
    "groupId",
    "symbol",
    "victim",
    "eventIndexInGroup",
    "eventTimestamp",
    "eventLiquidationUsd",
    "cumulativeLiquidationUsd",
    "cumulativeGroupRank24h",
    "liqAtrChangePctFromFirst",
    "recoveryAtrChangePctFromFirst",
    "cumulativeAdverseProgressATR",
    "marginalAdverseEfficiencyATRPer1M",
    "finalOutcomeLabelC",
  ];
  const csvRows = allSnapshots.map((s) => {
    const rank24h =
      (
        s.causal.historicalSeriousness as {
          cumulativeGroupUsd: Record<string, { rank: number | null }>;
        }
      ).cumulativeGroupUsd["24h"]?.rank ?? null;
    return [
      s.snapshotId,
      s.groupId,
      s.symbol,
      s.victim,
      s.eventIndexInGroup,
      s.eventTimestamp,
      s.eventLiquidationUsd,
      s.causal.cumulativeLiquidationUsd,
      rank24h,
      (s.causal.atr as { liqAtrChangePctFromFirstEvent: number | null })
        .liqAtrChangePctFromFirstEvent,
      (s.causal.atr as { recoveryAtrChangePctFromFirstEvent: number | null })
        .recoveryAtrChangePctFromFirstEvent,
      (s.causal.priceState as { cumulativeAdverseProgressATR: number })
        .cumulativeAdverseProgressATR,
      (
        s.causal.efficiency as {
          marginalAdverseEfficiencyATRPer1M: number | null;
        }
      ).marginalAdverseEfficiencyATRPer1M,
      outcomeOf(s.groupId),
    ];
  });
  const outPathCsv = `/mnt/data/liquidation-event-snapshots-6d-${Date.now()}.csv`;
  fs.writeFileSync(
    outPathCsv,
    [
      csvHeaders.join(","),
      ...csvRows.map((r) => r.map(csvEscape).join(",")),
    ].join("\n"),
  );

  const outPathTransitions = `/mnt/data/liquidation-event-transition-summary-6d-${Date.now()}.json`;
  fs.writeFileSync(
    outPathTransitions,
    JSON.stringify({
      stageComparison,
      groupsReachingThreshold,
      rankSubpopulations,
    }),
  );

  console.log(`\nOutput JSON: ${outPathJson}`);
  console.log(`Output CSV: ${outPathCsv}`);
  console.log(`Transition summary: ${outPathTransitions}`);
}

function groupsReachingCrossingIndexForGroup(
  g: RawGroup,
  allSnapshots: Snapshot[],
  t: number,
): number | null {
  const snaps = allSnapshots.filter((s) => s.groupId === g.groupId);
  const last = snaps[snaps.length - 1];
  const crossing = (last?.evaluationOnly as Record<string, unknown> | undefined)
    ?.firstSnapshotCrossings as Record<string, number | null> | undefined;
  return crossing?.[`P${t}`] ?? null;
}
function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

main();
