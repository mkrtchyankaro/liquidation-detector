/**
 * V11 engine ("squeeze wick", Oct 12 2026): hand-made scenarios for every rule, the LONG mirror, and the regression
 * against the research data (25 coins x 14 days): the same 112 wicks (time, type, "meaningful"), the same 44 entries and
 * the same 1H results as the study (2R: 19 TP / 21 SL; T1: 18 entries 9 / 7; meaningful: 23 entries 11 / 9).
 * Usage: npx tsx tests/v11-engine.test.ts
 */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { decideAt, DEFAULT_V11_RULE, H, quantile, rallyAt, tpFor, wickAt, type V11Bar, type V11Decision } from "../src/strategy/v11/v11-engine";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`); }
}

import { scene } from "./helpers/v11-scene";
const kinds = (d: V11Decision[]): string => d.map((x) => x.kind).join(",");
/** the LONG mirror of a scene: prices reflected around 100, short <-> long liquidations, OI the same */
const mirror = (B: V11Bar[]): V11Bar[] => B.map((b) => ({ ...b, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c, shortLiq: b.longLiq, longLiq: b.shortLiq }));

async function run(): Promise<void> {
  console.log("V11 engine");

  await scenario("the rally at hour 90: +6 % vs a ~0.5 % norm, OI down -> T1, start = the 84 close", () => {
    const B = scene(), r = rallyAt(B, 90, "SHORT")!;
    assert.ok(r, "a rally");
    assert.strictEqual(r.type, "T1");
    assert.strictEqual(r.startT, B[84].t + H);
    assert.ok(r.movePct > 5.9 && r.movePct < 6.3, `move ${r.movePct}`);
    assert.ok(r.oiPct < -4, `OI ${r.oiPct}`);
    assert.strictEqual(rallyAt(B, 50, "SHORT"), null, "no rally in the quiet part");
  });

  await scenario("the wick at hour 92 is found at its close (WICK), confirmed by hour 93 (OI up, price -0.2 %) -> SIGNAL, entry 94:00, SL = 107.5", () => {
    const B = scene();
    assert.strictEqual(kinds(decideAt(B, 92, "SHORT")), "WICK");
    const d = decideAt(B, 93, "SHORT");
    assert.strictEqual(kinds(d), "SIGNAL");
    const s = (d[0] as Extract<V11Decision, { kind: "SIGNAL" }>).signal;
    assert.strictEqual(s.entryT, B[94].t);
    assert.strictEqual(s.stop, 107.5);
    assert.strictEqual(s.confirm.n, 1);
    assert.strictEqual(s.wick.rally.type, "T1");
    assert.strictEqual(s.wick.meaningful, true, "$200K vs p85 ~$4K");
    assert.ok(s.confirm.oiPct > 0.4 && s.confirm.pricePct < 0);
    assert.strictEqual(kinds(decideAt(B, 94, "SHORT")), "", "decided once: nothing more at 94");
  });

  await scenario("the first candle has OI down -> wait; the second has OI up -> SIGNAL (n = 2, entry 95:00)", () => {
    const B = scene([{ oc: 0 }, {}]);
    B[93].oc = B[93].oo * 0.995; B[94].oo = B[93].oc; B[94].oc = B[94].oo * 1.004;
    assert.strictEqual(kinds(decideAt(B, 93, "SHORT")), "");
    const d = decideAt(B, 94, "SHORT");
    assert.strictEqual(kinds(d), "SIGNAL");
    const s = (d[0] as Extract<V11Decision, { kind: "SIGNAL" }>).signal;
    assert.strictEqual(s.confirm.n, 2);
    assert.strictEqual(s.entryT, B[95].t);
  });

  await scenario("a new high above the wick's high -> CANCELLED, never a signal later", () => {
    const B = scene([{ h: 108 }]);
    assert.strictEqual(kinds(decideAt(B, 93, "SHORT")), "CANCELLED");
    assert.ok(!kinds(decideAt(B, 94, "SHORT")).includes("SIGNAL"));
  });

  await scenario("the second candle above the wick's high (the first quiet, OI down) -> CANCELLED", () => {
    const B = scene([{}, { h: 107.6 }]);
    B[93].oc = B[93].oo * 0.995; B[94].oo = B[93].oc;
    assert.strictEqual(kinds(decideAt(B, 94, "SHORT")), "CANCELLED");
  });

  await scenario("OI down in both candles -> EXPIRED (no trade)", () => {
    const B = scene();
    B[93].oc = B[93].oo * 0.995; B[94].oo = B[93].oc; B[94].oc = B[94].oo * 0.995;
    assert.strictEqual(kinds(decideAt(B, 93, "SHORT")), "");
    assert.strictEqual(kinds(decideAt(B, 94, "SHORT")), "EXPIRED");
  });

  await scenario("a strong green candle (+0.5 %) with OI up does NOT confirm (limit 0.3 %); confirmCandles 1 -> expired at once", () => {
    const B = scene([{ c: 106.2 * 1.005, h: 106.9 }]);
    assert.strictEqual(kinds(decideAt(B, 93, "SHORT")), "");
    assert.strictEqual(kinds(decideAt(B, 93, "SHORT", { ...DEFAULT_V11_RULE, confirmCandles: 1 })), "EXPIRED");
  });

  await scenario("no wick: liquidations unknown (liqOk false) in one of the 3 hours before, or the close in the upper half, or liquidations under p85", () => {
    const a = scene(); a[90].liqOk = false;
    assert.strictEqual(wickAt(a, 92, "SHORT"), null);
    const b = scene(); b[92].c = 107.2;
    assert.strictEqual(wickAt(b, 92, "SHORT"), null);
    const c = scene(); c[92].shortLiq = 3_000;
    assert.strictEqual(wickAt(c, 92, "SHORT"), null);
    const d = scene(); d[92].h = Math.max(...d.slice(85, 92).map((b) => b.h)) - 0.01; d[92].c = 105.85;   // not above the rally's highs
    assert.strictEqual(wickAt(d, 92, "SHORT"), null);
  });

  await scenario("a missing hour (null) -> no decision at all", () => {
    const B: Array<V11Bar | null> = scene(); B[93] = null;
    assert.strictEqual(kinds(decideAt(B, 93, "SHORT")), "");
    const C: Array<V11Bar | null> = scene(); C[60] = null;   // inside the 72 h norm
    assert.strictEqual(wickAt(C, 92, "SHORT"), null);
  });

  await scenario("meaningful: >= $30K AND >= 2 x p85 (a $20K wick is a wick, not meaningful)", () => {
    const B = scene(); B[92].shortLiq = 20_000;
    const w = wickAt(B, 92, "SHORT")!;
    assert.ok(w && !w.meaningful);
  });

  await scenario("the LONG mirror: a fall, long liquidations, a new low, OI up -> SIGNAL with SL = the wick's low", () => {
    const B = mirror(scene());
    assert.strictEqual(kinds(decideAt(B, 93, "SHORT")), "", "no SHORT in a fall");
    const d = decideAt(B, 93, "LONG");
    assert.strictEqual(kinds(d), "SIGNAL");
    const s = (d[0] as Extract<V11Decision, { kind: "SIGNAL" }>).signal;
    assert.ok(Math.abs(s.stop - 92.5) < 1e-9);
    assert.strictEqual(s.side, "LONG");
  });

  await scenario("tpFor: SHORT entry 100, SL 101, 2R -> 98; LONG entry 100, SL 99, 2.5R -> 102.5; quantile = the research's", () => {
    assert.strictEqual(tpFor("SHORT", 100, 101, 2), 98);
    assert.strictEqual(tpFor("LONG", 100, 99, 2.5), 102.5);
    assert.strictEqual(quantile([5, 1, 4, 2, 3], 0.85), 5);
    assert.strictEqual(quantile([5, 1, 4, 2, 3], 0.5), 3);
  });

  await scenario("REGRESSION vs the research (25 coins x 14 days): the same 112 wicks, types, flags; 44 entries; 2R 19/21, T1 9/7, meaningful 11/9", () => {
    const dir = path.join(__dirname, "fixtures");
    const lines = zlib.gunzipSync(fs.readFileSync(path.join(dir, "research_1h_clean.csv.gz"))).toString("utf8").trim().split(/\r?\n/);
    const head = lines[0].split(","), ix = (n: string): number => head.indexOf(n);
    const P = (s: string): number => Date.parse(s.replace(" ", "T") + ":00Z");
    const by = new Map<string, V11Bar[]>();
    for (const l of lines.slice(1)) {
      const r = l.split(",");
      const b: V11Bar = { t: P(r[ix("open_time_utc")]), o: +r[ix("open")], h: +r[ix("high")], l: +r[ix("low")], c: +r[ix("close")], oo: +r[ix("oi_open")], oc: +r[ix("oi_close")], shortLiq: +r[ix("short_liq_usd")], longLiq: +r[ix("long_liq_usd")], liqOk: r[ix("liq_data_ok")] === "1" };
      if (!by.has(r[0])) by.set(r[0], []);
      by.get(r[0])!.push(b);
    }
    const ex = fs.readFileSync(path.join(dir, "squeeze_wick_examples.csv"), "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
    const TY: Record<string, string> = { T1: "T1 (OI down)", T2: "T2 (OI up)", FLAT: "flat OI" };
    const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");
    const mine: string[] = [];
    const sigs: Array<{ B: V11Bar[]; i: number; sl: number; type: string; meaningful: boolean }> = [];
    for (const [sym, B] of by) {
      B.sort((a, b) => a.t - b.t);
      for (let i = 1; i < B.length; i++) assert.strictEqual(B[i].t - B[i - 1].t, H, "consecutive hours");
      for (let w = 0; w < B.length; w++) {
        const wk = wickAt(B, w, "SHORT");
        if (wk && w < B.length - 6) mine.push(`${iso(wk.t)},${sym},${TY[wk.rally.type]},${wk.meaningful ? "True" : "False"}`);
        for (const d of decideAt(B, w, "SHORT")) if (d.kind === "SIGNAL") sigs.push({ B, i: w + 1, sl: d.signal.stop, type: d.signal.wick.rally.type, meaningful: d.signal.wick.meaningful });
      }
    }
    const theirs = ex.map((r) => `${r[0]},${r[1]},${r[2]},${r[11]}`);
    assert.deepStrictEqual([...mine].sort(), [...theirs].sort());
    const res = (f: (x: (typeof sigs)[0]) => boolean, R: number): string => {
      let tp = 0, sl = 0, op = 0;
      for (const x of sigs.filter(f)) {
        const e = x.B[x.i].o, risk = (x.sl - e) / e, tpp = e * (1 - R * risk);
        let r = "OPEN";
        for (let k = 0; k < 48 && x.i + k < x.B.length; k++) { const y = x.B[x.i + k]; if (y.h >= x.sl) { r = "SL"; break; } if (y.l <= tpp) { r = "TP"; break; } }
        if (r === "TP") tp++; else if (r === "SL") sl++; else op++;
      }
      return `${sigs.filter(f).length} ${tp}/${sl}/${op}`;
    };
    assert.strictEqual(res(() => true, 2), "44 19/21/4");
    assert.strictEqual(res(() => true, 2.5), "44 15/22/7");
    assert.strictEqual(res((x) => x.type === "T1", 2), "18 9/7/2");
    assert.strictEqual(res((x) => x.meaningful, 2), "23 11/9/3");
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
