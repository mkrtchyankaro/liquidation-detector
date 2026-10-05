/**
 * WHO MOVED OI INSIDE THE ENTRY CANDLE? (Johnny, Oct 5 2026 -- ALGO LONG 17:00: the entry candle was green with OI +0.06%,
 * but it ran up, left a long upper wick and the sellers won -- maybe the OI was added by NEW SHORTS on the way down).
 * Read-only, our DB. The NEW strategy's signals (from Oct 5 16:51 UTC: the live rules + oiCandle + giveback < 50%, both
 * sides; SHORT = the ALT rule, LONG = flush; own move; min move > TP; no BTC / ETH), then inside the entry candle:
 *   up   = the OI change summed over the steps where the price went UP     (buyers acting)
 *   down = the OI change summed over the steps where the price went DOWN   (sellers acting)
 *   steps = minutes (minute_bars: OI first -> last, price vs the minute before) and, where kept, seconds
 *           (oi_second_observations: OI and price, one row ~ per second)
 *   LONG  (OI rose in the candle): bad when more OI was added while the price FELL (down > up)   -> new shorts
 *   SHORT (OI fell in the candle): bad when more OI left while the price ROSE (up < down)       -> shorts covering
 *   (both are the same test: down > up = bad) -- no number made up, just which side is bigger
 * Trades: SL --pct / TP --tp from the entry, minute by minute (same minute = SL), one trade at a time per coin and side.
 *
 *   npx tsx src/tools/oi-split-test.ts
 *   options: --tf 15  --pct 1  --tp 2  --window 12  --fee 0.05  --new (new coins too)  --list
 */
