/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, BTC only, these
 * two specific bursts only. Extends the prior directional-ATR
 * recovery test with: (a) identical fixed horizons for both bursts
 * instead of an incomparable "until new low" window, (b) TP-side
 * candidates A-E tested against actual recovery per horizon, (c) a
 * genuinely separate SL-side / downside-risk analysis (not forced to
 * share a formula with the TP side), (d) a full per-candle
 * normalization timeline tracking BOTH DownATR and UpATR back toward
 * their own pre-burst levels (not just the ratio), and (e) a direct
 * Burst A vs Burst B comparison table.
 *
 * v1 directional ATR (prior-close-referenced) is the primary
 * definition throughout, per instruction. v2 (Wilder's own +DM/-DM)
 * is also computed and reported at pre/post burst so a v1-vs-v2
 * divergence, if any, is visible rather than assumed away.
 *
 * CAUSALITY: identical discipline to every prior pass. ATR values are
 * always computed causally at whatever timestamp they're evaluated
 * at, including every step of the forward walk (a real replay through
 * now-historical candles, not a single look-ahead value). Outcome
 * measurements (did price recover, how far, how fast) are explicitly
 * allowed to use real future candles, per instruction -- this is
 * offline outcome research, not a live decision. No 1-minute candle's
 * full high/low is used to fabricate the price path between two
 * individual liquidation events.
 *
 * No threshold is invented. No winner is declared for any candidate
 * formula. SL-side candidates are explicitly NOT required to mirror
 * the TP-side formulas.
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
const FORWARD_WALK_HOURS = 6;
const HORIZONS_MIN = [1, 3, 5, 10, 15, 30];

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
  return (n >= 0 ? "$" : "-$") + Math.abs(n).toFixed(2);
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
function directionalTrV2(
  candlesAsc: Candle[],
): { t: number; downTr: number; upTr: number }[] {
  const out: { t: number; downTr: number; upTr: number }[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    const upMove = c.high - p.high,
      downMove = p.low - c.low;
    out.push({
      t: c.t,
      downTr: downMove > upMove && downMove > 0 ? downMove : 0,
      upTr: upMove > downMove && upMove > 0 ? upMove : 0,
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

  const emaAtr14 = emaAtrSeries(candlesAsc, 14);
  const dtrV1 = directionalTrV1(candlesAsc),
    dtrV2 = directionalTrV2(candlesAsc);
  const downV1 = emaOfSeries(
    dtrV1.map((d) => ({ t: d.t, v: d.downTr })),
    14,
  );
  const upV1 = emaOfSeries(
    dtrV1.map((d) => ({ t: d.t, v: d.upTr })),
    14,
  );
  const downV2 = emaOfSeries(
    dtrV2.map((d) => ({ t: d.t, v: d.downTr })),
    14,
  );
  const upV2 = emaOfSeries(
    dtrV2.map((d) => ({ t: d.t, v: d.upTr })),
    14,
  );

  const burstResults: any[] = [];

  for (const b of BURSTS) {
    const startTs = Date.parse(b.startIso),
      endTs = Date.parse(b.endIso);
    console.log("=".repeat(170));
    console.log(b.label);
    console.log("=".repeat(170));

    const preDownV1 = lookupCausal(downV1, startTs)!,
      postDownV1 = lookupCausal(downV1, endTs)!;
    const preUpV1 = lookupCausal(upV1, startTs)!,
      postUpV1 = lookupCausal(upV1, endTs)!;
    const preRatioV1 = preDownV1 / preUpV1,
      postRatioV1 = postDownV1 / postUpV1;
    const preDownV2 = lookupCausal(downV2, startTs),
      postDownV2 = lookupCausal(downV2, endTs);
    const preUpV2 = lookupCausal(upV2, startTs),
      postUpV2 = lookupCausal(upV2, endTs);

    console.log(
      "\nv1 (primary): PreDown=" +
        preDownV1.toFixed(4) +
        " PreUp=" +
        preUpV1.toFixed(4) +
        " PreRatio=" +
        preRatioV1.toFixed(4) +
        " | PostDown=" +
        postDownV1.toFixed(4) +
        " PostUp=" +
        postUpV1.toFixed(4) +
        " PostRatio=" +
        postRatioV1.toFixed(4),
    );
    if (
      preDownV2 !== null &&
      postDownV2 !== null &&
      preUpV2 !== null &&
      postUpV2 !== null
    ) {
      console.log(
        "v2 (comparison): PreDown=" +
          preDownV2.toFixed(4) +
          " PreUp=" +
          preUpV2.toFixed(4) +
          " PreRatio=" +
          (preDownV2 / preUpV2).toFixed(4) +
          " | PostDown=" +
          postDownV2.toFixed(4) +
          " PostUp=" +
          postUpV2.toFixed(4) +
          " PostRatio=" +
          (postDownV2 / postUpV2).toFixed(4),
      );
    }

    let burstExtreme = Infinity;
    for (let t = Math.floor(startTs / 60000) * 60000; t <= endTs; t += 60000) {
      const c = candleAt(klines, t);
      if (c && c.low < burstExtreme) burstExtreme = c.low;
    }
    const burstEndCandle = candleAt(klines, endTs);
    const burstEndClose = burstEndCandle?.close ?? burstExtreme;
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
      "\nburstExtreme (low)=" +
        burstExtreme.toFixed(2) +
        "  burstEndClose=" +
        burstEndClose.toFixed(2) +
        "  burstStartPrice=" +
        burstStartPrice.toFixed(2),
    );

    console.log("\n--- PART 1: FIXED-HORIZON OUTCOMES ---");
    const horizonResults: any[] = [];
    for (const hMin of HORIZONS_MIN) {
      const horizonTs = endTs + hMin * 60000;
      let maxUp = 0,
        maxDown = 0,
        newLow = false,
        newLowTs: number | null = null,
        maxUpTs: number | null = null;
      for (
        let t = Math.floor(endTs / 60000) * 60000 + 60000;
        t <= horizonTs;
        t += 60000
      ) {
        const c = candleAt(klines, t);
        if (!c) continue;
        const up = c.high - burstExtreme;
        if (up > maxUp) {
          maxUp = up;
          maxUpTs = t;
        }
        const down = Math.max(0, burstExtreme - c.low);
        if (down > maxDown) maxDown = down;
        if (c.low < burstExtreme && !newLow) {
          newLow = true;
          newLowTs = t;
        }
      }
      const horizonCandle = candleAt(klines, horizonTs);
      const closeToCloseNet = horizonCandle
        ? horizonCandle.close - burstEndClose
        : null;
      const r = {
        horizonMin: hMin,
        maxUpUsd: maxUp,
        maxUpPct: (maxUp / burstExtreme) * 100,
        maxUpInPreUpAtr: maxUp / preUpV1,
        maxDownUsd: maxDown,
        maxDownPct: (maxDown / burstExtreme) * 100,
        maxDownInPreDownAtr: maxDown / preDownV1,
        closeToCloseNet,
        newLow,
        newLowTs,
        maxUpTs,
        timeToMaxUpMin: maxUpTs ? (maxUpTs - endTs) / 60000 : null,
        timeToNewLowMin: newLowTs ? (newLowTs - endTs) / 60000 : null,
      };
      horizonResults.push(r);
      console.log(
        "  +" +
          hMin +
          "min: maxUp=" +
          fmtUsd(r.maxUpUsd) +
          " (" +
          fmtPct(r.maxUpPct) +
          ", " +
          r.maxUpInPreUpAtr.toFixed(3) +
          " preUpATR)  " +
          "maxDown=" +
          fmtUsd(r.maxDownUsd) +
          " (" +
          fmtPct(r.maxDownPct) +
          ", " +
          r.maxDownInPreDownAtr.toFixed(3) +
          " preDownATR)  " +
          "closeNet=" +
          fmtUsd(r.closeToCloseNet) +
          "  newLow=" +
          (r.newLow ? "YES@+" + r.timeToNewLowMin!.toFixed(1) + "min" : "no"),
      );
    }

    const downExpansion = postDownV1 - preDownV1;
    const upCompression = preUpV1 - postUpV1;
    const candA = Math.max(0, upCompression);
    const candB = Math.max(0, downExpansion);
    const candC = (candA + candB) / 2;
    const requiredUpForPreRatio = postDownV1 / preRatioV1;
    const candD = Math.max(0, requiredUpForPreRatio - postUpV1);
    const shockDisplacement = burstStartPrice - burstExtreme;
    const shockAtr = shockDisplacement / preDownV1;
    const candE_shockBased = shockAtr * preUpV1;

    console.log(
      "\n--- PART 2: TP-SIDE CANDIDATES (all $ distances from burstExtreme) ---",
    );
    console.log("  A (UpATR compression):    " + fmtUsd(candA));
    console.log("  B (DownATR expansion):    " + fmtUsd(candB));
    console.log("  C (mean of A,B):          " + fmtUsd(candC));
    console.log("  D (ratio-normalization gap): " + fmtUsd(candD));
    console.log(
      "  E (ShockATR x preUpATR):  " +
        fmtUsd(candE_shockBased) +
        "  (ShockATR=" +
        shockAtr.toFixed(4) +
        ")",
    );
    console.log("\n  candidate reached, by horizon:");
    for (const hr of horizonResults) {
      const reached = (["A", "B", "C", "D", "E"] as const)
        .map((k) => {
          const target =
            k === "A"
              ? candA
              : k === "B"
                ? candB
                : k === "C"
                  ? candC
                  : k === "D"
                    ? candD
                    : candE_shockBased;
          return k + "=" + (hr.maxUpUsd >= target ? "YES" : "no");
        })
        .join(" ");
      console.log("    +" + hr.horizonMin + "min: " + reached);
    }

    console.log("\n--- PART 3: SL-SIDE / DOWNSIDE-RISK ANALYSIS ---");
    console.log(
      "  persistence + subsequent downside re-extension, per horizon (descriptive, n=1 per burst -- not a validated model):",
    );
    for (const hMin of HORIZONS_MIN) {
      const horizonTs = endTs + hMin * 60000;
      const curDown = lookupCausal(downV1, horizonTs),
        curUp = lookupCausal(upV1, horizonTs);
      if (curDown === null || curUp === null) continue;
      const curRatio = curDown / curUp;
      const remainingDownExpansion = curDown - preDownV1;
      const upShortfall = preUpV1 - curUp;
      const ratioElevationPct = ((curRatio - preRatioV1) / preRatioV1) * 100;

      const nextHmin = HORIZONS_MIN[HORIZONS_MIN.indexOf(hMin) + 1] ?? 30;
      const nextTs = endTs + nextHmin * 60000;
      let subsequentDown = 0;
      for (let t = horizonTs + 60000; t <= nextTs; t += 60000) {
        const c = candleAt(klines, t);
        if (!c) continue;
        const down = Math.max(0, burstExtreme - c.low);
        if (down > subsequentDown) subsequentDown = down;
      }

      console.log(
        "  at +" +
          hMin +
          "min: DownATR=" +
          curDown.toFixed(2) +
          " (remainingExpansion=" +
          fmtUsd(remainingDownExpansion) +
          ")  UpATR=" +
          curUp.toFixed(2) +
          " (shortfall=" +
          fmtUsd(upShortfall) +
          ")  " +
          "ratio=" +
          curRatio.toFixed(3) +
          " (elevation=" +
          fmtPct(ratioElevationPct) +
          " vs pre)  -> subsequent maxDown (+" +
          hMin +
          "min to +" +
          nextHmin +
          "min)=" +
          fmtUsd(subsequentDown),
      );
    }

    console.log(
      "\n--- PART 4: NORMALIZATION TIMELINE (every 5th closed 1m candle shown, burst end through +" +
        FORWARD_WALK_HOURS +
        "h) ---",
    );
    console.log(
      "timestamp | price | EMA_ATR | DownATR | UpATR | ratio | distFromPreDown | distFromPreUp | distFromPreRatio | upRecovery$ | upRecovery% | newLowDist$",
    );
    const upNorm: Record<
      number,
      { ts: number | null; price: number | null; upRecoveryPct: number | null }
    > = {};
    const downNorm: Record<
      number,
      { ts: number | null; price: number | null; upRecoveryPct: number | null }
    > = {};
    const ratioNorm: Record<
      number,
      { ts: number | null; price: number | null; upRecoveryPct: number | null }
    > = {};
    [25, 50, 75, 100].forEach((p) => {
      upNorm[p] = { ts: null, price: null, upRecoveryPct: null };
      downNorm[p] = { ts: null, price: null, upRecoveryPct: null };
      ratioNorm[p] = { ts: null, price: null, upRecoveryPct: null };
    });

    for (
      let t = Math.floor(endTs / 60000) * 60000;
      t <= endTs + FORWARD_WALK_HOURS * 3600000;
      t += 60000
    ) {
      const c = candleAt(klines, t);
      if (!c) continue;
      const eAtr = lookupCausal(emaAtr14, t);
      const curDown = lookupCausal(downV1, t),
        curUp = lookupCausal(upV1, t);
      if (curDown === null || curUp === null) continue;
      const curRatio = curDown / curUp;
      const distFromPreDown = curDown - preDownV1;
      const distFromPreUp = curUp - preUpV1;
      const distFromPreRatio = curRatio - preRatioV1;
      const upRecoveryUsd = c.high - burstExtreme;
      const upRecoveryPct = (upRecoveryUsd / burstExtreme) * 100;
      const newLowDist = c.low < burstExtreme ? burstExtreme - c.low : 0;

      if (t % (5 * 60000) === 0 || t === endTs) {
        console.log(
          fmtClock(t) +
            " | " +
            c.close.toFixed(1) +
            " | " +
            (eAtr?.toFixed(3) ?? "n/a") +
            " | " +
            curDown.toFixed(3) +
            " | " +
            curUp.toFixed(3) +
            " | " +
            curRatio.toFixed(3) +
            " | " +
            fmtUsd(distFromPreDown) +
            " | " +
            fmtUsd(distFromPreUp) +
            " | " +
            distFromPreRatio.toFixed(3) +
            " | " +
            fmtUsd(upRecoveryUsd) +
            " | " +
            fmtPct(upRecoveryPct) +
            " | " +
            fmtUsd(newLowDist),
        );
      }

      const upFrac =
        preUpV1 !== postUpV1
          ? ((curUp - postUpV1) / (preUpV1 - postUpV1)) * 100
          : null;
      const downFrac =
        preDownV1 !== postDownV1
          ? ((postDownV1 - curDown) / (postDownV1 - preDownV1)) * 100
          : null;
      const ratioFrac =
        preRatioV1 !== postRatioV1
          ? ((postRatioV1 - curRatio) / (postRatioV1 - preRatioV1)) * 100
          : null;
      [25, 50, 75, 100].forEach((p) => {
        if (upFrac !== null && upNorm[p].ts === null && upFrac >= p)
          upNorm[p] = { ts: t, price: c.close, upRecoveryPct };
        if (downFrac !== null && downNorm[p].ts === null && downFrac >= p)
          downNorm[p] = { ts: t, price: c.close, upRecoveryPct };
        if (ratioFrac !== null && ratioNorm[p].ts === null && ratioFrac >= p)
          ratioNorm[p] = { ts: t, price: c.close, upRecoveryPct };
      });
    }

    console.log("\n  UpATR normalization crossings:");
    [25, 50, 75, 100].forEach((p) => {
      const r = upNorm[p];
      console.log(
        "    " +
          p +
          "%: " +
          (r.ts
            ? fmtClock(r.ts) +
              " price=" +
              r.price!.toFixed(1) +
              " upRecovery=" +
              fmtPct(r.upRecoveryPct)
            : "not reached"),
      );
    });
    console.log("  DownATR normalization crossings:");
    [25, 50, 75, 100].forEach((p) => {
      const r = downNorm[p];
      console.log(
        "    " +
          p +
          "%: " +
          (r.ts
            ? fmtClock(r.ts) +
              " price=" +
              r.price!.toFixed(1) +
              " upRecovery=" +
              fmtPct(r.upRecoveryPct)
            : "not reached"),
      );
    });
    console.log("  Ratio normalization crossings:");
    [25, 50, 75, 100].forEach((p) => {
      const r = ratioNorm[p];
      console.log(
        "    " +
          p +
          "%: " +
          (r.ts
            ? fmtClock(r.ts) +
              " price=" +
              r.price!.toFixed(1) +
              " upRecovery=" +
              fmtPct(r.upRecoveryPct)
            : "not reached"),
      );
    });

    burstResults.push({
      label: b.label,
      preDownV1,
      postDownV1,
      preUpV1,
      postUpV1,
      preRatioV1,
      postRatioV1,
      shockAtr,
      candA,
      candB,
      candC,
      candD,
      candE_shockBased,
      horizonResults,
      burstExtreme,
      burstStartPrice,
    });
    console.log("");
  }

  console.log("=".repeat(170));
  console.log("PART 6: BURST A vs BURST B COMPARISON");
  console.log("=".repeat(170));
  if (burstResults.length === 2) {
    const [a, bb] = burstResults;
    console.log("\n" + "field".padEnd(30) + " | BURST A | BURST B");
    console.log(
      "preDownATR".padEnd(30) +
        " | " +
        a.preDownV1.toFixed(4) +
        " | " +
        bb.preDownV1.toFixed(4),
    );
    console.log(
      "postDownATR".padEnd(30) +
        " | " +
        a.postDownV1.toFixed(4) +
        " | " +
        bb.postDownV1.toFixed(4),
    );
    console.log(
      "preUpATR".padEnd(30) +
        " | " +
        a.preUpV1.toFixed(4) +
        " | " +
        bb.preUpV1.toFixed(4),
    );
    console.log(
      "postUpATR".padEnd(30) +
        " | " +
        a.postUpV1.toFixed(4) +
        " | " +
        bb.postUpV1.toFixed(4),
    );
    console.log(
      "preRatio".padEnd(30) +
        " | " +
        a.preRatioV1.toFixed(4) +
        " | " +
        bb.preRatioV1.toFixed(4),
    );
    console.log(
      "postRatio".padEnd(30) +
        " | " +
        a.postRatioV1.toFixed(4) +
        " | " +
        bb.postRatioV1.toFixed(4),
    );
    console.log(
      "ShockATR".padEnd(30) +
        " | " +
        a.shockAtr.toFixed(4) +
        " | " +
        bb.shockAtr.toFixed(4),
    );
    console.log(
      "candidate A ($)".padEnd(30) +
        " | " +
        a.candA.toFixed(2) +
        " | " +
        bb.candA.toFixed(2),
    );
    console.log(
      "candidate B ($)".padEnd(30) +
        " | " +
        a.candB.toFixed(2) +
        " | " +
        bb.candB.toFixed(2),
    );
    console.log(
      "candidate C ($)".padEnd(30) +
        " | " +
        a.candC.toFixed(2) +
        " | " +
        bb.candC.toFixed(2),
    );
    console.log(
      "candidate D ($)".padEnd(30) +
        " | " +
        a.candD.toFixed(2) +
        " | " +
        bb.candD.toFixed(2),
    );
    console.log(
      "candidate E ($)".padEnd(30) +
        " | " +
        a.candE_shockBased.toFixed(2) +
        " | " +
        bb.candE_shockBased.toFixed(2),
    );
    for (const hMin of HORIZONS_MIN) {
      const ha = a.horizonResults.find((h: any) => h.horizonMin === hMin),
        hb = bb.horizonResults.find((h: any) => h.horizonMin === hMin);
      console.log(
        ("actual recovery +" + hMin + "min ($)").padEnd(30) +
          " | " +
          ha.maxUpUsd.toFixed(2) +
          " | " +
          hb.maxUpUsd.toFixed(2),
      );
      console.log(
        ("additional downside +" + hMin + "min ($)").padEnd(30) +
          " | " +
          ha.maxDownUsd.toFixed(2) +
          " | " +
          hb.maxDownUsd.toFixed(2),
      );
      console.log(
        ("new low by +" + hMin + "min?").padEnd(30) +
          " | " +
          (ha.newLow ? "YES" : "no") +
          " | " +
          (hb.newLow ? "YES" : "no"),
      );
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "tp-sl-directional-atr-analysis-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: SYMBOL,
        victim: VICTIM,
        note: "ATR causal at every point including the forward walk. Outcome data intentionally uses real future candles -- offline outcome research, not a live decision. No threshold invented, no candidate declared a winner.",
        burstResults,
      },
      null,
      2,
    ),
  );
  console.log("\n\nFull data: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
