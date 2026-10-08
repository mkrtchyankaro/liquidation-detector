/**
 * MARKET STRUCTURE ZONES -- phase 1 (Johnny, Oct 8 2026): ONE coin, the last --days on 4h candles, text table + one
 * HTML chart. Read-only. Binance public 4h candles only (no OI, no liquidations, no order book in this phase).
 * The rules: src/research/market-structure.ts. Times in Yerevan (UTC+4).
 *
 *   npx tsx src/tools/structure-zones.ts --symbol XRPUSDT
 *   options: --days 12  --warm 30 (days of history before, for the swings)  --k 2 (swing)  --K 2 (closes)
 *   writes reports/structure-<SYMBOL>.html
 */
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import {
  H4,
  runStructure,
  zoneKey,
  type C4,
  type Step,
  type Zone,
} from "../research/market-structure";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const D = 24 * 3_600_000,
  YVN = 4 * 3_600_000;
const yt = (ms: number): string =>
  new Date(ms + YVN).toISOString().slice(0, 16).replace("T", " ");
const ys = (ms: number): string => yt(ms).slice(5);
const px = (v: number): string => String(+v.toPrecision(5));
const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);
const zs = (z: Zone | null): string =>
  z
    ? `${px(z.lo)}–${px(z.hi)} (ext ${px(z.ext)}, ${z.n} swing${z.n > 1 ? "s" : ""}${z.weak ? ", weak" : ""}${z.flip ? ", FLIP" : ""})`
    : "null";

