/**
 * Sep 10 2026 (Karo), operator-requested common-horizon-4h-v1 research.
 * Proves: Wilder-ATR with a configurable period is computed correctly
 * and isolated from the existing ATR(14) path; only closed candles
 * contribute; the readiness gate prevents starting research with
 * partial ATR state; the production-signal-disable gate is structurally
 * sound (state machine keeps running, only downstream consequences are
 * gated); peekWatch() is pure/read-only.
 */
import * as assert from "assert";
import * as fs from "fs";
import { ATRTrackerService } from "../src/domain/market/atr-tracker.service";
import { UnitResearchShadowService } from "../src/domain/research/unit-research-shadow.service";
import type { Candle } from "../src/shared/common.types";

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

function candle(interval: string, openTime: number, close: number, isClosed = true): Candle {
  return { symbol: "ETHUSDT", interval, openTime, closeTime: openTime + 60_000, open: close, high: close + 1, low: close - 1, close, volume: 100, isClosed } as unknown as Candle;
}

console.log("Running common-horizon-research tests...\n");

// ─── getWilderATR: correctness, isolation from getATR(14) ──────────────

scenario("getWilderATR returns null when the research buffer has fewer than period+1 candles", () => {
  const tracker = new ATRTrackerService();
  for (let i = 0; i < 50; i++) tracker.onCandle(candle("1m", i * 60_000, 2000 + i));
  assert.strictEqual(tracker.getWilderATR("ETHUSDT", "1m", 240), null, "50 candles is nowhere near enough for period=240");
});

scenario("getWilderATR returns a real value once the research buffer has period+1 candles", () => {
  const tracker = new ATRTrackerService();
  for (let i = 0; i < 250; i++) tracker.onCandle(candle("1m", i * 60_000, 2000 + Math.sin(i) * 5));
  const v = tracker.getWilderATR("ETHUSDT", "1m", 240);
  assert.ok(v !== null && v > 0, `expected a real positive ATR, got ${v}`);
});

scenario("getWilderATR at period=14 matches getATR(14)'s own value closely -- same Wilder formula, same underlying candle data, just fed through the separate research buffer", () => {
  const tracker = new ATRTrackerService();
  for (let i = 0; i < 100; i++) tracker.onCandle(candle("1m", i * 60_000, 2000 + Math.sin(i) * 5));
  const production = tracker.getATR("ETHUSDT", "1m");
  const research = tracker.getWilderATR("ETHUSDT", "1m", 14);
  assert.ok(production !== null && research !== null);
  assert.ok(Math.abs(production! - research!) < 1e-6, `production=${production} research=${research} should match closely (same formula, same data)`);
});

scenario("structural: getATR() never reads the separate research buffer", () => {
  const source = fs.readFileSync(require.resolve("../src/domain/market/atr-tracker.service.ts"), "utf8");
  const idx = source.indexOf("\n  getATR(");
  assert.ok(idx > -1, "getATR must be defined");
  const getAtrBody = source.slice(idx, source.indexOf("\n  /**", idx + 10));
  assert.ok(!getAtrBody.includes("researchState"), "getATR() must never read the separate research buffer");
});

scenario("structural: getWilderATR() reads ONLY the separate researchState buffer, never the existing `state` map getATR(14) uses", () => {
  const source = fs.readFileSync(require.resolve("../src/domain/market/atr-tracker.service.ts"), "utf8");
  // Search for "\n  getWilderATR(" (method-declaration-line-start,
  // 2-space indent, no comment marker) -- skips doc-comment references
  // to the SAME name (e.g. "read ONLY by getWilderATR() below"), which
  // a bare indexOf("getWilderATR(") would incorrectly match first.
  const idx = source.indexOf("\n  getWilderATR(");
  assert.ok(idx > -1, "getWilderATR's own method declaration must exist");
  const body = source.slice(idx, source.indexOf("\n  /**", idx + 10));
  assert.ok(body.includes("researchState.get("), "getWilderATR must read from researchState");
  assert.ok(!body.includes("this.state.get("), "getWilderATR must never read the existing state map");
});

// ─── Only closed candles contribute ─────────────────────────────────────

scenario("un-closed candles never enter the research buffer either -- restart/bootstrap uses the SAME closed-candle-only rule as live", () => {
  const tracker = new ATRTrackerService();
  for (let i = 0; i < 20; i++) tracker.onCandle(candle("1m", i * 60_000, 2000 + i, false)); // all un-closed
  assert.strictEqual(tracker.researchCandleCount("ETHUSDT", "1m"), 0, "un-closed candles must never be counted in the research buffer");
});

