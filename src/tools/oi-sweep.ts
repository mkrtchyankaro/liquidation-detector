/**
 * OI move -> first OI-drop 1h candle -> SWEEP signal. Read-only research on Binance history, times UTC.
 *
 *   npx tsx src/tools/oi-sweep.ts --days 30
 *   npx tsx src/tools/oi-sweep.ts --coins ETH,SOL --days 7 --tp 1 --sl 1 --max 2
 *
 * Rules: src/research/oi-sweep.ts (moves: src/research/oi-moves.ts). Defaults: the bot's 9 coins, TP +1%, SL -1%,
 * at most 2 trades open at the same time across all coins. Fees 0.1% per trade (in + out) are taken off.
 */
import "dotenv/config";
import * as fs from "fs";
import type { MvHour } from "../research/oi-moves";
import type { Minute } from "../research/oi-reversal";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";
import {
  portfolio,
  sweepSignals,
  tradeOf,
  type SweepSignal,
  type SweepTrade,
} from "../research/oi-sweep";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DAYS = Number(arg("days", "7")),
  TP = Number(arg("tp", "1")),
  SL = Number(arg("sl", "1")),
  MAX = Number(arg("max", "2")),
  FEE = 0.1;
const H = 3_600_000,
  D = 24 * H;
const t = (ms: number | null): string =>
  ms === null
    ? "      -     "
    : new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const px = (x: number): string =>
  x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toFixed(6);
const pad = (s: string, n: number): string => s.padEnd(n);

function coins(): string[] {
  const s = arg("coins", "");
  if (s)
    return s
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
      .map((x) => (x.endsWith("USDT") ? x : `${x}USDT`));
  try {
    const c = JSON.parse(
      fs.readFileSync(process.env.USERS_CONFIG ?? "users.config.json", "utf8"),
    ) as { v9?: { symbols?: string[] } };
    if (c.v9?.symbols?.length) return c.v9.symbols;
  } catch {
    /* default */
  }
  return [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "LINKUSDT",
    "AVAXUSDT",
    "SUIUSDT",
  ];
}

function report(name: string, trades: SweepTrade[]): void {
  const taken = trades.filter((x) => x.taken),
    closed = taken.filter((x) => x.result !== "OPEN");
  const tp = closed.filter((x) => x.result === "TP").length,
    sl = closed.length - tp;
  const gross = closed.reduce((a, x) => a + x.pnlPct, 0),
    net = gross - FEE * closed.length;
  console.log(`\n=== ${name} ===`);
  console.log(
    "ENTRY UTC     COIN   MOVE (since, hours)       1H CANDLE    SWEEP    SIDE   ENTRY        TP           SL           RESULT  EXIT UTC      ",
  );
  for (const x of trades) {
    console.log(
      `${t(x.entryTs)}  ${pad(x.symbol.replace("USDT", ""), 5)}  ${pad(`${x.dir === "UP" ? "▲" : "▼"} ${t(x.moveStart)} ${x.moveHours}h`, 24)}  ${t(x.candle.t)}  ${pad(x.sweep, 7)}  ${pad(x.side, 5)}  ${pad(px(x.entry), 11)}  ${pad(px(x.tp), 11)}  ${pad(px(x.sl), 11)}  ` +
        (x.taken
          ? `${pad(x.result, 6)}  ${t(x.exitTs)}`
          : `skipped (${MAX} trades already open)`),
    );
  }
  const winRate = closed.length ? (100 * tp) / closed.length : 0;
  console.log(
    `\nsignals ${trades.length} | taken ${taken.length}, skipped ${trades.length - taken.length} | closed ${closed.length}: TP ${tp}, SL ${sl} (${winRate.toFixed(0)}% TP; break-even needs ${((100 * (SL + FEE)) / (TP + SL)).toFixed(0)}% with fees) | still open ${taken.length - closed.length}`,
  );
  console.log(
    `result: ${gross >= 0 ? "+" : ""}${gross.toFixed(1)}% gross, ${net >= 0 ? "+" : ""}${net.toFixed(1)}% after fees  (each trade risks ${SL}% of its size; at 1 R = ${SL}%: ${(net / SL).toFixed(1)}R)`,
  );
  for (const side of ["LONG", "SHORT"] as const) {
    const v = closed.filter((x) => x.side === side),
      w = v.filter((x) => x.result === "TP").length;
    if (v.length)
      console.log(
        `   ${side}: ${v.length} closed, TP ${w}, SL ${v.length - w}, ${(v.reduce((a, x) => a + x.pnlPct, 0) - FEE * v.length).toFixed(1)}% after fees`,
      );
  }
}

async function main(): Promise<void> {
  const to = Math.floor(Date.now() / H) * H,
    winFrom = to - DAYS * D,
    from = Math.floor((winFrom - 2 * D) / D) * D;
  const sigs: SweepSignal[] = [],
    paths = new Map<string, Minute[]>();
  for (const s of coins()) {
    try {
      const snap = await oiSnapshots(s, from, to);
      const h: MvHour[] = (await klines(s, "1h", from, to)).map((c) => ({
        ...c,
        oi: oiAt(snap, c.t + H),
        oiOpen: oiAt(snap, c.t),
      }));
      paths.set(
        s,
        (await klines(s, "1m", from, to)).map((c) => ({
          t: c.t,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      const v = sweepSignals(s, h).filter((x) => x.entryTs > winFrom);
      sigs.push(...v);
      process.stderr.write(`${s}: ${v.length} sweep signals\n`);
    } catch (err) {
      console.log(
        `${s}: FAILED -- ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(
    `\nOI MOVE -> FIRST OI-DROP 1H CANDLE -> SWEEP | ${t(winFrom)} .. ${t(to)} UTC (${DAYS} days) | TP +${TP}%  SL -${SL}% | max ${MAX} open at once`,
  );
  const sweepSide = sigs.map((x) =>
    tradeOf(
      x,
      x.sweep === "TOP" ? "SHORT" : "LONG",
      paths.get(x.symbol)!,
      TP,
      SL,
    ),
  );
  const allLong = sigs.map((x) =>
    tradeOf(x, "LONG", paths.get(x.symbol)!, TP, SL),
  );
  report(
    "A. SWEEP READING: top sweep -> SHORT, bottom sweep -> LONG",
    portfolio(sweepSide, MAX),
  );
  report("B. ALWAYS LONG (as first written)", portfolio(allLong, MAX));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
