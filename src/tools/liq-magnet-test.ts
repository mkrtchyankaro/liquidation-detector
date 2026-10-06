/**
 * ARE THE LIQUIDATION ZONES MAGNETS? (Johnny, Oct 6 2026). Read-only: our DB (minute_bars OI, liq_raw_events -- kept
 * 14 days) + Binance public 1m klines (cached in data/klines1m-liq/). For every coin: the ledger (src/research/liq-ledger.ts,
 * calibrated by our real liquidations) walked minute by minute; every --every minutes (after --warm days) we take the
 * BIGGEST expected-liquidation band (0.5%) above the price (shorts) and below it (longs), within --range %, and look
 * which one the price reaches FIRST in the next --hours hours.
 *   the benchmark (a random walk, no edge): the band at distance d_up is reached first with chance d_dn / (d_up + d_dn)
 *   -> the zones are magnets only if the price reaches them MORE often than that, especially the side with more $
 * The samples overlap (one per hour, looking 48h ahead) -> they are not independent; read the numbers as a first look.
 *
 *   npx tsx src/tools/liq-magnet-test.ts                        all coins in SYMBOLS (no BTC / ETH)
 *   options: --symbols ALGOUSDT,ADAUSDT  --model vol|oi  --raw (not calibrated)  --every 60  --warm 1  --hours 48
 *            --range 8  --band 0.5  --list
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { MongoClient, type Db } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { LEDGER_TIERS, LEDGER_TIERS_CAL, LiqLedger, type LedgerMinute } from "../research/liq-ledger";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number, d = 1): string => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
const M = 60_000, D = 86_400_000, SKIP = ["BTCUSDT", "ETHUSDT"];
const fapi = axios.create({ baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com", timeout: 20_000 });
const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface K { t: number; high: number; low: number; close: number; vol: number }
async function fetchK(sym: string, from: number, to: number): Promise<K[]> {
  const out: K[] = [];
  for (let start = from; start < to;) {
    const rows: unknown[][] = (await fapi.get("/fapi/v1/klines", { params: { symbol: sym, interval: "1m", startTime: start, endTime: to - 1, limit: 1500 } })).data;
    for (const r of rows) out.push({ t: Number(r[0]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), vol: Number(r[5]) });
    if (rows.length < 1500) break;
    start = Number(rows[rows.length - 1][0]) + M;
  }
  return out;
}
/** 1m klines, whole past days cached on disk */
async function klines(sym: string, from: number, to: number): Promise<K[]> {
  const dir = path.join("data", "klines1m-liq", sym), out: K[] = [], today = Math.floor(Date.now() / D) * D;
  fs.mkdirSync(dir, { recursive: true });
  for (let d = Math.floor(from / D) * D; d < to; d += D) {
    const f = path.join(dir, `${dayStr(d)}.json`);
    if (d + D <= today && fs.existsSync(f)) { out.push(...(JSON.parse(fs.readFileSync(f, "utf8")) as K[])); continue; }
    const k = await fetchK(sym, d, Math.min(d + D, to));
    if (d + D <= today) fs.writeFileSync(f, JSON.stringify(k));
    out.push(...k);
  }
  return out.filter((x) => x.t >= from && x.t < to && x.t + M <= Date.now());
}

interface Sample { sym: string; t: number; price: number; up: number; dn: number; upUsd: number; dnUsd: number; hit: "UP" | "DOWN" | "NONE" | "BOTH"; pUp: number }

