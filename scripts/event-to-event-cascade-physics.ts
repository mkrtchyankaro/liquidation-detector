/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, pure event-to-
 * event research for ONE specific case: BTCUSDT LONG-victim raw
 * liquidation events, 2026-09-10 16:00-16:45 UTC. Analysis unit is
 * EVENT-TO-EVENT, deliberately NOT minute buckets, NOT episode/run
 * grouping. No W1/W2 rule, no classifier, no filtering of small
 * events -- every raw event in the window is kept and measured.
 *
 * CAUSALITY: ATR(240) is frozen once at the FIRST event in the window
 * (using only candles strictly before that first event), then reused
 * unchanged for every subsequent pair's ATR-denominated measurements --
 * this is a single, fixed local regime reference for this one cascade,
 * not re-frozen per pair (re-freezing per pair would let the cascade's
 * OWN volatility contaminate its own measurement). Candle data used to
 * measure price BETWEEN two liquidation events is real, closed 1m
 * candle data spanning that gap -- the finest resolution actually
 * available; sub-minute intra-candle precision is not claimed.
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
const WINDOW_START_ISO = "2026-09-10T16:00:00.000Z";
const WINDOW_END_ISO = "2026-09-10T16:45:00.000Z";
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const ATR_PERIOD = 240;

function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(11, 19);
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
interface EventPair {
  idx: number;
  eventNTs: number;
  eventNUsd: number;
  eventNPrice: number;
  eventN1Ts: number;
  eventN1Usd: number;
  eventN1Price: number;
  gapSeconds: number;
  downsideExtremePrice: number;
  downsideExtensionUsd: number;
  downsideExtensionAtr: number;
  recoveryExtremePrice: number;
  recoveryUsd: number;
  recoveryAtr: number;
  netPriceChange: number;
  netPriceChangePct: number;
  velocityUsdPerSec: number;
  velocityPctPerSec: number;
  freshDirectionalExtreme: boolean;
  recoveredBeforeNext: boolean;
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

  const windowStart = Date.parse(WINDOW_START_ISO);
  const windowEnd = Date.parse(WINDOW_END_ISO);

  const events = (await col
    .find({
      symbol: SYMBOL,
      victim: VICTIM,
      timestamp: { $gte: windowStart, $lte: windowEnd },
    })
    .sort({ timestamp: 1 })
    .toArray()) as unknown as RawEvent[];
  console.log(
    SYMBOL +
      " " +
      VICTIM +
      " raw liquidation events, " +
      WINDOW_START_ISO +
      " to " +
      WINDOW_END_ISO +
      ": n=" +
      events.length +
      "\n",
  );
  if (events.length < 2) {
    console.error("fewer than 2 events -- nothing to pair.");
    process.exit(1);
  }

  const klines = await fetchKlines(
    SYMBOL,
    windowStart - 6 * 3600000,
    windowEnd + 60000,
  );
  const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
  const atrSeries = computeWilderAtrSeries(candlesAsc, ATR_PERIOD);
  function candleAt(ms: number) {
    return klines.get(Math.floor(ms / 60000) * 60000) || null;
  }
  function atrAt(ms: number): number | null {
    let t = Math.floor(ms / 60000) * 60000 - 60000;
    for (let i = 0; i < 400; i++) {
      if (atrSeries.has(t)) return atrSeries.get(t)!;
      t -= 60000;
    }
    return null;
  }

  const atrFrozen = atrAt(events[0].timestamp);
  if (atrFrozen === null || atrFrozen <= 0) {
    console.error(
      "could not compute a valid frozen ATR -- insufficient candle history.",
    );
    process.exit(1);
  }
  console.log(
    "ATR(240) frozen at first event (" +
      new Date(events[0].timestamp).toISOString() +
      "): " +
      atrFrozen.toFixed(4) +
      "\n",
  );

  const pairs: EventPair[] = [];
  let runningDirectionalExtreme = events[0].price;
  for (let i = 0; i < events.length - 1; i++) {
    const eN = events[i],
      eN1 = events[i + 1];
    const gapSeconds = (eN1.timestamp - eN.timestamp) / 1000;

    const gapStartMinute = Math.floor(eN.timestamp / 60000) * 60000;
    const gapEndMinute = Math.floor(eN1.timestamp / 60000) * 60000;
    let downsideExtremePrice = eN.price;
    let downsideExtremeTs = eN.timestamp;
    for (let t = gapStartMinute; t <= gapEndMinute; t += 60000) {
      const c = candleAt(t);
      if (!c) continue;
      if (c.low < downsideExtremePrice) {
        downsideExtremePrice = c.low;
        downsideExtremeTs = t;
      }
    }
    let recoveryExtremePrice = downsideExtremePrice;
    for (let t = downsideExtremeTs; t <= gapEndMinute; t += 60000) {
      const c = candleAt(t);
      if (!c) continue;
      if (c.high > recoveryExtremePrice) recoveryExtremePrice = c.high;
    }

    const downsideExtensionUsd = Math.max(0, eN.price - downsideExtremePrice);
    const downsideExtensionAtr = downsideExtensionUsd / atrFrozen;
    const recoveryUsd = Math.max(
      0,
      recoveryExtremePrice - downsideExtremePrice,
    );
    const recoveryAtr = recoveryUsd / atrFrozen;
    const netPriceChange = eN1.price - eN.price;
    const netPriceChangePct = (netPriceChange / eN.price) * 100;
    const velocityUsdPerSec = gapSeconds > 0 ? netPriceChange / gapSeconds : 0;
    const velocityPctPerSec =
      gapSeconds > 0 ? netPriceChangePct / gapSeconds : 0;

    const freshDirectionalExtreme =
      downsideExtremePrice < runningDirectionalExtreme ||
      eN1.price < runningDirectionalExtreme;
    if (downsideExtremePrice < runningDirectionalExtreme)
      runningDirectionalExtreme = downsideExtremePrice;
    if (eN1.price < runningDirectionalExtreme)
      runningDirectionalExtreme = eN1.price;

    const recoveredBeforeNext = recoveryExtremePrice >= eN.price;

    pairs.push({
      idx: i,
      eventNTs: eN.timestamp,
      eventNUsd: eN.quoteQty,
      eventNPrice: eN.price,
      eventN1Ts: eN1.timestamp,
      eventN1Usd: eN1.quoteQty,
      eventN1Price: eN1.price,
      gapSeconds,
      downsideExtremePrice,
      downsideExtensionUsd,
      downsideExtensionAtr,
      recoveryExtremePrice,
      recoveryUsd,
      recoveryAtr,
      netPriceChange,
      netPriceChangePct,
      velocityUsdPerSec,
      velocityPctPerSec,
      freshDirectionalExtreme,
      recoveredBeforeNext,
    });
  }

