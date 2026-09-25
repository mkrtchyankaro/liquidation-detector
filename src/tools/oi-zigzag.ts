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
 *   exits (default): TP = the remaining expected move (--tpshare 0.8 = keep a 20% reserve),
 *            SL = remaining / 2.2 (--rr 2.2)
 *            or --slmode structure (SL = last extreme + 0.25 ATR, TP = 2.2R)
 *            or --slmode pct --sl 0.3 --tp 0.7
 *   --depth calibrated   expected move from the coin's last-24h waves in ATR
 *            (default: from this cleaning). The summary always shows BOTH.
 *   --grid   compare wave thresholds (k2/k3/k4/k6, P80/P90/P95, top/2) side by side
 *   --maxdelay 20   skip when the OI top became known more than 20 min after it
 *   late-entry test: at the moment the accumulation's end is
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
import { buildChains, buildWaves, DEFAULT_CHAIN_PARAMS, oneTradeAtATime, trailingOiNoise, type Chain, type Wave, type ZBar } from "../research/oi-zigzag";
import { zigzagChartHtml } from "../research/zigzag-chart";

const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const stamp = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const coins = (v: number): string => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));
const usd = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);
const px = (p: number): string => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(5));
const LABEL: Record<Wave["kind"], string> = { LONG_CLEANING: "CLEAN LONG ", SHORT_CLEANING: "CLEAN SHORT", OI_DOWN: "oi down    ", OI_UP: "OI UP      " };

