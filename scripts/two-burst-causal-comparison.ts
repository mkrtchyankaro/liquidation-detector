/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, strictly causal
 * event-by-event comparison of two specific BTCUSDT LONG liquidation
 * bursts. Continues the causality discipline just established:
 * sub-minute historical price-path data does not exist in this
 * system, so NOTHING here uses a 1-minute candle's high/low to
 * describe price action between two liquidation events. Every price
 * measurement is either a real liquidation event price, pure
 * arithmetic on two real event prices, or ATR from a fully-closed
 * PAST candle.
 *
 * No episode/W1-W2 rule, no threshold invented, no strategy
 * optimization. Divergence detection below compares each event
 * against that SAME burst's own running median-so-far (a self-
 * relative comparison, not a fixed number) -- consistent with this
 * project's established "no invented universal threshold" principle.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

const SYMBOL = "BTCUSDT";
const VICTIM = "LONG";
const ATR_PERIOD = 240;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

const BURSTS = [
  {
    label: "BURST A",
    startIso: "2026-09-10T16:05:00.000Z",
    endIso: "2026-09-10T16:10:30.000Z",
  },
  {
    label: "BURST B",
    startIso: "2026-09-10T16:34:00.000Z",
    endIso: "2026-09-10T16:36:10.000Z",
  },
];

function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(11, 19);
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

interface RawEvent {
  timestamp: number;
  price: number;
  quoteQty: number;
}
interface CausalPair {
  idx: number;
  phase: "EARLY" | "MIDDLE" | "LATE";
  eventTs: number;
  eventUsd: number;
  eventPrice: number;
  nextTs: number;
  nextUsd: number;
  nextPrice: number;
  gapSeconds: number;
  priceChange: number;
  priceChangePct: number;
  atrAtEvent: number | null;
  priceChangeAtr: number | null;
  velocityUsdPerSec: number;
  usdPerSecondUntilNext: number;
  freshExtreme: boolean;
  impactPer100kAtr: number | null;
  zeroOrOppositeResponse: boolean;
}

