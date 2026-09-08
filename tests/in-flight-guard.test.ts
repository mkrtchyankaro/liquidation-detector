/**
 * Sep 8 2026, operator-requested (Karo). Focused regression tests for
 * InFlightGuard -- proving it prevents the EXACT race V3's own
 * confirmed production incident (Aug 26 2026, duplicate [V3_CLOSE]
 * Telegram message) exposed, now ALSO closed in V5's own live-
 * reconciliation path (see app.ts's own reconcileV5LiveTrade doc
 * comment).
 *
 * Usage: npx tsx src/tools/in-flight-guard-tests.ts
 */
import * as assert from "assert";
import { InFlightGuard } from '../src/domain/trading/risk/in-flight-guard';

let passed = 0;
let failed = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const result = fn();
  if (result instanceof Promise) {
    return result
      .then(() => {
        passed++;
        console.log(`  \u2713 ${name}`);
      })
      .catch((err) => {
        failed++;
        console.log(`  \u2717 ${name}`);
        console.log(`      ${err instanceof Error ? err.message : String(err)}\n`);
      });
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("Running InFlightGuard tests...\n");

  await scenario(
    "TWO concurrent calls, same key, while the first is still 'awaiting a pending Binance REST call' -- the exact scenario that caused V3's real duplicate-Telegram incident. Only ONE actually runs the real work.",
    async () => {
      const guard = new InFlightGuard();
      let executionCount = 0;
      const doWork = async () => {
        await delay(50); // simulates reconcileLivePosition()'s own REST round-trip
        executionCount++;
        return "closed";
      };

      // Two "price ticks" arriving back-to-back, well within the 50ms
      // the first call's own REST round-trip is still pending --
      // exactly what handleV5Tick() firing twice in quick succession
      // looks like.
      const [r1, r2] = await Promise.all([guard.run("signal-A", doWork), guard.run("signal-A", doWork)]);

      assert.strictEqual(executionCount, 1, "the real work (Binance reconciliation + Mongo finalize + Telegram close + claim release) must run EXACTLY ONCE, never twice");
      const results = [r1, r2].filter((r) => r !== undefined);
      assert.strictEqual(results.length, 1, "exactly one of the two concurrent calls must have actually executed and returned a real result");
    },
  );

  await scenario(
    "THREE-way concurrent race, same key -- still only ever ONE execution, regardless of how many ticks pile up during the pending window",
    async () => {
      const guard = new InFlightGuard();
      let executionCount = 0;
      const doWork = async () => {
        await delay(30);
        executionCount++;
      };
      await Promise.all([guard.run("signal-B", doWork), guard.run("signal-B", doWork), guard.run("signal-B", doWork)]);
      assert.strictEqual(executionCount, 1);
    },
  );

  await scenario(
    "AFTER the first call fully completes (guard released), a genuinely LATER call with the SAME key is allowed to run normally -- the guard is never permanently stuck",
    async () => {
      const guard = new InFlightGuard();
      let executionCount = 0;
      const doWork = async () => {
        executionCount++;
      };
      await guard.run("signal-C", doWork); // completes fully, releases
      await guard.run("signal-C", doWork); // genuinely sequential -- must run again
      assert.strictEqual(executionCount, 2, "a later, non-overlapping call must NOT be blocked by a long-finished earlier one");
    },
  );

  await scenario(
    "DIFFERENT keys never block each other -- two different signalIds/symbols reconcile fully independently, concurrently",
    async () => {
      const guard = new InFlightGuard();
      let countA = 0;
      let countB = 0;
      await Promise.all([
        guard.run("signal-D", async () => {
          await delay(20);
          countA++;
        }),
        guard.run("signal-E", async () => {
          await delay(20);
          countB++;
        }),
      ]);
      assert.strictEqual(countA, 1);
      assert.strictEqual(countB, 1);
    },
  );

  await scenario(
    "if the wrapped work THROWS, the guard is still released (finally-block guarantee) -- a failed reconciliation correctly retries on the NEXT tick, never permanently locked out",
    async () => {
      const guard = new InFlightGuard();
      let attempt = 0;
      const flaky = async () => {
        attempt++;
        if (attempt === 1) throw new Error("simulated Binance REST failure");
        return "ok";
      };
      await assert.rejects(guard.run("signal-F", flaky));
      assert.strictEqual(guard.isInFlight("signal-F"), false, "must be released even after a throw");
      const result = await guard.run("signal-F", flaky); // retry, same key -- must be allowed
      assert.strictEqual(result, "ok");
      assert.strictEqual(attempt, 2);
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
