import type { Side } from "../../shared/common.types";
import type { OrderBookObservation } from "./order-book-observation";

/**
 * Sep 17 2026 (Karo), operator-requested production-completion pass,
 * Sections F/Q. Pure string builders only -- no Telegram client, no
 * Mongo, no Binance. Every call site wraps the actual .sendMessage()
 * call in its own try/catch so a Telegram failure here can never
 * affect trading logic.
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
  const lines: string[] = ["", "Book observation:"];
  if (relevantWall !== null) {
    lines.push(
      `${label}: $${(relevantWall.notionalUsd / 1000).toFixed(0)}k @ ${relevantWall.price}`,
    );
    if (relevantWall.distanceFromPriceAtr !== null)
      lines.push(
        `Distance: ${relevantWall.distanceFromPriceAtr.toFixed(2)} ATR`,
      );
  } else {
    lines.push(`${label}: N/A`);
  }
  if (ob.depthImbalance !== null)
    lines.push(`Depth imbalance: ${ob.depthImbalance.toFixed(2)}`);
  return lines.join("\n");
}

export function formatWatchMessage(
  symbol: string,
  candidateSide: Side,
  sameDirectionLiqUsd: number,
  percentileRank: number,
  displacementAtr: number,
): string {
  return [
    `${symbol} ${candidateSide} \u2014 WATCH`,
    "",
    `Liq: $${(sameDirectionLiqUsd / 1_000_000).toFixed(2)}M | Rank: ${percentileRank.toFixed(0)}`,
    `Displacement: ${displacementAtr.toFixed(2)} ATR`,
    "",
    "Mode: WATCHING for OI clearing + counter-move",
  ].join("\n");
}

export function formatEntryReadyMessage(
  symbol: string,
  candidateSide: Side,
  sameDirectionLiqUsd: number,
  percentileRank: number,
  extremePrice: number,
  entryRef: number,
  oiDestructionFraction: number | null,
  counterMoveAtr: number,
  distanceFromExtremeAtr: number,
  strategyInvalidationPrice: number,
  initialTpPrice: number,
  orderBook: OrderBookObservation | null,
  observationOnly: boolean,
): string {
  const lines = [
    `${symbol} ${candidateSide} \u2014 ENTRY READY`,
    "",
    `Liq: $${(sameDirectionLiqUsd / 1_000_000).toFixed(2)}M | Rank: ${percentileRank.toFixed(0)}`,
    `Extreme: ${extremePrice}`,
    `Entry ref: ${entryRef}`,
    `OI destruction: ${oiDestructionFraction !== null ? `-${(oiDestructionFraction * 100).toFixed(2)}%` : "N/A"}`,
    "OI clearing: YES",
    `Recovery: ${counterMoveAtr.toFixed(2)} ATR`,
    `Distance: ${distanceFromExtremeAtr.toFixed(2)} ATR`,
    fmtOrderBookSection(orderBook, candidateSide),
    "",
    `Strategy invalidation: ${strategyInvalidationPrice}`,
    `Initial TP: ${initialTpPrice}`,
    "",
    observationOnly
      ? "Mode: OBSERVATION \u2014 NO ORDER"
      : "Mode: LIVE EXECUTION ATTEMPT",
  ];
  return lines
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n\n\n+/g, "\n\n");
}

export function formatRealEntryMessage(
  symbol: string,
  candidateSide: Side,
  riskUsd: number,
  fillPrice: number,
  quantity: number,
  strategyInvalidationPrice: number,
  emergencyHardStopPrice: number,
  estimatedStrategyLossUsd: number,
  estimatedEmergencyMaxLossUsd: number,
  tpPrice: number,
): string {
  return [
    `${symbol} ${candidateSide} ENTRY (Liquidation+OI Exhaustion)`,
    `Risk: $${fmtNum(riskUsd)}`,
    `Fill: ${fillPrice}`,
    `Qty: ${quantity}`,
    `Strategy invalidation: ${strategyInvalidationPrice}`,
    `Emergency hard stop: ${emergencyHardStopPrice}`,
    `Est. strategy loss: $${fmtNum(estimatedStrategyLossUsd)}`,
    `Est. emergency max loss: $${fmtNum(estimatedEmergencyMaxLossUsd)}`,
    `TP: ${tpPrice}`,
  ].join("\n");
}
