/**
 * JOHNNY'S RULE ON ONE EXAMPLE (Oct 3 2026) Read-only. The 15m candles of a symbol in a time window (UTC) with price,
 * OI and who acted, and where the rule (src/research/oi-peak.ts) puts its 3 points:
 *   1 = OI's low (the build-up starts) · PEAK = OI's peak · 3 = the entry (first red candle with OI down after the peak)
 *
 *   npx tsx src/tools/v10-story.ts --symbol SUIUSDT --from "2026-10-02 22:00" --to "2026-10-03 03:00"
 *   options: --entry atr|atrFrozen|oiPeak (default atr)  --red  --window 12 (RANK 1 hours)  --atrfrom "2026-10-02 23:00" (freeze the ATR at that candle; default = the
 *            window's start) -- prints the 15m ATR(14) per candle and where "close 1 ATR below the high" is reached,
 *            with the live ATR and with the ATR frozen before the move
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { atrBefore, candles, label, type MinBar } from "../research/dc15";
import { signalsOf, type V10Entry } from "../strategy/v10/v10-engine";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const hm = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const ms = (s: string): number => Date.parse(`${s.replace(" ", "T")}:00Z`);

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const symbol = arg("symbol", "BTCUSDT").toUpperCase(), from = ms(arg("from", "")), to = ms(arg("to", "")), win = Number(arg("window", "12"));
  if (!(from > 0) || !(to > from)) throw new Error('use --from "YYYY-MM-DD HH:MM" --to "YYYY-MM-DD HH:MM" (UTC)');
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const bars: MinBar[] = (await db.collection(MINUTE_BARS).find({ symbol, high: { $ne: null }, ts: { $gte: new Date(from - 10 * 86_400_000), $lt: new Date(to) } })
      .project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1 }).sort({ ts: 1 }).toArray())
      .map((d) => ({ t: (d.ts as Date).getTime(), high: Number(d.high), low: Number(d.low), close: Number(d.close), oiFirst: Number(d.oiFirst), oiLast: Number(d.oiLast) }));
    const c = candles(bars, 15);
    const entry = arg("entry", "atr") as V10Entry;
    const sigs = signalsOf(c, win, { entry, redCandle: argv.includes("--red") }).filter((s) => s.t > from && s.t <= to);
    const marks = new Map<number, string[]>();
    const add = (t: number, m: string): void => { marks.set(t, [...(marks.get(t) ?? []), m]); };
    for (const s of sigs) {
      if (entry === "oiPeak") { add(s.startT, "1️⃣ OI low"); add(s.peakT, "OI PEAK"); }
      else { add(s.startT + 900_000, "1️⃣ move start"); add(s.peakT, s.side === "SHORT" ? "TOP" : "BOTTOM"); }
      add(s.t, `3️⃣ ENTRY ${s.side}`);
    }
    const inRange = c.filter((x) => x.t >= from && x.end <= to);
    if (!inRange.length) throw new Error("no candles in that window");
    const oiRef = inRange[0].oi0;
    // ATR(14) on 15m candles, known BEFORE each candle (Wilder) -- as the DC uses it
    const atr = atrBefore(c, 14), atrOf = new Map(c.map((x, i) => [x.t, atr[i]]));
    const frozenT = arg("atrfrom", "") ? ms(arg("atrfrom", "")) : inRange[0].t;
    const frozen = atrOf.get(frozenT) ?? NaN;
    let hi = -Infinity, firstLive = "", firstFrozen = "";
    console.log(`${symbol} · 15m candles · UTC · OI total = OI vs the window's start`);
    console.log(`ATR = the 15m ATR(14) known before the candle · "-1ATR" = the highest high so far minus 1 ATR (live ATR) · frozen ATR = the ATR before ${hm(frozenT)}: ${+frozen.toPrecision(4)} (${sp((100 * frozen) / inRange[0].open)})\n`);
    console.log("candle        close       price    OI      OI total  who          ATR      high       -1ATR      -1ATR(frozen)  rule");
    for (const x of inRange) {
      hi = Math.max(hi, x.high);
      const a = atrOf.get(x.t) ?? NaN, lineLive = hi - a, lineFrozen = hi - frozen;
      const okLive = x.close <= lineLive, okFrozen = x.close <= lineFrozen;
      if (okLive && !firstLive) firstLive = hm(x.end);
      if (okFrozen && !firstFrozen) firstFrozen = hm(x.end);
      const f = (v: number): string => String(+v.toPrecision(6)).padEnd(10);
      console.log(`${hm(x.t)}  ${f(x.close)} ${sp((100 * (x.close - x.open)) / x.open).padStart(7)} ${sp((100 * (x.oi1 - x.oi0)) / x.oi0).padStart(7)} ${sp((100 * (x.oi1 - oiRef)) / oiRef).padStart(8)}  ${label(x).padEnd(11)}  ${sp((100 * a) / x.open).padStart(7)}  ${f(hi)} ${f(lineLive)}${okLive ? "✓" : " "} ${f(lineFrozen)}${okFrozen ? "✓" : " "}    ${(marks.get(x.end) ?? []).join(" · ")}`);
    }
    console.log(`\nfirst close 1 ATR below the high (the high counted from the window's start): live ATR ${firstLive || "never"} · frozen ATR ${firstFrozen || "never"}`);
    console.log(`\n(the rule's times are candle CLOSES: "OI low" / "OI PEAK" / "ENTRY" are printed on the candle that closes then)\n`);
    if (!sigs.length) console.log(`no entry in this window by the rule (${entry})`);
    for (const s of sigs) {
      const up = s.side === "SHORT";
      console.log(`${up ? "🔻" : "🔺"} ${symbol} ${s.side} · entry ${hm(s.t)} UTC at ${+s.price.toPrecision(6)}`);
      console.log(`1️⃣ ${hm(s.startT)} → ${hm(s.peakT)}: price ${up ? "up" : "down"}, OI ${sp(s.buildOiPct)} (RANK 1 of ${s.prior} moves in ${win}h) · extreme ${+s.extreme.toPrecision(6)} (${sp(s.movePct)})`);
      console.log(`2️⃣ from the OI peak: OI ${sp(s.fromPeakOiPct)}${"atr" in s ? ` · the close came back ${s.backPct.toFixed(2)}% from the extreme (1 ATR = ${((100 * s.atr) / s.extreme).toFixed(2)}%)` : ""}`);
      console.log(`3️⃣ ${hm(s.t - 900_000)} candle: ${s.label}, OI ${sp(s.candleOiPct)} -> entry\n`);
    }
  } finally { await client.close(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
