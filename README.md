# liquidation-detector (V10 + V11)

Collects Binance futures liquidations and open interest, runs two strategies live and trades them per user in
**PAPER** or **REAL** mode, reporting every entry and close on Telegram. (V9 and ZZ were removed on Oct 12 2026.)

| Strategy | Timeframe | Idea | Settings | Collections |
|---|---|---|---|---|
| **V10** | 15m / 1h | BTC-led alts (part BTC), an alt's own turn (part ALT), liquidation walls (part WALL) | `"v10"` | `v10_signals`, `v10_trades`, `v10_book` |
| **V11** | 1h | **squeeze wick**: rally -> short-liquidation wick at a new high -> OI-confirmed SHORT | `"v11"` | `v11_signals`, `v11_trades` |
| OA | 1h | OI accumulation -- **PAPER only**, Telegram messages, never orders | `"oa"` | `oa_paper_trades` |

## V11 -- squeeze wick (`src/strategy/v11/`)

Every closed 1h candle, every coin (price = Binance 1h klines, OI = Binance `openInterestHist` 5m at the hour edges,
liquidations = our `minute_bars`). All thresholds are relative to the coin itself:

1. **Rally**: the price rose over 6 h by >= 2x the coin's median |6h move| (72 h). Start = the lowest close of those hours.
2. **Type**: OI start -> rally close vs the mean |hourly OI change| (24 h): **T1** fell (squeeze), **T2** rose, **FLAT**.
3. **Wick** (within 12 h): a new high, short liquidations >= the coin's 85th percentile (72 h), close in the lower half.
4. **Confirmation** (next 1-2 candles): a higher high cancels; OI up and the candle < +0.3 % confirms.
5. **Trade**: SHORT at the next hour's open, **SL = the wick's high**, **TP = tpR x risk** (default 2R), time-out 48 h.

Tested on 25 coins x 14 days: 44 entries, 2R -> 19 TP / 21 SL, +11R after fees (T1 only: 18 entries, +8.4R;
"meaningful" liquidations only: 23 entries, +10.6R). `tests/v11-engine.test.ts` replays that data and must give the
same 112 wicks and 44 entries. The LONG mirror exists (`"long": true`) but tested badly -- off by default.

REAL safety (same as V10): the symbol must be completely clear on the account and the user must not have a REAL V10
trade on it (V10 and V11 check each other under one lock); market entry -> SL verified (else fail-safe close) -> TP;
an unfinished entry is recovered from our own client order ids; closes are settled from Binance fills.

## Data

```
Binance WS  forceOrder ──► liq_raw_events (14 days)                ┐
Binance REST openInterest (1/s) ──► oi_second_observations (1 day) ├─ MarketCollector
                                   └──► minute_bars (365 days: price, OI, long / short liquidations per minute)
```

`market_positioning_5m` / `market_premium_1m` (ContextCollector) are research context only.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | wiring: config -> collectors -> V10 / V11 / OA services |
| `src/collector/` | Binance data collection, minute bars |
| `src/strategy/v10/` | V10 engine, live service, repository, messages, order-book / zone / wall parts |
| `src/strategy/v11/` | V11 engine (pure), data source, config, live service, repository, messages |
| `src/strategy/lib/` | pure strategy maths used live (15m DC, OI peak, ATR turn, zones, SL/TP simulation, OI accumulation) |
| `src/strategy/shared/` | number formatting, fee estimate, minute-bar loader |
| `src/strategy/oa/` | PAPER-only strategy |
| `src/execution/` | Binance entry sequence, settle / recovery, readiness, the V10 / V11 cross-check and lock |
| `src/config/` | `.env` and `users.config.json` loading / validation |
| `src/tools/` | read-only tools (below) and `test-live-entry` |
| `pine/` | TradingView indicator (liquidation ledger) |

## Configuration

`.env`: `MONGO_URI`, `MONGO_OWN_DB` (default `liquidation_detector`), `SYMBOLS` (comma list).

`users.config.json` (see `users.config.example.json`; every V11 field is explained in `src/strategy/v11/v11-config.ts`):
- `realOrdersEnabled` -- global switch; without it nobody trades REAL.
- `v10` / `v11` -- `enabled`, `userModes` (`OFF` / `PAPER` / `REAL` per user), `perUser` overrides.
- `v11`: `short`, `long`, `tpR`, `riskUsd`, `slBufferPct`, `rallyTypes`, `meaningfulOnly`, `minRiskPct`, `maxRiskPct`,
  `maxOpen`, `timeoutHours`, `symbols`, `excludeSymbols`, `rule` (the signal thresholds).
- per user: `telegram`, `binance` (keys, leverage, margin mode), `risk.riskUsd`.

A REAL user is checked at startup (keys, One-Way mode, USDT balance); on failure it runs PAPER and is told why.
An old `"v9"` block is ignored (logged as `[LEGACY_CONFIG_IGNORED]`).

## Commands

```bash
bash deploy.sh                                             # pull, build, test, validate config, restart
npx tsx src/tools/v11-replay.ts --days 14                  # V11 on the last days with the live code (read-only)
npx tsx src/tools/hour-view.ts --symbol BTC --from "02 Oct 01:00" --to "02 Oct 14:00"   # price / OI / liquidations per candle
npx tsx src/tools/research-1h-export.ts --days 14           # 1h research export (Binance price + OI, our liquidations)
npx tsx src/tools/test-live-entry.ts --user karo --confirm  # real tiny order round-trip
npm test
```
