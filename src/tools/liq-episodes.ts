/**
 * LIQUIDATION EPISODES -- list and measure them (research only, read-only).
 * Reads minute_bars (fill it first once: npx tsx src/tools/minute-bars-backfill.ts).
 *
 *   npx tsx src/tools/liq-episodes.ts
 *   npx tsx src/tools/liq-episodes.ts --symbols ADA --days 7
 *   options: --noise 0.25   OI uptick < 25% of the drop = noise
 *            --floor 0.5  OI moves < 0.5 x the coin's median 1h OI change are always noise
 *            --min 1        list only episodes with OI drop >= 1 x the coin's
 *                           median 1h OI change AND move >= 1 x its median 1h range
 *
 * Per episode: start, OI bottom, how long liquidations lasted, price move, and
 * the three numbers in USD -- forced liquidations, OI drop (all closes; minus
 * liquidations = other closes: stops / TPs / manual), OI rise after the bottom
 * (new positions in the zone) -- each with its rank among the coin's episodes
 * (top% = how big compared with the coin's other episodes).
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { loadEnv } from "../config/env";
import { MINUTE_BARS } from "../collector/minute-bars";
import { coinNorms, DEFAULT_EPISODE_PARAMS, denseBars, findEpisodes, median, percentileRank, type LiqEpisode } from "../research/liq-episodes";

const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const stamp = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const usd = (v: number): string => { const a = Math.abs(v), s = v < 0 ? "-" : ""; return a >= 1e6 ? `${s}${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}${(a / 1e3).toFixed(0)}K` : `${s}${a.toFixed(0)}`; };
const top = (all: number[], v: number): string => `top${Math.max(1, Math.round(100 - percentileRank(all, v) + 100 / all.length)).toString().padStart(3)}%`;
const FLOOR = Number(arg("floor", "0.5")); // OI moves < 0.5 x the coin's median 1h OI change are always noise
const q = (v: number[], p: number): number => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

async function main(): Promise<void> {
  const env = loadEnv();
  const symbols = arg("symbols", env.symbols.join(",")).split(",").map((s) => s.trim().toUpperCase()).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const days = Number(arg("days", "365"));
  const noise = Number(arg("noise", String(DEFAULT_EPISODE_PARAMS.noise)));
  const minMult = Number(arg("min", "1"));
  const client = new MongoClient(env.mongoUri);
  await client.connect();
  const allDur: number[] = [], allLiqMin: number[] = [];
  try {
    const col = client.db(env.mongoDb).collection(MINUTE_BARS);
    for (const symbol of symbols) {
      const rows = (await col.find({ symbol, ts: { $gte: new Date(Date.now() - days * 86_400_000) } }).sort({ ts: 1 }).toArray())
        .map((r) => ({ ts: new Date(r.ts).getTime(), high: r.high, low: r.low, close: r.close, oi: r.oiLast, longLiq: r.longLiqUsd ?? 0, shortLiq: r.shortLiqUsd ?? 0 }));
      if (rows.length < 120) { console.log(`\n${symbol}: not enough minute bars (${rows.length}) -- run minute-bars-backfill first`); continue; }
      const bars = denseBars(rows);
      const norms = coinNorms(bars);
      const minDrop = minMult * norms.hourOiPct, minMove = minMult * norms.hourRangePct;
      const found = findEpisodes(bars, { ...DEFAULT_EPISODE_PARAMS, noise, noiseFloorPct: FLOOR * norms.hourOiPct });
      const eps = found.filter((e) => e.oiDropPct >= minDrop && e.movePct >= minMove);
      const liqs = eps.map((e) => e.liqUsd), drops = eps.map((e) => e.oiDropUsd), rises = eps.map((e) => e.oiRiseUsd);

      console.log(`\n===== ${symbol}  ${stamp(bars[0].ts)} -> ${stamp(bars[bars.length - 1].ts)} UTC  (${(bars.length / 1440).toFixed(1)} days) =====`);
      console.log(`coin normal hour: price range ${norms.hourRangePct.toFixed(2)}%  OI change ${norms.hourOiPct.toFixed(2)}%   -> listed if OI drop >= ${minDrop.toFixed(2)}% and move >= ${minMove.toFixed(2)}%   (${eps.length} of ${found.length} found; the rest = small noise)`);
      console.log("VICTIM START        LIQ-END BOTTOM  DUR  MOVE   | LIQUIDATED        | OI DROP (all closes)      | OTHER CLOSES | OI RISE AFTER (zone)                 | END");
      for (const e of eps) {
        console.log(
          `${e.victim.padEnd(6)} ${stamp(e.startTs)}  ${hm(e.lastLiqTs)}   ${hm(e.bottomTs)}  ${String(e.durationMin).padStart(4)}m ${e.movePct.toFixed(2).padStart(5)}% ` +
          `| $${usd(e.liqUsd).padEnd(6)} ${top(liqs, e.liqUsd)}  ` +
          `| $${usd(e.oiDropUsd).padEnd(6)} -${e.oiDropPct.toFixed(2)}% ${top(drops, e.oiDropUsd)} ` +
          `| $${usd(e.otherClosesUsd).padEnd(7)}     ` +
          `| $${usd(e.oiRiseUsd).padEnd(6)} +${e.oiRisePct.toFixed(2)}% ${top(rises, e.oiRiseUsd)} ${String(e.accumMin).padStart(4)}m ${fmt(e.zoneLow)}-${fmt(e.zoneHigh)} ` +
          `| ${e.endReason === "OI_REBOUND" ? "" : "no rebound"}`,
        );
      }
      summary(symbol, eps);
      allDur.push(...eps.map((e) => e.durationMin)); allLiqMin.push(...eps.map((e) => e.liqActiveMin));
    }
  } finally {
    await client.close();
  }
  if (allDur.length) console.log(`\n===== ALL COINS: ${allDur.length} episodes  duration start->bottom median ${median(allDur)}m (75%: ${q(allDur, 0.75)}m, 90%: ${q(allDur, 0.9)}m)   liquidations active median ${median(allLiqMin)}m (90%: ${q(allLiqMin, 0.9)}m) =====`);
}

function fmt(p: number): string { return p >= 100 ? p.toFixed(1) : p >= 1 ? p.toFixed(3) : p.toFixed(5); }
function summary(symbol: string, eps: LiqEpisode[]): void {
  if (!eps.length) return;
  const dur = eps.map((e) => e.durationMin), liqMin = eps.map((e) => e.liqActiveMin);
  const forced = eps.map((e) => (e.oiDropUsd > 0 ? (100 * e.liqUsd) / e.oiDropUsd : NaN));
  console.log(`${symbol}: ${eps.length} episodes (LONG ${eps.filter((e) => e.victim === "LONG").length}, SHORT ${eps.filter((e) => e.victim === "SHORT").length})  duration median ${median(dur)}m (90%: ${q(dur, 0.9)}m)  liquidations active median ${median(liqMin)}m  liquidations = median ${median(forced).toFixed(0)}% of the OI drop`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
