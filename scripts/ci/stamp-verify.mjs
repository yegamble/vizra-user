/**
 * The OUT-OF-PROCESS half of the runtime proof-of-harness.
 *
 * `e2e/harness/stamp.ts` signs; this verifies, from the finished JSON report,
 * without loading Playwright and without running inside it. Two readers need
 * the same construction, so the construction is written twice — once in
 * TypeScript for the harness and the in-process reporter, once here for the CI
 * step — and `e2e/harness/stamp.test.ts` pins the two against each other over a
 * table of identities, so they cannot drift apart silently.
 *
 * The key is read from `.vizra-e2e/stamp-key.json`, which the stamp reporter
 * writes in `onEnd` — after the last test has finished, so no running spec could
 * have read it, and only if the reporter ran at all. A missing file, or a file
 * left over from an earlier run (every run mints a fresh key), therefore makes
 * every stamp fail to verify rather than making the check quietly pass. That is
 * the property that survives deleting the reporter from `playwright.config.ts`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Must match `STAMP_VERSION` in e2e/harness/stamp.ts. */
const STAMP_VERSION = "v1";

/** Must match `STAMP_ANNOTATION` in e2e/harness/stamp.ts. */
export const STAMP_ANNOTATION = "vizra-harness-stamp";

/** Must match `STAMP_KEY_FILE` in e2e/harness/stamp.ts. */
export const STAMP_KEY_FILE = ".vizra-e2e/stamp-key.json";

/**
 * @typedef {object} StampIdentity
 * @property {string} project
 * @property {string} file
 * @property {string} title
 * @property {number} workerIndex
 * @property {number} retry
 */

/**
 * @param {string} keyHex
 * @param {StampIdentity} identity
 * @returns {string}
 */
export function stampFor(keyHex, identity) {
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(
      [
        STAMP_VERSION,
        identity.project,
        identity.file,
        identity.title,
        String(identity.workerIndex),
        String(identity.retry),
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex");
}

/**
 * @param {string} keyHex
 * @param {StampIdentity} identity
 * @param {unknown} candidate
 * @returns {boolean}
 */
export function stampVerifies(keyHex, identity, candidate) {
  if (typeof candidate !== "string") return false;
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
  if (typeof keyHex !== "string" || !/^[0-9a-f]+$/.test(keyHex)) return false;
  const expected = stampFor(keyHex, identity);
  try {
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/**
 * Did this attempt count as a SUCCESS for the run?
 *
 * `passed` obviously does. A `failed` result whose test is `test.fail()`-marked
 * does too, because Playwright reports it as expected and the run stays green —
 * so an unstamped one of those would be exactly the hole this check exists for.
 * Everything else (`skipped`, `timedOut`, `interrupted`, an ordinary `failed`)
 * is not required to carry a stamp: fixture teardown can be cut short by a
 * timeout, and a run containing one is already red or already proved nothing.
 *
 * @param {{expectedStatus?: string}} test
 * @param {{status?: string}} result
 * @returns {boolean}
 */
export function countedAsSuccess(test, result) {
  if (result?.status === "passed") return true;
  return result?.status === "failed" && test?.expectedStatus === "failed";
}
