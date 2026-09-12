require("dotenv/config");
const { MongoClient } = require("mongodb");

function fmtTs(ms) {
  return ms
    ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z"
    : "n/a";
}
function fmt(v, digits) {
  return v === null || v === undefined
    ? "NOT_AVAILABLE"
    : typeof v === "number"
      ? v.toFixed(digits === undefined ? 6 : digits)
      : String(v);
}
function fmtUsd(v) {
  return v === null || v === undefined
    ? "NOT_AVAILABLE"
    : "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtPct(v, digits) {
  return v === null || v === undefined
    ? "NOT_AVAILABLE"
    : (v * 100).toFixed(digits === undefined ? 2 : digits) + "%";
}
function na(v) {
  return v === null || v === undefined ? "NOT_AVAILABLE" : v;
}

console.log("=".repeat(90));
console.log(
  "KNOWN GAPS -- metrics requested but NOT currently persisted for candle-physics signals",
);
console.log("=".repeat(90));
console.log(`
- maxIndividualEventUsd (the specific event that PASSED/FAILED the P95 seriousness
  gate at entry time) is NOT persisted on the signal document. It exists ONLY
  transiently inside handleCandlePhysicsEntry() (market-data-orchestrator.ts) at the
  moment of the P95-gate check, and is logged via [NO_P95_EVENT] only when a
  candidate is REJECTED -- for a SUCCESSFUL entry it is used once, then discarded.
  Below, this script derives an EPISODE-LEVEL proxy (the max of each wave's own
  persisted maxSingleEventUsd) and labels it clearly as a derived approximation,
  not the original gate-time value.

- P95 at qualification is persisted ONLY ONCE per signal (p95AtEntry/p95AtQualification,
  a single snapshot taken at final entry time) -- NOT per-wave, NOT at each wave's
  own completion time. The "P95 at that moment" requested for every wave is not
  separately available; this script uses the single stored p95AtEntry value for
  every wave's own qualification check below, with that caveat printed each time.

- Taker buy/sell USD, taker imbalance: the V5Wave schema HAS these fields
  (v5-wave.model.ts), but they are hardcoded null even in the legacy, pre-candle-
  physics V5 path (v5-wave.service.ts line ~379) -- this data has never been
  computed anywhere in this project, for any signal, live or legacy.

- Open Interest (OI) at wave start/end, OI delta%: the V5Wave schema also has
  these fields, and a REAL, live OiTrackerService instance already exists at
  runtime (market-data-orchestrator.ts's own this.oiTracker) -- but
  handleCandlePhysicsEntry() never reads it, so these fields are always null for
  candle-physics signals specifically. This is a genuine "exists at runtime, not
  wired in" gap, not a "never computed anywhere" gap like taker flow above.

- Account long/short ratio, position long/short ratio, BTC price change / BTC OI
  context specific to this signal: NOT stored anywhere in GlobalSignalDoc. BTC
  price/OI context (btcContext field) exists in the schema and IS populated for
  the legacy V5 path, but is left null in handleCandlePhysicsEntry() (never wired
  for the new engine).

- episodePlan / waveEfficiencyAnalysis fields exist in the schema (from an earlier
  strategy iteration) but are always null for current candle-physics signals --
  superseded by the fixed 0.30% SL / 2.2R TP and the P95 seriousness gate.

- "why dominant was selected" has no stored free-text reason field. This script
  DERIVES the answer (efficiency comparison) directly from each wave's own
  persisted priceEfficiency, which is a safe, direct derivation, not an invention.
`);

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const symbolIdx = args.indexOf("--symbol");
  const symbolFilter =
    symbolIdx !== -1 ? args[symbolIdx + 1].toUpperCase() : null;
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 20;
  const signalIdIdx = args.indexOf("--signalId");
  const signalIdFilter = signalIdIdx !== -1 ? args[signalIdIdx + 1] : null;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const col = db.collection("v5_global_signals");

  const filter = { cascadeId: null, timeframe: "1m" };
  if (symbolFilter) filter.symbol = symbolFilter;
  if (signalIdFilter) filter.signalId = signalIdFilter;

  const docs = await col
    .find(filter)
    .sort({ signalTs: -1 })
    .limit(limit)
    .toArray();
  console.log("=".repeat(90));
  console.log(
    "Found " +
      docs.length +
      " candle-physics-engine signal(s)" +
      (symbolFilter ? " for " + symbolFilter : "") +
      " (most recent " +
      limit +
      "):",
  );
  console.log("=".repeat(90));

  docs.forEach((d) => printFullSignalReport(d));

  await client.close();
}

