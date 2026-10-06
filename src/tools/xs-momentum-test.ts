/**
 * STRONG vs WEAK (Johnny, Oct 6 2026) -- cross-sectional momentum, read-only, Binance public data, no keys, no DB.
 * Every --rebalance hours, for every alt (SYMBOLS, no BTC / ETH): its strength = its % change over the last LOOKBACK
 * hours MINUS BTC's % change over the same hours (closed 1h candles only). Then
 *   MOMENTUM  LONG the strongest N, SHORT the weakest N      REVERSAL  the other way round
 * the same $ on every leg, entered at the close of the ranking hour, held to the next rebalance. Fees --fee % per side
 * on every leg that is opened or closed (a coin kept for the next period is not traded); funding paid / received at
 * every funding time inside the hold (Binance fundingRate). No stop loss.
 *   result = % on the whole capital (all legs together); shown for the whole --days, for each 7-day week (the newest
 *   last) and the last 7 days, plus the share of periods that made money and the worst drawdown.
 * Every combination of LOOKBACK x REBALANCE x N x MOMENTUM / REVERSAL is run; the best one of many is partly luck --
 * believe only what makes money in EVERY week.
 *
 *   npx tsx src/tools/xs-momentum-test.ts
 *   options: --days 30  --fee 0.05  --top 20  --symbols A,B,C  --list (the picks of the default setup)
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
  W = 7 * D,
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
    // the close of the hour that STARTS at r[0] is known at r[0] + 1h -> keyed by its END
    for (const r of rows)
      if (Number(r[0]) + H <= Date.now())
        out.set(Number(r[0]) + H, Number(r[4]));
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

interface Period {
  t: number;
  ret: number;
  longs: string[];
  shorts: string[];
}
interface Result {
  name: string;
  lb: number;
  rb: number;
  n: number;
  mode: "MOMENTUM" | "REVERSAL";
  periods: Period[];
}

async function main(): Promise<void> {
  const days = Number(arg("days", "30")),
    fee = Number(arg("fee", "0.05")) / 100,
    topK = Number(arg("top", "20"));
  const LOOKBACKS = [1, 4, 12, 24, 72],
    REBALANCES = [1, 4, 24],
    NS = [1, 3];
  const now = Math.floor(Date.now() / H) * H,
    testFrom = now - days * D,
    from = testFrom - Math.max(...LOOKBACKS) * H - D;
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
  const btc = await closes1h("BTCUSDT", from, now);
  for (const s of syms) {
    process.stderr.write(`\r${s}          `);
    try {
      const c = await closes1h(s, from, now);
      if (!c.has(from + H) || !c.has(now)) {
        console.log(`${s}: not enough history (listed later?) -- skipped`);
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
  if (coins.length < 7)
    throw new Error(`only ${coins.length} coins with full history`);

  const run = (
    lb: number,
    rb: number,
    n: number,
    mode: "MOMENTUM" | "REVERSAL",
    off = 0,
  ): Result => {
    const periods: Period[] = [];
    let held: { longs: string[]; shorts: string[] } = { longs: [], shorts: [] };
    // rebalance times aligned to the rebalance length (e.g. 24h -> 00:00 UTC)
    for (
      let t = Math.ceil((testFrom - off * H) / (rb * H)) * rb * H + off * H;
      t + rb * H <= now;
      t += rb * H
    ) {
      const b0 = btc.get(t - lb * H),
        b1 = btc.get(t);
      if (!b0 || !b1) continue;
      const rank = coins
        .map((s) => {
          const c = px.get(s)!,
            a0 = c.get(t - lb * H),
            a1 = c.get(t);
          return { s, v: a0 && a1 ? a1 / a0 - b1 / b0 : NaN };
        })
        .filter((x) => Number.isFinite(x.v))
        .sort((x, y) => y.v - x.v);
      if (rank.length < 2 * n + 1) continue;
      const strong = rank.slice(0, n).map((x) => x.s),
        weak = rank.slice(-n).map((x) => x.s);
      const longs = mode === "MOMENTUM" ? strong : weak,
        shorts = mode === "MOMENTUM" ? weak : strong;
      // fees: every leg opened or closed now (both the closing of the old and the opening of the new)
      const legs = 2 * n;
      let traded = 0;
      for (const s of longs) if (!held.longs.includes(s)) traded++;
      for (const s of shorts) if (!held.shorts.includes(s)) traded++;
      for (const s of held.longs) if (!longs.includes(s)) traded++;
      for (const s of held.shorts) if (!shorts.includes(s)) traded++;
      let ret = -(traded * fee) / legs;
      for (const s of longs) {
        const c = px.get(s)!,
          p0 = c.get(t),
          p1 = c.get(t + rb * H);
        if (p0 && p1) ret += (p1 / p0 - 1) / legs;
        for (const f of fund.get(s) ?? [])
          if (f.t > t && f.t <= t + rb * H) ret -= f.rate / legs; // longs pay a positive rate
      }
      for (const s of shorts) {
        const c = px.get(s)!,
          p0 = c.get(t),
          p1 = c.get(t + rb * H);
        if (p0 && p1) ret += (1 - p1 / p0) / legs;
        for (const f of fund.get(s) ?? [])
          if (f.t > t && f.t <= t + rb * H) ret += f.rate / legs; // shorts receive it
      }
      periods.push({ t, ret, longs, shorts });
      held = { longs, shorts };
    }
    return {
      name: `${mode === "MOMENTUM" ? "MOM" : "REV"} look ${String(lb).padStart(2)}h · every ${String(rb).padStart(2)}h · ${n}+${n}`,
      lb,
      rb,
      n,
      mode,
      periods,
    };
  };

  const results: Result[] = [];
  for (const lb of LOOKBACKS)
    for (const rb of REBALANCES)
      for (const n of NS)
        for (const mode of ["MOMENTUM", "REVERSAL"] as const)
          results.push(run(lb, rb, n, mode));

  // weeks: 7-day blocks ending now (the newest last)
  const weeks: Array<[number, number]> = [];
  for (let e = now; e - W >= testFrom - 1; e -= W) weeks.unshift([e - W, e]);
  const sum = (p: Period[]): number =>
    100 * (p.reduce((a, x) => a * (1 + x.ret), 1) - 1);
  const dd = (p: Period[]): number => {
    let eq = 1,
      peak = 1,
      m = 0;
    for (const x of p) {
      eq *= 1 + x.ret;
      peak = Math.max(peak, eq);
      m = Math.min(m, eq / peak - 1);
    }
    return 100 * m;
  };
  const row = (r: Result): string => {
    const wk = weeks.map(([a, b]) =>
      sum(r.periods.filter((x) => x.t >= a && x.t < b)),
    );
    const pos = r.periods.length
      ? (100 * r.periods.filter((x) => x.ret > 0).length) / r.periods.length
      : 0;
    return `  ${r.name.padEnd(34)} ${sp(sum(r.periods)).padStart(8)}% │ ${wk.map((v) => `${sp(v, 1).padStart(6)}%`).join(" ")} │ weeks + ${wk.filter((v) => v > 0).length}/${wk.length} │ periods + ${pos.toFixed(0).padStart(2)}% │ worst dd ${dd(r.periods).toFixed(1).padStart(6)}%`;
  };
  console.log(
    `STRONG vs WEAK vs BTC · ${coins.length} coins · ${utc(testFrom)} -> ${utc(now)} UTC (${days} days) · fee ${fee * 100}%/side + funding · no stop loss · % on the whole capital`,
  );
  console.log(
    `MOM = LONG the strongest, SHORT the weakest · REV = the other way · look = strength over the last N hours (alt % - BTC %) · every = rebalance`,
  );
  console.log(
    `weeks: ${weeks.map(([a]) => utc(a).slice(0, 5)).join(" | ")} (7 days each, the last one = the last 7 days)\n`,
  );
  const byAll = [...results].sort((a, b) => sum(b.periods) - sum(a.periods));
  console.log(`── the best ${topK} over ${days} days ──`);
  byAll.slice(0, topK).forEach((r) => console.log(row(r)));
  console.log(`\n── the ones that made money in EVERY week ──`);
  const every = results.filter((r) =>
    weeks.every(
      ([a, b]) => sum(r.periods.filter((x) => x.t >= a && x.t < b)) > 0,
    ),
  );
  if (every.length)
    every
      .sort((a, b) => sum(b.periods) - sum(a.periods))
      .forEach((r) => console.log(row(r)));
  else console.log("  none");
  console.log(`\n── the worst 5 ──`);
  byAll.slice(-5).forEach((r) => console.log(row(r)));
  console.log(
    `\n── the plain idea: MOM, strength over 24h, every 24h (00:00 UTC), 1+1 and 3+3 ──`,
  );
  for (const n of NS)
    console.log(
      row(
        results.find(
          (r) =>
            r.mode === "MOMENTUM" && r.lb === 24 && r.rb === 24 && r.n === n,
        )!,
      ),
    );
  // Oct 6: is it the hour or the idea? the daily setups rebalanced at every hour of the day (0 = 00:00 UTC)
  console.log(
    `\n── the daily ones at EVERY rebalance hour (UTC) -- real if it works at most hours, luck if only at one ──`,
  );
  for (const [lb, n] of [
    [4, 3],
    [1, 3],
    [4, 1],
    [1, 1],
    [24, 3],
  ] as const) {
    const rs = Array.from({ length: 24 }, (_, h) =>
      run(lb, 24, n, "MOMENTUM", h),
    );
    console.log(
      `  MOM look ${String(lb).padStart(2)}h · every 24h · ${n}+${n}: positive at ${rs.filter((r) => sum(r.periods) > 0).length}/24 hours · median ${sp([...rs.map((r) => sum(r.periods))].sort((a, b) => a - b)[12], 1)}% · every week + at ${rs.filter((r) => weeks.every(([a, b]) => sum(r.periods.filter((x) => x.t >= a && x.t < b)) > 0)).length}/24`,
    );
    for (let h = 0; h < 24; h += 4)
      console.log(
        `  ${row({ ...rs[h], name: `   at ${String(h).padStart(2, "0")}:00` })}`,
      );
  }
  console.log(
    `\n${results.length} combinations tried -- the best of many is partly luck`,
  );
  if (argv.includes("--list")) {
    const r = results.find(
      (x) => x.mode === "MOMENTUM" && x.lb === 24 && x.rb === 24 && x.n === 1,
    )!;
    console.log(`\nthe picks of MOM 24h / every 24h / 1+1:`);
    for (const p of r.periods)
      console.log(
        `  ${utc(p.t)}  LONG ${p.longs.join(",").replace(/USDT/g, "").padEnd(8)} SHORT ${p.shorts.join(",").replace(/USDT/g, "").padEnd(8)} ${sp(100 * p.ret)}%`,
      );
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