scenario("structural: onCandle()'s own closed-candle guard runs BEFORE both the existing and the research buffer are fed -- one shared gate, not two separate checks that could diverge", () => {
  const source = fs.readFileSync(require.resolve("../src/domain/market/atr-tracker.service.ts"), "utf8");
  const onCandleIdx = source.indexOf("\n  onCandle(");
  assert.ok(onCandleIdx > -1, "onCandle must be defined");
  const onCandleBody = source.slice(onCandleIdx, source.indexOf("\n  /**", onCandleIdx));
  const guardIdx = onCandleBody.indexOf("c.isClosed");
  const researchPushIdx = onCandleBody.indexOf("researchState.set(");
  assert.ok(guardIdx > -1 && researchPushIdx > -1 && guardIdx < researchPushIdx, "the closed-candle guard must run before the research buffer is ever touched");
});

// ─── Readiness gate ──────────────────────────────────────────────────────

scenario("structural: commonHorizonAtrReady() checks ONLY the 1m Wilder-ATR period (240) now -- production no longer waits for 3m/5m confirmation (operator-requested 1m-only simplification)", () => {
  const source = fs.readFileSync(require.resolve("../src/services/market-data-orchestrator.ts"), "utf8");
  const idx = source.indexOf("private commonHorizonAtrReady(");
  assert.ok(idx > -1, "commonHorizonAtrReady must be defined");
  const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
  assert.ok(body.includes("getWilderATR(") && body.includes('"1m"') && body.includes("COMMON_HORIZON_PERIODS.atr1m"), "must check the 1m Wilder-ATR period");
  assert.ok(!body.includes('"3m"') && !body.includes("COMMON_HORIZON_PERIODS.atr3m"), "must NEVER check the 3m Wilder-ATR period anymore");
  assert.ok(!body.includes('"5m"') && !body.includes("COMMON_HORIZON_PERIODS.atr5m"), "must NEVER check the 5m Wilder-ATR period anymore");
});

scenario("structural: the common-horizon episode-start call-site is gated by commonHorizonAtrReady() -- a liquidation arriving with incomplete bootstrap is skipped for research entirely, never started with partial state", () => {
  const source = fs.readFileSync(require.resolve("../src/services/market-data-orchestrator.ts"), "utf8");
  const idx = source.indexOf("private feedCommonHorizonCompetition(");
  assert.ok(idx > -1, "feedCommonHorizonCompetition's own declaration must exist");
  const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
  const gateIdx = body.indexOf("commonHorizonAtrReady(");
  const startIdx = body.indexOf("competitionShadow1m.startEpisode(");
  assert.ok(gateIdx > -1 && startIdx > -1 && gateIdx < startIdx, "startEpisode() calls for the common-horizon candidates must be inside the readiness-gated block");
});

// ─── Production-signal-disable gate ─────────────────────────────────────

scenario("structural: productionSignalsEnabled gates BOTH distributor.distribute() AND mainSymbolLocks.add() together -- locking a symbol without ever distributing would permanently starve research for that symbol", () => {
  const source = fs.readFileSync(require.resolve("../src/services/market-data-orchestrator.ts"), "utf8");
  const idx = source.indexOf("productionSignalsEnabled) {");
  assert.ok(idx > -1, "the productionSignalsEnabled gate must exist");
  // The gate's own body contains a NESTED "if (hasRealPlan..." at a
  // deeper indent; the boundary we want is the LATER, outer-indent
  // occurrence after the gate closes -- distinguish by requiring the
  // 6-space (not 8-space) indent prefix specific to the outer block.
  let bodyEnd = source.indexOf("\n      if (hasRealPlan", idx);
  if (bodyEnd === -1) bodyEnd = source.indexOf("\n  private ", idx); // fallback boundary
  const body = source.slice(idx, bodyEnd);
  assert.ok(body.includes("distributor.distribute("), "distribute() must be inside the gate");
  assert.ok(body.includes("mainSymbolLocks.add("), "mainSymbolLocks.add() must be inside the SAME gate");
});

scenario("structural: V5WaveService's own onLiquidation() call is now fully disconnected (Sep 12 2026 legacy-shadow cleanup, confirmed safe -- its own downstream research consumer, feedUnitResearchShadowAfter, was ALREADY disconnected before this change); onTick() remains connected, unconditionally, never gated by productionSignalsEnabled", () => {
  const source = fs.readFileSync(require.resolve("../src/services/market-data-orchestrator.ts"), "utf8");
  const codeOnly = source.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  const v5OnLiqLine = codeOnly.split("\n").find((l) => l.includes("this.v5.onLiquidation("));
  const v5OnTickLine = codeOnly.split("\n").find((l) => l.includes("this.v5.onTick("));
  assert.strictEqual(v5OnLiqLine, undefined, "v5.onLiquidation() must have NO executable (non-comment) call-site anymore -- fully disconnected, per the Sep 12 2026 legacy-shadow cleanup");
  assert.ok(v5OnTickLine && !v5OnTickLine.includes("productionSignalsEnabled"), "v5.onTick() call itself must not be gated -- left connected, its own side effects confirmed harmless once onLiquidation() no longer feeds it new watches");
});

