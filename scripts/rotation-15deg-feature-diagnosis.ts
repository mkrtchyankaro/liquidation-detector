/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, diagnostic ONLY
 * on the 15-degree directional ATR rotation entry -- no new angle
 * search. Focused on WHY some 15deg rotations succeed and others
 * fail, across three named populations: ALL3>=P99, totalUSD>=P99,
 * ALL3>=P97.
 *
 * Reuses the identical, unchanged episode/percentile/theta/slope
 * machinery from the rotation-entry pass. "Total rotation degrees"
 * and "rotation duration" are measured from the MAXIMUM liquidation-
 * direction distortion point (the true theta trough within the shock
 * window) to the entry -- not from episode end -- since the operator
 * specifically asked for both the max-distortion state AND the
 * rotation FROM it as separate, named features here. This is a
 * slightly different reference point than the prior pass's entry-
 * search (which anchored at episode-end for causal-search purposes);
 * both are causal, but this one is more physically informative for
 * the "how far did it actually swing back" question being asked now.
 *
 * All directional ATR slopes are normalized by PRE-liquidation ATR
 * values, exactly as instructed.
 *
 * Distributions (median/P25/P75) are reported per feature, split by
 * TP/SL/TIMEOUT outcome, over the pooled union of the three named
 * populations (deduplicated by symbol+victim+episode). Each named
 * population's own count is also reported separately. A separation
 * score (|median(TP)-median(SL)| / pooled IQR) ranks features by how
 * cleanly they separate outcomes -- purely descriptive, not a
 * classifier and not a threshold recommendation.
 *
 * No threshold optimized. No production rule created. No production
 * code touched.
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
const NORM_WALK_CAP_MIN = 120;
const MIN_PRIOR_SAMPLES = 15;
const POST_ENTRY_WATCH_MIN = 30;
const SHOCK_WINDOW_EXTRA_MIN = 30;
const SL_PCT = 0.3,
  TP_PCT = 0.6;
const ROTATION_DEG = 15;

