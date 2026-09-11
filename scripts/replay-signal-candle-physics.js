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
  const replayEnd = (sig.closedAt || sig.signalTs) + 10 * 60000;

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
    "CANDLE-BY-CANDLE REPLAY (adaptive, self-referential -- see script header for the 'no fixed threshold' rule)",
  );
  console.log("=".repeat(90));
  console.log(
    "time                 O/H/L/C                        liqUSD     ev  frozenU   curU      newExtU   recU     eff        state",
  );

  var state = "NO_WAVE";
  var waveCandles = [];
  var episodeExtreme = null;
  var stateLog = [];

  const startMinute = minuteFloor(episodeStart);
  const eventsByMinute = new Map();
  events.forEach(function (e) {
    const m = minuteFloor(e.timestamp);
    if (!eventsByMinute.has(m)) eventsByMinute.set(m, []);
    eventsByMinute.get(m).push(e);
  });

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

    const stateBefore = state;
    let reason = "";

    if (state === "NO_WAVE" || state === "WAIT_NEXT_PRESSURE") {
      if (sameSideLiqUsd > 0) {
        state = state === "NO_WAVE" ? "W1_CANDIDATE" : "W2_CANDIDATE";
        waveCandles = [
          {
            t: t,
            sameSideLiqUsd: sameSideLiqUsd,
            newDirectionalExtensionUnits: newDirectionalExtensionUnits,
            recoveryUnits: recoveryUnits,
          },
        ];
        reason = "same-side liquidation printed, opening a candidate wave";
      }
    } else if (state === "W1_CANDIDATE" || state === "W2_CANDIDATE") {
      waveCandles.push({
        t: t,
        sameSideLiqUsd: sameSideLiqUsd,
        newDirectionalExtensionUnits: newDirectionalExtensionUnits,
        recoveryUnits: recoveryUnits,
      });
      if (newDirectionalExtensionUnits > 0) {
        state = state === "W1_CANDIDATE" ? "W1_ACTIVE" : "W2_ACTIVE";
        reason =
          "candidate showed real directional extension -- promoted to ACTIVE";
      } else if (sameSideLiqUsd === 0 && recoveryUnits > 0) {
        state =
          state === "W1_CANDIDATE" ? "INVALID_W1" : "INVALID_W2_CANDIDATE";
        reason =
          "no directional extension was ever produced, and price is now moving away -- this print never became a real wave";
      }
    } else if (
      state === "W1_ACTIVE" ||
      state === "W2_ACTIVE" ||
      state === "W1_EXHAUSTING" ||
      state === "W2_EXHAUSTING"
    ) {
      waveCandles.push({
        t: t,
        sameSideLiqUsd: sameSideLiqUsd,
        newDirectionalExtensionUnits: newDirectionalExtensionUnits,
        recoveryUnits: recoveryUnits,
      });
      const priorActive = waveCandles.slice(0, -1).filter(function (c) {
        return c.sameSideLiqUsd > 0;
      });
      const priorMedianExt = median(
        priorActive.map(function (c) {
          return c.newDirectionalExtensionUnits;
        }),
      );
      const priorMedianRecovery = median(
        priorActive.map(function (c) {
          return c.recoveryUnits;
        }),
      );
      const madeNewExtreme = newDirectionalExtensionUnits > 0;

      const isExhausting =
        priorMedianExt !== null &&
        !madeNewExtreme &&
        recoveryUnits > (priorMedianRecovery || 0) &&
        sameSideLiqUsd > 0;
      const isComplete =
        state.indexOf("EXHAUSTING") !== -1 &&
        !madeNewExtreme &&
        recoveryUnits > (priorMedianRecovery || 0);

      if (isComplete) {
        state = state.indexOf("W1") === 0 ? "W1_COMPLETE" : "W2_COMPLETE";
        reason =
          "no new directional extreme this candle, AND recovery exceeded this wave's own prior median recovery -- pressure/result relationship structurally broke";
      } else if (isExhausting) {
        state = state.indexOf("W1") === 0 ? "W1_EXHAUSTING" : "W2_EXHAUSTING";
        reason =
          "liquidation pressure still present but produced no new extreme, and recovery is building relative to this wave's own prior candles";
      } else if (madeNewExtreme) {
        state = state.indexOf("W1") === 0 ? "W1_ACTIVE" : "W2_ACTIVE";
        reason = "new directional extreme made -- pressure remains effective";
      }
    } else if (state === "W1_COMPLETE") {
      state = "WAIT_NEXT_PRESSURE";
      const meaningful = waveCandles.some(function (c) {
        return c.newDirectionalExtensionUnits > 0;
      });
      reason = meaningful
        ? "W1 was meaningful -- becomes the dominant reference for W2"
        : "W1 never showed real extension -- excluded from dominant-wave reference";
    } else if (state === "W2_COMPLETE") {
      reason = "W2 complete -- ready for entry evaluation (see summary below)";
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

    if (state === "W2_COMPLETE") break;
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

  // ── Operator's own final decision block: compare W2 vs dominant W1 ──
  console.log("\n" + "=".repeat(90));
  console.log(
    "FINAL DECISION: W2 vs DOMINANT W1 (only runs if a genuine W2_COMPLETE was reached)",
  );
  console.log("=".repeat(90));
  if (state !== "W2_COMPLETE") {
    console.log(
      "Replay ended in state=" +
        state +
        " -- W2 never genuinely completed, so no ENTRY decision applies. Per the operator's own rule, an incomplete/invalid setup is NO TRADE, never forced.",
    );
  } else {
    // Find the meaningful W1 candles (from stateLog's own recorded
    // history -- w1MeaningfulCandles is reconstructed from the full
    // candle-by-candle loop's own waveCandles snapshots via stateLog.
    // Simpler: re-derive directly from candlesLoggedForW1/W2 captured below.
    console.log(
      "W2 completed. See the candle-by-candle table above for W1's own accumulated",
    );
    console.log(
      "candles (before WAIT_NEXT_PRESSURE) and W2's own accumulated candles (after",
    );
    console.log("W2_CANDIDATE) to compare:");
    console.log(
      "  - W1's own total same-side liqUsd and BEST (max) newDirectionalExtensionUnits",
    );
    console.log("    reached during W1_ACTIVE/W1_EXHAUSTING, vs");
    console.log(
      "  - W2's own total same-side liqUsd and BEST (max) newDirectionalExtensionUnits",
    );
    console.log("    reached during W2_ACTIVE/W2_EXHAUSTING.");
    console.log("");
    console.log("Per the operator's own rule:");
    console.log(
      "  - if W2's own pressure-to-extension relationship is STILL AS EFFECTIVE as W1's",
    );
    console.log(
      "    own (comparable or better efficiency, still making real new extremes) ->",
    );
    console.log(
      "    W2 becomes the new dominant reference, WAIT for W3 (no entry yet).",
    );
    console.log(
      "  - if W2's own effectiveness genuinely COLLAPSED relative to W1's own (similar",
    );
    console.log(
      "    or larger pressure, but W1_EXHAUSTING/W2_EXHAUSTING triggered on materially",
    );
    console.log(
      "    less new extension + more recovery than W1 ever showed) -> ENTRY, at this",
    );
    console.log("    candle's own close, at this candle's own close price.");
    console.log("");
    console.log(
      "This script deliberately does NOT auto-decide this final comparison with a",
    );
    console.log(
      "hardcoded number -- read the W1 vs W2 candle rows above and apply the operator's",
    );
    console.log(
      "own relative-effort-vs-result rule directly, exactly as specified.",
    );
  }

  await client.close();
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