async function main(): Promise<void> {
  const env = loadEnv();
  const symbols = arg("symbols", "ETH,SOL,ADA").split(",").map((s) => s.trim().toUpperCase()).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const days = Number(arg("days", "3"));
  const k = Number(arg("k", "4"));
  const html = process.argv.includes("--html");
  const slModeArg = arg("slmode", DEFAULT_CHAIN_PARAMS.slMode).toUpperCase();
  const slMode = (slModeArg === "PCT" || slModeArg === "STRUCTURE" ? slModeArg : "TARGET") as "TARGET" | "PCT" | "STRUCTURE";
  const slPct = Number(arg("sl", String(DEFAULT_CHAIN_PARAMS.slPct))), tpPct = Number(arg("tp", String(DEFAULT_CHAIN_PARAMS.tpPct)));
  const rr = Number(arg("rr", String(DEFAULT_CHAIN_PARAMS.rr))), atrBuffer = Number(arg("atr", String(DEFAULT_CHAIN_PARAMS.atrBuffer)));
  const maxConfirmDelayMin = Number(arg("maxdelay", String(DEFAULT_CHAIN_PARAMS.maxConfirmDelayMin)));
  const tpShare = Number(arg("tpshare", String(DEFAULT_CHAIN_PARAMS.tpShare)));
  const depthMode = (arg("depth", "cleaning").toUpperCase() === "CALIBRATED" ? "CALIBRATED" : "CLEANING") as "CLEANING" | "CALIBRATED";
  const otherMode = depthMode === "CLEANING" ? "CALIBRATED" : "CLEANING";
  const exitParams = { slMode, slPct, tpPct, rr, atrBuffer, maxConfirmDelayMin, tpShare };
  const exitLabel = slMode === "PCT" ? `SL ${slPct}% / TP ${tpPct}%`
    : slMode === "STRUCTURE" ? `SL = last extreme + ${atrBuffer} ATR (min ${DEFAULT_CHAIN_PARAMS.minSlPct}%), TP = ${rr}R`
    : `TP = ${Math.round(tpShare * 100)}% of the remaining expected move, SL = remaining / ${rr} (skip if SL < ${DEFAULT_CHAIN_PARAMS.minSlPct}%)`;
  const client = new MongoClient(env.mongoUri);
  await client.connect();
  if (process.argv.includes("--grid")) {
    try { await grid(client, env.mongoDb, symbols, days, { ...DEFAULT_CHAIN_PARAMS, ...exitParams }); } finally { await client.close(); }
    return;
  }
  const allChains: Chain[] = [];
  const otherChains: Chain[] = []; // same data, the other depth mode -- for the side-by-side summary
  try {
    const col = client.db(env.mongoDb).collection(MINUTE_BARS);
    for (const symbol of symbols) {
      const rows = await col.find({ symbol, ts: { $gte: new Date(Date.now() - days * 86_400_000 - 24 * 3_600_000) } /* +1 day of history before the first wave (normal OI move, ATR) */ }).sort({ ts: 1 }).toArray();
      const bars = dense(rows.map((r) => ({ ts: new Date(r.ts).getTime(), high: r.high, low: r.low, close: r.close, oi: r.oiLast, longLiq: r.longLiqUsd ?? 0, shortLiq: r.shortLiqUsd ?? 0 })));
      if (bars.length < 120) { console.log(`\n${symbol}: not enough minute bars (${bars.length}) -- run minute-bars-backfill first`); continue; }
      // No look-ahead: the "normal OI move" and R at each minute come only
      // from the 2 days BEFORE that minute (never from later data).
      const noiseArr = trailingOiNoise(bars);
      const rArr = noiseArr.map((n) => k * n);
      const noise = noiseArr[noiseArr.length - 1];
      const rPct = rArr[rArr.length - 1];
      const waves = buildWaves(bars, rArr);
      const chains = oneTradeAtATime(buildChains(waves, bars, { ...DEFAULT_CHAIN_PARAMS, noise15Pct: noiseArr, ...exitParams, depthMode }));
      allChains.push(...chains);
      otherChains.push(...oneTradeAtATime(buildChains(waves, bars, { ...DEFAULT_CHAIN_PARAMS, noise15Pct: noiseArr, ...exitParams, depthMode: otherMode })));
      const coin = symbol.replace("USDT", "");

      console.log(`\n===== ${symbol}  ${stamp(bars[0].ts)} -> ${stamp(bars[bars.length - 1].ts)} UTC =====`);
      console.log(`OI now ${coins(bars[bars.length - 1].oi)} ${coin}.  Normal 15-min OI change (last 2 days) ${noise.toFixed(3)}%  ->  wave threshold R now = ${k} x = ${rPct.toFixed(3)}% (~${coins((rPct / 100) * bars[bars.length - 1].oi)} ${coin}). Smaller OI moves are noise.`);
      console.log(`\n-- all waves (${waves.length}) --`);
      console.log(`WAVE         FROM         TO           MIN   OI ${coin.padEnd(5)}         PRICE start -> end   (low / high)            LIQ long / short`);
      for (const w of waves) {
        console.log(`${LABEL[w.kind]}  ${stamp(w.from.ts)}  ${stamp(w.to.ts)}  ${String(w.minutes).padStart(4)}  ${(w.oiEnd >= w.oiStart ? "+" : "-") + coins(w.coins)} (${w.oiChangePct >= 0 ? "+" : ""}${w.oiChangePct.toFixed(2)}%)`.padEnd(70) +
          `${px(w.priceStart)} -> ${px(w.priceEnd)}  (${px(w.priceLow)} / ${px(w.priceHigh)})`.padEnd(42) + `${usd(w.longLiqUsd)} / ${usd(w.shortLiqUsd)}${w.confirmed ? "" : "   <- still running"}`);
      }
      console.log(`\n-- cleaning -> accumulation -> resolution (${chains.length}) --`);
      for (const c of chains) printChain(c, coin);
      tradeTable(symbol, chains);
      if (html) {
        const file = `zigzag-${symbol}.html`;
        const trades = chains.filter((c) => c.trade?.result).map((c) => ({ ...c.trade!, grade: c.quality.grade }));
        writeFileSync(file, zigzagChartHtml(symbol, bars, waves, rPct, trades));
        console.log(`\nchart: ${file}`);
      }
    }
  } finally {
    await client.close();
  }
  summary(allChains, `${exitLabel} · depth ${depthMode}${depthMode === "CALIBRATED" ? " (last 24h waves, ATR)" : " (this cleaning)"}`);
  summary(otherChains, `${exitLabel} · depth ${otherMode}${otherMode === "CALIBRATED" ? " (last 24h waves, ATR)" : " (this cleaning)"}  [comparison]`);
}

function summary(all: Chain[], exitLabel: string): void {
  const med = (v: number[]): string => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1].toFixed(2) : "n/a"; };
  console.log(`\n===== SUMMARY by grade (A strongest) -- late entry: ${exitLabel} =====`);
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
  console.log("netR after fees (taker entry, maker TP / taker SL). Tiny sample -- a direction to look, not proof.");
}

