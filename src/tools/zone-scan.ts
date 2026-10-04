/**
 * WHICH ALTS HAVE A STRONG 4h ZONE? (Johnny + friend, Oct 4 2026: "XRP's zone is strong, SOL's is not"). Read-only:
 * Binance public 4h klines (90 days), no keys. For every symbol in SYMBOLS: the 4h main zone (src/research/zones.ts,
 * as src/tools/zones.ts: 1-ATR turns on the bodies, 0.8 ATR apart -> one zone, the latest with 3+ touches) and its
 * quality, all measured, no fixed thresholds:
 *   res / sup      touches from below (tops) / from above (bottoms)
 *   resD / supD    days between the first and the last touch of each role (spread in time = real tests, not one day)
 *   react          the median reaction after a touch, in ATR: how far the price went away from the zone before it came
 *                  back into it (or until now) -- big = real orders there
 *   width          the zone's height in ATR (narrow = precise)
 *   life           days from the first to the last touch
 * Sorted by react x (the smaller of res and sup) -- a strong flip needs both roles AND real reactions.
 *
 *   npx tsx src/tools/zone-scan.ts
 *   options: --days 90  --tol 0.8  --max-width 1.6 (ATR; default 2 x tol: points never chain into a zone taller than that)  --symbols XRPUSDT,SOLUSDT (default: SYMBOLS from .env)
 */
import "dotenv/config";
import axios from "axios";
import {
  atrSeries,
  pivots,
  zones,
  type ZCandle,
  type Zone,
} from "../research/zones";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 10);
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const DAY = 86_400_000;

/** how far the price went away from the zone after each touch (ATR), until it came back into the zone */
function reactions(c: readonly ZCandle[], z: Zone, atr: number): number[] {
  return z.pivots.map((p) => {
    // from the touch on: the furthest the price got from the zone; ends when, after fully leaving it, it comes back in
    let far = 0,
      left = false;
    for (let j = p.i + 1; j < c.length; j++) {
      const x = c[j];
      if (p.kind === "TOP") {
        far = Math.max(far, z.lo - x.low);
        if (x.high < z.lo) left = true;
        else if (left) break;
      } else {
        far = Math.max(far, x.high - z.hi);
        if (x.low > z.hi) left = true;
        else if (left) break;
      }
    }
    return far / atr;
  });
}
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

async function main(): Promise<void> {
  const days = Number(arg("days", "90")),
    tol = Number(arg("tol", "0.8")),
    maxW = Number(arg("max-width", String(2 * tol)));
  const syms = (
    argv.includes("--symbols")
      ? arg("symbols", "")
      : `BTCUSDT,${process.env.SYMBOLS ?? ""}`
  )
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const rows: Array<{
    sym: string;
    z: Zone;
    price: number;
    res: number;
    sup: number;
    resD: number;
    supD: number;
    react: number;
    width: number;
    life: number;
    score: number;
  }> = [];
  for (const sym of [...new Set(syms)]) {
    try {
      const raw: unknown[][] = (
        await fapi.get("/fapi/v1/klines", {
          params: {
            symbol: sym,
            interval: "4h",
            startTime: Date.now() - days * DAY,
            limit: 1500,
          },
        })
      ).data;
      const c: ZCandle[] = raw
        .slice(0, -1)
        .map((r) => ({
          t: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
        }));
      if (c.length < 60) continue;
      const atrS = atrSeries(c, 14),
        atr = atrS[atrS.length - 1],
        price = Number(raw[raw.length - 1][4]);
      const zs = zones(pivots(c, 1, 14), atr, tol, 2, maxW);
      const z = zs
        .filter((x) => x.pivots.length >= 3)
        .sort((a, b) => b.lastT - a.lastT)[0];
      if (!z) continue;
      const tops = z.pivots.filter((p) => p.kind === "TOP"),
        bots = z.pivots.filter((p) => p.kind === "BOTTOM");
      const span = (l: typeof tops): number =>
        l.length > 1 ? (l[l.length - 1].t - l[0].t) / DAY : 0;
      const react = median(reactions(c, z, atr));
      rows.push({
        sym,
        z,
        price,
        res: tops.length,
        sup: bots.length,
        resD: span(tops),
        supD: span(bots),
        react,
        width: (z.hi - z.lo) / atr,
        life: (z.lastT - z.pivots[0].t) / DAY,
        score: react * Math.min(tops.length, bots.length),
      });
    } catch (err) {
      console.error(`${sym}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  rows.sort((a, b) => b.score - a.score);
  console.log(
    `4h MAIN ZONES · ${days} days · zone height at most ${maxW} ATR · ${rows.length} coins · score = median reaction (ATR) x min(touches from below, from above)\n`,
  );
  console.log(
    `  coin        zone                          price      res sup  resD  supD  react  width  life  score  role`,
  );
  for (const r of rows) {
    const dp = Math.max(4, -Math.floor(Math.log10(r.price)) + 4),
      f = (v: number): string => v.toFixed(dp);
    const role =
      r.z.flip === "UP"
        ? "flip -> support"
        : r.z.flip === "DOWN"
          ? "flip -> resistance"
          : r.res
            ? "resistance"
            : "support";
    console.log(
      `  ${r.sym.replace(/USDT$/, "").padEnd(10)} ${`${f(r.z.lo)} – ${f(r.z.hi)}`.padEnd(29)} ${String(+r.price.toPrecision(6)).padStart(9)}  ${String(r.res).padStart(3)} ${String(r.sup).padStart(3)}  ${r.resD.toFixed(0).padStart(4)}  ${r.supD.toFixed(0).padStart(4)}  ${r.react.toFixed(1).padStart(5)}  ${r.width.toFixed(1).padStart(5)}  ${r.life.toFixed(0).padStart(4)}  ${r.score.toFixed(1).padStart(5)}  ${role} (${utc(r.z.pivots[0].t)} .. ${utc(r.z.lastT)})`,
    );
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
