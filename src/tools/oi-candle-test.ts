/**
 * THE OI CANDLE FILTERS (Johnny, Oct 5 2026). Read-only, our DB. The live signals (SHORT = the ALT rule, LONG = flush;
 * own move; min move to the extreme > TP; no BTC / ETH), then:
 *   SHORT  (Johnny: "the most important") after the top candle and before the entry candle there must be NO GREEN
 *          candle with OI DOWN (shorts closing / squeezed while the price still went up = the buyers still in control)
 *            S1 = the entry candle red with OI down   S2 = no green + OI-down candle between the top and the entry
 *            S3 = S1 + S2
 *   LONG   the mirror: after the bottom candle and before the entry candle NO RED candle with OI UP (new shorts piling in
 *          at the low)   L1 = that · L2 = L1 + the entry candle green with OI up
 * Trades: SL --pct / TP --tp from the entry, minute by minute (same minute = SL), one trade at a time per coin; each
 * rule simulated on its own.
 *
 *   npx tsx src/tools/oi-candle-test.ts
 *   options: --tf 15  --pct 1  --tp 2  --window 12  --fee 0.05  --new (new coins too)  --list
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type Candle, type MinBar } from "../research/dc15";
import { atrSignals, flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
import {
  ownMove,
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
const DAY = 86_400_000,
  SKIP = ["BTCUSDT", "ETHUSDT"];
const oiPct = (x: Candle): number =>
  x.oi0 > 0 ? (100 * (x.oi1 - x.oi0)) / x.oi0 : NaN;

interface Row {
  sym: string;
  isNew: boolean;
  side: "LONG" | "SHORT";
  t: number;
  exit: string;
  net: number;
  why: string;
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
    // every live signal with its flags; trades are simulated per rule afterwards (one at a time per coin and side)
    interface Sig {
      sym: string;
      isNew: boolean;
      bars: MinBar[];
      side: "LONG" | "SHORT";
      t: number;
      price: number;
      e1: boolean;
      e2: boolean;
      why: string;
    }
    const sigs: Sig[] = [];
    for (const sym of (process.env.SYMBOLS ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x && !SKIP.includes(x))) {
      const bars = await load(sym);
      if (!bars.length) continue;
      const isNew = bars[0].t > btc[0].t + DAY;
      if (isNew && !argv.includes("--new")) continue;
      const map = new Map(bars.map((b) => [b.t, b.close])),
        c = candles(bars, tf),
        byEnd = new Map(c.map((x, i) => [x.end, i])),
        byT = new Map(c.map((x, i) => [x.t, i]));
      const own = (startT: number, t: number): boolean =>
        !!ownMove(
          { moveStartT: startT, candleEnd: t } as V10Turn,
          map,
          btcMap,
          1,
        );
      const s = sym.replace(/USDT$/, "");
      for (const g of atrSignals(c, V10_K, V10_ATR_N, win, {
        atr: "live",
        topCandleOi: false,
      })) {
        if (g.side !== "SHORT" || !own(g.startT, g.t) || !(g.movePct > tpPct))
          continue;
        const i = byEnd.get(g.t),
          e = byT.get(g.extremeT);
        if (i === undefined || e === undefined) continue;
        // from the FIRST candle that touched the top (equal highs later are the same top)
        let e0 = e;
        for (let j = byT.get(g.startT) ?? e; j <= e; j++)
          if (c[j].high >= g.extreme) {
            e0 = j;
            break;
          }
        const x = c[i],
          bad: string[] = [];
        for (let j = e0 + 1; j < i; j++)
          if (c[j].close > c[j].open && c[j].oi1 < c[j].oi0)
            bad.push(`${utc(c[j].t).slice(6)} OI ${sp(oiPct(c[j]))}%`);
        const e1 = x.close < x.open && x.oi1 < x.oi0;
        const why = `entry ${x.close < x.open ? "red" : "green"} OI ${sp(oiPct(x))}% · ${bad.length ? `green + OI down after the top: ${bad.join(", ")}` : "no green + OI down after the top"}`;
        sigs.push({
          sym: s,
          isNew,
          bars,
          side: "SHORT",
          t: g.t,
          price: g.price,
          e1,
          e2: bad.length === 0,
          why,
        });
      }
      for (const g of flushSignals(c, V10_K, V10_ATR_N, win, {
        rank: true,
        side: "LONG",
      })) {
        if (!own(g.startT, g.t) || !(-g.movePct > tpPct)) continue;
        const i = byEnd.get(g.t),
          e = byT.get(g.extremeT);
        if (i === undefined || e === undefined) continue;
        // from the FIRST candle that touched the low (equal lows later are the same bottom) to the candle before the entry
        let e0 = e;
        for (let j = byT.get(g.startT) ?? e; j <= e; j++)
          if (c[j].low <= g.extreme) {
            e0 = j;
            break;
          }
        const x = c[i],
          bad: string[] = [];
        for (let j = e0 + 1; j < i; j++)
          if (c[j].close < c[j].open && c[j].oi1 > c[j].oi0)
            bad.push(`${utc(c[j].t).slice(6)} OI ${sp(oiPct(c[j]))}%`);
        const e1 = x.close > x.open && x.oi1 > x.oi0;
        const why = `entry ${x.close > x.open ? "green" : "red"} OI ${sp(oiPct(x))}% · ${bad.length ? `red + OI up after the bottom: ${bad.join(", ")}` : "no red + OI up after the bottom"}`;
        sigs.push({
          sym: s,
          isNew,
          bars,
          side: "LONG",
          t: g.t,
          price: g.price,
          e1,
          e2: bad.length === 0,
          why,
        });
      }
    }
    const run = (keep: (x: Sig) => boolean): Row[] => {
      const out: Row[] = [],
        busy = new Map<string, number>();
      for (const x of sigs.filter(keep).sort((a, b) => a.t - b.t)) {
        const k = `${x.sym}|${x.side}`;
        if ((busy.get(k) ?? 0) > x.t) continue;
        const sl =
          x.side === "SHORT"
            ? x.price * (1 + pct / 100)
            : x.price * (1 - pct / 100);
        const tr = simTrade(
          x.bars,
          x.t,
          x.price,
          sl,
          tpPct / pct,
          x.side === "SHORT" ? "DOWN" : "UP",
        );
        busy.set(k, tr.exitT);
        out.push({
          sym: x.sym,
          isNew: x.isNew,
          side: x.side,
          t: x.t,
          exit: tr.exit,
          net: tr.r - (2 * fee) / pct,
          why: x.why,
        });
      }
      return out;
    };

    console.log(
      `OI CANDLE FILTERS · ${tf}m · SL ${pct}% · TP ${tpPct}% · fee ${fee}%/side · ${argv.includes("--new") ? "all coins" : "old coins (as live)"} · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC\n`,
    );
    const line = (name: string, l: Row[]): string => {
      const d = l.filter((r) => r.exit !== "OPEN"),
        tp = d.filter((r) => r.exit === "TP").length;
      return `  ${name.padEnd(56)} ${String(d.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(d.length - tp).padStart(3)} · win ${d.length ? Math.round((100 * tp) / d.length) : 0}% · net ${sp(d.reduce((a, r) => a + r.net, 0)).padStart(7)}R`;
    };
    const key = (r: Row): string => `${r.sym}|${r.side}|${r.t}`;
    const list = (rows: Row[]): void => {
      if (argv.includes("--list"))
        for (const r of rows)
          console.log(
            `      ${utc(r.t)} ${r.sym.padEnd(6)}${r.isNew ? "*" : " "} ${r.exit.padEnd(4)} ${sp(r.net).padStart(6)}R · ${r.why}`,
          );
    };
    const dropped = (all: Row[], kept: Row[]): Row[] => {
      const k = new Set(kept.map(key));
      return all.filter((r) => !k.has(key(r)));
    };

    for (const side of ["SHORT", "LONG"] as const) {
      const sh = side === "SHORT";
      const all = run((x) => x.side === side),
        f1 = run((x) => x.side === side && x.e1),
        f2 = run((x) => x.side === side && x.e2),
        f3 = run((x) => x.side === side && x.e1 && x.e2);
      console.log(`${side === "LONG" ? "\n" : ""}── ${side} ──`);
      console.log(line("NOW (as live)", all));
      console.log(
        line(
          sh
            ? "1: the entry candle red with OI down"
            : "1: the entry candle green with OI up",
          f1,
        ),
      );
      console.log(
        line(
          sh
            ? "2: no GREEN + OI-down candle between the top and the entry"
            : "2: no RED + OI-up candle between the bottom and the entry",
          f2,
        ),
      );
      console.log(line("3: 1 + 2", f3));
      console.log(line("  dropped by 2 (in NOW only)", dropped(all, f2)));
      list(dropped(all, f2));
      console.log(line("  kept by 2", f2));
      list(f2);
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
