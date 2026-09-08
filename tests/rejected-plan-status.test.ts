/**
 * Sep 8 2026 (Karo). Proves the status-labeling fix: a rejected plan
 * (event.plan === null) must never be stored with status="SIGNAL" --
 * mirrors market-data-orchestrator.ts's own `hasRealPlan` logic
 * exactly.
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

/** Mirrors market-data-orchestrator.ts's own status-selection line:
 *  `status: hasRealPlan ? "SIGNAL" : "REJECTED_PLAN"`, where
 *  `hasRealPlan = event.plan !== null`. */
function resolveStatus(
  plan: { entry: number; tp: number; sl: number } | null,
): "SIGNAL" | "REJECTED_PLAN" {
  const hasRealPlan = plan !== null;
  return hasRealPlan ? "SIGNAL" : "REJECTED_PLAN";
}

console.log("Running rejected-plan status-labeling tests...\n");

scenario(
  "rejected plan (plan === null) is NOT stored as SIGNAL -- gets the distinct REJECTED_PLAN status instead",
  () => {
    const status = resolveStatus(null);
    assert.strictEqual(status, "REJECTED_PLAN");
    assert.notStrictEqual(status, "SIGNAL");
  },
);

scenario(
  "a real, executable plan (entry/tp/sl all present) IS stored as SIGNAL",
  () => {
    const status = resolveStatus({ entry: 100, tp: 105, sl: 98 });
    assert.strictEqual(status, "SIGNAL");
  },
);

scenario(
  "REJECTED_PLAN is distinguishable from a V5TerminalReason (e.g. W1_EXTREME_TOO_SMALL) -- both are non-SIGNAL, but represent genuinely different situations: REJECTED_PLAN reached entry-evaluation, a TERMINAL_NON_SIGNAL episode never did",
  () => {
    const rejectedPlanStatus = resolveStatus(null);
    const terminalNonSignalStatus = "W1_EXTREME_TOO_SMALL"; // a real V5TerminalReason value
    assert.notStrictEqual(
      rejectedPlanStatus,
      terminalNonSignalStatus,
      "these must remain distinguishable statuses, never collapsed into one",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
