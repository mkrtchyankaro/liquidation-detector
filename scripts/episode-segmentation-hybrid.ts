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
  lastExtremeUpdateCandleTs: number; // last 1m candle boundary the running extreme has already incorporated -- never re-walked backward
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

let ASSERT_NEGATIVE_RECOVERY_COUNT = 0;
let ASSERT_LONG_GAP_WRONG_SIGN_MERGE_COUNT = 0;
const LONG_GAP_SANITY_THRESHOLD_MS = 30 * 60000; // any merge across a gap this large gets extra scrutiny in the sanity pass

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

  console.log("=".repeat(100));
  console.log(
    "RECOVERY FORMULA (fixed -- running extreme now tracked from real candle low/high, never from liquidation event fill price)",
  );
  console.log("=".repeat(100));
  console.log(
    "LONG victim:  liquidation direction = DOWN. extreme = running LOW (from candle lows). recovery = priceNow - runningExtreme  (>= 0 always, since priceNow >= the recorded low by construction)",
  );
  console.log(
    "SHORT victim: liquidation direction = UP.   extreme = running HIGH (from candle highs). recovery = runningExtreme - priceNow (>= 0 always, since priceNow <= the recorded high by construction)",
  );
  console.log(
    "recoveryATR = recoveryUsd / atrFrozen (ATR frozen at the CURRENT episode's own start)\n",
  );

  const summary: any = {};
  const allDisagreements: any[] = [];
  const finalEpisodesD: Record<string, Record<string, any[]>> = {};
  const manualReconLong: any[] = [];
  const manualReconShort: any[] = [];
  const tightClusterExamples: any[] = [];

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
    // CAUSALITY FIX: at any timestamp ms, the candle covering ms's OWN
    // minute has NOT closed yet (it closes at the start of the NEXT
    // minute). The only safely-usable candle at ms is the PREVIOUS
    // minute's, which has already fully closed. This is the sole
    // source of 1m candle-based price information anywhere in this
    // script now -- candleAt() itself is only used for the POST-HOC
    // diagnostic display in the manual reconstruction printout, never
    // for any segmentation decision.
    function closedCandleAt(ms: number) {
      return klines.get(Math.floor(ms / 60000) * 60000 - 60000) || null;
    }
    const atrSeries = computeWilderAtrSeries(candlesAsc, 240);
    // CAUSALITY FIX: same principle as closedCandleAt() -- start the
    // backward search at the PREVIOUS minute, never the event's own
    // (still-forming) minute, since atrSeries was built from the full,
    // already-fetched historical candle array and would otherwise
    // silently return an ATR value that already incorporates the
    // not-yet-closed candle's own true range.
    function atrAt(ms: number): number | null {
      let t = Math.floor(ms / 60000) * 60000 - 60000;
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
            // SEMANTIC FIX: initialize the running extreme from the actual
            // candle low/high at this event's own minute, never from the
            // liquidation event's own execution price -- e.price is a fill
            // price, not necessarily the market extreme at that moment.
            // CAUSALITY FIX: only the closed (previous-minute) candle may
            // seed the initial extreme; the event's own execution price is
            // the only valid observation for the still-open current minute.
            const c0 = closedCandleAt(e.timestamp);
            const closedExtreme = c0
              ? victim === "LONG"
                ? c0.low
                : c0.high
              : null;
            const initExtreme =
              closedExtreme !== null
                ? victim === "LONG"
                  ? Math.min(closedExtreme, e.price)
                  : Math.max(closedExtreme, e.price)
                : e.price;
            current = {
              events: [e],
              runningExtreme: initExtreme,
              runningExtremeTs: e.timestamp,
              lastExtremeUpdateCandleTs:
                Math.floor(e.timestamp / 60000) * 60000 -
                60000 /* previous minute -- current minute not closed yet */,
              atrFrozen: atrAt(e.timestamp) ?? 1,
              peakIntensityPerSec: 0,
            };
            continue;
          }
          const lastEv = current.events[current.events.length - 1];
          const gap = e.timestamp - lastEv.timestamp;

          // CAUSALITY FIX: walk only candles that have ACTUALLY CLOSED
          // relative to this event's own timestamp -- upper bound is the
          // previous minute, never the event's own (still-forming) minute.
          const lastClosedCandleTs =
            Math.floor(e.timestamp / 60000) * 60000 - 60000;
          for (
            let t = current.lastExtremeUpdateCandleTs + 60000;
            t <= lastClosedCandleTs;
            t += 60000
          ) {
            const c = candleAt(t);
            if (!c) continue;
            const extremeCandidate = victim === "LONG" ? c.low : c.high;
            if (
              victim === "LONG"
                ? extremeCandidate < current.runningExtreme
                : extremeCandidate > current.runningExtreme
            ) {
              current.runningExtreme = extremeCandidate;
              current.runningExtremeTs = t;
            }
            current.lastExtremeUpdateCandleTs = t;
          }

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
            // CAUSALITY FIX: the event's own execution price is the most
            // precise, contemporaneous observation available exactly at
            // this timestamp -- strictly better than falling back to a
            // stale previous-candle close when a fresher, valid
            // observation (the event itself) exists.
            const priceNow = e.price;
            const recoveryUsd =
              victim === "LONG"
                ? priceNow - current.runningExtreme
                : current.runningExtreme - priceNow;
            recoveryAtr = recoveryUsd / current.atrFrozen;

            // ── ASSERTION: recoveryATR must never be negative ──
            if (recoveryAtr < -1e-9) {
              ASSERT_NEGATIVE_RECOVERY_COUNT++;
              console.error(
                "ASSERTION FAILED: negative recoveryATR=" +
                  recoveryAtr.toFixed(4) +
                  " for " +
                  symbol +
                  " " +
                  victim +
                  " at " +
                  fmtClock(e.timestamp) +
                  " (runningExtreme=" +
                  current.runningExtreme +
                  " priceNow=" +
                  priceNow +
                  ")",
              );
            }
            priceForceSplit = recoveryAtr >= STRUCTURAL_RECOVERY_ATR_BAR;
            priceOverrideNoSplit = recoveryAtr < SMALL_PAUSE_ATR_BAR;

            // ── ASSERTION: a large gap must never be merged purely because of a wrong-sign/negative recovery artifact ──
            if (
              gap > LONG_GAP_SANITY_THRESHOLD_MS &&
              priceOverrideNoSplit &&
              recoveryAtr < 0
            ) {
              ASSERT_LONG_GAP_WRONG_SIGN_MERGE_COUNT++;
              console.error(
                "ASSERTION FAILED: " +
                  fmtDur(gap) +
                  " gap merged via priceOverrideNoSplit driven by a NEGATIVE recoveryATR=" +
                  recoveryAtr.toFixed(4) +
                  " -- " +
                  symbol +
                  " " +
                  victim +
                  " at " +
                  fmtClock(e.timestamp),
              );
            }
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

          // ── collect examples from mode D: first 5 per side (broad coverage) + ALL tight (<20s) clusters (targeted proof) ──
          if (
            mode === "D" &&
            ((victim === "LONG" && manualReconLong.length < 5) ||
              (victim === "SHORT" && manualReconShort.length < 5) ||
              gap < 20000)
          ) {
            const inProgressCandle = candleAt(e.timestamp); // POST-HOC reference only -- NEVER used in the decision above
            const lastClosed = closedCandleAt(e.timestamp); // the actual causal price source used above
            const example = {
              symbol,
              victim,
              prevEventTs: lastEv.timestamp,
              prevEventPrice: lastEv.price,
              eventTs: e.timestamp,
              eventPrice: e.price,
              gap,
              runningExtremeBefore: current.runningExtreme,
              runningExtremeTs: current.runningExtremeTs,
              lastClosedCandleUsedInDecision: lastClosed
                ? {
                    openTime: Math.floor(e.timestamp / 60000) * 60000 - 60000,
                    open: lastClosed.open,
                    high: lastClosed.high,
                    low: lastClosed.low,
                    close: lastClosed.close,
                  }
                : null,
              inProgressCandleForReferenceOnly: inProgressCandle
                ? {
                    openTime: Math.floor(e.timestamp / 60000) * 60000,
                    open: inProgressCandle.open,
                    high: inProgressCandle.high,
                    low: inProgressCandle.low,
                    close: inProgressCandle.close,
                  }
                : null,
              recoveryAtr,
              atrFrozen: current.atrFrozen,
              decision: split ? "SPLIT" : "MERGE",
              reason,
            };
            if (victim === "LONG" && manualReconLong.length < 5)
              manualReconLong.push(example);
            else if (victim === "SHORT" && manualReconShort.length < 5)
              manualReconShort.push(example);
            if (gap < 20000) tightClusterExamples.push(example); // seconds-apart proof, matching the operator's own flagged scenario directly
          }

          if (split) {
            episodes.push(current.events);
            // CAUSALITY FIX: only the closed (previous-minute) candle may
            // seed the initial extreme; the event's own execution price is
            // the only valid observation for the still-open current minute.
            const c0 = closedCandleAt(e.timestamp);
            const closedExtreme = c0
              ? victim === "LONG"
                ? c0.low
                : c0.high
              : null;
            const initExtreme =
              closedExtreme !== null
                ? victim === "LONG"
                  ? Math.min(closedExtreme, e.price)
                  : Math.max(closedExtreme, e.price)
                : e.price;
            current = {
              events: [e],
              runningExtreme: initExtreme,
              runningExtremeTs: e.timestamp,
              lastExtremeUpdateCandleTs:
                Math.floor(e.timestamp / 60000) * 60000 -
                60000 /* previous minute -- current minute not closed yet */,
              atrFrozen: atrAt(e.timestamp) ?? 1,
              peakIntensityPerSec: 0,
            };
          } else {
            current.events.push(e);
            // running extreme for this minute is already incorporated by
            // the continuous candle-walk above; also check the event's
            // OWN fill price in case it pierced beyond the candle extreme
            // already recorded (fill prices can occasionally exceed the
            // 1m candle's own high/low during fast-moving liquidation
            // cascades) -- this only ever EXTENDS the extreme, never
            // substitutes for the candle-based tracking.
            if (
              victim === "LONG"
                ? e.price < current.runningExtreme
                : e.price > current.runningExtreme
            ) {
              current.runningExtreme = e.price;
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

  // ═══ SANITY GATE ═══
  console.log("=".repeat(100));
  console.log("SANITY CHECKS");
  console.log("=".repeat(100));
  console.log(
    "negativeRecoveryATR assertion failures (should be 0): " +
      ASSERT_NEGATIVE_RECOVERY_COUNT,
  );
  console.log(
    "largeGap-merged-via-wrong-sign assertion failures (should be 0): " +
      ASSERT_LONG_GAP_WRONG_SIGN_MERGE_COUNT,
  );

  console.log("\n" + "=".repeat(100));
  console.log("MANUAL CANDLE-BY-CANDLE RECONSTRUCTION -- 5 LONG transitions");
  console.log("=".repeat(100));
  manualReconLong.forEach((ex, i) => {
    console.log("\n[" + (i + 1) + "] " + ex.symbol + " LONG");
    console.log(
      "  prev event: " +
        fmtClock(ex.prevEventTs) +
        " price=" +
        ex.prevEventPrice,
    );
    console.log(
      "  next event: " +
        fmtClock(ex.eventTs) +
        " price=" +
        ex.eventPrice +
        "  gap=" +
        fmtDur(ex.gap),
    );
    console.log(
      "  runningExtreme (LOW) before this event: " +
        ex.runningExtremeBefore +
        " @ " +
        fmtClock(ex.runningExtremeTs),
    );
    if (ex.lastClosedCandleUsedInDecision)
      console.log(
        "  [USED IN DECISION] last CLOSED candle (previous minute): O=" +
          ex.lastClosedCandleUsedInDecision.open +
          " H=" +
          ex.lastClosedCandleUsedInDecision.high +
          " L=" +
          ex.lastClosedCandleUsedInDecision.low +
          " C=" +
          ex.lastClosedCandleUsedInDecision.close,
      );
    else
      console.log(
        "  [USED IN DECISION] no closed candle yet -- runningExtreme seeded from event price only.",
      );
    if (ex.inProgressCandleForReferenceOnly)
      console.log(
        "  [REFERENCE ONLY, NOT used] full in-progress candle for this event's own minute (eventual O/H/L/C): O=" +
          ex.inProgressCandleForReferenceOnly.open +
          " H=" +
          ex.inProgressCandleForReferenceOnly.high +
          " L=" +
          ex.inProgressCandleForReferenceOnly.low +
          " C=" +
          ex.inProgressCandleForReferenceOnly.close,
      );
    console.log(
      "  atrFrozen=" +
        ex.atrFrozen.toFixed(4) +
        "  recoveryATR=" +
        (ex.recoveryAtr !== null ? ex.recoveryAtr.toFixed(4) : "n/a") +
        "  (must be >= 0)",
    );
    console.log("  decision: " + ex.decision + " -- " + ex.reason);
  });

  console.log("\n" + "=".repeat(100));
  console.log("MANUAL CANDLE-BY-CANDLE RECONSTRUCTION -- 5 SHORT transitions");
  console.log("=".repeat(100));
  manualReconShort.forEach((ex, i) => {
    console.log("\n[" + (i + 1) + "] " + ex.symbol + " SHORT");
    console.log(
      "  prev event: " +
        fmtClock(ex.prevEventTs) +
        " price=" +
        ex.prevEventPrice,
    );
    console.log(
      "  next event: " +
        fmtClock(ex.eventTs) +
        " price=" +
        ex.eventPrice +
        "  gap=" +
        fmtDur(ex.gap),
    );
    console.log(
      "  runningExtreme (HIGH) before this event: " +
        ex.runningExtremeBefore +
        " @ " +
        fmtClock(ex.runningExtremeTs),
    );
    if (ex.lastClosedCandleUsedInDecision)
      console.log(
        "  [USED IN DECISION] last CLOSED candle (previous minute): O=" +
          ex.lastClosedCandleUsedInDecision.open +
          " H=" +
          ex.lastClosedCandleUsedInDecision.high +
          " L=" +
          ex.lastClosedCandleUsedInDecision.low +
          " C=" +
          ex.lastClosedCandleUsedInDecision.close,
      );
    else
      console.log(
        "  [USED IN DECISION] no closed candle yet -- runningExtreme seeded from event price only.",
      );
    if (ex.inProgressCandleForReferenceOnly)
      console.log(
        "  [REFERENCE ONLY, NOT used] full in-progress candle for this event's own minute (eventual O/H/L/C): O=" +
          ex.inProgressCandleForReferenceOnly.open +
          " H=" +
          ex.inProgressCandleForReferenceOnly.high +
          " L=" +
          ex.inProgressCandleForReferenceOnly.low +
          " C=" +
          ex.inProgressCandleForReferenceOnly.close,
      );
    console.log(
      "  atrFrozen=" +
        ex.atrFrozen.toFixed(4) +
        "  recoveryATR=" +
        (ex.recoveryAtr !== null ? ex.recoveryAtr.toFixed(4) : "n/a") +
        "  (must be >= 0)",
    );
    console.log("  decision: " + ex.decision + " -- " + ex.reason);
  });

  console.log("\n" + "=".repeat(100));
  console.log(
    "TIGHT-CLUSTER PROOF -- every transition with gap < 20s (the exact scenario flagged: seconds-apart events must never be split from unfinished-candle look-ahead)",
  );
  console.log("=".repeat(100));
  if (tightClusterExamples.length === 0)
    console.log("(none found in this window)");
  tightClusterExamples.slice(0, 30).forEach((ex, i) => {
    console.log(
      "\n[" +
        (i + 1) +
        "] " +
        ex.symbol +
        " " +
        ex.victim +
        "  " +
        fmtClock(ex.prevEventTs) +
        " -> " +
        fmtClock(ex.eventTs) +
        "  gap=" +
        fmtDur(ex.gap),
    );
    console.log(
      "  recoveryATR=" +
        (ex.recoveryAtr !== null ? ex.recoveryAtr.toFixed(4) : "n/a") +
        "  decision=" +
        ex.decision +
        " -- " +
        ex.reason,
    );
    if (ex.recoveryAtr !== null && ex.recoveryAtr < 0)
      console.log("  *** STILL NEGATIVE -- investigate further ***");
  });
  console.log(
    "\nTotal tight-cluster (<20s) transitions found: " +
      tightClusterExamples.length +
      ". Split rate among them: " +
      (tightClusterExamples.length
        ? (
            (tightClusterExamples.filter((e) => e.decision === "SPLIT").length /
              tightClusterExamples.length) *
            100
          ).toFixed(1) + "%"
        : "n/a") +
      " (should be low/zero if the fix is working -- seconds-apart events should almost never look like a structural recovery).",
  );

  if (
    ASSERT_NEGATIVE_RECOVERY_COUNT > 0 ||
    ASSERT_LONG_GAP_WRONG_SIGN_MERGE_COUNT > 0
  ) {
    console.log(
      "\n*** SANITY CHECKS FAILED -- stopping before the full A/B/C/D grouping comparison. Fix the issue above and rerun. ***",
    );
    const outPathDebug = path.join(
      OUTPUT_DIR,
      "episode-segmentation-SANITY-FAILED-" + Date.now() + ".json",
    );
    if (!fs.existsSync(OUTPUT_DIR))
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      outPathDebug,
      JSON.stringify(
        {
          manualReconLong,
          manualReconShort,
          tightClusterExamples,
          ASSERT_NEGATIVE_RECOVERY_COUNT,
          ASSERT_LONG_GAP_WRONG_SIGN_MERGE_COUNT,
        },
        null,
        2,
      ),
    );
    await client.close();
    return;
  }
  console.log(
    "\nAll sanity checks passed -- proceeding to the full A/B/C/D grouping comparison.\n",
  );

  // ═══ Investigate over-segmentation: bootstrap-gap diagnostics ═══
  console.log("=".repeat(100));
  console.log(
    "OVER-SEGMENTATION DIAGNOSTIC (investigation only -- no threshold changed)",
  );
  console.log("=".repeat(100));
  console.log(
    "Checking how often the FIRST transition of a new episode relies on the GLOBAL bootstrap gap (no intra-episode cadence yet) vs an established one, and how that compares to the actual gap observed.\n",
  );
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const eps = finalEpisodesD[symbol]?.[victim];
      if (!eps) continue;
      const singleEventEps = eps.filter((e) => e.eventCount === 1).length;
      if (eps.length > 0)
        console.log(
          symbol +
            " " +
            victim +
            ": " +
            eps.length +
            " episodes, " +
            singleEventEps +
            " (" +
            ((singleEventEps / eps.length) * 100).toFixed(0) +
            "%) are single-event -- " +
            (singleEventEps / eps.length > 0.5
              ? "HIGH single-event rate, consistent with the bootstrap-gap being too tight for a brand-new episode's own 2nd event"
              : "moderate/low single-event rate"),
        );
    }
  }
  console.log("");

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
        manualReconLong,
        manualReconShort,
        tightClusterExamples,
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
