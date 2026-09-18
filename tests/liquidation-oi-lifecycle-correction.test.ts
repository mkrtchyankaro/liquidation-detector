import * as assert from "assert";
import {
  advanceEpisodeEndDetection,
  initEpisodeEndDetectionState,
  passesRecoveryFractionGate,
  PRIMARY_VARIANT_MIRROR,
  type AtrLookup,
} from "../src/domain/liquidation-oi-strategy/episode-end-detector";
import { evaluatePostEpisodeOiCreation } from "../src/domain/liquidation-oi-strategy/post-episode-oi-creation";
import { evaluateTradeEconomics } from "../src/domain/liquidation-oi-strategy/trade-economics";
import { projectTpFromEntry } from "../src/domain/liquidation-oi-strategy/capacity-model";
import { LiquidationOiWatchManager } from "../src/domain/liquidation-oi-strategy/liquidation-oi-watch-manager";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
import type { Candle } from "../src/shared/common.types";

let passed = 0,
  failed = 0;
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

function candle(
  closeTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return {
    symbol: "TESTUSDT",
    interval: "1m",
    openTime: closeTime - 60_000,
    closeTime,
    open,
    high,
    low,
    close,
    volume: 0,
    isClosed: true,
  } as Candle;
}
const flatAtr: AtrLookup = { get: () => 1.0 };

