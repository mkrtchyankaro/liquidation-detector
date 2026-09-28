/**
 * CLEANINGS AND OI BUILD-UPS (Johnny, Sep 28 2026). Only our own data (minute_bars), always looking back.
 *
 * 1. CLEANING (a market flush): a 4h candle (Binance / UTC boundaries 00-04-08-12-16-20) in which
 *    - the open interest FELL strongly: at least 2x this coin's normal 4h OI change, and
 *    - liquidations were big: at least 2x this coin's normal 4h liquidations.
 *    Side: more longs liquidated -> a DOWN cleaning (longs flushed), more shorts -> UP (shorts flushed).
 *    Continuation: the next candle still cleans the same side (OI falls, liquidations >= normal) and goes
 *    further (DOWN: a lower low, UP: a higher high) -> the same cleaning. If the market turns the other way,
 *    it is a new episode. "Normal" = the coin's own median over the period -- no fixed %.
 *    (OI down + price down = deleveraging / capitulation, the flush that resets the leverage; the usual
 *    OI-vs-price reading.)
 * 2. OI BUILD-UPS since the last cleaning: every 15 minutes the OI change is put on the price layers the
 *    price traded in (0.2% layers); where OI kept GROWING at nearly the same prices, the layer gets strong.
 *    The strongest runs of layers above the price and below it are the zones.
 */
export interface Row { ts: number; high: number; low: number; close: number; oi: number; liqLong: number; liqShort: number }
export interface Candle4h { ts: number; open: number; high: number; low: number; close: number; oiPct: number; liqLong: number; liqShort: number }
export interface Cleaning { from: number; to: number; side: "DOWN" | "UP"; candles: number; high: number; low: number; movePct: number; oiPct: number; liqLong: number; liqShort: number; xOi: number; xLiq: number }
export interface BuildZone { lo: number; hi: number; usd: number; where: "ABOVE" | "BELOW" | "AT" }

const H = 3_600_000, H4 = 4 * H, STEP = 15 * 60_000;
const median = (v: number[]): number => { const a = v.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };

/** UTC 4h candles from minute rows; only finished ones (before `now`). */
export function candles4h(rows: readonly Row[], now: number): Candle4h[] {
  const out: Array<Candle4h & { oi0: number; oi1: number }> = [];
  for (const r of rows) {
    if (!(r.close > 0)) continue;
    const t = Math.floor(r.ts / H4) * H4, c = out[out.length - 1];
    const hi = r.high > 0 ? r.high : r.close, lo = r.low > 0 ? r.low : r.close;
    if (c && c.ts === t) {
      c.high = Math.max(c.high, hi); c.low = Math.min(c.low, lo); c.close = r.close;
      if (r.oi > 0) { if (!(c.oi0 > 0)) c.oi0 = r.oi; c.oi1 = r.oi; }
      c.liqLong += r.liqLong; c.liqShort += r.liqShort;
    } else out.push({ ts: t, open: r.close, high: hi, low: lo, close: r.close, oi0: r.oi, oi1: r.oi, oiPct: NaN, liqLong: r.liqLong, liqShort: r.liqShort });
  }
  return out.filter((c) => c.ts + H4 <= now).map(({ oi0, oi1, ...c }) => ({ ...c, oiPct: oi0 > 0 && oi1 > 0 ? (100 * (oi1 - oi0)) / oi0 : NaN }));
}

/** All cleaning episodes (oldest first). */
export function findCleanings(c: readonly Candle4h[]): Cleaning[] {
  if (c.length < 6) return [];
  const normOi = median(c.map((k) => Math.abs(k.oiPct))), normLiq = median(c.map((k) => k.liqLong + k.liqShort));
  if (!(normOi > 0) || !(normLiq > 0)) return [];
  const sideOf = (k: Candle4h): "DOWN" | "UP" => (k.liqLong >= k.liqShort ? "DOWN" : "UP");
  const strong = (k: Candle4h): boolean => k.oiPct <= -2 * normOi && k.liqLong + k.liqShort >= 2 * normLiq;
  const out: Cleaning[] = [];
  for (let i = 0; i < c.length; i++) {
    if (!strong(c[i])) continue;
    const side = sideOf(c[i]);
    let j = i;
    while (j + 1 < c.length) {
      const n = c[j + 1], p = c[j];
      const still = n.oiPct < 0 && n.liqLong + n.liqShort >= normLiq && sideOf(n) === side;
      const further = side === "DOWN" ? n.low < p.low : n.high > p.high;
      if (!(still && further)) break;
      j++;
    }
    const part = c.slice(i, j + 1);
    const liqLong = part.reduce((s, k) => s + k.liqLong, 0), liqShort = part.reduce((s, k) => s + k.liqShort, 0);
    const oiPct = 100 * (part.reduce((m, k) => m * (1 + (Number.isFinite(k.oiPct) ? k.oiPct : 0) / 100), 1) - 1);
    out.push({
      from: c[i].ts, to: c[j].ts + H4, side, candles: part.length,
      high: Math.max(...part.map((k) => k.high)), low: Math.min(...part.map((k) => k.low)),
      movePct: (100 * (c[j].close - c[i].open)) / c[i].open, oiPct, liqLong, liqShort,
      xOi: Math.abs(oiPct) / normOi, xLiq: (liqLong + liqShort) / normLiq,
    });
    i = j;
  }
  return out;
}

