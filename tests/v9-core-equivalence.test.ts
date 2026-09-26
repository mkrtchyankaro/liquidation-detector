/**
 * The live V9 core (src/strategy/v9/v9-core.ts) must reproduce the research
 * script scripts/liquidation-episodes-v13.js EXACTLY on the same data:
 * same regimes, same episodes (start, end, side, confirm time, OI drop,
 * move, extreme, parts) and same features (DOM, DIR, EXH, CLR, move).
 *
 * Usage: npx tsx tests/v9-core-equivalence.test.ts
 */
import * as assert from "assert";
import * as path from "path";
import { analyzeWindow, buildBuckets, changePoints, episodeFeatures, mergeEpisodes, subEpisodes, usableRange, type LiqEvent, type OiObservation } from "../src/strategy/v9/v9-core";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const research = require(path.join(__dirname, "..", "scripts", "liquidation-episodes-v13.js"));

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}

/** Deterministic pseudo-random market: OI random walk with liquidation
 *  bursts that drain OI, then rebuilding phases. */
function market(seed: number, minutes: number): { liq: LiqEvent[]; oi: OiObservation[]; from: number; until: number } {
  let x = seed >>> 0;
  const rnd = (): number => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  const from = 1_790_000_000_000;
  const liq: LiqEvent[] = [], oi: OiObservation[] = [];
  let level = 100_000, price = 50_000, burst = 0, burstSide: "LONG" | "SHORT" = "LONG";
  for (let m = 0; m < minutes; m++) {
    const t = from + m * 60_000;
    if (burst === 0 && rnd() < 0.02) { burst = 5 + Math.floor(rnd() * 40); burstSide = rnd() < 0.5 ? "LONG" : "SHORT"; }
    if (burst > 0) {
      burst--;
      level *= 1 - rnd() * 0.002;
      price *= burstSide === "LONG" ? 1 - rnd() * 0.002 : 1 + rnd() * 0.002;
      const n = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) liq.push({ ts: t + Math.floor(rnd() * 59_000), victim: rnd() < 0.85 ? burstSide : (burstSide === "LONG" ? "SHORT" : "LONG"), usd: rnd() * 50_000 });
    } else {
      level *= 1 + (rnd() - 0.45) * 0.0008;
      price *= 1 + (rnd() - 0.5) * 0.0008;
      if (rnd() < 0.05) liq.push({ ts: t + Math.floor(rnd() * 59_000), victim: rnd() < 0.5 ? "LONG" : "SHORT", usd: rnd() * 5_000 });
    }
    // a few polls per minute; some minutes without an exchange update
    if (rnd() < 0.93) {
      const updated = t + Math.floor(rnd() * 50_000);
      for (let p = 0; p < 3; p++) oi.push({ ts: updated + 200 + p * 1000, updated, oi: level, price });
    }
  }
  return { liq, oi, from, until: from + (minutes - 1) * 60_000 + 30_000 };
}

function researchRun(d: ReturnType<typeof market>) {
  const events = d.liq.filter((e) => e.ts >= d.from && e.ts <= d.until);
  const obs = d.oi.filter((o) => o.updated >= d.from && o.updated <= d.until);
  const buckets = research.buildBuckets(events, obs, d.from, d.until);
  const first = buckets.findIndex((b: { oi: number }) => Number.isFinite(b.oi));
  const last = buckets.findLastIndex((b: { oi: number }) => Number.isFinite(b.oi));
  const usable = buckets.slice(first, last + 1);
  const regimes = research.changePoints(usable.map((b: { oi: number }) => b.oi));
  const episodes = research.episodesFromRegimes(usable, regimes, d.from, d.until);
  return { usable, regimes, episodes, featured: episodes.map((e: unknown) => research.episodeFeatures(usable, e)) };
}

const close = (a: number, b: number): boolean => (Number.isNaN(a) && Number.isNaN(b)) || a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

