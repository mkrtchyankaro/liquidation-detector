/**
 * OI COMPARE — read-only. The same symbol and hours from 3 sources, side by side (UTC):
 *   DB       our minute_bars (OI polled ~1/s from Binance, condensed per minute)
 *   API      Binance /futures/data/openInterestHist (period 5m, only the last 30 days)
 *   ARCHIVE  data.binance.vision daily "metrics" files (5m, months/years back; yesterday at the latest)
 *
 *   npx tsx src/tools/oi-compare.ts --symbol BTC --from "04 Oct 18:00" --to "05 Oct 04:00"
 *
 * Per hour it prints the OI each source reports for the moment H:00, and for API / ARCHIVE also the row
 * whose timestamp says H:00. At the end: median difference vs DB when a row stamped T is read as OI at T,
 * and when it is read as OI at T+5m (shows which moment a 5m row really describes).
 * Only find() on Mongo and public GET requests to Binance. Nothing is written anywhere.
 */
import "dotenv/config";
import { inflateRawSync } from "zlib";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";

const M = 60_000,
  M5 = 5 * M,
  H = 60 * M;
const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MON: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
function parseUtc(s: string): number {
  let m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = s
    .trim()
    .match(
      /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(?:(\d{4})\s+)?(\d{1,2}):(\d{2})$/,
    );
  if (m && MON[m[2].toLowerCase()] !== undefined)
    return Date.UTC(
      m[3] ? +m[3] : new Date().getUTCFullYear(),
      MON[m[2].toLowerCase()],
      +m[1],
      +m[4],
      +m[5],
    );
  throw new Error(
    `cannot parse "${s}" (use "2026-10-04 20:00" or "04 Oct 20:00", UTC)`,
  );
}
const iso = (t: number) =>
  new Date(t).toISOString().slice(0, 16).replace("T", " ");
const n0 = (v?: number) =>
  v === undefined
    ? "-"
    : v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const dp = (a?: number, b?: number) =>
  a === undefined || b === undefined
    ? "-"
    : `${a >= b ? "+" : ""}${((a / b - 1) * 100).toFixed(3)}%`;
const median = (x: number[]) => {
  if (!x.length) return NaN;
  const s = [...x].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Binance API: 5m OI rows, timestamp -> sumOpenInterest (coins). */
async function apiRows(
  symbol: string,
  from: number,
  to: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let s = from; s <= to; s += 400 * M5) {
    const e = Math.min(to, s + 399 * M5);
    const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=500&startTime=${s}&endTime=${e}`;
    const r = await fetch(url);
    if (!r.ok) {
      console.log(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
      break;
    }
    for (const row of (await r.json()) as {
      timestamp: number;
      sumOpenInterest: string;
    }[])
      out.set(Number(row.timestamp), Number(row.sumOpenInterest));
  }
  return out;
}

/** First file of a zip (the archive zips hold one CSV). */
function unzipFirst(buf: Buffer): string {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("bad zip");
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10),
    size = buf.readUInt32LE(cd + 20),
    loc = buf.readUInt32LE(cd + 42);
  const start =
    loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
  const data = buf.subarray(start, start + size);
  return (method === 0 ? data : inflateRawSync(data)).toString("utf8");
}

/** Binance archive: daily metrics files, create_time -> sum_open_interest (coins). */
async function archiveRows(
  symbol: string,
  from: number,
  to: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (
    let d = Math.floor(from / 86_400_000) * 86_400_000;
    d <= to;
    d += 86_400_000
  ) {
    const day = new Date(d).toISOString().slice(0, 10);
    const r = await fetch(
      `https://data.binance.vision/data/futures/um/daily/metrics/${symbol}/${symbol}-metrics-${day}.zip`,
    );
    if (!r.ok) {
      console.log(`ARCHIVE ${day}: ${r.status} (not published yet?)`);
      continue;
    }
    for (const line of unzipFirst(Buffer.from(await r.arrayBuffer()))
      .trim()
      .split("\n")
      .slice(1)) {
      const c = line.split(",");
      out.set(Date.parse(c[0].replace(" ", "T") + "Z"), Number(c[2]));
    }
  }
  return out;
}

