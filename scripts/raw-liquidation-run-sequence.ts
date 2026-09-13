/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY, pure extraction
 * script. No thresholds, no ATR gating, no P95 filtering, no
 * reversal/episode/W1/W2 labels anywhere. Every liquidation minute
 * becomes part of a run; every run is recorded; every consecutive
 * same-side run pair gets its raw observable facts recorded; every
 * side-flip in the merged (both-victims) chronological run sequence
 * gets recorded as a plain transition. Nothing is judged, joined, or
 * classified -- that is explicitly left for manual/conversational
 * inspection afterward, per the operator's own instruction.
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
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
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

interface Run {
  symbol: string;
  victim: "LONG" | "SHORT";
  runIndex: number;
  startTimestamp: number;
  endTimestamp: number;
  durationMinutes: number;
  totalLiquidationUsd: number;
  eventCount: number;
  maxSingleEventUsd: number;
  startPrice: number;
  endPrice: number;
  directionalExtremePrice: number;
}
interface SameSidePair {
  symbol: string;
  victim: "LONG" | "SHORT";
  run1Index: number;
  run2Index: number;
  gapMinutes: number;
  run1EndTimestamp: number;
  run2StartTimestamp: number;
  run1EndPrice: number;
  run2StartPrice: number;
  priceChange: number;
  priceChangePct: number;
  maxRecoveryPrice: number;
  maxRecoveryPct: number;
  maxRecoveryAtr: number | null;
  minPriceBetween: number;
  maxPriceBetween: number;
  distanceOfRun2StartFromRun1Extreme: number;
  distanceOfRun2StartFromRun1ExtremePct: number;
  run2RevisitedRun1Extreme: boolean;
  run2ExceededRun1Extreme: boolean;
  run1TotalUsd: number;
  run2TotalUsd: number;
  run2OverRun1UsdRatio: number;
  oppositeSideUsdBetween: number;
  oppositeSideEventCountBetween: number;
}
interface OppositeSideTransition {
  symbol: string;
  fromVictim: "LONG" | "SHORT";
  toVictim: "LONG" | "SHORT";
  run1EndTimestamp: number;
  run2StartTimestamp: number;
  gapMinutes: number;
  run1TotalUsd: number;
  run2TotalUsd: number;
  run1EndPrice: number;
  run2StartPrice: number;
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

  const allRuns: Run[] = [];
  const allSameSidePairs: SameSidePair[] = [];
  const allOppositeTransitions: OppositeSideTransition[] = [];

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    if (events.length === 0) {
      console.log("  no events.\n");
      continue;
    }

    const klines = await fetchKlines(
      symbol,
      windowStart - 5 * 3600000,
      now + 60000,
    );
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    const atrSeries =
      candlesAsc.length >= 241
        ? computeWilderAtrSeries(candlesAsc, 240)
        : new Map<number, number>();
    function candleAt(ms: number) {
      return klines.get(Math.floor(ms / 60000) * 60000) || null;
    }
    function atrAt(ms: number): number | null {
      let t = Math.floor(ms / 60000) * 60000 - 60000;
      for (let i = 0; i < 300; i++) {
        if (atrSeries.has(t)) return atrSeries.get(t)!;
        t -= 60000;
      }
      return null;
    }

    const runsBySymbol: { LONG: Run[]; SHORT: Run[] } = { LONG: [], SHORT: [] };

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = events.filter((e) => e.victim === victim);
      const oppEvents = events.filter((e) => e.victim !== victim);
      const byMinute = new Map<number, any[]>();
      for (const e of sideEvents) {
        const m = Math.floor(e.timestamp / 60000) * 60000;
        if (!byMinute.has(m)) byMinute.set(m, []);
        byMinute.get(m)!.push(e);
      }

      const minuteKeys: number[] = [];
      for (let t = windowStart; t <= windowEndMinute; t += 60000)
        if (byMinute.has(t)) minuteKeys.push(t);

      const runs: Run[] = [];
      let curEvents: any[] = [];
      let lastMinute: number | null = null;
      for (const m of minuteKeys) {
        if (lastMinute !== null && m - lastMinute > 60000) {
          runs.push(buildRun(curEvents, runs.length));
          curEvents = [];
        }
        curEvents.push(...byMinute.get(m)!);
        lastMinute = m;
      }
      if (curEvents.length > 0) runs.push(buildRun(curEvents, runs.length));

