/**
 * OI ZIGZAG -- cut each coin's Open Interest into waves and show the
 * CLEANING -> ACCUMULATION -> RESOLUTION sequences (research only, read-only).
 * Reads minute_bars (fill once with: npx tsx src/tools/minute-bars-backfill.ts).
 *
 *   npx tsx src/tools/oi-zigzag.ts --symbols ETH --days 2
 *   npx tsx src/tools/oi-zigzag.ts --symbols ETH,BTC,SOL --days 2 --k 4 --html
 *
 *   --k 4    wave threshold R = k x the coin's median 15-minute OI change
 *            (bigger k = fewer, bigger waves; smaller k = more, noisier)
 *   --sl 0.3 --tp 0.7   late-entry test: at the moment the accumulation's end is
 *            KNOWN, the move already made shows the direction and is taken
 *            off the expected move; trade only if what remains >= TP
 *   --html   also writes zigzag-<SYMBOL>.html: price + OI chart with the
 *            waves coloured (open it in a browser)
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import { MongoClient } from "mongodb";
import { loadEnv } from "../config/env";
import { MINUTE_BARS } from "../collector/minute-bars";
import { buildChains, buildWaves, DEFAULT_CHAIN_PARAMS, medianOi15mPct, type Chain, type Wave, type ZBar } from "../research/oi-zigzag";
import { zigzagChartHtml } from "../research/zigzag-chart";

const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const stamp = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const coins = (v: number): string => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));
const usd = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);
const px = (p: number): string => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(5));
const LABEL: Record<Wave["kind"], string> = { LONG_CLEANING: "CLEAN LONG ", SHORT_CLEANING: "CLEAN SHORT", OI_DOWN: "oi down    ", OI_UP: "OI UP      " };

async function main(): Promise<void> {
  const env = loadEnv();
  const symbols = arg("symbols", "ETH").split(",").map((s) => s.trim().toUpperCase()).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const days = Number(arg("days", "2"));
  const k = Number(arg("k", "4"));
  const html = process.argv.includes("--html");
  const slPct = Number(arg("sl", String(DEFAULT_CHAIN_PARAMS.slPct))), tpPct = Number(arg("tp", String(DEFAULT_CHAIN_PARAMS.tpPct)));
  const client = new MongoClient(env.mongoUri);
  await client.connect();
  const allChains: Chain[] = [];
  try {
    const col = client.db(env.mongoDb).collection(MINUTE_BARS);
    for (const symbol of symbols) {
      const rows = await col.find({ symbol, ts: { $gte: new Date(Date.now() - days * 86_400_000 - 4 * 3_600_000) } /* +4h: ATR before the first wave */ }).sort({ ts: 1 }).toArray();
      const bars = dense(rows.map((r) => ({ ts: new Date(r.ts).getTime(), high: r.high, low: r.low, close: r.close, oi: r.oiLast, longLiq: r.longLiqUsd ?? 0, shortLiq: r.shortLiqUsd ?? 0 })));
      if (bars.length < 120) { console.log(`\n${symbol}: not enough minute bars (${bars.length}) -- run minute-bars-backfill first`); continue; }
      const noise = medianOi15mPct(bars);
      const rPct = k * noise;
      const waves = buildWaves(bars, rPct);
      const chains = buildChains(waves, bars, { ...DEFAULT_CHAIN_PARAMS, noise15Pct: noise, slPct, tpPct });
      allChains.push(...chains);
      const coin = symbol.replace("USDT", "");

      console.log(`\n===== ${symbol}  ${stamp(bars[0].ts)} -> ${stamp(bars[bars.length - 1].ts)} UTC =====`);
      console.log(`OI now ${coins(bars[bars.length - 1].oi)} ${coin}.  Normal 15-min OI change ${noise.toFixed(3)}%  ->  wave threshold R = ${k} x = ${rPct.toFixed(3)}% (~${coins((rPct / 100) * bars[bars.length - 1].oi)} ${coin}). Smaller OI moves are noise.`);
      console.log(`\n-- all waves (${waves.length}) --`);
      console.log(`WAVE         FROM         TO           MIN   OI ${coin.padEnd(5)}         PRICE start -> end   (low / high)            LIQ long / short`);
      for (const w of waves) {
        console.log(`${LABEL[w.kind]}  ${stamp(w.from.ts)}  ${stamp(w.to.ts)}  ${String(w.minutes).padStart(4)}  ${(w.oiEnd >= w.oiStart ? "+" : "-") + coins(w.coins)} (${w.oiChangePct >= 0 ? "+" : ""}${w.oiChangePct.toFixed(2)}%)`.padEnd(70) +
          `${px(w.priceStart)} -> ${px(w.priceEnd)}  (${px(w.priceLow)} / ${px(w.priceHigh)})`.padEnd(42) + `${usd(w.longLiqUsd)} / ${usd(w.shortLiqUsd)}${w.confirmed ? "" : "   <- still running"}`);
      }
      console.log(`\n-- cleaning -> accumulation -> resolution (${chains.length}) --`);
      for (const c of chains) printChain(c, coin);
      if (html) {
        const file = `zigzag-${symbol}.html`;
        writeFileSync(file, zigzagChartHtml(symbol, bars, waves, rPct));
        console.log(`\nchart: ${file}`);
      }
    }
  } finally {
    await client.close();
  }
  summary(allChains, slPct, tpPct);
}

