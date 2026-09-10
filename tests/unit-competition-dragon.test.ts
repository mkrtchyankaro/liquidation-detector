/**
 * Sep 10 2026 (Karo), operator-requested LIVE 3-way ATR-unit "dragon"
 * competition. Proves the dragon-formula's own correctness precisely
 * per the operator's own spec (descending RR search, first-valid-wins,
 * all attempts recorded, no clamp/floor), plus the isolation guarantee
 * (zero production influence, MAIN-only, no Binance/user/Telegram
 * reachability).
 */
import * as assert from "assert";
import * as fs from "fs";
import {
  evaluateDragon,
  DRAGON_RR_CANDIDATES,
  DRAGON_SL_MIN_PCT,
  DRAGON_SL_MAX_PCT,
} from "../src/domain/research/unit-competition-dragon";

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

console.log("Running unit-competition-dragon tests...\n");

// ─── Exact worked examples from the operator's own spec ────────────────

scenario(
  "operator's own example 1: rawTP=0.48% -> RR2.5 SL=0.192% invalid, RR2.4 SL=0.200% VALID -> selectedRR=2.4",
  () => {
    // Reverse-engineer inputs that produce rawTpPct = 0.48% exactly.
    const atrPct = 0.0048; // pressureFactor=1 case: atrPct * 1 = rawTP
    const result = evaluateDragon(atrPct, 1000, 1000); // relativePressure=1, pressureFactor=1
    assert.ok(
      Math.abs(result.rawTpPct - 0.0048) < 1e-9,
      `rawTpPct=${result.rawTpPct}`,
    );
    const attempt25 = result.rrAttempts.find((a) => a.rr === 2.5)!;
    const attempt24 = result.rrAttempts.find((a) => a.rr === 2.4)!;
    assert.ok(Math.abs(attempt25.slPct - 0.00192) < 1e-9);
    assert.strictEqual(attempt25.valid, false);
    assert.ok(Math.abs(attempt24.slPct - 0.002) < 1e-9);
    assert.strictEqual(attempt24.valid, true);
    assert.strictEqual(result.selectedRR, 2.4);
    assert.ok(Math.abs((result.rawSlPct ?? 0) - 0.002) < 1e-9);
    assert.strictEqual(result.verdict, "PASS");
  },
);

scenario(
  "operator's own example 2: rawTP=0.90% -> RR2.5 SL=0.36% VALID immediately -> selectedRR=2.5",
  () => {
    const atrPct = 0.009;
    const result = evaluateDragon(atrPct, 1000, 1000);
    assert.ok(Math.abs(result.rawTpPct - 0.009) < 1e-9);
    assert.strictEqual(result.selectedRR, 2.5);
    assert.ok(Math.abs((result.rawSlPct ?? 0) - 0.0036) < 1e-9);
    assert.strictEqual(result.verdict, "PASS");
  },
);

// ─── Descending search, all attempts recorded ───────────────────────────

scenario(
  "RR candidates are tried in EXACT descending order [2.5,2.4,2.3,2.2,2.1], all 5 always recorded regardless of outcome",
  () => {
    const result = evaluateDragon(0.005, 1000, 1000);
    assert.strictEqual(result.rrAttempts.length, 5);
    assert.deepStrictEqual(
      result.rrAttempts.map((a) => a.rr),
      [...DRAGON_RR_CANDIDATES],
    );
  },
);

scenario(
  "first (highest) valid RR wins -- never a lower one, even if multiple would also be valid",
  () => {
    // Choose rawTP such that BOTH RR=2.5 and RR=2.1 would produce a
    // valid SL -- confirms 2.5 (checked first) wins, not 2.1.
    const atrPct = 0.006; // SL at RR2.5 = 0.24%, SL at RR2.1 = 0.286% -- both inside [0.20,0.50]
    const result = evaluateDragon(atrPct, 1000, 1000);
    assert.strictEqual(
      result.selectedRR,
      2.5,
      "the FIRST (highest) valid RR must win",
    );
    assert.ok(result.rrAttempts.every((a) => a.rr <= 2.5));
    assert.strictEqual(
      result.rrAttempts.filter((a) => a.valid).length >= 2,
      true,
      "sanity: more than one RR should be valid in this scenario",
    );
  },
);

// ─── FAIL_NO_VALID_RR ───────────────────────────────────────────────────

scenario(
  "too-small rawTP (SL below 0.20% at every RR) -> FAIL_NO_VALID_RR, selectedRR/rawSlPct null",
  () => {
    const result = evaluateDragon(0.0005, 1000, 1000); // tiny ATR -> tiny rawTP
    assert.strictEqual(result.verdict, "FAIL_NO_VALID_RR");
    assert.strictEqual(result.selectedRR, null);
    assert.strictEqual(result.rawSlPct, null);
    assert.strictEqual(
      result.rrAttempts.length,
      5,
      "all 5 attempts must still be recorded even on total failure",
    );
    assert.ok(result.rrAttempts.every((a) => !a.valid));
  },
);