/** Where OI grew since `from` (15-minute steps, 0.2% layers): the strongest runs above and below `price`. */
export function buildUps(rows: readonly Row[], from: number, price: number, binPct = 0.2, maxPerSide = 3): BuildZone[] {
  const ok = rows.filter((r) => r.ts >= from && r.close > 0);
  if (ok.length < 30) return [];
  const step = (price * binPct) / 100;
  const lo = Math.min(...ok.map((r) => (r.low > 0 ? r.low : r.close)));
  const first = Math.floor(lo / step) * step;
  const hi = Math.max(...ok.map((r) => (r.high > 0 ? r.high : r.close)));
  const n = Math.max(1, Math.ceil((hi - first) / step) + 1);
  const grow = new Array<number>(n).fill(0);
  const binOf = (p: number): number => Math.min(n - 1, Math.max(0, Math.floor((p - first) / step)));
  let w: { ts: number; lo: number; hi: number; close: number; oi: number } | null = null, prevOi = NaN;
  const flush = (): void => {
    if (!w) return;
    if (Number.isFinite(w.oi) && Number.isFinite(prevOi) && w.oi > prevOi) {
      const a = binOf(w.lo), b = binOf(w.hi), usd = (w.oi - prevOi) * w.close;
      for (let i = a; i <= b; i++) grow[i] += usd / (b - a + 1);
    }
    if (Number.isFinite(w.oi)) prevOi = w.oi;
  };
  for (const r of ok) {
    const t = Math.floor(r.ts / STEP) * STEP, rl = r.low > 0 ? r.low : r.close, rh = r.high > 0 ? r.high : r.close;
    if (w && w.ts === t) { w.lo = Math.min(w.lo, rl); w.hi = Math.max(w.hi, rh); w.close = r.close; if (r.oi > 0) w.oi = r.oi; }
    else { flush(); w = { ts: t, lo: rl, hi: rh, close: r.close, oi: r.oi > 0 ? r.oi : NaN }; }
  }
  flush();
  const mid = (i: number): number => first + (i + 0.5) * step;
  const runsOf = (allow: (i: number) => boolean): BuildZone[] => {
    const v = grow.map((x, i) => (allow(i) ? x : 0));
    const s = v.map((_, i) => ((v[i - 1] ?? v[i]) + v[i] + (v[i + 1] ?? v[i])) / 3);
    const nz = s.filter((x) => x > 0).sort((a, b) => a - b);
    if (!nz.length) return [];
    const cut = nz[Math.floor(nz.length * 0.8)];
    const runs: Array<[number, number, number]> = [];
    for (let i = 0; i < s.length; i++) {
      if (!(s[i] >= cut && v[i] > 0)) continue;
      const last = runs[runs.length - 1];
      if (last && i - last[1] <= 1) { last[1] = i; last[2] += v[i]; } else runs.push([i, i, v[i]]);
    }
    return runs.sort((x, y) => y[2] - x[2]).slice(0, maxPerSide).map(([a, b, usd]) => {
      const zlo = first + a * step, zhi = first + (b + 1) * step;
      return { lo: zlo, hi: zhi, usd, where: price > zhi ? "BELOW" as const : price < zlo ? "ABOVE" as const : "AT" as const };
    });
  };
  return [...runsOf((i) => mid(i) > price), ...runsOf((i) => mid(i) <= price)];
}

const usd = (v: number): string => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);

/** TradingView Pine Script v6: the last cleaning (a shaded box over its candles) and the OI build-up zones since. */
export function cleaningsPine(coins: ReadonlyArray<{ symbol: string; last: Cleaning | null; zones: readonly BuildZone[] }>, madeAt: number): string {
  const p = (v: number): number => +v.toPrecision(7);
  const L: string[] = [
    "//@version=6",
    `indicator("liquidation-detector: cleanings & OI build-ups", overlay=true, max_boxes_count=100)`,
    "// Shaded red box = the last DOWN cleaning (longs flushed), green = the last UP cleaning (shorts flushed): OI fell strongly + big liquidations.",
    "// Zones after it = where the open interest kept growing (new positions): purple above the price, teal below.",
    `// made ${new Date(madeAt).toISOString().slice(0, 16)} UTC -- a snapshot`,
    "zone(t, lo, hi, col, txt) =>",
    "    box.new(t, hi, t + 60000, lo, xloc=xloc.bar_time, extend=extend.right, border_color=col, border_style=line.style_dashed, bgcolor=color.new(col, 85), text=txt, text_color=col, text_size=size.small, text_halign=text.align_right, text_valign=text.align_center)",
    "var bool drawn = false",
    "if barstate.islast and not drawn",
    "    drawn := true",
  ];
  for (const c of coins) {
    L.push(`    if str.startswith(syminfo.ticker, "${c.symbol.toUpperCase()}")`);
    let n = 0;
    if (c.last) {
      const col = c.last.side === "DOWN" ? "color.red" : "color.green";
      L.push(`        box.new(${c.last.from}, ${p(c.last.high)}, ${c.last.to}, ${p(c.last.low)}, xloc=xloc.bar_time, border_color=${col}, bgcolor=color.new(${col}, 80), text="cleaning ${c.last.side === "DOWN" ? "longs" : "shorts"} ${c.last.oiPct.toFixed(1)}% OI", text_color=${col}, text_size=size.small, text_valign=text.align_top)`);
      n++;
    }
    const t0 = c.last?.to ?? madeAt - 86_400_000;
    c.zones.forEach((z, i) => { n++; L.push(`        zone(${t0}, ${p(z.lo)}, ${p(z.hi)}, ${z.where === "ABOVE" ? "color.purple" : "color.teal"}, "OI+ ${i + 1} ${usd(z.usd)}")`); });
    if (!n) L.push("        na");
  }
  return L.join("\n") + "\n";
}
