import assert from "node:assert/strict";
import {
  runStructure,
  trueRanges,
  DEFAULT_STRUCTURE,
  H4,
  type Candle4h,
} from "../src/research/structure4h";

let passed = 0,
  failed = 0;
async function scenario(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(
      `  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
const T0 = Date.UTC(2026, 8, 1);
/** rows: [open, high, low, close]; 4h candles from T0 */
const mk = (
  rows: Array<[number, number, number, number]>,
  start = T0,
): Candle4h[] =>
  rows.map(([o, h, l, c], i) => ({
    openTime: start + i * H4,
    closeTime: start + (i + 1) * H4,
    open: o,
    high: h,
    low: l,
    close: c,
  }));
/** 14 quiet candles first so ATR exists (range 1, around 10) */
const warm = (n = 14, px = 10): Array<[number, number, number, number]> =>
  Array.from(
    { length: n },
    () => [px, px + 0.5, px - 0.5, px] as [number, number, number, number],
  );
const noProm = { ...DEFAULT_STRUCTURE, minProminenceAtr: 0 };

async function main(): Promise<void> {
  console.log("4h structure (Phase 1)");
  await scenario(
    "ATR formula: TR uses the previous close; ATR = mean of the last 14 TRs",
    () => {
      const c = mk([
        [10, 11, 9, 10],
        [10, 10.5, 9.5, 10],
        [10, 13, 12, 12.5],
      ]);
      assert.deepEqual(trueRanges(c), [2, 1, 3]); // candle 2: max(13, 10) - min(12, 10) = 3 (gap up counted)
    },
  );

  await scenario(
    "example 1: a swing LOW is usable only at the close of candle i+R; zone = [low, body bottom]",
    () => {
      const rows = [
        ...warm(),
        [10.4, 10.6, 10.0, 10.1],
        [10.1, 10.2, 9.4, 9.5],
        [9.5, 9.6, 8.8, 9.0],
        [9.0, 9.1, 8.2, 8.9],
        [8.9, 9.3, 8.5, 9.2],
        [9.2, 9.8, 9.0, 9.7],
      ] as Array<[number, number, number, number]>;
      const c = mk(rows);
      const piv = 17; // index of the 8.2 candle
      // up to the close of i+1: not confirmed
      const early = runStructure("T", c.slice(0, piv + 2), noProm);
      assert.ok(
        !early.pivots.some((p) => p.index === piv),
        "not visible one candle after",
      );
      const r = runStructure("T", c, noProm);
      const p = r.pivots.find((x) => x.index === piv && x.kind === "LOW")!;
      assert.equal(p.price, 8.2);
      assert.equal(p.pivotTime, c[piv].openTime);
      assert.equal(
        p.confirmedAt,
        c[piv + 2].closeTime,
        "confirmedAt = close of candle i+R",
      );
      const z = r.zones.find((x) => x.sourcePivotIds.includes(p.id))!;
      assert.equal(z.lo, 8.2);
      assert.equal(z.hi, 8.9);
      assert.equal(z.createdAt, p.confirmedAt);
    },
  );

  await scenario(
    "example 2: equal highs -> only the first is a pivot (strict left, non-strict right)",
    () => {
      const rows = [
        ...warm(14, 50),
        [50, 50.5, 49.5, 50],
        [51, 52, 50.8, 51.5],
        [53, 55, 52.8, 54],
        [54, 55, 53.5, 53.8],
        [53.5, 53, 52, 52.2],
        [52, 51, 50, 50.5],
      ] as Array<[number, number, number, number]>;
      const r = runStructure("T", mk(rows), noProm);
      const highs = r.pivots.filter((p) => p.kind === "HIGH" && p.price === 55);
      assert.equal(highs.length, 1);
      assert.equal(highs[0].index, 16);
    },
  );

  await scenario(
    "a candle that opened before a zone existed is never a touch, even if it closes when the zone appears",
    () => {
      const rows = [
        ...warm(),
        [10.4, 10.6, 10.0, 10.1],
        [10.1, 10.2, 9.4, 9.5],
        [9.5, 9.6, 8.8, 9.0],
        [9.0, 9.1, 8.2, 8.9],
        [8.9, 9.3, 8.5, 9.2],
        [9.2, 9.8, 8.6, 9.7],
        [9.7, 9.9, 8.7, 9.6],
      ] as Array<[number, number, number, number]>;
      const c = mk(rows);
      const r = runStructure("T", c, noProm);
      const z = r.zones.find((x) => x.side === "SUPPORT" && x.lo === 8.2)!;
      // candle 19 (low 8.6 <= hi 8.9) closes exactly at createdAt -> not a touch; candle 20 (low 8.7) opens at createdAt -> a touch
      assert.equal(z.createdAt, c[19].closeTime);
      assert.equal(z.touches.length, 1);
      assert.equal(z.touches[0].candleOpenTime, c[20].openTime);
    },
  );

  await scenario(
    "example 3: BULL from HH+HL, PL-A protected low, CLOSE break -> NEUTRAL; WICK variant breaks earlier",
    () => {
      // zig-zag: L1 100 -> H1 110 -> L2 104 -> H2 118, then a wick below 104 (close above), then a close below
      const up = (
        a: number,
        b: number,
        n: number,
      ): Array<[number, number, number, number]> =>
        Array.from({ length: n }, (_, k) => {
          const p0 = a + ((b - a) * k) / n,
            p1 = a + ((b - a) * (k + 1)) / n;
          return [p0, Math.max(p0, p1) + 0.3, Math.min(p0, p1) - 0.3, p1];
        });
      const rows: Array<[number, number, number, number]> = [
        ...warm(14, 106),
        ...up(106, 100, 3),
        ...up(100, 110, 4),
        ...up(110, 104, 3),
        ...up(104, 118, 5),
        ...up(118, 112, 3),
      ];
      const wickIdx = rows.length;
      rows.push([112, 112.5, 103.5, 105]); // wick below 104.x, close above
      rows.push([105, 108, 104.8, 107]);
      const closeIdx = rows.length;
      rows.push([107, 107.5, 102, 102.5]); // close below
      rows.push([102.5, 103, 101, 101.5]);
      const c = mk(rows);
      const r = runStructure("T", c, noProm);
      const bull = r.events.find((e) => e.to === "BULL");
      assert.ok(bull, "became BULL");
      assert.ok(
        bull!.protected && Math.abs(bull!.protected.price - 103.7) < 0.5,
        `protected low near 104 (got ${bull!.protected?.price})`,
      );
      const brk = r.events.find((e) => e.from === "BULL" && e.to === "NEUTRAL");
      assert.ok(brk, "structure broke");
      assert.equal(
        brk!.at,
        c[closeIdx].closeTime,
        "CLOSE break at the candle that CLOSED below",
      );
      const w = runStructure("T", c, {
        ...noProm,
        breakRule: "WICK",
      }).events.find((e) => e.from === "BULL" && e.to === "NEUTRAL");
      assert.equal(
        w!.at,
        c[wickIdx].closeTime,
        "WICK break at the wick candle (still known only at its close)",
      );
    },
  );

  await scenario(
    "a snapshot at asOf never contains anything known later (pivot / zone / trend)",
    () => {
      const rows = [
        ...warm(),
        [10.4, 10.6, 10.0, 10.1],
        [10.1, 10.2, 9.4, 9.5],
        [9.5, 9.6, 8.8, 9.0],
        [9.0, 9.1, 8.2, 8.9],
        [8.9, 9.3, 8.5, 9.2],
        [9.2, 9.8, 9.0, 9.7],
      ] as Array<[number, number, number, number]>;
      const c = mk(rows);
      for (let n = 15; n <= c.length; n++) {
        const r = runStructure("T", c.slice(0, n), noProm);
        const asOf = c[n - 1].closeTime;
        assert.ok(r.pivots.every((p) => p.confirmedAt <= asOf));
        assert.ok(
          r.zones.every(
            (z) =>
              z.createdAt <= asOf && z.touches.every((t) => t.knownAt <= asOf),
          ),
        );
        assert.ok(r.events.every((e) => e.at <= asOf));
      }
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
void main();
