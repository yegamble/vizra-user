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
 * ONE INVOCATION PER FIXTURE, and each one asserts the exact SET of record
 * KINDS the guard recorded.
 *
 * WHY, PRECISELY. The first version of this canary ran all three in one
 * invocation and required each fixture's diagnostic to appear somewhere in the
 * combined output. An independent verifier showed that claim was overstated:
 * replacing `console.error(token)` in `console-error.demo.ts` with a 404
 * sub-resource left the canary GREEN, because Chromium reports a failed load on
 * the console and the harness formats it as
 * `console.error: Failed to load resource…`, which satisfied that fixture's
 * expected string. The fixture then demonstrated the wrong control and nobody
 * was told.
 *
 * So each fixture now declares the kinds the guard MUST record and the kinds it
 * must NOT, measured against the committed demos:
 *
 *   console-error       -> {console}            (a plain console.error)
 *   failed-request      -> {response, console}  (Chromium logs the 404 too)
 *   uncaught-exception  -> {pageerror}
 *
 * Swapping any fixture's fault for another kind therefore turns the canary red:
 * a 404 in the console fixture adds `[response]`, a throw in the 404 fixture
 * adds `[pageerror]` and drops `http 404`, a console.error in the throw fixture
 * drops `[pageerror]`. The kind markers are the `[kind]` prefixes
 * `formatFailure` prints, so this reads what the guard actually recorded rather
 * than what the page happened to say.
 *
 * The cost of separate invocations is one browser launch each — a few seconds —
 * and it buys per-fixture isolation, without which "must NOT contain" could
 * never be asserted at all.
 */
const CANARIES = [
  {
    file: "e2e/demos/console-error.demo.ts",
    what: "a console.error on the page",
    expect: ["[console]", "console.error", "browser error(s) that no allow-list entry covers"],
    forbid: ["[response]", "[pageerror]", "[requestfailed]"],
  },
  {
    file: "e2e/demos/failed-request.demo.ts",
    what: "a sub-resource that returns 404",
    // `[console]` is NOT forbidden here: Chromium logs the failed load itself,
    // and the demo's own allow-list does not silence it. That is measured, not
    // assumed — see docs/evidence/VZ-FOUND-008/d2-failed-request-RED.txt.
    expect: ["[response]", "http 404"],
    forbid: ["[pageerror]", "[requestfailed]"],
  },
  {
    file: "e2e/demos/uncaught-exception.demo.ts",
    what: "an uncaught exception in the page",
    expect: ["[pageerror]", "pageerror"],
    forbid: ["[response]", "[console]", "[requestfailed]"],
  },
];

const project = process.env.E2E_CANARY_PROJECT ?? "desktop-chromium-1440";

const problems = [];

for (const canary of CANARIES) {
  const args = [
    "playwright",
    "test",
    "--config",
    "playwright.demos.config.ts",
    `--project=${project}`,
    canary.file,
    // `RED:` and not `RED`. Playwright compiles `--grep` with the `i` flag, so
    // the bare word also matches "decla(red)" in the GREEN halves' titles —
    // measured, not assumed. The colon selects exactly the
    // `test.describe("RED: …")` block, which is what the count below asserts.
    "--grep",
    "RED:",
  ];

  const run = spawnSync("npx", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    // The demo is EXPECTED to fail, so a non-zero exit is the success case here.
    // Output is captured rather than inherited so it can be asserted on.
    maxBuffer: 32 * 1024 * 1024,
  });

  if (run.error) {
    console.error(
      `::error::harness canary: could not run Playwright for ${canary.file} ` +
        `(${run.error.message}). A canary that could not run is BLOCKED, not a pass (AGENTS.md).`,
    );
    process.exit(2);
  }

  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  process.stdout.write(`\n--- ${canary.file} (${canary.what}) ---\n${output}`);

  if (run.status === null) {
    problems.push(
      `${canary.file}: Playwright was killed by signal ${run.signal}; the canary proved nothing.`,
    );
    continue;
  }

  if (run.status === 0) {
    problems.push(
      `${canary.file} (${canary.what}) PASSED. The browser-error guard in ` +
        "e2e/harness/browser-errors.ts is no longer failing a page that logs, throws or 404s — " +
        "which is invisible in an ordinary green lane, because a guard that has stopped " +
        "looking finds nothing to report.",
    );
    continue;
  }

  // Exactly one test, so "the other two failed instead" cannot stand in for it.
  if (!/\b1 failed\b/.test(output)) {
    problems.push(
      `${canary.file}: Playwright did not report exactly 1 failed test. This invocation selects ` +
        "one fixture with --grep 'RED:'; anything else means the fixture or the selection moved.",
    );
  }

  const missing = canary.expect.filter((needle) => !output.includes(needle));
  if (missing.length > 0) {
    problems.push(
      `${canary.file} (${canary.what}) did not fail for its own reason: the output does not ` +
        `contain ${missing.map((needle) => JSON.stringify(needle)).join(" or ")}. Either the ` +
        "fixture passed, or the guard failed it for an unrelated reason — both mean the " +
        "demonstration no longer demonstrates.",
    );
  }

  // The half that makes "for its own reason" true rather than aspirational: the
  // guard must NOT have recorded a kind this fixture is not supposed to produce.
  const unexpected = canary.forbid.filter((marker) => output.includes(marker));
  if (unexpected.length > 0) {
    problems.push(
      `${canary.file} (${canary.what}) failed for the WRONG reason: the guard recorded ` +
        `${unexpected.join(", ")}, which this fixture does not demonstrate. Swapping a ` +
        "fixture's fault for another kind leaves the control it was written for untested.",
    );
  }
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
  `OK: the harness canary failed all ${CANARIES.length} fault-injection fixtures, each with the ` +
    "exact set of record kinds it demonstrates and no others " +
    "([console] / [response]+http 404 / [pageerror]).",
);
