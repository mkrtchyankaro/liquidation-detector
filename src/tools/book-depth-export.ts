/**
 * HISTORICAL ORDER-BOOK DEPTH -- EXPORT (Johnny, Oct 9 2026). READ-ONLY: Binance's PUBLIC data archive only
 * (data.binance.vision, no keys, no DB); it writes files under reports/ and changes nothing in the DB, the collector
 * or the bot.
 * Binance keeps, per USDⓈ-M symbol and day, a "bookDepth" file: snapshots of the order book's CUMULATIVE depth in
 * bands around the price (columns as Binance writes them, typically timestamp, percentage, depth, notional). It is
 * NOT a full L2 book: it says how much sits within x% of the price, not at which exact price level.
 * This tool downloads what exists for the days asked, caches the day files in data/bookdepth/<SYMBOL>/, and reports
 * plainly which days the archive does NOT have (nothing is filled in).
 *
 *   npx tsx src/tools/book-depth-export.ts --symbols BTCUSDT,SOLUSDT,LINKUSDT --days 90
 * writes reports/book-depth/<SYMBOL>.csv.gz + reports/book-depth/export.txt and packs reports/book-depth.tgz
 * Load: one archive file per 0.3 s.
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
const D = 86_400_000;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const vision = axios.create({
  baseURL: "https://data.binance.vision",
  timeout: 60_000,
  responseType: "arraybuffer",
  validateStatus: (s) => s === 200 || s === 404,
});

async function main(): Promise<void> {
  const syms = arg("symbols", "BTCUSDT,SOLUSDT,LINKUSDT")
    .toUpperCase()
    .split(",")
    .filter(Boolean);
  const days = Number(arg("days", "90"));
  const to = Math.floor(Date.now() / D) * D,
    from = to - days * D;
  const out = path.join("reports", "book-depth");
  fs.mkdirSync(out, { recursive: true });
  const log: string[] = [];
  const say = (s: string): void => {
    console.log(s);
    log.push(s);
  };
  say(
    `═══ BOOK DEPTH EXPORT (data.binance.vision bookDepth) · ${day(from)} → ${day(to - D)} · ${syms.join(", ")} ═══`,
  );
  for (const sym of syms) {
    const cache = path.join("data", "bookdepth", sym);
    fs.mkdirSync(cache, { recursive: true });
    const gz = zlib.createGzip(),
      file = fs.createWriteStream(path.join(out, `${sym}.csv.gz`));
    gz.pipe(file);
    let header = "",
      have = 0,
      rows = 0,
      first = "",
      last = "";
    const missing: string[] = [];
    for (let d = from; d < to; d += D) {
      const f = path.join(cache, `${day(d)}.csv`);
      let csv: string | null = fs.existsSync(f)
        ? fs.readFileSync(f, "utf8")
        : null;
      if (csv === null) {
        let r;
        for (let i = 0; ; i++) {
          try {
            r = await vision.get(
              `/data/futures/um/daily/bookDepth/${sym}/${sym}-bookDepth-${day(d)}.zip`,
            );
            break;
          } catch (err) {
            if (i >= 4) throw err;
            await sleep(2000 * 2 ** i);
          }
        }
        await sleep(300);
        if (r.status === 404) {
          missing.push(day(d));
          continue;
        }
        csv = unzipFirst(Buffer.from(r.data));
        fs.writeFileSync(f, csv);
      }
      const lines = csv.split("\n").filter((l) => l.trim());
      if (!lines.length) {
        missing.push(day(d));
        continue;
      }
      if (/[a-z]/i.test(lines[0].split(",")[0])) {
        if (!header) {
          header = lines[0];
          gz.write(header + "\n");
        }
        lines.shift();
      }
      for (const l of lines) gz.write(l + "\n");
      rows += lines.length;
      have++;
      if (!first) first = day(d);
      last = day(d);
      process.stdout.write(
        `\r  ${sym} ${day(d)} · ${have} days · ${rows} rows`,
      );
    }
    await new Promise<void>((res) => {
      file.on("finish", () => res());
      gz.end();
    });
    process.stdout.write("\n");
    say(
      `  ${sym}: ${have} days in the archive (${first || "-"} → ${last || "-"}) · ${rows} rows · columns: ${header || "(no header)"}`,
    );
    if (missing.length)
      say(
        `    NOT in the archive (${missing.length} days): ${missing.length > 12 ? `${missing.slice(0, 6).join(", ")} … ${missing.slice(-6).join(", ")}` : missing.join(", ")}`,
      );
  }
  fs.writeFileSync(path.join(out, "export.txt"), log.join("\n") + "\n");
  execFileSync("tar", [
    "czf",
    path.join("reports", "book-depth.tgz"),
    "-C",
    "reports",
    "book-depth",
  ]);
  console.log(
    `\npack: reports/book-depth.tgz (${(fs.statSync(path.join("reports", "book-depth.tgz")).size / 1e6).toFixed(1)} MB)`,
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
