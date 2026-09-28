/**
 * V9 TAKE PROFIT AT THE CROWD'S OTHER STOP POOL (Johnny, Sep 29 2026). Read-only.
 * The real V9 trades of a user (default main). At the entry, the crowd stop pools on the OTHER side are built
 * from the 1h candles finished before the entry hour (UTC); a BUY looks at the shorts' stops above, a SELL
 * at the longs' stops below. Same entry, same SL -- only the TP changes:
 *   BASE         TP 2.2R (what we trade)
 *   NEAR_POOL    TP just before the nearest opposite pool that is >= 1R away
 *   STRONG_POOL  the same, only pools where 2+ strategies' stops sit
 *   POOL_OR_22   the nearest pool >= 1R, but not further than 2.2R (else 2.2R)
 * The price path: Binance 1m candles after the entry (SL first if one minute touches both). Fees: taker in,
 * maker TP, taker SL.
 *
 *   npx tsx src/tools/v9-crowd-tp.ts
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { poolsAt, type Candle, type Pool } from "../research/crowd-traps";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAY = 86_400_000,
  H = 3_600_000,
  M = 60_000;
const TAKER = 0.0005,
  MAKER = 0.0002;
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

type V = "BASE" | "NEAR_POOL" | "STRONG_POOL" | "POOL_OR_22";
const VS: V[] = ["BASE", "NEAR_POOL", "STRONG_POOL", "POOL_OR_22"];
interface Out {
  result: "TP" | "SL" | "OPEN" | "NONE";
  netR: number;
  tpR: number;
  exitTs: number;
}

function sim(
  m1: readonly Candle[],
  long: boolean,
  entry: number,
  sl: number,
  tp: number,
): Out {
  const risk = Math.abs(entry - sl),
    tpR = Math.abs(tp - entry) / risk;
  for (const c of m1) {
    if (long ? c.low <= sl : c.high >= sl)
      return {
        result: "SL",
        netR: -1 - (2 * TAKER * entry) / risk,
        tpR,
        exitTs: c.ts,
      };
    if (long ? c.high >= tp : c.low <= tp)
      return {
        result: "TP",
        netR: tpR - ((TAKER + MAKER) * entry) / risk,
        tpR,
        exitTs: c.ts,
      };
  }
  return { result: "OPEN", netR: 0, tpR, exitTs: Infinity };
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"),
    days = Number(arg("days", "60"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const rows: Array<{
    symbol: string;
    long: boolean;
    entryTs: number;
    entry: number;
    sl: number;
    pools: Array<{ q: Pool; r: number }>;
    by: Record<V, Out>;
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
      const symbol = String(t.symbol),
        entryTs = time(t.createdAt),
        entry = Number(t.entryPrice),
        sl = Number(t.slPrice),
        long = t.side === "LONG";
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
      let i = h1.findIndex((c) => c.ts >= Math.floor(entryTs / H) * H);
      if (i < 0) i = h1.length;
      const risk = Math.abs(entry - sl);
      const pools = poolsAt(h1, i)
        .filter((q) =>
          long
            ? q.side === "BUY_STOPS" && q.price > entry
            : q.side === "SELL_STOPS" && q.price < entry,
        )
        .map((q) => ({ q, r: Math.abs(q.price - entry) / risk }))
        .sort((a, b) => a.r - b.r);
      // the path: from the minute after the entry, until the trade and all TPs could have closed (up to 4 days)
      const m1 = await klines(
        symbol,
        "1m",
        Math.floor(entryTs / M) * M + M,
        Math.min(Date.now(), entryTs + 4 * DAY),
      );
      const at = (tpR: number): number =>
        long ? entry + tpR * risk : entry - tpR * risk;
      const before = (p: Pool): number =>
        long ? p.price * (1 - 0.0005) : p.price * (1 + 0.0005); // just before the stops
      const near = pools.find((x) => x.r >= 1),
        strong = pools.find((x) => x.r >= 1 && x.q.weight >= 2);
      const none: Out = { result: "NONE", netR: 0, tpR: NaN, exitTs: NaN };
      const by: Record<V, Out> = {
        BASE: sim(m1, long, entry, sl, at(2.2)),
        NEAR_POOL: near ? sim(m1, long, entry, sl, before(near.q)) : none,
        STRONG_POOL: strong ? sim(m1, long, entry, sl, before(strong.q)) : none,
        POOL_OR_22: sim(
          m1,
          long,
          entry,
          sl,
          near && near.r <= 2.2 ? before(near.q) : at(2.2),
        ),
      };
      rows.push({ symbol, long, entryTs, entry, sl, pools, by });
    }
  } finally {
    await client.close();
  }
  console.log(
    `\n=== V9 TP AT THE CROWD'S OTHER STOP POOL -- ${rows.length} trades of ${user} (UTC) ===`,
  );
  console.log(
    "ENTRY (UTC)   COIN  SIDE  entry       SL          opposite pools (distance in R, whose stops)                 BASE 2.2R      NEAR_POOL           STRONG_POOL         POOL_OR_22",
  );
  const cell = (o: Out): string =>
    o.result === "NONE"
      ? "no pool"
      : o.result === "OPEN"
        ? `open (${o.tpR.toFixed(1)}R)`
        : `${o.result} ${sR(o.netR)}${o.result === "TP" ? "" : ` (TP ${o.tpR.toFixed(1)}R)`}`;
  for (const r of rows) {
    const p =
      r.pools
        .slice(0, 4)
        .map((x) => `${x.r.toFixed(1)}R ${x.q.sources.join("+")}`)
        .join(", ") || "none";
    console.log(
      `${utc(r.entryTs)}   ${r.symbol.replace("USDT", "").padEnd(5)} ${r.long ? "BUY " : "SELL"}  ${fp(r.entry).padEnd(11)} ${fp(r.sl).padEnd(11)} ${p.padEnd(58)} ${cell(r.by.BASE).padEnd(14)} ${cell(r.by.NEAR_POOL).padEnd(19)} ${cell(r.by.STRONG_POOL).padEnd(19)} ${cell(r.by.POOL_OR_22)}`,
    );
  }
  console.log("\nvariant       closed  TP  SL  no-pool  open   netR     avg");
  for (const v of VS) {
    const a = rows.map((r) => r.by[v]),
      closed = a.filter((o) => o.result === "TP" || o.result === "SL"),
      net = closed.reduce((s, o) => s + o.netR, 0);
    console.log(
      `${v.padEnd(12)} ${String(closed.length).padStart(6)} ${String(a.filter((o) => o.result === "TP").length).padStart(3)} ${String(a.filter((o) => o.result === "SL").length).padStart(3)} ${String(a.filter((o) => o.result === "NONE").length).padStart(8)} ${String(a.filter((o) => o.result === "OPEN").length).padStart(5)}  ${sR(net).padStart(8)}  ${closed.length ? sR(net / closed.length) : "n/a"}`,
    );
  }
  console.log(
    "\nBASE here is re-simulated on Binance 1m candles from the real entry/SL (it should match the real results).",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
