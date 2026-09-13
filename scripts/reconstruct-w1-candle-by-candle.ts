/**
 * Sep 13 2026 (Karo), operator-requested. Candle-by-candle
 * reconstruction of a specific W1's own internal state-transitions,
 * using the REAL CandlePhysicsEngine class (never reimplemented).
 * Exposes phase-before/phase-after, newDirectionalExtensionUnits,
 * recoveryUnits, and the priorMedianRecovery the engine actually
 * compared against, for every closed candle in the requested window.
 *
 * READ-ONLY. No production code changed. No Mongo writes.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import { CandlePhysicsEngine } from "../src/domain/cascade/candle-physics-engine";

const symbol = process.argv[2];
const victim = process.argv[3] as "LONG" | "SHORT";
const startIso = process.argv[4]; // e.g. "2026-09-13T03:10:00Z"
const endIso = process.argv[5]; // e.g. "2026-09-13T03:25:00Z"
if (!symbol || !victim || !startIso || !endIso) {
  console.error(
    "Usage: npx tsx scripts/reconstruct-w1-candle-by-candle.ts SYMBOL LONG|SHORT startIso endIso",
  );
  process.exit(1);
}
const windowStart = Date.parse(startIso);
const windowEnd = Date.parse(endIso);

function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
async function fetchKlines(sym: string, s: number, e: number) {
  const m = new Map<
    number,
    { t: number; open: number; high: number; low: number; close: number }
  >();
  let cursor = s;
  while (cursor <= e) {
    const chunkEnd = Math.min(cursor + 1499 * 60000, e);
    const raw = await httpsGetJson(
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
        sym +
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

async function main() {
  const uri = process.env.MONGO_URI!;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const col = db.collection("liq_raw_events");

  const atrWarmupStart = windowStart - 5 * 3600000;
  const klines = await fetchKlines(symbol, atrWarmupStart, windowEnd + 60000);
  const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
  function simpleAtr240(uptoMs: number): number | null {
    const before = candlesAsc.filter((c) => c.t < uptoMs);
    if (before.length < 241) return null;
    const w = before.slice(-241);
    let sum = 0;
    for (let i = 1; i < w.length; i++)
      sum += Math.max(
        w[i].high - w[i].low,
        Math.abs(w[i].high - w[i - 1].close),
        Math.abs(w[i].low - w[i - 1].close),
      );
    return sum / (w.length - 1);
  }

  // Feed liquidations from a generous lead-in so the engine's own watch is already open (or opens naturally) by windowStart.
  const feedStart = windowStart - 20 * 60000;
  const events = await col
    .find({ symbol, victim, timestamp: { $gte: feedStart, $lte: windowEnd } })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(
    symbol +
      " " +
      victim +
      "  " +
      events.length +
      " raw liquidation events in feed window (" +
      new Date(feedStart).toISOString() +
      " to " +
      new Date(windowEnd).toISOString() +
      ")\n",
  );

  // rolling 24h P95 proxy, same disclosed approximation as the prior audit script
  const p95Sample = await col
    .find({
      symbol,
      victim,
      timestamp: { $gte: windowStart - 24 * 3600000, $lt: windowStart },
    })
    .toArray();
  function rollingP95(atMs: number) {
    const sample = p95Sample
      .filter((e) => e.timestamp < atMs)
      .map((e) => e.quoteQty)
      .sort((a, b) => a - b);
    if (sample.length < 30) return null;
    const idx = 0.95 * (sample.length - 1);
    const lo = Math.floor(idx),
      hi = Math.ceil(idx);
    return lo === hi
      ? sample[lo]
      : sample[lo] + (sample[hi] - sample[lo]) * (idx - lo);
  }

  const engine = new CandlePhysicsEngine();
  const relevantCandles = candlesAsc.filter(
    (c) => c.t >= feedStart && c.t <= windowEnd,
  );
  let eventIdx = 0;

  console.log(
    "timestamp | O | H | L | C | phaseBefore | extremeBefore | newExtUnits | recoveryUnits | priorMedianRecovery | phaseAfter | note",
  );
  for (const candle of relevantCandles) {
    while (eventIdx < events.length && events[eventIdx].timestamp < candle.t) {
      const e = events[eventIdx];
      const unit = simpleAtr240(e.timestamp);
      if (unit && unit > 0)
        engine.onLiquidation(
          symbol,
          victim,
          {
            symbol,
            side: victim === "LONG" ? "SELL" : "BUY",
            price: e.price,
            quantity: e.quoteQty / e.price,
            quoteQty: e.quoteQty,
            timestamp: e.timestamp,
          },
          unit,
          e.price,
          e.timestamp,
        );
      eventIdx++;
    }
    const wBefore = engine.peekWatch(symbol, victim);
    const phaseBefore = wBefore?.state ?? "NO_WATCH";
    const extremeBefore = wBefore?.episodeExtreme ?? null;
    const priorCandles = wBefore ? [...wBefore.currentWaveCandles] : [];
    const priorMedianRecovery = priorCandles.length
      ? median(priorCandles.map((c) => c.recoveryUnits))
      : null;

    const p95 = rollingP95(candle.t);
    const result = engine.onClosedCandle(
      symbol,
      victim,
      candle.t,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      p95,
    );
    const wAfter = engine.peekWatch(symbol, victim);
    const phaseAfter = wAfter?.state ?? "NO_WATCH";

    if (candle.t < windowStart) continue; // lead-in only, don't print

    const lastMetric =
      wAfter?.currentWaveCandles[wAfter.currentWaveCandles.length - 1];
    const note =
      result?.kind === "ENTRY"
        ? "ENTRY!"
        : result?.kind === "CANCEL"
          ? "CANCEL:" + result.reason
          : result?.kind === "PRE_W1_DISCARD"
            ? "PRE_W1_DISCARD:" + result.reason
            : "";
    console.log(
      new Date(candle.t).toISOString().slice(11, 19) +
        " | " +
        candle.open +
        " | " +
        candle.high +
        " | " +
        candle.low +
        " | " +
        candle.close +
        " | " +
        phaseBefore +
        " | " +
        (extremeBefore !== null ? extremeBefore.toFixed(4) : "n/a") +
        " | " +
        (lastMetric
          ? lastMetric.newDirectionalExtensionUnits.toFixed(3)
          : "n/a") +
        " | " +
        (lastMetric ? lastMetric.recoveryUnits.toFixed(3) : "n/a") +
        " | " +
        (priorMedianRecovery !== null
          ? priorMedianRecovery.toFixed(3)
          : "n/a") +
        " | " +
        phaseAfter +
        " | " +
        note,
    );
  }

  await client.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
