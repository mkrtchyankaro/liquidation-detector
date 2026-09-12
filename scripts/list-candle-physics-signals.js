/**
 * Sep 12 2026 (Karo), operator-requested. Main post-trade analysis
 * tool for candle-physics-engine signals. READ-ONLY, no strategy/
 * execution/persistence changes. Uses the new persisted research
 * fields (per-wave rates, marketContextAtEntry, W1-qualification
 * P95/event/timestamp) where present; falls back to exact-derivation
 * or omits the row for old signals that predate them.
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");

function fmtTs(ms) {
  return ms
    ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z"
    : null;
}
function fmtClock(ms) {
  return ms ? new Date(ms).toISOString().slice(11, 19) + " UTC" : null;
}
function fmtUsd(n) {
  if (n === null || n === undefined) return null;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000)
    return (
      "$" +
      (n / 1_000).toFixed(abs >= 100_000 ? 0 : abs >= 10_000 ? 1 : 2) +
      "k"
    );
  return "$" + n.toFixed(0);
}
function fmtPrice(n) {
  if (n === null || n === undefined) return null;
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n.toFixed(digits)).toString();
}
function fmtPct(n, digits) {
  if (n === null || n === undefined) return null;
  return (
    (n >= 0 ? "+" : "") +
    (n * 100).toFixed(digits === undefined ? 1 : digits) +
    "%"
  );
}
function fmtDuration(ms) {
  if (ms === null || ms === undefined) return null;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return totalMin + "m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? h + "h" : h + "h " + m + "m";
}
/** Prints "label: value" only when value is not null/undefined -- the
 *  core mechanism behind removing noisy NOT_AVAILABLE rows everywhere. */
function row(lines, label, value) {
  if (value === null || value === undefined || value === "") return;
  lines.push(label + ": " + value);
}

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

  console.log("KNOWN DATA GAPS");
  console.log("- Per-wave taker flow: not tracked");
  console.log("- Per-wave OI start/end/delta: not tracked");
  console.log("- Account/position L/S ratio: service exists but disconnected");
  console.log("- Funding rate: service exists but disconnected");
  console.log(
    "- Real candle-physics reclaim price: not tracked (approximation omitted below)",
  );
  console.log("");

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
  console.log(
    "Found " +
      docs.length +
      " candle-physics-engine signal(s)" +
      (symbolFilter ? " for " + symbolFilter : "") +
      " (most recent " +
      limit +
      "):",
  );
  console.log("");

  docs.forEach((d) => printFullSignalReport(d));

  await client.close();
}

