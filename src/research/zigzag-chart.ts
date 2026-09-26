import type { ChainTrade, Wave, ZBar } from "./oi-zigzag";

const stamp = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const coins = (v: number): string =>
  Math.abs(v) >= 1e6
    ? `${(v / 1e6).toFixed(2)}M`
    : Math.abs(v) >= 1e3
      ? `${(v / 1e3).toFixed(1)}K`
      : v.toFixed(0);
const px = (p: number): string =>
  p >= 1000
    ? p.toFixed(1)
    : p >= 10
      ? p.toFixed(2)
      : p >= 1
        ? p.toFixed(4)
        : p.toFixed(5);

/** Self-contained SVG chart: price (top), OI with zigzag (bottom), waves shaded. */
export function zigzagChartHtml(
  symbol: string,
  bars: readonly ZBar[],
  waves: readonly Wave[],
  rPct: number,
  trades: ReadonlyArray<ChainTrade & { grade: string }> = [],
): string {
  const W = Math.max(1200, bars.length * 1.2),
    H1 = 300,
    H2 = 220,
    M = 60;
  const x = (i: number): number => M + (i / (bars.length - 1)) * (W - 2 * M);
  const scale = (vals: number[], top: number, h: number) => {
    const f = vals.filter(Number.isFinite);
    const lo = Math.min(...f),
      hi = Math.max(...f);
    return {
      f: (v: number) => top + h - ((v - lo) / (hi - lo || 1)) * h,
      lo,
      hi,
    };
  };
  const ps = scale(
    bars.flatMap((b) => [b.low, b.high]),
    30,
    H1 - 40,
  );
  const os = scale(
    bars.map((b) => b.oi),
    H1 + 30,
    H2 - 40,
  );
  const line = (vals: number[], f: (v: number) => number): string =>
    vals
      .map((v, i) =>
        Number.isFinite(v) ? `${x(i).toFixed(1)},${f(v).toFixed(1)}` : "",
      )
      .filter(Boolean)
      .join(" ");
  const idx = (ts: number): number => Math.round((ts - bars[0].ts) / 60_000);
  const color: Record<Wave["kind"], string> = {
    LONG_CLEANING: "rgba(220,50,50,0.18)",
    SHORT_CLEANING: "rgba(40,110,230,0.18)",
    OI_DOWN: "rgba(128,128,128,0.08)",
    OI_UP: "rgba(30,170,90,0.14)",
  };
  const bands = waves
    .map(
      (w) =>
        `<rect x="${x(idx(w.from.ts)).toFixed(1)}" y="20" width="${(x(idx(w.to.ts)) - x(idx(w.from.ts))).toFixed(1)}" height="${H1 + H2 - 10}" fill="${color[w.kind]}"><title>${w.kind} ${stamp(w.from.ts)} -> ${stamp(w.to.ts)}  OI ${w.oiChangePct.toFixed(2)}%  price ${px(w.priceStart)} -> ${px(w.priceEnd)}</title></rect>`,
    )
    .join("");
  const zz = waves.length
    ? [waves[0].from, ...waves.map((w) => w.to)]
        .map((p) => `${x(idx(p.ts)).toFixed(1)},${os.f(p.oi).toFixed(1)}`)
        .join(" ")
    : "";
  const liqMarks = bars
    .map((b, i) => {
      const out: string[] = [];
      if (b.longLiq > 0)
        out.push(
          `<circle cx="${x(i).toFixed(1)}" cy="${(ps.f(b.low) + 6).toFixed(1)}" r="${Math.min(8, 1.5 + Math.log10(b.longLiq + 1) / 1.2).toFixed(1)}" fill="rgba(220,50,50,0.6)"><title>LONG liq $${Math.round(b.longLiq)} ${stamp(b.ts)}</title></circle>`,
        );
      if (b.shortLiq > 0)
        out.push(
          `<circle cx="${x(i).toFixed(1)}" cy="${(ps.f(b.high) - 6).toFixed(1)}" r="${Math.min(8, 1.5 + Math.log10(b.shortLiq + 1) / 1.2).toFixed(1)}" fill="rgba(40,110,230,0.6)"><title>SHORT liq $${Math.round(b.shortLiq)} ${stamp(b.ts)}</title></circle>`,
        );
      return out.join("");
    })
    .join("");
  const tradeMarks = trades
    .filter((t) => t.slPrice !== null)
    .map((t) => {
      const x0 = x(idx(t.decidedTs)),
        x1 = x(idx(t.exitTs ?? bars[bars.length - 1].ts));
      const col =
        t.result === "TP" ? "#1a9e55" : t.result === "SL" ? "#d33" : "#888";
      const tri =
        t.side === "LONG"
          ? `${x0},${ps.f(t.entry) + 10} ${x0 - 6},${ps.f(t.entry) + 20} ${x0 + 6},${ps.f(t.entry) + 20}`
          : `${x0},${ps.f(t.entry) - 10} ${x0 - 6},${ps.f(t.entry) - 20} ${x0 + 6},${ps.f(t.entry) - 20}`;
      return `<g><title>[${t.grade}] ${t.side === "LONG" ? "BUY" : "SELL"} ${stamp(t.decidedTs)} @ ${px(t.entry)}  SL ${px(t.slPrice!)}  TP ${px(t.tpPrice!)}  -> ${t.result} ${t.exitTs ? stamp(t.exitTs) : ""}  netR ${t.netR?.toFixed(2)}</title>
<line x1="${x0}" y1="${ps.f(t.tpPrice!)}" x2="${x1}" y2="${ps.f(t.tpPrice!)}" stroke="#1a9e55" stroke-width="1.5" stroke-dasharray="4 2"/>
<line x1="${x0}" y1="${ps.f(t.slPrice!)}" x2="${x1}" y2="${ps.f(t.slPrice!)}" stroke="#d33" stroke-width="1.5" stroke-dasharray="4 2"/>
<line x1="${x0}" y1="${ps.f(t.entry)}" x2="${x1}" y2="${ps.f(t.exitPrice ?? t.entry)}" stroke="${col}" stroke-width="2"/>
<polygon points="${tri}" fill="${col}"/><text x="${x0 + 8}" y="${ps.f(t.entry) + (t.side === "LONG" ? 30 : -24)}" font-size="11" font-weight="bold" fill="${col}">${t.grade} ${t.side === "LONG" ? "BUY" : "SELL"} ${t.result}</text></g>`;
    })
    .join("");
  const hours = bars
    .map((b, i) =>
      b.ts % 3_600_000 === 0
        ? `<line x1="${x(i).toFixed(1)}" y1="20" x2="${x(i).toFixed(1)}" y2="${H1 + H2 + 10}" stroke="#ddd"/><text x="${(x(i) + 2).toFixed(1)}" y="${H1 + H2 + 24}" font-size="10" fill="#666">${stamp(b.ts).slice(6)}</text>`
        : "",
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${symbol} OI zigzag</title>
<style>body{font-family:system-ui,sans-serif;margin:12px;background:#fff;color:#222}.wrap{overflow-x:auto;border:1px solid #ddd}</style></head><body>
<h3>${symbol} — OI zigzag (R = ${rPct.toFixed(3)}%)</h3>
<p>Top: price, red dots = LONG liquidations, blue dots = SHORT liquidations (size = log $). Bottom: OI (grey) and its zigzag (black).<br>
Bands: <span style="background:${color.LONG_CLEANING}">LONG cleaning</span> <span style="background:${color.SHORT_CLEANING}">SHORT cleaning</span> <span style="background:${color.OI_UP}">OI up (accumulation)</span> <span style="background:${color.OI_DOWN}">OI down without cleaning</span>. Triangles = simulated late entries (green TP / red SL), dashed lines = TP and SL. Hover a band or a trade for its numbers. Times UTC. Scroll right →</p>
<div class="wrap"><svg width="${W.toFixed(0)}" height="${H1 + H2 + 40}" xmlns="http://www.w3.org/2000/svg">
${hours}${bands}
<polyline points="${line(
    bars.map((b) => b.close),
    ps.f,
  )}" fill="none" stroke="#222" stroke-width="1"/>
${liqMarks}${tradeMarks}
<polyline points="${line(
    bars.map((b) => b.oi),
    os.f,
  )}" fill="none" stroke="#999" stroke-width="1"/>