      function buildRun(evs: any[], idx: number): Run {
        const prices = evs.map((e) => e.price);
        const extreme =
          victim === "LONG" ? Math.min(...prices) : Math.max(...prices);
        return {
          symbol,
          victim,
          runIndex: idx,
          startTimestamp: evs[0].timestamp,
          endTimestamp: evs[evs.length - 1].timestamp,
          durationMinutes:
            Math.round(
              (Math.floor(evs[evs.length - 1].timestamp / 60000) * 60000 -
                Math.floor(evs[0].timestamp / 60000) * 60000) /
                60000,
            ) + 1,
          totalLiquidationUsd: evs.reduce((s, e) => s + e.quoteQty, 0),
          eventCount: evs.length,
          maxSingleEventUsd: Math.max(...evs.map((e) => e.quoteQty)),
          startPrice: evs[0].price,
          endPrice: evs[evs.length - 1].price,
          directionalExtremePrice: extreme,
        };
      }

      runsBySymbol[victim] = runs;
      allRuns.push(...runs);
      console.log("  " + victim + ": " + runs.length + " runs");

      for (let i = 0; i < runs.length - 1; i++) {
        const r1 = runs[i],
          r2 = runs[i + 1];
        const gapMinutes = Math.round(
          (r2.startTimestamp - r1.endTimestamp) / 60000,
        );
        const priceChange = r2.startPrice - r1.endPrice;
        const priceChangePct = (priceChange / r1.endPrice) * 100;

        let maxRecoveryPrice = r1.endPrice,
          minPriceBetween = r1.endPrice,
          maxPriceBetween = r1.endPrice;
        const gapStartMinute = Math.floor(r1.endTimestamp / 60000) * 60000;
        const gapEndMinute = Math.floor(r2.startTimestamp / 60000) * 60000;
        for (let t = gapStartMinute; t <= gapEndMinute; t += 60000) {
          const c = candleAt(t);
          if (!c) continue;
          if (c.low < minPriceBetween) minPriceBetween = c.low;
          if (c.high > maxPriceBetween) maxPriceBetween = c.high;
          const candidateRecovery = victim === "LONG" ? c.high : c.low;
          if (
            victim === "LONG"
              ? candidateRecovery > maxRecoveryPrice
              : candidateRecovery < maxRecoveryPrice
          )
            maxRecoveryPrice = candidateRecovery;
        }
        const maxRecoveryUsd =
          victim === "LONG"
            ? maxRecoveryPrice - r1.directionalExtremePrice
            : r1.directionalExtremePrice - maxRecoveryPrice;
        const maxRecoveryPct =
          (Math.max(0, maxRecoveryUsd) / r1.directionalExtremePrice) * 100;
        const atrAtR1End = atrAt(r1.endTimestamp);
        const maxRecoveryAtr =
          atrAtR1End && atrAtR1End > 0
            ? Math.max(0, maxRecoveryUsd) / atrAtR1End
            : null;

        const distanceOfRun2StartFromRun1Extreme = Math.abs(
          r2.startPrice - r1.directionalExtremePrice,
        );
        const distanceOfRun2StartFromRun1ExtremePct =
          (distanceOfRun2StartFromRun1Extreme / r1.directionalExtremePrice) *
          100;
        const run2RevisitedRun1Extreme =
          victim === "LONG"
            ? r2.directionalExtremePrice <= r1.directionalExtremePrice
            : r2.directionalExtremePrice >= r1.directionalExtremePrice;
        const run2ExceededRun1Extreme =
          victim === "LONG"
            ? r2.directionalExtremePrice < r1.directionalExtremePrice
            : r2.directionalExtremePrice > r1.directionalExtremePrice;

        const oppBetween = oppEvents.filter(
          (e) =>
            e.timestamp > r1.endTimestamp && e.timestamp < r2.startTimestamp,
        );
        const oppositeSideUsdBetween = oppBetween.reduce(
          (s, e) => s + e.quoteQty,
          0,
        );
        const oppositeSideEventCountBetween = oppBetween.length;

        allSameSidePairs.push({
          symbol,
          victim,
          run1Index: r1.runIndex,
          run2Index: r2.runIndex,
          gapMinutes,
          run1EndTimestamp: r1.endTimestamp,
          run2StartTimestamp: r2.startTimestamp,
          run1EndPrice: r1.endPrice,
          run2StartPrice: r2.startPrice,
          priceChange,
          priceChangePct,
          maxRecoveryPrice,
          maxRecoveryPct,
          maxRecoveryAtr,
          minPriceBetween,
          maxPriceBetween,
          distanceOfRun2StartFromRun1Extreme,
          distanceOfRun2StartFromRun1ExtremePct,
          run2RevisitedRun1Extreme,
          run2ExceededRun1Extreme,
          run1TotalUsd: r1.totalLiquidationUsd,
          run2TotalUsd: r2.totalLiquidationUsd,
          run2OverRun1UsdRatio:
            r1.totalLiquidationUsd > 0
              ? r2.totalLiquidationUsd / r1.totalLiquidationUsd
              : 0,
          oppositeSideUsdBetween,
          oppositeSideEventCountBetween,
        });
      }
    }

    const merged = [...runsBySymbol.LONG, ...runsBySymbol.SHORT].sort(
      (a, b) => a.startTimestamp - b.startTimestamp,
    );
    for (let i = 0; i < merged.length - 1; i++) {
      const r1 = merged[i],
        r2 = merged[i + 1];
      if (r1.victim === r2.victim) continue;
      allOppositeTransitions.push({
        symbol,
        fromVictim: r1.victim,
        toVictim: r2.victim,
        run1EndTimestamp: r1.endTimestamp,
        run2StartTimestamp: r2.startTimestamp,
        gapMinutes: Math.round((r2.startTimestamp - r1.endTimestamp) / 60000),
        run1TotalUsd: r1.totalLiquidationUsd,
        run2TotalUsd: r2.totalLiquidationUsd,
        run1EndPrice: r1.endPrice,
        run2StartPrice: r2.startPrice,
      });
    }
    console.log("");
  }

  console.log("=".repeat(100));
  console.log("TOTALS");
  console.log("=".repeat(100));
  console.log("total runs: " + allRuns.length);
  console.log("total same-side pairs: " + allSameSidePairs.length);
  console.log(
    "total opposite-side transitions: " + allOppositeTransitions.length,
  );

  console.log("\n" + "=".repeat(100));
  console.log(
    "20 EXAMPLE SEQUENCES (mix of same-side pairs and opposite-side transitions)",
  );
  console.log("=".repeat(100));
  const sameExamples = allSameSidePairs.slice(0, 12);
  const oppExamples = allOppositeTransitions.slice(0, 8);
  sameExamples.forEach((p, i) => {
    console.log("\n[SAME-SIDE #" + (i + 1) + "] " + p.symbol + " " + p.victim);
    console.log(
      "  Run1 end: " +
        fmtClock(p.run1EndTimestamp) +
        " price=" +
        p.run1EndPrice +
        " totalUsd=" +
        fmtUsd(p.run1TotalUsd),
    );
    console.log("  gapMinutes=" + p.gapMinutes);
    console.log(
      "  Run2 start: " +
        fmtClock(p.run2StartTimestamp) +
        " price=" +
        p.run2StartPrice +
        " totalUsd=" +
        fmtUsd(p.run2TotalUsd) +
        " (ratio=" +
        p.run2OverRun1UsdRatio.toFixed(2) +
        "x)",
    );
    console.log(
      "  priceChange=" +
        p.priceChange.toFixed(6) +
        " (" +
        p.priceChangePct.toFixed(4) +
        "%)  maxRecoveryPct=" +
        p.maxRecoveryPct.toFixed(4) +
        "%  maxRecoveryATR=" +
        (p.maxRecoveryAtr !== null ? p.maxRecoveryAtr.toFixed(3) : "n/a"),
    );
    console.log(
      "  distanceOfRun2FromRun1Extreme=" +
        p.distanceOfRun2StartFromRun1ExtremePct.toFixed(4) +
        "%  revisited=" +
        p.run2RevisitedRun1Extreme +
        "  exceeded=" +
        p.run2ExceededRun1Extreme,
    );
    console.log(
      "  oppositeSideUsdBetween=" +
        fmtUsd(p.oppositeSideUsdBetween) +
        " (" +
        p.oppositeSideEventCountBetween +
        " events)",
    );
  });
  oppExamples.forEach((t, i) => {
    console.log(
      "\n[OPPOSITE-TRANSITION #" +
        (i + 1) +
        "] " +
        t.symbol +
        " " +
        t.fromVictim +
        " -> " +
        t.toVictim,
    );
    console.log(
      "  Run1(" +
        t.fromVictim +
        ") end: " +
        fmtClock(t.run1EndTimestamp) +
        " price=" +
        t.run1EndPrice +
        " totalUsd=" +
        fmtUsd(t.run1TotalUsd),
    );
    console.log("  gapMinutes=" + t.gapMinutes);
    console.log(
      "  Run2(" +
        t.toVictim +
        ") start: " +
        fmtClock(t.run2StartTimestamp) +
        " price=" +
        t.run2StartPrice +
        " totalUsd=" +
        fmtUsd(t.run2TotalUsd),
    );
  });

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "raw-liquidation-run-sequence-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        runs: allRuns,
        sameSidePairs: allSameSidePairs,
        oppositeSideTransitions: allOppositeTransitions,
      },
      null,
      2,
    ),
  );
  console.log("\n\nFull JSON: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
