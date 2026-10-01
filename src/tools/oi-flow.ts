/**
 * OI FLOWS: accumulation -> liquidation -> trade WITH the move -- research only, read-only (Johnny, Oct 2 2026).
 * See src/research/oi-flow.ts. OI IN and OUT are counted minute by minute (a candle's net change hides both), and
 * measured in their own ATRs. Two variants on the same moments:
 *   CONT  every liquidation after an accumulation (Johnny's 2nd idea: the rest gets liquidated next)
 *   REV   only when the drop BEFORE the accumulation liquidated the other side (the V9 3-phase story)
 * Trades like live V9: SL at the extreme since the OI peak, TP 1.5R, time stop 24h, fees, one trade per coin.
 * Results split by size (in ATRs) -- nothing picked. At the end the REAL V9 (main) over the same days.
 *
 *   npx tsx src/tools/oi-flow.ts --days 30
 *   options: --tf 5 (ATR window minutes)  --n 14  --rev 1  --tp 1.5  --minsl 0.7  --timestop 24  --coins BTC,DOGE  --list
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  SIZE_BUCKETS,
  flowSignals,
  sizeBucket,
  type FlowMinute,
  type FlowSignal,
} from "../research/oi-flow";
import {
  simTrade,
  type TpBar,
  type TpOpts,
  type TpResult,
  type TpTrade,
} from "../research/v9-tp-sim";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const nn = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
const sym = (s: string): string =>
  s.toUpperCase().endsWith("USDT") ? s.toUpperCase() : `${s.toUpperCase()}USDT`;
const D = 86_400_000;

interface Row {
  s: FlowSignal;
  r: TpResult;
}

function stats(rows: readonly { r: TpResult }[], nDays: number): string {
  const c = (st: string): number =>
    rows.filter((x) => x.r.status === st).length;
  const done = rows.filter((x) => x.r.status !== "OPEN"),
    R = done.reduce((a, x) => a + x.r.r, 0);
  const win = done.length ? Math.round((100 * c("TP")) / done.length) : 0;
  return `${String(rows.length).padStart(4)} trades · TP ${String(c("TP")).padStart(3)} · SL ${String(c("SL")).padStart(3)} · time ${String(c("TIME")).padStart(2)} · open ${c("OPEN")} · win ${String(win).padStart(3)}% · total ${sR(R).padStart(8)} · avg ${sR(done.length ? R / done.length : 0).padStart(7)} · per day ${sR(R / nDays)}`;
}
function table(
  title: string,
  rows: Row[],
  keyOf: (s: FlowSignal) => string,
  keys: string[],
  nDays: number,
): void {
  console.log(title);
  for (const k of keys) {
    const g = rows.filter((x) => keyOf(x.s) === k);
    if (g.length) console.log(`   ${k.padEnd(18)} ${stats(g, nDays)}`);
  }
  console.log("");
}
/** time order, min SL filter, one trade per coin at a time */
function trade(
  sigs: readonly FlowSignal[],
  bars: readonly TpBar[],
  o: TpOpts,
  minSl: number,
  cnt: { sl: number; busy: number },
): Row[] {
  const out: Row[] = [];
  let busy = -Infinity;
  for (const s of sigs) {
    if (!(s.slPct > minSl)) {
      cnt.sl++;
      continue;
    }
    if (s.t < busy) {
      cnt.busy++;
      continue;
    }
    const t: TpTrade = {
      id: `${s.symbol}-${s.t}`,
      symbol: s.symbol,
      side: s.side,
      createdAt: s.t - 1,
      entry: s.entry,
      sl: s.sl,
    };
    const r = simTrade(t, bars, o);
    busy = r.exitTs;
    out.push({ s, r });
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const days = Number(arg("days", "30")),
    tf = Number(arg("tf", "5")),
    n = Number(arg("n", "14")),
    rev = Number(arg("rev", "1"));
  const tpR = Number(arg("tp", "1.5")),
    minSl = Number(arg("minsl", "0.7")),
    ts = Number(arg("timestop", "24"));
  if (![days, tf, n, rev, tpR].every((x) => x > 0) || !(minSl >= 0))
    throw new Error("bad numbers");
  const coins = arg("coins", process.env.SYMBOLS ?? "BTCUSDT")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(sym);
  const o: TpOpts = {
    tpR,
    minSlPct: minSl,
    maxOpen: null,
    timeStopH: ts > 0 ? ts : null,
    riskUsd: 10,
  };
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const now = Date.now(),
      since = now - days * D,
      warm = since - 2 * D;
    const cont: Row[] = [],
      rev3: Row[] = [];
    const cC = { sl: 0, busy: 0 },
      cR = { sl: 0, busy: 0 };
    let firstData = Infinity;
    const barsBySym = new Map<string, TpBar[]>();
    for (const s of coins) {
      const docs = await db
        .collection(MINUTE_BARS)
        .find({ symbol: s, ts: { $gte: new Date(warm) } })
        .project({
          ts: 1,
          high: 1,
          low: 1,
          close: 1,
          oiLast: 1,
          longLiqUsd: 1,
          shortLiqUsd: 1,
        })
        .sort({ ts: 1 })
        .toArray();
      const rows: FlowMinute[] = docs.map((d) => ({
        t: num(d.ts),
        oi: nn(d.oiLast),
        high: nn(d.high),
        low: nn(d.low),
        close: nn(d.close),
        longLiq: Number(d.longLiqUsd ?? 0),
        shortLiq: Number(d.shortLiqUsd ?? 0),
      }));
      if (rows.length) firstData = Math.min(firstData, rows[0].t);
      const bars: TpBar[] = rows
        .filter((b) => b.high! > 0 && b.low! > 0 && b.close! > 0)
        .map((b) => ({ t: b.t, high: b.high!, low: b.low!, close: b.close! }));
      barsBySym.set(s, bars);
      const sigs = flowSignals(s, rows, {
        tf,
        n,
        rev,
        minSlPct: 0.33,
        maxGapMin: 15,
      }).filter((x) => x.t >= since);
      cont.push(...trade(sigs, bars, o, minSl, cC));
      rev3.push(
        ...trade(
          sigs.filter((x) => x.prior === "OTHER_SIDE"),
          bars,
          o,
          minSl,
          cR,
        ),
      );
    }
    const from = Math.max(since, firstData),
      nDays = Math.max(1, (now - from) / D);
    console.log(
      `OI FLOWS · ${utc(from)} -> ${utc(now)} UTC (${nDays.toFixed(1)} days of data) · ${coins.length} coins`,
    );
    console.log(
      `IN/OUT minute by minute · ATR = normal IN / OUT per ${tf} minutes (${n}) · a leg ends when OI turns back ${rev} ATR`,
    );
    console.log(
      `trade WITH the move (longs liquidated -> SHORT) · SL at the extreme since the OI peak · TP ${tpR}R · SL > ${minSl}% · time stop ${ts || "none"}h · one trade per coin\n`,
    );

    for (const [name, rows, cnt, what] of [
      ["CONT", cont, cC, "every liquidation after an OI rise"],
      [
        "REV ",
        rev3,
        cR,
        "only if the drop before the rise liquidated the OTHER side (V9 story)",
      ],
    ] as const) {
      console.log(`================ ${name} -- ${what}`);
      console.log(
        `skipped: SL too small ${cnt.sl} · coin already in a trade ${cnt.busy}`,
      );
      console.log(`ALL                  ${stats(rows, nDays)}\n`);
      table(
        "ACCUMULATION: new positions IN ÷ up-ATR (how many normal windows of IN):",
        rows,
        (s) => sizeBucket(s.accIn),
        SIZE_BUCKETS,
        nDays,
      );
      table(
        "ACCUMULATION: net OI rise ÷ up-ATR:",
        rows,
        (s) => sizeBucket(s.accNet),
        SIZE_BUCKETS,
        nDays,
      );
      if (name === "CONT")
        table(
          "the drop BEFORE the rise:",
          rows,
          (s) => s.prior,
          ["OTHER_SIDE", "SAME_SIDE", "NO_LIQ", "NONE"],
          nDays,
        );
      else
        table(
          "the drop BEFORE the rise: OUT ÷ down-ATR:",
          rows,
          (s) => sizeBucket(s.priorOut),
          SIZE_BUCKETS,
          nDays,
        );
      table("side:", rows, (s) => s.side, ["LONG", "SHORT"], nDays);
      table(
        "coin:",
        rows,
        (s) => s.symbol.replace(/USDT$/, ""),
        [...new Set(rows.map((x) => x.s.symbol.replace(/USDT$/, "")))].sort(),
        nDays,
      );
    }

    const docs = await db
      .collection("v9_trades")
      .find({
        userId: "main",
        entryPrice: { $ne: null },
        state: { $in: ["OPEN", "CLOSED"] },
      })
      .toArray();
    const v9 = docs
      .map(
        (d) =>
          ({
            id: String(d.tradeId),
            symbol: String(d.symbol),
            side: d.side,
            createdAt: num(d.createdAt),
            entry: Number(d.entryPrice),
            sl: Number(d.slPrice),
          }) as TpTrade,
      )
      .filter(
        (t) =>
          t.createdAt >= from &&
          t.entry > 0 &&
          t.sl > 0 &&
          t.entry !== t.sl &&
          (100 * Math.abs(t.entry - t.sl)) / t.entry > minSl,
      );
    const v9rows = v9.map((t) => ({
      r: simTrade(t, barsBySym.get(t.symbol) ?? [], o),
    }));
    console.log(
      `================ REAL V9 (main) same days, SL > ${minSl}%, same TP/time stop:`,
    );
    console.log(`                     ${stats(v9rows, nDays)}\n`);

    if (argv.includes("--list")) {
      for (const [name, rows] of [
        ["CONT", cont],
        ["REV", rev3],
      ] as const) {
        console.log(`---- ${name}`);
        for (const x of [...rows].sort((a, b) => a.s.t - b.s.t)) {
          const s = x.s;
          console.log(
            `${utc(s.t)} ${s.symbol.replace(/USDT$/, "").padEnd(5)} ${s.side.padEnd(5)} rise ${utc(s.accStart)}..${utc(s.peak).slice(6)} IN ${s.accIn.toFixed(1)} net ${s.accNet.toFixed(1)}ATR · before: ${s.prior} · ${s.victim} liq · SL ${s.slPct.toFixed(2)}% · ${x.r.status} ${sR(x.r.r)}`,
          );
        }
      }
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
