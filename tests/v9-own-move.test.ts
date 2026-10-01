/**
 * V9 own move vs BTC. Usage: npx tsx tests/v9-own-move.test.ts
 */
import * as assert from "assert";
import {
  betaOf,
  ownCheck,
  preMove,
  type OwnBar,
} from "../src/research/v9-own-move";

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
const M = 60_000,
  T0 = 100 * 60 * M;
const bar = (t: number, close: number): OwnBar => ({
  t,
  close,
  high: close,
  low: close,
});
// 60 minutes before the entry: the coin moves exactly 2x BTC -> beta 2
const btcPast = Array.from({ length: 60 }, (_, i) =>
  bar(T0 - (60 - i) * M, 100 * (1 + 0.001 * Math.sin(i))),
);
const coinPast = btcPast.map((b) =>
  bar(b.t, 10 * (1 + 2 * (b.close / 100 - 1))),
);

scenario(
  "beta from the past only: a coin moving 2x BTC -> about 2; too little data -> null",
  () => {
    const beta = betaOf(coinPast, btcPast, T0 - 60 * M, T0)!;
    assert.ok(Math.abs(beta - 2) < 0.05, `beta ${beta}`);
    assert.strictEqual(
      betaOf(coinPast.slice(0, 5), btcPast.slice(0, 5), T0 - 60 * M, T0),
      null,
    );
  },
);

const trade = {
  id: "a",
  symbol: "X",
  side: "LONG" as const,
  createdAt: T0 + 10_000,
  entry: 10,
  sl: 9.8,
};
const o = {
  tpR: 1.5,
  minSlPct: 0,
  maxOpen: null,
  timeStopH: null,
  riskUsd: 10,
};
scenario(
  "profit that is only BTC (coin +1%, BTC +0.6%, beta 2) -> own <= 0 -> the rule closes at k",
  () => {
    const btc = [
      ...btcPast,
      bar(T0, 100),
      bar(T0 + 30 * M, 100.6),
      bar(T0 + 31 * M, 99),
    ];
    const coin = [
      ...coinPast,
      bar(T0, 10),
      bar(T0 + 30 * M, 10.1),
      bar(T0 + 31 * M, 9.7),
    ]; // later falls to SL
    const c = ownCheck(trade, coin, btc, 30, 1, o)!;
    assert.ok(c.openAtK && c.own <= 0.05, `own ${c.own}`);
    assert.strictEqual(c.base.status, "SL");
    assert.ok(
      c.ruled.closedByRule && c.ruled.r > 0,
      "closed in profit by the rule instead of the SL",
    );
  },
);
scenario(
  "the coin's own move (coin +1%, BTC flat) -> own > 0 -> the trade runs as before",
  () => {
    const btc = [
      ...btcPast,
      bar(T0, 100),
      bar(T0 + 30 * M, 100),
      bar(T0 + 31 * M, 100),
    ];
    const coin = [
      ...coinPast,
      bar(T0, 10),
      bar(T0 + 30 * M, 10.1),
      bar(T0 + 31 * M, 10.31),
    ];
    const c = ownCheck(trade, coin, btc, 30, 1, o)!;
    assert.ok(
      c.own > 0.9 &&
        !c.ruled.closedByRule &&
        c.base.status === "TP" &&
        c.ruled.r === c.base.r,
    );
  },
);
scenario(
  "before the entry: a fall that BTC explains -> byBtc; a fall of the coin alone -> not byBtc",
  () => {
    const start = T0 - 30 * M; // the episode started 30 min before the entry; beta from the hour before that
    const btcB = btcPast.map((b) => ({ ...b, t: b.t - 30 * M })),
      coinB = coinPast.map((b) => ({ ...b, t: b.t - 30 * M }));
    const withBtc = preMove(
      trade,
      [...coinB, bar(start, 10), bar(T0, 9.8)],
      [...btcB, bar(start, 100), bar(T0, 99)],
      start,
      1,
    )!;
    assert.ok(
      withBtc.byBtc &&
        withBtc.coinPct < 0 &&
        Math.abs(withBtc.btcPart - -2) < 0.1,
      JSON.stringify(withBtc),
    );
    const alone = preMove(
      trade,
      [...coinB, bar(start, 10), bar(T0, 9.8)],
      [...btcB, bar(start, 100), bar(T0, 100)],
      start,
      1,
    )!;
    assert.ok(!alone.byBtc && Math.abs(alone.own - -2) < 1e-9);
    assert.strictEqual(
      preMove(trade, coinB, btcB, T0 + M, 1),
      null,
      "episode start after the entry -> null",
    );
  },
);
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
