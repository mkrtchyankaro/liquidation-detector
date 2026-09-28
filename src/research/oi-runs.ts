/**
 * OI ACCUMULATION RUNS (Johnny, Sep 28 2026): where the open interest grew minute after minute.
 * Only our own minute_bars, always looking back.
 *
 * A RUN starts when the OI grows from one minute to the next and goes on while it keeps growing.
 * Small pauses do not break it: the run ends when the OI has not made a new high for `pause` minutes,
 * or when it gave back more than `giveBack` (30%) of what it gained. The run ends at its OI peak.
 *   usd    = (peak OI - start OI) * price    -- new positions opened in the run
 *   price  = the price where the OI was added (weighted by each minute's OI increase)
 *   dir    = what the price did during the run (UP: new longs pushed it, DOWN: new shorts) -- info only
 *   at     = the minute with the biggest OI increase (the circle goes on the candle that holds it)
 *   rank   = its place among the runs of the same UTC day by $ (1 = the largest of that day)
 */
export interface OiRow {
  ts: number;
  high: number;
  low: number;
  close: number;
  oi: number;
}
export interface OiRun {
  from: number;
  to: number;
  minutes: number;
  usd: number;
  oiPct: number;
  price: number;
  lo: number;
  hi: number;
  dir: "UP" | "DOWN";
  movePct: number;
  at: number;
  atPrice: number;
  rank: number;
  xNormal: number;
}

const MIN = 60_000;

