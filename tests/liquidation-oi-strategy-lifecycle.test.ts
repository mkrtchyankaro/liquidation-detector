import * as assert from "assert";
import {
  isValidGlobalTransition, isGlobalTerminal, holdsSymbolOwnership,
  isValidUserStateTransition, isEligibleForTpRevision, isGlobalCloseEligible,
  candidateTradeSideForVictim, type GlobalLifecycleState,
} from "../src/domain/liquidation-oi-strategy/lifecycle.types";
import { strategyClientOrderId, isStrategyOwnedOrderId } from "../src/domain/liquidation-oi-strategy/strategy-order-identity";

let passed = 0;
let failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}`); console.log(`      ${err instanceof Error ? err.message : String(err)}\n`); }
}

function main(): void {
  console.log("Running liquidation-oi-strategy-lifecycle tests (Phase 1)...\n");

  scenario("1. the full happy-path global lifecycle is valid step by step", () => {
    const path: GlobalLifecycleState[] = ["EPISODE_TRACKING", "WATCH_QUALIFIED", "EXHAUSTION_CANDIDATE", "WAIT_FOR_POST_EPISODE_OI_CREATION", "ENTRY_READY", "ACTIVE", "CLOSING", "CLOSED"];
    for (let i = 1; i < path.length; i++) assert.ok(isValidGlobalTransition(path[i - 1]!, path[i]!), `${path[i - 1]} -> ${path[i]} must be valid`);
  });

  scenario("2. CANCELLED is reachable from every pre-entry state, but never from ACTIVE/CLOSING/CLOSED", () => {
    for (const s of ["EPISODE_TRACKING", "WATCH_QUALIFIED", "EXHAUSTION_CANDIDATE", "WAIT_FOR_POST_EPISODE_OI_CREATION", "ENTRY_READY"] as const) assert.ok(isValidGlobalTransition(s, "CANCELLED"));
    for (const s of ["ACTIVE", "CLOSING", "CLOSED"] as const) assert.ok(!isValidGlobalTransition(s, "CANCELLED"), `${s} -> CANCELLED must be invalid -- once ACTIVE, only CLOSING/CLOSED terminates it`);
  });

  scenario("3. ACTIVE can only go to CLOSING, never straight to CLOSED (must pass through cleanup)", () => {
    assert.ok(isValidGlobalTransition("ACTIVE", "CLOSING"));
    assert.ok(!isValidGlobalTransition("ACTIVE", "CLOSED"), "ACTIVE must never skip CLOSING -- cleanup must always be attempted first");
  });

  scenario("4. terminal global states (CLOSED, CANCELLED) have no outgoing transitions at all", () => {
    assert.strictEqual(isGlobalTerminal("CLOSED"), true);
    assert.strictEqual(isGlobalTerminal("CANCELLED"), true);
    for (const target of ["IDLE", "EPISODE_TRACKING", "ACTIVE"] as const) {
      assert.ok(!isValidGlobalTransition("CLOSED", target));
      assert.ok(!isValidGlobalTransition("CANCELLED", target));
    }
  });

  scenario("5. symbol ownership is held from WATCH_QUALIFIED through CLOSING, but NOT during EPISODE_TRACKING and NOT after CLOSED/CANCELLED", () => {
    assert.strictEqual(holdsSymbolOwnership("EPISODE_TRACKING"), false, "lightweight pre-WATCH tracking must not lock the symbol");
    for (const s of ["WATCH_QUALIFIED", "EXHAUSTION_CANDIDATE", "WAIT_FOR_POST_EPISODE_OI_CREATION", "ENTRY_READY", "ACTIVE", "CLOSING"] as const) assert.strictEqual(holdsSymbolOwnership(s), true, `${s} must hold ownership -- symbol cannot unlock while CLOSING`);
    assert.strictEqual(holdsSymbolOwnership("CLOSED"), false);
    assert.strictEqual(holdsSymbolOwnership("IDLE"), false);
  });

  scenario("6. INVARIANT 1: a TERMINAL user execution can never transition back to ACTIVE or PENDING", () => {
    assert.strictEqual(isValidUserStateTransition("TERMINAL", "ACTIVE"), false);
    assert.strictEqual(isValidUserStateTransition("TERMINAL", "PENDING"), false);
    assert.strictEqual(isValidUserStateTransition("PENDING", "ACTIVE"), true);
    assert.strictEqual(isValidUserStateTransition("ACTIVE", "TERMINAL"), true);
    assert.strictEqual(isValidUserStateTransition("PENDING", "TERMINAL"), true, "a user can go terminal directly from PENDING (e.g. execution failure before ever becoming active)");
  });

  scenario("7. INVARIANT 2: only ACTIVE users are eligible for a TP revision -- terminal and pending users are excluded", () => {
    assert.strictEqual(isEligibleForTpRevision("ACTIVE"), true);
    assert.strictEqual(isEligibleForTpRevision("TERMINAL"), false, "a terminal user (e.g. Artak after manual close) must never receive a TP revision");
    assert.strictEqual(isEligibleForTpRevision("PENDING"), false);
  });

  scenario("8. global CLOSED is refused while unresolved strategy orders remain, even if every user is terminal and cleanup-complete", () => {
    const result = isGlobalCloseEligible({
      mainThesisTerminal: true,
      users: [{ userId: "karo", state: "TERMINAL", cleanupState: "COMPLETE" }, { userId: "artak", state: "TERMINAL", cleanupState: "COMPLETE" }],
      unresolvedStrategyOrderCount: 1,
    });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes("unresolved strategy-owned order")));
  });

  scenario("9. global CLOSED is refused while any user's cleanup is not COMPLETE, even with zero unresolved orders", () => {
    const result = isGlobalCloseEligible({
      mainThesisTerminal: true,
      users: [{ userId: "karo", state: "TERMINAL", cleanupState: "FAILED_RETRYING" }],
      unresolvedStrategyOrderCount: 0,
    });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes("cleanupState")));
  });

  scenario("10. global CLOSED is refused while any user is still ACTIVE and the thesis is not yet terminal", () => {
    const result = isGlobalCloseEligible({
      mainThesisTerminal: false,
      users: [{ userId: "karo", state: "ACTIVE", cleanupState: "PENDING" }],
      unresolvedStrategyOrderCount: 0,
    });
    assert.strictEqual(result.eligible, false);
  });

  scenario("11. global CLOSED IS eligible when every condition is genuinely satisfied", () => {
    const result = isGlobalCloseEligible({
      mainThesisTerminal: true,
      users: [{ userId: "karo", state: "TERMINAL", cleanupState: "COMPLETE" }, { userId: "artak", state: "TERMINAL", cleanupState: "COMPLETE" }],
      unresolvedStrategyOrderCount: 0,
    });
    assert.strictEqual(result.eligible, true);
    assert.strictEqual(result.reasons.length, 0);
  });

  scenario("12. global CLOSED is ALSO eligible when the thesis itself is not marked terminal, but no manageable user remains (e.g. everyone manually closed)", () => {
    const result = isGlobalCloseEligible({
      mainThesisTerminal: false,
      users: [{ userId: "karo", state: "TERMINAL", cleanupState: "COMPLETE" }, { userId: "artak", state: "TERMINAL", cleanupState: "COMPLETE" }],
      unresolvedStrategyOrderCount: 0,
    });
    assert.strictEqual(result.eligible, true, "if every user independently terminated, there is nothing left to manage regardless of the thesis's own state");
  });

  scenario("13. candidate trade side mirrors the liquidation victim side (SHORT liq -> SHORT candidate), per the approved philosophy", () => {
    assert.strictEqual(candidateTradeSideForVictim("SHORT"), "SHORT");
    assert.strictEqual(candidateTradeSideForVictim("LONG"), "LONG");
  });

  scenario("14. strategyClientOrderId is deterministic -- same inputs always produce the same id", () => {
    const id1 = strategyClientOrderId("karo", "sig-abc-123", "TAKE_PROFIT", 3);
    const id2 = strategyClientOrderId("karo", "sig-abc-123", "TAKE_PROFIT", 3);
    assert.strictEqual(id1, id2, "identical (userId, globalSignalId, purpose, revision) must always produce the identical clientOrderId, enabling safe retry");
  });

  scenario("15. strategyClientOrderId differs for different revisions -- a stale revision's id is never reused for a new one", () => {
    const rev3 = strategyClientOrderId("karo", "sig-abc-123", "TAKE_PROFIT", 3);
    const rev4 = strategyClientOrderId("karo", "sig-abc-123", "TAKE_PROFIT", 4);
    assert.notStrictEqual(rev3, rev4);
  });

  scenario("16. strategyClientOrderId differs across users, purposes, and signals -- no cross-identity collision", () => {
    const base = strategyClientOrderId("karo", "sig-abc-123", "TAKE_PROFIT", 1);
    assert.notStrictEqual(base, strategyClientOrderId("artak", "sig-abc-123", "TAKE_PROFIT", 1), "different user must differ");
    assert.notStrictEqual(base, strategyClientOrderId("karo", "sig-xyz-999", "TAKE_PROFIT", 1), "different signal must differ");
    assert.notStrictEqual(base, strategyClientOrderId("karo", "sig-abc-123", "EMERGENCY_STOP", 1), "different purpose must differ");
  });

  scenario("17. every generated id stays within Binance's 36-character clientOrderId limit", () => {
    const id = strategyClientOrderId("some-very-long-user-identifier-example", "an-extremely-long-global-signal-id-value-here", "EMERGENCY_STOP", 999999);
    assert.ok(id.length <= 36, `id "${id}" is ${id.length} chars, exceeds Binance's 36-char limit`);
  });

  scenario("18. strategy-owned ids never collide with the legacy V3 clientOrderId prefix", () => {
    const id = strategyClientOrderId("karo", "sig-abc-123", "ENTRY", 0);
    assert.ok(!id.startsWith("v3"), "this strategy's ids must never start with the legacy V3 prefix -- distinct namespaces are required");
    assert.ok(isStrategyOwnedOrderId(id));
    assert.ok(!isStrategyOwnedOrderId("v3eabc123def456"), "a legacy V3-shaped id must never be misidentified as belonging to this strategy");
    assert.ok(!isStrategyOwnedOrderId("some-manual-order-id-a-human-set"), "an unrelated manual order id must never be misidentified as strategy-owned -- this is what prevents cancelling unrelated user orders");
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
