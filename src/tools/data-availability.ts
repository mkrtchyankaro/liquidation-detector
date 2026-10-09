/**
 * DATA AVAILABILITY AUDIT (Johnny, Oct 9 2026). READ-ONLY: it only READS our MongoDB (find / aggregate / count) and
 * writes one text file under reports/; it changes nothing in the DB, the collector or the bot. No Binance calls.
 * Oct 9: no server-side sort any more (it hit MongoDB's 32 MB sort limit): min/max by $group, then one day at a time.
 * For one coin it walks EVERY collection in the DB that holds documents of that coin and prints:
 *   first / last time, rows, the typical spacing (median gap) and the biggest gaps, the fields of one document,
 *   and what the price in it really is (from the collector code, see PRICE_NOTE).
 *
 *   npx tsx src/tools/data-availability.ts --symbol XRPUSDT
 *   option: --gaps 10 (how many of the biggest gaps to list)
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { MongoClient, type Document } from "mongodb";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const iso = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const dur = (ms: number): string =>
  ms >= 86_400_000
    ? `${(ms / 86_400_000).toFixed(1)} d`
    : ms >= 3_600_000
      ? `${(ms / 3_600_000).toFixed(1)} h`
      : ms >= 60_000
        ? `${(ms / 60_000).toFixed(1)} min`
        : `${(ms / 1000).toFixed(1)} s`;
const TIME_FIELDS = [
  "ts",
  "timestamp",
  "candleEnd",
  "t",
  "eventTime",
  "time",
  "createdAt",
  "hourStart",
];
/** what the price fields are, from the collector code (src/collector/market-collector.ts, minute-bars.ts, context-collector.ts, v10-book.ts) */
const PRICE_NOTE: Record<string, string> = {
  minute_bars:
    "open/high/low/close = the futures BOOK MID ((bid+ask)/2 from the bookTicker stream) sampled at each ~1/s OI poll -- not traded price, not mark price; high/low miss wicks between samples. OI = Binance openInterest in COINS. Liquidations $ and counts per side.",
  oi_second_observations:
    "one row per OI poll (~1/s): openInterest (coins), Binance's OI update time, price = book mid at the poll. TTL 14 days.",
  liq_raw_events:
    "every forceOrder event Binance streamed (at most ~1 per second per coin, so the feed is INCOMPLETE): side (victim), price, quantity, $.",
  market_positioning_5m:
    "Binance long/short ACCOUNT ratios per 5m (global, top accounts, top positions) -- no price.",
  market_premium_1m:
    "every minute: MARK price, INDEX price, premium %, funding rate.",
  v10_book:
    "order book snapshot at every 15m close (REST depth, limit 1000): $ of bids/asks within 1% and 2% of the mid, the 3 biggest 0.1% slices per side within 3%. TTL 90 days.",
};

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "XRPUSDT").toUpperCase(),
    nGaps = Number(arg("gaps", "10"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const lines: string[] = [];
  const say = (s: string): void => {
    console.log(s);
    lines.push(s);
  };
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    say(
      `═══ DATA AVAILABILITY · ${sym} · db ${db.databaseName} · run ${iso(Date.now())} UTC ═══`,
    );
    const cols = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .sort();
    const without: string[] = [];
    for (const name of cols) {
      const col = db.collection(name);
      const one = await col.findOne({ symbol: sym });
      if (!one) {
        without.push(name);
        continue;
      }
      const tf = TIME_FIELDS.find(
        (f) => one[f] instanceof Date || typeof one[f] === "number",
      );
      say(`\n── ${name} ──`);
      say(
        `  fields: ${Object.keys(one)
          .filter((k) => k !== "_id")
          .join(", ")}`,
      );
      if (PRICE_NOTE[name]) say(`  what it is: ${PRICE_NOTE[name]}`);
      if (!tf) {
        say(
          `  rows: ${await col.countDocuments({ symbol: sym })} · no time field found`,
        );
        continue;
      }
      const toMs = (v: unknown): number =>
        v instanceof Date ? v.getTime() : Number(v);
      // first / last without sorting (a $group needs almost no memory), then the times read ONE DAY AT A TIME by a range
      // query and sorted in this process -- no server-side sort, so no memory limit on the DB (the first version hit
      // MongoDB's 32 MB sort limit on oi_second_observations)
      const mm = (
        await col
          .aggregate<Document>([
            { $match: { symbol: sym } },
            {
              $group: {
                _id: null,
                a: { $min: `$${tf}` },
                b: { $max: `$${tf}` },
              },
            },
          ])
          .toArray()
      )[0];
      const isDate = one[tf] instanceof Date;
      const lo = toMs(mm?.a),
        hi = toMs(mm?.b);
      let n = 0,
        first = NaN,
        prev = NaN;
      const gaps: number[] = [];
      const big: { a: number; g: number }[] = [];
      for (
        let d0 = Math.floor(lo / 86_400_000) * 86_400_000;
        d0 <= hi;
        d0 += 86_400_000
      ) {
        const range = isDate
          ? { $gte: new Date(d0), $lt: new Date(d0 + 86_400_000) }
          : { $gte: d0, $lt: d0 + 86_400_000 };
        const ts: number[] = [];
        for await (const d of col.find(
          { symbol: sym, [tf]: range },
          { projection: { _id: 0, [tf]: 1 } },
        )) {
          const t = toMs(d[tf]);
          if (Number.isFinite(t)) ts.push(t);
        }
        ts.sort((x, y) => x - y);
        for (const t of ts) {
          if (n === 0) first = t;
          else {
            const g = t - prev;
            if (gaps.length < 200_000) gaps.push(g);
            if (big.length < nGaps || g > big[big.length - 1].g) {
              big.push({ a: prev, g });
              big.sort((x, y) => y.g - x.g);
              if (big.length > nGaps) big.pop();
            }
          }
          prev = t;
          n++;
        }
      }
      gaps.sort((x, y) => x - y);
      const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : NaN;
      say(
        `  time field: ${tf} · rows ${n} · ${iso(first)} → ${iso(prev)} UTC (${dur(prev - first)})`,
      );
      if (gaps.length)
        say(
          `  spacing: median ${dur(med)} · p90 ${dur(gaps[Math.floor(gaps.length * 0.9)])}`,
        );
      const real = big.filter((b) => b.g > Math.max(3 * med, 120_000));
      if (real.length) {
        say(`  biggest gaps (> 3x the median):`);
        for (const b of real) say(`    ${iso(b.a)} UTC · ${dur(b.g)}`);
      } else say(`  no gap above 3x the median spacing`);
      if (name === "liq_raw_events") {
        const bySide = await col
          .aggregate<Document>([
            { $match: { symbol: sym } },
            {
              $group: {
                _id: "$victim",
                n: { $sum: 1 },
                usd: { $sum: "$quoteQty" },
              },
            },
          ])
          .toArray();
        say(
          `  by side: ${bySide.map((s) => `${s._id} ${s.n} events $${Math.round(s.usd).toLocaleString("en-US")}`).join(" · ")}`,
        );
      }
    }
    say(
      `\n── collections with NO ${sym} documents ──\n  ${without.join(", ") || "(none)"}`,
    );
    say(`\n── not in the DB at all (by design of the collector) ──`);
    say(
      `  4H / 1D candles, traded-price OHLCV, taker buy/sell volume: not stored -- they come from Binance klines on demand (taker buy volume is inside each kline).`,
    );
    say(
      `  aggTrades (every trade) and depth-stream order-book updates: not collected (aggTrade:false, depth:false in market-collector.ts).`,
    );
    const out = path.join("reports", `data-availability-${sym}.txt`);
    fs.mkdirSync("reports", { recursive: true });
    fs.writeFileSync(out, lines.join("\n") + "\n");
    console.log(`\nfile: ${out}`);
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