function main(): void {
  console.log(
    "Running episode-end-detector / post-episode-oi-creation unit tests...\n",
  );

  scenario(
    "PRIMARY_VARIANT_MIRROR matches the frozen research parameters exactly",
    () => {
      assert.strictEqual(PRIMARY_VARIANT_MIRROR.candidate1mAtrMultiple, 0.75);
      assert.strictEqual(PRIMARY_VARIANT_MIRROR.confirm3mAtrMultiple, 1.0);
      assert.strictEqual(PRIMARY_VARIANT_MIRROR.confirm5mAtrMultiple, null);
      assert.strictEqual(PRIMARY_VARIANT_MIRROR.recoveryFractionMinimum, 0.3);
    },
  );

  scenario(
    "TEST 1 (structural): episode-end detector has no OI parameter at all -- OI growth inside an active episode cannot influence it",
    () => {
      const state = initEpisodeEndDetectionState(100, 0);
      const c1 = candle(60_000, 99, 99.5, 98.5, 99);
      const result = advanceEpisodeEndDetection(
        state,
        "LONG",
        [c1],
        [],
        flatAtr,
      );
      assert.strictEqual(
        result.confirmed,
        false,
        "no OI parameter exists anywhere in this call",
      );
    },
  );

  scenario(
    "TEST 2: recovery candidate starts but 3m confirmation candle has not closed yet -- remains pending",
    () => {
      const state = initEpisodeEndDetectionState(100, 0);
      const c1 = candle(60_000, 100, 100.8, 100, 100.8);
      const result = advanceEpisodeEndDetection(
        state,
        "LONG",
        [c1],
        [],
        flatAtr,
      );
      assert.strictEqual(result.confirmed, false);
      assert.strictEqual(result.candidateStarted, true);
      assert.notStrictEqual(
        result.state.candidateTime,
        null,
        "candidate must remain pending, not silently confirmed",
      );
    },
  );

  scenario(
    "TEST 3/4 (spirit): flat/falling OI must not by itself imply entry",
    () => {
      const flat = evaluatePostEpisodeOiCreation({
        candidateSide: "LONG",
        episodeEndOiQuantity: 1000,
        currentOiQuantity: 1000,
        episodeStartOiQuantity: 1200,
        episodeMinOiQuantity: 900,
        episodeEndPrice: 100,
        currentPrice: 101,
        atr3m: 1.0,
      });
      assert.strictEqual(flat.qualifies, false);
      assert.strictEqual(flat.reasonCode, "NO_POSITIVE_OI_CREATION");

      const falling = evaluatePostEpisodeOiCreation({
        candidateSide: "LONG",
        episodeEndOiQuantity: 1000,
        currentOiQuantity: 950,
        episodeStartOiQuantity: 1200,
        episodeMinOiQuantity: 900,
        episodeEndPrice: 100,
        currentPrice: 101,
        atr3m: 1.0,
      });
      assert.strictEqual(falling.qualifies, false);
      assert.strictEqual(falling.reasonCode, "NO_POSITIVE_OI_CREATION");
    },
  );

  scenario(
    "TEST 5 (XRP-type case): no timeout -- genuine positive OI creation confirmed later still qualifies",
    () => {
      const stillWaiting = evaluatePostEpisodeOiCreation({
        candidateSide: "LONG",
        episodeEndOiQuantity: 1000,
        currentOiQuantity: 1000,
        episodeStartOiQuantity: 1200,
        episodeMinOiQuantity: 900,
        episodeEndPrice: 100,
        currentPrice: 100,
        atr3m: 1.0,
      });
      assert.strictEqual(
        stillWaiting.qualifies,
        false,
        "flat OI, however long the wait, is never sufficient",
      );

      const laterQualifies = evaluatePostEpisodeOiCreation({
        candidateSide: "LONG",
        episodeEndOiQuantity: 1000,
        currentOiQuantity: 1020,
        episodeStartOiQuantity: 1200,
        episodeMinOiQuantity: 900,
        episodeEndPrice: 100,
        currentPrice: 100.5,
        atr3m: 1.0,
      });
      assert.strictEqual(
        laterQualifies.qualifies,
        true,
        "genuine positive creation + favorable price, whenever it arrives, must qualify",
      );
    },
  );

  scenario("TEST 6: LONG reversal setup -- Price up + OI up qualifies", () => {
    const result = evaluatePostEpisodeOiCreation({
      candidateSide: "LONG",
      episodeEndOiQuantity: 1000,
      currentOiQuantity: 1050,
      episodeStartOiQuantity: 1200,
      episodeMinOiQuantity: 900,
      episodeEndPrice: 100,
      currentPrice: 100.5,
      atr3m: 1.0,
    });
    assert.strictEqual(result.qualifies, true);
    assert.ok(result.postEpisodeOiCreationQuantity! > 0);
    assert.ok(result.favorablePriceMoveAtr! > 0);
  });

  scenario(
    "TEST 7: SHORT reversal setup -- Price down + OI up qualifies",
    () => {
      const result = evaluatePostEpisodeOiCreation({
        candidateSide: "SHORT",
        episodeEndOiQuantity: 1000,
        currentOiQuantity: 1050,
        episodeStartOiQuantity: 1200,
        episodeMinOiQuantity: 900,
        episodeEndPrice: 100,
        currentPrice: 99.5,
        atr3m: 1.0,
      });
      assert.strictEqual(result.qualifies, true);
    },
  );

  scenario(
    "TEST 8: OI up but price moves AGAINST the reversal direction -- no entry",
    () => {
      const longButPriceDown = evaluatePostEpisodeOiCreation({
        candidateSide: "LONG",
        episodeEndOiQuantity: 1000,
        currentOiQuantity: 1050,
        episodeStartOiQuantity: 1200,
        episodeMinOiQuantity: 900,
        episodeEndPrice: 100,
        currentPrice: 99,
        atr3m: 1.0,
      });
      assert.strictEqual(longButPriceDown.qualifies, false);
      assert.strictEqual(
        longButPriceDown.reasonCode,
        "NO_FAVORABLE_PRICE_MOVE",
      );

      const shortButPriceUp = evaluatePostEpisodeOiCreation({
        candidateSide: "SHORT",
        episodeEndOiQuantity: 1000,
        currentOiQuantity: 1050,
        episodeStartOiQuantity: 1200,
        episodeMinOiQuantity: 900,
        episodeEndPrice: 100,
        currentPrice: 101,
        atr3m: 1.0,
      });
      assert.strictEqual(shortButPriceUp.qualifies, false);
      assert.strictEqual(shortButPriceUp.reasonCode, "NO_FAVORABLE_PRICE_MOVE");
    },
  );

  scenario(
    "Recovery-fraction gate: rejects a confirmation below the 30% displacement fraction once displacement >= 1.0x ATR3m",
    () => {
      const ok = passesRecoveryFractionGate("LONG", 100, 97, 97.5, 1.0);
      assert.strictEqual(
        ok,
        false,
        "must reject a confirmation whose recovery fraction is below the 30% minimum once the gate is active",
      );
    },
  );

  scenario(
    "Recovery-fraction gate: accepts when displacement is below the 1.0x ATR3m minimum for the gate to even apply",
    () => {
      const ok = passesRecoveryFractionGate("LONG", 100, 99.5, 99.6, 1.0);
      assert.strictEqual(
        ok,
        true,
        "fraction gate must be bypassed, not failed, below the minimum displacement threshold",
      );
    },
  );

  scenario("A new adverse extreme invalidates a pending 1m candidate", () => {
    const state = initEpisodeEndDetectionState(100, 0);
    const c1 = candle(60_000, 100, 100.8, 100, 100.8);
    const afterCandidate = advanceEpisodeEndDetection(
      state,
      "LONG",
      [c1],
      [],
      flatAtr,
    );
    assert.notStrictEqual(afterCandidate.state.candidateTime, null);

    const c2 = candle(120_000, 100, 100.2, 96, 99);
    const afterInvalidated = advanceEpisodeEndDetection(
      afterCandidate.state,
      "LONG",
      [c2],
      [],
      flatAtr,
    );
    assert.strictEqual(
      afterInvalidated.state.candidateTime,
      null,
      "the pending candidate must be cleared by a new adverse extreme",
    );
    assert.strictEqual(
      afterInvalidated.state.extreme,
      96,
      "the running extreme must extend to the new adverse low",
    );
    assert.strictEqual(afterInvalidated.extremeUpdated, true);
    assert.strictEqual(afterInvalidated.candidateInvalidated, true);
  });

  scenario(
    "Full episode-end confirmation: 1m candidate followed by a passing 3m confirmation candle",
    () => {
      const state = initEpisodeEndDetectionState(100, 0);
      // Matches the real incremental caller: later 1m candles are what
      // let the loop "reach" a 3m candle's closeTime and check it.
      const c1 = candle(60_000, 100, 100.8, 100, 100.8);
      const c2 = candle(120_000, 100.8, 101, 100.6, 100.9);
      const c3 = candle(180_000, 100.9, 101.2, 100.7, 101.1);
      const c3m = candle(180_000, 100.8, 101.2, 100.7, 101.1);
      const result = advanceEpisodeEndDetection(
        state,
        "LONG",
        [c1, c2, c3],
        [c3m],
        flatAtr,
      );
      assert.strictEqual(result.confirmed, true);
      assert.strictEqual(result.confirmedPrice, 101.1);
      assert.strictEqual(result.confirmedAtCloseTime, 180_000);
    },
  );

  // ========== Sep 17 2026 (Karo), operator-corrected RR semantics ==========
  // RR>=2.0 is NOT a mandatory LOX entry gate. It is calculated and
  // reported, never solved backward from. Only economic viability
  // after fees (LOX_MIN_FEE_COVERAGE_MULTIPLE) gates entry.

  scenario(
    "A. LOX can enter with netRR < 2.0 when economics are otherwise viable",
    () => {
      const result = evaluateTradeEconomics({
        candidateSide: "LONG",
        entryPrice: 100,
        tpPrice: 101,
        slPrice: 99.2,
        quantity: 100,
      });
      // gross profit = 1*100=100, gross loss=.8*100=80 -> before fees RR=1.25 (<2.0), fees are tiny relative to $100 profit
      assert.ok(
        result.netRR !== null && result.netRR < 2.0,
        `expected netRR < 2.0 for this scenario, got ${result.netRR}`,
      );
      assert.ok(
        result.passesEconomicViability,
        "must pass economic viability despite netRR < 2.0 -- RR is not the gate",
      );
    },
  );

  scenario(
    "B. RR is calculated and reported correctly regardless of whether it gates entry",
    () => {
      const result = evaluateTradeEconomics({
        candidateSide: "LONG",
        entryPrice: 100,
        tpPrice: 101,
        slPrice: 99.5,
        quantity: 10,
      });
      assert.ok(result.netRR !== null);
      assert.ok(typeof result.netRR === "number");
      // netRR must reflect the real net (fee-adjusted) profit/loss ratio, not gross
      const grossRR = result.grossTpProfitUsd / result.grossSlLossUsd;
      assert.notStrictEqual(
        result.netRR,
        grossRR,
        "netRR must differ from gross RR once fees are applied",
      );
    },
  );

  scenario(
    "C. a fee-dominated/economically useless target cannot enter (passesEconomicViability=false) even though gross numbers look positive",
    () => {
      // Tiny price distance relative to quantity's own fee cost -- gross profit barely exceeds fees.
      const result = evaluateTradeEconomics({
        candidateSide: "LONG",
        entryPrice: 50000,
        tpPrice: 50003,
        slPrice: 49990,
        quantity: 0.01,
      });
      assert.ok(
        !result.passesEconomicViability,
        `expected economically non-viable, got netTpProfitUsd=${result.netTpProfitUsd} vs fees=${result.expectedTpFeesUsd}`,
      );
    },
  );

  scenario(
    "D/E. dynamic TP must not be extended merely to reach netRR=2 -- the capacity model output is not adjusted post-hoc for RR",
    () => {
      // Structural proof: computeRemainingCapacity/projectTpFromEntry (capacity-model.ts) take no RR
      // parameter at all -- RR cannot be an input to the TP projection, only evaluateTradeEconomics
      // (a SEPARATE, downstream, reporting-only calculation) reads the resulting TP to compute RR.
      const fnSource = projectTpFromEntry.toString();
      assert.ok(
        !fnSource.includes("RR") && !fnSource.includes("netRR"),
        "projectTpFromEntry must have no RR-related logic -- TP is purely a function of capacity, never adjusted to hit an RR target",
      );
    },
  );

  scenario(
    "F. WAIT_FOR_POST_EPISODE_OI_CREATION has a dedicated 30min timeout (Sep 18 2026, operator-requested, real production evidence) -- a setup still not qualifying after this long is released, never held indefinitely",
    () => {
      assert.strictEqual(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG.waitForPostEpisodeOiCreationTimeoutMs,
        30 * 60_000,
        "default must be exactly 30 minutes as requested",
      );

      const mgr = new LiquidationOiWatchManager(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
      );
      const now0 = 1_000_000;
      const flatAtr = { get: (_i: string, _t: number) => 1.0 };
      const c = (
        closeTime: number,
        open: number,
        high: number,
        low: number,
        close: number,
      ) =>
        ({
          symbol: "TESTUSDT",
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
      const pctx = {
        historicalSampleCount: 15,
        historicalP90: 200000,
        historicalP95: 400000,
        historicalP99: 700000,
        percentileRank: 96,
      };

      mgr.onLiquidationEvent(
        {
          symbol: "TESTUSDT",
          victim: "SHORT",
          timestamp: now0,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 5000, timestamp: now0 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "TESTUSDT",
          victim: "SHORT",
          timestamp: now0 + 10_000,
          price: 103,
          quoteQty: 300000,
        },
        { quantity: 4700, timestamp: now0 + 10_000 },
      );
      mgr.onTick(
        "TESTUSDT",
        pctx,
        [],
        103,
        1.0,
        1000,
        now0 + 11_000,
        [],
        [],
        flatAtr,
      );
      const c1 = c(now0 + 60_000, 103, 103, 102.1, 102.1);
      mgr.onTick(
        "TESTUSDT",
        pctx,
        [],
        102.1,
        1.0,
        1000,
        now0 + 65_000,
        [c1],
        [],
        flatAtr,
      );
      const c2 = c(now0 + 120_000, 102.1, 102.3, 101.9, 102.0);
      const c3 = c(now0 + 180_000, 102.0, 102.2, 101.7, 101.8);
      const c3m = c(now0 + 180_000, 103, 103, 101.7, 101.8);
      const history = [
        { contracts: 5000, fetchedAt: now0 },
        { contracts: 4600, fetchedAt: now0 + 15_000 },
        { contracts: 4590, fetchedAt: now0 + 25_000 },
        { contracts: 4590, fetchedAt: now0 + 180_000 },
      ];
      mgr.onTick(
        "TESTUSDT",
        pctx,
        history,
        101.8,
        1.0,
        1000,
        now0 + 185_000,
        [c2, c3],
        [c3m],
        flatAtr,
      );
      assert.strictEqual(
        mgr.getLifecycle("TESTUSDT")!.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
      );
      const enteredWaitAt = now0 + 180_000; // episodeEndTime

      // Simulate continuous market data (ticks every 2 minutes -- well under
      // marketDataStaleTimeoutMs=10min) so ONLY the new WAIT-specific timeout
      // is what's being tested here, not the unrelated generic staleness check.
      for (let elapsedMin = 2; elapsedMin <= 28; elapsedMin += 2) {
        mgr.onTick(
          "TESTUSDT",
          pctx,
          history,
          101.8,
          1.0,
          1000,
          enteredWaitAt + elapsedMin * 60_000,
          [],
          [],
          flatAtr,
        );
        assert.strictEqual(
          mgr.getLifecycle("TESTUSDT")?.globalState,
          "WAIT_FOR_POST_EPISODE_OI_CREATION",
          `must not time out before 30 minutes (at ${elapsedMin}min)`,
        );
      }

      // Past 30min, still no qualifying evidence -- must be cancelled and released.
      mgr.onTick(
        "TESTUSDT",
        pctx,
        history,
        101.8,
        1.0,
        1000,
        enteredWaitAt + 31 * 60_000,
        [],
        [],
        flatAtr,
      );
      assert.strictEqual(
        mgr.getLifecycle("TESTUSDT"),
        null,
        "symbol must be released (cancelled) after the WAIT timeout elapses",
      );
    },
  );

  scenario(
    "G. REGRESSION (Sep 18 2026, live production bug): provisional-end reopen must reset entryWindowTimeoutMs's clock, not inherit the original entry time -- confirmed live: BTCUSDT reopened and was cancelled 14 SECONDS later because the old clock (from before WAIT) had nearly expired",
    () => {
      const mgr = new LiquidationOiWatchManager(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
      );
      const now0 = 1_000_000;
      const flatAtr = { get: (_i: string, _t: number) => 1.0 };
      const c = (
        closeTime: number,
        open: number,
        high: number,
        low: number,
        close: number,
      ) =>
        ({
          symbol: "REOPENUSDT",
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
      const pctx = {
        historicalSampleCount: 15,
        historicalP90: 200000,
        historicalP95: 400000,
        historicalP99: 700000,
        percentileRank: 96,
      };

      mgr.onLiquidationEvent(
        {
          symbol: "REOPENUSDT",
          victim: "SHORT",
          timestamp: now0,
          price: 100,
          quoteQty: 500000,
        },
        { quantity: 5000, timestamp: now0 },
      );
      mgr.onLiquidationEvent(
        {
          symbol: "REOPENUSDT",
          victim: "SHORT",
          timestamp: now0 + 10_000,
          price: 103,
          quoteQty: 300000,
        },
        { quantity: 4700, timestamp: now0 + 10_000 },
      );
      mgr.onTick(
        "REOPENUSDT",
        pctx,
        [],
        103,
        1.0,
        1000,
        now0 + 11_000,
        [],
        [],
        flatAtr,
      );
      assert.strictEqual(
        mgr.getLifecycle("REOPENUSDT")!.globalState,
        "EXHAUSTION_CANDIDATE",
      );
      const enteredExhaustionAt = now0 + 11_000; // this is the "old clock" start

      const c1 = c(now0 + 60_000, 103, 103, 102.1, 102.1);
      mgr.onTick(
        "REOPENUSDT",
        pctx,
        [],
        102.1,
        1.0,
        1000,
        now0 + 65_000,
        [c1],
        [],
        flatAtr,
      );
      const c2 = c(now0 + 120_000, 102.1, 102.3, 101.9, 102.0);
      const c3 = c(now0 + 180_000, 102.0, 102.2, 101.7, 101.8);
      const c3m = c(now0 + 180_000, 103, 103, 101.7, 101.8);
      const history = [
        { contracts: 5000, fetchedAt: now0 },
        { contracts: 4600, fetchedAt: now0 + 15_000 },
        { contracts: 4590, fetchedAt: now0 + 25_000 },
        { contracts: 4590, fetchedAt: now0 + 180_000 },
      ];
      mgr.onTick(
        "REOPENUSDT",
        pctx,
        history,
        101.8,
        1.0,
        1000,
        now0 + 185_000,
        [c2, c3],
        [c3m],
        flatAtr,
      );
      assert.strictEqual(
        mgr.getLifecycle("REOPENUSDT")!.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
      );

      // Reopen happens close to (but under) the ORIGINAL 20min entryWindowTimeoutMs boundary
      // -- e.g. 19 minutes after first entering EXHAUSTION_CANDIDATE -- exactly the live BTCUSDT scenario.
      // Bridging ticks (<=8min apart) keep lastTickAt fresh so the UNRELATED
      // marketDataStaleTimeoutMs=10min check never trips while we wait out this gap.
      mgr.onTick(
        "REOPENUSDT",
        pctx,
        history,
        101.8,
        1.0,
        1000,
        now0 + 185_000 + 8 * 60_000,
        [],
        [],
        flatAtr,
      );
      const reopenAt = enteredExhaustionAt + 19 * 60_000;
      mgr.onTick(
        "REOPENUSDT",
        pctx,
        history,
        101.8,
        1.0,
        1000,
        reopenAt - 1000,
        [],
        [],
        flatAtr,
      );
      mgr.onLiquidationEvent(
        {
          symbol: "REOPENUSDT",
          victim: "SHORT",
          timestamp: reopenAt,
          price: 102,
          quoteQty: 50000,
        },
        null,
      );
      assert.strictEqual(
        mgr.getLifecycle("REOPENUSDT")!.globalState,
        "EXHAUSTION_CANDIDATE",
        "reopen must have occurred",
      );
      // onLiquidationEvent does not update lastTickAt -- feed a tick right after reopen so the
      // NEXT jump forward is measured against a fresh lastTickAt, not the stale pre-WAIT one
      // (avoids tripping the UNRELATED marketDataStaleTimeoutMs check, which is not what this test is about).
      mgr.onTick(
        "REOPENUSDT",
        pctx,
        [],
        102,
        1.0,
        1000,
        reopenAt + 1000,
        [],
        [],
        flatAtr,
      );

      // 15 more minutes pass (well within a FRESH 20min window from the reopen, but would have been
      // 34min from the ORIGINAL entry -- past the old, un-reset clock). Fed via intermediate ticks
      // (<=8min apart) so the UNRELATED marketDataStaleTimeoutMs=10min check never trips either.
      mgr.onTick(
        "REOPENUSDT",
        pctx,
        [],
        102,
        1.0,
        1000,
        reopenAt + 8 * 60_000,
        [],
        [],
        flatAtr,
      );
      mgr.onTick(
        "REOPENUSDT",
        pctx,
        [],
        102,
        1.0,
        1000,
        reopenAt + 15 * 60_000,
        [],
        [],
        flatAtr,
      );
      assert.strictEqual(
        mgr.getLifecycle("REOPENUSDT")!.globalState,
        "EXHAUSTION_CANDIDATE",
        "must NOT be cancelled -- the reopen must have reset the entryWindowTimeoutMs clock to give a genuine fresh 20-minute window",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
