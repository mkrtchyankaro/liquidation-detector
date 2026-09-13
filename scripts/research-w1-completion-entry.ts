/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research: can a
 * strong P95-qualified W1 COMPLETION itself be the entry, without
 * waiting for W2?
 *
 * Reconstructs every valid P95-qualified W1 over the last 72h, for
 * every production symbol and both victim sides, using the REAL,
 * current CandlePhysicsEngine class (imported directly, never
 * reimplemented -- so W1 qualification/completion exactly matches
 * production logic). Measures how far W1's own completion price is
 * from the actual liquidation extreme (completionRecoveryPct/ATR),
 * then simulates a hypothetical entry AT W1 completion with a grid of
 * SL/TP combinations, evaluated at 5/10/15/30-minute horizons using
 * real subsequent 1m candle data. Finally buckets W1s by strength
 * (maxEvent/P95 ratio, total-liq/P95 ratio, directional ATR move,
 * priceEfficiency) to see whether "stronger" W1s produce better
 * completion-entries.
 *
 * READ-ONLY. No production code changed. No Mongo writes. No PM2
 * restart. This is research only -- it does not change how the live
 * engine behaves.
 *
 * DISCLOSED APPROXIMATION: P95 is reconstructed here as a trailing
 * 24h rolling percentile of individual same-side event sizes for
 * that symbol, computed directly from liq_raw_events. This is NOT
 * byte-identical to the live LiquidationStatsService (which the
 * production orchestrator actually calls) -- that service is not
 * standalone-replayable outside the running process. The
 * approximation is disclosed, not hidden, and uses the exact same
 * percentile definition (P95) the production W1-qualification check
 * uses.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import {
  CandlePhysicsEngine,
  type CompletedWaveSummary,
} from "../src/domain/cascade/candle-physics-engine";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "AVAXUSDT",
];
const HOURS = 72;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

const SL_PCTS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
const RR_LEVELS = [2.0, 2.5, 3.0];
const HORIZON_MIN = [5, 10, 15, 30];

function fmtUsd(n: number | null) {
  if (n === null || n === undefined) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtPct(n: number | null, d?: number) {
  return n === null || n === undefined ? "n/a" : n.toFixed(d ?? 2) + "%";
}
function fmtDur(ms: number | null) {
  if (ms === null) return "n/a";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(0) + "s";
  return (s / 60).toFixed(1) + "m";
}
function sortNum(a: number[]) {
  return [...a]
    .filter((x) => x !== null && x !== undefined && !isNaN(x))
    .sort((x, y) => x - y);
}
function percentile(arr: (number | null)[], p: number): number | null {
  const s = sortNum(arr as number[]);
  if (!s.length) return null;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function median(a: (number | null)[]) {
  return percentile(a, 50);
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
  const byOpenTime = new Map<
    number,
    { t: number; open: number; high: number; low: number; close: number }
  >();
  let cursor = startTime;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + 1499 * 60000, endTime);
    const url =
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=1500";
    const raw = await httpsGetJson(url);
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw)
      byOpenTime.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    cursor = raw[raw.length - 1][0] + 60000;
  }
  return byOpenTime;
}

interface W1Record {
  symbol: string;
  victim: "LONG" | "SHORT";
  startTime: number;
  completionTime: number;
  durationMs: number;
  eventCount: number;
  totalLiqUsd: number;
  maxEventUsd: number;
  p95AtQualification: number;
  maxEventOverP95: number;
  unitAbs: number;
  directionalMoveAtr: number;
  priceEfficiency: number | null;
  extremePrice: number;
  completionPrice: number;
  completionRecoveryPct: number;
  completionRecoveryAtr: number;
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
  const startTs = now - HOURS * 3600 * 1000;
  console.log(
    "Reconstructing P95-qualified W1s across " +
      SYMBOLS.length +
      " symbols, last " +
      HOURS +
      "h...\n",
  );

