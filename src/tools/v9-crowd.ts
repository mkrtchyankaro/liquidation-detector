/**
 * V9 REAL SIGNALS vs CROWD STOP POOLS (Johnny, Sep 29 2026). Read-only.
 * Every real V9 trade of a user (default "main" = every V9 signal): did its cleaning sweep a crowd stop pool
 * (previous day high/low, swing, equal highs/lows, candle pattern, round number)? Swept vs not swept results.
 * Everything in UTC ms: trades / decisions from our DB, candles from Binance (1h for the pools, 1m for the
 * cleaning's extreme). Only candles finished before the episode started build the pools.
 *
 *   npx tsx src/tools/v9-crowd.ts                    (user main, all its trades)
 *   npx tsx src/tools/v9-crowd.ts --user main --days 7
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { SOURCES, type Candle } from "../research/crowd-traps";
import { checkSweep, type SweepCheck } from "../research/v9-crowd";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAY = 86_400_000,
  H = 3_600_000;
const time = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const fp = (v: number): string =>
  !Number.isFinite(v)
    ? "n/a"
    : v >= 1000
      ? v.toFixed(1)
      : v >= 1
        ? v.toFixed(4)
        : v.toFixed(5);
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 15_000,
});

async function klines(
  symbol: string,
  interval: string,
  from: number,
  to: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let start = from, guard = 0; guard < 200 && start < to; guard++) {
    const res = await http.get<Array<[number, string, string, string, string]>>(
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
        ts: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      });
    const next = res.data[res.data.length - 1][0] + 1;
    if (next <= start) break;
    start = next;
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"),
    days = Number(arg("days", "60"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const rows: Array<{
    symbol: string;
    side: string;
    entryTs: number;
    episodeStart: number;
    confirmTs: number;
    state: string;
    pnlR: number | null;
    chk: SweepCheck | null;
  }> = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const trades = await db
      .collection("v9_trades")
      .find({
        userId: user,
        createdAt: { $gte: Date.now() - days * DAY },
        entryPrice: { $ne: null },
        state: { $in: ["OPEN", "CLOSED"] },
      })
      .sort({ createdAt: 1 })
      .toArray();
    process.stderr.write(`${trades.length} trades of ${user}\n`);
    const h1Cache = new Map<string, Candle[]>();
    for (const t of trades) {
      const symbol = String(t.symbol);
      const d = await db
        .collection("v9_decisions")
        .findOne(
          { signalId: t.signalId },
          { projection: { episodeStart: 1, confirmTs: 1 } },
        );
      if (!d) {
        process.stderr.write(`${t.signalId}: no decision stored -- skipped\n`);
        continue;
      }
      const episodeStart = time(d.episodeStart),
        confirmTs = time(d.confirmTs);
      let h1 = h1Cache.get(symbol);
      if (!h1) {
        const first = Math.min(
          ...trades
            .filter((x) => x.symbol === symbol)
            .map((x) => time(x.createdAt)),
        );
        h1 = (await klines(symbol, "1h", first - 12 * DAY, Date.now())).filter(
          (c) => c.ts + H <= Date.now(),
        );
        h1Cache.set(symbol, h1);
      }
      const m1 = await klines(
        symbol,
        "1m",
        Math.floor(episodeStart / 60_000) * 60_000,
        confirmTs,
      );
      const long = t.side === "LONG";
      rows.push({
        symbol,
        side: long ? "BUY" : "SELL",
        entryTs: time(t.createdAt),
        episodeStart,
        confirmTs,
        state: String(t.state),
        pnlR: t.pnlR === null || t.pnlR === undefined ? null : Number(t.pnlR),
        chk: checkSweep(h1, m1, long, episodeStart, confirmTs),
      });
    }
  } finally {
    await client.close();
  }
  console.log(
    `\n=== V9 SIGNALS OF ${user} vs CROWD STOP POOLS (${rows.length} trades, all times UTC) ===`,
  );
  console.log(
    "ENTRY (UTC)   COIN  SIDE  cleaning (UTC)      start       extreme     swept pools (whose stops)                          result",
  );
  for (const r of rows) {
    const c = r.chk;
    const swept = !c
      ? "n/a (not enough candles)"
      : c.swept.length
        ? c.swept.map((q) => `${fp(q.price)} ${q.sources.join("+")}`).join(", ")
        : `none (nearest ${c.nearest ? `${fp(c.nearest.price)} ${c.nearest.sources.join("+")}, ${c.nearestDistPct.toFixed(2)}% away` : "-"})`;
    console.log(
      `${utc(r.entryTs)}   ${r.symbol.replace("USDT", "").padEnd(5)} ${r.side.padEnd(4)}  ${utc(r.episodeStart).slice(6)}-${utc(r.confirmTs).slice(6)}  ${fp(c?.startPrice ?? NaN).padEnd(11)} ${fp(c?.extreme ?? NaN).padEnd(11)} ${swept.padEnd(50)} ${r.state === "OPEN" ? "open" : r.pnlR === null ? "?" : sR(r.pnlR)}`,
    );
  }
  const closed = rows.filter(
    (r) => r.state === "CLOSED" && r.pnlR !== null && r.chk,
  );
  const line = (name: string, a: typeof closed): void => {
    const tp = a.filter((r) => r.pnlR! > 0).length,
      net = a.reduce((s, r) => s + r.pnlR!, 0);
    console.log(
      `  ${name.padEnd(28)} ${String(a.length).padStart(3)} trades  TP ${String(tp).padStart(2)}  SL ${String(a.length - tp).padStart(2)}  win ${a.length ? `${Math.round((100 * tp) / a.length)}%` : "n/a"}  ${sR(net).padStart(8)}  avg ${a.length ? sR(net / a.length) : "n/a"}`,
    );
  };
  console.log("\nclosed trades:");
  line(
    "cleaning SWEPT a crowd pool",
    closed.filter((r) => r.chk!.swept.length > 0),
  );
  line(
    "did NOT sweep a pool",
    closed.filter((r) => r.chk!.swept.length === 0),
  );
  line(
    "swept 2+ strategies' stops",
    closed.filter((r) => r.chk!.swept.some((q) => q.weight >= 2)),
  );
  for (const src of SOURCES)
    line(
      `swept ${src}`,
      closed.filter((r) => r.chk!.swept.some((q) => q.sources.includes(src))),
    );
  console.log(
    "\n(only a handful of trades -- a direction to watch, not a proof)",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
