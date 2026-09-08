# ARCHITECTURE.md

## Core invariant

```
MARKET + STRATEGY = ONE   (V5WaveService, single global instance)
SIGNAL             = ONE   (one signalId, one v5_global_signals document)
USERS              = MANY  (config-driven list)
TELEGRAM / BINANCE / RISK / POSITION STATE = INDEPENDENT PER USER
```

## Layers

```
domain/          ZERO I/O. Market-state stores (candle/trade/orderbook/
                 liquidation), liquidity/ATR/OI/wall/flow calculators,
                 trade-plan math, risk trackers (DailyLossLimitTracker,
                 InFlightGuard, ReconciliationHealthTracker), pure
                 signal/user-config value types.

strategy/v5/     The single, global V5 wave-chain strategy engine.
                 Also zero-I/O (consumes liquidation events + price
                 ticks, produces V5TickOutcome[] -- never touches
                 Mongo/Telegram/Binance itself). Kept as its own
                 top-level directory (peer to domain/, not nested
                 inside it) because it is the ONE thing this whole
                 project exists to run, and operators reading the
                 tree should find it immediately.

application/     Use-cases (execute-for-user, notify-user,
                 reconcile-user-position) and the port interfaces
                 (ExecutionPort, NotificationPort, *RepositoryPort)
                 those use-cases depend on. Never imports a concrete
                 infrastructure class directly.

infrastructure/  Concrete implementations: Binance REST/WS/execution,
                 Mongo client + repositories, Telegram client +
                 formatter, config loaders, logging.

services/        Top-level runtime orchestrators that wire
                 application + infrastructure together at startup and
                 drive the live event loop: MarketDataOrchestrator
                 (owns the WS connection), SignalDistributor (fans
                 one signal out to all users), ReconciliationManager
                 (loops per-user live-position polling),
                 UserRuntime/buildUserRuntime (constructs each user's
                 own Binance/Telegram/risk instances once at startup).
```

Dependency direction is strictly one-way:
`services -> application -> domain` and `services -> infrastructure`.
`application` depends on `domain` types and its own `ports/`, never on
`infrastructure` concrete classes. `domain` and `strategy/v5` depend on
nothing outside `shared/`.

## Data flow -- one signal, many users

```
Binance WS (liquidation, bookTicker, kline, aggTrade, orderbook)
  -> MarketDataOrchestrator
     -> domain stores (CandleStore, LiquidationStore, ATRTrackerService, ...)
     -> V5WaveService.onLiquidation() / .onTick()
        -> V5TickOutcome[] (SIGNAL_CANDIDATE | TERMINAL_NON_SIGNAL)
  -> MarketDataOrchestrator.handleTickOutcome()
     -> V5WaveService.evaluateSignal() -> V5SignalEvent
     -> mapped to GlobalSignalDoc (strategy-only fields)
     -> SignalDistributor.distribute(globalSignal)
        -> GlobalSignalRepository.insert()  [v5_global_signals, ONE doc]
        -> for each enabled user (own try/catch, isolated):
             notifyUser()      -> that user's own TelegramClient
             executeForUser()  -> that user's own BinanceExecutionService
                                  -> UserSignalRepository.upsert()
                                     [v5_signals_<userId>, per-user doc]
```

## Data flow -- reconciliation / manual close

```
Every relevant bookTicker tick
  -> ReconciliationManager.onTick(symbol, now)
     -> for each enabled user (own try/catch, isolated):
          UserSignalRepository.findOpen(userId)  [that user's OWN collection]
          -> reconcileUserPosition()
             -> InFlightGuard.run(signalId, ...)   [race-condition guard]
             -> that user's own BinanceExecutionService.reconcileLivePosition()
             -> on failure: ReconciliationHealthTracker (backoff + 5-min alert)
             -> on close: UserSignalRepository.upsert() [ONLY this user's doc]
                          that user's own TelegramClient close message
```

A manual close for Karo touches exactly: `v5_signals_karo`,
`execution_records_karo`/`execution_claims_karo` as needed, and Karo's own
Telegram. `v5_signals_friend`, `v5_global_signals`, and every other user's
state are never read or written by this flow.

## Why no HTTP layer

This is a background detection/execution service with one operator-facing
surface (Telegram) and one data surface (Mongo, for forensic/analytics
queries via `mongosh` or the existing tooling patterns). Adding
Express/REST/controllers would introduce a whole class of new
responsibilities (auth, request validation, rate limiting) with no current
requirement driving them. If a future requirement needs one (e.g. a
dashboard), it should be added as its own thin adapter reading from Mongo,
not woven into this process.

## Config/secrets boundary

```
.env                    global-only: symbols, Mongo URI/db names, log level.
                         Committed as .env.example with placeholders.
users.config.json        per-user secrets: Telegram token/chatId, Binance
                         apiKey/apiSecret, mode, leverage, risk settings.
                         Committed as users.config.example.json with
                         placeholders. Real file is gitignored.
```

userId is validated once at config-load time (`normalizeAndValidateUserId`,
fail-fast -- the whole process refuses to start on an invalid id) and
defensively again inside every Mongo per-user collection accessor
(`assertValidUserId`) -- collection names are never built from
unvalidated external input.

## Per-user execution-safety isolation

`BinanceExecutionService` -- copied from liqwatch-bot, adapted -- takes
each user's `mode`/`orderExecutionEnabled`/`leverage`/`marginMode` as
explicit constructor parameters (`services/user-runtime.ts` supplies
them from that user's own `UserConfig.binance`), never a shared global
environment variable. The original two-key live-arming design
(`isLiveArmed` requires BOTH `mode==="live"` AND
`orderExecutionEnabled===true`) is preserved as two separate
`BinanceUserConfig` fields -- one user being fully live-armed has zero
effect on any other user's own instance.
