/**
 * OI accumulation -> full cleanup (research rules). Usage: npx tsx tests/oi-cleanup.test.ts
 */
import * as assert from "assert";
import { findCleanups, type CuHour } from "../src/research/oi-cleanup";

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
const H = 3_600_000,
  T0 = Date.UTC(2026, 8, 1);
/** [close, oi] per hour; open = previous close, high/low = max/min(open, close) */
function hours(v: Array<[number, number]>): CuHour[] {
  return v.map(([c, oi], i) => {
    const o = i ? v[i - 1][0] : c;
    return {
      t: T0 + i * H,
      open: o,
      high: Math.max(o, c),
      low: Math.min(o, c),
      close: c,
      oi,
    };
  });
}

scenario(
  "DOWN accumulation cleaned further down -> REVERSAL LONG, confirmed by a green close",
  () => {
    const h = hours([
      [100, 1000],
      [99, 1010],
      [98, 1020],
      [97, 1030],
      [96, 1015],
      [95, 995],
      [96, 994],
      [98, 994],
      [99, 994],
    ]);
    const e = findCleanups(h, 1);
    assert.strictEqual(e.length, 1);
    assert.deepStrictEqual(
      [e[0].accDir, e[0].kind, e[0].side, e[0].confirmed, e[0].entry],
      ["DOWN", "REVERSAL", "LONG", true, 96],
    );
    assert.strictEqual(e[0].peakTs, T0 + 3 * H);
    assert.strictEqual(e[0].cleanTs, T0 + 5 * H);
    assert.strictEqual(e[0].entryTs, T0 + 7 * H);
    assert.ok(e[0].accPct > 2.9 && e[0].accPct < 3.1);
    assert.ok(e[0].cleanedPct > 100);
    assert.strictEqual(e[0].after!.hit["2"]!.hours, 1); // 96 -> 98 = +2.08% in the 1st hour after entry
  },
);

scenario(
  "DOWN accumulation cleaned while price goes UP -> CONTINUATION SHORT",
  () => {
    const h = hours([
      [100, 1000],
      [99, 1010],
      [98, 1030],
      [99, 1010],
      [100, 999],
      [99, 999],
      [97, 999],
    ]);
    const e = findCleanups(h, 1);
    assert.deepStrictEqual(
      [e[0].kind, e[0].side, e[0].confirmed, e[0].entry],
      ["CONTINUATION", "SHORT", true, 99],
    );
  },
);

scenario(
  "UP accumulation cleaned higher -> REVERSAL SHORT; not confirmed when the next candle is the wrong colour",
  () => {
    const h = hours([
      [100, 1000],
      [101, 1020],
      [102, 1030],
      [103, 990],
      [104, 990],
    ]);
    const e = findCleanups(h, 1);
    assert.deepStrictEqual(
      [e[0].kind, e[0].side, e[0].confirmed, e[0].entry, e[0].after],
      ["REVERSAL", "SHORT", false, null, null],
    );
  },
);

scenario(
  "partial cleanup is not an event; a new higher peak must be cleaned all the way back to the start",
  () => {
    const h = hours([
      [100, 1000],
      [101, 1020],
      [100, 1005],
      [102, 1040],
      [101, 1010],
      [100, 1001],
      [99, 1000],
      [98, 1000],
    ]);
    const e = findCleanups(h, 1);
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].peakTs, T0 + 3 * H);
    assert.strictEqual(e[0].cleanTs, T0 + 6 * H);
  },
);

scenario(
  "small accumulations (< minAcc) are skipped and the counting restarts",
  () => {
    const h = hours([
      [100, 1000],
      [101, 1005],
      [100, 999],
      [99, 1030],
      [98, 990],
      [99, 990],
      [100, 990],
    ]);
    const e = findCleanups(h, 1);
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].startTs, T0 + 2 * H);
    assert.strictEqual(e[0].kind, "REVERSAL");
    assert.strictEqual(e[0].side, "LONG");
  },
);

scenario("hours without OI are skipped, never counted as a cleanup", () => {
  const h = hours([
    [100, 1000],
    [99, 1030],
    [98, NaN],
    [97, 1025],
  ]);
  assert.strictEqual(findCleanups(h, 1).length, 0);
});

scenario(
  "the result does not depend on where the data starts: an old low (> maxAccH back) does not swallow a later accumulation",
  () => {
    const body: Array<[number, number]> = [
      [100, 1000],
      [99, 1010],
      [98, 1020],
      [97, 1030],
      [96, 1015],
      [95, 995],
      [96, 994],
      [98, 994],
      [99, 994],
    ];
    // long ago OI was far lower (900), then it sat at 1000 for 60 hours before the accumulation
    const prefix: Array<[number, number]> = [
      ...Array.from({ length: 30 }, (): [number, number] => [100, 900]),
      ...Array.from({ length: 60 }, (): [number, number] => [100, 1000]),
    ];
    const a = findCleanups(hours(body), 1),
      b = findCleanups(hours([...prefix, ...body]), 1);
    assert.strictEqual(b.length, 1);
    assert.deepStrictEqual(
      [b[0].kind, b[0].side, b[0].peakTs - b[0].startTs, b[0].entry],
      [a[0].kind, a[0].side, a[0].peakTs - a[0].startTs, a[0].entry],
    );
    assert.strictEqual(
      findCleanups(hours([...prefix, ...body]), 1, 168).length,
      0,
    ); // with a 7-day window the old low counts
  },
);

scenario(
  "when two accumulations are cleaned in the same hour the bigger one is reported once",
  () => {
    const h = hours([
      [100, 1000],
      [101, 1040],
      [100, 1020],
      [101, 1030],
      [99, 990],
      [98, 990],
      [97, 990],
    ]);
    const e = findCleanups(h, 1);
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].peakTs, T0 + H);
    assert.strictEqual(e[0].startTs, T0);
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
