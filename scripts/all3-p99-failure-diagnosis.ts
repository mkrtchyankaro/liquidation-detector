/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, diagnostic ONLY
 * -- no new filter search. Focused entirely on the ALL3>=P99 entries
 * (reproduced from the identical, unchanged episode/percentile/entry
 * logic used throughout this research thread) to understand why 6 of
 * 9 hit SL.
 *
 * Full context (all symbols, both victims) is still regenerated
 * internally, because the causal percentile ranks are dataset-wide by
 * construction -- but every diagnostic below is reported ONLY for the
 * 9 episodes that actually match ALL3>=P99. Nothing here searches for
 * a better filter.
 *
 * The quiet-period END-condition test (100% ATR normalization + no
 * same-side liquidation for X seconds) is applied ONLY to these same
 * 9 episodes, re-deriving each one's own entry timestamp under each
 * variant -- never expanding to new episodes, never using future
 * price to decide the entry point (the quiet-period condition is
 * itself purely a function of liquidation-event timestamps, which are
 * already fully known at any candidate entry moment).
 *
 * Cross-market/cascade-fragment checks compare entry timestamps
 * across ALL 9 trades (same-symbol and cross-symbol), and separately
 * check BTC's own same-side liquidation activity after each non-BTC
 * trade's entry, as concrete, requested diagnostics -- not a new
 * episode-grouping rule.
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
const NORM_WALK_CAP_MIN = 120;
const MIN_PRIOR_SAMPLES = 15;
const POST_ENTRY_WATCH_MIN = 30;
const SL_PCT = 0.3,
  TP_PCT = 0.66;
const QUIET_PERIOD_VARIANTS_SEC = [30, 60, 90, 120];

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
function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
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

interface TargetTrade {
  symbol: string;
  victim: Victim;
  waveIndex: number;
  episodeStartTs: number;
  episodeEndTs: number;
  extremePrice: number;
  extremeTs: number;
  entryTs: number;
  entryPrice: number;
  preLiqAtr: number;
  preRecAtr: number;
  preRatio: number;
  postLiqAtr: number;
  postRecAtr: number;
  postRatio: number;
  liqSeriesRef: Map<number, number>;
  recSeriesRef: Map<number, number>;
  klinesRef: Map<number, Candle>;
  allEventsRef: any[];
  outcome: "TP" | "SL" | "TIMEOUT" | "AMBIGUOUS";
  exitTs: number | null;
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

