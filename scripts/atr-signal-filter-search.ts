/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, multi-symbol,
 * 3-day dataset (confirmed actual retention -- HOURS set explicitly
 * to 72 here, not assumed generously as in the prior two passes).
 *
 * Goal shift from the prior study: instead of characterizing hundreds
 * of ATR-normalization entries, search a SMALL, interpretable space of
 * candidate filters (liquidation significance x ATR physics) for ones
 * that reduce the population to roughly 8-12 signals across all 10
 * symbols over the full 3-day window, then simulate simple fixed-%
 * and ATR-normalized TP/SL outcomes on those candidates, with a
 * leave-one-day-out breakdown to guard against 3-day overfitting.
 *
 * Reuses, UNCHANGED: episode construction (large+extreme regime,
 * existing run definition), v1 causal directional ATR, the causal
 * rolling symbol+victim-relative percentile ranks (prior-episodes-
 * only, MIN_PRIOR_SAMPLES floor) introduced in the prior pass, and
 * the 100%-ATR-normalization entry rule (causal, no future
 * confirmation, no threshold on the entry decision itself).
 *
 * Trade simulation is explicit about ambiguity: if a single candle's
 * range touches BOTH the TP and SL level in the same minute, SL is
 * assumed to have been hit first (the standard conservative
 * backtesting convention) -- this is stated, not hidden.
 *
 * Candidate filters are generated from a SMALL, explicit combinatorial
 * space (which the code enumerates, not hand-picks), never a search
 * over hundreds of arbitrary thresholds -- consistent with the
 * operator's own explicit "avoid 3-day overfitting" instruction.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No claim of a proven strategy -- this selects candidates
 * for continued LIVE testing, nothing more.
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
const TRADE_HORIZON_MIN = 30;
const SL_PCT = 0.3;
const TP_PCTS = [0.6, 0.66, 0.75];
const ALT_SL_PCTS = [0.2, 0.3, 0.4, 0.5];
const ATR_TP_MULTIPLES = [1.0, 1.5, 2.0, 2.5, 3.0];
const TARGET_MIN = 6,
  TARGET_MAX = 15,
  TARGET_CENTER = 10;

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
function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
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

interface Entry {
  symbol: string;
  victim: Victim;
  entryTs: number;
  entryPrice: number;
  day: string;
  totalUsd: number;
  maxSingleEventUsd: number;
  usdPerMinute: number;
  eventCount: number;
  durationMinutes: number;
  totalUsdPercentile: number | null;
  maxEventPercentile: number | null;
  usdPerMinPercentile: number | null;
  shockAtr: number;
  maxRatioInShockWindow: number;
  ratioDistortionAtEnd: number;
  normSpeedMin: number;
  recAtrAtEntry: number | null;
  freshExtremeRateDuringEpisode: number;
  zeroOppositeRateDuringEpisode: number;
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

  const allEntries: Entry[] = [];
  const klinesBySymbol: Record<string, Map<number, Candle>> = {};

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
    console.log(
      "  raw events: " +
        events.length +
        "  actual range: " +
        new Date(actualEarliest).toISOString() +
        " to " +
        new Date(actualLatest).toISOString(),
    );

