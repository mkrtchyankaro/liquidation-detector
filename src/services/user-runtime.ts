import { BinanceRestClient } from "../infrastructure/binance/binanceRest.client";
import { BinanceExecutionService } from "../infrastructure/binance/binance-execution.service";
import { TelegramClient } from "../infrastructure/telegram/telegram.client";
import { DailyLossLimitTracker } from "../domain/trading/risk/daily-loss-limit.service";
import { InFlightGuard } from "../domain/trading/risk/in-flight-guard";
import { ReconciliationHealthTracker } from "../domain/trading/risk/reconciliation-health";
import { ExecutionRecordRepository } from "../infrastructure/mongo/execution-record.repository";
import { ExecutionClaimRepository } from "../infrastructure/mongo/execution-claim.repository";
import { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import type { UserConfig } from "../domain/user/user-config.model";

/**
 * Sep 8 2026 (Karo). Everything ONE user needs to independently:
 *   - execute on Binance (own API keys, own leverage/margin -- own
 *     BinanceRestClient, own BinanceExecutionService instance)
 *   - be notified on Telegram (own bot token/chatId)
 *   - be gated by their own daily loss limit (own DailyLossLimitTracker,
 *     reading THIS user's own accountBudgetUsd/dailyLossLimitPct --
 *     never a shared, global env var)
 *   - never race itself (own InFlightGuard, own ReconciliationHealthTracker)
 *   - persist to their own collections (own ExecutionRecordRepository/
 *     ExecutionClaimRepository, both scoped to userId)
 *
 * One failure isolation boundary: everything below belongs to exactly
 * ONE user. A thrown exception anywhere in this bundle's own usage
 * must never propagate into another user's bundle or into the global
 * strategy engine -- see services/signal-distributor.ts and
 * services/reconciliation-manager.ts, where every per-user call is
 * wrapped in its own try/catch.
 */
export interface UserRuntime {
  readonly config: UserConfig;
  readonly binanceRest: BinanceRestClient | null;
  readonly execution: BinanceExecutionService | null;
  readonly telegram: TelegramClient | null;
  readonly dailyLossLimit: DailyLossLimitTracker;
  readonly reconcileInFlight: InFlightGuard;
  readonly reconcileHealth: ReconciliationHealthTracker;
  readonly executionRecords: ExecutionRecordRepository | null;
  readonly executionClaims: ExecutionClaimRepository | null;
}

export function buildUserRuntime(config: UserConfig, mongo: MongoClientWrapper): UserRuntime {
  let binanceRest: BinanceRestClient | null = null;
  let execution: BinanceExecutionService | null = null;
  let executionRecords: ExecutionRecordRepository | null = null;
  let executionClaims: ExecutionClaimRepository | null = null;

  if (config.binance && config.binance.enabled) {
    // Same BinanceRestClient/BinanceExecutionService CLASSES as
    // liqwatch-bot's own execution wiring -- one instance per user,
    // each with that user's OWN API keys, matching "each user has an
    // independent, real Binance account" exactly.
    binanceRest = new BinanceRestClient({
      restBaseUrl: "https://fapi.binance.com",
      wsBaseUrl: "wss://fstream.binance.com",
      apiKey: config.binance.apiKey,
      apiSecret: config.binance.apiSecret,
      testnet: false,
      recvWindowMs: 5000,
    });
    executionRecords = new ExecutionRecordRepository(mongo, config.userId);
    executionClaims = new ExecutionClaimRepository(mongo, config.userId);
    // Sep 8 2026 (Karo) -- CRITICAL safety wiring: this user's OWN
    // mode/leverage/marginMode/riskUsd, never a global env var (see
    // BinanceExecutionService constructor's own doc comment for the
    // full rationale). "karo=live, friend=shadow, artak=disabled"
    // is expressed correctly HERE -- each BinanceExecutionService
    // instance is independently configured from that one user's own
    // UserConfig.binance block.
    execution = new BinanceExecutionService(binanceRest, executionRecords, executionClaims, null, {
      mode: config.binance.mode,
      orderExecutionEnabled: config.binance.orderExecutionEnabled,
      leverage: config.binance.leverage,
      marginMode: config.binance.marginMode,
      riskUsdForValidation: config.risk.riskUsd,
    });
  }

  let telegram: TelegramClient | null = null;
  if (config.telegram && config.telegram.enabled) {
    telegram = new TelegramClient({
      enabled: true,
      botToken: config.telegram.botToken,
      chatIds: [config.telegram.chatId],
      parseMode: "none",
      disableNotification: false,
    });
  }

  return {
    config,
    binanceRest,
    execution,
    telegram,
    dailyLossLimit: new DailyLossLimitTracker(config.userId, config.risk.accountBudgetUsd, config.risk.dailyLossLimitPct),
    reconcileInFlight: new InFlightGuard(),
    reconcileHealth: new ReconciliationHealthTracker(),
    executionRecords,
    executionClaims,
  };
}
