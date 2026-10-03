/**
 * V10 "atr" entry (Johnny Oct 3): close 1 ATR back from the top + OI down, the move built with OI up, RANK 1;
 * variant: frozen ATR (from the move's start). Usage: npx tsx tests/atr-turn.test.ts
 */
import * as assert from "assert";
import type { Candle } from "../src/research/dc15";
import {
  atrSignals,
  atrStorySignals,
  h1Context,
  inH1Growth,
} from "../src/research/atr-turn";

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
/** candles from [close change, OI change, optional open change (a gap inside the candle -> its colour)] */
function mk(rows: Array<[number, number, number?]>): Candle[] {
  let p = 100,
    oi = 1000;
  return rows.map(([dc, d, og], i) => {
    const o = p + (og ?? 0),
      oi0 = oi;
    p += dc;
    oi += d;
    return {
      t: i * W,
      end: (i + 1) * W,
      open: o,
      high: Math.max(o, p) + 0.1,
      low: Math.min(o, p) - 0.1,
      close: p,
      oi0,
      oi1: oi,
      liqL: 0,
      liqS: 0,
    };
  });
}
const warm: Array<[number, number]> = [];
for (let c = 0; c < 5; c++) {
  for (let i = 0; i < 4; i++) warm.push([+0.4, +1]);
  for (let i = 0; i < 4; i++) warm.push([-0.4, -1]);
}
const W0 = warm.length;
const after = <T extends { t: number }>(s: T[]): T[] =>
  s.filter((x) => x.t > W0 * W);
const rel = (t: number): number => t / W - W0;

// the rise with OI up, a small red wiggle inside it (OI down, less than 1 ATR) that must NOT be an entry
const wiggle: Array<[number, number]> = [
  ...warm,
  [+0.6, +8],
  [+0.6, +8],
  [-0.2, -2], // wiggle: red, OI down, but only 0.3 back from the high (< 1 ATR)
  [+0.6, +8],
  [+0.6, +8],
  [-0.7, -3], // closes 0.8 back from the high (>= 1 ATR), OI below its peak -> ENTRY
  [-0.4, -2],
  [-0.4, -2],
];

scenario(
  "a red candle with OI down inside the rise (less than 1 ATR back) is not an entry; the close 1 ATR back is -- SHORT",
  () => {
    const s = atrSignals(mk(wiggle), 1, 14, 12).filter((y) => y.t > W0 * W);
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    const x = s[0];
    assert.strictEqual(x.side, "SHORT");
    assert.strictEqual(
      rel(x.t),
      6,
      "the entry is the close of the 1 ATR candle",
    );
    assert.ok(x.buildOiPct > 0 && x.fromPeakOiPct < 0 && x.prior > 0);
    assert.ok(x.backPct > 0 && x.atr > 0);
  },
);

scenario(
  "the candle that MAKES the top and closes 1 ATR below it is not the entry -- the next candle is",
  () => {
    // [close change, OI, open gap]: candle 4 opens 1.0 higher (a new high), closes 0.6 below the previous close
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.6, -3, +1.0],
      [-0.2, -1],
      [-0.4, -2],
      [-0.4, -2],
    ];
    const s = after(atrSignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    assert.strictEqual(
      rel(s[0].t),
      6,
      "wait for the candle after the one that made the top",
    );
  },
);

scenario(
  "OI fell BEFORE the top (take-profits on the way up) and the entry candle's own OI goes up -> still the entry (OI is below its peak)",
  () => {
    const rows: Array<[number, number]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, -2],
      [+0.6, -2],
      [-0.8, +1],
      [-0.4, -2],
      [-0.4, -2],
    ];
    const s = after(atrSignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    assert.strictEqual(rel(s[0].t), 5);
    assert.ok(
      s.map((x) => x as unknown as { candleOiPct: number })[0].candleOiPct > 0,
      "the candle's own OI went up",
    );
  },
);

scenario("a rise with OI only falling (no growth) is never an entry", () => {
  const rows: Array<[number, number]> = [
    ...warm,
    [+0.6, -8],
    [+0.6, -8],
    [+0.6, -8],
    [+0.6, -8],
    [-0.8, -3],
    [-0.4, +2],
    [-0.4, -2],
  ];
  assert.strictEqual(after(atrSignals(mk(rows), 1, 14, 12)).length, 0);
});

