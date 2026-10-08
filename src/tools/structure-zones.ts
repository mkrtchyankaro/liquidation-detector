/**
 * MARKET STRUCTURE ZONES -- phase 1, v2 (Johnny, Oct 8 2026): ONE coin, the last --days on 4h candles, text + one
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
  wallKey,
  type C4,
  type Wall,
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
/** a zone id in Yerevan time: "S2-1759...": -> "S2-0929-20" (side + structure - MMDD - HH of the first swing's candle) */
const zid = (id: string): string => {
  const [sd, t] = id.split("-");
  const y = yt(Number(t));
  return `${sd}-${y.slice(5, 7)}${y.slice(8, 10)}-${y.slice(11, 13)}`;
};
const ws = (w: Wall | null): string =>
  w
    ? `${zid(w.id)} v${w.v} ${px(w.lo)}–${px(w.hi)} ext ${px(w.ext)} ${w.n}sw ${w.status === "CONFIRMED" ? "CONF" : "PROV"}${w.flip ? " FLIP" : ""}${w.frozen ? " FROZEN" : ""}`
    : "null";
/** epoch ms / zone ids / long decimals in an engine note -> readable */
const fmtNote = (n: string): string =>
  n
    .replace(/\b([RS]\d+)-(\d{13})\b/g, (m) => zid(m))
    .replace(/\b(\d{13})\b/g, (m) => ys(Number(m)))
    .replace(/(\d+\.\d{5,})/g, (m) => px(Number(m)));

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
  const { steps, pivots, zones } = runStructure(c, k, K);
  const vis = steps.filter((x) => x.T > show);

  console.log(
    `\n═══ ${sym} · 4h market structure v2 · ${yt(show)} → ${yt(c[c.length - 1].t + H4)} Yerevan (UTC+4) · swing k=${k} · K=${K} closes ═══`,
  );

  console.log(
    `\n── SWINGS (pivot candle · known at · rejection range · zone) ──`,
  );
  for (const p of pivots.filter((x) => x.knownAt > show - 7 * D))
    console.log(
      `  ${p.high ? "HIGH" : "LOW "} ${ys(p.pivotTime)} · known ${ys(p.knownAt)} · ${px(p.lo)}–${px(p.hi)} · ${p.zoneId ? zid(p.zoneId) : "- (not in a structure)"}`,
    );

  console.log(`\n── EVENTS ──`);
  for (const x of vis.filter((y) => y.event)) {
    console.log(
      `  ${ys(x.T)}  ${pad(`${x.event}${x.dir ? " " + x.dir : ""}`, 24)} ${fmtNote(x.note)}${x.archived.length ? ` · archived: ${x.archived.map(zid).join(", ")}` : ""}`,
    );
  }
  if (!vis.some((y) => y.event)) console.log("  none");

  console.log(`\n── PERIODS (state and both walls unchanged) ──`);
  let a = vis[0];
  for (let j = 1; j <= vis.length; j++) {
    const x = vis[j];
    if (
      x &&
      !x.event &&
      x.state === a.state &&
      wallKey(x.R) === wallKey(a.R) &&
      wallKey(x.S) === wallKey(a.S)
    )
      continue;
    let why = "still going";
    if (x) {
      const w: string[] = [];
      if (x.event) w.push(x.event + (x.dir ? " " + x.dir : ""));
      for (const [nm, A, B] of [
        ["support", a.S, x.S],
        ["resistance", a.R, x.R],
      ] as const) {
        if (wallKey(A) === wallKey(B)) continue;
        if (!B) w.push(`${nm} -> null`);
        else if (A && A.id === B.id && A.flip === B.flip)
          w.push(
            `${nm} ${zid(B.id)} v${A.v}->v${B.v}${A.frozen !== B.frozen ? (B.frozen ? " frozen" : " unfrozen") : ""}`,
          );
        else w.push(`${nm} -> ${zid(B.id)}${B.flip ? " FLIP" : ""}`);
      }
      why = w.join(" · ") || "-";
    }
    console.log(
      `  ${pad(`${ys(a.T)} → ${ys(x ? x.T : vis[vis.length - 1].T)}`, 25)} ${pad(a.state + (a.dir ? " " + a.dir : ""), 23)} S ${pad(ws(a.S), 54)} R ${pad(ws(a.R), 54)} ${why}`,
    );
    a = x;
  }

  console.log(
    `\n── ZONES (id = side+structure-MMDD-HH of its first swing · lo–hi = most overlap · [≥2 overlap = v1] · versions) ──`,
  );
  for (const z of zones.filter((y) => !y.archived || y.archived.T > show)) {
    console.log(
      `  ${zid(z.id)} · structure ${z.structure} · ${z.side === "R" ? "resistance" : "support"} · ${z.status} · ${px(z.lo)}–${px(z.hi)} [${px(z.lo2)}–${px(z.hi2)}] ext ${px(z.ext)}${z.archived ? ` · ARCHIVED ${ys(z.archived.T)} (${z.archived.why})` : ""}`,
    );
    console.log(
      `      swings: ${z.pivots.map((p) => `${ys(p.pivotTime)} ${px(p.lo)}–${px(p.hi)}`).join(" · ")}`,
    );
    for (const h of z.history)
      console.log(
        `      v${h.v} ${ys(h.T)} +swing ${ys(h.added)} → ${px(h.lo)}–${px(h.hi)} ext ${px(h.ext)} · ${h.n} swing${h.n > 1 ? "s" : ""} · ${h.status}`,
      );
  }

  const last = steps[steps.length - 1];
  console.log(
    `\n── NOW (${ys(last.T)}) · close ${px(last.close)} · ${last.state}${last.dir ? " " + last.dir : ""}${last.testedZoneId ? ` · tested ${zid(last.testedZoneId)}` : ""} · structure ${last.structure} ──`,
  );
  console.log(`  support    ${ws(last.S)}\n  resistance ${ws(last.R)}`);

  // ── the HTML chart ──
  const cv = c.filter((x) => x.t >= show);
  const end = cv[cv.length - 1].t + H4;
  const iso = (ms: number): string => yt(Math.min(Math.max(ms, show), end));
  const thin = (lo: number, hi: number): number => (hi > lo ? hi : hi * 1.0004);
  type Seg = { w: Wall; x0: number; x1: number };
  const segs: Seg[] = [];
  for (const side of ["R", "S"] as const) {
    let cur: Seg | null = null;
    for (const x of vis) {
      const w = side === "R" ? x.R : x.S;
      if (cur && w && wallKey(w) === wallKey(cur.w)) {
        cur.x1 = x.T + H4;
        continue;
      }
      if (cur) segs.push(cur);
      cur = w ? { w, x0: x.T, x1: x.T + H4 } : null;
    }
    if (cur) segs.push(cur);
  }
  const shapes: unknown[] = [],
    ann: unknown[] = [];
  for (const z of zones.filter((y) => y.archived && y.archived.T > show)) {
    shapes.push({
      type: "rect",
      xref: "x",
      yref: "y",
      x0: iso(z.archived!.T),
      x1: iso(end),
      y0: z.lo,
      y1: thin(z.lo, z.hi),
      fillcolor: "rgba(128,128,128,0.12)",
      line: { width: 1, dash: "dash", color: "rgba(128,128,128,0.5)" },
    });
    ann.push({
      x: iso(end),
      y: z.hi,
      text: `${zid(z.id)} archived`,
      showarrow: false,
      xanchor: "right",
      yanchor: "bottom",
      font: { size: 9, color: "#999" },
    });
  }
  for (const sg of segs) {
    const w = sg.w,
      col = w.flip
        ? "rgba(70,110,230,"
        : w.side === "R"
          ? "rgba(220,50,50,"
          : "rgba(30,160,80,";
    const prov = w.status === "PROVISIONAL";
    shapes.push({
      type: "rect",
      xref: "x",
      yref: "y",
      x0: iso(sg.x0),
      x1: iso(sg.x1),
      y0: w.lo,
      y1: thin(w.lo, w.hi),
      fillcolor: `${col}${prov ? 0.08 : 0.3})`,
      line: {
        width: w.frozen ? 2 : 1,
        dash: prov ? "dot" : "solid",
        color: w.frozen ? "rgba(230,150,0,0.95)" : `${col}0.8)`,
      },
    });
    shapes.push({
      type: "line",
      xref: "x",
      yref: "y",
      x0: iso(sg.x0),
      x1: iso(sg.x1),
      y0: w.ext,
      y1: w.ext,
      line: { width: 1, dash: "dot", color: `${col}0.9)` },
    });
    ann.push({
      x: iso(sg.x0),
      y: w.side === "R" ? thin(w.lo, w.hi) : w.lo,
      text: `${zid(w.id)} v${w.v}${prov ? " prov" : ""}${w.flip ? " flip" : ""}`,
      showarrow: false,
      xanchor: "left",
      yanchor: w.side === "R" ? "bottom" : "top",
      font: { size: 9, color: `${col}1)` },
    });
  }
  const evCol: Record<string, string> = {
    BREAKOUT_TEST: "#e69500",
    FAKE_BREAK: "#888",
    BREAKOUT_CONFIRMED: "#d0451a",
    FAILED_BREAKOUT: "#888",
    NEW_STRUCTURE: "#1a5fd0",
  };
  const evTxt: Record<string, string> = {
    BREAKOUT_TEST: "TEST",
    FAKE_BREAK: "FAKE",
    BREAKOUT_CONFIRMED: "CONFIRMED",
    FAILED_BREAKOUT: "FAILED",
    NEW_STRUCTURE: "NEW",
  };
  for (const x of vis.filter((y) => y.event)) {
    const arrow = x.dir === "UP" ? " ↑" : x.dir === "DOWN" ? " ↓" : "";
    shapes.push({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: yt(x.T),
      x1: yt(x.T),
      y0: 0,
      y1: 1,
      line: {
        width:
          x.event === "NEW_STRUCTURE" || x.event === "BREAKOUT_CONFIRMED"
            ? 2
            : 1,
        dash: "dash",
        color: evCol[x.event],
      },
    });
    ann.push({
      x: yt(x.T),
      y: 1,
      yref: "paper",
      text: evTxt[x.event] + arrow,
      showarrow: false,
      yanchor: "bottom",
      font: { size: 11, color: evCol[x.event] },
    });
  }
  for (const p of pivots.filter((x) => x.pivotTime >= show)) {
    ann.push({
      x: yt(p.pivotTime + H4 / 2),
      y: p.ext,
      text: p.high ? "▼" : "▲",
      showarrow: false,
      yanchor: p.high ? "bottom" : "top",
      font: { size: 9, color: "#555" },
      hovertext: `swing ${p.high ? "high" : "low"} · candle ${yt(p.pivotTime)} · known ${yt(p.knownAt)}${p.zoneId ? " · " + zid(p.zoneId) : ""}`,
    });
  }
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
      text: `${sym} · 4h · structure v2 (Yerevan) · red = resistance, green = support, blue = flip, dotted outline = provisional, orange outline = frozen (under test), grey = archived, dotted line = extreme`,
      font: { size: 12 },
    },
    xaxis: { rangeslider: { visible: false }, type: "date" },
    yaxis: { fixedrange: false, side: "right" },
    shapes,
    annotations: ann,
    margin: { l: 20, r: 60, t: 50, b: 40 },
    hovermode: "x unified",
    dragmode: "zoom",
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sym} structure v2</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.27.0/plotly.min.js"></script>
<style>html,body{margin:0;height:100%;background:#fff;font-family:system-ui,sans-serif}#c{width:100%;height:92vh}p{margin:6px 12px;font-size:12px;color:#555}</style></head>
<body><div id="c"></div><p>Drag to zoom, double-click to reset. A wall starts at the 4h close when it became known (no look-ahead). ▲▼ = swings at their candle (hover: when known). Labels: zone id + version.</p>
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
