# liquidation-detector

Single global V5 liquidation-cascade detector, fanning out one canonical
signal to many independently-configured users (own Telegram, own Binance
account, own risk settings).

Standalone project. No dependency on, or modification of, `liqwatch-bot`.
See `PROJECT_CONTEXT.md` for why this project exists and `ARCHITECTURE.md`
for how it's built. See `MIGRATION_NOTES.md` for exactly what was
reused/adapted/newly-written, with old-file line references.

## Setup

```bash
npm install
cp .env.example .env            # fill in MONGO_URI, symbols, etc
cp users.config.example.json users.config.json   # fill in real per-user secrets
npm run build
npm test                        # all copied/adapted + new tests
```

## Run

```bash
npm run dev          # ts-node/tsx, no build step
# or
npm run build && npm start
# or, production (PM2)
pm2 start ecosystem.config.js
```

## Project layout

```
src/
  main.ts              composition root -- config -> Mongo -> per-user runtimes -> WS start
  domain/               zero-I/O market-state + trading-domain logic
  strategy/v5/          the ONE global V5 strategy engine (unchanged from liqwatch-bot)
  application/           use-cases + ports (the domain<->infrastructure boundary)
  infrastructure/        Binance/Mongo/Telegram/config/logging concrete implementations
  services/               top-level runtime orchestrators (market-data, signal fan-out, reconciliation)
tests/                  focused, fast (<1s total), no live network/Mongo required
```

## Mongo ownership

```
SHARED (liqwatch_bot database, reused, never duplicated):
  liq_minute_aggregates
  wall_minute_aggregates

OWNED by this project (liquidation_detector database):
  v5_global_signals            <- one canonical signal per real-world episode
  v5_signals_<userId>          <- one collection PER user
  execution_records_<userId>
  execution_claims_<userId>
```

## Per-user safety

Each user's own `BinanceExecutionService` instance is independently
configured from that user's own `users.config.json` block -- `mode`,
`orderExecutionEnabled`, `leverage`, and `marginMode` are never read from
a shared global environment variable. `karo=live, friend=shadow,
artak=disabled` means exactly that; see
`tests/per-user-binance-config.test.ts`.

## No HTTP layer

Background service only. No Express/REST/controllers -- see
`ARCHITECTURE.md` for why.
# liquidation-detector
