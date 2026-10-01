/**
 * BTC LEADS -> trade the coin that follows it (Johnny, Oct 1 2026). Read-only, straight from Binance (1h + 15m + 5m
 * candles, 5-minute OI), times UTC, LIVE-SAFE, no %. Rules: src/research/btc-lead.ts
 *   - start: a closed 1h BTC candle with OI up and the price moving; then every next hour is watched as four 15m candles
 *   - signal: a 15m OI fall bigger (in BTC) than the biggest 15m OI rise of the episode so far (BTC UP -> SHORT, DOWN -> LONG)
 *   - no signal in an hour: it goes on while the hour still has OI up + price the episode's way, else it is over
 *   - the coin (--pick amp, default): among the coins that followed BTC (R2 in the upper half of all coins in the --hours
 *     before), the one that moves the MOST per BTC % (x BTC); --pick r2 = simply the best follower
 *   - no SL / TP: how far the coin and BTC went our way (best) / against us (worst) in the next 1h / 4h
 *   - BIG episode = it built more OI than any single hour of the 24h before it (no %); summary split big / small
 *   - BASELINE: the same coin choice + after-look from EVERY 15m close, per side -- what "no signal" gives
 *
 *   npx tsx src/tools/btc-lead.ts --days 7
 *   options: --hours 4 (window to pick the coin)  --coins DOGE,SOL,...  --top 3 (coins shown per signal)
 */
import "dotenv/config";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";
import {
  afterOf,
  leadSignals,
  pickCoin,
  rankCoins,
  type After,
  type Q15,
} from "../research/btc-lead";
import type { MvHour } from "../research/oi-moves";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DEFAULT =
  "ETH,SOL,XRP,BNB,DOGE,ADA,LINK,AVAX,SUI,HYPE,LTC,BCH,DOT,NEAR,UNI,ENA,ALGO,XTZ,WLD,STRK,HBAR,ZEC,XLM,ONDO";
const H = 3_600_000,
  D = 24 * H,
  M5 = 5 * 60_000,
  Q = 15 * 60_000,
  WINDOWS = [1, 4];
