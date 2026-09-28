/**
 * V9 BACKTEST WITH THE 4h FRAME (Johnny, Sep 28 2026) -- the real V9 engine on the stored raw data, not the
 * signals we happened to get live. Read-only.
 *
 *   1. The LIVE engine (the same code, min SL 0.33%, stop at the episode extreme) is fed the raw rows
 *      (liq_raw_events + oi_second_observations) minute by minute, exactly like production.
 *   2. The first WARM-UP days only fill the engine's memory (3-day window + 3-day medians) -- no trades,
 *      like live, which warms up on history before it trades.
 *   3. Every signal after the warm-up is checked against the 4h frame (Binance candles, only those finished
 *      before the episode started) and simulated: entry at the first price after the decision, SL at the
 *      episode extreme, TP 2.2R, net of fees, one trade per coin at a time (like live).
 * Variants:
 *   V9            all V9 checks (what live traded before the frame)
 *   V9+FRAME      + only when the cleaning reached our edge of the frame (live for karo/artak now)
 *   V9+FORCED     + only a forced cleaning (the old REAL filter)
 *   RAW           every confirmed episode, V9's 5 checks ignored (SELECTED or NOT_SELECTED)
 *   RAW+FRAME     every confirmed episode at the edge of the frame
 * The V9 signals are also matched against the signals live really gave (v9_decisions, SELECTED), to see
 * whether this backtest is the same V9.
 *
 *   npx tsx src/tools/v9-backtest-frame.ts                  (all coins; ~10-20 min, use nohup)
 *   npx tsx src/tools/v9-backtest-frame.ts --symbols BTC,AVAX --warmup 3 --list
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient, type Db } from "mongodb";
import type { Victim } from "../strategy/v9/v9-core";
import {
  replaySymbolMulti,
  simulateOneAtATime,
  type Poll,
} from "../strategy/v9/v9-replay";
import {
  DEFAULT_V9_ENGINE_SETTINGS,
  type V9Decision,
} from "../strategy/v9/v9-causal-engine";
import {
  checkFrame,
  type K,
  type V9FrameInfo,
} from "../strategy/v9/v9-frame-core";

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
const WARMUP_MS = Number(arg("warmup", "3")) * 86_400_000;
const RR = 2.2,
  DAY = 86_400_000;
const LIST = argv.includes("--list");
const time = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const yerevan = (ms: number): string =>
  new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const fp = (v: number | undefined): string =>
  v === undefined || !Number.isFinite(v)
    ? "n/a"
    : v >= 1000
      ? v.toFixed(1)
      : v >= 1
        ? v.toFixed(4)
        : v.toFixed(5);
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 15_000,
});

async function klines(
  symbol: string,
  interval: string,
  from: number,
  to: number,
): Promise<K[]> {
  const out: K[] = [];
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

type Variant = "V9" | "V9+FRAME" | "V9+FORCED" | "RAW" | "RAW+FRAME";
const VARIANTS: Variant[] = ["V9", "V9+FRAME", "V9+FORCED", "RAW", "RAW+FRAME"];
interface Row {
  v: Variant;
  symbol: string;
  d: V9Decision;
  frame: V9FrameInfo | null;
  result: string;
  netR: number;
  entry?: number;
  sl?: number;
  live: boolean;
}

async function runSymbol(
  db: Db,
  symbol: string,
  liveSignals: Array<{ symbol: string; victim: Victim; confirmTs: number }>,
): Promise<{
  rows: Row[];
  from: number;
  until: number;
  liveInWindow: number;
} | null> {
  const liqCol = db.collection("liq_raw_events"),
    oiCol = db.collection("oi_second_observations");
  const [firstLiq, lastLiq, firstOi, lastOi] = await Promise.all([
    liqCol.findOne(
      { symbol },
      { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
    ),
    liqCol.findOne(
      { symbol },
      { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
    ),
    oiCol.findOne(
      { symbol },
      { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
    ),
    oiCol.findOne(
      { symbol },
      { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
    ),
  ]);
  if (!firstLiq || !lastLiq || !firstOi || !lastOi) return null;
  const from = Math.max(time(firstLiq.timestamp), time(firstOi.timestamp));
  const until = Math.min(time(lastLiq.timestamp), time(lastOi.timestamp));
  const tradeFrom = from + WARMUP_MS;
  if (tradeFrom >= until) {
    process.stderr.write(
      `${symbol}: only ${((until - from) / DAY).toFixed(1)} days of raw data -- less than the warm-up\n`,
    );
    return null;
  }
  process.stderr.write(
    `${symbol}: raw ${yerevan(from)} -> ${yerevan(until)}, trading from ${yerevan(tradeFrom)} ...\n`,
  );
  const liq = (
    await liqCol
      .find({
        symbol,
        victim: { $in: ["LONG", "SHORT"] },
        timestamp: { $gte: from, $lte: until },
      })
      .project({ timestamp: 1, victim: 1, quoteQty: 1 })
      .sort({ timestamp: 1 })
      .toArray()
  ).map((x) => ({
    ts: time(x.timestamp),
    victim: x.victim as Victim,
    usd: Number(x.quoteQty),
  }));
  const oi = (
    await oiCol
      .find({
        symbol,
        timestamp: { $gte: new Date(from), $lte: new Date(until) },
      })
      .project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 })
      .sort({ timestamp: 1 })
      .toArray()
  ).map((x) => ({
    ts: time(x.timestamp),
    updated: time(x.oiUpdatedAt),
    oi: Number(x.openInterest),
    price: Number(x.price),
  }));
  const polls: Poll[] = oi
    .filter((x) => x.price > 0)
    .map((x) => ({ ts: x.ts, price: x.price }));

  const [res] = replaySymbolMulti(symbol, liq, oi, from, until, [
    {
      settings: { ...DEFAULT_V9_ENGINE_SETTINGS, minSlFraction: 0.0033 },
      rr: RR,
    },
  ]);
  const decisions = res.decisions.filter((d) => d.evaluatedAt >= tradeFrom);

  const c4 = await klines(symbol, "4h", tradeFrom - 8 * DAY, until);
  const m1 = await klines(symbol, "1m", tradeFrom - 2 * DAY, until);
  const frameCache = new Map<V9Decision, V9FrameInfo>();
  const frameOf = (d: V9Decision): V9FrameInfo => {
    let f = frameCache.get(d);
    if (!f) {
      f = checkFrame(
        c4,
        m1,
        d.tradeSide === "LONG",
        d.episode.start,
        d.evaluatedAt,
      );
      frameCache.set(d, f);
    }
    return f;
  };

  const isLive = (d: V9Decision): boolean =>
    liveSignals.some(
      (s) =>
        s.symbol === symbol &&
        s.victim === d.episode.victim &&
        Math.abs(s.confirmTs - d.episode.confirmTs) <= 15 * 60_000,
    );
  const v9 = decisions.filter((d) => d.tradable);
  // RAW: every confirmed episode that V9 judged on its 5 checks (stale / duplicate / data-gap / too-tight / no-reference excluded)
  const raw = decisions.filter(
    (d) =>
      (d.reason === "SELECTED" || d.reason === "NOT_SELECTED") &&
      d.stopPrice > 0,
  );
  const pick: Record<Variant, V9Decision[]> = {
    V9: v9,
    "V9+FRAME": v9.filter((d) => frameOf(d).verdict === "IN_ZONE"),
    "V9+FORCED": v9.filter((d) => !d.quality?.weak),
    RAW: raw,
    "RAW+FRAME": raw.filter((d) => frameOf(d).verdict === "IN_ZONE"),
  };
  const rows: Row[] = [];
  for (const v of VARIANTS) {
    for (const { decision: d, trade: t } of simulateOneAtATime(
      polls,
      pick[v],
      RR,
    )) {
      rows.push({
        v,
        symbol,
        d,
        frame: v.includes("FRAME") || v === "V9" ? frameOf(d) : null,
        result: t.result,
        netR: t.netR ?? 0,
        entry: t.entry,
        sl: t.sl,
        live: isLive(d),
      });
    }
  }
  const liveInWindow = liveSignals.filter(
    (s) =>
      s.symbol === symbol && s.confirmTs >= tradeFrom && s.confirmTs <= until,
  ).length;
  return { rows, from: tradeFrom, until, liveInWindow };
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const rows: Row[] = [];
  let liveTotal = 0,
    spanFrom = Infinity,
    spanTo = -Infinity;
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const live = (
      await db
        .collection("v9_decisions")
        .find({ reason: "SELECTED" })
        .project({ symbol: 1, victim: 1, confirmTs: 1 })
        .toArray()
    ).map((x) => ({
      symbol: String(x.symbol),
      victim: x.victim as Victim,
      confirmTs: time(x.confirmTs),
    }));
    for (const s of symbols) {
      const r = await runSymbol(db, s, live);
      if (!r) continue;
      rows.push(...r.rows);
      liveTotal += r.liveInWindow;
      spanFrom = Math.min(spanFrom, r.from);
      spanTo = Math.max(spanTo, r.until);
    }
  } finally {
    await client.close();
  }
  const days = (spanTo - spanFrom) / DAY;
  console.log(
    `\n=== V9 BACKTEST ON RAW DATA  ${yerevan(spanFrom)} -> ${yerevan(spanTo)} Yerevan (${days.toFixed(1)} days after a ${WARMUP_MS / DAY}-day warm-up) ===`,
  );
  console.log(
    "entry at the first price after the decision, SL = episode extreme (>= 0.33%), TP 2.2R, net of fees, one trade per coin at a time\n",
  );
  for (const v of VARIANTS) {
    const a = rows.filter((r) => r.v === v && r.result !== "SYMBOL_BUSY");
    const tp = a.filter((r) => r.result === "TP").length,
      sl = a.filter((r) => r.result === "SL").length,
      open = a.filter((r) => r.result === "OPEN").length;
    const busy = rows.filter(
      (r) => r.v === v && r.result === "SYMBOL_BUSY",
    ).length;
    const net = a.reduce((x, r) => x + r.netR, 0);
    console.log(
      `${v.padEnd(10)} trades ${String(tp + sl).padStart(3)} (${days > 0 ? ((tp + sl + open) / days).toFixed(1) : "-"}/day)  TP ${String(tp).padStart(3)}  SL ${String(sl).padStart(3)}  open ${open}  busy ${busy}  win ${tp + sl ? `${Math.round((100 * tp) / (tp + sl))}%`.padStart(4) : " n/a"}  netR ${net >= 0 ? "+" : ""}${net.toFixed(2).padStart(6)}  avg ${tp + sl ? (net / (tp + sl + open)).toFixed(2) : "n/a"}R`,
    );
  }
  const v9 = rows.filter((r) => r.v === "V9");
  const matched = v9.filter((r) => r.live).length;
  console.log(
    `\nSame V9 as live? backtest V9 signals ${v9.length}, of them also given live ${matched}; live gave ${liveTotal} in this window.`,
  );
  console.log(
    "(differences come from the warm-up: live had 4 days of history, the backtest starts empty; and from restarts/gaps live)",
  );

  const listed: Variant[] = LIST ? VARIANTS : ["V9"];
  for (const v of listed) {
    console.log(`\n--- ${v} signals ---`);
    console.log(
      "DECISION (Yerevan)  COIN   SIDE  entry        SL           FRAME                          live?  result",
    );
    for (const r of rows
      .filter((x) => x.v === v)
      .sort((a, b) => a.d.evaluatedAt - b.d.evaluatedAt)) {
      const f = r.frame;
      const fr = !f
        ? "-"
        : f.verdict === "IN_ZONE"
          ? `IN_ZONE${f.pierced ? " (pierced)" : ""}`
          : f.verdict === "MIDDLE"
            ? `middle ${Math.round(f.pos)}%`
            : "no frame";
      console.log(
        `${yerevan(r.d.evaluatedAt)}         ${r.symbol.replace("USDT", "").padEnd(6)} ${r.d.tradeSide === "LONG" ? "BUY " : "SELL"}  ${fp(r.entry).padEnd(12)} ${fp(r.sl).padEnd(12)} ${fr.padEnd(30)} ${r.live ? "yes" : "no "}    ${r.result}${r.result === "TP" || r.result === "SL" ? ` ${r.netR >= 0 ? "+" : ""}${r.netR.toFixed(2)}R` : ""}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
