import type { ChainTrade, Wave, ZBar } from "./oi-zigzag";

const stamp = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const coins = (v: number): string => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));
const px = (p: number): string => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(5));

/** Self-contained SVG chart: price (top), OI with zigzag (bottom), waves shaded. */
export function zigzagChartHtml(symbol: string, bars: readonly ZBar[], waves: readonly Wave[], rPct: number, trades: ReadonlyArray<ChainTrade & { grade: string }> = []): string {
  const W = Math.max(1200, bars.length * 1.2), H1 = 300, H2 = 220, M = 60;
  const x = (i: number): number => M + (i / (bars.length - 1)) * (W - 2 * M);
  const scale = (vals: number[], top: number, h: number) => { const f = vals.filter(Number.isFinite); const lo = Math.min(...f), hi = Math.max(...f); return { f: (v: number) => top + h - ((v - lo) / (hi - lo || 1)) * h, lo, hi }; };
  const ps = scale(bars.flatMap((b) => [b.low, b.high]), 30, H1 - 40);
  const os = scale(bars.map((b) => b.oi), H1 + 30, H2 - 40);
  const line = (vals: number[], f: (v: number) => number): string => vals.map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${f(v).toFixed(1)}` : "")).filter(Boolean).join(" ");
  const idx = (ts: number): number => Math.round((ts - bars[0].ts) / 60_000);
  const color: Record<Wave["kind"], string> = { LONG_CLEANING: "rgba(220,50,50,0.18)", SHORT_CLEANING: "rgba(40,110,230,0.18)", OI_DOWN: "rgba(128,128,128,0.08)", OI_UP: "rgba(30,170,90,0.14)" };
  const bands = waves.map((w) => `<rect x="${x(idx(w.from.ts)).toFixed(1)}" y="20" width="${(x(idx(w.to.ts)) - x(idx(w.from.ts))).toFixed(1)}" height="${H1 + H2 - 10}" fill="${color[w.kind]}"><title>${w.kind} ${stamp(w.from.ts)} -> ${stamp(w.to.ts)}  OI ${w.oiChangePct.toFixed(2)}%  price ${px(w.priceStart)} -> ${px(w.priceEnd)}</title></rect>`).join("");
  const zz = waves.length ? [waves[0].from, ...waves.map((w) => w.to)].map((p) => `${x(idx(p.ts)).toFixed(1)},${os.f(p.oi).toFixed(1)}`).join(" ") : "";
  const liqMarks = bars.map((b, i) => {
    const out: string[] = [];
    if (b.longLiq > 0) out.push(`<circle cx="${x(i).toFixed(1)}" cy="${(ps.f(b.low) + 6).toFixed(1)}" r="${Math.min(8, 1.5 + Math.log10(b.longLiq + 1) / 1.2).toFixed(1)}" fill="rgba(220,50,50,0.6)"><title>LONG liq $${Math.round(b.longLiq)} ${stamp(b.ts)}</title></circle>`);
    if (b.shortLiq > 0) out.push(`<circle cx="${x(i).toFixed(1)}" cy="${(ps.f(b.high) - 6).toFixed(1)}" r="${Math.min(8, 1.5 + Math.log10(b.shortLiq + 1) / 1.2).toFixed(1)}" fill="rgba(40,110,230,0.6)"><title>SHORT liq $${Math.round(b.shortLiq)} ${stamp(b.ts)}</title></circle>`);
    return out.join("");
  }).join("");
  const tradeMarks = trades.filter((t) => t.slPrice !== null).map((t) => {
    const x0 = x(idx(t.decidedTs)), x1 = x(idx(t.exitTs ?? bars[bars.length - 1].ts));
    const col = t.result === "TP" ? "#1a9e55" : t.result === "SL" ? "#d33" : "#888";
    const tri = t.side === "LONG" ? `${x0},${ps.f(t.entry) + 10} ${x0 - 6},${ps.f(t.entry) + 20} ${x0 + 6},${ps.f(t.entry) + 20}` : `${x0},${ps.f(t.entry) - 10} ${x0 - 6},${ps.f(t.entry) - 20} ${x0 + 6},${ps.f(t.entry) - 20}`;
    return `<g><title>[${t.grade}] ${t.side === "LONG" ? "BUY" : "SELL"} ${stamp(t.decidedTs)} @ ${px(t.entry)}  SL ${px(t.slPrice!)}  TP ${px(t.tpPrice!)}  -> ${t.result} ${t.exitTs ? stamp(t.exitTs) : ""}  netR ${t.netR?.toFixed(2)}</title>
<line x1="${x0}" y1="${ps.f(t.tpPrice!)}" x2="${x1}" y2="${ps.f(t.tpPrice!)}" stroke="#1a9e55" stroke-width="1.5" stroke-dasharray="4 2"/>
<line x1="${x0}" y1="${ps.f(t.slPrice!)}" x2="${x1}" y2="${ps.f(t.slPrice!)}" stroke="#d33" stroke-width="1.5" stroke-dasharray="4 2"/>
<line x1="${x0}" y1="${ps.f(t.entry)}" x2="${x1}" y2="${ps.f(t.exitPrice ?? t.entry)}" stroke="${col}" stroke-width="2"/>
<polygon points="${tri}" fill="${col}"/><text x="${x0 + 8}" y="${ps.f(t.entry) + (t.side === "LONG" ? 30 : -24)}" font-size="11" font-weight="bold" fill="${col}">${t.grade} ${t.side === "LONG" ? "BUY" : "SELL"} ${t.result}</text></g>`;
  }).join("");
  const hours = bars.map((b, i) => (b.ts % 3_600_000 === 0 ? `<line x1="${x(i).toFixed(1)}" y1="20" x2="${x(i).toFixed(1)}" y2="${H1 + H2 + 10}" stroke="#ddd"/><text x="${(x(i) + 2).toFixed(1)}" y="${H1 + H2 + 24}" font-size="10" fill="#666">${stamp(b.ts).slice(6)}</text>` : "")).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${symbol} OI zigzag</title>
<style>body{font-family:system-ui,sans-serif;margin:12px;background:#fff;color:#222}.wrap{overflow-x:auto;border:1px solid #ddd}</style></head><body>
<h3>${symbol} — OI zigzag (R = ${rPct.toFixed(3)}%)</h3>
<p>Top: price, red dots = LONG liquidations, blue dots = SHORT liquidations (size = log $). Bottom: OI (grey) and its zigzag (black).<br>
Bands: <span style="background:${color.LONG_CLEANING}">LONG cleaning</span> <span style="background:${color.SHORT_CLEANING}">SHORT cleaning</span> <span style="background:${color.OI_UP}">OI up (accumulation)</span> <span style="background:${color.OI_DOWN}">OI down without cleaning</span>. Triangles = simulated late entries (green TP / red SL), dashed lines = TP and SL. Hover a band or a trade for its numbers. Times UTC. Scroll right →</p>
<div class="wrap"><svg width="${W.toFixed(0)}" height="${H1 + H2 + 40}" xmlns="http://www.w3.org/2000/svg">
${hours}${bands}
<polyline points="${line(bars.map((b) => b.close), ps.f)}" fill="none" stroke="#222" stroke-width="1"/>
${liqMarks}${tradeMarks}
<polyline points="${line(bars.map((b) => b.oi), os.f)}" fill="none" stroke="#999" stroke-width="1"/>
<polyline points="${zz}" fill="none" stroke="#000" stroke-width="2"/>
<text x="4" y="40" font-size="11">${px(ps.hi)}</text><text x="4" y="${H1 - 10}" font-size="11">${px(ps.lo)}</text>
<text x="4" y="${H1 + 40}" font-size="11">OI ${coins(os.hi)}</text><text x="4" y="${H1 + H2 - 10}" font-size="11">OI ${coins(os.lo)}</text>
</svg></div></body></html>`;
}