scenario(
  "too-large rawTP (SL above 0.50% at every RR) -> FAIL_NO_VALID_RR",
  () => {
    const result = evaluateDragon(0.05, 1000, 1000); // huge ATR -> huge rawTP
    assert.strictEqual(result.verdict, "FAIL_NO_VALID_RR");
    assert.ok(result.rrAttempts.every((a) => !a.valid));
  },
);

// ─── No clamp/floor, no exhaustion/absorption, raw formula only ────────

scenario(
  "structural: NO clamp/floor is ever applied to rawSlPct -- exact division, never max()'d against 0.20%; no exhaustion/absorption/ATR15m in the EXECUTABLE code",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/domain/research/unit-competition-dragon.ts"),
      "utf8",
    );
    const functionBody = source.slice(
      source.indexOf("export function evaluateDragon"),
    );
    assert.ok(
      !functionBody.includes("Math.max(") ||
        !functionBody.includes("Math.max(slPct"),
      "no clamp/floor logic on slPct inside evaluateDragon()'s own body",
    );
    assert.ok(
      !functionBody.toLowerCase().includes("exhaustion"),
      "no exhaustion concept in the executable evaluateDragon() body",
    );
    assert.ok(
      !functionBody.toLowerCase().includes("absorption"),
      "no absorption concept in the executable evaluateDragon() body",
    );
    assert.ok(
      !functionBody.includes("atr15m"),
      "ATR15m must never appear in the executable evaluateDragon() body",
    );
  },
);

scenario(
  "relativePressure/pressureFactor/rawTpPct match the EXACT operator-specified formula: sqrt(episodeLiq/baseline) * candidateAtrPct",
  () => {
    const episodeLiq = 250_000;
    const baseline = 40_000;
    const atrPct = 0.007;
    const result = evaluateDragon(atrPct, episodeLiq, baseline);
    const expectedRelPressure = episodeLiq / baseline;
    const expectedPressureFactor = Math.sqrt(expectedRelPressure);
    const expectedRawTp = atrPct * expectedPressureFactor;
    assert.ok(Math.abs(result.relativePressure - expectedRelPressure) < 1e-9);
    assert.ok(Math.abs(result.pressureFactor - expectedPressureFactor) < 1e-9);
    assert.ok(Math.abs(result.rawTpPct - expectedRawTp) < 1e-9);
  },
);

// ─── Invalid input handling ──────────────────────────────────────────────

scenario(
  "zero/negative inputs (atrPct, episodeLiq, baseline) all produce a safe FAIL, never NaN/Infinity",
  () => {
    for (const [atrPct, liq, baseline] of [
      [0, 1000, 1000],
      [0.005, 0, 1000],
      [0.005, 1000, 0],
      [-0.005, 1000, 1000],
    ] as const) {
      const result = evaluateDragon(atrPct, liq, baseline);
      assert.strictEqual(result.verdict, "FAIL_NO_VALID_RR");
      assert.ok(
        Number.isFinite(result.relativePressure) &&
          Number.isFinite(result.pressureFactor) &&
          Number.isFinite(result.rawTpPct),
      );
    }
  },
);

// ─── Isolation: zero production influence ────────────────────────────────

scenario(
  "structural: evaluateDragon() and unit-competition-dragon.ts have ZERO reference to Binance execution, user runtimes, or Telegram",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/domain/research/unit-competition-dragon.ts"),
      "utf8",
    );
    assert.ok(
      !source.includes("Binance") &&
        !source.includes("Telegram") &&
        !source.includes("UserRuntime") &&
        !source.includes("execution"),
    );
  },
);

scenario(
  "structural: the dragon-competition wiring in market-data-orchestrator.ts never calls Binance execution, user-runtime dispatch, or Telegram send -- confined to globalSignalRepo persistence only",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const dragonSectionStart = source.indexOf("private handleCompetitionTick");
    const dragonSectionEnd = source.indexOf(
      "\n  private ",
      dragonSectionStart + 50,
    );
    const dragonSection = source.slice(
      dragonSectionStart,
      dragonSectionEnd > -1 ? dragonSectionEnd : undefined,
    );
    assert.ok(
      !dragonSection.includes("BinanceExecutionService") &&
        !dragonSection.includes(".execution."),
      "no Binance execution reference inside the dragon-handling method",
    );
    assert.ok(
      !dragonSection.includes("sendMessage") &&
        !dragonSection.includes("Telegram"),
      "no Telegram reference inside the dragon-handling method",
    );
    assert.ok(
      dragonSection.includes(
        "this.globalSignalRepo.setUnitCompetitionCandidate",
      ),
      "the ONLY side effect must be research-persistence",
    );
  },
);

