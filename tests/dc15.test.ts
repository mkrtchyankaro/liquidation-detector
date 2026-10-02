/**
 * DC on 15m candles + the OI rule. Usage: npx tsx tests/dc15.test.ts
 */
import * as assert from "assert";
import {
  atrBefore,
  candles,
  coinInWindow,
  oiChange,
  outcome,
  pastRank,
  turns,
  type Candle,
  type MinBar,
  type Turn,
} from "../src/research/dc15";

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
const W = 15 * 60_000;
/** candles from [close, oiChange] with a fixed 1-unit range around the move */
function mk(rows: Array<[number, number]>): Candle[] {
  let oi = 1000,
    prev = 100;
  return rows.map(([c, d], i) => {
    const o = prev,
      oi0 = oi;
    oi += d;
    prev = c;
    return {
      t: i * W,
      end: (i + 1) * W,
      open: o,
      high: Math.max(o, c) + 0.2,
      low: Math.min(o, c) - 0.2,
      close: c,
      oi0,
      oi1: oi,
      liqL: 0,
      liqS: 0,
    };
  });
}
// warm-up (ATR ~1), rise with OI up, then a red candle with OI DOWN (accepted), fall with OI down,
// a green candle with OI DOWN (rejected: not the end), more fall, then a green candle with OI UP (accepted)
const warm: Array<[number, number]> = Array.from({ length: 16 }, (_, i) => [
  i % 2 ? 100.8 : 100,
  0,
]);
const story: Array<[number, number]> = [
  ...warm,
  [102, 5],
  [104, 5],
  [106, 5], // up, OI up
  [104.5, -4], // reversal candle, OI DOWN -> accepted (top)
  [102, -6],
  [100, -6], // down, OI down
  [101.5, -1], // green, OI DOWN -> rejected
  [98, -5], // down again
  [99.6, +6], // green, OI UP -> accepted (bottom)
];

