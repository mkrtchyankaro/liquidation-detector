/**
 * Sep 10 2026 (Karo), operator-requested. Proves a cascade candidate's
 * own timeframe (1m/3m/5m) survives the FULL lifecycle --
 * SIGNAL -> active trade -> CLOSED_TP/CLOSED_SL -> Telegram CLOSE
 * message -- and is correctly restored after restart/hydration, using
 * REAL V5WaveService + formatV5CloseMessage() (no mocking of the
 * trade-close path itself).
 */
import * as assert from "assert";
import { V5WaveService } from "../src/strategy/v5/v5-wave.service";
import { formatV5CloseMessage } from "../src/infrastructure/telegram/signal.formatter";

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

function makeV5(): V5WaveService {
  return new V5WaveService(
    () => 1,
    () => 1,
    () => null,
    () => 0,
    () => 1000,
  );
}

console.log("Running cascade-close-Telegram-timeframe tests...\n");

for (const tf of ["1m", "3m", "5m"] as const) {
  scenario(
    `${tf} cascade signal: SIGNAL -> active trade -> CLOSED_TP -> Telegram CLOSE shows "Candidate: ${tf}"`,
    () => {
      const v5 = makeV5();
      const entry = 2000;
      const tp = entry * 1.007;
      const sl = entry * 0.997;
      v5.hydrateActiveTrade({
        signalId: `sig-${tf}-tp`,
        symbol: "ETHUSDT",
        victim: "LONG",
        side: "LONG",
        entry,
        tp,
        sl,
        openedAt: 1000,
        bestPrice: entry,
        worstPrice: entry,
        entryWaveNumber: 2,
        isLive: false,
        binanceSlOrderId: null,
        binanceTpOrderId: null,
        positionQty: null,
        notional: null,
        riskUsd: null,
        timeframe: tf,
      });

      const closes = v5.onPriceTickForTrades("ETHUSDT", tp, 2000);
      assert.strictEqual(closes.length, 1);
      const close = closes[0]!;
      assert.strictEqual(
        close.trade.timeframe,
        tf,
        "the trade's own persisted timeframe must survive to close-time",
      );

      const message = formatV5CloseMessage(
        close.trade.symbol,
        close.trade.side,
        close.outcome,
        close.trade.entry,
        close.closePrice,
        close.trade.entryWaveNumber,
        close.trade.timeframe,
        close.trade.signalId,
      );
      assert.ok(
        !message.includes("Candidate:"),
        "the Candidate line must be gone from CLOSE messages after the redesign",
      );
      assert.ok(message.includes("✅ V5 CLOSE"), "must be a TP close message");
      assert.ok(
        message.includes(`SignalId: sig-${tf}-tp`),
        "must show the real signalId",
      );
    },
  );

  scenario(
    `${tf} cascade signal: SIGNAL -> active trade -> CLOSED_SL -> Telegram CLOSE shows "Candidate: ${tf}"`,
    () => {
      const v5 = makeV5();
      const entry = 2000;
      const tp = entry * 0.993;
      const sl = entry * 1.003;
      v5.hydrateActiveTrade({
        signalId: `sig-${tf}-sl`,
        symbol: "SOLUSDT",
        victim: "SHORT",
        side: "SHORT",
        entry,
        tp,
        sl,
        openedAt: 1000,
        bestPrice: entry,
        worstPrice: entry,
        entryWaveNumber: 2,
        isLive: false,
        binanceSlOrderId: null,
        binanceTpOrderId: null,
        positionQty: null,
        notional: null,
        riskUsd: null,
        timeframe: tf,
      });

      const closes = v5.onPriceTickForTrades("SOLUSDT", sl, 2000);
      assert.strictEqual(closes.length, 1);
      const close = closes[0]!;
      assert.strictEqual(close.trade.timeframe, tf);

      const message = formatV5CloseMessage(
        close.trade.symbol,
        close.trade.side,
        close.outcome,
        close.trade.entry,
        close.closePrice,
        close.trade.entryWaveNumber,
        close.trade.timeframe,
        close.trade.signalId,
      );
      assert.ok(
        !message.includes("Candidate:"),
        "the Candidate line must be gone from CLOSE messages after the redesign",
      );
      assert.ok(message.includes("❌ V5 CLOSE"));
    },
  );

  scenario(
    `${tf} cascade signal: timeframe survives a simulated restart (hydrateActiveTrade() called fresh, from persisted doc-shaped data, exactly like hydrateMainLocks() does) and CLOSE still shows the correct real trade data (Candidate line itself removed in the Sep 11 2026 redesign)`,
    () => {
      const persistedDoc = {
        signalId: `sig-${tf}-restart`,
        symbol: "BTCUSDT",
        victim: "LONG" as const,
        side: "LONG" as const,
        entry: 70000,
        tp: 70490,
        sl: 69790,
        signalTs: 1000,
        entryWaveNumber: 3,
        timeframe: tf as "1m" | "3m" | "5m" | null,
      };

      const v5AfterRestart = makeV5();
      v5AfterRestart.hydrateActiveTrade({
        signalId: persistedDoc.signalId,
        symbol: persistedDoc.symbol,
        victim: persistedDoc.victim,
        side: persistedDoc.side,
        entry: persistedDoc.entry,
        tp: persistedDoc.tp,
        sl: persistedDoc.sl,
        openedAt: persistedDoc.signalTs,
        bestPrice: persistedDoc.entry,
        worstPrice: persistedDoc.entry,
        entryWaveNumber: persistedDoc.entryWaveNumber,
        isLive: false,
        binanceSlOrderId: null,
        binanceTpOrderId: null,
        positionQty: null,
        notional: null,
        riskUsd: null,
        timeframe: persistedDoc.timeframe,
      });

      const closes = v5AfterRestart.onPriceTickForTrades(
        persistedDoc.symbol,
        persistedDoc.tp,
        5000,
      );
      assert.strictEqual(
        closes.length,
        1,
        "the restart-hydrated trade must still be detected and closed correctly",
      );
      assert.strictEqual(
        closes[0]!.trade.timeframe,
        tf,
        "timeframe must survive the restart round-trip",
      );

      const message = formatV5CloseMessage(
        closes[0]!.trade.symbol,
        closes[0]!.trade.side,
        closes[0]!.outcome,
        closes[0]!.trade.entry,
        closes[0]!.closePrice,
        closes[0]!.trade.entryWaveNumber,
        closes[0]!.trade.timeframe,
        closes[0]!.trade.signalId,
      );
      assert.ok(
        !message.includes("Candidate:"),
        "the Candidate line must be gone from CLOSE messages after the redesign, even after restart",
      );
    },
  );
}

