/**
 * BTC LEADS -> trade the coin that follows it (Johnny, Oct 1 2026). Read-only, straight from Binance (1h + 15m + 5m
 * candles, 5-minute OI), times UTC, LIVE-SAFE, no %. Rules: src/research/btc-lead.ts
 *   - start: a closed 1h BTC candle with OI up and the price moving; then every next hour is watched as four 15m candles
 *   - signal: a 15m OI fall bigger (in BTC) than the biggest 15m OI rise of the episode so far (BTC UP -> SHORT, DOWN -> LONG)
 *   - no signal in an hour: it goes on while the hour still has OI up + price the episode's way, else it is over
 *   - the coin whose 5m moves BTC explained best in the --hours before the signal
 *   - no SL / TP: how far the coin and BTC went our way (best) / against us (worst) in the next 1h / 4h
 *
 *   npx tsx src/tools/btc-lead.ts --days 7
 *   options: --hours 4 (window to pick the coin)  --coins DOGE,SOL,...  --top 3 (coins shown per signal)
 */
import "dotenv/config";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";
import {
  afterOf,
  leadSignals,
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
    `\nBTC leads · last ${days} days · ${sigs.length} BTC signals · coin = best BTC follower in the ${pickH}h before · after the signal: best (our way) / worst (against) / close, in % · UTC\n`,
  );
  const rows: Array<{ coin: After[]; btc: After[] }> = [];
  for (const s of sigs) {
    const rank = rankCoins(btc5, bars, s.ts, pickH);
    console.log(
      `${t(s.ts)}  BTC ${s.dir === "UP" ? "▲" : "▼"} since ${t(s.moveStart)} (${s.moveHours.toFixed(1)}h): price ${sp(s.pricePct)}, OI ${sp(s.oiPct)} · OI built ${Math.round(s.built).toLocaleString("en-US")} BTC, this 15m OI fell ${Math.round(s.fall).toLocaleString("en-US")} > biggest 15m rise ${Math.round(s.maxRise).toLocaleString("en-US")} -> ${s.side}`,
    );
    console.log(
      `      followers (R2 / x BTC): ${
        rank
          .slice(0, top)
          .map(
            (r) =>
              `${r.symbol.replace(/USDT$/, "")} ${r.r2.toFixed(2)} / x${r.beta.toFixed(2)}`,
          )
          .join(" · ") || "none"
      }`,
    );
    const pick = rank[0],
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
    if (a && b) rows.push({ coin: a.after, btc: b.after });
    console.log("");
  }
  if (!rows.length) return;
  const avg = (v: number[]): string => {
    const f = v.filter(Number.isFinite);
    return f.length ? sp(f.reduce((x, y) => x + y, 0) / f.length) : "  n/a";
  };
  console.log(
    `SUMMARY (${rows.length} signals) -- averages, % in the trade's direction:`,
  );
  WINDOWS.forEach((w, i) => {
    const c = rows.map((r) => r.coin[i]),
      b = rows.map((r) => r.btc[i]);
    console.log(
      `   ${String(w).padStart(2)}h  coin best ${avg(c.map((x) => x.best))} worst ${avg(c.map((x) => x.worst))} close ${avg(c.map((x) => x.close ?? NaN))}   |   BTC best ${avg(b.map((x) => x.best))} worst ${avg(b.map((x) => x.worst))} close ${avg(b.map((x) => x.close ?? NaN))}   |   coin went further our way than BTC: ${rows.filter((r) => r.coin[i].best > r.btc[i].best).length}/${rows.length}`,
    );
  });
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
