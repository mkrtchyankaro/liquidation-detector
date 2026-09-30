/**
 * OA -- OI ACCUMULATION strategy (Johnny, Sep 30 2026). Pure, no I/O. Rules FROZEN as tested on 23-30 Sep 2026
 * (1h, 9 coins -- in-sample only, not yet confirmed on new data; see step 4 for the current numbers).
 *
 * Per coin, walking forward over CLOSED 1h candles:
 *  1. ACCUMULATION: over the last 3..12 closed hours the price moved >= MOVE% (alts 3, ETH/BNB 2, BTC 1.5) and OI
 *     grew >= OIACC% (BTC 0.5, others 1). This opens an EPISODE (direction UP/DOWN) that lives 48h; a new accumulation
 *     the same way refreshes it, the opposite way replaces it.
 *  2. OI-DROP HOUR ("new high/low" = beyond the episode extreme known BEFORE this hour): an hour whose OI fell >= 0.2% with big liquidations (>= 80th percentile of this coin's hourly
 *     liquidations of that side over the trailing window). For an UP episode:
 *       A  REVERSAL      the hour made a NEW HIGH above the episode's extreme and SHORTS were liquidated -> SHORT
 *       B  CONTINUATION  the hour closed RED and LONGS were liquidated (flush against the move)          -> LONG
 *     A DOWN episode is the mirror (A: new low + long liq -> LONG; B: green hour + short liq -> SHORT).
 *  3. CONFIRMATION: the NEXT hour must go the new way (LONG: green and closes above the OI-drop hour's close;
 *     SHORT: red and closes below). Entry = its close.
 *  4. SL: the CONFIRMATION hour's extreme (LONG: its low, SHORT: its high), 0.05% beyond. Skip if the SL is closer
 *     than 0.2%. TP = 2R. Exit: SL first if both are touched in one bar; after 48h at market (TIME).
 *     (Sep 30: SL moved from the episode / 4h extreme to the confirmation candle -- median SL 1.9% -> 1.15%;
 *      same week: 25 trades, 14 TP / 10 SL, +15.5R after fees at 2R. Still in-sample.)
 *     After the trade ends the episode is deleted and the coin starts fresh; nothing new while a trade is open.
 */
export interface OaHour {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oiOpen: number;
  oiHigh: number;
  oiClose: number;
  oiChgPct: number;
  liqLongUsd: number;
  liqShortUsd: number;
  complete: boolean; // enough data in this hour (live: >= 50 minutes with OI)
}
/** exit path: any resolution (1m live, 15m in the research file); ts = bar OPEN time */
export interface PathBar {
  ts: number;
  high: number;
  low: number;
  close: number;
}
export type OaVariant = "A" | "B";
export interface OaEpisode {
  dir: "UP" | "DOWN";
  since: number;
  movePct: number;
  oiPct: number;
  ext: number;
  until: number;
  i0: number;
}
export interface OaTrade {
  symbol: string;
  side: "LONG" | "SHORT";
  variant: OaVariant;
  episode: {
    dir: "UP" | "DOWN";
    since: number;
    movePct: number;
    oiPct: number;
  };
  oiDropHour: number;
  oiDropPct: number;
  oiDropLiqUsd: number;
  oiDropClose: number;
  confirmHour: number;
  entryTs: number;
  entry: number;
  slPrice: number;
  tpPrice: number;
  slPct: number;
  rr: number;
  result: "TP" | "SL" | "TIME" | "OPEN";
  exitTs: number | null;
  exitPrice: number | null;
  grossR: number;
  netR: number;
}
export interface OaParams {
  moveBySymbol: Record<string, number>;
  moveDefault: number;
  oiAccBySymbol: Record<string, number>;
  oiAccDefault: number;
  lookMin: number;
  lookMax: number;
  keepH: number;
  oiDropPct: number;
  liqQ: number;
  liqMinHours: number;
  liqWindowH: number;
  rr: number;
  minSlPct: number;
  slBufferPct: number;
  maxHoldH: number;
  takerPct: number;
  makerPct: number;
}
export const OA_DEFAULTS: OaParams = {
  moveBySymbol: { BTCUSDT: 1.5, ETHUSDT: 2.0, BNBUSDT: 2.0 },
  moveDefault: 3.0,
  oiAccBySymbol: { BTCUSDT: 0.5 },
  oiAccDefault: 1.0,
  lookMin: 3,
  lookMax: 12,
  keepH: 48,
  oiDropPct: 0.2,
  liqQ: 0.8,
  liqMinHours: 24,
  liqWindowH: 168,
  rr: 2.0,
  minSlPct: 0.2,
  slBufferPct: 0.05,
  maxHoldH: 48,
  takerPct: 0.05,
  makerPct: 0.02,
};
const H = 3_600_000;

