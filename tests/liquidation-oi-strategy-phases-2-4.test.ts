import * as assert from "assert";
import { SymbolOwnershipRegistry } from "../src/domain/liquidation-oi-strategy/symbol-ownership";
import {
  startEpisode,
  foldLiquidationIntoEpisode,
  updateEpisodeOi,
  oiDestructionFraction,
  liquidationToStartingOiRatio,
} from "../src/domain/liquidation-oi-strategy/episode-tracker";
import { qualifyWatch } from "../src/domain/liquidation-oi-strategy/watch-qualification";
import {
  detectClearingState,
  isClearingEndDetected,
} from "../src/domain/liquidation-oi-strategy/oi-clearing-detector";
import {
  evaluateEntryGates,
  counterMoveAtr,
} from "../src/domain/liquidation-oi-strategy/entry-gate-pipeline";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
import { LiquidationOiWatchManager } from "../src/domain/liquidation-oi-strategy/liquidation-oi-watch-manager";

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

const CFG = DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG;

function main(): void {
  console.log("Running liquidation-oi-strategy Phase 2-4 tests...\n");

  scenario(
    "P2.1. resolve() starts fresh ownership for an unowned symbol",
    () => {
      const reg = new SymbolOwnershipRegistry();
      const r = reg.resolve("BTCUSDT", "SHORT", () => "own-1");
      assert.strictEqual(r.action, "start");
      assert.strictEqual(reg.isOwned("BTCUSDT"), true);
    },
  );

  scenario(
    "P2.2. resolve() for the SAME victim on an already-owned symbol routes to the existing owner",
    () => {
      const reg = new SymbolOwnershipRegistry();
      reg.resolve("BTCUSDT", "SHORT", () => "own-1");
      const r = reg.resolve("BTCUSDT", "SHORT", () => "own-2");
      assert.strictEqual(r.action, "route");
      if (r.action === "route") assert.strictEqual(r.ownershipId, "own-1");
    },
  );

  scenario(
    "P2.3. resolve() for the OPPOSITE victim on an already-owned symbol is ignored",
    () => {
      const reg = new SymbolOwnershipRegistry();
      reg.resolve("BTCUSDT", "SHORT", () => "own-1");
      const r = reg.resolve("BTCUSDT", "LONG", () => "own-2");
      assert.strictEqual(r.action, "ignore");
      assert.strictEqual(reg.peek("BTCUSDT")?.victim, "SHORT");
    },
  );

  scenario("P2.4. release() frees the symbol for a brand new owner", () => {
    const reg = new SymbolOwnershipRegistry();
    reg.resolve("BTCUSDT", "SHORT", () => "own-1");
    reg.release("BTCUSDT");
    assert.strictEqual(reg.isOwned("BTCUSDT"), false);
    const r = reg.resolve("BTCUSDT", "LONG", () => "own-2");
    assert.strictEqual(r.action, "start");
  });

  scenario(
    "P2.5. hydrate() restores ownership without going through resolve()",
    () => {
      const reg = new SymbolOwnershipRegistry();
      reg.hydrate("ETHUSDT", "restored-id", "LONG");
      assert.strictEqual(reg.isOwned("ETHUSDT"), true);
      assert.strictEqual(reg.peek("ETHUSDT")?.ownershipId, "restored-id");
      const r = reg.resolve("ETHUSDT", "SHORT", () => "new-id");
      assert.strictEqual(r.action, "ignore");
    },
  );

  scenario(
    "P3.1. startEpisode initializes extreme/start to the first event's own price",
    () => {
      const ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "SHORT",
          timestamp: 1000,
          price: 100,
          quoteQty: 50000,
        },
        { quantity: 900, timestamp: 1000 },
      );
      assert.strictEqual(ep.startPrice, 100);
      assert.strictEqual(ep.extremePrice, 100);
      assert.strictEqual(ep.eventCount, 1);
      assert.strictEqual(ep.startOiQuantity, 900);
    },
  );

  scenario(
    "P3.2. foldLiquidationIntoEpisode updates the extreme only when more adverse",
    () => {
      let ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "SHORT",
          timestamp: 1000,
          price: 100,
          quoteQty: 50000,
        },
        null,
      );
      ep = foldLiquidationIntoEpisode(ep, {
        symbol: "BTCUSDT",
        victim: "SHORT",
        timestamp: 2000,
        price: 105,
        quoteQty: 30000,
      });
      assert.strictEqual(ep.extremePrice, 105);
      ep = foldLiquidationIntoEpisode(ep, {
        symbol: "BTCUSDT",
        victim: "SHORT",
        timestamp: 3000,
        price: 102,
        quoteQty: 10000,
      });
      assert.strictEqual(ep.extremePrice, 105);
      assert.strictEqual(ep.sameDirectionLiqUsd, 90000);
      assert.strictEqual(ep.eventCount, 3);
    },
  );

  scenario(
    "P3.3. updateEpisodeOi tracks the running minimum independent of the most recent sample",
    () => {
      let ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 10000,
        },
        { quantity: 1000, timestamp: 1000 },
      );
      ep = updateEpisodeOi(ep, { quantity: 950, timestamp: 2000 });
      ep = updateEpisodeOi(ep, { quantity: 960, timestamp: 3000 });
      assert.strictEqual(ep.currentOiQuantity, 960);
      assert.strictEqual(ep.minOiQuantity, 950);
    },
  );

  scenario(
    "P3.4. oiDestructionFraction is clamped at >=0 and null when data is unavailable",
    () => {
      let ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 10000,
        },
        { quantity: 1000, timestamp: 1000 },
      );
      ep = updateEpisodeOi(ep, { quantity: 800, timestamp: 2000 });
      assert.ok(Math.abs(oiDestructionFraction(ep)! - 0.2) < 1e-9);
      const epNoOi = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 10000,
        },
        null,
      );
      assert.strictEqual(oiDestructionFraction(epNoOi), null);
    },
  );

  scenario(
    "P3.5. liquidationToStartingOiRatio uses OI QUANTITY, never a USD field",
    () => {
      const ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 1_000_000,
        },
        { quantity: 10_000, timestamp: 1000 },
      );
      assert.ok(Math.abs(liquidationToStartingOiRatio(ep, 100)! - 1.0) < 1e-9);
      const epNoOi = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 1_000_000,
        },
        null,
      );
      assert.strictEqual(liquidationToStartingOiRatio(epNoOi, 100), null);
    },
  );

  scenario(
    "P3.6. WATCH qualification refuses NOT_READY percentile safely",
    () => {
      const ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 500000,
        },
        null,
      );
      const result = qualifyWatch(
        ep,
        {
          historicalSampleCount: null,
          historicalP90: null,
          historicalP95: null,
          historicalP99: null,
          percentileRank: null,
        },
        1.0,
        CFG,
      );
      assert.strictEqual(result.qualifies, false);
      if (!result.qualifies)
        assert.strictEqual(result.reasonCode, "PERCENTILE_NOT_READY");
    },
  );

  scenario(
    "P3.7. WATCH qualification refuses insufficient sample count even with a high rank",
    () => {
      const ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 500000,
        },
        null,
      );
      const result = qualifyWatch(
        ep,
        {
          historicalSampleCount: 2,
          historicalP90: 100,
          historicalP95: 150,
          historicalP99: 200,
          percentileRank: 99,
        },
        1.0,
        CFG,
      );
      assert.strictEqual(result.qualifies, false);
      if (!result.qualifies)
        assert.strictEqual(result.reasonCode, "INSUFFICIENT_SAMPLE_COUNT");
    },
  );

  scenario("P3.8. WATCH qualification refuses a low percentile rank", () => {
    const ep = startEpisode(
      {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: 1000,
        price: 100,
        quoteQty: 500000,
      },
      null,
    );
    const result = qualifyWatch(
      ep,
      {
        historicalSampleCount: 20,
        historicalP90: 100,
        historicalP95: 150,
        historicalP99: 200,
        percentileRank: 60,
      },
      1.0,
      CFG,
    );
    assert.strictEqual(result.qualifies, false);
    if (!result.qualifies)
      assert.strictEqual(result.reasonCode, "BELOW_MINIMUM_PERCENTILE_RANK");
  });

  scenario(
    "P3.9. WATCH qualification refuses insufficient displacement",
    () => {
      const ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 500000,
        },
        null,
      );
      const result = qualifyWatch(
        ep,
        {
          historicalSampleCount: 20,
          historicalP90: 100,
          historicalP95: 150,
          historicalP99: 200,
          percentileRank: 95,
        },
        1.0,
        CFG,
      );
      assert.strictEqual(result.qualifies, false);
      if (!result.qualifies)
        assert.strictEqual(result.reasonCode, "INSUFFICIENT_DISPLACEMENT");
    },
  );

  scenario(
    "P3.10. WATCH qualification succeeds when every gate genuinely passes",
    () => {
      let ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 1000, timestamp: 1000 },
      );
      ep = foldLiquidationIntoEpisode(ep, {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: 2000,
        price: 99,
        quoteQty: 200000,
      });
      const result = qualifyWatch(
        ep,
        {
          historicalSampleCount: 20,
          historicalP90: 300000,
          historicalP95: 500000,
          historicalP99: 900000,
          percentileRank: 97,
        },
        1.0,
        CFG,
      );
      assert.strictEqual(result.qualifies, true);
      if (result.qualifies) {
        assert.strictEqual(result.episodePercentileRank, 97);
        assert.ok(result.displacementAtr >= CFG.minDisplacementAtrForWatch);
      }
    },
  );

  scenario(
    "P4.1. strong destruction with no recovery shows a negative slope and no clearing",
    () => {
      const now = 100_000;
      const history = [
        { contracts: 1000, fetchedAt: now - 30_000 },
        { contracts: 950, fetchedAt: now - 20_000 },
        { contracts: 900, fetchedAt: now - 10_000 },
        { contracts: 875, fetchedAt: now - 3_000 },
        { contracts: 850, fetchedAt: now },
      ];
      const state = detectClearingState(history, now - 30_000, now, CFG);
      assert.ok(
        state.windows[0]!.slopeContractsPerSec! < 0,
        `5s window must show negative slope, got ${state.windows[0]!.slopeContractsPerSec}`,
      );
      assert.strictEqual(isClearingEndDetected(state, CFG), false);
    },
  );

  scenario(
    "P4.2. destruction that decelerates and stabilizes is detected",
    () => {
      const now = 100_000;
      const history = [
        { contracts: 1000, fetchedAt: now - 30_000 },
        { contracts: 900, fetchedAt: now - 20_000 },
        { contracts: 850, fetchedAt: now - 15_000 },
        { contracts: 849, fetchedAt: now - 10_000 },
        { contracts: 849.5, fetchedAt: now - 5_000 },
        { contracts: 849, fetchedAt: now },
      ];
      const state = detectClearingState(history, now - 30_000, now, CFG);
      assert.ok(state.peakDestructionSlopeContractsPerSec! < 0);
      assert.strictEqual(state.isStabilizing, true);
      assert.strictEqual(isClearingEndDetected(state, CFG), true);
    },
  );

  scenario(
    "P4.3. an early rebuild sign is detected when the shortest window's slope turns positive",
    () => {
      const now = 100_000;
      const history = [
        { contracts: 900, fetchedAt: now - 5_000 },
        { contracts: 910, fetchedAt: now },
      ];
      const state = detectClearingState(history, now - 30_000, now, CFG);
      assert.strictEqual(state.hasEarlyRebuildSign, true);
    },
  );

  scenario("P4.4. stale OI is reflected via mostRecentSampleAgeMs", () => {
    const now = 100_000;
    const history = [
      { contracts: 1000, fetchedAt: now - 60_000 },
      { contracts: 950, fetchedAt: now - 50_000 },
    ];
    const state = detectClearingState(history, now - 60_000, now, CFG);
    assert.strictEqual(state.mostRecentSampleAgeMs, 50_000);
  });

  scenario("P4.5. fewer than 2 samples in a window yields a null slope", () => {
    const now = 100_000;
    const history = [{ contracts: 1000, fetchedAt: now - 2_000 }];
    const state = detectClearingState(history, now - 30_000, now, CFG);
    for (const w of state.windows)
      assert.strictEqual(w.slopeContractsPerSec, null);
  });

  scenario(
    "P4.6. counterMoveAtr is computed correctly and symmetrically for LONG and SHORT",
    () => {
      assert.ok(
        Math.abs(
          counterMoveAtr({
            currentPrice: 102,
            extremePrice: 100,
            victim: "LONG",
            atr3m: 2,
          }) - 1.0,
        ) < 1e-9,
      );
      assert.ok(
        Math.abs(
          counterMoveAtr({
            currentPrice: 98,
            extremePrice: 100,
            victim: "SHORT",
            atr3m: 2,
          }) - 1.0,
        ) < 1e-9,
      );
    },
  );

  scenario(
    "P4.7. OI ALONE cannot trigger ENTRY_READY -- clearing detected but no counter-move yet must refuse",
    () => {
      const now = 100_000;
      let ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: now - 30_000,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 1000, timestamp: now - 30_000 },
      );
      ep = foldLiquidationIntoEpisode(ep, {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: now - 20_000,
        price: 95,
        quoteQty: 300000,
      });
      const history = [
        { contracts: 1000, fetchedAt: now - 30_000 },
        { contracts: 900, fetchedAt: now - 15_000 },
        { contracts: 899, fetchedAt: now - 5_000 },
        { contracts: 899, fetchedAt: now },
      ];
      const result = evaluateEntryGates({
        episode: ep,
        oiHistory: history,
        currentPrice: 95,
        atr3m: 1.0,
        atr3mAgeMs: 1000,
        nowMs: now,
        config: CFG,
      });
      assert.strictEqual(result.entryReady, false);
      if (!result.entryReady)
        assert.strictEqual(result.reasonCode, "NO_COUNTER_MOVE_YET");
    },
  );

  scenario(
    "P4.8. clearing not detected refuses entry even with a genuine price counter-move",
    () => {
      const now = 100_000;
      let ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: now - 30_000,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 1000, timestamp: now - 30_000 },
      );
      ep = foldLiquidationIntoEpisode(ep, {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: now - 20_000,
        price: 95,
        quoteQty: 300000,
      });
      const history = [
        { contracts: 1000, fetchedAt: now - 30_000 },
        { contracts: 900, fetchedAt: now - 15_000 },
        { contracts: 700, fetchedAt: now },
      ];
      const result = evaluateEntryGates({
        episode: ep,
        oiHistory: history,
        currentPrice: 95.5,
        atr3m: 1.0,
        atr3mAgeMs: 1000,
        nowMs: now,
        config: CFG,
      });
      assert.strictEqual(result.entryReady, false);
      if (!result.entryReady)
        assert.strictEqual(result.reasonCode, "CLEARING_NOT_DETECTED");
    },
  );

  scenario(
    "P4.9. entry refused when setup has become too far from the extreme",
    () => {
      const now = 100_000;
      let ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: now - 30_000,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 1000, timestamp: now - 30_000 },
      );
      ep = foldLiquidationIntoEpisode(ep, {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: now - 20_000,
        price: 95,
        quoteQty: 300000,
      });
      const history = [
        { contracts: 1000, fetchedAt: now - 30_000 },
        { contracts: 900, fetchedAt: now - 20_000 },
        { contracts: 850, fetchedAt: now - 15_000 },
        { contracts: 849, fetchedAt: now - 10_000 },
        { contracts: 849.5, fetchedAt: now - 5_000 },
        { contracts: 849, fetchedAt: now },
      ]; // same genuinely-cleared pattern as P4.2, confirmed to trigger isClearingEndDetected=true
      const result = evaluateEntryGates({
        episode: ep,
        oiHistory: history,
        currentPrice: 97,
        atr3m: 1.0,
        atr3mAgeMs: 1000,
        nowMs: now,
        config: CFG,
      }); // 2 ATR away from the extreme (95), beyond the 1.0 ATR default max
      assert.strictEqual(result.entryReady, false);
      if (!result.entryReady)
        assert.strictEqual(
          result.reasonCode,
          "TOO_FAR_FROM_EXTREME",
          `expected TOO_FAR_FROM_EXTREME, got ${result.reasonCode}`,
        );
    },
  );

  scenario(
    "P4.10. entry succeeds when clearing AND price confirmation both genuinely pass",
    () => {
      const now = 100_000;
      let ep = startEpisode(
        {
          symbol: "BTCUSDT",
          victim: "LONG",
          timestamp: now - 30_000,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 1000, timestamp: now - 30_000 },
      );
      ep = foldLiquidationIntoEpisode(ep, {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: now - 20_000,
        price: 95,
        quoteQty: 300000,
      });
      const history = [
        { contracts: 1000, fetchedAt: now - 30_000 },
        { contracts: 850, fetchedAt: now - 15_000 },
        { contracts: 849, fetchedAt: now - 5_000 },
        { contracts: 849, fetchedAt: now },
      ];
      const result = evaluateEntryGates({
        episode: ep,
        oiHistory: history,
        currentPrice: 95.3,
        atr3m: 1.0,
        atr3mAgeMs: 1000,
        nowMs: now,
        config: CFG,
      });
      assert.strictEqual(result.entryReady, true);
      if (result.entryReady) assert.strictEqual(result.candidateSide, "LONG");
    },
  );

  scenario("O.1. one symbol cannot create a SAME-side second WATCH", () => {
    const mgr = new LiquidationOiWatchManager();
    mgr.onLiquidationEvent(
      {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: 1000,
        price: 100,
        quoteQty: 500000,
      },
      { quantity: 1000, timestamp: 1000 },
    );
    mgr.onLiquidationEvent(
      {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: 2000,
        price: 99,
        quoteQty: 200000,
      },
      { quantity: 950, timestamp: 2000 },
    );
    mgr.onTick(
      "BTCUSDT",
      {
        historicalSampleCount: 20,
        historicalP90: 100,
        historicalP95: 200,
        historicalP99: 400,
        percentileRank: 97,
      },
      [],
      99,
      1.0,
      1000,
      3000,
    );
    assert.strictEqual(
      mgr.isSymbolOwned("BTCUSDT"),
      true,
      "test setup: BTCUSDT must now be owned",
    );
    mgr.onLiquidationEvent(
      {
        symbol: "BTCUSDT",
        victim: "LONG",
        timestamp: 4000,
        price: 98,
        quoteQty: 100000,
      },
      { quantity: 900, timestamp: 4000 },
    );
    const lc = mgr.getLifecycle("BTCUSDT")!;
    assert.strictEqual(
      lc.episode.eventCount,
      3,
      "the new event must fold into the existing owned episode, not create a second one",
    );
  });

  scenario(
    "O.2. one symbol cannot create an OPPOSITE-side setup while owned",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "ETHUSDT",
          victim: "SHORT",
          timestamp: 1000,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 1000, timestamp: 1000 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "ETHUSDT",
          victim: "SHORT",
          timestamp: 2000,
          price: 101,
          quoteQty: 200000,
        },
        { quantity: 1050, timestamp: 2000 },
      );
      mgr.onTick(
        "ETHUSDT",
        {
          historicalSampleCount: 20,
          historicalP90: 100,
          historicalP95: 200,
          historicalP99: 400,
          percentileRank: 97,
        },
        [],
        101,
        1.0,
        1000,
        3000,
      );
      assert.strictEqual(
        mgr.isSymbolOwned("ETHUSDT"),
        true,
        "test setup: ETHUSDT must now be owned by SHORT",
      );
      mgr.onLiquidationEvent(
        {
          symbol: "ETHUSDT",
          victim: "LONG",
          timestamp: 4000,
          price: 90,
          quoteQty: 999999,
        },
        { quantity: 800, timestamp: 4000 },
      );
      const lc = mgr.getLifecycle("ETHUSDT")!;
      assert.strictEqual(
        lc.episode.victim,
        "SHORT",
        "the LONG event must never replace the owned SHORT episode",
      );
    },
  );

  scenario(
    "O.3. cancel() releases ownership, allowing a fresh setup afterward",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 1000, timestamp: 1000 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "LONG",
          timestamp: 2000,
          price: 98,
          quoteQty: 200000,
        },
        { quantity: 950, timestamp: 2000 },
      );
      mgr.onTick(
        "SOLUSDT",
        {
          historicalSampleCount: 20,
          historicalP90: 100,
          historicalP95: 200,
          historicalP99: 400,
          percentileRank: 97,
        },
        [],
        98,
        1.0,
        1000,
        3000,
      );
      assert.strictEqual(mgr.isSymbolOwned("SOLUSDT"), true);
      mgr.cancel("SOLUSDT", "TEST_CANCEL", "manual test cancel", 4000);
      assert.strictEqual(mgr.isSymbolOwned("SOLUSDT"), false);
      assert.strictEqual(mgr.getLifecycle("SOLUSDT"), null);
      mgr.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "SHORT",
          timestamp: 5000,
          price: 105,
          quoteQty: 400000,
        },
        { quantity: 1100, timestamp: 5000 },
      );
      assert.strictEqual(mgr.getLifecycle("SOLUSDT")!.episode.victim, "SHORT");
    },
  );

  scenario(
    "O.4. NO_SIGNAL reasons are persisted in the log with explicit reason codes",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "XRPUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 1.0,
          quoteQty: 1000,
        },
        null,
      );
      mgr.onTick(
        "XRPUSDT",
        {
          historicalSampleCount: null,
          historicalP90: null,
          historicalP95: null,
          historicalP99: null,
          percentileRank: null,
        },
        [],
        1.0,
        1.0,
        1000,
        2000,
      );
      const log = mgr.getNoSignalLog();
      assert.ok(log.length > 0);
      assert.strictEqual(log[0]!.reasonCode, "PERCENTILE_NOT_READY");
      assert.strictEqual(log[0]!.symbol, "XRPUSDT");
    },
  );

  scenario(
    "O.5. the full happy-path lifecycle reaches ENTRY_READY through valid transitions only",
    () => {
      const mgr = new LiquidationOiWatchManager();
      const now0 = 1_000_000;
      const flatAtr = { get: (_i: string, _t: number) => 1.0 };
      const candle = (
        closeTime: number,
        open: number,
        high: number,
        low: number,
        close: number,
      ) =>
        ({
          symbol: "AVAXUSDT",
          interval: "1m",
          openTime: closeTime - 60_000,
          closeTime,
          open,
          high,
          low,
          close,
          volume: 0,
          isClosed: true,
        }) as any;
      mgr.onLiquidationEvent(
        {
          symbol: "AVAXUSDT",
          victim: "SHORT",
          timestamp: now0,
          price: 30,
          quoteQty: 500000,
        },
        { quantity: 5000, timestamp: now0 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "AVAXUSDT",
          victim: "SHORT",
          timestamp: now0 + 10_000,
          price: 31,
          quoteQty: 300000,
        },
        { quantity: 4700, timestamp: now0 + 10_000 },
      );
      mgr.onTick(
        "AVAXUSDT",
        {
          historicalSampleCount: 15,
          historicalP90: 200000,
          historicalP95: 400000,
          historicalP99: 700000,
          percentileRank: 96,
        },
        [],
        31,
        1.0,
        1000,
        now0 + 11_000,
        [],
        [],
        flatAtr,
      );
      assert.strictEqual(
        mgr.getLifecycle("AVAXUSDT")!.globalState,
        "EXHAUSTION_CANDIDATE",
      );

      // 1m recovery candidate: SHORT favorable = price falling, >=0.75 ATR from extreme(31).
      const c1 = candle(now0 + 60_000, 31, 31, 30.1, 30.1);
      mgr.onTick(
        "AVAXUSDT",
        {
          historicalSampleCount: 15,
          historicalP90: 200000,
          historicalP95: 400000,
          historicalP99: 700000,
          percentileRank: 96,
        },
        [],
        30.1,
        1.0,
        1000,
        now0 + 65_000,
        [c1],
        [],
        flatAtr,
      );

      const c2 = candle(now0 + 120_000, 30.1, 30.3, 29.9, 30.0);
      const c3 = candle(now0 + 180_000, 30.0, 30.2, 29.7, 29.8);
      const c3m = candle(now0 + 180_000, 31, 31, 29.7, 29.8);
      const historyAtEpisodeEnd = [
        { contracts: 5000, fetchedAt: now0 },
        { contracts: 4600, fetchedAt: now0 + 20_000 },
        { contracts: 4590, fetchedAt: now0 + 25_000 },
        { contracts: 4590, fetchedAt: now0 + 180_000 },
      ];
      mgr.onTick(
        "AVAXUSDT",
        {
          historicalSampleCount: 15,
          historicalP90: 200000,
          historicalP95: 400000,
          historicalP99: 700000,
          percentileRank: 96,
        },
        historyAtEpisodeEnd,
        29.8,
        1.0,
        1000,
        now0 + 185_000,
        [c2, c3],
        [c3m],
        flatAtr,
      );
      assert.strictEqual(
        mgr.getLifecycle("AVAXUSDT")!.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
        "episode end must be confirmed before entry, never OI-driven",
      );

      const historyWithCreation = [
        ...historyAtEpisodeEnd,
        { contracts: 4640, fetchedAt: now0 + 200_000 },
      ];
      mgr.onTick(
        "AVAXUSDT",
        {
          historicalSampleCount: 15,
          historicalP90: 200000,
          historicalP95: 400000,
          historicalP99: 700000,
          percentileRank: 96,
        },
        historyWithCreation,
        29.7,
        1.0,
        1000,
        now0 + 200_000,
        [],
        [],
        flatAtr,
      );
      const finalLc = mgr.getLifecycle("AVAXUSDT")!;
      assert.strictEqual(finalLc.globalState, "ENTRY_READY");
      assert.strictEqual(finalLc.entryResult?.entryReady, true);
    },
  );

  // ============== Direction-sticky internal episode ownership (fix) ==============

  scenario(
    "D.1. LONG episode tracking + small SHORT liquidation -> LONG episode preserved",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "DOGEUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 0.1,
          quoteQty: 100000,
        },
        { quantity: 50000, timestamp: 1000 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "DOGEUSDT",
          victim: "SHORT",
          timestamp: 1500,
          price: 0.105,
          quoteQty: 500,
        },
        { quantity: 50050, timestamp: 1500 },
      ); // small opposite event, before ownership
      const lc = mgr.getLifecycle("DOGEUSDT")!;
      assert.strictEqual(
        lc.episode.victim,
        "LONG",
        "the tracked episode must remain LONG -- an opposite SHORT event must never take over, even before WATCH_QUALIFIED",
      );
      assert.strictEqual(
        lc.episode.eventCount,
        1,
        "the SHORT event must not be folded into the episode's own event count",
      );
    },
  );

  scenario(
    "D.2. SHORT episode tracking + small LONG liquidation -> SHORT episode preserved",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "ADAUSDT",
          victim: "SHORT",
          timestamp: 1000,
          price: 0.5,
          quoteQty: 100000,
        },
        { quantity: 20000, timestamp: 1000 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "ADAUSDT",
          victim: "LONG",
          timestamp: 1500,
          price: 0.49,
          quoteQty: 300,
        },
        { quantity: 19980, timestamp: 1500 },
      );
      const lc = mgr.getLifecycle("ADAUSDT")!;
      assert.strictEqual(lc.episode.victim, "SHORT");
      assert.strictEqual(lc.episode.eventCount, 1);
    },
  );

  scenario(
    "D.3. same-direction events continue accumulating normally despite an interleaved opposite event",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "LINKUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 10,
          quoteQty: 50000,
        },
        null,
      );
      mgr.onLiquidationEvent(
        {
          symbol: "LINKUSDT",
          victim: "SHORT",
          timestamp: 1200,
          price: 10.1,
          quoteQty: 1000,
        },
        null,
      ); // ignored
      mgr.onLiquidationEvent(
        {
          symbol: "LINKUSDT",
          victim: "LONG",
          timestamp: 1500,
          price: 9.8,
          quoteQty: 40000,
        },
        null,
      ); // must still fold normally
      const lc = mgr.getLifecycle("LINKUSDT")!;
      assert.strictEqual(
        lc.episode.eventCount,
        2,
        "only the two LONG events must be counted -- the interleaved SHORT event must not consume a slot",
      );
      assert.strictEqual(lc.episode.sameDirectionLiqUsd, 90000);
    },
  );

  scenario("D.4. opposite event does not alter episode total USD", () => {
    const mgr = new LiquidationOiWatchManager();
    mgr.onLiquidationEvent(
      {
        symbol: "SUIUSDT",
        victim: "SHORT",
        timestamp: 1000,
        price: 2.0,
        quoteQty: 200000,
      },
      null,
    );
    const before = mgr.getLifecycle("SUIUSDT")!.episode.sameDirectionLiqUsd;
    mgr.onLiquidationEvent(
      {
        symbol: "SUIUSDT",
        victim: "LONG",
        timestamp: 1200,
        price: 1.9,
        quoteQty: 999999,
      },
      null,
    ); // huge opposite event
    const after = mgr.getLifecycle("SUIUSDT")!.episode.sameDirectionLiqUsd;
    assert.strictEqual(
      after,
      before,
      "sameDirectionLiqUsd must be completely unaffected by an opposite-direction event, regardless of its own size",
    );
  });

  scenario(
    "D.5. opposite event does not alter episode extreme/start state incorrectly",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "BNBUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 500,
          quoteQty: 100000,
        },
        null,
      );
      const beforeExtreme = mgr.getLifecycle("BNBUSDT")!.episode.extremePrice;
      const beforeStart = mgr.getLifecycle("BNBUSDT")!.episode.startPrice;
      // an opposite SHORT event at a price that WOULD be a new extreme if (incorrectly) folded as if LONG
      mgr.onLiquidationEvent(
        {
          symbol: "BNBUSDT",
          victim: "SHORT",
          timestamp: 1200,
          price: 450,
          quoteQty: 50000,
        },
        null,
      );
      const lc = mgr.getLifecycle("BNBUSDT")!;
      assert.strictEqual(
        lc.episode.extremePrice,
        beforeExtreme,
        "extreme must be completely untouched by the opposite event's own price",
      );
      assert.strictEqual(lc.episode.startPrice, beforeStart);
    },
  );

  scenario(
    "D.6. after explicit episode cancel, the opposite direction is allowed to become the next episode",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "XRPUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 1.0,
          quoteQty: 100000,
        },
        { quantity: 10000, timestamp: 1000 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "XRPUSDT",
          victim: "LONG",
          timestamp: 2000,
          price: 0.98,
          quoteQty: 80000,
        },
        { quantity: 9800, timestamp: 2000 },
      );
      mgr.onTick(
        "XRPUSDT",
        {
          historicalSampleCount: 20,
          historicalP90: 100,
          historicalP95: 200,
          historicalP99: 400,
          percentileRank: 97,
        },
        [],
        0.98,
        0.01,
        1000,
        3000,
      );
      assert.strictEqual(
        mgr.getLifecycle("XRPUSDT")!.episode.victim,
        "LONG",
        "test setup: must be tracking LONG",
      );
      mgr.cancel("XRPUSDT", "TEST_RESET", "explicit reset for the test", 4000);
      assert.strictEqual(
        mgr.getLifecycle("XRPUSDT"),
        null,
        "cancel must fully clear the tracked episode",
      );
      mgr.onLiquidationEvent(
        {
          symbol: "XRPUSDT",
          victim: "SHORT",
          timestamp: 5000,
          price: 1.05,
          quoteQty: 60000,
        },
        null,
      );
      assert.strictEqual(
        mgr.getLifecycle("XRPUSDT")!.episode.victim,
        "SHORT",
        "only AFTER an explicit cancel may the opposite direction start a fresh episode",
      );
    },
  );

  scenario(
    "D.7. a WATCH_QUALIFIED (and beyond) episode remains direction-sticky exactly the same way as EPISODE_TRACKING",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "SHORT",
          timestamp: 1000,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 5000, timestamp: 1000 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "SHORT",
          timestamp: 2000,
          price: 103,
          quoteQty: 300000,
        },
        { quantity: 4800, timestamp: 2000 },
      );
      mgr.onTick(
        "SOLUSDT",
        {
          historicalSampleCount: 20,
          historicalP90: 100000,
          historicalP95: 200000,
          historicalP99: 400000,
          percentileRank: 97,
        },
        [],
        103,
        1.0,
        1000,
        3000,
      );
      const lcAfterPromotion = mgr.getLifecycle("SOLUSDT")!;
      assert.strictEqual(
        lcAfterPromotion.globalState,
        "EXHAUSTION_CANDIDATE",
        "test setup: must have reached WATCH_QUALIFIED->EXHAUSTION_CANDIDATE",
      );
      assert.strictEqual(mgr.isSymbolOwned("SOLUSDT"), true);
      const beforeUsd = lcAfterPromotion.episode.sameDirectionLiqUsd;
      const beforeExtreme = lcAfterPromotion.episode.extremePrice;
      // opposite-direction event arrives AFTER formal WATCH ownership is claimed
      mgr.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "LONG",
          timestamp: 4000,
          price: 95,
          quoteQty: 999999,
        },
        null,
      );
      const lcAfter = mgr.getLifecycle("SOLUSDT")!;
      assert.strictEqual(
        lcAfter.episode.victim,
        "SHORT",
        "victim direction must remain SHORT after WATCH_QUALIFIED, exactly as before it",
      );
      assert.strictEqual(
        lcAfter.episode.sameDirectionLiqUsd,
        beforeUsd,
        "USD total must remain untouched post-WATCH too",
      );
      assert.strictEqual(
        lcAfter.episode.extremePrice,
        beforeExtreme,
        "extreme must remain untouched post-WATCH too",
      );
      const ignoredLog = mgr.getOppositeEventIgnoredLog();
      assert.ok(
        ignoredLog.some(
          (e) => e.symbol === "SOLUSDT" && e.ignoredVictim === "LONG",
        ),
        "the ignored opposite event must be recorded in strategy telemetry",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
