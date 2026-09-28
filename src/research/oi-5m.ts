/**
 * 5-MINUTE OI + LIQUIDATIONS (Johnny, Sep 28 2026). Only our minute_bars, always looking back.
 * Every 5-minute UTC candle (like Binance: :00 :05 :10 ...):
 *   oiUp     = how much the open interest GREW in that candle, in $ (last OI of the candle - last OI of the
 *              previous candle, x price; 0 if it fell)
 *   liqLong  = $ of longs liquidated in that candle, liqShort = $ of shorts liquidated
 * The TradingView script draws them on the candles: OI growth = purple circle in the middle of the candle,
 * longs liquidated = orange circle under the low, shorts liquidated = blue circle over the high.
 * Darker / bigger = more $ (compared with this coin's own 5-minute candles in the period):
 *   light = above the median, medium = top 20%, dark = top 5%.
 * On bigger timeframes (15m, 1h, 4h) the 5-minute values inside the candle are added up.
 */
export interface Row5 {
  ts: number;
  close: number;
  oi: number;
  liqLong: number;
  liqShort: number;
}
export interface Slot5 {
  ts: number;
  oiUp: number;
  liqLong: number;
  liqShort: number;
}
export interface Levels {
  p50: number;
  p80: number;
  p95: number;
}

export const M5 = 5 * 60_000;

/** 5-minute UTC slots from `start` (aligned down) to the last finished one before `now`; missing data = 0. */
export function slots5(rows: readonly Row5[], now: number): Slot5[] {
  const ok = rows.filter((r) => r.close > 0);
  if (!ok.length) return [];
  const start = Math.floor(ok[0].ts / M5) * M5,
    end = Math.floor(now / M5) * M5;
  const n = Math.max(0, (end - start) / M5);
  const out: Slot5[] = Array.from({ length: n }, (_, i) => ({
    ts: start + i * M5,
    oiUp: 0,
    liqLong: 0,
    liqShort: 0,
  }));
  const lastOi = new Array<number>(n).fill(NaN),
    lastPx = new Array<number>(n).fill(NaN);
  for (const r of ok) {
    const i = Math.floor((r.ts - start) / M5);
    if (i < 0 || i >= n) continue;
    out[i].liqLong += r.liqLong;
    out[i].liqShort += r.liqShort;
    if (r.oi > 0) {
      lastOi[i] = r.oi;
      lastPx[i] = r.close;
    }
  }
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(lastOi[i])) continue; // no OI in this slot: the growth goes to the next slot with data
    if (Number.isFinite(prev) && lastOi[i] > prev)
      out[i].oiUp = (lastOi[i] - prev) * lastPx[i];
    prev = lastOi[i];
  }
  return out;
}

/** Median / top-20% / top-5% of the non-zero values. */
export function levels(v: readonly number[]): Levels {
  const a = v.filter((x) => x > 0).sort((x, y) => x - y);
  const q = (f: number): number =>
    a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : 0;
  return { p50: q(0.5), p80: q(0.8), p95: q(0.95) };
}

const K = (v: number): string => {
  const k = Math.round(v / 100) / 10;
  return k > 0 ? String(k) : "";
}; // $K, 1 decimal, empty = 0

