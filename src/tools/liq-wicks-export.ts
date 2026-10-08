/**
 * LIQUIDATION WICKS -- MULTI-COIN EXPORT (Johnny, Oct 8 2026). READ-ONLY: it reads our DB and Binance PUBLIC 1m
 * klines and writes files under reports/; it changes nothing in the DB, the collector or the bot.
 * For every coin that has minute_bars (or only --symbols A,B,...), it writes reports/liq-wicks/<SYMBOL>/:
 *   minutes.csv.gz  one row per minute: our bar (OI first/last/min/max in COINS, long/short liquidation $ and counts,
 *                   polls) + Binance 1m kline o/h/l/c/volume
 *   liqs.csv.gz     every liquidation event we have: time, side, price, $
 * plus reports/liq-wicks/coverage.txt (what each coin really covers) and packs everything into reports/liq-wicks.tgz.
 * Lighter than oi-research-export: no oi_second_observations scan and no openInterestHist.
 *
 *   npx tsx src/tools/liq-wicks-export.ts
 *   options: --symbols XRPUSDT,SOLUSDT   --days 20 (only the last N days; default: all minute_bars)
 * Binance weight: 1m klines in pages of 1500 (weight 10 each), one page per 0.7 s.
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { execFileSync } from "child_process";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const M = 60_000,
  D = 86_400_000;
const iso = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 30_000,
});
const num = (v: unknown): string =>
  v === null ||
  v === undefined ||
  (typeof v === "number" && !Number.isFinite(v))
    ? ""
    : String(v);

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const root = path.join("reports", "liq-wicks");
  fs.mkdirSync(root, { recursive: true });
  const cov: string[] = [];
  const say = (s: string): void => {
    console.log(s);
    cov.push(s);
  };
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const all = (await db
      .collection(MINUTE_BARS)
      .distinct("symbol")) as string[];
    const want = arg("symbols", "").toUpperCase().split(",").filter(Boolean);
    const syms = (
      want.length ? all.filter((s) => want.includes(s)) : all
    ).sort();
    const days = Number(arg("days", "0"));
    say(
      `═══ LIQ WICKS EXPORT · run ${iso(Date.now())} UTC · ${syms.length} coins (${all.length} with minute_bars) ═══`,
    );
    for (const sym of syms) {
      const first = await db
        .collection(MINUTE_BARS)
        .find({ symbol: sym })
        .sort({ ts: 1 })
        .limit(1)
        .project({ ts: 1 })
        .toArray();
      const last = await db
        .collection(MINUTE_BARS)
        .find({ symbol: sym })
        .sort({ ts: -1 })
        .limit(1)
        .project({ ts: 1 })
        .toArray();
      if (!first.length) continue;
      const a = (first[0].ts as Date).getTime(),
        b = (last[0].ts as Date).getTime();
      const from =
        days > 0 ? Math.max(a, Math.floor((Date.now() - days * D) / M) * M) : a;
      const to = b + M;
      const dir = path.join(root, sym);
      fs.mkdirSync(dir, { recursive: true });
      const gz = zlib.createGzip(),
        file = fs.createWriteStream(path.join(dir, "minutes.csv.gz"));
      gz.pipe(file);
      gz.write(
        "ts,oi_first,oi_last,oi_min,oi_max,polls,liqL_usd,liqS_usd,liqL_n,liqS_n,k_o,k_h,k_l,k_c,k_vol\n",
      );
      let bars = 0,
        withOi = 0,
        kls = 0;
      for (let w = from; w < to; w += 7 * D) {
        const we = Math.min(to, w + 7 * D);
        const bm = new Map<number, Record<string, unknown>>();
        for await (const x of db
          .collection(MINUTE_BARS)
          .find({ symbol: sym, ts: { $gte: new Date(w), $lt: new Date(we) } })
          .project({ _id: 0 }))
          bm.set((x.ts as Date).getTime(), x);
        const kl = new Map<number, unknown[]>();
        for (let s0 = w; s0 < we; ) {
          const rows: unknown[][] = (
            await fapi.get("/fapi/v1/klines", {
              params: {
                symbol: sym,
                interval: "1m",
                startTime: s0,
                endTime: we - 1,
                limit: 1500,
              },
            })
          ).data;
          if (!Array.isArray(rows) || !rows.length) break;
          for (const r of rows) kl.set(Number(r[0]), r);
          s0 = Number(rows[rows.length - 1][0]) + M;
          await sleep(Number(process.env.OI_EXPORT_SLEEP ?? 700));
          if (rows.length < 1500) break;
        }
        for (let t = w; t < we; t += M) {
          const x = bm.get(t),
            k = kl.get(t);
          if (!x && !k) continue;
          if (x) {
            bars++;
            if (Number(x.oiLast) > 0) withOi++;
          }
          if (k) kls++;
          gz.write(
            [
              t,
              x?.oiFirst,
              x?.oiLast,
              x?.oiMin,
              x?.oiMax,
              x?.polls,
              x?.longLiqUsd,
              x?.shortLiqUsd,
              x?.longLiqCount,
              x?.shortLiqCount,
              k?.[1],
              k?.[2],
              k?.[3],
              k?.[4],
              k?.[5],
            ]
              .map(num)
              .join(",") + "\n",
          );
        }
        process.stdout.write(`\r  ${sym} ${iso(w)} …`);
      }
      gz.end();
      await new Promise<void>((res) => file.on("finish", () => res()));
      const liqs = await db
        .collection("liq_raw_events")
        .find({ symbol: sym, timestamp: { $gte: from } })
        .project({ _id: 0, timestamp: 1, victim: 1, price: 1, quoteQty: 1 })
        .sort({ timestamp: 1 })
        .toArray();
      fs.writeFileSync(
        path.join(dir, "liqs.csv.gz"),
        zlib.gzipSync(
          [
            "ts,victim,price,usd",
            ...liqs.map((l) =>
              [l.timestamp, l.victim, l.price, l.quoteQty].join(","),
            ),
          ].join("\n") + "\n",
        ),
      );
      process.stdout.write("\r");
      say(
        `  ${sym.padEnd(14)} ${iso(from)} → ${iso(b)} · bars ${bars} · with OI ${withOi} · klines ${kls} · liquidations ${liqs.length}`,
      );
    }
    fs.writeFileSync(path.join(root, "coverage.txt"), cov.join("\n") + "\n");
    const tgz = path.join("reports", "liq-wicks.tgz");
    execFileSync("tar", ["czf", tgz, "-C", "reports", "liq-wicks"]);
    console.log(
      `\npack: ${tgz} (${(fs.statSync(tgz).size / 1e6).toFixed(1)} MB)`,
    );
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
