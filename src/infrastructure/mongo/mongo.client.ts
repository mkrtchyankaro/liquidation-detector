import { MongoClient, type Db, type Collection } from "mongodb";
import { childLogger } from "../logging/logger";
import { assertValidUserId } from "../../domain/user/user-id.validator";
import type { LiqMinuteAggregateDoc } from "./liq-aggregate.repository";
import type { WallMinuteAggregateDoc } from "./wall-aggregate.repository";
import type { GlobalSignalDoc } from "../../domain/signal/global-signal.model";
import type { CascadeDoc } from "../../domain/cascade/cascade.model";
import type { RawLiquidationEventDoc } from "./raw-liquidation-event.repository";
import type { UserSignalDoc } from "../../domain/signal/user-signal.model";
import type { RotationEpisodeHistoryDoc } from "../../domain/signal/rotation-episode-history.model";
import type { OiSecondObservationDoc } from "./oi-second-observation.repository";
import type { StrategyOrderDoc } from "./strategy-order.repository";
import type { LiquidationOiGlobalSignalDoc } from "./liquidation-oi-global-signal.repository";
import type { LiquidationOiWaitStateDoc } from "./liquidation-oi-wait-state.repository";
import type { LiquidationOiUserExecutionState } from "../../domain/liquidation-oi-strategy/user-execution.types";
import type { ExecutionRecordDoc } from "./execution-record.model";
import type { ExecutionClaimDoc } from "./execution-claim.model";

export interface MongoDetectorConfig {
  enabled: boolean;
  uri: string;
  /** The EXISTING liqwatch-bot database -- read/reused for shared,
   *  historical market data ONLY (liq_minute_aggregates,
   *  wall_minute_aggregates). This project also WRITES ongoing new
   *  liquidation/wall aggregates here (the same collections liqwatch-bot
   *  itself continues to grow) -- never a separate copy, per explicit
   *  operator instruction ("do not duplicate millions of existing
   *  market-data records"). This project's OWN signal/execution state
   *  never touches this database at all. */
  sharedMarketDataDb: string;
  /** This project's OWN, independently-owned database -- global
   *  signals + all per-user collections. liqwatch-bot never reads or
   *  writes here. */
  ownDb: string;
}

/**
 * Sep 8 2026 (Karo). Connection logic (lazy-connect, single shared
 * MongoClient, failure-cooldown so a down Mongo doesn't trigger a
 * reconnect storm on every call) is REUSED, byte-identical in
 * behavior, from liqwatch-bot's own src/db/mongo.client.ts
 * (MongoClientWrapper.ensure()). What's NEW here: ONE client exposes
 * TWO logical databases (shared historical vs this project's own),
 * and per-user collection accessors that go through
 * assertValidUserId() -- collection names are NEVER built from
 * unvalidated external input.
 */
export class MongoClientWrapper {
  private readonly log = childLogger({ mod: "mongo" });
  private client: MongoClient | null = null;
  private sharedDb: Db | null = null;
  private ownDb: Db | null = null;
  private connecting: Promise<void> | null = null;
  private lastFailureAt = 0;
  private readonly failureCooldownMs = 60_000;

  constructor(private readonly cfg: MongoDetectorConfig) {}

  get isEnabled(): boolean {
    return this.cfg.enabled;
  }

