/**
 * Binance history for research tools (read-only, no keys):
 *   OI    -- data.binance.vision daily "metrics" files (5-minute OI snapshots, years back), cached in data/metrics/<SYMBOL>/;
 *            days not archived yet come from /futures/data/openInterestHist (1h, last 30 days only)
 *   price -- /fapi/v1/klines
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import axios from "axios";

const H = 3_600_000, D = 24 * H;
const fapi = axios.create({ baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com", timeout: 20_000 });
const vision = axios.create({ baseURL: "https://data.binance.vision", timeout: 30_000, responseType: "arraybuffer", validateStatus: (s) => s === 200 || s === 404 });
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Binance throttles long downloads (429/418/timeouts): wait and try again, up to 6 times */
async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err) {
      if (i >= 5) throw err;
      const wait = 2000 * 2 ** i;
      process.stderr.write(`\n${what}: ${err instanceof Error ? err.message : String(err)} -- retry in ${wait / 1000}s\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** the one file inside a zip (central directory -> local header -> inflate) */
export function unzipFirst(buf: Buffer): string {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("bad zip");
  const cd = buf.readUInt32LE(e + 16);
  const method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + csize);
  return (method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
}

/** OI snapshots (coins) by timestamp, from `from` (a UTC day start) to `to` */
export async function oiSnapshots(symbol: string, from: number, to: number, histPeriod: "1h" | "5m" = "1h"): Promise<Map<number, number>> {
  const m = new Map<number, number>(), dir = path.join("data", "metrics", symbol);
  fs.mkdirSync(dir, { recursive: true });
  let lastArchived = from - D;
  for (let d = from; d < to; d += D) {
    const f = path.join(dir, `${day(d)}.csv`);
    let csv: string | null = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
    if (csv === null) {
      const r = await retry(`${symbol} OI ${day(d)}`, () => vision.get(`/data/futures/um/daily/metrics/${symbol}/${symbol}-metrics-${day(d)}.zip`));
      if (r.status === 404) continue;
      csv = unzipFirst(Buffer.from(r.data));
      fs.writeFileSync(f, csv);
    }
    for (const line of csv.split("\n")) {
      const v = line.split(",");
      const ts = Date.parse(`${v[0]?.replace(" ", "T")}Z`), oi = Number(v[2]);
      if (Number.isFinite(ts) && oi > 0) m.set(ts, oi);
    }
    lastArchived = d;
    process.stderr.write(`\r${symbol} OI archive ${day(d)}   `);
  }
  process.stderr.write("\n");
  // days not archived yet: Binance's own history (1h by default; 5m when a tool needs 15-minute OI, e.g. today)
  const step = histPeriod === "5m" ? 400 * 5 * 60_000 : 400 * H;
  for (let s = Math.max(lastArchived + D, to - 29 * D); s < to; s += step) {
    const r = await retry(`${symbol} OI hist`, () => fapi.get<Array<{ sumOpenInterest: string; timestamp: number }>>("/futures/data/openInterestHist", { params: { symbol, period: histPeriod, startTime: s, endTime: Math.min(to, s + step), limit: 500 } }));
    for (const x of r.data) if (!m.has(x.timestamp)) m.set(x.timestamp, Number(x.sumOpenInterest));
  }
  return m;
}

export interface Kline { t: number; open: number; high: number; low: number; close: number }
export async function klines(symbol: string, interval: "1m" | "5m" | "15m" | "1h", from: number, to: number): Promise<Kline[]> {
  const step = interval === "1m" ? 60_000 : interval === "5m" ? 5 * 60_000 : interval === "15m" ? 15 * 60_000 : H;
  const out: Kline[] = [];
  for (let s = from; s < to;) {
    const r = await retry(`${symbol} ${interval} klines`, () => fapi.get<Array<[number, string, string, string, string]>>("/fapi/v1/klines", { params: { symbol, interval, startTime: s, endTime: to - 1, limit: 1500 } }));
    if (!r.data.length) break;
    for (const k of r.data) if (k[0] + step <= to) out.push({ t: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4] });
    s = r.data[r.data.length - 1][0] + step;
  }
  return out;
}

/** OI at time x: the snapshot at x, else the last one in the 5 minutes... up to `back` ms before */
export function oiAt(snap: Map<number, number>, x: number, back = H): number {
  for (let y = x; y > x - back; y -= 5 * 60_000) { const v = snap.get(y); if (v !== undefined) return v; }
  return NaN;
}
