/**
 * V10 TP vs SL TRADES AND THE FORCEORDER LIQUIDATIONS (Johnny, Oct 4 2026). Read-only, our DB (minute_bars).
 * The LIVE rules (A = BTC's oiPeak signal -> 3 picks, any alt; B = the alt's own atr signal without the top-candle OI
 * rule, old alts only, moved on its own), SL --pct / TP --tp, the coin must have moved more than the TP, one trade per
 * coin at a time (A first). For every trade: what the liquidations did around the top, on the SIGNAL's chart (BTC for
 * A, the alt for B) and on the traded coin.
 *
 * For a SHORT ("against" = the side the rise hurt = SHORTS, "with" = the side the drop hurts = LONGS); LONG mirrored:
 *   rise    against-liq $ from the move's start to the end of the top candle  (the squeeze)
 *   climax  the biggest 15m candle of against-liq in the rise / the biggest 15m candle of ANY liq in the 12h before
 *           the move's start (>= 1 = the biggest liquidation candle of the last 12h -- no fixed $; each coin vs itself)
 *   top->in with-liq $ / against-liq $ from the end of the top candle to the entry (known at the entry)
 *   +1h     with-liq $ / against-liq $ in the hour AFTER the entry (hindsight -- to understand, not to trade)
 * Stream note: Binance sends max 1 liquidation per second per coin -> the sums are lower than the real ones.
 *
 *   npx tsx src/tools/v10-liq-study.ts --pct 1 --tp 2
 *   options: --side SHORT|LONG  --window 12  --picks 3  --own 1|15  --fee 0.05
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type Candle, type MinBar } from "../research/dc15";
import { simTrade, type Trade } from "../research/sltp";
import { moveOf, ownMove, pickAlts, signalsOf, V10_TF_MIN, type V10Turn } from "../strategy/v10/v10-engine";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "n/a");
const usd = (v: number): string => (!Number.isFinite(v) ? "n/a" : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v > 0 ? v.toFixed(0) : "-");
const rat = (v: number): string => (v === Infinity ? "new" : Number.isFinite(v) ? v.toFixed(2) : "n/a");
const DAY = 86_400_000, H = 3_600_000, W = V10_TF_MIN * 60_000;

interface Coin { bars: MinBar[]; map: Map<number, number>; old: boolean; c: Candle[]; ts: number[]; cl: number[]; cs: number[] }
interface Liq { rise: number; climax: number; topWith: number; topAgainst: number; afterWith: number; afterAgainst: number }
interface Row { t: number; sym: string; src: "A" | "B"; side: "SHORT" | "LONG"; entry: number; tr: Trade; net: number; sig: Liq; coin: Liq }

function prep(bars: MinBar[], old: boolean): Coin {
  const ts: number[] = [], cl: number[] = [0], cs: number[] = [0];
  for (const b of bars) { ts.push(b.t); cl.push(cl[cl.length - 1] + (b.longLiq ?? 0)); cs.push(cs[cs.length - 1] + (b.shortLiq ?? 0)); }
  return { bars, map: new Map(bars.map((b) => [b.t, b.close])), old, c: candles(bars, V10_TF_MIN), ts, cl, cs };
}
const idx = (ts: readonly number[], t: number): number => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; };
/** longs / shorts liquidated (USD) in minutes [a, b) */
const sum = (k: Coin, a: number, b: number): { L: number; S: number } => { const i = idx(k.ts, a), j = idx(k.ts, b); return { L: k.cl[j] - k.cl[i], S: k.cs[j] - k.cs[i] }; };