  /** Same lazy-connect-once-with-cooldown behavior as liqwatch-bot's
   *  own ensure() -- reused logic, now resolving BOTH database handles
   *  from one MongoClient/one connection. */
  private async ensure(): Promise<{ shared: Db; own: Db } | null> {
    if (!this.cfg.enabled) return null;
    if (this.sharedDb && this.ownDb) return { shared: this.sharedDb, own: this.ownDb };
    if (this.connecting) {
      await this.connecting;
      return this.sharedDb && this.ownDb ? { shared: this.sharedDb, own: this.ownDb } : null;
    }

    const sinceFailure = Date.now() - this.lastFailureAt;
    if (this.lastFailureAt > 0 && sinceFailure < this.failureCooldownMs) {
      return null; // fail fast during cooldown, same as liqwatch-bot's own behavior
    }

    this.connecting = (async (): Promise<void> => {
      try {
        this.log.info({ sharedDb: this.cfg.sharedMarketDataDb, ownDb: this.cfg.ownDb }, "connecting to mongo");
        const client = new MongoClient(this.cfg.uri, {
          serverSelectionTimeoutMS: 8_000,
          maxPoolSize: 10,
        });
        await client.connect();
        await client.db(this.cfg.sharedMarketDataDb).command({ ping: 1 });
        this.client = client;
        this.sharedDb = client.db(this.cfg.sharedMarketDataDb);
        this.ownDb = client.db(this.cfg.ownDb);
        this.lastFailureAt = 0;
        this.log.info("mongo connected");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastFailureAt = Date.now();
        this.log.error({ err: msg, retryInSec: Math.round(this.failureCooldownMs / 1000) }, "mongo connection failed; persistence disabled until cooldown expires");
        this.sharedDb = null;
        this.ownDb = null;
      } finally {
        this.connecting = null;
      }
    })();

    await this.connecting;
    return this.sharedDb && this.ownDb ? { shared: this.sharedDb, own: this.ownDb } : null;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.log.info("mongo closed");
    }
  }

  /** Sep 8 2026 (Karo) -- exposed specifically for liq-aggregate.repository.ts
   *  and wall-aggregate.repository.ts, copied UNCHANGED from liqwatch-bot
   *  and calling `this.mongo.ensure()` directly (their own, already-proven
   *  internal pattern -- not rewritten here, per explicit operator
   *  instruction to preserve behavior). Those two repositories ONLY ever
   *  want the SHARED, historical-market-data database, never this
   *  project's own per-user state -- this method returns exactly that,
   *  matching the OLD mongo.client.ts's single-Db ensure() signature. */
  async ensureShared(): Promise<Db | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.shared : null;
  }

  /** Sep 17 2026 (Karo), operator-requested TTL-retention pass --
   *  mirrors ensureShared() exactly, for the same reason: some
   *  repositories need the raw Db handle directly (here: to run
   *  `collMod` for in-place TTL value changes and `listIndexes` for
   *  stale-index detection), not just a typed Collection<T>. */
  async ensureOwn(): Promise<Db | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own : null;
  }

  // ─── SHARED, historical (liqwatch_bot database) -- reused, never duplicated ───

  /** Exact same collection name/shape as liqwatch-bot's own
   *  db/liq-aggregate.repository.ts (COLL_AGGREGATES = "liq_minute_aggregates").
   *  This project both reads history from and continues writing new
   *  minutes into this SAME, shared collection. */
  async liqMinuteAggregates(): Promise<Collection<LiqMinuteAggregateDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.shared.collection<LiqMinuteAggregateDoc>("liq_minute_aggregates") : null;
  }

  /** Exact same collection name/shape as liqwatch-bot's own
   *  db/wall-aggregate.repository.ts (COLL_AGGREGATES = "wall_minute_aggregates"). */
  async wallMinuteAggregates(): Promise<Collection<WallMinuteAggregateDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.shared.collection<WallMinuteAggregateDoc>("wall_minute_aggregates") : null;
  }

  // ─── OWN, new (liquidation_detector database) ──────────────────────────

  /** ONE collection, GLOBAL, strategy-only fields -- the canonical
   *  signal every user's own execution refers to by signalId. */
  async globalSignals(): Promise<Collection<GlobalSignalDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<GlobalSignalDoc>("v5_global_signals") : null;
  }

  /** Sep 10 2026 (Karo), operator-requested restart-safe persistence
   *  for the production V5 multi-timeframe cascade lifecycle. GLOBAL,
   *  own database -- see cascade.model.ts's own doc comment for why
   *  v5_global_signals is not sufficient for this. */
  async activeCascades(): Promise<Collection<CascadeDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<CascadeDoc>("v5_active_cascades") : null;
  }

  /** Sep 8 2026 (Karo) -- bounded (TTL-indexed) raw liquidation-event
   *  archive. GLOBAL, own database (never per-user, never the shared
   *  liqwatch_bot db -- this is a NEW capability the old bot never
   *  had). See RawLiquidationEventRepository's own doc comment for
   *  why liq_minute_aggregates' own top-N sampling is insufficient
   *  for dense-burst replay research. */
  async rawLiquidationEvents(): Promise<Collection<RawLiquidationEventDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<RawLiquidationEventDoc>("liq_raw_events") : null;
  }

  /** Sep 16 2026 (Karo), operator-requested -- see
   *  oi-second-observation.repository.ts's own module doc comment.
   *  TEMPORARY/RESEARCH data, own database, TTL-bounded. */
  async oiSecondObservations(): Promise<Collection<OiSecondObservationDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<OiSecondObservationDoc>("oi_second_observations") : null;
  }

  /** Sep 16 2026 (Karo), operator-approved architecture -- see
   *  strategy-order.repository.ts's own module doc comment. */
  async strategyOrders(): Promise<Collection<StrategyOrderDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<StrategyOrderDoc>("strategy_orders") : null;
  }

  /** Sep 16 2026 (Karo), operator-approved architecture -- Liquidation+OI
   *  Exhaustion strategy, structurally separate from v5_global_signals. */
  async liquidationOiGlobalSignals(): Promise<Collection<LiquidationOiGlobalSignalDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<LiquidationOiGlobalSignalDoc>("liquidation_oi_global_signals") : null;
  }

  /** Structurally separate from v5_signals_<userId>. */
  async liquidationOiUserExecutions(): Promise<Collection<LiquidationOiUserExecutionState> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<LiquidationOiUserExecutionState>("liquidation_oi_user_executions") : null;
  }

  /** Sep 17 2026 (Karo), operator-approved final capacity architecture,
   *  Section 31 -- restart-safe persistence for pre-ENTRY_READY WAIT
   *  state (previously RAM-only, lost on every restart). Structurally
   *  separate from liquidation_oi_global_signals (which only ever
   *  holds ENTRY_READY+ states) -- one doc per symbol currently
   *  waiting, deleted the instant the symbol leaves WAIT (either
   *  forward to ENTRY_READY or back to EXHAUSTION_CANDIDATE/CANCELLED). */
  async liquidationOiWaitStates(): Promise<Collection<LiquidationOiWaitStateDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<LiquidationOiWaitStateDoc>("liquidation_oi_wait_states") : null;
  }

  /** Sep 19 2026 (Karo), operator-requested Episode Research capture --
   *  ONE doc per finished liquidation episode (entry or no-entry
   *  alike), full event chain + Flush/Recovery flow + basis. Purely
   *  observational/research storage -- read by nothing in the live
   *  strategy. */
  async liquidationOiEpisodeResearch(): Promise<Collection<import("../../domain/liquidation-oi-strategy/episode-research-recorder").EpisodeResearchRecord & { _persistedAt: Date }> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection("liquidation_oi_episode_research") : null;
  }

  /** Sep 14 2026 (Karo), operator-requested -- historical ROTATION
   *  episode backfill. GLOBAL, own database. See
   *  rotation-episode-history.model.ts's own doc comment for the full
   *  rationale (separate from v5_global_signals, never mixed with
   *  WAVE-mode episode totals). */
  async rotationEpisodeHistory(): Promise<Collection<RotationEpisodeHistoryDoc> | null> {
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<RotationEpisodeHistoryDoc>("rotation_episode_history") : null;
  }

  /** Sep 8 2026, operator-approved (Karo) -- PER-USER collection,
   *  NEVER a single shared collection with a userId field (explicit
   *  operator correction: "I want each user to have an independent
   *  signal collection, similar to the isolation we currently have
   *  with Brother/Friend"). assertValidUserId() throws on anything
   *  that isn't already-validated-at-config-load-time -- this function
   *  is the LAST line of defense, never trusts its caller. */
  async userSignals(userId: string): Promise<Collection<UserSignalDoc> | null> {
    assertValidUserId(userId);
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<UserSignalDoc>(`v5_signals_${userId}`) : null;
  }

  /** Per-user, per explicit operator instruction ("YES if those
   *  collections represent user-specific Binance execution state" --
   *  they do, each user has their own separate Binance account). */
  async executionRecords(userId: string): Promise<Collection<ExecutionRecordDoc> | null> {
    assertValidUserId(userId);
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<ExecutionRecordDoc>(`execution_records_${userId}`) : null;
  }

  /** Per-user. Unlike liqwatch-bot's own GLOBAL execution_claims
   *  (shared across MAIN/FRIEND/BROTHER, which all traded the SAME
   *  underlying account/symbol-space), each user here has their OWN,
   *  separate Binance account -- a symbol-lock scoped per-user is the
   *  architecturally correct equivalent, not a cross-user global lock. */
  async executionClaims(userId: string): Promise<Collection<ExecutionClaimDoc> | null> {
    assertValidUserId(userId);
    const dbs = await this.ensure();
    return dbs ? dbs.own.collection<ExecutionClaimDoc>(`execution_claims_${userId}`) : null;
  }
}