/** pandas-style quantile (linear interpolation) */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q,
    lo = Math.floor(pos),
    hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function runOa(
  symbol: string,
  hours: readonly OaHour[],
  path: readonly PathBar[],
  p: OaParams = OA_DEFAULTS,
): { trades: OaTrade[]; episode: OaEpisode | null } {
  const h = hours,
    n = h.length,
    trades: OaTrade[] = [];
  const mv = p.moveBySymbol[symbol] ?? p.moveDefault,
    oa = p.oiAccBySymbol[symbol] ?? p.oiAccDefault;
  // liquidation thresholds from PRIOR hours only
  const thr = (i: number, side: "L" | "S"): number => {
    const from = Math.max(0, i - p.liqWindowH);
    if (i - from < p.liqMinHours) return NaN;
    const v: number[] = [];
    for (let k = from; k < i; k++)
      v.push(side === "L" ? h[k].liqLongUsd : h[k].liqShortUsd);
    return quantile(
      v.sort((a, b) => a - b),
      p.liqQ,
    );
  };
  let ep: OaEpisode | null = null,
    pending: { side: "LONG" | "SHORT"; k: number; variant: OaVariant } | null =
      null;
  let freeAt = n ? h[0].openTime : 0;
  let pi = 0;
  for (let i = p.liqMinHours; i < n; i++) {
    const k = h[i],
      T = k.openTime + H;
    if (T <= freeAt) continue;
    if (!k.complete) continue;
    const prevExt = ep ? ep.ext : null,
      prevDir = ep ? ep.dir : null; // extreme known BEFORE this hour
    // 1. accumulation
    for (let L = p.lookMin; L <= p.lookMax; L++) {
      const a = i - L + 1;
      if (a < 0) break;
      const pr = (k.close / h[a].open - 1) * 100,
        oi = (k.oiClose / h[a].oiOpen - 1) * 100;
      const dir = pr >= mv ? "UP" : pr <= -mv ? "DOWN" : null;
      if (dir && oi >= oa) {
        let ext = dir === "UP" ? -Infinity : Infinity;
        for (let x = a; x <= i; x++)
          ext =
            dir === "UP" ? Math.max(ext, h[x].high) : Math.min(ext, h[x].low);
        if (ep && ep.dir === dir) {
          ep.ext = dir === "UP" ? Math.max(ep.ext, ext) : Math.min(ep.ext, ext);
          ep.until = T + p.keepH * H;
          ep.oiPct = Math.max(ep.oiPct, oi);
        } else {
          ep = {
            dir,
            since: h[a].openTime,
            ext,
            until: T + p.keepH * H,
            movePct: pr,
            oiPct: oi,
            i0: a,
          };
          pending = null;
        }
        break;
      }
    }
    if (!ep) continue;
    if (T > ep.until) {
      ep = null;
      pending = null;
      continue;
    }
    // 3. a pending OI-drop signal: this hour must confirm
    let sig: { side: "LONG" | "SHORT"; variant: OaVariant; kc: number } | null =
      null;
    if (pending) {
      const pk = h[pending.k];
      const ok =
        pending.side === "SHORT"
          ? k.close < k.open && k.close < pk.close
          : k.close > k.open && k.close > pk.close;
      if (ok)
        sig = { side: pending.side, variant: pending.variant, kc: pending.k };
      pending = null;
    }
    // 2. the OI-drop hour
    if (!sig && k.oiChgPct <= -p.oiDropPct) {
      const up = ep.dir === "UP";
      const refExt = prevExt !== null && prevDir === ep.dir ? prevExt : ep.ext;
      const newExt = up ? k.high > refExt : k.low < refExt;
      const tS = thr(i, "S"),
        tL = thr(i, "L");
      let s: { side: "LONG" | "SHORT"; variant: OaVariant } | null = null;
      if (up) {
        if (newExt && k.liqShortUsd >= tS && k.liqShortUsd > 0)
          s = { side: "SHORT", variant: "A" };
        else if (k.close < k.open && k.liqLongUsd >= tL && k.liqLongUsd > 0)
          s = { side: "LONG", variant: "B" };
      } else {
        if (newExt && k.liqLongUsd >= tL && k.liqLongUsd > 0)
          s = { side: "LONG", variant: "A" };
        else if (k.close > k.open && k.liqShortUsd >= tS && k.liqShortUsd > 0)
          s = { side: "SHORT", variant: "B" };
      }
      if (s) pending = { ...s, k: i };
      ep.ext = up ? Math.max(ep.ext, k.high) : Math.min(ep.ext, k.low);
    }
    if (!sig) continue;
    // 4. the trade
    const long = sig.side === "LONG",
      entry = k.close;
    const ext = long ? k.low : k.high; // SL at the CONFIRMATION hour's extreme
    const sl = ext * (long ? 1 - p.slBufferPct / 100 : 1 + p.slBufferPct / 100);
    const risk = long ? entry - sl : sl - entry;
    if (!(risk / entry >= p.minSlPct / 100)) continue;
    const tp = entry + (long ? 1 : -1) * p.rr * risk;
    while (pi < path.length && path[pi].ts < T) pi++;
    // no bar after the entry yet (live: the hour just closed) -> the trade is OPEN
    const x = oaExit(sig.side, entry, sl, tp, T, path, p, pi) ?? {
      result: "OPEN" as const,
      exitTs: null,
      exitPrice: null,
      grossR: 0,
      netR: 0,
    };
    const { result, exitTs, exitPrice, grossR, netR } = x;
    const kc = h[sig.kc];
    trades.push({
      symbol,
      side: sig.side,
      variant: sig.variant,
      episode: {
        dir: ep.dir,
        since: ep.since,
        movePct: ep.movePct,
        oiPct: ep.oiPct,
      },
      oiDropHour: kc.openTime,
      oiDropPct: kc.oiChgPct,
      oiDropLiqUsd: long ? kc.liqLongUsd : kc.liqShortUsd,
      oiDropClose: kc.close,
      confirmHour: k.openTime,
      entryTs: T,
      entry,
      slPrice: sl,
      tpPrice: tp,
      slPct: (100 * risk) / entry,
      rr: p.rr,
      result,
      exitTs,
      exitPrice,
      grossR,
      netR,
    });
    freeAt = result === "OPEN" ? Infinity : exitTs!;
    ep = null;
    pending = null;
  }
  return { trades, episode: ep };
}

