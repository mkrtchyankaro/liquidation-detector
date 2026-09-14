/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, multi-symbol,
 * statistical test of the directional-ATR-normalization hypothesis
 * that emerged from the two BTC burst examples. Reuses the SAME,
 * UNCHANGED activeRun/wave construction established throughout this
 * project -- no new episode classifier invented. LARGE + EXTREME
 * magnitude waves (per each symbol+victim's own historical regime
 * classification) are treated as "episodes" for this study;
 * small/medium counts are reported, not silently dropped.
 *
 * FEATURE TIME vs OUTCOME WINDOW is kept structurally separate:
 * everything under computeEpisode() uses only data <= episode end
 * (pre-ATR uses only data <= episode START). The forward walks
 * explicitly consume real, now-historical future candles -- this is
 * offline outcome research, never a live decision. Normalization
 * crossings (part 5) are determined from ATR state ONLY -- price is
 * never consulted to decide whether normalization occurred, only to
 * measure what happened afterward (parts 6/12).
 *
 * Mirrors direction correctly: for LONG victims, DownATR is the
 * liquidation-direction ATR and UpATR is the recovery-direction ATR;
 * for SHORT victims this is reversed. All downstream logic is written
 * generically against liqDirAtr/recDirAtr so LONG and SHORT share one
 * code path.
 *
 * No threshold is invented for episode qualification (uses the
 * existing regime classification) or for "reversed" (TP/SL sections
 * report correlations and grouped medians, never a binary label with
 * an invented cutoff). No production code touched, no coefficient
 * optimized.
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
const PERSISTENCE_WINDOWS = [1, 2, 3, 5];
const PRICE_CONTROL_MULTIPLES = [0.25, 0.5, 1.0];

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
/** CAUSAL lookup: last candle closed STRICTLY BEFORE ms's own minute.
 *  Klines are openTime-keyed -- for ms=16:05:04, floor gives
 *  16:05:00 (still forming, closes at 16:06:00), so subtracting 60000
 *  first correctly starts the search at 16:04:00 (closes 16:05:00,
 *  fully closed by 16:05:04). Satisfies the operator's own audit
 *  requirement precisely. */
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

