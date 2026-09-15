/**
 * Sep 15 2026 (Karo), operator-requested. Tests for
 * buildMarketSnapshot() -- the liquidation-event enrichment builder.
 */
import * as assert from "assert";
import * as fs from "fs";
import { AggressiveFlowService } from "../src/domain/liquidation/aggressive-flow.service";
import { OiTrackerService } from "../src/domain/liquidation/oi-tracker.service";
import { OrderbookStore } from "../src/domain/market/orderbook.store";
import { WallTrackerService } from "../src/domain/liquidation/wall-tracker.service";
import { CandleStore } from "../src/domain/market/candle.store";
import { LiquidationStore } from "../src/domain/liquidation/liquidation.store";
import { ATRTrackerService } from "../src/domain/market/atr-tracker.service";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import { FundingStatsService } from "../src/domain/liquidation/funding-stats.service";
import { FundingRateService } from "../src/domain/liquidation/funding-rate.service";
import { loadObservabilityConfig } from "../src/infrastructure/config/observability.config";
import {
  buildMarketSnapshot,
  type MarketSnapshotDeps,
} from "../src/domain/liquidation/liquidation-market-snapshot.builder";
import type { Liquidation, Candle } from "../src/shared/common.types";

let passed = 0;
let failed = 0;

function scenario(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

const SYMBOL = "BTCUSDT";

const INTERVAL_MS: Record<"1m" | "3m" | "5m", number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
};
function mkCandle(
  interval: "1m" | "3m" | "5m",
  openTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return {
    symbol: SYMBOL,
    interval,
    openTime,
    closeTime: openTime + INTERVAL_MS[interval] - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 10,
    quoteVolume: o * 10,
    takerBuyVolume: 5,
    takerBuyQuoteVolume: o * 5,
    trades: 20,
    isClosed: true,
  };
}

function freshDeps(): MarketSnapshotDeps {
  return {
    aggressiveFlow: new AggressiveFlowService(),
    oiTracker: new OiTrackerService([]),
    orderbookStore: new OrderbookStore(),
    wallTracker: new WallTrackerService(loadObservabilityConfig()),
    candleStore: new CandleStore(),
    liquidationStore: new LiquidationStore(),
    atrTracker: new ATRTrackerService(),
    directionalAtr1m: new DirectionalAtrTracker(),
    directionalAtr3m: new DirectionalAtrTracker(),
    directionalAtr5m: new DirectionalAtrTracker(),
    fundingStats: new FundingStatsService([]),
    fundingRate: new FundingRateService([]),
  };
}
function liq(
  side: "SELL" | "BUY",
  price: number,
  quoteQty: number,
  timestamp: number,
): Liquidation {
  return {
    symbol: SYMBOL,
    side,
    price,
    quantity: quoteQty / price,
    quoteQty,
    timestamp,
  };
}

console.log("Running liquidation-market-snapshot.builder tests...\n");

scenario(
  "zero ATR_UP remains 0, not null (the exact bug class reported)",
  () => {
    const deps = freshDeps();
    // flat close/high (always 1000) with only `low` declining -- guarantees
    // UpTR = max(0, high_t - close_{t-1}) = max(0, 1000-1000) = 0 for
    // EVERY candle after the first, so atrUp converges to exactly 0.
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const low = 1000 - i * 2;
      deps.candleStore.ingest(mkCandle("1m", t, 1000, 1000, low, 1000));
      deps.directionalAtr1m.onCandle(mkCandle("1m", t, 1000, 1000, low, 1000));
      t += 60_000;
    }
    const event = liq("SELL", 1000, 50_000, t);
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: t,
    });
    const snap = buildMarketSnapshot(deps, event, t) as any;
    assert.strictEqual(
      snap.atr["1m"].atrUp,
      0,
      "atrUp should be exactly 0 given UpTR=0 on every candle",
    );
    assert.strictEqual(
      snap.atr["1m"].atrUpPct,
      0,
      "atrUpPct must be 0, NOT null, when atrUp is legitimately 0 -- this is the reported bug class",
    );
  },
);

scenario(
  "zero taker sell volume produces imbalance=1 (all buy), not null",
  () => {
    const deps = freshDeps();
    const t = 100_000;
    deps.aggressiveFlow.ingest({
      symbol: SYMBOL,
      quoteQty: 5000,
      aggressor: "BUY",
      timestamp: t - 1000,
    } as any);
    const event = liq("SELL", 1000, 10_000, t);
    const snap = buildMarketSnapshot(deps, event, t) as any;
    assert.strictEqual(snap.takerFlow["10s"].takerSellUsd, 0);
    assert.strictEqual(
      snap.takerFlow["10s"].imbalance,
      1,
      "100% buy flow should give imbalance=1, not null",
    );
  },
);

