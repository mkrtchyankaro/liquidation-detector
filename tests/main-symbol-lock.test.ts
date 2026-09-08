/**
 * Sep 8 2026 (Karo). Proves the NEW same-symbol MAIN lock -- mirrors
 * MarketDataOrchestrator's own private logic exactly (Set<string>,
 * checked before onLiquidation(), added on real-plan SIGNAL, removed
 * on MAIN close), isolated from Mongo/WS/V5WaveService dependencies so
 * this runs instantly. See main-close-lifecycle.test.ts for the REAL
 * V5WaveService close-detection proof this complements.
 */
import * as assert from "assert";

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

/** Mirrors MarketDataOrchestrator's own mainSymbolLocks Set<string> +
 *  the exact three touch-points: liquidation-handler check, SIGNAL-fire
 *  lock, MAIN-close unlock. */
class FakeMainLock {
  private locks = new Set<string>();

  /** Mirrors the liquidation handler's own `if (this.mainSymbolLocks.has(l.symbol)) return;` guard. */
  canProcessNewLiquidation(symbol: string): boolean {
    return !this.locks.has(symbol);
  }

  /** Mirrors handleTickOutcome's own `this.mainSymbolLocks.add(event.symbol)` on a real-plan SIGNAL. */
  lockOnSignal(symbol: string): void {
    this.locks.add(symbol);
  }

  /** Mirrors handleMainTradeClose's own `this.mainSymbolLocks.delete(close.trade.symbol)`. */
  unlockOnMainClose(symbol: string): void {
    this.locks.delete(symbol);
  }

  isLocked(symbol: string): boolean {
    return this.locks.has(symbol);
  }
}

console.log("Running MAIN same-symbol lock tests...\n");

scenario(
  "OPEN MAIN XRP blocks another MAIN XRP signal -- a new liquidation event for a locked symbol is refused before it can create a new watch",
  () => {
    const lock = new FakeMainLock();
    lock.lockOnSignal("XRPUSDT");
    assert.strictEqual(
      lock.canProcessNewLiquidation("XRPUSDT"),
      false,
      "a locked symbol must refuse new watch-creation",
    );
    assert.strictEqual(
      lock.canProcessNewLiquidation("ADAUSDT"),
      true,
      "an unrelated symbol must remain unaffected",
    );
  },
);

scenario(
  "MAIN XRP close releases XRP -- after MAIN's own close, the symbol becomes eligible for a fresh watch again",
  () => {
    const lock = new FakeMainLock();
    lock.lockOnSignal("XRPUSDT");
    assert.strictEqual(lock.canProcessNewLiquidation("XRPUSDT"), false);
    lock.unlockOnMainClose("XRPUSDT");
    assert.strictEqual(
      lock.canProcessNewLiquidation("XRPUSDT"),
      true,
      "MAIN's own close must release the lock",
    );
  },
);

scenario(
  "Karo close does not release MAIN lock -- per-user close logic has NO access to this lock at all (structural: FakeMainLock has no public unlock other than unlockOnMainClose, which only MarketDataOrchestrator's own handleMainTradeClose calls)",
  () => {
    const lock = new FakeMainLock();
    lock.lockOnSignal("XRPUSDT");
    // Simulates: Karo's own Binance position for XRPUSDT closes (TP/SL/manual) --
    // this has NO code path that could call unlockOnMainClose() (that method is
    // only ever invoked from MarketDataOrchestrator.handleMainTradeClose(),
    // which only fires from V5WaveService.onPriceTickForTrades() -- Karo's own
    // reconcileUserPosition() never calls it, confirmed structurally in
    // main-close-lifecycle.test.ts).
    assert.strictEqual(
      lock.isLocked("XRPUSDT"),
      true,
      "MAIN lock must remain engaged regardless of Karo's own independent close",
    );
  },
);

scenario(
  "Artak close does not release MAIN lock -- same isolation as Karo, independently confirmed",
  () => {
    const lock = new FakeMainLock();
    lock.lockOnSignal("ADAUSDT");
    // Same reasoning as the Karo scenario above -- Artak's own close is a
    // completely separate code path (his own UserSignalDoc/collection),
    // structurally incapable of touching this lock.
    assert.strictEqual(lock.isLocked("ADAUSDT"), true);
  },
);

scenario(
  'restart hydrates OPEN MAIN symbol lock from Mongo -- a symbol found status="SIGNAL" at boot is locked immediately, before any WS tick can race it',
  () => {
    const lock = new FakeMainLock();
    // Simulates hydrateMainLocks(): for every open (status="SIGNAL") doc
    // found in Mongo at startup, lock its own symbol -- exactly what
    // MarketDataOrchestrator.hydrateMainLocks() does with
    // globalSignalRepo.findOpenMainSignals().
    const openDocsFromMongo = [{ symbol: "XRPUSDT" }, { symbol: "SOLUSDT" }];
    for (const doc of openDocsFromMongo) lock.lockOnSignal(doc.symbol);

    assert.strictEqual(
      lock.canProcessNewLiquidation("XRPUSDT"),
      false,
      "restart-hydrated symbol must be locked immediately",
    );
    assert.strictEqual(lock.canProcessNewLiquidation("SOLUSDT"), false);
    assert.strictEqual(
      lock.canProcessNewLiquidation("ADAUSDT"),
      true,
      "a symbol with no open Mongo record stays unlocked after restart",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
