/**
 * LONG OI HISTORY -- EXPORT (Johnny, Oct 8 2026). READ-ONLY: Binance's PUBLIC data only (no keys, no DB), writes
 * files under reports/; it changes nothing in the DB, the collector or the bot.
 * Our own OI history is ~16 days; Binance's official archive (data.binance.vision, futures/um/daily/metrics) keeps
 * 5-minute OI snapshots for YEARS. This tool packs, for one coin:
 *   metrics5m.csv.gz  every 5-minute row of the archive, as Binance writes it:
 *                       create_time, sum_open_interest (COINS), sum_open_interest_value ($),
 *                       count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio, count_long_short_ratio,
 *                       sum_taker_long_short_vol_ratio
 *   klines5m.csv.gz   Binance 5m klines over the same days: open time, o/h/l/c, volume, quote volume, trades,
 *                       taker buy base, taker buy quote
 * Day files are cached in data/metrics/<SYMBOL>/ (the same cache the other research tools use), so a second run is fast.
 * NO liquidations here: Binance's archive has none for this period.
 *
 *   npx tsx src/tools/oi-long-export.ts --symbol XRPUSDT
 *   option: --days 730 (how far back; days the archive does not have are skipped and counted)
 * Binance load: one archive file per 0.3 s, 5m klines in pages of 1500 (weight 10) every 0.7 s.
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { execFileSync } from "child_process";
import axios from "axios";
import { unzipFirst } from "../research/binance-history";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const D = 86_400_000,
  M5 = 5 * 60_000;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const SLEEP = Number(process.env.OI_EXPORT_SLEEP ?? 1);
const vision = axios.create({
  baseURL: "https://data.binance.vision",
  timeout: 30_000,
  responseType: "arraybuffer",
  validateStatus: (s) => s === 200 || s === 404,
});
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 30_000,
});

async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 5) throw err;
      process.stderr.write(
        `\n${what}: ${err instanceof Error ? err.message : String(err)} -- retry in ${2 * 2 ** i}s\n`,
      );
      await sleep(2000 * 2 ** i);
    }
  }
}
const finish = (gz: zlib.Gzip, file: fs.WriteStream): Promise<void> =>
  new Promise((res) => {
    file.on("finish", () => res());
    gz.end();
  });

async function main(): Promise<void> {
  const sym = arg("symbol", "XRPUSDT").toUpperCase(),
    days = Number(arg("days", "730"));
  const to = Math.floor(Date.now() / D) * D,
    from = to - days * D;
  const dir = path.join("reports", `oi-long-${sym}`),
    cache = path.join("data", "metrics", sym);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const log: string[] = [];
  const say = (s: string): void => {
    console.log(s);
    log.push(s);
  };
  say(
    `═══ LONG OI EXPORT · ${sym} · ${day(from)} → ${day(to - D)} (${days} days asked) ═══`,
  );

  // 1 the archive, day by day (cached)
  const gzM = zlib.createGzip(),
    fM = fs.createWriteStream(path.join(dir, "metrics5m.csv.gz"));
  gzM.pipe(fM);
  let header = "",
    have = 0,
    missing = 0,
    rows = 0,
    first = "",
    last = "";
  for (let d = from; d < to; d += D) {
    const f = path.join(cache, `${day(d)}.csv`);
    let csv: string | null = fs.existsSync(f)
      ? fs.readFileSync(f, "utf8")
      : null;
    if (csv === null) {
      const r = await retry(`metrics ${day(d)}`, () =>
        vision.get(
          `/data/futures/um/daily/metrics/${sym}/${sym}-metrics-${day(d)}.zip`,
        ),
      );
      await sleep(300 * SLEEP);
      if (r.status === 404) {
        missing++;
        continue;
      }
      csv = unzipFirst(Buffer.from(r.data));
      fs.writeFileSync(f, csv);
    }
    const lines = csv.split("\n").filter((l) => l.trim());
    if (!lines.length) {
      missing++;
      continue;
    }
    if (/[a-z]/i.test(lines[0].split(",")[0])) {
      if (!header) {
        header = lines[0];
        gzM.write(header + "\n");
      }
      lines.shift();
    }
    for (const l of lines) gzM.write(l + "\n");
    rows += lines.length;
    have++;
    if (!first) first = day(d);
    last = day(d);
    process.stdout.write(`\r  archive ${day(d)} · ${have} days · ${rows} rows`);
  }
  await finish(gzM, fM);
  process.stdout.write("\n");
  say(
    `  metrics: ${have} days (${first} → ${last}) · ${rows} rows · ${missing} days not in the archive · columns: ${header || "(no header in the files)"}`,
  );

  // 2 5m klines over the same span
  const gzK = zlib.createGzip(),
    fK = fs.createWriteStream(path.join(dir, "klines5m.csv.gz"));
  gzK.pipe(fK);
  gzK.write("t,o,h,l,c,vol,qvol,trades,tbase,tquote\n");
  let n = 0;
  for (let s = from; s < Date.now(); ) {
    const r: unknown[][] = (
      await retry("klines 5m", () =>
        fapi.get("/fapi/v1/klines", {
          params: { symbol: sym, interval: "5m", startTime: s, limit: 1500 },
        }),
      )
    ).data;
    if (!Array.isArray(r) || !r.length) break;
    for (const k of r)
      if (Number(k[6]) < Date.now()) {
        gzK.write(
          [k[0], k[1], k[2], k[3], k[4], k[5], k[7], k[8], k[9], k[10]].join(
            ",",
          ) + "\n",
        );
        n++;
      }
    s = Number(r[r.length - 1][0]) + M5;
    process.stdout.write(`\r  klines 5m ${day(s)} · ${n}`);
    await sleep(700 * SLEEP);
    if (r.length < 1500) break;
  }
  await finish(gzK, fK);
  process.stdout.write("\n");
  say(`  klines 5m: ${n} candles`);

  fs.writeFileSync(path.join(dir, "export.txt"), log.join("\n") + "\n");
  const tgz = path.join("reports", `oi-long-${sym}.tgz`);
  execFileSync("tar", ["czf", tgz, "-C", "reports", `oi-long-${sym}`]);
  console.log(
    `\npack: ${tgz} (${(fs.statSync(tgz).size / 1e6).toFixed(1)} MB)`,
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