scenario(
  "structural: three fully independent UnitResearchShadowService instances (1m/3m/5m) power the competition -- separate from shadow3m/shadow5m used by the earlier unitResearch experiment",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    assert.ok(
      source.includes("competitionShadow1m = new UnitResearchShadowService("),
    );
    assert.ok(
      source.includes("competitionShadow3m = new UnitResearchShadowService("),
    );
    assert.ok(
      source.includes("competitionShadow5m = new UnitResearchShadowService("),
    );
    // Distinct from the earlier experiment's own instances.
    assert.ok(source.includes("shadow3m = new UnitResearchShadowService("));
    assert.ok(source.includes("shadow5m = new UnitResearchShadowService("));
  },
);

scenario(
  "structural: unitCompetitionResearch is never read anywhere in v5-wave.service.ts, binance-execution.service.ts, or execute-for-user.usecase.ts",
  () => {
    for (const file of [
      "../src/strategy/v5/v5-wave.service.ts",
      "../src/infrastructure/binance/binance-execution.service.ts",
      "../src/application/execution/execute-for-user.usecase.ts",
    ]) {
      const source = fs.readFileSync(require.resolve(file), "utf8");
      assert.ok(
        !source.includes("unitCompetitionResearch"),
        `${file} must never reference unitCompetitionResearch at all`,
      );
    }
  },
);

scenario(
  "structural: dragon-competition-tick is called ALWAYS AFTER this.v5.onTick(), never before, in the same bookTicker handler as the earlier shadow-research",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const tickHandlerStart = source.indexOf('this.ws.on("bookTicker"');
    const tickHandlerEnd = source.indexOf('this.ws.on("orderbook"');
    const tickHandler = source.slice(tickHandlerStart, tickHandlerEnd);
    const v5TickIdx = tickHandler.indexOf("this.v5.onTick(");
    const shadowTickIdx = tickHandler.indexOf("tickUnitResearchShadow(");
    assert.ok(v5TickIdx > -1 && shadowTickIdx > -1);
    assert.ok(
      shadowTickIdx > v5TickIdx,
      "shadow/competition research must be called AFTER v5.onTick()",
    );
  },
);

// ─── MAIN-only Telegram research lifecycle (Sep 10 2026) ────────────────

scenario(
  "structural: RESEARCH ENTRY/CLOSE telegram uses ONLY this.mainTelegram -- never a per-user runtime, never signal-distributor, never Binance execution",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const winnerSectionStart = source.indexOf("private declareWinnerIfNone");
    const winnerSectionEnd = source.indexOf(
      "\n  private handleCompetitionTick",
      winnerSectionStart,
    );
    const touchSectionStart = source.indexOf(
      "private checkCompetitionWinnerTouch",
    );
    const touchSectionEnd = source.indexOf(
      "\n  private ",
      touchSectionStart + 50,
    );
    const section =
      source.slice(winnerSectionStart, winnerSectionEnd) +
      source.slice(
        touchSectionStart,
        touchSectionEnd > -1 ? touchSectionEnd : undefined,
      );
    assert.ok(
      section.includes("this.mainTelegram.sendMessage("),
      "must send via this.mainTelegram",
    );
    assert.ok(
      !section.includes("signalDistributor") &&
        !section.includes("SignalDistributor"),
      "must never touch the production signal-distributor",
    );
    assert.ok(
      !section.includes("runtime.telegram") &&
        !section.includes("userRuntimes"),
      "must never touch any per-user runtime's own telegram",
    );
    assert.ok(
      !section.includes("BinanceExecutionService") &&
        !section.includes(".execution.run("),
      "must never touch Binance execution",
    );
  },
);

scenario(
  "structural: RESEARCH ENTRY message is sent ONLY once per episode -- declareWinnerIfNone() is a no-op if a winner already exists",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("private declareWinnerIfNone");
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    assert.ok(
      body.includes("if (this.competitionWinners.has(signalId)) return;"),
      "must return early if a winner already exists for this episode",
    );
  },
);

scenario(
  "structural: production TP/SL/entry/execution/Telegram code paths never reference competitionWinners or the RESEARCH ENTRY/CLOSE messages",
  () => {
    for (const file of [
      "../src/strategy/v5/v5-wave.service.ts",
      "../src/infrastructure/binance/binance-execution.service.ts",
      "../src/application/execution/execute-for-user.usecase.ts",
      "../src/application/signal/notify-user.usecase.ts",
    ]) {
      const source = fs.readFileSync(require.resolve(file), "utf8");
      assert.ok(
        !source.includes("competitionWinners") &&
          !source.includes("RESEARCH ENTRY") &&
          !source.includes("RESEARCH CLOSE"),
        `${file} must never reference the research-competition winner logic`,
      );
    }
  },
);