function printChain(c: Chain, coin: string): void {
  const w = c.cleaning, a = c.accumulation, r = c.resolution;
  const pct = (m: number, base: number): string => `${((100 * m) / base).toFixed(2)}%`;
  const q = c.quality;
  console.log(`\n[${q.grade}] ${w.kind === "LONG_CLEANING" ? "LONG" : "SHORT"} cleaning ${stamp(w.from.ts)} -> ${stamp(w.to.ts)} (${w.minutes}m, OI bottom seen at ${stamp(w.to.confirmedTs)})   speed ${q.speed.toFixed(1)}x normal  forced ${q.forcedPct.toFixed(1)}%  push ${Number.isFinite(q.pushAtr) ? q.pushAtr.toFixed(1) : "n/a"} ATR`);
  console.log(`   closed ${coins(w.coins)} ${coin}   price moved ${px(c.cleaningMove)} (${pct(c.cleaningMove, w.priceStart)})   liq ${usd(w.longLiqUsd)} long / ${usd(w.shortLiqUsd)} short`);
  console.log(c.depthPer1k >= 0.01 ? `   depth: ${px(c.depthPer1k)} per 1,000 ${coin}` : `   depth: ${px(c.depthPer1k * 1000)} per 1,000,000 ${coin}`);
  if (!a) { console.log("   accumulation: not yet"); return; }
  console.log(`   accumulation ${stamp(a.from.ts)} -> ${stamp(a.to.ts)} (${a.minutes}m${a.confirmed ? `, OI top seen at ${stamp(a.to.confirmedTs)}` : ", still running"})  opened ${coins(a.coins)} ${coin}  zone ${px(a.priceLow)} - ${px(a.priceHigh)}  ends at ${px(a.priceEnd)}`);
  console.log(`   EXPECTED move: ${px(c.expectedMove!)} (${pct(c.expectedMove!, a.priceEnd)})${c.calibration ? `  [calibrated: ${c.calibration.atrPerOiPct.toFixed(2)} ATR per 1% OI, from ${c.calibration.waves} waves of the last 24h]` : ""}`);
  if (!r) { printTrade(c); console.log("   resolution: not yet"); return; }
  printTrade(c);
  console.log(`   REAL next wave ${stamp(r.from.ts)} -> ${stamp(r.to.ts)} (${r.minutes}m${r.confirmed ? "" : ", still running"}): up ${px(c.actualUp!)} (${pct(c.actualUp!, a.priceEnd)}) / down ${px(c.actualDown!)} (${pct(c.actualDown!, a.priceEnd)})  -> closed ${coins(r.coins)} ${coin}`);
}

/** One line per decision: the episode, where we entered, SL, TP, what happened. */
function tradeTable(symbol: string, chains: Chain[]): void {
  const rows = chains.filter((c) => c.trade);
  console.log(`\n-- ${symbol} TRADES (late entry when the OI top became known) --`);
  console.log("GR SIDE  CLEANING (start -> OI bottom)   ENTRY time    price       SL (dist)              TP (dist)              RESULT  EXIT time     held   netR");
  for (const c of rows) {
    const t = c.trade!, w = c.cleaning;
    const dist = (p: number): string => `${((100 * Math.abs(p - t.entry)) / t.entry).toFixed(2)}%`;
    const head = `${c.quality.grade}  ${(t.side === "LONG" ? "BUY " : t.side === "SHORT" ? "SELL" : "  - ").padEnd(4)}  ${stamp(w.from.ts)} -> ${stamp(w.to.ts).slice(6)}      ${stamp(t.decidedTs)}  ${px(t.entry).padEnd(10)}`;
    if (t.skipReason) { console.log(`${head}  no trade: ${t.skipReason} (already moved ${dist(t.entry + t.alreadyMoved)}, remaining ${((100 * t.remaining) / t.entry).toFixed(2)}%)`); continue; }
    console.log(`${head}  ${`${px(t.slPrice!)} (${dist(t.slPrice!)})`.padEnd(21)}  ${`${px(t.tpPrice!)} (${dist(t.tpPrice!)})`.padEnd(21)}  ${t.result!.padEnd(6)}  ${t.exitTs ? stamp(t.exitTs) : "-".padEnd(11)}  ${(t.minutes !== null ? `${t.minutes}m` : "-").padStart(5)}  ${t.netR!.toFixed(2).padStart(5)}`);
  }
}

