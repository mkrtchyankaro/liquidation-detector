/**
 * OUR V10 RULES x THE 4h ZONE, ALL COINS, THE ZONE KNOWN AT THE SIGNAL (Johnny, Oct 4 2026). Read-only: our DB
 * (minute bars, OI) for the signals + Binance's public 4h klines for the zones.
 *   signals  exactly ours: SHORT = the live ALT rule (rise > TP %, OI up RANK 1, close 1 ATR off the top), LONG = flush
 *            (fall > TP %, OI down RANK 1, then OI up + 1 ATR); both moved on their own (BTC opposite / R2 < 0.5)
 *   zone     at each signal, from the 4h candles CLOSED before it only (no look-ahead): src/research/zones.ts mainZone
 *            (the latest zone with 3+ touches, bodies, 0.8 ATR apart, at most 1.6 ATR tall) + its measured quality:
 *            res / sup touches, resD (days the resistance was tested over), react (median ATR), score
 *   dist     where the entry is vs the zone, in 4h ATR: + = above the zone's top, - = below its bottom, 0 = inside
 * Trades: SL --pct / TP --tp from the entry, minute by minute (same minute = SL), one trade at a time per coin.
 * Then: does the zone separate TP from SL? Groups split at the MEDIAN of each measure (no thresholds made up).
 *
 *   npx tsx src/tools/zone-v10-all.ts
 *   options: --tf 15  --pct 1  --tp 2  --window 12  --fee 0.05  --old (only coins with BTC's history, as live)  --list
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
import { flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
import {
  mainZone,
  zoneQuality,
  type ZCandle,
  type ZoneQuality,
} from "../research/zones";
import {
  moveOf,
  ownMove,
  signalsOf,
  V10_ATR_N,
  V10_K,
  type V10Turn,
} from "../strategy/v10/v10-engine";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const DAY = 86_400_000,
  H4 = 4 * 3_600_000;

interface Row {
  sym: string;
  t: number;
  side: "LONG" | "SHORT";
  price: number;
  exit: string;
  net: number;
  zone: boolean;
  q: ZoneQuality | null;
  dist: number;
  lo: number;
  hi: number;
  isNew: boolean;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const tf = Number(arg("tf", "15")),
    pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2")),
    win = Number(arg("window", "12")),
    fee = Number(arg("fee", "0.05"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const load = async (symbol: string): Promise<MinBar[]> =>
      (
        await db
          .collection(MINUTE_BARS)
          .find({ symbol, high: { $ne: null } })
          .project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1 })
          .sort({ ts: 1 })
          .toArray()
      ).map((d) => ({
        t: (d.ts as Date).getTime(),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        oiFirst: Number(d.oiFirst),
        oiLast: Number(d.oiLast),
      }));
    const btc = await load("BTCUSDT"),
      btcMap = new Map(btc.map((b) => [b.t, b.close]));
    const rows: Row[] = [];
    for (const s of (process.env.SYMBOLS ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x && x !== "BTCUSDT")) {
      const bars = await load(s);
      if (!bars.length) continue;
      const isNew = bars[0].t > btc[0].t + DAY;
      if (argv.includes("--old") && isNew) continue;
      const raw: unknown[][] = (
        await fapi.get("/fapi/v1/klines", {
          params: {
            symbol: s,
            interval: "4h",
            startTime: bars[0].t - 90 * DAY,
            limit: 1500,
          },
        })
      ).data;
      const c4: ZCandle[] = raw.map((r) => ({
        t: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      }));
      const map = new Map(bars.map((b) => [b.t, b.close])),
        c = candles(bars, tf);
      const own = (startT: number, t: number): boolean =>
        !!ownMove(
          { moveStartT: startT, candleEnd: t } as V10Turn,
          map,
          btcMap,
          1,
        );
      const sigs: Array<{
        t: number;
        side: "LONG" | "SHORT";
        price: number;
        ext: number;
      }> = [];
      for (const g of signalsOf(c, win, { entry: "atr", topCandleOi: false }))
        if (
          g.side === "SHORT" &&
          own(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "SHORT", turn: g }, { coinPct: NaN }) >
            tpPct
        )
          sigs.push({ t: g.t, side: "SHORT", price: g.price, ext: g.extreme });
      for (const g of flushSignals(c, V10_K, V10_ATR_N, win, {
        rank: true,
        side: "LONG",
      }))
        if (
          own(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "LONG", turn: g }, { coinPct: NaN }) >
            tpPct
        )
          sigs.push({ t: g.t, side: "LONG", price: g.price, ext: g.extreme });
      sigs.sort((a, b) => a.t - b.t);
      let busy = 0;
      for (const g of sigs) {
        if (busy > g.t) continue;
        const sl =
          g.side === "SHORT"
            ? g.price * (1 + pct / 100)
            : g.price * (1 - pct / 100);
        const tr = simTrade(
          bars,
          g.t,
          g.price,
          sl,
          tpPct / pct,
          g.side === "SHORT" ? "DOWN" : "UP",
        );
        busy = tr.exitT;
        // the zone as it was known at the signal: only 4h candles closed by then
        const known = c4.filter((x) => x.t + H4 <= g.t),
          mz = mainZone(known);
        const q = mz ? zoneQuality(known, mz.z, mz.atr) : null;
        const dist = mz
          ? g.price > mz.z.hi
            ? (g.price - mz.z.hi) / mz.atr
            : g.price < mz.z.lo
              ? (g.price - mz.z.lo) / mz.atr
              : 0
          : NaN;
        const zone = mz
          ? g.side === "SHORT"
            ? g.ext > mz.z.hi
            : g.ext <= mz.z.hi && g.price >= mz.z.lo
          : false;
        rows.push({
          sym: s.replace(/USDT$/, ""),
          t: g.t,
          side: g.side,
          price: g.price,
          exit: tr.exit,
          net: tr.r - (2 * fee) / pct,
          zone,
          q,
          dist,
          lo: mz?.z.lo ?? NaN,
          hi: mz?.z.hi ?? NaN,
          isNew,
        });
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const closed = rows.filter((r) => r.exit !== "OPEN");
    console.log(
      `V10 SIGNALS x 4h ZONE (known at the signal) · ${tf}m · SL ${pct}% · TP ${tpPct}% · RANK 1 ${win}h · ${argv.includes("--old") ? "old coins only (as live)" : "all coins"} · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `dist = entry vs the zone in 4h ATR (+ above, - below, 0 inside) · groups split at the median of each measure\n`,
    );
    if (argv.includes("--list")) {
      for (const r of rows) {
        const q = r.q;
        console.log(
          `  ${utc(r.t)} ${r.sym.padEnd(6)}${r.isNew ? "*" : " "} ${r.side.padEnd(5)} ${r.exit.padEnd(4)} ${sp(r.net).padStart(6)}R · zone ${q ? `${+r.lo.toPrecision(5)}–${+r.hi.toPrecision(5)} res ${q.res} sup ${q.sup} resD ${q.resD.toFixed(0)} react ${q.react.toFixed(1)} score ${q.score.toFixed(1)} · dist ${sp(r.dist, 1)} ATR` : "none"}`,
        );
      }
      console.log("");
    }
    const line = (name: string, l: Row[]): string => {
      const tp = l.filter((r) => r.exit === "TP").length;
      return `  ${name.padEnd(44)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(l.length - tp).padStart(3)} · win ${l.length ? Math.round((100 * tp) / l.length) : 0}% · net ${sp(l.reduce((s, r) => s + r.net, 0)).padStart(7)}R`;
    };
    const med = (v: number[]): number => {
      const x = v.filter(Number.isFinite).sort((a, b) => a - b);
      return x.length ? x[Math.floor(x.length / 2)] : NaN;
    };
    for (const side of ["SHORT", "LONG"] as const) {
      const l = closed.filter((r) => r.side === side),
        z = l.filter((r) => r.q);
      if (!l.length) continue;
      console.log(`── ${side} ──`);
      console.log(line("all", l));
      console.log(
        line(
          "no zone known at the signal",
          l.filter((r) => !r.q),
        ),
      );
      console.log(
        line(
          side === "SHORT" ? "the top above the zone" : "the low at the zone",
          l.filter((r) => r.zone),
        ),
      );
      console.log(
        line(
          side === "SHORT"
            ? "the top NOT above the zone"
            : "the low NOT at the zone",
          l.filter((r) => r.q && !r.zone),
        ),
      );
      const split = (
        name: string,
        f: (q: ZoneQuality, r: Row) => number,
      ): void => {
        const m = med(z.map((r) => f(r.q!, r)));
        console.log(
          line(
            `${name} >= ${m.toFixed(1)} (median)`,
            z.filter((r) => f(r.q!, r) >= m),
          ),
        );
        console.log(
          line(
            `${name} <  ${m.toFixed(1)}`,
            z.filter((r) => f(r.q!, r) < m),
          ),
        );
      };
      split("score", (q) => q.score);
      split("resD (days)", (q) => q.resD);
      split("react (ATR)", (q) => q.react);
      split("min(res, sup)", (q) => Math.min(q.res, q.sup));
      split("dist from the zone (ATR)", (_q, r) => Math.abs(r.dist));
      console.log("");
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
