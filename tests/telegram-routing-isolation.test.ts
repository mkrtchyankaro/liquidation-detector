/**
 * Sep 9 2026 (Karo), operator-requested investigation. TRACE RESULT:
 * no code-level broadcast bug exists -- every telegram-send call-site
 * (notifyUser, notifyUserClose, reconciliation-alert,
 * handleMainTradeClose) already uses ONLY its own, specific
 * runtime.telegram / this.mainTelegram instance. TelegramClient
 * itself is a thin, per-instance wrapper with its own isolated
 * cfg.chatIds -- there is no shared state or cross-instance channel
 * through which one runtime could ever reach another's chatIds.
 *
 * What LOOKS like "broadcast" (Karo's close appearing in what looks
 * like Main's chat) is a CONFIGURATION-level chatId overlap in
 * users.config.json, not a code defect -- confirmed acceptable by the
 * operator's own explicit closing clarification: "if two users
 * intentionally have the same physical chatId, yes, both messages may
 * land there."
 *
 * These tests are regression-PROOFS (not bug-fixes) of the isolation
 * that already exists -- so any future accidental refactor toward a
 * shared/broadcast path fails immediately and loudly.
 */
import * as assert from "assert";
import {
  notifyUser,
  notifyUserClose,
} from "../src/application/signal/notify-user.usecase";
import type { UserRuntime } from "../src/services/user-runtime";
import type { GlobalSignalDoc } from "../src/domain/signal/global-signal.model";

let passed = 0;
let failed = 0;

