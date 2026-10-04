/**
 * ONE ZONE PER 10 DAYS vs THE ZONES NOW (Johnny, Oct 4 2026). Read-only: our DB (minute bars, OI) + Binance's public
 * 4h klines. Each signal is checked with the 4h candles CLOSED before it only (no look-ahead).
 *   signals  as live: SHORT = the ALT rule (rise > TP %, OI up RANK 1, 1 ATR off the top, own move);
 *            LONG = flush (fall > TP % with OI down RANK 1, then OI up + 1 ATR, own move); no BTC / ETH
 *   NOW      every zone of 3+ touches; SHORT skipped if ANY lies between the entry and the TP; LONG only with a STRONG
 *            zone (flip 2+/2+, >= 10 days) under the entry within --atr 4h ATRs
 *   NEW      ONE zone: of the last --days days, the zone touched the most times (3+) (src/research/zones.ts zoneOfDays)
 *            SHORT skipped if it lies between the entry and the TP; LONG only if it is under the entry (or the entry is
 *            in it) within --atr 4h ATRs. Also shown: the same with only a FLIP zone (touched from below AND above)
 * Trades: SL --pct / TP --tp, minute by minute (same minute = SL), one trade at a time per coin and side.
 *
 *   npx tsx src/tools/zone10-test.ts
 *   options: --days 10  --atr 7  --tf 15  --pct 1  --tp 2  --window 12  --fee 0.05  --new (new coins too)  --list
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
import { flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
import { zoneOfDays, type ZCandle } from "../research/zones";
import { zoneViewOf, zoneWall } from "../strategy/v10/v10-zone";
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
const fmt = (v: number): string => String(+v.toPrecision(5));
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const DAY = 86_400_000,
  H4 = 4 * 3_600_000,
  SKIP = ["BTCUSDT", "ETHUSDT"];

interface Row {
  sym: string;
  t: number;
  side: "LONG" | "SHORT";
  exit: string;
  net: number;
  nowPass: boolean;
  /** the 10-day zone: none / its box, touches, flip, where it is */
  z: {
    lo: number;
    hi: number;
    n: number;
    res: number;
    sup: number;
    flip: boolean;
  } | null;
  wall: boolean;
  dist: number;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const days = Number(arg("days", "10")),
    maxAtr = Number(arg("atr", "7"));
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
      .filter((x) => x && !SKIP.includes(x))) {
      const bars = await load(s);
      if (
        !bars.length ||
        (!argv.includes("--new") && bars[0].t > btc[0].t + DAY)
      )
        continue;
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
      const sigs: Array<{ t: number; side: "LONG" | "SHORT"; price: number }> =
        [];
      for (const g of signalsOf(c, win, { entry: "atr", topCandleOi: false }))
        if (
          g.side === "SHORT" &&
          own(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "SHORT", turn: g }, { coinPct: NaN }) >
            tpPct
        )
          sigs.push({ t: g.t, side: "SHORT", price: g.price });
      for (const g of flushSignals(c, V10_K, V10_ATR_N, win, {
        rank: true,
        side: "LONG",
      }))
        if (
          own(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "LONG", turn: g }, { coinPct: NaN }) >
            tpPct
        )
          sigs.push({ t: g.t, side: "LONG", price: g.price });
      for (const side of ["SHORT", "LONG"] as const) {
        let busy = 0;
        for (const g of sigs
          .filter((x) => x.side === side)
          .sort((a, b) => a.t - b.t)) {
          if (busy > g.t) continue;
          const sl =
            side === "SHORT"
              ? g.price * (1 + pct / 100)
              : g.price * (1 - pct / 100);
          const tp =
            side === "SHORT"
              ? g.price * (1 - tpPct / 100)
              : g.price * (1 + tpPct / 100);
          const tr = simTrade(
            bars,
            g.t,
            g.price,
            sl,
            tpPct / pct,
            side === "SHORT" ? "DOWN" : "UP",
          );
          busy = tr.exitT;
          // NOW: exactly the live filters
          const v = zoneViewOf(c4, g.t, g.price);
          const nowPass =
            side === "SHORT"
              ? !zoneWall(v, "SHORT", g.price, tp)
              : v?.strongBelowAtr != null && v.strongBelowAtr <= maxAtr;
          // NEW: one zone of the last `days` days
          const known = c4.filter((x) => x.t + H4 <= g.t),
            r = zoneOfDays(known, days);
          let z: Row["z"] = null,
            wall = false,
            dist = NaN;
          if (r) {
            const res = r.z.pivots.filter((p) => p.kind === "TOP").length,
              sup = r.z.pivots.length - res;
            z = {
              lo: r.z.lo,
              hi: r.z.hi,
              n: r.z.pivots.length,
              res,
              sup,
              flip: res >= 2 && sup >= 2,
            };
            wall =
              side === "SHORT"
                ? r.z.hi >= tp && r.z.lo < g.price
                : r.z.lo <= tp && r.z.hi > g.price;
            dist =
              g.price > r.z.hi
                ? (g.price - r.z.hi) / r.atr
                : g.price < r.z.lo
                  ? (g.price - r.z.lo) / r.atr
                  : 0;
          }
          rows.push({
            sym: s.replace(/USDT$/, ""),
            t: g.t,
            side,
            exit: tr.exit,
            net: tr.r - (2 * fee) / pct,
            nowPass,
            z,
            wall,
            dist,
          });
        }
      }
      await new Promise((res) => setTimeout(res, 150));
    }

    console.log(
      `ONE ZONE PER ${days} DAYS vs THE ZONES NOW · ${tf}m · SL ${pct}% · TP ${tpPct}% · fee ${fee}%/side · ${argv.includes("--new") ? "all coins" : "old coins (as live)"} · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `dist = entry vs the ${days}-day zone in 4h ATR (+ above it, - below, 0 inside) · LONG passes with the zone under it within ${maxAtr} ATR\n`,
    );
    if (argv.includes("--list"))
      for (const r of [...rows].sort((a, b) => a.t - b.t))
        console.log(
          `  ${utc(r.t)} ${r.sym.padEnd(6)} ${r.side.padEnd(5)} ${r.exit.padEnd(4)} ${sp(r.net).padStart(6)}R · now ${r.nowPass ? "pass" : "SKIP"} · ${days}d zone ${r.z ? `${fmt(r.z.lo)}–${fmt(r.z.hi)} ${r.z.n} touches (${r.z.res} below / ${r.z.sup} above)${r.z.flip ? " FLIP" : ""} · dist ${sp(r.dist, 1)} ATR${r.wall ? " · in the TP's way" : ""}` : "none"}`,
        );
    const closed = rows.filter((r) => r.exit !== "OPEN");
    const line = (name: string, l: Row[]): string => {
      const tp = l.filter((r) => r.exit === "TP").length;
      return `  ${name.padEnd(50)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(l.length - tp).padStart(3)} · win ${l.length ? Math.round((100 * tp) / l.length) : 0}% · net ${sp(l.reduce((a, r) => a + r.net, 0)).padStart(7)}R`;
    };
    const near = (r: Row): boolean =>
      Number.isFinite(r.dist) && r.dist >= 0 && r.dist <= maxAtr;
    for (const side of ["SHORT", "LONG"] as const) {
      const l = closed.filter((r) => r.side === side);
      console.log(`${argv.includes("--list") ? "\n" : ""}── ${side} ──`);
      console.log(line("all (no zone filter)", l));
      console.log(
        line(
          "NOW: passes the live filter",
          l.filter((r) => r.nowPass),
        ),
      );
      console.log(
        line(
          "NOW: skipped",
          l.filter((r) => !r.nowPass),
        ),
      );
      console.log(
        line(
          `no ${days}-day zone (3+ touches) at all`,
          l.filter((r) => !r.z),
        ),
      );
      if (side === "SHORT") {
        console.log(
          line(
            `NEW: passes (the ${days}-day zone NOT in the TP's way)`,
            l.filter((r) => !r.wall),
          ),
        );
        console.log(
          line(
            "NEW: skipped (the zone in the TP's way)",
            l.filter((r) => r.wall),
          ),
        );
        console.log(
          line(
            "NEW FLIP only: passes (no FLIP zone in the way)",
            l.filter((r) => !(r.wall && r.z?.flip)),
          ),
        );
        console.log(
          line(
            "NEW FLIP only: skipped",
            l.filter((r) => r.wall && r.z?.flip),
          ),
        );
      } else {
        console.log(
          line(
            `NEW: passes (the zone under the entry, <= ${maxAtr} ATR)`,
            l.filter(near),
          ),
        );
        console.log(
          line(
            "NEW: skipped",
            l.filter((r) => !near(r)),
          ),
        );
        console.log(
          line(
            "NEW FLIP only: passes",
            l.filter((r) => near(r) && r.z?.flip),
          ),
        );
        console.log(
          line(
            "NEW FLIP only: skipped",
            l.filter((r) => !(near(r) && r.z?.flip)),
          ),
        );
        console.log(
          line(
            "the entry INSIDE the zone (dist 0)",
            l.filter((r) => r.dist === 0),
          ),
        );
        console.log(
          line(
            "the entry BELOW the zone",
            l.filter((r) => r.dist < 0),
          ),
        );
      }
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
