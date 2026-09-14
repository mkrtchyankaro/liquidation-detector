/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, multi-symbol.
 * Continues the ATR-normalization-entry study with a genuine
 * methodological upgrade: liquidation SIGNIFICANCE is now measured
 * via a strictly CAUSAL, rolling, symbol+victim-relative percentile
 * rank -- computed using ONLY chronologically prior episodes for that
 * exact (symbol, victim) pair, never the full dataset's own
 * distribution. This is stricter than the existing large/extreme
 * regime classification used throughout this project (which ranks
 * each wave against the ENTIRE historical distribution, including
 * waves that occur LATER -- a real, if subtle, look-ahead property
 * that is fine for episode CONSTRUCTION/qualification but not
 * acceptable for a feature meant to represent "what was knowable at
 * this exact entry moment"). The existing regime filter is kept
 * UNCHANGED for episode qualification (large+extreme); the new causal
 * percentile is a SEPARATE, additional feature computed for the
 * significance analysis this task specifically needs.
 *
 * Requires a minimum of MIN_PRIOR_SAMPLES prior episodes for that
 * exact symbol+victim before a percentile rank is considered
 * meaningful -- episodes without enough prior history get
 * percentileRank=null and are excluded from percentile-bucketed
 * analysis (reported as excluded, not silently dropped).
 *
 * Episode/ATR/normalization/entry construction is otherwise IDENTICAL
 * to the prior pass (same v1 directional ATR, same causal-at-episode-
 * end normalization anchor, same entry-anchored MFE/MAE).
 *
 * No threshold invented beyond the existing regime split. P90/95/99
 * are tested side by side, never assumed. No coefficient optimized,
 * no ML model, no curve-fitting.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No trading strategy created.
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
const HOURS = 240;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const HORIZONS_MIN = [1, 3, 5, 10, 15, 30];
const NORM_WALK_CAP_MIN = 120;
const SHOCK_WINDOW_EXTRA_MIN = 30;
const MIN_PRIOR_SAMPLES = 20;

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
function percentileRankOf(priorValuesSorted: number[], value: number): number {
  if (priorValuesSorted.length === 0) return 0;
  let c = 0;
  for (const v of priorValuesSorted) if (v <= value) c++;
  return (c / priorValuesSorted.length) * 100;
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
  regime: string;
  events: RawEvent[];
}

interface HorizonOutcome {
  horizonMin: number;
  mfeInEntryRecAtr: number;
  maeInPreLiqAtr: number;
  newExtremeBroken: boolean;
  timeToMfeMin: number | null;
}
interface Episode {
  symbol: string;
  victim: Victim;
  waveIndex: number;
  startTs: number;
  endTs: number;
  durationMinutes: number;
  totalUsd: number;
  maxSingleEventUsd: number;
  eventCount: number;
  usdPerMinute: number;
  usdPerSecond: number;
  extremePrice: number;
  startPrice: number;
  preLiqAtr: number;
  preRecAtr: number;
  preRatio: number;
  postLiqAtr: number;
  postRecAtr: number;
  postRatio: number;
  liqDirExpansion: number;
  recDirCompression: number;
  ratioDistortionAtEnd: number;
  maxLiqDirAtrInShockWindow: number;
  minRecDirAtrInShockWindow: number;
  maxRatioInShockWindow: number;
  shockDisplacement: number;
  shockAtr: number;
  freshExtremeRateDuringEpisode: number;
  zeroOppositeRateDuringEpisode: number;
  earlyEfficiency: number | null;
  middleEfficiency: number | null;
  lateEfficiency: number | null;
  efficiencyDecay: number | null;
  displacementAtrPerUsdM: number;
  totalUsdPercentile: number | null;
  maxEventPercentile: number | null;
  usdPerMinPercentile: number | null;
  priorSampleCount: number;
  entry100: {
    ts: number;
    price: number;
    minutesAfterEnd: number;
    minutesAfterStart: number;
    horizons: HorizonOutcome[];
  } | null;
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

  const allEpisodes: Episode[] = [];
  const insufficientData: string[] = [];
  let excludedForPriorHistory = 0;

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = (await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: windowEnd } })
      .sort({ timestamp: 1 })
      .toArray()) as unknown as RawEvent[];
    if (events.length === 0) {
      console.log("  NO DATA.\n");
      insufficientData.push(symbol + ": zero raw events");
      continue;
    }
    const actualEarliest = events[0].timestamp,
      actualLatest = events[events.length - 1].timestamp;
    console.log("  raw events: " + events.length);

    const klines = await fetchKlines(
      symbol,
      actualEarliest - 8 * 3600000,
      actualLatest + (NORM_WALK_CAP_MIN / 60 + 1) * 3600000,
    );
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    if (candlesAsc.length < 15) {
      console.log("  insufficient candles.\n");
      insufficientData.push(symbol + ": fewer than 15 1m candles");
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
        let extremePrice = r.events[0].price;
        for (const e of r.events) {
          if (
            victim === "LONG" ? e.price < extremePrice : e.price > extremePrice
          )
            extremePrice = e.price;
        }
        return { symbol, victim, waveIndex: idx, ...r, extremePrice, regime };
      });
      console.log("  " + victim + ": " + waves.length + " waves total");

      const priorTotalUsd: number[] = [],
        priorMaxEvent: number[] = [],
        priorUsdPerMin: number[] = [];
      for (const w of waves) {
        let totalUsdPercentile: number | null = null,
          maxEventPercentile: number | null = null,
          usdPerMinPercentile: number | null = null;
        const priorCount = priorTotalUsd.length;
        if (priorCount >= MIN_PRIOR_SAMPLES) {
          const sortedTotal = [...priorTotalUsd].sort((a, b) => a - b);
          const sortedMax = [...priorMaxEvent].sort((a, b) => a - b);
          const sortedUpm = [...priorUsdPerMin].sort((a, b) => a - b);
          totalUsdPercentile = percentileRankOf(sortedTotal, w.totalUsd);
          maxEventPercentile = percentileRankOf(sortedMax, w.maxSingleEventUsd);
          usdPerMinPercentile = percentileRankOf(
            sortedUpm,
            w.totalUsd / w.durationMinutes,
          );
        } else {
          excludedForPriorHistory++;
        }
        if (w.regime === "large" || w.regime === "extreme") {
          const ep = computeEpisode(
            w,
            downV1,
            upV1,
            klines,
            totalUsdPercentile,
            maxEventPercentile,
            usdPerMinPercentile,
            priorCount,
          );
          if (ep) allEpisodes.push(ep);
        }
        priorTotalUsd.push(w.totalUsd);
        priorMaxEvent.push(w.maxSingleEventUsd);
        priorUsdPerMin.push(w.totalUsd / w.durationMinutes);
      }
    }
  }

  function computeEpisode(
    w: Wave,
    downV1: Map<number, number>,
    upV1: Map<number, number>,
    klines: Map<number, Candle>,
    totalUsdPercentile: number | null,
    maxEventPercentile: number | null,
    usdPerMinPercentile: number | null,
    priorSampleCount: number,
  ): Episode | null {
    const victim = w.victim;
    const preDown = lookupCausal(downV1, w.startTs),
      preUp = lookupCausal(upV1, w.startTs);
    const postDown = lookupCausal(downV1, w.endTs),
      postUp = lookupCausal(upV1, w.endTs);
    if (
      preDown === null ||
      preUp === null ||
      postDown === null ||
      postUp === null ||
      preDown <= 0 ||
      preUp <= 0
    )
      return null;
    const preLiqAtr = victim === "LONG" ? preDown : preUp,
      preRecAtr = victim === "LONG" ? preUp : preDown;
    const postLiqAtr = victim === "LONG" ? postDown : postUp,
      postRecAtr = victim === "LONG" ? postUp : postDown;
    const preRatio = preLiqAtr / preRecAtr,
      postRatio = postLiqAtr / postRecAtr;
    const liqDirExpansion = postLiqAtr - preLiqAtr;
    const recDirCompression = preRecAtr - postRecAtr;
    const ratioDistortionAtEnd = postRatio / preRatio;
    const startPrice = w.events[0].price;
    const shockDisplacement = Math.abs(startPrice - w.extremePrice);
    const shockAtr = shockDisplacement / preLiqAtr;
    const displacementAtrPerUsdM = shockAtr / (w.totalUsd / 1e6);

    const liqSeries = victim === "LONG" ? downV1 : upV1,
      recSeries = victim === "LONG" ? upV1 : downV1;

    let maxLiqDirAtrInShockWindow = preLiqAtr,
      minRecDirAtrInShockWindow = preRecAtr,
      maxRatioInShockWindow = preRatio;
    for (
      let t = w.startTs;
      t <= w.endTs + SHOCK_WINDOW_EXTRA_MIN * 60000;
      t += 60000
    ) {
      const l = lookupCausal(liqSeries, t),
        r = lookupCausal(recSeries, t);
      if (l === null || r === null || r <= 0) continue;
      if (l > maxLiqDirAtrInShockWindow) maxLiqDirAtrInShockWindow = l;
      if (r < minRecDirAtrInShockWindow) minRecDirAtrInShockWindow = r;
      const ratio = l / r;
      if (ratio > maxRatioInShockWindow) maxRatioInShockWindow = ratio;
    }

    const evs = w.events;
    let freshCount = 0,
      zeroOppCount = 0,
      pairCount = 0;
    const thirdSize = Math.ceil(Math.max(1, evs.length - 1) / 3);
    const phaseImpacts: {
      phase: "EARLY" | "MIDDLE" | "LATE";
      impact: number | null;
    }[] = [];
    let runningExtreme = evs[0]?.price ?? w.extremePrice;
    for (let i = 0; i < evs.length - 1; i++) {
      pairCount++;
      const eN = evs[i],
        eN1 = evs[i + 1];
      const priceChange = eN1.price - eN.price;
      if (!(victim === "LONG" ? priceChange < 0 : priceChange > 0))
        zeroOppCount++;
      const isFresh =
        victim === "LONG"
          ? eN1.price < runningExtreme
          : eN1.price > runningExtreme;
      if (isFresh) {
        freshCount++;
        runningExtreme = eN1.price;
      }
      const impactAtr =
        preLiqAtr > 0
          ? Math.abs(priceChange) / preLiqAtr / (eN.quoteQty / 100000)
          : null;
      const signedImpact = (
        victim === "LONG" ? priceChange < 0 : priceChange > 0
      )
        ? impactAtr
        : impactAtr !== null
          ? -impactAtr
          : null;
      const phase: "EARLY" | "MIDDLE" | "LATE" =
        i < thirdSize ? "EARLY" : i < thirdSize * 2 ? "MIDDLE" : "LATE";
      phaseImpacts.push({ phase, impact: signedImpact });
    }
    const freshExtremeRateDuringEpisode =
      pairCount > 0 ? (freshCount / pairCount) * 100 : 0;
    const zeroOppositeRateDuringEpisode =
      pairCount > 0 ? (zeroOppCount / pairCount) * 100 : 0;
    function phaseMedian(phase: "EARLY" | "MIDDLE" | "LATE") {
      return median(
        phaseImpacts.filter((p) => p.phase === phase).map((p) => p.impact),
      );
    }
    const earlyEfficiency = phaseMedian("EARLY"),
      middleEfficiency = phaseMedian("MIDDLE"),
      lateEfficiency = phaseMedian("LATE");
    const efficiencyDecay =
      earlyEfficiency !== null && lateEfficiency !== null
        ? lateEfficiency - earlyEfficiency
        : null;

    let entry100Ts: number | null = null,
      entry100Price: number | null = null;
    for (
      let t = Math.floor(w.endTs / 60000) * 60000;
      t <= w.endTs + NORM_WALK_CAP_MIN * 60000;
      t += 60000
    ) {
      const curLiq = lookupCausal(liqSeries, t),
        curRec = lookupCausal(recSeries, t);
      if (curLiq === null || curRec === null || curRec <= 0) continue;
      const curRatio = curLiq / curRec;
      const ratioFrac =
        postRatio !== preRatio
          ? ((postRatio - curRatio) / (postRatio - preRatio)) * 100
          : null;
      if (ratioFrac !== null && ratioFrac >= 100) {
        const c = candleAt(klines, t);
        if (c) {
          entry100Ts = t;
          entry100Price = c.close;
        }
        break;
      }
    }

    let entry100: Episode["entry100"] = null;
    if (entry100Ts !== null && entry100Price !== null) {
      const recAtrAtEntry = lookupCausal(recSeries, entry100Ts);
      const horizons: HorizonOutcome[] = [];
      let runningNewExtreme = w.extremePrice;
      for (const hMin of HORIZONS_MIN) {
        const horizonTs = entry100Ts + hMin * 60000;
        let mfe = 0,
          mae = 0,
          newExtremeBroken = false,
          timeToMfeMin: number | null = null;
        for (let t = entry100Ts + 60000; t <= horizonTs; t += 60000) {
          const c = candleAt(klines, t);
          if (!c) continue;
          const fav =
            victim === "LONG" ? c.high - entry100Price : entry100Price - c.low;
          if (fav > mfe) {
            mfe = fav;
            timeToMfeMin = (t - entry100Ts) / 60000;
          }
          const adv =
            victim === "LONG"
              ? Math.max(0, entry100Price - c.low)
              : Math.max(0, c.high - entry100Price);
          if (adv > mae) mae = adv;
          const brokeNow =
            victim === "LONG"
              ? c.low < runningNewExtreme
              : c.high > runningNewExtreme;
          if (brokeNow) {
            newExtremeBroken = true;
            runningNewExtreme =
              victim === "LONG"
                ? Math.min(runningNewExtreme, c.low)
                : Math.max(runningNewExtreme, c.high);
          }
        }
        horizons.push({
          horizonMin: hMin,
          mfeInEntryRecAtr:
            recAtrAtEntry && recAtrAtEntry > 0
              ? mfe / recAtrAtEntry
              : mfe / preRecAtr,
          maeInPreLiqAtr: mae / preLiqAtr,
          newExtremeBroken,
          timeToMfeMin,
        });
      }
      entry100 = {
        ts: entry100Ts,
        price: entry100Price,
        minutesAfterEnd: (entry100Ts - w.endTs) / 60000,
        minutesAfterStart: (entry100Ts - w.startTs) / 60000,
        horizons,
      };
    }

    return {
      symbol: w.symbol,
      victim,
      waveIndex: w.waveIndex,
      startTs: w.startTs,
      endTs: w.endTs,
      durationMinutes: w.durationMinutes,
      totalUsd: w.totalUsd,
      maxSingleEventUsd: w.maxSingleEventUsd,
      eventCount: w.eventCount,
      usdPerMinute: w.totalUsd / w.durationMinutes,
      usdPerSecond: w.totalUsd / (w.durationMinutes * 60),
      extremePrice: w.extremePrice,
      startPrice,
      preLiqAtr,
      preRecAtr,
      preRatio,
      postLiqAtr,
      postRecAtr,
      postRatio,
      liqDirExpansion,
      recDirCompression,
      ratioDistortionAtEnd,
      maxLiqDirAtrInShockWindow,
      minRecDirAtrInShockWindow,
      maxRatioInShockWindow,
      shockDisplacement,
      shockAtr,
      freshExtremeRateDuringEpisode,
      zeroOppositeRateDuringEpisode,
      earlyEfficiency,
      middleEfficiency,
      lateEfficiency,
      efficiencyDecay,
      displacementAtrPerUsdM,
      totalUsdPercentile,
      maxEventPercentile,
      usdPerMinPercentile,
      priorSampleCount,
      entry100,
    };
  }

  const withEntry = allEpisodes.filter((e) => e.entry100 !== null);
  const withEntryAndPercentile = withEntry.filter(
    (e) => e.totalUsdPercentile !== null,
  );
  console.log(
    "\nTotal qualifying episodes: " +
      allEpisodes.length +
      "  with 100% entry: " +
      withEntry.length +
      "  with entry AND sufficient prior history for percentile: " +
      withEntryAndPercentile.length,
  );
  console.log(
    "excluded from percentile analysis for insufficient prior history (<" +
      MIN_PRIOR_SAMPLES +
      " prior waves): " +
      excludedForPriorHistory,
  );
  if (insufficientData.length > 0) {
    console.log("\nINSUFFICIENT DATA:");
    insufficientData.forEach((m) => console.log("  " + m));
  }

  function mfeAt(e: Episode, hMin: number): number | null {
    return (
      e.entry100?.horizons.find((h) => h.horizonMin === hMin)
        ?.mfeInEntryRecAtr ?? null
    );
  }
  function maeAt(e: Episode, hMin: number): number | null {
    return (
      e.entry100?.horizons.find((h) => h.horizonMin === hMin)?.maeInPreLiqAtr ??
      null
    );
  }
  function newExtAt(e: Episode, hMin: number): boolean | null {
    return (
      e.entry100?.horizons.find((h) => h.horizonMin === hMin)
        ?.newExtremeBroken ?? null
    );
  }
  function timeToMfeAt(e: Episode, hMin: number): number | null {
    return (
      e.entry100?.horizons.find((h) => h.horizonMin === hMin)?.timeToMfeMin ??
      null
    );
  }

  function reportGroup(episodes: Episode[], label: string) {
    if (episodes.length === 0) {
      console.log("  " + label + ": n=0");
      return;
    }
    console.log("  " + label + " (n=" + episodes.length + "):");
    for (const hMin of HORIZONS_MIN) {
      const mfes = sortNum(episodes.map((e) => mfeAt(e, hMin)));
      const maes = sortNum(episodes.map((e) => maeAt(e, hMin)));
      const newExtVals = episodes
        .map((e) => newExtAt(e, hMin))
        .filter((v): v is boolean => v !== null);
      const pNewExt = newExtVals.length
        ? (newExtVals.filter((v) => v).length / newExtVals.length) * 100
        : null;
      const failRate =
        mfes.length && maes.length
          ? (episodes.filter((e) => {
              const m = mfeAt(e, hMin),
                a = maeAt(e, hMin);
              return m !== null && a !== null && a > m;
            }).length /
              episodes.length) *
            100
          : null;
      const medTimeToMfe = median(episodes.map((e) => timeToMfeAt(e, hMin)));
      console.log(
        "    +" +
          hMin +
          "m: MFE p25/med/p75=" +
          (percentile(mfes, 25)?.toFixed(3) ?? "n/a") +
          "/" +
          (percentile(mfes, 50)?.toFixed(3) ?? "n/a") +
          "/" +
          (percentile(mfes, 75)?.toFixed(3) ?? "n/a") +
          "recATR  medMAE=" +
          (percentile(maes, 50)?.toFixed(3) ?? "n/a") +
          "liqATR  P(newExt)=" +
          (pNewExt?.toFixed(1) ?? "n/a") +
          "%  failRate=" +
          (failRate?.toFixed(1) ?? "n/a") +
          "%  medTimeToMFE=" +
          (medTimeToMfe?.toFixed(1) ?? "n/a") +
          "min",
      );
    }
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "2. LIQUIDATION SIGNIFICANCE (causal totalUSD percentile) vs POST-NORMALIZATION OUTCOME",
  );
  console.log("=".repeat(160));
  const sigBuckets: [string, (v: number) => boolean][] = [
    ["<P50", (v) => v < 50],
    ["P50-P75", (v) => v >= 50 && v < 75],
    ["P75-P90", (v) => v >= 75 && v < 90],
    ["P90-P95", (v) => v >= 90 && v < 95],
    ["P95-P99", (v) => v >= 95 && v < 99],
    [">=P99", (v) => v >= 99],
  ];
  for (const [label, pred] of sigBuckets)
    reportGroup(
      withEntryAndPercentile.filter(
        (e) => e.totalUsdPercentile !== null && pred(e.totalUsdPercentile),
      ),
      label,
    );

  console.log("\n" + "=".repeat(160));
  console.log(
    "3. SIZE x SHOCKATR (median splits within the percentile-eligible entry population)",
  );
  console.log("=".repeat(160));
  const shockMed = median(withEntryAndPercentile.map((e) => e.shockAtr));
  const sizeMed = median(
    withEntryAndPercentile.map((e) => e.totalUsdPercentile),
  );
  if (shockMed !== null && sizeMed !== null) {
    for (const bigSize of [true, false])
      for (const bigShock of [true, false]) {
        const group = withEntryAndPercentile.filter(
          (e) =>
            e.totalUsdPercentile !== null &&
            e.totalUsdPercentile >= sizeMed === bigSize &&
            e.shockAtr >= shockMed === bigShock,
        );
        reportGroup(
          group,
          (bigSize ? "BIG" : "small") +
            " liquidation + " +
            (bigShock ? "BIG" : "small") +
            " ShockATR",
        );
      }
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "4. ABSORPTION/EFFICIENCY: high liquidation pressure + high vs low displacement-per-$1M",
  );
  console.log("=".repeat(160));
  const effMed = median(
    withEntryAndPercentile.map((e) => e.displacementAtrPerUsdM),
  );
  if (effMed !== null && sizeMed !== null) {
    const highPressure = withEntryAndPercentile.filter(
      (e) => e.totalUsdPercentile !== null && e.totalUsdPercentile >= sizeMed,
    );
    reportGroup(
      highPressure.filter((e) => e.displacementAtrPerUsdM >= effMed!),
      "high pressure + high efficiency (weak absorption)",
    );
    reportGroup(
      highPressure.filter((e) => e.displacementAtrPerUsdM < effMed!),
      "high pressure + low efficiency (strong absorption)",
    );
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "6. NAMED COMBINATIONS (P95+ liquidation crossed with other features)",
  );
  console.log("=".repeat(160));
  const p95Group = withEntryAndPercentile.filter(
    (e) => e.totalUsdPercentile !== null && e.totalUsdPercentile >= 95,
  );
  console.log("\n-- P95+ liquidation, n=" + p95Group.length + " --");
  const p95ShockMed = median(p95Group.map((e) => e.shockAtr));
  const p95DistMed = median(p95Group.map((e) => e.maxRatioInShockWindow));
  if (p95ShockMed !== null) {
    reportGroup(
      p95Group.filter((e) => e.shockAtr >= p95ShockMed!),
      "P95+ liq + high ShockATR",
    );
    reportGroup(
      p95Group.filter((e) => e.shockAtr < p95ShockMed!),
      "P95+ liq + low ShockATR",
    );
  }
  reportGroup(
    p95Group.filter((e) => (e.efficiencyDecay ?? Infinity) < 0),
    "P95+ liq + efficiency decay (weakening)",
  );
  reportGroup(
    p95Group.filter((e) => (e.efficiencyDecay ?? -Infinity) >= 0),
    "P95+ liq + no decay",
  );
  if (p95DistMed !== null) {
    reportGroup(
      p95Group.filter((e) => e.maxRatioInShockWindow >= p95DistMed!),
      "P95+ liq + large ATR distortion",
    );
    reportGroup(
      p95Group.filter((e) => e.maxRatioInShockWindow < p95DistMed!),
      "P95+ liq + small ATR distortion",
    );
  }
  const allShockMed = median(withEntryAndPercentile.map((e) => e.shockAtr));
  if (allShockMed !== null) {
    const highShockGroup = withEntryAndPercentile.filter(
      (e) => e.shockAtr >= allShockMed!,
    );
    reportGroup(
      highShockGroup.filter((e) => (e.efficiencyDecay ?? Infinity) < 0),
      "high ShockATR + strong efficiency decay",
    );
    reportGroup(
      highShockGroup.filter((e) => (e.efficiencyDecay ?? -Infinity) >= 0),
      "high ShockATR + weak/no efficiency decay",
    );
  }
  if (p95ShockMed !== null) {
    const stack = p95Group.filter(
      (e) => e.shockAtr >= p95ShockMed! && (e.efficiencyDecay ?? Infinity) < 0,
    );
    reportGroup(
      stack,
      "P95+ liq + high ShockATR + falling efficiency (fully stacked)",
    );
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "5. ATR STRUCTURE CORRELATIONS + 8. TP-SIDE FEATURE CORRELATIONS (predictor vs +30m MFE)",
  );
  console.log("=".repeat(160));
  function pearson(xs: number[], ys: number[]): number | null {
    if (xs.length !== ys.length || xs.length < 3) return null;
    const n = xs.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n,
      my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0,
      dx2 = 0,
      dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx,
        dy = ys[i] - my;
      num += dx * dy;
      dx2 += dx * dx;
      dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    return denom > 0 ? num / denom : null;
  }
  const fav30 = withEntryAndPercentile.map((e) => mfeAt(e, 30));
  function corrReport(name: string, values: (number | null)[]) {
    const pairs = values
      .map((v, i) => [v, fav30[i]])
      .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
    const r = pearson(
      pairs.map((p) => p[0]),
      pairs.map((p) => p[1]),
    );
    console.log(
      "  " +
        name +
        ": r=" +
        (r?.toFixed(3) ?? "n/a") +
        " (n=" +
        pairs.length +
        ")",
    );
  }
  corrReport(
    "totalUsdPercentile",
    withEntryAndPercentile.map((e) => e.totalUsdPercentile),
  );
  corrReport(
    "maxEventPercentile",
    withEntryAndPercentile.map((e) => e.maxEventPercentile),
  );
  corrReport(
    "usdPerMinPercentile",
    withEntryAndPercentile.map((e) => e.usdPerMinPercentile),
  );
  corrReport(
    "ShockATR",
    withEntryAndPercentile.map((e) => e.shockAtr),
  );
  corrReport(
    "maxRatioInShockWindow (max distortion)",
    withEntryAndPercentile.map((e) => e.maxRatioInShockWindow),
  );
  corrReport(
    "displacementAtrPerUsdM (efficiency)",
    withEntryAndPercentile.map((e) => e.displacementAtrPerUsdM),
  );
  corrReport(
    "efficiencyDecay",
    withEntryAndPercentile.map((e) => e.efficiencyDecay),
  );
  corrReport(
    "minutesAfterStart to entry (norm speed from liq start)",
    withEntryAndPercentile.map((e) => e.entry100?.minutesAfterStart ?? null),
  );
  corrReport(
    "minutesAfterEnd to entry (norm speed from liq end)",
    withEntryAndPercentile.map((e) => e.entry100?.minutesAfterEnd ?? null),
  );

  console.log("\n" + "=".repeat(160));
  console.log("7. FAILED vs SUCCESSFUL ENTRIES (with percentile context)");
  console.log("=".repeat(160));
  const failed = withEntryAndPercentile.filter((e) => {
    const m = mfeAt(e, 15),
      a = maeAt(e, 15);
    return m !== null && a !== null && a > m;
  });
  const mfe15Vals = sortNum(withEntryAndPercentile.map((e) => mfeAt(e, 15)));
  const p75Mfe15 = percentile(mfe15Vals, 75);
  const successful =
    p75Mfe15 !== null
      ? withEntryAndPercentile.filter(
          (e) => (mfeAt(e, 15) ?? -Infinity) >= p75Mfe15,
        )
      : [];
  console.log(
    "  failed (n=" +
      failed.length +
      ") vs successful/top-quartile (n=" +
      successful.length +
      "):",
  );
  console.log(
    "    medianTotalUsdPercentile: failed=" +
      (median(failed.map((e) => e.totalUsdPercentile))?.toFixed(1) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.totalUsdPercentile))?.toFixed(1) ??
        "n/a"),
  );
  console.log(
    "    medianMaxEventPercentile: failed=" +
      (median(failed.map((e) => e.maxEventPercentile))?.toFixed(1) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.maxEventPercentile))?.toFixed(1) ??
        "n/a"),
  );
  console.log(
    "    medianUsdPerMinPercentile: failed=" +
      (median(failed.map((e) => e.usdPerMinPercentile))?.toFixed(1) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.usdPerMinPercentile))?.toFixed(1) ??
        "n/a"),
  );
  console.log(
    "    medianShockATR: failed=" +
      (median(failed.map((e) => e.shockAtr))?.toFixed(3) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.shockAtr))?.toFixed(3) ?? "n/a"),
  );
  console.log(
    "    medianMaxDistortion: failed=" +
      (median(failed.map((e) => e.maxRatioInShockWindow))?.toFixed(3) ??
        "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.maxRatioInShockWindow))?.toFixed(3) ??
        "n/a"),
  );
  console.log(
    "    medianNormSpeed(minAfterEnd): failed=" +
      (median(failed.map((e) => e.entry100?.minutesAfterEnd ?? null))?.toFixed(
        2,
      ) ?? "n/a") +
      "  successful=" +
      (median(
        successful.map((e) => e.entry100?.minutesAfterEnd ?? null),
      )?.toFixed(2) ?? "n/a"),
  );
  console.log(
    "    medianEfficiencyDecay: failed=" +
      (median(failed.map((e) => e.efficiencyDecay))?.toFixed(4) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.efficiencyDecay))?.toFixed(4) ?? "n/a"),
  );

  console.log("\n" + "=".repeat(160));
  console.log("8. TP-CAPACITY BUCKETS (+30m MFE) -- feature lookback");
  console.log("=".repeat(160));
  const tpBuckets: [string, (v: number) => boolean][] = [
    ["<0.5", (v) => v < 0.5],
    ["0.5-1", (v) => v >= 0.5 && v < 1],
    ["1-2", (v) => v >= 1 && v < 2],
    ["2-3", (v) => v >= 2 && v < 3],
    ["3-5", (v) => v >= 3 && v < 5],
    ["5+", (v) => v >= 5],
  ];
  for (const [label, pred] of tpBuckets) {
    const group = withEntryAndPercentile.filter((e) => {
      const v = mfeAt(e, 30);
      return v !== null && pred(v);
    });
    console.log(
      "  MFE30m=" +
        label +
        " (n=" +
        group.length +
        "): medTotalUsdPctile=" +
        (median(group.map((e) => e.totalUsdPercentile))?.toFixed(1) ?? "n/a") +
        " medShockATR=" +
        (median(group.map((e) => e.shockAtr))?.toFixed(3) ?? "n/a") +
        " medDistortion=" +
        (median(group.map((e) => e.maxRatioInShockWindow))?.toFixed(3) ??
          "n/a") +
        " medEfficiency=" +
        (median(group.map((e) => e.displacementAtrPerUsdM))?.toFixed(4) ??
          "n/a") +
        " medNormSpeed=" +
        (median(group.map((e) => e.entry100?.minutesAfterEnd ?? null))?.toFixed(
          2,
        ) ?? "n/a") +
        "min",
    );
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "9. P90 / P95 / P99 SIDE-BY-SIDE (does raising the bar improve outcomes?)",
  );
  console.log("=".repeat(160));
  reportGroup(
    withEntryAndPercentile,
    "ALL 100%-normalization entries (no size filter)",
  );
  for (const pLevel of [90, 95, 99]) {
    reportGroup(
      withEntryAndPercentile.filter(
        (e) => (e.maxEventPercentile ?? -1) >= pLevel,
      ),
      "largest event >= P" + pLevel,
    );
    reportGroup(
      withEntryAndPercentile.filter(
        (e) => (e.totalUsdPercentile ?? -1) >= pLevel,
      ),
      "total liquidation >= P" + pLevel,
    );
    reportGroup(
      withEntryAndPercentile.filter(
        (e) => (e.usdPerMinPercentile ?? -1) >= pLevel,
      ),
      "USD/min >= P" + pLevel,
    );
    reportGroup(
      withEntryAndPercentile.filter(
        (e) =>
          (e.totalUsdPercentile ?? -1) >= pLevel ||
          (e.maxEventPercentile ?? -1) >= pLevel ||
          (e.usdPerMinPercentile ?? -1) >= pLevel,
      ),
      "ANY condition >= P" + pLevel,
    );
    reportGroup(
      withEntryAndPercentile.filter(
        (e) =>
          (e.totalUsdPercentile ?? -1) >= pLevel &&
          (e.maxEventPercentile ?? -1) >= pLevel &&
          (e.usdPerMinPercentile ?? -1) >= pLevel,
      ),
      "ALL conditions simultaneously >= P" + pLevel,
    );
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "PER-SYMBOL: P95+ total liquidation, +15m MFE (so pooled stats don't hide symbol differences)",
  );
  console.log("=".repeat(160));
  for (const symbol of SYMBOLS) {
    const symP95 = withEntryAndPercentile.filter(
      (e) => e.symbol === symbol && (e.totalUsdPercentile ?? -1) >= 95,
    );
    if (symP95.length === 0) continue;
    console.log(
      "  " +
        symbol +
        " (n=" +
        symP95.length +
        "): medianMFE15m=" +
        (median(symP95.map((e) => mfeAt(e, 15)))?.toFixed(3) ?? "n/a") +
        "recATR",
    );
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "atr-entry-quality-and-significance-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        minPriorSamples: MIN_PRIOR_SAMPLES,
        insufficientData,
        totalEpisodes: allEpisodes.length,
        withEntry: withEntry.length,
        withEntryAndPercentile: withEntryAndPercentile.length,
        excludedForPriorHistory,
        episodes: allEpisodes,
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
