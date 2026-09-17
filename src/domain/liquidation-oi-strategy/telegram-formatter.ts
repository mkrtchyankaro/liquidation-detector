import type { Side } from "../../shared/common.types";
import type { OrderBookObservation } from "./order-book-observation";
import { formatSignedPct } from "./pnl-calculator";

/**
 * Sep 17 2026 (Karo), operator-requested Section 7. Pure string
 * builders only -- no Telegram client, no Mongo, no Binance. Every
 * call site wraps the actual .sendMessage() in its own try/catch so a
 * Telegram failure here can never affect trading logic. This file is
 * the ONLY place LOX message text is constructed.
 */

function fmtNum(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined ? "N/A" : n.toFixed(digits);
}
function fmtOrderBookSection(
  ob: OrderBookObservation | null,
  candidateSide: Side,
): string {
  if (ob === null) return "";
  const relevantWall =
    candidateSide === "LONG"
      ? ob.strongestNearbyBidWall
      : ob.strongestNearbyAskWall;
  const label = candidateSide === "LONG" ? "BUY wall" : "SELL wall";
  if (relevantWall === null) return "";
  const lines: string[] = ["", "Book:"];
  lines.push(
    `${label} $${(relevantWall.notionalUsd / 1000).toFixed(0)}k @ ${relevantWall.price}`,
  );
  if (relevantWall.distanceFromPriceAtr !== null)
    lines.push(`Distance: ${relevantWall.distanceFromPriceAtr.toFixed(2)} ATR`);
  return lines.join("\n");
}
function durationLabel(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

export function formatWatchMessage(
  symbol: string,
  candidateSide: Side,
  sameDirectionLiqUsd: number,
  percentileRank: number,
  displacementAtr: number,
  oiDestructionFraction: number | null,
  orderBook: OrderBookObservation | null,
): string {
  const lines = [
    `${symbol} ${candidateSide} \u2014 WATCH`,
    "",
    `Liq: $${(sameDirectionLiqUsd / 1_000_000).toFixed(2)}M | Rank: ${percentileRank.toFixed(0)}`,
    `Displacement: ${displacementAtr.toFixed(2)} ATR`,
    `OI destruction: ${oiDestructionFraction !== null ? `${(oiDestructionFraction * 100).toFixed(1)}%` : "N/A"}`,
    "OI: clearing not yet confirmed",
    fmtOrderBookSection(orderBook, candidateSide),
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function formatPaperEntryMessage(
  symbol: string,
  candidateSide: Side,
  entryPrice: number,
  tpPrice: number,
  strategyInvalidationPrice: number,
  sameDirectionLiqUsd: number,
  percentileRank: number,
  counterMoveAtr: number,
  riskUsd: number,
  orderBook: OrderBookObservation | null,
): string {
  const tpPct = formatSignedPct(pctMove(candidateSide, entryPrice, tpPrice));
  const slPct = formatSignedPct(
    pctMove(candidateSide, entryPrice, strategyInvalidationPrice),
  );
  const lines = [
    `${symbol} ${candidateSide} \u2014 ENTRY \ud83d\udcdd PAPER`,
    "",
    `Entry: ${entryPrice}`,
    `TP: ${tpPrice} (${tpPct})`,
    `SL: ${strategyInvalidationPrice} (${slPct})`,
    "",
    `Liq: $${(sameDirectionLiqUsd / 1_000_000).toFixed(2)}M | Rank: ${percentileRank.toFixed(0)}`,
    "OI clearing: \u2713",
    `Recovery: ${counterMoveAtr.toFixed(2)} ATR`,
    fmtOrderBookSection(orderBook, candidateSide),
    "",
    `Risk model: $${fmtNum(riskUsd)}`,
    "Mode: PAPER \u2014 NO BINANCE ORDER",
  ];
  return lines
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n\n\n+/g, "\n\n");
}

export function formatRealEntryMessage(
  symbol: string,
  candidateSide: Side,
  entryPrice: number,
  quantity: number,
  riskUsd: number,
  tpPrice: number,
  strategyInvalidationPrice: number,
  emergencyHardStopPrice: number,
  sameDirectionLiqUsd: number,
  percentileRank: number,
  protectionConfirmed: boolean,
): string {
  const tpPct = formatSignedPct(pctMove(candidateSide, entryPrice, tpPrice));
  const slPct = formatSignedPct(
    pctMove(candidateSide, entryPrice, strategyInvalidationPrice),
  );
  const emergPct = formatSignedPct(
    pctMove(candidateSide, entryPrice, emergencyHardStopPrice),
  );
  return [
    `${symbol} ${candidateSide} \u2014 ENTRY \ud83d\udd34 LIVE`,
    "",
    `Entry: ${entryPrice}`,
    `Qty: ${quantity}`,
    `Risk: $${fmtNum(riskUsd)}`,
    "",
    `TP: ${tpPrice} (${tpPct})`,
    `Strategy SL: ${strategyInvalidationPrice} (${slPct})`,
    `Emergency stop: ${emergencyHardStopPrice} (${emergPct})`,
    "",
    `Protection: ${protectionConfirmed ? "CONFIRMED" : "NOT CONFIRMED -- see cleanup/logs"}`,
    "",
    `Liq: $${(sameDirectionLiqUsd / 1_000_000).toFixed(2)}M | Rank: ${percentileRank.toFixed(0)}`,
    "OI clearing: \u2713",
  ].join("\n");
}

export function formatTpUpdateMessage(
  symbol: string,
  candidateSide: Side,
  entryPrice: number,
  oldTp: number,
  newTp: number,
  revision: number,
  reason: string,
  mode: "PAPER" | "REAL",
  realReplaced: boolean | null,
): string {
  const oldPct = formatSignedPct(pctMove(candidateSide, entryPrice, oldTp));
  const newPct = formatSignedPct(pctMove(candidateSide, entryPrice, newTp));
  const modeLine =
    mode === "PAPER"
      ? "Mode: PAPER"
      : `Mode: LIVE | Binance TP replaced ${realReplaced ? "\u2713" : "\u2717 FAILED -- previous TP retained"}`;
  return [
    `${symbol} ${candidateSide} \u2014 TP UPDATED`,
    "",
    `Old TP: ${oldTp} (${oldPct})`,
    `New TP: ${newTp} (${newPct})`,
    "",
    `Reason: ${reason}`,
    `Revision: ${revision}`,
    "",
    modeLine,
  ].join("\n");
}

export function formatMarketExitMessage(
  symbol: string,
  candidateSide: Side,
  reason: string,
  entryPrice: number,
  exitRefPrice: number,
): string {
  const movePct = formatSignedPct(
    pctMove(candidateSide, entryPrice, exitRefPrice),
  );
  return [
    `${symbol} ${candidateSide} \u2014 MARKET EXIT`,
    "",
    `Reason: ${reason}`,
    "",
    `Entry: ${entryPrice}`,
    `Exit ref: ${exitRefPrice}`,
    `Move: ${movePct}`,
    "",
    "MAIN thesis invalidated.",
  ].join("\n");
}

const CLOSE_LABELS: Record<string, string> = {
  TP_FILLED: "\u2705 TP",
  STRATEGY_INVALIDATION: "\u274c SL",
  ADVERSE_OI_PRICE_EFFICIENCY_FLIP: "\u26a0\ufe0f THESIS FLIP",
  EMERGENCY_STOP: "\ud83d\udea8 EMERGENCY STOP",
  POSITION_CLOSED_EXTERNALLY: "\u2753 EXTERNAL",
  DYNAMIC_EXIT: "\u26a0\ufe0f DYNAMIC EXIT",
  MANUAL_CLOSE: "\ud83d\udc64 MANUAL",
  PROTECTION_FAILED: "\u26a0\ufe0f PROTECTION FAILED",
  EXECUTION_FAILED: "\u26a0\ufe0f EXECUTION FAILED",
  USER_STRATEGY_EXECUTION_DISABLED: "USER DISABLED",
};

export interface CloseMessageInput {
  symbol: string;
  candidateSide: Side;
  terminalReason: string;
  entryPrice: number;
  exitPrice: number | null;
  tpAtClose: number | null;
  durationMs: number | null;
  mode: "PAPER" | "REAL";
  paperGrossPnlUsd?: number | null;
  realActualPnlUsd?: number | null;
  realFeesUsd?: number | null;
  realNetPnlUsd?: number | null;
  cleanupState?: string;
}

/** Never labels a loss "SL" unless the reason genuinely was
 *  STRATEGY_INVALIDATION -- every reason gets its own stable label,
 *  per the operator's own explicit instruction. */
export function formatCloseMessage(input: CloseMessageInput): string {
  const label = CLOSE_LABELS[input.terminalReason] ?? input.terminalReason;
  const exitPriceLabel =
    input.exitPrice !== null ? String(input.exitPrice) : "N/A";
  const movePct =
    input.exitPrice !== null
      ? formatSignedPct(
          pctMove(input.candidateSide, input.entryPrice, input.exitPrice),
        )
      : "N/A";
  const lines = [
    `${input.symbol} ${input.candidateSide} \u2014 CLOSED ${label}`,
    "",
    `Entry: ${input.entryPrice}`,
    `Exit: ${exitPriceLabel}`,
    `Move: ${movePct}`,
  ];
  if (input.tpAtClose !== null)
    lines.push(
      `TP at close: ${input.tpAtClose} (${formatSignedPct(pctMove(input.candidateSide, input.entryPrice, input.tpAtClose))})`,
    );
  if (input.durationMs !== null)
    lines.push(`Duration: ${durationLabel(input.durationMs)}`);
  lines.push("");
  if (input.mode === "PAPER") {
    lines.push(
      `Paper PnL: ${input.paperGrossPnlUsd !== null && input.paperGrossPnlUsd !== undefined ? (input.paperGrossPnlUsd >= 0 ? "+" : "") + "$" + input.paperGrossPnlUsd.toFixed(2) : "N/A"}`,
    );
    lines.push("Mode: PAPER");
  } else {
    lines.push(
      `Actual PnL: ${input.realActualPnlUsd !== null && input.realActualPnlUsd !== undefined ? "$" + input.realActualPnlUsd.toFixed(2) : "N/A (not yet provable)"}`,
    );
    if (input.realFeesUsd !== null && input.realFeesUsd !== undefined)
      lines.push(`Fees: $${input.realFeesUsd.toFixed(2)}`);
    if (input.realNetPnlUsd !== null && input.realNetPnlUsd !== undefined)
      lines.push(`Net PnL: $${input.realNetPnlUsd.toFixed(2)}`);
    lines.push(`Cleanup: ${input.cleanupState ?? "PENDING"}`);
  }
  return lines.join("\n");
}

export function formatCleanupFailureMessage(
  symbol: string,
  userId: string,
  reason: string,
): string {
  return [
    `${symbol} \u2014 CLEANUP FAILURE`,
    "",
    `User: ${userId}`,
    `Reason: ${reason}`,
    "",
    "Will retry automatically. Manual review recommended if this persists.",
  ].join("\n");
}

function pctMove(
  side: Side,
  entryPrice: number,
  referencePrice: number,
): number {
  return side === "LONG"
    ? ((referencePrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - referencePrice) / entryPrice) * 100;
}
