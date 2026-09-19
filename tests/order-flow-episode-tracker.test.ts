import * as assert from "assert";
import { OrderFlowEpisodeTracker, type LifecycleSnapshot } from "../src/domain/liquidation-oi-strategy/order-flow-episode-tracker";
import { cvdUsd, imbalancePct, classifySpotConfirmation, classifyFuturesOiMove } from "../src/domain/liquidation-oi-strategy/order-flow-interpretation";
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

function lc(overrides: Partial<LifecycleSnapshot>): LifecycleSnapshot {
  return {
    episodeId: "ep-1", globalState: "EPISODE_TRACKING", victim: "SHORT",
    startPrice: 10, startOiQuantity: 1_000_000, sameDirectionLiqUsd: 50_000,
    episodeEndPrice: null, episodeEndOiQuantity: null,
    ...overrides,
  };
}

function main(): void {
  scenario("1. m === false is counted as aggressive BUY", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ isBuyerMaker: false, aggressor: "BUY", quoteQty: 500 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.futuresTakerBuyUsd, 500);
    assert.strictEqual(s!.futuresTakerSellUsd, 0);
  });

  scenario("2. m === true is counted as aggressive SELL", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ isBuyerMaker: true, aggressor: "SELL", quoteQty: 700 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.futuresTakerSellUsd, 700);
    assert.strictEqual(s!.futuresTakerBuyUsd, 0);
  });

  scenario("3. USD notional = price * quantity, exactly", () => {
    const t = trade({ price: 12.34, quantity: 56.7, quoteQty: 12.34 * 56.7 });
    assert.ok(Math.abs(t.quoteQty - 699.678) < 0.001);
  });

  scenario("4. cvdUsd = buyUsd - sellUsd", () => {
    assert.strictEqual(cvdUsd(1000, 400), 600);
    assert.strictEqual(cvdUsd(400, 1000), -600);
    assert.strictEqual(cvdUsd(500, 500), 0);
  });

  scenario("5. imbalancePct = (buy - sell) / total * 100, and 0 when total is 0", () => {
    assert.strictEqual(imbalancePct(75, 25), 50);
    assert.strictEqual(imbalancePct(25, 75), -50);
    assert.strictEqual(imbalancePct(0, 0), 0);
  });

  scenario("6a. trades before episode start (no lifecycle yet) are excluded", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.ingestFuturesTrade(trade({ quoteQty: 999 }));
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 100 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.futuresTakerBuyUsd, 100, "the pre-episode trade must never be counted");
  });

  scenario("6b. trades after freeze (episode end) are excluded until a reopen resumes", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 100 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 5000 }));
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.futuresTakerBuyUsd, 100, "trades arriving while frozen must not be counted");
  });

  scenario("6c. a reopen resumes accumulation and the next freeze includes the new trades too", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 100 }));
    const waitLc = lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 });
    tr.onLifecycleTransition("LINKUSDT", lc({}), waitLc, 1_001_000);
    const reopenLc = lc({ globalState: "EXHAUSTION_CANDIDATE" });
    tr.onLifecycleTransition("LINKUSDT", waitLc, reopenLc, 1_002_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 200 }));
    tr.onLifecycleTransition("LINKUSDT", reopenLc, lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.6, episodeEndOiQuantity: 1_000_300 }), 1_003_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.futuresTakerBuyUsd, 300, "cumulative across the reopen: 100 (before first freeze) + 200 (after resume) = 300");
  });

  scenario("7. trades for a different symbol never leak into another symbol's accumulator", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ symbol: "LINKUSDT", quoteQty: 100 }));
    tr.ingestFuturesTrade(trade({ symbol: "BTCUSDT", quoteQty: 99999 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.futuresTakerBuyUsd, 100);
    assert.strictEqual(tr.getFrozenStats("BTCUSDT", "ep-1"), null);
  });

  scenario("8. a brand-new episodeId for the same symbol starts a fresh accumulator, old one's data does not bleed in", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({ episodeId: "ep-1" }), 1_000_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 100 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ episodeId: "ep-1" }), lc({ episodeId: "ep-1", globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    tr.onLifecycleTransition("LINKUSDT", lc({ episodeId: "ep-1" }), null, 1_002_000);
    tr.onLifecycleTransition("LINKUSDT", null, lc({ episodeId: "ep-2", startOiQuantity: 2_000_000 }), 1_003_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 777 }));
    tr.onLifecycleTransition("LINKUSDT", lc({ episodeId: "ep-2" }), lc({ episodeId: "ep-2", globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 11, episodeEndOiQuantity: 2_000_200 }), 1_004_000);
    const s2 = tr.getFrozenStats("LINKUSDT", "ep-2");
    assert.strictEqual(s2!.futuresTakerBuyUsd, 777, "episode 2 must start from zero, not inherit episode 1's 100");
    assert.strictEqual(tr.getFrozenStats("LINKUSDT", "ep-1"), null, "episode 1's snapshot must no longer be reachable once released");
  });

  scenario("9. duplicate aggTradeId (WS reconnect re-delivery) is not double-counted", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ aggTradeId: 42, quoteQty: 100 }));
    tr.ingestFuturesTrade(trade({ aggTradeId: 42, quoteQty: 100 }));
    tr.ingestFuturesTrade(trade({ aggTradeId: 43, quoteQty: 50 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.futuresTakerBuyUsd, 150, "id 42 must only count once (100 + 50 = 150, not 250)");
  });

  scenario("9b. Spot and Futures dedup namespaces are separate (same aggTradeId on both markets does not collide)", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ aggTradeId: 1, quoteQty: 100 }));
    tr.ingestSpotTrade(trade({ aggTradeId: 1, quoteQty: 200 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.futuresTakerBuyUsd, 100);
    assert.strictEqual(s!.spotTakerBuyUsd, 200, "Spot's own id=1 must be counted independently of Futures' id=1");
  });

  scenario("10a. LONG candidate: SPOT_CONFIRM when Spot is meaningfully BUY-led", () => {
    assert.strictEqual(classifySpotConfirmation("LONG", 20, 5, true), "SPOT_CONFIRM");
  });
  scenario("10b. LONG candidate: SPOT_CONTRADICT when Spot is meaningfully SELL-led", () => {
    assert.strictEqual(classifySpotConfirmation("LONG", -20, 5, true), "SPOT_CONTRADICT");
  });
  scenario("10c. SHORT candidate: mirrored -- SPOT_CONFIRM when Spot is meaningfully SELL-led", () => {
    assert.strictEqual(classifySpotConfirmation("SHORT", -20, 5, true), "SPOT_CONFIRM");
  });
  scenario("10d. SHORT candidate: mirrored -- SPOT_CONTRADICT when Spot is meaningfully BUY-led", () => {
    assert.strictEqual(classifySpotConfirmation("SHORT", 20, 5, true), "SPOT_CONTRADICT");
  });
  scenario("10e. within the neutral band -> SPOT_NEUTRAL regardless of side", () => {
    assert.strictEqual(classifySpotConfirmation("LONG", 3, 5, true), "SPOT_NEUTRAL");
    assert.strictEqual(classifySpotConfirmation("SHORT", -3, 5, true), "SPOT_NEUTRAL");
  });

  scenario("11a. LONG candidate, price up + OI down -> SHORT_COVERING_OR_DELEVERAGING", () => {
    assert.strictEqual(classifyFuturesOiMove("LONG", 2, -10, 2), "SHORT_COVERING_OR_DELEVERAGING");
  });
  scenario("11b. LONG candidate, price up + OI flat -> POSITION_TRANSFER_OR_MIXED", () => {
    assert.strictEqual(classifyFuturesOiMove("LONG", 2, 0.5, 2), "POSITION_TRANSFER_OR_MIXED");
  });
  scenario("11c. LONG candidate, price up + OI up -> NEW_FUTURES_POSITIONING", () => {
    assert.strictEqual(classifyFuturesOiMove("LONG", 2, 10, 2), "NEW_FUTURES_POSITIONING");
  });
  scenario("11d. SHORT candidate (mirrored), price down + OI down -> LONG_LIQUIDATION_OR_DELEVERAGING", () => {
    assert.strictEqual(classifyFuturesOiMove("SHORT", -2, -10, 2), "LONG_LIQUIDATION_OR_DELEVERAGING");
  });
  scenario("11e. null oiDeltaPct (OI data unavailable) -> null label, never fabricated", () => {
    assert.strictEqual(classifyFuturesOiMove("LONG", 2, null, 2), null);
  });

  scenario("12. no Spot trades ingested -> spotDataAvailable=false, SPOT_NA, and the snapshot still freezes with full Futures/OI data intact", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 500 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.spotDataAvailable, false);
    assert.strictEqual(s!.spotConfirmationLabel, "SPOT_NA");
    assert.strictEqual(s!.futuresTakerBuyUsd, 500, "Futures data must be unaffected by missing Spot data");
  });

  scenario("13. observedLiquidationUsd is reported separately and is never added into futuresTakerSellUsd", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({ sameDirectionLiqUsd: 10_000 }), 1_000_000);
    tr.ingestFuturesTrade(trade({ aggressor: "SELL", isBuyerMaker: true, quoteQty: 300 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100, sameDirectionLiqUsd: 25_000 }), 1_001_000);
    const s = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s!.observedLiquidationUsd, 25_000);
    assert.strictEqual(s!.futuresTakerSellUsd, 300, "must be ONLY the aggTrade-observed sell flow, liquidation USD never folded in");
  });

  scenario("14. stats are genuinely frozen -- new trades after freeze never mutate the already-taken snapshot", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 100 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const s1 = tr.getFrozenStats("LINKUSDT", "ep-1");
    tr.ingestFuturesTrade(trade({ quoteQty: 99999 }));
    const s2 = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(s1!.futuresTakerBuyUsd, 100);
    assert.strictEqual(s2!.futuresTakerBuyUsd, 100, "re-reading the frozen snapshot must return the identical, unmutated value");
  });

  scenario("15. getFrozenStats reads the SAME frozen values regardless of how much later it is called (simulating a signal emitted well after episode end)", () => {
    const tr = new OrderFlowEpisodeTracker();
    tr.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    tr.ingestFuturesTrade(trade({ quoteQty: 250 }));
    tr.onLifecycleTransition("LINKUSDT", lc({}), lc({ globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 10.5, episodeEndOiQuantity: 1_000_100 }), 1_001_000);
    const sLater = tr.getFrozenStats("LINKUSDT", "ep-1");
    assert.strictEqual(sLater!.futuresTakerBuyUsd, 250, "the ENTRY signal, emitted long after freeze, must still see the frozen episode-end values");
    assert.strictEqual(sLater!.frozenAtMs, 1_001_000);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
