/**
 * V10 · WALL -- THE LIVE CODE REPLAYED on the past (Johnny, Oct 7 2026). Read-only: PAPER only, an in-memory store,
 * nothing written to the database, no order, no Telegram.
 * The real V10LiveService (the same class the bot runs) is driven by a fake clock, hour by hour (90 s after every 1h
 * close, as live), with the real data: Binance public klines + our liquidations + our minute bars (the PAPER exits).
 * Its trades should match the research test (src/tools/wall-trade-test.ts --h1 --tp 2 --list, "WICK room>=1.33x"):
 * the same hours, coins, sides, entries, SL and TP. Small differences can come only from the exits (the test uses
 * Binance 15m candles, PAPER our mark-price minutes) and from a coin being busy a little longer / shorter.
 *
 *   LOG_LEVEL=error npx tsx src/tools/wall-live-replay.ts
 *   options: --days 12  --tp 2  --room 1.33  --list
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { parseV10Settings } from "../strategy/v10/v10-config";
import {
  mongoV10Loader,
  V10LiveService,
  type V10UserRef,
} from "../strategy/v10/v10-live.service";
import type {
  V10SignalDoc,
  V10Store,
  V10TradeDoc,
} from "../strategy/v10/v10-repository";
import { BinanceMongoWallSource } from "../strategy/v10/wall-data";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const px = (v: number | null): string =>
  v === null ? "n/a" : String(+v.toPrecision(5));
const sp = (v: number, d = 2): string => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
const H = 3_600_000,
  D = 24 * H;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const symbols = (process.env.SYMBOLS ?? "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const days = Number(arg("days", "12")),
    list = argv.includes("--list");
  const settings = parseV10Settings(
    {
      enabled: true,
      btc: false,
      own: false,
      wall: true,
      wallTpPct: Number(arg("tp", "2")),
      wallRoomRatio: Number(arg("room", "1.33")),
      userModes: { replay: "PAPER" },
    },
    ["replay"],
    symbols,
  );
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const getDb = async () => db;
    const signals: V10SignalDoc[] = [],
      trades: V10TradeDoc[] = [];
    const store: V10Store = {
      ensureIndexes: async () => undefined,
      insertSignal: async (d) => {
        if (signals.some((x) => x.signalId === d.signalId)) return false;
        signals.push({ ...d });
        return true;
      },
      insertTrade: async (d) => {
        if (trades.some((x) => x.tradeId === d.tradeId)) return false;
        trades.push({ ...d });
        return true;
      },
      updateTrade: async (id, f) => {
        const t = trades.find((x) => x.tradeId === id);
        if (t) Object.assign(t, f);
      },
      findOpenTrades: async () =>
        trades.filter((t) => t.state === "OPEN").map((t) => ({ ...t })),
      hasOpenV9Trade: async () => false,
      openV9TradeSince: async () => null,
    };
    const users: V10UserRef[] = [
      {
        userId: "replay",
        mode: "PAPER",
        riskUsd: 10,
        binanceRest: null,
        telegram: null,
      },
    ];
    let now = 0;
    const svc = new V10LiveService(
      settings,
      () => users,
      mongoV10Loader(getDb),
      store,
      () => now,
      null,
      null,
      new BinanceMongoWallSource(getDb),
    );
    const real = Date.now(),
      start = Math.floor((real - days * D) / H) * H;
    console.log(
      `WALL live replay · ${settings.wallSymbols.length} coins · ${utc(start)} -> ${utc(real)} UTC · TP ${settings.wallTpPct}% · room >= ${settings.wallRoomRatio}x`,
    );
    for (let h = start; h + 100_000 <= real; h += H) {
      now = h + 100_000;
      await svc.onMinute();
      if ((h - start) % (24 * H) === 0)
        process.stderr.write(
          `  ${utc(h)} · ${trades.filter((t) => t.state !== "SKIPPED").length} trades so far\n`,
        );
    }
    now = real;
    await svc.onMinute();
    const done = trades.filter((t) => t.state === "CLOSED"),
      open = trades.filter((t) => t.state === "OPEN");
    const net = (t: V10TradeDoc): number =>
      ((t.side === "LONG" ? 1 : -1) * (100 * (t.exitPrice! - t.entryPrice!))) /
        t.entryPrice! -
      0.1;
    if (list)
      for (const t of [...done, ...open].sort(
        (a, b) => a.createdAt - b.createdAt,
      ))
        console.log(
          `  ${utc(t.createdAt)} ${t.symbol.replace("USDT", "").padEnd(6)} ${t.side.padEnd(5)} entry ${px(t.entryPrice).padEnd(8)} SL ${px(t.slPrice).padEnd(8)} TP ${px(t.tpPrice).padEnd(8)} -> ${t.state === "OPEN" ? "OPEN" : `${(t.closeReason ?? "").replace("_FILLED", "").replace("_CLOSED", "").padEnd(7)} ${sp(net(t))}%`}`,
        );
    const sum = done.reduce((a, t) => a + net(t), 0),
      win = done.filter((t) => net(t) > 0).length;
    console.log(
      `\n${done.length} closed trades · win ${done.length ? Math.round((100 * win) / done.length) : 0}% · sum ${sp(sum, 1)}% (fee 0.1% in) · TP ${done.filter((t) => t.closeReason === "TP_FILLED").length} · SL ${done.filter((t) => t.closeReason === "SL_FILLED").length} · 24h ${done.filter((t) => t.closeReason === "TIMEOUT_CLOSED").length} · open now ${open.length} · skipped ${trades.filter((t) => t.state === "SKIPPED").length}`,
    );
    console.log(
      `(compare with: npx tsx src/tools/wall-trade-test.ts --h1 --tp ${settings.wallTpPct} --list -> "WICK room>=1.33x stop")`,
    );
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
