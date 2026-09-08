/**
 * Sep 8 2026 (Karo). Proves the operator-corrected invariant: "MAIN
 * ENTRY/CLOSE -> MAIN Telegram configuration" -- MAIN's own close
 * notification must use ONLY the dedicated mainTelegram client, never
 * the generic broadcastTelegram (which remains, correctly, for the
 * unrelated liq-feed-dead system alert only). Source-level structural
 * proof, since fully instantiating MarketDataOrchestrator requires
 * many unrelated Mongo/WS dependencies.
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

const orchestratorSource = fs.readFileSync(
  require.resolve("../src/services/market-data-orchestrator.ts"),
  "utf8",
);
const mainSource = fs.readFileSync(require.resolve("../src/main.ts"), "utf8");

console.log("Running MAIN telegram-isolation tests...\n");

scenario(
  "handleMainTradeClose() sends via this.mainTelegram, never this.broadcastTelegram (that field no longer exists at all)",
  () => {
    const closeHandlerStart = orchestratorSource.indexOf(
      "private async handleMainTradeClose",
    );
    const closeHandlerEnd = orchestratorSource.indexOf(
      "private async handleTickOutcome",
    );
    assert.ok(
      closeHandlerStart > -1 && closeHandlerEnd > closeHandlerStart,
      "could not locate handleMainTradeClose() body",
    );
    const body = orchestratorSource.slice(closeHandlerStart, closeHandlerEnd);
    assert.ok(
      body.includes("this.mainTelegram"),
      "handleMainTradeClose() must send via this.mainTelegram",
    );
    assert.ok(
      !body.includes("this.broadcastTelegram"),
      "handleMainTradeClose() must NOT reference a broadcast field",
    );
  },
);

scenario(
  "MarketDataOrchestrator no longer has any 'broadcastTelegram' field -- the generic broadcast concept was removed entirely for MAIN's own lifecycle, only liqFeedWatchdog keeps its own separate broadcast",
  () => {
    assert.ok(
      !orchestratorSource.includes("private readonly broadcastTelegram"),
      "the old broadcastTelegram field must be gone",
    );
    assert.ok(
      orchestratorSource.includes("private readonly mainTelegram"),
      "a dedicated mainTelegram field must exist",
    );
  },
);

scenario(
  "main.ts wires mainTelegram to the 'main' user's OWN runtime.telegram specifically -- never a broadcast helper, never karo's or artak's own client",
  () => {
    const wireLine = mainSource.match(
      /userRuntimes\.find\(\(r\) => r\.config\.userId === "main"\)\?\.telegram/,
    );
    assert.ok(
      wireLine,
      "main.ts must look up the 'main' user's own runtime.telegram specifically for the MAIN close wiring",
    );
  },
);

scenario(
  "liqFeedAlertTelegram (the unrelated system-wide feed-dead alert) remains a separate, distinct broadcast mechanism -- this invariant is ONLY about MAIN's own signal ENTRY/CLOSE, not every system event",
  () => {
    assert.ok(
      mainSource.includes("const liqFeedAlertTelegram"),
      "the liq-feed broadcast mechanism must still exist, unchanged, for its own unrelated purpose",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
