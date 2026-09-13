/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research: the
 * natural physics of liquidation waves -- Wave1 -> recovery/pause ->
 * optional Wave2 -> recovery/continuation. No entry rules, no SL/TP,
 * no threshold optimization. Built directly on the unchanged 1-minute
 * liquidation-run structure (no return to raw-event episode
 * grouping) plus the same causal candle overlay validated in the
 * prior pass.
 *
 * "Meaningful Wave2" selection: the run immediately following Wave1
 * is NOT automatically Wave2. If it's classified small/background (by
 * that symbol+victim's OWN historical run-magnitude distribution --
 * never a fixed USD number), it's skipped and the search continues
 * forward until a run classified medium/large/extreme is found (or
 * the data runs out). This directly implements "tiny/background runs
 * should not automatically become Wave2" without inventing a new
 * threshold -- it reuses the same regime classification already
 * built for Wave1 itself.
 *
 * Structural labels (A-E) are descriptive research categories only,
 * computed from a transparent decision tree using data-derived splits
 * (median recovery fraction, median incremental extension within that
 * regime) -- never a hidden magic number, and cases that don't
 * cleanly fit are labeled "unclassified" rather than forced into a
 * category.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart.
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
const DIST_PCTS = [25, 50, 75, 90, 95];

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
  return percentile(sortNum(a), 50);
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
interface RawRun {
  startTs: number;
  endTs: number;
  durationMinutes: number;
  totalUsd: number;
  eventCount: number;
  maxSingleEventUsd: number;
}
interface ActiveRun extends RawRun {
  symbol: string;
  victim: "LONG" | "SHORT";
  runIdx: number;
  magnitudePercentile: number;
  regime: Regime;
}
type Regime = "small/background" | "medium" | "large" | "extreme/shock";

