/**
 * IS THE 1% SL TOO TIGHT ON THE NEW COINS? (Johnny, Oct 4 2026). Read-only, our DB. The live ALT SHORT signals (rise >
 * TP %, OI up RANK 1, close 1 ATR off the top, moved on its own) on every coin but BTC / ETH, split old / new (new = its
 * data starts more than a day after BTC's). For each: the 15m ATR at the entry (% of the price) and how fast a 1% SL was
 * hit. Then the same entries with the SL sized by that ATR (x1, x1.5, x2) and the TP at 2 x the SL (the same RR as 1 / 2).
 * net R uses each trade's own risk for the fees (2 x fee / SL%).
 *
 *   npx tsx src/tools/sl-test.ts
 *   options: --tf 15  --tp 2 (the min move, as live)  --window 12  --fee 0.05  --side SHORT|LONG  --list
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { atrBefore, candles, type MinBar } from "../research/dc15";
import { flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
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
const DAY = 86_400_000,
  SKIP = ["BTCUSDT", "ETHUSDT"];

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const tf = Number(arg("tf", "15")),
    tpPct = Number(arg("tp", "2")),
    win = Number(arg("window", "12")),
    fee = Number(arg("fee", "0.05"));
  const side = arg("side", "SHORT").toUpperCase() as "SHORT" | "LONG";
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
    const MODES: Array<[string, (atrPct: number) => number]> = [
      ["SL 1% / TP 2%", () => 1],
      ["SL 1 ATR / TP 2 ATR", (a) => a],
      ["SL 1.5 ATR / TP 3 ATR", (a) => 1.5 * a],
      ["SL 2 ATR / TP 4 ATR", (a) => 2 * a],
    ];
    interface R {
      sym: string;
      isNew: boolean;
      t: number;
      atrPct: number;
      res: Array<{ exit: string; net: number; mins: number }>;
    }
    const rows: R[] = [];
    for (const s of (process.env.SYMBOLS ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x && !SKIP.includes(x))) {
      const bars = await load(s);
      if (!bars.length) continue;
      const isNew = bars[0].t > btc[0].t + DAY,
        map = new Map(bars.map((b) => [b.t, b.close])),
        c = candles(bars, tf),
        atr = atrBefore(c, 14);
      const atrAt = new Map(c.map((x, i) => [x.end, (100 * atr[i]) / x.close]));
      const own = (startT: number, t: number): boolean =>
        !!ownMove(
          { moveStartT: startT, candleEnd: t } as V10Turn,
          map,
          btcMap,
          1,
        );
      const sigs =
        side === "SHORT"
          ? signalsOf(c, win, { entry: "atr", topCandleOi: false }).filter(
              (g) =>
                g.side === "SHORT" &&
                own(g.startT, g.t) &&
                moveOf(
                  { kind: "OWN", side: "SHORT", turn: g },
                  { coinPct: NaN },
                ) > tpPct,
            )
          : flushSignals(c, V10_K, V10_ATR_N, win, {
              rank: true,
              side: "LONG",
            }).filter(
              (g) =>
                own(g.startT, g.t) &&
                moveOf(
                  { kind: "OWN", side: "LONG", turn: g },
                  { coinPct: NaN },
                ) > tpPct,
            );
      const busy = MODES.map(() => 0);
      for (const g of sigs) {
        const atrPct = atrAt.get(g.t) ?? NaN;
        if (!(atrPct > 0)) continue;
        const res = MODES.map(([, f], k) => {
          if (busy[k] > g.t) return { exit: "busy", net: NaN, mins: NaN };
          const slPct = f(atrPct),
            sl =
              side === "SHORT"
                ? g.price * (1 + slPct / 100)
                : g.price * (1 - slPct / 100);
          const tr = simTrade(
            bars,
            g.t,
            g.price,
            sl,
            2,
            side === "SHORT" ? "DOWN" : "UP",
          );
          busy[k] = tr.exitT;
          return {
            exit: tr.exit,
            net: tr.r - (2 * fee) / slPct,
            mins: (tr.exitT - g.t) / 60_000,
          };
        });
        rows.push({ sym: s.replace(/USDT$/, ""), isNew, t: g.t, atrPct, res });
      }
    }
    const med = (v: number[]): number => {
      const x = v.filter(Number.isFinite).sort((a, b) => a - b);
      return x.length ? x[Math.floor(x.length / 2)] : NaN;
    };
    console.log(
      `${side} signals (live ALT rule) · ${tf}m · no BTC / ETH · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC · TP = 2 x SL · fee ${fee}%/side\n`,
    );
    for (const grp of [false, true]) {
      const l = rows.filter((r) => r.isNew === grp);
      console.log(
        `── ${grp ? "NEW coins" : "OLD coins"}: ${l.length} signals · 15m ATR at the entry: median ${med(l.map((r) => r.atrPct)).toFixed(2)}% · a 1% SL hit after median ${med(l.filter((r) => r.res[0].exit === "SL").map((r) => r.res[0].mins)).toFixed(0)} min ──`,
      );
      MODES.forEach(([name], k) => {
        const d = l
            .map((r) => r.res[k])
            .filter((x) => x.exit !== "busy" && x.exit !== "OPEN"),
          tp = d.filter((x) => x.exit === "TP").length;
        console.log(
          `  ${name.padEnd(24)} ${String(d.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(d.length - tp).padStart(3)} · win ${d.length ? Math.round((100 * tp) / d.length) : 0}% · net ${sp(d.reduce((a, x) => a + x.net, 0)).padStart(7)}R`,
        );
      });
      if (argv.includes("--list"))
        for (const r of l)
          console.log(
            `    ${utc(r.t)} ${r.sym.padEnd(6)} ATR ${r.atrPct.toFixed(2)}% · ${r.res.map((x) => (x.exit === "busy" ? "  -  " : `${x.exit} ${x.exit === "SL" || x.exit === "TP" ? `${x.mins.toFixed(0)}m` : ""}`)).join(" | ")}`,
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
