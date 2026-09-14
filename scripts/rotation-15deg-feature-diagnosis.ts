/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, multi-symbol,
 * exact 72-hour window. Tests an alternative causal ENTRY concept to
 * ATR-normalization: DIRECTIONAL ATR ROTATION, treating (liqDirATR,
 * recDirATR) as a 2D vector and tracking its angle theta = atan2(
 * recDirATR, liqDirATR) in degrees. Liquidation-dominant states sit
 * near 0 deg (liq axis dominant); recovery-dominant states sit near
 * 90 deg. Rotation entry = first causal timestamp where theta has
 * risen by >= X degrees from its value AT EPISODE END (the same
 * causal reference point used for the normalization search
 * throughout this thread -- chosen for the same reason: it's known
 * the moment episode end is reached, no hindsight required).
 *
 * liq/rec framing is fully generic across victim direction (as
 * established throughout this project): for LONG, liq=DownATR,
 * rec=UpATR; for SHORT, liq=UpATR, rec=DownATR. Theta rising always
 * means "rotating toward recovery dominance" regardless of side --
 * one code path, no hand-mirrored duplicate logic.
 *
 * Slopes (for the simple slope-cross variant and for rotation speed)
 * use a 3-minute causal trailing window: slope = (value_t -
 * value_{t-3min}) / 3, in ATR-units/minute.
 *
 * rotationStrength = normalized rise of recATR (from its post-episode
 * value, divided by pre-episode recATR) + normalized fall of liqATR
 * (from its post-episode value, divided by pre-episode liqATR) --
 * pre-liquidation values only for normalization, no invented
 * coefficient.
 *
 * Entry search is strictly causal: at any candidate timestamp, only
 * theta/slope/ATR values computable from data <= that timestamp are
 * used to decide whether the entry condition is met. Post-entry ATR
 * trajectory (next 1/2/3/5 candles) is computed and reported ONLY as
 * diagnostic information, explicitly never used to choose the entry
 * itself.
 *
 * Populations: totalUSD>=P95/97/99 and ALL3>=P95/97/99, using the
 * same causal rolling percentile ranks established in the prior
 * passes. Trade simulation is identical to the prior passes: SL=
 * 0.30%, TP in {0.60,0.66,0.75}%, 30min horizon, first-hit ordering,
 * genuine AMBIGUOUS when a single candle touches both levels (never
 * guessed).
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No production rule chosen here.
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
const SL_PCT = 0.3;
const TP_PCTS = [0.6, 0.66, 0.75];
const ROTATION_ANGLES_DEG = [15, 30, 45, 60, 75, 90];
const SLOPE_WINDOW_MIN = 3;

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

