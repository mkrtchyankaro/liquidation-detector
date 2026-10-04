/**
 * ZONES -- the friend's view in 3 lines (Johnny, Oct 4 2026). Read-only: Binance public klines, no keys, no database.
 *   4h MAIN ZONE   src/research/zones.ts zones(): turning points (1 ATR, bodies) close to each other (0.8 ATR) --
 *                  the zone touched last with 3+ points (the flip zone, body to body)
 *   1d TOP/BOTTOM  over the days the 4h zone exists (its first touch -> the end): highest body .. highest wick,
 *                  lowest wick .. lowest body
 *   1d ABOVE/BELOW src/research/zones.ts sdZones() over the same days: the standard supply / demand zones -- a base of small-body
 *                  candles before a strong candle (body > half its range and >= 1 ATR); supply = highest wick ..
 *                  lowest body, demand = lowest wick .. highest body; the nearest one not broken, above / below the price
 *
 *   npx tsx src/tools/zones.ts --symbol XRPUSDT                                  the last 90 days up to now
 *   npx tsx src/tools/zones.ts --symbol XRPUSDT --from 2026-09-01 --to 2026-10-04   only zones made in that period
 *   options: --main 4h  --outer 1d  --tol 0.8  --detail (the touches and every zone)
 */
import axios from "axios";
import {
  atrSeries,
  pivots,
  sdZones,
  zones,
  type ZCandle,
} from "../research/zones";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const day = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .slice(5, 16)
    .replace("T", " ")
    .replace(" 00:00", "");
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const DAY = 86_400_000,
  WARM = 60 * DAY; // extra history before --from for the ATR
