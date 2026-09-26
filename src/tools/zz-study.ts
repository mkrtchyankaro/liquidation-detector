/**
 * STUDY DATA + CHART (Johnny, Sep 26): for each coin, the last N calendar
 * days (UTC, today included up to now) as ONE merged minute table and one
 * picture. Read-only.
 *
 *   npx tsx src/tools/zz-study.ts --symbols BTC,ETH,SOL --days 3
 *
 * Per coin it writes:
 *   zz-study-<SYMBOL>.csv   one row per minute, nothing missing:
 *       time (UTC and Yerevan), open/high/low/close, OI (coins), OI change
 *       this minute, LONG / SHORT liquidations ($ and count, 0 when none),
 *       has_data (0 = no poll that minute, price/OI carried forward),
 *       the zigzag wave the minute belongs to
 *   zz-study-<SYMBOL>.html  price candles + liquidation bars + OI zigzag on
 *       one time axis, waves shaded, hover = that minute's numbers
 *
 * The merged table comes from minute_bars: the 1/s OI polls and every
 * liquidation event, grouped into minutes on the same UTC grid.
 * Zigzag threshold R = k (4) x the coin's median 15-min OI change of the 2
 * days BEFORE each minute (same as the research and ZZ PAPER).
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import { MongoClient } from "mongodb";
import { loadEnv } from "../config/env";
import { MINUTE_BARS } from "../collector/minute-bars";
import { buildWaves, trailingOiNoise, type Wave } from "../research/oi-zigzag";
import { zigzagStudyHtml, type StudyBar } from "../research/zigzag-chart";

const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const DAY = 86_400_000, MIN = 60_000;
const KIND: Record<Wave["kind"], string> = { LONG_CLEANING: "LONG_CLEANING", SHORT_CLEANING: "SHORT_CLEANING", OI_DOWN: "OI_DOWN", OI_UP: "OI_UP" };

async function main(): Promise<void> {
  const env = loadEnv();
  const symbols = arg("symbols", "BTC,ETH,SOL").split(",").map((s) => s.trim().toUpperCase()).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const days = Math.max(1, Number(arg("days", "3")));
  const k = Number(arg("k", "4"));
  const now = Date.now();
  const from = Math.floor(now / DAY) * DAY - (days - 1) * DAY; // 00:00 UTC, (days-1) days ago
  const historyFrom = from - 2 * DAY; // the zigzag threshold needs the 2 days before
  const client = new MongoClient(env.mongoUri);
  await client.connect();
  try {
    const col = client.db(env.mongoDb).collection(MINUTE_BARS);
    for (const symbol of symbols) {
      const rows = await col.find({ symbol, ts: { $gte: new Date(historyFrom) } }).sort({ ts: 1 }).toArray();
      if (rows.length < 300) { console.log(`${symbol}: not enough minute bars (${rows.length})`); continue; }
      const by = new Map(rows.map((r) => [new Date(r.ts).getTime(), r]));
      const first = new Date(rows[0].ts).getTime(), last = new Date(rows[rows.length - 1].ts).getTime();
      const all: StudyBar[] = [];
      let close = NaN, oi = NaN;
      for (let ts = first; ts <= last; ts += MIN) {
        const r = by.get(ts) as Record<string, number> | undefined;
        const has = !!r && Number(r.polls ?? 0) > 0;
        if (r && r.close > 0) close = r.close;
        if (r && r.oiLast > 0) oi = r.oiLast;
        all.push({
          ts, open: r && r.open > 0 ? r.open : close, high: r && r.high > 0 ? r.high : close, low: r && r.low > 0 ? r.low : close, close, oi,
          longLiq: r?.longLiqUsd ?? 0, shortLiq: r?.shortLiqUsd ?? 0, longCount: r?.longLiqCount ?? 0, shortCount: r?.shortLiqCount ?? 0, hasData: has,
        });
      }
      const zbars = all.map((b) => ({ ts: b.ts, high: b.high, low: b.low, close: b.close, oi: b.oi, longLiq: b.longLiq, shortLiq: b.shortLiq }));
      const noise = trailingOiNoise(zbars);
      const waves = buildWaves(zbars, noise.map((v) => k * v));
      const i0 = Math.max(0, all.findIndex((b) => b.ts >= from));
      const bars = all.slice(i0);
      const shown = waves.filter((w) => w.to.ts > bars[0].ts);

      // wave per minute (0-based id in the shown list)
      const waveAt = new Array<{ id: number; kind: string; running: boolean } | null>(bars.length).fill(null);
      shown.forEach((w, id) => {
        for (let ts = Math.max(w.from.ts, bars[0].ts); ts < w.to.ts; ts += MIN) {
          const i = (ts - bars[0].ts) / MIN;
          if (i >= 0 && i < bars.length) waveAt[i] = { id: id + 1, kind: KIND[w.kind], running: !w.confirmed };
        }
      });
      const lines = ["time_utc,time_yerevan,open,high,low,close,oi_coins,oi_change_coins,oi_change_pct,long_liq_usd,short_liq_usd,long_liq_count,short_liq_count,has_data,wave_id,wave_kind"];
      bars.forEach((b, i) => {
        const prev = i > 0 ? bars[i - 1].oi : (i0 > 0 ? all[i0 - 1].oi : NaN);
        const d = Number.isFinite(prev) ? b.oi - prev : 0;
        const w = waveAt[i];
        lines.push([iso(b.ts), iso(b.ts + 4 * 3_600_000), b.open, b.high, b.low, b.close, b.oi, d.toFixed(3), Number.isFinite(prev) && prev > 0 ? ((100 * d) / prev).toFixed(4) : "0",
          Math.round(b.longLiq), Math.round(b.shortLiq), b.longCount, b.shortCount, b.hasData ? 1 : 0, w ? w.id : "", w ? `${w.kind}${w.running ? " (running)" : ""}` : ""].join(","));
      });
      const csv = `zz-study-${symbol}.csv`, html = `zz-study-${symbol}.html`;
      writeFileSync(csv, lines.join("\n") + "\n");
      writeFileSync(html, zigzagStudyHtml(symbol, bars, shown, k * noise[noise.length - 1]));
      const gaps = bars.filter((b) => !b.hasData).length;
      console.log(`${symbol}: ${iso(bars[0].ts)} -> ${iso(bars[bars.length - 1].ts)} UTC, ${bars.length} minutes (${gaps} without data), ${shown.length} waves -> ${csv}, ${html}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
