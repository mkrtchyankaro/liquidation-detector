/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY population-level
 * research: what normally happens after a LARGE liquidation wave,
 * studied continuously over elapsed time -- WITHOUT labeling any
 * later run "W2". EXTREME/SHOCK is run through the identical analysis
 * completely separately and reported only as a secondary comparison
 * -- never pooled with LARGE.
 *
 * This directly follows the 30-case manual audit, which showed that
 * "next same-side run = W2" is not reliable ground truth (cases with
 * 70+ minute pauses and recovery fractions >9x the W1 move still got
 * auto-labeled as W2 candidates). This script does not use that
 * labeling at all.
 *
 * Observation checkpoints (1/2/3/5/10/15/20/30/45/60 min after W1
 * end) are explicitly NOT thresholds -- they are fixed points at
 * which the market state is sampled, so probabilities can be reported
 * continuously over elapsed time. Bins used for conditional
 * probability tables (recovery fraction, renewed-pressure magnitude)
 * are derived from the observed quartiles of the data itself, never
 * a fixed number.
 *
 * CAUSALITY: W1's own extreme/physics use only candles within W1's
 * own [start,end] window (already fully in the past by construction).
 * ATR is frozen using only candles strictly before W1's start. Every
 * post-W1 checkpoint metric uses only candles up to that checkpoint's
 * own timestamp -- never later data.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No W2 definition, no entry rule, no SL/TP, no fixed
 * timeout or recovery threshold.
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
const CHECKPOINTS_MIN = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];

