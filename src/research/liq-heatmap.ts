/**
 * LIQUIDATION / OPEN-POSITION HEATMAP (Johnny, Sep 28 2026) -- zones from OUR data, not from candles.
 *
 * minute_bars (price range, OI, long/short liquidations $) are read in 15-minute steps (OI per minute is
 * noisy: it goes up and down by itself, so per-minute changes would show huge "opened" and "closed" that
 * are only noise). Per price layer (bin, default 0.2% of the price) and hour:
 *   liquidations  -- longs / shorts liquidated there ($): where the cleaning already happened
 *   new positions -- OI that grew there beyond the liquidations ($)
 *   closed        -- OI that fell there beyond the liquidations ($), positions left voluntarily
 * THE LEDGER OF OPEN POSITIONS (Johnny's idea): which positions are still open, and at which entry price?
 *   OI grew  -> those positions are added to the layers the price traded in
 *   longs liquidated  -> removed from the layers ABOVE the price (longs that entered higher are the losers)
 *   shorts liquidated -> removed from the layers BELOW the price
 *   OI fell beyond the liquidations -> the NEWEST positions close first (last in, first out): quick
 *     in-and-out trades leave, positions that were built earlier and held stay -- so a band built at the
 *     bottom stays visible until the price comes back and liquidates it (or it is really closed)
 * What is left below the price = mostly longs waiting in profit (their stops/liquidations lie under them:
 * fuel for the next long cleaning); above the price = shorts waiting. It is a MODEL: the exchange does not
 * say whose position closed. It starts empty at the first stored minute, so the oldest layers are incomplete.
 */
export interface MinuteRow {
  ts: number;
  high: number;
  low: number;
  close: number;
  oi: number;
  liqLong: number;
  liqShort: number;
}
export interface Cell {
  liqLong: number;
  liqShort: number;
  opened: number;
  closed: number;
}
export interface Heat {
  bins: number[]; // lower edge of every price layer (ascending); layer i = [bins[i], bins[i+1])
  hours: number[]; // hour start timestamps (ascending)
  cells: Map<string, Cell>; // key `${hourIdx}:${binIdx}` -- what happened in that hour at that layer
  remain: Map<string, number>; // key `${hourIdx}:${binIdx}` -- $ of positions still open at the end of that hour
  profile: Cell[]; // per layer, whole period
  remainNow: number[]; // per layer, $ still open now
  closes: Array<{ ts: number; close: number }>; // hourly close (the price line)
  price: number;
  /** The ledger of open positions starts here (the end of the last market break). */
  ledgerFrom: number;
  lastBreak: MarketBreak | null;
}
/** A market break (Johnny): a big 4h impulse -- one candle or a run of same-colour candles -- after which
 *  the old positions are mostly gone (TP, SL, liquidations) and a new structure starts. */
export interface MarketBreak {
  from: number;
  to: number;
  up: boolean;
  movePct: number;
  oiPct: number;
  liqUsd: number;
  timesMedian: number;
}
export interface HeatZone {
  lo: number;
  hi: number;
  usd: number;
  liqLong: number;
  liqShort: number;
  side: "LONGS WAITING" | "SHORTS WAITING" | "LIQUIDATED";
}

const H = 3_600_000,
  STEP = 15 * 60_000;
const zero = (): Cell => ({ liqLong: 0, liqShort: 0, opened: 0, closed: 0 });

/**
 * The last market break in these rows: 4h candles (from our minute data) grouped into runs of the same
 * colour; a run whose body (open -> close) is at least `times` x this coin's median 4h body is an impulse.
 * The coin's own size decides, no fixed %. Only finished candles.
 */
