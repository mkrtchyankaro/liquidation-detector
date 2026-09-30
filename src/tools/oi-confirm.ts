/**
 * OI move -> first OI-drop 1h candle (skipped, only a warning) -> CONFIRMATION by the next 1h candle(s) -> trade.
 * Read-only research on Binance history, times UTC.
 *
 *   npx tsx src/tools/oi-confirm.ts --days 90
 *   npx tsx src/tools/oi-confirm.ts --coins ETH,SOL --days 30 --tp 1 --sl 1 --max 2
 *
 * Rules: src/research/oi-sweep.ts (confirmSignals). Two readings reported:
 *   1 = the first of the next two 1h candles that shows a direction (LONG: green, closes above the previous close,
 *       higher high; SHORT: red, closes below the previous close, lower low) -> enter at its close
 *   2 = the next candle shows a direction and the one after confirms it -> enter at the second close
 * TP +1%, SL -1% (1-minute candles, SL first), at most 2 trades open at once, fees 0.1% per trade taken off.
 */
import "dotenv/config";
import * as fs from "fs";
import type { MvHour } from "../research/oi-moves";
import type { Minute } from "../research/oi-reversal";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";
import {
  confirmSignals,
  portfolio,
  tradeOf,
  type ConfirmSignal,
  type Exit,
} from "../research/oi-sweep";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DAYS = Number(arg("days", "30")),
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
type Row = ConfirmSignal & Exit & { taken: boolean };

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

function summary(v: Row[]): string {
  const c = v.filter((x) => x.taken && x.result !== "OPEN"),
    w = c.filter((x) => x.result === "TP").length;
  const net = c.reduce((a, x) => a + x.pnlPct, 0) - FEE * c.length;
  return `${c.length} closed, TP ${w} (${c.length ? ((100 * w) / c.length).toFixed(0) : 0}%), SL ${c.length - w}, ${net >= 0 ? "+" : ""}${net.toFixed(1)}% after fees`;
}

function report(name: string, rows: Row[]): void {
  console.log(`\n=== ${name} ===`);
  console.log(
    "ENTRY UTC     COIN   MOVE (since, hours)       OI-DROP 1H   CONFIRM 1H          SIDE   ENTRY        TP           SL           RESULT  EXIT UTC",
  );
  for (const x of rows) {
    console.log(
      `${t(x.entryTs)}  ${pad(x.symbol.replace("USDT", ""), 5)}  ${pad(`${x.dir === "UP" ? "▲" : "▼"} ${t(x.moveStart)} ${x.moveHours}h`, 24)}  ${t(x.drop.t)}  ${pad(x.confirm.map((c) => t(c.t).slice(6)).join(" + "), 18)}  ${pad(x.side, 5)}  ${pad(px(x.entry), 11)}  ${pad(px(x.tp), 11)}  ${pad(px(x.sl), 11)}  ` +
        (x.taken
          ? `${pad(x.result, 6)}  ${t(x.exitTs)}`
          : `skipped (${MAX} trades already open)`),
    );
  }
  const taken = rows.filter((x) => x.taken);
  console.log(
    `\nsignals ${rows.length} | taken ${taken.length}, skipped ${rows.length - taken.length} | ALL: ${summary(rows)}   (break-even needs ${((100 * (SL + FEE)) / (TP + SL)).toFixed(0)}% TP)`,
  );
  for (const side of ["LONG", "SHORT"] as const)
    for (const dir of ["UP", "DOWN"] as const) {
      const v = rows.filter((x) => x.side === side && x.dir === dir);
      if (v.some((x) => x.taken))
        console.log(
          `   ${side} after a price ${dir === "UP" ? "RISE ▲" : "FALL ▼"}: ${summary(v)}`,
        );
    }
}

async function main(): Promise<void> {
  const to = Math.floor(Date.now() / H) * H,
    winFrom = to - DAYS * D,
    from = Math.floor((winFrom - 2 * D) / D) * D;
  const s1: ConfirmSignal[] = [],
    s2: ConfirmSignal[] = [],
    paths = new Map<string, Minute[]>(),
    hoursBy = new Map<string, number[]>();
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
      hoursBy.set(
        s,
        h.filter((c) => c.t + H > winFrom).map((c) => c.t + H),
      );
      const a = confirmSignals(s, h, 1).filter((x) => x.entryTs > winFrom),
        b = confirmSignals(s, h, 2).filter((x) => x.entryTs > winFrom);
      s1.push(...a);
      s2.push(...b);
      process.stderr.write(
        `${s}: ${a.length} signals (1 candle), ${b.length} (2 candles)\n`,
      );
    } catch (err) {
      const msg = `${s}: FAILED -- ${err instanceof Error ? err.message : String(err)}`;
      console.log(msg);
      process.stderr.write(msg + "\n");
    }
  }
  console.log(
    `\nOI MOVE -> OI-DROP 1H CANDLE (skipped) -> CONFIRMATION | ${t(winFrom)} .. ${t(to)} UTC (${DAYS} days) | TP +${TP}%  SL -${SL}% | max ${MAX} open | coins: ${[...paths.keys()].map((x) => x.replace("USDT", "")).join(",")}`,
  );
  report(
    "1. ONE CONFIRMING CANDLE (the first of the next two)",
    portfolio(
      s1.map((x) => tradeOf(x, x.side, paths.get(x.symbol)!, TP, SL)),
      MAX,
    ),
  );
  report(
    "2. TWO CONFIRMING CANDLES IN A ROW",
    portfolio(
      s2.map((x) => tradeOf(x, x.side, paths.get(x.symbol)!, TP, SL)),
      MAX,
    ),
  );

  console.log(
    `\n=== NO SIGNAL: entering at every 1h close on the same coins and days (TP +${TP}% / SL -${SL}%) ===`,
  );
  for (const side of ["LONG", "SHORT"] as const) {
    let n = 0,
      w = 0;
    for (const [s, hs] of hoursBy) {
      const path = paths.get(s)!;
      for (const ts of hs) {
        let lo = 0,
          hi = path.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (path[m].t < ts) lo = m + 1;
          else hi = m;
        }
        if (lo <= 0 || lo >= path.length) continue;
        const r = tradeOf(
          { symbol: s, entryTs: ts, entry: path[lo - 1].close },
          side,
          path,
          TP,
          SL,
        );
        if (r.result === "OPEN") continue;
        n++;
        if (r.result === "TP") w++;
      }
    }
    console.log(
      `   ${side} every hour: ${n} trades, TP ${w} (${n ? ((100 * w) / n).toFixed(0) : 0}%), ${(w * TP - (n - w) * SL - FEE * n).toFixed(0)}% after fees`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