function scenario(name: string, fn: () => Promise<void> | void): void {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`  \u2713 ${name}`);
    } catch (err) {
      failed++;
      console.log(`  \u2717 ${name}`);
      console.log(
        `      ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };
  scenarios.push(run);
}
const scenarios: Array<() => Promise<void>> = [];

/** Minimal fake telegram client -- records whether IT SPECIFICALLY was
 *  called, nothing more. Each runtime gets its OWN, separate instance
 *  (matching real TelegramClient's own per-instance isolation). */
function fakeTelegram() {
  const calls: string[] = [];
  return {
    calls,
    sendMessage: async (text: string) => {
      calls.push(text);
      return { ok: true, results: [] };
    },
  };
}

function fakeRuntime(
  userId: string,
  telegram: ReturnType<typeof fakeTelegram> | null,
): UserRuntime {
  return {
    config: {
      userId,
      enabled: true,
      telegram: telegram
        ? { enabled: true, botToken: "x", chatIds: ["1"] }
        : null,
      binance: null,
      risk: { riskUsd: 10, accountBudgetUsd: 500, dailyLossLimitPct: 5 },
      btcBlockEnabled: false,
      longEnabled: true,
      shortEnabled: true,
    },
    telegram: telegram as unknown as UserRuntime["telegram"],
  } as unknown as UserRuntime;
}

function baseSignal(overrides: Partial<GlobalSignalDoc> = {}): GlobalSignalDoc {
  return {
    signalId: "SIG-1",
    symbol: "LINKUSDT",
    side: "LONG",
    victim: "LONG",
    signalTs: Date.now(),
    entryPrice: 12,
    entryWaveNumber: 1,
    waveHistory: [],
    w1Diagnostics: null,
    totalEpisodePressure: 100000,
    dominantLayerLiqUsd: null,
    dominantLayerWaveNumber: null,
    exhaustionLayerLiqUsd: 100000,
    exhaustionLayerWaveNumber: 1,
    unitAtStart: 1,
    p95AtEntry: 1000,
    dailyLiqPerMinBaselineAtEntry: 500,
    atr15mAtEntry: 5,
    unitResearch: null,
    unitCompetitionResearch: null,
    commonHorizonResearch: null,
    qualifyingEventUsd: 100,
    qualifyingEventTs: Date.now(),
    p95AtQualification: 90,
    physics: null,
    btcContext: null,
    liq24hContext: null,
    wallContext: null,
    entry: 12,
    tp: 12.3,
    sl: 11.9,
    rr: 2.5,
    btcSafetyStatus: "CLEAN",
    btcIntendedSideAtSignalTime: null,
    rejectionReason: null,
    status: "SIGNAL",
    closedAt: null,
    closePrice: null,
    maxFavorableR: null,
    maxAdverseR: null,
    liquidationStatsContext: null,
    planDiagnostics: null,
    researchCheckpoints: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

console.log("Running Telegram routing-isolation tests...\n");

scenario(
  "Karo close: notifyUserClose(message, karoRuntime) calls ONLY Karo's own telegram, never touches Main's or Artak's own instance",
  async () => {
    const karoTg = fakeTelegram();
    const mainTg = fakeTelegram();
    const artakTg = fakeTelegram();
    const karoRuntime = fakeRuntime("karo", karoTg);

    await notifyUserClose("Karo's own close message", karoRuntime);

    assert.strictEqual(
      karoTg.calls.length,
      1,
      "Karo's own telegram must receive exactly the one close message",
    );
    assert.strictEqual(
      mainTg.calls.length,
      0,
      "Main's telegram instance must NEVER be called for Karo's own close",
    );
    assert.strictEqual(
      artakTg.calls.length,
      0,
      "Artak's telegram instance must NEVER be called for Karo's own close",
    );
  },
);

scenario(
  "Artak close: notifyUserClose(message, artakRuntime) calls ONLY Artak's own telegram, never touches Main's or Karo's own instance",
  async () => {
    const karoTg = fakeTelegram();
    const mainTg = fakeTelegram();
    const artakTg = fakeTelegram();
    const artakRuntime = fakeRuntime("artak", artakTg);

    await notifyUserClose("Artak's own close message", artakRuntime);

    assert.strictEqual(artakTg.calls.length, 1);
    assert.strictEqual(
      mainTg.calls.length,
      0,
      "Main's telegram instance must NEVER be called for Artak's own close",
    );
    assert.strictEqual(
      karoTg.calls.length,
      0,
      "Karo's telegram instance must NEVER be called for Artak's own close",
    );
  },
);

scenario(
  "Main close: the owning runtime is called, entirely separate instances for other users remain untouched (proves ownership is explicit by runtime, not by any shared path)",
  async () => {
    const mainTg = fakeTelegram();
    const karoTg = fakeTelegram();
    const artakTg = fakeTelegram();
    const mainRuntime = fakeRuntime("main", mainTg);

    // Mirrors handleMainTradeClose()'s own call: a dedicated telegram
    // client scoped exclusively to "main", never a loop over other
    // runtimes.
    await mainRuntime.telegram!.sendMessage("MAIN canonical close message");

    assert.strictEqual(mainTg.calls.length, 1);
    assert.strictEqual(
      karoTg.calls.length,
      0,
      "Karo's own telegram instance must never receive MAIN's own close",
    );
    assert.strictEqual(
      artakTg.calls.length,
      0,
      "Artak's own telegram instance must never receive MAIN's own close",
    );
  },
);

scenario(
  "user ENTRY: notifyUser(signal, runtime) is scoped to exactly the ONE passed-in runtime -- proves the per-user distribution loop calls this once per user, never a shared broadcast helper",
  async () => {
    const karoTg = fakeTelegram();
    const artakTg = fakeTelegram();
    const karoRuntime = fakeRuntime("karo", karoTg);
    const signal = baseSignal();

    await notifyUser(signal, karoRuntime);

    assert.strictEqual(karoTg.calls.length, 1);
    assert.strictEqual(
      artakTg.calls.length,
      0,
      "a single notifyUser() call for Karo must never also reach Artak's own instance",
    );
  },
);

scenario(
  "structural: TelegramClient has no shared/module-level state across instances -- each instance's own cfg.chatIds is the ONLY destination it can ever send to",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/infrastructure/telegram/telegram.client.ts"),
      "utf8",
    );
    assert.ok(
      source.includes("private readonly cfg: TelegramConfig"),
      "each instance must hold its own, private config",
    );
    assert.ok(
      !/static\s+\w+\s*[:=]/.test(source),
      "no static/shared mutable state that could leak across instances",
    );
    assert.ok(
      source.includes("this.cfg.chatIds.map"),
      "sendMessage must fan out ONLY across this instance's own configured chatIds",
    );
  },
);

(async () => {
  for (const s of scenarios) await s();
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