/** minutes -> closed 1h candles (for live use); minute = one minute_bars row */
export interface MinuteRow {
  ts: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  oiFirst: number | null;
  oiLast: number | null;
  oiMax: number | null;
  longLiqUsd: number;
  shortLiqUsd: number;
}
export function hoursFromMinutes(
  rows: readonly MinuteRow[],
  untilTs: number,
  minMinutes = 50,
): OaHour[] {
  const by = new Map<number, MinuteRow[]>();
  for (const r of rows) {
    if (r.ts >= untilTs) continue;
    const hr = Math.floor(r.ts / H) * H;
    (by.get(hr) ?? by.set(hr, []).get(hr)!).push(r);
  }
  const out: OaHour[] = [];
  const keys = [...by.keys()].sort((a, b) => a - b);
  if (!keys.length) return out;
  for (let hr = keys[0]; hr + H <= untilTs; hr += H) {
    const m = (by.get(hr) ?? [])
      .filter((r) => r.close !== null && r.close > 0)
      .sort((a, b) => a.ts - b.ts);
    const withOi = m.filter((r) => r.oiLast !== null && r.oiLast > 0);
    if (!m.length || !withOi.length) {
      out.push({
        openTime: hr,
        open: NaN,
        high: NaN,
        low: NaN,
        close: NaN,
        oiOpen: NaN,
        oiHigh: NaN,
        oiClose: NaN,
        oiChgPct: NaN,
        liqLongUsd: 0,
        liqShortUsd: 0,
        complete: false,
      });
      continue;
    }
    const oiOpen =
      withOi[0].oiFirst && withOi[0].oiFirst > 0
        ? withOi[0].oiFirst
        : withOi[0].oiLast!;
    const oiClose = withOi[withOi.length - 1].oiLast!;
    out.push({
      openTime: hr,
      open: m[0].open ?? m[0].close!,
      high: Math.max(...m.map((r) => r.high ?? r.close!)),
      low: Math.min(...m.map((r) => r.low ?? r.close!)),
      close: m[m.length - 1].close!,
      oiOpen,
      oiHigh: Math.max(
        oiOpen,
        oiClose,
        ...withOi.map((r) => r.oiMax ?? r.oiLast!),
      ),
      oiClose,
      oiChgPct: (100 * (oiClose - oiOpen)) / oiOpen,
      liqLongUsd: m.reduce((s, r) => s + (r.longLiqUsd || 0), 0),
      liqShortUsd: m.reduce((s, r) => s + (r.shortLiqUsd || 0), 0),
      complete: withOi.length >= minMinutes,
    });
  }
  return out;
}