async function main(): Promise<void> {
  const sym = arg("symbol", "XRPUSDT").toUpperCase();
  const DAYS = Number(arg("days", "12")),
    WARM = Number(arg("warm", "30")),
    k = Number(arg("k", "2")),
    K = Number(arg("K", "2"));
  const now = Date.now(),
    from = Math.floor((now - (DAYS + WARM) * D) / H4) * H4,
    show = Math.floor((now - DAYS * D) / H4) * H4;
  const fapi = axios.create({
    baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
    timeout: 20_000,
  });
  const rows: unknown[][] = (
    await fapi.get("/fapi/v1/klines", {
      params: {
        symbol: sym,
        interval: "4h",
        startTime: from,
        endTime: now - 1,
        limit: 1500,
      },
    })
  ).data;
  const c: C4[] = rows
    .map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
    }))
    .filter((x) => x.t + H4 <= now);
  const { steps, pivots } = runStructure(c, k, K);
  const vis = steps.filter((s) => s.T > show);

  console.log(
    `\n═══ ${sym} · 4h market structure · ${yt(show)} → ${yt(c[c.length - 1].t + H4)} Yerevan (UTC+4) · swing k=${k} · NEW_STRUCTURE after ${K} closes + a swing ═══`,
  );

  // the swings (to check by eye): candle time, when it became known, its rejection range
  console.log(`\n── SWINGS (candle · known at · rejection range) ──`);
  for (const p of pivots.filter((x) => x.known > show - 7 * D))
    console.log(
      `  ${p.high ? "HIGH" : "LOW "} ${ys(p.t)} · known ${ys(p.known)} · ${px(p.lo)}–${px(p.hi)}`,
    );

  // the events
  console.log(`\n── EVENTS ──`);
  for (const s of vis.filter((x) => x.event))
    console.log(`  ${ys(s.T)}  ${pad(s.event, 19)} ${s.note}`);
  if (!vis.some((x) => x.event)) console.log("  none");

  // the periods: same state + same zones
  console.log(
    `\n── PERIODS (a row = the state and the two zones stayed the same) ──`,
  );
  console.log(
    `  from → to (Yerevan)           state               support                                    resistance                                 detected S / R           why it ended`,
  );
  const rowsOut: { a: Step; b: Step; why: string }[] = [];
  let a = vis[0];
  for (let j = 1; j <= vis.length; j++) {
    const s = vis[j],
      p = vis[j - 1];
    if (
      s &&
      s.state === a.state &&
      zoneKey(s.R) === zoneKey(a.R) &&
      zoneKey(s.S) === zoneKey(a.S) &&
      !s.event
    )
      continue;
    let why = "still going";
    if (s) {
      const w: string[] = [];
      if (s.event) w.push(s.event);
      if (zoneKey(s.S) !== zoneKey(a.S))
        w.push(
          !s.S
            ? "support -> null"
            : a.S && s.S.pivots[0] === a.S.pivots[0]
              ? "support updated (new swing)"
              : "support replaced",
        );
      if (zoneKey(s.R) !== zoneKey(a.R))
        w.push(
          !s.R
            ? "resistance -> null"
            : a.R && s.R.pivots[0] === a.R.pivots[0]
              ? "resistance updated (new swing)"
              : "resistance replaced",
        );
      if (!w.length && s.state !== a.state) w.push(`state -> ${s.state}`);
      why = w.join(" · ");
    }
    rowsOut.push({ a, b: p, why });
    a = s;
  }
  for (const r of rowsOut) {
    console.log(
      `  ${pad(`${ys(r.a.T)} → ${ys(r.b.T + (r.why === "still going" ? 0 : H4))}`, 28)} ${pad(r.a.state, 19)} ${pad(zs(r.a.S), 42)} ${pad(zs(r.a.R), 42)} ${pad(`${r.a.S ? ys(r.a.S.known) : "-"} / ${r.a.R ? ys(r.a.R.known) : "-"}`, 24)} ${r.why}`,
    );
  }
  // the archived zones
  const arch = vis.flatMap((s) =>
    s.archived.map((z) => ({ z, T: s.T, ev: s.event })),
  );
  if (arch.length) {
    console.log(`\n── ARCHIVED ZONES (kept, no longer active) ──`);
    for (const x of arch)
      console.log(
        `  ${x.z.side === "R" ? "resistance" : "support   "} ${zs(x.z)} · archived ${ys(x.T)} by ${x.ev}`,
      );
  }
  const last = steps[steps.length - 1];
  console.log(
    `\n── NOW (${ys(last.T)}) · close ${px(last.close)} · ${last.state} ──\n  support    ${zs(last.S)}\n  resistance ${zs(last.R)}`,
  );

  // the HTML chart
  const cv = c.filter((x) => x.t >= show);
  type Seg = { z: Zone; x0: number; x1: number };
  const segs: Seg[] = [];
  for (const side of ["R", "S"] as const) {
    let cur: Seg | null = null;
    for (const s of vis) {
      const z = side === "R" ? s.R : s.S;
      if (cur && z && zoneKey(z) === zoneKey(cur.z)) {
        cur.x1 = s.T + H4;
        continue;
      }
      if (cur) segs.push(cur);
      cur = z ? { z, x0: s.T, x1: s.T + H4 } : null;
    }
    if (cur) segs.push(cur);
  }
  const end = cv[cv.length - 1].t + H4;
  const shapes: unknown[] = [];
  const iso = (ms: number): string => yt(Math.min(Math.max(ms, show), end));
  for (const sg of segs) {
    const col = sg.z.flip
      ? "rgba(70,110,230,"
      : sg.z.side === "R"
        ? "rgba(220,50,50,"
        : "rgba(30,160,80,";
    shapes.push({
      type: "rect",
      xref: "x",
      yref: "y",
      x0: iso(sg.x0),
      x1: iso(sg.x1),
      y0: sg.z.lo,
      y1: sg.z.hi === sg.z.lo ? sg.z.hi * 1.0003 : sg.z.hi,
      fillcolor: `${col}${sg.z.weak ? 0.15 : 0.3})`,
      line: { width: 1, color: `${col}0.8)` },
    });
    shapes.push({
      type: "line",
      xref: "x",
      yref: "y",
      x0: iso(sg.x0),
      x1: iso(sg.x1),
      y0: sg.z.ext,
      y1: sg.z.ext,
      line: { width: 1, dash: "dot", color: `${col}0.9)` },
    });
  }
  for (const x of arch)
    shapes.push({
      type: "rect",
      xref: "x",
      yref: "y",
      x0: iso(x.T),
      x1: iso(end),
      y0: x.z.lo,
      y1: x.z.hi === x.z.lo ? x.z.hi * 1.0003 : x.z.hi,
      fillcolor: "rgba(128,128,128,0.12)",
      line: { width: 1, dash: "dash", color: "rgba(128,128,128,0.5)" },
    });
  const ann: unknown[] = [];
  const evCol: Record<string, string> = {
    BREAKOUT_TEST_UP: "#e69500",
    BREAKOUT_TEST_DOWN: "#e69500",
    FAKE_BREAK: "#888",
    NEW_STRUCTURE_UP: "#1a5fd0",
    NEW_STRUCTURE_DOWN: "#1a5fd0",
  };
  const evTxt: Record<string, string> = {
    BREAKOUT_TEST_UP: "TEST ↑",
    BREAKOUT_TEST_DOWN: "TEST ↓",
    FAKE_BREAK: "FAKE",
    NEW_STRUCTURE_UP: "NEW ↑",
    NEW_STRUCTURE_DOWN: "NEW ↓",
  };
  for (const s of vis.filter((x) => x.event)) {
    shapes.push({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: yt(s.T),
      x1: yt(s.T),
      y0: 0,
      y1: 1,
      line: {
        width: s.event.startsWith("NEW") ? 2 : 1,
        dash: "dash",
        color: evCol[s.event],
      },
    });
    ann.push({
      x: yt(s.T),
      y: 1,
      yref: "paper",
      text: evTxt[s.event],
      showarrow: false,
      yanchor: "bottom",
      font: { size: 11, color: evCol[s.event] },
    });
  }
  for (const p of pivots.filter((x) => x.t >= show))
    ann.push({
      x: yt(p.t + H4 / 2),
      y: p.ext,
      text: p.high ? "▼" : "▲",
      showarrow: false,
      yanchor: p.high ? "bottom" : "top",
      font: { size: 9, color: "#555" },
      hovertext: `swing ${p.high ? "high" : "low"} · known ${yt(p.known)}`,
    });
  const trace = {
    type: "candlestick",
    x: cv.map((x) => yt(x.t + H4 / 2)),
    open: cv.map((x) => x.o),
    high: cv.map((x) => x.h),
    low: cv.map((x) => x.l),
    close: cv.map((x) => x.c),
    text: cv.map((x) => `${yt(x.t)} → ${yt(x.t + H4)} (Yerevan)`),
    hoverinfo: "x+y+text",
    name: sym,
    increasing: { line: { color: "#26a69a" } },
    decreasing: { line: { color: "#ef5350" } },
  };
  const layout = {
    title: {
      text: `${sym} · 4h · structure zones (Yerevan time) · red = resistance, green = support, blue = flip, grey dashed = archived, dotted = extreme`,
      font: { size: 13 },
    },
    xaxis: { rangeslider: { visible: false }, type: "date" },
    yaxis: { fixedrange: false, side: "right" },
    shapes,
    annotations: ann,
    margin: { l: 20, r: 60, t: 50, b: 40 },
    hovermode: "x unified",
    dragmode: "zoom",
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sym} structure</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.27.0/plotly.min.js"></script>
<style>html,body{margin:0;height:100%;background:#fff;font-family:system-ui,sans-serif}#c{width:100%;height:92vh}p{margin:6px 12px;font-size:12px;color:#555}</style></head>
<body><div id="c"></div><p>Drag to zoom, double-click to reset. Each zone starts at the 4h close when it became known (no look-ahead). ▲▼ = swings (drawn at their candle; known ${k} candles later).</p>
<script>Plotly.newPlot("c",[${JSON.stringify(trace)}],${JSON.stringify(layout)},{responsive:true,scrollZoom:true});</script></body></html>`;
  const out = path.join("reports", `structure-${sym}.html`);
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`\nchart: ${out}`);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