scenario("structural: productionSignalsEnabled now defaults to false (Sep 17 2026, operator-reported CRITICAL SAFETY FIX -- FAIL-CLOSED, not FAIL-OPEN; a live V5 SOLUSDT ENTRY was observed while V5_PRODUCTION_SIGNALS_ENABLED was not explicitly forced off at this default)", () => {
  const source = fs.readFileSync(require.resolve("../src/services/market-data-orchestrator.ts"), "utf8");
  assert.ok(source.includes("productionSignalsEnabled: boolean = false"), "the default must be false -- any call site that omits this parameter must get V5 production signals DISABLED, never silently enabled");
  assert.ok(!source.includes("productionSignalsEnabled: boolean = true"), "the old, unsafe fail-open default must not still be present anywhere");
});

scenario("structural: no restart/hydration path can flip productionSignalsEnabled back on -- it is a plain constructor boolean, never read from or written to Mongo", () => {
  const source = fs.readFileSync(require.resolve("../src/services/market-data-orchestrator.ts"), "utf8");
  // The field must be `private readonly` (set once, at construction, never reassigned) and must never appear as
  // part of any Mongo read/write (findOne/updateOne/insertOne/upsert) in this file.
  assert.ok(source.includes("private readonly productionSignalsEnabled"), "must be immutable after construction -- no runtime code path can toggle it");
  const mongoWriteLines = source.split("\n").filter((l) => /\.(updateOne|insertOne|replaceOne|findOneAndUpdate)\(/.test(l));
  for (const line of mongoWriteLines) assert.ok(!line.includes("productionSignalsEnabled"), `productionSignalsEnabled must never be persisted/restored via Mongo: ${line}`);
});

scenario("structural: main.ts wires productionSignalsEnabled from V5_PRODUCTION_SIGNALS_ENABLED, which is false unless that env var is literally the string \"true\" -- one clear source of truth, not scattered", () => {
  const source = fs.readFileSync(require.resolve("../src/main.ts"), "utf8");
  assert.ok(source.includes('process.env.V5_PRODUCTION_SIGNALS_ENABLED === "true"'), "main.ts must derive the flag from this exact, single env var check");
});

// ─── peekWatch() purity ──────────────────────────────────────────────────

scenario("peekWatch() never mutates shadow state -- calling it many times in a row returns identical results and never advances the watch toward a terminal state", () => {
  const shadow = new UnitResearchShadowService(() => 1000);
  shadow.startEpisode("ETHUSDT", "LONG", "sig-1", 5, 2000, 1000, 5000, 1000);
  const peek1 = shadow.peekWatch("ETHUSDT", "LONG");
  const peek2 = shadow.peekWatch("ETHUSDT", "LONG");
  const peek3 = shadow.peekWatch("ETHUSDT", "LONG");
  assert.deepStrictEqual(peek1, peek2);
  assert.deepStrictEqual(peek2, peek3);
  assert.strictEqual(shadow.activeWatchCount, 1, "peekWatch must never remove or terminate the watch");
});

scenario("peekWatch() reports WAITING_W1_RECOVERY while Wave 1 is active, then WAITING_W2_START once Wave 1 completes with no Wave 2 yet", () => {
  const shadow = new UnitResearchShadowService(() => 1000);
  shadow.startEpisode("ETHUSDT", "LONG", "sig-1", 1, 2000, 1000, 5000, 1000);
  let peek = shadow.peekWatch("ETHUSDT", "LONG");
  assert.strictEqual(peek?.phase, "WAITING_W1_RECOVERY");
  shadow.onTick("ETHUSDT", "LONG", 1990, 1500); // extreme deepens
  shadow.onTick("ETHUSDT", "LONG", 1991, 2000); // +1 UNIT recovery -> Wave 1 completes
  peek = shadow.peekWatch("ETHUSDT", "LONG");
  assert.strictEqual(peek?.phase, "WAITING_W2_START");
});

scenario("peekWatch() returns null once the episode reaches a terminal state -- no stale phase lingers after resolution", () => {
  const shadow = new UnitResearchShadowService(() => 1000);
  shadow.startEpisode("ETHUSDT", "LONG", "sig-1", 1, 2000, 1000, 5000, 1000);
  shadow.onTick("ETHUSDT", "LONG", 1990, 1500);
  shadow.onTick("ETHUSDT", "LONG", 1991, 2000); // Wave 1 complete, extreme=1990
  shadow.onTick("ETHUSDT", "LONG", 1993, 2500); // 2x UNIT recovery (1990+2=1992, price=1993 crosses it), no Wave 2 -> CANCEL
  assert.strictEqual(shadow.peekWatch("ETHUSDT", "LONG"), null);
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
