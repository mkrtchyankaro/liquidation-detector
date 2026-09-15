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

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
// Explicit exit regardless of outcome -- freshDeps() constructs
// OiTrackerService/FundingRateService instances (each with their own
// setInterval timer) once per scenario; without this, the process
// never exits naturally and hangs the rest of the npm test chain.
process.exit(failed > 0 ? 1 : 0);
