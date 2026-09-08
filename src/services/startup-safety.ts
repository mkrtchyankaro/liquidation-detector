import type { UserRuntime } from "./user-runtime";
import { UserSignalRepository } from "../infrastructure/mongo/user-signal.repository";
import type { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "startup-safety" });

/**
 * Sep 8 2026 (Karo). CRITICAL, ported from liqwatch-bot's own app.ts
 * (the `if (binanceExecution.isLiveArmed) { validateForLiveStart() +
 * reconcileOnStartup() }` block) -- confirmed to guard against a REAL
 * production incident (a droplet resize/reboot once orphaned two
 * real, correctly-protected Binance positions; a second incident
 * found the SL-detection itself was silently broken, both documented
 * in binance-execution.service.ts's own reconcileOnStartup() doc
 * comment). This was NOT wired anywhere in the new project until this
 * fix -- found during a full manual file-by-file audit, not by any
 * test (no test would have caught a startup step that simply never
 * ran).
 *
 * Multi-user adaptation: the original halts the ENTIRE process
 * (single account, single strategy) on failure. Here, each user has
 * their OWN BinanceExecutionService instance with its OWN
 * haltReason/isHalted state -- a failure for one user calls THAT
 * instance's own setHalt() (blocking only their own future run()
 * calls, confirmed via BinanceExecutionService.run()'s own isHalted
 * check) without affecting any other user, including "main" (which
 * never has binance enabled and is never touched by this at all).
 */
export async function runStartupSafetyChecks(
  userRuntimes: UserRuntime[],
  mongo: MongoClientWrapper,
  trackedSymbols: readonly string[],
): Promise<void> {
  for (const runtime of userRuntimes) {
    if (!runtime.config.enabled || !runtime.execution) continue;
    if (!runtime.execution.isLiveArmed) continue;

    const userId = runtime.config.userId;
    log.warn(
      `[STARTUP_SAFETY] userId=${userId} is LIVE-ARMED -- running fail-fast validation + reconciliation`,
    );

    let validated: boolean;
    try {
      validated = await runtime.execution.validateForLiveStart();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, userId }, "[STARTUP_SAFETY_VALIDATION_THREW]");
      validated = false;
    }

    if (!validated) {
      runtime.execution.setHalt(
        `userId=${userId} startup validation failed -- see [STARTUP_SAFETY_VALIDATION_*] logs above`,
      );
      log.error(
        `[STARTUP_SAFETY_HALTED] userId=${userId} — this user's own execution is halted. Every OTHER user is completely unaffected. Investigate and restart to clear.`,
      );
      continue;
    }

    let openSymbols: ReadonlySet<string>;
    try {
      const userSignalRepo = new UserSignalRepository(mongo, userId);
      const openDocs = await userSignalRepo.findOpen(userId);
      openSymbols = new Set(openDocs.map((d) => d.symbol));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId },
        "[STARTUP_SAFETY_OPEN_SYMBOLS_QUERY_FAILED] -- treating as zero known-open symbols",
      );
      openSymbols = new Set();
    }

    try {
      await runtime.execution.reconcileOnStartup(trackedSymbols, openSymbols);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, userId }, "[STARTUP_SAFETY_RECONCILE_THREW]");
      runtime.execution.setHalt(
        `userId=${userId} reconcileOnStartup threw: ${msg}`,
      );
      continue;
    }

    if (runtime.execution.isHalted) {
      log.error(
        `[STARTUP_SAFETY_HALTED] userId=${userId} — startup reconciliation engaged this user's own execution halt. Every OTHER user is completely unaffected. Investigate and restart to clear.`,
      );
    } else {
      log.info(
        `[STARTUP_SAFETY_PASSED] userId=${userId} — validation + reconciliation both passed`,
      );
    }
  }
}
