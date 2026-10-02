/**
 * BTC's big moves and the coins' OI. Usage: npx tsx tests/btc-oi-moves.test.ts
 */
import * as assert from "assert";
import {
  btcMoves,
  type Candle,
  type Series,
} from "../src/research/btc-oi-moves";

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
const W = 15 * 60_000,
  H = 3_600_000;
const N = 96 + 40; // 24h before + room after
const MOVE = 100; // the big candle index
// BTC: small wiggles, one big -2% candle at MOVE, then flat
const btcRet = Array.from({ length: N }, (_, i) =>
  i === MOVE ? -0.02 : 0.001 * Math.sin(i * 1.3),
);
function candles(ret: number[]): Candle[] {
  let p = 100;
  return ret.map((r, i) => {
    const o = p;
    p *= 1 + r;
    return { t: i * W, open: o, close: p };
  });
}
const series = (ret: number[], oi: (i: number) => number): Series => ({
  candles: candles(ret),
  oi: (ts) => oi(Math.round(ts / W)),
});
const btc = series(btcRet, (i) => (i <= MOVE ? 1000 : 1010)); // OI +1% in the big candle
// coin A: 1.5x BTC always, OI up with BTC; after the move it keeps going down a bit more than BTC (continued)
const aRet = btcRet.map((r, i) =>
  i > MOVE && i <= MOVE + 4 ? -0.002 : 1.5 * r,
);
// coin B: 1.5x BTC, OI DOWN in the big candle; after the move it comes back up (came back)
const bRet = btcRet.map((r, i) =>
  i > MOVE && i <= MOVE + 4 ? 0.003 : 1.5 * r,
);
const coins = new Map([
  ["A", series(aRet, (i) => (i <= MOVE ? 500 : 505))],
  ["B", series(bRet, (i) => (i <= MOVE ? 500 : 495))],
]);

scenario("the biggest BTC candle is found with its OI change", () => {
  const [m] = btcMoves(btc, coins, 15, 1, 96 * W);
  assert.strictEqual(m.t, MOVE * W);
  assert.ok(Math.abs(m.pricePct + 2) < 1e-9 && Math.abs(m.oiPct - 1) < 1e-9);
});
scenario("beta comes from the 24h BEFORE the candle (~1.5)", () => {
  const [m] = btcMoves(btc, coins, 15, 1, 96 * W);
  assert.ok(m.coins.every((c) => Math.abs(c.beta - 1.5) < 0.01));
});
scenario(
  "coin OI up + kept going = continued (+); coin OI down + bounced = came back (-)",
  () => {
    const [m] = btcMoves(btc, coins, 15, 1, 96 * W);
    const a = m.coins.find((c) => c.symbol === "A")!,
      b = m.coins.find((c) => c.symbol === "B")!;
    assert.ok(a.oiPct > 0 && a.rel1h > 0, `A ${a.oiPct} ${a.rel1h}`);
    assert.ok(b.oiPct < 0 && b.rel1h < 0, `B ${b.oiPct} ${b.rel1h}`);
  },
);
scenario("no data after the candle yet -> n/a (NaN), not a fake number", () => {
  const short = new Map([
    ["A", series(aRet.slice(0, MOVE + 2), (i) => (i <= MOVE ? 500 : 505))],
  ]);
  const [m] = btcMoves(
    series(btcRet.slice(0, MOVE + 2), (i) => (i <= MOVE ? 1000 : 1010)),
    short,
    15,
    1,
    96 * W,
  );
  assert.ok(Number.isNaN(m.coins[0].rel4h));
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
