/**
 * OI move -> sweep signal, TP/SL, max-open portfolio. Usage: npx tsx tests/oi-sweep.test.ts
 */
import * as assert from "assert";
import type { MvHour } from "../src/research/oi-moves";
import {
  portfolio,
  sweepOf,
  tradeOf,
  type SweepSignal,
} from "../src/research/oi-sweep";

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
  M = 60_000,
  T0 = Date.UTC(2026, 8, 1);
const k = (open: number, high: number, low: number, close: number): MvHour => ({
  t: T0,
  open,
  high,
  low,
  close,
  oi: 1,
  oiOpen: 1,
});

scenario(
  "sweep inside the candle: the longer wick, longer than the body = TOP / BOTTOM; a plain candle = none",
  () => {
    const prev = k(100, 101, 99, 100.5);
    assert.strictEqual(sweepOf(k(100.5, 102, 100.2, 100.4), prev), "TOP"); // upper wick 1.5 > lower 0.2, > body 0.1
    assert.strictEqual(sweepOf(k(100.2, 100.6, 98, 100.4), prev), "BOTTOM");
    assert.strictEqual(sweepOf(k(100, 101.2, 99.9, 101), prev), null); // body 1 > wicks -> just a move
    assert.strictEqual(sweepOf(k(100.5, 100.9, 99.5, 100.6), prev), "BOTTOM"); // inside the previous range still counts now
    assert.strictEqual(
      sweepOf(k(100.5, 100.9, 99.5, 100.6), prev, "prev"),
      null,
    ); // the older reading needed the previous low taken
  },
);

const sig = (symbol: string, entryTs: number): SweepSignal => ({
  symbol,
  dir: "UP",
  moveStart: T0,
  moveHours: 3,
  candle: k(1, 1, 1, 1),
  prev: k(1, 1, 1, 1),
  sweep: "BOTTOM",
  entryTs,
  entry: 100,
  oiDrop: 1,
});

scenario(
  "TP +1% / SL -1% on 1-minute candles, SL first in the same minute",
  () => {
    const path = [
      { t: T0 + H, high: 100.5, low: 99.5, close: 100 },
      { t: T0 + H + M, high: 101.2, low: 99.9, close: 101 },
    ];
    assert.deepStrictEqual(
      [
        tradeOf(sig("A", T0 + H), "LONG", path).result,
        tradeOf(sig("A", T0 + H), "SHORT", path).result,
      ],
      ["TP", "SL"],
    );
    const both = [{ t: T0 + H, high: 101.5, low: 98.5, close: 100 }];
    assert.strictEqual(tradeOf(sig("A", T0 + H), "LONG", both).result, "SL");
  },
);

scenario(
  "portfolio: at most 2 open at once -- the 3rd is skipped; a closed one frees its place",
  () => {
    const tr = (s: string, e: number, x: number | null) => ({
      ...sig(s, e),
      side: "LONG" as const,
      tp: 101,
      sl: 99,
      result: (x ? "TP" : "OPEN") as "TP" | "OPEN",
      exitTs: x,
      pnlPct: x ? 1 : 0,
    });
    const p = portfolio(
      [
        tr("A", T0, T0 + 5 * H),
        tr("B", T0 + H, T0 + 2 * H),
        tr("C", T0 + H, T0 + 9 * H),
        tr("D", T0 + 3 * H, null),
      ],
      2,
    );
    assert.deepStrictEqual(
      p.map((x) => [x.symbol, x.taken]),
      [
        ["A", true],
        ["B", true],
        ["C", false],
        ["D", true],
      ],
    );
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
