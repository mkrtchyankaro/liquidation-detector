/**
 * ONE COIN'S STORY AROUND A TOP / BOTTOM, CANDLE BY CANDLE (Johnny, Oct 4 2026). Read-only, our DB (minute_bars).
 * For "why was this a fake top" questions: price, OI and the forceOrder liquidations (USD, our stream: Binance sends at
 * most 1 liquidation per second per symbol, so the sums are LOWER than the real ones -- the picture, not the size).
 *
 *   npx tsx src/tools/v10-top-story.ts --symbol AVAXUSDT --from "2026-10-03 09:00" --to "2026-10-03 19:00" --entry "2026-10-03 12:30"
 *   options: --tf 15 (candle minutes; 5 for more detail)  --side SHORT|LONG (default SHORT: the top = the highest high
 *            before the entry; LONG: the lowest low)
 * Columns: the candle (UTC open time), colour, close, price % from the window's first close, OI % from the first
 * candle, the candle's own OI %, LONGS liquidated $, SHORTS liquidated $, BTC's candle %.
 * At the end: the sums by phase -- the rise (to the top candle), the top candle, top -> entry, after the entry.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type Candle, type MinBar } from "../research/dc15";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const ms = (s: string): number => Date.parse(`${s.replace(" ", "T")}:00Z`);
const hm = (t: number): string => new Date(t).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number, d = 2): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a");
const usd = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v > 0 ? v.toFixed(0) : "-");

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "").toUpperCase(), from = ms(arg("from", "")), to = ms(arg("to", "")), entry = argv.includes("--entry") ? ms(arg("entry", "")) : NaN;
  const tf = Number(arg("tf", "15")), side = arg("side", "SHORT").toUpperCase();
  if (!sym || !(from > 0) || !(to > from)) throw new Error('use --symbol X --from "YYYY-MM-DD HH:MM" --to "YYYY-MM-DD HH:MM" (UTC)');
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const load = async (symbol: string): Promise<MinBar[]> =>
      (await db.collection(MINUTE_BARS).find({ symbol, ts: { $gte: new Date(from), $lt: new Date(to) }, high: { $ne: null } })
        .project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 }).sort({ ts: 1 }).toArray())
        .map((d) => ({ t: (d.ts as Date).getTime(), high: Number(d.high), low: Number(d.low), close: Number(d.close), oiFirst: Number(d.oiFirst), oiLast: Number(d.oiLast),
          longLiq: Number(d.longLiqUsd ?? 0), shortLiq: Number(d.shortLiqUsd ?? 0) }));
    const c = candles(await load(sym), tf), b = new Map(candles(await load("BTCUSDT"), tf).map((x) => [x.t, x]));
    if (!c.length) throw new Error(`no data for ${sym} in that window`);
    const p0 = c[0].open, oi0 = c[0].oi0;
    // the top (SHORT) / bottom (LONG): the extreme candle before the entry (or in the whole window without --entry)
    const pre = c.filter((x) => !(x.end > entry));
    const top = (pre.length ? pre : c).reduce((a, x) => (side === "SHORT" ? x.high > a.high : x.low < a.low) ? x : a);
    console.log(`${sym} · ${tf}m · ${hm(from)} -> ${hm(to)} UTC · ${side === "SHORT" ? "top" : "bottom"} candle ${hm(top.t)} (${side === "SHORT" ? `high ${top.high}` : `low ${top.low}`})${Number.isFinite(entry) ? ` · entry at ${hm(entry)}` : ""}`);
    console.log(`liquidations from our forceOrder stream (max 1 per second per coin -> lower than real)\n`);
    console.log(` candle UTC    col   close     price%   OI%    candleOI%  LONGS liq  SHORTS liq   BTC%`);
    for (const x of c) {
      const col = x.close > x.open ? "🟢" : x.close < x.open ? "🔴" : "⚪";
      const btc = b.get(x.t), bp = btc ? (100 * (btc.close - btc.open)) / btc.open : NaN;
      const mark = x.t === top.t ? (side === "SHORT" ? " ◀ TOP" : " ◀ BOTTOM") : x.end === entry ? " ◀ ENTRY (at this close)" : "";
      console.log(` ${hm(x.t)}  ${col} ${String(+x.close.toPrecision(6)).padStart(9)}  ${sp((100 * (x.close - p0)) / p0).padStart(6)}  ${sp((100 * (x.oi1 - oi0)) / oi0).padStart(6)}   ${sp((100 * (x.oi1 - x.oi0)) / x.oi0).padStart(6)}   ${usd(x.liqL).padStart(9)}  ${usd(x.liqS).padStart(10)}  ${sp(bp).padStart(6)}${mark}`);
    }
    const phase = (name: string, l: readonly Candle[]): void => {
      if (!l.length) return;
      const L = l.reduce((a, x) => a + x.liqL, 0), S = l.reduce((a, x) => a + x.liqS, 0);
      const pr = (100 * (l[l.length - 1].close - l[0].open)) / l[0].open, oi = (100 * (l[l.length - 1].oi1 - l[0].oi0)) / l[0].oi0;
      console.log(`  ${name.padEnd(26)} ${String(l.length).padStart(3)} candles · price ${sp(pr).padStart(6)}% · OI ${sp(oi).padStart(6)}% · longs liq ${usd(L).padStart(7)} · shorts liq ${usd(S).padStart(7)}`);
    };
    console.log(`\nBY PHASE`);
    phase("rise / fall to the extreme", c.filter((x) => x.t < top.t));
    phase("the extreme candle", [top]);
    phase("after it -> entry", c.filter((x) => x.t > top.t && !(x.end > entry)));
    if (Number.isFinite(entry)) phase("after the entry", c.filter((x) => x.t >= entry));
  } finally { await client.close(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
