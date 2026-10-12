/**
 * H2 HOLDOUT (frozen 2026-10-12, see the project doc "h2-preregistration"). READ-ONLY: reads a CSV, prints, writes a CSV.
 *
 *   H2: a V11 SHORT signal is more dangerous when the coin's rs72 > +1 % AND rs6 > 0
 *     rs72 = coin close-to-close return over the 72 h before the entry  -  the market's (median of every coin in the file)
 *     rs6  = the same over the last 6 h before the entry
 *     (closes of the hours that ended at or before the entry hour's open only -- nothing later)
 *
 * The signals are the LIVE V11 engine (src/strategy/v11/v11-engine.ts, default rule) on 1h bars; the trade is the study's:
 * SHORT at the entry hour's open, SL = the wick's high, TP = 2R, 1h candles, SL first if both in one hour, 48 h limit
 * (still open = OPEN, not in R), fee 0.14 % round trip of the notional (= 0.14 / SL% in R) on every TP / SL.
 *
 *   npx tsx src/tools/research-1h-export.ts --days 26          # Binance price + OI, our liquidations -> reports/research-1h/all_1h.csv
 *   npx tsx src/tools/h2-holdout.ts reports/research-1h/all_1h.csv
 *   npx tsx src/tools/h2-holdout.ts <file> --discovery          # every entry (the 10-12 discovery check), not only the holdout
 *
 * Holdout = entries at or after HOLDOUT_START. Liquidation data per hour is "ok" when the export's db_minutes >= 55
 * (the same as the live bot), or from a liq_data_ok column when the file has one (the discovery file).
 */
import * as fs from "fs";
import { decideAt, H, type V11Bar } from "../strategy/v11/v11-engine";

const HOLDOUT_START = Date.parse("2026-10-12T13:00:00Z");
const RS72_MIN = 1, RS6_MIN = 0, R = 2, FEE_PCT = 0.14, MAX_HOURS = 48, EVENT_GAP_H = 6, MIN_MINUTES = 55;

const file = process.argv[2];
if (!file) { console.error("usage: npx tsx src/tools/h2-holdout.ts <all_1h.csv> [--discovery]"); process.exit(1); }
const discovery = process.argv.includes("--discovery");
const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
const head = lines[0].split(","), ix = (n: string): number => head.indexOf(n);
for (const c of ["symbol", "open_time_utc", "open", "high", "low", "close", "oi_open", "oi_close", "short_liq_usd", "long_liq_usd"]) if (ix(c) < 0) throw new Error(`column ${c} missing`);
if (ix("liq_data_ok") < 0 && ix("db_minutes") < 0) throw new Error("need db_minutes or liq_data_ok");
const P = (s: string): number => Date.parse(s.trim().replace(" ", "T") + ":00Z");
const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");

// ── bars: one consecutive grid per coin (a missing hour or a missing OI = null) ──
const raw = new Map<string, Map<number, V11Bar>>();
for (const l of lines.slice(1)) {
  const r = l.split(",");
  const oo = r[ix("oi_open")], oc = r[ix("oi_close")];
  if (oo === "" || oc === "") continue;
  const ok = ix("liq_data_ok") >= 0 ? r[ix("liq_data_ok")].trim() === "1" : Number(r[ix("db_minutes")]) >= MIN_MINUTES;
  const b: V11Bar = { t: P(r[ix("open_time_utc")]), o: +r[ix("open")], h: +r[ix("high")], l: +r[ix("low")], c: +r[ix("close")], oo: +oo, oc: +oc, shortLiq: +r[ix("short_liq_usd")] || 0, longLiq: +r[ix("long_liq_usd")] || 0, liqOk: ok };
  if (!raw.has(r[0])) raw.set(r[0], new Map());
  raw.get(r[0])!.set(b.t, b);
}
const t0 = Math.min(...[...raw.values()].flatMap((m) => [...m.keys()])), t1 = Math.max(...[...raw.values()].flatMap((m) => [...m.keys()]));
const grid = new Map<string, Array<V11Bar | null>>();
for (const [s, m] of raw) grid.set(s, Array.from({ length: (t1 - t0) / H + 1 }, (_, i) => m.get(t0 + i * H) ?? null));
const close = (s: string, t: number): number | undefined => raw.get(s)?.get(t)?.c;

