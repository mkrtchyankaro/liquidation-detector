/**
 * ZONES (Johnny, Sep 28 2026): were the real V9 signals taken AT a support /
 * resistance zone of the 1h and 4h candles? Read-only.
 *
 * Idea: the TP signals seem to be where the price had already turned before
 * (buyers and sellers "fought" there), e.g. SUI Sep 24 at 0.9357 (turned there
 * on Sep 21 and 23) or AVAX 10.03-10.05 (Sep 23, 24, 25). The last AVAX BUY
 * (Sep 28 05:46, SL) was far above that zone.
 *
 * Per signal, only with candles that were FINISHED before the episode started
 * (no look-ahead, the episode's own low is not used):
 *   - turning points: 1h swing lows (5 candles: 2 each side) and 4h swing
 *     lows (3 candles: 1 each side) of the last N days (BUY; SELL = highs)
 *   - the tested price: the episode extreme (lowest low since the episode
 *     start for a BUY = where the cleaning pushed the price and it held)
 *   - dist = the nearest turning point vs that price, in %
 *     (- = the price went through it, + = it stopped above it; BUY)
 *   - touches = how many turning points lie within the tolerance of it
 * "in zone" = at least 1 turning point within the tolerance on 1h or 4h.
 * cover% = how much of the N-day price range is "in a zone" by chance: if it is
 * high, being in a zone means little (every price is near some old swing).
 *
 *   npx tsx src/tools/v9-zones.ts                 (main's fills, 7 days back, 0.5%)
 *   npx tsx src/tools/v9-zones.ts --days 10 --tol 0.3 --user main
 *   npx tsx src/tools/v9-zones.ts --bounce 3      (only STRONG swings: the price went >= 3% away from them)
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const MIN = 60_000,
  H = 3_600_000;
const stamp = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const fp = (v: number): string =>
  !Number.isFinite(v)
    ? "n/a"
    : v >= 100
      ? v.toFixed(1)
      : v >= 1
        ? v.toFixed(3)
        : v.toFixed(4);

interface Candle {
  ts: number;
  high: number;
  low: number;
}
type Pt = { ts: number; price: number };

/** Candles of `span` ms from minute bars; only those finished by `until`. Binance 4h starts at 00/04/08.. UTC. */
export function candlesOf(
  bars: ReadonlyArray<Candle>,
  span: number,
  from: number,
  until: number,
): Candle[] {
  const by = new Map<number, Candle>();
  for (const b of bars) {
    const s = Math.floor(b.ts / span) * span;
    if (s < from || s + span > until) continue;
    const c = by.get(s);
    if (!c) by.set(s, { ts: s, high: b.high, low: b.low });
    else {
      c.high = Math.max(c.high, b.high);
      c.low = Math.min(c.low, b.low);
    }
  }
  return [...by.values()].sort((a, b) => a.ts - b.ts);
}

/** Swing points: a candle whose low (high) is below (above) the k candles on each side. Confirmed ones only. */
export function turningPoints(
  c: readonly Candle[],
  kind: "LOW" | "HIGH",
  k: number,
): Pt[] {
  const out: Pt[] = [];
  for (let i = k; i < c.length - k; i++) {
    const v = kind === "LOW" ? c[i].low : c[i].high;
    let ok = true;
    for (let j = i - k; j <= i + k && ok; j++)
      if (j !== i && (kind === "LOW" ? !(v < c[j].low) : !(v > c[j].high)))
        ok = false;
    if (ok) out.push({ ts: c[i].ts, price: v });
  }
  return out;
}

/**
 * How far the price went away from each swing before the level broke (BUY: highest high after a swing
 * low, until a later low goes under it). A "strong" zone = a swing the price really bounced from.
 */
export function withBounce(
  c: readonly Candle[],
  pts: readonly Pt[],
  kind: "LOW" | "HIGH",
): Array<Pt & { bouncePct: number }> {
  return pts.map((p) => {
    let far = p.price;
    for (const x of c) {
      if (x.ts <= p.ts) continue;
      if (kind === "LOW" ? x.low < p.price : x.high > p.price) break;
      far = kind === "LOW" ? Math.max(far, x.high) : Math.min(far, x.low);
    }
    return { ...p, bouncePct: (100 * Math.abs(far - p.price)) / p.price };
  });
}

