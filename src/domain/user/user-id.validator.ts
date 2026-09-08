/**
 * Sep 8 2026 (Karo). Every per-user Mongo collection name is built as
 * `<prefix>_${userId}` (see infrastructure/mongo/mongo.client.ts).
 * Operator's own explicit instruction: "Use a safe normalized userId
 * for collection names and validate it at configuration startup.
 * Never construct arbitrary Mongo collection names from unvalidated
 * external input."
 *
 * This is the ONE place that decides whether a userId is safe to
 * interpolate into a collection name. Called twice, deliberately:
 *   1. Once at config-load time (fail the WHOLE process at startup if
 *      any configured user has an invalid id -- never start with a
 *      bad one silently ignored).
 *   2. Again, defensively, inside every MongoClientWrapper per-user
 *      accessor -- never trusts that validation-at-load-time was
 *      actually performed by every caller.
 *
 * MongoDB collection names themselves allow a wide range of
 * characters, but this validator is intentionally FAR stricter than
 * what Mongo itself would accept -- the goal isn't "won't crash the
 * driver", it's "cannot be anything other than the exact, intended
 * identifier a human configured".
 */

const VALID_USER_ID_PATTERN = /^[a-z0-9_]{1,32}$/;

export function isValidUserId(userId: string): boolean {
  return VALID_USER_ID_PATTERN.test(userId);
}

export function assertValidUserId(userId: string): void {
  if (!isValidUserId(userId)) {
    throw new Error(
      `Invalid userId "${userId}" -- must match ${VALID_USER_ID_PATTERN} ` +
        `(lowercase letters, digits, underscore only, 1-32 chars). ` +
        `Refusing to use this in a Mongo collection name.`,
    );
  }
}

/** Convenience normalizer for config-loading: lowercases and trims,
 *  then validates. Does NOT silently strip/replace invalid characters
 *  -- if the result isn't valid after this light normalization, it
 *  throws (config-load time), rather than guessing what the operator
 *  meant. */
export function normalizeAndValidateUserId(rawUserId: string): string {
  const normalized = rawUserId.trim().toLowerCase();
  assertValidUserId(normalized);
  return normalized;
}