interface NormCrossing {
  level: number;
  ts: number;
  minutesAfterEnd: number;
}
interface Episode {
  symbol: string;
  victim: Victim;
  waveIndex: number;
  startTs: number;
  endTs: number;
  durationMinutes: number;
  totalUsd: number;
  eventCount: number;
  maxSingleEventUsd: number;
  usdPerMinute: number;
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
  ratioDistortion: number;
  shockDisplacement: number;
  shockAtr: number;
  freshExtremeRateDuringEpisode: number;
  zeroOppositeRateDuringEpisode: number;
  earlyEfficiency: number | null;
  middleEfficiency: number | null;
  lateEfficiency: number | null;
  liqNormCrossings: NormCrossing[];
  recNormCrossings: NormCrossing[];
  ratioNormCrossings: NormCrossing[];
  horizonOutcomes: {
    horizonMin: number;
    favorableUsd: number;
    favorablePct: number;
    favorableInRecAtr: number;
    adverseUsd: number;
    adversePct: number;
    adverseInLiqAtr: number;
    freshExtreme: boolean;
    freshExtremeMinutes: number | null;
    closeToCloseNet: number | null;
  }[];
  persistenceTests: {
    level: number;
    window: number;
    ratioWorsened: boolean;
    ratioWorsenedAmount: number | null;
    liqAtrReExpanded: boolean;
    recAtrReCollapsed: boolean;
    freshExtremeAfter: boolean;
  }[];
  priceOnlyCrossings: {
    multiple: number;
    ts: number | null;
    minutesAfterEnd: number | null;
    additionalRecoveryNext10min: number | null;
  }[];
  atrNormCrossingsWithAdditionalRecovery: {
    axis: "liq" | "rec" | "ratio";
    level: number;
    minutesAfterEnd: number;
    additionalRecoveryNext10min: number;
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
      console.log(
        "  NO DATA -- reporting as insufficient, not silently dropped.\n",
      );
      insufficientData.push(symbol + ": zero raw events in the queried window");
      continue;
    }
    const actualEarliest = events[0].timestamp,
      actualLatest = events[events.length - 1].timestamp;
    console.log(
      "  raw events: " +
        events.length +
        "  actual observed range: " +
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
      console.log("  insufficient candle history -- skipping symbol.\n");
      insufficientData.push(symbol + ": fewer than 15 1m candles available");
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
        (e) => e.timestamp >= actualEarliest && (e as any).victim === victim,
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
        const ep = computeEpisode(w, downV1, upV1, klines);
        if (ep) allEpisodes.push(ep);
      }
    }
  }

  function computeEpisode(
    w: Wave,
    downV1: Map<number, number>,
    upV1: Map<number, number>,
    klines: Map<number, Candle>,
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
    const ratioDistortion = postRatio / preRatio;
    const startPrice = w.events[0].price;
    const shockDisplacement = Math.abs(startPrice - w.extremePrice);
    const shockAtr = shockDisplacement / preLiqAtr;

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

    const liqNormCrossings: NormCrossing[] = [],
      recNormCrossings: NormCrossing[] = [],
      ratioNormCrossings: NormCrossing[] = [];
    const liqSeries = victim === "LONG" ? downV1 : upV1,
      recSeries = victim === "LONG" ? upV1 : downV1;
    for (
      let t = Math.floor(w.endTs / 60000) * 60000;
      t <= w.endTs + NORM_WALK_CAP_MIN * 60000;
      t += 60000
    ) {
      const curLiq = lookupCausal(liqSeries, t),
        curRec = lookupCausal(recSeries, t);
      if (curLiq === null || curRec === null) continue;
      const curRatio = curLiq / curRec;
      const liqFrac =
        postLiqAtr !== preLiqAtr
          ? ((postLiqAtr - curLiq) / (postLiqAtr - preLiqAtr)) * 100
          : null;
      const recFrac =
        preRecAtr !== postRecAtr
          ? ((curRec - postRecAtr) / (preRecAtr - postRecAtr)) * 100
          : null;
      const ratioFrac =
        postRatio !== preRatio
          ? ((postRatio - curRatio) / (postRatio - preRatio)) * 100
          : null;
      for (const level of NORM_LEVELS) {
        if (
          liqFrac !== null &&
          liqFrac >= level &&
          !liqNormCrossings.some((c) => c.level === level)
        )
          liqNormCrossings.push({
            level,
            ts: t,
            minutesAfterEnd: (t - w.endTs) / 60000,
          });
        if (
          recFrac !== null &&
          recFrac >= level &&
          !recNormCrossings.some((c) => c.level === level)
        )
          recNormCrossings.push({
            level,
            ts: t,
            minutesAfterEnd: (t - w.endTs) / 60000,
          });
        if (
          ratioFrac !== null &&
          ratioFrac >= level &&
          !ratioNormCrossings.some((c) => c.level === level)
        )
          ratioNormCrossings.push({
            level,
            ts: t,
            minutesAfterEnd: (t - w.endTs) / 60000,
          });
      }
    }

    const horizonOutcomes: Episode["horizonOutcomes"] = [];
    let runningFreshExtreme = w.extremePrice;
    for (const hMin of HORIZONS_MIN) {
      const horizonTs = w.endTs + hMin * 60000;
      let favorable = 0,
        adverse = 0,
        freshExtreme = false,
        freshExtremeMinutes: number | null = null;
      for (
        let t = Math.floor(w.endTs / 60000) * 60000 + 60000;
        t <= horizonTs;
        t += 60000
      ) {
        const c = candleAt(klines, t);
        if (!c) continue;
        const fav =
          victim === "LONG" ? c.high - w.extremePrice : w.extremePrice - c.low;
        if (fav > favorable) favorable = fav;
        const adv =
          victim === "LONG"
            ? Math.max(0, w.extremePrice - c.low)
            : Math.max(0, c.high - w.extremePrice);
        if (adv > adverse) adverse = adv;
        const isFreshNow =
          victim === "LONG"
            ? c.low < runningFreshExtreme
            : c.high > runningFreshExtreme;
        if (isFreshNow) {
          if (!freshExtreme) {
            freshExtreme = true;
            freshExtremeMinutes = (t - w.endTs) / 60000;
          }
          runningFreshExtreme =
            victim === "LONG"
              ? Math.min(runningFreshExtreme, c.low)
              : Math.max(runningFreshExtreme, c.high);
        }
      }
      const horizonCandle = candleAt(klines, horizonTs);
      const endCandle = candleAt(klines, w.endTs);
      const closeToCloseNet =
        horizonCandle && endCandle
          ? horizonCandle.close - endCandle.close
          : null;
      horizonOutcomes.push({
        horizonMin: hMin,
        favorableUsd: favorable,
        favorablePct: (favorable / w.extremePrice) * 100,
        favorableInRecAtr: favorable / preRecAtr,
        adverseUsd: adverse,
        adversePct: (adverse / w.extremePrice) * 100,
        adverseInLiqAtr: adverse / preLiqAtr,
        freshExtreme,
        freshExtremeMinutes,
        closeToCloseNet,
      });
    }

    const persistenceTests: Episode["persistenceTests"] = [];
    for (const crossing of ratioNormCrossings) {
      const curLiqAt = lookupCausal(liqSeries, crossing.ts),
        curRecAt = lookupCausal(recSeries, crossing.ts);
      const curRatioAt =
        curLiqAt !== null && curRecAt !== null && curRecAt > 0
          ? curLiqAt / curRecAt
          : null;
      if (curRatioAt === null) continue;
      for (const window of PERSISTENCE_WINDOWS) {
        const futureTs = crossing.ts + window * 60000;
        const futureLiq = lookupCausal(liqSeries, futureTs),
          futureRec = lookupCausal(recSeries, futureTs);
        if (futureLiq === null || futureRec === null || futureRec <= 0)
          continue;
        const futureRatio = futureLiq / futureRec;
        const ratioWorsened = futureRatio > curRatioAt;
        const ratioWorsenedAmount = ratioWorsened
          ? futureRatio - curRatioAt
          : null;
        const liqAtrReExpanded = futureLiq > (curLiqAt ?? 0);
        const recAtrReCollapsed = futureRec < (curRecAt ?? Infinity);
        let freshExtremeAfter = false;
        let runningExt = w.extremePrice;
        for (let t = crossing.ts; t <= futureTs; t += 60000) {
          const c = candleAt(klines, t);
          if (!c) continue;
          if (victim === "LONG" ? c.low < runningExt : c.high > runningExt) {
            freshExtremeAfter = true;
            runningExt = victim === "LONG" ? c.low : c.high;
          }
        }
        persistenceTests.push({
          level: crossing.level,
          window,
          ratioWorsened,
          ratioWorsenedAmount,
          liqAtrReExpanded,
          recAtrReCollapsed,
          freshExtremeAfter,
        });
      }
    }

    const priceOnlyCrossings: Episode["priceOnlyCrossings"] = [];
    for (const mult of PRICE_CONTROL_MULTIPLES) {
      const target = mult * preRecAtr;
      let crossTs: number | null = null;
      for (
        let t = Math.floor(w.endTs / 60000) * 60000 + 60000;
        t <= w.endTs + NORM_WALK_CAP_MIN * 60000;
        t += 60000
      ) {
        const c = candleAt(klines, t);
        if (!c) continue;
        const fav =
          victim === "LONG" ? c.high - w.extremePrice : w.extremePrice - c.low;
        if (fav >= target) {
          crossTs = t;
          break;
        }
      }
      let additionalRecoveryNext10min: number | null = null;
      if (crossTs !== null) {
        const cAtCross = candleAt(klines, crossTs);
        const favAtCross =
          victim === "LONG"
            ? (cAtCross?.high ?? w.extremePrice) - w.extremePrice
            : w.extremePrice - (cAtCross?.low ?? w.extremePrice);
        let maxFavAfter = favAtCross;
        for (let t = crossTs + 60000; t <= crossTs + 10 * 60000; t += 60000) {
          const c = candleAt(klines, t);
          if (!c) continue;
          const fav =
            victim === "LONG"
              ? c.high - w.extremePrice
              : w.extremePrice - c.low;
          if (fav > maxFavAfter) maxFavAfter = fav;
        }
        additionalRecoveryNext10min = maxFavAfter - favAtCross;
      }
      priceOnlyCrossings.push({
        multiple: mult,
        ts: crossTs,
        minutesAfterEnd: crossTs !== null ? (crossTs - w.endTs) / 60000 : null,
        additionalRecoveryNext10min,
      });
    }

    const atrNormCrossingsWithAdditionalRecovery: Episode["atrNormCrossingsWithAdditionalRecovery"] =
      [];
    for (const [axis, crossings] of [
      ["liq", liqNormCrossings],
      ["rec", recNormCrossings],
      ["ratio", ratioNormCrossings],
    ] as ["liq" | "rec" | "ratio", NormCrossing[]][]) {
      for (const crossing of crossings) {
        const cAtCross = candleAt(klines, crossing.ts);
        const favAtCross =
          victim === "LONG"
            ? (cAtCross?.high ?? w.extremePrice) - w.extremePrice
            : w.extremePrice - (cAtCross?.low ?? w.extremePrice);
        let maxFavAfter = favAtCross;
        for (
          let t = crossing.ts + 60000;
          t <= crossing.ts + 10 * 60000;
          t += 60000
        ) {
          const c = candleAt(klines, t);
          if (!c) continue;
          const fav =
            victim === "LONG"
              ? c.high - w.extremePrice
              : w.extremePrice - c.low;
          if (fav > maxFavAfter) maxFavAfter = fav;
        }
        atrNormCrossingsWithAdditionalRecovery.push({
          axis,
          level: crossing.level,
          minutesAfterEnd: crossing.minutesAfterEnd,
          additionalRecoveryNext10min: maxFavAfter - favAtCross,
        });
      }
    }

    return {
      symbol: w.symbol,
      victim,
      waveIndex: w.waveIndex,
      startTs: w.startTs,
      endTs: w.endTs,
      durationMinutes: w.durationMinutes,
      totalUsd: w.totalUsd,
      eventCount: w.eventCount,
      maxSingleEventUsd: w.maxSingleEventUsd,
      usdPerMinute: w.totalUsd / w.durationMinutes,
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
      ratioDistortion,
      shockDisplacement,
      shockAtr,
      freshExtremeRateDuringEpisode,
      zeroOppositeRateDuringEpisode,
      earlyEfficiency,
      middleEfficiency,
      lateEfficiency,
      liqNormCrossings,
      recNormCrossings,
      ratioNormCrossings,
      horizonOutcomes,
      persistenceTests,
      priceOnlyCrossings,
      atrNormCrossingsWithAdditionalRecovery,
    };
  }

  console.log(
    "\nTotal qualifying (large+extreme) episodes across all symbols/sides: " +
      allEpisodes.length,
  );
  if (insufficientData.length > 0) {
    console.log("\nINSUFFICIENT DATA REPORTED (not silently dropped):");
    insufficientData.forEach((m) => console.log("  " + m));
  }

  console.log("\n" + "=".repeat(160));
  console.log("A. DATASET / SAMPLE COUNTS");
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

  function aggregateGroup(episodes: Episode[], label: string) {
    if (episodes.length === 0) {
      console.log("  " + label + ": n=0");
      return;
    }
    console.log("  " + label + " (n=" + episodes.length + "):");
    for (const hMin of HORIZONS_MIN) {
      const outs = episodes
        .map((e) => e.horizonOutcomes.find((h) => h.horizonMin === hMin))
        .filter((o): o is NonNullable<typeof o> => !!o);
      const medFav = median(outs.map((o) => o.favorableInRecAtr));
      const medAdv = median(outs.map((o) => o.adverseInLiqAtr));
      const freshProb =
        (outs.filter((o) => o.freshExtreme).length / outs.length) * 100;
      const medFreshTime = median(
        outs
          .filter((o) => o.freshExtremeMinutes !== null)
          .map((o) => o.freshExtremeMinutes),
      );
      console.log(
        "    +" +
          hMin +
          "min: medianFavorable=" +
          (medFav?.toFixed(3) ?? "n/a") +
          "recATR  medianAdverse=" +
          (medAdv?.toFixed(3) ?? "n/a") +
          "liqATR  P(freshExtreme)=" +
          freshProb.toFixed(1) +
          "%  medianTimeToFresh=" +
          (medFreshTime?.toFixed(1) ?? "n/a") +
          "min",
      );
    }
  }

  console.log("\n" + "=".repeat(160));
  console.log("D. NORMALIZATION LEVEL (RATIO AXIS) vs FUTURE REVERSAL");
  console.log("=".repeat(160));
  const noNorm = allEpisodes.filter((e) => e.ratioNormCrossings.length === 0);
  aggregateGroup(noNorm, "no meaningful normalization reached");
  for (const level of NORM_LEVELS)
    aggregateGroup(
      allEpisodes.filter((e) =>
        e.ratioNormCrossings.some((c) => c.level === level),
      ),
      level + "% ratio-normalization reached",
    );

  console.log("\n" + "=".repeat(160));
  console.log("E. NORMALIZATION SPEED (RATIO 100%) vs FUTURE REVERSAL");
  console.log("=".repeat(160));
  const speedBuckets: [string, (e: Episode) => boolean][] = [
    [
      "<=1min",
      (e) => {
        const c = e.ratioNormCrossings.find((x) => x.level === 100);
        return !!c && c.minutesAfterEnd <= 1;
      },
    ],
    [
      "<=3min",
      (e) => {
        const c = e.ratioNormCrossings.find((x) => x.level === 100);
        return !!c && c.minutesAfterEnd <= 3;
      },
    ],
    [
      "<=5min",
      (e) => {
        const c = e.ratioNormCrossings.find((x) => x.level === 100);
        return !!c && c.minutesAfterEnd <= 5;
      },
    ],
    [
      "<=10min",
      (e) => {
        const c = e.ratioNormCrossings.find((x) => x.level === 100);
        return !!c && c.minutesAfterEnd <= 10;
      },
    ],
    [
      "no normalization within 10min",
      (e) => {
        const c = e.ratioNormCrossings.find((x) => x.level === 100);
        return !c || c.minutesAfterEnd > 10;
      },
    ],
  ];
  for (const [label, pred] of speedBuckets)
    aggregateGroup(allEpisodes.filter(pred), label);

  console.log("\n" + "=".repeat(160));
  console.log(
    "B. BY SYMBOL (ratio 100% normalized vs not, +15min favorable recovery)",
  );
  console.log("=".repeat(160));
  for (const symbol of SYMBOLS) {
    const symEpisodes = allEpisodes.filter((e) => e.symbol === symbol);
    if (symEpisodes.length === 0) continue;
    const normed = symEpisodes.filter((e) =>
      e.ratioNormCrossings.some((c) => c.level === 100),
    );
    const notNormed = symEpisodes.filter(
      (e) => !e.ratioNormCrossings.some((c) => c.level === 100),
    );
    const medNormed = median(
      normed.map(
        (e) =>
          e.horizonOutcomes.find((h) => h.horizonMin === 15)
            ?.favorableInRecAtr ?? null,
      ),
    );
    const medNotNormed = median(
      notNormed.map(
        (e) =>
          e.horizonOutcomes.find((h) => h.horizonMin === 15)
            ?.favorableInRecAtr ?? null,
      ),
    );
    console.log(
      "  " +
        symbol +
        " (n=" +
        symEpisodes.length +
        "): normalized(n=" +
        normed.length +
        ") medianFav15m=" +
        (medNormed?.toFixed(3) ?? "n/a") +
        "recATR  |  not-normalized(n=" +
        notNormed.length +
        ") medianFav15m=" +
        (medNotNormed?.toFixed(3) ?? "n/a") +
        "recATR",
    );
  }
  console.log("\n" + "=".repeat(160));
  console.log("C. LONG vs SHORT (same comparison)");
  console.log("=".repeat(160));
  for (const victim of ["LONG", "SHORT"] as const) {
    const vEpisodes = allEpisodes.filter((e) => e.victim === victim);
    const normed = vEpisodes.filter((e) =>
      e.ratioNormCrossings.some((c) => c.level === 100),
    );
    const notNormed = vEpisodes.filter(
      (e) => !e.ratioNormCrossings.some((c) => c.level === 100),
    );
    const medNormed = median(
      normed.map(
        (e) =>
          e.horizonOutcomes.find((h) => h.horizonMin === 15)
            ?.favorableInRecAtr ?? null,
      ),
    );
    const medNotNormed = median(
      notNormed.map(
        (e) =>
          e.horizonOutcomes.find((h) => h.horizonMin === 15)
            ?.favorableInRecAtr ?? null,
      ),
    );
    console.log(
      "  " +
        victim +
        " (n=" +
        vEpisodes.length +
        "): normalized(n=" +
        normed.length +
        ") medianFav15m=" +
        (medNormed?.toFixed(3) ?? "n/a") +
        "recATR  |  not-normalized(n=" +
        notNormed.length +
        ") medianFav15m=" +
        (medNotNormed?.toFixed(3) ?? "n/a") +
        "recATR",
    );
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "F. TEMPORARY vs SUSTAINED NORMALIZATION (ratio axis, per persistence window)",
  );
  console.log("=".repeat(160));
  const allPersistenceTests = allEpisodes.flatMap((e) =>
    e.persistenceTests.map((pt) => ({ ...pt, episode: e })),
  );
  for (const window of PERSISTENCE_WINDOWS) {
    const testsAtWindow = allPersistenceTests.filter(
      (t) => t.window === window && t.level === 100,
    );
    const sustained = testsAtWindow.filter((t) => !t.ratioWorsened);
    const temporary = testsAtWindow.filter((t) => t.ratioWorsened);
    console.log(
      "  window=" +
        window +
        " candles (n=" +
        testsAtWindow.length +
        "): sustained=" +
        sustained.length +
        " temporary=" +
        temporary.length,
    );
    console.log(
      "    sustained -> P(freshExtremeAfter)=" +
        (sustained.length
          ? (
              (sustained.filter((t) => t.freshExtremeAfter).length /
                sustained.length) *
              100
            ).toFixed(1)
          : "n/a") +
        "%",
    );
    console.log(
      "    temporary -> P(freshExtremeAfter)=" +
        (temporary.length
          ? (
              (temporary.filter((t) => t.freshExtremeAfter).length /
                temporary.length) *
              100
            ).toFixed(1)
          : "n/a") +
        "%",
    );
    const sustainedFav15 = median(
      sustained.map(
        (t) =>
          t.episode.horizonOutcomes.find((h) => h.horizonMin === 15)
            ?.favorableInRecAtr ?? null,
      ),
    );
    const temporaryFav15 = median(
      temporary.map(
        (t) =>
          t.episode.horizonOutcomes.find((h) => h.horizonMin === 15)
            ?.favorableInRecAtr ?? null,
      ),
    );
    console.log(
      "    sustained -> medianFav15m=" +
        (sustainedFav15?.toFixed(3) ?? "n/a") +
        "recATR  |  temporary -> medianFav15m=" +
        (temporaryFav15?.toFixed(3) ?? "n/a") +
        "recATR",
    );
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "G. ATR NORMALIZATION vs PRICE-ONLY BASELINE (does ATR add information beyond the bounce that already happened?)",
  );
  console.log("=".repeat(160));
  const priceOnlyAdditional = allEpisodes
    .flatMap((e) =>
      e.priceOnlyCrossings
        .filter((c) => c.ts !== null)
        .map((c) => c.additionalRecoveryNext10min),
    )
    .filter((v): v is number => v !== null);
  const atrRatio100Additional = allEpisodes.flatMap((e) =>
    e.atrNormCrossingsWithAdditionalRecovery
      .filter((c) => c.axis === "ratio" && c.level === 100)
      .map((c) => c.additionalRecoveryNext10min),
  );
  console.log(
    "  median ADDITIONAL recovery in the 10min AFTER a price-only crossing (any multiple, pooled): " +
      (median(priceOnlyAdditional)?.toFixed(2) ?? "n/a") +
      " $",
  );
  console.log(
    "  median ADDITIONAL recovery in the 10min AFTER a 100% ratio-ATR-normalization crossing: " +
      (median(atrRatio100Additional)?.toFixed(2) ?? "n/a") +
      " $",
  );
  console.log(
    "  (n=" +
      priceOnlyAdditional.length +
      " price-only crossings vs n=" +
      atrRatio100Additional.length +
      " ATR-normalization crossings)",
  );

  console.log("\n" + "=".repeat(160));
  console.log(
    "H/I. TP-SIDE CORRELATIONS (predictor vs +30min favorable recovery in recATR units)",
  );
  console.log("=".repeat(160));
  const fav30 = allEpisodes.map(
    (e) =>
      e.horizonOutcomes.find((h) => h.horizonMin === 30)?.favorableInRecAtr ??
      null,
  );
  function corrReport(predictorName: string, values: (number | null)[]) {
    const pairs = values
      .map((v, i) => [v, fav30[i]])
      .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
    const r = pearson(
      pairs.map((p) => p[0]),
      pairs.map((p) => p[1]),
    );
    console.log(
      "  " +
        predictorName +
        ": pearson r=" +
        (r?.toFixed(3) ?? "n/a") +
        " (n=" +
        pairs.length +
        ")",
    );
  }
  corrReport(
    "ShockATR",
    allEpisodes.map((e) => e.shockAtr),
  );
  corrReport(
    "RatioDistortion",
    allEpisodes.map((e) => e.ratioDistortion),
  );
  corrReport(
    "normalization speed (min to 100% ratio, lower=faster)",
    allEpisodes.map(
      (e) =>
        e.ratioNormCrossings.find((c) => c.level === 100)?.minutesAfterEnd ??
        null,
    ),
  );
  corrReport(
    "lateEfficiency (during episode)",
    allEpisodes.map((e) => e.lateEfficiency),
  );
  corrReport(
    "liqDirExpansion",
    allEpisodes.map((e) => e.liqDirExpansion),
  );
  corrReport(
    "recDirCompression",
    allEpisodes.map((e) => e.recDirCompression),
  );

  console.log("\n" + "=".repeat(160));
  console.log(
    "J. SL-SIDE: persistence features (from stored crossing lists) vs adverse extension (+15min)",
  );
  console.log("=".repeat(160));
  const adv15 = (e: Episode) =>
    e.horizonOutcomes.find((h) => h.horizonMin === 15)?.adverseInLiqAtr ?? null;
  function persistenceGroupCompare(
    label: string,
    pred: (e: Episode) => boolean,
  ) {
    const present = allEpisodes.filter(pred),
      absent = allEpisodes.filter((e) => !pred(e));
    console.log(
      "  " +
        label +
        ": present(n=" +
        present.length +
        ") medianAdverse15m=" +
        (median(present.map(adv15))?.toFixed(3) ?? "n/a") +
        "liqATR  |  absent(n=" +
        absent.length +
        ") medianAdverse15m=" +
        (median(absent.map(adv15))?.toFixed(3) ?? "n/a") +
        "liqATR",
    );
  }
  persistenceGroupCompare(
    "liq-direction ATR NEVER normalized at all by +15min",
    (e) => !e.liqNormCrossings.some((c) => c.minutesAfterEnd <= 15),
  );
  persistenceGroupCompare(
    "rec-direction ATR NEVER normalized at all by +15min",
    (e) => !e.recNormCrossings.some((c) => c.minutesAfterEnd <= 15),
  );
  persistenceGroupCompare(
    "ratio NEVER normalized at all by +15min",
    (e) => !e.ratioNormCrossings.some((c) => c.minutesAfterEnd <= 15),
  );
  persistenceGroupCompare(
    "ratio reached 100% then worsened again within 3 candles (temporary)",
    (e) =>
      e.persistenceTests.some(
        (pt) => pt.level === 100 && pt.window === 3 && pt.ratioWorsened,
      ),
  );

  console.log("\n" + "=".repeat(160));
  console.log(
    "K. FAILURE CASES / COUNTEREXAMPLES (ratio normalized 100% but favorable recovery at +15min was in the bottom quartile of normalized episodes)",
  );
  console.log("=".repeat(160));
  const normedEpisodes = allEpisodes.filter((e) =>
    e.ratioNormCrossings.some((c) => c.level === 100),
  );
  const normedFav15Vals = sortNum(
    normedEpisodes.map(
      (e) =>
        e.horizonOutcomes.find((h) => h.horizonMin === 15)?.favorableInRecAtr ??
        null,
    ),
  );
  const p25Threshold = percentile(normedFav15Vals, 25);
  if (p25Threshold !== null) {
    const failures = normedEpisodes.filter(
      (e) =>
        (e.horizonOutcomes.find((h) => h.horizonMin === 15)
          ?.favorableInRecAtr ?? Infinity) <= p25Threshold,
    );
    failures
      .slice(0, 15)
      .forEach((e) =>
        console.log(
          "  " +
            e.symbol +
            " " +
            e.victim +
            " wave#" +
            e.waveIndex +
            " @" +
            new Date(e.startTs).toISOString() +
            " -- normalized but fav15m=" +
            (e.horizonOutcomes
              .find((h) => h.horizonMin === 15)
              ?.favorableInRecAtr?.toFixed(3) ?? "n/a") +
            "recATR, adverse15m=" +
            (e.horizonOutcomes
              .find((h) => h.horizonMin === 15)
              ?.adverseInLiqAtr?.toFixed(3) ?? "n/a") +
            "liqATR",
        ),
      );
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "multi-symbol-atr-normalization-study-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        regimeCountsBySymbolVictim,
        insufficientData,
        totalEpisodes: allEpisodes.length,
        episodes: allEpisodes,
      },
      null,
      2,
    ),
  );
  console.log(
    "\n\nFull data (every episode, every crossing, every horizon): " + outPath,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
