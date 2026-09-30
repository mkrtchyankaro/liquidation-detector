/**
 * OI accumulation -> full cleanup, on Binance's OWN history (not our DB) -- read-only research.
 *   OI:     data.binance.vision daily "metrics" files (5-minute OI snapshots, years back), cached in data/metrics/;
 *           the last days that are not archived yet come from /futures/data/openInterestHist (1h).
 *   Price:  /fapi/v1/klines 1h.
 *
 *   npx tsx src/tools/oi-cleanup.ts                         (ETHUSDT, 180 days, accumulation >= 1%)
 *   npx tsx src/tools/oi-cleanup.ts --days 365 --minacc 2
 *   npx tsx src/tools/oi-cleanup.ts --symbol BTCUSDT --all  (also the unconfirmed ones)
 * Rules: src/research/oi-cleanup.ts. Times are UTC, candle OPEN times (as on the Binance chart).
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import axios from "axios";
import {
  CU_TARGETS,
  findCleanups,
  type CuEvent,
  type CuHour,
} from "../research/oi-cleanup";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SYMBOL = arg("symbol", "ETHUSDT").toUpperCase();
const DAYS = Number(arg("days", "180")),
  MIN_ACC = Number(arg("minacc", "1")),
  SHOW_ALL = argv.includes("--all");
const H = 3_600_000,
  D = 24 * H;
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const vision = axios.create({
  baseURL: "https://data.binance.vision",
  timeout: 30_000,
  responseType: "arraybuffer",
  validateStatus: (s) => s === 200 || s === 404,
});

/** the one file inside a zip (central directory -> local header -> inflate) */
function unzipFirst(buf: Buffer): string {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("bad zip");
  const cd = buf.readUInt32LE(e + 16);
  const method = buf.readUInt16LE(cd + 10),
    csize = buf.readUInt32LE(cd + 20),
    local = buf.readUInt32LE(cd + 42);
  const start =
    local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + csize);
  return (method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const t = (ms: number | null): string =>
  ms === null ? "-" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** OI snapshot (coins) by timestamp */
async function oiSnapshots(
  from: number,
  to: number,
): Promise<Map<number, number>> {
  const m = new Map<number, number>(),
    dir = path.join("data", "metrics", SYMBOL);
  fs.mkdirSync(dir, { recursive: true });
  let lastArchived = from - D;
  for (let d = from; d < to; d += D) {
    const f = path.join(dir, `${day(d)}.csv`);
    let csv: string | null = fs.existsSync(f)
      ? fs.readFileSync(f, "utf8")
      : null;
    if (csv === null) {
      const r = await vision.get(
        `/data/futures/um/daily/metrics/${SYMBOL}/${SYMBOL}-metrics-${day(d)}.zip`,
      );
      if (r.status === 404) continue;
      csv = unzipFirst(Buffer.from(r.data));
      fs.writeFileSync(f, csv);
    }
    for (const line of csv.split("\n")) {
      const v = line.split(",");
      const ts = Date.parse(`${v[0]?.replace(" ", "T")}Z`),
        oi = Number(v[2]);
      if (Number.isFinite(ts) && oi > 0) m.set(ts, oi);
    }
    lastArchived = d;
    process.stderr.write(`\rOI archive ${day(d)}   `);
  }
  process.stderr.write("\n");
  // not archived yet -> the API (last 30 days only)
  for (let s = Math.max(lastArchived + D, to - 29 * D); s < to; s += 400 * H) {
    const r = await fapi.get<
      Array<{ sumOpenInterest: string; timestamp: number }>
    >("/futures/data/openInterestHist", {
      params: {
        symbol: SYMBOL,
        period: "1h",
        startTime: s,
        endTime: Math.min(to, s + 400 * H),
        limit: 500,
      },
    });
    for (const x of r.data)
      if (!m.has(x.timestamp)) m.set(x.timestamp, Number(x.sumOpenInterest));
  }
  return m;
}

async function klines1h(
  from: number,
  to: number,
): Promise<Omit<CuHour, "oi">[]> {
  const out: Omit<CuHour, "oi">[] = [];
  for (let s = from; s < to; ) {
    const r = await fapi.get<Array<[number, string, string, string, string]>>(
      "/fapi/v1/klines",
      {
        params: {
          symbol: SYMBOL,
          interval: "1h",
          startTime: s,
          endTime: to - 1,
          limit: 1500,
        },
      },
    );
    if (!r.data.length) break;
    for (const k of r.data)
      if (k[0] + H <= to)
        out.push({
          t: k[0],
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
        });
    s = r.data[r.data.length - 1][0] + H;
  }
  return out;
}

/** OI at the hour's close: the snapshot at t+1h, else the last one inside the hour */
function oiAtClose(snap: Map<number, number>, tOpen: number): number {
  for (let x = tOpen + H; x > tOpen; x -= 5 * 60_000) {
    const v = snap.get(x);
    if (v !== undefined) return v;
  }
  return NaN;
}

const f2 = (x: number): string => (x >= 0 ? "+" : "") + x.toFixed(2);
const med = (v: number[]): number => {
  const a = [...v].sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : NaN;
};

function summary(title: string, ev: CuEvent[]): void {
  const c = ev.filter((e) => e.confirmed && e.after);
  const hits = CU_TARGETS.map((x) => {
    const h = c.filter((e) => e.after!.hit[String(x)]);
    return `+${x}%: ${h.length}/${c.length}${h.length ? ` (median ${med(h.map((e) => e.after!.hit[String(x)]!.hours))}h, against before it: median ${med(h.map((e) => e.after!.hit[String(x)]!.maeBefore)).toFixed(2)}% max ${Math.max(...h.map((e) => e.after!.hit[String(x)]!.maeBefore)).toFixed(2)}%)` : ""}`;
  });
  console.log(
    `${title.padEnd(26)} events ${ev.length}, confirmed ${c.length} | within 48h ${hits.join(" | ")}`,
  );
}

async function main(): Promise<void> {
  const to = Math.floor(Date.now() / H) * H,
    from = Math.floor((to - DAYS * D) / D) * D;
  const [snap, kl] = await Promise.all([
    oiSnapshots(from, to),
    klines1h(from, to),
  ]);
  const hours: CuHour[] = kl.map((k) => ({ ...k, oi: oiAtClose(snap, k.t) }));
  const withOi = hours.filter((h) => h.oi > 0).length;
  process.stderr.write(
    `${SYMBOL}: ${hours.length} 1h candles ${t(hours[0]?.t ?? null)} .. ${t(hours.at(-1)?.t ?? null)} UTC, OI on ${withOi}\n`,
  );
  const ev = findCleanups(hours, MIN_ACC);
  const show = SHOW_ALL ? ev : ev.filter((e) => e.confirmed);

  console.log(
    `\n=== ${SYMBOL} OI accumulation -> full cleanup, 1h, last ${DAYS} days, accumulation >= ${MIN_ACC}%, times UTC (candle open) ===`,
  );
  console.log(
    "TYPE          SIDE   OI growth: from -> peak (OI%, price%)            cleaned at (price% since peak, cleaned%)   confirm candle     entry      | 24h best/worst   48h best/worst   +1% / +1.5% / +2% after (hours, worst before)",
  );
  for (const e of show) {
    const a = e.after;
    const hit = (x: number): string => {
      const v = a?.hit[String(x)];
      return v ? `${v.hours}h/-${v.maeBefore.toFixed(2)}%` : "no";
    };
    console.log(
      `${(e.kind === "REVERSAL" ? "REVERSAL" : "CONTINUE").padEnd(12)}  ${e.side.padEnd(5)}  ${t(e.startTs)} -> ${t(e.peakTs)} (${f2(e.accPct)}%, ${f2(e.accMovePct)}%)`.padEnd(
        88,
      ) +
        `${t(e.cleanTs)} (${f2(e.cleanMovePct)}%, ${e.cleanedPct.toFixed(0)}%)`.padEnd(
          40,
        ) +
        `${e.confirmed ? t(e.confirmTs) : `not confirmed ${t(e.confirmTs)}`}`.padEnd(
          19,
        ) +
        `${e.entry === null ? "-" : e.entry}`.padEnd(11) +
        (a
          ? `| ${f2(a.mfe24)}/-${a.mae24.toFixed(2)}%    ${f2(a.mfe48)}/-${a.mae48.toFixed(2)}%    ${hit(1)}  ${hit(1.5)}  ${hit(2)}`
          : ""),
    );
  }
  console.log("");
  summary("ALL", ev);
  summary(
    "REVERSAL",
    ev.filter((e) => e.kind === "REVERSAL"),
  );
  summary(
    "CONTINUATION",
    ev.filter((e) => e.kind === "CONTINUATION"),
  );
  for (const [lo, hi] of [
    [MIN_ACC, 2],
    [2, 4],
    [4, 1e9],
  ] as const)
    if (hi > lo)
      summary(
        `OI growth ${lo}-${hi === 1e9 ? "..." : hi}%`,
        ev.filter((e) => e.accPct >= lo && e.accPct < hi),
      );

  const csv = path.join("data", `oi-cleanup-${SYMBOL}-${day(to)}.csv`);
  fs.writeFileSync(
    csv,
    [
      "kind,side,accDir,startUTC,peakUTC,cleanUTC,oiAccPct,accMovePct,cleanMovePct,cleanedPct,confirmed,confirmUTC,entry,mfe24,mae24,mfe48,mae48," +
        CU_TARGETS.map((x) => `hit${x}h,maeBefore${x}`).join(","),
    ]
      .concat(
        ev.map((e) =>
          [
            e.kind,
            e.side,
            e.accDir,
            t(e.startTs),
            t(e.peakTs),
            t(e.cleanTs),
            e.accPct.toFixed(2),
            e.accMovePct.toFixed(2),
            e.cleanMovePct.toFixed(2),
            e.cleanedPct.toFixed(0),
            e.confirmed,
            t(e.confirmTs),
            e.entry ?? "",
            e.after?.mfe24.toFixed(2) ?? "",
            e.after?.mae24.toFixed(2) ?? "",
            e.after?.mfe48.toFixed(2) ?? "",
            e.after?.mae48.toFixed(2) ?? "",
            ...CU_TARGETS.flatMap((x) => {
              const v = e.after?.hit[String(x)];
              return v ? [v.hours, v.maeBefore.toFixed(2)] : ["", ""];
            }),
          ].join(","),
        ),
      )
      .join("\n"),
  );
  console.log(
    `\nfile: ${csv}   (no SL/TP: "best" = furthest the price went our way, "worst" = furthest against us, from 1h highs/lows)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
