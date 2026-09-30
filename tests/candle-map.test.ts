import assert from "node:assert/strict";
import {
  buildCandles,
  toCsvLine,
  CSV_COLUMNS,
  type MinuteBar,
} from "../src/research/candle-map";

const T = Date.UTC(2026, 8, 30, 1),
  M = 60_000;
// 15m candle: OI 100 -> up to 110 (min 3) -> down to 95 (min 8) -> back to 102; price high at min 2, low at min 9
const oiPath = [
  101, 104, 110, 108, 106, 103, 99, 97, 95, 96, 98, 100, 101, 102, 102,
];
const minutes: MinuteBar[] = oiPath.map((oi, i) => ({
  ts: T + i * M,
  high: i === 2 ? 1.18 : 1.16,
  low: i === 9 ? 1.14 : 1.155,
  close: 1.16,
  oiFirst: i === 0 ? 100 : oiPath[i - 1],
  oiLast: oi,
  oiMin: Math.min(oi, i === 0 ? 100 : oiPath[i - 1]),
  oiMax: Math.max(oi, i === 0 ? 100 : oiPath[i - 1]),
}));
const liq = [
  { ts: T + 2 * M + 5000, victim: "SHORT" as const, price: 1.18, usd: 1180 }, // 1000 coins
  { ts: T + 9 * M, victim: "LONG" as const, price: 1.14, usd: 570 }, // 500 coins
  { ts: T + 9 * M + 30_000, victim: "LONG" as const, price: 1.14, usd: 114 }, // 100 coins
  { ts: T + 15 * M, victim: "LONG" as const, price: 1.1, usd: 999 }, // next candle -> not counted
];
const [r] = buildCandles(
  "SUIUSDT",
  "15m",
  [
    {
      openTime: T,
      open: 1.16,
      high: 1.18,
      low: 1.14,
      close: 1.15,
      volCoin: 1000,
      volUsd: 1160,
      takerBuyCoin: 400,
    },
  ],
  minutes,
  liq,
);
assert.equal(r.closeTime, T + 15 * M);
assert.equal(r.oiOpen, 100);
assert.equal(r.oiClose, 102);
assert.equal(r.oiHigh, 110);
assert.equal(r.oiLow, 95);
assert.equal(r.oiChgCoin, 2);
assert.equal(r.oiRiseCoin, 17); // 100->110 (10) + 95->102 (7)
assert.equal(r.oiFallCoin, 15); // 110 -> 95
assert.equal(r.oiRunUpPct, 10);
assert.equal(r.oiDropPct, 15);
assert.equal(r.oiOrder, "UP>DOWN");
assert.equal(r.priceOrder, "HIGH>LOW");
assert.equal(r.highAt, T + 2 * M);
assert.equal(r.lowAt, T + 9 * M);
assert.equal(r.liqShortUsd, 1180);
assert.ok(Math.abs(r.liqShortCoin - 1000) < 1e-9);
assert.equal(r.liqLongN, 2);
assert.ok(Math.abs(r.liqLongCoin - 600) < 1e-9);
assert.equal(r.liqLongUsd, 684);
assert.equal(r.liqMaxMinSide, "SHORT");
assert.equal(r.liqMaxMinAt, T + 2 * M);
assert.equal(r.takerBuyPct, 40);
assert.equal(r.minutesWithOi, 15);
assert.ok(
  Math.abs(r.upperWickPct - (100 * 0.02) / 1.16) < 1e-9 &&
    Math.abs(r.lowerWickPct - (100 * 0.01) / 1.16) < 1e-9,
);
const line = toCsvLine(r);
assert.equal(line.split(",").length, CSV_COLUMNS.length);
assert.ok(line.startsWith("SUIUSDT,15m,2026-09-30 01:00,2026-09-30 01:15,"));
// a candle with no data of ours: OI empty, still a row
const [e] = buildCandles(
  "SUIUSDT",
  "1h",
  [
    {
      openTime: T + 5 * 3_600_000,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volCoin: 0,
      volUsd: 0,
      takerBuyCoin: 0,
    },
  ],
  minutes,
  liq,
);
assert.equal(e.oiOpen, null);
assert.equal(e.minutesWithOi, 0);
assert.equal(e.liqLongN, 0);
console.log("candle-map: all checks passed");