/** --grid: the SAME data under several wave thresholds, side by side.
 *   kN      R = N x the coin's median 15-min OI move (last 2 days)
 *   Pxx     R = the coin's xx-th percentile 15-min OI move (last 2 days)
 *   .../2   the accumulation top is confirmed by half of R (earlier entry) */
async function grid(client: MongoClient, dbName: string, symbols: string[], days: number, exit: Omit<import("../research/oi-zigzag").ChainParams, "noise15Pct">): Promise<void> {
  const variants = [
    ...[2, 3, 4, 6].map((k) => ({ name: `k${k}`, q: 0.5, mult: k, top: 1 })),
    ...[0.8, 0.9, 0.95].map((q) => ({ name: `P${Math.round(q * 100)}`, q, mult: 1, top: 1 })),
    { name: "k4 top/2", q: 0.5, mult: 4, top: 0.5 },
    { name: "P90 top/2", q: 0.9, mult: 1, top: 0.5 },
  ];
  type Row = { ab: number; abTrades: number; tp: number; sl: number; open: number; net: number; cTrades: number; cNet: number; perCoin: Map<string, number> };
  const rows = new Map(variants.map((v) => [v.name, { ab: 0, abTrades: 0, tp: 0, sl: 0, open: 0, net: 0, cTrades: 0, cNet: 0, perCoin: new Map() } as Row]));
  const col = client.db(dbName).collection(MINUTE_BARS);
  for (const symbol of symbols) {
    const docs = await col.find({ symbol, ts: { $gte: new Date(Date.now() - days * 86_400_000 - 24 * 3_600_000) } }).sort({ ts: 1 }).toArray();
    const bars = dense(docs.map((r) => ({ ts: new Date(r.ts).getTime(), high: r.high, low: r.low, close: r.close, oi: r.oiLast, longLiq: r.longLiqUsd ?? 0, shortLiq: r.shortLiqUsd ?? 0 })));
    if (bars.length < 300) continue;
    const median = trailingOiNoise(bars);
    const coin = symbol.replace("USDT", "");
    for (const v of variants) {
      const base = v.q === 0.5 ? median : trailingOiNoise(bars, undefined, undefined, v.q);
      const rArr = base.map((n) => v.mult * n);
      const chains = oneTradeAtATime(buildChains(buildWaves(bars, rArr, v.top), bars, { ...exit, noise15Pct: median }));
      const row = rows.get(v.name)!;
      let coinNet = 0;
      for (const c of chains) {
        const t = c.trade;
        const ab = c.quality.grade !== "C";
        if (ab) row.ab++;
        if (!t || !t.result) continue;
        if (ab) {
          row.abTrades++; row.net += t.netR ?? 0; coinNet += t.netR ?? 0;
          if (t.result === "TP") row.tp++; else if (t.result === "SL") row.sl++; else row.open++;
        } else { row.cTrades++; row.cNet += t.netR ?? 0; }
      }
      row.perCoin.set(coin, coinNet);
    }
  }
  const coins = symbols.map((s) => s.replace("USDT", ""));
  console.log(`\n===== GRID: wave threshold R -- ${symbols.length} coins, ${days} days, exits as configured (A/B trades only count) =====`);
  console.log(`VARIANT    A/B eps  trades  TP  SL  open  win%    netR  | C: trades netR | netR per coin: ${coins.join(" ")}`);
  for (const v of variants) {
    const r = rows.get(v.name)!;
    const done = r.tp + r.sl;
    console.log(`${v.name.padEnd(10)} ${String(r.ab).padStart(6)}  ${String(r.abTrades).padStart(6)}  ${String(r.tp).padStart(2)}  ${String(r.sl).padStart(2)}  ${String(r.open).padStart(4)}  ${done ? ((100 * r.tp) / done).toFixed(0).padStart(3) : "n/a"}%  ${r.net.toFixed(2).padStart(6)}  | ${String(r.cTrades).padStart(4)} ${r.cNet.toFixed(1).padStart(6)}  | ${coins.map((c) => (r.perCoin.get(c) ?? 0).toFixed(1)).join(" ")}`);
  }
  console.log("kN = N x median 15-min OI move; Pxx = xx-th percentile; top/2 = accumulation top confirmed at half R. All from the 2 days BEFORE each minute (no look-ahead).");
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
