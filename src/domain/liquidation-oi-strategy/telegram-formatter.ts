import type { Side } from "../../shared/common.types";
import type { OrderBookObservation } from "./order-book-observation";
import type { OrderFlowFrozenStats } from "./order-flow-episode-tracker";
import { pctMoveFromEntry } from "./pnl-calculator";
import { formatPrice, formatSignedUsd, formatCompactUsd, formatPct, formatUtcTime, formatDuration } from "./telegram-display-format";

/**
 * Sep 17 2026 (Karo), operator-requested Telegram UX redesign pass.
 * Pure string builders only -- no Telegram client, no Mongo, no
 * Binance. Every call site wraps the actual .sendMessage() in its
 * own try/catch so a Telegram failure here can never affect trading
 * logic. This file is the ONLY place LOX message text is
 * constructed. WATCH is deliberately no longer formatted here --
 * WATCH state/logic remains fully operational internally, it simply
 * produces no user-facing Telegram message (operator Section B).
 */

const SEP = "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501";

function fmtOrderBookLine(ob: OrderBookObservation | null, candidateSide: Side): string | null {
  if (ob === null) return null;
  const wall = candidateSide === "LONG" ? ob.strongestNearbyBidWall : ob.strongestNearbyAskWall;
  if (wall === null) return null;
  const label = candidateSide === "LONG" ? "BUY" : "SELL";
  const distance = wall.distanceFromPriceAtr !== null ? ` (${wall.distanceFromPriceAtr.toFixed(2)} ATR)` : "";
  return `\ud83d\udcd6 Book      ${label} ${formatCompactUsd(wall.notionalUsd)} @ ${formatPrice(wall.price)}${distance}`;
}

export interface EntryMessageInput {
  symbol: string; candidateSide: Side; mode: "PAPER" | "REAL";
  globalSignalId: string; entryTimestamp: number;
  entryPrice: number; quantity: number; riskUsd: number;
  tpPrice: number; strategyInvalidationPrice: number;
  sameDirectionLiqUsd: number; percentileRank: number; oiMetricLine: string | null; counterMoveAtr: number;
  orderBook: OrderBookObservation | null;
  protectionConfirmed: boolean | null;
  displayName: string;
  /** Sep 17 2026 (Karo), operator-approved final capacity architecture
   *  -- netRR is CALCULATED/REPORTED here, never a mandatory entry
   *  gate (see trade-economics.ts's own doc comment). null if not
   *  available (should not happen for a real ENTRY_READY signal). */
  netRR: number | null;
  capacityAtr: number | null;
  /** Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
   *  observation -- a pre-formatted, multi-line block (see
   *  formatFlowLine below), or null if no order-flow tracker is wired
   *  up. Purely observational -- never affects any price/size above. */
  flowLine: string | null;
}

/** Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
 *  observation. Pure formatter -- takes the already-frozen,
 *  already-classified stats and produces the exact concise block the
 *  operator specified. Handles the "Spot data unavailable" case by
 *  printing SPOT: N/A rather than fabricating zeros. */
export function formatFlowLine(stats: OrderFlowFrozenStats): string {
  const spot = stats.spotDataAvailable
    ? `SPOT: Buy ${formatCompactUsd(stats.spotTakerBuyUsd)} | Sell ${formatCompactUsd(stats.spotTakerSellUsd)} | Imb ${formatPct(stats.spotImbalancePct)}`
    : "SPOT: N/A";
  const oiPart = stats.oiDeltaPct !== null ? formatPct(stats.oiDeltaPct) : "n/a";
  const spotLabel = stats.spotConfirmationLabel.replace("SPOT_", "");
  const movePart = stats.futuresOiMoveLabel ?? "N/A";
  return [
    "Flow (episode)",
    `FUT: Buy ${formatCompactUsd(stats.futuresTakerBuyUsd)} | Sell ${formatCompactUsd(stats.futuresTakerSellUsd)} | Imb ${formatPct(stats.futuresImbalancePct)}`,
    spot,
    `OI: ${oiPart} | Spot: ${spotLabel} | Move: ${movePart}`,
  ].join("\n");
}

