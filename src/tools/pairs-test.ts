/**
 * PAIRS THAT MOVE TOGETHER -- when they split, bet they come back (Johnny, Oct 6 2026). Read-only, Binance public data.
 * Every day at 00:00 UTC, using ONLY the last WINDOW days (1h closes, no look-ahead):
 *   1. every pair of alts (SYMBOLS, no BTC / ETH): the correlation of their hourly % moves -> the TOP --pairs most
 *      correlated pairs = today's pairs
 *   2. for each: spread = ln(price A) - ln(price B); its mean and spread over the window -> z = how far it is now
 * Every hour, for today's pairs (closed 1h candles):
 *   ENTER when |z| >= ENTRY: SHORT the one that ran ahead, LONG the one that fell behind, the same $ on both legs
 *   EXIT  when z comes back to 0 (the gap closed) -- no price stop, no TP. A pair dropped from the list stays open until
 *   its gap closes (its mean / spread frozen at entry). Still open at the end -> shown at the last price, marked OPEN.
 * Fees --fee % per side on every leg (4 per trade) + funding. Capital split into --pairs equal slots.
 * Shown: for every WINDOW x ENTRY -- the whole --days, each 7-day week (by the exit hour), trades, wins, the worst
 * trade, the average hold.
 *
 *   npx tsx src/tools/pairs-test.ts
 *   options: --days 30  --pairs 5  --fee 0.05  --symbols A,B  --list (every trade of the default setup: 7d, z 2)
 */
import "dotenv/config";
import axios from "axios";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const H = 3_600_000,
  D = 24 * H,
  WEEK = 7 * D,
  SKIP = ["BTCUSDT", "ETHUSDT"];
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});

async function closes1h(
  sym: string,
  from: number,
  to: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let start = from; start < to; ) {
    const rows: unknown[][] = (
      await fapi.get("/fapi/v1/klines", {
        params: {
          symbol: sym,
          interval: "1h",
          startTime: start,
          endTime: to - 1,
          limit: 1500,
        },
      })
    ).data;
    for (const r of rows)
      if (Number(r[0]) + H <= Date.now())
        out.set(Number(r[0]) + H, Number(r[4])); // keyed by the hour's END
    if (rows.length < 1500) break;
    start = Number(rows[rows.length - 1][0]) + H;
  }
  return out;
}
async function funding(
  sym: string,
  from: number,
  to: number,
): Promise<Array<{ t: number; rate: number }>> {
  const out: Array<{ t: number; rate: number }> = [];
  for (let start = from; start < to; ) {
    const rows: Array<{ fundingTime: number; fundingRate: string }> = (
      await fapi.get("/fapi/v1/fundingRate", {
        params: { symbol: sym, startTime: start, endTime: to, limit: 1000 },
      })
    ).data;
    for (const r of rows)
      out.push({ t: Number(r.fundingTime), rate: Number(r.fundingRate) });
    if (rows.length < 1000) break;
    start = Number(rows[rows.length - 1].fundingTime) + 1;
  }
  return out;
}

interface Trade {
  a: string;
  b: string;
  t0: number;
  t1: number;
  shortA: boolean;
  z0: number;
  ret: number;
  open: boolean;
  corr: number;
}

