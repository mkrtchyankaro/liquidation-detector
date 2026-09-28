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
  top: boolean;
  big: boolean;
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
      hi = -Infinity;
    for (let i = s + 1; i <= peakI; i++) {
      const d = r[i].oi - r[i - 1].oi;
      if (d > 0) {
        w += d;
        wp += d * r[i].close;
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
      top: false,
      big: false,
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

/** Marks the two ways to pick the big ones: the `topN` largest, and every run >= `times` x the median run. */
export function markRuns(runs: OiRun[], topN = 15, times = 3): OiRun[] {
  const sizes = runs.map((x) => x.usd).sort((a, b) => a - b);
  const med = sizes.length ? sizes[sizes.length >> 1] : 0;
  const cut =
    [...sizes].reverse()[Math.min(topN, sizes.length) - 1] ?? Infinity;
  for (const x of runs) {
    x.xNormal = med > 0 ? x.usd / med : 0;
    x.top = x.usd >= cut;
    x.big = med > 0 && x.usd >= times * med;
  }
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

/** Pine v6: one circle per run at (the middle of the run, the price where the OI was added). Hover = details. */
export function runsPine(
  coins: ReadonlyArray<{ symbol: string; runs: readonly OiRun[] }>,
  madeAt: number,
  times = 3,
  topN = 15,
): string {
  const p = (v: number): number => +v.toPrecision(7);
  const L: string[] = [
    "//@version=6",
    `indicator("liquidation-detector: OI accumulations", overlay=true, max_labels_count=500, max_lines_count=500)`,
    "// Circle = the open interest grew minute after minute (new positions). Placed at the middle of that time and",
    "// at the price where the OI was added. Bigger circle = more $. Green: price went up meanwhile, red: down. Hover a circle.",
    `// made ${new Date(madeAt).toISOString().slice(0, 16)} UTC -- a snapshot`,
    `mode = input.string("top ${topN}", "show", options=["top ${topN}", "${times}x normal", "both"])`,
    `lines = input.bool(false, "price line to the right")`,
    "// drawn once, on the last finished bar (no long if-blocks: TradingView limits their size)",
    "dot(on, t, y, sz, col, tip, isTop, isBig) =>",
    `    show = on and barstate.islastconfirmedhistory and ((mode == "top ${topN}" and isTop) or (mode == "${times}x normal" and isBig) or (mode == "both" and (isTop or isBig)))`,
    "    if show",
    '        label.new(t, y, "", xloc=xloc.bar_time, style=label.style_circle, size=sz, color=color.new(col, 35), textcolor=col, tooltip=tip)',
    "        if lines",
    "            line.new(t, y, t + 60000, y, xloc=xloc.bar_time, extend=extend.right, color=color.new(col, 60), style=line.style_dotted)",
    "    show",
  ];
  coins.forEach((c, k) => {
    // the largest first; at most 80 circles per coin
    const shown = c.runs
      .filter((x) => x.top || x.big)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 80);
    if (!shown.length) return;
    L.push(
      `c${k} = str.startswith(syminfo.ticker, "${c.symbol.toUpperCase()}")`,
    );
    const max = shown[0].usd;
    for (const x of shown) {
      const f = x.usd / max,
        sz = f > 0.66 ? "size.large" : f > 0.33 ? "size.normal" : "size.small";
      const col = x.dir === "UP" ? "color.green" : "color.red";
      const tip = `+${usd(x.usd)} OI (+${x.oiPct.toFixed(2)}%, ${x.xNormal.toFixed(1)}x normal) | ${hm(x.from)}-${hm(x.to).slice(6)} Yerevan, ${x.minutes} min | at ${p(x.price)}, price ${x.movePct >= 0 ? "+" : ""}${x.movePct.toFixed(2)}%`;
      L.push(
        `dot(c${k}, ${Math.round((x.from + x.to) / 2)}, ${p(x.price)}, ${sz}, ${col}, "${tip}", ${x.top}, ${x.big})`,
      );
    }
  });
  return L.join("\n") + "\n";
}