async function main() {
  let symbol = (arg("symbol") ?? "").toUpperCase();
  if (!symbol || !arg("from") || !arg("to")) {
    console.log(
      'usage: npx tsx src/tools/oi-compare.ts --symbol BTC --from "04 Oct 18:00" --to "05 Oct 04:00"',
    );
    process.exit(1);
  }
  if (!symbol.endsWith("USDT")) symbol += "USDT";
  const from = Math.floor(parseUtc(arg("from")!) / H) * H,
    to = Math.ceil(parseUtc(arg("to")!) / H) * H;

  // DB: OI at the start of each minute (oiFirst) and at its end (oiLast)
  const client = new MongoClient(
    process.env.MONGO_URI ?? "mongodb://localhost:27017",
  );
  await client.connect();
  const db = new Map<number, { first?: number; last?: number }>();
  try {
    const rows = await client
      .db(process.env.MONGO_OWN_DB ?? "liquidation_detector")
      .collection(MINUTE_BARS)
      .find({ symbol, ts: { $gte: new Date(from - H), $lt: new Date(to + H) } })
      .project({ _id: 0, ts: 1, oiFirst: 1, oiLast: 1 })
      .toArray();
    for (const r of rows)
      db.set(new Date(r.ts).getTime(), {
        first: r.oiFirst ?? undefined,
        last: r.oiLast ?? undefined,
      });
  } finally {
    await client.close();
  }
  const dbAt = (t: number) => db.get(t)?.first ?? db.get(t - M)?.last; // OI at the exact moment t

  const [api, arc] = await Promise.all([
    apiRows(symbol, from - H, to + H),
    archiveRows(symbol, from - H, to + H),
  ]);
  console.log(
    `\n${symbol}  ${iso(from)} → ${iso(to)} UTC   DB minutes ${db.size}, API rows ${api.size}, ARCHIVE rows ${arc.size}`,
  );
  console.log(
    `API / ARCHIVE "row H:00" = the row whose timestamp is H:00;  "vs DB" = difference to our DB at H:00 and at H:05\n`,
  );
  const head = [
    "moment UTC",
    "DB at H:00",
    "DB at H:05",
    "API row H:00",
    "API vs DB H:00",
    "API vs DB H:05",
    "ARCH row H:00",
    "ARCH vs DB H:00",
    "ARCH vs DB H:05",
  ];
  const rows: string[][] = [];
  for (let t = from; t <= to; t += H) {
    const d0 = dbAt(t),
      d5 = dbAt(t + M5),
      a = api.get(t),
      r = arc.get(t);
    rows.push([
      iso(t),
      n0(d0),
      n0(d5),
      n0(a),
      dp(a, d0),
      dp(a, d5),
      n0(r),
      dp(r, d0),
      dp(r, d5),
    ]);
  }
  const w = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (c: string[]) =>
    c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join("  ");
  console.log(line(head));
  console.log(w.map((x) => "-".repeat(x)).join("  "));
  rows.forEach((r) => console.log(line(r)));

  // every 5m row in the window: which moment does it match in our DB?
  console.log("\nAll 5m rows in the window, median |difference| to our DB:");
  for (const [name, src] of [
    ["API", api],
    ["ARCHIVE", arc],
  ] as const) {
    const res = [-5, 0, 5, 10].map((k) => {
      const e: number[] = [];
      for (const [t, v] of src) {
        if (t < from || t > to) continue;
        const d = dbAt(t + k * M);
        if (d) e.push(Math.abs(v / d - 1) * 100);
      }
      return `row T vs DB at T${k >= 0 ? "+" : ""}${k}m: ${median(e).toFixed(4)}% (n=${e.length})`;
    });
    console.log(`  ${name.padEnd(8)} ${res.join("   ")}`);
  }
  const both = [...api.keys()].filter(
    (t) => arc.has(t) && t >= from && t <= to,
  );
  if (both.length)
    console.log(
      `  API vs ARCHIVE (same timestamp): median |diff| ${median(both.map((t) => Math.abs(api.get(t)! / arc.get(t)! - 1) * 100)).toFixed(4)}% (n=${both.length})`,
    );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
