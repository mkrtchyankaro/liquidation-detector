/**
 * BTC pushes, coins' OI. Usage: npx tsx tests/btc-push.test.ts
 */
import * as assert from "assert";
import {
  coinInMove,
  priceAt,
  r2Of,
  type CoinData,
  type Hour,
} from "../src/research/btc-push";

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
const H = 3_600_000;
const hours = (ret: number[]): Hour[] => {
  let p = 100;
  return ret.map((r, i) => {
    const o = p;
    p *= 1 + r;
    return { t: i * H, open: o, close: p };
  });
};
const bRet = Array.from({ length: 100 }, (_, i) =>
  i >= 80 && i < 84 ? 0.005 : 0.004 * Math.sin(i * 1.1),
);
const btc = hours(bRet);

scenario(
  "R2 uses only the 3 days BEFORE the move: a 1.5x follower ~1, a random coin low",
  () => {
    assert.ok(
      r2Of(hours(bRet.map((r) => 1.5 * r)), btc, 80 * H - 72 * H, 80 * H) >
        0.99,
    );
    assert.ok(
      r2Of(
        hours(bRet.map((_, i) => 0.004 * Math.cos(i * 2.3))),
        btc,
        80 * H - 72 * H,
        80 * H,
      ) < 0.3,
    );
  },
);
scenario(
  "price at a time = that hour's open (or the previous hour's close)",
  () => {
    assert.strictEqual(priceAt(btc, 80 * H), btc[80].open);
    assert.strictEqual(priceAt(btc, 100 * H), btc[99].close);
  },
);
scenario(
  "coin in the move: price %, x BTC, OI change and the OI dip inside",
  () => {
    const coin = hours(bRet.map((r) => 1.5 * r));
    const oiPts: Array<[number, number]> = [
      [80 * H, 1000],
      [81 * H, 950],
      [82 * H, 930],
      [83 * H, 960],
      [84 * H, 970],
    ];
    const d: CoinData = {
      hours: coin,
      oi: (ts) => new Map(oiPts).get(ts) ?? NaN,
      oiPoints: oiPts,
      liq: () => ({ long: 0, short: 5000 }),
    };
    const btcPct =
      (100 * (priceAt(btc, 84 * H) - priceAt(btc, 80 * H))) /
      priceAt(btc, 80 * H);
    const r = coinInMove("X", d, btc, 80 * H, 84 * H, btcPct);
    assert.ok(
      r.pricePct > 0 && Math.abs(r.xBtc - 1.5) < 0.05,
      `${r.pricePct} ${r.xBtc}`,
    );
    assert.ok(
      Math.abs(r.oiPct + 3) < 1e-9 && Math.abs(r.oiDipPct + 7) < 1e-9,
      `${r.oiPct} ${r.oiDipPct}`,
    );
    assert.strictEqual(r.shortLiq, 5000);
  },
);
scenario(
  "no DB data for a coin -> liquidations unknown (null), not zero",
  () => {
    const d: CoinData = {
      hours: btc,
      oi: () => 1,
      oiPoints: [],
      liq: () => null,
    };
    assert.strictEqual(
      coinInMove("X", d, btc, 80 * H, 84 * H, 1).longLiq,
      null,
    );
  },
);
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
