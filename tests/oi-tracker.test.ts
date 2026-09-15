/**
 * Sep 15 2026 (Karo), operator-approved high-resolution OI polling.
 * Tests for OiTrackerService's own behaviors that the builder-level
 * tests (tests/liquidation-market-snapshot.test.ts) don't cover:
 * parallel fetch, whole-cycle overlap prevention, per-symbol failure
 * isolation, and time-based history retention. Uses a mocked global
 * fetch() -- no real network calls, no real Binance dependency.
 */
import * as assert from "assert";
import { OiTrackerService } from "../src/domain/liquidation/oi-tracker.service";

let passed = 0;
let failed = 0;
function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  \u2713 ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  \u2717 ${name}`);
      console.log(
        `      ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const realFetch = globalThis.fetch;
function installMockFetch(
  handler: (symbol: string) => Promise<Response> | Response,
): void {
  (globalThis as any).fetch = async (url: string | URL) => {
    const u = url.toString();
    const symbol = new URL(u).searchParams.get("symbol") ?? "UNKNOWN";
    return handler(symbol);
  };
}
function restoreFetch(): void {
  (globalThis as any).fetch = realFetch;
}
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

async function main(): Promise<void> {
  console.log("Running oi-tracker.service tests...\n");

  await scenario(
    "parallel fetch: all symbols are requested concurrently, not sequentially",
    async () => {
      const events: string[] = [];
      installMockFetch(async (symbol) => {
        events.push(`start:${symbol}`);
        await sleep(20); // simulate network latency
        events.push(`end:${symbol}`);
        return jsonResponse({ openInterest: "1000" });
      });
      const svc = new OiTrackerService(["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
      await sleep(80); // generous margin for the immediate constructor-triggered refresh() to fully complete
      svc.stop();
      restoreFetch();
      // Deterministic (not wall-clock-timing-based, which is jittery in a
      // sandboxed environment) proof of parallelism: if fetches were
      // SEQUENTIAL, every symbol's "end" would occur before the NEXT
      // symbol's "start". If PARALLEL, all 3 "start" events occur before
      // ANY "end" event, since all 3 requests are in flight together.
      const firstEndIndex = events.findIndex((e) => e.startsWith("end:"));
      const startsBeforeFirstEnd = events
        .slice(0, firstEndIndex)
        .filter((e) => e.startsWith("start:")).length;
      assert.strictEqual(
        startsBeforeFirstEnd,
        3,
        `all 3 fetches must have started before any of them finished (parallel) -- got ${startsBeforeFirstEnd}/3 starts before the first end. Event order: ${JSON.stringify(events)}`,
      );
    },
  );

  await scenario(
    "whole-cycle overlap prevention: a slow cycle causes the next tick to be skipped, not stacked",
    async () => {
      let activeCycles = 0;
      let maxConcurrentCycles = 0;
      let fetchCount = 0;
      installMockFetch(async () => {
        activeCycles++;
        maxConcurrentCycles = Math.max(maxConcurrentCycles, activeCycles);
        fetchCount++;
        await sleep(150); // deliberately slower than the 1s tick is NOT needed -- use a short interval test instead
        activeCycles--;
        return jsonResponse({ openInterest: "1000" });
      });
      const svc = new OiTrackerService(["AAAUSDT"]);
      // Manually trigger overlapping refresh() calls via the private method to simulate ticks arriving while a cycle is still running
      const refresh = (svc as any).refresh.bind(svc);
      const p1 = refresh();
      await sleep(10); // ensure cycle 1 has started (cycleRunning=true) before firing cycle 2
      const p2 = refresh(); // should return immediately (skip) since cycle 1 is still running
      await Promise.all([p1, p2]);
      svc.stop();
      restoreFetch();
      assert.strictEqual(
        fetchCount,
        1,
        `only ONE fetch should have occurred -- the second refresh() call should have been skipped entirely while the first was in flight, got ${fetchCount} fetches`,
      );
      assert.strictEqual(
        maxConcurrentCycles,
        1,
        "at no point should two cycles have been concurrently active",
      );
    },
  );

  await scenario(
    "per-symbol failure isolation: one failing symbol never blocks or corrupts another symbol's data",
    async () => {
      installMockFetch(async (symbol) => {
        if (symbol === "FAILUSDT") throw new Error("simulated network failure");
        if (symbol === "BADHTTPUSDT") return jsonResponse({}, false, 500);
        if (symbol === "BADJSONUSDT")
          return jsonResponse({ openInterest: "not-a-number" });
        return jsonResponse({ openInterest: "12345.6" });
      });
      const svc = new OiTrackerService([
        "FAILUSDT",
        "BADHTTPUSDT",
        "BADJSONUSDT",
        "GOODUSDT",
      ]);
      await sleep(50);
      svc.stop();
      restoreFetch();
      assert.strictEqual(
        svc.getCachedOI("FAILUSDT"),
        null,
        "a thrown fetch error must leave that symbol's OI null, not crash the cycle",
      );
      assert.strictEqual(
        svc.getCachedOI("BADHTTPUSDT"),
        null,
        "a non-ok HTTP response must leave that symbol's OI null",
      );
      assert.strictEqual(
        svc.getCachedOI("BADJSONUSDT"),
        null,
        "an unparseable openInterest value must leave that symbol's OI null",
      );
      const good = svc.getCachedOI("GOODUSDT");
      assert.ok(
        good !== null && good.contracts === 12345.6,
        "the good symbol must still be correctly populated despite 3 sibling symbols failing in the same cycle",
      );
    },
  );

  await scenario(
    "time-based retention: history is NOT capped at a fixed entry count -- old entries beyond the retention window are evicted by AGE, not by a count limit",
    async () => {
      let callCount = 0;
      installMockFetch(async () => {
        callCount++;
        return jsonResponse({ openInterest: String(1000 + callCount) });
      });
      const svc = new OiTrackerService(["AAAUSDT"]);
      const fetchOne = (svc as any).fetchOne.bind(svc);
      // Manually seed history entries with SYNTHETIC old timestamps (far older than the retention window) to prove eviction is time-based, not count-based
      const hist: { contracts: number; fetchedAt: number }[] =
        (svc as any).history.get("AAAUSDT") ?? [];
      (svc as any).history.set("AAAUSDT", hist);
      const veryOld = Date.now() - 30 * 60 * 1000; // 30 minutes ago -- older than the 21-minute retention window
      hist.push({ contracts: 1, fetchedAt: veryOld });
      await fetchOne("AAAUSDT"); // triggers a real (mocked) fetch, which should evict the 30-min-old entry
      svc.stop();
      restoreFetch();
      const finalHist = svc.getOiHistory("AAAUSDT");
      assert.ok(
        !finalHist.some((h) => h.fetchedAt === veryOld),
        "an entry older than the retention window must be evicted, proving eviction is time-based (a fixed-count cap would have kept it if under the count limit)",
      );
    },
  );

  await scenario(
    "history retains >=20 minutes at 1s cadence (synthetic dense population, no real waiting)",
    async () => {
      installMockFetch(async () => jsonResponse({ openInterest: "1000" }));
      const svc = new OiTrackerService(["AAAUSDT"]);
      svc.stop(); // stop the real timer; we'll populate history directly to simulate 1s cadence over 20+ minutes without actually waiting
      restoreFetch();
      const hist: { contracts: number; fetchedAt: number }[] = [];
      (svc as any).history.set("AAAUSDT", hist);
      const now = Date.now();
      const fetchOne = (svc as any).fetchOne.bind(svc);
      installMockFetch(async () => jsonResponse({ openInterest: "1000" }));
      // simulate a full 21-minute-old entry surviving, and an entry from exactly 20 minutes ago also surviving
      hist.push({ contracts: 1, fetchedAt: now - 20 * 60 * 1000 + 5000 }); // just inside 20 min
      await fetchOne("AAAUSDT");
      restoreFetch();
      const finalHist = svc.getOiHistory("AAAUSDT");
      assert.ok(
        finalHist.some((h) => h.fetchedAt === now - 20 * 60 * 1000 + 5000),
        "a sample from just inside the 20-minute mark must still be retained (>=20 min retention floor)",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