  const allW1s: W1Record[] = [];

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const allSymbolEvents = await col
      .find({ symbol, timestamp: { $gte: startTs - 24 * 3600000, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    const windowEvents = allSymbolEvents.filter((e) => e.timestamp >= startTs);
    if (windowEvents.length === 0) {
      console.log("  no events in window.\n");
      continue;
    }

    const klines = await fetchKlines(
      symbol,
      startTs - 5 * 3600000,
      now + 40 * 60000,
    ); // ATR warmup + trade-sim lookahead buffer
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    if (candlesAsc.length < 241) {
      console.log("  insufficient candle history for ATR(240) -- skipping.\n");
      continue;
    }

    function simpleAtr240(uptoMs: number): number | null {
      const before = candlesAsc.filter((c) => c.t < uptoMs);
      if (before.length < 241) return null;
      const w = before.slice(-241);
      let sum = 0;
      for (let i = 1; i < w.length; i++)
        sum += Math.max(
          w[i].high - w[i].low,
          Math.abs(w[i].high - w[i - 1].close),
          Math.abs(w[i].low - w[i - 1].close),
        );
      return sum / (w.length - 1);
    }
    function candleAt(ms: number) {
      return klines.get(Math.floor(ms / 60000) * 60000) || null;
    }

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEventsAll = allSymbolEvents.filter((e) => e.victim === victim);
      const sideEventsWindow = windowEvents.filter((e) => e.victim === victim);
      if (sideEventsWindow.length === 0) continue;

      function rollingP95(atMs: number): number | null {
        const sample = sideEventsAll
          .filter(
            (e) => e.timestamp >= atMs - 24 * 3600000 && e.timestamp < atMs,
          )
          .map((e) => e.quoteQty)
          .sort((a, b) => a - b);
        if (sample.length < 30) return null;
        const idx = 0.95 * (sample.length - 1);
        const lo = Math.floor(idx),
          hi = Math.ceil(idx);
        return lo === hi
          ? sample[lo]
          : sample[lo] + (sample[hi] - sample[lo]) * (idx - lo);
      }

      const engine = new CandlePhysicsEngine();
      const relevantCandles = candlesAsc.filter(
        (c) => c.t >= startTs - 20 * 60000 && c.t <= now,
      );
      let eventIdx = 0;
      let lastW1QualTs: number | null = null;

      for (const candle of relevantCandles) {
        while (
          eventIdx < sideEventsAll.length &&
          sideEventsAll[eventIdx].timestamp < candle.t
        ) {
          const e = sideEventsAll[eventIdx];
          const unit = simpleAtr240(e.timestamp);
          if (unit && unit > 0) {
            engine.onLiquidation(
              symbol,
              victim,
              {
                symbol,
                side: victim === "LONG" ? "SELL" : "BUY",
                price: e.price,
                quantity: e.quoteQty / e.price,
                quoteQty: e.quoteQty,
                timestamp: e.timestamp,
              },
              unit,
              e.price,
              e.timestamp,
            );
          }
          eventIdx++;
        }
        const p95 = rollingP95(candle.t);
        engine.onClosedCandle(
          symbol,
          victim,
          candle.t,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          p95,
        );

        const w = engine.peekWatch(symbol, victim);
        if (
          w &&
          w.dominantWave !== null &&
          w.dominantWave.waveNumber === 1 &&
          w.w1QualificationTs !== null &&
          w.w1QualificationTs !== lastW1QualTs &&
          w.w1QualificationTs >= startTs
        ) {
          lastW1QualTs = w.w1QualificationTs;
          const dw: CompletedWaveSummary = w.dominantWave;
          const p95AtQual = w.p95AtW1Qualification!;
          const maxEvent = w.maxIndividualEventUsdAtW1!;
          const completionPrice = candleAt(dw.endTime)?.close ?? null;
          if (completionPrice === null) continue;
          const unitAbs = w.unitAbs;
          const completionRecoveryPct =
            victim === "LONG"
              ? ((completionPrice - dw.extreme) / dw.extreme) * 100
              : ((dw.extreme - completionPrice) / dw.extreme) * 100;
          const completionRecoveryAtr =
            victim === "LONG"
              ? (completionPrice - dw.extreme) / unitAbs
              : (dw.extreme - completionPrice) / unitAbs;

          allW1s.push({
            symbol,
            victim,
            startTime: dw.startTime,
            completionTime: dw.endTime,
            durationMs: dw.endTime - dw.startTime,
            eventCount: dw.totalEvents,
            totalLiqUsd: dw.totalLiqUsd,
            maxEventUsd: maxEvent,
            p95AtQualification: p95AtQual,
            maxEventOverP95: maxEvent / p95AtQual,
            unitAbs,
            directionalMoveAtr: dw.totalExtensionUnits,
            priceEfficiency: dw.efficiency,
            extremePrice: dw.extreme,
            completionPrice,
            completionRecoveryPct,
            completionRecoveryAtr,
          });
        }
      }
    }
    const symbolW1Count = allW1s.filter((w) => w.symbol === symbol).length;
    console.log("  " + symbolW1Count + " valid P95-qualified W1(s) found.\n");
  }

  console.log(
    "TOTAL valid P95-qualified W1s across all symbols/sides: " +
      allW1s.length +
      "\n",
  );

  // ═══ Completion-recovery distributions ═══
  console.log("=".repeat(100));
  console.log(
    "COMPLETION-RECOVERY DISTRIBUTIONS (how late W1-completion is vs the actual extreme)",
  );
  console.log("=".repeat(100));
  function distLine(label: string, w1s: W1Record[]) {
    const pcts = w1s.map((w) => w.completionRecoveryPct);
    const atrs = w1s.map((w) => w.completionRecoveryAtr);
    console.log(label + " (n=" + w1s.length + "):");
    console.log(
      "  recoveryPct: p25=" +
        fmtPct(percentile(pcts, 25)) +
        " median=" +
        fmtPct(percentile(pcts, 50)) +
        " p75=" +
        fmtPct(percentile(pcts, 75)) +
        " p90=" +
        fmtPct(percentile(pcts, 90)),
    );
    console.log(
      "  recoveryATR: p25=" +
        (percentile(atrs, 25)?.toFixed(3) ?? "n/a") +
        " median=" +
        (percentile(atrs, 50)?.toFixed(3) ?? "n/a") +
        " p75=" +
        (percentile(atrs, 75)?.toFixed(3) ?? "n/a") +
        " p90=" +
        (percentile(atrs, 90)?.toFixed(3) ?? "n/a"),
    );
  }
  distLine("COMBINED", allW1s);
  for (const side of ["LONG", "SHORT"] as const)
    distLine(
      side,
      allW1s.filter((w) => w.victim === side),
    );
  for (const symbol of SYMBOLS) {
    const symW1s = allW1s.filter((w) => w.symbol === symbol);
    if (symW1s.length > 0) {
      for (const side of ["LONG", "SHORT"] as const) {
        const s = symW1s.filter((w) => w.victim === side);
        if (s.length) distLine(symbol + " " + side, s);
      }
    }
  }

  // ═══ Trade simulation at W1 completion ═══
  console.log("\n" + "=".repeat(100));
  console.log("TRADE SIMULATION -- ENTRY EXACTLY AT W1 COMPLETION");
  console.log("=".repeat(100));

  const allKlinesBySymbol = new Map<string, Map<number, any>>();
  for (const symbol of SYMBOLS) {
    if (!allW1s.some((w) => w.symbol === symbol)) continue;
    allKlinesBySymbol.set(
      symbol,
      await fetchKlines(symbol, startTs, now + 40 * 60000),
    );
  }
  function candleAtGlobal(symbol: string, ms: number) {
    return (
      allKlinesBySymbol.get(symbol)?.get(Math.floor(ms / 60000) * 60000) || null
    );
  }

  function simulateTrade(
    symbol: string,
    entryTs: number,
    entryPrice: number,
    victim: "LONG" | "SHORT",
    slPct: number,
    rr: number,
    horizonMin: number,
  ) {
    const slDist = entryPrice * (slPct / 100);
    const tpDist = slDist * rr;
    const sl = victim === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    const tp = victim === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
    let minPrice = Infinity,
      maxPrice = -Infinity;
    for (
      let t = Math.floor(entryTs / 60000) * 60000 + 60000;
      t <= entryTs + horizonMin * 60000;
      t += 60000
    ) {
      const c = candleAtGlobal(symbol, t);
      if (!c) continue;
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
      const hitTp = victim === "LONG" ? c.high >= tp : c.low <= tp;
      const hitSl = victim === "LONG" ? c.low <= sl : c.high >= sl;
      if (hitTp && hitSl)
        return {
          outcome: "AMBIGUOUS",
          timeMs: t - entryTs,
          minPrice,
          maxPrice,
        };
      if (hitTp)
        return { outcome: "TP", timeMs: t - entryTs, minPrice, maxPrice };
      if (hitSl)
        return { outcome: "SL", timeMs: t - entryTs, minPrice, maxPrice };
    }
    return {
      outcome: "NEITHER",
      timeMs: null as number | null,
      minPrice,
      maxPrice,
    };
  }

  function tradeStatsFor(
    w1s: W1Record[],
    slPct: number,
    rr: number,
    horizonMin: number,
  ) {
    let tp = 0,
      sl = 0,
      neither = 0,
      ambiguous = 0;
    const tpTimes: number[] = [],
      slTimes: number[] = [],
      maes: number[] = [],
      mfes: number[] = [];
    for (const w of w1s) {
      const out = simulateTrade(
        w.symbol,
        w.completionTime,
        w.completionPrice,
        w.victim,
        slPct,
        rr,
        horizonMin,
      );
      if (out.outcome === "TP") {
        tp++;
        if (out.timeMs !== null) tpTimes.push(out.timeMs);
      } else if (out.outcome === "SL") {
        sl++;
        if (out.timeMs !== null) slTimes.push(out.timeMs);
      } else if (out.outcome === "AMBIGUOUS") ambiguous++;
      else neither++;
      const mae =
        w.victim === "LONG"
          ? Math.max(
              0,
              ((w.completionPrice - out.minPrice) / w.completionPrice) * 100,
            )
          : Math.max(
              0,
              ((out.maxPrice - w.completionPrice) / w.completionPrice) * 100,
            );
      const mfe =
        w.victim === "LONG"
          ? Math.max(
              0,
              ((out.maxPrice - w.completionPrice) / w.completionPrice) * 100,
            )
          : Math.max(
              0,
              ((w.completionPrice - out.minPrice) / w.completionPrice) * 100,
            );
      maes.push(mae);
      mfes.push(mfe);
    }
    const decided = tp + sl;
    return {
      sampleCount: w1s.length,
      tpFirst: tp,
      slFirst: sl,
      neither,
      ambiguous,
      winRatePct: decided ? (tp / decided) * 100 : null,
      expectancyR: decided ? (tp * rr - sl) / decided : null,
      medianTimeToTP: median(tpTimes),
      medianTimeToSL: median(slTimes),
      maeP25: percentile(maes, 25),
      maeMedian: percentile(maes, 50),
      maeP75: percentile(maes, 75),
      maeP90: percentile(maes, 90),
      mfeP25: percentile(mfes, 25),
      mfeMedian: percentile(mfes, 50),
      mfeP75: percentile(mfes, 75),
      mfeP90: percentile(mfes, 90),
    };
  }

  const tradeResults: any = {};
  const breakdowns: { label: string; w1s: W1Record[] }[] = [
    { label: "COMBINED", w1s: allW1s },
    ...SYMBOLS.filter((s) => allW1s.some((w) => w.symbol === s)).map((s) => ({
      label: s,
      w1s: allW1s.filter((w) => w.symbol === s),
    })),
    { label: "LONG", w1s: allW1s.filter((w) => w.victim === "LONG") },
    { label: "SHORT", w1s: allW1s.filter((w) => w.victim === "SHORT") },
  ];

  for (const { label, w1s } of breakdowns) {
    if (w1s.length === 0) continue;
    tradeResults[label] = {};
    for (const horizonMin of HORIZON_MIN) {
      tradeResults[label][horizonMin + "m"] = {};
      for (const slPct of SL_PCTS) {
        tradeResults[label][horizonMin + "m"]["SL" + slPct] = {};
        for (const rr of RR_LEVELS) {
          tradeResults[label][horizonMin + "m"]["SL" + slPct][rr + "R"] =
            tradeStatsFor(w1s, slPct, rr, horizonMin);
        }
      }
    }
  }

  // Compact terminal print: COMBINED only, all horizons, SL=0.30% as the representative row, full grid in JSON.
  console.log(
    "\nCOMBINED, SL=0.30% (full SL/TP/horizon grid is in the JSON file):",
  );
  console.log(
    "horizon | RR | n | TP | SL | NEITHER | AMBIG | winRate | expR | medTimeToTP | medTimeToSL | medMAE | medMFE",
  );
  for (const horizonMin of HORIZON_MIN) {
    for (const rr of RR_LEVELS) {
      const r = tradeResults.COMBINED[horizonMin + "m"]["SL0.3"][rr + "R"];
      console.log(
        horizonMin +
          "m | " +
          rr +
          "R | " +
          r.sampleCount +
          " | " +
          r.tpFirst +
          " | " +
          r.slFirst +
          " | " +
          r.neither +
          " | " +
          r.ambiguous +
          " | " +
          fmtPct(r.winRatePct, 1) +
          " | " +
          (r.expectancyR !== null ? r.expectancyR.toFixed(3) : "n/a") +
          " | " +
          fmtDur(r.medianTimeToTP) +
          " | " +
          fmtDur(r.medianTimeToSL) +
          " | " +
          fmtPct(r.maeMedian) +
          " | " +
          fmtPct(r.mfeMedian),
      );
    }
  }

  // ═══ Strength buckets ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "STRENGTH-BUCKET ANALYSIS -- does a 'stronger' W1 predict better completionRecoveryATR?",
  );
  console.log("=".repeat(100));