/** SL / TP / 48h TIME exit on the path bars at/after entryTs (SL first when both are touched in one bar).
 *  null = no bar after the entry yet. Shared by the research engine and the live PAPER service. */
export function oaExit(
  side: "LONG" | "SHORT",
  entry: number,
  sl: number,
  tp: number,
  entryTs: number,
  path: readonly PathBar[],
  p: OaParams = OA_DEFAULTS,
  startIdx = 0,
): {
  result: "TP" | "SL" | "TIME" | "OPEN";
  exitTs: number | null;
  exitPrice: number | null;
  grossR: number;
  netR: number;
} | null {
  const long = side === "LONG",
    risk = Math.abs(entry - sl),
    rr = Math.abs(tp - entry) / risk,
    endTs = entryTs + p.maxHoldH * H;
  const fee = (exitPct: number): number =>
    (((p.takerPct + exitPct) / 100) * entry) / risk;
  let last: PathBar | null = null,
    j = startIdx;
  while (j < path.length && path[j].ts < entryTs) j++;
  for (; j < path.length && path[j].ts < endTs; j++) {
    const b = path[j];
    last = b;
    if (long ? b.low <= sl : b.high >= sl)
      return {
        result: "SL",
        exitTs: b.ts,
        exitPrice: sl,
        grossR: -1,
        netR: -1 - fee(p.takerPct),
      };
    if (long ? b.high >= tp : b.low <= tp)
      return {
        result: "TP",
        exitTs: b.ts,
        exitPrice: tp,
        grossR: rr,
        netR: rr - fee(p.makerPct),
      };
  }
  if (!last) return null;
  const grossR = ((long ? 1 : -1) * (last.close - entry)) / risk;
  if (j < path.length)
    return {
      result: "TIME",
      exitTs: last.ts,
      exitPrice: last.close,
      grossR,
      netR: grossR - fee(p.takerPct),
    };
  return {
    result: "OPEN",
    exitTs: null,
    exitPrice: null,
    grossR,
    netR: grossR - fee(p.takerPct),
  };
}
