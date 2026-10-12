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
 * Sources (read-only):
 *   price   Binance futures klines (same candles as TradingView, Binance last price)
 *   OI      Binance /futures/data/openInterestHist 5m (in COINS; Binance keeps only the last ~30 days):
 *           OI open = value at candle start, OI close = value at candle end, high/low over the 5m points in between
 *   liq     our DB: liq_raw_events (every event, kept ~14 days); older candles fall back to minute_bars sums.
 *           Column "liq" says which: R = raw events, M = minute_bars.
 * LONG liq = longs liquidated (forced sells), SHORT liq = shorts liquidated (forced buys).
 * Only find() on Mongo and public GET requests to Binance — nothing is written anywhere.
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import axios from "axios";
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

const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 30_000,
});
const M5 = 300_000;
const toMs = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));

interface Row {
  hour: number;
  liqSrc: string;
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
  const from = Math.floor(parseUtc(fromS) / HOUR) * HOUR;
  const to = Math.ceil(parseUtc(toS) / HOUR) * HOUR;
  if (to <= from) throw new Error("--to must be after --from");

  const client = new MongoClient(
    process.env.MONGO_URI ?? "mongodb://localhost:27017",
  );
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    // price: Binance klines
    const rows: Row[] = [];
    for (let h = from; h < to; h += HOUR)
      rows.push({
        hour: h,
        liqSrc: "-",
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
    for (let s0 = from; s0 < to; s0 += 1000 * HOUR) {
      const kl: unknown[][] = (
        await fapi.get("/fapi/v1/klines", {
          params: {
            symbol,
            interval: tfName,
            startTime: s0,
            endTime: Math.min(to, s0 + 1000 * HOUR) - 1,
            limit: 1000,
          },
        })
      ).data;
      for (const k of kl) {
        const r = rows[Math.floor((Number(k[0]) - from) / HOUR)];
        if (r) {
          r.open = Number(k[1]);
          r.high = Number(k[2]);
          r.low = Number(k[3]);
          r.close = Number(k[4]);
        }
      }
    }
    // OI: Binance 5m history
    const oi = new Map<number, number>();
    const oiFrom = Math.max(from, Date.now() - 30 * 86_400_000 + M5);
    for (let s0 = oiFrom; s0 <= to; s0 += 499 * M5) {
      const hist: { timestamp: number; sumOpenInterest: string }[] = (
        await fapi.get("/futures/data/openInterestHist", {
          params: {
            symbol,
            period: "5m",
            limit: 500,
            startTime: s0,
            endTime: Math.min(to, s0 + 499 * M5),
          },
        })
      ).data;
      for (const x of hist)
        oi.set(Number(x.timestamp), Number(x.sumOpenInterest));
    }
    for (const r of rows) {
      const pts: number[] = [];
      for (let t = r.hour; t <= r.hour + HOUR; t += M5) {
        const v = oi.get(t);
        if (v !== undefined) pts.push(v);
      }
      r.oiOpen = oi.get(r.hour) ?? null;
      r.oiClose = oi.get(r.hour + HOUR) ?? null;
      if (pts.length) {
        r.oiHigh = Math.max(...pts);
        r.oiLow = Math.min(...pts);
      }
    }
    // liquidations: raw events where we still have them, minute_bars before that
    const oldestRaw = (
      await db
        .collection("liq_raw_events")
        .find({ symbol })
        .sort({ timestamp: 1 })
        .limit(1)
        .project({ timestamp: 1 })
        .toArray()
    )[0];
    const rawFrom = oldestRaw
      ? Math.ceil(toMs(oldestRaw.timestamp) / HOUR) * HOUR
      : Infinity; // first candle fully covered by raw events
    const raw = await db
      .collection("liq_raw_events")
      .find({
        symbol,
        victim: { $in: ["LONG", "SHORT"] },
        timestamp: { $gte: from, $lt: to },
      })
      .project({ _id: 0, timestamp: 1, victim: 1, quoteQty: 1 })
      .toArray();
    const bars =
      from < rawFrom
        ? await db
            .collection(MINUTE_BARS)
            .find({
              symbol,
              ts: {
                $gte: new Date(from),
                $lt: new Date(Math.min(to, rawFrom)),
              },
            })
            .project({
              _id: 0,
              ts: 1,
              longLiqUsd: 1,
              shortLiqUsd: 1,
              longLiqCount: 1,
              shortLiqCount: 1,
            })
            .toArray()
        : [];
    for (const r of rows) r.liqSrc = r.hour >= rawFrom ? "R" : "M";
    for (const e of raw) {
      const r = rows[Math.floor((toMs(e.timestamp) - from) / HOUR)];
      if (!r || r.liqSrc !== "R") continue;
      if (e.victim === "LONG") {
        r.longUsd += Number(e.quoteQty);
        r.longN++;
      } else {
        r.shortUsd += Number(e.quoteQty);
        r.shortN++;
      }
    }
    for (const b of bars) {
      const r = rows[Math.floor((new Date(b.ts).getTime() - from) / HOUR)];
      if (!r || r.liqSrc !== "M") continue;
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
      `\n${symbol}  ${iso(from)} → ${iso(to)} UTC   (${rows.length} candles of ${tfName} · price + OI: Binance · liquidations: our DB)`,
    );
    console.log(`start: price ${num(p0, d)}   OI ${num(oi0, 0)} coins\n`);
    const head = [
      `${tfName} candle UTC`,
      "liq",
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
      "hour_utc,liq_source,open,high,low,close,price_pct,oi_open,oi_close,oi_change,oi_change_pct,oi_change_usd,oi_high,oi_low,oi_from_start_pct,price_from_start_pct,long_liq_usd,long_liq_count,short_liq_usd,short_liq_count",
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
        r.liqSrc,
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
          r.liqSrc,
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
    const noOi = rows.filter(
      (r) => r.oiOpen === null || r.oiClose === null,
    ).length;
    if (noOi)
      console.log(
        `note: ${noOi} candle(s) without Binance OI (Binance keeps OI history only ~30 days).`,
      );
    if (rows.some((r) => r.liqSrc === "M"))
      console.log(
        `note: liq column M = from minute_bars (raw events are kept ~14 days; minute_bars can miss a few late events).`,
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
