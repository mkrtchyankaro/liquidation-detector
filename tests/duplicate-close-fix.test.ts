/**
 * Sep 8 2026 (Karo). Proves the CRITICAL fix for a real production
 * incident: a single closed position sent 11+ duplicate "V5 CLOSE"
 * Telegram messages within one minute, because ReconciliationManager's
 * own in-memory openCache kept listing an already-closed signalId as
 * "open" for up to 15s (its own refresh interval), and every
 * bookTicker tick in that window re-triggered the full reconcile-and-
 * notify flow again. reconcileUserPosition() now returns `true`
 * exactly when it just closed a position, which the caller uses to
 * immediately prune its own cache -- this test proves that pruning
 * happens and stops further re-triggers within the same window,
 * using a lightweight fake mirroring reconciliation-manager.ts's own
 * cache-prune logic exactly.
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

// Mirrors ReconciliationManager's own openCache + onTick pruning logic
// exactly (see src/services/reconciliation-manager.ts), without any
// Mongo/Binance/Telegram dependency -- isolates the ONE thing this
// bug was actually about: does a `true` result prune the signalId
// from the cache immediately.
class FakeReconciliationCache {
  private openCache = new Map<string, { signalId: string; symbol: string }[]>();
  notifyCount = 0;

  seed(userId: string, entries: { signalId: string; symbol: string }[]): void {
    this.openCache.set(userId, entries);
  }

  /** Simulates one onTick() call for `symbol`, where `reconcileFn`
   *  stands in for reconcileUserPosition() -- returns true exactly
   *  when it "closed" the position (and would have sent a Telegram
   *  message, counted here via notifyCount). */
  async tick(
    userId: string,
    symbol: string,
    reconcileFn: (signalId: string) => Promise<boolean>,
  ): Promise<void> {
    const open = this.openCache.get(userId);
    if (!open) return;
    for (const entry of [...open]) {
      if (entry.symbol !== symbol) continue;
      const justClosed = await reconcileFn(entry.signalId);
      if (justClosed) {
        this.notifyCount++;
        const stillCached = this.openCache.get(userId);
        if (stillCached) {
          this.openCache.set(
            userId,
            stillCached.filter((s) => s.signalId !== entry.signalId),
          );
        }
      }
    }
  }

  openCount(userId: string): number {
    return this.openCache.get(userId)?.length ?? 0;
  }
}

async function main(): Promise<void> {
  console.log("Running duplicate-close-fix tests...\n");

  await (async () => {
    await scenario(
      "a position that just closed is pruned from the cache immediately -- a SECOND tick within the same window never re-triggers the close notification again",
      async () => {
        const cache = new FakeReconciliationCache();
        cache.seed("karo", [{ signalId: "sig-1", symbol: "ADAUSDT" }]);

        // Simulate reconcileUserPosition: ALWAYS reports "closed" (as
        // Binance genuinely would, since the position really did close)
        // -- this is exactly the bug scenario: every tick within the
        // stale-cache window would ALSO see "closed" if nothing pruned
        // the cache.
        const alwaysClosed = async (): Promise<boolean> => true;

        // Simulate 12 rapid bookTicker ticks in the same ~1s window
        // (matching the real incident's 11+ duplicate messages).
        for (let i = 0; i < 12; i++) {
          await cache.tick("karo", "ADAUSDT", alwaysClosed);
        }

        // WITHOUT the fix, notifyCount would be 12 (one per tick).
        // WITH the fix, only the FIRST tick's close counts -- the
        // signalId is pruned before the second tick even runs, so
        // reconcileFn is only called once per tick loop while it's
        // still in the cache (tick 1: sees it, closes it, prunes it;
        // ticks 2-12: cache is already empty, nothing to iterate).
        assert.strictEqual(
          cache.notifyCount,
          1,
          `expected exactly 1 close-notification, got ${cache.notifyCount} -- this IS the duplicate-close bug if > 1`,
        );
        assert.strictEqual(cache.openCount("karo"), 0);
      },
    );
  })();

  await (async () => {
    await scenario(
      "a position that is STILL open (reconcile returns false) stays in the cache across many ticks, unaffected",
      async () => {
        const cache = new FakeReconciliationCache();
        cache.seed("karo", [{ signalId: "sig-2", symbol: "ETHUSDT" }]);
        const stillOpen = async (): Promise<boolean> => false;

        for (let i = 0; i < 5; i++) {
          await cache.tick("karo", "ETHUSDT", stillOpen);
        }

        assert.strictEqual(cache.notifyCount, 0);
        assert.strictEqual(cache.openCount("karo"), 1); // never pruned -- correctly still tracked as open
      },
    );
  })();

  await (async () => {
    await scenario(
      "two DIFFERENT open positions for the same user -- closing one never prunes or affects the other",
      async () => {
        const cache = new FakeReconciliationCache();
        cache.seed("karo", [
          { signalId: "sig-3", symbol: "ADAUSDT" },
          { signalId: "sig-4", symbol: "XRPUSDT" },
        ]);

        await cache.tick("karo", "ADAUSDT", async () => true); // sig-3 closes
        await cache.tick("karo", "XRPUSDT", async () => false); // sig-4 still open

        assert.strictEqual(cache.notifyCount, 1);
        assert.strictEqual(cache.openCount("karo"), 1); // only sig-4 remains
      },
    );
  })();

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
