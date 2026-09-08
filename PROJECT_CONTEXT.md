# PROJECT_CONTEXT.md

## Why this project exists

The operator (Karo) ran a liquidation-cascade fade-trading bot called
`liqwatch-bot`, evolved over ~6 months through V1 -> V2/V3 -> V4 -> V5
strategy generations. Production topology grew organically into THREE
near-duplicate full processes -- `liqwatch-bot` (main), `liqwatch-bot-brother`,
`liqwatch-bot-friend` -- each independently connecting to Binance market
data, independently running its OWN copy of the V5 wave-chain strategy
engine, and independently executing trades on its own Binance account.

This produced real, confirmed problems:
- Three separate WS connections, three separate P95/ATR/liquidity-baseline
  in-memory states -- which could (and did) drift apart if the three
  processes restarted at different times, since several pieces of shared
  state synced via local JSON files on a 60s timer rather than being
  genuinely centralized.
- `app.ts` grew to 2,300+ lines and `simple-liquidation.service.ts`
  (the V3 strategy engine) to 14,000+ lines, mixing strategy decisions,
  Mongo persistence, Telegram delivery, Binance execution, and risk
  management in the same functions.
- Legacy V1/V2/V3/V4 code remained reachable and, in some cases, still
  actively running (log-only, zero functional effect) alongside the
  active V5 strategy, discovered during a full runtime audit.

## What changed

The operator approved a full architectural reset: ONE detector process,
running the V5 strategy exactly once, producing ONE canonical signal per
real-world liquidation episode -- then fanning that single signal out to
an arbitrary number of independently-configured users, each with their
own Telegram delivery, their own Binance account/execution, and their own
risk limits. This is `liquidation-detector`.

## Key operator decisions that shaped this project (chronological)

1. **Preserve behavior, change architecture** -- proven V5 strategy logic,
   trade-plan formulas, Binance execution/reconciliation, and risk
   mechanisms must NOT be redesigned just because the code "looks legacy"
   or the new architecture is cleaner. Every adaptation in this codebase
   was individually verified against the actual, currently-deployed
   main-bot behavior before being made -- see MIGRATION_NOTES.md for the
   specific verifications.
2. **Hexagonal/Clean Architecture, lightweight, no overengineering** --
   domain logic (V5 strategy, trade-plan math, risk trackers) must not
   know about Mongo/Telegram/Binance/config. Application-layer use-cases
   depend on port interfaces, never concrete infrastructure classes.
3. **No HTTP layer** -- this is a background service, not a web app.
4. **Per-user Mongo isolation via SEPARATE collections**, not a single
   shared collection with a userId column -- mirroring the isolation
   the operator already relied on with Brother/Friend, but now scoped
   per logical user rather than per OS process.
5. **Never construct a Mongo collection name from unvalidated input** --
   userId is validated (strict allowlist regex) at config-load time AND
   defensively again at every Mongo accessor call site.
6. **Reuse existing historical market data, never duplicate it** --
   `liq_minute_aggregates`/`wall_minute_aggregates` in the OLD
   `liqwatch_bot` database are read AND continue to be written by this
   new project; this project's own signal/execution state lives in a
   separate, newly-created `liquidation_detector` database.

## Two specific production incidents this project's risk layer defends against

Both were found and fixed in `liqwatch-bot` during the Sep 8 2026
preservation audit that preceded this project, and both fixes are
preserved here unchanged (`domain/trading/risk/`):

1. **Duplicate CLOSE Telegram message** (confirmed real incident, Aug 26
   2026) -- a fire-and-forget reconciliation call with no synchronous
   in-flight guard let two near-simultaneous price ticks both detect
   "position closed" and both fire a full close/finalize/notify chain.
   Fixed by `InFlightGuard`.
2. **Reconciliation-failure blind spot** -- what happens when Binance's
   API is unreachable for an extended period while a real position is
   open. Fixed by `ReconciliationHealthTracker`: backoff so failures
   don't hammer the API, ONE escalating Telegram alert after 5 minutes
   of continuous failure, and an absolute, unbreakable rule that a
   timeout/API failure can NEVER be treated as a closed position --
   only a genuine, positive Binance confirmation can.

## What this is NOT (yet)

- Not a rewrite of the V5 strategy itself -- wave-chain/dominant-exhaustion
  logic is copied unchanged.
- Not a user-management platform -- users are configured via a JSON file,
  loaded once at startup. No runtime user CRUD, no auth system.
- Not yet cut over to production -- this is a new, standalone,
  independently-runnable project the operator will validate (starting in
  shadow mode) before retiring the old Main/Brother/Friend processes.

## Runtime-readiness verification (final pass, Sep 8 2026)

Before any live deployment, four remaining gaps were traced against the
OLD production bot and closed (or explicitly deferred, when confirmed
display-only) -- see MIGRATION_NOTES.md's own "Runtime-readiness
verification" section for the full detail: OI polling wiring (a
mis-wired callback was found and fixed in the same pass), Funding
confirmed V3-only and correctly left out, Mongo indexes wired at startup
as a fail-fast blocker, and `liq24hContext`/`btcContext` confirmed 100%
display-only by direct source inspection.

A second, more severe gap was found DURING that verification and fixed
with explicit approval: `BinanceExecutionService` originally read
mode/leverage/marginMode from global environment variables, which would
have made every user share one live/shadow flag -- defeating the entire
multi-user premise. Fixed the same way as `DailyLossLimitTracker` before
it: explicit per-user constructor parameters, original fallback defaults
preserved, original two-key safety design (`mode==="live"` AND
`orderExecutionEnabled===true`) preserved unchanged.

A non-live soak-readiness check (Mongo disabled, placeholder Binance
credentials, one user configured live/one shadow) confirmed correct
startup sequencing, correct per-user execution-mode isolation, and zero
real order submission. Live network connectivity to Binance/MongoDB Atlas
could not be verified from the sandboxed build environment (both outside
its network allowlist) -- an equivalent check on the real deployment
server is the recommended next step before enabling any user's live
execution.
