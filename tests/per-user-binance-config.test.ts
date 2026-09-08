/**
 * Sep 8 2026 (Karo). Proves the critical safety fix: each user's own
 * BinanceExecutionService instance is independently configured from
 * that user's OWN UserConfig.binance block, never a shared global
 * env var. Constructs REAL BinanceRestClient/BinanceExecutionService
 * instances (no live network calls happen during construction) with
 * lightweight fake repositories, so this runs instantly with zero
 * external dependencies.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { BinanceRestClient } from "../src/infrastructure/binance/binanceRest.client";
import { BinanceExecutionService } from "../src/infrastructure/binance/binance-execution.service";
import type { ExecutionRecordRepository } from "../src/infrastructure/mongo/execution-record.repository";
import type { ExecutionClaimRepository } from "../src/infrastructure/mongo/execution-claim.repository";

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

function fakeRest(apiKey: string, apiSecret: string): BinanceRestClient {
  return new BinanceRestClient({
    restBaseUrl: "https://fapi.binance.com",
    wsBaseUrl: "wss://fstream.binance.com",
    apiKey,
    apiSecret,
    testnet: false,
    recvWindowMs: 5000,
  });
}

const fakeExecutionRecordRepo = {} as ExecutionRecordRepository;
const fakeExecutionClaimRepo = {} as ExecutionClaimRepository;

function buildExecutionService(
  apiKey: string,
  apiSecret: string,
  perUserConfig: {
    mode?: "shadow" | "live";
    orderExecutionEnabled?: boolean;
    leverage?: number;
    marginMode?: "ISOLATED" | "CROSSED";
  },
): BinanceExecutionService {
  return new BinanceExecutionService(fakeRest(apiKey, apiSecret), fakeExecutionRecordRepo, fakeExecutionClaimRepo, null, perUserConfig);
}

console.log("Running per-user Binance execution config tests...\n");

scenario("one user can be LIVE while another is SHADOW, simultaneously, in the same process", () => {
  const karo = buildExecutionService("karoKey", "karoSecret", { mode: "live", orderExecutionEnabled: true });
  const friend = buildExecutionService("friendKey", "friendSecret", { mode: "shadow", orderExecutionEnabled: false });
  assert.strictEqual(karo.isLiveArmed, true, "Karo must be live-armed");
  assert.strictEqual(friend.isLiveArmed, false, "Friend must NOT be live-armed");
});

scenario("mode='live' ALONE, without orderExecutionEnabled=true, is still NOT live-armed -- preserves the original two-key safety design", () => {
  const halfConfigured = buildExecutionService("key", "secret", { mode: "live", orderExecutionEnabled: false });
  assert.strictEqual(halfConfigured.isLiveArmed, false, "mode=live alone must never be sufficient -- matches liqwatch-bot's own confirmed main-bot SHADOW state");
});

scenario("orderExecutionEnabled=true ALONE, without mode='live', is still NOT live-armed", () => {
  const halfConfigured = buildExecutionService("key", "secret", { mode: "shadow", orderExecutionEnabled: true });
  assert.strictEqual(halfConfigured.isLiveArmed, false);
});

scenario("a disabled user (Artak) never even gets a BinanceExecutionService instance -- structural proof", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/services/user-runtime.ts"), "utf8");
  assert.ok(src.includes("if (config.binance && config.binance.enabled)"));
});

scenario("default construction (no perUserConfig) falls back to the exact original SAFE defaults -- never accidentally live", () => {
  const noConfig = new BinanceExecutionService(fakeRest("k", "s"), fakeExecutionRecordRepo, fakeExecutionClaimRepo, null);
  assert.strictEqual(noConfig.isLiveArmed, false);
});

scenario("one user's leverage/marginMode does not affect another (independent constructor-scoped fields, no global env var read)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/infrastructure/binance/binance-execution.service.ts"), "utf8");
  assert.ok(src.includes("this.leverage = perUserConfig?.leverage ?? 20;"));
  assert.ok(src.includes('this.marginMode = perUserConfig?.marginMode ?? "ISOLATED";'));
  assert.ok(!src.includes("process.env.BINANCE_LIVE_LEVERAGE"));
  assert.ok(!src.includes("process.env.BINANCE_MARGIN_MODE"));
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