function liqOf(k: Coin, side: "SHORT" | "LONG", startT: number, topT: number, entryT: number, windowH: number): Liq {
  const topEnd = topT + W, ag = (x: { L: number; S: number }): number => (side === "SHORT" ? x.S : x.L), wi = (x: { L: number; S: number }): number => (side === "SHORT" ? x.L : x.S);
  const rise = ag(sum(k, startT, topEnd));
  let riseMax = 0, priorMax = 0;
  for (const x of k.c) {
    if (x.t >= startT && x.t < topEnd) riseMax = Math.max(riseMax, side === "SHORT" ? x.liqS : x.liqL);
    if (x.t >= startT - windowH * H && x.end <= startT) priorMax = Math.max(priorMax, x.liqL + x.liqS);
  }
  const top = sum(k, topEnd, entryT), after = sum(k, entryT, entryT + H);
  return { rise, climax: priorMax > 0 ? riseMax / priorMax : riseMax > 0 ? Infinity : NaN, topWith: wi(top), topAgainst: ag(top), afterWith: wi(after), afterAgainst: ag(after) };
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const pct = Number(arg("pct", "1")), tpPct = Number(arg("tp", "2")), win = Number(arg("window", "12")), npicks = Number(arg("picks", "3"));
  const own = Number(arg("own", "1")), fee = Number(arg("fee", "0.05")), side = arg("side", "SHORT").toUpperCase() as "SHORT" | "LONG";
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const load = async (symbol: string): Promise<MinBar[]> =>
      (await db.collection(MINUTE_BARS).find({ symbol, high: { $ne: null } }).project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 }).sort({ ts: 1 }).toArray())
        .map((d) => ({ t: (d.ts as Date).getTime(), high: Number(d.high), low: Number(d.low), close: Number(d.close), oiFirst: Number(d.oiFirst), oiLast: Number(d.oiLast),
          longLiq: Number(d.longLiqUsd ?? 0), shortLiq: Number(d.shortLiqUsd ?? 0) }));
    const btc = prep(await load("BTCUSDT"), true);
    const coins = new Map<string, Coin>();
    for (const s of (process.env.SYMBOLS ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => x && x !== "BTCUSDT")) {
      const bars = await load(s);
      if (bars.length) coins.set(s, prep(bars, bars[0].t <= btc.bars[0].t + DAY));
    }
    const closes = new Map([...coins].map(([s, c]) => [s, c.map]));
    const short = (s: string): string => s.replace(/USDT$/, "");

    // the live candidates
    interface Cand { t: number; sym: string; src: "A" | "B"; side: "SHORT" | "LONG"; entry: number; startT: number; topT: number }
    const cands: Cand[] = [];
    for (const s of signalsOf(btc.c, win, { entry: "oiPeak" }).filter((x) => x.side === side))
      for (const p of pickAlts({ moveStartT: s.startT, candleEnd: s.t, side: s.side } as V10Turn, btc.map, closes, npicks))
        if (moveOf({ kind: "BTC", side: s.side, turn: s }, p) > tpPct) cands.push({ t: s.t, sym: p.symbol, src: "A", side: s.side, entry: p.price, startT: s.startT, topT: s.extremeT });
    for (const [sym, c] of coins) {
      if (!c.old) continue;
      for (const s of signalsOf(c.c, win, { entry: "atr", topCandleOi: false }).filter((x) => x.side === side)) {
        if (!ownMove({ moveStartT: s.startT, candleEnd: s.t } as V10Turn, c.map, btc.map, own)) continue;
        if (moveOf({ kind: "OWN", side: s.side, turn: s }, { coinPct: NaN }) > tpPct) cands.push({ t: s.t, sym, src: "B", side: s.side, entry: s.price, startT: s.startT, topT: s.extremeT });
      }
    }
    cands.sort((a, b) => a.t - b.t || (a.src === "A" ? -1 : 1));
    const busy = new Map<string, number>(), rows: Row[] = [];
    for (const c of cands) {
      if ((busy.get(c.sym) ?? 0) > c.t) continue;
      const k = coins.get(c.sym)!, sl = c.side === "SHORT" ? c.entry * (1 + pct / 100) : c.entry * (1 - pct / 100);
      const tr = simTrade(k.bars, c.t, c.entry, sl, tpPct / pct, c.side === "SHORT" ? "DOWN" : "UP");
      busy.set(c.sym, tr.exitT);
      const coinLiq = liqOf(k, c.side, c.startT, c.topT, c.t, win);
      rows.push({ t: c.t, sym: short(c.sym), src: c.src, side: c.side, entry: c.entry, tr, net: tr.r - (2 * fee) / pct,
        sig: c.src === "A" ? liqOf(btc, c.side, c.startT, c.topT, c.t, win) : coinLiq, coin: coinLiq });
    }

    const ag = side === "SHORT" ? "shorts" : "longs", wi = side === "SHORT" ? "longs" : "shorts";
    console.log(`V10 LIVE RULES · ${side} · SL ${pct}% · TP ${tpPct}% · ${utc(btc.bars[0].t)} -> ${utc(btc.bars[btc.bars.length - 1].t)} UTC · liquidations: our forceOrder stream (lower than real)`);
    console.log(`rise = ${ag} liq in the move (the squeeze) · climax = biggest ${ag}-liq 15m candle in the move / biggest liq candle of the 12h before (>= 1: the biggest of 12h)`);
    console.log(`top->in = ${wi} / ${ag} liq from the top candle's end to the entry · +1h = ${wi} / ${ag} liq in the hour after the entry (hindsight)\n`);
    const fmt = (l: Liq): string => `rise ${usd(l.rise).padStart(7)} · climax ${rat(l.climax).padStart(5)} · top->in ${usd(l.topWith).padStart(6)}/${usd(l.topAgainst).padStart(6)} · +1h ${usd(l.afterWith).padStart(6)}/${usd(l.afterAgainst).padStart(6)}`;
    for (const res of ["TP", "SL", "OPEN"] as const) {
      const l = rows.filter((r) => r.tr.exit === res);
      if (!l.length) continue;
      console.log(`── ${res} (${l.length}) ──`);
      for (const r of l) {
        console.log(`  ${utc(r.t)} ${r.src} ${r.sym.padEnd(6)} ${sp(r.net).padStart(6)}R  ${r.src === "A" ? "BTC " : "own "} ${fmt(r.sig)}`);
        if (r.src === "A") console.log(`  ${" ".repeat(11)}   ${" ".repeat(6)} ${" ".repeat(7)}  coin ${fmt(r.coin)}`);
      }
      console.log("");
    }

    // the groups: does a liquidation feature (known at the entry) separate TP from SL?
    const closed = rows.filter((r) => r.tr.exit !== "OPEN");
    const stat = (name: string, keep: (r: Row) => boolean): void => {
      for (const src of ["A", "B", "ALL"] as const) {
        const l = closed.filter((r) => (src === "ALL" || r.src === src) && keep(r));
        const tp = l.filter((r) => r.tr.exit === "TP").length, n = l.reduce((a, r) => a + r.net, 0);
        console.log(`  ${name.padEnd(44)} ${src.padEnd(3)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(l.length - tp).padStart(3)} · win ${l.length ? Math.round((100 * tp) / l.length) : 0}% · net R ${sp(n).padStart(7)}`);
      }
    };
    console.log(`FILTERS (known at the entry; "sig" = the signal's chart: BTC for A, the alt for B · "coin" = the traded coin)`);
    stat("all", () => true);
    stat("sig climax >= 1 (squeeze = biggest liq of 12h)", (r) => r.sig.climax >= 1);
    stat("sig climax < 1", (r) => !(r.sig.climax >= 1));
    stat(`sig top->in ${wi} > ${ag}`, (r) => r.sig.topWith > r.sig.topAgainst);
    stat(`sig top->in ${wi} <= ${ag}`, (r) => !(r.sig.topWith > r.sig.topAgainst));
    stat("sig climax >= 1 AND top->in with > against", (r) => r.sig.climax >= 1 && r.sig.topWith > r.sig.topAgainst);
    stat("coin climax >= 1", (r) => r.coin.climax >= 1);
    stat(`coin top->in ${wi} > ${ag}`, (r) => r.coin.topWith > r.coin.topAgainst);
    console.log(`\nHINDSIGHT (not tradable, to understand): in the hour after the entry`);
    stat(`sig +1h ${wi} > ${ag}`, (r) => r.sig.afterWith > r.sig.afterAgainst);
    stat(`sig +1h ${wi} <= ${ag}`, (r) => !(r.sig.afterWith > r.sig.afterAgainst));
  } finally { await client.close(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
