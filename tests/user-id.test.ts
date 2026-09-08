import * as assert from "assert";
import { isValidUserId, assertValidUserId, normalizeAndValidateUserId } from "../src/domain/user/user-id.validator";

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

console.log("Running userId validator tests...\n");

scenario("accepts simple lowercase alphanumeric ids", () => {
  assert.strictEqual(isValidUserId("karo"), true);
  assert.strictEqual(isValidUserId("friend"), true);
  assert.strictEqual(isValidUserId("artak_2"), true);
});

scenario("rejects uppercase", () => {
  assert.strictEqual(isValidUserId("Karo"), false);
});

scenario("rejects Mongo-injection-shaped input ($ne, dots, spaces)", () => {
  assert.strictEqual(isValidUserId("karo; db.dropDatabase()"), false);
  assert.strictEqual(isValidUserId("$ne"), false);
  assert.strictEqual(isValidUserId("a.b"), false);
  assert.strictEqual(isValidUserId("a b"), false);
  assert.strictEqual(isValidUserId(""), false);
});

scenario("rejects overly long ids (>32 chars)", () => {
  assert.strictEqual(isValidUserId("a".repeat(33)), false);
  assert.strictEqual(isValidUserId("a".repeat(32)), true);
});

scenario("assertValidUserId throws on invalid, does not throw on valid", () => {
  assert.throws(() => assertValidUserId("Bad Id!"));
  assert.doesNotThrow(() => assertValidUserId("karo"));
});

scenario("normalizeAndValidateUserId lowercases and trims before validating", () => {
  assert.strictEqual(normalizeAndValidateUserId("  Karo  "), "karo");
});

scenario("normalizeAndValidateUserId still throws if normalization can't produce a valid id", () => {
  assert.throws(() => normalizeAndValidateUserId("karo!"));
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
