/**
 * THE BOXES (the "bodies") -- where the price went sideways, one after the other (Johnny, Oct 8 2026). Read-only,
 * Binance public klines only (no keys, no DB).
 *   1. Walk the candles (--tf 1d by default) forward. A BOX grows while the candle BODIES (open / close, no wicks) of the
 *      box stay inside a height of --k x the daily ATR(14) known at the box's start.
 *   2. A body beyond that height = a break attempt. It is a BREAK only when the next --confirm candles also CLOSE beyond
 *      the box on the same side; otherwise it was a fake (a wick-like poke) and the box goes on without it.
 *      On a break the box ends at the candle before, and a new box starts at the breaking candle.
 *   3. A box shorter than --min days is a MOVE (the trend leg between two boxes), not a box.
 *   4. For every box, from its 1h closes: the BODY of the box = the price band holding 70% of the time (where the
 *      market really traded), and the band where it spent the most time.
 *   Writes data/boxes/<SYM>.pine -- paste it into TradingView (Pine v6): the boxes drawn on the chart to compare by eye.
 *
 *   npx tsx src/tools/boxes.ts --symbol XRPUSDT
 *   options: --days 120  --tf 1d (or 4h)  --k 2.5  --confirm 2  --min 5
 */
import "dotenv/config";
import axios from "axios";
import { mkdirSync, writeFileSync } from "fs";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const px = (v: number): string => String(+v.toPrecision(5));
const H = 3_600_000,
  D = 24 * H;
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});

interface C {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}
async function kl(
  symbol: string,
  interval: string,
  from: number,
  to: number,
): Promise<C[]> {
  const out: C[] = [];
  for (let s = from; s < to; ) {
    const rows: unknown[][] = (
      await fapi.get("/fapi/v1/klines", {
        params: {
          symbol,
          interval,
          startTime: s,
          endTime: to - 1,
          limit: 1500,
        },
      })
    ).data;
    if (!rows.length) break;
    for (const r of rows)
      out.push({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
      });
    s = Number(rows[rows.length - 1][0]) + 1;
    if (rows.length < 1500) break;
  }
  return out;
}
const atrAt = (d1: C[], t: number, n = 14): number => {
  const k = d1.filter((x) => x.t + D <= t).slice(-(n + 1));
  let s = 0,
    c = 0;
  for (let i = 1; i < k.length; i++) {
    s += Math.max(
      k[i].h - k[i].l,
      Math.abs(k[i].h - k[i - 1].c),
      Math.abs(k[i].l - k[i - 1].c),
    );
    c++;
  }
  return c ? s / c : NaN;
};

interface Box {
  s: number;
  e: number;
  lo: number;
  hi: number;
  fakes: number;
  end: "UP" | "DOWN" | "OPEN";
  height: number;
}

