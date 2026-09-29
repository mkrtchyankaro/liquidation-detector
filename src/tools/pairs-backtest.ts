/**
 * PAIR TRADING backtest + "now" scan on Binance 1m candles (Johnny, Sep 29 2026). Read-only, public klines only.
 * Rules: src/research/pairs.ts (BTC removed from every coin, 120-minute window, Z-score of the residual spread).
 *
 *   npx tsx src/tools/pairs-backtest.ts                       (last 1 month, all pairs, summary + when)
 *   npx tsx src/tools/pairs-backtest.ts --months 3
 *   npx tsx src/tools/pairs-backtest.ts --months 1 --list     (every trade with its time, to check on the chart)
 *   npx tsx src/tools/pairs-backtest.ts --now                 (only the last day: which pairs are stretched NOW)
 *   npx tsx src/tools/pairs-backtest.ts --tf 1h --months 6    (the same rules on 1h candles: window 120h = 5 days, hold <= 240h)
 */
import "dotenv/config";
import axios from "axios";
import { DEFAULT_PAIRS, runPairs, type PairTrade } from "../research/pairs";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const COINS = arg("coins", "BTC,ETH,SOL,XRP,BNB,DOGE,ADA,LINK,AVAX,SUI")
  .split(",")
  .map((s) => s.trim().toUpperCase());
const NOW_MODE = argv.includes("--now"),
  LIST = argv.includes("--list");
const months = NOW_MODE ? 1 / 30 : Number(arg("months", "1"));
const DAY = 86_400_000;
const TF = arg("tf", "1m");
const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
};
if (!TF_MS[TF])
  throw new Error(`--tf must be one of ${Object.keys(TF_MS).join(", ")}`);
const M = TF_MS[TF]; // one bar
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const yvn = (ms: number): string =>
  new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const utc = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const hold = (bars: number): string => {
  const m = (bars * M) / 60_000;
  return m >= 1440
    ? `${(m / 1440).toFixed(1)} days`
    : m >= 60
      ? `${(m / 60).toFixed(1)} h`
      : `${Math.round(m)} min`;
};
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fp = (v: number): string =>
  v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toFixed(5);

