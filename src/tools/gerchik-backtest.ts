/**
 * GERCHIK-STYLE BACKTEST on Binance candles (Johnny, Sep 28 2026). Read-only; only public klines, no DB.
 * Rules: src/research/gerchik.ts (D1 levels, 1h entries: FALSE_BREAK / REBOUND / BREAKOUT, 70% ATR filter,
 * SL behind the level >= 20% ATR, TP 3R, fees).
 *
 *   npx tsx src/tools/gerchik-backtest.ts                   (last 1 month, 9 coins)
 *   npx tsx src/tools/gerchik-backtest.ts --months 6
 *   npx tsx src/tools/gerchik-backtest.ts --months 1 --symbols ADA,ETH --list
 */
import "dotenv/config";
import axios from "axios";
import {
  backtestCoin,
  DEFAULT_G,
  KINDS,
  stats,
  type Candle,
  type GTrade,
  type Kind,
} from "../research/gerchik";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DEFAULT_SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "BNB",
  "DOGE",
  "ADA",
  "LINK",
  "AVAX",
  "SUI",
];
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(","))
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
const months = Number(arg("months", "1"));
const LIST = argv.includes("--list");
const DAY = 86_400_000;
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 15_000,
});
const yerevan = (ms: number): string =>
  new Date(ms + 4 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
const fp = (v: number): string =>
  v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toFixed(5);
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

async function klines(
  symbol: string,
  interval: string,
  from: number,
  to: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let start = from, guard = 0; guard < 500 && start < to; guard++) {
    const res = await http.get<Array<[number, string, string, string, string]>>(
      "/fapi/v1/klines",
      {
        params: {
          symbol,
          interval,
          startTime: start,
          endTime: to,
          limit: 1500,
        },
      },
    );
    if (!res.data.length) break;
    for (const k of res.data)
      out.push({
        ts: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      });
    const next = res.data[res.data.length - 1][0] + 1;
    if (next <= start) break;
    start = next;
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

async function main(): Promise<void> {
  const now = Date.now();
  const tradeFrom = Math.floor((now - months * 30 * DAY) / DAY) * DAY;
  const all: Array<GTrade & { symbol: string }> = [];
  const skips = { next: 0, atr: 0 };
  for (const s of symbols) {
    process.stderr.write(`${s} ...\n`);
    const d1 = await klines(
      s,
      "1d",
      tradeFrom - (DEFAULT_G.lookbackDays + 30) * DAY,
      now,
    );
    const h1 = (await klines(s, "1h", tradeFrom - DAY, now)).filter(
      (c) => c.ts + 3_600_000 <= now,
    ); // finished hours only
    if (d1.length < 40 || h1.length < 48) {
      process.stderr.write(`${s}: not enough candles\n`);
      continue;
    }
    for (const k of KINDS) {
      const r = backtestCoin(d1, h1, k, tradeFrom);
      all.push(...r.trades.map((t) => ({ ...t, symbol: s })));
      skips.next += r.skippedNextLevel;
      skips.atr += r.skippedAtr;
    }
  }
  const days = (now - tradeFrom) / DAY;
  console.log(
    `\n=== GERCHIK-STYLE BACKTEST  ${yerevan(tradeFrom)} -> now (${days.toFixed(0)} days, ${symbols.length} coins) ===`,
  );
  console.log(
    "D1 levels (turning points, >= 2 touches or mirror), 1h entries, no entry after 70% of the daily ATR, SL behind the level >= 20% ATR, TP 3R, net of fees\n",
  );
  console.log(
    "entry kind     trades  TP   SL  open  win    netR     avg/trade  per day   worst SL run  max drawdown",
  );
  const row = (name: string, t: readonly GTrade[]): void => {
    const st = stats(t);
    console.log(
      `${name.padEnd(14)} ${String(st.n).padStart(5)}  ${String(st.tp).padStart(3)}  ${String(st.sl).padStart(3)}  ${String(st.open).padStart(4)}  ${st.n ? `${Math.round((100 * st.tp) / st.n)}%`.padStart(4) : " n/a"}  ${sR(st.netR).padStart(8)}  ${st.n ? sR(st.netR / st.n).padStart(8) : "     n/a"}  ${sR(st.netR / days).padStart(7)}   ${String(st.worstStreak).padStart(6)}        ${st.maxDdR.toFixed(1)}R`,
    );
  };
  for (const k of KINDS)
    row(
      k,
      all.filter((t) => t.kind === k),
    );
  console.log(
    `\n(skipped: ${skips.atr} signals after 70% of the daily ATR, ${skips.next} with another level before the 3R target)`,
  );
  console.log("\nper coin (all three kinds):");
  for (const s of symbols) {
    const t = all.filter((x) => x.symbol === s),
      st = stats(t);
    if (!t.length) continue;
    const by = (k: Kind): string =>
      sR(stats(t.filter((x) => x.kind === k)).netR);
    console.log(
      `  ${s.replace("USDT", "").padEnd(5)} ${String(st.n).padStart(3)} trades  FALSE_BREAK ${by("FALSE_BREAK").padStart(8)}  REBOUND ${by("REBOUND").padStart(8)}  BREAKOUT ${by("BREAKOUT").padStart(8)}`,
    );
  }
  if (LIST) {
    for (const k of KINDS) {
      console.log(`\n--- ${k} ---`);
      for (const t of all
        .filter((x) => x.kind === k)
        .sort((a, b) => a.entryTs - b.entryTs)) {
        console.log(
          `  ${yerevan(t.entryTs)}  ${t.symbol.replace("USDT", "").padEnd(5)} ${t.side === "LONG" ? "BUY " : "SELL"}  level ${fp(t.level).padEnd(11)} entry ${fp(t.entry).padEnd(11)} SL ${fp(t.sl).padEnd(11)} TP ${fp(t.tp).padEnd(11)} ${t.result}${t.result === "OPEN" ? "" : ` ${sR(t.netR)}`}`,
        );
      }
    }
  }
  console.log(
    "\nV9 for comparison (main, PAPER, Sep 24-28): 21 trades, +9.08R, ~+2R/day -- but only 4.5 days.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
