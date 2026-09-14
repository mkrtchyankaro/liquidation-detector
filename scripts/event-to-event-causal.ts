/**
 * Sep 14 2026 (Karo), operator-requested CAUSALITY FIX. Rebuild of
 * event-to-event-cascade-physics.ts with every candle-based intra-
 * interval measurement removed. True sub-minute historical price data
 * does not exist anywhere in this system (bookTicker/aggTrade are
 * in-memory only, never persisted -- confirmed repeatedly across this
 * project's own research); the finest historical resolution available
 * is the 1-minute candle. A liquidation event's own timestamp almost
 * never aligns with a candle boundary, so using that candle's full
 * high/low to describe "what happened between event N and event N+1"
 * silently pulls in price action from BEFORE event N (the earlier
 * part of that same candle's minute) and/or AFTER event N+1 (the
 * later part of the next candle's minute) -- genuine look-ahead and
 * look-behind contamination, not an edge case.
 *
 * This script keeps ONLY what is actually knowable without fabricating
 * an intra-minute price path:
 *   - the two real liquidation event timestamps/prices/USD amounts
 *   - the gap between them (pure arithmetic on real timestamps)
 *   - net price change / velocity (pure arithmetic on the two real
 *     event prices -- no candle involved at any point)
 *   - a per-event frozen ATR, using only the LAST FULLY CLOSED candle
 *     strictly before that event's own minute (a completed, past
 *     candle carries no look-ahead risk -- this is different in kind
 *     from using a candle to describe price action inside a still-
 *     open interval)
 *   - whether event N+1's own price set a new running extreme, judged
 *     ONLY against prior events' own real prices, never a candle low
 *
 * Deliberately NOT computed here (see the accompanying explanation):
 * downside extension, recovery, "recovered before next liquidation" --
 * none of these are answerable without sub-minute price-path data,
 * which does not exist.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No Wave 1/Wave 2 rule, no classifier.
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
  eventNTs: number;
  eventNIso: string;
  eventNPrice: number;
  eventNUsd: number;
  eventN1Ts: number;
  eventN1Iso: string;
  eventN1Price: number;
  eventN1Usd: number;
  gapSeconds: number;
  netPriceChange: number;
  netPriceChangePct: number;
  velocityUsdPerSec: number;
  velocityPctPerSec: number;
  atrFrozenAtEventN: number | null;
  atrSourceCandleTs: number | null;
  netPriceChangeInAtr: number | null;
  freshRunningExtremeByEventPriceOnly: boolean;
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
  function atrAt(ms: number): {
    value: number | null;
    sourceCandleTs: number | null;
  } {
    let t = Math.floor(ms / 60000) * 60000 - 60000;
    for (let i = 0; i < 400; i++) {
      if (atrSeries.has(t))
        return { value: atrSeries.get(t)!, sourceCandleTs: t };
      t -= 60000;
    }
    return { value: null, sourceCandleTs: null };
  }

  const pairs: CausalPair[] = [];
  let runningExtreme = events[0].price;
  for (let i = 0; i < events.length - 1; i++) {
    const eN = events[i],
      eN1 = events[i + 1];
    const gapSeconds = (eN1.timestamp - eN.timestamp) / 1000;
    const netPriceChange = eN1.price - eN.price;
    const netPriceChangePct = (netPriceChange / eN.price) * 100;
    const velocityUsdPerSec = gapSeconds > 0 ? netPriceChange / gapSeconds : 0;
    const velocityPctPerSec =
      gapSeconds > 0 ? netPriceChangePct / gapSeconds : 0;

    const atr = atrAt(eN.timestamp);
    const netPriceChangeInAtr =
      atr.value && atr.value > 0 ? netPriceChange / atr.value : null;

    const freshRunningExtremeByEventPriceOnly = eN1.price < runningExtreme;
    if (eN1.price < runningExtreme) runningExtreme = eN1.price;

    pairs.push({
      idx: i,
      eventNTs: eN.timestamp,
      eventNIso: new Date(eN.timestamp).toISOString(),
      eventNPrice: eN.price,
      eventNUsd: eN.quoteQty,
      eventN1Ts: eN1.timestamp,
      eventN1Iso: new Date(eN1.timestamp).toISOString(),
      eventN1Price: eN1.price,
      eventN1Usd: eN1.quoteQty,
      gapSeconds,
      netPriceChange,
      netPriceChangePct,
      velocityUsdPerSec,
      velocityPctPerSec,
      atrFrozenAtEventN: atr.value,
      atrSourceCandleTs: atr.sourceCandleTs,
      netPriceChangeInAtr,
      freshRunningExtremeByEventPriceOnly,
    });
  }

  console.log("=".repeat(150));
  console.log(
    "STRICTLY CAUSAL EVENT-TO-EVENT TABLE (n=" +
      pairs.length +
      " pairs, " +
      events.length +
      " raw events)",
  );
  console.log(
    "No intra-interval candle high/low used anywhere below -- every field is either a raw event fact,",
  );
  console.log(
    "pure arithmetic on two real event prices, or ATR from a fully-closed PAST candle.",
  );
  console.log("=".repeat(150));
  console.log(
    "# | N_time | N_price | N_USD | N+1_time | N+1_price | N+1_USD | gap(s) | netChg$ | netChg% | vel$/s | ATR@N (src candle) | netChgATR | freshExtreme(eventPriceOnly)",
  );
  pairs.forEach((p) => {
    console.log(
      p.idx +
        " | " +
        fmtClock(p.eventNTs) +
        " | " +
        p.eventNPrice.toFixed(1) +
        " | " +
        fmtUsd(p.eventNUsd) +
        " | " +
        fmtClock(p.eventN1Ts) +
        " | " +
        p.eventN1Price.toFixed(1) +
        " | " +
        fmtUsd(p.eventN1Usd) +
        " | " +
        p.gapSeconds.toFixed(0) +
        " | " +
        p.netPriceChange.toFixed(1) +
        " | " +
        p.netPriceChangePct.toFixed(4) +
        "% | " +
        p.velocityUsdPerSec.toFixed(2) +
        " | " +
        (p.atrFrozenAtEventN?.toFixed(4) ?? "n/a") +
        " (" +
        (p.atrSourceCandleTs ? fmtClock(p.atrSourceCandleTs) : "n/a") +
        ") | " +
        (p.netPriceChangeInAtr !== null
          ? p.netPriceChangeInAtr.toFixed(4)
          : "n/a") +
        " | " +
        (p.freshRunningExtremeByEventPriceOnly ? "YES" : "no"),
    );
  });

  console.log("\n" + "=".repeat(150));
  console.log(
    "FIELDS DELIBERATELY OMITTED FROM THIS REBUILD (not answerable without sub-minute price data):",
  );
  console.log("=".repeat(150));
  console.log(
    "  - downside extension between event N and N+1 (needs intra-interval price path)",
  );
  console.log(
    "  - recovery between event N and N+1 (needs intra-interval price path)",
  );
  console.log(
    "  - whether price recovered before the next liquidation arrived (needs intra-interval price path)",
  );
  console.log(
    "  These require true sub-minute historical price data, which does not exist in this system.",
  );

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "event-to-event-causal-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        symbol: SYMBOL,
        victim: VICTIM,
        windowStart,
        windowEnd,
        rawEventCount: events.length,
        causalityNote:
          "No field below uses any candle's high/low to describe price action inside an event-to-event interval. atrFrozenAtEventN uses only the last FULLY CLOSED candle strictly before that event's own minute. Sub-minute historical price data does not exist in this system -- downside extension, recovery, and intra-interval recovery-before-next-liquidation are NOT computable and are omitted rather than approximated from 1-minute candle data.",
        pairs,
      },
      null,
      2,
    ),
  );
  console.log("\n\nFull causal dataset: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
