/**
 * FIRST CHANCE ONLY (Johnny, Oct 5 2026 -- ADA 10-05 00:30: the first candle after the top closed 2.35% back, but OI
 * was still rising (new shorts piling in) -> no entry then; the entry came 6 candles later, late, and hit the SL).
 * Read-only, our DB. The live signals (SHORT = the ALT rule, LONG = flush; own move; min move to the top > TP; no BTC /
 * ETH), two ways:
 *   NOW    as live: the entry waits until OI is below its peak (SHORT) / until a candle with OI up (LONG flush)
 *   FIRST  the FIRST candle that closes 1 ATR off the top / bottom decides: OI not right then -> that top / bottom is
 *          cancelled (src/research/atr-turn.ts firstChance)
 * Trades: SL --pct / TP --tp from the entry, minute by minute (same minute = SL), one trade at a time per coin and side,
 * each rule simulated on its own.
 *
 *   npx tsx src/tools/first-chance-test.ts
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

interface Sig {
  t: number;
  side: "LONG" | "SHORT";
  price: number;
  toTop: number;
  toEntry: number;
}
interface Row {
  sym: string;
  isNew: boolean;
  s: Sig;
  exit: string;
  net: number;
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
    const rules: Array<[string, boolean]> = [
      ["NOW: waits for OI (live)", false],
      ["FIRST: the first 1-ATR candle decides", true],
    ];
    let check = "";
    const rows: Row[][] = rules.map(() => []);
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
      // the move's start price = extreme / (1 + movePct): both % are taken from the start candle's close
      const mk = (
        side: "LONG" | "SHORT",
        g: { t: number; price: number; extreme: number; movePct: number },
      ): Sig => {
        const start = g.extreme / (1 + g.movePct / 100),
          sg = side === "SHORT" ? 1 : -1;
        return {
          t: g.t,
          side,
          price: g.price,
          toTop: sg * g.movePct,
          toEntry: (sg * 100 * (g.price - start)) / start,
        };
      };
      // sanity: the NOW SHORTs must be exactly the live ones (signalsOf)
      const live = signalsOf(c, win, {
        entry: "atr",
        topCandleOi: false,
      }).filter((g) => g.side === "SHORT").length;
      const mine = atrSignals(c, V10_K, V10_ATR_N, win, {
        atr: "live",
        topCandleOi: false,
      }).filter((g) => g.side === "SHORT").length;
      if (live !== mine) check += ` ${sym} ${live}/${mine}`;
      rules.forEach(([, first], k) => {
        const sigs: Sig[] = [];
        for (const g of atrSignals(c, V10_K, V10_ATR_N, win, {
          atr: "live",
          topCandleOi: false,
          firstChance: first,
        }))
          if (g.side === "SHORT" && own(g.startT, g.t))
            sigs.push(mk("SHORT", g));
        for (const g of flushSignals(c, V10_K, V10_ATR_N, win, {
          rank: true,
          side: "LONG",
          firstChance: first,
        }))
          if (own(g.startT, g.t)) sigs.push(mk("LONG", g));
        for (const side of ["SHORT", "LONG"] as const) {
          let busy = 0;
          for (const s of sigs
            .filter((x) => x.side === side && x.toTop > tpPct)
            .sort((a, b) => a.t - b.t)) {
            if (busy > s.t) continue;
            const sl =
              side === "SHORT"
                ? s.price * (1 + pct / 100)
                : s.price * (1 - pct / 100);
            const tr = simTrade(
              bars,
              s.t,
              s.price,
              sl,
              tpPct / pct,
              side === "SHORT" ? "DOWN" : "UP",
            );
            busy = tr.exitT;
            rows[k].push({
              sym: sym.replace(/USDT$/, ""),
              isNew,
              s,
              exit: tr.exit,
              net: tr.r - (2 * fee) / pct,
            });
          }
        }
      });
    }

    if (check)
      console.log(
        `!! the NOW SHORT signals differ from live's signalsOf:${check}`,
      );
    console.log(
      `FIRST CHANCE ONLY vs NOW · ${tf}m · SL ${pct}% · TP ${tpPct}% · fee ${fee}%/side · ${argv.includes("--new") ? "all coins" : "old coins (as live)"} · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC\n`,
    );
    const line = (name: string, l: Row[]): string => {
      const d = l.filter((r) => r.exit !== "OPEN"),
        tp = d.filter((r) => r.exit === "TP").length;
      return `  ${name.padEnd(44)} ${String(d.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(d.length - tp).padStart(3)} · win ${d.length ? Math.round((100 * tp) / d.length) : 0}% · net ${sp(d.reduce((a, r) => a + r.net, 0)).padStart(7)}R`;
    };
    const key = (r: Row): string => `${r.sym}|${r.s.side}|${r.s.t}`;
    for (const side of ["SHORT", "LONG"] as const) {
      console.log(`── ${side} ──`);
      const [now, nu] = rows.map((l) => l.filter((r) => r.s.side === side));
      console.log(line(rules[0][0], now));
      console.log(line(rules[1][0], nu));
      const inNew = new Set(nu.map(key)),
        inNow = new Set(now.map(key));
      const out = now.filter((r) => !inNew.has(key(r))),
        added = nu.filter((r) => !inNow.has(key(r)));
      console.log(line("  dropped by FIRST (in NOW only)", out));
      console.log(line("  added by FIRST (in FIRST only)", added));
      if (argv.includes("--list")) {
        for (const r of out)
          console.log(
            `      - ${utc(r.s.t)} ${r.sym.padEnd(6)}${r.isNew ? "*" : " "} ${r.exit.padEnd(4)} ${sp(r.net).padStart(6)}R · to the top ${r.s.toTop.toFixed(2)}% · to the entry ${r.s.toEntry.toFixed(2)}%`,
          );
        for (const r of added)
          console.log(
            `      + ${utc(r.s.t)} ${r.sym.padEnd(6)}${r.isNew ? "*" : " "} ${r.exit.padEnd(4)} ${sp(r.net).padStart(6)}R · to the top ${r.s.toTop.toFixed(2)}% · to the entry ${r.s.toEntry.toFixed(2)}%`,
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