  function bucketReport(bucketName: string, w1s: W1Record[]) {
    const atrs = w1s.map((w) => w.completionRecoveryAtr);
    console.log(
      "  " +
        bucketName +
        ": n=" +
        w1s.length +
        "  completionRecoveryATR median=" +
        (percentile(atrs, 50)?.toFixed(3) ?? "n/a") +
        " p75=" +
        (percentile(atrs, 75)?.toFixed(3) ?? "n/a") +
        " p90=" +
        (percentile(atrs, 90)?.toFixed(3) ?? "n/a"),
    );
  }

  console.log("\nA) maxIndividualEvent / P95 ratio buckets:");
  const ratioBuckets: [string, (w: W1Record) => boolean][] = [
    ["1.0-1.25x", (w) => w.maxEventOverP95 >= 1.0 && w.maxEventOverP95 < 1.25],
    ["1.25-1.5x", (w) => w.maxEventOverP95 >= 1.25 && w.maxEventOverP95 < 1.5],
    ["1.5-2x", (w) => w.maxEventOverP95 >= 1.5 && w.maxEventOverP95 < 2],
    ["2-3x", (w) => w.maxEventOverP95 >= 2 && w.maxEventOverP95 < 3],
    [">3x", (w) => w.maxEventOverP95 >= 3],
  ];
  ratioBuckets.forEach(([name, pred]) =>
    bucketReport(name, allW1s.filter(pred)),
  );

