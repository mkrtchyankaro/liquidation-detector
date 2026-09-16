import * as assert from "assert";
import { OiTrackerService } from "../src/domain/liquidation/oi-tracker.service";

let passed = 0;
let failed = 0;
async function scenario(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function mockOiResponse(openInterest: string, timeMs: number): Response {
  return new Response(
    JSON.stringify({ openInterest, symbol: "BTCUSDT", time: timeMs }),
    { status: 200 },
  );
}

async function main(): Promise<void> {
  console.log("Running oi-tracker persistence-hook tests...\n");
  const originalFetch = globalThis.fetch;

  await scenario(
    "1. an existing OI observation is persisted correctly",
    async () => {
      globalThis.fetch = (async () =>
        mockOiResponse("1234.5", 1_700_000_000_000)) as typeof fetch;
      const observed: any[] = [];
      const svc = new OiTrackerService(["BTCUSDT"], (obs) =>
        observed.push(obs),
      );
      await new Promise((r) => setTimeout(r, 50));
      svc.stop();
      globalThis.fetch = originalFetch;
      assert.strictEqual(observed.length, 1);
      assert.strictEqual(observed[0].symbol, "BTCUSDT");
      assert.strictEqual(observed[0].contracts, 1234.5);
      assert.strictEqual(observed[0].oiUpdatedAtMs, 1_700_000_000_000);
    },
  );

  await scenario("2. no additional Binance request is introduced", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return mockOiResponse("100", 1);
    }) as typeof fetch;
    const svcWithHook = new OiTrackerService(["BTCUSDT", "ETHUSDT"], () => {});
    await new Promise((r) => setTimeout(r, 50));
    svcWithHook.stop();
    const withHookCalls = callCount;

    callCount = 0;
    const svcWithoutHook = new OiTrackerService(["BTCUSDT", "ETHUSDT"]);
    await new Promise((r) => setTimeout(r, 50));
    svcWithoutHook.stop();
    globalThis.fetch = originalFetch;
    assert.strictEqual(
      withHookCalls,
      2,
      "exactly one fetch per symbol per cycle, hook present",
    );
    assert.strictEqual(
      callCount,
      2,
      "identical count without the hook, proving it adds zero requests",
    );
  });

  await scenario(
    "3/8. a throwing onObservation hook does not break OI polling",
    async () => {
      globalThis.fetch = (async () => mockOiResponse("500", 1)) as typeof fetch;
      const svc = new OiTrackerService(["BTCUSDT"], () => {
        throw new Error("simulated persistence failure");
      });
      await new Promise((r) => setTimeout(r, 50));
      svc.stop();
      globalThis.fetch = originalFetch;
      const cached = svc.getCachedOI("BTCUSDT");
      assert.ok(
        cached !== null,
        "the OI cache must still be populated even though the persistence hook threw",
      );
      assert.strictEqual(cached!.contracts, 500);
    },
  );

  await scenario("4. timestamps are preserved", async () => {
    globalThis.fetch = (async () =>
      mockOiResponse("777", 1_650_000_000_000)) as typeof fetch;
    const observed: any[] = [];
    const before = Date.now();
    const svc = new OiTrackerService(["BTCUSDT"], (obs) => observed.push(obs));
    await new Promise((r) => setTimeout(r, 50));
    const after = Date.now();
    svc.stop();
    globalThis.fetch = originalFetch;
    assert.strictEqual(
      observed[0].oiUpdatedAtMs,
      1_650_000_000_000,
      "Binance's own response time must be preserved exactly",
    );
    assert.ok(
      observed[0].fetchedAt >= before && observed[0].fetchedAt <= after,
      "local fetchedAt must be a real capture-time timestamp",
    );
  });

  await scenario(
    "5. all tracked symbols are stored independently",
    async () => {
      globalThis.fetch = (async (url: any) => {
        const symbol = new URL(String(url)).searchParams.get("symbol");
        return mockOiResponse(
          symbol === "BTCUSDT" ? "100" : symbol === "ETHUSDT" ? "200" : "300",
          1,
        );
      }) as typeof fetch;
      const observed: any[] = [];
      const svc = new OiTrackerService(
        ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        (obs) => observed.push(obs),
      );
      await new Promise((r) => setTimeout(r, 50));
      svc.stop();
      globalThis.fetch = originalFetch;
      assert.strictEqual(observed.length, 3);
      const bySymbol = Object.fromEntries(
        observed.map((o) => [o.symbol, o.contracts]),
      );
      assert.deepStrictEqual(bySymbol, {
        BTCUSDT: 100,
        ETHUSDT: 200,
        SOLUSDT: 300,
      });
    },
  );

  await scenario(
    "7. a zero causal price is preserved, never coerced to null",
    async () => {
      globalThis.fetch = (async () => mockOiResponse("100", 1)) as typeof fetch;
      const observed: any[] = [];
      const svc = new OiTrackerService(
        ["BTCUSDT"],
        (obs) => observed.push(obs),
        () => 0,
      );
      await new Promise((r) => setTimeout(r, 50));
      svc.stop();
      globalThis.fetch = originalFetch;
      assert.strictEqual(
        observed[0].price,
        0,
        "a causal price of exactly 0 must be preserved as 0, not silently become null",
      );
    },
  );

  await scenario(
    "6. index setup does not crash when Mongo is unavailable",
    async () => {
      const { OiSecondObservationRepository } =
        await import("../src/infrastructure/mongo/oi-second-observation.repository");
      const fakeMongo = { oiSecondObservations: async () => null } as any;
      const repo = new OiSecondObservationRepository(fakeMongo);
      const result1 = await repo.ensureIndexes();
      const result2 = await repo.ensureIndexes();
      repo.stop();
      assert.strictEqual(
        result1,
        false,
        "must return false, not throw, when Mongo is unavailable",
      );
      assert.strictEqual(result2, false);
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
