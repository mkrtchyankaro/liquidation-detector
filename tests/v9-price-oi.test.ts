/**
 * PRICE_OI confirmation: OI falling while price moves AGAINST the liquidation
 * move = the other side is being closed -> confirm. OI falling while price
 * still moves WITH it = victims still closing -> keep waiting.
 * Usage: npx tsx tests/v9-price-oi.test.ts
 */
import * as assert from "assert";
import { changePoints, type Bucket } from "../src/strategy/v9/v9-core";
import {
  priceOiEpisodes,
  typicalMinuteNoise,
} from "../src/strategy/v9/v9-price-oi";

let passed = 0,
  failed = 0;
function scenario(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(
      `  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
const M = 60_000,
  T = 1_790_000_000_000 - (1_790_000_000_000 % M);
/** piecewise series: [[fromMinute, value], ...] linearly interpolated */
function path(points: Array<[number, number]>, n: number): number[] {
  const out: number[] = [];
  for (let m = 0; m < n; m++) {
    let j = 0;
    while (j < points.length - 2 && m > points[j + 1][0]) j++;
    const [a, va] = points[j],
      [b, vb] = points[j + 1];
    out.push(m <= a ? va : m >= b ? vb : va + ((vb - va) * (m - a)) / (b - a));
  }
  return out;
}
function buckets(
  oi: number[],
  price: number[],
  liq: Record<number, { short?: number; long?: number }>,
): Bucket[] {
  return oi.map((o, m) => ({
    ts: T + m * M,
    long: liq[m]?.long ?? 0,
    short: liq[m]?.short ?? 0,
    count: liq[m] ? 1 : 0,
    oi: o,
    price: price[m],
    oiPoints: 1,
  }));
}

console.log("V9 PRICE_OI confirmation");

scenario(
  "ADA-like: short squeeze up, plateau, then OI falls while price falls -> confirmed at the reversal, not before",
  () => {
    const n = 60;
    const oi = path(
      [
        [0, 100],
        [5, 100],
        [10, 98],
        [15, 98],
        [30, 96],
        [59, 96],
      ],
      n,
    );
    const price = path(
      [
        [0, 1.0],
        [5, 1.0],
        [10, 1.02],
        [15, 1.02],
        [30, 1.0],
        [59, 1.0],
      ],
      n,
    );
    const b = buckets(oi, price, {
      6: { short: 90_000 },
      7: { short: 2_000 },
      8: { short: 500 },
    });
    const eps = priceOiEpisodes(b, changePoints(b.map((x) => x.oi)), T + n * M);
    assert.strictEqual(eps.length, 1);
    const e = eps[0];
    assert.strictEqual(e.victim, "SHORT");
    assert.ok(Number.isFinite(e.confirmTs), "confirmed");
    const k = (e.confirmTs - T) / M - 1;
    assert.ok(
      k >= 15 && k <= 18,
      `confirmed when price starts falling with OI (minute ${k})`,
    );
    assert.ok(
      Math.abs(e.extremePrice - 1.02) < 1e-9,
      "extreme = top of the squeeze",
    );
    assert.ok(e.priceMovePct > 1.9, "move measured start -> extreme");
  },
);

scenario(
  "OI keeps falling while price keeps RISING -> victims still closing, no confirmation",
  () => {
    const n = 40;
    const oi = path(
      [
        [0, 100],
        [5, 100],
        [39, 95],
      ],
      n,
    );
    const price = path(
      [
        [0, 1.0],
        [5, 1.0],
        [39, 1.05],
      ],
      n,
    );
    const b = buckets(oi, price, { 6: { short: 50_000 } });
    const eps = priceOiEpisodes(b, changePoints(b.map((x) => x.oi)), T + n * M);
    assert.ok(eps.length === 1 && !Number.isFinite(eps[0].confirmTs));
  },
);

scenario(
  "while OI is flat a pull-back confirms nothing; a later victim liquidation moves the base; confirm only after it",
  () => {
    const n = 60;
    const oi = path(
      [
        [0, 100],
        [5, 100],
        [10, 98],
        [20, 98],
        [35, 96],
        [59, 96],
      ],
      n,
    );
    const price = path(
      [
        [0, 1.0],
        [5, 1.0],
        [10, 1.02],
        [12, 1.015],
        [13, 1.022],
        [20, 1.022],
        [35, 1.0],
        [59, 1.0],
      ],
      n,
    );
    const b = buckets(oi, price, {
      6: { short: 90_000 },
      13: { short: 1_000 },
    });
    const e = priceOiEpisodes(
      b,
      changePoints(b.map((x) => x.oi)),
      T + n * M,
    )[0];
    const k = (e.confirmTs - T) / M - 1;
    assert.ok(
      k >= 20,
      `no confirmation during the flat-OI pull-back; confirmed at minute ${k}`,
    );
    assert.ok(
      Math.abs(e.extremePrice - 1.022) < 1e-9,
      "extreme includes the later push",
    );
  },
);

scenario(
  "a small pull-back WHILE OI is falling does confirm (the rule is sensitive by design -- replay decides)",
  () => {
    const n = 60;
    const oi = path(
      [
        [0, 100],
        [5, 100],
        [10, 98],
        [30, 94],
        [59, 94],
      ],
      n,
    );
    const price = path(
      [
        [0, 1.0],
        [5, 1.0],
        [10, 1.02],
        [14, 1.015],
        [18, 1.03],
        [30, 1.01],
        [59, 1.01],
      ],
      n,
    );
    const b = buckets(oi, price, { 6: { short: 90_000 } });
    const e = priceOiEpisodes(
      b,
      changePoints(b.map((x) => x.oi)),
      T + n * M,
    )[0];
    const k = (e.confirmTs - T) / M - 1;
    assert.ok(
      k >= 11 && k <= 14,
      `confirmed at the first pull-back (minute ${k})`,
    );
  },
);

scenario(
  "LONG victims mirror: price falls, then OI falls while price rises -> confirm",
  () => {
    const n = 60;
    const oi = path(
      [
        [0, 100],
        [5, 100],
        [10, 98],
        [15, 98],
        [30, 96],
        [59, 96],
      ],
      n,
    );
    const price = path(
      [
        [0, 1.0],
        [5, 1.0],
        [10, 0.98],
        [15, 0.98],
        [30, 1.0],
        [59, 1.0],
      ],
      n,
    );
    const b = buckets(oi, price, { 6: { long: 90_000 } });
    const e = priceOiEpisodes(
      b,
      changePoints(b.map((x) => x.oi)),
      T + n * M,
    )[0];
    assert.strictEqual(e.victim, "LONG");
    assert.ok(Number.isFinite(e.confirmTs));
    assert.ok(Math.abs(e.extremePrice - 0.98) < 1e-9);
  },
);

scenario(
  "significance: a reversal smaller than the required size does not confirm; a large enough one does",
  () => {
    const n = 60;
    const oi = path(
      [
        [0, 100],
        [5, 100],
        [10, 98],
        [30, 94],
        [59, 94],
      ],
      n,
    );
    const price = path(
      [
        [0, 1.0],
        [5, 1.0],
        [10, 1.02],
        [14, 1.015],
        [18, 1.03],
        [30, 1.01],
        [59, 1.01],
      ],
      n,
    );
    const b = buckets(oi, price, { 6: { short: 90_000 } });
    const regimes = changePoints(b.map((x) => x.oi));
    const loose = priceOiEpisodes(b, regimes, T + n * M, {
      minOiDrop: 0.01,
      minReversal: 0.001,
    })[0];
    const strict = priceOiEpisodes(b, regimes, T + n * M, {
      minOiDrop: 0.01,
      minReversal: 0.01,
    })[0];
    const kLoose = (loose.confirmTs - T) / M - 1,
      kStrict = (strict.confirmTs - T) / M - 1;
    assert.ok(kLoose <= 14, `small reversal allowed -> early (${kLoose})`);
    assert.ok(
      kStrict > 18,
      `needs 1% off the 1.03 top -> after the second push (${kStrict})`,
    );
  },
);

scenario(
  "typical one-minute noise = median absolute minute change (from the data)",
  () => {
    const b = buckets(
      [100, 101, 103, 102, 102],
      [1, 1.01, 1.03, 1.02, 1.02],
      {},
    );
    const nz = typicalMinuteNoise(b);
    assert.strictEqual(nz.minOiDrop, 1);
    assert.ok(Math.abs(nz.minReversal - 0.01) < 1e-12);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
