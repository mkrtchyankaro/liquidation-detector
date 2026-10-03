/**
 * V10 PARITY CHECK (Oct 2-3 2026) Read-only. Does the LIVE engine (src/strategy/v10/v10-engine.ts: at each 15m close,
 * only the last 10 days of bars) give exactly the same signals as the BACKTEST (Johnny's rule on all history at once,
 * src/research/oi-peak.ts / src/tools/v10-peak-trades.ts)? Prints every signal and any difference.
 *
 *   npx tsx src/tools/v10-parity.ts            options: --entry atr|atrFrozen|oiPeak  --window 12  --picks 3
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
import { btcRank1At, ownMove, pickAlts, rank1At, signalsOf, V10_HISTORY_MS, V10_TF_MIN, type V10Entry, type V10Rule, type V10Turn } from "../strategy/v10/v10-engine";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const win = Number(arg("window", "12")), npicks = Number(arg("picks", "3")), own = Number(arg("own", "15"));
  const rule: V10Rule = { entry: arg("entry", "atr") as V10Entry };
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const load = async (symbol: string): Promise<MinBar[]> =>
      (await db.collection(MINUTE_BARS).find({ symbol, high: { $ne: null } }).project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1 }).sort({ ts: 1 }).toArray())
        .map((d) => ({ t: (d.ts as Date).getTime(), high: Number(d.high), low: Number(d.low), close: Number(d.close), oiFirst: Number(d.oiFirst), oiLast: Number(d.oiLast) }));
    const btc = await load("BTCUSDT");
    const alts = (process.env.SYMBOLS ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => s && s !== "BTCUSDT");
    const closes = new Map<string, Map<number, number>>(), altBars = new Map<string, MinBar[]>();
    for (const s of alts) { const b = await load(s); if (b.length) { closes.set(s, new Map(b.map((x) => [x.t, x.close]))); altBars.set(s, b); } }
    const btcCloses = new Map(btc.map((b) => [b.t, b.close]));

    // the research = Johnny's rule on ALL history at once (src/research/oi-peak.ts)
    const researchAt = new Map(signalsOf(candles(btc, V10_TF_MIN), win, rule).map((s) => [s.t, s]));
    const ends = new Set<number>();
    for (let e = Math.ceil(btc[0].t / 900_000) * 900_000 + 900_000; e <= btc[btc.length - 1].t + 60_000; e += 900_000) ends.add(e);
    let same = 0, diff = 0;
    console.log(`V10 parity · BTC ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC · live = last ${V10_HISTORY_MS / 86_400_000} days at each close · RANK 1 ${win}h · entry ${rule.entry}\n`);
    for (const e of ends) {
      const live = btcRank1At(btc.filter((b) => b.t >= e - V10_HISTORY_MS), e, win, rule);
      const res = researchAt.get(e);
      if (!live && !res) continue;
      const side = live?.side ?? res!.side;
      const livePicks = live ? pickAlts(live, btcCloses, closes, npicks).map((p) => p.symbol.replace("USDT", "")).join(",") : "-";
      const ok = !!live && !!res && live.side === res.side && live.moveStartT === res.startT;
      ok ? same++ : diff++;
      console.log(`${ok ? "✓" : "✗ DIFFERENT"} ${utc(e)} ${side.padEnd(5)} · research ${res ? "yes" : "no "} · live ${live ? "yes" : "no "} · picks ${livePicks}`);
    }
    console.log(`\nPART 1 (BTC): ${same} identical, ${diff} different${diff ? "  <-- tell Claude" : ""}`);

    // PART 2 (ALT): each alt's own RANK 1 turns that moved on their own -- research (all history) vs live (last 10 days)
    let s2 = 0, d2 = 0;
    console.log(`\nPART 2 (ALT) · the alt's own RANK 1 turn, moved on its own`);
    for (const [sym, bars] of altBars) {
      if (bars[0].t > btc[0].t + 86_400_000) { console.log(`  ${sym.replace("USDT", "")}: too new for part 2 (live skips it too)`); continue; }
      const map = closes.get(sym)!;
      const res = new Map(signalsOf(candles(bars, V10_TF_MIN), win, rule)
        .filter((s) => ownMove({ moveStartT: s.startT, candleEnd: s.t } as V10Turn, map, btcCloses, own) !== null).map((s) => [s.t, s]));
      for (let e = Math.ceil(bars[0].t / 900_000) * 900_000 + 900_000; e <= bars[bars.length - 1].t + 60_000; e += 900_000) {
        const t = rank1At(bars.filter((b) => b.t >= e - V10_HISTORY_MS && b.t < e), e, win, rule);
        const live = t && ownMove(t, map, btcCloses, own) ? t : null, r = res.get(e);
        if (!live && !r) continue;
        const ok = !!live && !!r && live.moveStartT === r.startT;
        ok ? s2++ : d2++;
        if (!ok || argv.includes("--all")) console.log(`${ok ? "✓" : "✗ DIFFERENT"} ${utc(e)} ${sym.replace("USDT", "").padEnd(5)} ${(live?.side ?? r!.side).padEnd(5)} · research ${r ? "yes" : "no "} · live ${live ? "yes" : "no "}`);
      }
    }
    console.log(`PART 2 (ALT): ${s2} identical, ${d2} different${d2 ? "  <-- tell Claude" : ""}  (--all prints every one)`);
  } finally { await client.close(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