scenario(
  "zero opposite-side liquidation count in a window is 0, not null",
  () => {
    const deps = freshDeps();
    const t = 100_000;
    const event = liq("SELL", 1000, 10_000, t);
    deps.liquidationStore.ingest(event);
    const snap = buildMarketSnapshot(deps, event, t) as any;
    assert.strictEqual(snap.liquidationContext.sameSideLiqCount30s, 1);
    assert.strictEqual(
      snap.liquidationContext.oppositeSideLiqCount30s,
      0,
      "zero opposite-side count must be 0, not null",
    );
  },
);

scenario(
  "missing OI produces null with null age, never a fabricated value",
  () => {
    const deps = freshDeps();
    const t = 100_000;
    const event = liq("SELL", 1000, 10_000, t);
    const snap = buildMarketSnapshot(deps, event, t) as any;
    assert.strictEqual(snap.openInterest.openInterest, null);
    assert.strictEqual(snap.openInterest.oiAgeMs, null);
    assert.strictEqual(snap.openInterest.oiChange1mPct, null);
  },
);

scenario(
  "price history: priceChange1mPct computed correctly from the orderbook history ring, causally",
  () => {
    const deps = freshDeps();
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: 0,
    });
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 989,
      bidQty: 1,
      ask: 991,
      askQty: 1,
      timestamp: 60_000,
    });
    const event = liq("SELL", 990, 10_000, 60_000);
    const snap = buildMarketSnapshot(deps, event, 60_000) as any;
    assert.ok(
      snap.priceState.priceChange1mPct !== null,
      "priceChange1mPct should now be computable (previously reported as permanently null)",
    );
    assert.ok(
      Math.abs(snap.priceState.priceChange1mPct - -1) < 0.01,
      `expected ~-1%, got ${snap.priceState.priceChange1mPct}`,
    );
  },
);

scenario(
  "order-book history never uses a sample AFTER the requested lookback timestamp (causality)",
  () => {
    const deps = freshDeps();
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: 0,
    });
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 1999,
      bidQty: 1,
      ask: 2001,
      askQty: 1,
      timestamp: 120_000,
    });
    const event = liq("SELL", 1000, 10_000, 60_000);
    const snap = buildMarketSnapshot(deps, event, 60_000) as any;
    assert.ok(
      Math.abs(snap.priceState.priceChange1mPct - 0) < 0.01,
      `must not use the future sample -- expected ~0% change from mid=1000, got ${snap.priceState.priceChange1mPct}`,
    );
  },
);

scenario(
  "ATR normalAtr is now populated at 1m/3m/5m (previously reported unavailable at 1m/3m)",
  () => {
    const deps = freshDeps();
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const price = 1000 - i;
      const c1 = mkCandle("1m", t, price, price + 1, price - 1, price);
      deps.candleStore.ingest(c1);
      deps.atrTracker.onCandle(c1);
      deps.directionalAtr1m.onCandle(c1);
      t += 60_000;
    }
    const event = liq("SELL", 980, 10_000, t);
    const snap = buildMarketSnapshot(deps, event, t) as any;
    assert.ok(
      snap.atr["1m"].normalAtr !== null,
      "normalAtr at 1m must now be populated -- ATRTrackerService already tracks 1m via isTracked()",
    );
  },
);

scenario(
  "no future candle ever contributes to ATR (structural: onCandle rejects unclosed candles)",
  () => {
    const src = fs.readFileSync(
      require.resolve("../src/strategy/v5/directional-atr.ts"),
      "utf8",
    );
    assert.ok(
      src.includes("isClosed"),
      "DirectionalAtrTracker.onCandle must reject candles that are not fully closed",
    );
  },
);

scenario(
  "snapshot construction failure is caught by the orchestrator, never blocking the base liquidation write",
  () => {
    const src = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = src.indexOf('this.ws.on("liquidation"');
    assert.ok(idx > -1, "liquidation handler must exist");
    const handlerBody = src.slice(idx, idx + 3000);
    assert.ok(
      handlerBody.includes("try {") &&
        handlerBody.includes("buildMarketSnapshot"),
      "buildMarketSnapshot call must be wrapped in try/catch",
    );
    assert.ok(
      handlerBody.includes("rawLiquidationEventRepo.insert"),
      "the base raw-liquidation insert must still occur in the same handler regardless of snapshot outcome",
    );
  },
);

scenario(
  "orchestrator has an explicit stop() that stops oiTracker/fundingStats/fundingRate",
  () => {
    const src = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = src.indexOf("stop(): void {");
    assert.ok(idx > -1, "MarketDataOrchestrator must expose a stop() method");
    const body = src.slice(idx, idx + 300);
    assert.ok(
      body.includes("oiTracker.stop()") &&
        body.includes("fundingStats.stop()") &&
        body.includes("fundingRate.stop()"),
    );
  },
);