scenario(
  "not RANK 1 (a smaller OI build than the earlier moves) -> no entry",
  () => {
    const rows: Array<[number, number]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.7, -3],
      [-0.7, -3],
      [-0.7, -3],
      [-0.4, -2],
      [-0.4, -2],
      [+0.6, +1],
      [+0.6, +1],
      [+0.6, +1],
      [-0.7, -1],
      [-0.4, -1],
    ];
    const s = after(atrSignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    assert.ok(rel(s[0].t) < 9, "only the first (big) build-up");
  },
);

// a fast rise: the live ATR grows, the frozen ATR stays at its size before the move
const fast: Array<[number, number]> = [
  ...warm,
  [+2, +8],
  [+2, +8],
  [+2, +8],
  [+2, +8],
  [+2, +8],
  [+2, +8],
  [-0.75, -3],
  [-0.6, -3],
  [-0.6, -3],
  [-0.4, -2],
];

scenario(
  "frozen ATR (from the move's start) enters earlier than the live ATR after a fast rise",
  () => {
    const live = after(atrSignals(mk(fast), 1, 14, 12, { atr: "live" }));
    const frozen = after(atrSignals(mk(fast), 1, 14, 12, { atr: "frozen" }));
    assert.strictEqual(frozen.length, 1);
    assert.strictEqual(live.length, 1);
    assert.ok(
      frozen[0].t < live[0].t,
      `frozen ${rel(frozen[0].t)} live ${rel(live[0].t)}`,
    );
    assert.strictEqual(rel(frozen[0].t), 7);
  },
);

scenario(
  "the mirror: a fall with OI growing, OI then below its peak, a close 1 ATR up from the low -> LONG",
  () => {
    const rows: Array<[number, number]> = [
      ...warm,
      [-0.6, +8],
      [-0.6, +8],
      [-0.6, +8],
      [-0.6, +8],
      [+0.7, -3],
      [+0.4, -2],
      [+0.4, -2],
    ];
    const s = after(atrSignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1);
    assert.strictEqual((s[0] as unknown as { side: string }).side, "LONG");
    assert.strictEqual(rel(s[0].t), 5);
  },
);

scenario(
  "why no entry (story tool): the wiggle is 'less than 1 ATR back', the top-making candle 'wait for the next one'",
  () => {
    const why = new Map<number, string>();
    atrSignals(mk(wiggle), 1, 14, 12, { why: (t, m) => why.set(rel(t), m) });
    assert.match(why.get(3) ?? "", /back from the top, 1 ATR/);
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.6, -3, +1.0],
      [-0.2, -1],
      [-0.4, -2],
    ];
    const w2 = new Map<number, string>();
    atrSignals(mk(rows), 1, 14, 12, { why: (t, m) => w2.set(rel(t), m) });
    assert.match(w2.get(5) ?? "", /made the top -> wait/);
  },
);

scenario(
  "SUI (Oct 3): OI grows with the price, then falls BELOW where it started while the price keeps rising (shorts out) -> only 'biggest' growth sees it",
  () => {
    const rows: Array<[number, number]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, -4],
      [+0.6, -4],
      [+0.6, -4],
      [+0.6, -4],
      [-0.8, -2],
      [-0.4, -2],
      [-0.4, -2],
    ];
    assert.strictEqual(
      after(atrSignals(mk(rows), 1, 14, 12)).length,
      0,
      "afterLow: OI's low is now after the growth -> no growth",
    );
    const s = after(atrSignals(mk(rows), 1, 14, 12, { growth: "biggest" }));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    assert.strictEqual(rel(s[0].t), 6);
    assert.ok(
      Math.abs(s[0].buildOiPct - 0.8) < 0.05,
      `growth ${s[0].buildOiPct}`,
    );
  },
);