async function analyzeBurst(
  col: any,
  atrAt: (ms: number) => { value: number | null; sourceTs: number | null },
  label: string,
  startIso: string,
  endIso: string,
) {
  const startTs = Date.parse(startIso),
    endTs = Date.parse(endIso);
  const events = (await col
    .find({
      symbol: SYMBOL,
      victim: VICTIM,
      timestamp: { $gte: startTs, $lte: endTs },
    })
    .sort({ timestamp: 1 })
    .toArray()) as unknown as RawEvent[];
  console.log(
    label +
      ": n=" +
      events.length +
      " events, window " +
      startIso +
      " to " +
      endIso,
  );
  if (events.length < 2) {
    console.log("  fewer than 2 events -- skipping.");
    return null;
  }

  const thirdSize = Math.ceil((events.length - 1) / 3);
  const pairs: CausalPair[] = [];
  let runningExtreme = events[0].price;
  for (let i = 0; i < events.length - 1; i++) {
    const eN = events[i],
      eN1 = events[i + 1];
    const gapSeconds = (eN1.timestamp - eN.timestamp) / 1000;
    const priceChange = eN1.price - eN.price;
    const priceChangePct = (priceChange / eN.price) * 100;
    const atr = atrAt(eN.timestamp);
    const priceChangeAtr =
      atr.value && atr.value > 0 ? priceChange / atr.value : null;
    const velocityUsdPerSec = gapSeconds > 0 ? priceChange / gapSeconds : 0;
    const usdPerSecondUntilNext =
      gapSeconds > 0 ? eN.quoteQty / gapSeconds : eN.quoteQty;
    const freshExtreme = eN1.price < runningExtreme;
    if (eN1.price < runningExtreme) runningExtreme = eN1.price;
    const impactPer100kAtr =
      priceChangeAtr !== null ? priceChangeAtr / (eN.quoteQty / 100000) : null;
    const zeroOrOppositeResponse = priceChange >= 0;
    const phase: "EARLY" | "MIDDLE" | "LATE" =
      i < thirdSize ? "EARLY" : i < thirdSize * 2 ? "MIDDLE" : "LATE";

    pairs.push({
      idx: i,
      phase,
      eventTs: eN.timestamp,
      eventUsd: eN.quoteQty,
      eventPrice: eN.price,
      nextTs: eN1.timestamp,
      nextUsd: eN1.quoteQty,
      nextPrice: eN1.price,
      gapSeconds,
      priceChange,
      priceChangePct,
      atrAtEvent: atr.value,
      priceChangeAtr,
      velocityUsdPerSec,
      usdPerSecondUntilNext,
      freshExtreme,
      impactPer100kAtr,
      zeroOrOppositeResponse,
    });
  }

  const durationSeconds =
    (events[events.length - 1].timestamp - events[0].timestamp) / 1000;
  const totalUsd = events.reduce((s, e) => s + e.quoteQty, 0);
  const usdPerMinute = totalUsd / (durationSeconds / 60);
  const startAtr = atrAt(events[0].timestamp);
  const endAtr = atrAt(events[events.length - 1].timestamp);
  const atrChangeAbs =
    startAtr.value !== null && endAtr.value !== null
      ? endAtr.value - startAtr.value
      : null;
  const atrChangePct =
    startAtr.value !== null && endAtr.value !== null && startAtr.value > 0
      ? (atrChangeAbs! / startAtr.value) * 100
      : null;
  const totalDirectionalAtr = pairs.reduce(
    (s, p) => s + (p.priceChangeAtr ?? 0),
    0,
  );
  const totalUsdInM = totalUsd / 1e6;
  const directionalEfficiencyPer1M =
    totalUsdInM > 0 ? totalDirectionalAtr / totalUsdInM : null;
  const freshExtremeRate =
    (pairs.filter((p) => p.freshExtreme).length / pairs.length) * 100;
  const zeroOppositeRate =
    (pairs.filter((p) => p.zeroOrOppositeResponse).length / pairs.length) * 100;

  function phaseEfficiency(phase: "EARLY" | "MIDDLE" | "LATE") {
    const phasePairs = pairs.filter((p) => p.phase === phase);
    const validImpacts = phasePairs
      .map((p) => p.impactPer100kAtr)
      .filter((v) => v !== null) as number[];
    return {
      n: phasePairs.length,
      medianImpactPer100kAtr: median(validImpacts),
      medianGapSeconds: median(phasePairs.map((p) => p.gapSeconds)),
      medianUsd: median(phasePairs.map((p) => p.eventUsd)),
      freshExtremePct: phasePairs.length
        ? (phasePairs.filter((p) => p.freshExtreme).length /
            phasePairs.length) *
          100
        : null,
      zeroOppositePct: phasePairs.length
        ? (phasePairs.filter((p) => p.zeroOrOppositeResponse).length /
            phasePairs.length) *
          100
        : null,
    };
  }

  const divergencePoints: number[] = [];
  for (let i = 2; i < pairs.length; i++) {
    const priorUsd = sortNum(pairs.slice(0, i).map((p) => p.eventUsd));
    const priorIntensity = sortNum(
      pairs.slice(0, i).map((p) => p.usdPerSecondUntilNext),
    );
    const priorImpact = sortNum(
      pairs
        .slice(0, i)
        .map((p) => p.impactPer100kAtr)
        .filter((v): v is number => v !== null),
    );
    const medUsd = median(priorUsd),
      medIntensity = median(priorIntensity),
      medImpact = median(priorImpact);
    const cur = pairs[i];
    if (
      medUsd !== null &&
      medIntensity !== null &&
      medImpact !== null &&
      cur.impactPer100kAtr !== null
    ) {
      const usdRising = cur.eventUsd > medUsd;
      const intensityRising = cur.usdPerSecondUntilNext > medIntensity;
      const impactWeakening = cur.impactPer100kAtr > medImpact;
      if (usdRising && intensityRising && impactWeakening)
        divergencePoints.push(i);
    }
  }

  return {
    label,
    events,
    pairs,
    durationSeconds,
    eventCount: events.length,
    totalUsd,
    usdPerMinute,
    startAtr: startAtr.value,
    endAtr: endAtr.value,
    atrChangeAbs,
    atrChangePct,
    totalDirectionalAtr,
    directionalEfficiencyPer1M,
    freshExtremeRate,
    zeroOppositeRate,
    early: phaseEfficiency("EARLY"),
    middle: phaseEfficiency("MIDDLE"),
    late: phaseEfficiency("LATE"),
    divergencePoints,
  };
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

  const earliestBurstStart = Math.min(
    ...BURSTS.map((b) => Date.parse(b.startIso)),
  );
  const latestBurstEnd = Math.max(...BURSTS.map((b) => Date.parse(b.endIso)));
  const klines = await fetchKlines(
    SYMBOL,
    earliestBurstStart - 6 * 3600000,
    latestBurstEnd + 60000,
  );
  const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
  const atrSeries = computeWilderAtrSeries(candlesAsc, ATR_PERIOD);
  function atrAt(ms: number): {
    value: number | null;
    sourceTs: number | null;
  } {
    let t = Math.floor(ms / 60000) * 60000 - 60000;
    for (let i = 0; i < 400; i++) {
      if (atrSeries.has(t)) return { value: atrSeries.get(t)!, sourceTs: t };
      t -= 60000;
    }
    return { value: null, sourceTs: null };
  }

  const results = [];
  for (const b of BURSTS) {
    const r = await analyzeBurst(col, atrAt, b.label, b.startIso, b.endIso);
    if (r) results.push(r);
  }

  for (const r of results) {
    console.log("\n" + "=".repeat(170));
    console.log(
      r.label +
        " -- EVENT-BY-EVENT TABLE (n=" +
        r.pairs.length +
        " pairs, " +
        r.eventCount +
        " raw events)",
    );
    console.log("=".repeat(170));
    console.log(
      "# phase | time | USD | price | gap(s) | priceChg | priceChg% | priceChgATR | vel$/s | USD/s-until-next | freshExt | impact/$100k(ATR) | zeroOrOpp",
    );
    r.pairs.forEach((p) => {
      console.log(
        p.idx +
          " " +
          p.phase.padEnd(6) +
          " | " +
          fmtClock(p.eventTs) +
          " | " +
          fmtUsd(p.eventUsd) +
          " | " +
          p.eventPrice.toFixed(1) +
          " | " +
          p.gapSeconds.toFixed(0) +
          " | " +
          p.priceChange.toFixed(1) +
          " | " +
          p.priceChangePct.toFixed(4) +
          "% | " +
          (p.priceChangeAtr !== null ? p.priceChangeAtr.toFixed(4) : "n/a") +
          " | " +
          p.velocityUsdPerSec.toFixed(2) +
          " | " +
          fmtUsd(p.usdPerSecondUntilNext) +
          " | " +
          (p.freshExtreme ? "YES" : "no") +
          " | " +
          (p.impactPer100kAtr !== null
            ? p.impactPer100kAtr.toFixed(5)
            : "n/a") +
          " | " +
          (p.zeroOrOppositeResponse ? "YES" : "no"),
      );
    });

    console.log(
      "\n--- " + r.label + " PHASE EVOLUTION (EARLY/MIDDLE/LATE) ---",
    );
    for (const [name, ph] of [
      ["EARLY", r.early],
      ["MIDDLE", r.middle],
      ["LATE", r.late],
    ] as const) {
      console.log(
        "  " +
          name +
          " (n=" +
          ph.n +
          "): medianImpact/$100k(ATR)=" +
          (ph.medianImpactPer100kAtr?.toFixed(5) ?? "n/a") +
          " medianGap=" +
          (ph.medianGapSeconds?.toFixed(1) ?? "n/a") +
          "s medianUSD=" +
          fmtUsd(ph.medianUsd ?? 0) +
          " freshExtreme%=" +
          fmtPct(ph.freshExtremePct) +
          " zeroOrOpposite%=" +
          fmtPct(ph.zeroOppositePct),
      );
    }

    console.log(
      "\n--- " +
        r.label +
        " DIVERGENCE POINTS (USD rising + intensity rising + downside impact weakening, all vs this burst's OWN running median-so-far) ---",
    );
    if (r.divergencePoints.length === 0) console.log("  none found");
    else
      r.divergencePoints.forEach((i) => {
        const p = r.pairs[i];
        console.log(
          "  event #" +
            i +
            " at " +
            fmtClock(p.eventTs) +
            ": USD=" +
            fmtUsd(p.eventUsd) +
            " USD/s-until-next=" +
            fmtUsd(p.usdPerSecondUntilNext) +
            " impact/$100k(ATR)=" +
            (p.impactPer100kAtr?.toFixed(5) ?? "n/a"),
        );
      });
  }

  console.log("\n" + "=".repeat(170));
  console.log("BURST SUMMARY COMPARISON");
  console.log("=".repeat(170));
  for (const r of results) {
    console.log("\n" + r.label + ":");
    console.log(
      "  duration: " +
        r.durationSeconds.toFixed(0) +
        "s (" +
        (r.durationSeconds / 60).toFixed(2) +
        "min)",
    );
    console.log("  event count: " + r.eventCount);
    console.log("  total liquidation: " + fmtUsd(r.totalUsd));
    console.log("  liquidation/minute: " + fmtUsd(r.usdPerMinute));
    console.log("  start ATR: " + (r.startAtr?.toFixed(4) ?? "n/a"));
    console.log("  end ATR: " + (r.endAtr?.toFixed(4) ?? "n/a"));
    console.log(
      "  ATR change: " +
        (r.atrChangeAbs?.toFixed(4) ?? "n/a") +
        " (" +
        fmtPct(r.atrChangePct, 2) +
        ")",
    );
    console.log(
      "  total directional movement (ATR): " + r.totalDirectionalAtr.toFixed(4),
    );
    console.log(
      "  directional efficiency per $1M: " +
        (r.directionalEfficiencyPer1M?.toFixed(4) ?? "n/a") +
        " ATR/$1M",
    );
    console.log("  fresh-extreme rate: " + fmtPct(r.freshExtremeRate));
    console.log("  zero/opposite-response rate: " + fmtPct(r.zeroOppositeRate));
    console.log(
      "  early efficiency (median impact/$100k ATR): " +
        (r.early.medianImpactPer100kAtr?.toFixed(5) ?? "n/a"),
    );
    console.log(
      "  middle efficiency: " +
        (r.middle.medianImpactPer100kAtr?.toFixed(5) ?? "n/a"),
    );
    console.log(
      "  late efficiency: " +
        (r.late.medianImpactPer100kAtr?.toFixed(5) ?? "n/a"),
    );
    console.log("  divergence points found: " + r.divergencePoints.length);
  }

  if (results.length === 2) {
    console.log("\n--- DIRECT A vs B DELTA ---");
    const [a, b] = results;
    console.log(
      "  ATR change % :  A=" +
        fmtPct(a.atrChangePct, 2) +
        "   B=" +
        fmtPct(b.atrChangePct, 2),
    );
    console.log(
      "  directional efficiency per $1M :  A=" +
        (a.directionalEfficiencyPer1M?.toFixed(4) ?? "n/a") +
        "   B=" +
        (b.directionalEfficiencyPer1M?.toFixed(4) ?? "n/a"),
    );
    console.log(
      "  fresh-extreme rate :  A=" +
        fmtPct(a.freshExtremeRate) +
        "   B=" +
        fmtPct(b.freshExtremeRate),
    );
    console.log(
      "  zero/opposite rate :  A=" +
        fmtPct(a.zeroOppositeRate) +
        "   B=" +
        fmtPct(b.zeroOppositeRate),
    );
    console.log(
      "  late-phase efficiency :  A=" +
        (a.late.medianImpactPer100kAtr?.toFixed(5) ?? "n/a") +
        "   B=" +
        (b.late.medianImpactPer100kAtr?.toFixed(5) ?? "n/a"),
    );
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "two-burst-causal-comparison-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        causalityNote:
          "No candle high/low used to describe price between two liquidation events anywhere in this file. ATR uses only fully-closed past candles.",
        results,
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