function sortNum(a: (number | null)[]) {
  return a
    .filter(
      (x): x is number =>
        x !== null && x !== undefined && !isNaN(x) && Number.isFinite(x),
    )
    .sort((x, y) => x - y);
}
function median(a: (number | null)[]) {
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
function percentileRankOf(priorSorted: number[], value: number): number {
  if (priorSorted.length === 0) return 0;
  let c = 0;
  for (const v of priorSorted) if (v <= value) c++;
  return (c / priorSorted.length) * 100;
}
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
function thetaDeg(liq: number, rec: number): number {
  return Math.atan2(rec, liq) * (180 / Math.PI);
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

type Candle = {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
};
type Victim = "LONG" | "SHORT";

function directionalTrV1(
  candlesAsc: Candle[],
): { t: number; downTr: number; upTr: number }[] {
  const out: { t: number; downTr: number; upTr: number }[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    out.push({
      t: c.t,
      downTr: Math.max(0, p.close - c.low),
      upTr: Math.max(0, c.high - p.close),
    });
  }
  return out;
}
function emaOfSeries(
  series: { t: number; v: number }[],
  period: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (series.length === 0) return out;
  const alpha = 2 / (period + 1);
  let ema = series[0].v;
  out.set(series[0].t, ema);
  for (let i = 1; i < series.length; i++) {
    ema = alpha * series[i].v + (1 - alpha) * ema;
    out.set(series[i].t, ema);
  }
  return out;
}
function lookupCausal(
  seriesMap: Map<number, number>,
  ms: number,
): number | null {
  let t = Math.floor(ms / 60000) * 60000 - 60000;
  for (let i = 0; i < 400; i++) {
    if (seriesMap.has(t)) return seriesMap.get(t)!;
    t -= 60000;
  }
  return null;
}
function candleAt(klines: Map<number, Candle>, ms: number): Candle | null {
  return klines.get(Math.floor(ms / 60000) * 60000) || null;
}

interface RawEvent {
  timestamp: number;
  price: number;
  quoteQty: number;
}
interface Wave {
  symbol: string;
  victim: Victim;
  waveIndex: number;
  startTs: number;
  endTs: number;
  durationMinutes: number;
  totalUsd: number;
  eventCount: number;
  maxSingleEventUsd: number;
  extremePrice: number;
  extremeTs: number;
  regime: string;
  events: RawEvent[];
}

interface Trade15 {
  symbol: string;
  victim: Victim;
  waveIndex: number;
  entryTs: number;
  entryPrice: number;
  populations: string[];
  outcome: "TP" | "SL" | "TIMEOUT" | "AMBIGUOUS";
  features: Record<string, number | null>;
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
  const windowEnd = now;

  const trades: Trade15[] = [];

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = (await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: windowEnd } })
      .sort({ timestamp: 1 })
      .toArray()) as unknown as RawEvent[];
    if (events.length === 0) {
      console.log("  NO DATA.\n");
      continue;
    }
    const actualEarliest = events[0].timestamp,
      actualLatest = events[events.length - 1].timestamp;

    const klines = await fetchKlines(
      symbol,
      actualEarliest - 8 * 3600000,
      actualLatest + (NORM_WALK_CAP_MIN / 60 + 1) * 3600000,
    );
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    if (candlesAsc.length < 15) {
      console.log("  insufficient candles.\n");
      continue;
    }

    const dtrV1 = directionalTrV1(candlesAsc);
    const downV1 = emaOfSeries(
      dtrV1.map((d) => ({ t: d.t, v: d.downTr })),
      14,
    );
    const upV1 = emaOfSeries(
      dtrV1.map((d) => ({ t: d.t, v: d.upTr })),
      14,
    );

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = events.filter(
        (e) => (e as any).victim === victim,
      ) as any[];
      if (sideEvents.length === 0) continue;
      const byMinute = new Map<number, any[]>();
      for (const e of sideEvents) {
        const m = Math.floor(e.timestamp / 60000) * 60000;
        if (!byMinute.has(m)) byMinute.set(m, []);
        byMinute.get(m)!.push(e);
      }
      const minuteKeys: number[] = [];
      for (let t = windowStart; t <= windowEnd; t += 60000)
        if (byMinute.has(t)) minuteKeys.push(t);

      const rawWaves: {
        startTs: number;
        endTs: number;
        durationMinutes: number;
        totalUsd: number;
        eventCount: number;
        maxSingleEventUsd: number;
        events: RawEvent[];
      }[] = [];
      let curEvents: any[] = [];
      let lastMinute: number | null = null;
      for (const m of minuteKeys) {
        if (lastMinute !== null && m - lastMinute > 60000) {
          rawWaves.push(buildWave(curEvents));
          curEvents = [];
        }
        curEvents.push(...byMinute.get(m)!);
        lastMinute = m;
      }
      if (curEvents.length > 0) rawWaves.push(buildWave(curEvents));
      function buildWave(evs: any[]) {
        return {
          startTs: evs[0].timestamp,
          endTs: evs[evs.length - 1].timestamp,
          durationMinutes:
            Math.round(
              (Math.floor(evs[evs.length - 1].timestamp / 60000) * 60000 -
                Math.floor(evs[0].timestamp / 60000) * 60000) /
                60000,
            ) + 1,
          totalUsd: evs.reduce((s: number, e: any) => s + e.quoteQty, 0),
          eventCount: evs.length,
          maxSingleEventUsd: Math.max(...evs.map((e: any) => e.quoteQty)),
          events: evs as RawEvent[],
        };
      }

      const totals = sortNum(rawWaves.map((r) => r.totalUsd));
      const p50 = percentile(totals, 50)!,
        p80 = percentile(totals, 80)!,
        p95Regime = percentile(totals, 95)!;
      const waves: Wave[] = rawWaves.map((r, idx) => {
        const regime =
          r.totalUsd < p50
            ? "small"
            : r.totalUsd < p80
              ? "medium"
              : r.totalUsd < p95Regime
                ? "large"
                : "extreme";
        let extremePrice = r.events[0].price,
          extremeTs = r.events[0].timestamp;
        for (const e of r.events) {
          if (
            victim === "LONG" ? e.price < extremePrice : e.price > extremePrice
          ) {
            extremePrice = e.price;
            extremeTs = e.timestamp;
          }
        }
        return {
          symbol,
          victim,
          waveIndex: idx,
          ...r,
          extremePrice,
          extremeTs,
          regime,
        };
      });

      const priorTotalUsd: number[] = [],
        priorMaxEvent: number[] = [],
        priorUsdPerMin: number[] = [];
      for (const w of waves) {
        let totalUsdPercentile: number | null = null,
          maxEventPercentile: number | null = null,
          usdPerMinPercentile: number | null = null;
        if (priorTotalUsd.length >= MIN_PRIOR_SAMPLES) {
          totalUsdPercentile = percentileRankOf(
            [...priorTotalUsd].sort((a, b) => a - b),
            w.totalUsd,
          );
          maxEventPercentile = percentileRankOf(
            [...priorMaxEvent].sort((a, b) => a - b),
            w.maxSingleEventUsd,
          );
          usdPerMinPercentile = percentileRankOf(
            [...priorUsdPerMin].sort((a, b) => a - b),
            w.totalUsd / w.durationMinutes,
          );
        }
        const pops: string[] = [];
        if (totalUsdPercentile !== null && totalUsdPercentile >= 99)
          pops.push("totalUSD>=P99");
        if (
          totalUsdPercentile !== null &&
          totalUsdPercentile >= 99 &&
          maxEventPercentile !== null &&
          maxEventPercentile >= 99 &&
          usdPerMinPercentile !== null &&
          usdPerMinPercentile >= 99
        )
          pops.push("ALL3>=P99");
        if (
          totalUsdPercentile !== null &&
          totalUsdPercentile >= 97 &&
          maxEventPercentile !== null &&
          maxEventPercentile >= 97 &&
          usdPerMinPercentile !== null &&
          usdPerMinPercentile >= 97
        )
          pops.push("ALL3>=P97");
        if (
          (w.regime === "large" || w.regime === "extreme") &&
          pops.length > 0
        ) {
          const t = computeTrade(w, downV1, upV1, klines, events, pops);
          if (t) trades.push(t);
        }
        priorTotalUsd.push(w.totalUsd);
        priorMaxEvent.push(w.maxSingleEventUsd);
        priorUsdPerMin.push(w.totalUsd / w.durationMinutes);
      }
    }
  }

  function computeTrade(
    w: Wave,
    downV1: Map<number, number>,
    upV1: Map<number, number>,
    klines: Map<number, Candle>,
    allEvents: any[],
    pops: string[],
  ): Trade15 | null {
    const victim = w.victim;
    const preDownAtr = lookupCausal(downV1, w.startTs),
      preUpAtr = lookupCausal(upV1, w.startTs);
    const postDownAtr = lookupCausal(downV1, w.endTs),
      postUpAtr = lookupCausal(upV1, w.endTs);
    if (
      preDownAtr === null ||
      preUpAtr === null ||
      postDownAtr === null ||
      postUpAtr === null ||
      preDownAtr <= 0 ||
      preUpAtr <= 0
    )
      return null;
    const preLiqAtr = victim === "LONG" ? preDownAtr : preUpAtr,
      preRecAtr = victim === "LONG" ? preUpAtr : preDownAtr;
    const postLiqAtr = victim === "LONG" ? postDownAtr : postUpAtr,
      postRecAtr = victim === "LONG" ? postUpAtr : postDownAtr;
    if (postRecAtr <= 0) return null;
    const liqSeries = victim === "LONG" ? downV1 : upV1,
      recSeries = victim === "LONG" ? upV1 : downV1;
    const thetaPre = thetaDeg(preLiqAtr, preRecAtr);
    const thetaAtEnd = thetaDeg(postLiqAtr, postRecAtr);

    let minTheta = thetaAtEnd,
      minThetaTs = w.endTs,
      downAtMaxDist = postDownAtr,
      upAtMaxDist = postUpAtr;
    for (
      let t = w.startTs;
      t <= w.endTs + SHOCK_WINDOW_EXTRA_MIN * 60000;
      t += 60000
    ) {
      const l = lookupCausal(liqSeries, t),
        r = lookupCausal(recSeries, t);
      if (l === null || r === null || r <= 0) continue;
      const th = thetaDeg(l, r);
      if (th < minTheta) {
        minTheta = th;
        minThetaTs = t;
        downAtMaxDist = lookupCausal(downV1, t) ?? downAtMaxDist;
        upAtMaxDist = lookupCausal(upV1, t) ?? upAtMaxDist;
      }
    }

    let entryTs: number | null = null,
      entryPrice: number | null = null;
    for (
      let t = Math.floor(w.endTs / 60000) * 60000;
      t <= w.endTs + NORM_WALK_CAP_MIN * 60000;
      t += 60000
    ) {
      const curLiq = lookupCausal(liqSeries, t),
        curRec = lookupCausal(recSeries, t);
      if (curLiq === null || curRec === null || curRec <= 0) continue;
      const curTheta = thetaDeg(curLiq, curRec);
      if (curTheta - thetaAtEnd >= ROTATION_DEG) {
        const c = candleAt(klines, t);
        if (c) {
          entryTs = t;
          entryPrice = c.close;
        }
        break;
      }
    }
    if (entryTs === null || entryPrice === null) return null;

    const downAtEntry = lookupCausal(downV1, entryTs)!,
      upAtEntry = lookupCausal(upV1, entryTs)!;
    const thetaAtEntry = thetaDeg(
      victim === "LONG" ? downAtEntry : upAtEntry,
      victim === "LONG" ? upAtEntry : downAtEntry,
    );
    const totalRotationDeg = thetaAtEntry - minTheta;
    const rotationDurationMin = (entryTs - minThetaTs) / 60000;
    const degPerMinute =
      rotationDurationMin > 0 ? totalRotationDeg / rotationDurationMin : null;

    function slopeNorm(
      series: Map<number, number>,
      preAtr: number,
      windowMin: number,
    ): number | null {
      const cur = lookupCausal(series, entryTs!),
        past = lookupCausal(series, entryTs! - windowMin * 60000);
      if (cur === null || past === null || preAtr <= 0) return null;
      return (cur - past) / windowMin / preAtr;
    }

    const sameSideEvents = allEvents.filter((e) => e.victim === victim);
    const beforeEntry = sameSideEvents
      .filter((e) => e.timestamp <= entryTs!)
      .sort((a, b) => b.timestamp - a.timestamp);
    const secondsSinceLastLiq =
      beforeEntry.length > 0
        ? (entryTs - beforeEntry[0].timestamp) / 1000
        : null;
    const usdInWindow = (sec: number) =>
      sameSideEvents
        .filter(
          (e) => e.timestamp <= entryTs! && e.timestamp > entryTs! - sec * 1000,
        )
        .reduce((s, e) => s + e.quoteQty, 0);
    const countInWindow = (sec: number) =>
      sameSideEvents.filter(
        (e) => e.timestamp <= entryTs! && e.timestamp > entryTs! - sec * 1000,
      ).length;

    const distFromExtremeToEntryAtr =
      Math.abs(entryPrice - w.extremePrice) / preRecAtr;
    const timeFromExtremeToEntryMin = (entryTs - w.extremeTs) / 60000;
    const shockAtr = Math.abs(w.events[0].price - w.extremePrice) / preLiqAtr;

    const slDist = entryPrice * (SL_PCT / 100),
      tpDist = entryPrice * (TP_PCT / 100);
    const slLevel =
      victim === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    const tpLevel =
      victim === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
    let outcome: Trade15["outcome"] = "TIMEOUT";
    for (
      let t = entryTs + 60000;
      t <= entryTs + POST_ENTRY_WATCH_MIN * 60000;
      t += 60000
    ) {
      const c = candleAt(klines, t);
      if (!c) continue;
      const hitTp = victim === "LONG" ? c.high >= tpLevel : c.low <= tpLevel;
      const hitSl = victim === "LONG" ? c.low <= slLevel : c.high >= slLevel;
      if (hitTp && hitSl) {
        outcome = "AMBIGUOUS";
        break;
      }
      if (hitSl) {
        outcome = "SL";
        break;
      }
      if (hitTp) {
        outcome = "TP";
        break;
      }
    }

    const features: Record<string, number | null> = {
      thetaPre,
      minTheta,
      thetaAtEntry,
      totalRotationDeg,
      rotationDurationMin,
      degPerMinute,
      preDownAtr,
      preUpAtr,
      downAtMaxDist,
      upAtMaxDist,
      downAtEntry,
      upAtEntry,
      downSlope1m: slopeNorm(downV1, preDownAtr, 1),
      upSlope1m: slopeNorm(upV1, preUpAtr, 1),
      downSlope2m: slopeNorm(downV1, preDownAtr, 2),
      upSlope2m: slopeNorm(upV1, preUpAtr, 2),
      downSlope3m: slopeNorm(downV1, preDownAtr, 3),
      upSlope3m: slopeNorm(upV1, preUpAtr, 3),
      secondsSinceLastLiq,
      usd30s: usdInWindow(30),
      usd60s: usdInWindow(60),
      usd120s: usdInWindow(120),
      count30s: countInWindow(30),
      count60s: countInWindow(60),
      count120s: countInWindow(120),
      totalEpisodeUsd: w.totalUsd,
      largestEventSoFar: w.maxSingleEventUsd,
      usdPerMinSoFar: w.totalUsd / w.durationMinutes,
      shockAtr,
      distFromExtremeToEntryAtr,
      timeFromExtremeToEntryMin,
      ratioAtEntry:
        (victim === "LONG" ? downAtEntry : upAtEntry) /
        (victim === "LONG" ? upAtEntry : downAtEntry),
    };

    return {
      symbol: w.symbol,
      victim,
      waveIndex: w.waveIndex,
      entryTs,
      entryPrice,
      populations: pops,
      outcome,
      features,
    };
  }

  console.log(
    "\nTotal 15deg-rotation trades found (any of the 3 named populations): " +
      trades.length,
  );
  for (const popName of ["ALL3>=P99", "totalUSD>=P99", "ALL3>=P97"])
    console.log(
      "  " +
        popName +
        ": n=" +
        trades.filter((t) => t.populations.includes(popName)).length,
    );

  const featureNames = Object.keys(trades[0]?.features ?? {});
  const byOutcome = (o: string) => trades.filter((t) => t.outcome === o);
  const tpTrades = byOutcome("TP"),
    slTrades = byOutcome("SL"),
    toTrades = byOutcome("TIMEOUT");
  console.log(
    "\nOutcome counts (pooled, union of 3 populations): TP=" +
      tpTrades.length +
      " SL=" +
      slTrades.length +
      " TIMEOUT=" +
      toTrades.length +
      " AMBIGUOUS=" +
      byOutcome("AMBIGUOUS").length,
  );

  console.log("\n" + "=".repeat(175));
  console.log("FEATURE DISTRIBUTIONS: TP vs SL vs TIMEOUT (median [P25, P75])");
  console.log("=".repeat(175));
  function fmtDist(vals: (number | null)[]): string {
    const s = sortNum(vals);
    if (s.length === 0) return "n/a";
    return (
      (percentile(s, 50)?.toFixed(3) ?? "n/a") +
      " [" +
      (percentile(s, 25)?.toFixed(3) ?? "n/a") +
      "," +
      (percentile(s, 75)?.toFixed(3) ?? "n/a") +
      "]"
    );
  }
  const separationScores: { feature: string; score: number | null }[] = [];
  for (const f of featureNames) {
    const allVals = sortNum(trades.map((t) => t.features[f]));
    const iqr =
      allVals.length > 0
        ? percentile(allVals, 75)! - percentile(allVals, 25)!
        : null;
    const tpVals = tpTrades.map((t) => t.features[f]),
      slVals = slTrades.map((t) => t.features[f]),
      toVals = toTrades.map((t) => t.features[f]);
    const medTp = median(tpVals),
      medSl = median(slVals);
    const score =
      medTp !== null && medSl !== null && iqr !== null && iqr > 0
        ? Math.abs(medTp - medSl) / iqr
        : null;
    separationScores.push({ feature: f, score });
    console.log(
      "  " +
        f.padEnd(24) +
        " TP: " +
        fmtDist(tpVals) +
        "   SL: " +
        fmtDist(slVals) +
        "   TIMEOUT: " +
        fmtDist(toVals),
    );
  }

  console.log("\n" + "=".repeat(175));
  console.log(
    "TOP FEATURES BY SEPARATION SCORE (|median(TP)-median(SL)| / pooled IQR) -- descriptive only, not a classifier",
  );
  console.log("=".repeat(175));
  const ranked = separationScores
    .filter((s) => s.score !== null)
    .sort((a, b) => b.score! - a.score!);
  ranked
    .slice(0, 8)
    .forEach((s, i) =>
      console.log(
        "  " + (i + 1) + ". " + s.feature + "  score=" + s.score!.toFixed(3),
      ),
    );

  console.log("\n" + "=".repeat(175));
  console.log("ALL3>=P99 INDIVIDUAL 15deg-ROTATION TRADES (compact table)");
  console.log("=".repeat(175));
  console.log(
    "symbol | side | tradeDir | entry time | entryPrice | rotDeg | rotDurMin | degPerMin | liqSlope1m(norm) | recSlope1m(norm) | secSinceLastLiq | usd60s | distExtremeATR | ShockATR | ratioAtEntry | result",
  );
  const all3p99Trades = trades
    .filter((t) => t.populations.includes("ALL3>=P99"))
    .sort((a, b) => a.entryTs - b.entryTs);
  console.log(
    "(n=" +
      all3p99Trades.length +
      " -- if this isn't 11, that's real information: check whether some episodes were excluded for insufficient prior percentile history, or whether the underlying liquidation data has changed since the earlier estimate)",
  );
  for (const t of all3p99Trades) {
    const f = t.features;
    const liqSlope1m = t.victim === "LONG" ? f.downSlope1m : f.upSlope1m;
    const recSlope1m = t.victim === "LONG" ? f.upSlope1m : f.downSlope1m;
    const tradeDirection = t.victim === "LONG" ? "LONG" : "SHORT"; // reversal trade direction mirrors victim side, per the established entry rule
    console.log(
      t.symbol +
        " | " +
        t.victim +
        " | " +
        tradeDirection +
        " | " +
        fmtClock(t.entryTs) +
        " | " +
        t.entryPrice.toFixed(4) +
        " | " +
        (f.totalRotationDeg?.toFixed(1) ?? "n/a") +
        " | " +
        (f.rotationDurationMin?.toFixed(1) ?? "n/a") +
        " | " +
        (f.degPerMinute?.toFixed(2) ?? "n/a") +
        " | " +
        (liqSlope1m?.toFixed(4) ?? "n/a") +
        " | " +
        (recSlope1m?.toFixed(4) ?? "n/a") +
        " | " +
        (f.secondsSinceLastLiq?.toFixed(0) ?? "n/a") +
        " | $" +
        ((f.usd60s ?? 0) / 1000).toFixed(1) +
        "k | " +
        (f.distFromExtremeToEntryAtr?.toFixed(3) ?? "n/a") +
        " | " +
        (f.shockAtr?.toFixed(3) ?? "n/a") +
        " | " +
        (f.ratioAtEntry?.toFixed(3) ?? "n/a") +
        " | " +
        t.outcome,
    );
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "rotation-15deg-feature-diagnosis-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        hoursWindow: HOURS,
        slPct: SL_PCT,
        tpPct: TP_PCT,
        rotationDeg: ROTATION_DEG,
        trades,
        separationScores: ranked,
      },
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