function printFullSignalReport(d) {
  console.log("\n" + "#".repeat(90));
  console.log("SIGNAL / TRADE");
  console.log("#".repeat(90));
  console.log("signalId:          " + d.signalId);
  console.log("symbol:            " + d.symbol);
  console.log("direction:         " + d.victim);
  console.log("status:            " + d.status);
  console.log("signal timestamp:  " + fmtTs(d.signalTs));
  console.log("entry:             " + na(d.entry));
  console.log("SL:                " + na(d.sl));
  console.log("TP:                " + na(d.tp));
  console.log("RR:                " + na(d.rr));
  const isClosed = d.status === "CLOSED_TP" || d.status === "CLOSED_SL";
  console.log(
    "close timestamp:   " +
      (isClosed ? fmtTs(d.closedAt) : "NOT_AVAILABLE (not closed)"),
  );
  console.log(
    "close price:       " +
      (isClosed ? na(d.closePrice) : "NOT_AVAILABLE (not closed)"),
  );
  console.log("maxFavorableR:     " + na(d.maxFavorableR));
  console.log("maxAdverseR:       " + na(d.maxAdverseR));
  if (isClosed && d.closedAt && d.signalTs) {
    const durationSec = (d.closedAt - d.signalTs) / 1000;
    console.log(
      "trade duration:    " +
        durationSec.toFixed(0) +
        " sec (" +
        (durationSec / 60).toFixed(2) +
        " min)",
    );
  } else {
    console.log("trade duration:    NOT_AVAILABLE (not closed)");
  }

  console.log("\n" + "-".repeat(90));
  console.log("P95 / LIQUIDATION SERIOUSNESS");
  console.log("-".repeat(90));
  console.log(
    "P95 at qualification (single snapshot, entry time): " +
      fmtUsd(d.p95AtQualification),
  );
  console.log(
    "P95 at entry (same snapshot, stored twice):          " +
      fmtUsd(d.p95AtEntry),
  );
  const episodeMaxIndividualEvent = d.waveHistory.length
    ? Math.max(...d.waveHistory.map((w) => w.maxSingleEventUsd))
    : null;
  console.log(
    "episode max individual event (derived: max of each wave's own maxSingleEventUsd -- NOT the original transient P95-gate value): " +
      fmtUsd(episodeMaxIndividualEvent),
  );
  console.log(
    "episode total liquidation USD (totalEpisodePressure): " +
      fmtUsd(d.totalEpisodePressure),
  );
  const totalEventCount = d.waveHistory.reduce((s, w) => s + w.liqEvents, 0);
  console.log(
    "total event count (sum of every wave's own liqEvents): " + totalEventCount,
  );
  console.log(
    "side-specific liquidation totals (LONG vs SHORT split): NOT_AVAILABLE (this signal document only stores same-victim totals; liq_raw_events has per-victim data but is a separate, unjoined collection)",
  );
  console.log(
    "per-wave: max individual event >= P95(at entry, approximated for all waves):",
  );
  d.waveHistory.forEach((w) => {
    const passes =
      d.p95AtQualification !== null &&
      w.maxSingleEventUsd >= d.p95AtQualification;
    console.log(
      "  W" +
        w.waveNumber +
        ": maxEvent=" +
        fmtUsd(w.maxSingleEventUsd) +
        "  >=P95? " +
        (d.p95AtQualification === null
          ? "NOT_AVAILABLE"
          : passes
            ? "YES"
            : "NO"),
    );
  });

  console.log("\n" + "-".repeat(90));
  console.log("WAVES");
  console.log("-".repeat(90));
  d.waveHistory.forEach((w, i) => {
    console.log("\n  --- Wave " + w.waveNumber + " ---");
    console.log("  status:                    " + w.state);
    console.log("  victim side:               " + d.victim);
    console.log("  start timestamp:           " + fmtTs(w.anchorTs));
    console.log("  end/completion timestamp:  " + fmtTs(w.extremeTs));
    const durationSec = (w.extremeTs - w.anchorTs) / 1000;
    console.log(
      "  duration:                  " +
        durationSec.toFixed(0) +
        " sec (" +
        (durationSec / 60).toFixed(2) +
        " min)",
    );
    console.log("  anchor price:              " + fmt(w.anchorPrice));
    console.log("  extreme price:             " + fmt(w.extremePrice));
    console.log(
      "  reclaim/recovery price:    " +
        (w.reclaimPrice !== null
          ? fmt(w.reclaimPrice) +
            "  (NOTE: for candle-physics waves this is an APPROXIMATION -- extreme +/- 1 UNIT -- not a live-tracked reclaim price)"
          : "NOT_AVAILABLE"),
    );
    console.log("  frozen UNIT (ATR) used:    " + fmt(d.unitAtStart));
    const priceDistance = Math.abs(w.anchorPrice - w.extremePrice);
    console.log("  directional price distance:" + fmt(priceDistance));
    console.log(
      "  DistanceATR (extremeDistanceAtr): " + fmt(w.extremeDistanceAtr, 4),
    );
    console.log(
      "  new-extreme extension units: NOT_AVAILABLE (not persisted per-wave on V5Wave -- only extremeDistanceAtr, the wave's OWN incremental ATR progress, is stored)",
    );
    console.log("  total liquidation USD:     " + fmtUsd(w.liqNotionalUsd));
    console.log("  event count:               " + w.liqEvents);
    console.log("  max individual raw event:  " + fmtUsd(w.maxSingleEventUsd));
    if (durationSec > 0) {
      console.log(
        "  liquidation rate:          " +
          (w.liqNotionalUsd / durationSec).toFixed(2) +
          " USD/sec  (" +
          (w.liqNotionalUsd / (durationSec / 60)).toFixed(2) +
          " USD/min)",
      );
      console.log(
        "  event rate:                " +
          (w.liqEvents / (durationSec / 60)).toFixed(3) +
          " events/min",
      );
      console.log(
        "  price speed:               " +
          (w.extremeDistanceAtr / (durationSec / 60)).toFixed(4) +
          " ATR/min",
      );
      console.log(
        "  candle count (derived from duration, 1m candles): " +
          Math.max(1, Math.round(durationSec / 60) + 1),
      );
    } else {
      console.log(
        "  liquidation rate:          NOT_AVAILABLE (zero-duration wave)",
      );
      console.log(
        "  event rate:                NOT_AVAILABLE (zero-duration wave)",
      );
      console.log(
        "  price speed:               NOT_AVAILABLE (zero-duration wave)",
      );
      console.log(
        "  candle count:              NOT_AVAILABLE (zero-duration wave)",
      );
    }
    console.log(
      "  priceImpactPer1M / efficiency (priceEfficiency): " +
        fmt(w.priceEfficiency, 2),
    );
    console.log(
      "  efficiency ratio vs dominant (priceEfficiencyRatioVsDominant): " +
        (w.priceEfficiencyRatioVsDominant !== null
          ? fmt(w.priceEfficiencyRatioVsDominant, 4)
          : "NOT_AVAILABLE (never populated for candle-physics waves -- the dominant-comparison section below derives this instead)"),
    );
    console.log(
      "  exhaustion percentage:     NOT_AVAILABLE (no dedicated stored field for candle-physics waves; the DOMINANT/COMPARISON section below computes an efficiency-based comparison from persisted data)",
    );
    console.log(
      "  recoveryUnits/reclaimUnits: " +
        (w.recoveryPct !== null
          ? fmt(w.recoveryPct, 4)
          : "NOT_AVAILABLE (recoveryPct not populated for candle-physics waves)"),
    );

    console.log("\n  FLOW / MARKET CONTEXT (Wave " + w.waveNumber + "):");
    console.log(
      "    taker buy USD:           " +
        (w.takerBuyUsd !== null
          ? fmtUsd(w.takerBuyUsd)
          : "NOT_AVAILABLE (never computed anywhere in this project, see KNOWN GAPS above)"),
    );
    console.log(
      "    taker sell USD:          " +
        (w.takerSellUsd !== null ? fmtUsd(w.takerSellUsd) : "NOT_AVAILABLE"),
    );
    console.log(
      "    taker imbalance:         " +
        (w.takerImbalance !== null
          ? fmt(w.takerImbalance, 4)
          : "NOT_AVAILABLE"),
    );
    console.log(
      "    OI at wave start:        " +
        (w.oiStart !== null
          ? fmt(w.oiStart, 2)
          : "NOT_AVAILABLE (OiTrackerService exists at runtime but is not wired into candle-physics signals yet, see KNOWN GAPS above)"),
    );
    console.log(
      "    OI at wave end:          " +
        (w.oiEnd !== null ? fmt(w.oiEnd, 2) : "NOT_AVAILABLE"),
    );
    console.log(
      "    OI delta%:               " +
        (w.oiDeltaPct !== null ? fmtPct(w.oiDeltaPct) : "NOT_AVAILABLE"),
    );

    console.log("\n  P95/W1 QUALIFICATION DEBUG (Wave " + w.waveNumber + "):");
    const waveP95 = d.p95AtQualification;
    console.log(
      "    P95 at that moment:      " +
        fmtUsd(waveP95) +
        "  (APPROXIMATION -- single entry-time snapshot reused for every wave, see KNOWN GAPS above)",
    );
    console.log("    max individual event:    " + fmtUsd(w.maxSingleEventUsd));
    console.log("    cumulative wave liquidity: " + fmtUsd(w.liqNotionalUsd));
    console.log("    event count:             " + w.liqEvents);
    const eventCountOk = w.liqEvents >= 2;
    const p95Ok = waveP95 !== null && w.maxSingleEventUsd >= waveP95;
    let label;
    if (!eventCountOk) label = "DISCARDED_SINGLE_EVENT";
    else if (!p95Ok) label = "DISCARDED_NO_P95";
    else label = "QUALIFIED_AS_W1";
    console.log("    label:                   " + label);
  });

  console.log("\n" + "-".repeat(90));
  console.log("DOMINANT / COMPARISON");
  console.log("-".repeat(90));
  const dominantWave = d.waveHistory.find(
    (w) => w.waveNumber === d.dominantLayerWaveNumber,
  );
  const signalWave = d.waveHistory.find(
    (w) => w.waveNumber === d.exhaustionLayerWaveNumber,
  );
  console.log(
    "dominant/reference wave:   W" +
      na(d.dominantLayerWaveNumber) +
      "  (" +
      fmtUsd(d.dominantLayerLiqUsd) +
      ")",
  );
  if (dominantWave && signalWave) {
    console.log(
      "why selected:              derived -- the wave with the STRONGEST priceEfficiency among all prior completed waves becomes dominant (see candle-physics-engine.ts); dominant W" +
        dominantWave.waveNumber +
        " efficiency=" +
        fmt(dominantWave.priceEfficiency, 2) +
        " vs signal W" +
        signalWave.waveNumber +
        " efficiency=" +
        fmt(signalWave.priceEfficiency, 2),
    );
  } else {
    console.log(
      "why selected:              NOT_AVAILABLE (dominant or signal wave not found in waveHistory)",
    );
  }
  console.log(
    "signal/exhaustion wave:    W" +
      na(d.exhaustionLayerWaveNumber) +
      "  (" +
      fmtUsd(d.exhaustionLayerLiqUsd) +
      ")",
  );
  if (dominantWave && signalWave) {
    const liqChangePct =
      dominantWave.liqNotionalUsd > 0
        ? (signalWave.liqNotionalUsd - dominantWave.liqNotionalUsd) /
          dominantWave.liqNotionalUsd
        : null;
    console.log(
      "liq change %:              " +
        (liqChangePct !== null ? fmtPct(liqChangePct) : "NOT_AVAILABLE"),
    );
    const effChangePct =
      dominantWave.priceEfficiency &&
      dominantWave.priceEfficiency > 0 &&
      signalWave.priceEfficiency !== null
        ? (signalWave.priceEfficiency - dominantWave.priceEfficiency) /
          dominantWave.priceEfficiency
        : null;
    console.log(
      "efficiency change %:      " +
        (effChangePct !== null
          ? fmtPct(effChangePct)
          : "NOT_AVAILABLE (one of the two waves has zero/null efficiency)"),
    );
    const domDurationMin =
      (dominantWave.extremeTs - dominantWave.anchorTs) / 60000;
    const sigDurationMin = (signalWave.extremeTs - signalWave.anchorTs) / 60000;
    const domSpeed =
      domDurationMin > 0
        ? dominantWave.extremeDistanceAtr / domDurationMin
        : null;
    const sigSpeed =
      sigDurationMin > 0
        ? signalWave.extremeDistanceAtr / sigDurationMin
        : null;
    const speedChangePct =
      domSpeed !== null && domSpeed > 0 && sigSpeed !== null
        ? (sigSpeed - domSpeed) / domSpeed
        : null;
    console.log(
      "speed change %:            " +
        (speedChangePct !== null
          ? fmtPct(speedChangePct)
          : "NOT_AVAILABLE (zero-duration wave involved)"),
    );
    console.log(
      "price-impact change %:     same as efficiency change % above (priceImpactPer1M IS priceEfficiency in this schema)",
    );
    const domRate =
      domDurationMin > 0 ? dominantWave.liqNotionalUsd / domDurationMin : null;
    const sigRate =
      sigDurationMin > 0 ? signalWave.liqNotionalUsd / sigDurationMin : null;
    const rateChangePct =
      domRate !== null && domRate > 0 && sigRate !== null
        ? (sigRate - domRate) / domRate
        : null;
    console.log(
      "liq-rate change %:         " +
        (rateChangePct !== null
          ? fmtPct(rateChangePct)
          : "NOT_AVAILABLE (zero-duration wave involved)"),
    );
    const domEventRate =
      domDurationMin > 0 ? dominantWave.liqEvents / domDurationMin : null;
    const sigEventRate =
      sigDurationMin > 0 ? signalWave.liqEvents / sigDurationMin : null;
    const eventRateChangePct =
      domEventRate !== null && domEventRate > 0 && sigEventRate !== null
        ? (sigEventRate - domEventRate) / domEventRate
        : null;
    console.log(
      "event-rate change %:       " +
        (eventRateChangePct !== null
          ? fmtPct(eventRateChangePct)
          : "NOT_AVAILABLE (zero-duration wave involved)"),
    );
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
