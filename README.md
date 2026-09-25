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

| Collection | What | Kept |
|---|---|---|
| `liq_raw_events` | every liquidation (Binance keeps no history) | 4 days |
| `oi_second_observations` | open interest every second + mid price | 3 days |
| `v9_decisions` | every confirmed episode + why it was / was not a signal | 60 days |
| `v9_trades` | every user's trade (entry, SL, TP, exit, PnL) | forever |
| `v9_episode_timeline` | what the engine saw live, every minute per symbol | 60 days |
| `market_positioning_5m` | % long of all accounts / top accounts / top positions (Binance keeps 30 days) | 1 year |
| `market_premium_1m` | mark, index, premium %, funding rate | 1 year |

`minute_bars` (kept 365 days): one row per symbol per minute -- price OHLC,
OI first/last/min/max, LONG/SHORT liquidation USD and count -- written every
minute from the raw rows. Research only (liquidation-episode studies over
months, while raw rows are kept a few days).

Candles, taker buy/sell volume and ATR are not stored: Binance keeps full
kline history (taker buy volume is inside every kline), backtests fetch them.

Restarts: episodes are recomputed from the stored raw data, so a restart loses
nothing except the seconds the collector is down; an episode with a whole
minute of missing data is never traded (`DATA_GAP`). Already-traded episodes
are restored from `v9_trades`.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | wiring: config → collector → V9 service |
| `src/collector/` | Binance data collection (market data + research context) |
| `src/strategy/v9/` | V9 core (pure), causal engine, live service, feed, repository, Telegram text |
| `src/research/` | research-only logic (liquidation-episode definition), never used by trading |
| `src/execution/` | Binance entry sequence, close report, account readiness |
| `src/config/` | `.env` and `users.config.json` loading/validation |
| `src/tools/` | `v9-show-signal` (full story of one signal), `v9-replay` (honest backtest), `test-live-entry` (real order round-trip test), `minute-bars-backfill`, `liq-episodes` (list/measure liquidation episodes) |
| `scripts/liquidation-episodes-v13.js` | original research script (reference for the equivalence test) |

## Configuration

`.env`: `MONGO_URI`, `MONGO_OWN_DB` (default `liquidation_detector`), `SYMBOLS` (comma list).

`users.config.json` (see `users.config.example.json`):
- `realOrdersEnabled` — global switch; without it nobody trades REAL.
- `v9.userModes` — `OFF` / `PAPER` / `REAL` per user.
- `v9.rr` (default 2.2) and `v9.minSlPct` (default 0.33): stops closer than this
  are moved out to it (TP follows), keeping stop-out fees <= ~0.3R.
- per user: `telegram`, `binance` (keys, leverage cap, margin mode), `risk.riskUsd`.

A REAL user is checked at startup (keys, One-Way mode, USDT balance); on
failure it runs PAPER and is told why on Telegram.

## Commands

```bash
bash deploy.sh                                         # pull, build, test, validate config, restart
npx tsx src/tools/v9-show-signal.ts <signalId>        # the whole story of one signal
npx tsx src/tools/v9-replay.ts                         # causal replay of history (read-only)
npx tsx src/tools/test-live-entry.ts --user karo --confirm   # real tiny order round-trip
npx tsx src/tools/minute-bars-backfill.ts              # once: raw rows -> minute_bars (safe to re-run)
npx tsx src/tools/liq-episodes.ts [--symbols ADA]      # liquidation episodes with liq $, OI drop $, OI rise $
npm test
```