async function main(): Promise<void> {
  const sym = arg("symbol", "XRPUSDT").toUpperCase(),
    days = Number(arg("days", "120")),
    tf = arg("tf", "1d");
  const K = Number(arg("k", "2.5")),
    CONFIRM = Number(arg("confirm", "2")),
    MIN = Number(arg("min", "5"));
  const now = Date.now(),
    from = now - days * D;
  const d1 = await kl(sym, "1d", from - 30 * D, now);
  const c = (
    tf === "1d" ? d1.filter((x) => x.t >= from) : await kl(sym, tf, from, now)
  ).filter((x) => x.t + (tf === "4h" ? 4 * H : D) <= now); // closed only
  const h1 = await kl(sym, "1h", from, now);
  const bLo = (x: C): number => Math.min(x.o, x.c),
    bHi = (x: C): number => Math.max(x.o, x.c);

  const boxes: Box[] = [];
  let cur: Box = {
    s: 0,
    e: 0,
    lo: bLo(c[0]),
    hi: bHi(c[0]),
    fakes: 0,
    end: "OPEN",
    height: K * atrAt(d1, c[0].t),
  };
  for (let j = 1; j < c.length; j++) {
    const nlo = Math.min(cur.lo, bLo(c[j])),
      nhi = Math.max(cur.hi, bHi(c[j]));
    if (nhi - nlo <= cur.height) {
      cur.lo = nlo;
      cur.hi = nhi;
      cur.e = j;
      continue;
    }
    const up = bHi(c[j]) > cur.hi;
    let confirmed = true;
    for (let k = j; k < Math.min(c.length, j + CONFIRM); k++)
      if (up ? !(c[k].c > cur.hi) : !(c[k].c < cur.lo)) {
        confirmed = false;
        break;
      }
    if (j + CONFIRM > c.length) confirmed = false; // not enough candles yet to know
    if (!confirmed) {
      cur.fakes++;
      cur.e = j;
      continue;
    }
    cur.end = up ? "UP" : "DOWN";
    boxes.push(cur);
    cur = {
      s: j,
      e: j,
      lo: bLo(c[j]),
      hi: bHi(c[j]),
      fakes: 0,
      end: "OPEN",
      height: K * atrAt(d1, c[j].t),
    };
  }
  boxes.push(cur);

  const step = tf === "4h" ? 4 * H : D;
  console.log(
    `${sym} · ${tf} candles · ${day(c[0].t)} -> ${day(c[c.length - 1].t)} · a box = bodies within ${K} x daily ATR · a break = ${CONFIRM} closes beyond · a box lasts >= ${MIN} days\n`,
  );
  const pine: string[] = [];
  for (const b of boxes) {
    const t0 = c[b.s].t,
      t1 = c[b.e].t + step,
      len = (t1 - t0) / D;
    const isBox = len >= MIN;
    // where it really traded: the 1h closes inside the box's time
    const hs = h1.filter((x) => x.t >= t0 && x.t < t1).map((x) => x.c);
    let body = "",
      most = "",
      vaLo = NaN,
      vaHi = NaN;
    if (isBox && hs.length) {
      const atr = atrAt(d1, t0),
        w = 0.1 * atr,
        base = Math.min(...hs);
      const cnt = new Map<number, number>();
      for (const v of hs) {
        const k = Math.floor((v - base) / w);
        cnt.set(k, (cnt.get(k) ?? 0) + 1);
      }
      let mk = 0,
        mv = -1;
      for (const [k, v] of cnt)
        if (v > mv) {
          mv = v;
          mk = k;
        }
      let a = mk,
        z = mk,
        acc = mv;
      while (acc < 0.7 * hs.length) {
        const dn = cnt.get(a - 1) ?? -1,
          upn = cnt.get(z + 1) ?? -1;
        if (dn < 0 && upn < 0) break;
        if (upn >= dn) {
          z++;
          acc += Math.max(0, upn);
        } else {
          a--;
          acc += Math.max(0, dn);
        }
      }
      vaLo = base + a * w;
      vaHi = base + (z + 1) * w;
      body = ` · BODY (70% of the time) ${px(vaLo)}–${px(vaHi)}`;
      most = ` · most time ${px(base + mk * w)}–${px(base + (mk + 1) * w)}`;
    }
    const pct = (100 * (b.hi - b.lo)) / b.lo;
    console.log(
      `${isBox ? "📦 BOX " : "   move"} ${day(t0)} -> ${day(t1 - 1)} (${len.toFixed(0)}d) · bodies ${px(b.lo)}–${px(b.hi)} (${pct.toFixed(1)}%)${body}${most}${b.fakes ? ` · fake breaks ${b.fakes}` : ""} · ${b.end === "OPEN" ? "STILL OPEN" : `ended: broke ${b.end}`}`,
    );
    if (isBox) {
      pine.push(
        `box.new(${t0}, ${b.hi}, ${t1}, ${b.lo}, xloc=xloc.bar_time, border_color=color.new(color.yellow, 0), bgcolor=color.new(color.yellow, 92), border_width=2)`,
      );
      if (Number.isFinite(vaLo))
        pine.push(
          `box.new(${t0}, ${vaHi}, ${t1}, ${vaLo}, xloc=xloc.bar_time, border_color=color.new(color.purple, 100), bgcolor=color.new(color.purple, 80))`,
        );
    }
  }
  mkdirSync("data/boxes", { recursive: true });
  const file = `data/boxes/${sym}.pine`;
  writeFileSync(
    file,
    [
      `//@version=6`,
      `indicator("Boxes ${sym} (our numbers, ${day(now)})", overlay=true, max_boxes_count=200)`,
      `// yellow = the box (the candle bodies) · purple = its BODY: the band with 70% of the time`,
      `if barstate.islast`,
      ...pine.map((l) => `    ${l}`),
      ``,
    ].join("\n"),
  );
  console.log(
    `\nTradingView: ${file} (Pine editor -> paste -> Add to chart, on ${sym})`,
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
