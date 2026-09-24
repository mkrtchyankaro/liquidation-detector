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
import { analyzeWindow, buildBuckets, changePoints, episodeFeatures, usableRange, type LiqEvent, type OiObservation } from "../src/strategy/v9/v9-core";

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
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
