/**
 * THE CURRENT 4h ZONES OF A COIN -- the zone above the price and the zone below (Johnny, Oct 6 2026). Read-only:
 * Binance public 4h klines (the last 90 days), no keys, no database. The SAME zones as the live V10 message
 * (src/strategy/v10/v10-zone.ts zoneViewOf): turning points of 1 ATR on candle bodies, grouped when within 0.8 ATR,
 * a zone at most 1.6 ATR wide, 3+ touches. Only closed 4h candles; the price = the last price.
 *   body   lo – hi       the zone (candle bodies) -- draw this on the chart
 *   wick   wickLo – wickHi  where the wicks of those touches reached
 *   touches  ↑ from below (it was resistance) / ↓ from above (it was support)
 *   FLIP ✅  both roles 2+ times · strong = FLIP built over 10+ days (the only kind the live message warns about)
 * Plus the 4h supply / demand zones (sdZones) not broken yet: the nearest above and below.
 *
 *   npx tsx src/tools/zones-now.ts --symbol XRPUSDT
 *   npx tsx src/tools/zones-now.ts --symbol XRPUSDT,ALGOUSDT,ADAUSDT
 */
import { atrSeries, pivots, sdZones, zoneQuality, zones, type ZCandle } from "../research/zones";
import { publicKlines4h } from "../strategy/v10/v10-zone";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const H4 = 4 * 3_600_000;
const px = (v: number): string => String(+v.toPrecision(5));
const pct = (v: number, price: number): string => `${v >= price ? "+" : ""}${((100 * (v - price)) / price).toFixed(2)}%`;

async function one(sym: string): Promise<void> {
  const all = await publicKlines4h(sym);
  if (all.length < 30) { console.log(`${sym}: not enough 4h candles`); return; }
  const price = all[all.length - 1].close;
  const c: ZCandle[] = all.filter((x) => x.t + H4 <= Date.now());
  const a = atrSeries(c, 14), atr = a[a.length - 1];
  const zs = zones(pivots(c, 1, 14), atr, 0.8, 3, 1.6).map((z) => ({ z, q: zoneQuality(c, z, atr) }))
    .sort((x, y) => y.z.hi - x.z.hi);
  const dist = (lo: number, hi: number): string =>
    price > hi ? `${pct(hi, price)} · ${((hi - price) / atr).toFixed(1)} ATR` : price < lo ? `${pct(lo, price)} · +${((lo - price) / atr).toFixed(1)} ATR` : "ԳԻՆԸ ՆԵՐՍՈՒՄ Է";
  const above = zs.filter((x) => x.z.lo > price).sort((x, y) => x.z.lo - y.z.lo)[0];
  const below = zs.filter((x) => x.z.hi < price).sort((x, y) => y.z.hi - x.z.hi)[0];

  console.log(`\n═══ ${sym} · ${utc(Date.now())} UTC · գին ${px(price)} · 4h ATR ${px(atr)} (${((100 * atr) / price).toFixed(2)}%) · ${utc(c[0].t)} -> ${utc(c[c.length - 1].t + H4)} ═══`);
  if (!zs.length) console.log("  4h զոնա (3+ հպում) չկա");
  let marked = false;
  for (const { z, q } of zs) {
    if (!marked && z.hi < price) { console.log(`  ─────────── ԳԻՆ ${px(price)} ───────────`); marked = true; }
    const flip = q.res >= 2 && q.sup >= 2, strong = flip && q.life >= 10;
    const tag = z === above?.z ? " ⬆️ ՎԵՐԵՎԻ" : z === below?.z ? " ⬇️ ՆԵՐՔԵՎԻ" : "";
    console.log(`  ${px(z.lo)} – ${px(z.hi)}  (wick ${px(z.wickLo)} – ${px(z.wickHi)}) · ↑${q.res} ↓${q.sup} · FLIP ${flip ? "✅" : "չէ"}${strong ? " · ուժեղ" : ""} · ${q.life.toFixed(0)} օր · վերջին ${utc(z.lastT)} · ${dist(z.lo, z.hi)}${tag}`);
  }
  if (!marked) console.log(`  ─────────── ԳԻՆ ${px(price)} ───────────`);

  const sd = sdZones(c).filter((z) => z.brokenT === null);
  const sup = sd.filter((z) => z.kind === "SUPPLY" && z.lo > price).sort((x, y) => x.lo - y.lo)[0];
  const dem = sd.filter((z) => z.kind === "DEMAND" && z.hi < price).sort((x, y) => y.hi - x.hi)[0];
  console.log(`  supply վերևում: ${sup ? `${px(sup.lo)} – ${px(sup.hi)} (${utc(sup.t)}, ${pct(sup.lo, price)})` : "չկա"}`);
  console.log(`  demand ներքևում: ${dem ? `${px(dem.lo)} – ${px(dem.hi)} (${utc(dem.t)}, ${pct(dem.hi, price)})` : "չկա"}`);
}

async function main(): Promise<void> {
  for (const s of arg("symbol", "XRPUSDT").toUpperCase().split(",").map((x) => x.trim()).filter(Boolean)) {
    try { await one(s); } catch (err) { console.log(`${s}: ${err instanceof Error ? err.message : err}`); }
  }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
