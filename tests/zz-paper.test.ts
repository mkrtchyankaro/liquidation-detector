/**
 * ZZ PAPER live service: same decisions as the research code, idempotent,
 * PAPER only, closes on TP/SL, config can never arm real orders.
 * Usage: npx tsx tests/zz-paper.test.ts
 */
import * as assert from "assert";
import { buildChains, buildWaves, DEFAULT_CHAIN_PARAMS, trailingOiNoise, type ZBar } from "../src/research/oi-zigzag";
import { ZzPaperService, checkExit, type ZzTradeDoc } from "../src/strategy/zz/zz-paper.service";
import { parseZzSettings } from "../src/strategy/zz/zz-config";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const M = 60_000, T0 = Date.UTC(2026, 8, 23, 6, 0);

// 6h calm (tiny wiggles) -> fast LONG cleaning (OI -2%, price -2%, big liquidations)
// -> accumulation (OI +1.5%) -> resolution (OI falls, price falls 3%)
function price(m: number): number {
  if (m < 360) return 100 + (m % 3) * 0.02;
  if (m < 372) return 100 - (2 * (m - 360)) / 12;
  if (m < 412) return 98 + (0.6 * (m - 372)) / 40;
  return Math.max(95.5, 98.6 - 0.05 * (m - 412));
}
function oi(m: number): number {
  if (m < 360) return 100_000 + (m % 4) * 15;
  if (m < 372) return 100_000 - (2000 * (m - 360)) / 12;
  if (m < 412) return 98_000 + (1500 * (m - 372)) / 40;
  return 99_500 - 60 * (m - 412);
}
const ALL: ZBar[] = Array.from({ length: 600 }, (_, m) => ({ ts: T0 + m * M, close: price(m), high: price(m) + 0.01, low: price(m) - 0.01, oi: oi(m), longLiq: m >= 361 && m <= 371 ? 20_000 : 0, shortLiq: 0 }));

function research(bars: ZBar[], maxDelay = 40) {
  const noise = trailingOiNoise(bars);
  return buildChains(buildWaves(bars, noise.map((n) => 4 * n)), bars, { ...DEFAULT_CHAIN_PARAMS, noise15Pct: noise, maxConfirmDelayMin: maxDelay, tpShare: 0.8 });
}

function fakeDb() {
  const docs: ZzTradeDoc[] = [];
  const match = (d: ZzTradeDoc, q: Record<string, unknown>) => Object.entries(q).every(([k, v]) => (d as unknown as Record<string, unknown>)[k] === v);
  const col = {
    createIndex: async () => "",
    find: (q: Record<string, unknown>) => ({ toArray: async () => docs.filter((d) => match(d, q)).map((d) => ({ ...d })) }),
    countDocuments: async (q: Record<string, unknown>) => docs.filter((d) => match(d, q)).length,
    updateOne: async (q: Record<string, unknown>, u: { $setOnInsert?: ZzTradeDoc; $set?: Partial<ZzTradeDoc> }, o?: { upsert?: boolean }) => {
      const d = docs.find((x) => match(x, q));
      if (d && u.$set) Object.assign(d, u.$set);
      if (!d && o?.upsert && u.$setOnInsert) { docs.push({ ...u.$setOnInsert }); return { upsertedCount: 1 }; }
      return { upsertedCount: 0 };
    },
  };
  return { docs, getDb: async () => ({ collection: () => col }) as never };
}

