/**
 * V9 SIGNALS vs THE 4h DIRECTION (Johnny, Sep 29 2026). Read-only.
 * Takes EVERY V9 signal stored in the DB (v9_decisions: SELECTED = opened, SYMBOL_BUSY = a V9 signal on a coin that
 * already had a trade), simulates it with the live rules (entry = first stored price after the decision, SL = the
 * signal's stop, TP = 2.2R, fees) on the stored prices (oi_second_observations), and labels it with the 4h
 * direction AT THAT MOMENT (only closed 4h candles; definitions in src/research/trend4h.ts).
 * Then: are signals WITH the 4h direction better than signals AGAINST it?  No filter is applied anywhere.
 *
 *   npx tsx src/tools/v9-trend4h.ts               (all stored signals, last 14 days)
 *   npx tsx src/tools/v9-trend4h.ts --days 30
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import type { Poll } from "../strategy/v9/v9-replay";
import {
  simulateExit,
  type ExitTrade,
  type Sig,
} from "../research/v9-exit-sim";
import { H4, type Candle4h } from "../research/structure4h";
import {
  DEFINITIONS,
  directionsAt,
  fit,
  type Definition,
  type Dir,
  type Fit,
} from "../research/trend4h";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAYS = Number(arg("days", "14")),
  RR = 2.2,
  DAY = 86_400_000,
  HOLD_MAX = 5 * DAY;
const time = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});

async function klines4h(
  symbol: string,
  from: number,
  to: number,
): Promise<Candle4h[]> {
  const out: Candle4h[] = [];
  for (let start = from, guard = 0; guard < 50 && start < to; guard++) {
    const res = await http.get<Array<[number, string, string, string, string]>>(
      "/fapi/v1/klines",
      {
        params: {
          symbol,
          interval: "4h",
          startTime: start,
          endTime: to,
          limit: 1500,
        },
      },
    );
    if (!res.data.length) break;
    for (const k of res.data)
      out.push({
        openTime: k[0],
        closeTime: k[0] + H4,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      });
    const next = res.data[res.data.length - 1][0] + 1;
    if (next <= start) break;
    start = next;
  }
  const seen = new Set<number>(),
    now = Date.now();
  return out
    .filter(
      (k) =>
        k.closeTime <= now && !seen.has(k.openTime) && seen.add(k.openTime),
    )
    .sort((a, b) => a.openTime - b.openTime);
}

interface Row {
  symbol: string;
  sig: Sig;
  reason: string;
  t: ExitTrade;
  k: Candle4h | null;
  dir: Record<Definition, Dir | null>;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const rows: Row[] = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const decs = await db
      .collection("v9_decisions")
      .find({
        reason: { $in: ["SELECTED", "SYMBOL_BUSY"] },
        stopPrice: { $gt: 0 },
        evaluatedAt: { $gte: Date.now() - DAYS * DAY },
      })
      .project({
        signalId: 1,
        symbol: 1,
        victim: 1,
        reason: 1,
        evaluatedAt: 1,
        stopPrice: 1,
      })
      .sort({ evaluatedAt: 1 })
      .toArray();
    const seen = new Set<string>();
    const sigs = decs.filter(
      (d) => !seen.has(String(d.signalId)) && seen.add(String(d.signalId)),
    );
    process.stderr.write(
      `${sigs.length} V9 signals (SELECTED + SYMBOL_BUSY) in the last ${DAYS} days\n`,
    );
    const bySymbol = new Map<string, typeof sigs>();
    for (const d of sigs)
      bySymbol.set(String(d.symbol), [
        ...(bySymbol.get(String(d.symbol)) ?? []),
        d,
      ]);
    for (const [symbol, list] of bySymbol) {
      const first = time(list[0].evaluatedAt);
      const candles = await klines4h(
        symbol,
        Math.floor((first - 60 * DAY) / H4) * H4,
        Date.now(),
      );
      process.stderr.write(
        `${symbol}: ${list.length} signals, ${candles.length} 4h candles\n`,
      );
      for (const d of list) {
        const sig: Sig = {
          id: String(d.signalId),
          side: d.victim === "LONG" ? "LONG" : "SHORT",
          stop: Number(d.stopPrice),
          evaluatedAt: time(d.evaluatedAt),
        };
        const polls: Poll[] = (
          await db
            .collection("oi_second_observations")
            .find({
              symbol,
              timestamp: {
                $gte: new Date(sig.evaluatedAt - 60_000),
                $lte: new Date(
                  Math.min(Date.now(), sig.evaluatedAt + HOLD_MAX),
                ),
              },
            })
            .project({ timestamp: 1, price: 1 })
            .sort({ timestamp: 1 })
            .toArray()
        )
          .map((x) => ({ ts: time(x.timestamp), price: Number(x.price) }))
          .filter((x) => x.price > 0);
        const t = simulateExit(polls, sig, RR, []);
        const { k, dir } = directionsAt(candles, sig.evaluatedAt);
        rows.push({
          symbol,
          sig,
          reason: String(d.reason),
          t,
          k: k >= 0 ? candles[k] : null,
          dir,
        });
      }
    }
  } finally {
    await client.close();
  }
  rows.sort((a, b) => a.sig.evaluatedAt - b.sig.evaluatedAt);
  const done = rows.filter((r) => r.t.result === "TP" || r.t.result === "SL");
  const open = rows.filter((r) => r.t.result === "OPEN").length,
    nodata = rows.length - done.length - open;
  console.log(
    `\n=== V9 SIGNALS vs 4h DIRECTION  (last ${DAYS} days, all times UTC) ===`,
  );
  console.log(
    `signals ${rows.length}: finished ${done.length} (TP/SL), still open ${open}, no stored prices ${nodata}`,
  );
  const all = done.reduce((x, r) => x + r.t.netR, 0);
  console.log(
    `ALL finished: ${done.length} trades, TP ${done.filter((r) => r.t.result === "TP").length}, SL ${done.filter((r) => r.t.result === "SL").length}, net ${sR(all)}, avg ${done.length ? sR(all / done.length) : "n/a"}\n`,
  );
  console.log(
    "definition  group     trades  TP  SL  win%    netR     avg/trade",
  );
  for (const def of DEFINITIONS) {
    for (const g of ["WITH", "AGAINST", "NEUTRAL"] as Fit[]) {
      const a = done.filter(
        (r) => r.dir[def] !== null && fit(r.sig.side, r.dir[def]!) === g,
      );
      const tp = a.filter((r) => r.t.result === "TP").length,
        net = a.reduce((x, r) => x + r.t.netR, 0);
      console.log(
        `${def.padEnd(10)}  ${g.padEnd(8)}  ${String(a.length).padStart(6)}  ${String(tp).padStart(2)}  ${String(a.length - tp).padStart(2)}  ${a.length ? `${Math.round((100 * tp) / a.length)}%`.padStart(4) : " n/a"}  ${sR(net).padStart(8)}  ${a.length ? sR(net / a.length) : "n/a"}`,
      );
    }
    console.log("");
  }
  console.log(
    "1C = last closed 4h candle vs the previous (HH+HL up, LH+LL down, else flat); 3C = 2 such steps in a row;",
  );
  console.log(
    "SWING = Phase 1 structure (pivots); 24H = close vs close 6 candles earlier. WITH = LONG in UP / SHORT in DOWN.",
  );
  console.log(
    "Break-even win rate at 2.2R with fees: about 34-37% (depends on the SL size). Fewer than ~20 trades in a group = only a hint, not a result.",
  );
  {
    console.log(
      "\nSIGNAL (UTC)  COIN   SIDE   status       result          last closed 4h candle (open UTC)   1C    3C    SWING 24H",
    );
    for (const r of rows) {
      const res =
        r.t.result === "TP" || r.t.result === "SL"
          ? `${r.t.result} ${sR(r.t.netR)}`
          : r.t.result;
      const d = (x: Dir | null): string => (x ?? "-").padEnd(5);
      console.log(
        `${utc(r.sig.evaluatedAt)}   ${r.symbol.replace("USDT", "").padEnd(6)} ${r.sig.side.padEnd(5)}  ${r.reason.padEnd(11)}  ${res.padEnd(14)}  ${r.k ? utc(r.k.openTime) : "-".padEnd(11)}                        ${d(r.dir["1C"])} ${d(r.dir["3C"])} ${d(r.dir.SWING)} ${d(r.dir["24H"])}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
