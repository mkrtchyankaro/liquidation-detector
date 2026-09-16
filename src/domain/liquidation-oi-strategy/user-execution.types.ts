import type { Side } from "../../shared/common.types";
import type {
  UserExecutionState,
  CleanupState,
  UserTerminalReason,
} from "./lifecycle.types";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 5-7.
 * Per-user execution record for the Liquidation+OI Exhaustion
 * strategy -- structurally separate from V3/V5's own UserSignalDoc,
 * never written to v5_signals_<userId>.
 */
export interface LiquidationOiUserExecutionState {
  userId: string;
  globalSignalId: string;
  symbol: string;
  side: Side;
  state: UserExecutionState;
  terminalReason: UserTerminalReason | null;
  cleanupState: CleanupState;

  riskUsd: number;
  entryPrice: number | null;
  quantity: number | null;
  positionSizeUsdt: number | null;

  entryClientOrderId: string | null;
  entryBinanceOrderId: number | null;
  emergencyStopClientAlgoId: string | null;
  emergencyStopBinanceAlgoId: number | null;
  emergencyStopPrice: number | null;
  estimatedEmergencyMaxLossUsd: number | null;
  tpClientOrderId: string | null;
  tpBinanceOrderId: number | null;
  tpPrice: number | null;
  appliedTpRevision: number;

  estimatedStrategyLossUsd: number | null;
  expectedTpPnlUsd: number | null;
  realizedPnlUsd: number | null;
  pnlSource: "ESTIMATED" | "REALIZED" | null;

  createdAt: number;
  updatedAt: number;
}

export function newPendingUserExecution(
  userId: string,
  globalSignalId: string,
  symbol: string,
  side: Side,
  riskUsd: number,
  now: number,
): LiquidationOiUserExecutionState {
  return {
    userId,
    globalSignalId,
    symbol,
    side,
    state: "PENDING",
    terminalReason: null,
    cleanupState: "PENDING",
    riskUsd,
    entryPrice: null,
    quantity: null,
    positionSizeUsdt: null,
    entryClientOrderId: null,
    entryBinanceOrderId: null,
    emergencyStopClientAlgoId: null,
    emergencyStopBinanceAlgoId: null,
    emergencyStopPrice: null,
    estimatedEmergencyMaxLossUsd: null,
    tpClientOrderId: null,
    tpBinanceOrderId: null,
    tpPrice: null,
    appliedTpRevision: 0,
    estimatedStrategyLossUsd: null,
    expectedTpPnlUsd: null,
    realizedPnlUsd: null,
    pnlSource: null,
    createdAt: now,
    updatedAt: now,
  };
}
