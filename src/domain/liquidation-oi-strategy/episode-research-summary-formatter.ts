import type { EpisodeResearchRecord } from "./episode-research-recorder";
import { formatCompactUsd, formatPct } from "./telegram-display-format";

/**
 * Sep 19 2026 (Karo), operator-requested Episode Research capture --
 * Section 9's own "readable episode summary". Deliberately NOT part
 * of the main ENTRY Telegram message (that one already carries
 * Recovery Flow -- see telegram-formatter.ts's own formatEntryMessage/
 * formatRecoveryFlowLine) -- this is for the structured DB/debug log
 * line at episode finalization (onEntry / onEpisodeTerminal), per the
 * operator's own explicit instruction to keep the Telegram signal
 * itself short and put full detail in logs/DB instead.
 */

function fmtBasisBps(bps: number | null): string {
  return bps !== null ? `${bps >= 0 ? "+" : ""}${bps.toFixed(1)} bps` : "N/A";
}

function fmtPctOrNa(pct: number | null): string {
  return pct !== null ? formatPct(pct) : "N/A";
}

export function formatEpisodeResearchSummary(record: EpisodeResearchRecord): string {
  const entered = record.entrySnapshot !== null;
  const lines: string[] = [
    "LIQUIDATION EPISODE SUMMARY",
    `${record.symbol} / ${record.victim}`,
    `Start ${new Date(record.episodeStartSnapshot.ts).toISOString()} \u2192 Extreme ${record.finalExtremeSnapshot ? new Date(record.finalExtremeSnapshot.ts).toISOString() : "N/A"} \u2192 End ${record.episodeEndSnapshot ? new Date(record.episodeEndSnapshot.ts).toISOString() : "N/A"}`,
    `End reason: ${record.endReason ?? "N/A"} / Entry: ${entered ? "YES" : "NO"}`,
    `Total liquidation: ${formatCompactUsd(record.flushFlow?.totalObservedLiquidationUsd ?? 0)} / ${record.liquidationEventSnapshots.length} events`,
    `Start:  Spot ${record.episodeStartSnapshot.market.spotMid?.toFixed(4) ?? "N/A"} / Futures ${record.episodeStartSnapshot.market.futuresMid?.toFixed(4) ?? "N/A"} / basis ${fmtBasisBps(record.episodeStartSnapshot.market.basisBps)}`,
  ];
  if (record.finalExtremeSnapshot !== null) {
    lines.push(`Extreme: Spot ${record.finalExtremeSnapshot.market.spotMid?.toFixed(4) ?? "N/A"} / Futures ${record.finalExtremeSnapshot.market.futuresMid?.toFixed(4) ?? "N/A"} / basis ${fmtBasisBps(record.finalExtremeSnapshot.market.basisBps)}`);
  }
  const endOrEntry = record.entrySnapshot ?? record.episodeEndSnapshot;
  if (endOrEntry !== null) {
    lines.push(`${entered ? "Entry" : "End"}:   Spot ${endOrEntry.market.spotMid?.toFixed(4) ?? "N/A"} / Futures ${endOrEntry.market.futuresMid?.toFixed(4) ?? "N/A"} / basis ${fmtBasisBps(endOrEntry.market.basisBps)}`);
  }
  if (record.flushFlow !== null) {
    lines.push(`Flush  Futures: Buy ${formatCompactUsd(record.flushFlow.futuresBuyUsd)} / Sell ${formatCompactUsd(record.flushFlow.futuresSellUsd)} / Delta ${formatCompactUsd(record.flushFlow.futuresDelta)}`);
    lines.push(`Flush  Spot:    Buy ${formatCompactUsd(record.flushFlow.spotBuyUsd)} / Sell ${formatCompactUsd(record.flushFlow.spotSellUsd)} / Delta ${formatCompactUsd(record.flushFlow.spotDelta)}`);
    lines.push(`Flush  OI delta: ${fmtPctOrNa(record.flushFlow.oiDeltaPct)}`);
  }
  if (record.recoveryFlow !== null) {
    lines.push(`Recovery Futures: Buy ${formatCompactUsd(record.recoveryFlow.futuresBuyUsd)} / Sell ${formatCompactUsd(record.recoveryFlow.futuresSellUsd)} / Delta ${formatCompactUsd(record.recoveryFlow.futuresDelta)}`);
    lines.push(`Recovery Spot:    Buy ${formatCompactUsd(record.recoveryFlow.spotBuyUsd)} / Sell ${formatCompactUsd(record.recoveryFlow.spotSellUsd)} / Delta ${formatCompactUsd(record.recoveryFlow.spotDelta)}`);
    lines.push(`Recovery OI delta: ${fmtPctOrNa(record.recoveryFlow.oiDeltaPct)}`);
  }
  if (record.basisRecovery !== null) {
    lines.push(`Basis closed: ${fmtPctOrNa(record.basisRecovery.basisClosedPct)} / Convergence: ${record.basisRecovery.convergenceDirection}`);
  }
  lines.push(entered ? `Entry reason: ${record.entryReason ?? "N/A"}` : `No-entry reason: ${record.noEntryReason ?? "N/A"}`);
  return lines.join("\n");
}