export function formatEntryMessage(input: EntryMessageInput): string {
  const headerEmoji = input.mode === "PAPER" ? "\ud83d\udfe2" : "\ud83d\udd34";
  const modeTag = input.mode === "PAPER" ? "PAPER" : "LIVE";
  const positionNotional = input.entryPrice * input.quantity;
  const tpPct = pctMoveFromEntry(input.candidateSide, input.entryPrice, input.tpPrice);
  const slPct = pctMoveFromEntry(input.candidateSide, input.entryPrice, input.strategyInvalidationPrice);
  const tpUsd = input.candidateSide === "LONG" ? (input.tpPrice - input.entryPrice) * input.quantity : (input.entryPrice - input.tpPrice) * input.quantity;
  const slUsd = input.candidateSide === "LONG" ? (input.strategyInvalidationPrice - input.entryPrice) * input.quantity : (input.entryPrice - input.strategyInvalidationPrice) * input.quantity;

  const lines: string[] = [
    `${headerEmoji} ${input.symbol} \u00b7 ${input.candidateSide} \u00b7 ${modeTag}`,
    SEP,
    `\ud83d\udccd ENTRY  \u00b7  ${formatUtcTime(input.entryTimestamp)}`,
    `\ud83c\udd94 ${input.globalSignalId}`,
    "",
    `Entry     ${formatPrice(input.entryPrice)}`,
    `TP        ${formatPrice(input.tpPrice)}  (${formatPct(tpPct)})  \u2502 ${formatSignedUsd(tpUsd)}`,
    `SL        ${formatPrice(input.strategyInvalidationPrice)}  (${formatPct(slPct)})  \u2502 ${formatSignedUsd(slUsd)}`,
  ];
  // Sep 19 2026 (Karo), operator-requested REVISION -- no more separate
  // "Emergency" line: strategyInvalidationPrice IS now the real resting
  // Binance SL order itself for REAL users (see
  // liquidation-oi-user-execution.service.ts's own doc comment), not a
  // distinct, wider catastrophe-only buffer. The "SL" line above already
  // shows the one price that matters.
  lines.push(
    "",
    `Risk      $${input.riskUsd.toFixed(2)}`,
    `Position  ${formatCompactUsd(positionNotional)}`,
    "",
    `\u26a1 Liq       ${formatCompactUsd(input.sameDirectionLiqUsd)}  \u00b7  P${input.percentileRank.toFixed(0)}`,
  );
  if (input.oiMetricLine !== null) lines.push(input.oiMetricLine);
  lines.push(`\u2197 Recovery  ${input.counterMoveAtr.toFixed(2)} ATR`);
  if (input.capacityAtr !== null) lines.push(`\ud83c\udfaf Capacity  ${input.capacityAtr.toFixed(2)} ATR`);
  if (input.netRR !== null) lines.push(`\ud83d\udcca Net RR    ${input.netRR.toFixed(2)}`);
  const bookLine = fmtOrderBookLine(input.orderBook, input.candidateSide);
  if (bookLine !== null) lines.push(bookLine);
  if (input.flowLine !== null) lines.push("", input.flowLine);
  if (input.mode === "REAL") lines.push(`Protection ${input.protectionConfirmed ? "CONFIRMED \u2713" : "NOT CONFIRMED \u2717"}`);
  lines.push(SEP, `${input.displayName} \u00b7 ${modeTag}`);
  return lines.join("\n");
}

const CLOSE_HEADER: Record<string, { emoji: string; label: string }> = {
  TP_FILLED: { emoji: "\u2705", label: "TAKE PROFIT" },
  STRATEGY_INVALIDATION: { emoji: "\ud83d\udd34", label: "STOP LOSS" },
  ADVERSE_OI_PRICE_EFFICIENCY_FLIP: { emoji: "\u26a0\ufe0f", label: "MARKET EXIT" },
  DYNAMIC_EXIT: { emoji: "\u26a0\ufe0f", label: "MARKET EXIT" },
  SL_FILLED: { emoji: "\ud83d\udea8", label: "STOP LOSS" },
  POSITION_CLOSED_EXTERNALLY: { emoji: "\u2753", label: "EXTERNAL CLOSE" },
  MANUAL_CLOSE: { emoji: "\ud83d\udc64", label: "MANUAL CLOSE" },
  PROTECTION_FAILED: { emoji: "\u26a0\ufe0f", label: "PROTECTION FAILED" },
  EXECUTION_FAILED: { emoji: "\u26a0\ufe0f", label: "EXECUTION FAILED" },
  USER_STRATEGY_EXECUTION_DISABLED: { emoji: "\u26a0\ufe0f", label: "USER DISABLED" },
};
const REASON_TEXT: Record<string, string> = {
  ADVERSE_OI_PRICE_EFFICIENCY_FLIP: "OI / Price thesis invalidated",
  DYNAMIC_EXIT: "MAIN thesis exit",
};

export interface CloseMessageInput {
  symbol: string; candidateSide: Side; terminalReason: string;
  globalSignalId: string; terminalTimestamp: number;
  entryPrice: number; exitPrice: number | null; quantity: number | null; riskUsd: number | null;
  durationMs: number | null; mode: "PAPER" | "REAL";
  paperGrossPnlUsd?: number | null;
  realActualPnlUsd?: number | null; realFeesUsd?: number | null; realNetPnlUsd?: number | null; cleanupState?: string;
  displayName: string;
}