<polyline points="${zz}" fill="none" stroke="#000" stroke-width="2"/>
<text x="4" y="40" font-size="11">${px(ps.hi)}</text><text x="4" y="${H1 - 10}" font-size="11">${px(ps.lo)}</text>
<text x="4" y="${H1 + 40}" font-size="11">OI ${coins(os.hi)}</text><text x="4" y="${H1 + H2 - 10}" font-size="11">OI ${coins(os.lo)}</text>
</svg></div></body></html>`;
}

/** One minute of the merged study data (price + OI + liquidations, zeros when none). */
export interface StudyBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oi: number;
  longLiq: number;
  shortLiq: number;
  longCount: number;
  shortCount: number;
  hasData: boolean;
}

/** STUDY CHART (Johnny, Sep 26): three panels on one time axis, waves shaded
 *  through all of them --
 *   1. price as 5-minute candles, liquidation dots (red LONG below, blue SHORT above)
 *   2. liquidations per minute as bars (SHORT up, LONG down, sqrt scale)
 *   3. OI (grey) and its zigzag (black)
 *  Hover anywhere: that minute's numbers (UTC and Yerevan time). Scroll right. */
export function zigzagStudyHtml(
  symbol: string,
  bars: readonly StudyBar[],
  waves: readonly Wave[],
  rPct: number,
): string {
  const n = bars.length;
  const PX = 1.3,
    M = 70,
    H1 = 320,
    H2 = 130,
    H3 = 200,
    GAP = 18;
  const W = M * 2 + n * PX;
  const x = (i: number): number => M + i * PX;
  const t0 = bars[0].ts;
  const idx = (ts: number): number => Math.round((ts - t0) / 60_000);
  const top1 = 30,
    top2 = top1 + H1 + GAP,
    top3 = top2 + H2 + GAP,
    bottom = top3 + H3;
  const fin = (v: number[]) => v.filter(Number.isFinite);
  const pLo = Math.min(...fin(bars.map((b) => b.low))),
    pHi = Math.max(...fin(bars.map((b) => b.high)));
  const py = (v: number): number =>
    top1 + H1 - ((v - pLo) / (pHi - pLo || 1)) * H1;
  const oLo = Math.min(...fin(bars.map((b) => b.oi))),
    oHi = Math.max(...fin(bars.map((b) => b.oi)));
  const oy = (v: number): number =>
    top3 + H3 - ((v - oLo) / (oHi - oLo || 1)) * H3;
  const lMax = Math.max(1, ...bars.map((b) => Math.max(b.longLiq, b.shortLiq)));
  const mid2 = top2 + H2 / 2;
  const ly = (v: number): number =>
    (Math.sqrt(v) / Math.sqrt(lMax)) * (H2 / 2 - 2);
  const color: Record<Wave["kind"], string> = {
    LONG_CLEANING: "rgba(220,50,50,0.16)",
    SHORT_CLEANING: "rgba(40,110,230,0.16)",
    OI_DOWN: "rgba(128,128,128,0.08)",
    OI_UP: "rgba(30,170,90,0.13)",
  };
  const label: Record<Wave["kind"], string> = {
    LONG_CLEANING: "LONG cleaning",
    SHORT_CLEANING: "SHORT cleaning",
    OI_DOWN: "OI down",
    OI_UP: "OI up",
  };
  const shown = waves.filter((w) => w.to.ts > t0);
  const bands = shown
    .map((w) => {
      const a = Math.max(0, idx(w.from.ts)),
        z = idx(w.to.ts);
      return `<rect x="${x(a).toFixed(1)}" y="${top1}" width="${Math.max(1, (z - a) * PX).toFixed(1)}" height="${bottom - top1}" fill="${color[w.kind]}"><title>${label[w.kind]} ${stamp(w.from.ts)} -> ${stamp(w.to.ts)} UTC (${w.minutes} min)
