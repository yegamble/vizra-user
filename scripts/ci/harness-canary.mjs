/**
 * THE LANE'S SELF-TEST: does the browser-error guard still FAIL a broken page?
 *
 * THE HOLE THIS CLOSES. An independent verifier recorded it exactly: neutering
 * `e2e/harness/test.ts` — or, more precisely, the listeners in
 * `e2e/harness/browser-errors.ts` — while leaving its identifiers in place is
 * **silent in CI**. `npm run test` exits 0 (the unit tests cover the decision
 * logic, not the listeners), `scripts/ci/check-e2e-lane.sh` exits 0 (its harness
 * check is string-presence only), and the lane itself exits 0, because a lane
 * whose guard has stopped looking sees nothing to fail on. The only thing that
 * would have caught it is `npm run e2e:demos`, and that is not a CI lane: it
 * needs Docker, a dev server and several minutes.
 *
 * So the three demonstrations that matter most run IN the lane, against the same
 * container the lane just drove, and each one is REQUIRED TO FAIL for its own
 * named reason:
 *
 *   console.error on the page      -> "browser error(s) that no allow-list entry covers"
 *   a sub-resource returning 404   -> "http 404"
 *   an uncaught exception          -> "pageerror"
 *
 * If any of them passes, or fails for a different reason, the lane is RED. That
 * makes "the guard was quietly switched off" a named CI failure instead of a
 * greener run. The faults are injected with `page.addInitScript` against the
 * unmodified production server — there is no fixture route, and
 * `scripts/ci/check-no-test-fixtures-in-image.sh` proves none ships.
 *
 * DELIBERATELY NOT HERE. The Docker D6 pair (the image carries no harness file),
 * D5 (pointed at `next dev`), D7 (the workflow parser) and D9 (artifact
 * redaction). D6 needs a second image build, D5 needs a development server, and
 * D7/D9 are already asserted by cheap checks in other lanes. This step is the
 * smallest thing that would have caught the silent case, and it costs one
 * Playwright invocation on a container that is already running.
 *
 * Usage:  node scripts/ci/harness-canary.mjs
 * `E2E_BASE_URL` set -> drive that origin (CI: the container the lane drove).
 * Unset -> the demos configuration starts the local production server itself,
 * which needs `npm run build` first.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * One Playwright invocation for all three, so the step costs a single browser
 * launch. Each entry's diagnostic must appear in the output AND the run must
 * report exactly three failures — a fixture that silently passed would leave its
 * diagnostic missing and the count short.
 */
const CANARIES = [
  {
    file: "e2e/demos/console-error.demo.ts",
    what: "a console.error on the page",
    expect: ["console.error", "browser error(s) that no allow-list entry covers"],
  },
  {
    file: "e2e/demos/failed-request.demo.ts",
    what: "a sub-resource that returns 404",
    expect: ["http 404"],
  },
  {
    file: "e2e/demos/uncaught-exception.demo.ts",
    what: "an uncaught exception in the page",
    expect: ["pageerror"],
  },
];

const project = process.env.E2E_CANARY_PROJECT ?? "desktop-chromium-1440";

const args = [
  "playwright",
  "test",
  "--config",
  "playwright.demos.config.ts",
  `--project=${project}`,
  ...CANARIES.map((canary) => canary.file),
  // `RED:` and not `RED`. Playwright compiles `--grep` with the `i` flag, so the
  // bare word also matches "decla(red)" in the GREEN halves' titles — measured,
  // not assumed. The colon is what makes the selection exactly the three
  // `test.describe("RED: …")` blocks, which is what the count below asserts.
  "--grep",
  "RED:",
];

const run = spawnSync("npx", args, {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  // The demos are EXPECTED to fail, so a non-zero exit is the success case here.
  // Output is captured rather than inherited so it can be asserted on.
  maxBuffer: 32 * 1024 * 1024,
});

if (run.error) {
  console.error(
    `::error::harness canary: could not run Playwright (${run.error.message}). ` +
      "A canary that could not run is BLOCKED, not a pass (AGENTS.md).",
  );
  process.exit(2);
}

const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
process.stdout.write(output);

const problems = [];

if (run.status === 0) {
  problems.push(
    "every fault-injection fixture PASSED. The browser-error guard in " +
      "e2e/harness/browser-errors.ts is no longer failing a page that logs, throws or 404s — " +
      "which is invisible in an ordinary green lane, because a guard that has stopped " +
      "looking finds nothing to report.",
  );
}

if (run.status === null) {
  problems.push(`Playwright was killed by signal ${run.signal}; the canary proved nothing.`);
}

for (const canary of CANARIES) {
  const missing = canary.expect.filter((needle) => !output.includes(needle));
  if (missing.length > 0) {
    problems.push(
      `${canary.file} (${canary.what}) did not fail for its own reason: the output does not ` +
        `contain ${missing.map((needle) => JSON.stringify(needle)).join(" or ")}. Either the ` +
        "fixture passed, or the guard failed it for an unrelated reason — both mean the " +
        "demonstration no longer demonstrates.",
    );
  }
}

// A per-fixture count, so "one of the three quietly passed" cannot hide behind
// the other two failing.
const expectedFailures = CANARIES.length;
if (!new RegExp(`\\b${expectedFailures} failed\\b`).test(output)) {
  problems.push(
    `Playwright did not report exactly ${expectedFailures} failed tests. Each of the ` +
      `${expectedFailures} fault-injection fixtures must fail; a run that reports fewer has a ` +
      "fixture that the guard let through.",
  );
}

if (problems.length > 0) {
  console.error("::error::the browser harness no longer fails a broken page:");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "  This step exists because neutering the guard while leaving its identifiers in place " +
      "is otherwise SILENT: `npm run test`, `check-e2e-lane.sh` and the lane itself all stay " +
      "green. See e2e/harness/browser-errors.ts and scripts/e2e/demonstrate.sh D1-D3.",
  );
  process.exit(1);
}

console.log(
  `OK: the harness canary failed all ${expectedFailures} fault-injection fixtures, each for ` +
    "its own named reason (console.error, http 404, pageerror).",
);
