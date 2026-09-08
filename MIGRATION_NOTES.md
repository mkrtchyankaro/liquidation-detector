# MIGRATION_NOTES.md

Exact provenance for every file in this project. "Old path" is relative to
`liqwatch-bot/src/`. No file in `liqwatch-bot` was modified or deleted --
this project is entirely new, standalone code.

## Copied unchanged (byte-identical logic, only import paths adjusted)

| New path | Old path |
|---|---|
| `domain/market/candle.store.ts` | `market-data/candle.store.ts` |
| `domain/market/trade.store.ts` | `market-data/trade.store.ts` |
| `domain/market/orderbook.store.ts` | `market-data/orderbook.store.ts` |
| `domain/market/rolling-metrics.service.ts` | `market-data/rolling-metrics.service.ts` |
| `domain/market/atr-tracker.service.ts` | `strategy-v2/atr-tracker.service.ts` |
| `domain/market/atr-bootstrap.ts` | `strategy-v2/atr-bootstrap.ts` |
| `domain/liquidation/liquidation.store.ts` | `market-data/liquidation.store.ts` |
| `domain/liquidation/liquidation-stats.service.ts` | `market-data/liquidation-stats.service.ts` |
| `domain/liquidation/liq-feed-watchdog.service.ts` | `market-data/liq-feed-watchdog.service.ts` |
| `domain/liquidation/wall-tracker.service.ts` | `market-data/wall-tracker.service.ts` |
| `domain/liquidation/oi-tracker.service.ts` | `market-data/oi-tracker.service.ts` |
| `domain/liquidation/funding-stats.service.ts` | `market-data/funding-stats.service.ts` |
| `domain/liquidation/funding-rate.service.ts` | `market-data/funding-rate.service.ts` |
| `domain/liquidation/aggressive-flow.service.ts` | `market-data/aggressive-flow.service.ts` |
| `domain/trading/trade-plan.ts` | `strategy-v2/trade-plan.ts` |
| `domain/trading/risk/in-flight-guard.ts` | `risk/in-flight-guard.ts` |
| `domain/trading/risk/reconciliation-health.ts` | `risk/reconciliation-health.ts` |
| `strategy/v5/v5-wave.service.ts` | `strategy-v2/v5/v5-wave.service.ts` |
| `strategy/v5/v5-wave.model.ts` | `strategy-v2/v5/v5-wave.model.ts` |
| `strategy/v5/v5-trade-plan.ts` | `strategy-v2/v5/v5-trade-plan.ts` |
| `strategy/v5/v5.config.ts` | `strategy-v2/v5/v5.config.ts` |
| `strategy/v5/v5-liq-stats.ts` | `strategy-v2/v5/v5-liq-stats.ts` |
| `strategy/v5/btc-opposing-watch.ts` | `strategy-v2/btc-opposing-watch.ts` |
| `infrastructure/binance/binanceRest.client.ts` | `exchange/binanceRest.client.ts` |
| `infrastructure/binance/binanceWs.client.ts` | `exchange/binanceWs.client.ts` |
| `infrastructure/binance/binance-connectivity.service.ts` | `exchange/binance-connectivity.service.ts` |
| `infrastructure/binance/binance.types.ts` | `exchange/binance.types.ts` |
| `infrastructure/mongo/liq-aggregate.repository.ts` | `db/liq-aggregate.repository.ts` (+ `ensureShared()` adapter, see below) |
| `infrastructure/mongo/wall-aggregate.repository.ts` | `db/wall-aggregate.repository.ts` (+ `ensureShared()` adapter, see below) |
| `infrastructure/mongo/execution-claim.model.ts` | `exchange/execution-claim.model.ts` |
| `infrastructure/mongo/execution-record.model.ts` | `exchange/execution-record.model.ts` |
| `infrastructure/telegram/telegram.client.ts` | `telegram/telegram.client.ts` |
| `infrastructure/telegram/signal.formatter.ts` | `strategy-v2/v5/v5-signal.formatter.ts` |
| `infrastructure/config/observability.config.ts` | `config/observability.config.ts` |
| `infrastructure/config/binance.config.ts` | `config/binance.config.ts` |
| `infrastructure/config/persistence.config.ts` | `config/persistence.config.ts` |
| `infrastructure/config/wall-persistence.config.ts` | `config/wall-persistence.config.ts` |
| `infrastructure/config/symbols.config.ts` | `config/symbols.config.ts` |
| `infrastructure/config/integrations.config.ts` | `config/integrations.config.ts` |
| `shared/common.types.ts` | `types/common.types.ts` |
| `shared/indicators.ts` | `utils/indicators.ts` |
| `shared/math.ts` | `utils/math.ts` |
| `infrastructure/logging/logger.ts` | `utils/logger.ts` |
| `tests/v5-wave.test.ts` | `tools/v5-wave-tests.ts` |
| `tests/in-flight-guard.test.ts` | `tools/in-flight-guard-tests.ts` |
| `tests/reconciliation-health.test.ts` | `tools/reconciliation-health-tests.ts` |

