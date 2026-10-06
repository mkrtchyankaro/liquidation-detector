/**
 * LIQUIDATION ZONES NOW -- walk from N days back to now and see where the positions and their liquidations are piled up
 * (Johnny, Oct 6 2026). Read-only: Binance public 1m klines (price with wicks + volume), our DB minute_bars (OI every
 * minute) and liq_raw_events (our real liquidations, max 1/s per coin, kept 14 days). The ledger and every assumption:
 * src/research/liq-ledger.ts. Two models side by side: "OI" (only OI changes) and "OI + volume" (Johnny's hand-over:
 * the price rises, OI stays -> the longs below took profit and new buyers took their place higher).
 *   ⚪ white = estimated liquidations still alive (the price has not reached them yet)
 *   🔴 red   = real liquidations from our DB (and in the text: the estimated ones the price already burned)
 *
 *   npx tsx src/tools/liq-zones.ts --symbol ALGOUSDT                 from 5 days back
 *   npx tsx src/tools/liq-zones.ts --symbol ALGOUSDT --days 10
 *   options: --tf 15 (candle minutes in the picture)  --mmr 0 (maintenance margin, %)  --top 6
 *   TradingView: --model vol|oi (the ledger drawn, default vol)  --band 0.5 (alive band %)  --real 12  --spikes 12
 *   writes data/liq-zones/<SYMBOL>.pine (OUR numbers baked into a Pine script: `cat` it, paste into the Pine Editor)
 *   and    data/liq-zones/<SYMBOL>.html (copy to your computer with scp, open in the browser)
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { LiqLedger, type LedgerMinute } from "../research/liq-ledger";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const px = (v: number): string => String(+v.toPrecision(5));
const usd = (v: number): string =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(1)}k`
      : `$${v.toFixed(0)}`;
const M = 60_000,
  D = 86_400_000;
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});

interface K {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}
async function klines1m(sym: string, from: number, to: number): Promise<K[]> {
  const out: K[] = [];
  for (let start = from; start < to; ) {
    const rows: unknown[][] = (
      await fapi.get("/fapi/v1/klines", {
        params: {
          symbol: sym,
          interval: "1m",
          startTime: start,
          endTime: to - 1,
          limit: 1500,
        },
      })
    ).data;
    for (const r of rows)
      out.push({
        t: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        vol: Number(r[5]),
      });
    if (rows.length < 1500) break;
    start = Number(rows[rows.length - 1][0]) + M;
  }
  return out.filter((x) => x.t + M <= Date.now());
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "ALGOUSDT").toUpperCase(),
    days = Number(arg("days", "5")),
    tf = Number(arg("tf", "15"));
  const mmr = Number(arg("mmr", "0")) / 100,
    topN = Number(arg("top", "6")),
    W = tf * M;
  const now = Math.floor(Date.now() / M) * M;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  let oi: Map<number, number>,
    liqs: Array<{ t: number; usd: number; p: number; long: boolean }>;
  const want = Math.floor((now - days * D) / W) * W;
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    oi = new Map(
      (
        await db
          .collection(MINUTE_BARS)
          .find({
            symbol: sym,
            oiLast: { $gt: 0 },
            ts: { $gte: new Date(want) },
          })
          .project({ ts: 1, oiLast: 1 })
          .sort({ ts: 1 })
          .toArray()
      ).map((d) => [(d.ts as Date).getTime(), Number(d.oiLast)]),
    );
    liqs = (
      await db
        .collection("liq_raw_events")
        .find({
          symbol: sym,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: want },
        })
        .project({ timestamp: 1, victim: 1, quoteQty: 1, price: 1 })
        .toArray()
    )
      .map((r) => ({
        t: Number(r.timestamp),
        usd: Number(r.quoteQty),
        p: Number(r.price),
        long: r.victim === "LONG",
      }))
      .filter((x) => x.usd > 0 && x.p > 0);
  } finally {
    await client.close();
  }
  if (!oi.size) throw new Error(`${sym}: no OI in minute_bars for these days`);
  const start = Math.max(want, Math.ceil(Math.min(...oi.keys()) / W) * W);
  process.stderr.write(
    `${sym}: 1m klines ${utc(start - D)} -> ${utc(now)} ...\n`,
  );
  const all = await klines1m(sym, start - D, now);
  const before = all.filter((k) => k.t < start),
    ks = all.filter((k) => k.t >= start);
  if (!ks.length) throw new Error(`${sym}: no klines`);

  // the minutes: OI from our DB, its change vs the last known minute (a gap > 5 min = no change)
  const mins: LedgerMinute[] = [];
  let lastOi = NaN,
    lastT = -Infinity;
  for (const k of ks) {
    const o = oi.get(k.t);
    let dOi = 0;
    if (o !== undefined) {
      if (Number.isFinite(lastOi) && k.t - lastT <= 5 * M) dOi = o - lastOi;
      lastOi = o;
      lastT = k.t;
    }
    if (!Number.isFinite(lastOi)) continue;
    mins.push({
      t: k.t,
      high: k.high,
      low: k.low,
      close: k.close,
      vol: k.vol,
      oi: lastOi,
      dOi,
    });
  }
  if (!mins.length) throw new Error(`${sym}: no minutes with OI`);
  const lo = Math.min(...all.map((k) => k.low)),
    hi = Math.max(...all.map((k) => k.high)),
    base = lo / 1.2;
  const profile: Array<[number, number]> = before.map((k) => [
    (k.high + k.low + k.close) / 3,
    k.vol,
  ]);
  const startClose = before.length
    ? before[before.length - 1].close
    : mins[0].close;
  const ledgers = (["oi", "vol"] as const).map((kind) => {
    const probe = new LiqLedger(base, 1, kind);
    const l = new LiqLedger(
      base,
      probe.idx(hi * 1.2) + 2,
      kind,
      0.1,
      undefined,
      mmr,
    );
    l.seed(mins[0].oi, profile, startClose);
    return l;
  });

  // candles for the picture and its price range
  const candles: K[] = [];
  for (const k of ks) {
    const t = Math.floor(k.t / W) * W,
      c = candles[candles.length - 1];
    if (c && c.t === t) {
      c.high = Math.max(c.high, k.high);
      c.low = Math.min(c.low, k.low);
      c.close = k.close;
      c.vol += k.vol;
    } else candles.push({ ...k, t });
  }
  const cLo = Math.min(...candles.map((c) => c.low)),
    cHi = Math.max(...candles.map((c) => c.high)),
    span = cHi - cLo;
  const pLo = cLo - 0.4 * span,
    pHi = cHi + 0.4 * span,
    ROWS = 140;
  const rowOf = (p: number): number =>
    Math.floor(((p - pLo) / (pHi - pLo)) * ROWS);
  const rows = (l: LiqLedger): number[] => {
    const { long, short } = l.liqMap(),
      r = new Array<number>(ROWS).fill(0);
    for (let i = 0; i < l.bins; i++) {
      const v = long[i] + short[i];
      if (v > 0) {
        const y = rowOf(l.price(i));
        if (y >= 0 && y < ROWS) r[y] += v * l.price(i);
      }
    }
    return r;
  };
  const heat: number[][][] = [[], []];
  let ci = 0;
  for (const m of mins) {
    for (const l of ledgers) l.step(m);
    while (ci < candles.length && m.t + M >= candles[ci].t + W) {
      ledgers.forEach((l, j) => heat[j].push(rows(l)));
      ci++;
    }
  }
  while (heat[0].length < candles.length)
    ledgers.forEach((l, j) => heat[j].push(rows(l)));
  const price = ks[ks.length - 1].close;

  // ── text: the zones now ──
  const pctOf = (p: number): string =>
    `${p >= price ? "+" : ""}${((100 * (p - price)) / price).toFixed(2)}%`;
  /** 0.5%-wide buckets of a by-bin array ($ = qty x price); the biggest ones, listed high -> low */
  const zonesOf = (
    l: LiqLedger,
    a: Float64Array,
    keep: (p: number) => boolean,
  ): string[] => {
    const k = Math.log(1.005),
      b = new Map<number, number>();
    for (let i = 0; i < l.bins; i++)
      if (a[i] > 0 && keep(l.price(i))) {
        const z = Math.floor(Math.log(l.price(i) / base) / k);
        b.set(z, (b.get(z) ?? 0) + a[i] * l.price(i));
      }
    const tot = [...b.values()].reduce((s, v) => s + v, 0) || 1;
    return [...b.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, topN)
      .sort((x, y) => y[0] - x[0])
      .map(([z, v]) => {
        const p0 = base * Math.exp(z * k),
          p1 = base * Math.exp((z + 1) * k);
        return `   ${px(p0)} – ${px(p1)}   ≈${usd(v).padStart(8)}  ${((100 * v) / tot).toFixed(0).padStart(2)}%   (${pctOf((p0 + p1) / 2)})`;
      });
  };
  console.log(
    `${sym} · from ${utc(mins[0].t)} to ${utc(now)} UTC (${((now - mins[0].t) / D).toFixed(1)} days) · price ${px(price)} · OI then ${px(mins[0].oi)} -> now ${px(mins[mins.length - 1].oi)} coins`,
  );
  console.log(
    `model: leverage 10/25/50/100x the same share · maintenance margin ${mmr * 100}% · the start OI spread over the day before by volume · ≈$ are model estimates\n`,
  );
  ledgers.forEach((l) => {
    const lm = l.liqMap(),
      e = l.entries();
    let below = 0,
      above = 0;
    for (let i = 0; i < l.bins; i++) {
      const v = (e.long[i] + e.short[i]) / 2;
      if (l.price(i) < price) below += v;
      else above += v;
    }
    console.log(
      `═══ ${l.kind === "oi" ? "OI only" : "OI + volume (hand-over)"} ═══`,
    );
    console.log(
      ` open positions entered: below the price ${((100 * below) / (below + above || 1)).toFixed(0)}% · above ${((100 * above) / (below + above || 1)).toFixed(0)}%`,
    );
    console.log(
      ` ⚪ ABOVE -- shorts' liquidations still alive (the biggest 0.5% bands):`,
    );
    zonesOf(l, lm.short, (p) => p > price).forEach((s) => console.log(s));
    console.log(` ⚪ BELOW -- longs' liquidations still alive:`);
    zonesOf(l, lm.long, (p) => p < price).forEach((s) => console.log(s));
    console.log(
      ` 🔴 burned on the way (estimated, by liquidation price):  longs ≈${usd(l.burnedLong.reduce((s, v, i) => s + v * l.price(i), 0))} · shorts ≈${usd(l.burnedShort.reduce((s, v, i) => s + v * l.price(i), 0))}`,
    );
    const burned = new Float64Array(l.bins);
    for (let i = 0; i < l.bins; i++)
      burned[i] = l.burnedLong[i] + l.burnedShort[i];
    zonesOf(l, burned, () => true)
      .slice(0, 4)
      .forEach((s) => console.log(s));
    console.log("");
  });
  const liqRows = new Array<number>(ROWS).fill(0);
  for (const x of liqs) {
    const y = rowOf(x.p);
    if (y >= 0 && y < ROWS) liqRows[y] += x.usd;
  }
  const rp = (y: number): string =>
    `${px(pLo + (y / ROWS) * (pHi - pLo))} – ${px(pLo + ((y + 1) / ROWS) * (pHi - pLo))}`;
  console.log(
    `🔴 REAL liquidations (our DB) in these days: longs ${usd(liqs.filter((x) => x.long).reduce((a, x) => a + x.usd, 0))} · shorts ${usd(liqs.filter((x) => !x.long).reduce((a, x) => a + x.usd, 0))} · the biggest price bands:`,
  );
  [...liqRows.keys()]
    .filter((y) => liqRows[y] > 0)
    .sort((a, b) => liqRows[b] - liqRows[a])
    .slice(0, 5)
    .sort((a, b) => b - a)
    .forEach((y) => console.log(`   ${rp(y)}   ${usd(liqRows[y])}`));

  // ── the TradingView file: our numbers baked into a Pine script (paste it into the Pine Editor) ──
  {
    const l = ledgers[arg("model", "vol") === "oi" ? 0 : 1],
      lm = l.liqMap(),
      bw = Math.log(1 + Number(arg("band", "0.5")) / 100);
    const bands = (
      a: Float64Array,
      keep: (p: number) => boolean,
    ): Array<{ p0: number; p1: number; v: number }> => {
      const b = new Map<number, number>();
      for (let i = 0; i < l.bins; i++)
        if (a[i] > 0 && keep(l.price(i))) {
          const z = Math.floor(Math.log(l.price(i) / base) / bw);
          b.set(z, (b.get(z) ?? 0) + a[i] * l.price(i));
        }
      return [...b.entries()].map(([z, v]) => ({
        p0: base * Math.exp(z * bw),
        p1: base * Math.exp((z + 1) * bw),
        v,
      }));
    };
    const top = <T extends { v: number }>(x: T[], k: number): T[] =>
      [...x].sort((a, b) => b.v - a.v).slice(0, k);
    const above = top(
        bands(lm.short, (p) => p > price),
        topN,
      ),
      below = top(
        bands(lm.long, (p) => p < price),
        topN,
      );
    const aliveTot = [...above, ...below].reduce((s, x) => s + x.v, 0) || 1;
    // our REAL liquidations: 0.25% price bands (the time span they happened in) and the biggest 15m candles
    const lb = Math.log(1.0025),
      rb = new Map<
        number,
        { v: number; L: number; S: number; t0: number; t1: number; n: number }
      >();
    for (const x of liqs) {
      const z = Math.floor(Math.log(x.p / base) / lb),
        r = rb.get(z) ?? { v: 0, L: 0, S: 0, t0: x.t, t1: x.t, n: 0 };
      r.v += x.usd;
      r.n++;
      if (x.long) r.L += x.usd;
      else r.S += x.usd;
      r.t0 = Math.min(r.t0, x.t);
      r.t1 = Math.max(r.t1, x.t);
      rb.set(z, r);
    }
    const real = top(
      [...rb.entries()].map(([z, r]) => ({
        ...r,
        p0: base * Math.exp(z * lb),
        p1: base * Math.exp((z + 1) * lb),
      })),
      Number(arg("real", "12")),
    );
    const realMax = Math.max(1, ...real.map((x) => x.v));
    const c15 = new Map<
      number,
      { v: number; pq: number; L: number; S: number }
    >();
    for (const x of liqs) {
      const t = Math.floor(x.t / (15 * M)) * 15 * M,
        r = c15.get(t) ?? { v: 0, pq: 0, L: 0, S: 0 };
      r.v += x.usd;
      r.pq += x.p * x.usd;
      if (x.long) r.L += x.usd;
      else r.S += x.usd;
      c15.set(t, r);
    }
    const spikes = top(
      [...c15.entries()].map(([t, r]) => ({ t, ...r })),
      Number(arg("spikes", "12")),
    );
    const aMax = Math.max(1, ...[...above, ...below].map((x) => x.v));
    const f = (v: number): string => String(+v.toPrecision(6));
    const lines: string[] = [];
    for (const x of [...above, ...below]) {
      const pct = ((x.p0 + x.p1) / 2 / price - 1) * 100;
      lines.push(
        `    alive(${f(x.p0)}, ${f(x.p1)}, ${(x.v / aMax).toFixed(3)}, "⚪ ≈${usd(x.v)} · ${((100 * x.v) / aliveTot).toFixed(0)}% · ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%")`,
      );
    }
    for (const x of real)
      lines.push(
        `    real(${x.t0}, ${x.t1}, ${f(x.p0)}, ${f(x.p1)}, ${(x.v / realMax).toFixed(3)}, "🔴 ${usd(x.v)} (${x.n}) · L ${usd(x.L)} / S ${usd(x.S)}")`,
      );
    for (const s of spikes)
      lines.push(
        `    spike(${s.t}, ${f(s.pq / s.v)}, "${usd(s.v)} ${s.L >= s.S ? "LONGS" : "SHORTS"}", ${s.L >= s.S})`,
      );
    const pine = `//@version=6
// LIQUIDATION ZONES · ${sym} · made ${utc(now)} UTC from OUR data (liquidation-detector: our OI per minute + our real
// liquidations + Binance volume), src/tools/liq-zones.ts. These are fixed numbers: run the tool again and paste again to refresh.
//   ⚪ alive  = estimated liquidations still alive (the ledger "${l.kind === "oi" ? "OI only" : "OI + volume"}", from ${utc(mins[0].t)} UTC)
//   🔴 real   = OUR real liquidations by 0.25% price band (box = from the first to the last one there) · ▲▼ = the biggest 15m candles
//   (our stream gets max 1 liquidation per second per coin -> the real $ are lower than Binance's)
indicator("LIQ ZONES ${sym} · ${utc(now)} UTC (our DB)", shorttitle = "LIQZ ${sym.replace(/USDT$/, "")}", overlay = true, max_boxes_count = 200, max_labels_count = 100, max_lines_count = 10)
aliveCol = input.color(#2962ff, "Alive (estimated)")
realCol  = input.color(#ff2d2d, "Real liquidations")
showAlive = input.bool(true, "Show alive")
showReal  = input.bool(true, "Show real")
showSpike = input.bool(true, "Show the biggest 15m liquidation candles")
extendR   = input.int(40, "Extend alive boxes right (bars)", minval = 0)
const int START = ${mins[0].t}
var array<box> bx = array.new<box>()
var array<label> lb = array.new<label>()
alive(float p0, float p1, float rel, string txt) =>
    if showAlive
        bx.push(box.new(START, p1, time + extendR * (time_close - time), p0, xloc = xloc.bar_time, bgcolor = color.new(aliveCol, int(85 - 60 * rel)), border_color = color.new(aliveCol, 40), text = txt, text_color = color.new(aliveCol, 0), text_size = size.small, text_halign = text.align_right))
real(int t0, int t1, float p0, float p1, float rel, string txt) =>
    if showReal
        bx.push(box.new(t0, p1, math.max(t1, t0 + 15 * 60000), p0, xloc = xloc.bar_time, bgcolor = color.new(realCol, int(85 - 55 * rel)), border_color = color.new(realCol, 30), text = txt, text_color = color.new(realCol, 0), text_size = size.tiny, text_halign = text.align_left))
spike(int t, float p, string txt, bool isLong) =>
    if showSpike
        lb.push(label.new(t, p, txt, xloc = xloc.bar_time, style = isLong ? label.style_label_up : label.style_label_down, color = color.new(realCol, 15), textcolor = color.white, size = size.tiny))
if barstate.islast
    for b in bx
        b.delete()
    bx.clear()
    for x in lb
        x.delete()
    lb.clear()
${lines.join("\n")}
`;
    const pf = path.join("data", "liq-zones", `${sym}.pine`);
    fs.mkdirSync(path.dirname(pf), { recursive: true });
    fs.writeFileSync(pf, pine);
    console.log(
      `\nTradingView: ${pf}  (cat it, copy everything into the Pine Editor, Add to chart)`,
    );
  }

  // ── the picture (canvas, data inline) ──
  const data = {
    sym,
    tf,
    price,
    pLo,
    pHi,
    ROWS,
    from: candles[0].t,
    candles: candles.map((c) => [c.t, c.open, c.high, c.low, c.close]),
    heat: heat.map((h) => h.map((r) => r.map((v) => Math.round(v)))),
    liqs: liqs.map((x) => [x.t, x.p, Math.round(x.usd), x.long ? 1 : 0]),
    liqRows: liqRows.map((v) => Math.round(v)),
    titles: [
      "OI only (like the usual heatmaps)",
      "OI + volume (TP handed to new positions)",
    ],
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${sym} liquidation zones</title>
<style>body{margin:0;background:#0b0e11;color:#eaecef;font:13px system-ui,sans-serif}p{color:#848e9c;margin:8px 12px}canvas{display:block;margin:6px 12px}#tip{position:fixed;pointer-events:none;background:#1e2329;border:1px solid #474d57;padding:4px 6px;font-size:12px;display:none}</style></head>
<body><p>${sym} · ${utc(candles[0].t)} → ${utc(now)} UTC · price ${px(price)} · ⚪ white = estimated liquidations still alive (brighter = more) · 🔴 red circles = real liquidations from our DB · right: ⚪ alive now, 🔴 real by price · hover for prices</p>
<canvas id="c0"></canvas><canvas id="c1"></canvas><div id="tip"></div>
<script>
const d=${JSON.stringify(data)};
const LM=70,CW=1150,PW=220,PH=520,TOP=30,fmt=v=>String(+v.toPrecision(5)),day=t=>new Date(t).toISOString().slice(5,10),hm=t=>new Date(t).toISOString().slice(5,16).replace('T',' ');
const n=d.candles.length,cw=CW/n,Y=p=>TOP+PH-(p-d.pLo)/(d.pHi-d.pLo)*PH,P=y=>d.pLo+(TOP+PH-y)/PH*(d.pHi-d.pLo),rh=PH/d.ROWS;
d.heat.forEach((h,j)=>{const cv=document.getElementById('c'+j),dpr=window.devicePixelRatio||1,w=LM+CW+PW+60,H=TOP+PH+30;cv.width=w*dpr;cv.height=H*dpr;cv.style.width=w+'px';cv.style.height=H+'px';const g=cv.getContext('2d');g.scale(dpr,dpr);
g.fillStyle='#eaecef';g.font='600 14px system-ui';g.fillText(d.sym+' · '+d.tf+'m · '+d.titles[j],LM,TOP-10);g.fillStyle='#14161c';g.fillRect(LM,TOP,CW,PH);
const vals=h.flat().filter(v=>v>0).sort((a,b)=>a-b),p99=vals.length?vals[Math.floor(vals.length*0.99)]:1;
h.forEach((r,i)=>r.forEach((v,y)=>{if(v<=0)return;const a=Math.min(1,Math.sqrt(v/p99));if(a<0.05)return;g.fillStyle='rgba(255,255,255,'+(a*0.85).toFixed(2)+')';g.fillRect(LM+i*cw,TOP+PH-(y+1)*rh,cw+0.4,rh+0.4);}));
g.font='11px system-ui';for(let k=0;k<=8;k++){const p=d.pLo+k/8*(d.pHi-d.pLo);g.strokeStyle='#2a2e39';g.beginPath();g.moveTo(LM,Y(p));g.lineTo(LM+CW,Y(p));g.stroke();g.fillStyle='#848e9c';g.textAlign='right';g.fillText(fmt(p),LM-6,Y(p)+4);}
g.textAlign='left';d.candles.forEach((c,i)=>{if(c[0]%86400000===0){g.strokeStyle='#2a2e39';g.beginPath();g.moveTo(LM+i*cw,TOP);g.lineTo(LM+i*cw,TOP+PH);g.stroke();g.fillStyle='#848e9c';g.fillText(day(c[0]),LM+i*cw+3,TOP+PH+14);}
const up=c[4]>=c[1],col=up?'#2ebd85':'#f6465d',x=LM+i*cw+cw/2;g.strokeStyle=col;g.beginPath();g.moveTo(x,Y(c[2]));g.lineTo(x,Y(c[3]));g.stroke();g.fillStyle=col;g.fillRect(LM+i*cw+cw*0.15,Math.min(Y(c[1]),Y(c[4])),cw*0.7,Math.max(1,Math.abs(Y(c[1])-Y(c[4]))));});
const ml=Math.max(1,...d.liqs.map(l=>l[2]));d.liqs.forEach(l=>{const i=(l[0]-d.from)/(d.tf*60000);if(i<0||i>n||l[1]<d.pLo||l[1]>d.pHi)return;g.fillStyle='rgba(255,45,45,0.55)';g.beginPath();g.arc(LM+i*cw,Y(l[1]),1.5+9*Math.sqrt(l[2]/ml),0,7);g.fill();});
g.strokeStyle='#f0b90b';g.setLineDash([3,3]);g.beginPath();g.moveTo(LM,Y(d.price));g.lineTo(LM+CW+PW,Y(d.price));g.stroke();g.setLineDash([]);g.fillStyle='#f0b90b';g.fillText(fmt(d.price),LM+CW+PW+4,Y(d.price)+4);
const cur=h[h.length-1],mc=Math.max(1,...cur),mr=Math.max(1,...d.liqRows),x0=LM+CW+8;
cur.forEach((v,y)=>{if(v>0){g.fillStyle='rgba(255,255,255,0.8)';g.fillRect(x0,TOP+PH-(y+1)*rh,v/mc*(PW-20),rh*0.9);}});
d.liqRows.forEach((v,y)=>{if(v>0){g.fillStyle='rgba(255,45,45,0.85)';g.fillRect(x0,TOP+PH-(y+1)*rh+rh*0.3,v/mr*(PW-20),rh*0.5);}});
const tip=document.getElementById('tip');cv.onmousemove=e=>{const b=cv.getBoundingClientRect(),x=e.clientX-b.left,y=e.clientY-b.top;if(y<TOP||y>TOP+PH){tip.style.display='none';return;}const i=Math.floor((x-LM)/cw);tip.style.display='block';tip.style.left=e.clientX+12+'px';tip.style.top=e.clientY+12+'px';tip.textContent=fmt(P(y))+(i>=0&&i<n?'  ·  '+hm(d.candles[i][0])+' UTC':'');};cv.onmouseleave=()=>tip.style.display='none';});
</script></body></html>`;
  const out = path.join("data", "liq-zones", `${sym}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`\npicture: ${out}`);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