    const klines = await fetchKlines(
      symbol,
      actualEarliest - 8 * 3600000,
      actualLatest + (NORM_WALK_CAP_MIN / 60 + 1) * 3600000,
    );
    klinesBySymbol[symbol] = klines;
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
        let extremePrice = r.events[0].price;
        for (const e of r.events) {
          if (
            victim === "LONG" ? e.price < extremePrice : e.price > extremePrice
          )
            extremePrice = e.price;
        }
        return { symbol, victim, waveIndex: idx, ...r, extremePrice, regime };
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
        if (w.regime === "large" || w.regime === "extreme") {
          const entry = computeEntry(
            w,
            downV1,
            upV1,
            klines,
            totalUsdPercentile,
            maxEventPercentile,
            usdPerMinPercentile,
          );
          if (entry) allEntries.push(entry);
        }
        priorTotalUsd.push(w.totalUsd);
        priorMaxEvent.push(w.maxSingleEventUsd);
        priorUsdPerMin.push(w.totalUsd / w.durationMinutes);
      }
      console.log(
        "  " +
          victim +
          ": " +
          waves.length +
          " waves, entries so far: " +
          allEntries.filter((e) => e.symbol === symbol && e.victim === victim)
            .length,
      );
    }
  }

  function computeEntry(
    w: Wave,
    downV1: Map<number, number>,
    upV1: Map<number, number>,
    klines: Map<number, Candle>,
    totalUsdPercentile: number | null,
    maxEventPercentile: number | null,
    usdPerMinPercentile: number | null,
  ): Entry | null {
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
    const ratioDistortionAtEnd = postRatio / preRatio;
    const startPrice = w.events[0].price;
    const shockAtr = Math.abs(startPrice - w.extremePrice) / preLiqAtr;
    const liqSeries = victim === "LONG" ? downV1 : upV1,
      recSeries = victim === "LONG" ? upV1 : downV1;

    let maxRatioInShockWindow = preRatio;
    for (let t = w.startTs; t <= w.endTs + 30 * 60000; t += 60000) {
      const l = lookupCausal(liqSeries, t),
        r = lookupCausal(recSeries, t);
      if (l === null || r === null || r <= 0) continue;
      const ratio = l / r;
      if (ratio > maxRatioInShockWindow) maxRatioInShockWindow = ratio;
    }

    const evs = w.events;
    let freshCount = 0,
      zeroOppCount = 0,
      pairCount = 0;
    let runningExtreme = evs[0]?.price ?? w.extremePrice;
    for (let i = 0; i < evs.length - 1; i++) {
      pairCount++;
      const priceChange = evs[i + 1].price - evs[i].price;
      if (!(victim === "LONG" ? priceChange < 0 : priceChange > 0))
        zeroOppCount++;
      if (
        victim === "LONG"
          ? evs[i + 1].price < runningExtreme
          : evs[i + 1].price > runningExtreme
      ) {
        freshCount++;
        runningExtreme = evs[i + 1].price;
      }
    }
    const freshExtremeRateDuringEpisode =
      pairCount > 0 ? (freshCount / pairCount) * 100 : 0;
    const zeroOppositeRateDuringEpisode =
      pairCount > 0 ? (zeroOppCount / pairCount) * 100 : 0;

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
      const curRatio = curLiq / curRec;
      const ratioFrac =
        postRatio !== preRatio
          ? ((postRatio - curRatio) / (postRatio - preRatio)) * 100
          : null;
      if (ratioFrac !== null && ratioFrac >= 100) {
        const c = candleAt(klines, t);
        if (c) {
          entryTs = t;
          entryPrice = c.close;
        }
        break;
      }
    }
    if (entryTs === null || entryPrice === null) return null;
    const recAtrAtEntry = lookupCausal(recSeries, entryTs);

    return {
      symbol: w.symbol,
      victim,
      entryTs,
      entryPrice,
      day: dayKey(entryTs),
      totalUsd: w.totalUsd,
      maxSingleEventUsd: w.maxSingleEventUsd,
      usdPerMinute: w.totalUsd / w.durationMinutes,
      eventCount: w.eventCount,
      durationMinutes: w.durationMinutes,
      totalUsdPercentile,
      maxEventPercentile,
      usdPerMinPercentile,
      shockAtr,
      maxRatioInShockWindow,
      ratioDistortionAtEnd,
      normSpeedMin: (entryTs - w.endTs) / 60000,
      recAtrAtEntry,
      freshExtremeRateDuringEpisode,
      zeroOppositeRateDuringEpisode,
    };
  }

  console.log(
    "\nTotal 100%-normalization entries (large+extreme episodes, all symbols/sides): " +
      allEntries.length,
  );
  const withPercentile = allEntries.filter(
    (e) => e.totalUsdPercentile !== null,
  );
  console.log(
    "with sufficient prior history for percentile: " + withPercentile.length,
  );
  const days = Array.from(new Set(allEntries.map((e) => e.day))).sort();
  console.log("observed days: " + days.join(", "));

  function simulateTrade(
    e: Entry,
    slPct: number,
    tpPct: number | null,
    tpAtrMult: number | null,
  ): {
    outcome: "TP" | "SL" | "TIMEOUT";
    minutesToOutcome: number | null;
    rMultiple: number;
  } {
    const klines = klinesBySymbol[e.symbol];
    const slDist = e.entryPrice * (slPct / 100);
    const tpDist =
      tpAtrMult !== null
        ? (e.recAtrAtEntry ?? 0) * tpAtrMult
        : e.entryPrice * ((tpPct ?? 0) / 100);
    const slLevel =
      e.victim === "LONG" ? e.entryPrice - slDist : e.entryPrice + slDist;
    const tpLevel =
      e.victim === "LONG" ? e.entryPrice + tpDist : e.entryPrice - tpDist;
    for (
      let t = e.entryTs + 60000;
      t <= e.entryTs + TRADE_HORIZON_MIN * 60000;
      t += 60000
    ) {
      const c = candleAt(klines, t);
      if (!c) continue;
      const hitTp = e.victim === "LONG" ? c.high >= tpLevel : c.low <= tpLevel;
      const hitSl = e.victim === "LONG" ? c.low <= slLevel : c.high >= slLevel;
      if (hitSl)
        return {
          outcome: "SL",
          minutesToOutcome: (t - e.entryTs) / 60000,
          rMultiple: -1,
        };
      if (hitTp) {
        const rMult = tpDist / slDist;
        return {
          outcome: "TP",
          minutesToOutcome: (t - e.entryTs) / 60000,
          rMultiple: rMult,
        };
      }
    }
    return { outcome: "TIMEOUT", minutesToOutcome: null, rMultiple: 0 };
  }

  function tradeSummary(
    entries: Entry[],
    slPct: number,
    tpPct: number | null,
    tpAtrMult: number | null,
  ) {
    const trades = entries.map((e) =>
      simulateTrade(e, slPct, tpPct, tpAtrMult),
    );
    const tpCount = trades.filter((t) => t.outcome === "TP").length;
    const slCount = trades.filter((t) => t.outcome === "SL").length;
    const timeoutCount = trades.filter((t) => t.outcome === "TIMEOUT").length;
    const winRate = entries.length ? (tpCount / entries.length) * 100 : null;
    const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
    const avgR = entries.length ? totalR / entries.length : null;
    let maxConsecutiveSl = 0,
      curStreak = 0;
    for (const t of trades) {
      if (t.outcome === "SL") {
        curStreak++;
        maxConsecutiveSl = Math.max(maxConsecutiveSl, curStreak);
      } else curStreak = 0;
    }
    const medTimeToTp = median(
      trades.filter((t) => t.outcome === "TP").map((t) => t.minutesToOutcome),
    );
    const medTimeToSl = median(
      trades.filter((t) => t.outcome === "SL").map((t) => t.minutesToOutcome),
    );
    return {
      n: entries.length,
      tpCount,
      slCount,
      timeoutCount,
      winRate,
      totalR,
      avgR,
      maxConsecutiveSl,
      medTimeToTp,
      medTimeToSl,
    };
  }

  interface FilterDef {
    name: string;
    pred: (e: Entry) => boolean;
  }
  const filters: FilterDef[] = [];
  for (const pLevel of [90, 95, 97, 99]) {
    filters.push({
      name: "totalUSD>=P" + pLevel,
      pred: (e) => (e.totalUsdPercentile ?? -1) >= pLevel,
    });
    filters.push({
      name: "maxEvent>=P" + pLevel,
      pred: (e) => (e.maxEventPercentile ?? -1) >= pLevel,
    });
    filters.push({
      name: "usdPerMin>=P" + pLevel,
      pred: (e) => (e.usdPerMinPercentile ?? -1) >= pLevel,
    });
    filters.push({
      name: "ANY2of3>=P" + pLevel,
      pred: (e) => {
        const flags = [
          (e.totalUsdPercentile ?? -1) >= pLevel,
          (e.maxEventPercentile ?? -1) >= pLevel,
          (e.usdPerMinPercentile ?? -1) >= pLevel,
        ];
        return flags.filter(Boolean).length >= 2;
      },
    });
    filters.push({
      name: "ALL3>=P" + pLevel,
      pred: (e) =>
        (e.totalUsdPercentile ?? -1) >= pLevel &&
        (e.maxEventPercentile ?? -1) >= pLevel &&
        (e.usdPerMinPercentile ?? -1) >= pLevel,
    });
  }
  const shockMed = median(withPercentile.map((e) => e.shockAtr));
  const distMed = median(withPercentile.map((e) => e.maxRatioInShockWindow));
  const speedMed = median(withPercentile.map((e) => e.normSpeedMin));
  for (const pLevel of [95, 97]) {
    const base = (e: Entry) => (e.totalUsdPercentile ?? -1) >= pLevel;
    if (shockMed !== null)
      filters.push({
        name: "totalUSD>=P" + pLevel + "+ShockATR>=med",
        pred: (e) => base(e) && e.shockAtr >= shockMed!,
      });
    if (distMed !== null)
      filters.push({
        name: "totalUSD>=P" + pLevel + "+distortion>=med",
        pred: (e) => base(e) && e.maxRatioInShockWindow >= distMed!,
      });
    if (speedMed !== null)
      filters.push({
        name: "totalUSD>=P" + pLevel + "+fastNorm(<=med)",
        pred: (e) => base(e) && e.normSpeedMin <= speedMed!,
      });
    if (shockMed !== null && distMed !== null)
      filters.push({
        name: "totalUSD>=P" + pLevel + "+Shock>=med+distortion>=med",
        pred: (e) =>
          base(e) &&
          e.shockAtr >= shockMed! &&
          e.maxRatioInShockWindow >= distMed!,
      });
    const any2base = (e: Entry) => {
      const flags = [
        (e.totalUsdPercentile ?? -1) >= pLevel,
        (e.maxEventPercentile ?? -1) >= pLevel,
        (e.usdPerMinPercentile ?? -1) >= pLevel,
      ];
      return flags.filter(Boolean).length >= 2;
    };
    if (shockMed !== null)
      filters.push({
        name: "ANY2of3>=P" + pLevel + "+ShockATR>=med",
        pred: (e) => any2base(e) && e.shockAtr >= shockMed!,
      });
  }

  console.log("\n" + "=".repeat(160));
  console.log(
    "CANDIDATE FILTER SIGNAL COUNTS (n=" +
      filters.length +
      " candidate filters generated)",
  );
  console.log("=".repeat(160));
  const filterResults = filters.map((f) => {
    const matched = withPercentile.filter(f.pred);
    const perDay = days.map((d) => matched.filter((e) => e.day === d).length);
    const symDist = SYMBOLS.map(
      (s) => matched.filter((e) => e.symbol === s).length,
    ).filter((c) => c > 0).length;
    const longCount = matched.filter((e) => e.victim === "LONG").length,
      shortCount = matched.filter((e) => e.victim === "SHORT").length;
    return {
      filter: f,
      matched,
      n: matched.length,
      perDay,
      symbolsRepresented: symDist,
      longCount,
      shortCount,
      distanceFromTarget: Math.abs(matched.length - TARGET_CENTER),
    };
  });
  filterResults.sort((a, b) => a.n - b.n);
  for (const fr of filterResults)
    console.log(
      "  " +
        fr.filter.name.padEnd(45) +
        " n=" +
        String(fr.n).padStart(3) +
        "  perDay=[" +
        fr.perDay.join(",") +
        "]  symbols=" +
        fr.symbolsRepresented +
        "  LONG=" +
        fr.longCount +
        " SHORT=" +
        fr.shortCount,
    );

  const inRange = filterResults
    .filter((fr) => fr.n >= TARGET_MIN && fr.n <= TARGET_MAX)
    .sort((a, b) => a.distanceFromTarget - b.distanceFromTarget);
  console.log(
    "\nFilters in the " +
      TARGET_MIN +
      "-" +
      TARGET_MAX +
      " signal range: " +
      inRange.length,
  );

  console.log("\n" + "=".repeat(160));
  console.log(
    "TOP 10 CANDIDATES CLOSEST TO TARGET (n~" +
      TARGET_CENTER +
      "), WITH TRADE SIMULATION",
  );
  console.log("=".repeat(160));
  const top10 = (
    inRange.length > 0
      ? inRange
      : [...filterResults].sort(
          (a, b) => a.distanceFromTarget - b.distanceFromTarget,
        )
  ).slice(0, 10);
  for (const fr of top10) {
    console.log(
      "\n--- " +
        fr.filter.name +
        " (n=" +
        fr.n +
        ", " +
        ((fr.n / HOURS) * 24).toFixed(2) +
        "/day) ---",
    );
    console.log(
      "  perDay=[" +
        fr.perDay.join(",") +
        "]  LONG=" +
        fr.longCount +
        " SHORT=" +
        fr.shortCount +
        " symbolsRepresented=" +
        fr.symbolsRepresented,
    );
    console.log(
      "  median totalUsdPctile=" +
        (median(fr.matched.map((e) => e.totalUsdPercentile))?.toFixed(1) ??
          "n/a") +
        " medianMaxEventPctile=" +
        (median(fr.matched.map((e) => e.maxEventPercentile))?.toFixed(1) ??
          "n/a") +
        " medianUsdPerMinPctile=" +
        (median(fr.matched.map((e) => e.usdPerMinPercentile))?.toFixed(1) ??
          "n/a"),
    );
    console.log(
      "  medianShockATR=" +
        (median(fr.matched.map((e) => e.shockAtr))?.toFixed(3) ?? "n/a") +
        " medianDistortion=" +
        (median(fr.matched.map((e) => e.maxRatioInShockWindow))?.toFixed(3) ??
          "n/a") +
        " medianNormSpeed=" +
        (median(fr.matched.map((e) => e.normSpeedMin))?.toFixed(2) ?? "n/a") +
        "min",
    );
    for (const tp of TP_PCTS) {
      const s = tradeSummary(fr.matched, SL_PCT, tp, null);
      console.log(
        "  SL=" +
          SL_PCT +
          "% TP=" +
          tp +
          "%: TP=" +
          s.tpCount +
          " SL=" +
          s.slCount +
          " TIMEOUT=" +
          s.timeoutCount +
          " winRate=" +
          (s.winRate?.toFixed(1) ?? "n/a") +
          "% totalR=" +
          s.totalR.toFixed(2) +
          " avgR=" +
          (s.avgR?.toFixed(3) ?? "n/a") +
          " maxConsecSL=" +
          s.maxConsecutiveSl +
          " medTimeToTP=" +
          (s.medTimeToTp?.toFixed(1) ?? "n/a") +
          "min medTimeToSL=" +
          (s.medTimeToSl?.toFixed(1) ?? "n/a") +
          "min",
      );
    }
    console.log("  ATR-normalized TP (SL=" + SL_PCT + "% fixed):");
    for (const mult of ATR_TP_MULTIPLES) {
      const s = tradeSummary(fr.matched, SL_PCT, null, mult);
      console.log(
        "    TP=" +
          mult +
          "xrecATR: TP=" +
          s.tpCount +
          " SL=" +
          s.slCount +
          " TIMEOUT=" +
          s.timeoutCount +
          " winRate=" +
          (s.winRate?.toFixed(1) ?? "n/a") +
          "% totalR=" +
          s.totalR.toFixed(2) +
          " avgR=" +
          (s.avgR?.toFixed(3) ?? "n/a"),
      );
    }
    console.log("  alt SL sensitivity (TP=0.66% fixed):");
    for (const altSl of ALT_SL_PCTS) {
      const s = tradeSummary(fr.matched, altSl, 0.66, null);
      console.log(
        "    SL=" +
          altSl +
          "%: winRate=" +
          (s.winRate?.toFixed(1) ?? "n/a") +
          "% totalR=" +
          s.totalR.toFixed(2),
      );
    }
    console.log("  by day (SL=0.30% TP=0.66%):");
    for (const d of days) {
      const dayEntries = fr.matched.filter((e) => e.day === d);
      if (dayEntries.length === 0) {
        console.log("    " + d + ": n=0");
        continue;
      }
      const s = tradeSummary(dayEntries, SL_PCT, 0.66, null);
      console.log(
        "    " +
          d +
          " (n=" +
          dayEntries.length +
          "): TP=" +
          s.tpCount +
          " SL=" +
          s.slCount +
          " TIMEOUT=" +
          s.timeoutCount +
          " totalR=" +
          s.totalR.toFixed(2),
      );
    }
  }

  console.log("\n" + "=".repeat(160));
  console.log("LEAVE-ONE-DAY-OUT (top 3 candidates, SL=0.30% TP=0.66%)");
  console.log("=".repeat(160));
  for (const fr of top10.slice(0, 3)) {
    console.log("\n--- " + fr.filter.name + " ---");
    for (const heldOutDay of days) {
      const trainDays = fr.matched.filter((e) => e.day !== heldOutDay);
      const testDays = fr.matched.filter((e) => e.day === heldOutDay);
      const trainSummary = tradeSummary(trainDays, SL_PCT, 0.66, null);
      const testSummary = tradeSummary(testDays, SL_PCT, 0.66, null);
      console.log(
        "  trained on " +
          days.filter((d) => d !== heldOutDay).join("+") +
          " (n=" +
          trainDays.length +
          ", totalR=" +
          trainSummary.totalR.toFixed(2) +
          ")  ->  held-out " +
          heldOutDay +
          " (n=" +
          testDays.length +
          ", totalR=" +
          testSummary.totalR.toFixed(2) +
          ")",
      );
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "atr-signal-filter-search-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        hoursWindow: HOURS,
        days,
        totalEntries: allEntries.length,
        withPercentile: withPercentile.length,
        filterResults: filterResults.map((fr) => ({
          name: fr.filter.name,
          n: fr.n,
          perDay: fr.perDay,
          symbolsRepresented: fr.symbolsRepresented,
          longCount: fr.longCount,
          shortCount: fr.shortCount,
        })),
        entries: allEntries,
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
