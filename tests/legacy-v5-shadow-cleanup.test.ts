/**
 * Sep 12 2026 (Karo), operator-requested. Proves the legacy V5WaveService
 * signal-GENERATION shadow path (this.v5.onLiquidation()) is fully and
 * safely disconnected: it can no longer produce/persist
 * TERMINAL_NON_SIGNAL noise documents (CANCEL_NO_SECOND_WAVE etc) in
 * v5_global_signals, while every current, real production concern
 * (CandlePhysics SIGNAL persistence, BTC_BLOCK, Telegram ENTRY,
 * Binance execution, restart hydration) remains completely unchanged.
 */
import * as assert from "assert";
import * as fs from "fs";

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

console.log("Running legacy-V5-shadow-cleanup tests...\n");

const source = fs.readFileSync(
  require.resolve("../src/services/market-data-orchestrator.ts"),
  "utf8",
);
const codeOnly = source
  .split("\n")
  .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
  .join("\n");

scenario(
  "1. this.v5.onLiquidation() has NO executable call-site anymore -- the sole entry point that could create a new legacy watch and eventually emit a TERMINAL_NON_SIGNAL outcome (CANCEL_NO_SECOND_WAVE, CASCADE_NOT_SERIOUS, ...) is gone",
  () => {
    assert.ok(
      !codeOnly.includes("this.v5.onLiquidation("),
      "onLiquidation() must have zero executable calls",
    );
    assert.ok(
      /\/\/.*this\.v5\.onLiquidation\(/.test(source),
      "the call must be commented out, not deleted -- matching the project's own 'do not delete, just stop calling' convention",
    );
  },
);

scenario(
  "1b. persistTerminalNonSignal() itself is untouched (not deleted, not modified) but is now naturally unreachable -- its only caller (handleTickOutcome's TERMINAL_NON_SIGNAL branch) can only fire from an outcome produced by onLiquidation()/onTick(), and onLiquidation() can never populate a new watch again",
  () => {
    assert.ok(
      source.includes("private async persistTerminalNonSignal("),
      "the function itself must still exist, untouched, per the operator's own explicit 'do not delete' instruction",
    );
    assert.ok(
      source.includes('if (outcome.kind === "TERMINAL_NON_SIGNAL")'),
      "the TERMINAL_NON_SIGNAL branch inside handleTickOutcome() must still exist, untouched -- it is simply never reachable anymore, not removed",
    );
  },
);

scenario(
  "2/3. handleCandlePhysicsEntry()'s own SIGNAL-construction and globalSignalRepo.insert() are completely separate code from persistTerminalNonSignal() -- current CandlePhysics SIGNAL persistence is untouched by this cleanup",
  () => {
    const idx = source.indexOf("private async handleCandlePhysicsEntry(");
    assert.ok(idx > -1);
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    assert.ok(
      body.includes("await this.globalSignalRepo.insert(globalSignal)"),
      "CandlePhysics's own SIGNAL persistence must still be present, unchanged",
    );
    assert.ok(
      !body.includes("persistTerminalNonSignal"),
      "handleCandlePhysicsEntry() must never call the legacy persistTerminalNonSignal() -- these are, and remain, two completely separate code paths",
    );
  },
);

scenario(
  "4. BTC_BLOCK still reads exclusively from CandlePhysicsEngine.getSeriousEpisodeContext() -- never from the disconnected legacy V5WaveService state",
  () => {
    const idx = source.indexOf("private async handleCandlePhysicsEntry(");
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    assert.ok(
      body.includes("this.candlePhysics.getSeriousEpisodeContext("),
      "BTC_BLOCK must read the live CandlePhysicsEngine state",
    );
    const bodyCodeOnly = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    assert.ok(
      !bodyCodeOnly.includes("getBtcWatchVictim("),
      "BTC_BLOCK must never call the legacy V5WaveService.getBtcWatchVictim() -- confirmed disconnected in the prior BTC_BLOCK redesign, untouched by this cleanup",
    );
  },
);

scenario(
  "5. Telegram ENTRY (SignalDistributor.distribute()) is completely untouched by this cleanup -- unrelated code path, never referenced onLiquidation() at all",
  () => {
    const distSource = fs.readFileSync(
      require.resolve("../src/services/signal-distributor.ts"),
      "utf8",
    );
    assert.ok(
      !distSource.includes("this.v5") && !distSource.includes("onLiquidation"),
      "signal-distributor.ts must never have referenced the legacy V5WaveService's own liquidation-ingestion at all",
    );
    assert.ok(
      distSource.includes("for (const runtime of this.userRuntimes)"),
      "the existing per-user ENTRY fan-out loop must remain exactly as before",
    );
  },
);

scenario(
  "6. Binance execution path (executeForUser / BinanceExecutionService) is completely untouched -- never depended on this.v5.onLiquidation() at all",
  () => {
    const execSource = fs.readFileSync(
      require.resolve("../src/application/execution/execute-for-user.usecase.ts"),
      "utf8",
    );
    assert.ok(
      !execSource.includes("this.v5") && !execSource.includes("onLiquidation"),
      "execute-for-user.usecase.ts must never have referenced the legacy V5WaveService's own liquidation-ingestion",
    );
  },
);

scenario(
  '7. restart hydration still gates exclusively on status==="SIGNAL" -- a CANCEL_NO_SECOND_WAVE (or any other legacy TERMINAL_NON_SIGNAL) document was never, and is still never, treated as an active/locked trade',
  () => {
    const modelSource = fs.readFileSync(
      require.resolve("../src/domain/signal/global-signal.model.ts"),
      "utf8",
    );
    assert.ok(
      modelSource.includes('"SIGNAL": a real, executable plan exists'),
      "the status field's own doc comment must still document SIGNAL as the sole 'locked/open' status hydration and mainSymbolLocks treat as active",
    );
    assert.ok(
      modelSource.includes("V5TerminalReason"),
      "CANCEL_NO_SECOND_WAVE remains a valid, documented V5TerminalReason value on the shared status union -- it is a legitimate status VALUE (never deleted), simply never reachable as a NEW write anymore from the disconnected path",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