scenario(
  "the candle that MADE the top and closed 1 ATR back must have OI DOWN inside it; with OI up that top gives no entry",
  () => {
    const up: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.6, +3, +1.0],
      [-0.2, -1],
      [-0.4, -2],
      [-0.4, -2],
    ];
    assert.strictEqual(
      after(atrSignals(mk(up), 1, 14, 12)).length,
      0,
      "top candle OI up -> no entry",
    );
    const why = new Map<number, string>();
    atrSignals(mk(up), 1, 14, 12, { why: (t, m) => why.set(rel(t), m) });
    assert.match(why.get(6) ?? "", /OI went UP/);
    assert.strictEqual(
      after(atrSignals(mk(up), 1, 14, 12, { topCandleOi: false })).length,
      1,
      "without the rule it was an entry",
    );
    const down: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.6, -3, +1.0],
      [-0.2, +1],
      [-0.4, -2],
      [-0.4, -2],
    ];
    const s = after(atrSignals(mk(down), 1, 14, 12));
    assert.strictEqual(s.length, 1);
    assert.strictEqual(
      rel(s[0].t),
      6,
      "top candle OI down -> entry at the NEXT candle, whose own OI may go up",
    );
  },
);

scenario(
  "after a top candle that closed 1 ATR back (OI down), the entry candle must close RED -- a green one waits",
  () => {
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.6, -3, +1.0],
      [+0.1, -1, -0.3],
      [-0.3, -1],
      [-0.4, -2],
    ];
    const s = after(atrSignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    assert.strictEqual(
      rel(s[0].t),
      7,
      "candle 5 is green (opened lower, closed up) -> the entry is the red candle 6",
    );
    assert.strictEqual(
      rel(after(atrSignals(mk(rows), 1, 14, 12, { redAfterTop: false }))[0].t),
      6,
      "without the rule: the green candle",
    );
  },
);

// ── "story" (Johnny's final wording, Oct 3) ──
scenario(
  "story: OI grows with the price -> OI falls while the price still rises -> top (its OI may rise a little) -> red candle 1 ATR back = SHORT",
  () => {
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, -4],
      [+0.6, -4],
      [+0.3, +1],
      [-0.8, -1],
      [-0.4, -2],
    ];
    const s = after(atrStorySignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    const x = s[0];
    assert.strictEqual(x.side, "SHORT");
    assert.strictEqual(rel(x.t), 6);
    assert.ok(
      x.buildOiPct > 0 &&
        x.buildPricePct > 0 &&
        x.declineOiPct < 0 &&
        x.declinePricePct > 0,
      JSON.stringify(x),
    );
    assert.strictEqual(rel(x.peakT), 2, "the OI peak = the 2nd candle's close");
    assert.strictEqual(rel(x.topT), 5);
  },
);

scenario(
  "story: OI grows up to the top, the TOP candle (a wick) has the big OI drop -> the next red candle = SHORT",
  () => {
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.6, -6, +1.0],
      [-0.3, -1],
      [-0.4, -2],
    ];
    const s = after(atrStorySignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    assert.strictEqual(rel(s[0].t), 5);
    assert.ok(s[0].declineOiPct < 0);
  },
);

scenario(
  "story: OI grows INTO the top with no fall before or in the top candle -> no SHORT",
  () => {
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.6, +3, +1.0],
      [-0.3, -1],
      [-0.4, -2],
      [-0.4, -2],
    ];
    const why = new Map<number, string>();
    assert.strictEqual(
      after(
        atrStorySignals(mk(rows), 1, 14, 12, {
          why: (t, m) => why.set(rel(t), m),
        }),
      ).filter((x) => x.side === "SHORT").length,
      0,
    );
    assert.match(why.get(5) ?? "", /OI's peak is not before the top/);
  },
);

scenario(
  "story: a GREEN candle 1 ATR below the top waits; the next red one is the entry",
  () => {
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, -4],
      [+0.6, -4],
      [+0.3, +1],
      [-0.8, -1, -1.2],
      [-0.2, -1],
      [-0.4, -2],
    ];
    const s = after(atrStorySignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    assert.strictEqual(rel(s[0].t), 7);
  },
);

