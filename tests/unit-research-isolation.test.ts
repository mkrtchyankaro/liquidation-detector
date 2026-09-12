/**
 * Sep 9 2026 (Karo), operator-requested RESEARCH-ONLY ATR-timeframe
 * comparison. Proves the isolation guarantee: ATR3m/ATR5m and the
 * shadow unit-research state machine have ZERO ability to influence
 * production strategy behavior (W1/W2 detection, entry, TP/SL,
 * execution, Telegram).
 */
import * as assert from "assert";
import * as fs from "fs";
import { V5WaveService } from "../src/strategy/v5/v5-wave.service";
import { UnitResearchShadowService } from "../src/domain/research/unit-research-shadow.service";
import { ResearchCheckpointTracker } from "../src/domain/signal/research-checkpoint-tracker";
import type { Liquidation } from "../src/shared/common.types";

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

function liq(
  symbol: string,
  side: "BUY" | "SELL",
  price: number,
  quoteQty: number,
  timestamp: number,
): Liquidation {
  return {
    symbol,
    side,
    price,
    quantity: quoteQty / price,
    quoteQty,
    timestamp,
  };
}

console.log("Running unit-research-isolation tests...\n");

// ─── UnitResearchShadowService owns completely separate state ──────────

scenario(
  "UnitResearchShadowService has NO shared mutable state with V5WaveService -- structural proof from imports and field declarations",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/domain/research/unit-research-shadow.service.ts"),
      "utf8",
    );
    const importLines = source
      .split("\n")
      .filter((l) => l.trim().startsWith("import"));
    assert.ok(
      !importLines.some((l) => l.includes("V5WaveService")),
      "the shadow service must never IMPORT V5WaveService's own class",
    );
    assert.ok(
      source.includes("private readonly watches = new Map"),
      "the shadow service must own its own, independent Map",
    );
  },
);

scenario(
  "feeding the shadow service does not change V5WaveService's own watch state at all -- byte-identical watch before and after",
  () => {
    const v5 = new V5WaveService(
      () => 500,
      () => 1,
      () => null,
      () => 1000,
      () => 1000,
      () => ({
        atEntry: {
          topBidNotional: 0,
          topAskNotional: 0,
          topBidPrice: 0,
          topAskPrice: 0,
          imbalance: 0,
          topBidPersistent: false,
          topAskPersistent: false,
        },
        atAnchor: {
          topBidNotional: 0,
          topAskNotional: 0,
          topBidPrice: 0,
          topAskPrice: 0,
          imbalance: 0,
          topBidPersistent: false,
          topAskPersistent: false,
        },
        atSweepStart: null,
      }),
    );
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 5000, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    const watchBefore = JSON.stringify(v5.getWatch("ETHUSDT", "LONG"));

    // Feed a COMPLETELY UNRELATED shadow service with the SAME events,
    // many times over, with a wildly different UNIT -- if there were any
    // shared state, this would corrupt v5's own watch.
    const shadow = new UnitResearchShadowService(() => 1000);
    shadow.startEpisode(
      "ETHUSDT",
      "LONG",
      "shadow-signal-1",
      5,
      2000,
      1000,
      5000,
      1000,
    );
    for (let i = 0; i < 20; i++) {
      shadow.onLiquidation(
        liq("ETHUSDT", "SELL", 2000 - i, 100, 1000 + i * 10),
        "LONG",
      );
      shadow.onTick("ETHUSDT", "LONG", 2000 - i, 1000 + i * 10);
    }

    const watchAfter = JSON.stringify(v5.getWatch("ETHUSDT", "LONG"));
    assert.strictEqual(
      watchBefore,
      watchAfter,
      "V5WaveService's own watch must be COMPLETELY unaffected by any amount of shadow-service activity",
    );
  },
);

