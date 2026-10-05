/**
 * WHY DO THE LONGS FAIL? (Johnny, Oct 5 2026 -- 5 REAL ALT LONGs, all SL, the same day: BTC falling with them, the OI
 * rise in the entry candle tiny (+0.06..+0.22%), the entry at the first candle off the low, thin coins slipping).
 * Read-only: our DB + Binance's public 15m klines (the traded $ volume). The live signals (LONG = flush, SHORT = the ALT
 * rule; own move; min move to the extreme > TP; no BTC / ETH), split four ways -- each split at the data's median or
 * by sign, no number made up:
 *   btcMove   BTC's % over the move (the move's start -> the entry): with the trade's move (LONG: BTC fell too) or not
 *   btc12h    BTC's % over the 12h before the entry: the market falling (LONG) / rising (SHORT) or not
 *   r2        how much of the coin's move BTC explains (R2, 1-minute returns), at the median
 *   candleOi  the OI change in the entry candle (LONG flush: the "new positions"), at the median
 *   volume    the coin's average 15m traded $ of the 24h before the entry (thin vs thick coins), at the median
 *   confirm   wait one candle: enter at the NEXT candle's close only if it closes further the trade's way (LONG: above
 *             the entry candle's close); else no trade
 * Trades: SL --pct / TP --tp from the entry, minute by minute (same minute = SL), one trade at a time per coin.
 *
 *   npx tsx src/tools/long-test.ts
 *   options: --side LONG|SHORT  --tf 15  --pct 1  --tp 2  --window 12  --fee 0.05  --new (new coins too)  --list
 */
import "dotenv/config";
import axios from "axios";
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
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const DAY = 86_400_000,
  H = 3_600_000,
  SKIP = ["BTCUSDT", "ETHUSDT"];

interface Row {
  sym: string;
  isNew: boolean;
  t: number;
  exit: string;
  net: number;
  btcMove: number;
  btc12h: number;
  r2: number;
  candleOi: number;
  vol: number;
  conf: { exit: string; net: number } | null;
}