## Extracted (only part of a larger file copied)

| New path | Old source | What was extracted |
|---|---|---|
| `shared/trading.types.ts` | `strategy-v2/paper-signal.model.ts` (384 lines) | Only `WallContext` (renamed from `PaperWallContext`). `Side` was NOT re-extracted -- `common.types.ts` already exports an identical `Side` type, used as the single source of truth instead of duplicating it (the original codebase had this type defined in two places; this project has it in one). The other ~15 types in that file (`PaperSignalDoc`, `PaperScoreBreakdown`, `PaperMagContext`, etc) are V1/V3 paper-signal-specific and were not copied. |

## Adapted (real behavior-preserving code change required by the multi-user architecture)

| File | Change | Why | Verification |
|---|---|---|---|
| `infrastructure/binance/binance-execution.service.ts` | Removed the V3-only physics-formula dispatch branch (`derivePhysicsTradePlan`/`usesPhysicsFormula`/`wave1Liq`/`wave2Liq`/`isV5Signal`). `planForSymbol()` now unconditionally calls `deriveLiquidityTradePlan()`. | This project has exactly one strategy (V5); the branch existed only to route V3 signals to a different formula. | **Verified against the CURRENT, deployed main-bot code**, not assumed: `app.ts:1972` shows V5's only execution call site sets `isV5Signal: true` unconditionally; `binance-execution.service.ts:67`'s dispatch condition is `if (!input.isV5Signal && usesPhysicsFormula(...))`, which is therefore always `false` for V5. The physics branch is unreachable for V5 in production today, too -- removing it changes zero observable V5 behavior. |
| `domain/trading/risk/daily-loss-limit.service.ts` | Constructor now takes `accountBudgetUsd`/`dailyLossLimitPct` as explicit optional parameters (defaulting to the original 500/5 fallback) instead of reading `process.env.V3_ACCOUNT_BUDGET_USD`/`V3_DAILY_LOSS_LIMIT_PCT` directly. | **Required**, not a style cleanup: the original read one global env-var pair, which would make every user silently share one budget/limit -- incompatible with "each user needs independent daily loss limits" (explicit requirement). All comparison/accumulation math is otherwise byte-identical. | Approved explicitly by operator: "configuration ownership changes from process-global to per-user" is the intended, minimal scope of this change. Covered by `tests/multi-user-isolation.test.ts` (independent trackers) and `tests/reconciliation-health.test.ts`/original math preserved. |
| `infrastructure/mongo/execution-claim.repository.ts` | Constructor now also takes `userId`; every `this.mongo.executionClaims()` call became `this.mongo.executionClaims(this.userId)`. | Each user has their own, separate Binance account -- a global, cross-user symbol lock (the old, correct behavior when MAIN/FRIEND/BROTHER shared meaning) is the wrong semantic here; a claim must be scoped per user. | Structural (constructor signature + collection-name string) verified in `tests/multi-user-isolation.test.ts`. |
| `infrastructure/mongo/execution-record.repository.ts` | Same pattern as execution-claim.repository.ts. | Same reasoning -- per-user audit trail, not a shared one. | Same. |
| `infrastructure/mongo/mongo.client.ts` | New file, but its `ensure()`/connection logic (lazy-connect-once, `failureCooldownMs` back-off) is copied unchanged in behavior from `db/mongo.client.ts`'s own `ensure()`. New: exposes TWO databases (shared historical + this project's own) from one `MongoClient`, and validated per-user collection accessors. | Multi-database, multi-user collection design is new to this project by definition -- there was no old equivalent to copy wholesale. | `ensureShared()` (new, thin) preserves the exact old single-Db signature for the two repositories that call it directly. |
| `infrastructure/binance/binance-execution.service.ts` | **Second adaptation (discovered during the operator-requested soak-readiness check, not assumed)**: `mode`/`orderExecutionEnabled`/`leverage`/`marginMode`/`minRRAfterFill`/`takerFeeRateEstimate`/the `validateForLiveStart()` API-key check now come from an explicit, optional `perUserConfig` constructor parameter instead of `process.env.BINANCE_EXECUTION_MODE`/`BINANCE_ORDER_EXECUTION_ENABLED`/`BINANCE_LIVE_LEVERAGE`/`BINANCE_MARGIN_MODE`/`BINANCE_API_KEY`/`BINANCE_API_SECRET`. All values default to the EXACT original fallbacks (shadow, false, 20, ISOLATED, 2.0, 0.0005) when omitted. | With one instance constructed per user, all instances would otherwise silently read the SAME global env vars -- making "karo=live, friend=shadow, artak=disabled" impossible to express, risking every enabled user going live from one accidental global flag flip. The original TWO-key safety design (`isLiveArmed` requires BOTH `mode==="live"` AND `orderExecutionEnabled===true`) is preserved as two SEPARATE `BinanceUserConfig` fields, never collapsed into one. | `tests/per-user-binance-config.test.ts` (6 tests). |
| `infrastructure/binance/binanceRest.client.ts` | Added one new public method, `hasCredentials()` -- same check as the existing private `requireAuth()`, exposed as a non-throwing boolean. | `validateForLiveStart()`'s original API-key check read a global env var, intentionally blank in this project's `.env` (real per-user keys live in `users.config.json`) -- would have falsely failed validation for every correctly-configured live user. | Indirect, via per-user-binance-config.test.ts's construction tests. |

