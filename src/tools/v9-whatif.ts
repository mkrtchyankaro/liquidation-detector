/**
 * WHAT-IF ON THE REAL LIVE SIGNALS (Johnny, Sep 27 2026).
 *
 * The causal replay rebuilds signals from raw data and needs 3 days of
 * warm-up (its 3-day window and 3-day medians start empty), so with only a
 * few days of raw data its signals are NOT the live ones. This tool does not
 * rebuild anything: it takes the signals V9 really gave live (v9_trades),
 * keeps their exact entry, and only re-computes the STOP / TP under each rule
 * and the result on minute_bars (kept 365 days). Read-only.
 *
 *   npx tsx src/tools/v9-whatif.ts               (all live signals)
 *   npx tsx src/tools/v9-whatif.ts --user main   (whose fills to use; default main)
 *
 * Rules compared (entry = the user's real fill; TP = 2.2R; SL never < 0.33%):
 *   OLD      SL at the episode extreme (start -> decision)
 *   OITURN   SL at the extreme since the OI turn (if closer)
 *   MIN0.6   OITURN only when that stop is >= 0.6% away (live since Sep 26)
 *   +S3/+S5  MIN0.6, but no trade when the TP lies beyond the last 1h swing
 *            (3-candle / 5-candle rule) -- the 1h structure would have to break
 * Filters on top of OLD (Johnny, Sep 27 -- "weak signals should not come at all"):
 *   TINY     skip when the NATURAL stop (episode extreme, before the 0.33%
 *            minimum) is closer than 0.5% -- a tiny move; fees eat 0.2-0.3R
 *   SIZE     skip when the victims' liquidations $ are below the median of
 *            this coin's previous V9 decisions (last 3 days, only the past)
 *   FORCED   skip when liquidations $ / closed OI $ is below that median
 *   T12/T24  time stop: still open after 12h/24h -> closed at that minute's close
 *   TREND    skip trades against the 1h structure (UP = higher highs+lows, DOWN = lower)
 *   CHG12    skip when the 12h before the entry moved >= 1% against the trade
 *   ACC15/30 skip when the new-positions phase (lowest OI -> OI turn) lasted < 15/30 min
 *   SHARE25  skip when < 25% of the closed OI was re-opened
 *   ACCREL   skip when the accumulation OI % is below this coin's median of its previous episodes (ACCREL2: below 2x)
 *   CONF     skip when the confirming liquidations < the coin's typical liquidation minute
 * "LIVE" = what really happened to the user's trade (validation: OLD should
 * match it for signals that ran with the old rule).
 * Result on 1-minute high/low; when SL and TP are both inside one minute, SL first.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { hourCandles, lastSwing } from "../strategy/v9/v9-causal-engine";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const MIN = 60_000,
  RR = 2.2,
  MIN_SL = 0.0033,
  TAKER = 0.05,
  MAKER = 0.02;
const stamp = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);

interface Bar {
  ts: number;
  high: number;
  low: number;
  close: number;
  oi: number;
  liqL: number;
  liqS: number;
}
type Res = {
  sl: number;
  slPct: number;
  tp: number;
  result: "TP" | "SL" | "OPEN" | "TIME";
  netR: number;
  blocked?: boolean;
  minutes?: number;
};

/** maxMinutes: time stop -- still open after that long = closed at that minute's close (taker both ways). */
function simulate(
  bars: readonly Bar[],
  entryTs: number,
  long: boolean,
  entry: number,
  sl: number,
  maxMinutes = Infinity,
): Res {
  const risk = Math.abs(entry - sl),
    slPct = (100 * risk) / entry;
  const tp = long ? entry + RR * risk : entry - RR * risk;
  const t0 = Math.floor(entryTs / MIN) * MIN;
  for (const b of bars) {
    if (b.ts <= t0) continue; // from the minute after the entry minute
    const minutes = (b.ts - t0) / MIN;
    if (long ? b.low <= sl : b.high >= sl)
      return {
        sl,
        slPct,
        tp,
        result: "SL",
        netR: -1 - (2 * TAKER) / slPct,
        minutes,
      };
    if (long ? b.high >= tp : b.low <= tp)
      return {
        sl,
        slPct,
        tp,
        result: "TP",
        netR: RR - (TAKER + MAKER) / slPct,
        minutes,
      };
    if (minutes >= maxMinutes)
      return {
        sl,
        slPct,
        tp,
        result: "TIME",
        netR:
          (long ? b.close - entry : entry - b.close) / risk -
          (2 * TAKER) / slPct,
        minutes,
      };
  }
  return { sl, slPct, tp, result: "OPEN", netR: 0 };
}