export function formatCloseMessage(input: CloseMessageInput): string {
  const header = CLOSE_HEADER[input.terminalReason] ?? { emoji: "\u2753", label: input.terminalReason };
  const modeTag = input.mode === "PAPER" ? "PAPER" : "LIVE";
  const exitKnown = input.exitPrice !== null;
  const movePct = exitKnown ? pctMoveFromEntry(input.candidateSide, input.entryPrice, input.exitPrice!) : null;
  const moveUsd = exitKnown && input.quantity !== null
    ? (input.candidateSide === "LONG" ? (input.exitPrice! - input.entryPrice) : (input.entryPrice - input.exitPrice!)) * input.quantity
    : null;

  const lines: string[] = [
    `${header.emoji} ${input.symbol} \u00b7 ${header.label}`,
    SEP,
    `\ud83c\udfc1 CLOSED  \u00b7  ${formatUtcTime(input.terminalTimestamp)}`,
    `\ud83c\udd94 ${input.globalSignalId}`,
    "",
  ];
  const reasonText = REASON_TEXT[input.terminalReason];
  if (reasonText !== undefined) lines.push(`Reason    ${reasonText}`, "");
  lines.push(
    `Entry     ${formatPrice(input.entryPrice)}`,
    `Exit      ${exitKnown ? formatPrice(input.exitPrice!) : "N/A"}`,
    "",
  );

  const resultLine = movePct !== null
    ? `Result    ${formatPct(movePct)}  \u2502 ${moveUsd !== null ? formatSignedUsd(moveUsd) : "N/A"}`
    : "Result    N/A";
  lines.push(resultLine);
  if (input.riskUsd !== null) lines.push(`Risk      $${input.riskUsd.toFixed(2)}`);
  if (input.durationMs !== null) lines.push(`Duration  ${formatDuration(input.durationMs)}`);

  if (input.mode === "REAL") {
    lines.push("");
    lines.push(`Actual PnL ${input.realActualPnlUsd !== null && input.realActualPnlUsd !== undefined ? formatSignedUsd(input.realActualPnlUsd) : "N/A (not yet provable)"}`);
    if (input.realFeesUsd !== null && input.realFeesUsd !== undefined) lines.push(`Fees       $${input.realFeesUsd.toFixed(2)}`);
    if (input.realNetPnlUsd !== null && input.realNetPnlUsd !== undefined) lines.push(`Net PnL    ${formatSignedUsd(input.realNetPnlUsd)}`);
    lines.push(`Cleanup    ${input.cleanupState ?? "PENDING"}`);
  }

  lines.push(SEP, `${input.displayName} \u00b7 ${modeTag}`);
  return lines.join("\n");
}

export interface TpUpdateMessageInput {
  symbol: string; candidateSide: Side; globalSignalId: string;
  entryPrice: number; quantity: number; oldTp: number; newTp: number; revision: number;
  mode: "PAPER" | "REAL"; realReplaced: boolean | null; displayName: string;
  oldCapacityAtr: number | null; newCapacityAtr: number | null;
}

export function formatTpUpdateMessage(input: TpUpdateMessageInput): string {
  const oldPct = pctMoveFromEntry(input.candidateSide, input.entryPrice, input.oldTp);
  const newPct = pctMoveFromEntry(input.candidateSide, input.entryPrice, input.newTp);
  const oldUsd = (input.candidateSide === "LONG" ? (input.oldTp - input.entryPrice) : (input.entryPrice - input.oldTp)) * input.quantity;
  const newUsd = (input.candidateSide === "LONG" ? (input.newTp - input.entryPrice) : (input.entryPrice - input.newTp)) * input.quantity;
  const modeLine = input.mode === "PAPER" ? `${input.displayName} \u00b7 PAPER` : `${input.displayName} \u00b7 LIVE${input.realReplaced === false ? " (replace FAILED -- previous TP retained)" : ""}`;

  const lines = [
    `\ud83d\udd04 ${input.symbol} \u00b7 TP UPDATED`,
    SEP,
    `\ud83c\udd94 ${input.globalSignalId}`,
    "",
    `Old TP    ${formatPrice(input.oldTp)} (${formatPct(oldPct)}) \u2502 ${formatSignedUsd(oldUsd)}`,
    `New TP    ${formatPrice(input.newTp)} (${formatPct(newPct)}) \u2502 ${formatSignedUsd(newUsd)}`,
  ];
  if (input.oldCapacityAtr !== null && input.newCapacityAtr !== null) {
    lines.push(`Capacity  ${input.oldCapacityAtr.toFixed(2)} \u2192 ${input.newCapacityAtr.toFixed(2)} ATR`);
  }
  lines.push(
    "",
    `Revision  ${input.revision}`,
    SEP,
    modeLine,
  );
  return lines.join("\n");
}