## Newly written (multi-user orchestration -- no old equivalent existed)

```
domain/user/user-id.validator.ts
domain/user/user-config.model.ts
domain/signal/global-signal.model.ts
domain/signal/user-signal.model.ts
application/ports/index.ts
application/signal/notify-user.usecase.ts
application/execution/execute-for-user.usecase.ts
application/execution/reconcile-user-position.usecase.ts
infrastructure/config/users.config.loader.ts
infrastructure/mongo/global-signal.repository.ts
infrastructure/mongo/user-signal.repository.ts
services/user-runtime.ts
services/signal-distributor.ts
services/reconciliation-manager.ts
services/market-data-orchestrator.ts
main.ts
tests/binance-execution-dispatch.test.ts   (rewritten -- old test proved a V3-vs-V5
                                             dispatch distinction that no longer exists;
                                             new version tests the single, simplified path)
tests/user-id.test.ts
tests/signal-distributor.test.ts
tests/multi-user-isolation.test.ts
tests/per-user-binance-config.test.ts      (added during the safety fix, see
                                             "Runtime-readiness verification" below)
```

## Deliberately NOT copied

```
strategy-v2/simple-liquidation.service.ts     (14,122 lines, V3 strategy -- entirely)
strategy-v2/physics-trade-plan.ts             (V3-only formula)
strategy-v2/analyzer-lite.service.ts          (V1, confirmed zero external side-effect)
strategy-v2/shadow-trader.service.ts          (V1, confirmed zero external side-effect)
strategy-v2/paper-signal.service.ts + .formatter.ts + boot-reconciler.ts (V1)
strategy-v2/v4/*                               (confirmed zero importers anywhere)
db/wave-transition.repository.ts               (confirmed zero importers anywhere)
db/micro-signal.repository.ts, entry-candidate.repository.ts, paper-signal.repository.ts
                                                (V3-specific; confirmed V5 never references
                                                 micro_signals/entry_candidates)
config/candidate-role.config.ts, trading-role.config.ts, data-role.config.ts
                                                (V3 multi-instance-role architecture,
                                                 superseded entirely by the per-user model)
strategy-v2/liq-absorption-snapshot.ts, v3-24h-context-snapshot.ts,
market-data/liquidation-stats-snapshot.ts, strategy-v2/wall-context-snapshot.ts
                                                (the entire local-file cross-PROCESS-sync
                                                 category -- structurally unnecessary once
                                                 there is only one process holding one
                                                 in-memory state; this eliminates the
                                                 "main vs brother divergence" risk class
                                                 identified in the original preservation
                                                 audit, rather than fixing the sync)
```