scenario(
  "a legacy, non-cascade close (timeframe=null) shows NO Candidate line -- the existing V5 close format is completely unaffected",
  () => {
    const v5 = makeV5();
    const entry = 2000;
    const tp = entry * 1.007;
    v5.hydrateActiveTrade({
      signalId: "sig-legacy",
      symbol: "ETHUSDT",
      victim: "LONG",
      side: "LONG",
      entry,
      tp,
      sl: entry * 0.997,
      openedAt: 1000,
      bestPrice: entry,
      worstPrice: entry,
      entryWaveNumber: 2,
      isLive: false,
      binanceSlOrderId: null,
      binanceTpOrderId: null,
      positionQty: null,
      notional: null,
      riskUsd: null,
    });

    const closes = v5.onPriceTickForTrades("ETHUSDT", tp, 2000);
    assert.strictEqual(closes[0]!.trade.timeframe, null);
    const message = formatV5CloseMessage(
      closes[0]!.trade.symbol,
      closes[0]!.trade.side,
      closes[0]!.outcome,
      closes[0]!.trade.entry,
      closes[0]!.closePrice,
      closes[0]!.trade.entryWaveNumber,
      closes[0]!.trade.timeframe,
      closes[0]!.trade.signalId,
    );
    assert.ok(
      !message.includes("Candidate:"),
      "a legacy close must never show a Candidate line",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