const ms = (s: string): number =>
  Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}:00Z`);

async function klines(
  sym: string,
  tf: string,
  from: number,
  to: number,
): Promise<{ c: ZCandle[]; last: number }> {
  const out: ZCandle[] = [];
  let start = from;
  for (;;) {
    const rows: unknown[][] = (
      await fapi.get("/fapi/v1/klines", {
        params: {
          symbol: sym,
          interval: tf,
          startTime: start,
          endTime: to - 1,
          limit: 1500,
        },
      })
    ).data;
    for (const r of rows)
      out.push({
        t: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      });
    if (rows.length < 1500) break;
    start = Number(rows[rows.length - 1][0]) + 1;
  }
  const step =
    {
      "15m": 900_000,
      "1h": 3_600_000,
      "4h": 14_400_000,
      "1d": DAY,
      "1w": 7 * DAY,
    }[tf] ?? DAY;
  // a candle not closed by `to` (or by now) is left out -- nothing is decided on an open candle
  const closed = out.filter((x) => x.t + step <= Math.min(to, Date.now()));
  return { c: closed, last: out.length ? out[out.length - 1].close : NaN };
}

async function main(): Promise<void> {
  const sym = arg("symbol", "XRPUSDT").toUpperCase(),
    mainTf = arg("main", "4h"),
    outerTf = arg("outer", "1d"),
    tol = Number(arg("tol", "0.8"));
  const to = argv.includes("--to")
    ? ms(arg("to", "")) + (arg("to", "").length <= 10 ? DAY : 0)
    : Date.now();
  const from = argv.includes("--from") ? ms(arg("from", "")) : to - 90 * DAY;
  if (!(from > 0) || !(to > from))
    throw new Error("use --from YYYY-MM-DD --to YYYY-MM-DD (UTC)");
  const [m, o] = await Promise.all([
    klines(sym, mainTf, from - WARM, to),
    klines(sym, outerTf, from - WARM, to),
  ]);
  const price = o.last,
    dp = Math.max(4, -Math.floor(Math.log10(price)) + 4),
    f = (v: number): string => v.toFixed(dp);
  const pct = (v: number): string =>
    `${v >= price ? "+" : ""}${((100 * (v - price)) / price).toFixed(2)}%`;

  // 4h main zone: only turning points inside the period
  const atr = atrSeries(m.c, 14),
    ps = pivots(m.c, 1, 14).filter((p) => p.t >= from);
  const zs = zones(ps, atr[atr.length - 1], tol, 2);
  const main =
    zs
      .filter((z) => z.pivots.length >= 3)
      .sort((x, y) => y.lastT - x.lastT)[0] ??
    zs.sort((x, y) => y.lastT - x.lastT)[0];
  // 1d (Johnny Oct 4): the daily view is taken over the days the 4h zone EXISTS -- from its first touch to the end
  const life = main ? Math.floor(main.pivots[0].t / DAY) * DAY : from;
  const sd = sdZones(o.c, { from: life }).filter((z) => z.brokenT === null);
  const above = sd
    .filter((z) => z.kind === "SUPPLY" && z.lo > price)
    .sort((x, y) => x.lo - y.lo)[0];
  const below = sd
    .filter((z) => z.kind === "DEMAND" && z.hi < price)
    .sort((x, y) => y.hi - x.hi)[0];
  const inside = sd.filter((z) => z.lo <= price && price <= z.hi);
  // the edges of those days: the top zone = the highest body .. the highest wick, the bottom zone = the lowest wick .. the lowest body
  const days = o.c.filter((x) => x.t >= life);
  const topBody = Math.max(...days.map((x) => Math.max(x.open, x.close))),
    topWick = Math.max(...days.map((x) => x.high));
  const botBody = Math.min(...days.map((x) => Math.min(x.open, x.close))),
    botWick = Math.min(...days.map((x) => x.low));
  const when = (v: number, key: (x: ZCandle) => number): string =>
    day(days.find((x) => key(x) === v)?.t ?? NaN);

  console.log(
    `${sym} · ${day(from)} → ${day(Math.min(to, Date.now()))} UTC · price ${price}`,
  );
  console.log(
    `${mainTf} main zone:   ${main ? `${f(main.lo)} – ${f(main.hi)}  (${main.pivots.length} touches${main.flip === "UP" ? ", was resistance, now support" : main.flip === "DOWN" ? ", was support, now resistance" : ""})` : "none"}`,
  );
  console.log(
    `${outerTf} top:          ${f(topBody)} – ${f(topWick)}  (the highest body ${when(topBody, (x) => Math.max(x.open, x.close))} .. the highest wick ${when(topWick, (x) => x.high)}, since ${day(life)}, the 4h zone's first touch)`,
  );
  console.log(
    `${outerTf} bottom:       ${f(botWick)} – ${f(botBody)}  (the lowest wick ${when(botWick, (x) => x.low)} .. the lowest body ${when(botBody, (x) => Math.min(x.open, x.close))})`,
  );
  console.log(
    `${outerTf} above:        ${above ? `${f(above.lo)} – ${f(above.hi)}  (supply, ${day(above.t)}, ${pct(above.lo)})` : "none (no unbroken supply zone above in this period)"}`,
  );
  console.log(
    `${outerTf} below:        ${below ? `${f(below.lo)} – ${f(below.hi)}  (demand, ${day(below.t)}, ${pct(below.hi)})` : "none (no unbroken demand zone below in this period)"}`,
  );
  for (const z of inside)
    console.log(
      `${outerTf} PRICE INSIDE: ${f(z.lo)} – ${f(z.hi)}  (${z.kind.toLowerCase()}, ${day(z.t)})`,
    );

  if (argv.includes("--detail")) {
    console.log(
      `  every ${mainTf} zone (2+ touches) in the period, high to low:`,
    );
    for (const z of [...zs].sort((x, y) => y.hi - x.hi)) {
      const first = z.pivots[0].t,
        last = z.lastT;
      console.log(
        `   ${f(z.lo)} – ${f(z.hi)} · ${z.tops} from below (tops) · ${z.bottoms} from above (bottoms) · ${z.flip === "UP" ? "FLIP up" : z.flip === "DOWN" ? "FLIP down" : "-"} · ${day(first)} .. ${day(last)}`,
      );
    }
    if (main)
      for (const p of main.pivots)
        console.log(
          `   ${mainTf} ${day(p.t)}  ${p.kind === "TOP" ? "hit from below" : "hit from above"}  body ${f(p.body)} · wick ${f(p.wick)}`,
        );
    console.log(
      `  every ${outerTf} supply / demand zone made since ${day(life)}:`,
    );
    for (const z of sdZones(o.c, { from: life }))
      console.log(
        `   ${z.kind.padEnd(6)} ${f(z.lo)} – ${f(z.hi)} · base ${day(z.t)} (${z.baseN} candle${z.baseN > 1 ? "s" : ""}) · leg ${day(z.legT)} · touched ${z.touches}x · ${z.brokenT ? `broken ${day(z.brokenT)}` : "not broken"}`,
      );
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
