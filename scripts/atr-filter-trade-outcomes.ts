/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, multi-symbol,
 * exact 72-hour window. Continues from the prior filter-frequency
 * search: reuses the IDENTICAL, unchanged episode/percentile/entry
 * generation logic, restricted to the 8 specifically named filters
 * plus one "best P95" comparison (selected programmatically as the
 * P95-tier filter whose signal count is closest to the 8-15 target
 * band, since the operator's own prior run output isn't available to
 * this script directly -- see the note at the top of this response).
 *
 * What this adds that the prior pass didn't compute: REAL first-hit
 * TP/SL simulation, with a genuine AMBIGUOUS outcome -- if a single
 * candle's range touches BOTH the TP and SL level, the exact fill
 * order within that minute is NOT knowable from 1-minute OHLC data
 * alone, so this is honestly marked AMBIGUOUS rather than guessed
 * (the prior pass's conservative "assume SL" shortcut is REMOVED
 * here, per explicit instruction).
 *
 * Win rate excludes AMBIGUOUS from the denominator (per instruction);
 * TIMEOUT remains in the denominator as a non-win. Total R excludes
 * AMBIGUOUS trades entirely (contributes neither positive nor
 * negative R, since the true outcome is genuinely unknown).
 *
 * Frequency is reported as "N over the exact 72h window" -- never
 * divided by 3 assumed calendar days, per explicit correction.
 *
 * No new thresholds are searched or optimized here -- exactly the 8
 * named filters plus the one P95 comparison, nothing else.
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
const TRADE_HORIZON_MIN = 30;
const SL_PCT = 0.3;
const TP_PCTS = [0.6, 0.66, 0.75];
const TARGET_MIN = 8,
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
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
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
  totalUsd: number;
  maxSingleEventUsd: number;
  usdPerMinute: number;
  totalUsdPercentile: number | null;
  maxEventPercentile: number | null;
  usdPerMinPercentile: number | null;
  shockAtr: number;
  maxRatioInShockWindow: number;
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
    const preLiqAtr = victim === "LONG" ? preDown : preUp;
    const postLiqAtr = victim === "LONG" ? postDown : postUp,
      postRecAtr = victim === "LONG" ? postUp : postDown;
    const preRecAtrForRatio = victim === "LONG" ? preUp : preDown;
    const preRatio = preLiqAtr / preRecAtrForRatio,
      postRatio = postLiqAtr / postRecAtr;
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

    return {
      symbol: w.symbol,
      victim,
      entryTs,
      entryPrice,
      totalUsd: w.totalUsd,
      maxSingleEventUsd: w.maxSingleEventUsd,
      usdPerMinute: w.totalUsd / w.durationMinutes,
      totalUsdPercentile,
      maxEventPercentile,
      usdPerMinPercentile,
      shockAtr,
      maxRatioInShockWindow,
    };
  }

  const withPercentile = allEntries.filter(
    (e) => e.totalUsdPercentile !== null,
  );
  console.log(
    "\nTotal 100%-normalization entries: " +
      allEntries.length +
      "  with sufficient prior history: " +
      withPercentile.length,
  );
  console.log(
    "Window: exactly " +
      HOURS +
      " hours (" +
      new Date(windowStart).toISOString() +
      " to " +
      new Date(windowEnd).toISOString() +
      ")",
  );

  function simulateTrade(
    e: Entry,
    slPct: number,
    tpPct: number,
  ): {
    outcome: "TP" | "SL" | "TIMEOUT" | "AMBIGUOUS";
    exitTs: number | null;
    rMultiple: number | null;
  } {
    const klines = klinesBySymbol[e.symbol];
    const slDist = e.entryPrice * (slPct / 100),
      tpDist = e.entryPrice * (tpPct / 100);
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
      if (hitTp && hitSl)
        return { outcome: "AMBIGUOUS", exitTs: t, rMultiple: null };
      if (hitSl) return { outcome: "SL", exitTs: t, rMultiple: -1 };
      if (hitTp)
        return { outcome: "TP", exitTs: t, rMultiple: tpDist / slDist };
    }
    return { outcome: "TIMEOUT", exitTs: null, rMultiple: 0 };
  }

  function tradeSummary(entries: Entry[], tpPct: number) {
    const sorted = [...entries].sort((a, b) => a.entryTs - b.entryTs);
    const trades = sorted.map((e) => ({
      entry: e,
      trade: simulateTrade(e, SL_PCT, tpPct),
    }));
    const tpCount = trades.filter((t) => t.trade.outcome === "TP").length;
    const slCount = trades.filter((t) => t.trade.outcome === "SL").length;
    const timeoutCount = trades.filter(
      (t) => t.trade.outcome === "TIMEOUT",
    ).length;
    const ambiguousCount = trades.filter(
      (t) => t.trade.outcome === "AMBIGUOUS",
    ).length;
    const denomExclAmbiguous = tpCount + slCount + timeoutCount;
    const winRateExclAmbiguous =
      denomExclAmbiguous > 0 ? (tpCount / denomExclAmbiguous) * 100 : null;
    const totalR = trades.reduce((s, t) => s + (t.trade.rMultiple ?? 0), 0);
    let maxConsecutiveSl = 0,
      curStreak = 0;
    for (const t of trades) {
      if (t.trade.outcome === "SL") {
        curStreak++;
        maxConsecutiveSl = Math.max(maxConsecutiveSl, curStreak);
      } else if (t.trade.outcome !== "AMBIGUOUS") curStreak = 0;
    }
    return {
      trades,
      tpCount,
      slCount,
      timeoutCount,
      ambiguousCount,
      winRateExclAmbiguous,
      totalR,
      maxConsecutiveSl,
    };
  }

  interface FilterDef {
    name: string;
    pred: (e: Entry) => boolean;
  }
  const shockMed = median(withPercentile.map((e) => e.shockAtr));
  const distMed = median(withPercentile.map((e) => e.maxRatioInShockWindow));
  const named: FilterDef[] = [
    {
      name: "1. ALL3>=P99",
      pred: (e) =>
        (e.totalUsdPercentile ?? -1) >= 99 &&
        (e.maxEventPercentile ?? -1) >= 99 &&
        (e.usdPerMinPercentile ?? -1) >= 99,
    },
    {
      name: "2. USD/min>=P99",
      pred: (e) => (e.usdPerMinPercentile ?? -1) >= 99,
    },
    {
      name: "3. maxEvent>=P99",
      pred: (e) => (e.maxEventPercentile ?? -1) >= 99,
    },
    {
      name: "4. ANY2of3>=P99",
      pred: (e) => {
        const f = [
          (e.totalUsdPercentile ?? -1) >= 99,
          (e.maxEventPercentile ?? -1) >= 99,
          (e.usdPerMinPercentile ?? -1) >= 99,
        ];
        return f.filter(Boolean).length >= 2;
      },
    },
    {
      name: "5. totalUSD>=P99",
      pred: (e) => (e.totalUsdPercentile ?? -1) >= 99,
    },
    {
      name: "6. ALL3>=P97",
      pred: (e) =>
        (e.totalUsdPercentile ?? -1) >= 97 &&
        (e.maxEventPercentile ?? -1) >= 97 &&
        (e.usdPerMinPercentile ?? -1) >= 97,
    },
    {
      name: "7. ANY2of3>=P97+ShockATR>=med",
      pred: (e) => {
        const f = [
          (e.totalUsdPercentile ?? -1) >= 97,
          (e.maxEventPercentile ?? -1) >= 97,
          (e.usdPerMinPercentile ?? -1) >= 97,
        ];
        return (
          f.filter(Boolean).length >= 2 &&
          shockMed !== null &&
          e.shockAtr >= shockMed
        );
      },
    },
    {
      name: "8. totalUSD>=P97+ShockATR>=med+distortion>=med",
      pred: (e) =>
        (e.totalUsdPercentile ?? -1) >= 97 &&
        shockMed !== null &&
        e.shockAtr >= shockMed &&
        distMed !== null &&
        e.maxRatioInShockWindow >= distMed,
    },
  ];
  const p95Candidates: FilterDef[] = [
    {
      name: "P95-cmp: totalUSD>=P95",
      pred: (e) => (e.totalUsdPercentile ?? -1) >= 95,
    },
    {
      name: "P95-cmp: maxEvent>=P95",
      pred: (e) => (e.maxEventPercentile ?? -1) >= 95,
    },
    {
      name: "P95-cmp: usdPerMin>=P95",
      pred: (e) => (e.usdPerMinPercentile ?? -1) >= 95,
    },
    {
      name: "P95-cmp: ANY2of3>=P95",
      pred: (e) => {
        const f = [
          (e.totalUsdPercentile ?? -1) >= 95,
          (e.maxEventPercentile ?? -1) >= 95,
          (e.usdPerMinPercentile ?? -1) >= 95,
        ];
        return f.filter(Boolean).length >= 2;
      },
    },
    {
      name: "P95-cmp: ALL3>=P95",
      pred: (e) =>
        (e.totalUsdPercentile ?? -1) >= 95 &&
        (e.maxEventPercentile ?? -1) >= 95 &&
        (e.usdPerMinPercentile ?? -1) >= 95,
    },
  ];
  const p95Counts = p95Candidates.map((f) => ({
    f,
    n: withPercentile.filter(f.pred).length,
  }));
  const p95InRange = p95Counts
    .filter((x) => x.n >= TARGET_MIN && x.n <= TARGET_MAX)
    .sort(
      (a, b) => Math.abs(a.n - TARGET_CENTER) - Math.abs(b.n - TARGET_CENTER),
    );
  const bestP95 = (
    p95InRange.length > 0
      ? p95InRange
      : [...p95Counts].sort(
          (a, b) =>
            Math.abs(a.n - TARGET_CENTER) - Math.abs(b.n - TARGET_CENTER),
        )
  )[0];
  console.log(
    "\nBest P95 comparison filter selected programmatically (closest to " +
      TARGET_MIN +
      "-" +
      TARGET_MAX +
      " signals): " +
      bestP95.f.name +
      " (n=" +
      bestP95.n +
      ")",
  );
  console.log(
    "All P95 candidates for transparency: " +
      p95Counts.map((x) => x.f.name + "=" + x.n).join(", "),
  );

  const allFilters = [...named, bestP95.f];

  for (const f of allFilters) {
    const matched = withPercentile
      .filter(f.pred)
      .sort((a, b) => a.entryTs - b.entryTs);
    console.log("\n" + "=".repeat(170));
    console.log(
      f.name +
        "  --  N=" +
        matched.length +
        " over the exact " +
        HOURS +
        "h window",
    );
    console.log("=".repeat(170));

    for (const tp of TP_PCTS) {
      const s = tradeSummary(matched, tp);
      console.log(
        "\n  TP=" +
          tp +
          "% (SL=" +
          SL_PCT +
          "%): TP=" +
          s.tpCount +
          " SL=" +
          s.slCount +
          " TIMEOUT=" +
          s.timeoutCount +
          " AMBIGUOUS=" +
          s.ambiguousCount +
          "  winRate(exclAmbiguous)=" +
          (s.winRateExclAmbiguous?.toFixed(1) ?? "n/a") +
          "%  totalR=" +
          s.totalR.toFixed(2) +
          "  maxConsecSL=" +
          s.maxConsecutiveSl,
      );
    }

    console.log("\n  INDIVIDUAL TRADES (chronological):");
    console.log(
      "  time | symbol | side | entry | totalUSD | totUsdPctile | maxEvtPctile | usdPerMinPctile | ShockATR | distortion | @0.60%(exit) | @0.66%(exit) | @0.75%(exit)",
    );
    for (const e of matched) {
      const r60 = simulateTrade(e, SL_PCT, 0.6),
        r66 = simulateTrade(e, SL_PCT, 0.66),
        r75 = simulateTrade(e, SL_PCT, 0.75);
      console.log(
        "  " +
          fmtClock(e.entryTs) +
          " | " +
          e.symbol +
          " | " +
          e.victim +
          " | " +
          e.entryPrice.toFixed(4) +
          " | $" +
          (e.totalUsd / 1000).toFixed(1) +
          "k | " +
          (e.totalUsdPercentile?.toFixed(1) ?? "n/a") +
          " | " +
          (e.maxEventPercentile?.toFixed(1) ?? "n/a") +
          " | " +
          (e.usdPerMinPercentile?.toFixed(1) ?? "n/a") +
          " | " +
          e.shockAtr.toFixed(3) +
          " | " +
          e.maxRatioInShockWindow.toFixed(3) +
          " | " +
          r60.outcome +
          (r60.exitTs ? "@" + fmtClock(r60.exitTs).slice(11) : "") +
          " | " +
          r66.outcome +
          (r66.exitTs ? "@" + fmtClock(r66.exitTs).slice(11) : "") +
          " | " +
          r75.outcome +
          (r75.exitTs ? "@" + fmtClock(r75.exitTs).slice(11) : ""),
      );
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "atr-filter-trade-outcomes-" + Date.now() + ".json",
  );
  const fullResults = allFilters.map((f) => {
    const matched = withPercentile
      .filter(f.pred)
      .sort((a, b) => a.entryTs - b.entryTs);
    const tpResults = TP_PCTS.map((tp) => ({
      tpPct: tp,
      summary: tradeSummary(matched, tp),
      trades: matched.map((e) => ({
        entry: e,
        outcome: simulateTrade(e, SL_PCT, tp),
      })),
    }));
    return { filterName: f.name, n: matched.length, tpResults };
  });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        hoursWindow: HOURS,
        windowStart,
        windowEnd,
        slPct: SL_PCT,
        tpPcts: TP_PCTS,
        tradeHorizonMin: TRADE_HORIZON_MIN,
        ambiguousNote:
          "AMBIGUOUS = a single 1m candle touched both TP and SL levels; true fill order is not determinable from 1m OHLC and is NOT guessed. Excluded from win-rate denominator and from total R.",
        bestP95Selection: {
          chosen: bestP95.f.name,
          n: bestP95.n,
          allCandidates: p95Counts.map((x) => ({ name: x.f.name, n: x.n })),
        },
        results: fullResults,
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
