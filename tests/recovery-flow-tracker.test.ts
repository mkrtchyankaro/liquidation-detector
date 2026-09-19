import * as assert from "assert";
import { RecoveryFlowTracker, type RecoveryLifecycleSnapshot } from "../src/domain/liquidation-oi-strategy/recovery-flow-tracker";
import { formatRecoveryFlowLine } from "../src/domain/liquidation-oi-strategy/telegram-formatter";
import type { Trade } from "../src/shared/common.types";

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
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function trade(overrides: Partial<Trade>): Trade {
  return {
    symbol: "LINKUSDT", timestamp: 1_000_000, price: 10, quantity: 100, quoteQty: 1000,
    isBuyerMaker: false, aggressor: "BUY", aggTradeId: undefined,
    ...overrides,
  };
}

function lc(overrides: Partial<RecoveryLifecycleSnapshot>): RecoveryLifecycleSnapshot {
  return {
    episodeId: "ep-1", globalState: "EXHAUSTION_CANDIDATE", victim: "SHORT",
    episodeMaxAdverseExtreme: 100, episodeEndPrice: null, episodeEndTime: null,
    ...overrides,
  };
}

function main(): void {
  scenario("1. LONG recovery window starts exactly at the final (lowest) extreme's own timestamp", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({ victim: "LONG", episodeMaxAdverseExtreme: 100 }), 1_000_000);
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "LONG" }), lc({ victim: "LONG", episodeMaxAdverseExtreme: 95 }), 1_005_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_010_000, quoteQty: 500 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "LONG", episodeMaxAdverseExtreme: 95 }), lc({ victim: "LONG", episodeMaxAdverseExtreme: 95, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 96, episodeEndTime: 1_015_000 }), 1_015_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryStartAt, 1_005_000, "must start at the LAST extreme update, not episode start (1_000_000)");
    assert.strictEqual(s!.recoveryExtremePrice, 95);
  });

  scenario("2. SHORT recovery window starts exactly at the final (highest) extreme's own timestamp", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({ victim: "SHORT", episodeMaxAdverseExtreme: 100 }), 1_000_000);
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "SHORT" }), lc({ victim: "SHORT", episodeMaxAdverseExtreme: 105 }), 1_005_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_010_000, quoteQty: 500 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "SHORT", episodeMaxAdverseExtreme: 105 }), lc({ victim: "SHORT", episodeMaxAdverseExtreme: 105, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 104, episodeEndTime: 1_015_000 }), 1_015_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryStartAt, 1_005_000);
    assert.strictEqual(s!.recoveryExtremePrice, 105);
  });

  scenario("3. a SECOND, even lower LONG low replaces the recovery start again -- flow before it is excluded", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({ victim: "LONG", episodeMaxAdverseExtreme: 100 }), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_002_000, quoteQty: 111 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "LONG" }), lc({ victim: "LONG", episodeMaxAdverseExtreme: 95 }), 1_005_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_006_000, quoteQty: 222 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "LONG", episodeMaxAdverseExtreme: 95 }), lc({ victim: "LONG", episodeMaxAdverseExtreme: 90 }), 1_008_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_009_000, quoteQty: 333 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "LONG", episodeMaxAdverseExtreme: 90 }), lc({ victim: "LONG", episodeMaxAdverseExtreme: 90, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 91, episodeEndTime: 1_015_000 }), 1_015_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryStartAt, 1_008_000, "must use the SECOND (final) low's timestamp");
    assert.strictEqual(s!.recoveryExtremePrice, 90);
    assert.strictEqual(s!.recoveryFuturesTakerBuyUsd, 333, "only flow after the FINAL replaced extreme counts (111 and 222 must be excluded)");
  });

  scenario("4. a SECOND, even higher SHORT high replaces the recovery start again -- flow before it is excluded", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({ victim: "SHORT", episodeMaxAdverseExtreme: 100 }), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_002_000, quoteQty: 111 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "SHORT" }), lc({ victim: "SHORT", episodeMaxAdverseExtreme: 105 }), 1_005_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_006_000, quoteQty: 222 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "SHORT", episodeMaxAdverseExtreme: 105 }), lc({ victim: "SHORT", episodeMaxAdverseExtreme: 110 }), 1_008_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_009_000, quoteQty: 333 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ victim: "SHORT", episodeMaxAdverseExtreme: 110 }), lc({ victim: "SHORT", episodeMaxAdverseExtreme: 110, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 109, episodeEndTime: 1_015_000 }), 1_015_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryStartAt, 1_008_000);
    assert.strictEqual(s!.recoveryExtremePrice, 110);
    assert.strictEqual(s!.recoveryFuturesTakerBuyUsd, 333);
  });

  scenario("5. trades strictly before recoveryStartAt are excluded even when only ONE extreme ever occurred", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 999_999, quoteQty: 9999 }));
    tr.ingestFuturesTrade(trade({ timestamp: 1_000_500, quoteQty: 50 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryFuturesTakerBuyUsd, 50, "the trade at 999_999 (before recoveryStartAt=1_000_000) must be excluded");
  });

  scenario("6. trades after recoveryEndAt (confirmation) are excluded from the frozen snapshot", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_001_000, quoteQty: 50 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_003_000, quoteQty: 9999 }));
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryFuturesTakerBuyUsd, 50, "trade after recoveryEndAt must never be counted, even though the buffer still holds it");
  });

  scenario("7. boundary timestamp exactly AT recoveryStartAt is included (inclusive)", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_000_000, quoteQty: 10 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryFuturesTakerBuyUsd, 10, "the exactly-at-start trade must be included");
  });

  scenario("8a. Futures: m===false counted as BUY", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_001_000, isBuyerMaker: false, aggressor: "BUY", quoteQty: 300 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryFuturesTakerBuyUsd, 300);
  });
  scenario("8b. Spot: m===true counted as SELL", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestSpotTrade(trade({ timestamp: 1_001_000, isBuyerMaker: true, aggressor: "SELL", quoteQty: 400 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoverySpotTakerSellUsd, 400);
  });

  scenario("9. notional/CVD/imbalance are computed correctly over the recovery window", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_001_000, price: 10, quantity: 30, quoteQty: 300, aggressor: "BUY" }));
    tr.ingestFuturesTrade(trade({ timestamp: 1_001_500, price: 10, quantity: 10, quoteQty: 100, aggressor: "SELL" }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryFuturesTakerBuyUsd, 300);
    assert.strictEqual(s!.recoveryFuturesTakerSellUsd, 100);
    assert.strictEqual(s!.recoveryFuturesCvdUsd, 200);
    assert.strictEqual(s!.recoveryFuturesImbalancePct, 50);
  });

  scenario("10. recoveryOiStart/End/Delta are computed from the nearest samples to the window boundaries", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestOiSamples("LINKUSDT", [{ contracts: 5000, fetchedAt: 1_000_010 }], 1_000_010);
    tr.ingestOiSamples("LINKUSDT", [{ contracts: 5200, fetchedAt: 1_001_990 }], 1_001_990);
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryOiStart, 5000);
    assert.strictEqual(s!.recoveryOiEnd, 5200);
    assert.strictEqual(s!.recoveryOiDelta, 200);
    assert.ok(Math.abs(s!.recoveryOiDeltaPct! - 4) < 0.001);
  });

  scenario("11. no OI samples anywhere near the window -> oiDataAvailable=false, deltas null", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestOiSamples("LINKUSDT", [{ contracts: 5000, fetchedAt: 500_000 }], 500_000);
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.oiDataAvailable, false);
    assert.strictEqual(s!.recoveryOiDelta, null);
    assert.strictEqual(s!.recoveryOiDeltaPct, null);
  });

  scenario("12. no Spot trades in the window -> spotDataAvailable=false, Telegram line prints SPOT: N/A", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_001_000, quoteQty: 500 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1")!;
    assert.strictEqual(s.spotDataAvailable, false);
    const line = formatRecoveryFlowLine({ ...s, recoveryMoveAtr: 1.0 });
    assert.ok(line.includes("SPOT: N/A"), `expected "SPOT: N/A" in:\n${line}`);
  });

  scenario("13. duplicate aggTradeId (reconnect re-delivery) is not double-counted within the recovery window", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_001_000, aggTradeId: 7, quoteQty: 100 }));
    tr.ingestFuturesTrade(trade({ timestamp: 1_001_100, aggTradeId: 7, quoteQty: 100 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.recoveryFuturesTakerBuyUsd, 100, "id 7 must only count once");
  });

  scenario("14. tracker calls for an untracked symbol/episode are safe no-ops (never throw, never fabricate data)", () => {
    const tr = new RecoveryFlowTracker();
    assert.doesNotThrow(() => tr.ingestFuturesTrade(trade({ symbol: "UNKNOWNUSDT" })));
    assert.doesNotThrow(() => tr.ingestSpotTrade(trade({ symbol: "UNKNOWNUSDT" })));
    assert.doesNotThrow(() => tr.ingestOiSamples("UNKNOWNUSDT", [{ contracts: 1, fetchedAt: 1 }], 1));
    assert.strictEqual(tr.getFrozenStats("UNKNOWNUSDT", "ep-x"), null);
  });

  scenario("15. the old Episode Flow header ('Flow (episode)') is never produced by the Recovery Flow formatter", () => {
    const tr = new RecoveryFlowTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ timestamp: 1_001_000, quoteQty: 500 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_002_000 }), 1_002_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1")!;
    const line = formatRecoveryFlowLine({ ...s, recoveryMoveAtr: 1.0 });
    assert.ok(!line.includes("Flow (episode)"), "must never print the retired Episode Flow header");
    assert.ok(line.startsWith("Recovery Flow: Extreme"), "must print the new Recovery Flow header instead");
  });

  scenario("16a. LONG example message matches the operator's own format", () => {
    const stats = {
      symbol: "BTCUSDT", episodeId: "ep-1", victim: "LONG" as const,
      recoveryStartAt: 1_000_000, recoveryEndAt: 1_074_000, recoveryDurationMs: 74_000,
      recoveryExtremePrice: 100, recoveryConfirmationPrice: 101.08, recoveryMoveAtr: 1.08,
      spotDataAvailable: true, recoverySpotTakerBuyUsd: 3_400_000, recoverySpotTakerSellUsd: 2_200_000,
      recoverySpotCvdUsd: 1_200_000, recoverySpotImbalancePct: 21.4, recoverySpotPriceDeltaPct: 1.0, recoverySpotVolumeUsd: 5_600_000,
      spotConfirmationLabel: "SPOT_CONFIRM" as const,
      recoveryFuturesTakerBuyUsd: 8_200_000, recoveryFuturesTakerSellUsd: 5_100_000, recoveryFuturesCvdUsd: 3_100_000,
      recoveryFuturesImbalancePct: 23.3, recoveryFuturesPriceDeltaPct: 1.08,
      oiDataAvailable: true, recoveryOiStart: 100_000, recoveryOiEnd: 99_690, recoveryOiDelta: -310, recoveryOiDeltaPct: -0.31,
      recoveryOiMoveLabel: "SHORT_COVERING_OR_DELEVERAGING" as const,
      frozenAtMs: 1_074_000,
    };
    const line = formatRecoveryFlowLine(stats);
    assert.ok(line.includes("FUT: Buy $8.20M | Sell $5.10M"), line);
    assert.ok(line.includes("SPOT: Buy $3.40M | Sell $2.20M"), line);
    assert.ok(line.includes("SHORT COVERING"), line);
    assert.ok(line.includes("SPOT CONFIRM"), line);
    assert.ok(line.includes("+1.08 ATR"), line);
    assert.ok(line.includes("Duration: 74s"), line);
  });

  scenario("16b. SHORT example message matches the operator's own format", () => {
    const stats = {
      symbol: "BTCUSDT", episodeId: "ep-2", victim: "SHORT" as const,
      recoveryStartAt: 1_000_000, recoveryEndAt: 1_068_000, recoveryDurationMs: 68_000,
      recoveryExtremePrice: 100, recoveryConfirmationPrice: 98.97, recoveryMoveAtr: -1.03,
      spotDataAvailable: true, recoverySpotTakerBuyUsd: 2_500_000, recoverySpotTakerSellUsd: 3_800_000,
      recoverySpotCvdUsd: -1_300_000, recoverySpotImbalancePct: -20.6, recoverySpotPriceDeltaPct: -1.0, recoverySpotVolumeUsd: 6_300_000,
      spotConfirmationLabel: "SPOT_CONFIRM" as const,
      recoveryFuturesTakerBuyUsd: 4_600_000, recoveryFuturesTakerSellUsd: 7_900_000, recoveryFuturesCvdUsd: -3_300_000,
      recoveryFuturesImbalancePct: -26.4, recoveryFuturesPriceDeltaPct: -1.03,
      oiDataAvailable: true, recoveryOiStart: 100_000, recoveryOiEnd: 100_270, recoveryOiDelta: 270, recoveryOiDeltaPct: 0.27,
      recoveryOiMoveLabel: "NEW_FUTURES_POSITIONING" as const,
      frozenAtMs: 1_068_000,
    };
    const line = formatRecoveryFlowLine(stats);
    assert.ok(line.includes("FUT: Buy $4.60M | Sell $7.90M"), line);
    assert.ok(line.includes("SPOT: Buy $2.50M | Sell $3.80M"), line);
    assert.ok(line.includes("NEW POSITIONING"), line);
    assert.ok(line.includes("SPOT CONFIRM"), line);
    assert.ok(line.includes("-1.03 ATR"), line);
    assert.ok(line.includes("Duration: 68s"), line);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
