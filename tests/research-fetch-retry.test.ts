import * as assert from "assert";
import {
  fetchKlinesWithRetry,
  getFetchStats,
  resetFetchStats,
} from "../src/domain/research/research-fetch-retry";

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

function mkKline(openTime: number): unknown[] {
  return [
    openTime,
    "100",
    "101",
    "99",
    "100.5",
    "10",
    openTime + 59999,
    "1000",
    5,
    "5",
    "500",
    "0",
  ];
}

async function main(): Promise<void> {
  console.log("Running research-fetch-retry tests...\n");
  const originalFetch = globalThis.fetch;

  await scenario(
    "1. a 429 response is retried and eventually succeeds",
    async () => {
      resetFetchStats();
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        if (callCount === 1) return new Response(null, { status: 429 });
        return new Response(JSON.stringify([mkKline(0)]), { status: 200 });
      }) as typeof fetch;
      try {
        const candles = await fetchKlinesWithRetry(
          "BTCUSDT",
          60_000,
          0,
          120_000,
        );
        assert.ok(
          candles.length >= 1,
          "must eventually return candles after the retry succeeds",
        );
        const stats = getFetchStats();
        assert.ok(stats.totalRetries >= 1, "must record at least one retry");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await scenario("2. a 418 (IP ban) is retried the same as a 429", async () => {
    resetFetchStats();
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return new Response(null, { status: 418 });
      return new Response(JSON.stringify([mkKline(0)]), { status: 200 });
    }) as typeof fetch;
    try {
      const candles = await fetchKlinesWithRetry("BTCUSDT", 60_000, 0, 120_000);
      assert.ok(candles.length >= 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await scenario(
    "3. a non-rate-limit error (e.g. 500) is NOT retried -- propagates immediately",
    async () => {
      resetFetchStats();
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        return new Response(null, { status: 500 });
      }) as typeof fetch;
      try {
        await assert.rejects(() =>
          fetchKlinesWithRetry("BTCUSDT", 60_000, 0, 120_000),
        );
        assert.strictEqual(
          callCount,
          1,
          "a genuine server error must not trigger the rate-limit retry loop",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await scenario(
    "4. request-attempt counter increments correctly across retries",
    async () => {
      resetFetchStats();
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        if (callCount <= 2) return new Response(null, { status: 429 });
        return new Response(JSON.stringify([mkKline(0)]), { status: 200 });
      }) as typeof fetch;
      try {
        await fetchKlinesWithRetry("BTCUSDT", 60_000, 0, 120_000);
        const stats = getFetchStats();
        assert.strictEqual(
          stats.totalRequestAttempts,
          3,
          "3 total attempts: 2 failed + 1 success",
        );
        assert.strictEqual(stats.totalRetries, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
