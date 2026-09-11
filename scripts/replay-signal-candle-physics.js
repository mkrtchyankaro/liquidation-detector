require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function minuteFloor(ms) {
  return Math.floor(ms / 60000) * 60000;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Bad JSON from " + url));
          }
        });
      })
      .on("error", reject);
  });
}
async function fetchKlinesRange(symbol, startTime, endTime) {
  const base = process.env.BINANCE_REST_BASE_URL || "https://fapi.binance.com";
  const byOpenTime = new Map();
  let cursor = startTime;
  const CHUNK = 1500;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + (CHUNK - 1) * 60000, endTime);
    const url =
      base +
      "/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=" +
      CHUNK;
    const raw = await httpsGetJson(url);
    if (!Array.isArray(raw)) throw new Error("Unexpected klines response");
    for (const k of raw)
      byOpenTime.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    if (raw.length === 0) cursor = chunkEnd + 60000;
    else cursor = raw[raw.length - 1][0] + 60000;
    if (cursor <= startTime) break;
  }
  return byOpenTime;
}
function wilderAtr(candlesAsc, period) {
  if (candlesAsc.length < period + 1) return null;
  const trs = [];
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
  let v = 0;
  for (let j = 0; j < period; j++) v += trs[j];
  v /= period;
  for (let k = period; k < trs.length; k++)
    v = (v * (period - 1) + trs[k]) / period;
  return v;
}
function median(arr) {
  const a = arr.filter((x) => x !== null && !isNaN(x));
  if (a.length === 0) return null;
  const s = a.slice().sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--signalId");
  const signalId =
    idx !== -1 ? args[idx + 1] : "2e377402-141e-475b-aaf4-ecff73b7347d";
  const noExtremeTest = args.includes("--no-extreme-test");

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const signalCol = db.collection("v5_global_signals");
  const rawCol = db.collection("liq_raw_events");

  const sig = await signalCol.findOne({ signalId: signalId });
  if (!sig) {
    console.error("Signal not found: " + signalId);
    await client.close();
    return;
  }

  console.log("=".repeat(90));
  console.log(
    "PRODUCTION'S OWN RECORD (for comparison only -- not used to drive this replay)",
  );
  console.log("=".repeat(90));
  console.log(
    "symbol=" + sig.symbol + " victim=" + sig.victim + " side=" + sig.side,
  );
  console.log(
    "signalTs=" +
      fmtTs(sig.signalTs) +
      " entry=" +
      sig.entry +
      " status=" +
      sig.status +
      " closePrice=" +
      sig.closePrice +
      " closedAt=" +
      (sig.closedAt ? fmtTs(sig.closedAt) : "n/a"),
  );
  console.log("production waveHistory:");
  (sig.waveHistory || []).forEach(function (w) {
    console.log(
      "  W" +
        w.waveNumber +
        ": anchor=" +
        w.anchorPrice +
        "@" +
        fmtTs(w.anchorTs) +
        " extreme=" +
        w.extremePrice +
        "@" +
        fmtTs(w.extremeTs) +
        " liqUsd=" +
        w.liqNotionalUsd +
        " events=" +
        w.liqEvents,
    );
  });

  const symbol = sig.symbol;
  const victim = sig.victim;
  const forcedDown = victim === "LONG";
  const episodeStart = sig.waveHistory[0].anchorTs;
  const replayEnd = (sig.closedAt || sig.signalTs) + 30 * 60000; // extended buffer -- WAIT_EXTREME_TEST may push entry later than the original replay's own entry point

  const events = await rawCol
    .find({
      symbol: symbol,
      victim: victim,
      timestamp: { $gte: episodeStart, $lt: replayEnd },
    })
    .sort({ timestamp: 1 })
    .toArray();
  console.log("\nRaw same-victim events in window: " + events.length);
  if (events.length === 0) {
    console.log(
      "No raw events available for this window (liq_raw_events may not have existed yet at this signal's own timestamp) -- cannot replay. Try a more recent signal.",
    );
    await client.close();
    return;
  }

  const klineFetchStart = episodeStart - 250 * 60000;
  const klines = await fetchKlinesRange(symbol, klineFetchStart, replayEnd);
  console.log("Fetched " + klines.size + " candles.");
  const candlesAscAll = Array.from(klines.values()).sort(function (a, b) {
    return a.t - b.t;
  });

  const candlesBeforeEpisode = candlesAscAll.filter(function (c) {
    return c.t < minuteFloor(episodeStart);
  });
  const frozenUnit = wilderAtr(candlesBeforeEpisode, 240);
  console.log(
    "frozenUnit (Wilder ATR-240 as of episode start) = " + frozenUnit,
  );
  if (!frozenUnit) {
    console.log("UNIT unavailable -- cannot replay.");
    await client.close();
    return;
  }

  console.log("\n" + "=".repeat(90));
  console.log(
    "CANDLE-BY-CANDLE REPLAY (adaptive, self-referential -- NO fixed thresholds, NO permanent invalid states)",
  );
  console.log("=".repeat(90));
  console.log(
    "time                 O/H/L/C                        liqUSD     ev  frozenU   curU      newExtU   recU     eff        state",
  );

  var state = "NO_WAVE"; // NO_WAVE | CANDIDATE | ACTIVE | EXHAUSTING | WAIT_EXTREME_TEST | REVERSAL_CONFIRMED
  var waveNumber = 0;
  var currentWaveCandles = [];
  var episodeExtreme = null;
  var dominantWave = null; // { waveNumber, totalLiqUsd, totalExtensionUnits, efficiency }
  var exhaustedWave = null; // { waveNumber, summary, finalExtreme, dominant } -- set when entering WAIT_EXTREME_TEST
  var testCandles = []; // re-attack test candles, accumulated during WAIT_EXTREME_TEST
  var completedWaveLog = [];
  var stateLog = [];
  var entryEvent = null;

  const startMinute = minuteFloor(episodeStart);
  const eventsByMinute = new Map();
  events.forEach(function (e) {
    const m = minuteFloor(e.timestamp);
    if (!eventsByMinute.has(m)) eventsByMinute.set(m, []);
    eventsByMinute.get(m).push(e);
  });

  function waveSummary(candles) {
    const totalLiqUsd = candles.reduce(function (s, c) {
      return s + c.sameSideLiqUsd;
    }, 0);
    const totalExtensionUnits = candles.reduce(function (s, c) {
      return s + Math.max(0, c.newDirectionalExtensionUnits);
    }, 0);
    const liqMillions = totalLiqUsd / 1000000;
    const efficiency =
      liqMillions > 0 ? totalExtensionUnits / liqMillions : null; // null = NOT_COMPUTABLE, zero-liq wave
    return {
      totalLiqUsd: totalLiqUsd,
      totalExtensionUnits: totalExtensionUnits,
      efficiency: efficiency,
    };
  }

  for (let t = startMinute; t <= replayEnd; t += 60000) {
    const kl = klines.get(t);
    if (!kl) continue;
    const evs = eventsByMinute.get(t) || [];
    const sameSideLiqUsd = evs.reduce(function (s, e) {
      return s + e.quoteQty;
    }, 0);

    const candlesBeforeThis = candlesAscAll.filter(function (c) {
      return c.t < t;
    });
    const currentUnitAtCandle = wilderAtr(candlesBeforeThis, 240);

    if (episodeExtreme === null) episodeExtreme = kl.open;

    const candleLow = kl.low,
      candleHigh = kl.high;
    const priorExtreme = episodeExtreme;
    const newDirectionalExtension = forcedDown
      ? Math.max(0, priorExtreme - candleLow)
      : Math.max(0, candleHigh - priorExtreme);
    const newDirectionalExtensionUnits = newDirectionalExtension / frozenUnit;
    if (forcedDown) episodeExtreme = Math.min(episodeExtreme, candleLow);
    else episodeExtreme = Math.max(episodeExtreme, candleHigh);

    const recoveryFromExtreme = forcedDown
      ? kl.close - episodeExtreme
      : episodeExtreme - kl.close;
    const recoveryUnits = recoveryFromExtreme / frozenUnit;

    const liqMillions = sameSideLiqUsd / 1000000;
    const candleEfficiency =
      sameSideLiqUsd > 0
        ? liqMillions > 0
          ? newDirectionalExtensionUnits / liqMillions
          : "NOT_COMPUTABLE"
        : "NOT_COMPUTABLE";
    const madeNewExtreme = newDirectionalExtensionUnits > 0;

    const stateBefore = state;
    let reason = "";
    const thisCandleMetrics = {
      t: t,
      sameSideLiqUsd: sameSideLiqUsd,
      newDirectionalExtensionUnits: newDirectionalExtensionUnits,
      recoveryUnits: recoveryUnits,
    };

    if (state === "NO_WAVE" || state === "WAIT_NEXT_PRESSURE") {
      if (sameSideLiqUsd > 0) {
        // Section 1: open a candidate, THEN immediately judge THIS SAME
        // closed candle (the candidate-candle IS already closed by the
        // time we process it in this loop) per section 2's A/B/C rules.
        waveNumber++;
        currentWaveCandles = [thisCandleMetrics];
        if (madeNewExtreme) {
          // Case A (real displacement) and Case C (displacement +
          // rejection in the same candle) are BOTH promoted to ACTIVE --
          // per section 2C, a same-candle rejection is deliberately NOT
          // auto-classified as exhausting without a prior candle to
          // compare against; the VERY NEXT candle's own self-referential
          // comparison below will naturally detect exhaustion if the
          // rejection continues.
          state = "ACTIVE";
          reason =
            "W" +
            waveNumber +
            "_CANDIDATE: first closed candle showed real directional extension -- promoted to ACTIVE";
        } else {
          // Case B: no displacement at all -- per section 2B and 11,
          // this is NOT a permanent invalid state. Return to NO_WAVE /
          // WAIT_NEXT_PRESSURE immediately so the NEXT liquidation can
          // freely open a fresh candidate.
          const target =
            dominantWave === null ? "NO_WAVE" : "WAIT_NEXT_PRESSURE";
          reason =
            "W" +
            waveNumber +
            "_CANDIDATE: liquidation printed but produced ZERO directional extension -- not a real wave, returning to " +
            target +
            " (next liquidation may open a fresh candidate)";
          waveNumber--; // this candidate never became a real, numbered wave
          currentWaveCandles = [];
          state = target;
        }
      }
    } else if (state === "ACTIVE" || state === "EXHAUSTING") {
      currentWaveCandles.push(thisCandleMetrics);
      const priorCandles = currentWaveCandles.slice(0, -1);
      const priorMedianRecovery =
        median(
          priorCandles.map(function (c) {
            return c.recoveryUnits;
          }),
        ) || 0;

      if (madeNewExtreme) {
        // Section 5: "if the next candle resumes strong same-side
        // liquidation and makes a new extreme again, the wave was NOT
        // really complete" -- ALWAYS reverts an EXHAUSTING wave back to
        // ACTIVE the moment a new extreme is made again, regardless of
        // how large the candle is (UNIT is a ruler here, never a cap).
        state = "ACTIVE";
        reason =
          "W" +
          waveNumber +
          ": new directional extreme made (" +
          newDirectionalExtensionUnits.toFixed(3) +
          "U) -- pressure remains effective, wave continues";
      } else if (state === "ACTIVE" && recoveryUnits > priorMedianRecovery) {
        state = "EXHAUSTING";
        reason =
          "W" +
          waveNumber +
          ": no new extreme this candle, and recovery (" +
          recoveryUnits.toFixed(3) +
          "U) exceeds this wave's own prior median recovery -- first sign of stalling";
      } else if (state === "EXHAUSTING") {
        // Section 5: a SECOND consecutive closed candle confirming no
        // new price discovery is the required closed-candle confirmation.
        const summary = waveSummary(currentWaveCandles);
        completedWaveLog.push({
          waveNumber: waveNumber,
          summary: summary,
          completedAt: t,
        });
        if (dominantWave === null) {
          dominantWave = { waveNumber: waveNumber, summary: summary };
          state = "WAIT_NEXT_PRESSURE";
          reason =
            "W" +
            waveNumber +
            "_COMPLETE: confirmed stall (2nd consecutive non-extending candle) -- this is the FIRST meaningful wave, becomes the dominant reference";
        } else {
          const domEff = dominantWave.summary.efficiency;
          const curEff = summary.efficiency;
          const domLabel =
            "W" +
            dominantWave.waveNumber +
            " (eff=" +
            (domEff === null ? "NOT_COMPUTABLE" : domEff.toFixed(2)) +
            ")";
          const curLabel =
            "W" +
            waveNumber +
            " (eff=" +
            (curEff === null ? "NOT_COMPUTABLE" : curEff.toFixed(2)) +
            ")";
          if (domEff === null || curEff === null) {
            state = "WAIT_NEXT_PRESSURE";
            dominantWave = { waveNumber: waveNumber, summary: summary };
            reason =
              "W" +
              waveNumber +
              "_COMPLETE vs dominant " +
              domLabel +
              ": efficiencyRatio NOT_COMPUTABLE (a zero-liquidity reference) -- " +
              curLabel +
              " becomes the new dominant reference, waiting for the next wave";
          } else if (curEff >= domEff) {
            state = "WAIT_NEXT_PRESSURE";
            dominantWave = { waveNumber: waveNumber, summary: summary };
            reason =
              curLabel +
              " vs dominant " +
              domLabel +
              ": efficiency held or improved (continuation) -- W" +
              waveNumber +
              " becomes the new dominant reference, waiting for the next wave";
          } else {
            // Sep 11 2026 (Karo), operator-requested -- optional
            // bypass, via --no-extreme-test, reproducing the EARLIER
            // (pre-confirmation-layer) replay behavior EXACTLY: enter
            // immediately on exhaustion, no re-attack test. Nothing
            // else in the wave/candidate logic changes.
            if (noExtremeTest) {
              state = "ENTERED";
              entryEvent = {
                time: t,
                price: kl.close,
                waveNumber: waveNumber,
                dominant: dominantWave,
                signal: { waveNumber: waveNumber, summary: summary },
              };
              reason =
                curLabel +
                " vs dominant " +
                domLabel +
                ": efficiency COLLAPSED -- (--no-extreme-test) ENTRY at this candle's own close (" +
                kl.close +
                ")";
            } else {
              // Sep 11 2026 (Karo), operator-requested confirmation layer
              // -- do NOT enter yet. The exhausted wave's own final
              // structural extreme (episodeExtreme, at THIS exact moment)
              // must first survive a renewed re-attack before this counts
              // as a real reversal.
              state = "WAIT_EXTREME_TEST";
              exhaustedWave = {
                waveNumber: waveNumber,
                summary: summary,
                finalExtreme: episodeExtreme,
                dominant: dominantWave,
              };
              testCandles = [];
              reason =
                curLabel +
                " vs dominant " +
                domLabel +
                ": efficiency COLLAPSED -- EXHAUSTION_CANDIDATE, remembering finalExtreme=" +
                episodeExtreme +
                ", now WAIT_EXTREME_TEST (no entry yet -- the extreme must survive a re-attack)";
            }
          }
        }
      }
    } else if (state === "WAIT_EXTREME_TEST") {
      if (sameSideLiqUsd > 0) {
        if (madeNewExtreme) {
          // Section "Case A": renewed pressure efficiently broke through
          // -- the exhaustion was NOT real. This re-attack itself
          // becomes a genuine new wave (reusing the SAME candidate->
          // ACTIVE promotion as a fresh wave), continuing forward. The
          // OLD dominant reference is left unchanged -- this new wave
          // will be judged against it normally when it later completes.
          waveNumber++;
          currentWaveCandles = [thisCandleMetrics];
          state = "ACTIVE";
          reason =
            "WAIT_EXTREME_TEST: renewed pressure broke through finalExtreme=" +
            exhaustedWave.finalExtreme +
            " with real new extension (" +
            newDirectionalExtensionUnits.toFixed(3) +
            "U) -- exhaustion FAILED, this becomes new W" +
            waveNumber +
            "_ACTIVE (continuation)";
        } else {
          testCandles.push(thisCandleMetrics);
          const priorTestCandles = testCandles.slice(0, -1);
          const priorTestMedianRecovery =
            median(
              priorTestCandles.map(function (c) {
                return c.recoveryUnits;
              }),
            ) || 0;
          if (
            testCandles.length >= 2 &&
            recoveryUnits > priorTestMedianRecovery
          ) {
            const testSummary = waveSummary(testCandles);
            state = "REVERSAL_CONFIRMED";
            entryEvent = {
              time: t,
              price: kl.close,
              waveNumber: exhaustedWave.waveNumber,
              exhaustedWave: exhaustedWave,
              dominant: exhaustedWave.dominant,
              test: testSummary,
            };
            reason =
              "WAIT_EXTREME_TEST: renewed pressure (testLiqUsd=" +
              testSummary.totalLiqUsd.toFixed(0) +
              ") tested finalExtreme=" +
              exhaustedWave.finalExtreme +
              " but produced only " +
              testSummary.totalExtensionUnits.toFixed(3) +
              "U of new territory, then recovery confirmed -- REVERSAL_CONFIRMED, ENTRY at this candle's own close (" +
              kl.close +
              ")";
          } else {
            reason =
              "WAIT_EXTREME_TEST: renewed pressure testing finalExtreme=" +
              exhaustedWave.finalExtreme +
              ", no new extension yet this candle (testCandles=" +
              testCandles.length +
              ") -- still observing";
          }
        }
      } else if (testCandles.length > 0) {
        reason =
          "WAIT_EXTREME_TEST: no liquidation this candle -- an in-progress re-attack test simply pauses, does not reset (a small sweep/pause is allowed)";
      }
      // No liquidation at all and no test in progress: stay silently
      // in WAIT_EXTREME_TEST -- per the operator's own explicit
      // instruction, "no more liquidation" must NEVER auto-trigger entry.
    }

    const curU =
      currentUnitAtCandle !== null ? currentUnitAtCandle.toFixed(6) : "n/a";
    const effStr =
      typeof candleEfficiency === "number"
        ? candleEfficiency.toFixed(2)
        : candleEfficiency;
    console.log(
      fmtTs(t).padEnd(20) +
        " " +
        (kl.open + "/" + kl.high + "/" + kl.low + "/" + kl.close).padEnd(30) +
        " " +
        sameSideLiqUsd.toFixed(0).padEnd(10) +
        " " +
        String(evs.length).padEnd(3) +
        " " +
        frozenUnit.toFixed(6).padEnd(9) +
        " " +
        curU.padEnd(9) +
        " " +
        newDirectionalExtensionUnits.toFixed(3).padEnd(9) +
        " " +
        recoveryUnits.toFixed(3).padEnd(8) +
        " " +
        effStr.toString().padEnd(10) +
        " " +
        stateBefore +
        "->" +
        state,
    );
    if (reason)
      stateLog.push({
        t: t,
        stateBefore: stateBefore,
        stateAfter: state,
        reason: reason,
      });

    if (state === "REVERSAL_CONFIRMED" || state === "ENTERED") break;
  }

  console.log("\n" + "=".repeat(90));
  console.log("STATE TRANSITIONS");
  console.log("=".repeat(90));
  stateLog.forEach(function (s) {
    console.log(
      fmtTs(s.t) +
        "  " +
        s.stateBefore +
        " -> " +
        s.stateAfter +
        "  (" +
        s.reason +
        ")",
    );
  });

  console.log("\n" + "=".repeat(90));
  console.log("COMPLETED WAVES");
  console.log("=".repeat(90));
  completedWaveLog.forEach(function (w) {
    console.log(
      "W" +
        w.waveNumber +
        " completed at " +
        fmtTs(w.completedAt) +
        ": totalLiqUsd=" +
        w.summary.totalLiqUsd.toFixed(0) +
        " totalExtensionUnits=" +
        w.summary.totalExtensionUnits.toFixed(3) +
        " efficiency=" +
        (w.summary.efficiency === null
          ? "NOT_COMPUTABLE"
          : w.summary.efficiency.toFixed(2)),
    );
  });

  console.log("\n" + "=".repeat(90));
  console.log(
    "FINAL DECISION" +
      (noExtremeTest
        ? " (--no-extreme-test: immediate entry on exhaustion, no re-attack confirmation)"
        : ""),
  );
  console.log("=".repeat(90));
  if (entryEvent && entryEvent.test) {
    console.log(
      "REVERSAL_CONFIRMED -> ENTRY at " +
        fmtTs(entryEvent.time) +
        ", price=" +
        entryEvent.price,
    );
    console.log(
      "Exhausted wave: W" +
        entryEvent.exhaustedWave.waveNumber +
        " " +
        JSON.stringify(entryEvent.exhaustedWave.summary) +
        " finalExtreme=" +
        entryEvent.exhaustedWave.finalExtreme,
    );
    console.log(
      "Dominant reference at the time of exhaustion: W" +
        entryEvent.dominant.waveNumber +
        " " +
        JSON.stringify(entryEvent.dominant.summary),
    );
    console.log("Re-attack test result: " + JSON.stringify(entryEvent.test));
  } else if (entryEvent) {
    console.log(
      "EXHAUSTION -> ENTRY at " +
        fmtTs(entryEvent.time) +
        ", price=" +
        entryEvent.price +
        " (no-extreme-test mode)",
    );
    console.log(
      "Signal wave: W" +
        entryEvent.signal.waveNumber +
        " " +
        JSON.stringify(entryEvent.signal.summary),
    );
    console.log(
      "Dominant reference: W" +
        entryEvent.dominant.waveNumber +
        " " +
        JSON.stringify(entryEvent.dominant.summary),
    );
  } else if (state === "WAIT_EXTREME_TEST") {
    console.log(
      "NO TRADE (yet) -- replay ended still in WAIT_EXTREME_TEST for W" +
        exhaustedWave.waveNumber +
        " (finalExtreme=" +
        exhaustedWave.finalExtreme +
        "). Per the operator's own explicit rule, this stays an UNRESOLVED exhaustion candidate -- no entry is forced just because liquidation stopped.",
    );
  } else {
    console.log(
      "NO TRADE -- replay ended in state=" +
        state +
        " without ever reaching a genuine exhaustion candidate.",
    );
  }

  await client.close();
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