  console.log("=".repeat(160));
  console.log(
    "A. EVENT-TO-EVENT TABLE (n=" +
      pairs.length +
      " pairs, " +
      events.length +
      " raw events)",
  );
  console.log("=".repeat(160));
  console.log(
    "# | N_time | N_USD | N_price | N+1_time | N+1_USD | N+1_price | gap(s) | downExt$ | downExtATR | recov$ | recovATR | netChg | netChg% | vel$/s | freshExt | recovered?",
  );
  pairs.forEach((p) => {
    console.log(
      p.idx +
        " | " +
        fmtClock(p.eventNTs) +
        " | " +
        fmtUsd(p.eventNUsd) +
        " | " +
        p.eventNPrice.toFixed(1) +
        " | " +
        fmtClock(p.eventN1Ts) +
        " | " +
        fmtUsd(p.eventN1Usd) +
        " | " +
        p.eventN1Price.toFixed(1) +
        " | " +
        p.gapSeconds.toFixed(0) +
        " | " +
        p.downsideExtensionUsd.toFixed(1) +
        " | " +
        p.downsideExtensionAtr.toFixed(3) +
        " | " +
        p.recoveryUsd.toFixed(1) +
        " | " +
        p.recoveryAtr.toFixed(3) +
        " | " +
        p.netPriceChange.toFixed(1) +
        " | " +
        p.netPriceChangePct.toFixed(4) +
        "% | " +
        p.velocityUsdPerSec.toFixed(2) +
        " | " +
        (p.freshDirectionalExtreme ? "YES" : "no") +
        " | " +
        (p.recoveredBeforeNext ? "YES" : "no"),
    );
  });

  interface Section {
    label: string;
    startIso: string;
    endIso: string;
  }
  const sections: Section[] = [
    {
      label: "16:05-16:10",
      startIso: "2026-09-10T16:05:00.000Z",
      endIso: "2026-09-10T16:10:00.000Z",
    },
    {
      label: "16:17-16:19",
      startIso: "2026-09-10T16:17:00.000Z",
      endIso: "2026-09-10T16:19:00.000Z",
    },
    {
      label: "16:30",
      startIso: "2026-09-10T16:30:00.000Z",
      endIso: "2026-09-10T16:31:00.000Z",
    },
    {
      label: "16:34-16:35",
      startIso: "2026-09-10T16:34:00.000Z",
      endIso: "2026-09-10T16:35:00.000Z",
    },
  ];
  console.log("\n" + "=".repeat(160));
  console.log("B. CASCADE-SECTION SUMMARY");
  console.log("=".repeat(160));
  for (const section of sections) {
    const secStart = Date.parse(section.startIso),
      secEnd = Date.parse(section.endIso);
    const inSection = pairs.filter(
      (p) => p.eventNTs >= secStart && p.eventNTs <= secEnd,
    );
    console.log(
      "\n--- " + section.label + " (n=" + inSection.length + " pairs) ---",
    );
    if (inSection.length === 0) {
      console.log("  (no event pairs starting in this window)");
      continue;
    }
    console.log(
      "  median gap(s): " +
        median(inSection.map((p) => p.gapSeconds))?.toFixed(1),
    );
    console.log(
      "  median event USD (N): " +
        fmtUsd(median(inSection.map((p) => p.eventNUsd)) ?? 0),
    );
    console.log(
      "  median downside extension ATR: " +
        median(inSection.map((p) => p.downsideExtensionAtr))?.toFixed(4),
    );
    console.log(
      "  median recovery ATR: " +
        median(inSection.map((p) => p.recoveryAtr))?.toFixed(4),
    );
    console.log(
      "  % pairs with fresh directional extreme: " +
        (
          (inSection.filter((p) => p.freshDirectionalExtreme).length /
            inSection.length) *
          100
        ).toFixed(1) +
        "%",
    );
    console.log(
      "  % pairs recovered before next liquidation: " +
        (
          (inSection.filter((p) => p.recoveredBeforeNext).length /
            inSection.length) *
          100
        ).toFixed(1) +
        "%",
    );
    console.log(
      "  median velocity ($/s): " +
        median(inSection.map((p) => p.velocityUsdPerSec))?.toFixed(3),
    );
    console.log(
      "  downside-extension-ATR per $1k event USD, efficiency (median): " +
        median(
          inSection.map((p) => p.downsideExtensionAtr / (p.eventNUsd / 1000)),
        )?.toFixed(5),
    );
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "event-to-event-cascade-physics-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        symbol: SYMBOL,
        victim: VICTIM,
        windowStart,
        windowEnd,
        atrFrozen,
        rawEventCount: events.length,
        pairs,
        sections,
      },
      null,
      2,
    ),
  );
  console.log("\n\nFull data (every pair, every field): " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
