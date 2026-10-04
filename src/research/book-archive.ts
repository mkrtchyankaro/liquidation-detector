/**
 * Binance's public order book archive (data.binance.vision "bookDepth", ~1 day late) -- shared by the research tools.
 * percentage -1..-5 = the bids within that % below the price, +1..+5 = the asks above; notional in $.
 * Cached per day in data/bookDepth/<SYMBOL>/.
 */
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { unzipFirst } from "./binance-history";

const DAY = 86_400_000;
export const dayStr = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);
/** a timestamp cell: "2026-10-03 00:00:08" (UTC) or epoch ms */
export const tsOf = (x: string | undefined): number => {
  const v = (x ?? "").trim();
  return /^\d{12,}$/.test(v)
    ? Number(v)
    : Date.parse(`${v.replace(" ", "T")}Z`);
};

export interface Book {
  ts: number[];
  n: Map<number, number[]>;
}

const vision = axios.create({
  baseURL: "https://data.binance.vision",
  timeout: 60_000,
  responseType: "arraybuffer",
  validateStatus: (s) => s === 200 || s === 404,
});
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
/** one day's bookDepth CSV (null = not in the archive), cached on disk */
export async function bookCsv(
  symbol: string,
  day: number,
): Promise<string | null> {
  const dir = path.join("data", "bookDepth", symbol),
    f = path.join(dir, `${dayStr(day)}.csv`);
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
  for (let i = 0; ; i++) {
    try {
      const r = await vision.get(
        `/data/futures/um/daily/bookDepth/${symbol}/${symbol}-bookDepth-${dayStr(day)}.zip`,
      );
      await sleep(300);
      if (r.status === 404) return null;
      const csv = unzipFirst(Buffer.from(r.data));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, csv);
      return csv;
    } catch (err) {
      if (i >= 4) throw err;
      process.stderr.write(
        `${symbol} ${dayStr(day)}: ${err instanceof Error ? err.message : err} -- retry\n`,
      );
      await sleep(2000 * 2 ** i);
    }
  }
}
export async function book(
  symbol: string,
  from: number,
  to: number,
  missing: string[],
): Promise<Book> {
  const rows = new Map<number, Map<number, number>>();
  for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
    const csv = await bookCsv(symbol, d);
    if (csv === null) {
      missing.push(`${symbol} ${dayStr(d)}`);
      continue;
    }
    for (const line of csv.split("\n")) {
      const v = line.split(",");
      const t = tsOf(v[0]),
        p = Number(v[1]),
        n = Number(v[3]);
      if (!Number.isFinite(t) || !Number.isFinite(p) || !Number.isFinite(n))
        continue; // the header
      if (!rows.has(t)) rows.set(t, new Map());
      rows.get(t)!.set(Math.round(p), n);
    }
  }
  const ts = [...rows.keys()].sort((a, b) => a - b),
    n = new Map<number, number[]>();
  for (const p of [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5])
    n.set(
      p,
      ts.map((t) => rows.get(t)!.get(p) ?? NaN),
    );
  return { ts, n };
}
/** the last snapshot at or before t (within 5 minutes), else -1 */
export const at = (b: Book, t: number): number => {
  let lo = 0,
    hi = b.ts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (b.ts[m] <= t) lo = m + 1;
    else hi = m;
  }
  const i = lo - 1;
  return i >= 0 && t - b.ts[i] <= 5 * 60_000 ? i : -1;
};
export const val = (b: Book, i: number, p: number): number =>
  i < 0 ? NaN : b.n.get(p)![i];