// ── relative strength, known at the entry: closes of hours ending <= entry (hour opens <= entryT - 1h) ──
const ret = (s: string, a: number, b: number): number | null => { const x = close(s, a), y = close(s, b); return x && y ? 100 * (y / x - 1) : null; };
const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
function rs(sym: string, k: number, hours: number, excludeSelf: boolean): { rs: number; n: number } | null {
  const a = k - (hours + 1) * H, b = k - H, own = ret(sym, a, b);
  if (own === null) return null;
  const others = [...raw.keys()].filter((s) => !(excludeSelf && s === sym)).map((s) => ret(s, a, b)).filter((x): x is number => x !== null);
  return { rs: own - median(others), n: others.length };
}

// ── signals + trades ──
interface Row { symbol: string; entryT: number; entry: number; sl: number; tp: number; riskPct: number; result: string; exitT: number | null; netR: number | null; rallyType: string; rs72: number; rs6: number; rs72x: number; rs6x: number; nMkt: number; h2: boolean; h2x: boolean }
const rows: Row[] = [];
for (const [sym, g] of grid) {
  for (let i = 0; i < g.length; i++) {
    if (!g[i]) continue;
    for (const d of decideAt(g, i, "SHORT")) {
      if (d.kind !== "SIGNAL") continue;
      const k = i + 1, b = g[k];
      if (!b) continue;                                            // the entry hour is not in the file yet
      const e = b.o, sl = d.signal.stop, riskPct = (100 * (sl - e)) / e;
      if (!(riskPct > 0)) continue;
      if (!discovery && b.t < HOLDOUT_START) continue;
      const tp = e - R * (sl - e);
      let result = "OPEN", exitT: number | null = null;
      for (let j = k; j < Math.min(g.length, k + MAX_HOURS); j++) {
        const y = g[j];
        if (!y) { result = "GAP"; break; }
        if (y.h >= sl) { result = "SL"; exitT = y.t; break; }
        if (y.l <= tp) { result = "TP"; exitT = y.t; break; }
      }
      const fee = FEE_PCT / riskPct;
      const netR = result === "TP" ? R - fee : result === "SL" ? -1 - fee : null;
      const a72 = rs(sym, b.t, 72, false), a6 = rs(sym, b.t, 6, false), x72 = rs(sym, b.t, 72, true), x6 = rs(sym, b.t, 6, true);
      if (!a72 || !a6 || !x72 || !x6) { console.log(`  (skipped: ${sym} ${iso(b.t)} -- not 72 h of closes before the entry)`); continue; }
      rows.push({ symbol: sym, entryT: b.t, entry: e, sl, tp, riskPct, result, exitT, netR, rallyType: d.signal.wick.rally.type,
        rs72: a72.rs, rs6: a6.rs, rs72x: x72.rs, rs6x: x6.rs, nMkt: a72.n, h2: a72.rs > RS72_MIN && a6.rs > RS6_MIN, h2x: x72.rs > RS72_MIN && x6.rs > RS6_MIN });
    }
  }
}
rows.sort((a, b) => a.entryT - b.entryT);

