import type { V5SignalEvent } from "../../strategy/v5/v5-wave.service";

/**
 * Sep 7 2026, operator-approved (Karo) -- V5's own Telegram formatter.
 * Kept close to the existing, proven ENTRY message shape (emoji
 * header, Entry/SL/TP/RR block) -- the main change from V4's own
 * formatter is the "V5 Chain" block, which lists EVERY wave in the
 * chain (not a fixed wave1/wave2 pair), since V5's entry can happen
 * on any wave depth.
 *
 * Sep 8 2026, operator-approved (Karo) -- two cleanup changes:
 *   1. Added the position-size line (matching V3's own real formula:
 *      positionQty = V3_RISK_USD / slDistance, notional = qty*entry --
 *      the EXACT SAME computation app.ts's own execution-wiring uses).
 *      This is the PLANNED size (Telegram sends before real execution
 *      confirms) -- for a live trade the ACTUAL filled size may differ
 *      slightly due to slippage/exchange rounding.
 *   2. REMOVED the old "BTC Safety: CLEAN/WOULD_BLOCK" line. That
 *      status was informational only and its own "suppressed" claim
 *      was never actually enforced by any code -- confirmed and fixed
 *      separately via the new, precise V5_BTC_BLOCK mechanism (see
 *      v5.config.ts's own v5BtcBlockEnabled() doc comment), which now
 *      produces its own explicit, unambiguous log lines/terminal
 *      reasons (BTC_BLOCK_NO_ENTRY / BTC_BLOCK_SAME_SIDE) instead. A
 *      signal that reaches Telegram at all was, by construction, never
 *      blocked by V5_BTC_BLOCK -- there is nothing left to display.
 */