export function lastBreak(
  rows: readonly MinuteRow[],
  times = 3,
): MarketBreak | null {
  const H4 = 4 * H;
  const c: Array<{
    ts: number;
    open: number;
    close: number;
    oi0: number;
    oi1: number;
    liq: number;
  }> = [];
  for (const r of rows) {
    if (!(r.close > 0)) continue;
    const t = Math.floor(r.ts / H4) * H4,
      last = c[c.length - 1];
    if (last && last.ts === t) {
      last.close = r.close;
      if (r.oi > 0) {
        last.oi1 = r.oi;
        if (!(last.oi0 > 0)) last.oi0 = r.oi;
      }
      last.liq += r.liqLong + r.liqShort;
    } else
      c.push({
        ts: t,
        open: r.close,
        close: r.close,
        oi0: r.oi,
        oi1: r.oi,
        liq: r.liqLong + r.liqShort,
      });
  }
  const now = rows.length ? rows[rows.length - 1].ts : 0;
  const done = c.filter((k) => k.ts + H4 <= now + 60_000);
  if (done.length < 6) return null;
  const bodies = done
    .map((k) => Math.abs(k.close - k.open) / k.open)
    .sort((a, b) => a - b);
  const median = bodies[bodies.length >> 1];
  if (!(median > 0)) return null;
  let best: MarketBreak | null = null;
  for (let i = 0; i < done.length; ) {
    const up = done[i].close >= done[i].open;
    let j = i;
    while (j + 1 < done.length && done[j + 1].close >= done[j + 1].open === up)
      j++;
    const move = (done[j].close - done[i].open) / done[i].open;
    const x = Math.abs(move) / median;
    if (x >= times) {
      let liq = 0;
      for (let k = i; k <= j; k++) liq += done[k].liq;
      best = {
        from: done[i].ts,
        to: done[j].ts + H4,
        up,
        movePct: 100 * move,
        oiPct:
          done[i].oi0 > 0
            ? (100 * (done[j].oi1 - done[i].oi0)) / done[i].oi0
            : NaN,
        liqUsd: liq,
        timesMedian: x,
      };
    }
    i = j + 1;
  }
  return best;
}