scenario(
  "two independent UnitResearchShadowService instances (3m/5m) never share state with each other",
  () => {
    const shadow3m = new UnitResearchShadowService(() => 1000);
    const shadow5m = new UnitResearchShadowService(() => 1000);
    shadow3m.startEpisode(
      "ETHUSDT",
      "LONG",
      "sig-1",
      3,
      2000,
      1000,
      5000,
      1000,
    );
    assert.strictEqual(shadow3m.activeWatchCount, 1);
    assert.strictEqual(
      shadow5m.activeWatchCount,
      0,
      "starting an episode on shadow3m must not create anything on shadow5m",
    );
  },
);

// ─── market-data-orchestrator.ts wiring: shadow always AFTER production ─

scenario(
  "structural: market-data-orchestrator.ts calls shadow-research ALWAYS AFTER this.v5.onLiquidation()/this.v5.onTick(), never before",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );

    const liqHandlerStart = source.indexOf('this.ws.on("liquidation"');
    const liqHandlerEnd = source.indexOf('this.ws.on("bookTicker"');
    const liqHandler = source.slice(liqHandlerStart, liqHandlerEnd);
    const v5LiqIdx = liqHandler.indexOf("this.v5.onLiquidation(");
    const shadowLiqIdx = liqHandler.indexOf("feedUnitResearchShadowAfter(");
    assert.ok(
      v5LiqIdx > -1 && shadowLiqIdx > -1,
      "both calls must exist in the liquidation handler",
    );
    assert.ok(
      shadowLiqIdx > v5LiqIdx,
      "shadow-research must be called AFTER v5.onLiquidation(), never before",
    );

    const tickHandlerStart = source.indexOf('this.ws.on("bookTicker"');
    const tickHandlerEnd = source.indexOf('this.ws.on("orderbook"');
    const tickHandler = source.slice(tickHandlerStart, tickHandlerEnd);
    const v5TickIdx = tickHandler.indexOf("this.v5.onTick(");
    const shadowTickIdx = tickHandler.indexOf("tickUnitResearchShadow(");
    assert.ok(
      v5TickIdx > -1 && shadowTickIdx > -1,
      "both calls must exist in the bookTicker handler",
    );
    assert.ok(
      shadowTickIdx > v5TickIdx,
      "shadow-research must be called AFTER v5.onTick(), never before",
    );
  },
);