/** Pine v6 for ONE coin: the data sits in the script as comma-separated $K values, one per 5-minute slot. */
export function pine5m(
  symbol: string,
  slots: readonly Slot5[],
  madeAt: number,
): string {
  const lv = {
    oi: levels(slots.map((s) => s.oiUp)),
    ll: levels(slots.map((s) => s.liqLong)),
    ls: levels(slots.map((s) => s.liqShort)),
  };
  const kk = (l: Levels): string =>
    `${+(l.p50 / 1000).toFixed(3)}, ${+(l.p80 / 1000).toFixed(3)}, ${+(l.p95 / 1000).toFixed(3)}`;
  const chunks = (
    name: string,
    vals: string[],
  ): { decl: string[]; expr: string } => {
    const decl: string[] = [],
      parts: string[] = [];
    for (let i = 0; i < vals.length; i += 200) {
      decl.push(
        `${name}${parts.length} = "${vals.slice(i, i + 200).join(",")}"`,
      );
      parts.push(`${name}${parts.length}`);
    }
    return { decl, expr: parts.length ? parts.join(' + "," + ') : '""' };
  };
  const oi = chunks(
      "O",
      slots.map((s) => K(s.oiUp)),
    ),
    ll = chunks(
      "L",
      slots.map((s) => K(s.liqLong)),
    ),
    ls = chunks(
      "S",
      slots.map((s) => K(s.liqShort)),
    );
  const coin = symbol.toUpperCase();
  return [
    "//@version=6",
    `indicator("liquidation-detector: 5m OI + liquidations ${coin}", overlay=true)`,
    "// Every 5-minute candle (UTC): purple = the open interest GREW (middle of the candle), orange = longs liquidated (under the low),",
    "// blue = shorts liquidated (over the high). Light = above normal, medium = top 20%, dark and bigger = top 5% of this coin's 5-minute candles.",
    "// On 15m / 1h / 4h the 5-minute values inside the candle are added up.",
    `// ${coin}, made ${new Date(madeAt).toISOString().slice(0, 16)} UTC -- a snapshot, data from ${new Date(slots[0]?.ts ?? madeAt).toISOString().slice(0, 16)} UTC`,
    `show = input.string("above normal", "show", options=["all", "above normal", "top 20%", "top 5%"])`,
    `showOi = input.bool(true, "OI growth (purple)")`,
    `showLiq = input.bool(true, "liquidations (orange longs / blue shorts)")`,
    `START = ${slots[0]?.ts ?? 0}`,
    ...oi.decl,
    ...ll.decl,
    ...ls.decl,
    "parse(s) =>",
    "    out = array.new_float()",
    '    for p in str.split(s, ",")',
    "        v = str.tonumber(p)",
    "        array.push(out, na(v) ? 0.0 : v)",
    "    out",
    `var float[] oi = parse(${oi.expr})`,
    `var float[] ll = parse(${ll.expr})`,
    `var float[] ls = parse(${ls.expr})`,
    `isSym = str.startswith(syminfo.ticker, "${coin}")`,
    "tfMs = timeframe.in_seconds() * 1000",
    "k = math.max(1, tfMs / 300000)",
    "// under 5 minutes: only the candle that opens the 5-minute slot",
    "okBar = isSym and (tfMs >= 300000 or time % 300000 == 0)",
    "sumOf(a) =>",
    "    i0 = int(math.floor((time - START) / 300000))",
    "    i1 = int(math.floor((time + math.max(tfMs, 300000) - 1 - START) / 300000))",
    "    s = 0.0",
    "    lo = math.max(i0, 0)",
    "    hi = math.min(i1, array.size(a) - 1)",
    "    if hi >= lo",
    "        for i = lo to hi",
    "            s += array.get(a, i)",
    "    s",
    "// 0 nothing, 1 small, 2 above normal, 3 top 20%, 4 top 5% (levels in $K per 5-minute candle, x the 5-minute candles inside)",
    "grade(v, p50, p80, p95) => v <= 0 ? 0 : v >= p95 * k ? 4 : v >= p80 * k ? 3 : v >= p50 * k ? 2 : 1",
    `minG = show == "all" ? 1 : show == "above normal" ? 2 : show == "top 20%" ? 3 : 4`,
    `gO = okBar and showOi ? grade(sumOf(oi), ${kk(lv.oi)}) : 0`,
    `gL = okBar and showLiq ? grade(sumOf(ll), ${kk(lv.ll)}) : 0`,
    `gS = okBar and showLiq ? grade(sumOf(ls), ${kk(lv.ls)}) : 0`,
    "tr(g) => g >= 4 ? 0 : g == 3 ? 30 : g == 2 ? 60 : 80",
    'plotshape(gO >= minG and gO < 4 ? hl2 : na, "OI growth", shape.circle, location.absolute, color.new(color.purple, tr(gO)), size=size.tiny)',
    'plotshape(gO >= minG and gO == 4 ? hl2 : na, "OI growth top 5%", shape.circle, location.absolute, color.purple, size=size.small)',
    'plotshape(gL >= minG and gL < 4 ? low : na, "longs liquidated", shape.circle, location.absolute, color.new(color.orange, tr(gL)), size=size.tiny)',
    'plotshape(gL >= minG and gL == 4 ? low : na, "longs liquidated top 5%", shape.circle, location.absolute, color.orange, size=size.small)',
    'plotshape(gS >= minG and gS < 4 ? high : na, "shorts liquidated", shape.circle, location.absolute, color.new(color.blue, tr(gS)), size=size.tiny)',
    'plotshape(gS >= minG and gS == 4 ? high : na, "shorts liquidated top 5%", shape.circle, location.absolute, color.blue, size=size.small)',
    "",
  ].join("\n");
}
