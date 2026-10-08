/**
 * OI RESEARCH -- AUDIT + EXPORT (Johnny, Oct 8 2026). READ-ONLY: it reads our DB and Binance PUBLIC endpoints and
 * writes files under reports/; it changes nothing in the DB, the collector or the bot.
 * The analysis itself is done on the exported files (Claude, in its workspace) -- this tool only audits and exports.
 *
 * Writes reports/oi-research-<SYMBOL>/ and packs it into reports/oi-research-<SYMBOL>.tgz:
 *   minutes.csv.gz   one row per minute over the WHOLE range our minute_bars really cover:
 *                      our bar (mid price o/h/l/c from the 1/s polls, OI first/last/min/max in COINS, polls,
 *                      long/short liquidation $ and counts) + Binance 1m kline (o/h/l/c, volume, quote volume,
 *                      taker buy base/quote, trades) + from oi_second_observations (last ~14 days): how many
 *                      DISTINCT Binance OI values / update times that minute, the poll -> update lag
 *   oihist5m.csv.gz  Binance's own OI history (5m, ~30 days kept by Binance): sumOpenInterest (coins) and
 *                      sumOpenInterestValue ($) -- an independent check of our units and timestamps
 *   liqs.csv.gz      every liquidation event we have (~14 days): time, side, price, $
 *   audit.txt        what this tool printed
 *
 *   npx tsx src/tools/oi-research-export.ts --symbol XRPUSDT
 *   option: --days N (only the last N days of minute_bars; default: all of it)
 * Binance weight: 1m klines in pages of 1500 (weight 10 each), one page per 0.7 s (~860 weight/min, the bot keeps room).
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
const q = (xs: number[], p: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const num = (v: unknown): string =>
  v === null ||
  v === undefined ||
  (typeof v === "number" && !Number.isFinite(v))
    ? ""
    : String(v);

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "XRPUSDT").toUpperCase();
  const dir = path.join("reports", `oi-research-${sym}`);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const say = (s: string): void => {
    console.log(s);
    lines.push(s);
  };
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    say(`═══ OI RESEARCH AUDIT · ${sym} · run ${iso(Date.now())} UTC ═══`);

    // 1 what each source really covers
    const span = async (
      col: string,
      f: string,
    ): Promise<[number, number, number]> => {
      const c = db.collection(col);
      const a = await c
        .find({ symbol: sym })
        .sort({ [f]: 1 })
        .limit(1)
        .project({ [f]: 1 })
        .toArray();
      const b = await c
        .find({ symbol: sym })
        .sort({ [f]: -1 })
        .limit(1)
        .project({ [f]: 1 })
        .toArray();
      const n = await c.countDocuments({ symbol: sym });
      const t = (x: unknown): number =>
        x instanceof Date ? x.getTime() : Number(x);
      return [a.length ? t(a[0][f]) : NaN, b.length ? t(b[0][f]) : NaN, n];
    };
    for (const [col, f] of [
      [MINUTE_BARS, "ts"],
      ["oi_second_observations", "timestamp"],
      ["liq_raw_events", "timestamp"],
    ] as const) {
      const [a, b, n] = await span(col, f);
      say(
        `  ${col.padEnd(24)} ${Number.isFinite(a) ? `${iso(a)} → ${iso(b)} UTC · ${((b - a) / D).toFixed(1)} days` : "no rows"} · ${n} rows`,
      );
    }

    const days = Number(arg("days", "0"));
    const [mbA, mbB] = await span(MINUTE_BARS, "ts");
    if (!Number.isFinite(mbA))
      throw new Error("no minute_bars for this symbol");
    const from =
      days > 0
        ? Math.max(mbA, Math.floor((Date.now() - days * D) / M) * M)
        : mbA;
    const to = Math.floor(Date.now() / M) * M;

    // 2 oi_second_observations: how often Binance's OI value really changes; poll -> update lag (only ~14 days kept)
    say(`\n── oi_second_observations: real update cadence ──`);
    const perMin = new Map<
      number,
      { polls: number; vals: Set<number>; upd: Set<number>; lag: number[] }
    >();
    const updTimes = new Set<number>();
    let unitCheck: { oi: number; usd: number; price: number } | null = null;
    for await (const o of db
      .collection("oi_second_observations")
      .find({ symbol: sym, timestamp: { $gte: new Date(from) } })
      .project({
        _id: 0,
        timestamp: 1,
        oiUpdatedAt: 1,
        openInterest: 1,
        openInterestUsd: 1,
        price: 1,
      })) {
      const t = (o.timestamp as Date).getTime(),
        m = Math.floor(t / M) * M;
      let r = perMin.get(m);
      if (!r) {
        r = { polls: 0, vals: new Set(), upd: new Set(), lag: [] };
        perMin.set(m, r);
      }
      r.polls++;
      r.vals.add(Number(o.openInterest));
      if (o.oiUpdatedAt instanceof Date) {
        const u = o.oiUpdatedAt.getTime();
        r.upd.add(u);
        updTimes.add(u);
        r.lag.push(t - u);
      }
      if (!unitCheck && Number(o.openInterestUsd) > 0)
        unitCheck = {
          oi: Number(o.openInterest),
          usd: Number(o.openInterestUsd),
          price: Number(o.price),
        };
    }
    const ups = [...updTimes].sort((x, y) => x - y),
      ugaps = ups.slice(1).map((u, i) => u - ups[i]);
    const allLag = [...perMin.values()].flatMap((r) => r.lag);
    const distinctPerMin = [...perMin.values()].map((r) => r.vals.size);
    say(
      `  minutes with polls ${perMin.size} · distinct Binance OI update times ${ups.length}`,
    );
    say(
      `  gap between Binance OI updates: median ${(q(ugaps, 0.5) / 1000).toFixed(1)} s · p10 ${(q(ugaps, 0.1) / 1000).toFixed(1)} s · p90 ${(q(ugaps, 0.9) / 1000).toFixed(1)} s`,
    );
    say(
      `  distinct OI VALUES per minute: median ${q(distinctPerMin, 0.5)} · p90 ${q(distinctPerMin, 0.9)} (the rest are repeated polls of the same value)`,
    );
    say(
      `  poll time - Binance update time: median ${(q(allLag, 0.5) / 1000).toFixed(1)} s · p90 ${(q(allLag, 0.9) / 1000).toFixed(1)} s`,
    );
    if (unitCheck)
      say(
        `  units: openInterest ${unitCheck.oi} · openInterestUsd ${unitCheck.usd.toFixed(0)} · price ${unitCheck.price} → usd/oi = ${(unitCheck.usd / unitCheck.oi).toFixed(4)} (≈ price → openInterest is in COINS)`,
      );
    const lagMed = new Map<number, number>();
    for (const [m, r] of perMin) {
      lagMed.set(m, q(r.lag, 0.5));
      r.lag = [];
    }

    // 3 Binance's own 5m OI history (independent check)
    const hist: [number, string, string][] = [];
    for (let s0 = Date.now() - 29.5 * D; s0 < Date.now(); ) {
      const rows = (
        await fapi.get("/futures/data/openInterestHist", {
          params: {
            symbol: sym,
            period: "5m",
            limit: 500,
            startTime: Math.floor(s0),
          },
        })
      ).data as {
        timestamp: number;
        sumOpenInterest: string;
        sumOpenInterestValue: string;
      }[];
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows)
        hist.push([r.timestamp, r.sumOpenInterest, r.sumOpenInterestValue]);
      s0 = rows[rows.length - 1].timestamp + 1;
      if (rows.length < 500) break;
      await sleep(Number(process.env.OI_EXPORT_SLEEP ?? 300));
    }
    const histAt = new Map<number, number>(
      hist.map((r) => [r[0], Number(r[1])]),
    );

    // 4 minute_bars + Binance 1m klines, one week at a time (the server has little memory), streamed to the file
    const gzOut = zlib.createGzip(),
      file = fs.createWriteStream(path.join(dir, "minutes.csv.gz"));
    gzOut.pipe(file);
    const mh = [
      "ts",
      "mid_o",
      "mid_h",
      "mid_l",
      "mid_c",
      "oi_first",
      "oi_last",
      "oi_min",
      "oi_max",
      "polls",
      "liqL_usd",
      "liqS_usd",
      "liqL_n",
      "liqS_n",
      "k_o",
      "k_h",
      "k_l",
      "k_c",
      "k_vol",
      "k_qvol",
      "k_tbase",
      "k_tquote",
      "k_trades",
      "oi_vals",
      "oi_upd",
      "lag_med_ms",
    ];
    gzOut.write(mh.join(",") + "\n");
    let present = 0,
      noOi = 0,
      noKline = 0,
      klines = 0;
    const missing: { a: number; n: number }[] = [];
    let run: { a: number; n: number } | null = null;
    const pollHist = new Map<number, number>();
    const pd: number[] = [],
      hd: number[] = [];
    for (let w = from; w < to; w += 7 * D) {
      const we = Math.min(to, w + 7 * D);
      const bars = new Map<number, Record<string, unknown>>();
      for await (const b of db
        .collection(MINUTE_BARS)
        .find({ symbol: sym, ts: { $gte: new Date(w), $lt: new Date(we) } })
        .project({ _id: 0 }))
        bars.set((b.ts as Date).getTime(), b);
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
      klines += kl.size;
      process.stdout.write(`\r  exporting ${iso(w)} … (${klines} klines)`);
      for (let t = w; t < we; t += M) {
        const b = bars.get(t),
          k = kl.get(t),
          r = perMin.get(t);
        if (t <= mbB) {
          if (!b) {
            if (run) run.n++;
            else run = { a: t, n: 1 };
          } else if (run) {
            missing.push(run);
            run = null;
          }
        }
        if (b) {
          present++;
          if (!(Number(b.oiLast) > 0)) noOi++;
          const pl = Number(b.polls);
          pollHist.set(pl, (pollHist.get(pl) ?? 0) + 1);
          if (!k) noKline++;
          if (k && Number(b.close) > 0)
            pd.push((100 * (Number(b.close) - Number(k[4]))) / Number(k[4]));
          const h = histAt.get(t);
          if (h && Number(b.oiLast) > 0)
            hd.push((100 * (Number(b.oiLast) - h)) / h);
        }
        if (!b && !k) continue;
        gzOut.write(
          [
            t,
            b?.open,
            b?.high,
            b?.low,
            b?.close,
            b?.oiFirst,
            b?.oiLast,
            b?.oiMin,
            b?.oiMax,
            b?.polls,
            b?.longLiqUsd,
            b?.shortLiqUsd,
            b?.longLiqCount,
            b?.shortLiqCount,
            k?.[1],
            k?.[2],
            k?.[3],
            k?.[4],
            k?.[5],
            k?.[7],
            k?.[9],
            k?.[10],
            k?.[8],
            r?.vals.size,
            r?.upd.size,
            lagMed.get(t),
          ]
            .map(num)
            .join(",") + "\n",
        );
      }
    }
    if (run) missing.push(run);
    gzOut.end();
    await new Promise<void>((res) => file.on("finish", () => res()));
    process.stdout.write("\n");
    const expected = Math.round((mbB + M - from) / M);
    say(`\n── minute_bars (exported ${iso(from)} → ${iso(mbB)} UTC) ──`);
    say(
      `  minutes expected ${expected} · present ${present} · missing ${expected - present} in ${missing.length} gaps · bars without OI ${noOi}`,
    );
    for (const g of missing.sort((x, y) => y.n - x.n).slice(0, 10))
      say(`  gap ${iso(g.a)} UTC · ${g.n} min`);
    const pollsSorted = [...pollHist.entries()].sort((x, y) => x[0] - y[0]);
    let acc = 0;
    const half = present / 2;
    let pmed = NaN;
    for (const [v, n] of pollsSorted) {
      acc += n;
      if (acc >= half) {
        pmed = v;
        break;
      }
    }
    say(
      `  polls per minute: median ${pmed} · min ${pollsSorted[0]?.[0]} · max ${pollsSorted[pollsSorted.length - 1]?.[0]}`,
    );
    say(
      `\n── Binance 1m klines ──\n  ${klines} candles · our minutes without a kline ${noKline}`,
    );
    say(
      `  our minute close (mid from polls) vs kline close: median ${q(pd, 0.5).toFixed(4)}% · p1 ${q(pd, 0.01).toFixed(4)}% · p99 ${q(pd, 0.99).toFixed(4)}%`,
    );
    say(
      `\n── Binance openInterestHist 5m (independent) ──\n  ${hist.length} rows${hist.length ? ` ${iso(hist[0][0])} → ${iso(hist[hist.length - 1][0])} UTC` : ""} · our oiLast vs Binance (same minute): median ${q(hd, 0.5).toFixed(3)}% · p10 ${q(hd, 0.1).toFixed(3)}% · p90 ${q(hd, 0.9).toFixed(3)}% · n ${hd.length}`,
    );

    // 6 liquidations
    const liqs = await db
      .collection("liq_raw_events")
      .find({ symbol: sym })
      .project({ _id: 0, timestamp: 1, victim: 1, price: 1, quoteQty: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    const perSec = new Map<number, number>();
    for (const l of liqs) {
      const s = Math.floor(Number(l.timestamp) / 1000);
      perSec.set(s, (perSec.get(s) ?? 0) + 1);
    }
    say(
      `\n── liquidations ──\n  ${liqs.length} events · seconds with >1 event ${[...perSec.values()].filter((n) => n > 1).length} (Binance's stream sends at most ~1 per second per coin)`,
    );

    // write the files
    const gz = (f: string, rows: string[]): void => {
      fs.writeFileSync(
        path.join(dir, f),
        zlib.gzipSync(rows.join("\n") + "\n"),
      );
    };
    gz("oihist5m.csv.gz", [
      "ts,sumOpenInterest,sumOpenInterestValue",
      ...hist.map((r) => r.join(",")),
    ]);
    gz("liqs.csv.gz", [
      "ts,victim,price,usd",
      ...liqs.map((l) =>
        [l.timestamp, l.victim, l.price, l.quoteQty].join(","),
      ),
    ]);
    fs.writeFileSync(path.join(dir, "audit.txt"), lines.join("\n") + "\n");
    const tgz = path.join("reports", `oi-research-${sym}.tgz`);
    execFileSync("tar", ["czf", tgz, "-C", "reports", `oi-research-${sym}`]);
    console.log(
      `\nfiles: ${dir}/  ·  pack: ${tgz} (${(fs.statSync(tgz).size / 1e6).toFixed(1)} MB)`,
    );
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