  console.log("\nB) W1 total liquidation / P95 ratio buckets:");
  const totalLiqRatioBuckets: [string, (w: W1Record) => boolean][] = [
    ["<1x", (w) => w.totalLiqUsd / w.p95AtQualification < 1],
    [
      "1-2x",
      (w) =>
        w.totalLiqUsd / w.p95AtQualification >= 1 &&
        w.totalLiqUsd / w.p95AtQualification < 2,
    ],
    [
      "2-4x",
      (w) =>
        w.totalLiqUsd / w.p95AtQualification >= 2 &&
        w.totalLiqUsd / w.p95AtQualification < 4,
    ],
    [
      "4-8x",
      (w) =>
        w.totalLiqUsd / w.p95AtQualification >= 4 &&
        w.totalLiqUsd / w.p95AtQualification < 8,
    ],
    [">8x", (w) => w.totalLiqUsd / w.p95AtQualification >= 8],
  ];
  totalLiqRatioBuckets.forEach(([name, pred]) =>
    bucketReport(name, allW1s.filter(pred)),
  );

  console.log("\nC) W1 directional movement in ATR buckets:");
  const atrMoveBuckets: [string, (w: W1Record) => boolean][] = [
    ["<0.5 ATR", (w) => w.directionalMoveAtr < 0.5],
    [
      "0.5-1.0 ATR",
      (w) => w.directionalMoveAtr >= 0.5 && w.directionalMoveAtr < 1.0,
    ],
    [
      "1.0-2.0 ATR",
      (w) => w.directionalMoveAtr >= 1.0 && w.directionalMoveAtr < 2.0,
    ],
    [
      "2.0-3.0 ATR",
      (w) => w.directionalMoveAtr >= 2.0 && w.directionalMoveAtr < 3.0,
    ],
    [">3.0 ATR", (w) => w.directionalMoveAtr >= 3.0],
  ];
  atrMoveBuckets.forEach(([name, pred]) =>
    bucketReport(name, allW1s.filter(pred)),
  );

