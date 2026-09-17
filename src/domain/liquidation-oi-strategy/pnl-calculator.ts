import type { Side } from "../../shared/common.types";

/**
 * Sep 17 2026 (Karo), operator-requested Sections 6/9. Every LOX
 * percentage/PnL number, PAPER or REAL, comes from here -- no
 * duplicated sign logic scattered through Telegram or persistence
 * code. `side` here is the CANDIDATE side (the direction actually
 * traded), matching candidateTradeSideForVictim()'s own output.
 */

export function pctMoveFromEntry(
  side: Side,
  entryPrice: number,
  referencePrice: number,
): number {
  const raw =
    side === "LONG"
      ? (referencePrice - entryPrice) / entryPrice
      : (entryPrice - referencePrice) / entryPrice;
  return raw * 100;
}

export function formatSignedPct(pct: number, digits = 2): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(digits)}%`;
}

export interface PaperPnlInput {
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  simulatedFeesUsd?: number | null;
}
export interface PaperPnlResult {
  grossPnlUsd: number;
  priceMovePct: number;
  simulatedFeesUsd: number | null;
  paperNetPnlUsd: number | null;
}

export function computePaperPnl(input: PaperPnlInput): PaperPnlResult {
  const grossPnlUsd =
    input.side === "LONG"
      ? (input.exitPrice - input.entryPrice) * input.quantity
      : (input.entryPrice - input.exitPrice) * input.quantity;
  const priceMovePct = pctMoveFromEntry(
    input.side,
    input.entryPrice,
    input.exitPrice,
  );
  const simulatedFeesUsd = input.simulatedFeesUsd ?? null;
  const paperNetPnlUsd =
    simulatedFeesUsd !== null ? grossPnlUsd - simulatedFeesUsd : null;
  return { grossPnlUsd, priceMovePct, simulatedFeesUsd, paperNetPnlUsd };
}