interface EntryCandidate {
  ts: number;
  price: number;
  rotationStrength: number | null;
  thetaAtEntry: number | null;
  degPerMinute: number | null;
}
interface Episode {
  symbol: string;
  victim: Victim;
  waveIndex: number;
  startTs: number;
  endTs: number;
  extremePrice: number;
  extremeTs: number;
  preLiqAtr: number;
  preRecAtr: number;
  postLiqAtr: number;
  postRecAtr: number;
  thetaAtEnd: number;
  totalUsdPercentile: number | null;
  maxEventPercentile: number | null;
  usdPerMinPercentile: number | null;
  liqSeries: Map<number, number>;
  recSeries: Map<number, number>;
  klines: Map<number, Candle>;
  normalizationEntry: EntryCandidate | null;
  rotationEntries: Record<number, EntryCandidate | null>;
  slopeCrossEntry: EntryCandidate | null;
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
        if (
          (w.regime === "large" || w.regime === "extreme") &&
          totalUsdPercentile !== null
        ) {
          const ep = computeEpisode(
            w,
            downV1,
            upV1,
            klines,
            totalUsdPercentile,
            maxEventPercentile,
            usdPerMinPercentile,
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
    if (postRecAtr <= 0) return null;
    const thetaAtEnd = thetaDeg(postLiqAtr, postRecAtr);
    const liqSeries = victim === "LONG" ? downV1 : upV1,
      recSeries = victim === "LONG" ? upV1 : downV1;
    const preRatio = preLiqAtr / preRecAtr,
      postRatio = postLiqAtr / postRecAtr;

    function slopeAt(series: Map<number, number>, t: number): number | null {
      const cur = lookupCausal(series, t),
        past = lookupCausal(series, t - SLOPE_WINDOW_MIN * 60000);
      if (cur === null || past === null) return null;
      return (cur - past) / SLOPE_WINDOW_MIN;
    }
    function rotationStrengthAt(curLiq: number, curRec: number): number {
      const normalizedRiseOfRec = (curRec - postRecAtr) / preRecAtr;
      const normalizedFallOfLiq = (postLiqAtr - curLiq) / preLiqAtr;
      return normalizedRiseOfRec + normalizedFallOfLiq;
    }

    let normalizationEntry: EntryCandidate | null = null;
    const rotationEntries: Record<number, EntryCandidate | null> = {};
    ROTATION_ANGLES_DEG.forEach((a) => (rotationEntries[a] = null));
    let slopeCrossEntry: EntryCandidate | null = null;

    for (
      let t = Math.floor(w.endTs / 60000) * 60000;
      t <= w.endTs + NORM_WALK_CAP_MIN * 60000;
      t += 60000
    ) {
      const curLiq = lookupCausal(liqSeries, t),
        curRec = lookupCausal(recSeries, t);
      if (curLiq === null || curRec === null || curRec <= 0) continue;
      const c = candleAt(klines, t);
      if (!c) continue;
      const curTheta = thetaDeg(curLiq, curRec);
      const deltaTheta = curTheta - thetaAtEnd;
      const rs = rotationStrengthAt(curLiq, curRec);

      if (normalizationEntry === null) {
        const curRatio = curLiq / curRec;
        const ratioFrac =
          postRatio !== preRatio
            ? ((postRatio - curRatio) / (postRatio - preRatio)) * 100
            : null;
        if (ratioFrac !== null && ratioFrac >= 100)
          normalizationEntry = {
            ts: t,
            price: c.close,
            rotationStrength: rs,
            thetaAtEntry: curTheta,
            degPerMinute: null,
          };
      }
      for (const a of ROTATION_ANGLES_DEG) {
        if (rotationEntries[a] === null && deltaTheta >= a) {
          const minutesElapsed = (t - w.endTs) / 60000;
          rotationEntries[a] = {
            ts: t,
            price: c.close,
            rotationStrength: rs,
            thetaAtEntry: curTheta,
            degPerMinute:
              minutesElapsed > 0 ? deltaTheta / minutesElapsed : null,
          };
        }
      }
      if (slopeCrossEntry === null) {
        const liqSlope = slopeAt(liqSeries, t),
          recSlope = slopeAt(recSeries, t);
        if (
          liqSlope !== null &&
          recSlope !== null &&
          liqSlope < 0 &&
          recSlope > 0
        )
          slopeCrossEntry = {
            ts: t,
            price: c.close,
            rotationStrength: rs,
            thetaAtEntry: curTheta,
            degPerMinute: null,
          };
      }
      if (
        normalizationEntry !== null &&
        ROTATION_ANGLES_DEG.every((a) => rotationEntries[a] !== null) &&
        slopeCrossEntry !== null
      )
        break;
    }

    return {
      symbol: w.symbol,
      victim,
      waveIndex: w.waveIndex,
      startTs: w.startTs,
      endTs: w.endTs,
      extremePrice: w.extremePrice,
      extremeTs: w.extremeTs,
      preLiqAtr,
      preRecAtr,
      postLiqAtr,
      postRecAtr,
      thetaAtEnd,
      totalUsdPercentile,
      maxEventPercentile,
      usdPerMinPercentile,
      liqSeries,
      recSeries,
      klines,
      normalizationEntry,
      rotationEntries,
      slopeCrossEntry,
    };
  }

  console.log(
    "\nTotal qualifying episodes (large+extreme, with percentile): " +
      allEpisodes.length,
  );

  function simulateTrade(
    ep: Episode,
    entry: EntryCandidate,
    tpPct: number,
  ): {
    outcome: "TP" | "SL" | "TIMEOUT" | "AMBIGUOUS";
    rMultiple: number | null;
  } {
    const slDist = entry.price * (SL_PCT / 100),
      tpDist = entry.price * (tpPct / 100);
    const slLevel =
      ep.victim === "LONG" ? entry.price - slDist : entry.price + slDist;
    const tpLevel =
      ep.victim === "LONG" ? entry.price + tpDist : entry.price - tpDist;
    for (
      let t = entry.ts + 60000;
      t <= entry.ts + POST_ENTRY_WATCH_MIN * 60000;
      t += 60000
    ) {
      const c = candleAt(ep.klines, t);
      if (!c) continue;
      const hitTp = ep.victim === "LONG" ? c.high >= tpLevel : c.low <= tpLevel;
      const hitSl = ep.victim === "LONG" ? c.low <= slLevel : c.high >= slLevel;
      if (hitTp && hitSl) return { outcome: "AMBIGUOUS", rMultiple: null };
      if (hitSl) return { outcome: "SL", rMultiple: -1 };
      if (hitTp) return { outcome: "TP", rMultiple: tpDist / slDist };
    }
    return { outcome: "TIMEOUT", rMultiple: 0 };
  }
  function summarize(
    episodes: Episode[],
    getEntry: (ep: Episode) => EntryCandidate | null,
    tpPct: number,
  ) {
    const withEntry = episodes
      .map((ep) => ({ ep, entry: getEntry(ep) }))
      .filter(
        (x): x is { ep: Episode; entry: EntryCandidate } => x.entry !== null,
      );
    const trades = withEntry.map((x) => ({
      ...x,
      result: simulateTrade(x.ep, x.entry, tpPct),
    }));
    const tpCount = trades.filter((t) => t.result.outcome === "TP").length,
      slCount = trades.filter((t) => t.result.outcome === "SL").length,
      toCount = trades.filter((t) => t.result.outcome === "TIMEOUT").length,
      ambCount = trades.filter((t) => t.result.outcome === "AMBIGUOUS").length;
    const totalR = trades.reduce((s, t) => s + (t.result.rMultiple ?? 0), 0);
    const medDelayMin = median(
      withEntry.map((x) => (x.entry.ts - x.ep.endTs) / 60000),
    );
    return {
      n: withEntry.length,
      tpCount,
      slCount,
      toCount,
      ambCount,
      totalR,
      medDelayMin,
    };
  }

  interface PopDef {
    name: string;
    pred: (ep: Episode) => boolean;
  }
  const populations: PopDef[] = [
    {
      name: "totalUSD>=P95",
      pred: (ep) => (ep.totalUsdPercentile ?? -1) >= 95,
    },
    {
      name: "totalUSD>=P97",
      pred: (ep) => (ep.totalUsdPercentile ?? -1) >= 97,
    },
    {
      name: "totalUSD>=P99",
      pred: (ep) => (ep.totalUsdPercentile ?? -1) >= 99,
    },
    {
      name: "ALL3>=P95",
      pred: (ep) =>
        (ep.totalUsdPercentile ?? -1) >= 95 &&
        (ep.maxEventPercentile ?? -1) >= 95 &&
        (ep.usdPerMinPercentile ?? -1) >= 95,
    },
    {
      name: "ALL3>=P97",
      pred: (ep) =>
        (ep.totalUsdPercentile ?? -1) >= 97 &&
        (ep.maxEventPercentile ?? -1) >= 97 &&
        (ep.usdPerMinPercentile ?? -1) >= 97,
    },
    {
      name: "ALL3>=P99",
      pred: (ep) =>
        (ep.totalUsdPercentile ?? -1) >= 99 &&
        (ep.maxEventPercentile ?? -1) >= 99 &&
        (ep.usdPerMinPercentile ?? -1) >= 99,
    },
  ];

  console.log("\n" + "=".repeat(175));
  console.log(
    "MAIN OUTPUT: TRADE GROUPS PER POPULATION x ENTRY METHOD x TP LEVEL",
  );
  console.log("=".repeat(175));
  const jsonResults: any[] = [];
  for (const pop of populations) {
    const popEpisodes = allEpisodes.filter(pop.pred);
    console.log("\n" + "#".repeat(100));
    console.log(
      "POPULATION: " + pop.name + "  (n episodes=" + popEpisodes.length + ")",
    );
    console.log("#".repeat(100));

    const methods: {
      name: string;
      getEntry: (ep: Episode) => EntryCandidate | null;
    }[] = [
      {
        name: "100% ATR normalization",
        getEntry: (ep) => ep.normalizationEntry,
      },
      ...ROTATION_ANGLES_DEG.map((a) => ({
        name: a + "deg rotation",
        getEntry: (ep: Episode) => ep.rotationEntries[a],
      })),
      { name: "simple slope-cross", getEntry: (ep) => ep.slopeCrossEntry },
    ];

    const popResults: any[] = [];
    for (const m of methods) {
      const n = popEpisodes.filter((ep) => m.getEntry(ep) !== null).length;
      console.log(
        "\n  -- " +
          m.name +
          " -- N=" +
          n +
          " (signals/72h=" +
          n.toFixed(0) +
          ")",
      );
      const tpResults: any[] = [];
      for (const tp of TP_PCTS) {
        const s = summarize(popEpisodes, m.getEntry, tp);
        console.log(
          "    TP=" +
            tp +
            "%: TP=" +
            s.tpCount +
            " SL=" +
            s.slCount +
            " TIMEOUT=" +
            s.toCount +
            " AMBIGUOUS=" +
            s.ambCount +
            "  totalR=" +
            s.totalR.toFixed(2) +
            "  medEntryDelay=" +
            (s.medDelayMin?.toFixed(2) ?? "n/a") +
            "min",
        );
        tpResults.push({ tpPct: tp, ...s });
      }
      popResults.push({ method: m.name, n, tpResults });
    }
    jsonResults.push({
      population: pop.name,
      nEpisodes: popEpisodes.length,
      methodResults: popResults,
    });
  }

  for (const popName of ["totalUSD>=P97", "ALL3>=P97"]) {
    const pop = populations.find((p) => p.name === popName)!;
    const popEpisodes = allEpisodes.filter(pop.pred);
    console.log("\n" + "=".repeat(175));
    console.log(
      "FINAL COMPARISON TABLE -- population=" +
        popName +
        " (TP=0.66%, SL=0.30%)",
    );
    console.log("=".repeat(175));
    console.log(
      "METHOD | N | medEntryDelay(min) | TP | SL | TIMEOUT | AMBIGUOUS | totalR",
    );
    const methods: {
      name: string;
      getEntry: (ep: Episode) => EntryCandidate | null;
    }[] = [
      {
        name: "100% ATR normalization",
        getEntry: (ep) => ep.normalizationEntry,
      },
      ...ROTATION_ANGLES_DEG.map((a) => ({
        name: a + "deg rotation",
        getEntry: (ep: Episode) => ep.rotationEntries[a],
      })),
      { name: "simple slope-cross", getEntry: (ep) => ep.slopeCrossEntry },
    ];
    for (const m of methods) {
      const s = summarize(popEpisodes, m.getEntry, 0.66);
      console.log(
        "  " +
          m.name.padEnd(24) +
          " | " +
          String(s.n).padStart(3) +
          " | " +
          (s.medDelayMin !== null
            ? s.medDelayMin.toFixed(2).padStart(8)
            : "n/a".padStart(8)) +
          " | " +
          s.tpCount +
          " | " +
          s.slCount +
          " | " +
          s.toCount +
          " | " +
          s.ambCount +
          " | " +
          s.totalR.toFixed(2),
      );
    }
  }

  console.log("\n" + "=".repeat(175));
  console.log(
    "ROTATION vs NORMALIZATION ENTRY DELAY (from episode extreme), all qualifying episodes with BOTH entries found",
  );
  console.log("=".repeat(175));
  const bothFound = allEpisodes.filter(
    (ep) => ep.normalizationEntry !== null && ep.rotationEntries[45] !== null,
  );
  const normDelays = bothFound.map(
    (ep) => (ep.normalizationEntry!.ts - ep.extremeTs) / 60000,
  );
  const rotDelays = bothFound.map(
    (ep) => (ep.rotationEntries[45]!.ts - ep.extremeTs) / 60000,
  );
  const normLost = bothFound.map(
    (ep) =>
      ((ep.victim === "LONG"
        ? ep.normalizationEntry!.price - ep.extremePrice
        : ep.extremePrice - ep.normalizationEntry!.price) /
        ep.extremePrice) *
      100,
  );
  const rotLost = bothFound.map(
    (ep) =>
      ((ep.victim === "LONG"
        ? ep.rotationEntries[45]!.price - ep.extremePrice
        : ep.extremePrice - ep.rotationEntries[45]!.price) /
        ep.extremePrice) *
      100,
  );
  console.log("  n=" + bothFound.length);
  console.log(
    "  median delay from extreme: normalization=" +
      (median(normDelays)?.toFixed(2) ?? "n/a") +
      "min  45deg-rotation=" +
      (median(rotDelays)?.toFixed(2) ?? "n/a") +
      "min",
  );
  console.log(
    "  median reversal-% already lost before entry: normalization=" +
      (median(normLost)?.toFixed(4) ?? "n/a") +
      "%  45deg-rotation=" +
      (median(rotLost)?.toFixed(4) ?? "n/a") +
      "%",
  );

  console.log("\n" + "=".repeat(175));
  console.log(
    "DIAGNOSTIC (future info, NOT used for entry decision): post-entry liq/rec ATR trajectory, 45deg rotation entries, ALL3>=P97 population",
  );
  console.log("=".repeat(175));
  const diagPop = allEpisodes.filter(
    (ep) =>
      (ep.totalUsdPercentile ?? -1) >= 97 &&
      (ep.maxEventPercentile ?? -1) >= 97 &&
      (ep.usdPerMinPercentile ?? -1) >= 97 &&
      ep.rotationEntries[45] !== null,
  );
  for (const ep of diagPop) {
    const entry = ep.rotationEntries[45]!;
    const trade66 = simulateTrade(ep, entry, 0.66);
    const traj = [1, 2, 3, 5].map((m) => {
      const l = lookupCausal(ep.liqSeries, entry.ts + m * 60000),
        r = lookupCausal(ep.recSeries, entry.ts + m * 60000);
      return l !== null && r !== null
        ? "liq=" + l.toFixed(3) + "/rec=" + r.toFixed(3)
        : "n/a";
    });
    console.log(
      "  " +
        ep.symbol +
        " " +
        ep.victim +
        " @" +
        fmtClock(entry.ts) +
        " outcome(0.66%)=" +
        trade66.outcome +
        " rotationStrength=" +
        (entry.rotationStrength?.toFixed(3) ?? "n/a") +
        " degPerMin=" +
        (entry.degPerMinute?.toFixed(2) ?? "n/a"),
    );
    console.log("    +1/2/3/5min liq/rec: " + traj.join(" | "));
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "directional-atr-rotation-entry-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        hoursWindow: HOURS,
        slPct: SL_PCT,
        tpPcts: TP_PCTS,
        rotationAnglesDeg: ROTATION_ANGLES_DEG,
        slopeWindowMin: SLOPE_WINDOW_MIN,
        results: jsonResults,
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
