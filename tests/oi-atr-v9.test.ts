/**
 * V9 with OI ATR. Usage: npx tsx tests/oi-atr-v9.test.ts
 */
import * as assert from "assert";
import {
  atrBucket,
  atrSignals,
  buildCandles,
  sideAtrs,
  type MinBar,
  type OiCandle,
} from "../src/research/oi-atr-v9";

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
  TF = 5 * M;

/** candles from OI closes; liq per candle; price constant 100 except where given */
function candles(
  oi: number[],
  liq: Array<[number, number]> = [],
  price: number[] = [],
): OiCandle[] {
  return oi.slice(1).map((x, k) => {
    const i = k + 1,
      p = price[i] ?? 100;
    return {
      t: i * TF,
      end: (i + 1) * TF,
      oiOpen: oi[i - 1],
      oiHigh: Math.max(oi[i - 1], x),
      oiLow: Math.min(oi[i - 1], x),
      oiClose: x,
      high: p + 0.5,
      low: p - 0.5,
      close: p,
      longLiq: liq[i]?.[0] ?? 0,
      shortLiq: liq[i]?.[1] ?? 0,
    };
  });
}
// warm-up: small zig-zag (no liquidations), then the story
const warm = [100, 101, 100, 101, 100, 101, 100];
const clean = [98, 96, 94, 92, 90]; // OI -2 per candle, longs liquidated
const acc = [92, 94, 96, 98, 100]; // OI +2: new positions
const turn = [98, 96]; // OI -2 again
const story = [...warm, ...clean, ...acc, ...turn];
const liqFor = (cleanSide: 0 | 1, turnSide: 0 | 1): Array<[number, number]> =>
  story.map((_, i) => {
    if (i >= warm.length && i < warm.length + clean.length)
      return cleanSide === 0 ? [1000, 0] : [0, 1000];
    if (i >= warm.length + clean.length + acc.length)
      return turnSide === 0 ? [500, 0] : [0, 500];
    return [0, 0];
  });
const opts = { tf: 5, n: 2, rev: 1, minSlPct: 0.33, maxGapCandles: 3 };

scenario(
  "minute bars -> 5m candles: OI open/high/low/close and liquidations summed",
  () => {
    const mb: MinBar[] = [0, 1, 2, 3, 4, 5].map((i) => ({
      t: i * M,
      high: 10 + i,
      low: 9,
      close: 10,
      oiFirst: 100 + i,
      oiLast: 101 + i,
      oiMin: 99,
      oiMax: 110 + i,
      longLiq: 1,
      shortLiq: 2,
    }));
    const c = buildCandles(mb, 5);
    assert.strictEqual(c.length, 2);
    assert.deepStrictEqual(
      [
        c[0].oiOpen,
        c[0].oiClose,
        c[0].oiHigh,
        c[0].oiLow,
        c[0].high,
        c[0].longLiq,
        c[0].shortLiq,
      ],
      [100, 105, 114, 99, 14, 5, 10],
    );
  },
);
scenario(
  "up/down ATR use only candles BEFORE (the candle's own move is not in its value)",
  () => {
    const a = sideAtrs(candles([100, 101, 99, 102, 98]), 2);
    assert.ok(Number.isNaN(a[2].up) && Number.isNaN(a[2].down));
    assert.strictEqual(a[3].up, 2); // rises +1, +3 before candle 3
    assert.ok(Number.isNaN(a[3].down)); // only one fall (-2) before it; its own -4 not counted
  },
);
scenario(
  "cleaning (longs) -> accumulation -> turn (shorts liquidated) = LONG at the first turn candle",
  () => {
    const c = candles(story, liqFor(0, 1));
    const s = atrSignals("XUSDT", c, opts);
    assert.strictEqual(s.length, 1);
    const x = s[0];
    assert.strictEqual(x.side, "LONG");
    assert.strictEqual(x.t, c[c.length - 2].end); // known at the first turn candle, not later
    assert.ok(x.cleanAtr >= 4 && x.accAtr >= 4, `${x.cleanAtr} ${x.accAtr}`);
    assert.ok(Math.abs(x.regrow - 10 / 11) < 1e-9, String(x.regrow)); // cleaning starts at the last OI high (101)
    assert.ok(x.sl < x.entry && x.slPct >= 0.33);
  },
);
scenario("mirror: shorts cleaned, longs liquidated in the turn = SHORT", () => {
  const s = atrSignals("XUSDT", candles(story, liqFor(1, 0)), opts);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].side, "SHORT");
  assert.ok(s[0].sl > s[0].entry);
});
scenario(
  "turn liquidations on the SAME side as the cleaning = no signal",
  () => {
    assert.strictEqual(
      atrSignals("XUSDT", candles(story, liqFor(0, 0)), opts).length,
      0,
    );
  },
);
scenario("no liquidations at all = no signal", () => {
  assert.strictEqual(atrSignals("XUSDT", candles(story), opts).length, 0);
});
scenario(
  "does not look ahead: the signal on the cut data equals the one on the full data",
  () => {
    const full = candles(
      [...story, 94, 92, 95],
      liqFor(0, 1).concat([
        [0, 0],
        [0, 0],
        [0, 0],
      ]),
    );
    const cut = full.slice(0, story.length - 2);
    assert.deepStrictEqual(
      atrSignals("XUSDT", cut, opts),
      atrSignals("XUSDT", full, opts).filter(
        (x) => x.t <= cut[cut.length - 1].end,
      ),
    );
  },
);
scenario("buckets", () => {
  assert.deepStrictEqual([0.5, 1, 2.5, 4, 9].map(atrBucket), [
    "<1",
    "1-2",
    "2-3",
    "3-5",
    "5+",
  ]);
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
