/**
 * RESEARCH 1H EXPORT (Johnny, Oct 12 2026). READ-ONLY: reads our Mongo (find only) and Binance PUBLIC endpoints,
 * writes files under reports/research-1h/ and packs them into reports/research-1h.tar.gz. Changes nothing in the DB or the bot.
 *
 *   npx tsx src/tools/research-1h-export.ts                       # 25 research coins, last 14 days
 *   npx tsx src/tools/research-1h-export.ts --days 30             # Binance keeps OI history only 30 days
 *   npx tsx src/tools/research-1h-export.ts --symbols BTCUSDT,ETHUSDT --days 7
 *
 * One row per symbol per CLOSED 1H candle (UTC, hour start = open_time_utc):
 *   price      Binance 1h kline: open high low close, volume (coins), quote volume ($), taker buy quote ($), trades
 *   OI (Binance)  /futures/data/openInterestHist 5m (timestamp T = OI at T, checked against our DB):
 *              oi_open = OI at hour start, oi_close = OI at hour end, oi_high / oi_low over the 13 snapshots, in COINS;
 *              oi_close_usd = Binance sumOpenInterestValue at hour end
 *   OI (our DB)   minute_bars: db_oi_open (oiFirst of the first minute), db_oi_close (oiLast of the last minute), db_minutes
 *   liquidations  our DB minute_bars (kept 365 days): long_liq_usd/count, short_liq_usd/count  (LONG = longs liquidated)
 *              + liq_raw_events (kept ~14 days): biggest single long / short liquidation $ in the hour
 * Files: <SYMBOL>_1h.csv, all_1h.csv (all symbols), liq_events.csv (every raw liquidation event in the range), README.txt
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";

const COINS = [
  "ADA",
  "ALGO",
  "AVAX",
  "BCH",
  "BNB",
  "BTC",
  "DOGE",
  "DOT",
  "ENA",
  "ETH",
  "HBAR",
  "HYPE",
  "LINK",
  "LTC",
  "NEAR",
  "ONDO",
  "SOL",
  "STRK",
  "SUI",
  "UNI",
  "WLD",
  "XLM",
  "XRP",
  "XTZ",
  "ZEC",
].map((c) => `${c}USDT`);
const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const H = 3_600_000,
  M5 = 300_000;
const iso = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 30_000,
});
const num = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === "number" && !Number.isFinite(v))
    ? ""
    : String(v);
const toMs = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));

async function get<T>(
  url: string,
  params: Record<string, unknown>,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return (await fapi.get(url, { params })).data as T;
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

async function main() {
  const days = Math.min(30, Math.max(1, Number(arg("days", "14"))));
  const symbols = arg("symbols", COINS.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const end = Math.floor(Date.now() / H) * H; // last closed hour ends here
  const start = end - days * 24 * H;
  const out = path.join("reports", "research-1h");
  fs.mkdirSync(out, { recursive: true });
  const HEAD = [
    "symbol",
    "open_time_utc",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume_usd",
    "taker_buy_quote_usd",
    "trades",
    "oi_open",
    "oi_close",
    "oi_high",
    "oi_low",
    "oi_change",
    "oi_change_pct",
    "oi_close_usd",
    "db_oi_open",
    "db_oi_close",
    "db_minutes",
    "long_liq_usd",
    "long_liq_count",
    "short_liq_usd",
    "short_liq_count",
    "max_long_liq_usd",
    "max_short_liq_usd",
  ];
  const all = fs.createWriteStream(path.join(out, "all_1h.csv"));
  all.write(HEAD.join(",") + "\n");
  const ev = fs.createWriteStream(path.join(out, "liq_events.csv"));
  ev.write("symbol,time_utc,ts_ms,victim,price,usd\n");
  console.log(
    `research 1h export · ${symbols.length} symbols · ${iso(start)} → ${iso(end)} UTC (${days} days)`,
  );

  const client = new MongoClient(
    process.env.MONGO_URI ?? "mongodb://localhost:27017",
  );
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const sym of symbols) {
      // price: 1h klines
      const kl = new Map<number, unknown[]>();
      for (let s = start; s < end; s += 1000 * H) {
        const rows = await get<unknown[][]>("/fapi/v1/klines", {
          symbol: sym,
          interval: "1h",
          startTime: s,
          endTime: Math.min(end, s + 1000 * H) - 1,
          limit: 1000,
        });
        for (const r of rows) kl.set(Number(r[0]), r);
        await sleep(300);
      }
      // OI: Binance 5m history (max 30 days back)
      const oi = new Map<number, { c: number; usd: number }>();
      for (let s = start; s <= end; s += 499 * M5) {
        const rows = await get<
          {
            timestamp: number;
            sumOpenInterest: string;
            sumOpenInterestValue: string;
          }[]
        >("/futures/data/openInterestHist", {
          symbol: sym,
          period: "5m",
          limit: 500,
          startTime: s,
          endTime: Math.min(end, s + 499 * M5),
        });
        for (const r of rows)
          oi.set(Number(r.timestamp), {
            c: Number(r.sumOpenInterest),
            usd: Number(r.sumOpenInterestValue),
          });
        await sleep(300);
      }
      // our DB: minute_bars (OI + liquidation sums) and raw liquidation events
      const bars = await db
        .collection(MINUTE_BARS)
        .find({
          symbol: sym,
          ts: { $gte: new Date(start), $lt: new Date(end) },
        })
        .project({
          _id: 0,
          ts: 1,
          oiFirst: 1,
          oiLast: 1,
          longLiqUsd: 1,
          shortLiqUsd: 1,
          longLiqCount: 1,
          shortLiqCount: 1,
        })
        .sort({ ts: 1 })
        .toArray();
      const hb = new Map<
        number,
        {
          n: number;
          oo: number | null;
          oc: number | null;
          L: number;
          Ln: number;
          S: number;
          Sn: number;
          mL: number;
          mS: number;
        }
      >();
      const hget = (h: number) => {
        let v = hb.get(h);
        if (!v) {
          v = {
            n: 0,
            oo: null,
            oc: null,
            L: 0,
            Ln: 0,
            S: 0,
            Sn: 0,
            mL: 0,
            mS: 0,
          };
          hb.set(h, v);
        }
        return v;
      };
      for (const b of bars) {
        const t = new Date(b.ts).getTime();
        const v = hget(Math.floor(t / H) * H);
        v.n++;
        if (v.oo === null && b.oiFirst) v.oo = b.oiFirst;
        if (b.oiLast) v.oc = b.oiLast;
        v.L += Number(b.longLiqUsd ?? 0);
        v.Ln += Number(b.longLiqCount ?? 0);
        v.S += Number(b.shortLiqUsd ?? 0);
        v.Sn += Number(b.shortLiqCount ?? 0);
      }
      const raw = await db
        .collection("liq_raw_events")
        .find({
          symbol: sym,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: start, $lt: end },
        })
        .project({ _id: 0, timestamp: 1, victim: 1, price: 1, quoteQty: 1 })
        .toArray();
      let nev = 0;
      for (const r of raw
        .map((x) => ({
          t: toMs(x.timestamp),
          v: String(x.victim),
          p: Number(x.price),
          usd: Number(x.quoteQty),
        }))
        .filter((x) => x.t >= start && x.t < end)
        .sort((a, b) => a.t - b.t)) {
        ev.write(
          [sym, iso(r.t), r.t, r.v, r.p, r.usd.toFixed(2)].join(",") + "\n",
        );
        nev++;
        const v = hget(Math.floor(r.t / H) * H);
        if (r.v === "LONG") v.mL = Math.max(v.mL, r.usd);
        else v.mS = Math.max(v.mS, r.usd);
      }
      // rows
      const f = fs.createWriteStream(path.join(out, `${sym}_1h.csv`));
      f.write(HEAD.join(",") + "\n");
      let rowsN = 0,
        noOi = 0;
      for (let h = start; h < end; h += H) {
        const k = kl.get(h);
        if (!k) continue;
        const snaps = Array.from({ length: 13 }, (_, i) =>
          oi.get(h + i * M5),
        ).filter(Boolean) as { c: number; usd: number }[];
        const a = oi.get(h),
          z = oi.get(h + H);
        if (!a || !z) noOi++;
        const d = hb.get(h);
        const row = [
          sym,
          iso(h),
          k[1],
          k[2],
          k[3],
          k[4],
          k[5],
          k[7],
          k[10],
          k[8],
          num(a?.c),
          num(z?.c),
          snaps.length ? Math.max(...snaps.map((s) => s.c)) : "",
          snaps.length ? Math.min(...snaps.map((s) => s.c)) : "",
          a && z ? (z.c - a.c).toFixed(3) : "",
          a && z ? (100 * (z.c / a.c - 1)).toFixed(4) : "",
          num(z?.usd),
          num(d?.oo),
          num(d?.oc),
          d?.n ?? 0,
          (d?.L ?? 0).toFixed(2),
          d?.Ln ?? 0,
          (d?.S ?? 0).toFixed(2),
          d?.Sn ?? 0,
          (d?.mL ?? 0).toFixed(2),
          (d?.mS ?? 0).toFixed(2),
        ].join(",");
        f.write(row + "\n");
        all.write(row + "\n");
        rowsN++;
      }
      await new Promise((r) => f.end(r));
      console.log(
        `  ${sym.padEnd(10)} hours ${rowsN} · Binance OI missing at an hour edge: ${noOi} · DB minute_bars ${bars.length} · raw liquidation events ${nev}`,
      );
    }
  } finally {
    await client.close();
  }
  await new Promise((r) => all.end(r));
  await new Promise((r) => ev.end(r));
  fs.writeFileSync(
    path.join(out, "README.txt"),
    `research 1h export, ${iso(start)} -> ${iso(end)} UTC, ${days} days, symbols: ${symbols.join(" ")}\n` +
      "Columns: see the header comment of src/tools/research-1h-export.ts. OI in coins. LONG liq = longs liquidated (forced sells).\n",
  );
  execFileSync("tar", [
    "czf",
    path.join("reports", "research-1h.tar.gz"),
    "-C",
    "reports",
    "research-1h",
  ]);
  console.log(
    `done -> reports/research-1h.tar.gz (${(fs.statSync(path.join("reports", "research-1h.tar.gz")).size / 1e6).toFixed(1)} MB)`,
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
