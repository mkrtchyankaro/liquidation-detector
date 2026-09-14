/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, BTC only, these
 * two specific bursts only. Tests whether the DownATR/UpATR(v1,EMA14)
 * distortion measured during a LONG liquidation burst contains
 * information about the post-burst upward recovery distance.
 *
 * CAUSALITY split, exactly as instructed:
 *   - ATR values themselves (EMA/DownATR/UpATR) are ALWAYS computed
 *     causally -- at any walked timestamp, only fully closed candles
 *     strictly before that timestamp are used. This holds during the
 *     burst AND during the post-burst forward walk (the forward walk
 *     is a REPLAY through real, now-historical candles, asking "what
 *     would this causal ATR have shown at each of these later
 *     moments" -- never a single look-ahead value pasted in).
 *   - The OUTCOME side (did price actually recover, how far, how
 *     fast) is explicitly allowed to use future data relative to the
 *     burst, per the operator's own instruction: this is offline
 *     outcome research, not a live decision simulation.
 *   - No 1-minute candle's full high/low is used to fake the price
 *     path BETWEEN two individual liquidation events. The burst's own
 *     "directional extreme" is different in kind: it is the minimum
 *     LOW across the burst's own candles, all of which are safely and
 *     entirely in the past by the time this post-hoc analysis runs --
 *     identifying an already-completed burst's own overall low is not
 *     the same claim as reconstructing a sub-minute intra-event path.
 *
 * Four candidate recovery-distance formulas (A-D) are computed and
 * compared -- none is asserted correct. No threshold is invented; the
 * "reached / not reached" check is a direct comparison against the
 * candidate's own computed number.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No trading rule created.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

const SYMBOL = "BTCUSDT";
const VICTIM = "LONG";
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const FORWARD_WALK_HOURS = 48;

const BURSTS = [
  {
    label: "BURST A",
    startIso: "2026-09-10T16:05:04.000Z",
    endIso: "2026-09-10T16:10:13.000Z",
  },
  {
    label: "BURST B",
    startIso: "2026-09-10T16:34:17.000Z",
    endIso: "2026-09-10T16:35:57.000Z",
  },
];

function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
function fmtPct(n: number | null, d?: number) {
  return n === null || n === undefined
    ? "n/a"
    : (n >= 0 ? "+" : "") + n.toFixed(d ?? 3) + "%";
}
function fmtUsd(n: number | null) {
  if (n === null) return "n/a";
  return "$" + Math.abs(n).toFixed(2);
}

function httpsGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}
async function fetchKlines(symbol: string, startTime: number, endTime: number) {
  const m = new Map<
    number,
    { t: number; open: number; high: number; low: number; close: number }
  >();
  let cursor = startTime;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + 1499 * 60000, endTime);
    const raw = await httpsGetJson(
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
        symbol +
        "&interval=1m&startTime=" +
        cursor +
        "&endTime=" +
        chunkEnd +
        "&limit=1500",
    );
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw)
      m.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    cursor = raw[raw.length - 1][0] + 60000;
  }
  return m;
}