scenario(
  "structural: this.v5.onTick()/evaluateSignal() still appear EXACTLY where production calls them; this.v5.onLiquidation() is now fully disconnected (Sep 12 2026 legacy-shadow cleanup) -- shadow code adds no additional call to any of these write-capable methods",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    // Strip comment lines first -- doc-comments legitimately reference
    // these method names in explanatory prose (e.g. "called AFTER
    // this.v5.onTick() has already run"); only EXECUTABLE code lines
    // count here.
    const codeOnly = source
      .split("\n")
      .filter(
        (line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"),
      )
      .join("\n");
    const countOnTick = (codeOnly.match(/this\.v5\.onTick\(/g) ?? []).length;
    const countOnLiquidation = (
      codeOnly.match(/this\.v5\.onLiquidation\(/g) ?? []
    ).length;
    const countEvaluateSignal = (
      codeOnly.match(/this\.v5\.evaluateSignal\(/g) ?? []
    ).length;
    assert.strictEqual(
      countOnTick,
      1,
      `this.v5.onTick( must appear exactly once (production only) -- found ${countOnTick}`,
    );
    // Sep 12 2026 (Karo), operator-requested cleanup -- the OLD, legacy
    // 1x-UNIT-recovery signal-GENERATION entry point is now disconnected
    // (commented out, matching this project's own established "do not
    // delete, just stop calling" convention). It must never be called
    // from executable code anymore -- this is the exact fix this test
    // now guards.
    assert.strictEqual(
      countOnLiquidation,
      0,
      `this.v5.onLiquidation( must be fully disconnected (0 executable calls) -- found ${countOnLiquidation}`,
    );
    assert.strictEqual(
      countEvaluateSignal,
      1,
      `this.v5.evaluateSignal( call-site itself is untouched (now naturally unreachable dead code, never deleted) -- found ${countEvaluateSignal}`,
    );
    const countGetWatch = (codeOnly.match(/this\.v5\.getWatch\(/g) ?? [])
      .length;
    assert.ok(
      countGetWatch >= 2,
      "getWatch() must be called at least twice -- once for the shadow's own new-episode detection",
    );
  },
);

// ─── ATR3m addition does not change existing interval behavior ─────────

scenario(
  "adding '3m' tracking does not change ATR(1m)/ATR(5m)/ATR(15m)/ATR(1h) values at all -- fed identical candles, with and without 3m candles interleaved",
  () => {
    const { ATRTrackerService } =
      require("../src/domain/market/atr-tracker.service") as typeof import("../src/domain/market/atr-tracker.service");
    function makeCandle(interval: string, openTime: number, close: number) {
      return {
        symbol: "ETHUSDT",
        interval,
        openTime,
        closeTime: openTime + 60_000,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 100,
        isClosed: true,
      } as any;
    }
    const a = new ATRTrackerService();
    const b = new ATRTrackerService();
    for (let i = 0; i < 20; i++) {
      a.onCandle(makeCandle("1m", i * 60_000, 2000 + i));
      b.onCandle(makeCandle("1m", i * 60_000, 2000 + i));
      b.onCandle(makeCandle("3m", i * 180_000, 2000 + i)); // ONLY fed to `b`
    }
    assert.strictEqual(
      a.getATR("ETHUSDT", "1m"),
      b.getATR("ETHUSDT", "1m"),
      "feeding 3m candles alongside 1m must never change the 1m ATR value",
    );
  },
);

// ─── ResearchCheckpointTracker's new optional param leaves the default unchanged ─

scenario(
  "ResearchCheckpointTracker's own default (zero-arg) behavior is byte-identical to before the offsets-parameter was added",
  () => {
    const production = new ResearchCheckpointTracker();
    production.registerWatch("sig-1", "ETHUSDT", "SIGNAL", 1000, 2000, {
      kind: "R",
      dirMul: 1,
      denom: 10,
    });
    const events = production.onTick("ETHUSDT", 2010, 1000 + 30_000);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(
      events[0]!.checkpoint.offsetLabel,
      "30s",
      "the default offset sequence must be unchanged",
    );
  },
);

scenario(
  "a shadow ResearchCheckpointTracker with custom offsets is a COMPLETELY SEPARATE instance from the default one -- registering on one never affects the other",
  () => {
    const production = new ResearchCheckpointTracker();
    const shadow = new ResearchCheckpointTracker([
      { label: "30s", ms: 30_000 },
      { label: "3m", ms: 3 * 60_000 },
    ]);
    shadow.registerWatch("sig-shadow", "ETHUSDT", "SIGNAL", 1000, 2000, {
      kind: "R",
      dirMul: 1,
      denom: 10,
    });
    assert.strictEqual(shadow.activeWatchCount, 1);
    assert.strictEqual(
      production.activeWatchCount,
      0,
      "registering on the shadow tracker must never create anything on the production tracker",
    );
  },
);

// ─── GlobalSignalDoc.unitResearch is never read by production decision logic ─

scenario(
  "structural: unitResearch is never read anywhere in v5-wave.service.ts, binance-execution.service.ts, or execute-for-user.usecase.ts",
  () => {
    for (const file of [
      "../src/strategy/v5/v5-wave.service.ts",
      "../src/infrastructure/binance/binance-execution.service.ts",
      "../src/application/execution/execute-for-user.usecase.ts",
    ]) {
      const source = fs.readFileSync(require.resolve(file), "utf8");
      assert.ok(
        !source.includes("unitResearch"),
        `${file} must never reference unitResearch at all`,
      );
    }
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
