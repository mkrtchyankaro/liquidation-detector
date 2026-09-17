import type { Collection } from "mongodb";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import type { LiquidationOiGlobalSignalDoc } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";
import type { LiquidationOiUserExecutionState } from "../src/domain/liquidation-oi-strategy/user-execution.types";
import type { StrategyOrderDoc } from "../src/infrastructure/mongo/strategy-order.repository";
import { holdsSymbolOwnership } from "../src/domain/liquidation-oi-strategy/lifecycle.types";

/**
 * Sep 17 2026 (Karo), operator-requested operational-safety pass.
 * READ-ONLY. Shared by scripts/lox-reset.ts and scripts/lox-status.ts
 * so both tools report from the exact same audit logic.
 *
 * Source-audit confirmed (grep, this pass): the `strategy_orders`
 * Mongo collection is constructed and used EXCLUSIVELY by
 * StrategyOrderRepository, which is constructed exactly once in
 * main.ts, only for LOX -- every row is LOX-owned by construction
 * today. This module still filters defensively on a non-empty
 * globalSignalId (the actual LOX ownership proof field) rather than
 * assuming "the whole collection", so it stays correct if the
 * collection is ever shared later.
 */

export function loxMongoConfig(): MongoDetectorConfig {
  return {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
}

export interface LoxCollections {
  signals: Collection<LiquidationOiGlobalSignalDoc>;
  userExecs: Collection<LiquidationOiUserExecutionState>;
  orders: Collection<StrategyOrderDoc>;
}

export async function getLoxCollections(
  mongo: MongoClientWrapper,
): Promise<LoxCollections | null> {
  const signals = await mongo.liquidationOiGlobalSignals();
  const userExecs = await mongo.liquidationOiUserExecutions();
  const orders = await mongo.strategyOrders();
  if (signals === null || userExecs === null || orders === null) return null;
  return { signals, userExecs, orders };
}

export interface LoxAudit {
  allSignals: LiquidationOiGlobalSignalDoc[];
  allUserExecs: LiquidationOiUserExecutionState[];
  allOrders: StrategyOrderDoc[];
  lockedSignals: LiquidationOiGlobalSignalDoc[];
  signalsByState: Record<string, number>;
  userExecsByModeState: Record<string, number>;
  ordersByState: Record<string, number>;
  realExposure: Array<{
    userId: string;
    globalSignalId: string;
    symbol: string;
    reason: string;
  }>;
  unresolvedLoxOrders: StrategyOrderDoc[];
}

function groupCount<T>(
  items: T[],
  keyFn: (item: T) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export async function auditLoxState(cols: LoxCollections): Promise<LoxAudit> {
  const allSignals = await cols.signals.find({}).toArray();
  const allUserExecs = await cols.userExecs.find({}).toArray();
  const allOrdersRaw = await cols.orders.find({}).toArray();
  const allOrders = allOrdersRaw.filter(
    (o) => typeof o.globalSignalId === "string" && o.globalSignalId.length > 0,
  );

  const lockedSignals = allSignals.filter((s) => holdsSymbolOwnership(s.state));
  const signalsByState = groupCount(allSignals, (s) => s.state);
  const userExecsByModeState = groupCount(
    allUserExecs,
    (u) => `${u.mode}_${u.state}`,
  );
  const ordersByState = groupCount(allOrders, (o) => o.state);

  const realExposure: LoxAudit["realExposure"] = [];
  for (const u of allUserExecs) {
    if (u.mode !== "REAL") continue;
    if (u.state === "ACTIVE")
      realExposure.push({
        userId: u.userId,
        globalSignalId: u.globalSignalId,
        symbol: u.symbol,
        reason: "REAL user state=ACTIVE -- may have an open Binance position",
      });
    else if (u.cleanupState === "PENDING")
      realExposure.push({
        userId: u.userId,
        globalSignalId: u.globalSignalId,
        symbol: u.symbol,
        reason: "REAL user cleanupState=PENDING -- cleanup never ran",
      });
    else if (u.cleanupState === "FAILED_RETRYING")
      realExposure.push({
        userId: u.userId,
        globalSignalId: u.globalSignalId,
        symbol: u.symbol,
        reason: `REAL user cleanupState=FAILED_RETRYING (${u.cleanupFailureReason ?? "unknown reason"}) -- residual order cancellation unverified`,
      });
  }
  const unresolvedLoxOrders = allOrders.filter((o) => o.state === "OPEN");
  for (const o of unresolvedLoxOrders) {
    if (
      !realExposure.some(
        (r) => r.userId === o.userId && r.globalSignalId === o.globalSignalId,
      )
    ) {
      realExposure.push({
        userId: o.userId,
        globalSignalId: o.globalSignalId,
        symbol: o.symbol,
        reason: `unresolved (OPEN) LOX-owned strategy order, purpose=${o.purpose}`,
      });
    }
  }

  return {
    allSignals,
    allUserExecs,
    allOrders,
    lockedSignals,
    signalsByState,
    userExecsByModeState,
    ordersByState,
    realExposure,
    unresolvedLoxOrders,
  };
}