import "dotenv/config";
import { MongoClient, type Db } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
import { atrSignals, flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
import {
  againstCandles,
  givebackPct,
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
  M = 60_000,
  SKIP = ["BTCUSDT", "ETHUSDT"];

interface Split {
  up: number;
  down: number;
  n: number;
}
/** the OI change while the price rose vs fell, from consecutive (t, price, oi) points; % of the OI at the start */
function split(points: Array<{ p: number; oi: number }>, base: number): Split {
  let up = 0,
    down = 0,
    n = 0;
  for (let k = 1; k < points.length; k++) {
    const dp = points[k].p - points[k - 1].p,
      d = points[k].oi - points[k - 1].oi;
    if (!(Number.isFinite(dp) && Number.isFinite(d))) continue;
    n++;
    if (dp > 0) up += d;
    else if (dp < 0) down += d;
  }
  return { up: (100 * up) / base, down: (100 * down) / base, n };
}

async function seconds(
  db: Db,
  symbol: string,
  from: number,
  to: number,
): Promise<Array<{ p: number; oi: number }>> {
  return (
    await db
      .collection("oi_second_observations")
      .find({ symbol, timestamp: { $gte: new Date(from), $lt: new Date(to) } })
      .project({ timestamp: 1, openInterest: 1, price: 1 })
      .sort({ timestamp: 1 })
      .toArray()
  )
    .map((r) => ({ p: Number(r.price), oi: Number(r.openInterest) }))
    .filter((x) => x.p > 0 && x.oi > 0);
}

interface Row {
  sym: string;
  isNew: boolean;
  side: "LONG" | "SHORT";
  t: number;
  price: number;
  bars: MinBar[];
  min: Split;
  sec: Split | null;
  candleOi: number;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const tf = Number(arg("tf", "15")),
    pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2")),
    win = Number(arg("window", "12")),
    fee = Number(arg("fee", "0.05"));
  const W = tf * M;
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
    let secMissing = 0;
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
        byEnd = new Map(c.map((x, i) => [x.end, i]));
      const sigs = [
        ...atrSignals(c, V10_K, V10_ATR_N, win, {
          atr: "live",
          topCandleOi: false,
        }).filter((g) => g.side === "SHORT" && g.movePct > tpPct),
        ...flushSignals(c, V10_K, V10_ATR_N, win, {
          rank: true,
          side: "LONG",
        }).filter((g) => -g.movePct > tpPct),
      ];
      for (const g of sigs) {
        const turn = {
          side: g.side,
          candleEnd: g.t,
          extreme: g.extreme,
          extremeT: g.extremeT,
          moveStartT: g.startT,
          movePct: g.movePct,
        } as V10Turn;
        if (
          !ownMove(
            { moveStartT: g.startT, candleEnd: g.t } as V10Turn,
            map,
            btcMap,
            1,
          )
        )
          continue;
        // the NEW strategy (Oct 5 16:51 UTC): no candle against the turn, given back < 50%
        if (
          againstCandles(bars, turn).length ||
          !(givebackPct(turn, g.price) < 50)
        )
          continue;
        const i = byEnd.get(g.t);
        if (i === undefined || i < 1) continue;
        // minutes of the entry candle; the first step is from the previous candle's close
        const mins = bars.filter((b) => b.t >= g.t - W && b.t < g.t);
        const pts = [
          { p: c[i - 1].close, oi: c[i].oi0 },
          ...mins.map((b) => ({ p: b.close, oi: b.oiLast })),
        ];
        const sec = await seconds(db, sym, g.t - W, g.t);
        if (sec.length < 60) secMissing++;
        rows.push({
          sym: sym.replace(/USDT$/, ""),
          isNew,
          side: g.side,
          t: g.t,
          price: g.price,
          bars,
          min: split(pts, c[i].oi0),
          sec: sec.length >= 60 ? split(sec, sec[0].oi) : null,
          candleOi: (100 * (c[i].oi1 - c[i].oi0)) / c[i].oi0,
        });
      }
    }

    interface Done {
      r: Row;
      exit: string;
      net: number;
    }
    const run = (keep: (r: Row) => boolean): Done[] => {
      const out: Done[] = [],
        busy = new Map<string, number>();
      for (const r of rows.filter(keep).sort((a, b) => a.t - b.t)) {
        const k = `${r.sym}|${r.side}`;
        if ((busy.get(k) ?? 0) > r.t) continue;
        const sl =
          r.side === "SHORT"
            ? r.price * (1 + pct / 100)
            : r.price * (1 - pct / 100);
        const tr = simTrade(
          r.bars,
          r.t,
          r.price,
          sl,
          tpPct / pct,
          r.side === "SHORT" ? "DOWN" : "UP",
        );
        busy.set(k, tr.exitT);
        out.push({ r, exit: tr.exit, net: tr.r - (2 * fee) / pct });
      }
      return out;
    };
    const line = (name: string, l: Done[]): string => {
      const d = l.filter((x) => x.exit !== "OPEN"),
        tp = d.filter((x) => x.exit === "TP").length;
      return `  ${name.padEnd(54)} ${String(d.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(d.length - tp).padStart(3)} · win ${d.length ? Math.round((100 * tp) / d.length) : 0}% · net ${sp(d.reduce((a, x) => a + x.net, 0)).padStart(7)}R`;
    };
    const bad = (s: Split | null): boolean | null => (s ? s.down > s.up : null);
    console.log(
      `WHO MOVED OI IN THE ENTRY CANDLE · the NEW strategy (oiCandle + giveback < 50%) · ${tf}m · SL ${pct}% · TP ${tpPct}% · ${argv.includes("--new") ? "all coins" : "old coins (as live)"} · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `up / down = the OI change (% of the candle's start OI) while the price rose / fell · bad = down > up${secMissing ? ` · seconds missing for ${secMissing} signals (the seconds rows shown only where kept)` : ""}\n`,
    );
    for (const side of ["SHORT", "LONG"] as const) {
      const base = run((r) => r.side === side);
      console.log(`── ${side} ──`);
      console.log(line("the NEW strategy (as live from Oct 5 16:51)", base));
      console.log(
        line(
          `minutes: ${side === "LONG" ? "OI added more while the price ROSE" : "OI left more while the price FELL"} (kept)`,
          run((r) => r.side === side && bad(r.min) === false),
        ),
      );
      console.log(
        line(
          `minutes: the other way -> skipped`,
          run((r) => r.side === side && bad(r.min) === true),
        ),
      );
      const withSec = rows.filter((r) => r.side === side && r.sec);
      if (withSec.length) {
        console.log(
          line(
            `seconds (only signals with second data): all`,
            run((r) => r.side === side && !!r.sec),
          ),
        );
        console.log(
          line(
            `seconds: kept`,
            run((r) => r.side === side && bad(r.sec) === false),
          ),
        );
        console.log(
          line(
            `seconds: the other way -> skipped`,
            run((r) => r.side === side && bad(r.sec) === true),
          ),
        );
      }
      if (argv.includes("--list"))
        for (const d of base) {
          const r = d.r,
            f = (s: Split | null): string =>
              s
                ? `up ${sp(s.up, 3)}% down ${sp(s.down, 3)}%${bad(s) ? " ✗" : " ✓"}`
                : "n/a";
          console.log(
            `      ${utc(r.t)} ${r.sym.padEnd(6)}${r.isNew ? "*" : " "} ${d.exit.padEnd(4)} ${sp(d.net).padStart(6)}R · candle OI ${sp(r.candleOi)}% · min: ${f(r.min)} · sec: ${f(r.sec)}`,
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
