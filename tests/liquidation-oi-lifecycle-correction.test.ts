import * as assert from "assert";
import {
  advanceEpisodeEndDetection,
  initEpisodeEndDetectionState,
  passesRecoveryFractionGate,
  PRIMARY_VARIANT_MIRROR,
  type AtrLookup,
} from "../src/domain/liquidation-oi-strategy/episode-end-detector";
import { evaluatePostEpisodeOiCreation } from "../src/domain/liquidation-oi-strategy/post-episode-oi-creation";
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

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
