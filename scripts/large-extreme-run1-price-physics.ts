/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research: price
 * physics of LARGE/EXTREME Run1 -> recovery/silence -> Run2, using
 * the UNCHANGED 1-minute liquidation-run definition (no re-grouping)
 * plus a causal 1-minute-candle overlay for price analysis only.
 *
 * Run membership is untouched from the prior pass: activeRun =
 * consecutive non-zero same-side minutes. Regimes (small/medium/
 * large/extreme) are derived exactly as before, per symbol+victim,
 * from the historical distribution of run totalUSD. This pass
 * analyzes ONLY Run1s classified large or extreme/shock, kept as
 * fully separate populations throughout -- never mixed.
 *
 * CAUSALITY: candles are an analysis layer only, never used for run
 * membership. ATR(240) is frozen using only candles strictly before
 * Run1's own start. "Run1 start price" reads the last CLOSED candle
 * before Run1 begins. The recovery walk during the gap uses only
 * candles for minutes strictly between Run1's end and Run2's start --
 * every one of which is definitionally already closed by the time
 * Run2 arrives, since this is a post-hoc historical study, not a
 * live decision simulation. No future information is used to
 * describe what happened at an earlier point.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No W1/W2 rule. No entry rule. No threshold optimization.
 * No return to episode/raw-event grouping.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];
const HOURS = 72;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const GAP_BUCKETS: [string, (g: number) => boolean][] = [
  ["0-1", (g) => g <= 1],
  ["2-3", (g) => g >= 2 && g <= 3],
  ["4-5", (g) => g >= 4 && g <= 5],
  ["6-10", (g) => g >= 6 && g <= 10],
  ["11-15", (g) => g >= 11 && g <= 15],
  ["16-20", (g) => g >= 16 && g <= 20],
  ["21-30", (g) => g >= 21 && g <= 30],
  ["30+", (g) => g > 30],
];
const LARGE_EXAMPLES = 15;
const EXTREME_EXAMPLES = 10;

