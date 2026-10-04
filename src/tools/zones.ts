/**
 * ZONES OF INTEREST -- Binance candles, 4h and daily (Johnny's friend, Oct 4 2026). Read-only: Binance public klines,
 * no keys, no database. The rule: src/research/zones.ts (turning points by the 1-ATR rule on the candle BODIES, close
 * ones grouped into zones, a zone that was resistance and became support = a flip).
 *
 *   npx tsx src/tools/zones.ts --symbol XRPUSDT                 4h and daily, the friend's view
 *   options: --tf 4h,1d (any of 15m 1h 4h 1d 1w)  --days (history; default 4h 90, 1d 240, 1h 30, 15m 10, 1w 730)
 *            --range (days for the range's high / low; default 4h 30, 1d 60, 1h 7, 15m 2, 1w 180)
 *            --k 1 (ATR for a turn)  --tol 0.8 (ATR: how close points join one zone)  --all (every zone, also single points)
 * The output per timeframe:
 *   MAIN ZONE  the zone touched last that has >= 3 points (tops + bottoms), its role and every touch
 *   ABOVE / BELOW  the nearest zones (>= 2 points) over / under the price
 *   RANGE      the highest top and the lowest bottom (bodies) of the last --range days: the edges of the range
 */
import axios from "axios";
import {
  atrSeries,
  pivots,
  zones,
  type Zone,
  type ZCandle,
} from "../research/zones";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number, tf: string): string =>
  new Date(ms)
    .toISOString()
    .slice(5, tf === "1d" || tf === "1w" ? 10 : 16)
    .replace("T", " ");
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const DAY = 86_400_000;
const DAYS: Record<string, number> = {
  "15m": 10,
  "1h": 30,
  "4h": 90,
  "1d": 240,
  "1w": 730,
};
const RANGE: Record<string, number> = {
  "15m": 2,
  "1h": 7,
  "4h": 30,
  "1d": 60,
  "1w": 180,
};

const role = (z: Zone): string =>
  z.flip === "UP"
    ? "FLIP: was resistance -> now support"
    : z.flip === "DOWN"
      ? "FLIP: was support -> now resistance"
      : z.tops
        ? "resistance"
        : "support";

async function one(sym: string, tf: string): Promise<void> {
  const days = Number(arg("days", String(DAYS[tf] ?? 90))),
    rangeDays = Number(arg("range", String(RANGE[tf] ?? 30)));
  const k = Number(arg("k", "1")),
    tol = Number(arg("tol", "0.8"));
  const rows: unknown[][] = (
    await fapi.get("/fapi/v1/klines", {
      params: {
        symbol: sym,
        interval: tf,
        startTime: Date.now() - days * DAY,
        limit: 1500,
      },
    })
  ).data;
  // the last candle is still open -> left out (nothing is decided on a candle that is not closed)
  const c: ZCandle[] = rows
    .slice(0, -1)
    .map((r) => ({
      t: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
    }));
  if (c.length < 30) {
    console.log(
      `${sym} ${tf}: only ${c.length} candles -- use a longer --days`,
    );
    return;
  }
  const atr = atrSeries(c, 14),
    a = atr[atr.length - 1],
    price = Number(rows[rows.length - 1][4]);
  const ps = pivots(c, k, 14),
    all = zones(ps, a, tol, 1),
    zs = all.filter((z) => z.pivots.length >= 2);
  const dp = Math.max(4, -Math.floor(Math.log10(price)) + 4),
    f = (v: number): string => v.toFixed(dp);
  const pct = (v: number): string =>
    `${v >= price ? "+" : ""}${((100 * (v - price)) / price).toFixed(2)}%`;
  const span = (z: Zone): string => `${f(z.lo)} – ${f(z.hi)}`;
  const where = (z: Zone): string =>
    price > z.hi
      ? `${pct(z.hi)} under the price`
      : price < z.lo
        ? `${pct(z.lo)} over the price`
        : "THE PRICE IS INSIDE";

  console.log(
    `══ ${sym} · ${tf} · ${utc(c[0].t, tf)} -> ${utc(c[c.length - 1].t, tf)} UTC (${c.length} closed candles) · now ${price} · ATR ${((100 * a) / price).toFixed(2)}%`,
  );
  const main =
    [...zs]
      .filter((z) => z.pivots.length >= 3)
      .sort((x, y) => y.lastT - x.lastT)[0] ??
    [...zs].sort((x, y) => y.lastT - x.lastT)[0];
  if (main) {
    console.log(
      `MAIN ZONE   ${span(main)}  (wicks ${f(main.wickLo)} – ${f(main.wickHi)}) · ${role(main)} · ${main.pivots.length} touches · ${where(main)}`,
    );
    for (const p of main.pivots)
      console.log(
        `              ${utc(p.t, tf)}  ${p.kind === "TOP" ? "hit from below, went down" : "hit from above, went up "}  body ${f(p.body)} · wick ${f(p.wick)}`,
      );
  } else console.log(`MAIN ZONE   none (no zone with 2+ touches)`);
  const above = zs
    .filter((z) => z.lo > price && z !== main)
    .sort((x, y) => x.lo - y.lo)
    .slice(0, 2);
  const below = zs
    .filter((z) => z.hi < price && z !== main)
    .sort((x, y) => y.hi - x.hi)
    .slice(0, 2);
  for (const z of above)
    console.log(
      `ABOVE       ${span(z)} · ${role(z)} · ${z.pivots.length} touches · last ${utc(z.lastT, tf)} · ${where(z)}`,
    );
  for (const z of below)
    console.log(
      `BELOW       ${span(z)} · ${role(z)} · ${z.pivots.length} touches · last ${utc(z.lastT, tf)} · ${where(z)}`,
    );
  const recent = ps.filter((p) => p.t >= c[c.length - 1].t - rangeDays * DAY);
  const hi = recent
      .filter((p) => p.kind === "TOP")
      .sort((x, y) => y.body - x.body)[0],
    lo = recent
      .filter((p) => p.kind === "BOTTOM")
      .sort((x, y) => x.body - y.body)[0];
  console.log(
    `RANGE (${rangeDays}d) top ${hi ? `${f(hi.body)} (wick ${f(hi.wick)}, ${utc(hi.t, tf)}) ${pct(hi.body)}` : "none"} · bottom ${lo ? `${f(lo.body)} (wick ${f(lo.wick)}, ${utc(lo.t, tf)}) ${pct(lo.body)}` : "none"}`,
  );
  if (argv.includes("--all")) {
    console.log(`  every zone (single points too):`);
    for (const z of [...all].sort((x, y) => y.hi - x.hi))
      console.log(
        `   ${span(z)}  ${String(z.pivots.length).padStart(2)} touches (${z.tops} from below, ${z.bottoms} from above) · ${role(z).padEnd(36)} last ${utc(z.lastT, tf)} · ${where(z)}`,
      );
  }
  console.log("");
}

async function main(): Promise<void> {
  const sym = arg("symbol", "XRPUSDT").toUpperCase();
  for (const tf of arg("tf", "4h,1d")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean))
    await one(sym, tf);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
