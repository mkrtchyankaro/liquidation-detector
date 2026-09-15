import * as fs from "fs";

/**
 * Sep 14 2026 (Karo), operator-requested. Pure mechanical grouping:
 * within each symbol, consecutive same-victim raw events form one
 * group; a victim-side flip closes the current group and opens a new
 * one. That is the ENTIRE rule -- no time gap, ATR, USD size, price,
 * or percentile threshold ever influences group membership. Reads
 * ONLY `rawTimeline` from the neutral-same-side-event-transitions
 * output; touches no old sequenceId/episodeId/REAL_REVERSAL/
 * CONTINUATION/FAILED_REVERSAL label. Pure local transformation -- no
 * Mongo, no Binance.
 *
 *   tsx scripts/directional-liquidation-groups.ts --input=/mnt/data/neutral-same-side-event-transitions-6d-<ts>.json
 */

interface RawTimelineRow {
  globalIndex: number;
  timestamp: number;
  symbol: string;
  victim: "LONG" | "SHORT";
  price: number;
  quoteQty: number;
}
interface Source {
  rawTimeline: RawTimelineRow[];
}

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;

function median(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}
function mean(arr: readonly number[]): number | null {
  return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
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
function distSummary(values: readonly number[]): Record<string, number | null> {
  const s = [...values].sort((a, b) => a - b);
  return {
    p25: pctl(s, 0.25),
    p50: pctl(s, 0.5),
    p75: pctl(s, 0.75),
    p90: pctl(s, 0.9),
    p95: pctl(s, 0.95),
    p99: pctl(s, 0.99),
    max: s.length > 0 ? s[s.length - 1]! : null,
  };
}
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseArgs(argv: string[]): { inputPath: string } {
  const hit = argv.find((a) => a.startsWith("--input="));
  if (!hit) {
    console.error(
      "Usage: directional-liquidation-groups.ts --input=/path/to/neutral-same-side-event-transitions-6d-<ts>.json",
    );
    process.exit(1);
  }
  return { inputPath: hit.slice("--input=".length) };
}

interface GroupEvent {
  globalIndex: number;
  timestamp: number;
  price: number;
  quoteQty: number;
  gapFromPreviousEventInGroupMs: number | null;
}
interface Group {
  groupId: string;
  symbol: string;
  victim: "LONG" | "SHORT";
  groupIndexWithinSymbol: number;
  startTimestamp: number;
  endTimestamp: number;
  durationMs: number;
  durationSeconds: number;
  durationMinutes: number;
  eventCount: number;
  totalLiquidationUsd: number;
  maxSingleLiquidationUsd: number;
  minSingleLiquidationUsd: number;
  meanLiquidationUsd: number | null;
  medianLiquidationUsd: number | null;
  events: GroupEvent[];
  minGapMs: number | null;
  medianGapMs: number | null;
  maxGapMs: number | null;
  p75GapMs: number | null;
  p90GapMs: number | null;
  p95GapMs: number | null;
  firstLiquidationPrice: number;
  lastLiquidationPrice: number;
  minLiquidationPrice: number;
  maxLiquidationPrice: number;
  adversePriceProgressPct: number;
  favorablePriceMovementPct: number;
  previousGroupId: string | null;
  previousGroupVictim: "LONG" | "SHORT" | null;
  previousGroupEndTimestamp: number | null;
  gapFromPreviousGroupMs: number | null;
  previousGroupTotalLiquidationUsd: number | null;
  totalUsdVsPreviousGroupRatio: number | null;
  nextGroupId: string | null;
  nextGroupVictim: "LONG" | "SHORT" | null;
  nextGroupStartTimestamp: number | null;
  gapToNextGroupMs: number | null;
  nextGroupTotalLiquidationUsd: number | null;
  totalUsdVsNextGroupRatio: number | null;
}

function main(): void {
  const { inputPath } = parseArgs(process.argv.slice(2));
  const source: Source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const rawEventCount = source.rawTimeline.length;
  console.log(`Source raw event count: ${rawEventCount}`);

  const allGroups: Group[] = [];
  let groupedRawEventCount = 0;
  const seenGlobalIndexesBySymbol = new Map<string, Set<number>>();

  for (const symbol of SYMBOLS) {
    const events = source.rawTimeline
      .filter((e) => e.symbol === symbol)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (events.length === 0) continue;
    seenGlobalIndexesBySymbol.set(symbol, new Set());

    const rawGroups: RawTimelineRow[][] = [];
    let current: RawTimelineRow[] = [events[0]!];
    for (let i = 1; i < events.length; i++) {
      if (events[i]!.victim === current[current.length - 1]!.victim) {
        current.push(events[i]!);
      } else {
        rawGroups.push(current);
        current = [events[i]!];
      }
    }
    rawGroups.push(current);

    const symbolGroups: Group[] = rawGroups.map(
      (groupEvents, groupIndexWithinSymbol) => {
        const victim = groupEvents[0]!.victim;
        const groupId = `${symbol}-group-${groupIndexWithinSymbol}`;
        const quoteQtys = groupEvents.map((e) => e.quoteQty);
        const prices = groupEvents.map((e) => e.price);
        const gaps: number[] = [];
        const events2: GroupEvent[] = groupEvents.map((e, idx) => {
          const gapFromPreviousEventInGroupMs =
            idx === 0 ? null : e.timestamp - groupEvents[idx - 1]!.timestamp;
          if (gapFromPreviousEventInGroupMs !== null)
            gaps.push(gapFromPreviousEventInGroupMs);
          return {
            globalIndex: e.globalIndex,
            timestamp: e.timestamp,
            price: e.price,
            quoteQty: e.quoteQty,
            gapFromPreviousEventInGroupMs,
          };
        });
        const gapsSorted = [...gaps].sort((a, b) => a - b);

        const startPrice = groupEvents[0]!.price;
        const adverseExtremePrice =
          victim === "LONG" ? Math.min(...prices) : Math.max(...prices);
        const favorableExtremePrice =
          victim === "LONG" ? Math.max(...prices) : Math.min(...prices);
        const adversePriceProgressPct =
          startPrice > 0
            ? (Math.abs(adverseExtremePrice - startPrice) / startPrice) * 100
            : 0;
        const favorablePriceMovementPct =
          startPrice > 0
            ? (Math.abs(favorableExtremePrice - startPrice) / startPrice) * 100
            : 0;

        const startTimestamp = groupEvents[0]!.timestamp,
          endTimestamp = groupEvents[groupEvents.length - 1]!.timestamp;
        const durationMs = endTimestamp - startTimestamp;

        return {
          groupId,
          symbol,
          victim,
          groupIndexWithinSymbol,
          startTimestamp,
          endTimestamp,
          durationMs,
          durationSeconds: durationMs / 1000,
          durationMinutes: durationMs / 60000,
          eventCount: groupEvents.length,
          totalLiquidationUsd: quoteQtys.reduce((a, b) => a + b, 0),
          maxSingleLiquidationUsd: Math.max(...quoteQtys),
          minSingleLiquidationUsd: Math.min(...quoteQtys),
          meanLiquidationUsd: mean(quoteQtys),
          medianLiquidationUsd: median(quoteQtys),
          events: events2,
          minGapMs: gaps.length > 0 ? Math.min(...gaps) : null,
          medianGapMs: median(gaps),
          maxGapMs: gaps.length > 0 ? Math.max(...gaps) : null,
          p75GapMs: pctl(gapsSorted, 0.75),
          p90GapMs: pctl(gapsSorted, 0.9),
          p95GapMs: pctl(gapsSorted, 0.95),
          firstLiquidationPrice: groupEvents[0]!.price,
          lastLiquidationPrice: groupEvents[groupEvents.length - 1]!.price,
          minLiquidationPrice: Math.min(...prices),
          maxLiquidationPrice: Math.max(...prices),
          adversePriceProgressPct,
          favorablePriceMovementPct,
          previousGroupId: null,
          previousGroupVictim: null,
          previousGroupEndTimestamp: null,
          gapFromPreviousGroupMs: null,
          previousGroupTotalLiquidationUsd: null,
          totalUsdVsPreviousGroupRatio: null,
          nextGroupId: null,
          nextGroupVictim: null,
          nextGroupStartTimestamp: null,
          gapToNextGroupMs: null,
          nextGroupTotalLiquidationUsd: null,
          totalUsdVsNextGroupRatio: null,
        };
      },
    );

    for (let i = 0; i < symbolGroups.length; i++) {
      const g = symbolGroups[i]!;
      if (i > 0) {
        const prev = symbolGroups[i - 1]!;
        g.previousGroupId = prev.groupId;
        g.previousGroupVictim = prev.victim;
        g.previousGroupEndTimestamp = prev.endTimestamp;
        g.gapFromPreviousGroupMs = g.startTimestamp - prev.endTimestamp;
        g.previousGroupTotalLiquidationUsd = prev.totalLiquidationUsd;
        g.totalUsdVsPreviousGroupRatio =
          prev.totalLiquidationUsd > 0
            ? g.totalLiquidationUsd / prev.totalLiquidationUsd
            : null;
      }
      if (i < symbolGroups.length - 1) {
        const next = symbolGroups[i + 1]!;
        g.nextGroupId = next.groupId;
        g.nextGroupVictim = next.victim;
        g.nextGroupStartTimestamp = next.startTimestamp;
        g.gapToNextGroupMs = next.startTimestamp - g.endTimestamp;
        g.nextGroupTotalLiquidationUsd = next.totalLiquidationUsd;
        g.totalUsdVsNextGroupRatio =
          next.totalLiquidationUsd > 0
            ? g.totalLiquidationUsd / next.totalLiquidationUsd
            : null;
      }
    }

    for (const g of symbolGroups) {
      for (const e of g.events) {
        seenGlobalIndexesBySymbol.get(symbol)!.add(e.globalIndex);
        groupedRawEventCount++;
      }
    }
    allGroups.push(...symbolGroups);
  }

  console.log(`Grouped raw event count: ${groupedRawEventCount}`);
  console.log(`Total group count: ${allGroups.length}`);

  const countByStream: Record<string, number> = {};
  for (const g of allGroups)
    countByStream[`${g.symbol}|${g.victim}`] =
      (countByStream[`${g.symbol}|${g.victim}`] ?? 0) + 1;
  console.log(
    `Group counts by symbol/victim: ${JSON.stringify(countByStream)}`,
  );

  const singleEventGroups = allGroups.filter((g) => g.eventCount === 1).length;
  const multiEventGroups = allGroups.filter((g) => g.eventCount > 1).length;
  console.log(`Single-event group count: ${singleEventGroups}`);
  console.log(`Multi-event group count: ${multiEventGroups}`);

  const longestDuration = [...allGroups].sort(
    (a, b) => b.durationMs - a.durationMs,
  )[0];
  const largestUsd = [...allGroups].sort(
    (a, b) => b.totalLiquidationUsd - a.totalLiquidationUsd,
  )[0];
  console.log(
    `Longest-duration group: ${longestDuration?.groupId} (${longestDuration?.durationMs}ms)`,
  );
  console.log(
    `Largest-total-USD group: ${largestUsd?.groupId} ($${largestUsd?.totalLiquidationUsd})`,
  );

  interface Sandwich {
    A: {
      groupId: string;
      eventCount: number;
      totalUsd: number;
      durationMs: number;
      victim: string;
    };
    B: {
      groupId: string;
      eventCount: number;
      totalUsd: number;
      maxSingleUsd: number;
      durationMs: number;
      victim: string;
    };
    C: {
      groupId: string;
      eventCount: number;
      totalUsd: number;
      durationMs: number;
      victim: string;
    };
    bOverA: number | null;
    bOverC: number | null;
    bOverApc: number | null;
    gapAEndToBStartMs: number;
    gapBEndToCStartMs: number;
  }
  const sandwiches: Sandwich[] = [];
  for (const symbol of SYMBOLS) {
    const symbolGroups = allGroups
      .filter((g) => g.symbol === symbol)
      .sort((a, b) => a.groupIndexWithinSymbol - b.groupIndexWithinSymbol);
    for (let i = 1; i < symbolGroups.length - 1; i++) {
      const A = symbolGroups[i - 1]!,
        B = symbolGroups[i]!,
        C = symbolGroups[i + 1]!;
      sandwiches.push({
        A: {
          groupId: A.groupId,
          eventCount: A.eventCount,
          totalUsd: A.totalLiquidationUsd,
          durationMs: A.durationMs,
          victim: A.victim,
        },
        B: {
          groupId: B.groupId,
          eventCount: B.eventCount,
          totalUsd: B.totalLiquidationUsd,
          maxSingleUsd: B.maxSingleLiquidationUsd,
          durationMs: B.durationMs,
          victim: B.victim,
        },
        C: {
          groupId: C.groupId,
          eventCount: C.eventCount,
          totalUsd: C.totalLiquidationUsd,
          durationMs: C.durationMs,
          victim: C.victim,
        },
        bOverA:
          A.totalLiquidationUsd > 0
            ? B.totalLiquidationUsd / A.totalLiquidationUsd
            : null,
        bOverC:
          C.totalLiquidationUsd > 0
            ? B.totalLiquidationUsd / C.totalLiquidationUsd
            : null,
        bOverApc:
          A.totalLiquidationUsd + C.totalLiquidationUsd > 0
            ? B.totalLiquidationUsd /
              (A.totalLiquidationUsd + C.totalLiquidationUsd)
            : null,
        gapAEndToBStartMs: B.startTimestamp - A.endTimestamp,
        gapBEndToCStartMs: C.startTimestamp - B.endTimestamp,
      });
    }
  }
  console.log(`A-B-A sandwich pattern count: ${sandwiches.length}`);

  function buildDistributions(
    groups: readonly Group[],
  ): Record<string, unknown> {
    return {
      eventCount: distSummary(groups.map((g) => g.eventCount)),
      durationMs: distSummary(groups.map((g) => g.durationMs)),
      totalLiquidationUsd: distSummary(
        groups.map((g) => g.totalLiquidationUsd),
      ),
      maxInternalGapMs: distSummary(
        groups.map((g) => g.maxGapMs).filter((v): v is number => v !== null),
      ),
    };
  }
  const distOverall = buildDistributions(allGroups);
  const distBySymbol: Record<string, unknown> = {};
  for (const s of SYMBOLS)
    distBySymbol[s] = buildDistributions(
      allGroups.filter((g) => g.symbol === s),
    );
  const distByVictim: Record<string, unknown> = {};
  for (const v of ["LONG", "SHORT"] as const)
    distByVictim[v] = buildDistributions(
      allGroups.filter((g) => g.victim === v),
    );

  const violations: string[] = [];
  if (groupedRawEventCount !== rawEventCount)
    violations.push(
      `Grouped event count ${groupedRawEventCount} != source raw event count ${rawEventCount}`,
    );
  const globalIndexSeenOnce = new Map<string, number>();
  for (const symbol of SYMBOLS) {
    for (const idx of seenGlobalIndexesBySymbol.get(symbol) ?? []) {
      const key = `${symbol}-${idx}`;
      globalIndexSeenOnce.set(key, (globalIndexSeenOnce.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of globalIndexSeenOnce)
    if (count !== 1)
      violations.push(
        `Event ${key} appears ${count} times, expected exactly 1`,
      );
  for (const symbol of SYMBOLS) {
    const symbolGroups = allGroups
      .filter((g) => g.symbol === symbol)
      .sort((a, b) => a.groupIndexWithinSymbol - b.groupIndexWithinSymbol);
    for (let i = 1; i < symbolGroups.length; i++) {
      if (symbolGroups[i]!.victim === symbolGroups[i - 1]!.victim)
        violations.push(
          `${symbol}: groups ${i - 1} and ${i} do not alternate victim (both ${symbolGroups[i]!.victim})`,
        );
    }
    const reconstructed = symbolGroups.flatMap((g) =>
      g.events.map((e) => e.globalIndex),
    );
    const original = source.rawTimeline
      .filter((e) => e.symbol === symbol)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((e) => e.globalIndex);
    if (JSON.stringify(reconstructed) !== JSON.stringify(original))
      violations.push(
        `${symbol}: concatenated groups do not reconstruct the original chronological stream exactly`,
      );
  }
  const validationPass = violations.length === 0;
  console.log(`\nValidation: ${validationPass ? "PASS" : "FAIL"}`);
  if (!validationPass)
    violations.slice(0, 20).forEach((v) => console.error(`  ${v}`));

  const outPathJson = `/mnt/data/directional-liquidation-groups-6d-${Date.now()}.json`;
  fs.writeFileSync(
    outPathJson,
    JSON.stringify({
      methodology: {
        rule: "Within each symbol, consecutive same-victim raw events form one group; a victim-side flip closes the current group and opens a new one. This is the ONLY grouping rule -- no time gap, ATR, USD size, price, or percentile threshold was used to decide group membership.",
        sourceFile: inputPath,
      },
      summary: {
        rawEventCount,
        totalGroupCount: allGroups.length,
        countByStream,
        singleEventGroupCount: singleEventGroups,
        multiEventGroupCount: multiEventGroups,
        distributions: {
          overall: distOverall,
          bySymbol: distBySymbol,
          byVictim: distByVictim,
        },
      },
      groups: allGroups,
      sandwiches,
      validation: {
        rawEventCount,
        groupedRawEventCount,
        violations,
        pass: validationPass,
      },
    }),
  );

  const groupCsvHeaders = [
    "groupId",
    "symbol",
    "victim",
    "groupIndexWithinSymbol",
    "startTimestamp",
    "endTimestamp",
    "durationMs",
    "eventCount",
    "totalLiquidationUsd",
    "maxSingleLiquidationUsd",
    "medianGapMs",
    "maxGapMs",
    "adversePriceProgressPct",
    "previousGroupVictim",
    "gapFromPreviousGroupMs",
    "totalUsdVsPreviousGroupRatio",
    "nextGroupVictim",
    "gapToNextGroupMs",
    "totalUsdVsNextGroupRatio",
  ];
  const groupCsvRows = allGroups.map((g) => [
    g.groupId,
    g.symbol,
    g.victim,
    g.groupIndexWithinSymbol,
    g.startTimestamp,
    g.endTimestamp,
    g.durationMs,
    g.eventCount,
    g.totalLiquidationUsd,
    g.maxSingleLiquidationUsd,
    g.medianGapMs,
    g.maxGapMs,
    g.adversePriceProgressPct,
    g.previousGroupVictim,
    g.gapFromPreviousGroupMs,
    g.totalUsdVsPreviousGroupRatio,
    g.nextGroupVictim,
    g.gapToNextGroupMs,
    g.totalUsdVsNextGroupRatio,
  ]);
  const outPathGroupsCsv = `/mnt/data/directional-liquidation-groups-summary-6d-${Date.now()}.csv`;
  fs.writeFileSync(
    outPathGroupsCsv,
    [
      groupCsvHeaders.join(","),
      ...groupCsvRows.map((r) => r.map(csvEscape).join(",")),
    ].join("\n"),
  );

  const sandwichCsvHeaders = [
    "symbol",
    "aGroupId",
    "aVictim",
    "aEventCount",
    "aTotalUsd",
    "bGroupId",
    "bVictim",
    "bEventCount",
    "bTotalUsd",
    "bMaxSingleUsd",
    "cGroupId",
    "cVictim",
    "cEventCount",
    "cTotalUsd",
    "bOverA",
    "bOverC",
    "bOverApc",
    "gapAEndToBStartMs",
    "gapBEndToCStartMs",
  ];
  const sandwichCsvRows = sandwiches.map((s) => [
    s.A.groupId.split("-")[0],
    s.A.groupId,
    s.A.victim,
    s.A.eventCount,
    s.A.totalUsd,
    s.B.groupId,
    s.B.victim,
    s.B.eventCount,
    s.B.totalUsd,
    s.B.maxSingleUsd,
    s.C.groupId,
    s.C.victim,
    s.C.eventCount,
    s.C.totalUsd,
    s.bOverA,
    s.bOverC,
    s.bOverApc,
    s.gapAEndToBStartMs,
    s.gapBEndToCStartMs,
  ]);
  const outPathSandwichCsv = `/mnt/data/opposite-sandwich-patterns-6d-${Date.now()}.csv`;
  fs.writeFileSync(
    outPathSandwichCsv,
    [
      sandwichCsvHeaders.join(","),
      ...sandwichCsvRows.map((r) => r.map(csvEscape).join(",")),
    ].join("\n"),
  );

  console.log(`\nOutput JSON: ${outPathJson}`);
  console.log(`Groups CSV: ${outPathGroupsCsv}`);
  console.log(`Sandwich CSV: ${outPathSandwichCsv}`);
}

main();