export function findRuns(
  rows: readonly OiRow[],
  pause = 3,
  giveBack = 0.3,
): OiRun[] {
  const r = rows.filter((x) => x.oi > 0 && x.close > 0);
  const out: OiRun[] = [];
  let s = -1,
    peak = 0,
    peakI = -1;
  const close = (): void => {
    if (s < 0 || peakI <= s) {
      s = -1;
      return;
    }
    const startOi = r[s].oi;
    let w = 0,
      wp = 0,
      lo = Infinity,
      hi = -Infinity,
      best = s + 1,
      bestD = -Infinity;
    for (let i = s + 1; i <= peakI; i++) {
      const d = r[i].oi - r[i - 1].oi;
      if (d > 0) {
        w += d;
        wp += d * r[i].close;
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
      lo = Math.min(lo, r[i].low > 0 ? r[i].low : r[i].close);
      hi = Math.max(hi, r[i].high > 0 ? r[i].high : r[i].close);
    }
    const price = w > 0 ? wp / w : r[peakI].close;
    out.push({
      from: r[s + 1].ts,
      to: r[peakI].ts + MIN,
      minutes: Math.round((r[peakI].ts - r[s].ts) / MIN),
      usd: (peak - startOi) * price,
      oiPct: (100 * (peak - startOi)) / startOi,
      price,
      lo,
      hi,
      dir: r[peakI].close >= r[s].close ? "UP" : "DOWN",
      movePct: (100 * (r[peakI].close - r[s].close)) / r[s].close,
      at: r[best].ts,
      atPrice: r[best].close,
      rank: 0,
      xNormal: 0,
    });
    s = -1;
  };
  for (let i = 1; i < r.length; i++) {
    const gap = r[i].ts - r[i - 1].ts > 5 * MIN; // a hole in the data breaks the run
    if (s >= 0 && gap) close();
    if (s < 0) {
      if (!gap && r[i].oi > r[i - 1].oi) {
        s = i - 1;
        peak = r[i].oi;
        peakI = i;
      }
      continue;
    }
    if (r[i].oi > peak) {
      peak = r[i].oi;
      peakI = i;
      continue;
    }
    const gained = peak - r[s].oi;
    if (i - peakI > pause || peak - r[i].oi > giveBack * gained) {
      close();
      if (r[i].oi > r[i - 1].oi) {
        s = i - 1;
        peak = r[i].oi;
        peakI = i;
      }
    }
  }
  close();
  return out;
}

/** Ranks the runs inside each UTC day by $ (1 = the largest of that day). */
export function rankRuns(runs: OiRun[]): OiRun[] {
  const sizes = runs.map((x) => x.usd).sort((a, b) => a - b);
  const med = sizes.length ? sizes[sizes.length >> 1] : 0;
  const byDay = new Map<number, OiRun[]>();
  for (const x of runs) {
    x.xNormal = med > 0 ? x.usd / med : 0;
    const d = Math.floor(x.at / 86_400_000);
    byDay.set(d, [...(byDay.get(d) ?? []), x]);
  }
  for (const day of byDay.values())
    day
      .sort((a, b) => b.usd - a.usd)
      .forEach((x, i) => {
        x.rank = i + 1;
      });
  return runs;
}

const usd = (v: number): string =>
  v >= 1e9
    ? `$${(v / 1e9).toFixed(2)}B`
    : v >= 1e6
      ? `$${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
        ? `$${(v / 1e3).toFixed(0)}K`
        : `$${v.toFixed(0)}`;
const hm = (ms: number): string =>
  new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");

/** Pine v6: one circle per run, on the candle that holds its strongest minute, at the price where the OI was added. */
export function runsPine(
  coins: ReadonlyArray<{ symbol: string; runs: readonly OiRun[] }>,
  madeAt: number,
  maxPerDay = 10,
): string {
  const p = (v: number): number => +v.toPrecision(7);
  const L: string[] = [
    "//@version=6",
    `indicator("liquidation-detector: OI accumulations", overlay=true, max_labels_count=500, max_lines_count=500)`,
    "// Circle = the open interest grew minute after minute (new positions), at the price where the OI was added.",
    "// Darker = more $ (compared with the largest of that day). Green: the price went up meanwhile, red: down. Hover a circle.",
    `// made ${new Date(madeAt).toISOString().slice(0, 16)} UTC -- a snapshot`,
    `perDay = input.int(${maxPerDay}, "largest per day (UTC)", minval=1, maxval=${maxPerDay})`,
    `lines = input.bool(false, "price line to the right")`,
    "// put the circle on the candle that holds the time (TradingView would move it to the NEXT candle otherwise)",
    "barOf(t) =>",
    "    ms = timeframe.in_seconds() * 1000",
    "    t - t % ms",
    "dot(on, t, y, tr, col, tip, rank) =>",
    "    show = on and barstate.islastconfirmedhistory and rank <= perDay",
    "    if show",
    '        label.new(barOf(t), y, "", xloc=xloc.bar_time, style=label.style_circle, size=size.small, color=color.new(col, tr), textcolor=col, tooltip=tip)',
    "        if lines",
    "            line.new(barOf(t), y, barOf(t) + 60000, y, xloc=xloc.bar_time, extend=extend.right, color=color.new(col, 60), style=line.style_dotted)",
    "    show",
  ];
  coins.forEach((c, k) => {
    const shown = c.runs.filter((x) => x.rank >= 1 && x.rank <= maxPerDay);
    if (!shown.length) return;
    L.push(
      `c${k} = str.startswith(syminfo.ticker, "${c.symbol.toUpperCase()}")`,
    );
    const dayMax = new Map<number, number>();
    for (const x of shown) {
      const d = Math.floor(x.at / 86_400_000);
      dayMax.set(d, Math.max(dayMax.get(d) ?? 0, x.usd));
    }
    for (const x of shown) {
      const f = x.usd / (dayMax.get(Math.floor(x.at / 86_400_000)) ?? x.usd);
      const tr = f > 0.66 ? 0 : f > 0.33 ? 35 : 65;
      const col = x.dir === "UP" ? "color.green" : "color.red";
      const tip = `#${x.rank} of the day: +${usd(x.usd)} OI (+${x.oiPct.toFixed(2)}%) | ${hm(x.from)}-${hm(x.to).slice(6)} Yerevan, ${x.minutes} min | at ${p(x.price)}, price ${x.movePct >= 0 ? "+" : ""}${x.movePct.toFixed(2)}%`;
      L.push(
        `dot(c${k}, ${x.at}, ${p(x.price)}, ${tr}, ${col}, "${tip}", ${x.rank})`,
      );
    }
  });
  return L.join("\n") + "\n";
}
