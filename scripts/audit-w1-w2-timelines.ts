/**
 * Sep 13 2026 (Karo), operator-requested AUDIT. Does NOT change the
 * W1/W2 reconstruction, does NOT invent a max-gap, does NOT touch
 * ATR/entry logic. Reuses the EXACT same wave-reconstruction from the
 * prior liquidation-wave-physics.ts pass unchanged (same regime
 * derivation, same "skip small/background runs to find a meaningful
 * W2" logic, same causal ATR-freeze / closed-candle handling).
 *
 * Purpose: stratified-sample ~30 real LARGE/EXTREME W1->W2 cases
 * across pause-length buckets, print their complete minute-by-minute
 * timelines with full observable evidence, and save everything to
 * JSON for manual/conversational inspection. This script does NOT
 * compute a same-structure/ambiguous/different verdict -- that
 * requires actually looking at each timeline, which happens as a
 * follow-up once the real output is shared, not as a hidden rule
 * baked in here.
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

function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
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

interface AuditCase {
  symbol: string;
  victim: "LONG" | "SHORT";
  regime: "large" | "extreme/shock";
  pauseBucket: string;
  w1: ActiveRun;
  w2: ActiveRun;
  atrFrozen: number;
  w1StartPrice: number;
  w1Extreme: number;
  w1MoveUsd: number;
  w1MovePct: number;
  w1MoveAtr: number;
  pauseMinutes: number;
  maxRecoveryUsd: number;
  maxRecoveryPct: number;
  maxRecoveryAtr: number;
  recoveryFraction: number;
  residualGapMinutes: number;
  residualGapUsd: number;
  w2Extreme: number;
  w2StartPrice: number;
  w2ClosestApproachToW1ExtremeUsd: number;
  w2ClosestApproachToW1ExtremePct: number;
  w2ClosestApproachToW1ExtremeAtr: number;
  w2NewTerritory: boolean;
  incrementalExtensionUsd: number;
  incrementalExtensionPct: number;
  incrementalExtensionAtr: number;
  timeline: {
    minuteTs: number;
    ohlc: string | null;
    sameSideUsd: number;
    oppositeSideUsd: number;
    sameSideEventCount: number;
    sameSideMaxEvent: number;
    label: string;
  }[];
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
    console.log("Fetching " + symbol + "...");
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
      console.log("  insufficient candle history -- skipping.");
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

  const allCandidates: {
    symbol: string;
    victim: "LONG" | "SHORT";
    regime: "large" | "extreme/shock";
    w1: ActiveRun;
    w2: ActiveRun;
    pauseMinutes: number;
  }[] = [];
  for (const symbol of SYMBOLS) {
    if (!helpers[symbol]) continue;
    for (const victim of ["LONG", "SHORT"] as const) {
      const runs = allRuns[symbol][victim];
      for (let i = 0; i < runs.length; i++) {
        const w1 = runs[i];
        if (w1.regime !== "large" && w1.regime !== "extreme/shock") continue;
        let w2Idx = -1;
        for (let j = i + 1; j < runs.length; j++) {
          if (runs[j].regime !== "small/background") {
            w2Idx = j;
            break;
          }
        }
        if (w2Idx === -1) continue;
        const w2 = runs[w2Idx];
        const pauseMinutes = Math.round((w2.startTs - w1.endTs) / 60000) - 1;
        allCandidates.push({
          symbol,
          victim,
          regime: w1.regime as "large" | "extreme/shock",
          w1,
          w2,
          pauseMinutes,
        });
      }
    }
  }
  console.log(
    "\nTotal W1(large/extreme)->candidateW2 pairs available: " +
      allCandidates.length,
  );

  const largeBuckets: [string, (m: number) => boolean, number][] = [
    ["0-3min", (m) => m <= 3, 5],
    ["4-10min", (m) => m >= 4 && m <= 10, 5],
    ["10-30min", (m) => m > 10 && m <= 30, 5],
    [">30min", (m) => m > 30, 5],
  ];
  const selected: typeof allCandidates = [];
  const largeCandidates = allCandidates.filter((c) => c.regime === "large");
  for (const [bucketLabel, pred, count] of largeBuckets) {
    const inBucket = largeCandidates
      .filter((c) => pred(c.pauseMinutes))
      .sort((a, b) => b.w1.totalUsd - a.w1.totalUsd);
    const picked: typeof inBucket = [];
    const usedKeys = new Set<string>();
    for (const c of inBucket) {
      const key = c.symbol + c.victim;
      if (
        picked.length < count &&
        (!usedKeys.has(key) || picked.length < count / 2)
      ) {
        picked.push(c);
        usedKeys.add(key);
      }
      if (picked.length >= count) break;
    }
    if (picked.length < count)
      for (const c of inBucket) {
        if (picked.length >= count) break;
        if (!picked.includes(c)) picked.push(c);
      }
    picked.forEach((c) => selected.push(c));
    console.log(
      "LARGE " +
        bucketLabel +
        ": selected " +
        picked.length +
        "/" +
        inBucket.length +
        " available",
    );
  }
  const extremeCandidates = allCandidates
    .filter((c) => c.regime === "extreme/shock")
    .sort((a, b) => a.pauseMinutes - b.pauseMinutes);
  const extremeShort = extremeCandidates
    .slice(0, Math.ceil(extremeCandidates.length / 2))
    .sort((a, b) => b.w1.totalUsd - a.w1.totalUsd)
    .slice(0, 5);
  const extremeLong = extremeCandidates
    .slice(Math.ceil(extremeCandidates.length / 2))
    .sort((a, b) => b.w1.totalUsd - a.w1.totalUsd)
    .slice(0, 5);
  extremeShort.forEach((c) => selected.push(c));
  extremeLong.forEach((c) => selected.push(c));
  console.log(
    "EXTREME: selected " +
      (extremeShort.length + extremeLong.length) +
      " (" +
      extremeShort.length +
      " shorter-pause, " +
      extremeLong.length +
      " longer-pause)",
  );

  const auditCases: AuditCase[] = [];
  for (const cand of selected) {
    const { symbol, victim, regime, w1, w2, pauseMinutes } = cand;
    const { atrAt, closedCandleAt, candleAt } = helpers[symbol];
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

    let runningExtreme = w1Extreme;
    let maxRecoveryAtr = -Infinity,
      maxRecoveryUsd = 0;
    for (let t = w1.endTs + 60000; t < w2.startTs; t += 60000) {
      const c = candleAt(t);
      if (!c) continue;
      const ec = victim === "LONG" ? c.low : c.high;
      if (victim === "LONG" ? ec < runningExtreme : ec > runningExtreme) {
        runningExtreme = ec;
        maxRecoveryAtr = -Infinity;
      }
      const recUsd =
        victim === "LONG" ? c.close - runningExtreme : runningExtreme - c.close;
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

    const gapMinuteRows = allTimelines[symbol][victim].filter(
      (r) => r.minuteTs > w1.endTs && r.minuteTs < w2.startTs,
    );
    const residualGapMinutes = gapMinuteRows.filter(
      (r) => r.eventCount > 0,
    ).length;
    const residualGapUsd = gapMinuteRows.reduce(
      (s, r) => s + r.totalLiquidationUsd,
      0,
    );

    let w2Extreme: number | null = null;
    let w2ClosestApproach: number | null = null;
    for (let t = w2.startTs; t <= w2.endTs; t += 60000) {
      const c = candleAt(t);
      if (!c) continue;
      const v = victim === "LONG" ? c.low : c.high;
      if (
        w2Extreme === null ||
        (victim === "LONG" ? v < w2Extreme : v > w2Extreme)
      )
        w2Extreme = v;
      const approach = Math.abs(c.close - w1Extreme);
      if (w2ClosestApproach === null || approach < w2ClosestApproach)
        w2ClosestApproach = approach;
    }
    if (w2Extreme === null) continue;
    const w2StartCandle = closedCandleAt(w2.startTs);
    const w2StartPrice = w2StartCandle
      ? w2StartCandle.close
      : (candleAt(w2.startTs)?.open ?? runningExtreme);

    const w2NewTerritory =
      victim === "LONG" ? w2Extreme < w1Extreme : w2Extreme > w1Extreme;
    const incrementalExtensionUsd = w2NewTerritory
      ? Math.abs(w1Extreme - w2Extreme)
      : 0;
    const incrementalExtensionPct = (incrementalExtensionUsd / w1Extreme) * 100;
    const incrementalExtensionAtr = incrementalExtensionUsd / atrFrozen;

    const closestApproachUsd =
      w2ClosestApproach ?? Math.abs(w2StartPrice - w1Extreme);
    const closestApproachPct = (closestApproachUsd / w1Extreme) * 100;
    const closestApproachAtr = closestApproachUsd / atrFrozen;

    const pauseBucket =
      regime === "large"
        ? pauseMinutes <= 3
          ? "0-3min"
          : pauseMinutes <= 10
            ? "4-10min"
            : pauseMinutes <= 30
              ? "10-30min"
              : ">30min"
        : pauseMinutes <=
            (median(extremeCandidates.map((c) => c.pauseMinutes)) ?? 0)
          ? "shorter-pause"
          : "longer-pause";

    const spanStart = w1.startTs - 10 * 60000;
    const spanEnd = w2.endTs + 10 * 60000;
    const longTl = allTimelines[symbol].LONG,
      shortTl = allTimelines[symbol].SHORT;
    const sameTl = victim === "LONG" ? longTl : shortTl,
      oppTl = victim === "LONG" ? shortTl : longTl;
    const timeline: AuditCase["timeline"] = [];
    for (
      let t = spanStart;
      t <= Math.min(spanEnd, windowEndMinute);
      t += 60000
    ) {
      const c = candleAt(t);
      const sr = sameTl.find((r) => r.minuteTs === t),
        or = oppTl.find((r) => r.minuteTs === t);
      let label = "AFTER";
      if (t < w1.startTs) label = "BEFORE";
      else if (t <= w1.endTs) label = "W1";
      else if (t < w2.startTs) label = "BETWEEN";
      else if (t <= w2.endTs) label = "W2";
      timeline.push({
        minuteTs: t,
        ohlc: c ? c.open + "/" + c.high + "/" + c.low + "/" + c.close : null,
        sameSideUsd: sr?.totalLiquidationUsd ?? 0,
        oppositeSideUsd: or?.totalLiquidationUsd ?? 0,
        sameSideEventCount: sr?.eventCount ?? 0,
        sameSideMaxEvent: sr?.maxSingleEventUsd ?? 0,
        label,
      });
    }

    auditCases.push({
      symbol,
      victim,
      regime,
      pauseBucket,
      w1,
      w2,
      atrFrozen,
      w1StartPrice,
      w1Extreme,
      w1MoveUsd,
      w1MovePct,
      w1MoveAtr,
      pauseMinutes,
      maxRecoveryUsd,
      maxRecoveryPct,
      maxRecoveryAtr,
      recoveryFraction,
      residualGapMinutes,
      residualGapUsd,
      w2Extreme,
      w2StartPrice,
      w2ClosestApproachToW1ExtremeUsd: closestApproachUsd,
      w2ClosestApproachToW1ExtremePct: closestApproachPct,
      w2ClosestApproachToW1ExtremeAtr: closestApproachAtr,
      w2NewTerritory,
      incrementalExtensionUsd,
      incrementalExtensionPct,
      incrementalExtensionAtr,
      timeline,
    });
  }

  console.log("\n" + "=".repeat(100));
  console.log(auditCases.length + " AUDIT CASES -- FULL TIMELINES");
  console.log("=".repeat(100));
  auditCases.forEach((c, idx) => {
    console.log("\n" + "#".repeat(100));
    console.log(
      "CASE " +
        (idx + 1) +
        "/" +
        auditCases.length +
        "  " +
        c.symbol +
        " " +
        c.victim +
        "  [" +
        c.regime.toUpperCase() +
        ", pause bucket=" +
        c.pauseBucket +
        "]",
    );
    console.log("#".repeat(100));
    console.log(
      "W1: totalUSD=" +
        fmtUsd(c.w1.totalUsd) +
        " duration=" +
        c.w1.durationMinutes +
        "min movePct=" +
        c.w1MovePct.toFixed(3) +
        "% atrFrozen=" +
        c.atrFrozen.toFixed(4) +
        " moveATR=" +
        c.w1MoveAtr.toFixed(3),
    );
    console.log(
      "BETWEEN: pause=" +
        c.pauseMinutes +
        "min maxRecoveryPct=" +
        c.maxRecoveryPct.toFixed(3) +
        "% maxRecoveryATR=" +
        c.maxRecoveryAtr.toFixed(3) +
        " recoveryFractionOfW1Move=" +
        c.recoveryFraction.toFixed(3) +
        "  residualGapActivity=" +
        c.residualGapMinutes +
        "min/" +
        fmtUsd(c.residualGapUsd) +
        " (same-side, did not qualify as a run)",
    );
    console.log(
      "CANDIDATE W2: totalUSD=" +
        fmtUsd(c.w2.totalUsd) +
        " duration=" +
        c.w2.durationMinutes +
        "min  closestApproachToW1Extreme=" +
        c.w2ClosestApproachToW1ExtremePct.toFixed(3) +
        "% (" +
        c.w2ClosestApproachToW1ExtremeAtr.toFixed(3) +
        " ATR)  exceedsW1Extreme=" +
        (c.w2NewTerritory ? "YES" : "NO") +
        "  incrementalExtension=" +
        c.incrementalExtensionPct.toFixed(3) +
        "% (" +
        c.incrementalExtensionAtr.toFixed(3) +
        " ATR)",
    );
    console.log(
      "\ntimestamp | O/H/L/C | sameSideUSD | oppSideUSD | sameSideCount | sameSideMaxEvent | label",
    );
    c.timeline.forEach((r) =>
      console.log(
        fmtClock(r.minuteTs) +
          " | " +
          (r.ohlc ?? "n/a") +
          " | " +
          fmtUsd(r.sameSideUsd) +
          " | " +
          fmtUsd(r.oppositeSideUsd) +
          " | " +
          r.sameSideEventCount +
          " | " +
          fmtUsd(r.sameSideMaxEvent) +
          " | " +
          r.label,
      ),
    );
    console.log("\nJUDGMENT: [pending manual review of the timeline above]");
  });

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "audit-w1-w2-timelines-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        totalCandidatesAvailable: allCandidates.length,
        auditCases,
      },
      null,
      2,
    ),
  );
  console.log("\n\nFull case data + timelines saved to: " + outPath);
  console.log(
    "\nNOTE: no same/ambiguous/different verdict is computed in this script. That judgment requires reading the printed timelines above and is a follow-up analysis step, not a rule baked in here.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
