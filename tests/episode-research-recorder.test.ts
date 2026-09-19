import * as assert from "assert";
import { EpisodeResearchRecorder, type ResearchLifecycleSnapshot } from "../src/domain/liquidation-oi-strategy/episode-research-recorder";
import { MarketSnapshotCache } from "../src/domain/liquidation-oi-strategy/market-snapshot-cache";
import type { Trade, BookTicker } from "../src/shared/common.types";

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

function bt(overrides: Partial<BookTicker>): BookTicker {
  return { symbol: "LINKUSDT", bid: 9.99, bidQty: 10, ask: 10.01, askQty: 10, timestamp: 1_000_000, ...overrides };
}

function lc(overrides: Partial<ResearchLifecycleSnapshot>): ResearchLifecycleSnapshot {
  return {
    episodeId: "ep-1", globalState: "EPISODE_TRACKING", victim: "SHORT",
    episodeMaxAdverseExtreme: 100, episodeEndPrice: null, episodeEndTime: null,
    episodeStartPrice: 100, episodeStartOiQuantity: 5000, sameDirectionLiqUsd: 0,
    ...overrides,
  };
}

function main(): void {
  scenario("LONG mirror: extreme is the LOWEST price, recovery is priced going UP", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({ victim: "LONG", episodeMaxAdverseExtreme: 100, episodeStartPrice: 100 }), 1_000_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ victim: "LONG" }), lc({ victim: "LONG", episodeMaxAdverseExtreme: 90 }), 1_005_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ victim: "LONG", episodeMaxAdverseExtreme: 90 }), lc({ victim: "LONG", episodeMaxAdverseExtreme: 90, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 95, episodeEndTime: 1_010_000 }), 1_010_000);
    const record = rec.onEpisodeTerminal("LINKUSDT", 1_010_000, "TIMEOUT")!;
    assert.strictEqual(record.finalExtremeSnapshot!.price, 90, "LONG's final extreme must be the LOWEST price seen");
    assert.strictEqual(record.recoveryFlow!.futuresPriceStart, 90);
    assert.strictEqual(record.recoveryFlow!.futuresPriceEnd, 95, "recovery ends higher than the extreme for a LONG");
  });

  scenario("SHORT mirror: extreme is the HIGHEST price, recovery is priced going DOWN", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({ victim: "SHORT", episodeMaxAdverseExtreme: 100, episodeStartPrice: 100 }), 1_000_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ victim: "SHORT" }), lc({ victim: "SHORT", episodeMaxAdverseExtreme: 110 }), 1_005_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ victim: "SHORT", episodeMaxAdverseExtreme: 110 }), lc({ victim: "SHORT", episodeMaxAdverseExtreme: 110, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 105, episodeEndTime: 1_010_000 }), 1_010_000);
    const record = rec.onEpisodeTerminal("LINKUSDT", 1_010_000, "TIMEOUT")!;
    assert.strictEqual(record.finalExtremeSnapshot!.price, 110, "SHORT's final extreme must be the HIGHEST price seen");
    assert.strictEqual(record.recoveryFlow!.futuresPriceStart, 110);
    assert.strictEqual(record.recoveryFlow!.futuresPriceEnd, 105, "recovery ends lower than the extreme for a SHORT");
  });

  scenario("a new extreme resets the ACTIVE Recovery Flow window and pushes the old one into recoveryFlowHistory", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    rec.onLifecycleTransition("LINKUSDT", lc({}), lc({ episodeMaxAdverseExtreme: 105 }), 1_005_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 105 }), lc({ episodeMaxAdverseExtreme: 105, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 104, episodeEndTime: 1_008_000 }), 1_008_000);
    const firstRecovery = rec.getRecord("LINKUSDT", "ep-1")!.recoveryFlow;
    assert.ok(firstRecovery !== null);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 105, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION" }), lc({ episodeMaxAdverseExtreme: 105, globalState: "EXHAUSTION_CANDIDATE" }), 1_009_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 105 }), lc({ episodeMaxAdverseExtreme: 112 }), 1_011_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 112 }), lc({ episodeMaxAdverseExtreme: 112, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 108, episodeEndTime: 1_013_000 }), 1_013_000);
    const record = rec.onEpisodeTerminal("LINKUSDT", 1_013_000, "TIMEOUT")!;
    assert.strictEqual(record.recoveryFlowHistory.length, 1, "the FIRST recovery computation must be preserved in history");
    assert.strictEqual(record.recoveryFlowHistory[0]!.futuresPriceStart, 105, "the historical entry must reflect the OLD extreme");
    assert.strictEqual(record.recoveryFlow!.futuresPriceStart, 112, "the ACTIVE recovery flow must reflect the NEW, final extreme");
    assert.strictEqual(record.extremeSnapshots.length, 2, "both extremes must be recorded in the full chain");
  });

  scenario("timeout, no-entry episode: still persisted with noEntryReason set and both flow windows computed", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    rec.onLiquidationEvent("LINKUSDT", 1_000_500, "SHORT", 50, 500, 100, 500, false);
    rec.onLifecycleTransition("LINKUSDT", lc({}), lc({ episodeMaxAdverseExtreme: 103 }), 1_002_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 103 }), lc({ episodeMaxAdverseExtreme: 103, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 101, episodeEndTime: 1_005_000 }), 1_005_000);
    const record = rec.onEpisodeTerminal("LINKUSDT", 1_800_000, "WAIT_FOR_POST_EPISODE_OI_CREATION_TIMEOUT")!;
    assert.strictEqual(record.entrySnapshot, null, "no entry must have occurred");
    assert.strictEqual(record.noEntryReason, "WAIT_FOR_POST_EPISODE_OI_CREATION_TIMEOUT");
    assert.strictEqual(record.entryReason, null);
    assert.ok(record.flushFlow !== null, "Flush Flow must still be computed for a no-entry episode");
    assert.ok(record.recoveryFlow !== null, "Recovery Flow must still be computed, ending at episode end since there was no entry");
    assert.strictEqual(record.recoveryFlow!.endAt, 1_800_000, "no-entry Recovery Flow must end at the episode's own terminal timestamp");
  });

  scenario("liquidation notional is never double-counted into Futures taker buy/sell volume", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    rec.onLiquidationEvent("LINKUSDT", 1_000_500, "SHORT", 100, 1000, 100, 1000, false);
    rec.ingestFuturesTrade(trade({ timestamp: 1_000_600, aggressor: "SELL", quoteQty: 250 }));
    rec.onLifecycleTransition("LINKUSDT", lc({}), lc({ episodeMaxAdverseExtreme: 103 }), 1_001_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 103 }), lc({ episodeMaxAdverseExtreme: 103, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 99, episodeEndTime: 1_002_000 }), 1_002_000);
    const record = rec.onEpisodeTerminal("LINKUSDT", 1_003_000, "TIMEOUT")!;
    assert.strictEqual(record.flushFlow!.totalObservedLiquidationUsd, 1000, "liquidation USD is its own separate total");
    assert.strictEqual(record.flushFlow!.futuresSellUsd, 250, "futuresSellUsd must be ONLY the aggTrade flow (250), the 1000 liquidation notional must NOT be added in");
    assert.strictEqual(record.liquidationEventSnapshots[0]!.notionalUsd, 1000);
  });

  scenario("stale OI: sample far outside the staleness window returns N/A (null), not a fabricated value", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    rec.ingestOiSamples("LINKUSDT", [{ contracts: 5000, fetchedAt: 100_000 }], 100_000);
    rec.onLifecycleTransition("LINKUSDT", lc({}), lc({ episodeMaxAdverseExtreme: 100 }), 1_001_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 100 }), lc({ episodeMaxAdverseExtreme: 100, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 99, episodeEndTime: 1_002_000 }), 1_002_000);
    const record = rec.onEpisodeTerminal("LINKUSDT", 1_003_000, "TIMEOUT")!;
    assert.strictEqual(record.flushFlow!.oiStart, null);
    assert.strictEqual(record.flushFlow!.oiDeltaPct, null);
  });

  scenario("stale/missing Spot: no Spot trades ingested -> spotDataAvailable=false in both flow windows, Futures data unaffected", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    rec.ingestFuturesTrade(trade({ timestamp: 1_000_500, quoteQty: 300 }));
    rec.onLifecycleTransition("LINKUSDT", lc({}), lc({ episodeMaxAdverseExtreme: 103 }), 1_001_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 103 }), lc({ episodeMaxAdverseExtreme: 103, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 99, episodeEndTime: 1_002_000 }), 1_002_000);
    const record = rec.onEpisodeTerminal("LINKUSDT", 1_003_000, "TIMEOUT")!;
    assert.strictEqual(record.flushFlow!.spotDataAvailable, false);
    assert.strictEqual(record.flushFlow!.futuresBuyUsd, 300, "Futures flow must be computed correctly regardless of missing Spot data");
  });

  scenario("stale/missing Futures bid/ask (bookTicker never arrived): market snapshot basis fields are null, never fabricated", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    const record0 = rec.getRecord("LINKUSDT", "ep-1")!;
    assert.strictEqual(record0.episodeStartSnapshot.market.futuresMid, null, "no bookTicker ever ingested -> futuresMid must be null, not fabricated from the episode's own startPrice");
    assert.strictEqual(record0.episodeStartSnapshot.market.basisUsd, null);
  });

  scenario("basis is computed from real bid/ask mid once bookTicker data exists, not from any liquidation price", () => {
    const cache = new MarketSnapshotCache();
    cache.ingestFuturesBookTicker(bt({ bid: 99.98, ask: 100.02, timestamp: 999_000 }));
    cache.ingestSpotBookTicker(bt({ bid: 99.90, ask: 99.94, timestamp: 999_000 }));
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    const record = rec.getRecord("LINKUSDT", "ep-1")!;
    assert.ok(Math.abs(record.episodeStartSnapshot.market.futuresMid! - 100.0) < 0.001);
    assert.ok(Math.abs(record.episodeStartSnapshot.market.spotMid! - 99.92) < 0.001);
    assert.ok(Math.abs(record.episodeStartSnapshot.market.basisUsd! - 0.08) < 0.001);
  });

  scenario("entry finalizes Recovery Flow ending at the entry timestamp, not the episode-end timestamp", () => {
    const cache = new MarketSnapshotCache();
    const rec = new EpisodeResearchRecorder(cache);
    rec.onLifecycleTransition("LINKUSDT", null, lc({}), 1_000_000);
    rec.onLifecycleTransition("LINKUSDT", lc({}), lc({ episodeMaxAdverseExtreme: 100 }), 1_001_000);
    rec.onLifecycleTransition("LINKUSDT", lc({ episodeMaxAdverseExtreme: 100 }), lc({ episodeMaxAdverseExtreme: 100, globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION", episodeEndPrice: 99, episodeEndTime: 1_002_000 }), 1_002_000);
    rec.onEntry("LINKUSDT", 1_050_000, 98, "netRR=2.1");
    const record = rec.getRecord("LINKUSDT", "ep-1")!;
    assert.strictEqual(record.recoveryFlow!.endAt, 1_050_000, "Recovery Flow must end at the ACTUAL confirmed entry time, not episode-end confirmation");
    assert.strictEqual(record.entrySnapshot!.price, 98);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