console.log("V9 core equivalence with research v13");
for (const seed of [1, 7, 42, 99, 2024]) {
  scenario(`seed ${seed}: regimes, episodes and features are identical`, () => {
    const d = market(seed, 3 * 1440);
    const r = researchRun(d);
    const live = analyzeWindow(d.liq, d.oi, d.from, d.until);
    assert.ok(live);
    const liveRegimes = changePoints(usableRange(buildBuckets(d.liq.filter((e) => e.ts >= d.from && e.ts <= d.until), d.oi.filter((o) => o.updated >= d.from && o.updated <= d.until), d.from, d.until))!.map((b) => b.oi));
    assert.deepStrictEqual(liveRegimes.map((g) => [g.a, g.b]), r.regimes.map((g: { a: number; b: number }) => [g.a, g.b]), "regime boundaries");
    assert.strictEqual(live!.episodes.length, r.episodes.length, "episode count");
    assert.ok(r.episodes.length > 3, `test data must produce episodes (got ${r.episodes.length})`);
    live!.episodes.forEach((e, i) => {
      const o = r.episodes[i];
      for (const k of ["start", "end", "victim", "parts", "endReason", "sIdx", "eIdx"] as const) assert.strictEqual(e[k], o[k], `episode ${i} ${k}`);
      for (const k of ["confirmTs", "oiDropPct", "priceMovePct", "extremePrice", "long", "short"] as const) assert.ok(close(e[k] as number, o[k]), `episode ${i} ${k}: ${e[k]} vs ${o[k]}`);
      const f = episodeFeatures(live!.buckets, e), of = r.featured[i];
      assert.strictEqual(f.dom, of.checks.DOM, `episode ${i} DOM`);
      assert.strictEqual(f.dir, of.checks.DIR, `episode ${i} DIR`);
      assert.strictEqual(f.exh, of.exh, `episode ${i} EXH`);
      assert.ok(close(f.clr, of.clr), `episode ${i} CLR`);
      assert.ok(close(f.dirMove, of.dirMove), `episode ${i} dirMove`);
    });
  });
}
scenario("minOppositeLiqUsd: small opposite parts no longer close an episode; huge threshold = no confirmations", () => {
  const d = market(42, 3 * 1440);
  const w = analyzeWindow(d.liq, d.oi, d.from, d.until)!;
  const regimes = changePoints(w.buckets.map((b) => b.oi));
  const subs = subEpisodes(w.buckets, regimes, d.until);
  const any = mergeEpisodes(w.buckets, subs);
  const same = mergeEpisodes(w.buckets, subs, 0);
  assert.deepStrictEqual(same.map((e) => e.confirmTs), any.map((e) => e.confirmTs), "threshold 0 = research behaviour");
  const none = mergeEpisodes(w.buckets, subs, Infinity);
  assert.ok(none.every((e) => !Number.isFinite(e.confirmTs)), "nothing can confirm");
  assert.ok(none.length < any.length, "absorbed parts merge episodes");
});

scenario("breakout: a SAME-side part with an OI drop after the accumulation confirms (trade follows it); classic merges it", () => {
  // OI: 100 -> 96 (LONG cleaning, min 1-5) -> 99 (growth 6-9) -> 95 (LONG again, 10-14) -> 98 (15-19) -> 94 (SHORT, 20-24) -> 97
  const oi = [100, 99, 98, 97, 96.5, 96, 97, 98, 99, 99, 98, 97, 96, 95.5, 95, 96, 97, 98, 98, 98, 97, 96, 95, 94.5, 94, 95, 96, 97, 97, 97];
  const bk = oi.map((v, i) => ({ ts: i * 60_000, long: 0, short: 0, count: 0, oi: v, price: 100 - i * 0.1, oiPoints: 1 }));
  const sub = (a: number, z: number, victim: "LONG" | "SHORT") => ({ start: a * 60_000, end: z * 60_000, sIdx: a, eIdx: z, victim, long: victim === "LONG" ? 1e5 : 0, short: victim === "SHORT" ? 1e5 : 0, count: 3, oiDropPct: 1, continuations: 0, opposite: 0, rightCensored: false, endReason: "GROWTH_END" });
  const subs = [sub(1, 10, "LONG"), sub(10, 20, "LONG"), sub(20, 29, "SHORT")];
  const classic = mergeEpisodes(bk, subs);
  assert.strictEqual(classic[0].parts, 2, "classic: the second LONG part is merged");
  assert.strictEqual(classic[0].confirmSide, "SHORT", "classic: confirmed only by the SHORT part");
  const brk = mergeEpisodes(bk, subs, undefined, true);
  assert.strictEqual(brk[0].parts, 1);
  assert.strictEqual(brk[0].confirmSide, "LONG", "breakout: the next LONG part confirms -> SELL");
  assert.strictEqual(brk[0].endReason, "BREAKOUT_SAME_SIDE");
  assert.strictEqual(brk[0].confirmTs, 11 * 60_000, "OI fell below the part's base (minute 9 = 99) at minute 10 -> known at 11");
  assert.strictEqual(brk[1].confirmSide, "SHORT", "breakout: then the SHORT part confirms the second one -> BUY");
  assert.strictEqual(brk[2].confirmSide, null, "last one not confirmed");
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
