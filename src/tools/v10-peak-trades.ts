/**
 * V10 WITH JOHNNY'S RULE -- BACKTEST (Oct 3 2026) Read-only, our DB (minute_bars).
 * Entry = src/research/oi-peak.ts: OI up from its low to the peak (RANK 1), OI falling at the top, the FIRST red 15m
 * candle with OI down -> SHORT at its close (mirror: LONG). No ATR wait, nothing else.
 *   A  BTC's signal -> the 3 alts that moved most with BTC over the build-up (OI low -> the entry), upper half by R2,
 *      ranked by x BTC -> same side, in at BTC's signal
 *   B  an alt's own signal, when it moved on its own over its build-up (BTC opposite / explains < half) -- only alts
 *      with as much history as BTC
 * Exit: SL / TP % from the entry, no time limit, same minute SL + TP = SL; one trade per coin at a time; fees per side.
 *
 *   npx tsx src/tools/v10-peak-trades.ts --pct 1 --tp 1
 *   options: --tp 2  --window 12  --picks 3  --fee 0.05  --list  --without AVAX
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, coinInWindow, ownness, priceAt, type MinBar } from "../research/dc15";
import { oiPeakSignals } from "../research/oi-peak";
import { simTrade, type Trade } from "../research/sltp";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "n/a");
const DAY = 86_400_000;

interface Cand { t: number; sym: string; src: "A" | "B"; side: "SHORT" | "LONG"; entry: number; rank: number }
interface Done extends Cand { tr: Trade; net: number }

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const pct = Number(arg("pct", "1")), tpPct = Number(arg("tp", arg("pct", "1"))), win = Number(arg("window", "12"));
  const npicks = Number(arg("picks", "3")), fee = Number(arg("fee", "0.05"));
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
      if (bars.length) coins.set(s.replace(/USDT$/, ""), { bars, map: new Map(bars.map((b) => [b.t, b.close])), old: bars[0].t <= btc[0].t + DAY });
    }
    const cands: Cand[] = [];
    // A: BTC's signals
    const btcSigs = oiPeakSignals(candles(btc, 15), 1, 14, win);
    for (const s of btcSigs) {
      const rows: Array<{ sym: string; x: number; follow: number; price: number }> = [];
      for (const [sym, c] of coins) {
        const w = coinInWindow(c.map, btcMap, s.startT, s.t, s.side === "SHORT");
        const price = priceAt(c.map, s.t);
        if (Number.isFinite(w.x) && Number.isFinite(w.follow) && price > 0) rows.push({ sym, x: w.x, follow: w.follow, price });
      }
      if (!rows.length) continue;
      const med = [...rows].map((r) => r.follow).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
      rows.filter((r) => r.follow >= med).sort((a, b) => b.x - a.x).slice(0, npicks)
        .forEach((r, i) => cands.push({ t: s.t, sym: r.sym, src: "A", side: s.side, entry: r.price, rank: i + 1 }));
    }
    // B: each old alt's own signals, moved on its own
    let bAll = 0;
    for (const [sym, c] of coins) {
      if (!c.old) continue;
      for (const s of oiPeakSignals(candles(c.bars, 15), 1, 14, win)) {
        bAll++;
        const w = coinInWindow(c.map, btcMap, s.startT, s.peakT);
        if (!Number.isFinite(w.follow) || !Number.isFinite(w.pct) || ownness(w.follow, w.pct, w.btcPct) === "WITH BTC") continue;
        cands.push({ t: s.t, sym, src: "B", side: s.side, entry: s.price, rank: 0 });
      }
    }
    cands.sort((a, b) => a.t - b.t || (a.src === "A" ? -1 : 1));
    const rr = tpPct / pct, busy = new Map<string, number>(), done: Done[] = [];
    for (const c of cands) {
      if ((busy.get(c.sym) ?? 0) > c.t) continue;
      const sl = c.side === "SHORT" ? c.entry * (1 + pct / 100) : c.entry * (1 - pct / 100);
      const tr = simTrade(coins.get(c.sym)!.bars, c.t, c.entry, sl, rr, c.side === "SHORT" ? "DOWN" : "UP");
      busy.set(c.sym, tr.exitT);
      done.push({ ...c, tr, net: tr.r - (2 * fee) / pct });
    }
    const line = (name: string, l: Done[]): string => {
      const tp = l.filter((d) => d.tr.exit === "TP").length, sl = l.filter((d) => d.tr.exit === "SL").length, op = l.length - tp - sl;
      const sumN = l.reduce((a, d) => a + d.net, 0);
      const hrs = l.filter((d) => d.tr.exit !== "OPEN").map((d) => (d.tr.exitT - d.t) / 3_600_000).sort((a, b) => a - b);
      return `   ${name.padEnd(14)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(sl).padStart(3)} · open ${op} · win ${tp + sl ? Math.round((100 * tp) / (tp + sl)) : 0}% · net R ${sp(sumN).padStart(7)} ($${(sumN * 10).toFixed(0)} at $10) · median hold ${hrs.length ? hrs[Math.floor(hrs.length / 2)].toFixed(1) : "-"}h`;
    };
    console.log(`V10 · JOHNNY'S RULE (OI up -> OI peak -> first red / green candle with OI down) · RANK 1 ${win}h · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`);
    console.log(`SL ${pct}% · TP ${tpPct}% · fee ${fee}%/side · BTC signals: ${btcSigs.length} (SHORT ${btcSigs.filter((s) => s.side === "SHORT").length}, LONG ${btcSigs.filter((s) => s.side === "LONG").length}) · alt signals: ${bAll}, on their own: ${cands.filter((c) => c.src === "B").length}\n`);
    for (const side of ["SHORT", "LONG"] as const) {
      const d = done.filter((x) => x.side === side);
      console.log(`================ ${side}`);
      console.log(line("A (BTC)", d.filter((x) => x.src === "A")));
      for (let k = 1; k <= npicks; k++) console.log(line(` A pick #${k}`, d.filter((x) => x.src === "A" && x.rank === k)));
      console.log(line("B (ALT)", d.filter((x) => x.src === "B")));
      const without = arg("without", "AVAX").toUpperCase().split(",").filter(Boolean);
      console.log(line(` B w/o ${without.join(",")}`, d.filter((x) => x.src === "B" && !without.includes(x.sym))));
      console.log("   by coin:");
      for (const sym of [...new Set(d.map((x) => x.sym))].sort()) console.log(line(` ${sym}`, d.filter((x) => x.sym === sym)));
      if (argv.includes("--list")) for (const x of d) console.log(`     ${utc(x.t)} ${x.src} ${x.sym.padEnd(5)} entry ${+x.entry.toPrecision(6)} -> ${x.tr.exit.padEnd(4)} ${utc(x.tr.exitT)} net ${sp(x.net)}`);
      console.log("");
    }
  } finally { await client.close(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
