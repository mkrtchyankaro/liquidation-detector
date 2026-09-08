import type { ExecutionResult } from "../../infrastructure/binance/binance-execution.service";
import type { WallSnapshots } from "../../domain/trading/trade-plan";
import type { GlobalSignalDoc } from "../../domain/signal/global-signal.model";
import type { UserSignalDoc } from "../../domain/signal/user-signal.model";

export interface GlobalSignalRepositoryPort {
  insert(doc: GlobalSignalDoc): Promise<void>;
}

export interface UserSignalRepositoryPort {
  upsert(userId: string, doc: UserSignalDoc): Promise<void>;
  findOpen(userId: string): Promise<UserSignalDoc[]>;
  findBySignalId(userId: string, signalId: string): Promise<UserSignalDoc | null>;
}

export interface NotificationPort {
  send(userId: string, message: string): Promise<void>;
}

/** Matches BinanceExecutionService's own real method surface exactly
 *  -- application-layer code never imports BinanceExecutionService
 *  directly, only this port. */
export interface ExecutionPort {
  readonly isLiveArmed: boolean;
  run(input: {
    symbol: string;
    side: "LONG" | "SHORT";
    entry: number;
    stopLoss: number;
    takeProfit: number;
    riskUsd: number;
    positionSizeUsdt: number;
    signalId: string;
    cumLiq: number;
    liqBaseline: number;
    atr15mPct: number;
    walls: WallSnapshots;
  }): Promise<ExecutionResult>;
  reconcileLivePosition(
    symbol: string,
    slOrderId: number | null,
    tpOrderId: number | null,
    signalId: string,
  ): Promise<
    | { stillOpen: true }
    | { stillOpen: false; reason: "TP" | "SL"; actualPrice: number }
    | { stillOpen: false; reason: "UNKNOWN" }
  >;
  recordConfirmedClose(signalId: string, reason: "TP" | "SL"): Promise<void>;
}