scenario("15m candles from minutes: open = first close, OI first/last", () => {
  const bars: MinBar[] = [0, 1, 2, 15].map((m, i) => ({
    t: m * 60_000,
    high: 10 + i,
    low: 9,
    close: 9.5 + i,
    oiFirst: 100 + i,
    oiLast: 101 + i,
  }));
  const c = candles(bars, 15);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(
    [c[0].open, c[0].close, c[0].high, c[0].oi0, c[0].oi1],
    [9.5, 11.5, 12, 100, 103],
  );
});
scenario("ATR uses only candles before", () => {
  const a = atrBefore(mk(story), 14);
  assert.ok(Number.isNaN(a[13]) && a[14] > 0);
});
scenario(
  "OI rule: accepts the top (OI down after an OI-up rise), rejects the green candle with OI down, accepts the bottom with OI up",
  () => {
    const t = turns(mk(story), 1, 14, true).filter((x) => x.t > 17 * W); // after the warm-up start
    const desc = t.map((x) => `${x.newDir}:${x.accepted}`);
    assert.deepStrictEqual(
      desc,
      ["DOWN:true", "UP:false", "UP:true"],
      desc.join(" "),
    );
    assert.strictEqual(t[0].label, "LONGS OUT");
    assert.strictEqual(t[1].label, "SHORTS OUT");
    assert.strictEqual(t[2].label, "NEW LONGS");
    assert.strictEqual(t[2].extreme, mk(story)[24].low); // the bottom kept going through the rejected candle
  },
);
scenario("plain DC (no OI rule) takes the fake green candle as a turn", () => {
  const t = turns(mk(story), 1, 14, false).filter((x) => x.t > 16 * W);
  assert.ok(
    t.some((x) => x.newDir === "UP" && x.label === "SHORTS OUT" && x.accepted),
  );
});
scenario(
  "no look-ahead: the turns on cut data are the same as on full data up to the cut",
  () => {
    const full = turns(mk(story), 1, 14, true),
      cut = turns(mk(story).slice(0, 22), 1, 14, true);
    assert.deepStrictEqual(
      cut,
      full.filter((x) => x.t <= 22 * W),
    );
  },
);
scenario("outcome: signed by direction, best / worst inside the window", () => {
  const bars: MinBar[] = [0, 1, 2, 3].map((i) => ({
    t: i * 60_000,
    high: 101 + i,
    low: 99 - i,
    close: 100 - i,
    oiFirst: 1,
    oiLast: 1,
  }));
  const o = outcome(bars, 0, 100, "DOWN", [1 / 30], 1);
  assert.ok(Math.abs(o.at[0] - 1) < 1e-9, String(o.at[0])); // after 2 minutes close 99 -> +1% for a SHORT
  assert.ok(o.worst < 0 && o.best > 0);
});
scenario(
  "pastRank: compared only with the accepted moves of the window BEFORE it",
  () => {
    const H = 3_600_000;
    const t = (h: number, oi: number, accepted = true): Turn => ({
      t: h * H,
      newDir: "UP",
      price: 1,
      moveStartT: 0,
      extreme: 1,
      extremeT: 0,
      movePct: -oi / 10,
      moveOiPct: oi,
      candleOiPct: 0,
      label: "",
      accepted,
      atr: 1,
    });
    const r = pastRank(
      [t(0, 1), t(5, -3), t(10, 2), t(11, 9, false), t(40, 0.5)],
      24,
    );
    assert.deepStrictEqual(
      r.map((x) => [x.rank, x.prior]),
      [
        [1, 0],
        [1, 1],
        [2, 2],
        [1, 0],
      ],
    ); // |-3| beats 1; 2 loses to 3; the rejected 9 does not count; 40h: window empty
    assert.ok(Number.isNaN(r[0].share) && r[2].share === 0.5);
  },
);
scenario(
  "liquidations: squeeze in the rise, longs (losers) liquidated in the top candle, forced share",
  () => {
    const c = mk(story);
    c[17].liqS = 500;
    c[18].liqS = 300;
    c[17].liqL = 10; // the rise was a short squeeze
    c[19].liqL = 400;
    c[19].liqS = 50; // the top candle: longs liquidated
    const top = turns(c, 1, 14, true).find(
      (x) => x.newDir === "DOWN" && x.accepted,
    )!;
    assert.strictEqual(top.moveLiq, "SQUEEZE");
    assert.strictEqual(top.candleLiq, "LOSERS");
    assert.ok(
      Math.abs(top.forced - 400 / (4 * 104.5)) < 1e-9,
      String(top.forced),
    ); // 400 USD / |OI -4| x price
  },
);
scenario("candles sum the minute liquidations", () => {
  const bars: MinBar[] = [0, 1].map((m) => ({
    t: m * 60_000,
    high: 2,
    low: 1,
    close: 1.5,
    oiFirst: 1,
    oiLast: 1,
    longLiq: 3,
    shortLiq: 4,
  }));
  const [k] = candles(bars, 15);
  assert.deepStrictEqual([k.liqL, k.liqS], [6, 8]);
});
scenario(
  "coin in the BTC window: x = 2 and follow ~1 for a 2x copy; window only",
  () => {
    const btc = new Map<number, number>(),
      coin = new Map<number, number>();
    let b = 100,
      c = 50;
    for (let i = 0; i < 60; i++) {
      const r = 0.001 * Math.sin(i * 1.7) + 0.0005;
      b *= 1 + r;
      c *= 1 + 2 * r;
      btc.set(i * 60_000, b);
      coin.set(i * 60_000, c);
    }
    const s = coinInWindow(coin, btc, 10 * 60_000, 50 * 60_000);
    assert.ok(Math.abs(s.x - 2) < 0.05 && s.follow > 0.99, JSON.stringify(s));
  },
);
scenario(
  "price filter: movePct = start close -> extreme; pastRank by price uses its own key",
  () => {
    const c = mk(story);
    const top = turns(c, 1, 14, true).find(
      (x) => x.newDir === "DOWN" && x.accepted && x.t > 17 * W,
    )!;
    const startClose = c.find((k) => k.t === top.moveStartT)!.close;
    assert.ok(
      Math.abs(top.movePct - (100 * (top.extreme - startClose)) / startClose) <
        1e-9 && top.movePct > 0,
    );
    const H = 3_600_000;
    const t = (h: number, oi: number, px: number): Turn => ({
      ...top,
      t: h * H,
      moveOiPct: oi,
      movePct: px,
      accepted: true,
    });
    const list = [t(0, 1, 5), t(1, 3, 1)];
    assert.deepStrictEqual(
      pastRank(list, 24).map((r) => r.rank),
      [1, 1],
    ); // OI: 3 > 1
    assert.deepStrictEqual(
      pastRank(list, 24, (x) => x.movePct).map((r) => r.rank),
      [1, 2],
    ); // price: 1 < 5
  },
);
scenario("coin OI change: last known OI at each time, no look-ahead", () => {
  const oi = new Map<number, number>([
    [0, 100],
    [60_000, 110],
    [120_000, 999],
  ]);
  assert.ok(Math.abs(oiChange(oi, 60_000, 120_000) - 10) < 1e-9); // at 2:00 the minute 2:00 is not closed yet -> 110
  assert.ok(Number.isNaN(oiChange(oi, 0, 60_000))); // nothing known before 0:00
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