async function coin(db: Db, sym: string): Promise<Sample[]> {
  const every = Number(arg("every", "60")) * M, warm = Number(arg("warm", "1")) * D, hours = Number(arg("hours", "48")) * 3_600_000;
  const range = Number(arg("range", "8")) / 100, bw = Math.log(1 + Number(arg("band", "0.5")) / 100), cal = !argv.includes("--raw");
  const oi = new Map((await db.collection(MINUTE_BARS).find({ symbol: sym, oiLast: { $gt: 0 } }).project({ ts: 1, oiLast: 1 }).sort({ ts: 1 }).toArray())
    .map((d) => [(d.ts as Date).getTime(), Number(d.oiLast)]));
  const liqs = (await db.collection("liq_raw_events").find({ symbol: sym, victim: { $in: ["LONG", "SHORT"] } }).project({ timestamp: 1, victim: 1, quoteQty: 1, price: 1 }).sort({ timestamp: 1 }).toArray())
    .map((r) => ({ t: Number(r.timestamp), usd: Number(r.quoteQty), p: Number(r.price), long: r.victim === "LONG" })).filter((x) => x.usd > 0 && x.p > 0);
  if (!oi.size || (cal && !liqs.length)) return [];
  // the calibration needs our liquidations: start where both exist
  const start = Math.ceil(Math.max(Math.min(...oi.keys()), cal ? liqs[0].t : 0) / M) * M, now = Math.floor(Date.now() / M) * M;
  if (now - start < warm + D) return [];
  const all = await klines(sym, start - D, now);
  const before = all.filter((k) => k.t < start), ks = all.filter((k) => k.t >= start);
  const liqMin = new Map<number, { L: number; S: number }>();
  for (const x of liqs) { const t = Math.floor(x.t / M) * M, r = liqMin.get(t) ?? { L: 0, S: 0 }; if (x.long) r.L += x.usd / x.p; else r.S += x.usd / x.p; liqMin.set(t, r); }
  const mins: LedgerMinute[] = [];
  let lastOi = NaN, lastT = -Infinity;
  for (const k of ks) {
    const o = oi.get(k.t);
    let dOi = 0;
    if (o !== undefined) { if (Number.isFinite(lastOi) && k.t - lastT <= 5 * M) dOi = o - lastOi; lastOi = o; lastT = k.t; }
    if (!Number.isFinite(lastOi)) continue;
    mins.push({ t: k.t, high: k.high, low: k.low, close: k.close, vol: k.vol, oi: lastOi, dOi, liqL: liqMin.get(k.t)?.L ?? 0, liqS: liqMin.get(k.t)?.S ?? 0 });
  }
  if (mins.length < 2) return [];
  const lo = Math.min(...all.map((k) => k.low)), hi = Math.max(...all.map((k) => k.high)), base = lo / 1.2;
  const kind = arg("model", "vol") === "oi" ? "oi" : "vol";
  const probe = new LiqLedger(base, 1, kind);
  const l = new LiqLedger(base, probe.idx(hi * 1.2) + 2, kind, 0.1, cal ? LEDGER_TIERS_CAL : LEDGER_TIERS, 0, cal);
  l.seed(mins[0].oi, before.map((k) => [(k.high + k.low + k.close) / 3, k.vol]), before.length ? before[before.length - 1].close : mins[0].close);

  const out: Sample[] = [];
  const firstEval = mins[0].t + warm;
  for (let n = 0; n < mins.length; n++) {
    const m = mins[n];
    l.step(m);
    if (m.t < firstEval || (m.t - firstEval) % every !== 0 || m.t + hours > now) continue;
    const price = m.close, lm = l.liqMap();
    // the biggest band above (shorts' liquidations) and below (longs'), within the range
    const best = (a: Float64Array, above: boolean): { edge: number; usd: number } | null => {
      const b = new Map<number, number>();
      for (let i = 0; i < l.bins; i++) {
        const p = l.price(i);
        if (!(a[i] > 0) || (above ? !(p > price && p <= price * (1 + range)) : !(p < price && p >= price * (1 - range)))) continue;
        const z = Math.floor(Math.log(p / base) / bw);
        b.set(z, (b.get(z) ?? 0) + a[i] * p);
      }
      const top = [...b.entries()].sort((x, y) => y[1] - x[1])[0];
      if (!top) return null;
      const p0 = base * Math.exp(top[0] * bw), p1 = base * Math.exp((top[0] + 1) * bw);
      return { edge: above ? Math.max(p0, price * 1.0001) : Math.min(p1, price * 0.9999), usd: top[1] };
    };
    const A = best(lm.short, true), B = best(lm.long, false);
    if (!A || !B) continue;
    let hit: Sample["hit"] = "NONE";
    for (let j = n + 1; j < mins.length && mins[j].t <= m.t + hours; j++) {
      const u = mins[j].high >= A.edge, d = mins[j].low <= B.edge;
      if (u && d) { hit = "BOTH"; break; }
      if (u) { hit = "UP"; break; }
      if (d) { hit = "DOWN"; break; }
    }
    const up = A.edge / price - 1, dn = 1 - B.edge / price;
    out.push({ sym: sym.replace(/USDT$/, ""), t: m.t, price, up, dn, upUsd: A.usd, dnUsd: B.usd, hit, pUp: dn / (up + dn) });
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const syms = (argv.includes("--symbols") ? arg("symbols", "") : process.env.SYMBOLS ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => x && !SKIP.includes(x));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const all: Sample[] = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const s of syms) {
      process.stderr.write(`\r${s}          `);
      try { all.push(...(await coin(db, s))); } catch (err) { console.log(`${s}: ${err instanceof Error ? err.message : err}`); }
    }
    process.stderr.write("\n");
  } finally { await client.close(); }

  const done = all.filter((x) => x.hit === "UP" || x.hit === "DOWN");
  console.log(`ARE THE LIQUIDATION ZONES MAGNETS? · model ${arg("model", "vol")}${argv.includes("--raw") ? " NOT calibrated" : " calibrated by our real liquidations"} · biggest 0.5% band above / below within ±${arg("range", "8")}% · every ${arg("every", "60")} min · ${arg("hours", "48")}h ahead`);
  console.log(`${all.length} samples (${new Set(all.map((x) => x.sym)).size} coins) · reached one side: ${done.length} · neither: ${all.filter((x) => x.hit === "NONE").length} · both in the same minute: ${all.filter((x) => x.hit === "BOTH").length}`);
  console.log(`the samples overlap (hourly, ${arg("hours", "48")}h ahead) -- not independent\n`);
  const line = (name: string, l: Sample[], side: (x: Sample) => boolean): void => {
    if (!l.length) { console.log(`  ${name.padEnd(46)} -`); return; }
    const got = l.filter(side).length, exp = l.reduce((a, x) => a + (side({ ...x, hit: "UP" }) ? x.pUp : 1 - x.pUp), 0);
    console.log(`  ${name.padEnd(46)} ${String(l.length).padStart(5)} · reached first ${String(got).padStart(5)} (${((100 * got) / l.length).toFixed(1)}%) · random walk ${exp.toFixed(0).padStart(5)} (${((100 * exp) / l.length).toFixed(1)}%) · edge ${sp((100 * (got - exp)) / l.length)} pts`);
  };
  console.log("the side with MORE expected liquidations ($) -- is it reached first more often than a random walk says?");
  const big = (x: Sample): boolean => (x.upUsd >= x.dnUsd ? x.hit === "UP" : x.hit === "DOWN");
  line("all", done, big);
  for (const [a, b] of [[1, 1.5], [1.5, 3], [3, Infinity]] as const)
    line(`  bigger side ${a}x..${b === Infinity ? "" : `${b}x`} the other`, done.filter((x) => { const r = Math.max(x.upUsd, x.dnUsd) / Math.min(x.upUsd, x.dnUsd); return r >= a && r < b; }), big);
  console.log("\nthe NEARER band -- for reference (a random walk already favours it)");
  line("all", done, (x) => (x.up <= x.dn ? x.hit === "UP" : x.hit === "DOWN"));
  console.log("\nper coin (the bigger side):");
  for (const s of [...new Set(done.map((x) => x.sym))].sort()) line(s, done.filter((x) => x.sym === s), big);
  if (argv.includes("--list"))
    for (const x of all) console.log(`  ${utc(x.t)} ${x.sym.padEnd(6)} ${String(+x.price.toPrecision(5)).padEnd(9)} up ${sp(100 * x.up, 2)}% $${x.upUsd.toFixed(0)} · down -${(100 * x.dn).toFixed(2)}% $${x.dnUsd.toFixed(0)} · ${x.hit} (random walk up ${(100 * x.pUp).toFixed(0)}%)`);
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