const t = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number | null): string =>
  v === null || !Number.isFinite(v)
    ? "  n/a"
    : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const days = Number(arg("days", "7")),
    pickH = Number(arg("hours", "4")),
    top = Number(arg("top", "3"));
  const how = arg("pick", "amp") === "r2" ? "r2" : "amp";
  const coins = arg("coins", DEFAULT)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (s.endsWith("USDT") ? s : `${s}USDT`))
    .filter((s) => s !== "BTCUSDT");
  const to = Math.floor(Date.now() / M5) * M5,
    win = to - days * D,
    from = Math.floor((win - 2 * D) / D) * D;
  const snap = await oiSnapshots("BTCUSDT", from, to, "5m");
  const h: MvHour[] = (await klines("BTCUSDT", "1h", from, to)).map((c) => ({
    ...c,
    oi: oiAt(snap, c.t + H, 10 * 60_000),
    oiOpen: oiAt(snap, c.t, 10 * 60_000),
  }));
  const q15: Q15[] = (await klines("BTCUSDT", "15m", from, to)).map((c) => ({
    ...c,
    oiFrom: oiAt(snap, c.t, 10 * 60_000),
    oiTo: oiAt(snap, c.t + Q, 10 * 60_000),
  }));
  const sigs = leadSignals(h, q15).filter((s) => s.ts >= win);
  const btc5 = await klines("BTCUSDT", "5m", win - (pickH + 1) * H, to);
  const bars = new Map<
    string,
    Array<{ t: number; high: number; low: number; close: number }>
  >();
  for (const s of coins) {
    try {
      bars.set(
        s,
        (await klines(s, "5m", win - (pickH + 1) * H, to)).map((k) => ({
          t: k.t,
          high: k.high,
          low: k.low,
          close: k.close,
        })),
      );
    } catch (err) {
      console.log(
        `  ${s}: failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    await sleep(250);
  }
  console.log(
    `\nBTC leads · last ${days} days · ${sigs.length} BTC signals · coin = ${how === "amp" ? "the follower that moves most per BTC %" : "the best BTC follower"} in the ${pickH}h before · after the signal: best (our way) / worst (against) / close, in % · UTC\n`,
  );
  const rows: Array<{
    coin: After[];
    btc: After[];
    big: boolean;
    side: "LONG" | "SHORT";
  }> = [];
  for (const s of sigs) {
    const rank = rankCoins(btc5, bars, s.ts, pickH);
    console.log(
      `${t(s.ts)}  BTC ${s.dir === "UP" ? "▲" : "▼"} since ${t(s.moveStart)} (${s.moveHours.toFixed(1)}h): price ${sp(s.pricePct)}, OI ${sp(s.oiPct)} · OI built ${Math.round(s.built).toLocaleString("en-US")} BTC (${s.big ? "BIG" : "small"}: biggest 1h rise of the 24h before ${Math.round(s.prevMaxHourRise).toLocaleString("en-US")}), this 15m OI fell ${Math.round(s.fall).toLocaleString("en-US")} > biggest 15m rise ${Math.round(s.maxRise).toLocaleString("en-US")} -> ${s.side}`,
    );
    console.log(
      `      ${how === "amp" ? "biggest x BTC" : "followers"} (R2 / x BTC): ${
        (how === "amp"
          ? [...rank]
              .filter((r) => Number.isFinite(r.beta))
              .sort((a, z) => z.beta - a.beta)
          : rank
        )
          .slice(0, top)
          .map(
            (r) =>
              `${r.symbol.replace(/USDT$/, "")} ${r.r2.toFixed(2)} / x${r.beta.toFixed(2)}`,
          )
          .join(" · ") || "none"
      }`,
    );
    const pick = pickCoin(rank, how),
      a = pick ? afterOf(bars.get(pick.symbol)!, s.ts, s.side, WINDOWS) : null,
      b = afterOf(btc5, s.ts, s.side, WINDOWS);
    const fmt = (x: After[]): string =>
      x
        .map((w) => `${w.h}h ${sp(w.best)} / ${sp(w.worst)} / ${sp(w.close)}`)
        .join("   ");
    if (a)
      console.log(
        `      ${pick!.symbol.replace(/USDT$/, "").padEnd(5)} ${s.side} ${a.entry}:  ${fmt(a.after)}`,
      );
    if (b) console.log(`      BTC   ${s.side} ${b.entry}:  ${fmt(b.after)}`);
    if (a && b)
      rows.push({ coin: a.after, btc: b.after, big: s.big, side: s.side });
    console.log("");
  }
  if (!rows.length) return;
  // baseline: every 15m close in the window, same coin choice, both sides
  const base: Record<"LONG" | "SHORT", After[][]> = { LONG: [], SHORT: [] };
  for (let ts = Math.ceil(win / Q) * Q; ts + 4 * H <= to; ts += Q) {
    const pick = pickCoin(rankCoins(btc5, bars, ts, pickH), how);
    if (!pick) continue;
    for (const side of ["LONG", "SHORT"] as const) {
      const a = afterOf(bars.get(pick.symbol)!, ts, side, WINDOWS);
      if (a) base[side].push(a.after);
    }
  }
  const mean = (v: number[]): number => {
    const f = v.filter(Number.isFinite);
    return f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN;
  };
  const line = (name: string, rs: typeof rows): void => {
    if (!rs.length) {
      console.log(`   ${name}: none`);
      return;
    }
    WINDOWS.forEach((w, i) => {
      const c = rs.map((r) => r.coin[i]);
      const exp = mean(
        rs.map((r) => mean(base[r.side].map((x) => x[i].close ?? NaN))),
      ); // baseline for the same sides
      console.log(
        `   ${name.padEnd(16)} ${String(rs.length).padStart(2)} sig · ${String(w).padStart(2)}h  coin best ${sp(mean(c.map((x) => x.best)))} worst ${sp(mean(c.map((x) => x.worst)))} close ${sp(mean(c.map((x) => x.close ?? NaN)))} | close > 0 in ${c.filter((x) => (x.close ?? 0) > 0).length}/${rs.length} | baseline close ${sp(exp)}`,
      );
    });
  };
  console.log(
    `SUMMARY -- averages, % in the trade's direction (baseline = same coin choice from every 15m close, same sides):`,
  );
  line("ALL", rows);
  line(
    "BIG episodes",
    rows.filter((r) => r.big),
  );
  line(
    "small episodes",
    rows.filter((r) => !r.big),
  );
  WINDOWS.forEach((w, i) =>
    console.log(
      `   baseline ${w}h: LONG close ${sp(mean(base.LONG.map((x) => x[i].close ?? NaN)))} (${base.LONG.length}) · SHORT close ${sp(mean(base.SHORT.map((x) => x[i].close ?? NaN)))} (${base.SHORT.length})`,
    ),
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