scenario(
  "story: the mirror -- a fall with OI growing, OI then falls while the price still falls, green candle 1 ATR up = LONG",
  () => {
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [-0.6, +8],
      [-0.6, +8],
      [-0.6, -4],
      [-0.6, -4],
      [-0.3, +1],
      [+0.8, -1],
      [+0.4, -2],
    ];
    const s = after(atrStorySignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].side, "LONG");
    assert.strictEqual(rel(s[0].t), 6);
  },
);

scenario(
  "story (SUI): OI grows with the price, then falls BELOW where it started while the price runs -> the growth still counts -> SHORT",
  () => {
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, -4],
      [+0.6, -4],
      [+0.6, -4],
      [+0.6, -4],
      [-0.8, -2],
      [-0.4, -2],
    ];
    const s = after(atrStorySignals(mk(rows), 1, 14, 12));
    assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
    assert.strictEqual(rel(s[0].t), 6);
    assert.ok(
      Math.abs(s[0].buildOiPct - 0.8) < 0.05 && s[0].declineOiPct < -1,
      JSON.stringify(s[0]),
    );
  },
);

scenario(
  "selfTop (1h): the candle that MADE the top and closed RED 1 ATR below its own high is itself the entry",
  () => {
    // candle 4: opens 1.0 higher (a new high), closes 0.6 below the previous close -> red, 1.7 below its high
    const rows: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [-0.6, -3, +1.0],
      [-0.2, -1],
      [-0.4, -2],
    ];
    assert.strictEqual(
      rel(after(atrSignals(mk(rows), 1, 14, 12))[0].t),
      6,
      "without selfTop: the next candle",
    );
    const s = after(atrSignals(mk(rows), 1, 14, 12, { selfTop: true }));
    assert.strictEqual(s.length, 1);
    assert.strictEqual(rel(s[0].t), 5, "with selfTop: the top candle itself");
    // a GREEN top candle (closes up from its open, still 1 ATR below its high) is not a self entry
    const green: Array<[number, number, number?]> = [
      ...warm,
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.6, +8],
      [+0.1, -3, -0.3],
      [-0.6, -1],
      [-0.4, -2],
    ];
    assert.ok(
      after(atrSignals(mk(green), 1, 14, 12, { selfTop: true })).every(
        (x) => rel(x.t) !== 5,
      ),
    );
  },
);

scenario(
  "1h context: a rise with OI growing -> a SHORT signal inside it passes; a rise with OI only falling does not",
  () => {
    const up = h1Context(
      mk([...warm, [+0.6, +8], [+0.6, +8], [+0.6, +4]]),
      1,
      14,
    );
    const t = (W0 + 3) * W;
    assert.strictEqual(inH1Growth(up, t, "SHORT"), true);
    assert.strictEqual(inH1Growth(up, t, "LONG"), false);
    assert.strictEqual(
      inH1Growth(up, t - 1, "SHORT"),
      inH1Growth(up, (W0 + 2) * W, "SHORT"),
      "only closed candles count",
    );
    const noOi = h1Context(
      mk([...warm, [+0.6, -8], [+0.6, -8], [+0.6, -4]]),
      1,
      14,
    );
    assert.strictEqual(inH1Growth(noOi, t, "SHORT"), false);
  },
);

scenario(
  "far A:high / B:body: the candle's high (wick) / body top must be 1 ATR below the top -- later than the close rule",
  () => {
    const close = after(
      atrSignals(mk(wiggle), 1, 14, 12, { topCandleOi: false }),
    );
    const high = after(
      atrSignals(mk(wiggle), 1, 14, 12, { topCandleOi: false, far: "high" }),
    );
    const body = after(
      atrSignals(mk(wiggle), 1, 14, 12, { topCandleOi: false, far: "body" }),
    );
    assert.strictEqual(
      rel(close[0].t),
      6,
      "close: the candle closing 1 ATR below",
    );
    assert.strictEqual(
      rel(high[0].t),
      7,
      "high: that candle's wick is still near the top -> the next one",
    );
    assert.strictEqual(
      rel(body[0].t),
      7,
      "body: that candle opened at the top -> the next one",
    );
    assert.ok(high[0].price < close[0].price);
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