export function formatV5EntryMessage(event: V5SignalEvent): string {
  const time = new Date(event.signalTs).toISOString().slice(11, 19) + " UTC";

  const lines: string[] = [];
  const executed = event.plan !== null;
  const emoji = executed ? "🟢" : "🟡";
  lines.push(
    `${emoji} V5 ${executed ? "ENTRY" : "SIGNAL (not executed)"} ${event.symbol} ${event.side} · ${time}`,
  );
  // Sep 10 2026 (Karo), operator-requested -- ADDITIVE, ONE line, ONLY
  // for a cascade-produced signal (timeframe !== null). A legacy,
  // non-cascade signal (timeframe === null) renders EXACTLY as before,
  // completely unaffected -- no line added, no format change.
  if (event.timeframe !== null) lines.push(`Candidate: ${event.timeframe}`);

  if (event.plan) {
    const tpPct =
      (Math.abs(event.plan.tp - event.plan.entry) / event.plan.entry) * 100;
    const slPct =
      (Math.abs(event.plan.entry - event.plan.sl) / event.plan.entry) * 100;
    lines.push(`Entry: ${event.plan.entry}`);
    lines.push(`SL: ${event.plan.sl.toFixed(6)} (-${slPct.toFixed(2)}%)`);
    lines.push(`TP: ${event.plan.tp.toFixed(6)} (+${tpPct.toFixed(2)}%)`);
    lines.push(`RR: ${event.plan.rr.toFixed(2)}`);

    // Sep 8 2026, operator-approved (Karo) -- PLANNED position size,
    // same formula as app.ts's own real-execution wiring (V3_RISK_USD
    // / slDistance). Skipped gracefully (no line at all) if slDistance
    // is somehow zero -- never divides by zero, never shows a
    // misleading Infinity.
    const riskUsd = Number(process.env.V3_RISK_USD ?? 20);
    const slDistance = Math.abs(event.plan.entry - event.plan.sl);
    if (slDistance > 0) {
      const positionQty = riskUsd / slDistance;
      const notionalUsdt = positionQty * event.plan.entry;
      lines.push(
        `Risk: $${riskUsd} (position size: $${notionalUsdt.toFixed(0)})`,
      );
    }
  } else {
    lines.push(`Entry (reference only): ${event.entryPrice}`);
    lines.push(`Plan rejected: ${event.rejectionReason ?? "unknown"}`);
  }

  lines.push("");
  // Sep 10 2026 (Karo), operator-requested -- for a cascade-produced
  // signal (timeframe !== null), the OLD "reclaimed... trigger: X%
  // recovery, extremeDistanceAtr=Y" line is not meaningful: the
  // cascade model has no "50%/75%/100% of anchor-extreme range"
  // recovery-percent concept at all (it completes each wave at
  // exactly 1x UNIT recovery), so entryWaveRecord.selectedRecoveryPct
  // is honestly null and extremeDistanceAtr is a per-wave-history
  // reconstruction, not a real recovery-trigger metric -- printing
  // "trigger: ?%" / "extremeDistanceAtr=0.000" there is misleading,
  // never a genuine value. A simplified, honest line is used instead.
  // A legacy, non-cascade signal (timeframe === null) renders the
  // EXACT SAME line as before, completely unaffected -- those fields
  // ARE real and meaningful for that path.
  if (event.timeframe !== null) {
    lines.push(
      `V5 Chain: Signal on Wave ${event.entryWaveNumber} of ${event.waveHistory.length}`,
    );
  } else {
    const entryWaveRecord = event.waveHistory.find(
      (w) => w.waveNumber === event.entryWaveNumber,
    );
    lines.push(
      `V5 Chain: reclaimed on Wave ${event.entryWaveNumber} of ${event.waveHistory.length} ` +
        `(trigger: ${entryWaveRecord?.selectedRecoveryPct ?? "?"}% recovery, extremeDistanceAtr=${entryWaveRecord?.extremeDistanceAtr.toFixed(3) ?? "?"})`,
    );
  }
  lines.push(
    `Qualifying event: $${formatUsd(event.qualifyingEventUsd)} (P95 at qualification: $${formatUsd(event.p95AtQualification)})`,
  );
  lines.push(
    `Episode total liquidity: $${formatUsd(event.totalEpisodePressure)}`,
  );
  lines.push(
    `Dominant layer: $${formatUsd(event.dominantLayerLiqUsd ?? 0)} (Wave ${event.dominantLayerWaveNumber}) → Exhaustion layer: $${formatUsd(event.exhaustionLayerLiqUsd ?? 0)} (Wave ${event.exhaustionLayerWaveNumber})`,
  );
  for (const w of event.waveHistory) {
    lines.push(
      `  W${w.waveNumber}: anchor=${w.anchorPrice} → extreme=${w.extremePrice} → reclaim=${w.reclaimPrice ?? "—"}  ($${formatUsd(w.liqNotionalUsd)})`,
    );
  }

  if (event.plan) {
    lines.push("");
    lines.push(
      `Physics (episode-total-based): liqStrength=${event.plan.liqStrength.toFixed(2)} (raw ${event.plan.liqStrengthRaw.toFixed(2)}) ` +
        `physicsTP=${(event.plan.physicsTPPct * 100).toFixed(2)}%`,
    );
  }

  // Sep 8 2026, operator-approved (Karo) -- ALWAYS shown, on EVERY
  // instance, regardless of that instance's own v5BtcBlockEnabled()
  // setting -- see btcIntendedSideAtSignalTime's own doc comment. On
  // an instance where V5_BTC_BLOCK=true, any signal reaching this
  // point is, by construction, ALREADY "would block: no" (a genuine
  // same-side match would have been blocked before ever reaching
  // Telegram formatting) -- so this line is never contradictory, only
  // sometimes redundant there. On MAIN (or any instance with
  // V5_BTC_BLOCK=false), this is the ONLY way to see what
  // BROTHER/FRIEND did/would have done with the identical signal.
  if (event.symbol !== "BTCUSDT") {
    const wouldBlock =
      event.btcIntendedSideAtSignalTime !== null &&
      event.btcIntendedSideAtSignalTime === event.side;
    lines.push("");
    lines.push(
      wouldBlock
        ? `⚠️ BTC_BLOCK would apply here: YES (BTC currently has an active ${event.btcIntendedSideAtSignalTime} setup, same side)`
        : `BTC_BLOCK would apply here: NO`,
    );
  } else {
    lines.push("");
    lines.push(
      `BTC_BLOCK would apply here: YES, unconditionally (BTC itself never trades when V5_BTC_BLOCK=true)`,
    );
  }

  return lines.join("\n");
}

export function formatV5CloseMessage(
  symbol: string,
  side: string,
  outcome: "TP" | "SL",
  entry: number,
  closePrice: number,
  entryWaveNumber: number,
): string {
  const emoji = outcome === "TP" ? "✅" : "❌";
  const pnlPct =
    side === "LONG"
      ? (closePrice - entry) / entry
      : (entry - closePrice) / entry;
  return (
    `${emoji} V5 CLOSE ${symbol} ${side} ${outcome}\n` +
    `Entry: ${entry} → Exit: ${closePrice}\n` +
    `PnL: ${(pnlPct * 100).toFixed(2)}%\n` +
    `Entered on Wave ${entryWaveNumber}`
  );
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return n.toFixed(0);
}