function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtPct(n: number | null, d?: number) {
  return n === null || n === undefined ? "n/a" : n.toFixed(d ?? 1) + "%";
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

interface Checkpoint {
  elapsedMin: number;
  recoveryPct: number;
  recoveryAtr: number;
  recoveryFraction: number;
  sameSideUsdSinceW1: number;
  oppositeSideUsdSinceW1: number;
  distanceFromExtremePct: number;
  distanceFromExtremeAtr: number;
  revisitedExtreme: boolean;
  exceededExtreme: boolean;
  incrementalExtensionPct: number;
  incrementalExtensionAtr: number;
}
interface W1Record {
  symbol: string;
  victim: "LONG" | "SHORT";
  regime: "large" | "extreme/shock";
  totalUsd: number;
  eventCount: number;
  maxSingleEventUsd: number;
  durationMinutes: number;
  usdPerMinute: number;
  startPrice: number;
  extreme: number;
  movePct: number;
  atrFrozen: number;
  moveAtr: number;
  w1EndTs: number;
  checkpoints: Checkpoint[];
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

  const recordsByRegime: Record<"large" | "extreme/shock", W1Record[]> = {
    large: [],
    "extreme/shock": [],
  };

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
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

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = events.filter((e) => e.victim === victim);
      const oppEvents = events.filter((e) => e.victim !== victim);
      const byMinute = new Map<number, any[]>();
      for (const e of sideEvents) {
        const m = Math.floor(e.timestamp / 60000) * 60000;
        if (!byMinute.has(m)) byMinute.set(m, []);
        byMinute.get(m)!.push(e);
      }
      const timeline: MinuteRow[] = [];
      for (let t = windowStart; t <= windowEndMinute; t += 60000) {
        const evs = byMinute.get(t);
        timeline.push(
          evs && evs.length
            ? {
                minuteTs: t,
                eventCount: evs.length,
                totalLiquidationUsd: evs.reduce((s, e) => s + e.quoteQty, 0),
                maxSingleEventUsd: Math.max(...evs.map((e) => e.quoteQty)),
              }
            : {
                minuteTs: t,
                eventCount: 0,
                totalLiquidationUsd: 0,
                maxSingleEventUsd: 0,
              },
        );
      }

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
      const classified: ActiveRun[] = rawRuns.map((r, idx) => {
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

      for (const w1Run of classified) {
        if (w1Run.regime !== "large" && w1Run.regime !== "extreme/shock")
          continue;
        const regime = w1Run.regime as "large" | "extreme/shock";

        const atrFrozen = atrAt(w1Run.startTs);
        if (atrFrozen === null || atrFrozen <= 0) continue;
        const startCandle = closedCandleAt(w1Run.startTs);
        const startPrice = startCandle
          ? startCandle.close
          : (candleAt(w1Run.startTs)?.open ?? null);
        if (startPrice === null) continue;

        let extreme: number | null = null;
        for (let t = w1Run.startTs; t <= w1Run.endTs; t += 60000) {
          const c = candleAt(t);
          if (!c) continue;
          const v = victim === "LONG" ? c.low : c.high;
          if (
            extreme === null ||
            (victim === "LONG" ? v < extreme : v > extreme)
          )
            extreme = v;
        }
        if (extreme === null) continue;

        const moveUsd = Math.abs(startPrice - extreme);
        const movePct = (moveUsd / startPrice) * 100;
        const moveAtr = moveUsd / atrFrozen;
        const usdPerMinute = w1Run.totalUsd / w1Run.durationMinutes;

        let runningExtreme = extreme;
        const checkpoints: Checkpoint[] = [];
        let revisitedSoFar = false,
          exceededSoFar = false;
        for (const elapsedMin of CHECKPOINTS_MIN) {
          const checkpointTs = w1Run.endTs + elapsedMin * 60000;
          if (checkpointTs > windowEndMinute) break;
          for (let t = w1Run.endTs + 60000; t <= checkpointTs; t += 60000) {
            const c = candleAt(t);
            if (!c) continue;
            const v = victim === "LONG" ? c.low : c.high;
            if (victim === "LONG" ? v <= extreme : v >= extreme)
              revisitedSoFar = true;
            if (victim === "LONG" ? v < extreme : v > extreme)
              exceededSoFar = true;
            if (victim === "LONG" ? v < runningExtreme : v > runningExtreme)
              runningExtreme = v;
          }
          const cAtCheckpoint = candleAt(checkpointTs);
          const priceNow = cAtCheckpoint ? cAtCheckpoint.close : null;
          if (priceNow === null) continue;

          const signedDistanceUsd =
            victim === "LONG" ? priceNow - extreme : extreme - priceNow;
          const recoveryUsd = Math.max(0, signedDistanceUsd);
          const recoveryPct = (recoveryUsd / extreme) * 100;
          const recoveryAtr = recoveryUsd / atrFrozen;
          const recoveryFraction = moveUsd > 0 ? recoveryUsd / moveUsd : 0;
          const distanceFromExtremePct = (signedDistanceUsd / extreme) * 100;
          const distanceFromExtremeAtr = signedDistanceUsd / atrFrozen;

          const incrementalExtensionUsd =
            victim === "LONG"
              ? Math.max(0, extreme - runningExtreme)
              : Math.max(0, runningExtreme - extreme);
          const incrementalExtensionPct =
            (incrementalExtensionUsd / extreme) * 100;
          const incrementalExtensionAtr = incrementalExtensionUsd / atrFrozen;

          const sameSideSince = sideEvents
            .filter(
              (e) => e.timestamp > w1Run.endTs && e.timestamp <= checkpointTs,
            )
            .reduce((s, e) => s + e.quoteQty, 0);
          const oppSideSince = oppEvents
            .filter(
              (e) => e.timestamp > w1Run.endTs && e.timestamp <= checkpointTs,
            )
            .reduce((s, e) => s + e.quoteQty, 0);

          checkpoints.push({
            elapsedMin,
            recoveryPct,
            recoveryAtr,
            recoveryFraction,
            sameSideUsdSinceW1: sameSideSince,
            oppositeSideUsdSinceW1: oppSideSince,
            distanceFromExtremePct,
            distanceFromExtremeAtr,
            revisitedExtreme: revisitedSoFar,
            exceededExtreme: exceededSoFar,
            incrementalExtensionPct,
            incrementalExtensionAtr,
          });
        }

        recordsByRegime[regime].push({
          symbol,
          victim,
          regime,
          totalUsd: w1Run.totalUsd,
          eventCount: w1Run.eventCount,
          maxSingleEventUsd: w1Run.maxSingleEventUsd,
          durationMinutes: w1Run.durationMinutes,
          usdPerMinute,
          startPrice,
          extreme,
          movePct,
          atrFrozen,
          moveAtr,
          w1EndTs: w1Run.endTs,
          checkpoints,
        });
      }
    }
  }

  console.log(
    "\nLARGE W1 records: " +
      recordsByRegime.large.length +
      "  EXTREME/SHOCK W1 records: " +
      recordsByRegime["extreme/shock"].length,
  );

  function distLine(vals: number[]) {
    const s = sortNum(vals);
    return [25, 50, 75, 90, 95]
      .map((p) => "p" + p + "=" + (percentile(s, p)?.toFixed(3) ?? "n/a"))
      .join(" ");
  }
  for (const regime of ["large", "extreme/shock"] as const) {
    const recs = recordsByRegime[regime];
    console.log("\n" + "=".repeat(100));
    console.log(
      regime.toUpperCase() +
        " -- W1 PHYSICS DISTRIBUTIONS (n=" +
        recs.length +
        ")",
    );
    console.log("=".repeat(100));
    console.log("  totalUSD:    " + distLine(recs.map((r) => r.totalUsd)));
    console.log(
      "  duration:    " + distLine(recs.map((r) => r.durationMinutes)),
    );
    console.log("  USD/min:     " + distLine(recs.map((r) => r.usdPerMinute)));
    console.log("  movePct:     " + distLine(recs.map((r) => r.movePct)));
    console.log("  moveATR:     " + distLine(recs.map((r) => r.moveAtr)));

    console.log(
      "\n" + regime.toUpperCase() + " -- POST-W1 EVOLUTION BY ELAPSED TIME",
    );
    for (const elapsedMin of CHECKPOINTS_MIN) {
      const atThisCheckpoint = recs
        .map((r) => r.checkpoints.find((c) => c.elapsedMin === elapsedMin))
        .filter((c) => c !== undefined) as Checkpoint[];
      if (atThisCheckpoint.length === 0) continue;
      const revisitProb =
        (atThisCheckpoint.filter((c) => c.revisitedExtreme).length /
          atThisCheckpoint.length) *
        100;
      const exceedProb =
        (atThisCheckpoint.filter((c) => c.exceededExtreme).length /
          atThisCheckpoint.length) *
        100;
      console.log(
        "  +" +
          elapsedMin +
          "min (n=" +
          atThisCheckpoint.length +
          "): recoveryPct med=" +
          median(atThisCheckpoint.map((c) => c.recoveryPct))?.toFixed(3) +
          " recoveryATR med=" +
          median(atThisCheckpoint.map((c) => c.recoveryAtr))?.toFixed(3) +
          " recoveryFraction med=" +
          median(atThisCheckpoint.map((c) => c.recoveryFraction))?.toFixed(3) +
          " | P(revisit)=" +
          fmtPct(revisitProb) +
          " P(exceed)=" +
          fmtPct(exceedProb) +
          " | incExtATR med=" +
          median(
            atThisCheckpoint.map((c) => c.incrementalExtensionAtr),
          )?.toFixed(3) +
          " | sameSideUSD med=" +
          fmtUsd(
            median(atThisCheckpoint.map((c) => c.sameSideUsdSinceW1)) ?? 0,
          ),
      );
    }
  }

  for (const regime of ["large", "extreme/shock"] as const) {
    const recs = recordsByRegime[regime];
    console.log("\n" + "=".repeat(100));
    console.log(
      regime.toUpperCase() +
        " -- CONDITIONAL P(new territory / exceeded) TABLES",
    );
    console.log("=".repeat(100));

    const finalStates = recs
      .map((r) => ({ r, cp: r.checkpoints[r.checkpoints.length - 1] }))
      .filter((x) => x.cp);

    console.log(
      "\nP(exceeded) by recovery-fraction quartile bin (bins derived from this population's OWN recoveryFraction distribution at final observed checkpoint):",
    );
    const recFractions = sortNum(finalStates.map((x) => x.cp.recoveryFraction));
    const rq1 = percentile(recFractions, 25)!,
      rq2 = percentile(recFractions, 50)!,
      rq3 = percentile(recFractions, 75)!;
    const recBins: [string, (v: number) => boolean][] = [
      ["Q1(<=" + rq1.toFixed(2) + ")", (v) => v <= rq1],
      [
        "Q2(" + rq1.toFixed(2) + "-" + rq2.toFixed(2) + ")",
        (v) => v > rq1 && v <= rq2,
      ],
      [
        "Q3(" + rq2.toFixed(2) + "-" + rq3.toFixed(2) + ")",
        (v) => v > rq2 && v <= rq3,
      ],
      ["Q4(>" + rq3.toFixed(2) + ")", (v) => v > rq3],
    ];
    recBins.forEach(([label, pred]) => {
      const bucket = finalStates.filter((x) => pred(x.cp.recoveryFraction));
      if (bucket.length)
        console.log(
          "  " +
            label +
            " (n=" +
            bucket.length +
            "): P(exceed)=" +
            fmtPct(
              (bucket.filter((x) => x.cp.exceededExtreme).length /
                bucket.length) *
                100,
            ),
        );
    });

    console.log(
      "\nP(exceeded) by renewed-pressure-magnitude quartile bin (renewedUsd/W1Usd, at final observed checkpoint):",
    );
    const renewedRatios = finalStates.map((x) => ({
      x,
      ratio: x.r.totalUsd > 0 ? x.cp.sameSideUsdSinceW1 / x.r.totalUsd : 0,
    }));
    const ratioVals = sortNum(renewedRatios.map((rr) => rr.ratio));
    const pq1 = percentile(ratioVals, 25)!,
      pq2 = percentile(ratioVals, 50)!,
      pq3 = percentile(ratioVals, 75)!;
    const pressureBins: [string, (v: number) => boolean][] = [
      ["Q1(<=" + pq1.toFixed(3) + ")", (v) => v <= pq1],
      ["Q2", (v) => v > pq1 && v <= pq2],
      ["Q3", (v) => v > pq2 && v <= pq3],
      ["Q4(>" + pq3.toFixed(3) + ")", (v) => v > pq3],
    ];
    pressureBins.forEach(([label, pred]) => {
      const bucket = renewedRatios.filter((rr) => pred(rr.ratio));
      if (bucket.length)
        console.log(
          "  " +
            label +
            " (n=" +
            bucket.length +
            "): P(exceed)=" +
            fmtPct(
              (bucket.filter((rr) => rr.x.cp.exceededExtreme).length /
                bucket.length) *
                100,
            ) +
            " medianIncExtATR=" +
            median(
              bucket.map((rr) => rr.x.cp.incrementalExtensionAtr),
            )?.toFixed(3),
        );
    });

    console.log(
      "\nP(exceeded) by recovery-fraction bin x renewed-pressure bin (combined):",
    );
    for (const [rLabel, rPred] of recBins) {
      for (const [pLabel, pPred] of pressureBins) {
        const bucket = renewedRatios.filter(
          (rr) => rPred(rr.x.cp.recoveryFraction) && pPred(rr.ratio),
        );
        if (bucket.length >= 3)
          console.log(
            "  recovery=" +
              rLabel +
              " x pressure=" +
              pLabel +
              " (n=" +
              bucket.length +
              "): P(exceed)=" +
              fmtPct(
                (bucket.filter((rr) => rr.x.cp.exceededExtreme).length /
                  bucket.length) *
                  100,
              ),
          );
      }
    }
  }

  console.log("\n" + "=".repeat(100));
  console.log("HUMAN-READABLE SUMMARY (real numbers from the data above)");
  console.log("=".repeat(100));
  for (const regime of ["large", "extreme/shock"] as const) {
    const recs = recordsByRegime[regime];
    if (recs.length === 0) continue;
    console.log("\n--- " + regime.toUpperCase() + " ---");
    console.log(
      "After a typical " +
        regime +
        " liquidation wave, W1 moves " +
        median(recs.map((r) => r.movePct))?.toFixed(3) +
        "% / " +
        median(recs.map((r) => r.moveAtr))?.toFixed(3) +
        " ATR (median, n=" +
        recs.length +
        ").",
    );
    const cp5 = recs
      .map((r) => r.checkpoints.find((c) => c.elapsedMin === 5))
      .filter((c) => c) as Checkpoint[];
    if (cp5.length)
      console.log(
        "Within 5 minutes the median recovery is " +
          median(cp5.map((c) => c.recoveryPct))?.toFixed(3) +
          "% / " +
          median(cp5.map((c) => c.recoveryAtr))?.toFixed(3) +
          " ATR (n=" +
          cp5.length +
          ").",
      );
    const cp30 = recs
      .map((r) => r.checkpoints.find((c) => c.elapsedMin === 30))
      .filter((c) => c) as Checkpoint[];
    if (cp30.length)
      console.log(
        "Within 30 minutes, P(exceeded W1 extreme)=" +
          fmtPct(
            (cp30.filter((c) => c.exceededExtreme).length / cp30.length) * 100,
          ) +
          " (n=" +
          cp30.length +
          ").",
      );
  }
  console.log(
    "\n(Full conditional tables above are the primary evidence -- these sentences are illustrative summaries only, not the complete picture.)",
  );

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "large-w1-post-wave-population-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date(now).toISOString(), recordsByRegime },
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