/** All confirmed swings (k candles each side), oldest first. */
function swings(
  c: ReadonlyArray<{ low: number; high: number }>,
  kind: "LOW" | "HIGH",
  k: number,
): number[] {
  const out: number[] = [];
  for (let i = k; i < c.length - k; i++) {
    const v = kind === "LOW" ? c[i].low : c[i].high;
    let ok = true;
    for (let j = i - k; j <= i + k && ok; j++)
      if (j !== i && (kind === "LOW" ? !(v < c[j].low) : !(v > c[j].high)))
        ok = false;
    if (ok) out.push(v);
  }
  return out;
}

/** 1h structure from the last two swing highs and lows: UP (HH+HL), DOWN (LH+LL), else MIX. */
function structure1h(
  c: ReadonlyArray<{ low: number; high: number }>,
  k = 2,
): "UP" | "DOWN" | "MIX" {
  const h = swings(c, "HIGH", k).slice(-2),
    l = swings(c, "LOW", k).slice(-2);
  if (h.length < 2 || l.length < 2) return "MIX";
  if (h[1] > h[0] && l[1] > l[0]) return "UP";
  if (h[1] < h[0] && l[1] < l[0]) return "DOWN";
  return "MIX";
}

function clampMin(long: boolean, entry: number, sl: number): number {
  const d = entry * MIN_SL;
  return Math.abs(entry - sl) < d ? (long ? entry - d : entry + d) : sl;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const trades = await db
      .collection("v9_trades")
      .find({ userId: user, entryPrice: { $ne: null } })
      .sort({ createdAt: 1 })
      .toArray();
    if (!trades.length) {
      console.log(`no V9 trades with a fill for user "${user}"`);
      return;
    }
    const rules = [
      "OLD",
      "OITURN",
      "MIN0.6",
      "MIN0.6+S3",
      "MIN0.6+S5",
      "OLD+TINY",
      "OLD+SIZE",
      "OLD+FORCED",
      "OLD+T12",
      "OLD+T24",
      "OLD+TREND",
      "OLD+CHG12",
      "OLD+FORCED+TREND",
      "OLD+FORCED+T24",
      "OLD+ACC15",
      "OLD+ACC30",
      "OLD+SHARE25",
      "OLD+CONF",
      "OLD+FORCED+ACC15",
      "OLD+FORCED+CONF",
      "OLD+FORCED+ACC15+CONF",
      "OLD+ACCREL",
      "OLD+ACCREL2",
      "OLD+FORCED+ACCREL",
      "OLD+FORCED+ACCREL2",
    ] as const;
    const tot = new Map<
      string,
      {
        tp: number;
        sl: number;
        time: number;
        open: number;
        skip: number;
        net: number;
      }
    >(
      [...rules, "LIVE"].map((r) => [
        r,
        { tp: 0, sl: 0, time: 0, open: 0, skip: 0, net: 0 },
      ]),
    );
    const add = (rule: string, r: Res | null): void => {
      const t = tot.get(rule)!;
      if (!r || r.blocked) {
        t.skip++;
        return;
      }
      if (r.result === "TP") t.tp++;
      else if (r.result === "SL") t.sl++;
      else if (r.result === "TIME") t.time++;
      else t.open++;
      t.net += r.netR;
    };
    const cell = (r: Res | null, w = 20): string =>
      !r
        ? "n/a".padEnd(w)
        : r.blocked
          ? "SKIP".padEnd(w)
          : `${r.result.padEnd(4)} ${r.netR >= 0 ? "+" : ""}${r.netR.toFixed(2)}${r.minutes !== undefined ? ` ${Math.round(r.minutes / 60)}h` : ""}`.padEnd(
              w,
            );

    console.log(
      `\n=== WHAT-IF on the ${trades.length} real live V9 signals (fills of "${user}") ===`,
    );
    console.log(
      "ENTRY UTC    SYMBOL    SIDE  LIVE            | OLD             OLD+T24         | chg12h 1h-struct | forced% med%  | acc min  acc%  med(n)    x  share | conf$    typ$    -> flags",
    );
    for (const t of trades) {
      const d = await db
        .collection("v9_decisions")
        .findOne({ signalId: t.signalId });
      if (!d) continue;
      const long = t.side === "LONG",
        entry = Number(t.entryPrice),
        now = num(d.evaluatedAt),
        entryTs = num(t.createdAt);
      const rows = await db
        .collection(MINUTE_BARS)
        .find({
          symbol: t.symbol,
          ts: { $gte: new Date(now - 100 * 3_600_000) },
        })
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
      const bars: Bar[] = rows
        .map((r) => ({
          ts: num(r.ts),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          oi: Number(r.oiLast),
          liqL: Number(r.longLiqUsd ?? 0),
          liqS: Number(r.shortLiqUsd ?? 0),
        }))
        .filter((b) => b.high > 0 && b.low > 0);
      const upto = (from: number): Bar[] =>
        bars.filter((b) => b.ts >= Math.floor(from / MIN) * MIN && b.ts <= now);
      const ext = (from: number): number => {
        const s = upto(from);
        return long
          ? Math.min(...s.map((b) => b.low))
          : Math.max(...s.map((b) => b.high));
      };
      const after = bars.filter((b) => b.ts > now);

      // OLD: extreme since the episode start
      const oldSl = clampMin(long, entry, ext(num(d.episodeStart)));
      // OI turn: highest OI from the minute before the episode end to (not incl.) the confirmation
      let turnTs: number | null = null,
        best = -Infinity;
      for (const b of bars)
        if (
          b.ts >= num(d.episodeEnd) - MIN &&
          b.ts < num(d.confirmTs) &&
          b.oi > 0 &&
          b.oi >= best
        ) {
          best = b.oi;
          turnTs = b.ts;
        }
      const turnExt = turnTs === null ? NaN : ext(turnTs);
      const turnValid =
        Number.isFinite(turnExt) &&
        (long
          ? turnExt < entry && turnExt > oldSl
          : turnExt > entry && turnExt < oldSl);
      const oiturnSl = clampMin(long, entry, turnValid ? turnExt : oldSl);
      const min06Sl =
        turnValid && Math.abs(entry - turnExt) / entry >= 0.006
          ? oiturnSl
          : oldSl;

      const rOld = simulate(after, entryTs, long, entry, oldSl);
      const rOit = simulate(after, entryTs, long, entry, oiturnSl);
      const rMin = simulate(after, entryTs, long, entry, min06Sl);
      // 1h structure at the decision (complete hours only)
      const candles = hourCandles(
        bars
          .filter((b) => b.ts <= now)
          .map((b) => ({ ts: b.ts, low: b.low, high: b.high })),
        now,
      );
      const beyond = (k: number): boolean => {
        const sw = lastSwing(candles, long ? "HIGH" : "LOW", k);
        return sw !== null && (long ? rMin.tp > sw.price : rMin.tp < sw.price);
      };
      const rS3: Res = { ...rMin, blocked: beyond(1) },
        rS5: Res = { ...rMin, blocked: beyond(2) };
      const live: Res | null =
        t.state === "CLOSED" && t.pnlR !== null
          ? {
              sl: Number(t.slPrice),
              slPct: (100 * Math.abs(entry - Number(t.slPrice))) / entry,
              tp: Number(t.tpPrice),
              result:
                t.closeReason === "TP_FILLED"
                  ? "TP"
                  : t.closeReason === "SL_FILLED"
                    ? "SL"
                    : "OPEN",
              netR: Number(t.pnlR),
            }
          : t.state === "OPEN"
            ? {
                sl: Number(t.slPrice),
                slPct: (100 * Math.abs(entry - Number(t.slPrice))) / entry,
                tp: Number(t.tpPrice),
                result: "OPEN",
                netR: 0,
              }
            : null;

      // quality numbers, each vs this coin's previous decisions (last 3 days, before this one)
      const natSlPct =
        (100 * Math.abs(entry - ext(num(d.episodeStart)))) / entry;
      const victimLiq = Number(d.features?.victimLiq ?? 0);
      const startBar = bars.find(
        (b) => b.ts >= Math.floor(num(d.episodeStart) / MIN) * MIN,
      );
      const forcedOf = (
        liq: number,
        dropPct: number,
        oi: number,
        px: number,
      ): number =>
        oi > 0 && px > 0 && dropPct > 0
          ? liq / ((dropPct / 100) * oi * px)
          : NaN;
      const forced = startBar
        ? forcedOf(victimLiq, Number(d.episode?.oiDropPct), startBar.oi, entry)
        : NaN;
      const prior = await db
        .collection("v9_decisions")
        .find({
          symbol: t.symbol,
          confirmTs: {
            $lt: num(d.confirmTs),
            $gte: num(d.confirmTs) - 3 * 86_400_000,
          },
        })
        .project({ features: 1, episode: 1, episodeStart: 1 })
        .toArray();
      const med = (v: number[]): number => {
        const a = v.filter(Number.isFinite).sort((x, y) => x - y);
        return a.length ? a[a.length >> 1] : NaN;
      };
      const medLiq = med(prior.map((p) => Number(p.features?.victimLiq)));
      // forced share of earlier episodes: OI$ from their own start bar when we have it, else this one's
      const medForced = med(
        prior.map((p) => {
          const sb = bars.find(
            (b) => b.ts >= Math.floor(num(p.episodeStart) / MIN) * MIN,
          );
          return forcedOf(
            Number(p.features?.victimLiq),
            Number(p.episode?.oiDropPct),
            sb?.oi ?? startBar?.oi ?? NaN,
            entry,
          );
        }),
      );
      // the live engine's own FORCED numbers when stored (decisions from stage 48 on) -- exactly what REAL users were filtered with
      const q = d.quality as
        | { forcedPct: number; forcedMedianPct: number; weak: boolean }
        | null
        | undefined;
      const forcedShown = q ? q.forcedPct / 100 : forced,
        medShown = q ? q.forcedMedianPct / 100 : medForced;
      const tiny = natSlPct < 0.5,
        small = Number.isFinite(medLiq) && victimLiq < medLiq,
        notForced = q
          ? q.weak
          : Number.isFinite(medForced) && forced < medForced;
      const skipIf = (b: boolean): Res => ({ ...rOld, blocked: b });

      // time stops
      const rT12 = simulate(after, entryTs, long, entry, oldSl, 12 * 60),
        rT24 = simulate(after, entryTs, long, entry, oldSl, 24 * 60);
      // trend before the entry: price change (+ = our way) and the 1h structure (5-candle swings)
      const closeAt = (ts: number): number => {
        let v = NaN;
        for (const b of bars) {
          if (b.ts > ts) break;
          if (b.close > 0) v = b.close;
        }
        return v;
      };
      const chg = (h: number): number => {
        const p = closeAt(now - h * 3_600_000);
        return p > 0 ? ((100 * (entry - p)) / p) * (long ? 1 : -1) : NaN;
      };
      const c12 = chg(12);
      const st = structure1h(candles);
      const against = (long && st === "DOWN") || (!long && st === "UP");
      const adverse12 = Number.isFinite(c12) && c12 <= -1; // the last 12h went >= 1% against our trade

      // NEW POSITIONS (accumulation): lowest OI since the episode start -> the OI turn; CONFIRMATION: the
      // other side's liquidations from the turn to the decision vs this coin's typical liquidation minute (48h)
      let accMin = NaN,
        accPct = NaN,
        share = NaN,
        conf = NaN;
      // accumulation OI % of any episode (start / end / confirm), same way as below: lowest OI -> OI turn
      const accOf = (start: number, end: number, confirm: number): number => {
        let tTs: number | null = null,
          top = -Infinity;
        for (const b of bars)
          if (b.ts >= end - MIN && b.ts < confirm && b.oi > 0 && b.oi >= top) {
            top = b.oi;
            tTs = b.ts;
          }
        if (tTs === null) return NaN;
        let lo = Infinity;
        for (const b of bars)
          if (
            b.ts >= Math.floor(start / MIN) * MIN &&
            b.ts < tTs &&
            b.oi > 0 &&
            b.oi < lo
          )
            lo = b.oi;
        return Number.isFinite(lo) && top > 0 ? (100 * (top - lo)) / lo : NaN;
      };
      // this coin's previous episodes (last 3 days, confirmed before this one): their accumulation sizes
      const priorAcc = await db
        .collection("v9_decisions")
        .find({
          symbol: t.symbol,
          confirmTs: {
            $lt: num(d.confirmTs),
            $gte: num(d.confirmTs) - 3 * 86_400_000,
          },
        })
        .project({ episodeStart: 1, episodeEnd: 1, confirmTs: 1 })
        .toArray();
      const seen = new Set<string>();
      const accPrev = priorAcc
        .filter((p) => {
          const k = String(p.episodeStart);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .map((p) =>
          accOf(num(p.episodeStart), num(p.episodeEnd), num(p.confirmTs)),
        )
        .filter(Number.isFinite);
      const accMed = med(accPrev);
      if (turnTs !== null) {
        let low: Bar | null = null;
        for (const b of bars) {
          if (
            b.ts < Math.floor(num(d.episodeStart) / MIN) * MIN ||
            b.ts >= turnTs
          )
            continue;
          if (b.oi > 0 && (!low || b.oi < low.oi)) low = b;
        }
        const turnBar = bars.find((b) => b.ts === turnTs);
        if (low && turnBar) {
          accMin = (turnTs - low.ts) / MIN;
          accPct = (100 * (turnBar.oi - low.oi)) / low.oi;
          const s0 = startBar?.oi ?? NaN;
          share = s0 > low.oi ? (turnBar.oi - low.oi) / (s0 - low.oi) : NaN;
        }
        conf = bars
          .filter((b) => b.ts >= turnTs && b.ts <= now)
          .reduce((a, b) => a + (long ? b.liqS : b.liqL), 0);
      }
      const liqMinutes = bars
        .filter(
          (b) =>
            b.ts < now && b.ts >= now - 48 * 3_600_000 && b.liqL + b.liqS > 0,
        )
        .map((b) => b.liqL + b.liqS)
        .sort((a, b) => a - b);
      const typical = liqMinutes.length
        ? liqMinutes[liqMinutes.length >> 1]
        : NaN;
      const accRelLow = accPrev.length >= 3 && !(accPct >= accMed),
        accRelLow2 = accPrev.length >= 3 && !(accPct >= 2 * accMed);
      const accShort15 = !(accMin >= 15),
        accShort30 = !(accMin >= 30),
        share25 = !(share >= 0.25),
        confSmall = Number.isFinite(typical) && !(conf >= typical);

      add("OLD", rOld);
      add("OITURN", rOit);
      add("MIN0.6", rMin);
      add("MIN0.6+S3", rS3);
      add("MIN0.6+S5", rS5);
      add("LIVE", live);
      add("OLD+TINY", skipIf(tiny));
      add("OLD+SIZE", skipIf(small));
      add("OLD+FORCED", skipIf(notForced));
      add("OLD+T12", rT12);
      add("OLD+T24", rT24);
      add("OLD+TREND", skipIf(against));
      add("OLD+CHG12", skipIf(adverse12));
      add("OLD+FORCED+TREND", skipIf(notForced || against));
      add("OLD+FORCED+T24", { ...rT24, blocked: notForced });
      add("OLD+ACC15", skipIf(accShort15));
      add("OLD+ACC30", skipIf(accShort30));
      add("OLD+SHARE25", skipIf(share25));
      add("OLD+CONF", skipIf(confSmall));
      add("OLD+FORCED+ACC15", skipIf(notForced || accShort15));
      add("OLD+FORCED+CONF", skipIf(notForced || confSmall));
      add(
        "OLD+FORCED+ACC15+CONF",
        skipIf(notForced || accShort15 || confSmall),
      );
      add("OLD+ACCREL", skipIf(accRelLow));
      add("OLD+ACCREL2", skipIf(accRelLow2));
      add("OLD+FORCED+ACCREL", skipIf(notForced || accRelLow));
      add("OLD+FORCED+ACCREL2", skipIf(notForced || accRelLow2));
      const why =
        [
          notForced ? "FORCED" : "",
          accShort15 ? "ACC<15m" : "",
          accRelLow ? "ACC<med" : "",
          share25 ? "SHARE<25%" : "",
          confSmall ? "CONF" : "",
        ]
          .filter(Boolean)
          .join(",") || "-";
      const sp = (v: number): string =>
        (Number.isFinite(v)
          ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
          : "n/a"
        ).padStart(6);
      const k$ = (v: number): string =>
        !Number.isFinite(v)
          ? "n/a"
          : v >= 1e6
            ? `${(v / 1e6).toFixed(2)}M`
            : v >= 1e3
              ? `${(v / 1e3).toFixed(1)}K`
              : v.toFixed(0);
      console.log(
        `${stamp(entryTs)}  ${String(t.symbol).padEnd(9)} ${long ? "BUY " : "SELL"}  ${cell(live, 16)}| ${cell(rOld, 16)}${cell(rT24, 16)}| ${sp(c12)} ${st.padStart(5)}${against ? "(vs)" : "    "} | ${Number.isFinite(forcedShown) ? (100 * forcedShown).toFixed(1).padStart(5) : "  n/a"}  ${Number.isFinite(medShown) ? (100 * medShown).toFixed(1).padStart(4) : " n/a"}${q ? "*" : " "} | ${Number.isFinite(accMin) ? String(Math.round(accMin)).padStart(6) : "   n/a"} ${Number.isFinite(accPct) ? accPct.toFixed(2).padStart(6) : "   n/a"} ${Number.isFinite(accMed) ? accMed.toFixed(2).padStart(5) : "  n/a"}(${String(accPrev.length).padStart(2)}) ${Number.isFinite(accMed) && accMed > 0 && Number.isFinite(accPct) ? (accPct / accMed).toFixed(1).padStart(4) : " n/a"} ${Number.isFinite(share) ? `${Math.round(100 * share)}%`.padStart(6) : "   n/a"} | ${k$(conf).padStart(7)} ${k$(typical).padStart(7)} -> ${why}`,
      );
    }
    console.log("\n=== TOTAL (net R after fees; SKIP = no trade) ===");
    for (const [rule, t] of tot) {
      const done = t.tp + t.sl;
      console.log(
        `${rule.padEnd(17)} TP ${String(t.tp).padStart(2)}  SL ${String(t.sl).padStart(2)}  time ${t.time}  open ${t.open}  skip ${String(t.skip).padStart(2)}  win ${done ? ((100 * t.tp) / done).toFixed(0).padStart(3) : "n/a"}%  netR ${t.net >= 0 ? "+" : ""}${t.net.toFixed(2)}`,
      );
    }
    console.log(
      "chg = price change before the entry, + = in our trade's direction. 1h-struct: last two 1h swings (5-candle): UP = higher highs+lows, DOWN = lower; (vs) = the trade is against it.",
    );
    console.log(
      "T12/T24 = time stop: still open after 12h/24h -> closed at market. TREND = skip trades against the 1h structure. CHG12 = skip when the last 12h went >= 1% against the trade.",
    );
    console.log(
      "acc = new positions: minutes and OI % from the lowest OI to the OI turn; share = that rise / the OI the cleaning closed. conf$ = the other side's liquidations from the turn to the entry; typ$ = the coin's typical liquidation minute (48h).",
    );
    console.log(
      "ACC15/ACC30 = skip if the accumulation lasted < 15/30 min; SHARE25 = skip if < 25% re-opened; CONF = skip if conf$ < typ$.",
    );
    console.log(
      "med(n) = median acc% of this coin's previous episodes (last 3 days, n of them); x = this acc% / that median. ACCREL = skip if x < 1 (smaller than usual); ACCREL2 = skip if x < 2. Needs n >= 3.",
    );
    console.log(
      "forced% with * = the live engine's own numbers (what REAL users were filtered with); without * = recomputed here.",
    );
    console.log(
      "LIVE = what really happened. OLD should match LIVE for signals opened before OITURN went live (Sep 25 17:22 UTC); small differences = minute bars vs live 1-second prices.",
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