// ============================================================
// CAUSALITY REGRESSION TESTS -- Sep 15 2026, operator-reported.
// A real production document showed orderBookAgeMs=-923: the
// snapshot builder used order-book state 923ms AFTER the
// liquidation's own timestamp. Every scenario below proves ONE
// specific source can never leak future information, using the
// EXACT reproduction the operator specified: state A at T-500ms,
// state B at T+300ms, liquidation at T, snapshot MUST use state A.
// ============================================================

scenario(
  "CAUSALITY: future order-book (bookTicker+depth) update excluded, state at T-500ms used instead",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: T - 500,
    }); // state A
    deps.orderbookStore.setDepth({
      symbol: SYMBOL,
      bids: [{ price: 999, quantity: 5 }],
      asks: [{ price: 1001, quantity: 5 }],
      timestamp: T - 500,
    } as any);
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 5999,
      bidQty: 1,
      ask: 6001,
      askQty: 1,
      timestamp: T + 300,
    }); // state B -- future, must be rejected
    deps.orderbookStore.setDepth({
      symbol: SYMBOL,
      bids: [{ price: 5999, quantity: 999 }],
      asks: [{ price: 6001, quantity: 999 }],
      timestamp: T + 300,
    } as any);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.priceState.bestBid,
      999,
      "must use state A's bid (999), never state B's future bid (5999)",
    );
    assert.strictEqual(
      snap.orderBook.orderBookUpdatedAt,
      T - 500,
      "orderBookUpdatedAt must be state A's timestamp",
    );
    assert.ok(
      snap.orderBook.orderBookAgeMs >= 0,
      `orderBookAgeMs must never be negative, got ${snap.orderBook.orderBookAgeMs}`,
    );
  },
);

scenario(
  "CAUSALITY: future price-history sample excluded from priceChange deltas",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: T - 60_000 - 500,
    }); // ~1m ago, state A
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 99999,
      bidQty: 1,
      ask: 100001,
      askQty: 1,
      timestamp: T + 300,
    }); // future, must never affect any delta
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.ok(
      Math.abs(snap.priceState.priceChange1mPct) < 1,
      `priceChange1mPct must reflect state A (~0%), not the future spike -- got ${snap.priceState.priceChange1mPct}`,
    );
  },
);

scenario(
  "CAUSALITY: future aggTrade excluded from taker-flow windows (pre-existing AggressiveFlowService guard)",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.aggressiveFlow.ingest({
      symbol: SYMBOL,
      quoteQty: 1000,
      aggressor: "BUY",
      timestamp: T - 5_000,
    } as any);
    deps.aggressiveFlow.ingest({
      symbol: SYMBOL,
      quoteQty: 999_999,
      aggressor: "SELL",
      timestamp: T + 5_000,
    } as any); // future
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.takerFlow["10s"].takerSellUsd,
      0,
      "future SELL trade must not appear in the 10s window",
    );
    assert.strictEqual(snap.takerFlow["10s"].takerBuyUsd, 1000);
  },
);

scenario(
  "CAUSALITY: future OI update excluded, historical OI at-or-before T used instead",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 5000, fetchedAt: T - 500 }, // state A
      { contracts: 999_999, fetchedAt: T + 300 }, // future -- must be rejected
    ]);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.openInterest.openInterest,
      5000,
      "must use the OI reading from T-500ms, never the future one",
    );
    assert.strictEqual(snap.openInterest.oiUpdatedAt, T - 500);
    assert.ok(
      snap.openInterest.oiAgeMs >= 0,
      `oiAgeMs must never be negative, got ${snap.openInterest.oiAgeMs}`,
    );
  },
);

scenario("CAUSALITY: future positioning update excluded", () => {
  const deps = freshDeps();
  const T = 1_000_000;
  (deps.fundingStats as any).cache.set(SYMBOL, {
    symbol: SYMBOL,
    ratio: 1.5,
    longAccount: 0.6,
    shortAccount: 0.4,
    bucketTime: T + 300,
    fetchedAt: T + 300,
  }); // future
  const event = liq("SELL", 1000, 10_000, T);
  const snap = buildMarketSnapshot(deps, event, T) as any;
  assert.strictEqual(
    snap.positioning.globalLongShortAccountRatio,
    null,
    "a positioning reading fetched AFTER T must be rejected, not used",
  );
  assert.strictEqual(snap.positioning.positioningAgeMs, null);
});

scenario("CAUSALITY: future funding update excluded", () => {
  const deps = freshDeps();
  const T = 1_000_000;
  (deps.fundingRate as any).cache.set(SYMBOL, {
    rate: 0.0005,
    fetchedAt: T + 300,
  }); // future
  const event = liq("SELL", 1000, 10_000, T);
  const snap = buildMarketSnapshot(deps, event, T) as any;
  assert.strictEqual(
    snap.funding.fundingRate,
    null,
    "a funding rate fetched AFTER T must be rejected, not used",
  );
  assert.strictEqual(snap.funding.fundingAgeMs, null);
});