function printFullSignalReport(d) {
  const lines = [];
  lines.push("#".repeat(70));
  lines.push("SIGNAL / TRADE");
  lines.push("#".repeat(70));
  row(lines, "signalId", d.signalId);
  row(lines, "symbol", d.symbol);
  row(lines, "direction", d.victim);
  row(lines, "status", d.status);
  row(lines, "signal timestamp", fmtTs(d.signalTs));
  row(lines, "entry", fmtPrice(d.entry));
  row(lines, "SL", fmtPrice(d.sl));
  row(lines, "TP", fmtPrice(d.tp));
  row(
    lines,
    "RR",
    d.rr !== null && d.rr !== undefined ? d.rr.toFixed(2) : null,
  );
  const isClosed = d.status === "CLOSED_TP" || d.status === "CLOSED_SL";
  if (isClosed) {
    row(lines, "close timestamp", fmtTs(d.closedAt));
    row(lines, "close price", fmtPrice(d.closePrice));
  }
  row(
    lines,
    "maxFavorableR",
    d.maxFavorableR !== null && d.maxFavorableR !== undefined
      ? d.maxFavorableR.toFixed(2)
      : null,
  );
  row(
    lines,
    "maxAdverseR",
    d.maxAdverseR !== null && d.maxAdverseR !== undefined
      ? d.maxAdverseR.toFixed(2)
      : null,
  );
  if (isClosed && d.closedAt && d.signalTs)
    row(lines, "trade duration", fmtDuration(d.closedAt - d.signalTs));

  // ── W1 qualification ──
  const w1Lines = [];
  // Fallback distinguished internally (isFallback), never surfaced as clutter --
  // just a differently-worded label on the P95 row itself.
  let isFallback = false;
  let p95 = d.p95AtW1Qualification;
  let maxEvent = d.maxIndividualEventUsdAtW1;
  let qualTs = d.w1QualificationTs;
  if (p95 === null || p95 === undefined) {
    isFallback = true;
    p95 = d.p95AtQualification ?? d.p95AtEntry ?? null;
  }
  row(
    w1Lines,
    "P95",
    fmtUsd(p95) === null
      ? null
      : fmtUsd(p95) + (isFallback ? " (entry snapshot)" : ""),
  );
  row(w1Lines, "Max event", fmtUsd(maxEvent));
  row(w1Lines, "Time", fmtClock(qualTs));
  if (w1Lines.length > 0) {
    lines.push("");
    lines.push("W1 qualification");
    lines.push(...w1Lines);
  }

  // ── Episode summary ──
  const epLines = [];
  row(epLines, "Episode total", fmtUsd(d.totalEpisodePressure));
  const totalEvents = (d.waveHistory || []).reduce(
    (s, w) => s + (w.liqEvents || 0),
    0,
  );
  row(epLines, "Total events", totalEvents > 0 ? String(totalEvents) : null);
  if (epLines.length > 0) {
    lines.push("");
    lines.push(...epLines);
  }

  // ── Waves ──
  if (d.waveHistory && d.waveHistory.length > 0) {
    lines.push("");
    lines.push("WAVES");
    for (const w of d.waveHistory) {
      lines.push("");
      lines.push("W" + w.waveNumber);
      const durationMs =
        w.extremeTs && w.anchorTs ? w.extremeTs - w.anchorTs : null;
      row(lines, "  start", fmtTs(w.anchorTs));
      row(lines, "  end", fmtTs(w.extremeTs));
      row(lines, "  duration", fmtDuration(durationMs));
      row(lines, "  anchor", fmtPrice(w.anchorPrice));
      row(lines, "  extreme", fmtPrice(w.extremePrice));
      row(
        lines,
        "  UNIT",
        d.unitAtStart !== null && d.unitAtStart !== undefined
          ? fmtPrice(d.unitAtStart)
          : null,
      );
      row(
        lines,
        "  DistanceATR",
        w.extremeDistanceAtr !== null && w.extremeDistanceAtr !== undefined
          ? w.extremeDistanceAtr.toFixed(3)
          : null,
      );
      row(lines, "  Liq USD", fmtUsd(w.liqNotionalUsd));
      row(
        lines,
        "  Events",
        w.liqEvents !== null && w.liqEvents !== undefined
          ? String(w.liqEvents)
          : null,
      );
      row(lines, "  Max event", fmtUsd(w.maxSingleEventUsd));

      // Prefer persisted rate fields; fall back to exact derivation ONLY
      // for old signals that predate them (w.liqRateUsdPerMin === undefined,
      // not just null -- undefined means the field never existed on this
      // document at all, distinguishing "old schema" from "computed as null
      // because duration was zero").
      const hasPersistedRates = w.liqRateUsdPerMin !== undefined;
      let liqRate = hasPersistedRates ? w.liqRateUsdPerMin : null;
      let eventRate = hasPersistedRates ? w.eventRatePerMin : null;
      let speedRate = hasPersistedRates ? w.priceSpeedAtrPerMin : null;
      if (!hasPersistedRates && durationMs && durationMs > 0) {
        const durationMin = durationMs / 60000;
        if (w.liqNotionalUsd !== null && w.liqNotionalUsd !== undefined)
          liqRate = w.liqNotionalUsd / durationMin;
        if (w.liqEvents !== null && w.liqEvents !== undefined)
          eventRate = w.liqEvents / durationMin;
        if (w.extremeDistanceAtr !== null && w.extremeDistanceAtr !== undefined)
          speedRate = w.extremeDistanceAtr / durationMin;
      }
      row(
        lines,
        "  Liq rate",
        liqRate !== null
          ? fmtUsd(liqRate) + "/min" + (!hasPersistedRates ? " (derived)" : "")
          : null,
      );
      row(
        lines,
        "  Event rate",
        eventRate !== null
          ? eventRate.toFixed(2) +
              "/min" +
              (!hasPersistedRates ? " (derived)" : "")
          : null,
      );
      row(
        lines,
        "  Speed",
        speedRate !== null
          ? speedRate.toFixed(3) +
              " ATR/min" +
              (!hasPersistedRates ? " (derived)" : "")
          : null,
      );
      row(
        lines,
        "  Efficiency",
        w.priceEfficiency !== null && w.priceEfficiency !== undefined
          ? w.priceEfficiency.toFixed(2)
          : null,
      );
      // reclaimPrice deliberately OMITTED -- approximation, not real observed data (per operator instruction).
    }
  }

  // ── Comparison (dominant vs signal wave) ──
  const dominantWave = (d.waveHistory || []).find(
    (w) => w.waveNumber === d.dominantLayerWaveNumber,
  );
  const signalWave = (d.waveHistory || []).find(
    (w) => w.waveNumber === d.exhaustionLayerWaveNumber,
  );
  if (dominantWave && signalWave && dominantWave !== signalWave) {
    const compLines = [];
    row(compLines, "Reference", "W" + dominantWave.waveNumber);
    row(compLines, "Signal", "W" + signalWave.waveNumber);
    if (dominantWave.liqNotionalUsd > 0)
      row(
        compLines,
        "Liq",
        fmtPct(
          (signalWave.liqNotionalUsd - dominantWave.liqNotionalUsd) /
            dominantWave.liqNotionalUsd,
        ),
      );
    if (dominantWave.priceEfficiency)
      row(
        compLines,
        "Efficiency",
        fmtPct(
          (signalWave.priceEfficiency - dominantWave.priceEfficiency) /
            dominantWave.priceEfficiency,
        ),
      );
    const domDurMin =
      dominantWave.extremeTs && dominantWave.anchorTs
        ? (dominantWave.extremeTs - dominantWave.anchorTs) / 60000
        : null;
    const sigDurMin =
      signalWave.extremeTs && signalWave.anchorTs
        ? (signalWave.extremeTs - signalWave.anchorTs) / 60000
        : null;
    if (domDurMin > 0 && sigDurMin > 0) {
      const domSpeed = dominantWave.extremeDistanceAtr / domDurMin;
      const sigSpeed = signalWave.extremeDistanceAtr / sigDurMin;
      if (domSpeed > 0)
        row(compLines, "Speed", fmtPct((sigSpeed - domSpeed) / domSpeed));
      const domRate = dominantWave.liqNotionalUsd / domDurMin;
      const sigRate = signalWave.liqNotionalUsd / sigDurMin;
      if (domRate > 0)
        row(compLines, "Liq rate", fmtPct((sigRate - domRate) / domRate));
      const domEvtRate = dominantWave.liqEvents / domDurMin;
      const sigEvtRate = signalWave.liqEvents / sigDurMin;
      if (domEvtRate > 0)
        row(
          compLines,
          "Event rate",
          fmtPct((sigEvtRate - domEvtRate) / domEvtRate),
        );
    }
    if (compLines.length > 0) {
      lines.push("");
      lines.push("COMPARISON");
      lines.push(...compLines);
    }
  }

  // ── Entry market context (new field, omitted entirely for old signals) ──
  const mc = d.marketContextAtEntry;
  if (mc) {
    const takerLines = [];
    row(takerLines, "  Buy", fmtUsd(mc.takerFlowLast30sBuyUsd));
    row(takerLines, "  Sell", fmtUsd(mc.takerFlowLast30sSellUsd));
    row(takerLines, "  Imbalance", fmtPct(mc.takerFlowLast30sImbalance));
    const baselineLines = [];
    row(
      baselineLines,
      "  Median/min",
      fmtUsd(mc.takerVolumeRollingMedianPerMinUsd),
    );
    const oiLines = [];
    row(
      oiLines,
      "  Current",
      mc.oiCurrentContracts !== null && mc.oiCurrentContracts !== undefined
        ? mc.oiCurrentContracts.toFixed(2)
        : null,
    );
    row(
      oiLines,
      "  Median change",
      mc.oiRollingMedianChangeContracts !== null &&
        mc.oiRollingMedianChangeContracts !== undefined
        ? mc.oiRollingMedianChangeContracts.toFixed(2)
        : null,
    );

    if (
      takerLines.length > 0 ||
      baselineLines.length > 0 ||
      oiLines.length > 0
    ) {
      lines.push("");
      lines.push("ENTRY MARKET CONTEXT");
      if (takerLines.length > 0) {
        lines.push("Taker 30s:");
        lines.push(...takerLines);
      }
      if (baselineLines.length > 0) {
        lines.push("Taker baseline:");
        lines.push(...baselineLines);
      }
      if (oiLines.length > 0) {
        lines.push("OI:");
        lines.push(...oiLines);
      }
    }
  }

  // ── BTC context ──
  if (d.btcContext) {
    const btcLines = [];
    // Sep 12 2026 (Karo) -- BTC price is a PRICE, not a liquidation
    // magnitude: full comma-formatted number (e.g. $115,240), never
    // the compact k/M notation used for USD liquidation amounts.
    row(
      btcLines,
      "Price",
      d.btcContext.priceAtSignal !== null &&
        d.btcContext.priceAtSignal !== undefined
        ? "$" +
            d.btcContext.priceAtSignal.toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })
        : null,
    );
    row(
      btcLines,
      "OI",
      d.btcContext.oiAtSignal !== null && d.btcContext.oiAtSignal !== undefined
        ? d.btcContext.oiAtSignal.toFixed(2)
        : null,
    );
    if (btcLines.length > 0) {
      lines.push("");
      lines.push("BTC CONTEXT");
      lines.push(...btcLines);
    }
  }

  console.log(lines.join("\n"));
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