async function run(): Promise<void> {
  console.log("ZZ PAPER");
  const chain = research(ALL).find((c) => c.trade && !c.trade.skipReason && c.quality.grade !== "C");

  await scenario("the synthetic episode is an A/B trade in the research code (test precondition)", () => {
    assert.ok(chain, JSON.stringify(research(ALL).map((c) => [c.quality, c.trade?.skipReason])));
  });

  await scenario("live service opens the SAME trade as research, in the minute it is decided, and messages the user", async () => {
    const t = chain!.trade!;
    const upto = ALL.filter((b) => b.ts <= t.decidedTs); // live: data only up to the decision minute
    const f = fakeDb(), sent: string[] = [];
    const svc = new ZzPaperService({ enabled: true, users: ["main"], symbols: ["XUSDT"], maxDelayMin: 40, tpShare: 0.8 },
      () => [{ userId: "main", riskUsd: 10, telegram: { sendMessage: async (m: string) => { sent.push(m); } } }],
      async () => upto, f.getDb, () => t.decidedTs + M + 40_000);
    await svc.onMinute();
    assert.strictEqual(f.docs.length, 1);
    const d = f.docs[0];
    assert.strictEqual(d.state, "OPEN");
    assert.deepStrictEqual([d.entry, d.slPrice, d.tpPrice, d.side], [t.entry, t.slPrice, t.tpPrice, t.side]);
    assert.ok(sent[0].includes("ZZ XUSDT") && sent[0].includes("PAPER"));
    // same minute again (restart / double tick): nothing new
    await svc.onMinute();
    assert.strictEqual(f.docs.length, 1);
    assert.strictEqual(sent.length, 1);
  });

  await scenario("old decisions are never replayed (e.g. after a restart hours later)", async () => {
    const f = fakeDb(), sent: string[] = [];
    const svc = new ZzPaperService({ enabled: true, users: ["main"], symbols: ["XUSDT"], maxDelayMin: 40, tpShare: 0.8 },
      () => [{ userId: "main", riskUsd: 10, telegram: { sendMessage: async (m: string) => { sent.push(m); } } }],
      async () => ALL, f.getDb, () => ALL[ALL.length - 1].ts + M + 40_000);
    await svc.onMinute();
    assert.strictEqual(f.docs.filter((d) => d.state === "OPEN").length, 0);
  });

  await scenario("open trade closes on TP with net R after fees and a close message", async () => {
    const t = chain!.trade!;
    const f = fakeDb(), sent: string[] = [];
    let bars = ALL.filter((b) => b.ts <= t.decidedTs);
    let now = t.decidedTs + M + 40_000;
    const svc = new ZzPaperService({ enabled: true, users: ["main"], symbols: ["XUSDT"], maxDelayMin: 40, tpShare: 0.8 },
      () => [{ userId: "main", riskUsd: 10, telegram: { sendMessage: async (m: string) => { sent.push(m); } } }],
      async () => bars, f.getDb, () => now);
    await svc.onMinute();
    bars = ALL; now = ALL[ALL.length - 1].ts + M + 40_000;
    await svc.onMinute();
    const d = f.docs[0];
    assert.strictEqual(d.state, "CLOSED");
    assert.strictEqual(d.result, t.result);
    assert.ok(Math.abs(d.netR! - t.netR!) < 1e-9, "same net R as the research simulation");
    assert.ok(sent.some((m) => m.includes(d.result === "TP" ? "TAKE PROFIT" : "STOP LOSS")));
  });

  await scenario("checkExit: SL wins a same-minute tie", () => {
    const doc = { side: "SHORT", entry: 100, slPrice: 101, tpPrice: 97.8, decidedTs: T0 } as ZzTradeDoc;
    const r = checkExit(doc, [{ ts: T0 + M, high: 101.5, low: 97, close: 99, oi: 1, longLiq: 0, shortLiq: 0 }]);
    assert.strictEqual(r!.result, "SL");
  });

  await scenario("config: absent = off; unknown user fails; there is no REAL switch at all", () => {
    assert.strictEqual(parseZzSettings(undefined, ["main"], ["BTCUSDT"]).enabled, false);
    assert.throws(() => parseZzSettings({ enabled: true, users: ["bob"] }, ["main"], ["BTCUSDT"]));
    const s = parseZzSettings({ enabled: true, users: ["main"], mode: "REAL" }, ["main"], ["BTCUSDT"]);
    assert.ok(!("mode" in s) && s.users[0] === "main" && s.symbols[0] === "BTCUSDT");
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