async function closes(
  symbol: string,
  from: number,
  to: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let start = from, guard = 0; guard < 2000 && start < to; guard++) {
    const res = await http.get<Array<[number, string, string, string, string]>>(
      "/fapi/v1/klines",
      {
        params: {
          symbol,
          interval: TF,
          startTime: start,
          endTime: to,
          limit: 1500,
        },
      },
    );
    if (!res.data.length) break;
    for (const k of res.data) out.set(k[0], Number(k[4]));
    const next = res.data[res.data.length - 1][0] + 1;
    if (next <= start) break;
    start = next;
    await new Promise((r) => setTimeout(r, 100));
  }
  return out;
}

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / M) * M; // the current (unfinished) bar is left out
  const tradeFrom = now - months * 30 * DAY;
  const from = tradeFrom - 3 * DEFAULT_PAIRS.window * M; // warm-up for the windows (beta, spread, its mean)
  const data: Record<string, Map<number, number>> = {};
  for (const c of COINS) {
    process.stderr.write(`${c} ...\n`);
    data[c] = await closes(`${c}USDT`, from, now - 1);
  }
  // common minutes; a missing minute takes the last close (rare gaps)
  const ts: number[] = [];
  for (let t = from; t < now; t += M) ts.push(t);
  const px: Record<string, number[]> = {};
  for (const c of COINS) {
    let last = NaN;
    px[c] = ts.map((t) => {
      const v = data[c].get(t);
      if (v !== undefined) last = v;
      return last;
    });
  }
  const first = ts.findIndex((_, i) =>
    COINS.every((c) => Number.isFinite(px[c][i])),
  );
  const T = ts.slice(first),
    P: Record<string, number[]> = {};
  for (const c of COINS) P[c] = px[c].slice(first);
  const { trades, now: state } = runPairs(T, P, "BTC", tradeFrom);

  if (NOW_MODE) {
    console.log(
      `\n=== PAIRS NOW  ${yvn(now)} Yerevan (${utc(now)} UTC) -- residual spreads (BTC removed), last ${DEFAULT_PAIRS.window} x ${TF} ===`,
    );
    console.log("pair           Z      corr   ");
    for (const p of [...state]
      .sort((x, y) => Math.abs(y.z) - Math.abs(x.z))
      .slice(0, 15))
      console.log(
        `${`${p.a}/${p.b}`.padEnd(12)} ${(p.z >= 0 ? "+" : "") + p.z.toFixed(2)}  ${p.corr.toFixed(2)}   ${p.hint}`,
      );
    const open = trades.filter((t) => t.exit === "OPEN");
    console.log(
      open.length
        ? `\nopen by the rules right now: ${open.map((t) => `SHORT ${t.shortLeg} / LONG ${t.longLeg} since ${yvn(t.entryTs)}`).join(" | ")}`
        : "\nno open pair trade by the rules right now",
    );
    console.log(
      "\n|Z| >= 2 with corr >= 0.80 = stretched; the rules enter only when |Z| starts coming back.",
    );
    return;
  }

  const done = trades.filter((t) => t.exit !== "OPEN");
  const days = (now - tradeFrom) / DAY;
  const sum = (a: readonly PairTrade[], f: (t: PairTrade) => number): number =>
    a.reduce((x, t) => x + f(t), 0);
  console.log(
    `\n=== PAIR TRADING ${TF}  ${yvn(tradeFrom)} -> ${yvn(now)} Yerevan (${days.toFixed(0)} days, ${COINS.length - 1} coins vs BTC, ${((COINS.length - 1) * (COINS.length - 2)) / 2} pairs) ===`,
  );
  console.log(
    `window ${DEFAULT_PAIRS.window} x ${TF}, corr >= ${DEFAULT_PAIRS.corrMin}, in |Z| >= ${DEFAULT_PAIRS.zIn} (turning), out |Z| <= ${DEFAULT_PAIRS.zOut}, stop |Z| >= ${DEFAULT_PAIRS.zStop} / corr < ${DEFAULT_PAIRS.corrBreak} / ${DEFAULT_PAIRS.maxHold} bars; fees 4 x 0.05%\n`,
  );
  const win = done.filter((t) => t.netPct > 0).length;
  console.log(
    `trades ${done.length} (${(done.length / days).toFixed(1)}/day), open ${trades.length - done.length}`,
  );
  console.log(
    `winners after fees ${win} (${done.length ? Math.round((100 * win) / done.length) : 0}%), winners before fees ${done.filter((t) => t.grossPct > 0).length}`,
  );
  console.log(
    `sum BEFORE fees ${sp(sum(done, (t) => t.grossPct))}   AFTER fees ${sp(sum(done, (t) => t.netPct))}   (per trade: ${done.length ? sp(sum(done, (t) => t.grossPct) / done.length) : "n/a"} before, ${done.length ? sp(sum(done, (t) => t.netPct) / done.length) : "n/a"} after)`,
  );
  console.log(
    `= with $1000 per leg: ${done.length ? `$${(sum(done, (t) => t.netPct) * 10).toFixed(0)}` : "n/a"} after fees over ${days.toFixed(0)} days`,
  );
  console.log("\nby exit:");
  for (const e of ["TP", "STOP", "BROKEN", "TIME"] as const) {
    const a = done.filter((t) => t.exit === e);
    if (a.length)
      console.log(
        `  ${e.padEnd(7)} ${String(a.length).padStart(5)}  avg ${sp(sum(a, (t) => t.netPct) / a.length)} after fees, ${sp(sum(a, (t) => t.grossPct) / a.length)} before, held avg ${hold(sum(a, (t) => t.minutes) / a.length)}`,
      );
  }
  console.log("\nbest / worst pairs (after fees):");
  const byPair = new Map<string, PairTrade[]>();
  for (const t of done) {
    const k = `${t.a}/${t.b}`;
    byPair.set(k, [...(byPair.get(k) ?? []), t]);
  }
  const ranked = [...byPair.entries()]
    .map(([k, a]) => ({ k, n: a.length, net: sum(a, (t) => t.netPct) }))
    .sort((x, y) => y.net - x.net);
  for (const r of [
    ...ranked.slice(0, 5),
    ...(ranked.length > 10 ? [{ k: "...", n: 0, net: NaN }] : []),
    ...ranked.slice(-5),
  ])
    console.log(
      r.k === "..."
        ? "  ..."
        : `  ${r.k.padEnd(11)} ${String(r.n).padStart(4)} trades  ${sp(r.net)}`,
    );
  console.log("\nwhen (hour of entry, Yerevan time): trades / after fees");
  const line: string[] = [];
  for (let h = 0; h < 24; h++) {
    const a = done.filter(
      (t) => new Date(t.entryTs + 4 * 3_600_000).getUTCHours() === h,
    );
    line.push(
      `${String(h).padStart(2, "0")}h ${String(a.length).padStart(3)} ${sp(sum(a, (t) => t.netPct)).padStart(8)}`,
    );
  }
  for (let r = 0; r < 6; r++)
    console.log("  " + line.slice(r * 4, r * 4 + 4).join("   "));
  if (LIST) {
    console.log(
      "\nENTRY (Yerevan)  EXIT        held  SHORT        LONG         Z in   Z out  corr  exit     before   after",
    );
    for (const t of [...trades].sort((a, b) => a.entryTs - b.entryTs)) {
      const sa =
          t.shortLeg === t.a ? `${t.a} ${fp(t.pa0)}` : `${t.b} ${fp(t.pb0)}`,
        lb = t.longLeg === t.a ? `${t.a} ${fp(t.pa0)}` : `${t.b} ${fp(t.pb0)}`;
      console.log(
        `${yvn(t.entryTs)}      ${yvn(t.exitTs).slice(6)}  ${hold(t.minutes).padStart(9)}  ${sa.padEnd(12)} ${lb.padEnd(12)} ${(t.zIn >= 0 ? "+" : "") + t.zIn.toFixed(2)}  ${Number.isFinite(t.zOut) ? (t.zOut >= 0 ? "+" : "") + t.zOut.toFixed(2) : "  -  "}  ${t.corr.toFixed(2)}  ${t.exit.padEnd(7)} ${sp(t.grossPct).padStart(7)}  ${sp(t.netPct).padStart(7)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
