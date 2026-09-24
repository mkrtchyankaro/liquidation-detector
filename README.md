# liquidation-detector (V9)

Collects Binance futures liquidations and open interest, runs the **V9
liquidation/OI episode strategy** live, and trades it per user in **PAPER** or
**REAL** mode, reporting every entry and close on Telegram.

## How it works

```
Binance WS  forceOrder ──► liq_raw_events          ┐
Binance WS  bookTicker ──► mid price (memory)      ├─ MarketCollector
Binance REST openInterest (1/s) ──► oi_second_observations ┘
                                   │
               every minute (hh:mm:10)
                                   ▼
                         V9 engine (per symbol)
      OI regimes (BIC) → episodes → confirmation → DOM/DIR/CLR/MOV/EXH
                                   │ selected
                                   ▼
                  one signal id for everyone (symbol lock)
             ┌─────────────────────┴─────────────────────┐
           PAPER                                        REAL
   simulated TP/SL + fees                 MARKET entry → STOP_MARKET SL → LIMIT TP (2.2R from fill)
                                          Binance close detection from own fills
             └──────────────► Telegram per user ◄─────────┘
```

MongoDB collections (all others are unused):
`liq_raw_events`, `oi_second_observations`, `v9_decisions`, `v9_trades`.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | wiring: config → collector → V9 service |
| `src/collector/` | Binance data collection |
| `src/strategy/v9/` | V9 core (pure), causal engine, live service, feed, repository, Telegram text |
| `src/execution/` | Binance entry sequence, close report, account readiness |
| `src/config/` | `.env` and `users.config.json` loading/validation |
| `src/tools/` | `v9-replay` (honest backtest), `test-live-entry` (real order round-trip test) |
| `scripts/liquidation-episodes-v13.js` | original research script (reference for the equivalence test) |

## Configuration

`.env`: `MONGO_URI`, `MONGO_OWN_DB` (default `liquidation_detector`), `SYMBOLS` (comma list).

`users.config.json` (see `users.config.example.json`):
- `realOrdersEnabled` — global switch; without it nobody trades REAL.
- `v9.userModes` — `OFF` / `PAPER` / `REAL` per user.
- per user: `telegram`, `binance` (keys, leverage cap, margin mode), `risk.riskUsd`.

A REAL user is checked at startup (keys, One-Way mode, USDT balance); on
failure it runs PAPER and is told why on Telegram.

## Commands

```bash
bash deploy.sh                                         # pull, build, test, validate config, restart
npx tsx src/tools/v9-replay.ts                         # causal replay of history (read-only)
npx tsx src/tools/test-live-entry.ts --user karo --confirm   # real tiny order round-trip
npm test
```
