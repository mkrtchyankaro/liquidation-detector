/**
 * BTC and a coin: do their OI episodes happen together, and who is first? (Johnny, Oct 1 2026) Read-only, Binance
 * history (1h candles + 5-minute OI), times UTC. For every episode (src/research/oi-pair.ts): start, OI peak, end of the
 * OI drop after it -- price and OI at each point -- for the base coin and, side by side, the coin's matching episode,
 * with how many hours later (+) / earlier (-) the coin did each step.
 *
 *   npx tsx src/tools/oi-pair.ts --coin DOGE --days 7
 *   options: --base BTC
 */
import "dotenv/config";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";
import type { MvHour } from "../research/oi-moves";
import { episodes, pairEpisodes, type Episode } from "../research/oi-pair";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sym = (s: string): string =>
  s.toUpperCase().endsWith("USDT") ? s.toUpperCase() : `${s.toUpperCase()}USDT`;
const H = 3_600_000,
  D = 24 * H;
const t = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const pct = (a: number, b: number): string => {
  const v = (100 * (b - a)) / a;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
};
const lag = (v: number | null): string =>
  v === null ? "  -" : `${v >= 0 ? "+" : ""}${v}h`;

async function hours(
  symbol: string,
  from: number,
  to: number,
): Promise<MvHour[]> {
  const snap = await oiSnapshots(symbol, from, to),
    kl = await klines(symbol, "1h", from, to);
  return kl.map((c) => ({
    ...c,
    oi: oiAt(snap, c.t + H),
    oiOpen: oiAt(snap, c.t),
  }));
}
const line = (name: string, e: Episode): string =>
  `${name.padEnd(5)} ${e.dir === "UP" ? "▲" : "▼"} start ${t(e.start)} -> OI peak ${t(e.peak)} (price ${pct(e.priceStart, e.pricePeak)}, OI ${pct(e.oiStart, e.oiPeak)}) -> drop end ${t(e.dropEnd)} (${Math.round((e.dropEnd - e.peak) / H)}h, OI ${pct(e.oiPeak, e.oiDropEnd)} = ${Number.isFinite(e.takenPct) ? e.takenPct.toFixed(0) : "?"}% of built, price ${pct(e.pricePeak, e.priceDropEnd)})${e.ongoing ? " <- still going" : ""}`;

async function main(): Promise<void> {
  const base = sym(arg("base", "BTC")),
    coin = sym(arg("coin", "DOGE")),
    days = Number(arg("days", "7"));
  const to = Math.floor(Date.now() / H) * H,
    win = to - days * D,
    from = Math.floor((win - 2 * D) / D) * D;
  const [hb, hc] = [await hours(base, from, to), await hours(coin, from, to)];
  const eb = episodes(hb).filter((e) => e.peak > win),
    ec = episodes(hc).filter((e) => e.peak > win);
  const pairs = pairEpisodes(eb, ec);
  const b = base.replace(/USDT$/, ""),
    c = coin.replace(/USDT$/, "");
  console.log(
    `\n${b} vs ${c} · OI episodes (price + OI growing, then the OI drop) · last ${days} days · UTC · lag = ${c} later (+) / earlier (-) than ${b}\n`,
  );
  for (const p of pairs) {
    console.log(line(b, p.base));
    if (p.coin)
      console.log(
        `${line(c, p.coin)}\n      lag: start ${lag(p.startLagH)} · peak ${lag(p.peakLagH)} · drop end ${lag(p.dropEndLagH)}\n`,
      );
    else
      console.log(
        `${c.padEnd(5)} no matching episode (same direction, overlapping)\n`,
      );
  }
  const used = new Set(pairs.map((p) => p.coin).filter(Boolean));
  const alone = ec.filter((e) => !used.has(e));
  if (alone.length) {
    console.log(`${c} episodes with no ${b} episode:`);
    for (const e of alone) console.log(line(c, e));
  }
  const m = pairs.filter((p) => p.coin);
  const avg = (v: number[]): string =>
    v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : "-";
  console.log(
    `\nSUMMARY: ${b} ${eb.length} episodes, ${c} ${ec.length}; together ${m.length} · ${c} alone ${alone.length}`,
  );
  console.log(
    `   ${c} vs ${b}, average hours: start ${avg(m.map((p) => p.startLagH!))} · peak ${avg(m.map((p) => p.peakLagH!))} · drop end ${avg(m.map((p) => p.dropEndLagH!))}`,
  );
  console.log(
    `   ${c} peaked: before ${b} ${m.filter((p) => p.peakLagH! < 0).length} · same hour ${m.filter((p) => p.peakLagH === 0).length} · after ${m.filter((p) => p.peakLagH! > 0).length}`,
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
