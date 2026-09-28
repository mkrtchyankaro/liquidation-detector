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
  liqLong?: number;
  liqShort?: number;
}
/** A liquidation burst: minutes in a row where one side got liquidated (gaps up to `gap` minutes allowed). */
export interface LiqBurst {
  side: "LONG" | "SHORT";
  from: number;
  to: number;
  minutes: number;
  usd: number;
  price: number;
  at: number;
  rank: number;
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

/** Liquidation bursts of one side, ranked inside each UTC day by $ (1 = the largest of that day). */
export function findLiqBursts(
  rows: readonly OiRow[],
  side: "LONG" | "SHORT",
  gap = 2,
): LiqBurst[] {
  const out: LiqBurst[] = [];
  let cur: {
    from: number;
    last: number;
    usd: number;
    wp: number;
    at: number;
    atUsd: number;
  } | null = null;
  const done = (): void => {
    if (cur && cur.usd > 0)
      out.push({
        side,
        from: cur.from,
        to: cur.last + MIN,
        minutes: Math.round((cur.last - cur.from) / MIN) + 1,
        usd: cur.usd,
        price: cur.wp / cur.usd,
        at: cur.at,
        rank: 0,
      });
    cur = null;
  };
  for (const r of rows) {
    const v = side === "LONG" ? (r.liqLong ?? 0) : (r.liqShort ?? 0);
    if (!(v > 0) || !(r.close > 0)) continue;
    if (cur && r.ts - cur.last > (gap + 1) * MIN) done();
    if (!cur)
      cur = { from: r.ts, last: r.ts, usd: 0, wp: 0, at: r.ts, atUsd: 0 };
    cur.last = r.ts;
    cur.usd += v;
    cur.wp += v * r.close;
    if (v > cur.atUsd) {
      cur.atUsd = v;
      cur.at = r.ts;
    }
  }
  done();
  const byDay = new Map<number, LiqBurst[]>();
  for (const b of out) {
    const d = Math.floor(b.at / 86_400_000);
    byDay.set(d, [...(byDay.get(d) ?? []), b]);
  }
  for (const day of byDay.values())
    day
      .sort((x, y) => y.usd - x.usd)
      .forEach((b, i) => {
        b.rank = i + 1;
      });
  return out;
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

/** Pine v6: small circles. OI runs: green/red. Liquidation bursts: orange (longs liquidated) / blue (shorts liquidated).
 *  Each circle sits on the candle of its strongest minute; darker = bigger (compared with the largest of that day). */
export function runsPine(
  coins: ReadonlyArray<{
    symbol: string;
    runs: readonly OiRun[];
    liqs?: readonly LiqBurst[];
  }>,
  madeAt: number,
  maxPerDay = 10,
): string {
  const p = (v: number): number => +v.toPrecision(7);
  const L: string[] = [
    "//@version=6",
    `indicator("liquidation-detector: OI accumulations + liquidations", overlay=true, max_labels_count=500, max_lines_count=500)`,
    "// OI: green = the OI grew while the price went up, red = while it went down (at the price where the OI was added).",
    "// LIQUIDATIONS: orange = longs liquidated, blue = shorts liquidated (at the price where they happened).",
    "// Darker = more $ (compared with the largest of that day). Hover a circle for the details.",
    `// made ${new Date(madeAt).toISOString().slice(0, 16)} UTC -- a snapshot`,
    `showOi = input.bool(true, "OI accumulations")`,
    `oiPerDay = input.int(${maxPerDay}, "OI: largest per day (UTC)", minval=1, maxval=${maxPerDay})`,
    `showLiq = input.bool(true, "liquidations")`,
    `liqPerDay = input.int(${maxPerDay}, "liquidations: largest per day and side", minval=1, maxval=${maxPerDay})`,
    `dotSize = input.string("tiny", "circle size", options=["tiny", "small", "normal"])`,
    `lines = input.bool(false, "price line to the right")`,
    'sz = dotSize == "tiny" ? size.tiny : dotSize == "small" ? size.small : size.normal',
    "// put the circle on the candle that holds the time (TradingView would move it to the NEXT candle otherwise)",
    "barOf(t) =>",
    "    ms = timeframe.in_seconds() * 1000",
    "    t - t % ms",
    "mark(show, t, y, tr, col, tip) =>",
    "    if show and barstate.islastconfirmedhistory",
    '        label.new(barOf(t), y, "", xloc=xloc.bar_time, style=label.style_circle, size=sz, color=color.new(col, tr), textcolor=col, tooltip=tip)',
    "        if lines",
    "            line.new(barOf(t), y, barOf(t) + 60000, y, xloc=xloc.bar_time, extend=extend.right, color=color.new(col, 60), style=line.style_dotted)",
    "    show",
    "dot(on, t, y, tr, col, tip, rank) => mark(on and showOi and rank <= oiPerDay, t, y, tr, col, tip)",
    "liq(on, t, y, tr, col, tip, rank) => mark(on and showLiq and rank <= liqPerDay, t, y, tr, col, tip)",
  ];
  const trOf = <T extends { at: number; usd: number }>(
    list: readonly T[],
  ): ((x: T) => number) => {
    const dayMax = new Map<number, number>();
    for (const x of list) {
      const d = Math.floor(x.at / 86_400_000);
      dayMax.set(d, Math.max(dayMax.get(d) ?? 0, x.usd));
    }
    return (x) => {
      const f = x.usd / (dayMax.get(Math.floor(x.at / 86_400_000)) ?? x.usd);
      return f > 0.66 ? 0 : f > 0.33 ? 40 : 70;
    };
  };
  coins.forEach((c, k) => {
    const shown = c.runs.filter((x) => x.rank >= 1 && x.rank <= maxPerDay);
    const lq = (c.liqs ?? []).filter((x) => x.rank >= 1 && x.rank <= maxPerDay);
    if (!shown.length && !lq.length) return;
    L.push(
      `c${k} = str.startswith(syminfo.ticker, "${c.symbol.toUpperCase()}")`,
    );
    const tr = trOf(shown);
    for (const x of shown) {
      const col = x.dir === "UP" ? "color.green" : "color.red";
      const tip = `OI #${x.rank} of the day: +${usd(x.usd)} (+${x.oiPct.toFixed(2)}%) | ${hm(x.from)}-${hm(x.to).slice(6)} Yerevan, ${x.minutes} min | at ${p(x.price)}, price ${x.movePct >= 0 ? "+" : ""}${x.movePct.toFixed(2)}%`;
      L.push(
        `dot(c${k}, ${x.at}, ${p(x.price)}, ${tr(x)}, ${col}, "${tip}", ${x.rank})`,
      );
    }
    for (const side of ["LONG", "SHORT"] as const) {
      const list = lq.filter((b) => b.side === side),
        trL = trOf(list);
      for (const b of list) {
        const col = side === "LONG" ? "color.orange" : "color.blue";
        const tip = `${side === "LONG" ? "LONGS" : "SHORTS"} liquidated #${b.rank} of the day: ${usd(b.usd)} | ${hm(b.from)}-${hm(b.to).slice(6)} Yerevan, ${b.minutes} min | at ${p(b.price)}`;
        L.push(
          `liq(c${k}, ${b.at}, ${p(b.price)}, ${trL(b)}, ${col}, "${tip}", ${b.rank})`,
        );
      }
    }
  });
  return L.join("\n") + "\n";
}
