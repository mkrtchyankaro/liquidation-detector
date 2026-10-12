/**
 * HOUR VIEW — read-only, candle by candle (1h default, or --tf 4h / 15m / 1d): price, open interest, liquidations (UTC).
 *   npx tsx src/tools/hour-view.ts --symbol BTC --from "01 Oct 00:00" --to "03 Oct 00:00" --tf 4h
 *   4h candles start at 00/04/08/12/16/20 UTC (same as Binance / TradingView).
 *
 *   npx tsx src/tools/hour-view.ts --symbol BCH --from "2026-10-04 20:00" --to "2026-10-05 01:00"
 *   npx tsx src/tools/hour-view.ts --symbol BTC --from "02 Oct 01:00" --to "02 Oct 14:00" --csv bch.csv
 *
 * --symbol  BTC / BTCUSDT (USDT is added if missing)
 * --from    start of first hour, UTC  ("2026-10-04 20:00" or "04 Oct 20:00"; year = current if omitted)
 * --to      end, UTC, exclusive ("…01:00" -> last row is the 00:00–01:00 hour)
 * --csv     optional: also write the table to this CSV file
 *
 * Source: collection minute_bars (1 row per symbol per minute, kept 365 days):
 *   price open/high/low/close, OI first/last/min/max (in coins), LONG/SHORT liquidation USD + count.
 * LONG liq = longs liquidated (forced sells), SHORT liq = shorts liquidated (forced buys).
 * Only find() is used — nothing is written to the database.
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";

const TFS: Record<string, number> = {
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};
const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const MONTHS: Record<string, number> = {
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
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = t.match(
    /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(?:(\d{4})\s+)?(\d{1,2}):(\d{2})$/,
  );
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const y = m[3] ? +m[3] : new Date().getUTCFullYear();
    return Date.UTC(y, MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5]);
  }
  throw new Error(
    `cannot parse time "${s}" — use "2026-10-04 20:00" or "04 Oct 20:00" (UTC)`,
  );
}

const iso = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const num = (v: number | null, d = 2) =>
  v === null || !Number.isFinite(v)
    ? "-"
    : v.toLocaleString("en-US", {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
const pct = (v: number | null) =>
  v === null || !Number.isFinite(v)
    ? "-"
    : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const usd = (v: number) =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(1)}K`
      : `$${v.toFixed(0)}`;
const sig = (p: number) => (p >= 100 ? 2 : p >= 1 ? 4 : 6);

interface Row {
  hour: number;
  minutes: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  oiOpen: number | null;
  oiClose: number | null;
  oiHigh: number | null;
  oiLow: number | null;
  longUsd: number;
  longN: number;
  shortUsd: number;
  shortN: number;
}

async function main() {
  let symbol = (arg("symbol") ?? "").toUpperCase();
  const fromS = arg("from"),
    toS = arg("to");
  if (!symbol || !fromS || !toS) {
    console.log(
      'usage: npx tsx src/tools/hour-view.ts --symbol BCH --from "2026-10-04 20:00" --to "2026-10-05 01:00" [--tf 1h|4h|15m|1d] [--csv out.csv]',
    );
    process.exit(1);
  }
  if (!symbol.endsWith("USDT")) symbol += "USDT";
  const tfName = (arg("tf", "1h") ?? "1h").toLowerCase();
  const HOUR = TFS[tfName];
  if (!HOUR)
    throw new Error(`--tf must be one of ${Object.keys(TFS).join(", ")}`);
  const PER = HOUR / 60_000; // minutes per candle
  const from = Math.floor(parseUtc(fromS) / HOUR) * HOUR;
  const to = Math.ceil(parseUtc(toS) / HOUR) * HOUR;
  if (to <= from) throw new Error("--to must be after --from");

  const client = new MongoClient(
    process.env.MONGO_URI ?? "mongodb://localhost:27017",
  );
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const bars = await db
      .collection(MINUTE_BARS)
      .find({ symbol, ts: { $gte: new Date(from), $lt: new Date(to) } })
      .project({ _id: 0 })
      .sort({ ts: 1 })
      .toArray();

    const rows: Row[] = [];
    for (let h = from; h < to; h += HOUR)
      rows.push({
        hour: h,
        minutes: 0,
        open: null,
        high: null,
        low: null,
        close: null,
        oiOpen: null,
        oiClose: null,
        oiHigh: null,
        oiLow: null,
        longUsd: 0,
        longN: 0,
        shortUsd: 0,
        shortN: 0,
      });
    for (const b of bars) {
      const r = rows[Math.floor((new Date(b.ts).getTime() - from) / HOUR)];
      if (!r) continue;
      r.minutes++;
      if (b.open != null && r.open === null) r.open = b.open;
      if (b.high != null)
        r.high = r.high === null ? b.high : Math.max(r.high, b.high);
      if (b.low != null)
        r.low = r.low === null ? b.low : Math.min(r.low, b.low);
      if (b.close != null) r.close = b.close;
      if (b.oiFirst != null && b.oiFirst > 0 && r.oiOpen === null)
        r.oiOpen = b.oiFirst;
      if (b.oiLast != null && b.oiLast > 0) r.oiClose = b.oiLast;
      if (b.oiMax != null && b.oiMax > 0)
        r.oiHigh = r.oiHigh === null ? b.oiMax : Math.max(r.oiHigh, b.oiMax);
      if (b.oiMin != null && b.oiMin > 0)
        r.oiLow = r.oiLow === null ? b.oiMin : Math.min(r.oiLow, b.oiMin);
      r.longUsd += Number(b.longLiqUsd ?? 0);
      r.longN += Number(b.longLiqCount ?? 0);
      r.shortUsd += Number(b.shortLiqUsd ?? 0);
      r.shortN += Number(b.shortLiqCount ?? 0);
    }

    const first = rows.find((r) => r.oiOpen !== null && r.open !== null);
    const oi0 = first?.oiOpen ?? null,
      p0 = first?.open ?? null;
    const d = sig(p0 ?? 1);

    console.log(
      `\n${symbol}  ${iso(from)} → ${iso(to)} UTC   (${rows.length} candles of ${tfName}, ${bars.length} minute rows)`,
    );
    console.log(`start: price ${num(p0, d)}   OI ${num(oi0, 0)} coins\n`);
    const head = [
      `${tfName} candle UTC`,
      "min",
      "open",
      "high",
      "low",
      "close",
      "price %",
      "OI open",
      "OI close",
      "ΔOI coins",
      "ΔOI %",
      "ΔOI $",
      "OI high",
      "OI low",
      "OI from start",
      "price from start",
      "LONG liq",
      "#",
      "SHORT liq",
      "#",
    ];
    const table: string[][] = [];
    const csv: string[] = [
      "hour_utc,minutes,open,high,low,close,price_pct,oi_open,oi_close,oi_change,oi_change_pct,oi_change_usd,oi_high,oi_low,oi_from_start_pct,price_from_start_pct,long_liq_usd,long_liq_count,short_liq_usd,short_liq_count",
    ];
    let L = 0,
      Ln = 0,
      S = 0,
      Sn = 0,
      last: Row | null = null;
    for (const r of rows) {
      const dOi =
        r.oiOpen !== null && r.oiClose !== null ? r.oiClose - r.oiOpen : null;
      const dOiPct = dOi !== null && r.oiOpen ? (dOi / r.oiOpen) * 100 : null;
      const dOiUsd = dOi !== null && r.close !== null ? dOi * r.close : null;
      const pPct =
        r.open && r.close !== null ? (r.close / r.open - 1) * 100 : null;
      const oiCum =
        oi0 && r.oiClose !== null ? (r.oiClose / oi0 - 1) * 100 : null;
      const pCum = p0 && r.close !== null ? (r.close / p0 - 1) * 100 : null;
      L += r.longUsd;
      Ln += r.longN;
      S += r.shortUsd;
      Sn += r.shortN;
      if (r.close !== null) last = r;
      table.push([
        iso(r.hour).slice(5),
        String(r.minutes),
        num(r.open, d),
        num(r.high, d),
        num(r.low, d),
        num(r.close, d),
        pct(pPct),
        num(r.oiOpen, 0),
        num(r.oiClose, 0),
        dOi === null ? "-" : `${dOi >= 0 ? "+" : ""}${num(dOi, 0)}`,
        pct(dOiPct),
        dOiUsd === null
          ? "-"
          : `${dOiUsd >= 0 ? "+" : "-"}${usd(Math.abs(dOiUsd))}`,
        num(r.oiHigh, 0),
        num(r.oiLow, 0),
        pct(oiCum),
        pct(pCum),
        usd(r.longUsd),
        String(r.longN),
        usd(r.shortUsd),
        String(r.shortN),
      ]);
      csv.push(
        [
          iso(r.hour),
          r.minutes,
          r.open,
          r.high,
          r.low,
          r.close,
          pPct?.toFixed(4),
          r.oiOpen,
          r.oiClose,
          dOi?.toFixed(3),
          dOiPct?.toFixed(4),
          dOiUsd?.toFixed(0),
          r.oiHigh,
          r.oiLow,
          oiCum?.toFixed(4),
          pCum?.toFixed(4),
          r.longUsd.toFixed(0),
          r.longN,
          r.shortUsd.toFixed(0),
          r.shortN,
        ]
          .map((v) => v ?? "")
          .join(","),
      );
    }
    const w = head.map((h, i) =>
      Math.max(h.length, ...table.map((t) => t[i].length)),
    );
    const line = (c: string[]) =>
      c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join("  ");
    console.log(line(head));
    console.log(w.map((n) => "-".repeat(n)).join("  "));
    table.forEach((t) => console.log(line(t)));

    const oiEnd = last?.oiClose ?? null,
      pEnd = last?.close ?? null;
    const hi = Math.max(...rows.map((r) => r.oiHigh ?? -Infinity)),
      lo = Math.min(...rows.map((r) => r.oiLow ?? Infinity));
    console.log(
      `\nTOTAL  price ${num(p0, d)} → ${num(pEnd, d)} (${pct(p0 && pEnd ? (pEnd / p0 - 1) * 100 : null)})` +
        `   OI ${num(oi0, 0)} → ${num(oiEnd, 0)} (${pct(oi0 && oiEnd ? (oiEnd / oi0 - 1) * 100 : null)})` +
        `   OI high ${Number.isFinite(hi) ? num(hi, 0) : "-"} (${pct(oi0 && Number.isFinite(hi) ? (hi / oi0 - 1) * 100 : null)})` +
        `   OI low ${Number.isFinite(lo) ? num(lo, 0) : "-"} (${pct(oi0 && Number.isFinite(lo) ? (lo / oi0 - 1) * 100 : null)})`,
    );
    console.log(
      `       LONG liq ${usd(L)} (${Ln})   SHORT liq ${usd(S)} (${Sn})`,
    );
    const gaps = rows.filter((r) => r.minutes < PER).length;
    if (gaps)
      console.log(
        `note: ${gaps} candle(s) have fewer than ${PER} minute rows (column "min") — data gap, numbers for those hours are partial.`,
      );

    const out = arg("csv");
    if (out) {
      writeFileSync(out, csv.join("\n") + "\n");
      console.log(`CSV -> ${out}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