export function buildHeat(
  rows: readonly MinuteRow[],
  binPct = 0.2,
  ledgerFrom?: number,
): Heat | null {
  const ok = rows.filter((r) => r.close > 0).sort((a, b) => a.ts - b.ts);
  if (ok.length < 60) return null;
  const lo = Math.min(...ok.map((r) => (r.low > 0 ? r.low : r.close))),
    hi = Math.max(...ok.map((r) => (r.high > 0 ? r.high : r.close)));
  const price = ok[ok.length - 1].close,
    step = (price * binPct) / 100;
  const first = Math.floor(lo / step) * step;
  const n = Math.max(1, Math.ceil((hi - first) / step) + 1);
  const bins = Array.from({ length: n + 1 }, (_, i) => first + i * step);
  const mid = (i: number): number => first + (i + 0.5) * step;
  const binOf = (p: number): number =>
    Math.min(n - 1, Math.max(0, Math.floor((p - first) / step)));
  const h0 = Math.floor(ok[0].ts / H) * H;
  const hours: number[] = [];
  for (let h = h0; h <= ok[ok.length - 1].ts; h += H) hours.push(h);

  // 5-minute windows
  type Win = {
    ts: number;
    lo: number;
    hi: number;
    close: number;
    oi: number;
    liqLong: number;
    liqShort: number;
  };
  const wins: Win[] = [];
  for (const r of ok) {
    const w0 = Math.floor(r.ts / STEP) * STEP,
      rl = r.low > 0 ? r.low : r.close,
      rh = r.high > 0 ? r.high : r.close;
    const w = wins[wins.length - 1];
    if (w && w.ts === w0) {
      w.lo = Math.min(w.lo, rl);
      w.hi = Math.max(w.hi, rh);
      w.close = r.close;
      if (r.oi > 0) w.oi = r.oi;
      w.liqLong += r.liqLong;
      w.liqShort += r.liqShort;
    } else
      wins.push({
        ts: w0,
        lo: rl,
        hi: rh,
        close: r.close,
        oi: r.oi > 0 ? r.oi : NaN,
        liqLong: r.liqLong,
        liqShort: r.liqShort,
      });
  }

  const cells = new Map<string, Cell>(),
    remain = new Map<string, number>();
  const profile = Array.from({ length: n }, zero);
  // open positions as lots (entry layer, coins), oldest first
  const lots: Array<{ bin: number; coins: number }> = [];
  const closes: Heat["closes"] = [];
  const invNow = (): number[] => {
    const v = new Array<number>(n).fill(0);
    for (const l of lots) v[l.bin] += l.coins;
    return v;
  };
  /** Liquidated losers: remove from the lots whose layer passes `pick`, in proportion. */
  const liquidate = (coins: number, pick: (bin: number) => boolean): void => {
    let tot = 0;
    for (const l of lots) if (pick(l.bin)) tot += l.coins;
    if (!(tot > 0) || !(coins > 0)) return;
    const f = Math.min(1, coins / tot);
    for (const l of lots) if (pick(l.bin)) l.coins -= l.coins * f;
  };
  /** Voluntary closes: the newest lots first. */
  const closeNewest = (coins: number): void => {
    while (coins > 0 && lots.length) {
      const l = lots[lots.length - 1];
      if (l.coins > coins) {
        l.coins -= coins;
        return;
      }
      coins -= l.coins;
      lots.pop();
    }
  };
  let prevOi = NaN,
    lastHour = -1;
  const snapshot = (hIdx: number): void => {
    invNow().forEach((c, i) => {
      if (c > 0) remain.set(`${hIdx}:${i}`, c * mid(i));
    });
  };
  const brk = ledgerFrom === undefined ? lastBreak(ok) : null;
  const startLedger = ledgerFrom ?? brk?.to ?? ok[0].ts;
  for (const w of wins) {
    const hIdx = Math.floor((w.ts - h0) / H);
    if (lastHour >= 0 && hIdx !== lastHour) snapshot(lastHour);
    lastHour = hIdx;
    const a = binOf(w.lo),
      b = binOf(w.hi),
      k = b - a + 1,
      p = w.close;
    const dOi =
      Number.isFinite(w.oi) && Number.isFinite(prevOi) ? w.oi - prevOi : 0; // coins
    if (Number.isFinite(w.oi)) prevOi = w.oi;
    const liqCoins = (w.liqLong + w.liqShort) / p;
    const voluntary = dOi + liqCoins; // liquidations explain part of an OI drop
    // the ledger (from the last market break on): liquidated losers first, then the voluntary change
    if (w.ts >= startLedger) {
      liquidate(w.liqLong / p, (i) => mid(i) > p);
      liquidate(w.liqShort / p, (i) => mid(i) < p);
      if (voluntary > 0)
        for (let i = a; i <= b; i++)
          lots.push({ bin: i, coins: voluntary / k });
      else closeNewest(-voluntary);
    }
    for (let i = a; i <= b; i++) {
      const key = `${hIdx}:${i}`;
      const c = cells.get(key) ?? zero();
      const add = {
        liqLong: w.liqLong / k,
        liqShort: w.liqShort / k,
        opened: voluntary > 0 ? (voluntary * p) / k : 0,
        closed: voluntary < 0 ? (-voluntary * p) / k : 0,
      };
      c.liqLong += add.liqLong;
      c.liqShort += add.liqShort;
      c.opened += add.opened;
      c.closed += add.closed;
      cells.set(key, c);
      const q = profile[i];
      q.liqLong += add.liqLong;
      q.liqShort += add.liqShort;
      q.opened += add.opened;
      q.closed += add.closed;
    }
    const last = closes[closes.length - 1];
    if (last && Math.floor(last.ts / H) === Math.floor(w.ts / H))
      last.close = w.close;
    else closes.push({ ts: Math.floor(w.ts / H) * H, close: w.close });
  }
  if (lastHour >= 0) snapshot(lastHour);
  return {
    bins,
    hours,
    cells,
    remain,
    profile,
    remainNow: invNow().map((c, i) => c * mid(i)),
    closes,
    price,
    ledgerFrom: startLedger,
    lastBreak: brk,
  };
}