interface WavePair {
  symbol: string;
  victim: "LONG" | "SHORT";
  w1: ActiveRun;
  w2: ActiveRun | null;
  regime: "large" | "extreme/shock";
  w1StartPrice: number;
  w1Extreme: number;
  w1MoveUsd: number;
  w1MovePct: number;
  w1MoveAtr: number;
  w1SpeedUsdPerMin: number;
  w1EventsPerMin: number;
  w1Efficiency: number;
  atrFrozen: number;
  skippedTinyRuns: number;
  pauseMinutes: number | null;
  maxRecoveryUsd: number;
  maxRecoveryPct: number;
  maxRecoveryAtr: number;
  recoveryFraction: number;
  w2Extreme: number | null;
  w2NewTerritory: boolean | null;
  incrementalExtensionUsd: number | null;
  incrementalExtensionPct: number | null;
  incrementalExtensionAtr: number | null;
  w2MoveUsd: number | null;
  w2MovePct: number | null;
  w2MoveAtr: number | null;
  w2SpeedUsdPerMin: number | null;
  w2Efficiency: number | null;
  w2UsdRatio: number | null;
  w2SpeedRatio: number | null;
  w2MoveRatio: number | null;
  w2EfficiencyRatio: number | null;
  structuralLabel: string;
}

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
  const helpers: Record<
    string,
    {
      atrAt: (ms: number) => number | null;
      closedCandleAt: (ms: number) => any;
      candleAt: (ms: number) => any;
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
    helpers[symbol] = { atrAt, closedCandleAt, candleAt };

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

      const rawRuns: RawRun[] = [];
      let cur: MinuteRow[] = [];
      for (const r of timeline) {
        if (r.eventCount > 0) cur.push(r);
        else if (cur.length > 0) {
          rawRuns.push(buildRun(cur));
          cur = [];
        }
      }
      if (cur.length > 0) rawRuns.push(buildRun(cur));
      function buildRun(mins: MinuteRow[]): RawRun {
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

  const pairsByRegime: Record<"large" | "extreme/shock", WavePair[]> = {
    large: [],
    "extreme/shock": [],
  };

  for (const symbol of SYMBOLS) {
    if (!helpers[symbol]) continue;
    const { atrAt, closedCandleAt, candleAt } = helpers[symbol];
    for (const victim of ["LONG", "SHORT"] as const) {
      const runs = allRuns[symbol][victim];
      for (let i = 0; i < runs.length; i++) {
        const w1 = runs[i];
        if (w1.regime !== "large" && w1.regime !== "extreme/shock") continue;
        const regime = w1.regime as "large" | "extreme/shock";

        const atrFrozen = atrAt(w1.startTs);
        if (atrFrozen === null || atrFrozen <= 0) continue;
        const startCandle = closedCandleAt(w1.startTs);
        const w1StartPrice = startCandle
          ? startCandle.close
          : (candleAt(w1.startTs)?.open ?? null);
        if (w1StartPrice === null) continue;

        let w1Extreme: number | null = null;
        for (let t = w1.startTs; t <= w1.endTs; t += 60000) {
          const c = candleAt(t);
          if (!c) continue;
          const v = victim === "LONG" ? c.low : c.high;
          if (
            w1Extreme === null ||
            (victim === "LONG" ? v < w1Extreme : v > w1Extreme)
          )
            w1Extreme = v;
        }
        if (w1Extreme === null) continue;

        const w1MoveUsd = Math.abs(w1StartPrice - w1Extreme);
        const w1MovePct = (w1MoveUsd / w1StartPrice) * 100;
        const w1MoveAtr = w1MoveUsd / atrFrozen;
        const w1UsdInM = w1.totalUsd / 1e6;
        const w1Efficiency = w1UsdInM > 0 ? w1MoveAtr / w1UsdInM : 0;
        const w1SpeedUsdPerMin = w1.totalUsd / w1.durationMinutes;
        const w1EventsPerMin = w1.eventCount / w1.durationMinutes;

        let skipped = 0;
        let w2Idx = -1;
        for (let j = i + 1; j < runs.length; j++) {
          if (runs[j].regime === "small/background") {
            skipped++;
            continue;
          }
          w2Idx = j;
          break;
        }
        const w2 = w2Idx >= 0 ? runs[w2Idx] : null;

        const walkEnd = w2 ? w2.startTs - 60000 : windowEndMinute;
        let runningExtreme = w1Extreme;
        let maxRecoveryAtr = -Infinity,
          maxRecoveryUsd = 0;
        for (let t = w1.endTs + 60000; t <= walkEnd; t += 60000) {
          const c = candleAt(t);
          if (!c) continue;
          const ec = victim === "LONG" ? c.low : c.high;
          if (victim === "LONG" ? ec < runningExtreme : ec > runningExtreme) {
            runningExtreme = ec;
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
        const maxRecoveryPct =
          runningExtreme > 0 ? (maxRecoveryUsd / runningExtreme) * 100 : 0;
        const recoveryFraction = w1MoveUsd > 0 ? maxRecoveryUsd / w1MoveUsd : 0;
        const pauseMinutes = w2
          ? Math.round((w2.startTs - w1.endTs) / 60000) - 1
          : null;

        let w2Extreme: number | null = null,
          w2NewTerritory: boolean | null = null,
          incrementalExtensionUsd: number | null = null,
          incrementalExtensionPct: number | null = null,
          incrementalExtensionAtr: number | null = null;
        let w2MoveUsd: number | null = null,
          w2MovePct: number | null = null,
          w2MoveAtr: number | null = null,
          w2SpeedUsdPerMin: number | null = null,
          w2Efficiency: number | null = null;
        let w2UsdRatio: number | null = null,
          w2SpeedRatio: number | null = null,
          w2MoveRatio: number | null = null,
          w2EfficiencyRatio: number | null = null;

        if (w2) {
          for (let t = w2.startTs; t <= w2.endTs; t += 60000) {
            const c = candleAt(t);
            if (!c) continue;
            const v = victim === "LONG" ? c.low : c.high;
            if (
              w2Extreme === null ||
              (victim === "LONG" ? v < w2Extreme : v > w2Extreme)
            )
              w2Extreme = v;
          }
          if (w2Extreme !== null) {
            w2NewTerritory =
              victim === "LONG" ? w2Extreme < w1Extreme : w2Extreme > w1Extreme;
            incrementalExtensionUsd = w2NewTerritory
              ? Math.abs(w1Extreme - w2Extreme)
              : 0;
            incrementalExtensionPct =
              (incrementalExtensionUsd / w1Extreme) * 100;
            incrementalExtensionAtr = incrementalExtensionUsd / atrFrozen;
            w2MoveUsd = Math.abs(runningExtreme - w2Extreme);
            w2MovePct = (w2MoveUsd / runningExtreme) * 100;
            w2MoveAtr = w2MoveUsd / atrFrozen;
            const w2UsdInM = w2.totalUsd / 1e6;
            w2Efficiency =
              w2UsdInM > 0 ? incrementalExtensionAtr / w2UsdInM : 0;
            w2SpeedUsdPerMin = w2.totalUsd / w2.durationMinutes;
            w2UsdRatio = w1.totalUsd > 0 ? w2.totalUsd / w1.totalUsd : 0;
            w2SpeedRatio =
              w1SpeedUsdPerMin > 0 ? w2SpeedUsdPerMin / w1SpeedUsdPerMin : 0;
            w2MoveRatio = w1MoveAtr > 0 ? w2MoveAtr / w1MoveAtr : 0;
            w2EfficiencyRatio =
              w1Efficiency > 0 ? w2Efficiency / w1Efficiency : 0;
          }
        }

        pairsByRegime[regime].push({
          symbol,
          victim,
          w1,
          w2,
          regime,
          w1StartPrice,
          w1Extreme,
          w1MoveUsd,
          w1MovePct,
          w1MoveAtr,
          w1SpeedUsdPerMin,
          w1EventsPerMin,
          w1Efficiency,
          atrFrozen,
          skippedTinyRuns: skipped,
          pauseMinutes,
          maxRecoveryUsd,
          maxRecoveryPct,
          maxRecoveryAtr,
          recoveryFraction,
          w2Extreme,
          w2NewTerritory,
          incrementalExtensionUsd,
          incrementalExtensionPct,
          incrementalExtensionAtr,
          w2MoveUsd,
          w2MovePct,
          w2MoveAtr,
          w2SpeedUsdPerMin,
          w2Efficiency,
          w2UsdRatio,
          w2SpeedRatio,
          w2MoveRatio,
          w2EfficiencyRatio,
          structuralLabel: "",
        });
      }
    }
  }

  for (const regime of ["large", "extreme/shock"] as const) {
    const pairs = pairsByRegime[regime];
    const noW2 = pairs.filter((p) => p.w2 === null);
    const withW2 = pairs.filter((p) => p.w2 !== null);
    const medRecoveryFractionNoW2 =
      median(noW2.map((p) => p.recoveryFraction)) ?? 0;
    const medIncExtAtrWithW2 =
      median(
        withW2
          .filter((p) => p.w2NewTerritory)
          .map((p) => p.incrementalExtensionAtr!),
      ) ?? 0;

    pairs.forEach((p) => {
      if (p.w2 === null) {
        p.structuralLabel =
          p.recoveryFraction >= medRecoveryFractionNoW2
            ? regime === "extreme/shock"
              ? "E: extreme W1, no useful W2 (fast/strong recovery)"
              : "A: strong recovery, no meaningful W2"
            : "unclassified: no W2, recovery below median (weak recovery but still no renewed pressure)";
      } else if (p.w2NewTerritory) {
        const strongExtension =
          (p.incrementalExtensionAtr ?? 0) >= medIncExtAtrWithW2;
        const smallRecovery = p.recoveryFraction < medRecoveryFractionNoW2;
        if (smallRecovery && strongExtension)
          p.structuralLabel = "B: small recovery, strong W2 continuation";
        else if (strongExtension)
          p.structuralLabel = "D: W2 makes strong new territory";
        else
          p.structuralLabel =
            "unclassified: W2 new territory but below-median extension";
      } else {
        p.structuralLabel =
          "C: meaningful W2, weak/no incremental price movement";
      }
    });
  }

  console.log(
    "\nLARGE W1 count: " +
      pairsByRegime.large.length +
      "  EXTREME/SHOCK W1 count: " +
      pairsByRegime["extreme/shock"].length,
  );

  console.log("\n" + "=".repeat(100));
  console.log(
    "FEATURE vs OUTCOME (does size/speed/displacement/efficiency predict W2 arrival + new-territory?)",
  );
  console.log("=".repeat(100));
  for (const regime of ["large", "extreme/shock"] as const) {
    const pairs = pairsByRegime[regime];
    console.log("\n--- " + regime.toUpperCase() + " ---");
    function bucketedRate(featureFn: (p: WavePair) => number, label: string) {
      const vals = sortNum(pairs.map(featureFn));
      const med = median(vals) ?? 0;
      const above = pairs.filter((p) => featureFn(p) >= med),
        below = pairs.filter((p) => featureFn(p) < med);
      const w2RateAbove = above.length
        ? (above.filter((p) => p.w2 !== null).length / above.length) * 100
        : null;
      const w2RateBelow = below.length
        ? (below.filter((p) => p.w2 !== null).length / below.length) * 100
        : null;
      const newTerrAbove = above.filter((p) => p.w2 !== null).length
        ? (above.filter((p) => p.w2NewTerritory).length /
            above.filter((p) => p.w2 !== null).length) *
          100
        : null;
      const newTerrBelow = below.filter((p) => p.w2 !== null).length
        ? (below.filter((p) => p.w2NewTerritory).length /
            below.filter((p) => p.w2 !== null).length) *
          100
        : null;
      console.log(
        "  " +
          label +
          ": above-median P(W2)=" +
          fmtPct(w2RateAbove) +
          " P(newTerr|W2)=" +
          fmtPct(newTerrAbove) +
          "  |  below-median P(W2)=" +
          fmtPct(w2RateBelow) +
          " P(newTerr|W2)=" +
          fmtPct(newTerrBelow),
      );
    }
    bucketedRate((p) => p.w1.totalUsd, "totalUSD");
    bucketedRate((p) => p.w1SpeedUsdPerMin, "speed(USD/min)");
    bucketedRate((p) => p.w1.durationMinutes, "duration");
    bucketedRate((p) => p.w1MoveAtr, "displacement(ATR)");
    bucketedRate((p) => p.w1Efficiency, "efficiency(ATR per $1M)");
    bucketedRate((p) => p.recoveryFraction, "recoveryFraction");
  }

  console.log("\n" + "=".repeat(100));
  console.log("STRUCTURAL LABEL DISTRIBUTION (descriptive only)");
  console.log("=".repeat(100));
  for (const regime of ["large", "extreme/shock"] as const) {
    const pairs = pairsByRegime[regime];
    const counts = new Map<string, number>();
    pairs.forEach((p) =>
      counts.set(p.structuralLabel, (counts.get(p.structuralLabel) ?? 0) + 1),
    );
    console.log("\n" + regime.toUpperCase() + " (n=" + pairs.length + "):");
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([label, count]) =>
        console.log(
          "  " +
            fmtPct((count / pairs.length) * 100).padStart(6) +
            "  (n=" +
            count +
            ")  " +
            label,
        ),
      );
  }

  console.log("\n" + "=".repeat(100));
  console.log(
    "DISTRIBUTIONS (combined cross-symbol per regime -- full per-symbol breakdown in JSON)",
  );
  console.log("=".repeat(100));
  function distLine(vals: number[]) {
    const s = sortNum(vals);
    return DIST_PCTS.map(
      (p) => "p" + p + "=" + (percentile(s, p)?.toFixed(3) ?? "n/a"),
    ).join(" ");
  }
  for (const regime of ["large", "extreme/shock"] as const) {
    const pairs = pairsByRegime[regime];
    const withW2 = pairs.filter((p) => p.w2 !== null);
    console.log(
      "\n--- " +
        regime.toUpperCase() +
        " (n=" +
        pairs.length +
        ", n_withW2=" +
        withW2.length +
        ") ---",
    );
    console.log(
      "  totalUSD:          " + distLine(pairs.map((p) => p.w1.totalUsd)),
    );
    console.log(
      "  duration(min):     " +
        distLine(pairs.map((p) => p.w1.durationMinutes)),
    );
    console.log(
      "  USD/min:           " + distLine(pairs.map((p) => p.w1SpeedUsdPerMin)),
    );
    console.log(
      "  priceMovePct:      " + distLine(pairs.map((p) => p.w1MovePct)),
    );
    console.log(
      "  priceMoveATR:      " + distLine(pairs.map((p) => p.w1MoveAtr)),
    );
    console.log(
      "  ATR per $1M:       " + distLine(pairs.map((p) => p.w1Efficiency)),
    );
    console.log(
      "  recoveryPct:       " + distLine(pairs.map((p) => p.maxRecoveryPct)),
    );
    console.log(
      "  recoveryATR:       " + distLine(pairs.map((p) => p.maxRecoveryAtr)),
    );
    console.log(
      "  recoveryFraction:  " + distLine(pairs.map((p) => p.recoveryFraction)),
    );
    console.log(
      "  pauseMinutesToW2:  " + distLine(withW2.map((p) => p.pauseMinutes!)),
    );
    console.log(
      "  W2/W1 USDratio:    " + distLine(withW2.map((p) => p.w2UsdRatio!)),
    );
    console.log(
      "  W2/W1 speedRatio:  " + distLine(withW2.map((p) => p.w2SpeedRatio!)),
    );
    console.log(
      "  W2/W1 effRatio:    " +
        distLine(withW2.map((p) => p.w2EfficiencyRatio!)),
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log("REPRESENTATIVE EXAMPLES (20 total across categories)");
  console.log("=".repeat(100));

  function printExample(p: WavePair, label: string) {
    const { candleAt } = helpers[p.symbol];
    const longTl = allTimelines[p.symbol].LONG,
      shortTl = allTimelines[p.symbol].SHORT;
    console.log("\n" + "-".repeat(100));
    console.log(
      "[" +
        label +
        "] " +
        p.symbol +
        " " +
        p.victim +
        "  structuralLabel=" +
        p.structuralLabel,
    );
    console.log("-".repeat(100));
    console.log(
      "W1: " +
        fmtClock(p.w1.startTs) +
        "->" +
        fmtClock(p.w1.endTs) +
        "  liqUSD=" +
        fmtUsd(p.w1.totalUsd) +
        " duration=" +
        p.w1.durationMinutes +
        "min USD/min=" +
        fmtUsd(p.w1SpeedUsdPerMin) +
        " priceStart=" +
        p.w1StartPrice +
        " priceExtreme=" +
        p.w1Extreme +
        " movePct=" +
        p.w1MovePct.toFixed(3) +
        "%",
    );
    if (p.w2) {
      console.log(
        "RECOVERY: duration=" +
          p.pauseMinutes +
          "min recoveryPct=" +
          p.maxRecoveryPct.toFixed(3) +
          "%  (skipped " +
          p.skippedTinyRuns +
          " small/background run(s) before this W2)",
      );
      console.log(
        "W2: liqUSD=" +
          fmtUsd(p.w2.totalUsd) +
          " duration=" +
          p.w2.durationMinutes +
          "min USD/min=" +
          fmtUsd(p.w2SpeedUsdPerMin!) +
          " movePct=" +
          p.w2MovePct!.toFixed(3) +
          "% incrementalTerritoryPct=" +
          p.incrementalExtensionPct!.toFixed(3) +
          "%",
      );
    } else {
      console.log(
        "RECOVERY: no meaningful W2 found in this dataset (skipped " +
          p.skippedTinyRuns +
          " small/background run(s)) -- maxRecoveryPct=" +
          p.maxRecoveryPct.toFixed(3) +
          "%",
      );
    }
    const spanStart = p.w1.startTs - 10 * 60000;
    const spanEnd = (p.w2 ? p.w2.endTs : p.w1.endTs) + 10 * 60000;
    console.log("\nminute-by-minute:");
    for (
      let t = spanStart;
      t <= Math.min(spanEnd, windowEndMinute);
      t += 60000
    ) {
      const c = candleAt(t);
      const lr = longTl.find((r) => r.minuteTs === t),
        sr = shortTl.find((r) => r.minuteTs === t);
      const sameSide =
        p.victim === "LONG" ? (lr?.eventCount ?? 0) : (sr?.eventCount ?? 0);
      console.log(
        "  " +
          fmtClock(t).slice(11) +
          "  " +
          (c ? c.open + "/" + c.high + "/" + c.low + "/" + c.close : "n/a") +
          "  LONG=" +
          fmtUsd(lr?.totalLiquidationUsd ?? 0) +
          " SHORT=" +
          fmtUsd(sr?.totalLiquidationUsd ?? 0) +
          " n=" +
          sameSide,
      );
    }
  }

  const largePairs = pairsByRegime.large,
    extremePairs = pairsByRegime["extreme/shock"];
  const picks: { p: WavePair; label: string }[] = [];
  const largeWithW2 = largePairs
    .filter((p) => p.w2)
    .sort((a, b) => b.w1.totalUsd - a.w1.totalUsd);
  const largeNoW2 = largePairs
    .filter((p) => !p.w2)
    .sort((a, b) => b.w1.totalUsd - a.w1.totalUsd);
  const extremeWithW2 = extremePairs
    .filter((p) => p.w2)
    .sort((a, b) => b.w1.totalUsd - a.w1.totalUsd);
  const extremeNoW2 = extremePairs
    .filter((p) => !p.w2)
    .sort((a, b) => b.w1.totalUsd - a.w1.totalUsd);
  largeWithW2
    .slice(0, 4)
    .forEach((p) => picks.push({ p, label: "Large W1 with W2" }));
  largeNoW2
    .slice(0, 4)
    .forEach((p) => picks.push({ p, label: "Large W1 without W2" }));
  extremeWithW2
    .slice(0, 4)
    .forEach((p) => picks.push({ p, label: "Extreme W1 with W2" }));
  extremeNoW2
    .slice(0, 3)
    .forEach((p) => picks.push({ p, label: "Extreme W1 without W2" }));
  largePairs
    .filter((p) => p.structuralLabel.startsWith("D:"))
    .slice(0, 3)
    .forEach((p) => picks.push({ p, label: "W2 continuation (D)" }));
  largePairs
    .filter((p) => p.structuralLabel.startsWith("C:"))
    .slice(0, 2)
    .forEach((p) => picks.push({ p, label: "W2 exhaustion-like (C)" }));
  picks
    .slice(0, 20)
    .forEach(({ p, label }, idx) => printExample(p, label + " #" + (idx + 1)));

  console.log("\n" + "=".repeat(100));
  console.log("FINAL SUMMARY");
  console.log("=".repeat(100));
  const L = pairsByRegime.large,
    E = pairsByRegime["extreme/shock"];
  console.log(
    "1. Large W1 typical price move: median=" +
      median(L.map((p) => p.w1MovePct))?.toFixed(3) +
      "% (" +
      median(L.map((p) => p.w1MoveAtr))?.toFixed(3) +
      " ATR), n=" +
      L.length,
  );
  console.log(
    "2. Extreme W1 typical price move: median=" +
      median(E.map((p) => p.w1MovePct))?.toFixed(3) +
      "% (" +
      median(E.map((p) => p.w1MoveAtr))?.toFixed(3) +
      " ATR), n=" +
      E.length,
  );
  console.log(
    "3. Recovery after Large: median=" +
      median(L.map((p) => p.maxRecoveryPct))?.toFixed(3) +
      "%. After Extreme: median=" +
      median(E.map((p) => p.maxRecoveryPct))?.toFixed(3) +
      "%.",
  );
  console.log(
    "4. Meaningful W2 follows Large: " +
      fmtPct((L.filter((p) => p.w2).length / L.length) * 100) +
      " of the time. Extreme: " +
      fmtPct((E.filter((p) => p.w2).length / E.length) * 100) +
      ".",
  );
  console.log(
    "5. W2/W1 USD ratio when W2 exists: Large median=" +
      median(L.filter((p) => p.w2).map((p) => p.w2UsdRatio!))?.toFixed(2) +
      "x  Extreme median=" +
      median(E.filter((p) => p.w2).map((p) => p.w2UsdRatio!))?.toFixed(2) +
      "x",
  );
  console.log(
    "6. Additional price movement from W2: Large median incrementalExtensionATR=" +
      median(
        L.filter((p) => p.w2NewTerritory).map(
          (p) => p.incrementalExtensionAtr!,
        ),
      )?.toFixed(3) +
      "  Extreme median=" +
      median(
        E.filter((p) => p.w2NewTerritory).map(
          (p) => p.incrementalExtensionAtr!,
        ),
      )?.toFixed(3),
  );
  console.log(
    "7. Which feature matters most for W2/newTerritory: see the FEATURE vs OUTCOME table above (above-median vs below-median split per feature) -- read directly rather than compressed into a single ranking, since the splits move by different amounts per feature and regime.",
  );
  console.log(
    "8. Structural fingerprints where W2 usually unnecessary: see STRUCTURAL LABEL DISTRIBUTION above -- category A (and E for extreme) sizes indicate how common this is.",
  );
  console.log(
    "9. Structural fingerprints where waiting for W2 is justified: category B/D sizes in the same distribution above indicate this directly.",
  );

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "liquidation-wave-physics-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date(now).toISOString(), pairsByRegime },
      null,
      2,
    ),
  );
  console.log("\n\nFull data: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