  console.log(
    "\nD) W1 priceEfficiency buckets (quartiles of the observed distribution):",
  );
  const effVals = sortNum(
    allW1s.map((w) => w.priceEfficiency ?? NaN).filter((v) => !isNaN(v)),
  );
  if (effVals.length >= 4) {
    const q1 = percentile(effVals, 25)!,
      q2 = percentile(effVals, 50)!,
      q3 = percentile(effVals, 75)!;
    bucketReport(
      "Q1 (<=" + q1.toFixed(2) + ")",
      allW1s.filter(
        (w) => w.priceEfficiency !== null && w.priceEfficiency <= q1,
      ),
    );
    bucketReport(
      "Q2 (" + q1.toFixed(2) + "-" + q2.toFixed(2) + ")",
      allW1s.filter(
        (w) =>
          w.priceEfficiency !== null &&
          w.priceEfficiency > q1 &&
          w.priceEfficiency <= q2,
      ),
    );
    bucketReport(
      "Q3 (" + q2.toFixed(2) + "-" + q3.toFixed(2) + ")",
      allW1s.filter(
        (w) =>
          w.priceEfficiency !== null &&
          w.priceEfficiency > q2 &&
          w.priceEfficiency <= q3,
      ),
    );
    bucketReport(
      "Q4 (>" + q3.toFixed(2) + ")",
      allW1s.filter(
        (w) => w.priceEfficiency !== null && w.priceEfficiency > q3,
      ),
    );
  } else {
    console.log(
      "  insufficient priceEfficiency samples for quartile bucketing (n=" +
        effVals.length +
        ")",
    );
  }

  // ── Write full output ──
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "w1-completion-entry-research-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        hours: HOURS,
        allW1s,
        tradeResults,
      },
      null,
      2,
    ),
  );
  console.log("\nFull output (every W1, full SL/TP/horizon grid): " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
