/**
 * Sep 8 2026 (Karo). Proves MAIN's own canonical, market-price-based
 * close lifecycle -- exercises the REAL V5WaveService directly
 * (hydrateActiveTrade + onPriceTickForTrades), not a mock, since this
 * IS the restored mechanism this whole feature depends on. Also
 * proves structurally that user-side (Karo/Artak) code can never
 * touch it.
 */
import * as assert from "assert";
import * as fs from "fs";
import { V5WaveService } from "../src/strategy/v5/v5-wave.service";

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

function makeV5(): V5WaveService {
  return new V5WaveService(
    () => 1, // getAtrAbs -- unused by onPriceTickForTrades
    () => null, // getOi
    () => 1000, // getBaseline
    () => 100, // getIndividualP95
  );
}

console.log("Running MAIN close-lifecycle tests...\n");

scenario(
  "MAIN closes on canonical TP -- a LONG trade's price crossing >= tp produces a TP close event",
  () => {
    const v5 = makeV5();
    v5.hydrateActiveTrade({
      signalId: "sig-tp-1",
      symbol: "XRPUSDT",
      victim: "LONG",
      side: "LONG",
      entry: 1.0,
      tp: 1.1,
      sl: 0.95,
      openedAt: 1000,
      bestPrice: 1.0,
      worstPrice: 1.0,
      entryWaveNumber: 1,
      isLive: false, // MUST be false -- see market-data-orchestrator.ts's own doc comment
      binanceSlOrderId: null,
      binanceTpOrderId: null,
      positionQty: null,
      notional: null,
      riskUsd: null,
    });

    const closes = v5.onPriceTickForTrades("XRPUSDT", 1.1, 2000);
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(closes[0]!.outcome, "TP");
    assert.strictEqual(closes[0]!.trade.signalId, "sig-tp-1");
    assert.strictEqual(closes[0]!.closePrice, 1.1);
  },
);

scenario(
  "MAIN closes on canonical SL -- a LONG trade's price crossing <= sl produces an SL close event",
  () => {
    const v5 = makeV5();
    v5.hydrateActiveTrade({
      signalId: "sig-sl-1",
      symbol: "ADAUSDT",
      victim: "SHORT",
      side: "SHORT",
      entry: 0.23,
      tp: 0.225,
      sl: 0.235,
      openedAt: 1000,
      bestPrice: 0.23,
      worstPrice: 0.23,
      entryWaveNumber: 2,
      isLive: false,
      binanceSlOrderId: null,
      binanceTpOrderId: null,
      positionQty: null,
      notional: null,
      riskUsd: null,
    });

    const closes = v5.onPriceTickForTrades("ADAUSDT", 0.236, 2000);
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(closes[0]!.outcome, "SL");
  },
);

scenario(
  "MAIN close works with ZERO Binance users -- isLive stays false throughout, no execution/Binance dependency of any kind",
  () => {
    const v5 = makeV5();
    v5.hydrateActiveTrade({
      signalId: "sig-noexec",
      symbol: "SOLUSDT",
      victim: "LONG",
      side: "LONG",
      entry: 100,
      tp: 105,
      sl: 98,
      openedAt: 1,
      bestPrice: 100,
      worstPrice: 100,
      entryWaveNumber: 1,
      isLive: false,
      binanceSlOrderId: null,
      binanceTpOrderId: null,
      positionQty: null,
      notional: null,
      riskUsd: null,
    });
    // No markTradeLive() call anywhere -- this trade is NEVER touched by
    // any Binance-execution concept, yet still closes correctly on
    // price alone.
    const closes = v5.onPriceTickForTrades("SOLUSDT", 105, 100);
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(closes[0]!.outcome, "TP");
  },
);

scenario(
  "a trade with isLive=true is NEVER closed by onPriceTickForTrades -- confirms why markTradeLive() must never be called on the shared MAIN instance",
  () => {
    const v5 = makeV5();
    v5.hydrateActiveTrade({
      signalId: "sig-live",
      symbol: "ETHUSDT",
      victim: "LONG",
      side: "LONG",
      entry: 2000,
      tp: 2100,
      sl: 1950,
      openedAt: 1,
      bestPrice: 2000,
      worstPrice: 2000,
      entryWaveNumber: 1,
      isLive: true, // simulating what WOULD happen if markTradeLive() were mistakenly called
      binanceSlOrderId: 1,
      binanceTpOrderId: 2,
      positionQty: 1,
      notional: 2000,
      riskUsd: 20,
    });
    const closes = v5.onPriceTickForTrades("ETHUSDT", 2100, 100);
    assert.strictEqual(
      closes.length,
      0,
      "an isLive=true trade must never be closed by market-price simulation",
    );
  },
);

console.log(
  "\nStructural proof: reconcile-user-position.usecase.ts (Karo/Artak's own close path) never references V5WaveService at all:",
);
scenario(
  "reconcile-user-position.usecase.ts contains zero references to V5WaveService, market-data-orchestrator, or GlobalSignalRepository",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/application/execution/reconcile-user-position.usecase.ts"),
      "utf8",
    );
    assert.ok(
      !source.includes("V5WaveService"),
      "must not import/reference V5WaveService",
    );
    assert.ok(
      !source.includes("MarketDataOrchestrator"),
      "must not import/reference MarketDataOrchestrator",
    );
    assert.ok(
      !source.includes("GlobalSignalRepository"),
      "must not import/reference GlobalSignalRepository -- confirms Karo/Artak's own close can never touch MAIN's own record or lock",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
