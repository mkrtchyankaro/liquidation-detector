/**
 * CANDLE MAP EXPORT (Johnny, Sep 30 2026). Read-only: DB (minute_bars, liq_raw_events) + Binance klines. No trading.
 * Writes one CSV with, for every coin, every 1h candle followed by its four 15m candles (all times UTC):
 * price (OHLC, wicks, when the high/low happened, volume, taker buy %), liquidations LONG/SHORT in coin and USD,
 * and open interest described as a candle (open/high/low/close, opened/closed on the way, biggest swings, order).
 * Column meanings: src/research/candle-map.ts.
 *
 *   npx tsx src/tools/candle-map.ts                     (configured coins, last 7 days -> data/candle-map-<date>.csv)
 *   npx tsx src/tools/candle-map.ts --days 5 --symbols SUI,ETH
 */
import "dotenv/config";
import * as fs from "fs";
import * as zlib from "zlib";
import axios from "axios";
import { MongoClient } from "mongodb";
import {
  buildCandles,
  CSV_COLUMNS,
  toCsvLine,
  type Kline,
  type LiqEvent,
  type MinuteBar,
} from "../research/candle-map";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAYS = Math.min(14, Number(arg("days", "7"))),
  H = 3_600_000,
  DAY = 24 * H;
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const time = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? null
    : Number(v);

function symbols(): string[] {
  const s = arg("symbols", "");
  if (s)
    return s
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
      .map((x) => (x.endsWith("USDT") ? x : `${x}USDT`));
  try {
    const cfg = JSON.parse(
      fs.readFileSync(process.env.USERS_CONFIG ?? "users.config.json", "utf8"),
    ) as { v9?: { symbols?: string[] } };
    if (cfg.v9?.symbols?.length) return cfg.v9.symbols;
  } catch {
    /* next */
  }
  if (process.env.SYMBOLS)
    return process.env.SYMBOLS.split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
  return [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "LINKUSDT",
    "AVAXUSDT",
    "SUIUSDT",
  ];
}

async function klines(
  symbol: string,
  interval: "1h" | "15m",
  from: number,
  to: number,
): Promise<Kline[]> {
  const tfMs = interval === "1h" ? H : 15 * 60_000,
    out: Kline[] = [];
  for (let start = from, guard = 0; guard < 20 && start < to; guard++) {
    const res = await http.get<Array<Array<string | number>>>(
      "/fapi/v1/klines",
      {
        params: {
          symbol,
          interval,
          startTime: start,
          endTime: to,
          limit: 1500,
        },
      },
    );
    if (!res.data.length) break;
    for (const k of res.data)
      out.push({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volCoin: Number(k[5]),
        volUsd: Number(k[7]),
        takerBuyCoin: Number(k[9]),
      });
    const next = Number(res.data[res.data.length - 1][0]) + 1;
    if (next <= start) break;
    start = next;
  }
  const now = Date.now(),
    seen = new Set<number>();
  return out.filter(
    (k) =>
      k.openTime + tfMs <= now &&
      k.openTime >= from &&
      !seen.has(k.openTime) &&
      seen.add(k.openTime),
  ); // closed candles only
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const to = Math.floor(Date.now() / H) * H,
    from = to - DAYS * DAY;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const lines: string[] = [CSV_COLUMNS.join(",")];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const symbol of symbols()) {
      const minutes: MinuteBar[] = (
        await db
          .collection("minute_bars")
          .find({ symbol, ts: { $gte: new Date(from), $lt: new Date(to) } })
          .project({
            ts: 1,
            high: 1,
            low: 1,
            close: 1,
            oiFirst: 1,
            oiLast: 1,
            oiMin: 1,
            oiMax: 1,
          })
          .sort({ ts: 1 })
          .toArray()
      ).map((m) => ({
        ts: time(m.ts),
        high: numOrNull(m.high),
        low: numOrNull(m.low),
        close: numOrNull(m.close),
        oiFirst: numOrNull(m.oiFirst),
        oiLast: numOrNull(m.oiLast),
        oiMin: numOrNull(m.oiMin),
        oiMax: numOrNull(m.oiMax),
      }));
      const liq: LiqEvent[] = (
        await db
          .collection("liq_raw_events")
          .find({
            symbol,
            victim: { $in: ["LONG", "SHORT"] },
            timestamp: { $gte: from, $lt: to },
          })
          .project({ timestamp: 1, victim: 1, price: 1, quoteQty: 1 })
          .toArray()
      ).map((e) => ({
        ts: time(e.timestamp),
        victim: e.victim === "LONG" ? ("LONG" as const) : ("SHORT" as const),
        price: Number(e.price),
        usd: Number(e.quoteQty),
      }));
      const [k1h, k15] = [
        await klines(symbol, "1h", from, to),
        await klines(symbol, "15m", from, to),
      ];
      const rows1h = buildCandles(symbol, "1h", k1h, minutes, liq),
        rows15 = buildCandles(symbol, "15m", k15, minutes, liq);
      const byHour = new Map<number, typeof rows15>();
      for (const r of rows15)
        byHour.set(r.hour, [...(byHour.get(r.hour) ?? []), r]);
      for (const r of rows1h) {
        lines.push(toCsvLine(r));
        for (const q of byHour.get(r.openTime) ?? []) lines.push(toCsvLine(q));
      }
      const withOi = rows1h.filter((r) => r.minutesWithOi >= 50).length;
      process.stderr.write(
        `${symbol}: ${rows1h.length} 1h + ${rows15.length} 15m candles, ${minutes.length} minutes of our data, ${liq.length} liquidations; hours with full OI data ${withOi}/${rows1h.length}\n`,
      );
    }
  } finally {
    await client.close();
  }
  fs.mkdirSync("data", { recursive: true });
  const file = `data/candle-map-${new Date(to).toISOString().slice(0, 13).replace("T", "_")}UTC.csv`;
  fs.writeFileSync(file, lines.join("\n") + "\n");
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file)));
  process.stderr.write(
    `\n${lines.length - 1} rows -> ${file}  (and ${file}.gz, ${(fs.statSync(`${file}.gz`).size / 1024).toFixed(0)} KB)\n`,
  );
  process.stderr.write(
    `period ${new Date(from).toISOString().slice(0, 16)} -> ${new Date(to).toISOString().slice(0, 16)} UTC (closed candles only)\n`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