type Candle = {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

function emaAtrSeries(
  candlesAsc: Candle[],
  period: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (candlesAsc.length < 2) return out;
  const alpha = 2 / (period + 1);
  const trs: { t: number; tr: number }[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    trs.push({
      t: c.t,
      tr: Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close),
      ),
    });
  }
  let ema = trs[0].tr;
  out.set(trs[0].t, ema);
  for (let i = 1; i < trs.length; i++) {
    ema = alpha * trs[i].tr + (1 - alpha) * ema;
    out.set(trs[i].t, ema);
  }
  return out;
}
function directionalTrV1(
  candlesAsc: Candle[],
): { t: number; downTr: number; upTr: number }[] {
  const out: { t: number; downTr: number; upTr: number }[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    out.push({
      t: c.t,
      downTr: Math.max(0, p.close - c.low),
      upTr: Math.max(0, c.high - p.close),
    });
  }
  return out;
}
function emaOfSeries(
  series: { t: number; v: number }[],
  period: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (series.length === 0) return out;
  const alpha = 2 / (period + 1);
  let ema = series[0].v;
  out.set(series[0].t, ema);
  for (let i = 1; i < series.length; i++) {
    ema = alpha * series[i].v + (1 - alpha) * ema;
    out.set(series[i].t, ema);
  }
  return out;
}
function lookupCausal(
  seriesMap: Map<number, number>,
  ms: number,
): number | null {
  let t = Math.floor(ms / 60000) * 60000 - 60000;
  for (let i = 0; i < 400; i++) {
    if (seriesMap.has(t)) return seriesMap.get(t)!;
    t -= 60000;
  }
  return null;
}
function candleAt(klines: Map<number, Candle>, ms: number): Candle | null {
  return klines.get(Math.floor(ms / 60000) * 60000) || null;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const col = db.collection("liq_raw_events");

  const earliest = Math.min(...BURSTS.map((b) => Date.parse(b.startIso)));
  const latest = Math.max(...BURSTS.map((b) => Date.parse(b.endIso)));
  const klines = await fetchKlines(
    SYMBOL,
    earliest - 8 * 3600000,
    latest + FORWARD_WALK_HOURS * 3600000,
  );
  const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
  console.log(
    "Fetched " +
      candlesAsc.length +
      " 1m candles, " +
      new Date(candlesAsc[0]?.t ?? 0).toISOString() +
      " to " +
      new Date(candlesAsc[candlesAsc.length - 1]?.t ?? 0).toISOString() +
      "\n",
  );

  const dtrV1 = directionalTrV1(candlesAsc);
  const downAtrV1 = emaOfSeries(
    dtrV1.map((d) => ({ t: d.t, v: d.downTr })),
    14,
  );
  const upAtrV1 = emaOfSeries(
    dtrV1.map((d) => ({ t: d.t, v: d.upTr })),
    14,
  );

  for (const b of BURSTS) {
    const startTs = Date.parse(b.startIso),
      endTs = Date.parse(b.endIso);
    console.log("=".repeat(160));
    console.log(b.label + " (" + b.startIso + " -> " + b.endIso + ")");
    console.log("=".repeat(160));

    const preDownAtr = lookupCausal(downAtrV1, startTs),
      postDownAtr = lookupCausal(downAtrV1, endTs);
    const preUpAtr = lookupCausal(upAtrV1, startTs),
      postUpAtr = lookupCausal(upAtrV1, endTs);
    if (
      preDownAtr === null ||
      postDownAtr === null ||
      preUpAtr === null ||
      postUpAtr === null
    ) {
      console.log("insufficient ATR data -- skipping this burst.");
      continue;
    }
    const downExpansion = postDownAtr - preDownAtr;
    const upCompression = preUpAtr - postUpAtr;
    const preRatio = preDownAtr / preUpAtr;
    const postRatio = postDownAtr / postUpAtr;

    console.log("\n--- 1. ATR DISTORTION MAGNITUDE ---");
    console.log(
      "  Pre  DownATR=" +
        preDownAtr.toFixed(4) +
        "  UpATR=" +
        preUpAtr.toFixed(4) +
        "  ratio(Down/Up)=" +
        preRatio.toFixed(4),
    );
    console.log(
      "  Post DownATR=" +
        postDownAtr.toFixed(4) +
        "  UpATR=" +
        postUpAtr.toFixed(4) +
        "  ratio(Down/Up)=" +
        postRatio.toFixed(4),
    );
    console.log(
      "  DownATR expansion: " +
        downExpansion.toFixed(4) +
        " (" +
        fmtPct((downExpansion / preDownAtr) * 100) +
        ")",
    );
    console.log(
      "  UpATR compression: " +
        upCompression.toFixed(4) +
        " (" +
        fmtPct((upCompression / preUpAtr) * 100) +
        ")",
    );
    console.log(
      "  ratio distortion: " +
        preRatio.toFixed(4) +
        " -> " +
        postRatio.toFixed(4) +
        "  (x" +
        (postRatio / preRatio).toFixed(3) +
        ")",
    );

    const candidateA = Math.max(0, upCompression);
    const candidateB = Math.max(0, downExpansion);
    const candidateC = (candidateA + candidateB) / 2;
    const requiredUpAtrForPreRatio = postDownAtr / preRatio;
    const candidateD = Math.max(0, requiredUpAtrForPreRatio - postUpAtr);

    console.log(
      "\n--- 2. CANDIDATE RECOVERY-DISTANCE FORMULAS (all in $, since ATR itself is price-denominated) ---",
    );
    console.log(
      "  A (UpATR compression recovered):        $" + candidateA.toFixed(2),
    );
    console.log(
      "  B (DownATR expansion, as up-distance):  $" + candidateB.toFixed(2),
    );
    console.log(
      "  C (mean of A and B):                    $" + candidateC.toFixed(2),
    );
    console.log(
      "  D (UpATR gap implied by pre-burst ratio, holding DownATR fixed): $" +
        candidateD.toFixed(2),
    );

    let burstExtreme = Infinity;
    for (let t = Math.floor(startTs / 60000) * 60000; t <= endTs; t += 60000) {
      const c = candleAt(klines, t);
      if (!c) continue;
      if (c.low < burstExtreme) burstExtreme = c.low;
    }
    const firstEventDoc = await col
      .find({
        symbol: SYMBOL,
        victim: VICTIM,
        timestamp: { $gte: startTs - 5000, $lte: startTs + 5000 },
      })
      .sort({ timestamp: 1 })
      .limit(1)
      .toArray();
    const burstStartPrice =
      firstEventDoc.length > 0
        ? firstEventDoc[0].price
        : (candleAt(klines, startTs)?.close ?? burstExtreme);

    console.log(
      "\n--- burst's own directional extreme (min candle low across the burst's own now-closed candles) ---",
    );
    console.log(
      "  burstStartPrice (nearest real liquidation event): $" +
        burstStartPrice.toFixed(2),
    );
    console.log(
      "  burstExtreme (lowest low reached during the burst): $" +
        burstExtreme.toFixed(2),
    );

    let maxRecoveryUsd = 0,
      maxRecoveryTs = endTs;
    let newLowTs: number | null = null;
    const reachedCandidate: Record<
      string,
      { reached: boolean; ts: number | null; atMinutes: number | null }
    > = {
      A: { reached: false, ts: null, atMinutes: null },
      B: { reached: false, ts: null, atMinutes: null },
      C: { reached: false, ts: null, atMinutes: null },
      D: { reached: false, ts: null, atMinutes: null },
    };
    const upAtrMultiples = [0.25, 0.5, 1.0, 1.5, 2.0];
    const reachedUpAtrMultiple: Record<
      number,
      { reached: boolean; ts: number | null; atMinutes: number | null }
    > = {};
    upAtrMultiples.forEach(
      (m) =>
        (reachedUpAtrMultiple[m] = {
          reached: false,
          ts: null,
          atMinutes: null,
        }),
    );

    const normTargets = [25, 50, 75, 100];
    const normReached: Record<
      number,
      {
        ts: number | null;
        priceRecoveryUsd: number | null;
        priceRecoveryPct: number | null;
      }
    > = {};
    normTargets.forEach(
      (p) =>
        (normReached[p] = {
          ts: null,
          priceRecoveryUsd: null,
          priceRecoveryPct: null,
        }),
    );

    for (
      let t = Math.floor(endTs / 60000) * 60000 + 60000;
      t <= endTs + FORWARD_WALK_HOURS * 3600000;
      t += 60000
    ) {
      const c = candleAt(klines, t);
      if (!c) continue;
      if (c.low < burstExtreme) {
        newLowTs = t;
        break;
      }

      const recoveryUsd = c.high - burstExtreme;
      if (recoveryUsd > maxRecoveryUsd) {
        maxRecoveryUsd = recoveryUsd;
        maxRecoveryTs = t;
      }

      const minutesSinceBurstEnd = (t - endTs) / 60000;
      for (const key of ["A", "B", "C", "D"] as const) {
        const target =
          key === "A"
            ? candidateA
            : key === "B"
              ? candidateB
              : key === "C"
                ? candidateC
                : candidateD;
        if (!reachedCandidate[key].reached && recoveryUsd >= target)
          reachedCandidate[key] = {
            reached: true,
            ts: t,
            atMinutes: minutesSinceBurstEnd,
          };
      }
      for (const m of upAtrMultiples) {
        if (!reachedUpAtrMultiple[m].reached && recoveryUsd >= m * preUpAtr)
          reachedUpAtrMultiple[m] = {
            reached: true,
            ts: t,
            atMinutes: minutesSinceBurstEnd,
          };
      }

      const curDownAtr = lookupCausal(downAtrV1, t),
        curUpAtr = lookupCausal(upAtrV1, t);
      if (curDownAtr !== null && curUpAtr !== null && curUpAtr > 0) {
        const curRatio = curDownAtr / curUpAtr;
        const denom = postRatio - preRatio;
        const fracNormalized =
          denom !== 0 ? ((postRatio - curRatio) / denom) * 100 : null;
        if (fracNormalized !== null) {
          for (const p of normTargets) {
            if (normReached[p].ts === null && fracNormalized >= p) {
              normReached[p] = {
                ts: t,
                priceRecoveryUsd: recoveryUsd,
                priceRecoveryPct: (recoveryUsd / burstExtreme) * 100,
              };
            }
          }
        }
      }
    }

    console.log(
      "\n--- 3. NORMALIZATION WALK-FORWARD (ATR-ratio return toward pre-burst baseline) ---",
    );
    normTargets.forEach((p) => {
      const r = normReached[p];
      console.log(
        "  " +
          p +
          "% normalized -> " +
          (r.ts !== null
            ? fmtClock(r.ts) +
              "  price recovery=" +
              fmtUsd(r.priceRecoveryUsd) +
              " (" +
              fmtPct(r.priceRecoveryPct) +
              ")"
            : "never reached within " +
              FORWARD_WALK_HOURS +
              "h forward window (or a new low occurred first)"),
      );
    });

    console.log("\n--- 4. CANDIDATE vs ACTUAL RECOVERY ---");
    console.log(
      "  max recovery reached before a new low: $" +
        maxRecoveryUsd.toFixed(2) +
        " (" +
        fmtPct((maxRecoveryUsd / burstExtreme) * 100) +
        ") at " +
        fmtClock(maxRecoveryTs),
    );
    if (newLowTs !== null)
      console.log(
        "  NOTE: a new low below burstExtreme occurred at " +
          fmtClock(newLowTs) +
          " -- recovery tracking stopped there.",
      );
    else
      console.log(
        "  NOTE: no new low occurred within the " +
          FORWARD_WALK_HOURS +
          "h forward window.",
      );
    for (const key of ["A", "B", "C", "D"] as const) {
      const r = reachedCandidate[key];
      console.log(
        "  candidate " +
          key +
          ": " +
          (r.reached
            ? "REACHED at " +
              fmtClock(r.ts!) +
              " (+" +
              r.atMinutes!.toFixed(1) +
              "min after burst end)"
            : "NOT reached before new low / window end"),
      );
    }
    console.log("  time to +0.25/+0.5/+1.0/+1.5/+2.0 pre-burst UpATR:");
    upAtrMultiples.forEach((m) => {
      const r = reachedUpAtrMultiple[m];
      console.log(
        "    +" +
          m +
          " UpATR ($" +
          (m * preUpAtr).toFixed(2) +
          "): " +
          (r.reached
            ? fmtClock(r.ts!) + " (+" + r.atMinutes!.toFixed(1) + "min)"
            : "not reached"),
      );
    });

    const shockDisplacement = burstStartPrice - burstExtreme;
    const shockAtr = preDownAtr > 0 ? shockDisplacement / preDownAtr : null;
    const recoveryAtr = preUpAtr > 0 ? maxRecoveryUsd / preUpAtr : null;
    const recoveryToShockRatio =
      shockAtr !== null && shockAtr > 0 && recoveryAtr !== null
        ? recoveryAtr / shockAtr
        : null;

    console.log("\n--- 7. SHOCK -> RECOVERY ---");
    console.log("  shock displacement: $" + shockDisplacement.toFixed(2));
    console.log(
      "  ShockATR (displacement / pre-burst DownATR): " +
        (shockAtr?.toFixed(4) ?? "n/a"),
    );
    console.log(
      "  RecoveryATR (max recovery / pre-burst UpATR): " +
        (recoveryAtr?.toFixed(4) ?? "n/a"),
    );
    console.log(
      "  Recovery/Shock ratio: " + (recoveryToShockRatio?.toFixed(4) ?? "n/a"),
    );
    console.log("");
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "directional-atr-recovery-test-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: SYMBOL,
        victim: VICTIM,
        note: "ATR values causal at every point (during burst AND during forward walk). Outcome/recovery data intentionally uses real future candles per explicit instruction -- this is offline outcome research, not a live decision.",
        bursts: BURSTS,
      },
      null,
      2,
    ),
  );
  console.log("Metadata: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