scenario(
  "CAUSALITY: future liquidation event excluded from same-side/opposite-side context",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.liquidationStore.ingest(liq("SELL", 999, 5000, T - 500)); // state A, valid
    deps.liquidationStore.ingest(liq("BUY", 1001, 999_999, T + 5_000)); // future, must be excluded even though it's a real store entry
    const event = liq("SELL", 1000, 10_000, T);
    deps.liquidationStore.ingest(event);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.liquidationContext.oppositeSideLiqUsd30s,
      0,
      "the future opposite-side liquidation must not be counted",
    );
    assert.strictEqual(
      snap.liquidationContext.sameSideLiqUsd30s,
      15_000,
      "only the two same-side events at/before T (5000+10000)",
    );
  },
);

scenario(
  "CAUSALITY: ATR candle closing after T excluded, causal ATR-at-T used instead",
  () => {
    const deps = freshDeps();
    const T = 5 * 60_000; // T = 5 minutes in
    // 5 closed 1m candles well before T
    let t = 0;
    for (let i = 0; i < 5; i++) {
      const c = mkCandle("1m", t, 1000, 1000, 1000 - i, 1000 - i);
      deps.directionalAtr1m.onCandle(c);
      t += 60_000;
    }
    const preT_downAtr = deps.directionalAtr1m.getDownAtrAtOrBefore(
      SYMBOL,
      T,
      60_000,
    );
    // a candle that CLOSES after T (openTime=T, closes at T+59999) -- must not affect an AtOrBefore(T) read
    deps.directionalAtr1m.onCandle(mkCandle("1m", T, 1000, 1000, 1, 1)); // dramatic low -- would swing ATR if wrongly included
    const postFutureCandle_downAtr = deps.directionalAtr1m.getDownAtrAtOrBefore(
      SYMBOL,
      T,
      60_000,
    );
    assert.strictEqual(
      postFutureCandle_downAtr,
      preT_downAtr,
      "a candle closing after T must not change the AtOrBefore(T) ATR reading",
    );
  },
);

scenario(
  "CAUSALITY: no ageMs field is ever negative, across a full snapshot with mixed past/future sources",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: T - 100,
    });
    deps.orderbookStore.setDepth({
      symbol: SYMBOL,
      bids: [{ price: 999, quantity: 5 }],
      asks: [{ price: 1001, quantity: 5 }],
      timestamp: T - 100,
    } as any);
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 5999,
      bidQty: 1,
      ask: 6001,
      askQty: 1,
      timestamp: T + 9000,
    }); // future
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 5000, fetchedAt: T - 100 },
      { contracts: 1, fetchedAt: T + 9000 },
    ]); // future
    (deps.fundingStats as any).cache.set(SYMBOL, {
      symbol: SYMBOL,
      ratio: 1,
      longAccount: 0.5,
      shortAccount: 0.5,
      bucketTime: T + 9000,
      fetchedAt: T + 9000,
    }); // future
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    const ageFields: [string, number | null][] = [
      ["openInterest.oiAgeMs", snap.openInterest.oiAgeMs],
      ["orderBook.orderBookAgeMs", snap.orderBook.orderBookAgeMs],
      ["positioning.positioningAgeMs", snap.positioning.positioningAgeMs],
      ["funding.fundingAgeMs", snap.funding.fundingAgeMs],
    ];
    for (const [name, v] of ageFields)
      assert.ok(
        v === null || v >= 0,
        `${name} must never be negative, got ${v}`,
      );
  },
);

// ============================================================
// Sep 15 2026, operator-reported second gap. Root cause: the
// orchestrator's own "bookTicker" WS handler never called
// orderbookStore.setBookTicker() -- only "orderbook" (depth) called
// its own setDepth(). OrderbookStore's causal ring/accessors
// themselves were always correct (proven by the CAUSALITY tests
// above); they simply never received bookTicker data to serve in
// production. Fixed with a single added call, not a design change.
// ============================================================

scenario(
  "WIRING: orchestrator's bookTicker WS handler feeds orderbookStore.setBookTicker() (the actual root cause)",
  () => {
    const src = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = src.indexOf('this.ws.on("bookTicker"');
    assert.ok(idx > -1, "bookTicker handler must exist");
    const body = src.slice(idx, idx + 1200);
    assert.ok(
      body.includes("this.orderbookStore.setBookTicker(b)"),
      "the bookTicker handler must feed orderbookStore.setBookTicker() -- this was the actual root cause of bestBid/bestAsk/midPrice/priceChange*Pct always being null in production",
    );
  },
);

