/**
 * V10 ENTRIES COMPARED -- BACKTEST (Oct 3 2026) Read-only, our DB (minute_bars). The SAME functions as live
 * (src/strategy/v10/v10-engine.ts signalsOf / pickAlts / ownMove), on all history at once, for each entry rule:
 *   atr            15m close 1 ATR back from the top (ATR before the candle) + OI down, move built with OI up, RANK 1
 *   atr+red        the same, the candle must be red (green for LONG)
 *   atrFrozen      the ATR from the move's start
 *   atrFrozen+red
 *   oiPeak         OI low -> OI peak -> first red candle with OI down (no ATR distance)
 *   A = BTC's signal -> the picks (in at BTC's signal) · B = an alt's own signal, moved on its own (old alts only)
 * Exit: SL / TP % from the entry, no time limit, same minute SL + TP = SL; one trade per coin at a time (A first);
 * net R = R - 2 x fee / SL%.
 *
 *   npx tsx src/tools/v10-entry-compare.ts --pct 1 --tp 2
 *   options: --own 15|1 (part 2 R2 on 15m closes / 1m returns)  --window 12  --picks 3  --fee 0.05  --side SHORT|LONG  --without AVAX  --list atr  (prints that rule's trades)
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
import { simTrade, type Trade } from "../research/sltp";
import { ownMove, pickAlts, signalsOf, V10_TF_MIN, type V10Rule, type V10Turn } from "../strategy/v10/v10-engine";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "n/a");
const DAY = 86_400_000;

const RULES: Array<[string, V10Rule]> = [
  ["atr", { entry: "atr", redCandle: false }],
  ["atr+red", { entry: "atr", redCandle: true }],
  ["atrFrozen", { entry: "atrFrozen", redCandle: false }],
  ["atrFrozen+red", { entry: "atrFrozen", redCandle: true }],
  ["oiPeak", { entry: "oiPeak", redCandle: false }],
];

interface Cand { t: number; sym: string; src: "A" | "B"; side: "SHORT" | "LONG"; entry: number; rank: number }
interface Done extends Cand { tr: Trade; net: number }

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const pct = Number(arg("pct", "1")), tpPct = Number(arg("tp", arg("pct", "1"))), win = Number(arg("window", "12"));
  const npicks = Number(arg("picks", "3")), fee = Number(arg("fee", "0.05")), side = arg("side", "SHORT").toUpperCase(), own = Number(arg("own", "15"));
  const without = arg("without", "AVAX").toUpperCase().split(",").map((x) => x.trim()).filter(Boolean);
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const load = async (symbol: string): Promise<MinBar[]> =>
      (await db.collection(MINUTE_BARS).find({ symbol, high: { $ne: null } }).project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1 }).sort({ ts: 1 }).toArray())
        .map((d) => ({ t: (d.ts as Date).getTime(), high: Number(d.high), low: Number(d.low), close: Number(d.close), oiFirst: Number(d.oiFirst), oiLast: Number(d.oiLast) }));
    const btc = await load("BTCUSDT");
    const btcMap = new Map(btc.map((b) => [b.t, b.close]));
    const coins = new Map<string, { bars: MinBar[]; map: Map<number, number>; old: boolean }>();
    for (const s of (process.env.SYMBOLS ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => x && x !== "BTCUSDT")) {
      const bars = await load(s);
      if (bars.length) coins.set(s, { bars, map: new Map(bars.map((b) => [b.t, b.close])), old: bars[0].t <= btc[0].t + DAY });
    }
    const closes = new Map([...coins].map(([s, c]) => [s, c.map]));
    const btcC = candles(btc, V10_TF_MIN), altC = new Map([...coins].map(([s, c]) => [s, candles(c.bars, V10_TF_MIN)]));
    const short = (s: string): string => s.replace(/USDT$/, "");

    console.log(`V10 ENTRIES COMPARED · ${side} · SL ${pct}% · TP ${tpPct}% · fee ${fee}%/side · RANK 1 ${win}h · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`);
    console.log(`A = BTC's signal -> ${npicks} picks · B = the alt's own move (old alts only, R² on ${own}m) · net R at $10 risk\n`);
    const head = `${"rule".padEnd(14)} ${"part".padEnd(10)} trades   TP   SL open  win   net R      $  hold`;
    console.log(head);
    for (const [name, rule] of RULES) {
      const cands: Cand[] = [];
      const btcSigs = signalsOf(btcC, win, rule).filter((s) => s.side === side);
      for (const s of btcSigs) {
        const turn = { moveStartT: s.startT, candleEnd: s.t, side: s.side, windowEndT: "windowEndT" in s ? s.windowEndT : undefined } as V10Turn;
        for (const p of pickAlts(turn, btcMap, closes, npicks)) cands.push({ t: s.t, sym: p.symbol, src: "A", side: s.side, entry: p.price, rank: p.rank });
      }
      for (const [sym, c] of coins) {
        if (!c.old) continue;
        for (const s of signalsOf(altC.get(sym)!, win, rule).filter((x) => x.side === side)) {
          if (!ownMove({ moveStartT: s.startT, peakT: s.peakT } as V10Turn, c.map, btcMap, own)) continue;
          cands.push({ t: s.t, sym, src: "B", side: s.side, entry: s.price, rank: 0 });
        }
      }
      cands.sort((a, b) => a.t - b.t || (a.src === "A" ? -1 : 1));
      const busy = new Map<string, number>(), done: Done[] = [];
      for (const c of cands) {
        if ((busy.get(c.sym) ?? 0) > c.t) continue;
        const sl = c.side === "SHORT" ? c.entry * (1 + pct / 100) : c.entry * (1 - pct / 100);
        const tr = simTrade(coins.get(c.sym)!.bars, c.t, c.entry, sl, tpPct / pct, c.side === "SHORT" ? "DOWN" : "UP");
        busy.set(c.sym, tr.exitT);
        done.push({ ...c, tr, net: tr.r - (2 * fee) / pct });
      }
      const line = (part: string, l: Done[]): string => {
        const tp = l.filter((d) => d.tr.exit === "TP").length, sl = l.filter((d) => d.tr.exit === "SL").length, op = l.length - tp - sl;
        const n = l.reduce((a, d) => a + d.net, 0);
        const hrs = l.filter((d) => d.tr.exit !== "OPEN").map((d) => (d.tr.exitT - d.t) / 3_600_000).sort((a, b) => a - b);
        return `${name.padEnd(14)} ${part.padEnd(10)} ${String(l.length).padStart(6)} ${String(tp).padStart(4)} ${String(sl).padStart(4)} ${String(op).padStart(4)} ${(tp + sl ? Math.round((100 * tp) / (tp + sl)) : 0).toString().padStart(3)}% ${sp(n).padStart(7)} ${("$" + (n * 10).toFixed(0)).padStart(6)} ${hrs.length ? hrs[Math.floor(hrs.length / 2)].toFixed(1) + "h" : "-"}`;
      };
      console.log(`${name.padEnd(14)} BTC signals: ${btcSigs.length}`);
      console.log(line("A (BTC)", done.filter((d) => d.src === "A")));
      console.log(line("B (ALT)", done.filter((d) => d.src === "B")));
      console.log(line(`B w/o ${without.join(",")}`, done.filter((d) => d.src === "B" && !without.includes(short(d.sym)))));
      console.log(line("ALL", done));
      if (arg("list", "") === name)
        for (const d of done) console.log(`     ${utc(d.t)} ${d.src} ${short(d.sym).padEnd(5)} ${d.src === "A" ? `#${d.rank}` : "  "} entry ${+d.entry.toPrecision(6)} -> ${d.tr.exit.padEnd(4)} ${utc(d.tr.exitT)} net ${sp(d.net)}`);
      console.log("");
    }
  } finally { await client.close(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
