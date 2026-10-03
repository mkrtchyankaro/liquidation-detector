/**
 * V10 PART 2 "MOVED ON ITS OWN": R2 ON 1-MINUTE RETURNS vs ON 15m CLOSES (Johnny, Oct 3 2026) Read-only, our DB.
 * The BNB signal of Oct 3 03:30 was called "own" (R2 0.26 on minutes) while on the 15m chart BNB moved just like BTC.
 *
 *   one window:  npx tsx src/tools/v10-own-r2.ts --symbol BNBUSDT --from "2026-10-02 20:45" --to "2026-10-03 01:45"
 *   all part-2 signals + backtest:  npx tsx src/tools/v10-own-r2.ts --pct 1 --tp 2
 *   options: --entry atr|atrFrozen|oiPeak (default atr)  --window 12  --fee 0.05  --side SHORT|LONG  --list
 * "own" = BTC went the other way, or R2 < 0.5; a move with fewer than 10 steps cannot be measured -> not own.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, coinInWindow, ownness, type MinBar } from "../research/dc15";
import { simTrade, type Trade } from "../research/sltp";
import { signalsOf, V10_TF_MIN, type V10Entry } from "../strategy/v10/v10-engine";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "n/a");
const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "n/a ");
const ms = (s: string): number => Date.parse(`${s.replace(" ", "T")}:00Z`);
const DAY = 86_400_000;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const load = async (symbol: string): Promise<MinBar[]> =>
      (await db.collection(MINUTE_BARS).find({ symbol, high: { $ne: null } }).project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1 }).sort({ ts: 1 }).toArray())
        .map((d) => ({ t: (d.ts as Date).getTime(), high: Number(d.high), low: Number(d.low), close: Number(d.close), oiFirst: Number(d.oiFirst), oiLast: Number(d.oiLast) }));
    const btc = await load("BTCUSDT");
    const btcMap = new Map(btc.map((b) => [b.t, b.close]));

    // ── one window ──
    if (argv.includes("--symbol")) {
      const sym = arg("symbol", "").toUpperCase(), from = ms(arg("from", "")), to = ms(arg("to", ""));
      if (!(from > 0) || !(to > from)) throw new Error('use --from "YYYY-MM-DD HH:MM" --to "YYYY-MM-DD HH:MM" (UTC)');
      const m = new Map((await load(sym)).map((b) => [b.t, b.close]));
      console.log(`${sym} vs BTC · ${utc(from)} -> ${utc(to)} UTC`);
      for (const step of [1, 5, 15]) {
        const w = coinInWindow(m, btcMap, from, to, undefined, step);
        console.log(`  R² on ${String(step).padStart(2)}m: ${r2(w.follow)} (${w.points} steps) · ${sym.replace("USDT", "")} ${sp(w.pct)}% · BTC ${sp(w.btcPct)}% -> ${Number.isFinite(w.follow) ? ownness(w.follow, w.pct, w.btcPct) : "too short to measure"}`);
      }
      return;
    }

    // ── every part-2 signal: 1m vs 15m ──
    const pct = Number(arg("pct", "1")), tpPct = Number(arg("tp", "2")), win = Number(arg("window", "12")), fee = Number(arg("fee", "0.05"));
    const side = arg("side", "SHORT").toUpperCase(), entry = arg("entry", "atr") as V10Entry;
    interface Row { t: number; sym: string; side: "SHORT" | "LONG"; price: number; pct: number; btcPct: number; f1: number; f15: number; n15: number; own1: boolean; own15: boolean; x: number; opp: boolean }
    const rows: Row[] = [], bars = new Map<string, MinBar[]>();
    for (const s of (process.env.SYMBOLS ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => x && x !== "BTCUSDT")) {
      const b = await load(s);
      if (!b.length || b[0].t > btc[0].t + DAY) continue;   // part 2 = only alts with BTC's history (as live)
      bars.set(s, b);
      const m = new Map(b.map((x) => [x.t, x.close]));
      for (const g of signalsOf(candles(b, V10_TF_MIN), win, { entry }).filter((x) => x.side === side)) {
        const w1 = coinInWindow(m, btcMap, g.startT, g.t, undefined, 1), w15 = coinInWindow(m, btcMap, g.startT, g.t, undefined, 15);
        const own = (w: typeof w1): boolean => Number.isFinite(w.follow) && Number.isFinite(w.pct) && ownness(w.follow, w.pct, w.btcPct) !== "WITH BTC";
        // SIZE (Johnny Oct 3): from the build-up's start to the entry, the alt's move to its top vs BTC's to its top
        const wx = coinInWindow(m, btcMap, g.startT, g.t, g.side === "SHORT");
        const opp = w1.pct !== 0 && w1.btcPct !== 0 && Math.sign(w1.pct) !== Math.sign(w1.btcPct);
        rows.push({ t: g.t, sym: s.replace("USDT", ""), side: g.side, price: g.price, pct: w1.pct, btcPct: w1.btcPct, f1: w1.follow, f15: w15.follow, n15: w15.points, own1: own(w1), own15: own(w15), x: wx.x, opp });
      }
    }
    rows.sort((a, b) => a.t - b.t);
    const run = (keep: (r: Row) => boolean): Array<Row & { tr: Trade; net: number }> => {
      const busy = new Map<string, number>(), out: Array<Row & { tr: Trade; net: number }> = [];
      for (const r of rows.filter(keep)) {
        if ((busy.get(r.sym) ?? 0) > r.t) continue;
        const sl = r.side === "SHORT" ? r.price * (1 + pct / 100) : r.price * (1 - pct / 100);
        const tr = simTrade(bars.get(`${r.sym}USDT`)!, r.t, r.price, sl, tpPct / pct, r.side === "SHORT" ? "DOWN" : "UP");
        busy.set(r.sym, tr.exitT);
        out.push({ ...r, tr, net: tr.r - (2 * fee) / pct });
      }
      return out;
    };
    const line = (name: string, l: Array<{ tr: Trade; net: number }>): string => {
      const tp = l.filter((d) => d.tr.exit === "TP").length, sl = l.filter((d) => d.tr.exit === "SL").length, n = l.reduce((a, d) => a + d.net, 0);
      return `  ${name.padEnd(30)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(sl).padStart(3)} · open ${l.length - tp - sl} · win ${tp + sl ? Math.round((100 * tp) / (tp + sl)) : 0}% · net R ${sp(n).padStart(7)} ($${(n * 10).toFixed(0)} at $10)`;
    };
    const res1 = run((r) => r.own1), res15 = run((r) => r.own15);
    console.log(`V10 PART 2 · R² 1m vs 15m · entry ${entry} · ${side} · SL ${pct}% · TP ${tpPct}% · fee ${fee}%/side · RANK 1 ${win}h · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`);
    console.log(`alt signals: ${rows.length} · own on 1m: ${rows.filter((r) => r.own1).length} · own on 15m: ${rows.filter((r) => r.own15).length} · own on both: ${rows.filter((r) => r.own1 && r.own15).length} · 15m too short (< 10 steps): ${rows.filter((r) => !Number.isFinite(r.f15)).length}\n`);
    console.log(line("own on 1m (as live now)", res1));
    console.log(line("own on 15m (new)", res15));
    console.log(line(" own on both", run((r) => r.own1 && r.own15)));
    console.log(line(" own only on 1m (dropped)", run((r) => r.own1 && !r.own15)));
    console.log(line(" own only on 15m (added)", run((r) => !r.own1 && r.own15)));
    console.log(line("ALL alt signals (no filter)", run(() => true)));
    // SIZE: "own" = BTC went the other way, or the alt moved at least x times BTC (each x found in the data, no fixed number)
    console.log(`\n  BY SIZE: own = BTC the other way, or alt move / BTC move (to the top, from the build-up's start) >= x`);
    const xs = [...new Set(rows.filter((r) => Number.isFinite(r.x) && r.x > 0).map((r) => +r.x.toFixed(1)))].sort((a, b) => a - b);
    for (const X of xs) console.log(line(` x >= ${X.toFixed(1)}`, run((r) => r.opp || (Number.isFinite(r.x) && r.x >= X))));
    if (argv.includes("--list")) {
      const r1 = new Map(res1.map((d) => [`${d.t}${d.sym}`, d])), r15 = new Map(res15.map((d) => [`${d.t}${d.sym}`, d]));
      console.log(`\n  entry (UTC)  coin   alt%    BTC%   R²1m  R²15m(steps)  own1m own15m     x  result`);
      for (const r of rows) {
        const d = r1.get(`${r.t}${r.sym}`) ?? r15.get(`${r.t}${r.sym}`);
        console.log(`  ${utc(r.t)}  ${r.sym.padEnd(5)} ${sp(r.pct).padStart(6)} ${sp(r.btcPct).padStart(6)}   ${r2(r.f1)}  ${r2(r.f15)} (${String(r.n15).padStart(2)})      ${r.own1 ? "yes" : " - "}   ${r.own15 ? "yes" : " - "}  ${(r.opp ? "opp" : Number.isFinite(r.x) ? r.x.toFixed(1) : "n/a").padStart(5)}  ${d ? `${d.tr.exit} ${sp(d.net)}` : ""}`);
      }
    }
  } finally { await client.close(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
