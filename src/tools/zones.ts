/**
 * ZONES OF INTEREST -- Binance 4h candles (Johnny's friend, Oct 4 2026). Read-only: Binance public klines, no keys,
 * no database. The rule: src/research/zones.ts (turning points by the 1-ATR rule on the candle BODIES, close ones
 * grouped into zones, a zone that was resistance and became support = a flip).
 *
 *   npx tsx src/tools/zones.ts --symbol XRPUSDT
 *   options: --tf 4h (1h, 1d ...)  --days 90  --k 1 (ATR for a turn)  --tol 0.5 (ATR: how close points join one zone)
 *            --min 2 (points for a zone)
 */
import axios from "axios";
import { atrSeries, pivots, zones, type ZCandle } from "../research/zones";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});

async function main(): Promise<void> {
  const sym = arg("symbol", "XRPUSDT").toUpperCase(),
    tf = arg("tf", "4h"),
    days = Number(arg("days", "90"));
  const k = Number(arg("k", "1")),
    tol = Number(arg("tol", "0.5")),
    min = Number(arg("min", "2"));
  const rows: unknown[][] = (
    await fapi.get("/fapi/v1/klines", {
      params: {
        symbol: sym,
        interval: tf,
        startTime: Date.now() - days * 86_400_000,
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
  if (c.length < 30) throw new Error(`only ${c.length} candles`);
  const atr = atrSeries(c, 14),
    a = atr[atr.length - 1],
    price = Number(rows[rows.length - 1][4]);
  const ps = pivots(c, k, 14),
    zs = zones(ps, a, tol, min);
  const dp = Math.max(4, -Math.floor(Math.log10(price)) + 4),
    f = (v: number): string => v.toFixed(dp);
  const pct = (v: number): string =>
    `${v >= price ? "+" : ""}${((100 * (v - price)) / price).toFixed(2)}%`;
  console.log(
    `${sym} · ${tf} · ${utc(c[0].t)} -> ${utc(c[c.length - 1].t)} UTC (${c.length} closed candles) · now ${price} · ATR ${f(a)} (${((100 * a) / price).toFixed(2)}%)`,
  );
  console.log(
    `turning points: ${ps.length} (1 ATR on the bodies) · zones (>= ${min} points within ${tol} ATR): ${zs.length}\n`,
  );
  console.log(
    `  zone (bodies)              wicks                 points  tops bottoms  role now                last touch      from now`,
  );
  const role = (z: (typeof zs)[number]): string =>
    z.flip === "UP"
      ? "FLIP: was resist -> support"
      : z.flip === "DOWN"
        ? "FLIP: was support -> resist"
        : z.tops
          ? "resistance"
          : "support";
  for (const z of [...zs].sort((x, y) => y.hi - x.hi)) {
    const where =
      price > z.hi
        ? `below ${pct(z.hi)}`
        : price < z.lo
          ? `above ${pct(z.lo)}`
          : "PRICE INSIDE";
    console.log(
      `  ${f(z.lo)} – ${f(z.hi)}   (${f(z.wickLo)} – ${f(z.wickHi)})   ${String(z.pivots.length).padStart(4)}   ${String(z.tops).padStart(3)} ${String(z.bottoms).padStart(6)}   ${role(z).padEnd(27)} ${utc(z.lastT)}    ${where}`,
    );
  }
  const latest = [...zs].sort((x, y) => y.lastT - x.lastT)[0];
  const below = zs.filter((z) => z.hi < price).sort((x, y) => y.hi - x.hi)[0],
    above = zs.filter((z) => z.lo > price).sort((x, y) => x.lo - y.lo)[0];
  console.log(
    `\nTHE LATEST ZONE (touched last): ${latest ? `${f(latest.lo)} – ${f(latest.hi)} · ${role(latest)} · ${latest.pivots.length} points` : "none"}`,
  );
  if (latest)
    for (const p of latest.pivots)
      console.log(
        `   ${utc(p.t)} UTC  ${p.kind === "TOP" ? "top    (hit from below)" : "bottom (hit from above)"}  body ${f(p.body)} · wick ${f(p.wick)}`,
      );
  console.log(
    `nearest zone BELOW the price: ${below ? `${f(below.lo)} – ${f(below.hi)} (${pct(below.hi)})` : "none"}`,
  );
  console.log(
    `nearest zone ABOVE the price: ${above ? `${f(above.lo)} – ${f(above.hi)} (${pct(above.lo)})` : "none"}`,
  );
  if (argv.includes("--points")) {
    console.log(`\nALL TURNING POINTS`);
    for (const p of ps)
      console.log(
        `   ${utc(p.t)}  ${p.kind.padEnd(6)} body ${f(p.body)} wick ${f(p.wick)}`,
      );
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
