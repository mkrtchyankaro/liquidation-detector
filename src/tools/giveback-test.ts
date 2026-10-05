/**
 * HOW MUCH OF THE MOVE WAS ALREADY GIVEN BACK AT THE ENTRY? + SHORTS OPEN AT THE SAME TIME (Johnny, Oct 5 2026).
 * Live Oct 4-5: the 3 SHORT TPs had given back 16-38% of their move at the entry, the 5 SLs 39-63% -- 8 trades, the
 * line seen AFTER the results, so it is checked here on the whole history (groups by quartiles / the median of the
 * data, no number made up). Read-only, our DB. The live signals (SHORT = the ALT rule, LONG = flush; own move; min move
 * to the top > TP; no BTC / ETH).
 *   giveback  = (top - entry) / (top - the move's start)   (a LONG: (entry - low) / (start - low))
 *   together  = how many OTHER trades of the same side (any coin) were open at the entry
 *   maxOpen   = the portfolio replayed in time: a signal is skipped when N trades of its side are already open
 * Trades: SL --pct / TP --tp from the entry, minute by minute (same minute = SL), one trade at a time per coin and side.
 *
 *   npx tsx src/tools/giveback-test.ts
 *   options: --tf 15  --pct 1  --tp 2  --window 12  --fee 0.05  --new (new coins too)  --list
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
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

interface Row {
  sym: string;
  isNew: boolean;
  side: "LONG" | "SHORT";
  t: number;
  exitT: number;
  exit: string;
  net: number;
  give: number;
  move: number;
  together: number;
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
    for (const sym of (process.env.SYMBOLS ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x && !SKIP.includes(x))) {
      const bars = await load(sym);
      if (!bars.length) continue;
      const isNew = bars[0].t > btc[0].t + DAY;
      if (isNew && !argv.includes("--new")) continue;
      const map = new Map(bars.map((b) => [b.t, b.close])),
        c = candles(bars, tf);
      const own = (startT: number, t: number): boolean =>
        !!ownMove(
          { moveStartT: startT, candleEnd: t } as V10Turn,
          map,
          btcMap,
          1,
        );
      const sigs = [
        ...atrSignals(c, V10_K, V10_ATR_N, win, {
          atr: "live",
          topCandleOi: false,
        }).filter((g) => g.side === "SHORT"),
        ...flushSignals(c, V10_K, V10_ATR_N, win, { rank: true, side: "LONG" }),
      ].filter(
        (g) =>
          own(g.startT, g.t) &&
          (g.side === "SHORT" ? g.movePct : -g.movePct) > tpPct,
      );
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
          const tr = simTrade(
            bars,
            g.t,
            g.price,
            sl,
            tpPct / pct,
            side === "SHORT" ? "DOWN" : "UP",
          );
          busy = tr.exitT;
          const start = g.extreme / (1 + g.movePct / 100);
          rows.push({
            sym: sym.replace(/USDT$/, ""),
            isNew,
            side,
            t: g.t,
            exitT: tr.exitT,
            exit: tr.exit,
            net: tr.r - (2 * fee) / pct,
            give: (g.extreme - g.price) / (g.extreme - start),
            move: Math.abs(g.movePct),
            together: 0,
          });
        }
      }
    }
    // how many other trades of the same side were open at each entry (any coin)
    for (const r of rows)
      r.together = rows.filter(
        (o) => o !== r && o.side === r.side && o.t <= r.t && o.exitT > r.t,
      ).length;

    console.log(
      `GIVEBACK + TOGETHER · ${tf}m · SL ${pct}% · TP ${tpPct}% · fee ${fee}%/side · ${argv.includes("--new") ? "all coins" : "old coins (as live)"} · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `giveback = how much of the move (start -> top) the price had already given back at the entry\n`,
    );
    const line = (name: string, l: Row[]): string => {
      const d = l.filter((r) => r.exit !== "OPEN"),
        tp = d.filter((r) => r.exit === "TP").length;
      return `  ${name.padEnd(40)} ${String(d.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(d.length - tp).padStart(3)} · win ${d.length ? Math.round((100 * tp) / d.length) : 0}% · net ${sp(d.reduce((a, r) => a + r.net, 0)).padStart(7)}R`;
    };
    const q = (v: number[], p: number): number => {
      const x = [...v].sort((a, b) => a - b);
      return x[Math.min(x.length - 1, Math.floor(p * x.length))];
    };
    for (const side of ["SHORT", "LONG"] as const) {
      const l = rows.filter((r) => r.side === side && r.exit !== "OPEN");
      if (!l.length) continue;
      console.log(`── ${side} ──`);
      console.log(line("all", l));
      const g = l.map((r) => r.give),
        q1 = q(g, 0.25),
        q2 = q(g, 0.5),
        q3 = q(g, 0.75),
        P = (v: number): string => `${Math.round(100 * v)}%`;
      console.log(`  giveback by quarter (the data's own quartiles):`);
      console.log(
        line(
          `  Q1  < ${P(q1)}`,
          l.filter((r) => r.give < q1),
        ),
      );
      console.log(
        line(
          `  Q2  ${P(q1)} .. ${P(q2)}`,
          l.filter((r) => r.give >= q1 && r.give < q2),
        ),
      );
      console.log(
        line(
          `  Q3  ${P(q2)} .. ${P(q3)}`,
          l.filter((r) => r.give >= q2 && r.give < q3),
        ),
      );
      console.log(
        line(
          `  Q4  >= ${P(q3)}`,
          l.filter((r) => r.give >= q3),
        ),
      );
      console.log(
        line(
          `  below the median ${P(q2)}`,
          l.filter((r) => r.give < q2),
        ),
      );
      console.log(
        line(
          `  the median and above`,
          l.filter((r) => r.give >= q2),
        ),
      );
      console.log(
        line(
          `  < 40% (the live Oct 4-5 hypothesis)`,
          l.filter((r) => r.give < 0.4),
        ),
      );
      console.log(
        line(
          `  >= 40%`,
          l.filter((r) => r.give >= 0.4),
        ),
      );
      console.log(`  other ${side}s open at the entry:`);
      for (const [name, f] of [
        ["0", (n: number) => n === 0],
        ["1", (n: number) => n === 1],
        ["2", (n: number) => n === 2],
        ["3+", (n: number) => n >= 3],
      ] as Array<[string, (n: number) => boolean]>)
        console.log(
          line(
            `  ${name}`,
            l.filter((r) => f(r.together)),
          ),
        );
      // the portfolio replayed in time with a cap on open trades of this side
      console.log(`  max open ${side}s at a time (replayed in time):`);
      for (const cap of [1, 2, 3, 4, 5]) {
        const kept: Row[] = [];
        for (const r of [...l].sort((a, b) => a.t - b.t))
          if (kept.filter((o) => o.exitT > r.t).length < cap) kept.push(r);
        console.log(line(`  max ${cap}`, kept));
      }
      if (argv.includes("--list"))
        for (const r of [...l].sort((a, b) => a.give - b.give))
          console.log(
            `      ${utc(r.t)} ${r.sym.padEnd(6)}${r.isNew ? "*" : " "} ${r.exit.padEnd(4)} ${sp(r.net).padStart(6)}R · move ${r.move.toFixed(2)}% · given back ${P(r.give).padStart(4)} · ${r.together} other open`,
          );
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
