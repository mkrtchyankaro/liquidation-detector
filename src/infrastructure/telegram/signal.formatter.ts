import type { V5SignalEvent } from "../../strategy/v5/v5-wave.service";

/**
 * Sep 11 2026 (Karo), operator-requested Telegram presentation/design
 * cleanup -- FORMATTER-ONLY. No strategy logic, candle physics, P95
 * qualification, SL/TP, execution, or BTC_BLOCK computation is
 * touched anywhere in this file; every value below is read directly
 * from the SAME event data the previous formatter already used (plus
 * the new, purely-additive p95AtW1Qualification/maxIndividualEventUsdAtW1
 * fields, when available), simply displayed more compactly.
 */

function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
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

/** Sensible, generic symbol-price precision -- no per-symbol lookup
 *  table (that would be a design decision beyond "formatter only"):
 *  more decimals for smaller-magnitude prices, fewer for larger ones,
 *  trimming trailing zeros so e.g. 2515.637811928875 -> 2515.64 and
 *  0.204500 -> 0.2045. */
function formatPrice(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n.toFixed(digits)).toString();
}

function formatPct(n: number): string {
  return n.toFixed(2) + "%";
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return totalMin + "m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? h + "h" : h + "h " + m + "m";
}

export function formatV5EntryMessage(event: V5SignalEvent): string {
  const time = new Date(event.signalTs).toISOString().slice(11, 19) + " UTC";
  const executed = event.plan !== null;
  const emoji = executed ? "🟢" : "🟡";

  const lines: string[] = [];
  lines.push(
    `${emoji} V5 ${executed ? "ENTRY" : "SIGNAL (not executed)"} ${event.symbol} ${event.side} · ${time}`,
  );
  lines.push("");

  if (event.plan) {
    const tpPct =
      (Math.abs(event.plan.tp - event.plan.entry) / event.plan.entry) * 100;
    const slPct =
      (Math.abs(event.plan.entry - event.plan.sl) / event.plan.entry) * 100;
    lines.push(`Entry: ${formatPrice(event.plan.entry)}`);
    lines.push(`SL: ${formatPrice(event.plan.sl)} (-${formatPct(slPct)})`);
    lines.push(`TP: ${formatPrice(event.plan.tp)} (+${formatPct(tpPct)})`);
    lines.push(`RR: ${event.plan.rr.toFixed(2)}`);

    const riskUsd = Number(process.env.V3_RISK_USD ?? 20);
    const slDistance = Math.abs(event.plan.entry - event.plan.sl);
    if (slDistance > 0) {
      const positionQty = riskUsd / slDistance;
      const notionalUsdt = positionQty * event.plan.entry;
      lines.push(`Risk: $${riskUsd} · Size: ${formatUsd(notionalUsdt)}`);
    }
  } else {
    lines.push(`Entry (reference only): ${formatPrice(event.entryPrice)}`);
    lines.push(`Plan rejected: ${event.rejectionReason ?? "unknown"}`);
  }

  lines.push("");
  lines.push(`SignalId: ${event.signalId}`);
  lines.push("");

  // Sep 11 2026 (Karo) -- prefer the REAL W1-qualification P95 when
  // available (p95AtW1Qualification, from the current candle-physics
  // engine), falling back to the older, generic p95AtQualification
  // snapshot only when the newer field is absent (the legacy,
  // non-cascade V5 path).
  const p95 = event.p95AtW1Qualification ?? event.p95AtQualification;
  lines.push(`P95: ${formatUsd(p95)}`);
  lines.push(`Episode: ${formatUsd(event.totalEpisodePressure)}`);
  lines.push("");

  for (const w of event.waveHistory) {
    const durationMs = w.extremeTs - w.anchorTs;
    lines.push(
      `W${w.waveNumber} · ${formatUsd(w.liqNotionalUsd)} · ${w.liqEvents} events · ${formatDuration(durationMs)}`,
    );
    const reclaimPart =
      w.reclaimPrice !== null
        ? ` · reclaim ${formatPrice(w.reclaimPrice)}`
        : "";
    lines.push(
      `    max ${formatUsd(w.maxSingleEventUsd)} · anchor ${formatPrice(w.anchorPrice)} → extreme ${formatPrice(w.extremePrice)}${reclaimPart}`,
    );
    lines.push("");
  }

  // Sep 8 2026, operator-approved (Karo) -- ALWAYS shown, on EVERY
  // instance, regardless of that instance's own v5BtcBlockEnabled()
  // setting -- see btcIntendedSideAtSignalTime's own doc comment.
  // Presentation-only change here: same computation, more compact line.
  if (event.symbol !== "BTCUSDT") {
    const wouldBlock =
      event.btcIntendedSideAtSignalTime !== null &&
      event.btcIntendedSideAtSignalTime === event.side;
    lines.push(
      wouldBlock
        ? `⚠️ BTC_BLOCK would apply here: YES (active ${event.btcIntendedSideAtSignalTime} setup, same side)`
        : `BTC_BLOCK would apply here: NO`,
    );
  } else {
    lines.push(
      `BTC_BLOCK would apply here: YES, unconditionally (BTC itself never trades when V5_BTC_BLOCK=true)`,
    );
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatV5CloseMessage(
  symbol: string,
  side: string,
  outcome: "TP" | "SL",
  entry: number,
  closePrice: number,
  entryWaveNumber: number,
  // Sep 10 2026 (Karo), operator-requested -- ADDITIVE, optional
  // (default null/undefined keeps every EXISTING call-site's own
  // output byte-identical). Kept as a parameter (unused, "Candidate:"
  // line removed per Sep 11 2026 redesign) so no call-site needs to
  // change its own argument list.
  timeframe?: "1m" | "3m" | "5m" | null,
  signalId?: string,
  // Sep 11 2026 (Karo), operator-requested -- ADDITIVE, optional
  // (default undefined keeps every call-site not yet passing it
  // byte-identical). Trade duration in ms, when the caller has both
  // the open and close timestamps available.
  durationMs?: number,
): string {
  void timeframe;
  const emoji = outcome === "TP" ? "✅" : "❌";
  const pnlPct =
    side === "LONG"
      ? (closePrice - entry) / entry
      : (entry - closePrice) / entry;

  const lines = [`${emoji} V5 CLOSE ${symbol} ${side} · ${outcome}`, ""];
  lines.push(`Entry: ${formatPrice(entry)}`);
  lines.push(`Exit: ${formatPrice(closePrice)}`);
  lines.push(`PnL: ${pnlPct >= 0 ? "+" : ""}${formatPct(pnlPct * 100)}`);
  if (durationMs !== undefined)
    lines.push(`Duration: ${formatDuration(durationMs)}`);
  lines.push(`Entered: W${entryWaveNumber}`);
  if (signalId) {
    lines.push("");
    lines.push(`SignalId: ${signalId}`);
  }
  return lines.join("\n");
}