async function vol15(
  symbol: string,
  from: number,
  to: number,
  W: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let t = from; t < to; ) {
    const raw: unknown[][] = (
      await fapi.get("/fapi/v1/klines", {
        params: { symbol, interval: "15m", startTime: t, limit: 1500 },
      })
    ).data;
    if (!raw.length) break;
    for (const x of raw) out.set(Number(x[0]), Number(x[7]));
    const next = Number(raw[raw.length - 1][0]) + W;
    if (next <= t) break;
    t = next;
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const side = arg("side", "LONG").toUpperCase() as "LONG" | "SHORT",
    long = side === "LONG";
  const tf = Number(arg("tf", "15")),
    pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2")),
    win = Number(arg("window", "12")),
    fee = Number(arg("fee", "0.05"));
  const W = tf * 60_000;
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
    // BTC's close at or just before t (minute bars)
    const btcAt = (t: number): number => {
      for (let k = 0; k < 10; k++) {
        const v = btcMap.get(
          Math.floor(t / 60_000) * 60_000 - 60_000 - k * 60_000,
        );
        if (v) return v;
      }
      return NaN;
    };
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
        c = candles(bars, tf),
        idx = new Map(c.map((x, i) => [x.end, i]));
      const sigs = (
        long
          ? flushSignals(c, V10_K, V10_ATR_N, win, { rank: true, side: "LONG" })
          : atrSignals(c, V10_K, V10_ATR_N, win, {
              atr: "live",
              topCandleOi: false,
            }).filter((g) => g.side === "SHORT")
      ).filter((g) => (long ? -g.movePct : g.movePct) > tpPct);
      if (!sigs.length) continue;
      const vols = await vol15(
        sym,
        sigs[0].t - 2 * DAY,
        sigs[sigs.length - 1].t + W,
        W,
      );
      let busy = 0,
        busyC = 0;
      for (const g of sigs.sort((a, b) => a.t - b.t)) {
        const own = ownMove(
          { moveStartT: g.startT, candleEnd: g.t } as V10Turn,
          map,
          btcMap,
          1,
        );
        if (!own) continue;
        const dir = long ? "UP" : "DOWN";
        const sl = (p: number): number =>
          long ? p * (1 - pct / 100) : p * (1 + pct / 100);
        let exit = "busy",
          net = NaN;
        if (busy <= g.t) {
          const tr = simTrade(
            bars,
            g.t,
            g.price,
            sl(g.price),
            tpPct / pct,
            dir,
          );
          busy = tr.exitT;
          exit = tr.exit;
          net = tr.r - (2 * fee) / pct;
        }
        // wait one candle: the next candle must close further the trade's way
        let conf: Row["conf"] = null;
        const i = idx.get(g.t);
        if (i !== undefined && i + 1 < c.length && busyC <= c[i + 1].end) {
          const nx = c[i + 1];
          if (long ? nx.close > g.price : nx.close < g.price) {
            const tr = simTrade(
              bars,
              nx.end,
              nx.close,
              sl(nx.close),
              tpPct / pct,
              dir,
            );
            busyC = tr.exitT;
            conf = { exit: tr.exit, net: tr.r - (2 * fee) / pct };
          } else conf = { exit: "NO", net: 0 };
        }
        let vs = 0,
          vn = 0;
        for (let o = Math.floor(g.t / W) * W - W; o >= g.t - DAY; o -= W) {
          const x = vols.get(o);
          if (Number.isFinite(x)) {
            vs += x!;
            vn++;
          }
        }
        const b0 = btcAt(g.startT),
          b1 = btcAt(g.t),
          b12 = btcAt(g.t - win * H);
        rows.push({
          sym: sym.replace(/USDT$/, ""),
          isNew,
          t: g.t,
          exit,
          net,
          btcMove: (100 * (b1 - b0)) / b0,
          btc12h: (100 * (b1 - b12)) / b12,
          r2: own.follow,
          candleOi: g.candleOiPct,
          vol: vn >= 48 ? vs / vn : NaN,
          conf,
        });
      }
    }

    const sg = long ? -1 : 1; // "with the trade's move": LONG = BTC fell (the coin fell), SHORT = BTC rose
    console.log(
      `${side} · ${tf}m · SL ${pct}% · TP ${tpPct}% · fee ${fee}%/side · ${argv.includes("--new") ? "all coins" : "old coins (as live)"} · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC\n`,
    );
    const line = (
      name: string,
      l: Array<{ exit: string; net: number }>,
    ): string => {
      const d = l.filter((r) => r.exit === "TP" || r.exit === "SL"),
        tp = d.filter((r) => r.exit === "TP").length;
      return `  ${name.padEnd(52)} ${String(d.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(d.length - tp).padStart(3)} · win ${d.length ? Math.round((100 * tp) / d.length) : 0}% · net ${sp(d.reduce((a, r) => a + r.net, 0)).padStart(7)}R`;
    };
    const med = (v: number[]): number => {
      const x = v.filter(Number.isFinite).sort((a, b) => a - b);
      return x.length ? x[Math.floor(x.length / 2)] : NaN;
    };
    const l = rows.filter((r) => r.exit === "TP" || r.exit === "SL");
    console.log(line("all (as live)", l));
    const word = long ? "fell" : "rose";
    console.log(`\nBTC over the move (the move's start -> the entry):`);
    console.log(
      line(
        `  BTC ${word} too (with the move)`,
        l.filter((r) => sg * r.btcMove > 0),
      ),
    );
    console.log(
      line(
        `  BTC did not`,
        l.filter((r) => !(sg * r.btcMove > 0)),
      ),
    );
    const bm = med(l.map((r) => sg * r.btcMove));
    console.log(
      line(
        `  BTC with the move >= ${bm.toFixed(2)}% (median)`,
        l.filter((r) => sg * r.btcMove >= bm),
      ),
    );
    console.log(
      line(
        `  less`,
        l.filter((r) => sg * r.btcMove < bm),
      ),
    );
    console.log(`\nBTC over the ${win}h before the entry (the market):`);
    console.log(
      line(
        `  BTC ${word} (the market ${long ? "falling" : "rising"})`,
        l.filter((r) => sg * r.btc12h > 0),
      ),
    );
    console.log(
      line(
        `  BTC did not`,
        l.filter((r) => !(sg * r.btc12h > 0)),
      ),
    );
    const rm = med(l.map((r) => r.r2));
    console.log(`\nR2 with BTC (1m returns), median ${rm.toFixed(2)}:`);
    console.log(
      line(
        `  R2 >= ${rm.toFixed(2)} (more with BTC)`,
        l.filter((r) => r.r2 >= rm),
      ),
    );
    console.log(
      line(
        `  R2 <  ${rm.toFixed(2)}`,
        l.filter((r) => r.r2 < rm),
      ),
    );
    const om = med(l.map((r) => Math.abs(r.candleOi)));
    console.log(`\nthe entry candle's OI change, |median| ${om.toFixed(2)}%:`);
    console.log(
      line(
        `  |OI| >= ${om.toFixed(2)}%`,
        l.filter((r) => Math.abs(r.candleOi) >= om),
      ),
    );
    console.log(
      line(
        `  |OI| <  ${om.toFixed(2)}%`,
        l.filter((r) => Math.abs(r.candleOi) < om),
      ),
    );
    const vm = med(l.map((r) => r.vol));
    console.log(
      `\nthe coin's average 15m traded $ (24h before), median $${(vm / 1e3).toFixed(0)}k:`,
    );
    console.log(
      line(
        `  thick (>= median)`,
        l.filter((r) => r.vol >= vm),
      ),
    );
    console.log(
      line(
        `  thin`,
        l.filter((r) => r.vol < vm),
      ),
    );
    const cf = rows
      .map((r) => r.conf)
      .filter((x): x is NonNullable<Row["conf"]> => !!x);
    console.log(
      `\nwait one candle (enter at the next close only if it went further the trade's way):`,
    );
    console.log(
      line(
        `  confirmed -> traded`,
        cf.filter((x) => x.exit !== "NO"),
      ),
    );
    console.log(
      `  not confirmed -> no trade: ${cf.filter((x) => x.exit === "NO").length} signals`,
    );
    if (argv.includes("--list")) {
      console.log("");
      for (const r of [...rows].sort((a, b) => a.t - b.t))
        console.log(
          `  ${utc(r.t)} ${r.sym.padEnd(6)}${r.isNew ? "*" : " "} ${r.exit.padEnd(4)} ${sp(r.net).padStart(6)}R · BTC move ${sp(r.btcMove)}% · BTC ${win}h ${sp(r.btc12h)}% · R2 ${r.r2.toFixed(2)} · OI ${sp(r.candleOi)}% · vol $${Number.isFinite(r.vol) ? (r.vol / 1e3).toFixed(0) : "?"}k · wait1: ${r.conf ? `${r.conf.exit}${r.conf.exit === "NO" ? "" : ` ${sp(r.conf.net)}R`}` : "n/a"}`,
        );
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
