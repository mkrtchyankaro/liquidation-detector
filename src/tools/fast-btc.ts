/**
 * FAST TRADE test: BTC's 15-minute candle -> SHORT/LONG a coin right away (Johnny, Oct 1 2026). Read-only, our own
 * minute_bars (price, OI, real liquidations). Rule: src/research/fast-btc.ts. Compared with the baseline: the same
 * entries/SL/TP from EVERY 15-minute candle, always LONG and always SHORT (what "no signal" gives).
 *
 *   npx tsx src/tools/fast-btc.ts --coin DOGE --days 14 --tp 2.5
 *   options: --base BTC  --risk 10  --timestop 24 (hours, 0 = none)  --minsl 0 (skip SL closer than this %)  --list
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  candles15,
  fastTrades,
  type FBar,
  type FastTrade,
} from "../research/fast-btc";
import type { TpOpts } from "../research/v9-tp-sim";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sym = (s: string): string =>
  s.toUpperCase().endsWith("USDT") ? s.toUpperCase() : `${s.toUpperCase()}USDT`;
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const base = sym(arg("base", "BTC")),
    coin = sym(arg("coin", "DOGE")),
    days = Number(arg("days", "14")),
    ts = Number(arg("timestop", "24"));
  const minSl = Number(arg("minsl", "0"));
  const o: TpOpts = {
    tpR: Number(arg("tp", "2.5")),
    minSlPct: 0,
    maxOpen: null,
    timeStopH: ts > 0 ? ts : null,
    riskUsd: Number(arg("risk", "10")),
  };
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const since = Date.now() - days * 86_400_000;
    const load = async (s: string): Promise<FBar[]> =>
      (
        await db
          .collection(MINUTE_BARS)
          .find({
            symbol: s,
            ts: { $gte: new Date(since) },
            close: { $ne: null },
          })
          .sort({ ts: 1 })
          .toArray()
      ).map((r) => ({
        t: num(r.ts),
        open: Number(r.open ?? r.close),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        oiFirst: Number(r.oiFirst ?? NaN),
        oiLast: Number(r.oiLast ?? NaN),
        longLiq: Number(r.longLiqUsd ?? 0),
        shortLiq: Number(r.shortLiqUsd ?? 0),
      }));
    const [b, c] = [await load(base), await load(coin)];
    if (!b.length || !c.length)
      throw new Error(
        `no minute_bars for ${base} or ${coin} in the last ${days} days`,
      );
    const btc15 = candles15(b);
    const slOk = (x: FastTrade): boolean =>
      (100 * Math.abs(x.trade.entry - x.trade.sl)) / x.trade.entry > minSl;
    const show = (name: string, all: FastTrade[]): void => {
      const tr = all.filter(slOk),
        done = tr.filter((x) => x.res.status !== "OPEN"),
        R = done.reduce((s, x) => s + x.res.r, 0);
      const n = (s: string): number =>
        done.filter((x) => x.res.status === s).length;
      const sls = tr
        .map(
          (x) => (100 * Math.abs(x.trade.entry - x.trade.sl)) / x.trade.entry,
        )
        .sort((a, z) => a - z);
      console.log(
        `${name.padEnd(30)} ${String(done.length).padStart(4)} trades · TP ${n("TP")} · SL ${n("SL")} · time ${n("TIME")} · win ${done.length ? Math.round((100 * n("TP")) / done.length) : 0}% · ${sR(R)} ($${(R * o.riskUsd).toFixed(0)}) · per trade ${done.length ? sR(R / done.length) : "-"} · median SL ${sls.length ? sls[Math.floor(sls.length / 2)].toFixed(2) : "-"}%`,
      );
    };
    const rule = fastTrades(btc15, c, o);
    const firstDay = new Date(b[0].t).toISOString().slice(0, 16);
    console.log(
      `FAST: ${base.replace(/USDT$/, "")} 15-min candle -> ${coin.replace(/USDT$/, "")} · data from ${firstDay} UTC · TP ${o.tpR}R · SL = ${coin.replace(/USDT$/, "")}'s 15-min candle extreme${minSl > 0 ? ` (only SL > ${minSl}%)` : ""} · fees included · one trade at a time\n`,
    );
    show("RULE (BTC 15m: price+OI+liq)", rule.trades);
    show(
      "  of which SHORT",
      rule.trades.filter((x) => x.side === "SHORT"),
    );
    show(
      "  of which LONG",
      rule.trades.filter((x) => x.side === "LONG"),
    );
    console.log(
      `  (${rule.skippedBusy} signals skipped while a trade was open; BTC 15m candles: ${btc15.length}, signals: ${btc15.filter((x) => x.minutes === 15).length ? rule.trades.length + rule.skippedBusy : 0})`,
    );
    console.log("");
    show("BASELINE every candle, LONG", fastTrades(btc15, c, o, "LONG").trades);
    show(
      "BASELINE every candle, SHORT",
      fastTrades(btc15, c, o, "SHORT").trades,
    );
    if (argv.includes("--list")) {
      console.log("");
      for (const x of rule.trades.filter(slOk))
        console.log(
          `  ${utc(x.trade.createdAt + 1)} ${x.side.padEnd(5)} BTC ${((100 * (x.btc.close - x.btc.open)) / x.btc.open).toFixed(2)}% OI ${((100 * (x.btc.oiTo - x.btc.oiFrom)) / x.btc.oiFrom).toFixed(2)}% liq L $${Math.round(x.btc.longLiq / 1000)}K / S $${Math.round(x.btc.shortLiq / 1000)}K -> entry ${x.trade.entry} SL ${x.trade.sl} (${((100 * Math.abs(x.trade.entry - x.trade.sl)) / x.trade.entry).toFixed(2)}%) -> ${x.res.status} ${sR(x.res.r)}`,
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