function summary(all: Chain[], slPct: number, tpPct: number): void {
  const med = (v: number[]): string => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1].toFixed(2) : "n/a"; };
  console.log(`\n===== SUMMARY by grade (A strongest) -- late entry SL ${slPct}% / TP ${tpPct}% =====`);
  console.log("GRADE  CLEANINGS  real/expected (median; 1.00 = exact)   TRADES  TP  SL  open  win%    netR");
  for (const g of ["A", "B", "C"] as const) {
    const cs = all.filter((c) => c.quality.grade === g);
    const done = cs.filter((c) => c.expectedMove && c.actualUp !== null && c.resolution?.confirmed);
    const ratios = done.map((c) => Math.max(c.actualUp!, c.actualDown!) / c.expectedMove!);
    const tr = cs.map((c) => c.trade).filter((t) => t && t.result);
    const tp = tr.filter((t) => t!.result === "TP").length, sl = tr.filter((t) => t!.result === "SL").length, open = tr.filter((t) => t!.result === "OPEN").length;
    const net = tr.reduce((a, t) => a + (t!.netR ?? 0), 0);
    console.log(`  ${g}    ${String(cs.length).padStart(5)}      ${med(ratios).padStart(6)}  (n=${done.length})                    ${String(tr.length).padStart(4)}  ${String(tp).padStart(2)}  ${String(sl).padStart(2)}  ${String(open).padStart(3)}  ${tp + sl ? ((100 * tp) / (tp + sl)).toFixed(0).padStart(3) : "n/a"}%  ${net.toFixed(2).padStart(6)}`);
  }
  console.log(`netR after fees. Break-even win rate at RR ${(tpPct / slPct).toFixed(2)} before fees: ${(100 * slPct / (slPct + tpPct)).toFixed(0)}%. Tiny sample -- a direction to look, not proof.`);
}

function printChain(c: Chain, coin: string): void {
  const w = c.cleaning, a = c.accumulation, r = c.resolution;
  const pct = (m: number, base: number): string => `${((100 * m) / base).toFixed(2)}%`;
  const q = c.quality;
  console.log(`\n[${q.grade}] ${w.kind === "LONG_CLEANING" ? "LONG" : "SHORT"} cleaning ${stamp(w.from.ts)} -> ${stamp(w.to.ts)} (${w.minutes}m, OI bottom seen at ${stamp(w.to.confirmedTs)})   speed ${q.speed.toFixed(1)}x normal  forced ${q.forcedPct.toFixed(1)}%  push ${Number.isFinite(q.pushAtr) ? q.pushAtr.toFixed(1) : "n/a"} ATR`);
  console.log(`   closed ${coins(w.coins)} ${coin}   price moved ${px(c.cleaningMove)} (${pct(c.cleaningMove, w.priceStart)})   liq ${usd(w.longLiqUsd)} long / ${usd(w.shortLiqUsd)} short`);
  console.log(`   depth: ${px(c.depthPer1k)} per 1,000 ${coin}`);
  if (!a) { console.log("   accumulation: not yet"); return; }
  console.log(`   accumulation ${stamp(a.from.ts)} -> ${stamp(a.to.ts)} (${a.minutes}m${a.confirmed ? `, OI top seen at ${stamp(a.to.confirmedTs)}` : ", still running"})  opened ${coins(a.coins)} ${coin}  zone ${px(a.priceLow)} - ${px(a.priceHigh)}  ends at ${px(a.priceEnd)}`);
  console.log(`   EXPECTED move: ${px(c.expectedMove!)} (${pct(c.expectedMove!, a.priceEnd)})`);
  if (!r) { printTrade(c); console.log("   resolution: not yet"); return; }
  printTrade(c);
  console.log(`   REAL next wave ${stamp(r.from.ts)} -> ${stamp(r.to.ts)} (${r.minutes}m${r.confirmed ? "" : ", still running"}): up ${px(c.actualUp!)} (${pct(c.actualUp!, a.priceEnd)}) / down ${px(c.actualDown!)} (${pct(c.actualDown!, a.priceEnd)})  -> closed ${coins(r.coins)} ${coin}`);
}

function printTrade(c: Chain): void {
  const t = c.trade;
  if (!t) return;
  const pct = (m: number): string => `${((100 * m) / t.entry).toFixed(2)}%`;
  const head = `   LATE ENTRY at ${stamp(t.decidedTs)} price ${px(t.entry)}: already moved ${t.alreadyMoved >= 0 ? "+" : "-"}${px(Math.abs(t.alreadyMoved))} (${pct(Math.abs(t.alreadyMoved))}) -> remaining ${px(t.remaining)} (${pct(t.remaining)})`;
  if (t.skipReason) { console.log(`${head}  -> NO TRADE (${t.skipReason})`); return; }
  console.log(`${head}  -> ${t.side === "LONG" ? "BUY" : "SELL"}: ${t.result}${t.minutes !== null ? ` in ${t.minutes}m` : ""}  netR ${t.netR!.toFixed(2)}`);
}

function dense(rows: Array<{ ts: number; high: number | null; low: number | null; close: number | null; oi: number | null; longLiq: number; shortLiq: number }>): ZBar[] {
  if (!rows.length) return [];
  const by = new Map(rows.map((r) => [r.ts, r]));
  const out: ZBar[] = [];
  let close = NaN, oi = NaN;
  for (let ts = rows[0].ts; ts <= rows[rows.length - 1].ts; ts += 60_000) {
    const r = by.get(ts);
    if (r?.close && r.close > 0) close = r.close;
    if (r?.oi && r.oi > 0) oi = r.oi;
    out.push({ ts, close, oi, high: r?.high ?? close, low: r?.low ?? close, longLiq: r?.longLiq ?? 0, shortLiq: r?.shortLiq ?? 0 });
  }
  return out;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
