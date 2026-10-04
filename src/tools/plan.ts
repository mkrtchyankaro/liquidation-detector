/**
 * THE PLAN (Johnny, Oct 4 2026) -- a backtest the way live would run it. Read-only: our DB (minute bars, OI) + Binance's
 * public 4h klines. No BTC-led part; BTC and ETH give no signals (their data is still used for "moved on its own").
 *   SHORT  the live ALT rule: a rise > TP %, OI up RANK 1 (12h), OI below its peak, the close 1 ATR off the top, moved on
 *          its own
 *   LONG   NEW (src/research/oi-impulse.ts): a flush (a fall > TP % with OI DOWN, RANK 1 in 12h), the price may stay low,
 *          then a GREEN candle whose OI rise is the biggest of the 12h before it, within --lookback h of the flush's low
 *          (12 and 24 both shown), the low not broken, moved on its own
 *   4h zones, known at the signal (only 4h candles closed by then): every zone of 3+ touches (src/research/zones.ts,
 *          bodies, 0.8 ATR apart, at most 1.6 ATR tall); STRONG = a flip (2+ from below AND 2+ from above) built over
 *          >= 10 days (first -> last touch; the friend's rule)
 *          WALL = a zone between the entry and the TP (the TP would have to go through it)
 *          dist = the LONG's entry above the nearest strong zone under it, in 4h ATR
 * Trades: SL --pct / TP --tp from the entry, minute by minute (same minute = SL), one trade at a time per coin.
 *
 *   npx tsx src/tools/plan.ts
 *   options: --tf 15  --pct 1  --tp 2  --window 12  --fee 0.05  --new (new coins too)  --list
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
import { impulseLongs } from "../research/oi-impulse";
import { simTrade } from "../research/sltp";
import {
  atrSeries,
  pivots,
  zoneQuality,
  zones,
  type ZCandle,
} from "../research/zones";
import {
  moveOf,
  ownMove,
  signalsOf,
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
  H4 = 4 * 3_600_000,
  SKIP = ["BTCUSDT", "ETHUSDT"];

interface Z {
  lo: number;
  hi: number;
  strong: boolean;
}
interface Row {
  sym: string;
  t: number;
  side: "LONG" | "SHORT";
  kind: string;
  price: number;
  exit: string;
  net: number;
  wallAny: boolean;
  wallStrong: boolean;
  dist: number;
  nZones: number;
}

/** the zones of 3+ touches known at t, each marked strong or not, and the 4h ATR */
function zonesAt(c4: readonly ZCandle[], t: number): { zs: Z[]; atr: number } {
  const known = c4.filter((x) => x.t + H4 <= t);
  if (known.length < 30) return { zs: [], atr: NaN };
  const a = atrSeries(known, 14),
    atr = a[a.length - 1];
  const zs = zones(pivots(known, 1, 14), atr, 0.8, 3, 1.6).map((z) => {
    const q = zoneQuality(known, z, atr);
    return {
      lo: z.lo,
      hi: z.hi,
      strong: q.res >= 2 && q.sup >= 2 && q.life >= 10,
    };
  });
  return { zs, atr };
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
      .filter((x) => x && !SKIP.includes(x))) {
      const bars = await load(s);
      if (
        !bars.length ||
        (!argv.includes("--new") && bars[0].t > btc[0].t + DAY)
      )
        continue; // as live: old coins only
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
        kind: string;
        price: number;
      }> = [];
      for (const g of signalsOf(c, win, { entry: "atr", topCandleOi: false }))
        if (
          g.side === "SHORT" &&
          own(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "SHORT", turn: g }, { coinPct: NaN }) >
            tpPct
        )
          sigs.push({ t: g.t, side: "SHORT", kind: "SHORT", price: g.price });
      for (const lb of [12, 24])
        for (const g of impulseLongs(c, {
          windowH: win,
          lookbackH: lb,
          minMovePct: tpPct,
        }))
          if (own(g.startT, g.t))
            sigs.push({
              t: g.t,
              side: "LONG",
              kind: `LONG ${lb}h`,
              price: g.price,
            });
      for (const kind of ["SHORT", "LONG 12h", "LONG 24h"]) {
        let busy = 0; // each kind traded on its own (one trade per coin at a time), so the kinds can be compared
        for (const g of sigs
          .filter((x) => x.kind === kind)
          .sort((a, b) => a.t - b.t)) {
          if (busy > g.t) continue;
          const sl =
            g.side === "SHORT"
              ? g.price * (1 + pct / 100)
              : g.price * (1 - pct / 100);
          const tpPrice =
            g.side === "SHORT"
              ? g.price * (1 - tpPct / 100)
              : g.price * (1 + tpPct / 100);
          const tr = simTrade(
            bars,
            g.t,
            g.price,
            sl,
            tpPct / pct,
            g.side === "SHORT" ? "DOWN" : "UP",
          );
          busy = tr.exitT;
          const { zs, atr } = zonesAt(c4, g.t);
          const between = (z: Z): boolean =>
            g.side === "SHORT"
              ? z.hi >= tpPrice && z.lo < g.price
              : z.lo <= tpPrice && z.hi > g.price;
          const below = zs
            .filter((z) => z.strong && z.hi <= g.price)
            .sort((a, b) => b.hi - a.hi)[0];
          rows.push({
            sym: s.replace(/USDT$/, ""),
            t: g.t,
            side: g.side,
            kind,
            price: g.price,
            exit: tr.exit,
            net: tr.r - (2 * fee) / pct,
            wallAny: zs.some(between),
            wallStrong: zs.some((z) => z.strong && between(z)),
            dist: below ? (g.price - below.hi) / atr : NaN,
            nZones: zs.length,
          });
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    console.log(
      `THE PLAN · ${tf}m · SL ${pct}% · TP ${tpPct}% · RANK 1 ${win}h · fee ${fee}%/side · ${argv.includes("--new") ? "all coins" : "old coins (as live)"} · no BTC / ETH signals · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `zones known at the signal · STRONG = flip (2+ / 2+) built over >= 10 days · WALL = a zone between the entry and the TP\n`,
    );
    if (argv.includes("--list"))
      for (const r of [...rows].sort((a, b) => a.t - b.t))
        console.log(
          `  ${utc(r.t)} ${r.sym.padEnd(6)} ${r.kind.padEnd(8)} ${r.exit.padEnd(4)} ${sp(r.net).padStart(6)}R · wall ${r.wallStrong ? "STRONG" : r.wallAny ? "zone" : "-"} · strong zone below ${Number.isFinite(r.dist) ? `${r.dist.toFixed(1)} ATR` : "none"}`,
        );
    const closed = rows.filter((r) => r.exit !== "OPEN");
    const line = (name: string, l: Row[]): string => {
      const tp = l.filter((r) => r.exit === "TP").length;
      return `  ${name.padEnd(42)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(l.length - tp).padStart(3)} · win ${l.length ? Math.round((100 * tp) / l.length) : 0}% · net ${sp(l.reduce((s, r) => s + r.net, 0)).padStart(7)}R`;
    };
    const med = (v: number[]): number => {
      const x = v.filter(Number.isFinite).sort((a, b) => a - b);
      return x.length ? x[Math.floor(x.length / 2)] : NaN;
    };
    for (const kind of ["SHORT", "LONG 12h", "LONG 24h"]) {
      const l = closed.filter((r) => r.kind === kind);
      console.log(`${argv.includes("--list") ? "\n" : ""}── ${kind} ──`);
      console.log(line("all", l));
      console.log(
        line(
          "no wall (no zone between entry and TP)",
          l.filter((r) => !r.wallAny),
        ),
      );
      console.log(
        line(
          "a zone in the way",
          l.filter((r) => r.wallAny),
        ),
      );
      console.log(
        line(
          "no STRONG wall",
          l.filter((r) => !r.wallStrong),
        ),
      );
      console.log(
        line(
          "a STRONG zone in the way",
          l.filter((r) => r.wallStrong),
        ),
      );
      if (kind !== "SHORT") {
        const m = med(l.map((r) => r.dist));
        console.log(
          line(
            `a strong zone below, <= ${m.toFixed(1)} ATR (median)`,
            l.filter((r) => r.dist <= m),
          ),
        );
        console.log(
          line(
            `a strong zone below, further`,
            l.filter((r) => r.dist > m),
          ),
        );
        console.log(
          line(
            "no strong zone below",
            l.filter((r) => !Number.isFinite(r.dist)),
          ),
        );
      }
    }
    console.log(
      `\nTHE PLAN TOGETHER (SHORT no strong wall + LONG 12h / 24h no strong wall), one coin may hold one of each`,
    );
    for (const lb of ["LONG 12h", "LONG 24h"])
      console.log(
        line(
          `SHORT + ${lb}`,
          closed.filter(
            (r) => (r.kind === "SHORT" || r.kind === lb) && !r.wallStrong,
          ),
        ),
      );
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
