/**
 * LIQUIDATION / OI HEATMAP (Johnny, Sep 28 2026) -- zones from OUR data, not from candles.
 *
 * Every minute of minute_bars (price range, OI, long/short liquidations $) is spread over the price layers
 * it traded through. Per layer (bin) and hour we add up:
 *   liqLong / liqShort  -- liquidations $ (where the cleaning already happened)
 *   opened              -- OI that grew there, in $ (new positions entered here = fuel for the next cleaning)
 *   closed              -- OI that fell there beyond what was liquidated, in $ (positions left voluntarily)
 * The stronger a layer (all four together), the darker it is. The main ZONES are the strongest runs of
 * neighbouring layers over the whole period.
 * Bin size is a share of the price (default 0.2%), so every coin gets layers of the same relative size.
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
  cells: Map<string, Cell>; // key `${hourIdx}:${binIdx}`
  profile: Cell[]; // per layer, whole period
  closes: Array<{ ts: number; close: number }>; // hourly close (the price line)
}
export interface HeatZone {
  lo: number;
  hi: number;
  total: number;
  liqLong: number;
  liqShort: number;
  opened: number;
  closed: number;
  kind: "LIQUIDATIONS" | "NEW POSITIONS" | "CLOSED POSITIONS";
}

const H = 3_600_000;
const zero = (): Cell => ({ liqLong: 0, liqShort: 0, opened: 0, closed: 0 });
export const cellTotal = (c: Cell): number =>
  c.liqLong + c.liqShort + c.opened + c.closed;

export function buildHeat(
  rows: readonly MinuteRow[],
  binPct = 0.2,
): Heat | null {
  const ok = rows.filter((r) => r.close > 0).sort((a, b) => a.ts - b.ts);
  if (ok.length < 60) return null;
  const lo = Math.min(...ok.map((r) => (r.low > 0 ? r.low : r.close))),
    hi = Math.max(...ok.map((r) => (r.high > 0 ? r.high : r.close)));
  const ref = ok[ok.length - 1].close,
    step = (ref * binPct) / 100;
  const first = Math.floor(lo / step) * step;
  const n = Math.max(1, Math.ceil((hi - first) / step) + 1);
  const bins = Array.from({ length: n + 1 }, (_, i) => first + i * step);
  const binOf = (p: number): number =>
    Math.min(n - 1, Math.max(0, Math.floor((p - first) / step)));
  const h0 = Math.floor(ok[0].ts / H) * H;
  const hours: number[] = [];
  for (let h = h0; h <= ok[ok.length - 1].ts; h += H) hours.push(h);
  const cells = new Map<string, Cell>();
  const profile = Array.from({ length: n }, zero);
  const closes: Heat["closes"] = [];
  let prevOi = NaN;
  for (const r of ok) {
    const hi2 = r.high > 0 ? r.high : r.close,
      lo2 = r.low > 0 ? r.low : r.close;
    const a = binOf(lo2),
      b = binOf(hi2),
      k = b - a + 1;
    const dOi = r.oi > 0 && prevOi > 0 ? (r.oi - prevOi) * r.close : 0;
    if (r.oi > 0) prevOi = r.oi;
    const hIdx = Math.floor((r.ts - h0) / H);
    for (let i = a; i <= b; i++) {
      // a liquidation also lowers OI: only the drop beyond the liquidations counts as a voluntary close
      const voluntary =
        dOi < 0 ? Math.max(0, -dOi - r.liqLong - r.liqShort) : 0;
      const add = {
        liqLong: r.liqLong / k,
        liqShort: r.liqShort / k,
        opened: dOi > 0 ? dOi / k : 0,
        closed: voluntary / k,
      };
      const key = `${hIdx}:${i}`;
      const c = cells.get(key) ?? zero();
      c.liqLong += add.liqLong;
      c.liqShort += add.liqShort;
      c.opened += add.opened;
      c.closed += add.closed;
      cells.set(key, c);
      const p = profile[i];
      p.liqLong += add.liqLong;
      p.liqShort += add.liqShort;
      p.opened += add.opened;
      p.closed += add.closed;
    }
    const last = closes[closes.length - 1];
    if (last && Math.floor(last.ts / H) === Math.floor(r.ts / H))
      last.close = r.close;
    else closes.push({ ts: Math.floor(r.ts / H) * H, close: r.close });
  }
  return { bins, hours, cells, profile, closes };
}

/** The strongest runs of neighbouring layers: layers above the 80th percentile (smoothed over 3 layers), merged, top `max`. */
export function findZones(heat: Heat, max = 5): HeatZone[] {
  const t = heat.profile.map(cellTotal);
  const s = t.map(
    (_, i) => ((t[i - 1] ?? t[i]) + t[i] + (t[i + 1] ?? t[i])) / 3,
  );
  const sorted = [...s].sort((a, b) => a - b);
  const cut = sorted[Math.floor(sorted.length * 0.8)] ?? Infinity;
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < s.length; i++) {
    if (!(s[i] >= cut && s[i] > 0)) continue;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs
    .map(([a, b]) => {
      const c = zero();
      for (let i = a; i <= b; i++) {
        const p = heat.profile[i];
        c.liqLong += p.liqLong;
        c.liqShort += p.liqShort;
        c.opened += p.opened;
        c.closed += p.closed;
      }
      const liq = c.liqLong + c.liqShort;
      const kind: HeatZone["kind"] =
        liq >= c.opened && liq >= c.closed
          ? "LIQUIDATIONS"
          : c.opened >= c.closed
            ? "NEW POSITIONS"
            : "CLOSED POSITIONS";
      return {
        lo: heat.bins[a],
        hi: heat.bins[b + 1],
        total: cellTotal(c),
        ...c,
        kind,
      };
    })
    .sort((x, y) => y.total - x.total)
    .slice(0, max);
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

/** One coin's panel: the heatmap (hours x price layers), the price line, the zones and the side profile. */
export function heatPanel(
  symbol: string,
  heat: Heat,
  zones: readonly HeatZone[],
  price: number,
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
    nH = heat.hours.length;
  const lo = heat.bins[0],
    hi = heat.bins[nB];
  const x = (hIdx: number): number => L + (hIdx / nH) * plotW;
  const y = (p: number): number => T + ((hi - p) / (hi - lo)) * plotH;
  const cw = plotW / nH,
    ch = plotH / nB;
  const liqMax = Math.max(
    1,
    ...[...heat.cells.values()].map((c) => c.liqLong + c.liqShort),
  );
  const opMax = Math.max(1, ...[...heat.cells.values()].map((c) => c.opened));
  const parts: string[] = [];
  const rects = (layer: "liq" | "opened"): string => {
    const out: string[] = [];
    for (const [key, c] of heat.cells) {
      const v = layer === "liq" ? c.liqLong + c.liqShort : c.opened;
      if (!(v > 0)) continue;
      const a = Math.sqrt(v / (layer === "liq" ? liqMax : opMax));
      if (a < 0.04) continue;
      const [h, b] = key.split(":").map(Number);
      const tip = `${yvn(heat.hours[h])} · ${fp(heat.bins[b])}-${fp(heat.bins[b + 1])}\nliquidated: longs ${usd(c.liqLong)}, shorts ${usd(c.liqShort)}\nnew positions ${usd(c.opened)} · closed ${usd(c.closed)}`;
      out.push(
        `<rect x="${x(h).toFixed(1)}" y="${y(heat.bins[b + 1]).toFixed(1)}" width="${(cw + 0.3).toFixed(1)}" height="${(ch + 0.3).toFixed(1)}" fill-opacity="${Math.min(1, a).toFixed(2)}"><title>${esc(tip)}</title></rect>`,
      );
    }
    return out.join("");
  };
  parts.push(
    `<g class="heat liq">${rects("liq")}</g><g class="heat opened" style="display:none">${rects("opened")}</g>`,
  );
  // zones
  zones.forEach((z, i) => {
    parts.push(
      `<rect class="zone" x="${L}" width="${plotW}" y="${y(z.hi).toFixed(1)}" height="${Math.max(2, y(z.lo) - y(z.hi)).toFixed(1)}"><title>${esc(`Z${i + 1} ${fp(z.lo)}-${fp(z.hi)} (${z.kind})\nliquidated longs ${usd(z.liqLong)}, shorts ${usd(z.liqShort)}\nnew positions ${usd(z.opened)}, closed ${usd(z.closed)}`)}</title></rect>`,
    );
    parts.push(
      `<text class="zlbl" x="${L + plotW + 6}" y="${((y(z.hi) + y(z.lo)) / 2 + 4).toFixed(1)}">Z${i + 1}</text>`,
    );
  });
  // price line + current price
  const pts = heat.closes
    .map(
      (c) =>
        `${(x((c.ts - heat.hours[0]) / H) + cw / 2).toFixed(1)},${y(c.close).toFixed(1)}`,
    )
    .join(" ");
  parts.push(`<polyline class="price" points="${pts}"/>`);
  parts.push(
    `<line class="now" x1="${L}" x2="${L + plotW}" y1="${y(price).toFixed(1)}" y2="${y(price).toFixed(1)}"/><text class="nowlbl" x="${L + plotW + 6}" y="${(y(price) - 4).toFixed(1)}">${fp(price)}</text>`,
  );
  // axes
  for (let i = 0; i <= 5; i++) {
    const p = lo + ((hi - lo) * i) / 5;
    if (Math.abs(y(p) - y(price)) < 18) continue;
    parts.push(
      `<text class="ax" x="${L + plotW + 6}" y="${(y(p) + 4).toFixed(1)}">${fp(p)}</text>`,
    );
  }
  for (let h = 0; h < nH; h++)
    if (new Date(heat.hours[h] + 4 * H).getUTCHours() === 0)
      parts.push(
        `<line class="grid" x1="${x(h)}" x2="${x(h)}" y1="${T}" y2="${T + plotH}"/><text class="ax" x="${x(h) + 3}" y="${HT - 8}">${yvn(heat.hours[h]).slice(0, 5)}</text>`,
      );
  // side profile: liquidations (orange) and new positions (blue), per layer over the whole period
  const px0 = L + plotW + 70,
    pw = PR - 16;
  const pMax = Math.max(
    1,
    ...heat.profile.map((c) => Math.max(c.liqLong + c.liqShort, c.opened)),
  );
  heat.profile.forEach((c, b) => {
    const yy = y(heat.bins[b + 1]),
      hh = Math.max(1, ch - 1);
    const lw = ((c.liqLong + c.liqShort) / pMax) * pw,
      ow = (c.opened / pMax) * pw;
    if (lw > 0.5)
      parts.push(
        `<rect class="pliq" x="${px0}" y="${yy.toFixed(1)}" width="${lw.toFixed(1)}" height="${(hh / 2).toFixed(1)}" rx="1"><title>${esc(`${fp(heat.bins[b])}-${fp(heat.bins[b + 1])}: liquidated ${usd(c.liqLong + c.liqShort)}`)}</title></rect>`,
      );
    if (ow > 0.5)
      parts.push(
        `<rect class="pop" x="${px0}" y="${(yy + hh / 2).toFixed(1)}" width="${ow.toFixed(1)}" height="${(hh / 2).toFixed(1)}" rx="1"><title>${esc(`${fp(heat.bins[b])}-${fp(heat.bins[b + 1])}: new positions ${usd(c.opened)}`)}</title></rect>`,
      );
  });
  parts.push(
    `<text class="ax" x="${px0}" y="${HT - 8}">whole period per layer</text>`,
  );
  const rows = zones
    .map(
      (z, i) =>
        `<tr><td>Z${i + 1}</td><td>${fp(z.lo)} – ${fp(z.hi)}</td><td>${price > z.hi ? `${(((price - z.hi) / price) * 100).toFixed(2)}% below` : price < z.lo ? `${(((z.lo - price) / price) * 100).toFixed(2)}% above` : "price is IN it"}</td><td>${z.kind === "LIQUIDATIONS" ? "cleaned (liquidations)" : z.kind === "NEW POSITIONS" ? "new positions (fuel)" : "positions closed"}</td><td>${usd(z.liqLong)}</td><td>${usd(z.liqShort)}</td><td>${usd(z.opened)}</td><td>${usd(z.closed)}</td></tr>`,
    )
    .join("");
  return `<section class="coin"><h2>${esc(symbol.replace("USDT", ""))} <span class="sub">now ${fp(price)}</span></h2>
<svg viewBox="0 0 ${W} ${HT}" width="100%" role="img" aria-label="${esc(symbol)} liquidation and open-interest heatmap">${parts.join("")}</svg>
<table><thead><tr><th>zone</th><th>price</th><th>from now</th><th>what happened there</th><th>longs liquidated</th><th>shorts liquidated</th><th>new positions</th><th>closed positions</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function heatHtml(panels: string[], title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Liquidation heatmap</title><style>
:root{--surface:#0b0e11;--card:#161a1e;--text:#eaecef;--muted:#848e9c;--grid:#2b3139;--liq:#d95926;--op:#3987e5;--price:#ffffff;--zone:#f0b90b}
@media (prefers-color-scheme: light){:root:where(:not([data-theme="dark"])){--surface:#fcfcfb;--card:#ffffff;--text:#0b0b0b;--muted:#52514e;--grid:#e4e3df;--liq:#eb6834;--op:#2a78d6;--price:#0b0b0b;--zone:#b07800}}
body{background:var(--surface);color:var(--text);font:14px system-ui,sans-serif;margin:16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:16px;margin:4px 0}.sub{color:var(--muted);font-weight:400;font-size:13px}
.coin{background:var(--card);border-radius:8px;padding:10px 12px;margin:0 0 16px}
.bar{display:flex;gap:8px;align-items:center;margin:8px 0 14px;flex-wrap:wrap}
button{background:var(--card);color:var(--text);border:1px solid var(--grid);border-radius:6px;padding:6px 10px;cursor:pointer}button.on{border-color:var(--zone)}
.heat.liq rect{fill:var(--liq)}.heat.opened rect{fill:var(--op)}
.pliq{fill:var(--liq)}.pop{fill:var(--op)}
.zone{fill:none;stroke:var(--zone);stroke-width:1.5;stroke-dasharray:5 4}.zlbl{fill:var(--zone);font-size:12px;font-weight:600}
.price{fill:none;stroke:var(--price);stroke-width:2;stroke-linejoin:round}.now{stroke:var(--price);stroke-dasharray:2 3;opacity:.6}.nowlbl{fill:var(--text);font-size:11px}
.ax{fill:var(--muted);font-size:11px}.grid{stroke:var(--grid)}
table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--grid)}th{color:var(--muted);font-weight:500}
.legend span{display:inline-flex;align-items:center;gap:5px;margin-right:12px;color:var(--muted)}.sw{width:12px;height:12px;border-radius:3px;display:inline-block}
@media (max-width:700px){table{display:block;overflow-x:auto}}
</style></head><body><h1>${esc(title)}</h1>
<div class="bar"><span class="sub">Heat shows:</span><button id="bLiq" class="on">Liquidations (cleaned)</button><button id="bOp">New positions (OI opened)</button>
<span class="legend"><span><i class="sw" style="background:var(--liq)"></i>liquidations</span><span><i class="sw" style="background:var(--op)"></i>new positions</span><span><i class="sw" style="border:1.5px dashed var(--zone)"></i>main zones</span><span><i class="sw" style="background:var(--price);height:2px"></i>price</span></span></div>
<p class="sub">Darker = more happened at that price in that hour. Hover a square for the numbers. Right: the whole period per price layer. Zones = the strongest layers (liquidations + new + closed positions together).</p>
${panels.join("\n")}
<script>
const show=(l)=>{document.querySelectorAll('.heat.liq').forEach(g=>g.style.display=l==='liq'?'':'none');document.querySelectorAll('.heat.opened').forEach(g=>g.style.display=l==='op'?'':'none');bLiq.classList.toggle('on',l==='liq');bOp.classList.toggle('on',l==='op');};
bLiq.onclick=()=>show('liq');bOp.onclick=()=>show('op');
</script></body></html>`;
}
