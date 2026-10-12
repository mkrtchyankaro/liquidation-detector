/**
 * V11 REPLAY (Oct 12 2026) -- READ-ONLY. Runs the LIVE V11 code (the same data source and engine as the bot) over the
 * last N days and prints every wick and every signal with what happened after it (1h candles, SL first on a tie).
 * Nothing is written anywhere, no order, no message. Use it before switching V11 on, or to check a day by hand.
 *
 *   npx tsx src/tools/v11-replay.ts                       # every coin of SYMBOLS (.env), last 14 days, 2R
 *   npx tsx src/tools/v11-replay.ts --days 7 --r 2.5
 *   npx tsx src/tools/v11-replay.ts --symbols XRP,BTC --days 10
 *
 * Binance keeps the OI history 30 days -> --days at most 25 (the rule needs ~4 days before the first hour).
 * Our liquidations are kept 365 days in minute_bars (an hour with < 55 of our minute rows = unknown -> no wick there).
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { loadEnv } from "../config/env";
import { loadAppConfig } from "../config/users-config";
import { BinanceMongoV11Source } from "../strategy/v11/v11-data";
import { decideAt, H, type V11Bar } from "../strategy/v11/v11-engine";
import { historyHours } from "../strategy/v11/v11-live.service";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");

async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = loadAppConfig(env.usersConfigPath, env.symbols).v11;   // the rule from users.config.json (or the defaults)
  const days = Math.min(25, Math.max(1, Number(arg("days", "14"))));
  const R = Number(arg("r", String(cfg.tpR)));
  const symbols = arg("symbols", (cfg.symbols.length ? cfg.symbols : env.symbols).join(",")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const end = Math.floor(Date.now() / H) * H, start = end - days * 24 * H, need = historyHours(cfg);
  const client = new MongoClient(env.mongoUri);
  await client.connect();
  const db = client.db(env.mongoDb);
  const src = new BinanceMongoV11Source(async () => db);
  console.log(`V11 replay · ${symbols.length} coins · ${iso(start)} -> ${iso(end)} UTC · TP ${R}R · rule ${JSON.stringify(cfg.rule)}`);
  const tot = { n: 0, tp: 0, sl: 0, open: 0, r: 0 };
  try {
    for (const sym of symbols) {
      let bars: Array<V11Bar | null>;
      try { bars = await src.bars(sym, start - need * H, end); }
      catch (err) { console.log(`  ${sym}: data failed (${err instanceof Error ? err.message : String(err)})`); continue; }
      const missing = bars.filter((b) => !b).length, noLiq = bars.filter((b) => b && !b.liqOk).length;
      const lines: string[] = [];
      for (let i = need; i < bars.length; i++) {
        for (const side of [cfg.short ? "SHORT" : null, cfg.long ? "LONG" : null].filter(Boolean) as Array<"SHORT" | "LONG">) {
          for (const d of decideAt(bars, i, side, cfg.rule)) {
            if (d.kind === "WICK") lines.push(`    wick   ${iso(d.wick.t)} ${side} high ${d.wick.h} low ${d.wick.l} liq $${Math.round(d.wick.liqUsd)} (p85 $${Math.round(d.wick.liqNorm)})${d.wick.meaningful ? " meaningful" : ""} rally ${d.wick.rally.type} ${d.wick.rally.movePct.toFixed(2)}% OI ${d.wick.rally.oiPct.toFixed(2)}%`);
            else if (d.kind === "CANCELLED") lines.push(`    cancel ${iso(d.t)} ${d.why}`);
            else if (d.kind === "EXPIRED") lines.push(`    no confirmation for the ${iso(d.wick.t)} wick`);
            else if (d.kind === "SIGNAL") {
              const s = d.signal, k = (s.entryT - (bars[0]?.t ?? start - need * H)) / H, e = bars[k]?.o;
              if (e === undefined) { lines.push(`  ▶ SIGNAL ${iso(s.entryT)} ${side} (the entry hour is still open)`); continue; }
              const dd = side === "SHORT" ? 1 : -1, tp = e - R * (s.stop - e);
              let res = "OPEN";
              for (let j = k; j < Math.min(bars.length, k + 48); j++) {
                const y = bars[j]; if (!y) { res = "GAP"; break; }
                const hs = dd > 0 ? y.h >= s.stop : y.l <= s.stop, ht = dd > 0 ? y.l <= tp : y.h >= tp;
                if (hs) { res = "SL"; break; }
                if (ht) { res = "TP"; break; }
              }
              tot.n++; if (res === "TP") { tot.tp++; tot.r += R; } else if (res === "SL") { tot.sl++; tot.r -= 1; } else tot.open++;
              lines.push(`  ▶ SIGNAL ${iso(s.entryT)} ${side} entry ${e} SL ${s.stop} (${(100 * dd * (s.stop - e) / e).toFixed(2)}%) TP ${+tp.toPrecision(8)} · ${s.wick.rally.type}${s.wick.meaningful ? " meaningful" : ""} · confirm ${iso(s.confirm.t)} OI ${s.confirm.oiPct.toFixed(2)}% -> ${res}`);
            }
          }
        }
      }
      console.log(`  ${sym}: hours ${bars.length - need}, incomplete hours ${missing}, hours without our liquidations ${noLiq}`);
      for (const l of lines) console.log(l);
    }
  } finally { await client.close(); }
  console.log(`\nsignals ${tot.n}: TP ${tot.tp} · SL ${tot.sl} · open ${tot.open} · ${tot.r >= 0 ? "+" : ""}${tot.r.toFixed(1)}R before fees`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