/** dist (signed, % of price; + = price stayed on "our" side of the level) to the nearest point, and touches within tol %. */
export function zoneOf(
  points: readonly Pt[],
  price: number,
  long: boolean,
  tolPct: number,
): { dist: number; level: number; touches: number; lastTs: number } {
  let best: Pt | null = null;
  for (const p of points)
    if (!best || Math.abs(p.price - price) < Math.abs(best.price - price))
      best = p;
  if (!best) return { dist: NaN, level: NaN, touches: 0, lastTs: NaN };
  const near = points.filter(
    (p) => (100 * Math.abs(p.price - price)) / price <= tolPct,
  );
  const dist = ((100 * (price - best.price)) / price) * (long ? 1 : -1);
  return {
    dist,
    level: best.price,
    touches: near.length,
    lastTs: near.length ? Math.max(...near.map((p) => p.ts)) : NaN,
  };
}

/** Share of the price range [lo, hi] that lies within tol % of some point: how easy it is to be "in a zone" by chance. */
function cover(
  points: readonly Pt[],
  lo: number,
  hi: number,
  tolPct: number,
): number {
  if (!points.length || !(hi > lo)) return NaN;
  let inside = 0;
  const n = 400;
  for (let i = 0; i <= n; i++) {
    const p = lo + ((hi - lo) * i) / n;
    if (points.some((q) => (100 * Math.abs(q.price - p)) / p <= tolPct))
      inside++;
  }
  return inside / (n + 1);
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"),
    days = Number(arg("days", "7")),
    tol = Number(arg("tol", "0.5")),
    minBounce = Number(arg("bounce", "0"));
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
    console.log(
      `\n=== ZONES: ${trades.length} real V9 signals of "${user}", turning points of the last ${days} days before each episode, tolerance ${tol}%${minBounce > 0 ? `, only STRONG swings (price bounced >= ${minBounce}% from them)` : ""} ===`,
    );
    console.log(
      "BUY: support = old 1h/4h swing LOWS under the price; SELL: resistance = old swing HIGHS. tested = the episode extreme (where the cleaning pushed the price).",
    );
    console.log(
      "ENTRY UTC    SYMBOL    SIDE  RESULT       entry     tested  | 1h: level   dist   touch | 4h: level   dist   touch | 1h h  cover1h cover4h | ZONE?",
    );
    type Row = {
      res: string;
      netR: number;
      in1: boolean;
      in4: boolean;
      t2: boolean;
      n1: number;
      d1: number;
      d4: number;
      c1: number;
      c4: number;
    };
    const rows: Row[] = [];
    for (const t of trades) {
      const d = await db
        .collection("v9_decisions")
        .findOne({ signalId: t.signalId });
      if (!d) continue;
      const long = t.side === "LONG",
        entry = Number(t.entryPrice),
        now = num(d.evaluatedAt),
        start = num(d.episodeStart);
      const from = start - days * 24 * H;
      const raw = await db
        .collection(MINUTE_BARS)
        .find({
          symbol: t.symbol,
          ts: { $gte: new Date(from - 4 * H), $lte: new Date(now) },
        })
        .project({ ts: 1, high: 1, low: 1 })
        .sort({ ts: 1 })
        .toArray();
      const bars: Candle[] = raw
        .map((r) => ({
          ts: num(r.ts),
          high: Number(r.high),
          low: Number(r.low),
        }))
        .filter((b) => b.high > 0 && b.low > 0);
      // the tested price: the episode extreme up to the decision
      const ep = bars.filter(
        (b) => b.ts >= Math.floor(start / MIN) * MIN && b.ts <= now,
      );
      const tested = long
        ? Math.min(...ep.map((b) => b.low))
        : Math.max(...ep.map((b) => b.high));
      // candles finished before the episode started (no look-ahead, the episode's own low excluded)
      const c1 = candlesOf(bars, H, from, start),
        c4 = candlesOf(bars, 4 * H, from, start);
      const kind = long ? "LOW" : "HIGH";
      const p1 = withBounce(c1, turningPoints(c1, kind, 2), kind).filter(
        (p) => p.bouncePct >= minBounce,
      );
      const p4 = withBounce(c4, turningPoints(c4, kind, 1), kind).filter(
        (p) => p.bouncePct >= minBounce,
      );
      const z1 = zoneOf(p1, tested, long, tol),
        z4 = zoneOf(p4, tested, long, tol);
      const lo = Math.min(...c1.map((c) => c.low)),
        hi = Math.max(...c1.map((c) => c.high));
      const cv1 = cover(p1, lo, hi, tol),
        cv4 = cover(p4, lo, hi, tol);
      const res =
        t.state === "CLOSED"
          ? t.closeReason === "TP_FILLED"
            ? "TP"
            : t.closeReason === "SL_FILLED"
              ? "SL"
              : String(t.closeReason ?? "?").replace("_FILLED", "")
          : String(t.state);
      const netR = t.pnlR !== null && t.pnlR !== undefined ? Number(t.pnlR) : 0;
      const in1 = z1.touches >= 1,
        in4 = z4.touches >= 1;
      rows.push({
        res,
        netR,
        in1,
        in4,
        t2: z1.touches + z4.touches >= 2,
        n1: z1.touches,
        d1: z1.dist,
        d4: z4.dist,
        c1: cv1,
        c4: cv4,
      });
      const dd = (v: number): string =>
        (Number.isFinite(v)
          ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
          : "n/a"
        ).padStart(7);
      const pc = (v: number): string =>
        (Number.isFinite(v) ? `${Math.round(100 * v)}%` : "n/a").padStart(6);
      console.log(
        `${stamp(num(t.createdAt))}  ${String(t.symbol).padEnd(9)} ${long ? "BUY " : "SELL"}  ${`${res} ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}`.padEnd(11)} ${fp(entry).padStart(8)} ${fp(tested).padStart(8)}  | ${fp(z1.level).padStart(9)} ${dd(z1.dist)} ${String(z1.touches).padStart(4)}   | ${fp(z4.level).padStart(9)} ${dd(z4.dist)} ${String(z4.touches).padStart(4)}   | ${String(c1.length).padStart(4)} ${pc(cv1)}  ${pc(cv4)}  | ${in1 || in4 ? `YES (${[in1 ? "1h" : "", in4 ? "4h" : ""].filter(Boolean).join("+")})` : "no"}`,
      );
    }
    const sum = (name: string, pick: (r: Row) => boolean): void => {
      const a = rows.filter(pick),
        tp = a.filter((r) => r.res === "TP").length,
        sl = a.filter((r) => r.res === "SL").length;
      const net = a.reduce((s, r) => s + r.netR, 0);
      console.log(
        `${name.padEnd(34)} trades ${String(a.length).padStart(2)}  TP ${String(tp).padStart(2)}  SL ${String(sl).padStart(2)}  win ${tp + sl ? `${Math.round((100 * tp) / (tp + sl))}%`.padStart(4) : " n/a"}  netR ${net >= 0 ? "+" : ""}${net.toFixed(2)}`,
      );
    };
    console.log(`\n=== SUMMARY (LIVE results, tolerance ${tol}%) ===`);
    sum("all", () => true);
    sum("in zone 1h or 4h", (r) => r.in1 || r.in4);
    sum("NOT in zone", (r) => !(r.in1 || r.in4));
    sum("in zone 1h", (r) => r.in1);
    sum("in zone 4h", (r) => r.in4);
    sum("in zone 1h AND 4h", (r) => r.in1 && r.in4);
    sum(">= 2 touches (1h+4h together)", (r) => r.t2);
    sum("1h touches >= 3 (many old swings here)", (r) => r.n1 >= 3);
    sum("1h touches 1-2", (r) => r.n1 >= 1 && r.n1 <= 2);
    const avg = (v: number[]): number => {
      const a = v.filter(Number.isFinite);
      return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
    };
    console.log(
      `\nchance level: on average ${Math.round(100 * avg(rows.map((r) => r.c1)))}% (1h) and ${Math.round(100 * avg(rows.map((r) => r.c4)))}% (4h) of the ${days}-day price range lies within ${tol}% of some old swing.`,
    );
    console.log(
      "If 'in zone' trades win clearly more than the others AND cover% is low, the zone means something. If cover% is high, almost every price is 'in a zone'.",
    );
    console.log(
      "dist: + = the tested price stayed on our side of the level (BUY: above the old low), - = it went through it. touch = old swings within the tolerance. 1h h = 1h candles used.",
    );
  } finally {
    await client.close();
  }
}

if (require.main === module)
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