scenario(
  "structural: checkCompetitionWinnerTouch() is called from tickUnitResearchShadow() (the SAME research-only tick-path), never from MAIN's own onPriceTickForTrades()-adjacent production close-handling",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const tickResearchIdx = source.indexOf("private tickUnitResearchShadow");
    const tickResearchBody = source.slice(
      tickResearchIdx,
      source.indexOf("\n  private handleCompetitionTick", tickResearchIdx),
    );
    assert.ok(
      tickResearchBody.includes("this.checkCompetitionWinnerTouch("),
      "must be called from tickUnitResearchShadow()",
    );
    const mainCloseIdx = source.indexOf("private async handleMainTradeClose");
    const mainCloseBody = source.slice(
      mainCloseIdx,
      source.indexOf("\n  private ", mainCloseIdx + 50),
    );
    assert.ok(
      !mainCloseBody.includes("checkCompetitionWinnerTouch"),
      "MAIN's own canonical close-handler must never reference the research winner-touch check",
    );
  },
);

// ─── Sep 10 2026 surgical fix: symbol/side/signalTs via $setOnInsert ────

scenario(
  "structural: setUnitCompetitionCandidate()/setUnitCompetitionWinner() write symbol/side/signalTs via $setOnInsert, NEVER $set -- a hard guarantee against overwriting production's own canonical values",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/infrastructure/mongo/global-signal.repository.ts"),
      "utf8",
    );
    const candidateIdx = source.indexOf("async setUnitCompetitionCandidate(");
    const candidateBody = source.slice(
      candidateIdx,
      source.indexOf("\n  async appendUnitCompetitionCheckpoint", candidateIdx),
    );
    assert.ok(
      candidateBody.includes("$setOnInsert"),
      "setUnitCompetitionCandidate must use $setOnInsert somewhere",
    );
    assert.ok(
      candidateBody.includes("meta.symbol") &&
        candidateBody.includes("meta.side") &&
        candidateBody.includes("meta.signalTs"),
      "setUnitCompetitionCandidate must write symbol/side/signalTs from the meta parameter",
    );
    // The $setOnInsert block itself (not the surrounding function) must be
    // the one containing symbol/side/signalTs -- extract just that object
    // literal and confirm.
    const setOnInsertIdx = candidateBody.indexOf("$setOnInsert");
    const setOnInsertBlock = candidateBody.slice(
      setOnInsertIdx,
      candidateBody.indexOf("}", candidateBody.indexOf("{", setOnInsertIdx)) +
        1,
    );
    assert.ok(
      setOnInsertBlock.includes("symbol") &&
        setOnInsertBlock.includes("side") &&
        setOnInsertBlock.includes("signalTs"),
      "the $setOnInsert object literal itself must contain symbol/side/signalTs",
    );

    const winnerIdx = source.indexOf("async setUnitCompetitionWinner(");
    const winnerBody = source.slice(
      winnerIdx,
      source.indexOf("\n  async setUnitCompetitionWinnerResult", winnerIdx),
    );
    assert.ok(
      winnerBody.includes("$setOnInsert"),
      "setUnitCompetitionWinner must use $setOnInsert somewhere",
    );
    assert.ok(
      winnerBody.includes("meta.symbol") &&
        winnerBody.includes("meta.side") &&
        winnerBody.includes("meta.signalTs"),
      "setUnitCompetitionWinner must write symbol/side/signalTs from the meta parameter",
    );
  },
);

scenario(
  "structural: the production tick-handler's own outcome loop is UNCHANGED -- still fire-and-forget (void), no await added to solve the reporting race",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    assert.ok(
      source.includes(
        "for (const outcome of outcomes) void this.handleTickOutcome(outcome);",
      ),
      "production's own outcome-loop must remain exactly fire-and-forget, byte-identical to before this fix",
    );
  },
);

scenario(
  "structural: the new meta (symbol/side/signalTs) passed to setUnitCompetitionCandidate/setUnitCompetitionWinner is sourced ONLY from the shadow event's own already-known fields (symbol/entry.side/victim/episodeStartTs) -- never reconstructed, guessed, or re-derived",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const handleTickIdx = source.indexOf("private handleCompetitionTick");
    const handleTickBody = source.slice(
      handleTickIdx,
      source.indexOf(
        "\n  private setCompetitionCandidateStatus",
        handleTickIdx,
      ),
    );
    assert.ok(
      handleTickBody.includes(
        "{ symbol, side: entry.side, signalTs: entry.episodeStartTs }",
      ),
    );
    assert.ok(
      handleTickBody.includes(
        "{ symbol, side: victim, signalTs: noEntry.episodeStartTs }",
      ),
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