/** Strongest runs of neighbouring layers of `value` (80th percentile of the non-empty layers, merged). */
function runs(
  value: readonly number[],
  allow: (i: number) => boolean,
): Array<[number, number, number]> {
  const v = value.map((x, i) => (allow(i) ? x : 0));
  const s = v.map(
    (_, i) => ((v[i - 1] ?? v[i]) + v[i] + (v[i + 1] ?? v[i])) / 3,
  );
  const nz = s.filter((x) => x > 0).sort((a, b) => a - b);
  if (!nz.length) return [];
  const cut = nz[Math.floor(nz.length * 0.8)];
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < s.length; i++) {
    if (!(s[i] >= cut && v[i] > 0)) continue;
    const last = out[out.length - 1];
    if (last && i - last[1] <= 1) {
      last[1] = i;
      last[2] += v[i];
    } else out.push([i, i, v[i]]);
  }
  return out.sort((x, y) => y[2] - x[2]);
}

/** Where the cleanings already happened (liquidations, whole period). */
export function liquidationZones(heat: Heat, max = 3): HeatZone[] {
  const liq = heat.profile.map((c) => c.liqLong + c.liqShort);
  return runs(liq, () => true)
    .slice(0, max)
    .map(([a, b, usd]) => {
      let liqLong = 0,
        liqShort = 0;
      for (let i = a; i <= b; i++) {
        liqLong += heat.profile[i].liqLong;
        liqShort += heat.profile[i].liqShort;
      }
      return {
        lo: heat.bins[a],
        hi: heat.bins[b + 1],
        usd,
        liqLong,
        liqShort,
        side: "LIQUIDATED" as const,
      };
    });
}

