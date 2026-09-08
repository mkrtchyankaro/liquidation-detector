/**
 * Sep 8 2026, operator-approved (Karo). Generic, reusable in-flight
 * guard -- porting V3's own PROVEN, confirmed-incident-fix pattern
 * (simple-liquidation.service.ts's own closeActiveInFlight, Aug 26
 * 2026) as small, SHARED infrastructure, rather than re-implementing
 * an ad-hoc Set inline in app.ts.
 *
 * The exact incident this class exists to prevent (V3's own, already
 * confirmed live, and structurally identical to a gap found in V5's
 * own reconciliation path during the Sep 8 2026 preservation audit):
 * a fire-and-forget async operation (`void doSomething(...)`) with NO
 * synchronous guard -- if the SAME operation is triggered again (e.g.
 * the next price tick) BEFORE the first, still-in-flight call has
 * finished, BOTH calls proceed through the ENTIRE downstream chain
 * (a slow network call, a Mongo write, a Telegram send, a claim
 * release) a second time, for the identical underlying event.
 *
 * Usage pattern (matches V3's own checked+set-before-any-await,
 * cleared-in-finally shape exactly):
 *
 *   const guard = new InFlightGuard();
 *   await guard.run(signalId, async () => { ...the real work... });
 *
 * run() returns undefined (a safe no-op) if `key` is already in
 * flight -- the caller's own real work function is never invoked a
 * second time until the first call has fully finished (success OR
 * throw). Keyed by whatever uniquely identifies the ONE thing that
 * must never run twice concurrently (V3 uses signalId for close-
 * dedup; V5's own port below does the same).
 */
export class InFlightGuard {
  private readonly inFlight = new Set<string>();

  /** True and marks `key` as in-flight if it was NOT already in
   *  flight; false (and does NOT mark) if it already was. This is the
   *  exact synchronous check+set V3's own pattern relies on -- no
   *  await happens between the check and the set, so there is no
   *  window for a second, concurrent caller to slip through. */
  tryEnter(key: string): boolean {
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  release(key: string): void {
    this.inFlight.delete(key);
  }

  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Runs `fn` only if `key` is not already in flight. A concurrent
   *  call with the SAME key, arriving before this one finishes,
   *  returns undefined immediately WITHOUT running `fn` again --
   *  exactly the protection V3's own closeActiveInFlight provides.
   *  `key` is always released in a finally block, so a thrown
   *  exception never permanently locks it out. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (!this.tryEnter(key)) return undefined;
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }
}
