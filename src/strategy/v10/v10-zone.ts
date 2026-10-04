/**
 * V10 · THE 4h ZONE AT A SIGNAL (Oct 4 2026) -- always shown and recorded; it changes a trade only for a user who
 * turned a filter on (zoneFilterShort: no SHORT with a zone between the entry and the TP; zoneFilterLong: a LONG only
 * with a STRONG zone -- flip 2+/2+ built over >= 10 days -- under the entry within zoneLongMaxAtr 4h ATRs).
 * The test (src/tools/zone-v10-all.ts, live coins, the zone known at the signal): SHORTs on a coin whose 4h main zone
 * is a real FLIP (tested 2+ times from below AND 2+ times from above) won 71% (+17.3R, 17 trades), the others 50%
 * (+4.8R, 12). To check that live, the entry message shows the zone and the trade row keeps it.
 *   zone = src/research/zones.ts mainZone(): 1-ATR turns on the 4h bodies, 0.8 ATR apart, at most 1.6 ATR tall,
 *          the latest zone with 3+ touches -- from the 4h candles CLOSED before the signal (public Binance klines)
 */
import {
  atrSeries,
  mainZone,
  pivots,
  zoneQuality,
  zones,
  type ZCandle,
} from "../../research/zones";

const FAPI = process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com";
const H4 = 4 * 3_600_000,
  DAY = 86_400_000;

export interface V10ZoneView {
  lo: number;
  hi: number;
  /** touches from below (as resistance) / from above (as support) */
  res: number;
  sup: number;
  /** a real flip: both roles tested at least twice */
  flip: boolean;
  /** the entry vs the zone in 4h ATR: + above its top, - below its bottom, 0 inside */
  distAtr: number;
  /** Oct 4: every zone of 3+ touches known then (strong = a flip 2+/2+ built over >= 10 days), the 4h ATR, and how far
   *  (4h ATRs) the entry is above the nearest STRONG zone under it (null = none under it) */
  zones?: Array<{ lo: number; hi: number; strong: boolean }>;
  atr?: number;
  strongBelowAtr?: number | null;
}

/** a zone between the entry and the TP (the TP would have to go through it) */
export function zoneWall(
  v: V10ZoneView | null | undefined,
  side: "LONG" | "SHORT",
  entry: number,
  tp: number,
): { lo: number; hi: number; strong: boolean } | null {
  for (const z of v?.zones ?? [])
    if (
      side === "SHORT" ? z.hi >= tp && z.lo < entry : z.lo <= tp && z.hi > entry
    )
      return z;
  return null;
}

export interface V10ZoneSource {
  at(symbol: string, t: number, price: number): Promise<V10ZoneView | null>;
}

/** pure: the zone view from 4h candles (only those closed by t are used) */
export function zoneViewOf(
  c4: readonly ZCandle[],
  t: number,
  price: number,
): V10ZoneView | null {
  const known = c4.filter((x) => x.t + H4 <= t),
    mz = mainZone(known);
  if (!mz) return null;
  const q = zoneQuality(known, mz.z, mz.atr),
    z = mz.z;
  const a = atrSeries(known, 14),
    atr = a[a.length - 1];
  const all = zones(pivots(known, 1, 14), atr, 0.8, 3, 1.6).map((x) => {
    const qq = zoneQuality(known, x, atr);
    return {
      lo: x.lo,
      hi: x.hi,
      strong: qq.res >= 2 && qq.sup >= 2 && qq.life >= 10,
    };
  });
  const below = all
    .filter((x) => x.strong && x.hi <= price)
    .sort((p, r) => r.hi - p.hi)[0];
  return {
    lo: z.lo,
    hi: z.hi,
    res: q.res,
    sup: q.sup,
    flip: q.res >= 2 && q.sup >= 2,
    distAtr:
      price > z.hi
        ? (price - z.hi) / mz.atr
        : price < z.lo
          ? (price - z.lo) / mz.atr
          : 0,
    zones: all,
    atr,
    strongBelowAtr: below ? (price - below.hi) / atr : null,
  };
}

const fmt = (v: number): string => String(+v.toPrecision(5));
/** the Telegram line(s) (Armenian); with the trade (side, entry, TP): the strong zone under it and a zone in the TP's way */
export function formatZoneLine(
  v: V10ZoneView | null | undefined,
  trade?: { side: "LONG" | "SHORT"; entry: number; tp: number | null },
): string {
  if (!v) return "🧱 4h զոնա՝ չկա (3+ դիպչումով զոնա չգտնվեց)";
  const where =
    v.distAtr > 0
      ? `գինը զոնայից ${v.distAtr.toFixed(1)} ATR վերև`
      : v.distAtr < 0
        ? `գինը զոնայից ${(-v.distAtr).toFixed(1)} ATR ներքև`
        : "գինը զոնայի մեջ";
  const lines = [
    `🧱 4h զոնա ${fmt(v.lo)} – ${fmt(v.hi)} · ${v.flip ? "FLIP ✅" : "FLIP չէ ⚠️"} (${v.res} ներքևից / ${v.sup} վերևից) · ${where}`,
  ];
  if (v.strongBelowAtr !== undefined)
    lines.push(
      v.strongBelowAtr === null
        ? "Ուժեղ զոնա ներքևում՝ չկա"
        : `Ուժեղ զոնա ներքևում՝ ${v.strongBelowAtr.toFixed(1)} ATR (FLIP, ≥ 10 օր)`,
    );
  if (trade && trade.tp !== null && v.zones) {
    const w = zoneWall(v, trade.side, trade.entry, trade.tp);
    lines.push(
      w
        ? `⚠️ TP-ի ճանապարհին զոնա կա՝ ${fmt(w.lo)} – ${fmt(w.hi)}${w.strong ? " (ուժեղ)" : ""}`
        : "TP-ի ճանապարհին զոնա չկա ✅",
    );
  }
  return lines.join("\n");
}

/** public 4h klines, cached per symbol until the next 4h close */
export class V10ZoneFinder implements V10ZoneSource {
  private cache = new Map<string, { until: number; c: ZCandle[] }>();
  constructor(
    private readonly fetchKlines: (
      symbol: string,
    ) => Promise<ZCandle[]> = publicKlines4h,
  ) {}

  async at(
    symbol: string,
    t: number,
    price: number,
  ): Promise<V10ZoneView | null> {
    let e = this.cache.get(symbol);
    if (!e || t >= e.until) {
      e = {
        until: Math.floor(t / H4) * H4 + H4,
        c: await this.fetchKlines(symbol),
      };
      this.cache.set(symbol, e);
    }
    return zoneViewOf(e.c, t, price);
  }
}

export async function publicKlines4h(symbol: string): Promise<ZCandle[]> {
  const r = await fetch(
    `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=4h&startTime=${Date.now() - 90 * DAY}&limit=1500`,
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!r.ok) throw new Error(`klines ${symbol}: HTTP ${r.status}`);
  return ((await r.json()) as unknown[][]).map((x) => ({
    t: Number(x[0]),
    open: Number(x[1]),
    high: Number(x[2]),
    low: Number(x[3]),
    close: Number(x[4]),
  }));
}
