/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, multi-symbol.
 * Tests the hypothesis: ATR-distortion normalization (specifically
 * 100% normalization back toward pre-liquidation state) defines a
 * causal liquidation-episode-END / hypothetical-ENTRY signal, and
 * measures ONLY future price movement from that entry forward.
 *
 * DESIGN CHOICE, stated explicitly: the "distorted" reference used to
 * compute % normalized is the ATR value AT EPISODE END -- not a
 * retrospectively-discovered peak distortion. A peak can only be
 * identified with hindsight (you don't know a point was the maximum
 * until you've seen what came after), which would silently reintroduce
 * exactly the future-leakage the operator's own Section 4 rules out.
 * Maximum distortion observed during the shock window (episode start
 * through episode end + 30min) IS separately computed and reported as
 * a descriptive statistic (Section 3), but the causal normalization
 * search itself is anchored at the episode-end value throughout.
 *
 * Episode construction, causal ATR, and regime classification are
 * UNCHANGED from every prior pass -- LARGE + EXTREME waves only,
 * small/medium counts reported not dropped. v1 directional ATR
 * (prior-close-referenced) throughout.
 *
 * FEATURE TIME vs OUTCOME WINDOW: entry is defined purely from ATR
 * state (never price, never later liquidation waves, never a
 * confirmation-candle wait, never moved later because the trade
 * failed). Everything from the entry timestamp forward is outcome.
 *
 * No threshold invented beyond the existing magnitude regime split.
 * No coefficient optimized. Combinations are tested via simple
 * median-split cross-tabs, never a fitted weighting.
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
const NORM_LEVELS = [25, 50, 75, 100];
const NORM_WALK_CAP_MIN = 120;
const SHOCK_WINDOW_EXTRA_MIN = 30;

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
function emaAtrSeries(
  candlesAsc: Candle[],
  period: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (candlesAsc.length < 2) return out;
  const alpha = 2 / (period + 1);
  const trs: { t: number; tr: number }[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    trs.push({
      t: c.t,
      tr: Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close),
      ),
    });
  }
  let ema = trs[0].tr;
  out.set(trs[0].t, ema);
  for (let i = 1; i < trs.length; i++) {
    ema = alpha * trs[i].tr + (1 - alpha) * ema;
    out.set(trs[i].t, ema);
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
  mfeUsd: number;
  mfePct: number;
  mfeInPreRecAtr: number;
  mfeInEntryRecAtr: number;
  maeUsd: number;
  maePct: number;
  maeInPreLiqAtr: number;
  newExtremeBroken: boolean;
  timeToMfeMin: number | null;
  timeToMaeMin: number | null;
  timeToNewExtremeMin: number | null;
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
  preEmaAtr: number | null;
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
  priceDisplacementAtr: number;
  freshExtremeRateDuringEpisode: number;
  zeroOppositeRateDuringEpisode: number;
  earlyEfficiency: number | null;
  middleEfficiency: number | null;
  lateEfficiency: number | null;
  efficiencyDecay: number | null;
  entries: Record<
    number,
    {
      ts: number;
      price: number;
      minutesAfterEnd: number;
      recAtrAtEntry: number | null;
      horizons: HorizonOutcome[];
    } | null
  >;
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
  const regimeCountsBySymbolVictim: Record<
    string,
    { small: number; medium: number; large: number; extreme: number }
  > = {};
  const insufficientData: string[] = [];

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
    console.log(
      "  raw events: " +
        events.length +
        "  range: " +
        new Date(actualEarliest).toISOString() +
        " to " +
        new Date(actualLatest).toISOString(),
    );

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

    const emaAtr14 = emaAtrSeries(candlesAsc, 14);
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
        p95 = percentile(totals, 95)!;
      const key = symbol + "_" + victim;
      regimeCountsBySymbolVictim[key] = {
        small: 0,
        medium: 0,
        large: 0,
        extreme: 0,
      };
      const waves: Wave[] = rawWaves.map((r, idx) => {
        const regime =
          r.totalUsd < p50
            ? "small"
            : r.totalUsd < p80
              ? "medium"
              : r.totalUsd < p95
                ? "large"
                : "extreme";
        (regimeCountsBySymbolVictim[key] as any)[regime]++;
        let extremePrice = r.events[0].price;
        for (const e of r.events) {
          if (
            victim === "LONG" ? e.price < extremePrice : e.price > extremePrice
          )
            extremePrice = e.price;
        }
        return { symbol, victim, waveIndex: idx, ...r, extremePrice, regime };
      });
      console.log(
        "  " +
          victim +
          ": " +
          waves.length +
          " waves -- small=" +
          regimeCountsBySymbolVictim[key].small +
          " medium=" +
          regimeCountsBySymbolVictim[key].medium +
          " large=" +
          regimeCountsBySymbolVictim[key].large +
          " extreme=" +
          regimeCountsBySymbolVictim[key].extreme,
      );

      const qualifying = waves.filter(
        (w) => w.regime === "large" || w.regime === "extreme",
      );
      for (const w of qualifying) {
        const ep = computeEpisode(w, emaAtr14, downV1, upV1, klines);
        if (ep) allEpisodes.push(ep);
      }
    }
  }

  function computeEpisode(
    w: Wave,
    emaAtr14: Map<number, number>,
    downV1: Map<number, number>,
    upV1: Map<number, number>,
    klines: Map<number, Candle>,
  ): Episode | null {
    const victim = w.victim;
    const preDown = lookupCausal(downV1, w.startTs),
      preUp = lookupCausal(upV1, w.startTs);
    const postDown = lookupCausal(downV1, w.endTs),
      postUp = lookupCausal(upV1, w.endTs);
    const preEmaAtr = lookupCausal(emaAtr14, w.startTs);
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
    const priceDisplacementAtr = shockAtr;

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

    const ratioCrossings: Record<number, { ts: number; price: number } | null> =
      {};
    NORM_LEVELS.forEach((l) => (ratioCrossings[l] = null));
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
      const c = candleAt(klines, t);
      for (const level of NORM_LEVELS) {
        if (
          ratioCrossings[level] === null &&
          ratioFrac !== null &&
          ratioFrac >= level &&
          c
        )
          ratioCrossings[level] = { ts: t, price: c.close };
      }
      if (NORM_LEVELS.every((l) => ratioCrossings[l] !== null)) break;
    }

    const entries: Episode["entries"] = {};
    for (const level of NORM_LEVELS) {
      const crossing = ratioCrossings[level];
      if (!crossing) {
        entries[level] = null;
        continue;
      }
      const entryTs = crossing.ts,
        entryPrice = crossing.price;
      const recAtrAtEntry = lookupCausal(recSeries, entryTs);
      const horizons: HorizonOutcome[] = [];
      let runningNewExtreme = w.extremePrice;
      for (const hMin of HORIZONS_MIN) {
        const horizonTs = entryTs + hMin * 60000;
        let mfe = 0,
          mae = 0,
          newExtremeBroken = false,
          timeToMfeMin: number | null = null,
          timeToMaeMin: number | null = null,
          timeToNewExtremeMin: number | null = null;
        for (let t = entryTs + 60000; t <= horizonTs; t += 60000) {
          const c = candleAt(klines, t);
          if (!c) continue;
          const fav =
            victim === "LONG" ? c.high - entryPrice : entryPrice - c.low;
          if (fav > mfe) {
            mfe = fav;
            timeToMfeMin = (t - entryTs) / 60000;
          }
          const adv =
            victim === "LONG"
              ? Math.max(0, entryPrice - c.low)
              : Math.max(0, c.high - entryPrice);
          if (adv > mae) {
            mae = adv;
            timeToMaeMin = (t - entryTs) / 60000;
          }
          const brokeNow =
            victim === "LONG"
              ? c.low < runningNewExtreme
              : c.high > runningNewExtreme;
          if (brokeNow) {
            if (!newExtremeBroken) {
              newExtremeBroken = true;
              timeToNewExtremeMin = (t - entryTs) / 60000;
            }
            runningNewExtreme =
              victim === "LONG"
                ? Math.min(runningNewExtreme, c.low)
                : Math.max(runningNewExtreme, c.high);
          }
        }
        horizons.push({
          horizonMin: hMin,
          mfeUsd: mfe,
          mfePct: (mfe / entryPrice) * 100,
          mfeInPreRecAtr: mfe / preRecAtr,
          mfeInEntryRecAtr:
            recAtrAtEntry && recAtrAtEntry > 0
              ? mfe / recAtrAtEntry
              : mfe / preRecAtr,
          maeUsd: mae,
          maePct: (mae / entryPrice) * 100,
          maeInPreLiqAtr: mae / preLiqAtr,
          newExtremeBroken,
          timeToMfeMin,
          timeToMaeMin,
          timeToNewExtremeMin,
        });
      }
      entries[level] = {
        ts: entryTs,
        price: entryPrice,
        minutesAfterEnd: (entryTs - w.endTs) / 60000,
        recAtrAtEntry,
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
      preEmaAtr,
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
      priceDisplacementAtr,
      freshExtremeRateDuringEpisode,
      zeroOppositeRateDuringEpisode,
      earlyEfficiency,
      middleEfficiency,
      lateEfficiency,
      efficiencyDecay,
      entries,
    };
  }

  const PRIMARY_LEVEL = 100;
  const episodesWithEntry = allEpisodes.filter(
    (e) => e.entries[PRIMARY_LEVEL] !== null,
  );
  console.log(
    "\nTotal qualifying episodes: " +
      allEpisodes.length +
      "  with a 100%-normalization entry: " +
      episodesWithEntry.length +
      " (" +
      (
        (episodesWithEntry.length / Math.max(1, allEpisodes.length)) *
        100
      ).toFixed(1) +
      "%)",
  );
  if (insufficientData.length > 0) {
    console.log("\nINSUFFICIENT DATA:");
    insufficientData.forEach((m) => console.log("  " + m));
  }

  console.log("\n" + "=".repeat(160));
  console.log("A. TOTAL VALID EPISODES / B. NORMALIZATION-ENTRY SUCCESS STATS");
  console.log("=".repeat(160));
  for (const [key, counts] of Object.entries(regimeCountsBySymbolVictim))
    console.log(
      "  " +
        key +
        ": small=" +
        counts.small +
        " medium=" +
        counts.medium +
        " large=" +
        counts.large +
        " extreme=" +
        counts.extreme,
    );
  for (const level of NORM_LEVELS) {
    const n = allEpisodes.filter((e) => e.entries[level] !== null).length;
    console.log(
      "  reached " +
        level +
        "% normalization: " +
        n +
        "/" +
        allEpisodes.length +
        " (" +
        ((n / Math.max(1, allEpisodes.length)) * 100).toFixed(1) +
        "%)",
    );
  }

  function mfeAt(e: Episode, level: number, hMin: number): number | null {
    return (
      e.entries[level]?.horizons.find((h) => h.horizonMin === hMin)
        ?.mfeInEntryRecAtr ?? null
    );
  }
  function maeAt(e: Episode, level: number, hMin: number): number | null {
    return (
      e.entries[level]?.horizons.find((h) => h.horizonMin === hMin)
        ?.maeInPreLiqAtr ?? null
    );
  }
  function newExtAt(e: Episode, level: number, hMin: number): boolean | null {
    return (
      e.entries[level]?.horizons.find((h) => h.horizonMin === hMin)
        ?.newExtremeBroken ?? null
    );
  }

  function reportGroup(episodes: Episode[], label: string) {
    if (episodes.length === 0) {
      console.log("  " + label + ": n=0");
      return;
    }
    const withEntry = episodes.filter((e) => e.entries[PRIMARY_LEVEL] !== null);
    console.log(
      "  " +
        label +
        " (n=" +
        episodes.length +
        ", withEntry=" +
        withEntry.length +
        "):",
    );
    for (const hMin of HORIZONS_MIN) {
      const mfes = sortNum(withEntry.map((e) => mfeAt(e, PRIMARY_LEVEL, hMin)));
      const maes = sortNum(withEntry.map((e) => maeAt(e, PRIMARY_LEVEL, hMin)));
      const newExtVals = withEntry
        .map((e) => newExtAt(e, PRIMARY_LEVEL, hMin))
        .filter((v): v is boolean => v !== null);
      const pNewExt = newExtVals.length
        ? (newExtVals.filter((v) => v).length / newExtVals.length) * 100
        : null;
      console.log(
        "    +" +
          hMin +
          "m: MFE p25/med/p75=" +
          (percentile(mfes, 25)?.toFixed(3) ?? "n/a") +
          "/" +
          (percentile(mfes, 50)?.toFixed(3) ?? "n/a") +
          "/" +
          (percentile(mfes, 75)?.toFixed(3) ?? "n/a") +
          "recATR  medianMAE=" +
          (percentile(maes, 50)?.toFixed(3) ?? "n/a") +
          "liqATR  P(newExtreme)=" +
          (pNewExt?.toFixed(1) ?? "n/a") +
          "%",
      );
    }
  }

  console.log("\n" + "=".repeat(160));
  console.log("C. RESULTS BY SYMBOL (100% normalization entry)");
  console.log("=".repeat(160));
  for (const symbol of SYMBOLS)
    reportGroup(
      allEpisodes.filter((e) => e.symbol === symbol),
      symbol,
    );

  console.log("\n" + "=".repeat(160));
  console.log("D. LONG vs SHORT");
  console.log("=".repeat(160));
  for (const victim of ["LONG", "SHORT"] as const)
    reportGroup(
      allEpisodes.filter((e) => e.victim === victim),
      victim,
    );

  function bucketReport(
    featureName: string,
    getFeature: (e: Episode) => number | null,
    buckets: [string, (v: number) => boolean][],
  ) {
    console.log("\n--- " + featureName + " ---");
    for (const [label, pred] of buckets) {
      const group = episodesWithEntry.filter((e) => {
        const v = getFeature(e);
        return v !== null && pred(v);
      });
      reportGroup(group, label);
    }
  }
  console.log("\n" + "=".repeat(160));
  console.log(
    "E. LIQUIDATION SIZE vs TP  /  F. SHOCKATR vs TP  /  G. ATR DISTORTION vs TP  /  H. NORM SPEED vs TP  /  I. EFFICIENCY vs TP  /  J. INTENSITY/CADENCE vs TP",
  );
  console.log("=".repeat(160));
  const shockVals = sortNum(episodesWithEntry.map((e) => e.shockAtr));
  const shockP33 = percentile(shockVals, 33),
    shockP66 = percentile(shockVals, 66);
  bucketReport(
    "ShockATR (data-derived terciles: <p33 / p33-p66 / >p66)",
    (e) => e.shockAtr,
    [
      ["low", (v) => shockP33 !== null && v < shockP33],
      [
        "medium",
        (v) =>
          shockP33 !== null &&
          shockP66 !== null &&
          v >= shockP33 &&
          v < shockP66,
      ],
      ["high", (v) => shockP66 !== null && v >= shockP66],
    ],
  );
  const ratioDistVals = sortNum(
    episodesWithEntry.map((e) => e.ratioDistortionAtEnd),
  );
  const rdP33 = percentile(ratioDistVals, 33),
    rdP66 = percentile(ratioDistVals, 66);
  bucketReport(
    "RatioDistortion at episode end (terciles)",
    (e) => e.ratioDistortionAtEnd,
    [
      ["low", (v) => rdP33 !== null && v < rdP33],
      [
        "medium",
        (v) => rdP33 !== null && rdP66 !== null && v >= rdP33 && v < rdP66,
      ],
      ["high", (v) => rdP66 !== null && v >= rdP66],
    ],
  );
  const intensityVals = sortNum(episodesWithEntry.map((e) => e.usdPerMinute));
  const intP33 = percentile(intensityVals, 33),
    intP66 = percentile(intensityVals, 66);
  bucketReport(
    "Liquidation intensity USD/min (terciles)",
    (e) => e.usdPerMinute,
    [
      ["low", (v) => intP33 !== null && v < intP33],
      [
        "medium",
        (v) => intP33 !== null && intP66 !== null && v >= intP33 && v < intP66,
      ],
      ["high", (v) => intP66 !== null && v >= intP66],
    ],
  );
  bucketReport(
    "Normalization speed (minutes after episode end to 100%)",
    (e) => e.entries[PRIMARY_LEVEL]?.minutesAfterEnd ?? null,
    [
      ["fast (<=3min)", (v) => v <= 3],
      ["medium (3-10min)", (v) => v > 3 && v <= 10],
      ["slow (>10min)", (v) => v > 10],
    ],
  );
  bucketReport(
    "Efficiency decay (late - early, negative = weakening)",
    (e) => e.efficiencyDecay,
    [
      ["weakening (decay < 0)", (v) => v < 0],
      ["stable/strengthening (decay >= 0)", (v) => v >= 0],
    ],
  );

  console.log("\n" + "=".repeat(160));
  console.log(
    "K. FEATURE COMBINATIONS (median-split cross-tabs, no coefficients)",
  );
  console.log("=".repeat(160));
  function medianSplit(getFeature: (e: Episode) => number | null) {
    const vals = sortNum(episodesWithEntry.map(getFeature));
    return median(vals);
  }
  const shockMed = medianSplit((e) => e.shockAtr),
    ratioMed = medianSplit((e) => e.ratioDistortionAtEnd),
    intMed = medianSplit((e) => e.usdPerMinute),
    decayMed = medianSplit((e) => e.efficiencyDecay),
    speedMed = medianSplit(
      (e) => e.entries[PRIMARY_LEVEL]?.minutesAfterEnd ?? null,
    );
  function combo2(
    name: string,
    f1: (e: Episode) => number | null,
    m1: number | null,
    f2: (e: Episode) => number | null,
    m2: number | null,
  ) {
    if (m1 === null || m2 === null) {
      console.log("  " + name + ": insufficient data for median split");
      return;
    }
    console.log("  " + name + ":");
    for (const hi1 of [true, false])
      for (const hi2 of [true, false]) {
        const group = episodesWithEntry.filter((e) => {
          const v1 = f1(e),
            v2 = f2(e);
          return (
            v1 !== null && v2 !== null && v1 >= m1 === hi1 && v2 >= m2 === hi2
          );
        });
        const fav15 = median(group.map((e) => mfeAt(e, PRIMARY_LEVEL, 15)));
        console.log(
          "    " +
            (hi1 ? "HIGH" : "low") +
            "/" +
            (hi2 ? "HIGH" : "low") +
            " (n=" +
            group.length +
            "): medianMFE15m=" +
            (fav15?.toFixed(3) ?? "n/a") +
            "recATR",
        );
      }
  }
  combo2(
    "ShockATR x RatioDistortion",
    (e) => e.shockAtr,
    shockMed,
    (e) => e.ratioDistortionAtEnd,
    ratioMed,
  );
  combo2(
    "ShockATR x Intensity",
    (e) => e.shockAtr,
    shockMed,
    (e) => e.usdPerMinute,
    intMed,
  );
  combo2(
    "ShockATR x EfficiencyDecay",
    (e) => e.shockAtr,
    shockMed,
    (e) => e.efficiencyDecay,
    decayMed,
  );
  combo2(
    "RatioDistortion x NormSpeed",
    (e) => e.ratioDistortionAtEnd,
    ratioMed,
    (e) => e.entries[PRIMARY_LEVEL]?.minutesAfterEnd ?? null,
    speedMed,
  );
  combo2(
    "Intensity x EfficiencyDecay",
    (e) => e.usdPerMinute,
    intMed,
    (e) => e.efficiencyDecay,
    decayMed,
  );

  console.log("\n" + "=".repeat(160));
  console.log(
    "CORRELATIONS (predictor vs +30min MFE in entry-recATR units, PRIMARY 100%-entry population)",
  );
  console.log("=".repeat(160));
  const fav30 = episodesWithEntry.map((e) => mfeAt(e, PRIMARY_LEVEL, 30));
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
    "total liquidation USD",
    episodesWithEntry.map((e) => e.totalUsd),
  );
  corrReport(
    "max single event USD",
    episodesWithEntry.map((e) => e.maxSingleEventUsd),
  );
  corrReport(
    "duration (min)",
    episodesWithEntry.map((e) => e.durationMinutes),
  );
  corrReport(
    "USD/min",
    episodesWithEntry.map((e) => e.usdPerMinute),
  );
  corrReport(
    "event count",
    episodesWithEntry.map((e) => e.eventCount),
  );
  corrReport(
    "ShockATR",
    episodesWithEntry.map((e) => e.shockAtr),
  );
  corrReport(
    "priceDisplacementAtr",
    episodesWithEntry.map((e) => e.priceDisplacementAtr),
  );
  corrReport(
    "maxRatioInShockWindow",
    episodesWithEntry.map((e) => e.maxRatioInShockWindow),
  );
  corrReport(
    "liqDirExpansion",
    episodesWithEntry.map((e) => e.liqDirExpansion),
  );
  corrReport(
    "recDirCompression",
    episodesWithEntry.map((e) => e.recDirCompression),
  );
  corrReport(
    "ratioDistortionAtEnd",
    episodesWithEntry.map((e) => e.ratioDistortionAtEnd),
  );
  corrReport(
    "normalization speed (min)",
    episodesWithEntry.map(
      (e) => e.entries[PRIMARY_LEVEL]?.minutesAfterEnd ?? null,
    ),
  );
  corrReport(
    "lateEfficiency",
    episodesWithEntry.map((e) => e.lateEfficiency),
  );
  corrReport(
    "efficiencyDecay",
    episodesWithEntry.map((e) => e.efficiencyDecay),
  );
  corrReport(
    "freshExtremeRateDuringEpisode",
    episodesWithEntry.map((e) => e.freshExtremeRateDuringEpisode),
  );
  corrReport(
    "zeroOppositeRateDuringEpisode",
    episodesWithEntry.map((e) => e.zeroOppositeRateDuringEpisode),
  );

  console.log("\n" + "=".repeat(160));
  console.log(
    "L. FAILED NORMALIZATION ENTRIES (MAE15m > MFE15m) vs SUCCESSFUL (top-quartile MFE15m)",
  );
  console.log("=".repeat(160));
  const failed = episodesWithEntry.filter((e) => {
    const m = mfeAt(e, PRIMARY_LEVEL, 15),
      a = maeAt(e, PRIMARY_LEVEL, 15);
    return m !== null && a !== null && a > m;
  });
  const mfe15Vals = sortNum(
    episodesWithEntry.map((e) => mfeAt(e, PRIMARY_LEVEL, 15)),
  );
  const p75Mfe15 = percentile(mfe15Vals, 75);
  const successful =
    p75Mfe15 !== null
      ? episodesWithEntry.filter(
          (e) => (mfeAt(e, PRIMARY_LEVEL, 15) ?? -Infinity) >= p75Mfe15,
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
    "    medianShockATR: failed=" +
      (median(failed.map((e) => e.shockAtr))?.toFixed(3) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.shockAtr))?.toFixed(3) ?? "n/a"),
  );
  console.log(
    "    medianRatioDistortion: failed=" +
      (median(failed.map((e) => e.ratioDistortionAtEnd))?.toFixed(3) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.ratioDistortionAtEnd))?.toFixed(3) ??
        "n/a"),
  );
  console.log(
    "    medianNormSpeed(min): failed=" +
      (median(
        failed.map((e) => e.entries[PRIMARY_LEVEL]?.minutesAfterEnd ?? null),
      )?.toFixed(2) ?? "n/a") +
      "  successful=" +
      (median(
        successful.map(
          (e) => e.entries[PRIMARY_LEVEL]?.minutesAfterEnd ?? null,
        ),
      )?.toFixed(2) ?? "n/a"),
  );
  console.log(
    "    medianLateEfficiency: failed=" +
      (median(failed.map((e) => e.lateEfficiency))?.toFixed(4) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.lateEfficiency))?.toFixed(4) ?? "n/a"),
  );
  console.log(
    "    medianUsdPerMin: failed=" +
      (median(failed.map((e) => e.usdPerMinute))?.toFixed(0) ?? "n/a") +
      "  successful=" +
      (median(successful.map((e) => e.usdPerMinute))?.toFixed(0) ?? "n/a"),
  );

  console.log("\n" + "=".repeat(160));
  console.log(
    "M. TP-CAPACITY BUCKETS (actual MFE at +30m, entry-recATR units)",
  );
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
    const group = episodesWithEntry.filter((e) => {
      const v = mfeAt(e, PRIMARY_LEVEL, 30);
      return v !== null && pred(v);
    });
    console.log(
      "  MFE30m=" +
        label +
        " (n=" +
        group.length +
        "): medianShockATR=" +
        (median(group.map((e) => e.shockAtr))?.toFixed(3) ?? "n/a") +
        " medianRatioDistortion=" +
        (median(group.map((e) => e.ratioDistortionAtEnd))?.toFixed(3) ??
          "n/a") +
        " medianNormSpeed=" +
        (median(
          group.map((e) => e.entries[PRIMARY_LEVEL]?.minutesAfterEnd ?? null),
        )?.toFixed(2) ?? "n/a") +
        "min medianUsdPerMin=" +
        (median(group.map((e) => e.usdPerMinute))?.toFixed(0) ?? "n/a"),
    );
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "atr-normalization-entry-study-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        regimeCountsBySymbolVictim,
        insufficientData,
        totalEpisodes: allEpisodes.length,
        episodesWithPrimaryEntry: episodesWithEntry.length,
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