// ── metrics ──
// market events: ALL entries (any coin, any group) less than EVENT_GAP_H apart = one event; a group counts the distinct
// events its entries belong to (so a group never has more events than all signals together)
const eventOf = new Map<Row, number>();
{ let id = -1, last = -Infinity; for (const r of rows) { if (r.entryT - last >= EVENT_GAP_H * H) id++; eventOf.set(r, id); last = r.entryT; } }
const events = (rs: Row[]): number => new Set(rs.map((r) => eventOf.get(r))).size;
function maxDD(rs: Row[]): number {        // closed trades in exit order, cumulative net R, the deepest fall from a peak
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs.filter((x) => x.netR !== null).sort((a, b) => a.exitT! - b.exitT! || a.entryT - b.entryT)) { eq += r.netR!; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return dd;
}
function line(name: string, rs: Row[]): void {
  const tp = rs.filter((r) => r.result === "TP").length, sl = rs.filter((r) => r.result === "SL").length, op = rs.length - tp - sl;
  const net = rs.reduce((s, r) => s + (r.netR ?? 0), 0), closed = tp + sl;
  console.log(`  ${name.padEnd(34)} n ${String(rs.length).padStart(3)} | TP ${String(tp).padStart(3)} SL ${String(sl).padStart(3)} OPEN ${op} | win ${closed ? Math.round((100 * tp) / closed) : 0}% | net ${net >= 0 ? "+" : ""}${net.toFixed(1)}R (${closed ? (net / closed).toFixed(2) : "n/a"} R/trade) | max DD ${maxDD(rs).toFixed(1)}R | events ${events(rs)}`);
}
function permP(a: Row[], b: Row[]): number {   // one-sided: P(mean R of H2 <= observed) under random relabelling
  const A = a.filter((r) => r.netR !== null).map((r) => r.netR!), Bv = b.filter((r) => r.netR !== null).map((r) => r.netR!);
  if (!A.length || !Bv.length) return NaN;
  const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
  const obs = mean(A) - mean(Bv), all = [...A, ...Bv];
  let seed = 1, hit = 0;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let it = 0; it < 20000; it++) {
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    if (mean(all.slice(0, A.length)) - mean(all.slice(A.length)) <= obs + 1e-12) hit++;
  }
  return hit / 20000;
}

const span = rows.length ? `${iso(rows[0].entryT)} -> ${iso(rows[rows.length - 1].entryT)} UTC` : "no entries";
console.log(`H2 ${discovery ? "DISCOVERY CHECK (all entries)" : `HOLDOUT (entries from ${iso(HOLDOUT_START)} UTC)`} · file ${file} · ${raw.size} coins · data ${iso(t0)} -> ${iso(t1 + H)} UTC · entries ${span}`);
console.log(`  rule fixed: rs72 > +${RS72_MIN}% AND rs6 > ${RS6_MIN} -> "dangerous"; TP ${R}R; fee ${FEE_PCT}% round trip; ${MAX_HOURS} h limit; events = entries < ${EVENT_GAP_H} h apart`);
console.log("\nPRIMARY (the market median includes the coin itself, as in the discovery):");
line("all signals", rows);
line("H2 dangerous", rows.filter((r) => r.h2));
line("the rest", rows.filter((r) => !r.h2));
console.log(`  one-sided permutation p (H2 mean R lower than the rest): ${permP(rows.filter((r) => r.h2), rows.filter((r) => !r.h2)).toFixed(3)}`);
console.log("\nCHECK (the coin removed from the market median):");
line("H2 dangerous", rows.filter((r) => r.h2x));
line("the rest", rows.filter((r) => !r.h2x));
const flip = rows.filter((r) => r.h2 !== r.h2x);
console.log(`  entries that change group when the coin is removed: ${flip.length}${flip.length ? " -- " + flip.map((r) => `${r.symbol} ${iso(r.entryT)}`).join(", ") : ""}`);
if (rows.length) console.log(`  market size per entry (coins with both closes): min ${Math.min(...rows.map((r) => r.nMkt))}, max ${Math.max(...rows.map((r) => r.nMkt))}`);

const out = file.replace(/[^/]*$/, "") + `h2_${discovery ? "discovery" : "holdout"}_entries.csv`;
fs.writeFileSync(out, ["symbol,entry_utc,entry,sl,tp,sl_pct,result,exit_hour_utc,net_r,rally_type,rs72,rs6,h2_dangerous,rs72_excl_self,rs6_excl_self,h2_excl_self,market_coins"]
  .concat(rows.map((r) => [r.symbol, iso(r.entryT), r.entry, r.sl, +r.tp.toPrecision(8), r.riskPct.toFixed(3), r.result, r.exitT ? iso(r.exitT) : "", r.netR?.toFixed(3) ?? "", r.rallyType, r.rs72.toFixed(3), r.rs6.toFixed(3), r.h2, r.rs72x.toFixed(3), r.rs6x.toFixed(3), r.h2x, r.nMkt].join(","))).join("\n") + "\n");
console.log(`\nevery entry -> ${out}`);
