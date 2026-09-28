/**
 * CROWD STOP-POOL BACKTEST on Binance 1h candles (Johnny, Sep 28 2026). Read-only; public klines, no DB.
 * Where do the popular retail strategies park their stops, and does trading AGAINST the crowd work?
 * Rules: src/research/crowd-traps.ts. Each "our" variant has its crowd control next to it:
 *   MAGNET vs ANTI_MAGNET, SWEEP_REV vs CROWD_BREAK, PDH_TRAP vs CROWD_PDH, and CROWD_PATTERN.
 *
 *   npx tsx src/tools/crowd-backtest.ts                       (6 months, 9 coins, RR 2.2)
 *   npx tsx src/tools/crowd-backtest.ts --months 1 --rr 2.2 --symbols ADA,ETH
 */
import "dotenv/config";
import axios from "axios";
import {
  cstats,
  DEFAULT_C,
  poolsAt,
  runCoin,
  SOURCES,
  VARIANTS,
  type Candle,
  type CTrade,
} from "../research/crowd-traps";

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
const months = Number(arg("months", "6"));
const RR = Number(arg("rr", "2.2"));
const DAY = 86_400_000;
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 15_000,
});
const yerevan = (ms: number): string =>
  new Date(ms + 4 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
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
  const settings = { ...DEFAULT_C, rr: RR };
  const all: Array<CTrade & { symbol: string }> = [];
  for (const s of symbols) {
    process.stderr.write(`${s} ...\n`);
    const h = (await klines(s, "1h", tradeFrom - 5 * DAY, now)).filter(
      (c) => c.ts + 3_600_000 <= now,
    );
    if (h.length < 200) {
      process.stderr.write(`${s}: not enough candles\n`);
      continue;
    }
    const cache = h.map((_, i) =>
      h[i].ts >= tradeFrom - 3_600_000 ? poolsAt(h, i) : undefined,
    );
    for (const v of VARIANTS)
      all.push(
        ...runCoin(h, v, tradeFrom, settings, cache).map((t) => ({
          ...t,
          symbol: s,
        })),
      );
  }
  const days = (now - tradeFrom) / DAY;
  console.log(
    `\n=== CROWD STOP POOLS  ${yerevan(tradeFrom)} -> now (${days.toFixed(0)} days, ${symbols.length} coins, 1h candles, RR ${RR}, net of fees) ===`,
  );
  console.log(
    "pools = where the crowd's stops sit: previous day high/low, swing highs/lows, equal highs/lows, candle-pattern extremes, round numbers\n",
  );
  console.log(
    "variant          trades   TP    SL  win    netR      avg/trade  per day   worst SL run  max drawdown",
  );
  const row = (name: string, t: readonly CTrade[]): void => {
    const st = cstats(t);
    console.log(
      `${name.padEnd(16)} ${String(st.n).padStart(6)} ${String(st.tp).padStart(4)} ${String(st.sl).padStart(5)}  ${st.n ? `${Math.round((100 * st.tp) / st.n)}%`.padStart(4) : " n/a"}  ${sR(st.netR).padStart(9)}  ${st.n ? sR(st.netR / st.n).padStart(8) : "     n/a"}  ${sR(st.netR / days).padStart(7)}   ${String(st.worst).padStart(6)}        ${st.dd.toFixed(1)}R`,
    );
  };
  const pairs: Array<[string, string]> = [
    ["MAGNET", "ANTI_MAGNET"],
    ["SWEEP_REV", "CROWD_BREAK"],
    ["PDH_TRAP", "CROWD_PDH"],
    ["CROWD_PATTERN", ""],
  ];
  for (const [ours, crowd] of pairs) {
    row(
      ours,
      all.filter((t) => t.v === ours),
    );
    if (crowd)
      row(
        `  vs ${crowd}`,
        all.filter((t) => t.v === crowd),
      );
  }
  const be = 1 / (1 + RR);
  console.log(
    `\n(break-even win rate at RR ${RR}: ~${Math.round(100 * be) + 2}% with fees; MAGNET: TP = the pool itself, SL = that distance / RR)`,
  );

  console.log(
    "\nSWEEP_REV by whose stops were swept (a pool can have several sources):",
  );
  for (const src of SOURCES) {
    const t = all.filter((x) => x.v === "SWEEP_REV" && x.sources.includes(src)),
      st = cstats(t);
    if (st.n)
      console.log(
        `  ${src.padEnd(8)} ${String(st.n).padStart(5)} trades  win ${Math.round((100 * st.tp) / st.n)}%  ${sR(st.netR).padStart(9)}  avg ${sR(st.netR / st.n)}`,
      );
  }
  console.log(
    "SWEEP_REV by pool weight (how many strategies' stops were there):",
  );
  for (const w of [1, 2, 3]) {
    const t = all.filter(
        (x) =>
          x.v === "SWEEP_REV" &&
          (w < 3 ? x.sources.length === w : x.sources.length >= 3),
      ),
      st = cstats(t);
    if (st.n)
      console.log(
        `  ${w < 3 ? `${w}` : "3+"} source${w > 1 ? "s" : " "}  ${String(st.n).padStart(5)} trades  win ${Math.round((100 * st.tp) / st.n)}%  ${sR(st.netR).padStart(9)}  avg ${sR(st.netR / st.n)}`,
      );
  }
  console.log("\nper coin (netR):");
  for (const s of symbols) {
    const cells = VARIANTS.map(
      (v) =>
        `${v} ${sR(cstats(all.filter((t) => t.symbol === s && t.v === v)).netR)}`,
    );
    console.log(`  ${s.replace("USDT", "").padEnd(5)} ${cells.join("  ")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
