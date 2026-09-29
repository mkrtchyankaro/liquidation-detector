import assert from "node:assert/strict";
import { directionsAt, fit, lastClosed } from "../src/research/trend4h";
import { H4, type Candle4h } from "../src/research/structure4h";

const T0 = Date.UTC(2026, 8, 1);
const mk = (rows: Array<[number, number, number, number]>): Candle4h[] =>
  rows.map(([o, h, l, c], i) => ({
    openTime: T0 + i * H4,
    closeTime: T0 + (i + 1) * H4,
    open: o,
    high: h,
    low: l,
    close: c,
  }));
const c = mk([
  [10, 11, 9, 10],
  [10, 12, 9.5, 11],
  [11, 13, 10, 12],
  [12, 12.5, 11, 11.2],
  [11, 11.5, 10, 10.2],
  [10, 10.4, 9, 9.5],
  [9.5, 9.9, 8.5, 9],
]);
// a signal inside candle 3 (opened, not closed): only candles 0..2 count
assert.equal(lastClosed(c, T0 + 3 * H4 + 60_000), 2);
assert.equal(
  lastClosed(c, T0 + 3 * H4),
  2,
  "a candle closing exactly at t counts",
);
assert.equal(lastClosed(c, T0 + 1000), -1);
let d = directionsAt(c, T0 + 3 * H4 + 60_000).dir;
assert.equal(d["1C"], "UP");
assert.equal(d["3C"], "UP");
assert.equal(d["24H"], null);
assert.equal(d.SWING, null);
d = directionsAt(c, T0 + 4 * H4 + 1).dir; // candle 3: lower high, higher low -> inside
assert.equal(d["1C"], "FLAT");
assert.equal(d["3C"], "FLAT");
d = directionsAt(c, T0 + 7 * H4).dir; // 4,5,6 all LH+LL; close 9 vs close 6 candles earlier (10) -> DOWN
assert.equal(d["1C"], "DOWN");
assert.equal(d["3C"], "DOWN");
assert.equal(d["24H"], "DOWN");
assert.equal(fit("LONG", "UP"), "WITH");
assert.equal(fit("SHORT", "UP"), "AGAINST");
assert.equal(fit("SHORT", "DOWN"), "WITH");
assert.equal(fit("LONG", "FLAT"), "NEUTRAL");
console.log("trend4h: all checks passed");