/** Where positions are still open: longs waiting below the price, shorts waiting above it (the fuel). */
export function fuelZones(heat: Heat, maxPerSide = 3): HeatZone[] {
  const mid = (i: number): number => (heat.bins[i] + heat.bins[i + 1]) / 2;
  const make =
    (side: "LONGS WAITING" | "SHORTS WAITING") =>
    ([a, b, usd]: [number, number, number]): HeatZone => ({
      lo: heat.bins[a],
      hi: heat.bins[b + 1],
      usd,
      liqLong: 0,
      liqShort: 0,
      side,
    });
  return [
    ...runs(heat.remainNow, (i) => mid(i) < heat.price)
      .slice(0, maxPerSide)
      .map(make("LONGS WAITING")),
    ...runs(heat.remainNow, (i) => mid(i) > heat.price)
      .slice(0, maxPerSide)
      .map(make("SHORTS WAITING")),
  ];
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fp = (v: number): string =>
  v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toFixed(5);
export const usd = (v: number): string =>
  v >= 1e9
    ? `$${(v / 1e9).toFixed(2)}B`
    : v >= 1e6
      ? `$${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
        ? `$${(v / 1e3).toFixed(0)}K`
        : `$${v.toFixed(0)}`;
const yvn = (ms: number): string =>
  new Date(ms + 4 * H).toISOString().slice(5, 16).replace("T", " ");
export const fromNow = (
  z: { lo: number; hi: number },
  price: number,
): string =>
  price > z.hi
    ? `${(((price - z.hi) / price) * 100).toFixed(2)}% below`
    : price < z.lo
      ? `${(((z.lo - price) / price) * 100).toFixed(2)}% above`
      : "price is IN it";

/** One coin: the heatmap (3 views), the price line, the zones, the side profile of what is still open, two tables. */
export function heatPanel(
  symbol: string,
  heat: Heat,
  liqZ: readonly HeatZone[],
  fuelZ: readonly HeatZone[],
): string {
  const W = 1100,
    HT = 460,
    L = 8,
    PR = 230,
    T = 14,
    B = 26,
    plotW = W - L - PR - 70,
    plotH = HT - T - B;
  const nB = heat.bins.length - 1,
    nH = heat.hours.length,
    price = heat.price;
  const lo = heat.bins[0],
    hi = heat.bins[nB];
  const x = (hIdx: number): number => L + (hIdx / nH) * plotW;
  const y = (p: number): number => T + ((hi - p) / (hi - lo)) * plotH;
  const cw = plotW / nH,
    ch = plotH / nB;
  const parts: string[] = [];
  const layer = (
    cls: string,
    entries: Array<[string, number, string]>,
    hidden: boolean,
  ): string => {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    const out: string[] = [];
    for (const [key, v, tip] of entries) {
      const a = Math.sqrt(v / max);
      if (!(a >= 0.05)) continue;
      const [h, b] = key.split(":").map(Number);
      out.push(
        `<rect x="${x(h).toFixed(1)}" y="${y(heat.bins[b + 1]).toFixed(1)}" width="${(cw + 0.3).toFixed(1)}" height="${(ch + 0.3).toFixed(1)}" fill-opacity="${Math.min(1, a).toFixed(2)}"><title>${esc(tip)}</title></rect>`,
      );
    }
    return `<g class="heat ${cls}"${hidden ? ' style="display:none"' : ""}>${out.join("")}</g>`;
  };
  const where = (key: string): string => {
    const [h, b] = key.split(":").map(Number);
    return `${yvn(heat.hours[h])} · ${fp(heat.bins[b])}-${fp(heat.bins[b + 1])}`;
  };
  const cellTip = (key: string, c: Cell): string =>
    `${where(key)}\nliquidated: longs ${usd(c.liqLong)}, shorts ${usd(c.liqShort)}\nnew positions ${usd(c.opened)} · closed ${usd(c.closed)}`;
  parts.push(
    layer(
      "remain",
      [...heat.remain].map(([k, v]) => [
        k,
        v,
        `${where(k)}\nstill open at the end of this hour: ${usd(v)}`,
      ]),
      false,
    ),
  );
  parts.push(
    layer(
      "liq",
      [...heat.cells].map(([k, c]) => [
        k,
        c.liqLong + c.liqShort,
        cellTip(k, c),
      ]),
      true,
    ),
  );
  parts.push(
    layer(
      "opened",
      [...heat.cells].map(([k, c]) => [k, c.opened, cellTip(k, c)]),
      true,
    ),
  );
  const box = (z: HeatZone, label: string, cls: string): void => {
    parts.push(
      `<rect class="${cls}" x="${L}" width="${plotW}" y="${y(z.hi).toFixed(1)}" height="${Math.max(2, y(z.lo) - y(z.hi)).toFixed(1)}"><title>${esc(`${label} ${fp(z.lo)}-${fp(z.hi)} ${z.side} ${usd(z.usd)}`)}</title></rect>`,
    );
    parts.push(
      `<text class="${cls}lbl" x="${L + plotW + 6}" y="${((y(z.hi) + y(z.lo)) / 2 + 4).toFixed(1)}">${label}</text>`,
    );
  };
  fuelZ.forEach((z, i) => box(z, `F${i + 1}`, "fzone"));
  liqZ.forEach((z, i) => box(z, `L${i + 1}`, "lzone"));
  const pts = heat.closes
    .map(
      (c) =>
        `${(x((c.ts - heat.hours[0]) / H) + cw / 2).toFixed(1)},${y(c.close).toFixed(1)}`,
    )
    .join(" ");
  parts.push(`<polyline class="price" points="${pts}"/>`);
  if (heat.lastBreak) {
    const bx0 = x((heat.lastBreak.from - heat.hours[0]) / H),
      bx1 = x((heat.lastBreak.to - heat.hours[0]) / H);
    parts.push(
      `<rect class="brk" x="${bx0.toFixed(1)}" y="${T}" width="${Math.max(2, bx1 - bx0).toFixed(1)}" height="${plotH}"><title>${esc(`last market break ${yvn(heat.lastBreak.from)} -> ${yvn(heat.lastBreak.to)}: ${heat.lastBreak.movePct.toFixed(2)}%, OI ${heat.lastBreak.oiPct.toFixed(2)}%, liquidations ${usd(heat.lastBreak.liqUsd)}`)}</title></rect><text class="brklbl" text-anchor="end" x="${(bx0 - 4).toFixed(1)}" y="${T + 12}">last market break →</text>`,
    );
  }
  parts.push(
    `<line class="now" x1="${L}" x2="${L + plotW}" y1="${y(price).toFixed(1)}" y2="${y(price).toFixed(1)}"/><text class="nowlbl" x="${L + plotW + 30}" y="${(y(price) + 4).toFixed(1)}">${fp(price)}</text>`,
  );
  for (let i = 0; i <= 5; i++) {
    const p = lo + ((hi - lo) * i) / 5;
    if (Math.abs(y(p) - y(price)) < 18) continue;
    parts.push(
      `<text class="ax" x="${L + plotW + 30}" y="${(y(p) + 4).toFixed(1)}">${fp(p)}</text>`,
    );
  }
  for (let h = 0; h < nH; h++)
    if (new Date(heat.hours[h] + 4 * H).getUTCHours() === 0)
      parts.push(
        `<line class="grid" x1="${x(h)}" x2="${x(h)}" y1="${T}" y2="${T + plotH}"/><text class="ax" x="${x(h) + 3}" y="${HT - 8}">${yvn(heat.hours[h]).slice(0, 5)}</text>`,
      );
  // side profile: what is still open now, by entry layer (below the price = longs waiting, above = shorts waiting)
  const px0 = L + plotW + 90,
    pw = PR - 36;
  const pMax = Math.max(1, ...heat.remainNow);
  heat.remainNow.forEach((v, b) => {
    const w = (v / pMax) * pw;
    if (!(w > 0.5)) return;
    const m = (heat.bins[b] + heat.bins[b + 1]) / 2;
    parts.push(
      `<rect class="${m < price ? "plong" : "pshort"}" x="${px0}" y="${y(heat.bins[b + 1]).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, ch - 1).toFixed(1)}" rx="1"><title>${esc(`${fp(heat.bins[b])}-${fp(heat.bins[b + 1])}: ${usd(v)} still open (${m < price ? "longs waiting" : "shorts waiting"})`)}</title></rect>`,
    );
  });
  parts.push(`<text class="ax" x="${px0}" y="${HT - 8}">still open now</text>`);
  const fuelRows = fuelZ
    .map(
      (z, i) =>
        `<tr><td>F${i + 1}</td><td>${z.side === "LONGS WAITING" ? "longs waiting (their stops are below)" : "shorts waiting (their stops are above)"}</td><td>${fp(z.lo)} – ${fp(z.hi)}</td><td>${fromNow(z, price)}</td><td>${usd(z.usd)}</td></tr>`,
    )
    .join("");
  const liqRows = liqZ
    .map(
      (z, i) =>
        `<tr><td>L${i + 1}</td><td>${fp(z.lo)} – ${fp(z.hi)}</td><td>${fromNow(z, price)}</td><td>${usd(z.liqLong)}</td><td>${usd(z.liqShort)}</td></tr>`,
    )
    .join("");
  return `<section class="coin"><h2>${esc(symbol.replace("USDT", ""))} <span class="sub">now ${fp(price)}</span></h2>
<svg viewBox="0 0 ${W} ${HT}" width="100%" role="img" aria-label="${esc(symbol)} heatmap of open positions and liquidations">${parts.join("")}</svg>
<div class="tables"><table><caption>⛽ Fuel: positions still open (model)</caption><thead><tr><th></th><th>who</th><th>price</th><th>from now</th><th>still open</th></tr></thead><tbody>${fuelRows || '<tr><td colspan="5">none</td></tr>'}</tbody></table>
<table><caption>🔥 Already cleaned (liquidations)</caption><thead><tr><th></th><th>price</th><th>from now</th><th>longs liq.</th><th>shorts liq.</th></tr></thead><tbody>${liqRows || '<tr><td colspan="5">none</td></tr>'}</tbody></table></div></section>`;
}

export function heatHtml(panels: string[], title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Position heatmap</title><style>
:root{--surface:#0b0e11;--card:#161a1e;--text:#eaecef;--muted:#848e9c;--grid:#2b3139;--liq:#d95926;--op:#3987e5;--rem:#199e70;--short:#9085e9;--price:#ffffff;--zone:#f0b90b}
@media (prefers-color-scheme: light){:root:where(:not([data-theme="dark"])){--surface:#fcfcfb;--card:#ffffff;--text:#0b0b0b;--muted:#52514e;--grid:#e4e3df;--liq:#eb6834;--op:#2a78d6;--rem:#1baf7a;--short:#4a3aa7;--price:#0b0b0b;--zone:#b07800}}
body{background:var(--surface);color:var(--text);font:14px system-ui,sans-serif;margin:16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:16px;margin:4px 0}.sub{color:var(--muted);font-weight:400;font-size:13px}
.coin{background:var(--card);border-radius:8px;padding:10px 12px;margin:0 0 16px}
.bar{display:flex;gap:8px;align-items:center;margin:8px 0 10px;flex-wrap:wrap}
button{background:var(--card);color:var(--text);border:1px solid var(--grid);border-radius:6px;padding:6px 10px;cursor:pointer}button.on{border-color:var(--zone)}
.heat.remain rect{fill:var(--rem)}.heat.liq rect{fill:var(--liq)}.heat.opened rect{fill:var(--op)}
.plong{fill:var(--rem)}.pshort{fill:var(--short)}
.fzone{fill:none;stroke:var(--zone);stroke-width:1.5;stroke-dasharray:5 4}.fzonelbl{fill:var(--zone);font-size:12px;font-weight:600}
.lzone{fill:none;stroke:var(--liq);stroke-width:1.2;stroke-dasharray:2 3}.lzonelbl{fill:var(--liq);font-size:12px;font-weight:600}
.price{fill:none;stroke:var(--price);stroke-width:2;stroke-linejoin:round}.now{stroke:var(--price);stroke-dasharray:2 3;opacity:.6}.nowlbl{fill:var(--text);font-size:11px;font-weight:600}
.ax{fill:var(--muted);font-size:11px}.grid{stroke:var(--grid)}.brk{fill:var(--zone);fill-opacity:.12}.brklbl{fill:var(--zone);font-size:11px}
.tables{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:800px){.tables{grid-template-columns:1fr}}
table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px}caption{text-align:left;font-weight:600;padding:4px 0}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--grid)}th{color:var(--muted);font-weight:500}
.legend span{display:inline-flex;align-items:center;gap:5px;margin-right:12px;color:var(--muted)}.sw{width:12px;height:12px;border-radius:3px;display:inline-block}
</style></head><body><h1>${esc(title)}</h1>
<div class="bar"><span class="sub">Heat shows:</span><button id="bRem" class="on">Positions still open</button><button id="bLiq">Liquidations</button><button id="bOp">New positions</button></div>
<div class="bar legend"><span><i class="sw" style="background:var(--rem)"></i>longs waiting (below the price)</span><span><i class="sw" style="background:var(--short)"></i>shorts waiting (above)</span><span><i class="sw" style="background:var(--liq)"></i>liquidations</span><span><i class="sw" style="background:var(--op)"></i>new positions</span><span><i class="sw" style="border:1.5px dashed var(--zone)"></i>F = fuel zone</span><span><i class="sw" style="border:1.5px dotted var(--liq)"></i>L = cleaned zone</span></div>
<p class="sub">"Positions still open": darker = more positions opened at that price are still open at that hour; a band that fades = they were closed. Below the price they are mostly longs in profit (their stops and liquidations lie under them = fuel for the next long cleaning); above, shorts. This is a model of our OI and liquidations -- the exchange does not say whose position closed. Hover a square for the numbers.</p>
${panels.join("\n")}
<script>
const views={rem:'remain',liq:'liq',op:'opened'};const btn={rem:bRem,liq:bLiq,op:bOp};
const show=(v)=>{for(const k in views){document.querySelectorAll('.heat.'+views[k]).forEach(g=>g.style.display=k===v?'':'none');btn[k].classList.toggle('on',k===v);}};
bRem.onclick=()=>show('rem');bLiq.onclick=()=>show('liq');bOp.onclick=()=>show('op');
</script></body></html>`;
}