scenario(
  "END-TO-END: realistic bookTicker+depth sequence -> liquidation -> every previously-null field is now populated and causal",
  () => {
    const deps = freshDeps();
    let t = 0;
    // warm up 1m candles so ATR (and thus the *Pct fields) has something real to normalize
    for (let i = 0; i < 20; i++) {
      const price = 1.4 - i * 0.0001;
      const c = mkCandle("1m", t, price, price + 0.0002, price - 0.0002, price);
      deps.candleStore.ingest(c);
      deps.atrTracker.onCandle(c);
      deps.directionalAtr1m.onCandle(c);
      t += 60_000;
    }
    // realistic bookTicker + depth sequence covering the full 5-minute
    // window (one sample every 6s), so every priceChange*Pct window has
    // a real historical sample to compare against
    for (let i = 0; i < 50; i++) {
      const ts = t - (50 - i) * 6_000;
      const price = 1.4 - i * 0.00002;
      deps.orderbookStore.setBookTicker({
        symbol: SYMBOL,
        bid: price - 0.0001,
        bidQty: 10,
        ask: price + 0.0001,
        askQty: 10,
        timestamp: ts,
      });
      deps.orderbookStore.setDepth({
        symbol: SYMBOL,
        bids: [{ price: price - 0.0001, quantity: 5000 }],
        asks: [{ price: price + 0.0001, quantity: 4000 }],
        timestamp: ts,
      } as any);
    }
    const event = liq("SELL", 1.399, 5000, t);
    const snap = buildMarketSnapshot(deps, event, t) as any;

    assert.ok(
      snap.priceState.bestBid !== null,
      "bestBid must now be populated",
    );
    assert.ok(
      snap.priceState.bestAsk !== null,
      "bestAsk must now be populated",
    );
    assert.ok(
      snap.priceState.midPrice !== null,
      "midPrice must now be populated",
    );
    assert.ok(snap.priceState.spread !== null, "spread must now be populated");
    assert.ok(
      snap.priceState.spreadPct !== null,
      "spreadPct must now be populated",
    );
    for (const w of ["10s", "30s", "1m", "2m", "3m", "5m"])
      assert.ok(
        snap.priceState[`priceChange${w}Pct`] !== null,
        `priceChange${w}Pct must now be populated`,
      );

    assert.ok(snap.orderBook.bestBid !== null);
    assert.ok(
      snap.orderBook.depthBands !== null,
      "depthBands must now be populated",
    );

    assert.ok(
      snap.atr["1m"].normalAtrPct !== null,
      "normalAtrPct must now be populated once midPrice is available",
    );
    assert.ok(snap.atr["1m"].atrDownPct !== null);
    assert.ok(snap.atr["1m"].atrUpPct !== null);
    assert.ok(snap.atr["1m"].liquidationDirectionAtrPct !== null);
    assert.ok(snap.atr["1m"].recoveryDirectionAtrPct !== null);

    // causality still holds throughout
    assert.ok(snap.orderBook.orderBookAgeMs >= 0);
    assert.ok(
      snap.priceState.bestBid < 1.4 && snap.priceState.bestBid > 1.38,
      "must reflect the LAST bookTicker sample at-or-before t, not a future or unrelated value",
    );
  },
);

// ============================================================
// Sep 15 2026, operator-reported THIRD gap. Root cause: the raw
// bookTicker/depth ring (used for CURRENT bestBid/bestAsk/midPrice/
// depthBands) was evicting by a fixed ENTRY COUNT (50), not a time
// window. On a high-frequency symbol, 50 entries can represent well
// under a second of real time -- so any realistic processing lag
// between a liquidation's own timestamp and when the handler actually
// runs could mean EVERY retained raw entry already postdates T, even
// though the SAME data was clearly available a moment earlier (as
// proven by the 5-minute, time-windowed derived-summary ring still
// having it -- which is exactly why priceChange*Pct kept working
// while bestBid/midPrice/depthBands did not). Fixed by switching the
// raw ring to the SAME time-window retention model already proven
// correct for the derived-summary ring.
// ============================================================

