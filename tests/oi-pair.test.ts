/**
 * OI episodes of two coins and their lag. Usage: npx tsx tests/oi-pair.test.ts
 */
import * as assert from "assert";
import { pairEpisodes, type Episode } from "../src/research/oi-pair";

let passed = 0,
  failed = 0;
function scenario(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(
      `  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
const H = 3_600_000;
const ep = (dir: "UP" | "DOWN", s: number, pk: number, e: number): Episode => ({
  dir,
  start: s * H,
  peak: pk * H,
  dropEnd: e * H,
  priceStart: 1,
  pricePeak: 1,
  priceDropEnd: 1,
  oiStart: 1,
  oiPeak: 1,
  oiDropEnd: 1,
  built: 0,
  takenPct: 0,
  ongoing: false,
});

scenario(
  "matches the same-direction episode that overlaps most, lag in hours (coin later = +)",
  () => {
    const [p] = pairEpisodes(
      [ep("UP", 10, 14, 16)],
      [ep("UP", 11, 15, 18), ep("DOWN", 10, 14, 16), ep("UP", 30, 32, 33)],
    );
    assert.deepStrictEqual([p.startLagH, p.peakLagH, p.dropEndLagH], [1, 1, 2]);
  },
);
scenario("no overlapping same-direction episode -> null", () => {
  assert.strictEqual(
    pairEpisodes([ep("UP", 10, 14, 16)], [ep("DOWN", 10, 14, 16)])[0].coin,
    null,
  );
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