OI ${w.oiChangePct >= 0 ? "+" : ""}${w.oiChangePct.toFixed(2)}% (${coins(w.coins)})
price ${px(w.priceStart)} -> ${px(w.priceEnd)}  (low ${px(w.priceLow)} / high ${px(w.priceHigh)})
liq LONG $${coins(w.longLiqUsd)} / SHORT $${coins(w.shortLiqUsd)}</title></rect>`;
    })
    .join("");
  // 5-minute candles
  const candles: string[] = [];
  for (let s = 0; s < n; s += 5) {
    const g = bars.slice(s, s + 5).filter((b) => Number.isFinite(b.close));
    if (!g.length) continue;
    const o = g[0].open,
      c = g[g.length - 1].close,
      h = Math.max(...g.map((b) => b.high)),
      l = Math.min(...g.map((b) => b.low));
    const col = c >= o ? "#1a9e55" : "#d33";
    const cx = x(s + 2);
    candles.push(
      `<line x1="${cx.toFixed(1)}" y1="${py(h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${py(l).toFixed(1)}" stroke="${col}" stroke-width="1"/><rect x="${(cx - 2.5).toFixed(1)}" y="${Math.min(py(o), py(c)).toFixed(1)}" width="5" height="${Math.max(1, Math.abs(py(o) - py(c))).toFixed(1)}" fill="${col}"/>`,
    );
  }
  const dots: string[] = [],
    liqBars: string[] = [];
  bars.forEach((b, i) => {
    if (b.longLiq > 0) {
      dots.push(
        `<circle cx="${x(i).toFixed(1)}" cy="${(py(b.low) + 7).toFixed(1)}" r="${Math.min(8, 1.5 + Math.log10(b.longLiq + 1) / 1.2).toFixed(1)}" fill="rgba(220,50,50,0.55)"/>`,
      );
      liqBars.push(
        `<rect x="${x(i).toFixed(1)}" y="${mid2}" width="${Math.max(1, PX).toFixed(1)}" height="${ly(b.longLiq).toFixed(1)}" fill="#d33"/>`,
      );
    }
    if (b.shortLiq > 0) {
      dots.push(
        `<circle cx="${x(i).toFixed(1)}" cy="${(py(b.high) - 7).toFixed(1)}" r="${Math.min(8, 1.5 + Math.log10(b.shortLiq + 1) / 1.2).toFixed(1)}" fill="rgba(40,110,230,0.55)"/>`,
      );
      liqBars.push(
        `<rect x="${x(i).toFixed(1)}" y="${(mid2 - ly(b.shortLiq)).toFixed(1)}" width="${Math.max(1, PX).toFixed(1)}" height="${ly(b.shortLiq).toFixed(1)}" fill="#2a6ee6"/>`,
      );
    }
  });
  const oiLine = bars
    .map((b, i) =>
      Number.isFinite(b.oi) ? `${x(i).toFixed(1)},${oy(b.oi).toFixed(1)}` : "",
    )
    .filter(Boolean)
    .join(" ");
  const pivots = shown.length
    ? [shown[0].from, ...shown.map((w) => w.to)].filter((p) => p.ts >= t0)
    : [];
  const zz = pivots
    .map((p) => `${x(idx(p.ts)).toFixed(1)},${oy(p.oi).toFixed(1)}`)
    .join(" ");
  const grid = bars
    .map((b, i) => {
      if (b.ts % 3_600_000 !== 0) return "";
      const day = b.ts % 86_400_000 === 0;
      return `<line x1="${x(i).toFixed(1)}" y1="${top1}" x2="${x(i).toFixed(1)}" y2="${bottom}" stroke="${day ? "#888" : "#e4e4e4"}" stroke-width="${day ? 1.5 : 1}"/><text x="${(x(i) + 2).toFixed(1)}" y="${bottom + 14}" font-size="10" fill="${day ? "#000" : "#777"}" font-weight="${day ? "bold" : "normal"}">${day ? stamp(b.ts).slice(0, 5) : stamp(b.ts).slice(6, 8)}</text>`;
    })
    .join("");
  // compact per-minute data for the hover readout
  const kindAt = new Array<string>(n).fill("");
  for (const w of shown)
    for (
      let i = Math.max(0, idx(w.from.ts));
      i < Math.min(n, idx(w.to.ts));
      i++
    )
      kindAt[i] = label[w.kind];
  const data = JSON.stringify({
    t0,
    c: bars.map((b) => +b.close.toPrecision(8)),
    o: bars.map((b) => +b.oi.toPrecision(9)),
    l: bars.map((b) => Math.round(b.longLiq)),
    s: bars.map((b) => Math.round(b.shortLiq)),
    k: kindAt,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${symbol} study</title>
<style>body{font-family:system-ui,sans-serif;margin:12px;background:#fff;color:#222}.wrap{overflow-x:auto;border:1px solid #ddd;position:relative}
#tip{position:fixed;bottom:8px;right:8px;background:#222;color:#fff;font:12px/1.5 ui-monospace,monospace;padding:8px 10px;border-radius:6px;white-space:pre;pointer-events:none;opacity:.92}</style></head><body>
<h3>${symbol} — price, liquidations, OI zigzag (R now = ${rPct.toFixed(3)}%)</h3>
<p style="font-size:13px">1) price, 5-min candles; dots = liquidations (red LONG below, blue SHORT above). 2) liquidations per minute: blue up = SHORT, red down = LONG. 3) OI (grey) and zigzag (black).<br>
Bands: <span style="background:${color.LONG_CLEANING}">LONG cleaning</span> <span style="background:${color.SHORT_CLEANING}">SHORT cleaning</span> <span style="background:${color.OI_UP}">OI up</span> <span style="background:${color.OI_DOWN}">OI down, no cleaning</span>. Axis in UTC (bold = new day); the box bottom-right shows the minute under the mouse (on a phone: tap), also in Yerevan time. Scroll right →</p>
<div id="tip">move the mouse over the chart</div>
<div class="wrap"><svg id="svg" width="${W.toFixed(0)}" height="${bottom + 24}" xmlns="http://www.w3.org/2000/svg">
${grid}${bands}
${candles.join("")}${dots.join("")}
<line x1="${M}" y1="${mid2}" x2="${(W - M).toFixed(0)}" y2="${mid2}" stroke="#bbb"/>${liqBars.join("")}
<polyline points="${oiLine}" fill="none" stroke="#999" stroke-width="1"/>
<polyline points="${zz}" fill="none" stroke="#000" stroke-width="2"/>
<line id="cross" x1="0" y1="${top1}" x2="0" y2="${bottom}" stroke="#000" stroke-dasharray="3 3" visibility="hidden"/>
<text x="4" y="${top1 + 10}" font-size="11">${px(pHi)}</text><text x="4" y="${top1 + H1}" font-size="11">${px(pLo)}</text>
<text x="4" y="${top2 + 10}" font-size="11">SHORT</text><text x="4" y="${top2 + H2}" font-size="11">LONG</text><text x="4" y="${mid2 - 3}" font-size="10" fill="#777">max $${coins(lMax)}</text>
<text x="4" y="${top3 + 10}" font-size="11">OI ${coins(oHi)}</text><text x="4" y="${top3 + H3}" font-size="11">OI ${coins(oLo)}</text>
</svg></div>
<script>
const D=${data};const svg=document.getElementById("svg"),tip=document.getElementById("tip"),cross=document.getElementById("cross");
const f=(v)=>{const a=Math.abs(v),g=v<0?"-":"";return g+(a>=1e6?(a/1e6).toFixed(2)+"M":a>=1e3?(a/1e3).toFixed(1)+"K":String(a));};
const hm=(ms)=>new Date(ms).toISOString().slice(5,16).replace("T"," ");
const show=(cx)=>{const r=svg.getBoundingClientRect();const i=Math.round((cx-r.left-${M})/${PX});if(i<0||i>=D.c.length)return;
cross.setAttribute("x1",${M}+i*${PX});cross.setAttribute("x2",${M}+i*${PX});cross.setAttribute("visibility","visible");
const ts=D.t0+i*60000;const d0=i>0?D.o[i]-D.o[i-1]:0;
tip.textContent="UTC     "+hm(ts)+"\\nYerevan "+hm(ts+4*3600000)+"\\nprice   "+D.c[i]+"\\nOI      "+f(D.o[i])+"  ("+(d0>=0?"+":"")+f(Math.round(d0))+" this min)\\nLONG liq  $"+f(D.l[i])+"\\nSHORT liq $"+f(D.s[i])+"\\nwave    "+(D.k[i]||"-");};
svg.addEventListener("mousemove",(e)=>show(e.clientX));svg.addEventListener("click",(e)=>show(e.clientX));svg.addEventListener("touchmove",(e)=>show(e.touches[0].clientX),{passive:true});
</script></body></html>`;
}