  const targetTrades: TargetTrade[] = [];
  const allEventsBySymbol: Record<string, any[]> = {};
  const klinesBySymbol: Record<string, Map<number, Candle>> = {};
  const wavesBySymbolVictim: Record<string, Wave[]> = {};

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
    allEventsBySymbol[symbol] = events;
    const actualEarliest = events[0].timestamp,
      actualLatest = events[events.length - 1].timestamp;

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
      wavesBySymbolVictim[symbol + "_" + victim] = waves;

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
        const isAll3P99 =
          totalUsdPercentile !== null &&
          totalUsdPercentile >= 99 &&
          maxEventPercentile !== null &&
          maxEventPercentile >= 99 &&
          usdPerMinPercentile !== null &&
          usdPerMinPercentile >= 99;
        if ((w.regime === "large" || w.regime === "extreme") && isAll3P99) {
          const trade = computeTargetTrade(w, downV1, upV1, klines);
          if (trade) targetTrades.push(trade);
        }
        priorTotalUsd.push(w.totalUsd);
        priorMaxEvent.push(w.maxSingleEventUsd);
        priorUsdPerMin.push(w.totalUsd / w.durationMinutes);
      }
    }
  }

  function computeTargetTrade(
    w: Wave,
    downV1: Map<number, number>,
    upV1: Map<number, number>,
    klines: Map<number, Candle>,
  ): TargetTrade | null {
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
    const liqSeries = victim === "LONG" ? downV1 : upV1,
      recSeries = victim === "LONG" ? upV1 : downV1;

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

    const slDist = entryPrice * (SL_PCT / 100),
      tpDist = entryPrice * (TP_PCT / 100);
    const slLevel =
      victim === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    const tpLevel =
      victim === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
    let outcome: TargetTrade["outcome"] = "TIMEOUT",
      exitTs: number | null = null;
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
        exitTs = t;
        break;
      }
      if (hitSl) {
        outcome = "SL";
        exitTs = t;
        break;
      }
      if (hitTp) {
        outcome = "TP";
        exitTs = t;
        break;
      }
    }

    return {
      symbol: w.symbol,
      victim,
      waveIndex: w.waveIndex,
      episodeStartTs: w.startTs,
      episodeEndTs: w.endTs,
      extremePrice: w.extremePrice,
      extremeTs: w.extremeTs,
      entryTs,
      entryPrice,
      preLiqAtr,
      preRecAtr,
      preRatio,
      postLiqAtr,
      postRecAtr,
      postRatio,
      liqSeriesRef: liqSeries,
      recSeriesRef: recSeries,
      klinesRef: klines,
      allEventsRef: allEventsBySymbol[w.symbol],
      outcome,
      exitTs,
    };
  }

  console.log("\nTotal ALL3>=P99 target trades found: " + targetTrades.length);
  targetTrades.sort((a, b) => a.entryTs - b.entryTs);

  console.log("\n" + "=".repeat(170));
  console.log("PER-TRADE DEEP RECONSTRUCTION");
  console.log("=".repeat(170));
  const diagnostics = targetTrades.map((t, idx) => {
    const sameSideEvents = (t.allEventsRef as any[]).filter(
      (e) => e.victim === t.victim,
    );
    const distFromExtremeToEntry = Math.abs(t.entryPrice - t.extremePrice);
    const timeFromExtremeToEntryMin = (t.entryTs - t.extremeTs) / 60000;

    const sameSideAfterEntry = sameSideEvents.filter(
      (e) =>
        e.timestamp > t.entryTs &&
        e.timestamp <= t.entryTs + POST_ENTRY_WATCH_MIN * 60000,
    );
    const nextWave = wavesBySymbolVictim[t.symbol + "_" + t.victim].find(
      (w) => w.waveIndex === t.waveIndex + 1,
    );
    const nextWaveStartsShortlyAfter = nextWave
      ? (nextWave.startTs - t.entryTs) / 60000
      : null;

    let ratioAtEntry: number | null = null,
      maxRatioAfterEntry = -Infinity,
      liqAtEntry: number | null = null,
      maxLiqAfterEntry = -Infinity,
      recAtEntry: number | null = null,
      minRecAfterEntry = Infinity;
    let firstNewExtremeTs: number | null = null,
      firstNewExtremePrice: number | null = null;
    let runningExtreme = t.extremePrice;
    const priceMoves: Record<number, number> = {};
    for (
      let t2 = t.entryTs;
      t2 <= t.entryTs + POST_ENTRY_WATCH_MIN * 60000;
      t2 += 60000
    ) {
      const l = lookupCausal(t.liqSeriesRef, t2),
        r = lookupCausal(t.recSeriesRef, t2);
      if (l !== null && r !== null && r > 0) {
        const ratio = l / r;
        if (t2 === t.entryTs) {
          ratioAtEntry = ratio;
          liqAtEntry = l;
          recAtEntry = r;
        } else {
          if (ratio > maxRatioAfterEntry) maxRatioAfterEntry = ratio;
          if (l > maxLiqAfterEntry) maxLiqAfterEntry = l;
          if (r < minRecAfterEntry) minRecAfterEntry = r;
        }
      }
      const c = candleAt(t.klinesRef, t2);
      if (c) {
        const brokeNow =
          t.victim === "LONG"
            ? c.low < runningExtreme
            : c.high > runningExtreme;
        if (brokeNow && firstNewExtremeTs === null) {
          firstNewExtremeTs = t2;
          firstNewExtremePrice = t.victim === "LONG" ? c.low : c.high;
        }
        if (brokeNow)
          runningExtreme =
            t.victim === "LONG"
              ? Math.min(runningExtreme, c.low)
              : Math.max(runningExtreme, c.high);
        for (const m of [1, 2, 3, 5]) {
          if (t2 === t.entryTs + m * 60000)
            priceMoves[m] =
              t.victim === "LONG"
                ? c.close - t.entryPrice
                : t.entryPrice - c.close;
        }
      }
    }
    const ratioReDistorted =
      ratioAtEntry !== null && maxRatioAfterEntry > ratioAtEntry;
    const liqReExpanded = liqAtEntry !== null && maxLiqAfterEntry > liqAtEntry;
    const recReCollapsed = recAtEntry !== null && minRecAfterEntry < recAtEntry;

    console.log(
      "\n--- TRADE #" +
        (idx + 1) +
        "  " +
        t.symbol +
        " " +
        t.victim +
        "  outcome=" +
        t.outcome +
        " ---",
    );
    console.log(
      "  1. episode: " +
        fmtClock(t.episodeStartTs) +
        " -> " +
        fmtClock(t.episodeEndTs),
    );
    console.log("  2. extreme price: " + t.extremePrice);
    console.log("  3. entry (100% normalization) ts: " + fmtClock(t.entryTs));
    console.log("  4. entry price: " + t.entryPrice);
    console.log(
      "  5. distance extreme->entry: " +
        distFromExtremeToEntry.toFixed(4) +
        " (" +
        ((distFromExtremeToEntry / t.extremePrice) * 100).toFixed(4) +
        "%)",
    );
    console.log(
      "  6. time extreme->entry: " +
        timeFromExtremeToEntryMin.toFixed(2) +
        "min",
    );
    console.log(
      "  7. same-side liquidation AFTER entry (30min window): " +
        sameSideAfterEntry.length +
        " events, " +
        fmtUsd(sameSideAfterEntry.reduce((s, e) => s + e.quoteQty, 0)),
    );
    console.log(
      "  8. next wave (same symbol+victim) starts: " +
        (nextWave
          ? fmtClock(nextWave.startTs) +
            " (+" +
            nextWaveStartsShortlyAfter!.toFixed(1) +
            "min after entry)"
          : "none found"),
    );
    console.log(
      "  9. ATR ratio re-distorted after entry (max after > value at entry): " +
        ratioReDistorted +
        "  (atEntry=" +
        (ratioAtEntry?.toFixed(3) ?? "n/a") +
        " maxAfter=" +
        (maxRatioAfterEntry > -Infinity
          ? maxRatioAfterEntry.toFixed(3)
          : "n/a") +
        ")",
    );
    console.log(
      "  10. liq-direction ATR re-expanded after entry: " +
        liqReExpanded +
        "  (atEntry=" +
        (liqAtEntry?.toFixed(4) ?? "n/a") +
        " maxAfter=" +
        (maxLiqAfterEntry > -Infinity ? maxLiqAfterEntry.toFixed(4) : "n/a") +
        ")",
    );
    console.log(
      "  11. recovery-direction ATR re-collapsed after entry: " +
        recReCollapsed +
        "  (atEntry=" +
        (recAtEntry?.toFixed(4) ?? "n/a") +
        " minAfter=" +
        (minRecAfterEntry < Infinity ? minRecAfterEntry.toFixed(4) : "n/a") +
        ")",
    );
    console.log(
      "  12. price movement (favorable-signed) at +1/2/3/5min: " +
        [1, 2, 3, 5]
          .map((m) =>
            priceMoves[m] !== undefined ? priceMoves[m].toFixed(4) : "n/a",
          )
          .join(" / "),
    );
    console.log(
      "  13. first new extreme after entry: " +
        (firstNewExtremeTs
          ? fmtClock(firstNewExtremeTs) + " @ " + firstNewExtremePrice
          : "none within 30min"),
    );

    return {
      trade: t,
      distFromExtremeToEntry,
      timeFromExtremeToEntryMin,
      sameSideAfterEntryCount: sameSideAfterEntry.length,
      sameSideAfterEntryUsd: sameSideAfterEntry.reduce(
        (s, e) => s + e.quoteQty,
        0,
      ),
      nextWaveStartsShortlyAfter,
      ratioReDistorted,
      liqReExpanded,
      recReCollapsed,
      priceMoves,
      firstNewExtremeTs,
      firstNewExtremePrice,
    };
  });

  console.log("\n" + "=".repeat(170));
  console.log(
    "CASCADE-FRAGMENT DETECTION (same-symbol pairs, all gaps shown -- no cutoff imposed)",
  );
  console.log("=".repeat(170));
  for (let i = 0; i < targetTrades.length; i++) {
    for (let j = i + 1; j < targetTrades.length; j++) {
      const a = targetTrades[i],
        b = targetTrades[j];
      if (a.symbol === b.symbol && a.victim === b.victim) {
        const gapMin = (b.entryTs - a.entryTs) / 60000;
        console.log(
          "  " +
            a.symbol +
            " " +
            a.victim +
            ": trade@" +
            fmtClock(a.entryTs) +
            " (" +
            a.outcome +
            ")  ->  trade@" +
            fmtClock(b.entryTs) +
            " (" +
            b.outcome +
            ")  gap=" +
            gapMin.toFixed(1) +
            "min" +
            (gapMin <= 10
              ? "  <-- CLOSE, worth inspecting as possible same-cascade fragments"
              : ""),
        );
      }
    }
  }

  console.log("\n" + "=".repeat(170));
  console.log(
    "CROSS-MARKET SIMULTANEITY (all pairs within 10 minutes, any symbols)",
  );
  console.log("=".repeat(170));
  let anyCrossFound = false;
  for (let i = 0; i < targetTrades.length; i++) {
    for (let j = i + 1; j < targetTrades.length; j++) {
      const a = targetTrades[i],
        b = targetTrades[j];
      const gapMin = Math.abs(b.entryTs - a.entryTs) / 60000;
      if (gapMin <= 10) {
        anyCrossFound = true;
        console.log(
          "  " +
            a.symbol +
            " " +
            a.victim +
            "@" +
            fmtClock(a.entryTs) +
            " (" +
            a.outcome +
            ")  <->  " +
            b.symbol +
            " " +
            b.victim +
            "@" +
            fmtClock(b.entryTs) +
            " (" +
            b.outcome +
            ")  gap=" +
            gapMin.toFixed(1) +
            "min",
        );
      }
    }
  }
  if (!anyCrossFound) console.log("  none found within 10 minutes.");

  console.log("\n" + "=".repeat(170));
  console.log(
    "BTC MARKET-WIDE CONTEXT (BTC same-side liquidation activity in the 30min after each NON-BTC trade's entry)",
  );
  console.log("=".repeat(170));
  for (const t of targetTrades) {
    if (t.symbol === "BTCUSDT") continue;
    const btcEvents = allEventsBySymbol["BTCUSDT"] || [];
    const btcSameSide = btcEvents.filter(
      (e) =>
        e.victim === t.victim &&
        e.timestamp > t.entryTs &&
        e.timestamp <= t.entryTs + 30 * 60000,
    );
    console.log(
      "  " +
        t.symbol +
        " " +
        t.victim +
        "@" +
        fmtClock(t.entryTs) +
        " (" +
        t.outcome +
        "): BTC " +
        t.victim +
        " liquidation in next 30min = " +
        btcSameSide.length +
        " events, " +
        fmtUsd(btcSameSide.reduce((s, e) => s + e.quoteQty, 0)),
    );
  }

  console.log("\n" + "=".repeat(170));
  console.log(
    "WINNER vs LOSERS -- ALL 9 TRADES, ALL REQUESTED DIMENSIONS SIDE BY SIDE",
  );
  console.log("=".repeat(170));
  console.log(
    "outcome | symbol/side | sameSideActiveAfter | lastEventBeforeEntry(s) | usdLast30/60/120s | newLiqAfter | ratioReDistorted | liqReExpanded | recReCollapsed | distExtreme->Entry% | normDelay(min)",
  );
  for (const d of diagnostics) {
    const t = d.trade;
    const sameSideEvents = (t.allEventsRef as any[]).filter(
      (e) => e.victim === t.victim,
    );
    const beforeEntry = sameSideEvents
      .filter((e) => e.timestamp <= t.entryTs)
      .sort((a, b) => b.timestamp - a.timestamp);
    const lastEventBeforeEntrySec =
      beforeEntry.length > 0
        ? (t.entryTs - beforeEntry[0].timestamp) / 1000
        : null;
    const usdInWindow = (sec: number) =>
      sameSideEvents
        .filter(
          (e) =>
            e.timestamp <= t.entryTs && e.timestamp > t.entryTs - sec * 1000,
        )
        .reduce((s, e) => s + e.quoteQty, 0);
    console.log(
      t.outcome.padEnd(9) +
        " | " +
        (t.symbol + "/" + t.victim).padEnd(14) +
        " | " +
        (d.sameSideAfterEntryCount > 0
          ? "YES(" + d.sameSideAfterEntryCount + ")"
          : "no"
        ).padEnd(20) +
        " | " +
        (lastEventBeforeEntrySec?.toFixed(0) ?? "n/a").padEnd(24) +
        " | " +
        fmtUsd(usdInWindow(30)) +
        "/" +
        fmtUsd(usdInWindow(60)) +
        "/" +
        fmtUsd(usdInWindow(120)) +
        " | " +
        (d.sameSideAfterEntryCount > 0 ? "YES" : "no").padEnd(11) +
        " | " +
        String(d.ratioReDistorted).padEnd(17) +
        " | " +
        String(d.liqReExpanded).padEnd(13) +
        " | " +
        String(d.recReCollapsed).padEnd(15) +
        " | " +
        ((d.distFromExtremeToEntry / t.extremePrice) * 100).toFixed(4) +
        "% | " +
        ((t.entryTs - t.episodeEndTs) / 60000).toFixed(2),
    );
  }

  console.log("\n" + "=".repeat(170));
  console.log(
    "QUIET-PERIOD END-CONDITION TEST (100% normalization + no same-side liquidation for X seconds), same 9 episodes",
  );
  console.log("=".repeat(170));
  for (const quietSec of QUIET_PERIOD_VARIANTS_SEC) {
    const results: {
      symbol: string;
      victim: string;
      originalEntryTs: number;
      newEntryTs: number | null;
      delayMin: number | null;
      recoveryLostUsd: number | null;
      outcome: "TP" | "SL" | "TIMEOUT" | "AMBIGUOUS" | "NO_ENTRY";
    }[] = [];
    for (const t of targetTrades) {
      const sameSideEvents = (t.allEventsRef as any[]).filter(
        (e) => e.victim === t.victim,
      );
      let newEntryTs: number | null = null,
        newEntryPrice: number | null = null;
      for (
        let t2 = t.entryTs;
        t2 <= t.entryTs + NORM_WALK_CAP_MIN * 60000;
        t2 += 60000
      ) {
        const l = lookupCausal(t.liqSeriesRef, t2),
          r = lookupCausal(t.recSeriesRef, t2);
        if (l === null || r === null || r <= 0) continue;
        const ratio = l / r;
        const ratioFrac =
          t.postRatio !== t.preRatio
            ? ((t.postRatio - ratio) / (t.postRatio - t.preRatio)) * 100
            : null;
        if (ratioFrac === null || ratioFrac < 100) continue;
        const lastEventBefore = sameSideEvents
          .filter((e) => e.timestamp <= t2)
          .sort((a, b) => b.timestamp - a.timestamp)[0];
        const quietSatisfied =
          !lastEventBefore ||
          (t2 - lastEventBefore.timestamp) / 1000 >= quietSec;
        if (quietSatisfied) {
          const c = candleAt(t.klinesRef, t2);
          if (c) {
            newEntryTs = t2;
            newEntryPrice = c.close;
          }
          break;
        }
      }
      if (newEntryTs === null || newEntryPrice === null) {
        results.push({
          symbol: t.symbol,
          victim: t.victim,
          originalEntryTs: t.entryTs,
          newEntryTs: null,
          delayMin: null,
          recoveryLostUsd: null,
          outcome: "NO_ENTRY",
        });
        continue;
      }
      const delayMin = (newEntryTs - t.entryTs) / 60000;
      const recoveryLostUsd =
        t.victim === "LONG"
          ? newEntryPrice - t.extremePrice
          : t.extremePrice - newEntryPrice;
      const slDist = newEntryPrice * (SL_PCT / 100),
        tpDist = newEntryPrice * (TP_PCT / 100);
      const slLevel =
        t.victim === "LONG" ? newEntryPrice - slDist : newEntryPrice + slDist;
      const tpLevel =
        t.victim === "LONG" ? newEntryPrice + tpDist : newEntryPrice - tpDist;
      let outcome: "TP" | "SL" | "TIMEOUT" | "AMBIGUOUS" = "TIMEOUT";
      for (
        let t3 = newEntryTs + 60000;
        t3 <= newEntryTs + POST_ENTRY_WATCH_MIN * 60000;
        t3 += 60000
      ) {
        const c = candleAt(t.klinesRef, t3);
        if (!c) continue;
        const hitTp =
          t.victim === "LONG" ? c.high >= tpLevel : c.low <= tpLevel;
        const hitSl =
          t.victim === "LONG" ? c.low <= slLevel : c.high >= slLevel;
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
      results.push({
        symbol: t.symbol,
        victim: t.victim,
        originalEntryTs: t.entryTs,
        newEntryTs,
        delayMin,
        recoveryLostUsd,
        outcome,
      });
    }
    const validResults = results.filter((r) => r.newEntryTs !== null);
    const tpCount = validResults.filter((r) => r.outcome === "TP").length,
      slCount = validResults.filter((r) => r.outcome === "SL").length,
      toCount = validResults.filter((r) => r.outcome === "TIMEOUT").length,
      ambCount = validResults.filter((r) => r.outcome === "AMBIGUOUS").length;
    console.log(
      "\n  quiet=" +
        quietSec +
        "s: N=" +
        validResults.length +
        "/" +
        targetTrades.length +
        " (" +
        (targetTrades.length - validResults.length) +
        " never satisfied within " +
        NORM_WALK_CAP_MIN +
        "min)  TP=" +
        tpCount +
        " SL=" +
        slCount +
        " TIMEOUT=" +
        toCount +
        " AMBIGUOUS=" +
        ambCount,
    );
    console.log(
      "    avg entry delay: " +
        (median(validResults.map((r) => r.delayMin))?.toFixed(2) ?? "n/a") +
        "min median  avg recovery lost before entry: " +
        (median(validResults.map((r) => r.recoveryLostUsd))?.toFixed(4) ??
          "n/a"),
    );
    results.forEach((r) =>
      console.log(
        "    " +
          r.symbol +
          "/" +
          r.victim +
          ": original@" +
          fmtClock(r.originalEntryTs) +
          " -> new@" +
          (r.newEntryTs
            ? fmtClock(r.newEntryTs) +
              " (+" +
              r.delayMin!.toFixed(1) +
              "min, recoveryLost=" +
              r.recoveryLostUsd!.toFixed(4) +
              ")"
            : "NEVER") +
          "  outcome=" +
          r.outcome,
      ),
    );
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "all3-p99-failure-diagnosis-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        hoursWindow: HOURS,
        targetTrades: targetTrades.map((t) => ({
          symbol: t.symbol,
          victim: t.victim,
          episodeStartTs: t.episodeStartTs,
          episodeEndTs: t.episodeEndTs,
          extremePrice: t.extremePrice,
          extremeTs: t.extremeTs,
          entryTs: t.entryTs,
          entryPrice: t.entryPrice,
          outcome: t.outcome,
          exitTs: t.exitTs,
        })),
        diagnostics: diagnostics.map((d) => ({
          symbol: d.trade.symbol,
          victim: d.trade.victim,
          outcome: d.trade.outcome,
          distFromExtremeToEntry: d.distFromExtremeToEntry,
          timeFromExtremeToEntryMin: d.timeFromExtremeToEntryMin,
          sameSideAfterEntryCount: d.sameSideAfterEntryCount,
          sameSideAfterEntryUsd: d.sameSideAfterEntryUsd,
          nextWaveStartsShortlyAfter: d.nextWaveStartsShortlyAfter,
          ratioReDistorted: d.ratioReDistorted,
          liqReExpanded: d.liqReExpanded,
          recReCollapsed: d.recReCollapsed,
          priceMoves: d.priceMoves,
          firstNewExtremeTs: d.firstNewExtremeTs,
          firstNewExtremePrice: d.firstNewExtremePrice,
        })),
      },
      null,
      2,
    ),
  );
  console.log("\n\nFull diagnostic data: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