## Runtime-readiness verification (Sep 8 2026, post-construction)

Four items closed before any live deployment, each traced against the OLD
production code first, per explicit operator instruction ("reuse proven
behavior, do not invent replacements"):

1. **OI runtime scheduling** -- `OiTrackerService` is now constructed in
   `MarketDataOrchestrator`'s own constructor. Confirmed from source: this
   class auto-starts its own 60s-refresh timer INSIDE its constructor (no
   separate `.start()` call exists) -- reproduced unchanged. `main.ts`'s
   own `getOi` callback passed to `V5WaveService` was ALSO found to be
   wired incorrectly (mistakenly reading `liquidationStats.snapshot()`
   instead of the OI tracker) during this pass -- fixed to read
   `oiTracker.getCachedOI(symbol)` correctly.
2. **Funding was deliberately NOT added.** Traced precisely: both
   `FundingStatsService` and `FundingRateService` are constructed ONLY
   inside `app.ts`'s `if (V3_ENABLED)` block in the old bot -- confirmed
   via exact line-range analysis (lines 568/578, both within the
   established V3_ENABLED block spanning 554-1227). `V5WaveService`'s own
   constructor has no funding-related parameter at all. On the currently-
   live V5-only `brother` instance (`V3_ENABLED=false`), funding services
   are NEVER constructed. Funding is V3-Telegram-display-only
   infrastructure with zero V5 consumption -- correctly out of scope.
3. **Mongo indexes.** `ensureIndexes()` already existed, unchanged, in the
   copied `execution-claim.repository.ts`/`execution-record.repository.ts`
   (signalId-unique + symbol-active-partial-unique for claims,
   signalId-unique for records) -- they simply were never called. Now
   called for every enabled user at startup in `main.ts`, as a startup
   blocker (throws on failure), matching the original's own severity.
   `GlobalSignalRepository`/`UserSignalRepository` gained NEW
   `ensureIndexes()` methods (signalId-unique) -- the old, single-collection
   `v5-signal.repository.ts` had no index management to reproduce, but the
   operator explicitly requested this guarantee for the new architecture.
4. **liq24hContext / btcContext traced, not implemented.** Every read site
   in `v5-wave.service.ts` confirmed by direct inspection: `lastBtcPrice`
   is set once (on each BTCUSDT price tick) and read exactly once, directly
   into the output event's `btcContext.priceAtSignal` -- no comparison, no
   branch. `get24hStats()` is called exactly once per signal, directly into
   `liq24hContext` -- same. Zero decision/gating logic anywhere reads
   either value. **Confirmed 100% display/diagnostic-only** -- left as a
   documented follow-up, per operator instruction, since neither affects
   trading/execution/safety behavior.

## Critical safety finding during the soak-readiness check

`BinanceExecutionService`'s original constructor read
`mode`/`orderExecutionEnabled`/`leverage`/`marginMode`/API keys directly
from `process.env` -- correct for one process/one account, but would have
made every user share ONE global live/shadow flag in this multi-user
project, defeating "karo=live, friend=shadow, artak=disabled" entirely.
Found, reported, and fixed (approved) before any further work -- see the
adaptation table above and `tests/per-user-binance-config.test.ts`.

## Non-live soak-readiness check results

Run with `MONGO_URI` unset and placeholder Binance credentials
(`mode=live` for one test user, `shadow` for others), `USERS_CONFIG_PATH`
pointed at a temporary copy of the example config:

```
✅ app boots (no crash, clean startup log sequence)
✅ users load correctly ("loaded 3 user(s)... 3 enabled: [karo, friend, artak]")
✅ Mongo-disabled path degrades gracefully ("MONGO_URI not set -- skipping
   index validation, persistence disabled") -- code path verified; a REAL
   Mongo connection could not be tested from this sandbox (MongoDB Atlas
   is outside the sandbox's network allowlist -- see below)
✅ OI polling starts with the correct, unchanged cadence
   ("OiTrackerService started for 2 symbols (refresh 60000ms)")
✅ per-user Binance execution mode is correctly independent:
   karo -> "BINANCE EXECUTION IS LIVE-ARMED", friend/artak -> "ready in
   SHADOW mode" -- exactly matching their own configured mode
✅ zero real order was submitted (no BINANCE_LIVE_EXECUTION_START or
   order-placement log line ever appeared -- no signal was ever generated
   to trigger one, since the WS connection could not reach Binance)
✅ graceful shutdown on SIGTERM
✅ no old-project runtime dependency (grep-verified: zero imports/paths
   referencing liqwatch-bot; two unrelated cosmetic string literals --
   a log "app" label and a Telegram alert's suggested pm2-restart
   command -- were found still saying "liqwatch-bot" and corrected to
   "liquidation-detector")
⚠️ WS connection to Binance itself returned HTTP 403 -- confirmed this is
   the SANDBOX's own network egress restriction (fapi.binance.com/
   fstream.binance.com are not in this environment's allowlisted domains;
   directly verified with `curl` before this check), NOT a code defect.
   The reconnect-backoff logic itself worked correctly (attempts at 2s,
   4s, 8s). "liquidation processing starts" / "V5 receives market data"
   could therefore NOT be fully verified end-to-end from this sandbox --
   this requires running the same check on a server with real Binance/
   Mongo network access (the operator's own deployment target).
```

**Recommended equivalent check on the real server**, before going live for
any user: same `MONGO_URI` unset OR pointed at a real, empty/test Mongo,
same soak run, confirm real WS connection succeeds and `V5_WATCH_CREATED`-
style log lines appear once real liquidation events arrive, with every
user's `binance.mode` left at `"shadow"` until that's confirmed.

## Known limitations / TODOs for a future iteration

1. **Shadow-trade (paper) simulation for non-executed signals is not
   replicated.** The old `V5WaveService.onPriceTickForTrades()`/
   `activeTrades` shadow-close-simulation path exists in the copied
   `v5-wave.service.ts` file but is not currently wired up in
   `market-data-orchestrator.ts` -- this project's source of truth for
   "is a position open" is each user's own real Binance reconciliation,
   not an in-memory simulation. A signal with no user executing it today
   produces a `v5_global_signals` document but no simulated TP/SL outcome.
   If research/backtesting value from that simulation is wanted, wiring
   `onPriceTickForTrades()` back in is a self-contained addition.
2. **`liq24hContext`/`btcContext` on `GlobalSignalDoc` are currently
   always `null`** -- confirmed 100% display/diagnostic-only (see the
   runtime-readiness section above), deliberately deferred per operator
   instruction, since neither affects strategy/execution/safety behavior.
3. Load-testing / long-running soak validation on a server with real
   Binance/Mongo network access has not been performed -- the sandboxed
   soak-readiness check above verified everything reachable without live
   network access to Binance/MongoDB Atlas (both outside this sandbox's
   network allowlist); a server-side equivalent run is the recommended
   next step before enabling any user's real execution.

