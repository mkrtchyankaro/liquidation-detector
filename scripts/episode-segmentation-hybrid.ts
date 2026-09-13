/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research: build a
 * robust liquidation-episode segmentation function and compare 4
 * candidate rules event-by-event, per symbol + victim side.
 *
 * Candidates (every parameter below is a disclosed research choice,
 * never a hidden magic number, and none of them are fixed absolute
 * time constants -- gap tolerance is always relative to THIS
 * episode's own recent cadence):
 *
 *   A. gap-only (adaptive): split if gap > typicalGap * 4.
 *      typicalGap = median of the last 5 intra-episode gaps (falls
 *      back to the symbol+side's own global median gap ONLY to
 *      bootstrap an episode's first couple of events).
 *
 *   B. gap + rolling intensity: same check, but the multiplier
 *      stretches up to 2x wider when the $/sec flow going into the
 *      gap is still close to this episode's own peak $/sec so far --
 *      effectiveMultiplier = 4 * (1 + intensityRatio), intensityRatio
 *      = clamp(recentIntensity / peakIntensitySoFar, 0, 1).
 *
 *   C. gap + price continuity: adds two ATR-normalized bars on
 *      recovery-from-this-episode's-own-running-extreme:
 *        - below 0.2 ATR recovery: NEVER split (price hasn't left the
 *          regime, regardless of gap size).
 *        - above 0.6 ATR recovery: ALWAYS split (structural recovery
 *          happened, even if liquidation resumes soon after).
 *        - in between: defer to the gap check.
 *
 *   D. B's intensity-adjusted gap check + C's price bars together.
 *
 * CAUSALITY: the running extreme for an IN-PROGRESS episode extends
 * continuously (never resets mid-episode -- it's still the same
 * episode by definition while it's open); ATR is frozen at each
 * episode's own start; recovery/intensity are computed from data
 * available strictly up to the candidate event, never later data.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. This solves episode segmentation ONLY -- no W1/W2
 * classification, no production recommendation.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];
const HOURS = 72;
const BASE_GAP_MULTIPLIER = 4;
const INTENSITY_MAX_STRETCH = 1; // effective multiplier can grow up to BASE * (1 + 1) = 2x wider
const SMALL_PAUSE_ATR_BAR = 0.2; // below this recovery, never split
const STRUCTURAL_RECOVERY_ATR_BAR = 0.6; // above this recovery, always split
const RECENT_GAP_WINDOW = 5;
const MAX_DISAGREEMENTS_TO_PRINT = 10;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtUsd(n: number | null) {
  if (n === null || n === undefined) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtDur(ms: number) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(0) + "s";
  if (s < 3600) return (s / 60).toFixed(1) + "m";
  return (s / 3600).toFixed(2) + "h";
}
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(11, 19) + "Z";
}
function sortNum(a: number[]) {
  return [...a]
    .filter((x) => x !== null && x !== undefined && !isNaN(x))
    .sort((x, y) => x - y);
}
function median(a: number[]) {
  const s = sortNum(a);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
  const byOpenTime = new Map<
    number,
    { t: number; open: number; high: number; low: number; close: number }
  >();
  let cursor = startTime;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + 1499 * 60000, endTime);
    const url =
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=1500";
    const raw = await httpsGetJson(url);
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw)
      byOpenTime.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    cursor = raw[raw.length - 1][0] + 60000;
  }
  return byOpenTime;
}
function computeWilderAtrSeries(
  candlesAsc: { t: number; high: number; low: number; close: number }[],
  period: number,
) {
  const atrMap = new Map<number, number>();
  if (candlesAsc.length < period + 1) return atrMap;
  const trs: number[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      prev = candlesAsc[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    );
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  atrMap.set(candlesAsc[period].t, atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrMap.set(candlesAsc[i + 1].t, atr);
  }
  return atrMap;
}

type Mode = "A" | "B" | "C" | "D";
interface EpisodeInProgress {
  events: any[];
  runningExtreme: number;
  runningExtremeTs: number;
  atrFrozen: number;
  peakIntensityPerSec: number;
}
interface Decision {
  split: boolean;
  gap: number;
  typicalGap: number;
  effectiveMultiplier: number;
  recoveryAtr: number | null;
  intensityRatio: number | null;
  reason: string;
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

  const now = Date.now();
  const windowStart = now - HOURS * 3600 * 1000;

  const summary: any = {};
  const allDisagreements: any[] = [];
  const finalEpisodesD: Record<string, Record<string, any[]>> = {};

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const windowEvents = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    if (windowEvents.length === 0) {
      console.log("  no events.\n");
      continue;
    }

    const klines = await fetchKlines(
      symbol,
      windowStart - 5 * 3600000,
      now + 60000,
    );
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    if (candlesAsc.length < 241) {
      console.log("  insufficient candle history -- skipping.\n");
      continue;
    }
    function candleAt(ms: number) {
      return klines.get(Math.floor(ms / 60000) * 60000) || null;
    }
    function priceJustBefore(ms: number): number | null {
      const c = candleAt(Math.floor(ms / 60000) * 60000 - 60000);
      return c ? c.close : null;
    }
    const atrSeries = computeWilderAtrSeries(candlesAsc, 240);
    function atrAt(ms: number): number | null {
      let t = Math.floor(ms / 60000) * 60000;
      for (let i = 0; i < 300; i++) {
        if (atrSeries.has(t)) return atrSeries.get(t)!;
        t -= 60000;
      }
      return null;
    }

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = windowEvents.filter((e) => e.victim === victim);
      if (sideEvents.length < 3) {
        console.log(
          "  " + victim + ": too few events (n=" + sideEvents.length + ").",
        );
        continue;
      }
      const globalGaps: number[] = [];
      for (let i = 1; i < sideEvents.length; i++)
        globalGaps.push(sideEvents[i].timestamp - sideEvents[i - 1].timestamp);
      const globalMedianGap = median(globalGaps);

      const results: Record<
        Mode,
        { episodes: any[][]; decisions: (Decision | null)[] }
      > = {
        A: { episodes: [], decisions: [] },
        B: { episodes: [], decisions: [] },
        C: { episodes: [], decisions: [] },
        D: { episodes: [], decisions: [] },
      };

      for (const mode of ["A", "B", "C", "D"] as Mode[]) {
        let current: EpisodeInProgress | null = null;
        const episodes: any[][] = [];
        const decisions: (Decision | null)[] = [null];
        for (let i = 0; i < sideEvents.length; i++) {
          const e = sideEvents[i];
          if (current === null) {
            current = {
              events: [e],
              runningExtreme: e.price,
              runningExtremeTs: e.timestamp,
              atrFrozen: atrAt(e.timestamp) ?? 1,
              peakIntensityPerSec: 0,
            };
            continue;
          }
          const lastEv = current.events[current.events.length - 1];
          const gap = e.timestamp - lastEv.timestamp;
          const recentGaps = current.events
            .slice(-RECENT_GAP_WINDOW - 1)
            .map((_, idx, arr) =>
              idx > 0 ? arr[idx].timestamp - arr[idx - 1].timestamp : null,
            )
            .filter((v) => v !== null) as number[];
          const typicalGap = Math.max(
            recentGaps.length ? median(recentGaps) : globalMedianGap,
            1000,
          );

          const trailing60s = current.events.filter(
            (ev) => ev.timestamp > lastEv.timestamp - 60000,
          );
          const recentIntensity =
            trailing60s.reduce((s, ev) => s + ev.quoteQty, 0) / 60;
          current.peakIntensityPerSec = Math.max(
            current.peakIntensityPerSec,
            recentIntensity,
          );
          const intensityRatio =
            current.peakIntensityPerSec > 0
              ? Math.min(1, recentIntensity / current.peakIntensityPerSec)
              : 0;

          const effectiveMultiplier =
            mode === "B" || mode === "D"
              ? BASE_GAP_MULTIPLIER *
                (1 + INTENSITY_MAX_STRETCH * intensityRatio)
              : BASE_GAP_MULTIPLIER;
          const gapSplit = gap > typicalGap * effectiveMultiplier;

          let recoveryAtr: number | null = null;
          let priceForceSplit = false,
            priceOverrideNoSplit = false;
          if (mode === "C" || mode === "D") {
            const priceNow = priceJustBefore(e.timestamp) ?? e.price;
            const recoveryUsd =
              victim === "LONG"
                ? priceNow - current.runningExtreme
                : current.runningExtreme - priceNow;
            recoveryAtr = recoveryUsd / current.atrFrozen;
            priceForceSplit = recoveryAtr >= STRUCTURAL_RECOVERY_ATR_BAR;
            priceOverrideNoSplit = recoveryAtr < SMALL_PAUSE_ATR_BAR;
          }

          let split: boolean;
          let reason: string;
          if (mode === "A") {
            split = gapSplit;
            reason = gapSplit
              ? "gap " +
                fmtDur(gap) +
                " > " +
                fmtDur(typicalGap * effectiveMultiplier) +
                " (4x adaptive cadence)"
              : "gap within adaptive cadence";
          } else if (mode === "B") {
            split = gapSplit;
            reason = gapSplit
              ? "gap " +
                fmtDur(gap) +
                " > " +
                fmtDur(typicalGap * effectiveMultiplier) +
                " (intensity-adjusted, ratio=" +
                intensityRatio.toFixed(2) +
                ")"
              : "gap within intensity-adjusted cadence";
          } else if (mode === "C") {
            split = priceForceSplit || (gapSplit && !priceOverrideNoSplit);
            reason = priceForceSplit
              ? "structural recovery " +
                recoveryAtr!.toFixed(3) +
                " ATR >= " +
                STRUCTURAL_RECOVERY_ATR_BAR
              : priceOverrideNoSplit
                ? "recovery only " +
                  recoveryAtr!.toFixed(3) +
                  " ATR < " +
                  SMALL_PAUSE_ATR_BAR +
                  " -- kept merged despite gap"
                : gapSplit
                  ? "gap-based split (recovery " +
                    recoveryAtr!.toFixed(3) +
                    " ATR, inconclusive zone)"
                  : "gap within cadence, no price override needed";
          } else {
            split = priceForceSplit || (gapSplit && !priceOverrideNoSplit);
            reason = priceForceSplit
              ? "structural recovery " +
                recoveryAtr!.toFixed(3) +
                " ATR >= " +
                STRUCTURAL_RECOVERY_ATR_BAR
              : priceOverrideNoSplit
                ? "recovery only " +
                  recoveryAtr!.toFixed(3) +
                  " ATR < " +
                  SMALL_PAUSE_ATR_BAR +
                  " -- kept merged despite gap"
                : gapSplit
                  ? "intensity-adjusted gap split (recovery " +
                    recoveryAtr!.toFixed(3) +
                    " ATR, inconclusive zone)"
                  : "gap within intensity-adjusted cadence";
          }

          decisions.push({
            split,
            gap,
            typicalGap,
            effectiveMultiplier,
            recoveryAtr,
            intensityRatio:
              mode === "B" || mode === "D" ? intensityRatio : null,
            reason,
          });

          if (split) {
            episodes.push(current.events);
            current = {
              events: [e],
              runningExtreme: e.price,
              runningExtremeTs: e.timestamp,
              atrFrozen: atrAt(e.timestamp) ?? 1,
              peakIntensityPerSec: 0,
            };
          } else {
            current.events.push(e);
            const extremeCandidate = e.price;
            if (
              victim === "LONG"
                ? extremeCandidate < current.runningExtreme
                : extremeCandidate > current.runningExtreme
            ) {
              current.runningExtreme = extremeCandidate;
              current.runningExtremeTs = e.timestamp;
            }
          }
        }
        if (current) episodes.push(current.events);
        results[mode] = { episodes, decisions };
      }

      console.log("  " + victim + " (n=" + sideEvents.length + " events):");
      for (const mode of ["A", "B", "C", "D"] as Mode[]) {
        const eps = results[mode].episodes;
        const durations = eps.map(
          (ep) => ep[ep.length - 1].timestamp - ep[0].timestamp,
        );
        const counts = eps.map((ep) => ep.length);
        console.log(
          "    " +
            mode +
            ": episodes=" +
            eps.length +
            " medianDuration=" +
            fmtDur(median(durations)) +
            " medianEventsPerEpisode=" +
            median(counts).toFixed(1),
        );
      }
      summary[symbol + "_" + victim] = Object.fromEntries(
        (["A", "B", "C", "D"] as Mode[]).map((m) => [
          m,
          {
            episodes: results[m].episodes.length,
            medianDurationMs: median(
              results[m].episodes.map(
                (ep) => ep[ep.length - 1].timestamp - ep[0].timestamp,
              ),
            ),
            medianEventsPerEpisode: median(
              results[m].episodes.map((ep) => ep.length),
            ),
          },
        ]),
      );

      if (!finalEpisodesD[symbol]) finalEpisodesD[symbol] = {};
      finalEpisodesD[symbol][victim] = results.D.episodes.map((ep) => ({
        start: ep[0].timestamp,
        end: ep[ep.length - 1].timestamp,
        eventCount: ep.length,
        totalLiqUsd: ep.reduce((s: number, e: any) => s + e.quoteQty, 0),
        maxEvent: Math.max(...ep.map((e: any) => e.quoteQty)),
      }));

      for (let i = 1; i < sideEvents.length; i++) {
        const dA = results.A.decisions[i],
          dB = results.B.decisions[i],
          dC = results.C.decisions[i],
          dD = results.D.decisions[i];
        if (!dA || !dB || !dC || !dD) continue;
        const splits = [dA.split, dB.split, dC.split, dD.split];
        if (new Set(splits).size > 1) {
          allDisagreements.push({
            symbol,
            victim,
            eventIdx: i,
            eventTs: sideEvents[i].timestamp,
            prevEventTs: sideEvents[i - 1].timestamp,
            gap: dA.gap,
            decisions: { A: dA, B: dB, C: dC, D: dD },
            eventPrice: sideEvents[i].price,
            eventUsd: sideEvents[i].quoteQty,
            prevEventPrice: sideEvents[i - 1].price,
            prevEventUsd: sideEvents[i - 1].quoteQty,
          });
        }
      }
    }
    console.log("");
  }

  console.log("=".repeat(100));
  console.log(
    "DISAGREEMENTS (candidates split the decision differently at the SAME transition) -- up to " +
      MAX_DISAGREEMENTS_TO_PRINT,
  );
  console.log("=".repeat(100));
  const interesting = allDisagreements
    .sort(
      (a, b) =>
        Math.abs(Number(a.decisions.A.split) - Number(a.decisions.D.split)) -
        Math.abs(Number(b.decisions.A.split) - Number(b.decisions.D.split)),
    )
    .reverse()
    .slice(0, MAX_DISAGREEMENTS_TO_PRINT);

  interesting.forEach((d, idx) => {
    console.log(
      "\n--- Disagreement #" +
        (idx + 1) +
        ": " +
        d.symbol +
        " " +
        d.victim +
        " ---",
    );
    console.log(
      "  previous event: " +
        fmtClock(d.prevEventTs) +
        " price=" +
        d.prevEventPrice +
        " size=" +
        fmtUsd(d.prevEventUsd),
    );
    console.log(
      "  next event:     " +
        fmtClock(d.eventTs) +
        " price=" +
        d.eventPrice +
        " size=" +
        fmtUsd(d.eventUsd),
    );
    console.log("  gap: " + fmtDur(d.gap));
    for (const m of ["A", "B", "C", "D"] as Mode[]) {
      const dec = d.decisions[m];
      console.log(
        "  [" +
          m +
          "] " +
          (dec.split ? "SPLIT" : "MERGE") +
          " -- " +
          dec.reason,
      );
    }
  });

  if (allDisagreements.length < MAX_DISAGREEMENTS_TO_PRINT)
    console.log(
      "\n(only " +
        allDisagreements.length +
        " disagreement(s) found across all symbols/sides in this window)",
    );

  console.log("\n" + "=".repeat(100));
  console.log(
    "COHERENCE OBSERVATIONS (from the disagreement set above, not a final verdict)",
  );
  console.log("=".repeat(100));
  const aOverSplitsVsD = allDisagreements.filter(
    (d) => d.decisions.A.split && !d.decisions.D.split,
  ).length;
  const dSplitsVsAMerge = allDisagreements.filter(
    (d) => !d.decisions.A.split && d.decisions.D.split,
  ).length;
  console.log(
    "Cases where A(gap-only) splits but D(full hybrid) keeps merged: " +
      aOverSplitsVsD +
      " -- candidates for 'A incorrectly breaks a still-live cascade on a quiet minute'.",
  );
  console.log(
    "Cases where A(gap-only) merges but D(full hybrid) splits: " +
      dSplitsVsAMerge +
      " -- candidates for 'A incorrectly keeps two genuinely separate cascades together because the raw gap happened to be short'.",
  );
  console.log(
    "Total disagreements found: " +
      allDisagreements.length +
      " across all symbol/sides.",
  );

  const outPath = path.join(
    OUTPUT_DIR,
    "episode-segmentation-hybrid-" + Date.now() + ".json",
  );
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        params: {
          BASE_GAP_MULTIPLIER,
          INTENSITY_MAX_STRETCH,
          SMALL_PAUSE_ATR_BAR,
          STRUCTURAL_RECOVERY_ATR_BAR,
          RECENT_GAP_WINDOW,
        },
        summary,
        disagreements: allDisagreements,
        finalEpisodesD,
      },
      null,
      2,
    ),
  );
  console.log(
    "\nFull data (all 4 candidates' episodes, every disagreement, final D-based episodes): " +
      outPath,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