/**
 * A TradingView Pine Script (v5) that draws these zones on the chart of the coin it is added to:
 * tradingview.com -> Pine Editor -> paste -> "Add to chart" on e.g. BINANCE:BTCUSDT.P. The zones are a
 * snapshot of the moment the script was made -- run the tool again for fresh ones.
 */
export function pineScript(
  coins: ReadonlyArray<{
    symbol: string;
    fuel: readonly HeatZone[];
    cleaned: readonly HeatZone[];
    breakTs: number | null;
    madeAt: number;
  }>,
): string {
  const lines: string[] = [
    "//@version=5",
    `indicator("liquidation-detector zones", overlay=true, max_boxes_count=200, max_lines_count=50)`,
    "// F = fuel: positions still open since the last market break (model) -- teal = longs waiting (stops below), purple = shorts waiting (stops above)",
    "// L = cleaned: liquidations already happened there (orange). Dashed orange line = the last market break.",
    `// made ${new Date(coins[0]?.madeAt ?? Date.now()).toISOString().slice(0, 16)} UTC -- a snapshot, make a new one for fresh zones`,
    "zone(t, lo, hi, col, txt) =>",
    "    box.new(t, hi, t + 60000, lo, xloc=xloc.bar_time, extend=extend.right, border_color=col, border_style=line.style_dashed, bgcolor=color.new(col, 85), text=txt, text_color=col, text_size=size.small, text_halign=text.align_right, text_valign=text.align_center)",
    "var bool drawn = false",
    "if barstate.islast and not drawn",
    "    drawn := true",
  ];
  for (const c of coins) {
    const key = c.symbol.toUpperCase();
    lines.push(`    if str.startswith(syminfo.ticker, "${key}")`);
    const t0 = c.breakTs ?? c.madeAt - 86_400_000;
    let n = 0;
    c.fuel.forEach((z, i) => {
      n++;
      lines.push(
        `        zone(${t0}, ${+z.lo.toPrecision(7)}, ${+z.hi.toPrecision(7)}, ${z.side === "LONGS WAITING" ? "color.teal" : "color.purple"}, "F${i + 1} ${z.side === "LONGS WAITING" ? "longs waiting" : "shorts waiting"} ${usd(z.usd)}")`,
      );
    });
    c.cleaned.forEach((z, i) => {
      n++;
      lines.push(
        `        zone(${t0}, ${+z.lo.toPrecision(7)}, ${+z.hi.toPrecision(7)}, color.orange, "L${i + 1} cleaned")`,
      );
    });
    if (c.breakTs) {
      n++;
      lines.push(
        `        line.new(${c.breakTs}, close, ${c.breakTs}, close * 1.001, xloc=xloc.bar_time, extend=extend.both, color=color.orange, style=line.style_dashed)`,
      );
    }
    if (!n) lines.push("        na");
  }
  return lines.join("\n") + "\n";
}