scenario(
  "BURST: current bestBid/bestAsk/midPrice survive a rapid-fire update burst that would have exceeded the old fixed-count ring",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    // 200 bookTicker/depth updates in the 2 seconds before T -- far more
    // than the OLD ring's fixed cap of 50 entries, which would have
    // evicted the T-2000ms..T range entirely by the time T is queried
    for (let i = 0; i < 200; i++) {
      const ts = T - 2000 + i * 10; // every 10ms
      deps.orderbookStore.setBookTicker({
        symbol: SYMBOL,
        bid: 999 + i * 0.001,
        bidQty: 1,
        ask: 1001 + i * 0.001,
        askQty: 1,
        timestamp: ts,
      });
      deps.orderbookStore.setDepth({
        symbol: SYMBOL,
        bids: [{ price: 999 + i * 0.001, quantity: 5 }],
        asks: [{ price: 1001 + i * 0.001, quantity: 5 }],
        timestamp: ts,
      } as any);
    }
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.ok(
      snap.priceState.bestBid !== null,
      "bestBid must survive a 200-update burst that would have overflowed a 50-entry count-capped ring",
    );
    assert.ok(
      snap.orderBook.depthBands !== null,
      "depthBands must survive the same burst",
    );
    assert.ok(
      snap.orderBook.orderBookUpdatedAt <= T,
      "the selected sample must never postdate T",
    );
    assert.ok(snap.orderBook.orderBookAgeMs >= 0);
  },
);

scenario(
  "BURST: historical priceChange AND current bestBid/midPrice are BOTH available from the same burst (the exact real-world symptom)",
  () => {
    const deps = freshDeps();
    const T = 5 * 60_000 + 2000;
    // steady updates for 5 minutes, then a burst in the last 2 seconds
    for (let i = 0; i < 50; i++) {
      const ts = T - 300_000 + i * 6_000;
      deps.orderbookStore.setBookTicker({
        symbol: SYMBOL,
        bid: 999,
        bidQty: 1,
        ask: 1001,
        askQty: 1,
        timestamp: ts,
      });
      deps.orderbookStore.setDepth({
        symbol: SYMBOL,
        bids: [{ price: 999, quantity: 5000 }],
        asks: [{ price: 1001, quantity: 4000 }],
        timestamp: ts,
      } as any);
    }
    for (let i = 0; i < 200; i++) {
      const ts = T - 2000 + i * 10;
      deps.orderbookStore.setBookTicker({
        symbol: SYMBOL,
        bid: 1009,
        bidQty: 1,
        ask: 1011,
        askQty: 1,
        timestamp: ts,
      });
      deps.orderbookStore.setDepth({
        symbol: SYMBOL,
        bids: [{ price: 1009, quantity: 6000 }],
        asks: [{ price: 1011, quantity: 3000 }],
        timestamp: ts,
      } as any);
    }
    const event = liq("SELL", 1010, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.ok(
      snap.priceState.priceChange1mPct !== null,
      "historical priceChange1mPct must be available",
    );
    assert.ok(
      snap.priceState.bestBid !== null,
      "current bestBid must ALSO be available -- this is the exact real-world symptom: history worked, current state did not",
    );
    assert.ok(
      snap.orderBook.bookImbalanceChangeVs1mAgo !== null,
      "historical depth delta must be available",
    );
    assert.ok(
      snap.orderBook.depthBands !== null,
      "current depthBands must ALSO be available",
    );
  },
);

// ============================================================
// Sep 15 2026, operator-reported FOURTH gap. Root cause: NOT the
// builder or causality -- the depthBands["0.05pct"] key contains a
// literal embedded dot, which the research exporter's naive
// path.split(".") parser could not traverse ("depthBands.0.05pct.
// bidDepthUsd" splits into 4 segments instead of 3). The builder's
// own causal computation was already correct throughout. Fixed by
// adding flat, explicitly-named aliases (bidDepth5bpUsd/
// askDepth5bpUsd/imbalance5bp) alongside the existing depthBands
// object (unchanged, all 4 bands, nested) -- additive, not a
// restructure -- and pointing the exporter at the flat names.
// ============================================================

scenario(
  "5BP DEPTH: bidDepth5bpUsd/askDepth5bpUsd/imbalance5bp are populated with valid causal depth",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: T - 100,
    });
    // mid = 1000, 5bp = 0.05% = 0.5 -- levels within [999.5, 1000.5] should count; further levels should not
    deps.orderbookStore.setDepth({
      symbol: SYMBOL,
      bids: [
        { price: 999.7, quantity: 10 },
        { price: 990, quantity: 999 },
      ], // 990 is outside the 5bp band, must be excluded
      asks: [
        { price: 1000.3, quantity: 6 },
        { price: 1010, quantity: 999 },
      ], // 1010 is outside the 5bp band, must be excluded
      timestamp: T - 100,
    } as any);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.orderBook.bidDepth5bpUsd,
      999.7 * 10,
      "bidDepth5bpUsd must sum only levels within 5bp of mid, excluding the far level",
    );
    assert.strictEqual(
      snap.orderBook.askDepth5bpUsd,
      1000.3 * 6,
      "askDepth5bpUsd must sum only levels within 5bp of mid, excluding the far level",
    );
    const expectedImbalance =
      (999.7 * 10 - 1000.3 * 6) / (999.7 * 10 + 1000.3 * 6);
    assert.ok(
      Math.abs(snap.orderBook.imbalance5bp - expectedImbalance) < 1e-9,
      `imbalance5bp must equal (bid-ask)/(bid+ask), expected ${expectedImbalance}, got ${snap.orderBook.imbalance5bp}`,
    );
  },
);

