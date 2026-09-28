/**
 * CROWD STOP HITS backtest (Johnny, Sep 29 2026) -- see src/research/crowd-stop-hits.ts. Read-only.
 * Our data (minute_bars: OI + liquidations) finds the cleanings and whether the crowd really opened
 * positions; Binance candles (15m UTC for the crowd strategies, 1m for the trade path). All times UTC ms.
 *
 *   npx tsx src/tools/crowd-stop-hits.ts                    (all stored days, 9 coins)
 *   npx tsx src/tools/crowd-stop-hits.ts --days 7 --symbols ADA,ETH --list
 *   npx tsx src/tools/crowd-stop-hits.ts --any-oi           (crowd entries even without OI growth)
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import {
  KINDS,
  runHits,
  type C,
  type Flow,
  type HitTrade,
} from "../research/crowd-stop-hits";

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
const DAYS = Number(arg("days", "30")),
  RR = Number(arg("rr", "2.2")),
  LIST = argv.includes("--list"),
  ANY_OI = argv.includes("--any-oi");
const DAY = 86_400_000,
  Q = 15 * 60_000;
const time = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const fp = (v: number): string =>
  !Number.isFinite(v)
    ? "n/a"
    : v >= 1000
      ? v.toFixed(1)
      : v >= 1
        ? v.toFixed(4)
        : v.toFixed(5);
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 15_000,
});

async function klines(
  symbol: string,
  interval: string,
  from: number,
  to: number,
): Promise<C[]> {
  const out: C[] = [];
  for (let start = from, guard = 0; guard < 300 && start < to; guard++) {
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
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const now = Date.now();
  const all: Array<HitTrade & { symbol: string }> = [];
  let spanFrom = Infinity;
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const s of symbols) {
      const raw = await db
        .collection("minute_bars")
        .find({ symbol: s, ts: { $gte: new Date(now - DAYS * DAY) } })
        .project({ ts: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 })
        .sort({ ts: 1 })
        .toArray();
      if (raw.length < 600) {
        process.stderr.write(`${s}: not enough stored minutes\n`);
        continue;
      }
      const first = Math.ceil(time(raw[0].ts) / Q) * Q;
      spanFrom = Math.min(spanFrom, first);
      process.stderr.write(`${s}: our data from ${utc(first)} UTC ...\n`);
      // our OI + liquidations per 15m UTC slot
      const flowBySlot = new Map<number, Flow>();
      for (const r of raw) {
        const slot = Math.floor(time(r.ts) / Q) * Q,
          oi = Number(r.oiLast ?? 0);
        let f = flowBySlot.get(slot);
        if (!f) {
          f = { oiStart: NaN, oiEnd: NaN, liqLong: 0, liqShort: 0 };
          flowBySlot.set(slot, f);
        }
        if (oi > 0) {
          if (!Number.isFinite(f.oiStart)) f.oiStart = oi;
          f.oiEnd = oi;
        }
        f.liqLong += Number(r.longLiqUsd ?? 0);
        f.liqShort += Number(r.shortLiqUsd ?? 0);
      }
      // candles: 1 day earlier for the indicators; only finished ones
      const c15 = (await klines(s, "15m", first - DAY, now)).filter(
        (k) => k.ts + Q <= now,
      );
      const m1 = (await klines(s, "1m", first, now)).filter(
        (k) => k.ts + 60_000 <= now,
      );
      const flow = c15.map((k) => flowBySlot.get(k.ts));
      all.push(
        ...runHits(c15, m1, flow, RR, !ANY_OI).map((t) => ({
          ...t,
          symbol: s,
        })),
      );
    }
  } finally {
    await client.close();
  }
  const days = (now - spanFrom) / DAY;
  console.log(
    `\n=== CROWD STOP HITS  ${utc(spanFrom)} UTC -> now (${days.toFixed(1)} days, ${symbols.length} coins, RR ${RR}, net of fees) ===`,
  );
  console.log(
    `crowd entries: 15m candles${ANY_OI ? "" : " where our OI grew"}; cleaning = our OI fell >= 2x normal + liquidations >= 2x normal (15m)\n`,
  );
  console.log(
    "variant     cleaning hit crowd stops?   trades  TP  SL  open  win    netR     avg",
  );
  const line = (v: HitTrade["variant"], hit: boolean | null): void => {
    const a = all.filter(
      (t) => t.variant === v && (hit === null || t.hit === hit),
    );
    const closed = a.filter((t) => t.result !== "OPEN"),
      tp = closed.filter((t) => t.result === "TP").length,
      net = closed.reduce((x, t) => x + t.netR, 0);
    console.log(
      `${v.padEnd(11)} ${(hit === null ? "all" : hit ? "YES (crowd stops hit)" : "no").padEnd(27)} ${String(closed.length).padStart(5)} ${String(tp).padStart(3)} ${String(closed.length - tp).padStart(3)} ${String(a.length - closed.length).padStart(5)}  ${closed.length ? `${Math.round((100 * tp) / closed.length)}%`.padStart(4) : " n/a"}  ${sR(net).padStart(8)}  ${closed.length ? sR(net / closed.length) : "n/a"}`,
    );
  };
  for (const v of ["WITH_MOVE", "REVERSAL"] as const) {
    line(v, true);
    line(v, false);
    line(v, null);
    console.log("");
  }
  console.log(
    "WITH_MOVE = Johnny's idea: the crowd got stopped -> go the way of the flush. REVERSAL = the control (fade the flush, like V9).",
  );
  console.log(
    "\nWITH_MOVE when crowd stops were hit, by whose stops (a cleaning can hit several):",
  );
  for (const k of KINDS) {
    const a = all.filter(
        (t) =>
          t.variant === "WITH_MOVE" &&
          t.kinds.includes(k) &&
          t.result !== "OPEN",
      ),
      tp = a.filter((t) => t.result === "TP").length,
      net = a.reduce((x, t) => x + t.netR, 0);
    if (a.length)
      console.log(
        `  ${k.padEnd(9)} ${String(a.length).padStart(4)} trades  win ${Math.round((100 * tp) / a.length)}%  ${sR(net).padStart(8)}`,
      );
  }
  if (LIST) {
    console.log(
      "\nCLEANING (UTC)  COIN  variant    side  crowd stops hit (whose)          entry        SL           result",
    );
    for (const t of [...all].sort((a, b) => a.cleaningTs - b.cleaningTs))
      console.log(
        `${utc(t.cleaningTs)}     ${t.symbol.replace("USDT", "").padEnd(5)} ${t.variant.padEnd(10)} ${t.side === "LONG" ? "BUY " : "SELL"}  ${(t.hit ? `${t.stopsHit} (${t.kinds.join("+")})` : "none").padEnd(32)} ${fp(t.entry).padEnd(12)} ${fp(t.sl).padEnd(12)} ${t.result}${t.result === "OPEN" ? "" : ` ${sR(t.netR)}`}`,
      );
  }
  console.log(
    "\n(our OI/liquidation data covers only a few days -- a direction to watch, not a proof)",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