async function main(): Promise<void> {
  const days = Number(arg("days", "30")),
    nPairs = Number(arg("pairs", "5")),
    fee = Number(arg("fee", "0.05")) / 100;
  const WINDOWS = [3, 7, 14],
    ENTRIES = [2, 2.5];
  const now = Math.floor(Date.now() / H) * H,
    testFrom = Math.ceil((now - days * D) / D) * D,
    from = testFrom - Math.max(...WINDOWS) * D - H;
  const syms = (
    argv.includes("--symbols")
      ? arg("symbols", "")
      : (process.env.SYMBOLS ?? "")
  )
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x && !SKIP.includes(x));
  const px = new Map<string, Map<number, number>>(),
    fund = new Map<string, Array<{ t: number; rate: number }>>();
  for (const s of syms) {
    process.stderr.write(`\r${s}          `);
    try {
      const c = await closes1h(s, from, now);
      if (!c.has(from + H) || !c.has(now)) {
        console.log(`${s}: not enough history -- skipped`);
        continue;
      }
      px.set(s, c);
      fund.set(s, await funding(s, testFrom, now));
    } catch (err) {
      console.log(`${s}: ${err instanceof Error ? err.message : err}`);
    }
  }
  process.stderr.write("\n");
  const coins = [...px.keys()];
  if (coins.length < 4) throw new Error(`only ${coins.length} coins`);
  const lp = (s: string, t: number): number => {
    const v = px.get(s)!.get(t);
    return v ? Math.log(v) : NaN;
  };

  /** today's pairs from the window ending at `day`: [a, b, corr, mean, sd] */
  const pick = (
    day: number,
    wDays: number,
  ): Array<{
    a: string;
    b: string;
    corr: number;
    mean: number;
    sd: number;
  }> => {
    const hours: number[] = [];
    for (let t = day - wDays * D + H; t <= day; t += H) hours.push(t);
    const rets = new Map<string, number[]>();
    for (const s of coins)
      rets.set(
        s,
        hours.map((t) => lp(s, t) - lp(s, t - H)),
      );
    const out: Array<{
      a: string;
      b: string;
      corr: number;
      mean: number;
      sd: number;
    }> = [];
    for (let i = 0; i < coins.length; i++)
      for (let j = i + 1; j < coins.length; j++) {
        const x = rets.get(coins[i])!,
          y = rets.get(coins[j])!;
        let n = 0,
          sx = 0,
          sy = 0,
          sxx = 0,
          syy = 0,
          sxy = 0;
        for (let k = 0; k < x.length; k++) {
          if (!Number.isFinite(x[k]) || !Number.isFinite(y[k])) continue;
          n++;
          sx += x[k];
          sy += y[k];
          sxx += x[k] ** 2;
          syy += y[k] ** 2;
          sxy += x[k] * y[k];
        }
        if (n < 24) continue;
        const corr =
          (n * sxy - sx * sy) /
          Math.sqrt((n * sxx - sx ** 2) * (n * syy - sy ** 2));
        const spr = hours
          .map((t) => lp(coins[i], t) - lp(coins[j], t))
          .filter(Number.isFinite);
        const mean = spr.reduce((a, v) => a + v, 0) / spr.length,
          sd = Math.sqrt(
            spr.reduce((a, v) => a + (v - mean) ** 2, 0) / spr.length,
          );
        if (Number.isFinite(corr) && sd > 0)
          out.push({ a: coins[i], b: coins[j], corr, mean, sd });
      }
    return out.sort((p, q) => q.corr - p.corr).slice(0, nPairs);
  };

  const legRet = (s: string, t0: number, t1: number, long: boolean): number => {
    const p0 = px.get(s)!.get(t0),
      p1 = px.get(s)!.get(t1);
    if (!p0 || !p1) return 0;
    let r = long ? p1 / p0 - 1 : 1 - p1 / p0;
    for (const f of fund.get(s) ?? [])
      if (f.t > t0 && f.t <= t1) r += long ? -f.rate : f.rate;
    return r;
  };

  const run = (wDays: number, entry: number): Trade[] => {
    const trades: Trade[] = [];
    const open = new Map<
      string,
      {
        a: string;
        b: string;
        t0: number;
        shortA: boolean;
        z0: number;
        mean: number;
        sd: number;
        corr: number;
      }
    >();
    let today: ReturnType<typeof pick> = [];
    for (let t = testFrom; t <= now; t += H) {
      if (t % D === 0) today = pick(t, wDays);
      // exits first (the gap closed: z crossed 0)
      for (const [k, o] of open) {
        const z = (lp(o.a, t) - lp(o.b, t) - o.mean) / o.sd;
        if (!Number.isFinite(z)) continue;
        if (o.shortA ? z <= 0 : z >= 0) {
          const ret =
            (legRet(o.a, o.t0, t, !o.shortA) + legRet(o.b, o.t0, t, o.shortA)) /
              2 -
            2 * fee;
          trades.push({
            a: o.a,
            b: o.b,
            t0: o.t0,
            t1: t,
            shortA: o.shortA,
            z0: o.z0,
            ret,
            open: false,
            corr: o.corr,
          });
          open.delete(k);
        }
      }
      // entries: today's pairs, not already open, a free slot
      for (const p of today) {
        const k = `${p.a}|${p.b}`;
        if (open.has(k) || open.size >= nPairs || t === now) continue;
        const z = (lp(p.a, t) - lp(p.b, t) - p.mean) / p.sd;
        if (!(Math.abs(z) >= entry)) continue;
        open.set(k, {
          a: p.a,
          b: p.b,
          t0: t,
          shortA: z > 0,
          z0: z,
          mean: p.mean,
          sd: p.sd,
          corr: p.corr,
        });
      }
    }
    for (const o of open.values()) {
      const ret =
        (legRet(o.a, o.t0, now, !o.shortA) + legRet(o.b, o.t0, now, o.shortA)) /
          2 -
        2 * fee;
      trades.push({
        a: o.a,
        b: o.b,
        t0: o.t0,
        t1: now,
        shortA: o.shortA,
        z0: o.z0,
        ret,
        open: true,
        corr: o.corr,
      });
    }
    return trades.sort((x, y) => x.t1 - y.t1);
  };

  const weeks: Array<[number, number]> = [];
  for (let e = now + 1; e - WEEK >= testFrom - 1; e -= WEEK)
    weeks.unshift([e - WEEK, e]);
  // % on the whole capital: every trade uses 1 / --pairs of it
  const tot = (l: Trade[]): number =>
    (100 * l.reduce((a, x) => a + x.ret, 0)) / nPairs;
  console.log(
    `PAIRS THAT MOVE TOGETHER · ${coins.length} coins · ${utc(testFrom)} -> ${utc(now)} UTC (${days} days) · top ${nPairs} pairs picked every day at 00:00 UTC from the last WINDOW days`,
  );
  console.log(
    `enter when the gap is >= ENTRY standard deviations (short the one ahead, long the one behind) · exit when the gap is back to normal · no stop, no TP · fee ${fee * 100}%/side + funding`,
  );
  console.log(
    `% on the whole capital (${nPairs} equal slots) · weeks by the exit hour: ${weeks.map(([a]) => utc(a).slice(0, 5)).join(" | ")}\n`,
  );
  for (const w of WINDOWS)
    for (const e of ENTRIES) {
      const tr = run(w, e),
        closed = tr.filter((x) => !x.open);
      const wk = weeks.map(([a, b]) =>
        tot(tr.filter((x) => x.t1 >= a && x.t1 < b)),
      );
      const wins = closed.filter((x) => x.ret > 0).length,
        worst = Math.min(...tr.map((x) => x.ret)),
        hold =
          closed.reduce((a, x) => a + (x.t1 - x.t0), 0) /
          (closed.length || 1) /
          H;
      console.log(
        `  window ${String(w).padStart(2)}d · entry ${e.toFixed(1)}σ  ${sp(tot(tr)).padStart(8)}% │ ${wk.map((v) => `${sp(v, 1).padStart(6)}%`).join(" ")} │ weeks + ${wk.filter((v) => v > 0).length}/${wk.length} │ ${String(closed.length).padStart(3)} closed, win ${closed.length ? Math.round((100 * wins) / closed.length) : 0}% · ${tr.length - closed.length} OPEN ${sp(tot(tr.filter((x) => x.open)), 1)}% │ worst trade ${sp(100 * worst, 1)}% · avg hold ${hold.toFixed(0)}h`,
      );
    }
  if (argv.includes("--list")) {
    console.log(`\nevery trade · window 7d · entry 2σ:`);
    for (const x of run(7, 2)) {
      const S = (s: string): string => s.replace(/USDT$/, "");
      const sh = x.shortA ? x.a : x.b,
        lo = x.shortA ? x.b : x.a;
      console.log(
        `  ${utc(x.t0)} -> ${utc(x.t1)} ${x.open ? "OPEN " : "     "} SHORT ${S(sh).padEnd(6)} LONG ${S(lo).padEnd(6)} corr ${x.corr.toFixed(2)} · gap ${x.z0.toFixed(1)}σ · ${sp(100 * x.ret)}%`,
      );
    }
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
