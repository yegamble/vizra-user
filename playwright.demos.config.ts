/**
 * The DEMONSTRATION configuration. Not the lane.
 *
 * `e2e/demos/*.demo.ts` inject faults into the real production page — a
 * `console.error`, a sub-resource that 404s, an uncaught exception — to prove
 * the guard in `e2e/harness/` actually fails a test rather than decorating one.
 * They are therefore EXPECTED TO FAIL, and must never be collected by
 * `playwright.config.ts` (which matches `**​/*.spec.ts` only).
 *
 * `scripts/e2e/demonstrate.sh` drives this config for the red half of each
 * demonstration and asserts a non-zero exit; the green half re-runs the same
 * spec with the fault removed (or allow-listed with a written reason) and
 * asserts zero.
 *
 * The coverage-floor reporter is not loaded here: these runs are deliberately
 * partial, and a floor that fired on them would only teach people to ignore it.
 */

import base from "./playwright.config";

const demosConfig = {
  ...base,
  testMatch: "**/*.demo.ts",
  retries: 0,
  failOnFlakyTests: true,
  reporter: [["list"]] as const,
};

export default demosConfig;
