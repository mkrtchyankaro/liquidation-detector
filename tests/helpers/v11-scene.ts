/** A hand-made V11 market (Oct 12 2026) shared by the V11 tests. */
import { H, type V11Bar } from "../../src/strategy/v11/v11-engine";

export const T0 = Date.UTC(2026, 9, 1, 0, 0);
/** 100 quiet hours around 100 (median |6h move| ~0.5 %), then a T1 rally 100 -> 106 (hours 85-90, OI -5 %), a pause
 *  (91), the WICK (92: new high 107.5, $200K short liquidations, closes in the lower half), then hours 93.. as given */
export function scene(after: Array<Partial<V11Bar>> = []): V11Bar[] {
  const B: V11Bar[] = [];
  let oi = 1_000_000;
  for (let i = 0; i < 85; i++) {
    const f = (k: number): number => 100 * (1 + 0.004 * Math.sin(k * 0.9) + 0.003 * Math.sin(k * 2.3));
    const o = f(i), c = f(i + 1);
    const oo = oi; oi = 1_000_000 + 1_000 * Math.sin(i * 1.3);
    B.push({ t: T0 + i * H, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, oo, oc: oi, shortLiq: 1_000 + 500 * (i % 7), longLiq: 1_000, liqOk: true });
  }
  let p = B[84].c;
  for (let i = 85; i <= 90; i++) {                      // the rally: +1 % an hour, OI -0.85 % an hour (shorts closing)
    const o = p, c = p * 1.01, oo = oi; oi = oi * 0.9915;
    B.push({ t: T0 + i * H, o, h: c * 1.001, l: o * 0.999, c, oo, oc: oi, shortLiq: 1_500, longLiq: 500, liqOk: true });
    p = c;
  }
  B.push({ t: T0 + 91 * H, o: p, h: p * 1.001, l: p * 0.997, c: p * 0.998, oo: oi, oc: oi, shortLiq: 800, longLiq: 800, liqOk: true });
  p = p * 0.998;
  B.push({ t: T0 + 92 * H, o: p, h: 107.5, l: 105.8, c: 106.2, oo: oi, oc: oi * 0.99, shortLiq: 200_000, longLiq: 5_000, liqOk: true });
  oi = oi * 0.99;
  let last = B[92];
  for (let k = 0; k < Math.max(after.length, 3); k++) {
    const x = after[k] ?? {};
    const o = last.c, c = x.c ?? o * 0.998, oo = last.oc, oc = x.oc ?? oo * 1.005;
    const b: V11Bar = { t: T0 + (93 + k) * H, o, h: x.h ?? Math.max(o, c) * 1.001, l: x.l ?? Math.min(o, c) * 0.999, c, oo, oc, shortLiq: 1_000, longLiq: 1_000, liqOk: true, ...x };
    B.push(b); last = b;
  }
  return B;
}