scenario(
  "5BP DEPTH: matches depthBands['0.05pct'] exactly -- flat fields are aliases, not a separate computation",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: T - 100,
    });
    deps.orderbookStore.setDepth({
      symbol: SYMBOL,
      bids: [{ price: 999.7, quantity: 10 }],
      asks: [{ price: 1000.3, quantity: 6 }],
      timestamp: T - 100,
    } as any);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    const band = snap.orderBook.depthBands["0.05pct"];
    assert.strictEqual(snap.orderBook.bidDepth5bpUsd, band.bidDepthUsd);
    assert.strictEqual(snap.orderBook.askDepth5bpUsd, band.askDepthUsd);
    assert.strictEqual(snap.orderBook.imbalance5bp, band.bookImbalance);
  },
);

scenario(
  "5BP DEPTH: a future depth snapshot is never used for bidDepth5bpUsd/askDepth5bpUsd/imbalance5bp",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: T - 500,
    });
    deps.orderbookStore.setDepth({
      symbol: SYMBOL,
      bids: [{ price: 999.7, quantity: 10 }],
      asks: [{ price: 1000.3, quantity: 6 }],
      timestamp: T - 500,
    } as any); // state A, valid
    deps.orderbookStore.setDepth({
      symbol: SYMBOL,
      bids: [{ price: 999.7, quantity: 99999 }],
      asks: [{ price: 1000.3, quantity: 99999 }],
      timestamp: T + 300,
    } as any); // state B, future -- must be rejected
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.orderBook.bidDepth5bpUsd,
      999.7 * 10,
      "must use state A's depth, never the future state B's inflated quantity",
    );
    assert.strictEqual(snap.orderBook.askDepth5bpUsd, 1000.3 * 6);
  },
);

scenario(
  "5BP DEPTH: research exporter prints the values instead of '-' (reproduces the exact reported symptom)",
  () => {
    const src = fs.readFileSync(
      require.resolve("../scripts/inspect-liquidation-period.ts"),
      "utf8",
    );
    assert.ok(
      !src.includes('"depthBands.0.05pct'),
      "the exporter must no longer use the broken dotted-path lookup for the 5bp band",
    );
    assert.ok(
      src.includes('get(s.orderBook, "bidDepth5bpUsd")'),
      "the exporter must read the new flat bidDepth5bpUsd field",
    );
    assert.ok(
      src.includes('get(s.orderBook, "askDepth5bpUsd")'),
      "the exporter must read the new flat askDepth5bpUsd field",
    );
    assert.ok(
      src.includes('get(s.orderBook, "imbalance5bp")'),
      "the exporter must read the new flat imbalance5bp field",
    );
  },
);

// ============================================================
// Sep 15 2026, operator-approved high-resolution OI research.
// Tests for the new oiDelta*Pct/oiDelta*Usd/oiVelocity*/
// oiAccelerationPctPerSecSq fields added to openInterest.
// ============================================================

scenario("OI: exact-T sample is allowed (not treated as future)", () => {
  const deps = freshDeps();
  const T = 1_000_000;
  (deps.oiTracker as any).history.set(SYMBOL, [
    { contracts: 5000, fetchedAt: T },
  ]); // fetchedAt === T exactly
  const event = liq("SELL", 1000, 10_000, T);
  const snap = buildMarketSnapshot(deps, event, T) as any;
  assert.strictEqual(
    snap.openInterest.openInterest,
    5000,
    "a sample fetched at exactly T must be usable, not rejected",
  );
  assert.strictEqual(
    snap.openInterest.oiAgeMs,
    0,
    "age must be exactly 0, never negative, for a sample fetched at exactly T",
  );
});

scenario(
  "OI: historical target uses the LATEST sample <= target, not the nearest overall",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 4000, fetchedAt: T - 35_000 }, // older, should be ignored in favor of the closer one below
      { contracts: 4500, fetchedAt: T - 31_000 }, // this is the latest sample <= (T-30s), should be used for the 30s-ago comparison
      { contracts: 5000, fetchedAt: T }, // current
    ]);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    const expectedPct = ((5000 - 4500) / 4500) * 100;
    assert.ok(
      Math.abs(snap.openInterest.oiDelta30sPct - expectedPct) < 1e-9,
      `oiDelta30sPct must use the 4500 sample (latest <= T-30s), not the 4000 one -- expected ~${expectedPct}, got ${snap.openInterest.oiDelta30sPct}`,
    );
  },
);

