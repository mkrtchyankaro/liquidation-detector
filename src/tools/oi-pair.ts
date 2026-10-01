/**
 * BTC and a coin: do their OI episodes happen together, and who is first? (Johnny, Oct 1 2026) Read-only, Binance
 * history (1h candles + 5-minute OI), times UTC. For every episode (src/research/oi-pair.ts): start, OI peak, end of the
 * OI drop after it -- price and OI at each point -- for the base coin and, side by side, the coin's matching episode,
 * with how many hours later (+) / earlier (-) the coin did each step.
 *
 *   npx tsx src/tools/oi-pair.ts --coin DOGE --days 7
 *   options: --base BTC
 *   --show 2026-09-30T06:00 --hours 12   hour-by-hour table of both coins from that UTC hour (price, OI) and, for every
 *                                        price move found there, WHY it was or was not taken as an episode
 */
import "dotenv/config";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";
import { findMoves, type MvHour } from "../research/oi-moves";
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
  const show = arg("show", "");
  if (show) {
    const s0 = Date.parse(show.endsWith("Z") ? show : `${show}:00Z`),
      n = Number(arg("hours", "12"));
    if (!Number.isFinite(s0))
      throw new Error("--show must look like 2026-09-30T06:00 (UTC)");
    const row = (h: MvHour[], ts: number) => h.find((x) => x.t === ts);
    const pc = (a: number, b: number): string => {
      const v = (100 * (b - a)) / a;
      return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`.padStart(7);
    };
    const B = base.replace(/USDT$/, ""),
      C = coin.replace(/USDT$/, "");
    console.log(
      `\nhour (UTC)   | ${B} candle   ${B} OI    | ${C} candle   ${C} OI     (change of each 1h candle, open -> close)`,
    );
    for (let ts = s0; ts < s0 + n * H; ts += H) {
      const a = row(hb, ts),
        c = row(hc, ts);
      if (!a || !c) continue;
      console.log(
        `${t(ts)}  | ${pc(a.open, a.close)}   ${pc(a.oiOpen, a.oi)}  | ${pc(c.open, c.close)}   ${pc(c.oiOpen, c.oi)}`,
      );
    }
    for (const [name, h] of [
      [B, hb],
      [C, hc],
    ] as const) {
      console.log(
        `\n${name}: price moves (1h bodies stepping one way, >= 3 candles) touching that window, and the episode checks:`,
      );
      const ms = findMoves(h).filter(
        (m) => h[m.e].t + H > s0 && h[m.s].t < s0 + n * H,
      );
      if (!ms.length)
        console.log(
          "   none -- the candle BODIES did not step one way for 3+ hours, or the move was not bigger than the range just before it",
        );
      for (const m of ms) {
        const p = m.phases[0];
        const before = h
          .slice(Math.max(0, m.s - p.hours), m.s)
          .flatMap((x) => [x.oiOpen, x.oi])
          .filter((x) => x > 0);
        const range = before.length
            ? Math.max(...before) - Math.min(...before)
            : NaN,
          grew = p.oiTo - p.oiFrom;
        const priceOk =
          m.dir === "UP" ? p.priceTo > p.priceFrom : p.priceTo < p.priceFrom;
        console.log(
          `   ${m.dir} ${t(h[m.s].t)} -> ${t(h[m.e].t + H)} price ${pc(m.startPrice, h[m.e].close)} | first phase ${p.kind} ${p.hours}h, OI ${pc(p.oiFrom, p.oiTo)}`,
        );
        console.log(
          `      OI grew ${grew.toFixed(0)} vs the OI range of the ${p.hours}h before ${range.toFixed(0)} -> ${p.kind.endsWith("OI UP") && grew > range && priceOk ? "EPISODE" : `not an episode (${!p.kind.endsWith("OI UP") ? "the OI did not rise first" : !priceOk ? "the price did not move while the OI rose" : "the OI growth was not bigger than its normal swing"})`}`,
        );
      }
    }
    return;
  }
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
