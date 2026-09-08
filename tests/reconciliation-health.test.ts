/**
 * Sep 8 2026, operator-requested (Karo). Focused tests for
 * ReconciliationHealthTracker -- proving the exact failure -> backoff
 * -> 5-minute alert -> recovery/reset lifecycle, using synthetic `now`
 * timestamps (no real setTimeout delays needed, since every method
 * takes `now` explicitly).
 *
 * Usage: npx tsx src/tools/reconciliation-health-tests.ts
 */
import * as assert from "assert";
import { ReconciliationHealthTracker } from '../src/domain/trading/risk/reconciliation-health';

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

console.log("Running ReconciliationHealthTracker tests...\n");

scenario("a signal with no prior failure is never skipped, and its first recordFailure() does NOT alert (episode just started)", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();
  assert.strictEqual(tracker.shouldSkipRetry("sig-1", t0), false);
  const shouldAlert = tracker.recordFailure("sig-1", t0);
  assert.strictEqual(shouldAlert, false, "a brand-new failure episode must never alert immediately");
});

scenario("immediately after a failure, the SAME signal is skipped (within the 5s backoff window)", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();
  tracker.recordFailure("sig-2", t0);
  assert.strictEqual(tracker.shouldSkipRetry("sig-2", t0 + 1000), true, "1s later -- still within the 5s backoff");
  assert.strictEqual(tracker.shouldSkipRetry("sig-2", t0 + 4999), true, "4.999s later -- still within backoff");
});

scenario("after the 5s backoff window elapses, retries are allowed again", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();
  tracker.recordFailure("sig-3", t0);
  assert.strictEqual(tracker.shouldSkipRetry("sig-3", t0 + 5001), false, "5.001s later -- backoff elapsed, must retry");
});

scenario("multiple failures accumulating BEFORE the 5-minute threshold never alert", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();
  tracker.recordFailure("sig-4", t0);
  for (let i = 1; i <= 10; i++) {
    const shouldAlert = tracker.recordFailure("sig-4", t0 + i * 10_000); // every 10s, up to 100s total -- well under 5 min
    assert.strictEqual(shouldAlert, false, `failure #${i + 1} at ${i * 10}s must not alert yet`);
  }
});

scenario("EXACTLY at the 5-minute continuous-failure mark, recordFailure() alerts ONCE", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();
  tracker.recordFailure("sig-5", t0); // episode starts
  const stillTooEarly = tracker.recordFailure("sig-5", t0 + 5 * 60_000 - 1); // 1ms before 5 min
  assert.strictEqual(stillTooEarly, false, "1ms before the threshold must not alert yet");
  const nowAlerts = tracker.recordFailure("sig-5", t0 + 5 * 60_000); // exactly 5 min
  assert.strictEqual(nowAlerts, true, "exactly at the 5-minute mark, the alert must fire");
});

scenario("after the alert has fired, FURTHER failures in the SAME ongoing episode NEVER re-alert (no spam)", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();
  tracker.recordFailure("sig-6", t0);
  assert.strictEqual(tracker.recordFailure("sig-6", t0 + 5 * 60_000), true, "first alert fires");
  assert.strictEqual(tracker.recordFailure("sig-6", t0 + 10 * 60_000), false, "10 min in -- must NOT re-alert");
  assert.strictEqual(tracker.recordFailure("sig-6", t0 + 60 * 60_000), false, "1 hour in -- still must NOT re-alert, same episode");
});

scenario("recordSuccess() clears the episode and reports recovery -- the FULL lifecycle: failure -> backoff -> alert -> recovery", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();

  // Failure episode begins.
  tracker.recordFailure("sig-7", t0);
  assert.strictEqual(tracker.shouldSkipRetry("sig-7", t0 + 1000), true, "backoff active");

  // Crosses the 5-minute mark -- exactly one alert.
  assert.strictEqual(tracker.recordFailure("sig-7", t0 + 5 * 60_000), true);

  // Recovery: reconciliation finally succeeds.
  const recovered = tracker.recordSuccess("sig-7");
  assert.strictEqual(recovered, true, "there WAS an ongoing episode -- recordSuccess must report the recovery");

  // Backoff/failure state is fully reset -- immediately retryable, no lingering skip.
  assert.strictEqual(tracker.shouldSkipRetry("sig-7", t0 + 5 * 60_000 + 1), false, "must be immediately retryable right after recovery");

  // A SECOND, brand-new failure episode starts its OWN fresh 5-minute
  // timer -- does NOT inherit any time from the prior, already-
  // recovered episode.
  tracker.recordFailure("sig-7", t0 + 5 * 60_000 + 1);
  assert.strictEqual(
    tracker.recordFailure("sig-7", t0 + 5 * 60_000 + 1 + 4 * 60_000),
    false,
    "only 4 minutes into the NEW episode -- must not alert yet, timer did not carry over from the old episode",
  );
});

scenario("recordSuccess() on a signal with NO ongoing failure episode is a safe no-op, reports false (nothing to recover from)", () => {
  const tracker = new ReconciliationHealthTracker();
  const recovered = tracker.recordSuccess("sig-8-never-failed");
  assert.strictEqual(recovered, false);
});

scenario("different signals have completely independent failure/backoff/alert state", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();
  tracker.recordFailure("sig-A", t0);
  // sig-B has never failed -- must never be skipped, regardless of sig-A's state.
  assert.strictEqual(tracker.shouldSkipRetry("sig-B", t0 + 1000), false);
  assert.strictEqual(tracker.recordFailure("sig-B", t0 + 5 * 60_000), false, "sig-B's OWN episode just started -- independent of sig-A's 5-min-old one");
});

scenario("clear() explicitly removes tracking for a signal, regardless of episode state", () => {
  const tracker = new ReconciliationHealthTracker({ backoffMs: 5_000, alertThresholdMs: 5 * 60_000 });
  const t0 = Date.now();
  tracker.recordFailure("sig-9", t0);
  tracker.clear("sig-9");
  assert.strictEqual(tracker.shouldSkipRetry("sig-9", t0 + 100), false, "cleared -- no backoff should remain");
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