function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtPct(n: number | null, d?: number) {
  return n === null || n === undefined ? "n/a" : n.toFixed(d ?? 1) + "%";
}
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
function sortNum(a: number[]) {
  return [...a]
    .filter(
      (x) => x !== null && x !== undefined && !isNaN(x) && Number.isFinite(x),
    )
    .sort((x, y) => x - y);
}
function median(a: number[]) {
  const s = sortNum(a);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(sortedArr: number[], p: number): number | null {
  if (sortedArr.length === 0) return null;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sortedArr[lo]
    : sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function percentileRank(sortedArr: number[], value: number): number {
  if (sortedArr.length === 0) return 0;
  let c = 0;
  for (const v of sortedArr) if (v <= value) c++;
  return (c / sortedArr.length) * 100;
}

function httpsGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}
async function fetchKlines(symbol: string, startTime: number, endTime: number) {
  const m = new Map<
    number,
    { t: number; open: number; high: number; low: number; close: number }
  >();
  let cursor = startTime;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + 1499 * 60000, endTime);
    const raw = await httpsGetJson(
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
        symbol +
        "&interval=1m&startTime=" +
        cursor +
        "&endTime=" +
        chunkEnd +
        "&limit=1500",
    );
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw)
      m.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    cursor = raw[raw.length - 1][0] + 60000;
  }
  return m;
}
function computeWilderAtrSeries(
  candlesAsc: { t: number; high: number; low: number; close: number }[],
  period: number,
) {
  const atrMap = new Map<number, number>();
  if (candlesAsc.length < period + 1) return atrMap;
  const trs: number[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      prev = candlesAsc[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    );
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  atrMap.set(candlesAsc[period].t, atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrMap.set(candlesAsc[i + 1].t, atr);
  }
  return atrMap;
}

interface MinuteRow {
  minuteTs: number;
  eventCount: number;
  totalLiquidationUsd: number;
  maxSingleEventUsd: number;
  firstLiquidationPrice: number | null;
  lastLiquidationPrice: number | null;
  minLiquidationPrice: number | null;
  maxLiquidationPrice: number | null;
}
interface ActiveRun {
  symbol: string;
  victim: "LONG" | "SHORT";
  runIdx: number;
  startTs: number;
  endTs: number;
  durationMinutes: number;
  totalUsd: number;
  eventCount: number;
  maxSingleEventUsd: number;
  magnitudePercentile: number;
  regime: string;
}
type Regime = "small/background" | "medium" | "large" | "extreme/shock";

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const col = db.collection("liq_raw_events");

  const now = Date.now();
  const windowStart = Math.floor((now - HOURS * 3600 * 1000) / 60000) * 60000;
  const windowEndMinute = Math.floor(now / 60000) * 60000;

  const allTimelines: Record<
    string,
    Record<"LONG" | "SHORT", MinuteRow[]>
  > = {};
  const allRuns: Record<string, Record<"LONG" | "SHORT", ActiveRun[]>> = {};
  const atrHelpers: Record<
    string,
    {
      atrAt: (ms: number) => number | null;
      closedCandleAt: (
        ms: number,
      ) => { open: number; high: number; low: number; close: number } | null;
      candleAt: (
        ms: number,
      ) => { open: number; high: number; low: number; close: number } | null;
    }
  > = {};

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    allTimelines[symbol] = { LONG: [], SHORT: [] };
    allRuns[symbol] = { LONG: [], SHORT: [] };

    const klines = await fetchKlines(
      symbol,
      windowStart - 5 * 3600000,
      now + 60000,
    );
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    if (candlesAsc.length < 241) {
      console.log("  insufficient candle history -- skipping.\n");
      continue;
    }
    const atrSeries = computeWilderAtrSeries(candlesAsc, 240);
    function candleAt(ms: number) {
      return klines.get(Math.floor(ms / 60000) * 60000) || null;
    }
    function closedCandleAt(ms: number) {
      return klines.get(Math.floor(ms / 60000) * 60000 - 60000) || null;
    }
    function atrAt(ms: number): number | null {
      let t = Math.floor(ms / 60000) * 60000 - 60000;
      for (let i = 0; i < 300; i++) {
        if (atrSeries.has(t)) return atrSeries.get(t)!;
        t -= 60000;
      }
      return null;
    }
    atrHelpers[symbol] = { atrAt, closedCandleAt, candleAt };

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = events.filter((e) => e.victim === victim);
      const byMinute = new Map<number, any[]>();
      for (const e of sideEvents) {
        const m = Math.floor(e.timestamp / 60000) * 60000;
        if (!byMinute.has(m)) byMinute.set(m, []);
        byMinute.get(m)!.push(e);
      }

      const timeline: MinuteRow[] = [];
      for (let t = windowStart; t <= windowEndMinute; t += 60000) {
        const evs = byMinute.get(t);
        if (!evs || evs.length === 0)
          timeline.push({
            minuteTs: t,
            eventCount: 0,
            totalLiquidationUsd: 0,
            maxSingleEventUsd: 0,
            firstLiquidationPrice: null,
            lastLiquidationPrice: null,
            minLiquidationPrice: null,
            maxLiquidationPrice: null,
          });
        else {
          const prices = evs.map((e) => e.price);
          timeline.push({
            minuteTs: t,
            eventCount: evs.length,
            totalLiquidationUsd: evs.reduce((s, e) => s + e.quoteQty, 0),
            maxSingleEventUsd: Math.max(...evs.map((e) => e.quoteQty)),
            firstLiquidationPrice: evs[0].price,
            lastLiquidationPrice: evs[evs.length - 1].price,
            minLiquidationPrice: Math.min(...prices),
            maxLiquidationPrice: Math.max(...prices),
          });
        }
      }
      allTimelines[symbol][victim] = timeline;

      const rawRuns: {
        startTs: number;
        endTs: number;
        durationMinutes: number;
        totalUsd: number;
        eventCount: number;
        maxSingleEventUsd: number;
      }[] = [];
      let cur: MinuteRow[] = [];
      for (const r of timeline) {
        if (r.eventCount > 0) cur.push(r);
        else if (cur.length > 0) {
          rawRuns.push(buildRun(cur));
          cur = [];
        }
      }
      if (cur.length > 0) rawRuns.push(buildRun(cur));
      function buildRun(mins: MinuteRow[]) {
        return {
          startTs: mins[0].minuteTs,
          endTs: mins[mins.length - 1].minuteTs,
          durationMinutes: mins.length,
          totalUsd: mins.reduce((s, m) => s + m.totalLiquidationUsd, 0),
          eventCount: mins.reduce((s, m) => s + m.eventCount, 0),
          maxSingleEventUsd: Math.max(...mins.map((m) => m.maxSingleEventUsd)),
        };
      }

      const totals = sortNum(rawRuns.map((r) => r.totalUsd));
      const p50 = percentile(totals, 50)!,
        p80 = percentile(totals, 80)!,
        p95 = percentile(totals, 95)!;
      allRuns[symbol][victim] = rawRuns.map((r, idx) => {
        const pctile = percentileRank(totals, r.totalUsd);
        const regime: Regime =
          r.totalUsd < p50
            ? "small/background"
            : r.totalUsd < p80
              ? "medium"
              : r.totalUsd < p95
                ? "large"
                : "extreme/shock";
        return {
          symbol,
          victim,
          runIdx: idx,
          ...r,
          magnitudePercentile: pctile,
          regime,
        };
      });
    }
  }

  // ═══ Build LARGE and EXTREME Run1->Run2 pairs, with causal price physics ═══
  interface PricePhysicsPair {
    symbol: string;
    victim: "LONG" | "SHORT";
    run1: ActiveRun;
    run2: ActiveRun;
    regime: "large" | "extreme/shock";
    run1StartPrice: number;
    run1Extreme: number;
    run1DisplacementUsd: number;
    run1DisplacementPct: number;
    run1DisplacementAtr: number;
    run1UsdPerAtr: number;
    run1Efficiency: number;
    atrFrozen: number;
    zeroGapMinutes: number;
    maxRecoveryUsd: number;
    maxRecoveryPct: number;
    maxRecoveryAtr: number;
    recoveryFractionOfDisplacement: number;
    run2Extreme: number;
    run2NewTerritory: boolean;
    incrementalExtensionUsd: number;
    incrementalExtensionPct: number;
    incrementalExtensionAtr: number;
    run2IncrementalEfficiency: number | null;
    efficiencyRatio: number | null;
    run2UsdRatio: number;
  }
  const pairsByRegime: Record<"large" | "extreme/shock", PricePhysicsPair[]> = {
    large: [],
    "extreme/shock": [],
  };

  for (const symbol of SYMBOLS) {
    if (!atrHelpers[symbol]) continue;
    const { atrAt, closedCandleAt, candleAt } = atrHelpers[symbol];
    for (const victim of ["LONG", "SHORT"] as const) {
      const runs = allRuns[symbol][victim];
      for (let i = 0; i < runs.length - 1; i++) {
        const r1 = runs[i],
          r2 = runs[i + 1];
        if (r1.regime !== "large" && r1.regime !== "extreme/shock") continue;
        const regime = r1.regime as "large" | "extreme/shock";

        const atrFrozen = atrAt(r1.startTs);
        if (atrFrozen === null || atrFrozen <= 0) continue;
        const startCandle = closedCandleAt(r1.startTs);
        const run1StartPrice = startCandle
          ? startCandle.close
          : (candleAt(r1.startTs)?.open ?? null);
        if (run1StartPrice === null) continue;

        // Run1's OWN directional market-price extreme (candle-based, over Run1's own duration -- safely in the past)
        let run1Extreme: number | null = null;
        for (let t = r1.startTs; t <= r1.endTs; t += 60000) {
          const c = candleAt(t);
          if (!c) continue;
          const v = victim === "LONG" ? c.low : c.high;
          if (
            run1Extreme === null ||
            (victim === "LONG" ? v < run1Extreme : v > run1Extreme)
          )
            run1Extreme = v;
        }
        if (run1Extreme === null) continue;

        const run1DisplacementUsd = Math.abs(run1StartPrice - run1Extreme);
        const run1DisplacementPct =
          (run1DisplacementUsd / run1StartPrice) * 100;
        const run1DisplacementAtr = run1DisplacementUsd / atrFrozen;
        const run1UsdInMillions = r1.totalUsd / 1e6;
        const run1UsdPerAtr =
          run1DisplacementAtr > 0 ? r1.totalUsd / run1DisplacementAtr : 0;
        const run1Efficiency =
          run1UsdInMillions > 0 ? run1DisplacementAtr / run1UsdInMillions : 0;

        // recovery walk: STRICTLY the gap's own minutes (Run1.end < t < Run2.start), each already closed by construction
        let runningExtreme = run1Extreme,
          runningExtremeTs = r1.endTs;
        let maxRecoveryAtr = -Infinity,
          maxRecoveryUsd = 0;
        for (let t = r1.endTs + 60000; t < r2.startTs; t += 60000) {
          const c = candleAt(t);
          if (!c) continue;
          const extremeCandidate = victim === "LONG" ? c.low : c.high;
          if (
            victim === "LONG"
              ? extremeCandidate < runningExtreme
              : extremeCandidate > runningExtreme
          ) {
            runningExtreme = extremeCandidate;
            runningExtremeTs = t;
            maxRecoveryAtr = -Infinity;
          }
          const recUsd =
            victim === "LONG"
              ? c.close - runningExtreme
              : runningExtreme - c.close;
          const recAtr = recUsd / atrFrozen;
          if (recAtr > maxRecoveryAtr) {
            maxRecoveryAtr = recAtr;
            maxRecoveryUsd = recUsd;
          }
        }
        if (maxRecoveryAtr === -Infinity) {
          maxRecoveryAtr = 0;
          maxRecoveryUsd = 0;
        }
        const maxRecoveryPct = (maxRecoveryUsd / runningExtreme) * 100;
        const recoveryFractionOfDisplacement =
          run1DisplacementUsd > 0 ? maxRecoveryUsd / run1DisplacementUsd : 0;
        const zeroGapMinutes = Math.round((r2.startTs - r1.endTs) / 60000) - 1;

        // Run2's own directional extreme (candle-based, over Run2's own duration -- safely in the past)
        let run2Extreme: number | null = null;
        for (let t = r2.startTs; t <= r2.endTs; t += 60000) {
          const c = candleAt(t);
          if (!c) continue;
          const v = victim === "LONG" ? c.low : c.high;
          if (
            run2Extreme === null ||
            (victim === "LONG" ? v < run2Extreme : v > run2Extreme)
          )
            run2Extreme = v;
        }
        if (run2Extreme === null) continue;

        const run2NewTerritory =
          victim === "LONG"
            ? run2Extreme < run1Extreme
            : run2Extreme > run1Extreme;
        const incrementalExtensionUsd = run2NewTerritory
          ? Math.abs(run1Extreme - run2Extreme)
          : 0;
        const incrementalExtensionPct =
          (incrementalExtensionUsd / run1Extreme) * 100;
        const incrementalExtensionAtr = incrementalExtensionUsd / atrFrozen;
        const run2UsdInMillions = r2.totalUsd / 1e6;
        const run2IncrementalEfficiency =
          run2UsdInMillions > 0
            ? incrementalExtensionAtr / run2UsdInMillions
            : null;
        const efficiencyRatio =
          run2IncrementalEfficiency !== null && run1Efficiency > 0
            ? run2IncrementalEfficiency / run1Efficiency
            : null;
        const run2UsdRatio = r1.totalUsd > 0 ? r2.totalUsd / r1.totalUsd : 0;

        pairsByRegime[regime].push({
          symbol,
          victim,
          run1: r1,
          run2: r2,
          regime,
          run1StartPrice,
          run1Extreme,
          run1DisplacementUsd,
          run1DisplacementPct,
          run1DisplacementAtr,
          run1UsdPerAtr,
          run1Efficiency,
          atrFrozen,
          zeroGapMinutes,
          maxRecoveryUsd,
          maxRecoveryPct,
          maxRecoveryAtr,
          recoveryFractionOfDisplacement,
          run2Extreme,
          run2NewTerritory,
          incrementalExtensionUsd,
          incrementalExtensionPct,
          incrementalExtensionAtr,
          run2IncrementalEfficiency,
          efficiencyRatio,
          run2UsdRatio,
        });
      }
    }
  }

  console.log("\nLARGE Run1->Run2 pairs: " + pairsByRegime.large.length);
  console.log(
    "EXTREME/SHOCK Run1->Run2 pairs: " + pairsByRegime["extreme/shock"].length,
  );

  // ═══ Sections 8-10: NEW TERRITORY vs NO NEW TERRITORY, per regime ═══
  for (const regime of ["large", "extreme/shock"] as const) {
    console.log("\n" + "=".repeat(100));
    console.log(regime.toUpperCase() + " -- NEW TERRITORY vs NO NEW TERRITORY");
    console.log("=".repeat(100));
    const pairs = pairsByRegime[regime];
    const newTerr = pairs.filter((p) => p.run2NewTerritory);
    const noNewTerr = pairs.filter((p) => !p.run2NewTerritory);
    function groupStats(group: PricePhysicsPair[], label: string) {
      console.log("\n" + label + " (n=" + group.length + "):");
      console.log(
        "  Run1 totalUSD median=" +
          fmtUsd(median(group.map((p) => p.run1.totalUsd)) ?? 0),
      );
      console.log(
        "  zero-gap minutes: median=" +
          median(group.map((p) => p.zeroGapMinutes)),
      );
      console.log(
        "  Run1 recoveryATR: median=" +
          median(group.map((p) => p.maxRecoveryAtr))?.toFixed(3),
      );
      console.log(
        "  recovery/displacement fraction: median=" +
          median(group.map((p) => p.recoveryFractionOfDisplacement))?.toFixed(
            3,
          ),
      );
      console.log(
        "  Run2/Run1 USD ratio: median=" +
          median(group.map((p) => p.run2UsdRatio))?.toFixed(2),
      );
      console.log(
        "  incremental extension ATR: median=" +
          median(group.map((p) => p.incrementalExtensionAtr))?.toFixed(3),
      );
      console.log(
        "  Run1 efficiency: median=" +
          median(group.map((p) => p.run1Efficiency))?.toFixed(4),
      );
      console.log(
        "  Run2 incremental efficiency: median=" +
          median(
            group
              .map((p) => p.run2IncrementalEfficiency)
              .filter((v) => v !== null) as number[],
          )?.toFixed(4),
      );
      console.log(
        "  efficiency ratio: median=" +
          median(
            group
              .map((p) => p.efficiencyRatio)
              .filter((v) => v !== null) as number[],
          )?.toFixed(4),
      );
    }
    groupStats(newTerr, "NEW TERRITORY");
    groupStats(noNewTerr, "NO NEW TERRITORY");
  }

  // ═══ Section 9: gap-bucket analysis, per regime ═══
  for (const regime of ["large", "extreme/shock"] as const) {
    console.log("\n" + "=".repeat(100));
    console.log(regime.toUpperCase() + " -- GAP-BUCKET ANALYSIS");
    console.log("=".repeat(100));
    const pairs = pairsByRegime[regime];
    console.log(
      "bucket | n | P(newTerritory) | medRun2Ratio | medRecoveryATR | medIncExtATR | medEfficiencyRatio",
    );
    for (const [label, pred] of GAP_BUCKETS) {
      const bucket = pairs.filter((p) => pred(p.zeroGapMinutes));
      if (bucket.length === 0) {
        console.log(label + " | 0 | n/a | n/a | n/a | n/a | n/a");
        continue;
      }
      const newTerrPct =
        (bucket.filter((p) => p.run2NewTerritory).length / bucket.length) * 100;
      console.log(
        label +
          " | " +
          bucket.length +
          " | " +
          fmtPct(newTerrPct) +
          " | " +
          median(bucket.map((p) => p.run2UsdRatio))?.toFixed(2) +
          " | " +
          median(bucket.map((p) => p.maxRecoveryAtr))?.toFixed(3) +
          " | " +
          median(bucket.map((p) => p.incrementalExtensionAtr))?.toFixed(3) +
          " | " +
          (median(
            bucket
              .map((p) => p.efficiencyRatio)
              .filter((v) => v !== null) as number[],
          )?.toFixed(3) ?? "n/a"),
      );
    }
  }

  // ═══ Cross-symbol / LONG-vs-SHORT stability check ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "STABILITY ACROSS SYMBOLS AND LONG/SHORT (LARGE regime shown; EXTREME in JSON)",
  );
  console.log("=".repeat(100));
  for (const victim of ["LONG", "SHORT"] as const) {
    const pairs = pairsByRegime.large.filter((p) => p.victim === victim);
    if (pairs.length === 0) continue;
    console.log(
      victim +
        " (n=" +
        pairs.length +
        "): medRecoveryATR=" +
        median(pairs.map((p) => p.maxRecoveryAtr))?.toFixed(3) +
        " newTerritory%=" +
        fmtPct(
          (pairs.filter((p) => p.run2NewTerritory).length / pairs.length) * 100,
        ),
    );
  }
  for (const symbol of SYMBOLS) {
    const pairs = pairsByRegime.large.filter((p) => p.symbol === symbol);
    if (pairs.length < 5) continue;
    console.log(
      symbol +
        " (n=" +
        pairs.length +
        "): medRecoveryATR=" +
        median(pairs.map((p) => p.maxRecoveryAtr))?.toFixed(3) +
        " newTerritory%=" +
        fmtPct(
          (pairs.filter((p) => p.run2NewTerritory).length / pairs.length) * 100,
        ),
    );
  }

  // ═══ Section 11: minute-by-minute human-readable examples ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "REPRESENTATIVE EXAMPLES -- " +
      LARGE_EXAMPLES +
      " LARGE, " +
      EXTREME_EXAMPLES +
      " EXTREME (mix of new-territory and no-new-territory)",
  );
  console.log("=".repeat(100));

  function printExample(p: PricePhysicsPair, label: string) {
    const { candleAt } = atrHelpers[p.symbol];
    const longTimeline = allTimelines[p.symbol].LONG,
      shortTimeline = allTimelines[p.symbol].SHORT;
    function minuteRowFor(tl: MinuteRow[], t: number) {
      return tl.find((r) => r.minuteTs === t);
    }

    console.log("\n" + "-".repeat(100));
    console.log(
      "[" +
        label +
        "] " +
        p.symbol +
        " " +
        p.victim +
        "  regime=" +
        p.regime +
        "  " +
        (p.run2NewTerritory ? "NEW TERRITORY" : "NO NEW TERRITORY"),
    );
    console.log("-".repeat(100));
    console.log(
      "Run1: " +
        fmtClock(p.run1.startTs) +
        "->" +
        fmtClock(p.run1.endTs) +
        " totalUsd=" +
        fmtUsd(p.run1.totalUsd) +
        " (p" +
        p.run1.magnitudePercentile.toFixed(0) +
        ") displacementATR=" +
        p.run1DisplacementAtr.toFixed(3) +
        " efficiency=" +
        p.run1Efficiency.toFixed(4),
    );
    console.log(
      "gap: " +
        p.zeroGapMinutes +
        "min  maxRecoveryATR=" +
        p.maxRecoveryAtr.toFixed(3) +
        " (=" +
        (p.recoveryFractionOfDisplacement * 100).toFixed(1) +
        "% of Run1 displacement)",
    );
    console.log(
      "Run2: " +
        fmtClock(p.run2.startTs) +
        "->" +
        fmtClock(p.run2.endTs) +
        " totalUsd=" +
        fmtUsd(p.run2.totalUsd) +
        " ratio=" +
        p.run2UsdRatio.toFixed(2) +
        "x incrementalExtATR=" +
        p.incrementalExtensionAtr.toFixed(3) +
        " incrementalEff=" +
        (p.run2IncrementalEfficiency?.toFixed(4) ?? "n/a") +
        " efficiencyRatio=" +
        (p.efficiencyRatio?.toFixed(4) ?? "n/a"),
    );

    const spanStart = p.run1.startTs - 10 * 60000;
    const spanEnd = p.run2.endTs + 10 * 60000;
    console.log(
      "\ntimestamp | O/H/L/C | LONG_USD | SHORT_USD | sameSideCount | state | runningExtreme | recovery | incrementalTerritory",
    );
    let runningExt = p.run1Extreme,
      phase = "BEFORE";
    for (let t = spanStart; t <= spanEnd; t += 60000) {
      const c = candleAt(t);
      const lr = minuteRowFor(longTimeline, t),
        sr = minuteRowFor(shortTimeline, t);
      const sameSideCount =
        p.victim === "LONG" ? (lr?.eventCount ?? 0) : (sr?.eventCount ?? 0);
      if (t < p.run1.startTs) phase = "BEFORE";
      else if (t >= p.run1.startTs && t <= p.run1.endTs) phase = "RUN1";
      else if (t > p.run1.endTs && t < p.run2.startTs) phase = "GAP";
      else if (t >= p.run2.startTs && t <= p.run2.endTs) phase = "RUN2";
      else phase = "AFTER";
      if (c) {
        const v = p.victim === "LONG" ? c.low : c.high;
        if (
          phase !== "BEFORE" &&
          (p.victim === "LONG" ? v < runningExt : v > runningExt)
        )
          runningExt = v;
      }
      const recovery = c
        ? p.victim === "LONG"
          ? c.close - runningExt
          : runningExt - c.close
        : null;
      const incTerritory =
        p.victim === "LONG"
          ? Math.max(0, p.run1Extreme - runningExt)
          : Math.max(0, runningExt - p.run1Extreme);
      console.log(
        fmtClock(t) +
          " | " +
          (c ? c.open + "/" + c.high + "/" + c.low + "/" + c.close : "n/a") +
          " | " +
          fmtUsd(lr?.totalLiquidationUsd ?? 0) +
          " | " +
          fmtUsd(sr?.totalLiquidationUsd ?? 0) +
          " | " +
          sameSideCount +
          " | " +
          phase +
          " | " +
          runningExt.toFixed(4) +
          " | " +
          (recovery !== null ? recovery.toFixed(4) : "n/a") +
          " | " +
          incTerritory.toFixed(4),
      );
    }
  }

  const largeNewTerr = pairsByRegime.large
    .filter((p) => p.run2NewTerritory)
    .sort((a, b) => b.run1.totalUsd - a.run1.totalUsd);
  const largeNoNewTerr = pairsByRegime.large
    .filter((p) => !p.run2NewTerritory)
    .sort((a, b) => b.run1.totalUsd - a.run1.totalUsd);
  const extremeNewTerr = pairsByRegime["extreme/shock"]
    .filter((p) => p.run2NewTerritory)
    .sort((a, b) => b.run1.totalUsd - a.run1.totalUsd);
  const extremeNoNewTerr = pairsByRegime["extreme/shock"]
    .filter((p) => !p.run2NewTerritory)
    .sort((a, b) => b.run1.totalUsd - a.run1.totalUsd);

  const largePicks = [
    ...largeNewTerr.slice(0, Math.ceil(LARGE_EXAMPLES / 2)),
    ...largeNoNewTerr.slice(0, Math.floor(LARGE_EXAMPLES / 2)),
  ];
  const extremePicks = [
    ...extremeNewTerr.slice(0, Math.ceil(EXTREME_EXAMPLES / 2)),
    ...extremeNoNewTerr.slice(0, Math.floor(EXTREME_EXAMPLES / 2)),
  ];
  largePicks.forEach((p, i) => printExample(p, "LARGE #" + (i + 1)));
  extremePicks.forEach((p, i) => printExample(p, "EXTREME #" + (i + 1)));

  // ═══ Section 12: final summary, computed directly from the data above ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "FINAL RESEARCH SUMMARY -- ANSWERS COMPUTED DIRECTLY FROM THE DATA ABOVE",
  );
  console.log("=".repeat(100));
  const L = pairsByRegime.large,
    E = pairsByRegime["extreme/shock"];
  console.log(
    "1. After LARGE Run1, historically normal recovery before Run2: median=" +
      median(L.map((p) => p.maxRecoveryAtr))?.toFixed(3) +
      " ATR, p75=" +
      percentile(sortNum(L.map((p) => p.maxRecoveryAtr)), 75)?.toFixed(3) +
      " ATR (n=" +
      L.length +
      ")",
  );
  console.log(
    "2. After EXTREME Run1, recovery: median=" +
      median(E.map((p) => p.maxRecoveryAtr))?.toFixed(3) +
      " ATR, p75=" +
      percentile(sortNum(E.map((p) => p.maxRecoveryAtr)), 75)?.toFixed(3) +
      " ATR (n=" +
      E.length +
      ") -- " +
      ((median(E.map((p) => p.maxRecoveryAtr)) ?? 0) >
      (median(L.map((p) => p.maxRecoveryAtr)) ?? 0)
        ? "LARGER than LARGE"
        : "SMALLER/similar to LARGE") +
      ", see the gap-bucket tables above for the full shape.",
  );
  console.log(
    "3. Zero-gap length vs P(new territory): see the GAP-BUCKET ANALYSIS tables above for both regimes -- read directly, not summarized into one number here to avoid oversimplifying a non-monotonic relationship if one exists.",
  );
  const smallerRun2 = L.filter((p) => p.run2UsdRatio < 0.8);
  console.log(
    "4. When Run2 < 0.8x Run1 (LARGE), still creates new territory: " +
      fmtPct(
        smallerRun2.length
          ? (smallerRun2.filter((p) => p.run2NewTerritory).length /
              smallerRun2.length) *
              100
          : null,
      ) +
      " of the time (n=" +
      smallerRun2.length +
      ")",
  );
  const highEffortLowResult = L.filter(
    (p) =>
      p.run2UsdRatio >= 0.8 &&
      p.incrementalExtensionAtr <
        (percentile(sortNum(L.map((p2) => p2.incrementalExtensionAtr)), 25) ??
          0),
  );
  console.log(
    "5. Substantial Run2 USD + poor incremental extension (LARGE, n=" +
      highEffortLowResult.length +
      "): median subsequent Run1-vs-Run2 pattern is captured in the NO NEW TERRITORY group above -- inspect the printed examples for what followed each specific case.",
  );
  console.log(
    "6. Run2 efficiency, continuation vs failed-extension (LARGE): newTerritory median=" +
      (median(
        L.filter((p) => p.run2NewTerritory)
          .map((p) => p.run2IncrementalEfficiency)
          .filter((v) => v !== null) as number[],
      )?.toFixed(4) ?? "n/a") +
      " vs noNewTerritory median=" +
      (median(
        L.filter((p) => !p.run2NewTerritory)
          .map((p) => p.run2IncrementalEfficiency)
          .filter((v) => v !== null) as number[],
      )?.toFixed(4) ?? "n/a") +
      " (noNewTerritory is 0 by definition -- the real comparison is whether HIGH-EFFORT no-new-territory cases are common, see NEW/NO-NEW-TERRITORY tables above for Run2UsdRatio in each group)",
  );
  console.log(
    "7. Stability across symbols/sides: see the STABILITY table above -- inspect directly for how much medRecoveryATR and newTerritory% vary.",
  );
  console.log(
    "8. Does effort-vs-incremental-result distinguish exhaustion from continuation: see the efficiency-ratio comparisons in the NEW/NO-NEW-TERRITORY tables above for both regimes -- this script computes the numbers; the interpretive judgment is left to you as requested (no entry rule, no threshold optimization performed here).",
  );

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "large-extreme-run1-price-physics-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date(now).toISOString(), pairsByRegime },
      null,
      2,
    ),
  );
  console.log(
    "\n\nFull data (every LARGE/EXTREME pair, all fields): " + outPath,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