scenario(
  "OI: insufficient history returns null, never a fabricated value",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 5000, fetchedAt: T },
    ]); // only the current sample exists -- no history far enough back
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.openInterest.oiDelta10mPct,
      null,
      "with no sample 10 minutes back, oiDelta10mPct must be null, not fabricated",
    );
    assert.strictEqual(snap.openInterest.oiDelta10mUsd, null);
  },
);

scenario(
  "OI: all new delta windows (5s..10m) are causal -- a future sample never leaks into any of them",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 4000, fetchedAt: T - 700_000 }, // far enough back to serve as the "past" reference for every window up to 10m
      { contracts: 5000, fetchedAt: T - 500 }, // "current" (at-or-before T)
      { contracts: 999_999, fetchedAt: T + 300 }, // future -- must never be selected as "current" for any window
    ]);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    const expectedPct = ((5000 - 4000) / 4000) * 100;
    for (const w of [
      "5s",
      "10s",
      "15s",
      "30s",
      "1m",
      "2m",
      "3m",
      "5m",
      "10m",
    ]) {
      assert.ok(
        Math.abs(snap.openInterest[`oiDelta${w}Pct`] - expectedPct) < 1e-9,
        `oiDelta${w}Pct must use the 4000 sample as its past reference and 5000 as current, never the future 999999 -- expected ~${expectedPct}, got ${snap.openInterest[`oiDelta${w}Pct`]}`,
      );
    }
    assert.strictEqual(
      snap.openInterest.openInterest,
      5000,
      "current OI must be the T-500 sample, never the future 999999 one",
    );
  },
);

scenario(
  "OI: zero delta remains 0, not null (the exact bug class caught earlier in this project)",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 5000, fetchedAt: T - 10_000 },
      { contracts: 5000, fetchedAt: T }, // unchanged -- delta should be exactly 0
    ]);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.openInterest.oiDelta10sPct,
      0,
      "unchanged OI must produce delta=0, not null",
    );
    assert.strictEqual(
      snap.openInterest.oiVelocity10sPctPerSec,
      0,
      "zero delta must produce zero velocity, not null",
    );
  },
);

scenario(
  "OI: oiAgeMs is never negative even when history contains a future sample",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 5000, fetchedAt: T - 100 },
      { contracts: 6000, fetchedAt: T + 5000 }, // future
    ]);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.ok(
      snap.openInterest.oiAgeMs >= 0,
      `oiAgeMs must never be negative, got ${snap.openInterest.oiAgeMs}`,
    );
    assert.strictEqual(
      snap.openInterest.oiAgeMs,
      100,
      "must reflect the causal T-100 sample's age, not the future sample's",
    );
  },
);

scenario(
  "OI: oiVelocity and oiAcceleration are purely numeric -- no semantic classification string anywhere in the output",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 5100, fetchedAt: T - 30_000 },
      { contracts: 5050, fetchedAt: T - 10_000 },
      { contracts: 5000, fetchedAt: T },
    ]);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    const serialized = JSON.stringify(snap.openInterest);
    for (const forbidden of [
      "accelerating",
      "decelerating",
      "stabilizing",
      "rebuilding",
    ]) {
      assert.ok(
        !serialized.toLowerCase().includes(forbidden),
        `openInterest must never contain the semantic label "${forbidden}" -- classification is explicitly out of scope for this recorder`,
      );
    }
    assert.strictEqual(
      typeof snap.openInterest.oiVelocity10sPctPerSec,
      "number",
    );
    assert.strictEqual(
      typeof snap.openInterest.oiAccelerationPctPerSecSq,
      "number",
    );
  },
);

scenario(
  "OI: USD delta uses a single consistent current midPrice basis (documented design choice)",
  () => {
    const deps = freshDeps();
    const T = 1_000_000;
    deps.orderbookStore.setBookTicker({
      symbol: SYMBOL,
      bid: 999,
      bidQty: 1,
      ask: 1001,
      askQty: 1,
      timestamp: T - 100,
    }); // midPrice = 1000
    (deps.oiTracker as any).history.set(SYMBOL, [
      { contracts: 4900, fetchedAt: T - 10_000 },
      { contracts: 5000, fetchedAt: T },
    ]);
    const event = liq("SELL", 1000, 10_000, T);
    const snap = buildMarketSnapshot(deps, event, T) as any;
    assert.strictEqual(
      snap.openInterest.oiDelta10sUsd,
      (5000 - 4900) * 1000,
      "USD delta must equal (contracts delta) x (current midPrice), the documented single-basis design",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
// Explicit exit regardless of outcome -- freshDeps() constructs
// OiTrackerService/FundingRateService instances (each with their own
// setInterval timer) once per scenario; without this, the process
// never exits naturally and hangs the rest of the npm test chain.
process.exit(failed > 0 ? 1 : 0);
