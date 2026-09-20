/**
 * The `e2e` lane still tests what it claims to test (VZ-FOUND-008).
 *
 * WHY THIS IS A PARSER AND NOT A GREP. The first version of this guard greped
 * the workflow for `docker build`, `docker run`, `E2E_BASE_URL`,
 * `upload-artifact` and friends. An independent verifier ran three mutations
 * through it:
 *
 *     m1  delete the `run: npm run e2e` line        -> exit 0  "OK: … still drives the built image"
 *     m2  replace it with `run: echo skipping`      -> exit 0  "OK: … still drives the built image"
 *     m3  add `if: false` to the `e2e:` job         -> exit 0  "OK: … still drives the built image"
 *
 * m1 and m2 are not caught by anything downstream: the `e2e` job still runs,
 * builds and starts the image, passes the fixture guard, and concludes
 * `success` — having opened no browser. `ci-required` then reports that every
 * required check succeeded. The guard whose own header promised that "removing
 * one is a named red failure" was silent on the most direct removal there is,
 * which is worse than no guard, because reviewers trust it.
 *
 * A grep cannot tell a step from a comment, a `run:` from a name, a step that
 * executes from one behind `if: false`, or `npm run e2e` from
 * `npm run e2e || true`. So the workflow is PARSED, and the assertions are
 * about the step graph:
 *
 *   1. the `e2e` job exists, is not disabled (`if:`), and does not hide its
 *      result (`continue-on-error`);
 *   2. exactly one step's `run` is EXACTLY the documented lane command
 *      (`npm run e2e`) — not a superstring, so `|| true`, `; true`, `&& :`,
 *      a subshell or any other exit-code laundering fails to match at all;
 *   3. that step is unconditional and does not continue-on-error;
 *   4. it targets the BUILT IMAGE: its `E2E_BASE_URL` is the URL a
 *      `docker run --publish` step in the same job exposes;
 *   5. the coverage-floor step FOLLOWS it;
 *  5b. the HARNESS CANARY step (`node scripts/ci/harness-canary.mjs`) exists,
 *      is unconditional, does not continue-on-error, and drives the same
 *      container. It is the only CI step that would notice the browser-error
 *      guard being switched off while its identifiers stayed in place — a case
 *      an independent verifier measured as silent in every other check;
 *   6. the image is built and started, and proved free of harness fixtures,
 *      before the lane runs;
 *   7. artifacts are redacted and then uploaded on failure, with EVERY upload
 *      step gated on `steps.<redact>.outcome == 'success'` — two bare
 *      `failure()` conditions are not a sequence — and with
 *      `if-no-files-found: error`. EVERY step, not the first one: a verifier
 *      appended a SECOND, ungated `actions/upload-artifact` step and the
 *      `.find()` this used to do answered OK, so a failing redactor would have
 *      had the unredacted tree published by the second step. An uploader that
 *      is not `actions/upload-artifact` is recognised too;
 *   8. nothing starts a development server, and nothing sets
 *      `E2E_COVERAGE_FLOOR` or `VIZRA_E2E_STAMP_KEY`;
 *   9. the workflow triggers on `pull_request` and `merge_group`;
 *  10. the harness keeps its guard AND its runtime stamp, and
 *      `playwright.config.ts` keeps the three lines the stamp depends on.
 *      Those last checks are string presence and are NOT the control; see the
 *      comment where they are made.
 *
 * Usage:  node scripts/ci/check-e2e-lane.mjs [workflow.yml]
 * Invoked by `scripts/ci/check-e2e-lane.sh`, which is what `ci-guard` runs and
 * what AGENTS.md documents.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Imported dynamically so a missing dependency is a NAMED failure rather than
// a module-resolution stack trace. `ci-guard` runs this job; it installs from
// the lockfile for exactly this reason.
let parse;
try {
  ({ parse } = await import("yaml"));
} catch {
  console.error(
    "::error::e2e-lane guard: the `yaml` package is not installed, so the workflow cannot be " +
      "parsed. Run `npm ci` first. This check is BLOCKED, not passed.",
  );
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The one command the lane may run. Documented in AGENTS.md as `npm run e2e`. */
const LANE_COMMAND = "npm run e2e";
/** The step that re-checks the floor from outside the Playwright process. */
const FLOOR_COMMAND = "node scripts/ci/check-coverage-floor-ran.mjs";
const FIXTURE_GUARD = "check-no-test-fixtures-in-image.sh";
const REDACT_SCRIPT = "redact-artifacts.sh";
/**
 * The harness's own self-test. Without it, neutering the browser-error guard
 * while leaving its identifiers in place is SILENT in CI — `npm run test` exits
 * 0, the harness check at the bottom of this file is string-presence only, and
 * the lane exits 0 because a guard that has stopped looking finds nothing to
 * fail on.
 */
const CANARY_COMMAND = "node scripts/ci/harness-canary.mjs";

/**
 * Does this `uses:` name a step that PUBLISHES artifacts?
 *
 * Broader than `actions/upload-artifact@` on purpose. A verifier's mutation
 * replaced that action with a different one and the guard's answer was "no step
 * uploads artifacts" — correct, but only because the check keyed on one exact
 * name. Anything whose action name contains `upload` or `artifact` is treated as
 * an uploader and must carry the same gate, so swapping the action is not a way
 * round the redaction. Arbitrary `run:` exfiltration (`gh release upload`,
 * `curl`) is outside what any parser can close; the control there is review, and
 * AGENTS.md says so rather than implying otherwise.
 */
const UPLOADER = /(^|\/)[\w.-]*(upload|artifact)[\w.-]*@/i;

const workflowPath = process.argv[2] ?? ".github/workflows/e2e.yml";
const problems = [];
const add = (message) => problems.push(message);

let workflow;
try {
  workflow = parse(readFileSync(path.resolve(repoRoot, workflowPath), "utf8"));
} catch (error) {
  console.error(
    `::error::e2e-lane guard: could not parse ${workflowPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

/**
 * `continue-on-error` in ANY spelling that is not a literal false: `true`, the
 * string "true", or an expression whose value cannot be read here. Anything
 * unreadable fails closed — a guard that cannot tell must not say yes.
 */
function hidesFailure(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  return String(value).trim() !== "false";
}

/** Any `if:` at all disables a step conditionally; the lane must be unconditional. */
function isConditional(node) {
  return node && Object.prototype.hasOwnProperty.call(node, "if");
}

const triggers = workflow?.on ?? workflow?.true; // YAML 1.1 parses bare `on:` as true
if (!triggers || typeof triggers !== "object") {
  add("the workflow declares no triggers.");
} else {
  if (!("pull_request" in triggers)) add("it does not trigger on `pull_request`.");
  if (!("merge_group" in triggers)) {
    add("it does not trigger on `merge_group`, so a required lane would hang the merge queue.");
  }
  const pr = triggers.pull_request;
  if (pr && typeof pr === "object" && "paths" in pr) {
    add(
      "`pull_request` carries a `paths:` filter. A path-filtered REQUIRED lane passes by never " +
        "running; `e2e` is in .github/required-checks.txt and in the floor.",
    );
  }
}

const job = workflow?.jobs?.e2e;
if (!job) {
  add("there is no `e2e` job — the required check of that name could never run.");
} else {
  if (isConditional(job)) {
    add("the `e2e` job carries an `if:`. A conditional required lane reports `skipped`, not `success`.");
  }
  if (hidesFailure(job["continue-on-error"])) {
    add("the `e2e` job sets `continue-on-error`, which hides a red lane.");
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (steps.length === 0) add("the `e2e` job has no steps.");

  const runOf = (step) => (typeof step?.run === "string" ? step.run.trim() : "");
  const usesOf = (step) => (typeof step?.uses === "string" ? step.uses : "");

  // (2) the lane step, matched EXACTLY.
  const laneIndexes = steps
    .map((step, index) => (runOf(step) === LANE_COMMAND ? index : -1))
    .filter((index) => index >= 0);

  if (laneIndexes.length === 0) {
    const nearMiss = steps.find((step) => runOf(step).includes("e2e") || runOf(step).includes("playwright"));
    add(
      `no step runs the browser lane. Exactly one step's \`run\` must be \`${LANE_COMMAND}\` ` +
        "and nothing else — a superstring such as `npm run e2e || true` launders the exit code" +
        (nearMiss ? `. Closest step found: \`${runOf(nearMiss)}\`` : ", and deleting the step is silent") +
        ".",
    );
  } else if (laneIndexes.length > 1) {
    add(`${laneIndexes.length} steps run \`${LANE_COMMAND}\`; exactly one must.`);
  }

  const laneIndex = laneIndexes[0];
  if (laneIndex !== undefined) {
    const lane = steps[laneIndex];

    // (3) unconditional, and its exit code counts.
    if (isConditional(lane)) {
      add("the browser-lane step carries an `if:`; it must run unconditionally on every pull request.");
    }
    if (hidesFailure(lane["continue-on-error"])) {
      add("the browser-lane step sets `continue-on-error`, so a red lane would report success.");
    }
    if (typeof lane.shell === "string" && !/^(bash|sh)( |$)/.test(lane.shell.trim())) {
      add(`the browser-lane step overrides \`shell: ${lane.shell}\`; the default shell's exit-code handling is what the lane relies on.`);
    }

    // (4) it targets the built image.
    const baseUrl = lane.env?.E2E_BASE_URL;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      add(
        "the browser-lane step sets no `E2E_BASE_URL`, so the harness would start its own " +
          "server instead of driving the built image.",
      );
    } else {
      const published = steps.some((step) => {
        const run = runOf(step);
        if (!run.includes("docker run")) return false;
        const port = /--publish\s+(\d+):/.exec(run)?.[1];
        return port !== undefined && baseUrl.includes(`:${port}`);
      });
      if (!published) {
        add(
          `the browser-lane step's E2E_BASE_URL (${baseUrl}) does not match any port a ` +
            "`docker run --publish` step in this job exposes; the lane may not be driving the built image.",
        );
      }
    }

    // (5) the floor step follows it.
    const floorIndex = steps.findIndex((step) => runOf(step).includes(FLOOR_COMMAND));
    if (floorIndex === -1) {
      add(
        `no step runs \`${FLOOR_COMMAND}\`. The in-process coverage floor lives in ` +
          "playwright.config.ts, which this pull request can edit; the floor must also be " +
          "re-checked from the finished report.",
      );
    } else if (floorIndex < laneIndex) {
      add("the coverage-floor step runs BEFORE the browser lane, so it would read a stale or absent report.");
    } else if (isConditional(steps[floorIndex]) || hidesFailure(steps[floorIndex]["continue-on-error"])) {
      add("the coverage-floor step is conditional or continues on error.");
    }

    // (6) the image is built, proved fixture-free and started, before the lane.
    const before = steps.slice(0, laneIndex);
    if (!before.some((step) => runOf(step).includes("docker build"))) {
      add("no step builds the production image before the lane runs.");
    }
    if (!before.some((step) => runOf(step).includes("docker run"))) {
      add("no step starts the built image before the lane runs.");
    }
    if (!before.some((step) => runOf(step).includes(FIXTURE_GUARD))) {
      add(`no step runs \`${FIXTURE_GUARD}\` before the lane, so the shipped image is not proved fixture-free.`);
    }
  }

  // (5b) THE HARNESS CANARY. Asserted the same way as the lane step — present,
  //      exactly the documented command, unconditional, exit code not laundered
  //      — because this is the only CI step that would notice the guard itself
  //      being switched off.
  const canaryIndexes = steps
    .map((step, index) => (runOf(step) === CANARY_COMMAND ? index : -1))
    .filter((index) => index >= 0);
  if (canaryIndexes.length === 0) {
    add(
      `no step runs \`${CANARY_COMMAND}\`. Without it, neutering e2e/harness/browser-errors.ts ` +
        "while leaving its identifiers in place is silent: every other check in this lane " +
        "stays green, because a guard that has stopped looking finds nothing to fail on.",
    );
  } else if (canaryIndexes.length > 1) {
    add(`${canaryIndexes.length} steps run \`${CANARY_COMMAND}\`; exactly one must.`);
  } else {
    const canaryIndex = canaryIndexes[0];
    const canary = steps[canaryIndex];
    if (isConditional(canary)) {
      add(
        "the harness-canary step carries an `if:`. A conditional self-test is one expression " +
          "away from never running, and its absence is invisible in a green lane.",
      );
    }
    if (hidesFailure(canary["continue-on-error"])) {
      add("the harness-canary step sets `continue-on-error`, so a neutered guard would report success.");
    }
    if (typeof canary.shell === "string" && !/^(bash|sh)( |$)/.test(canary.shell.trim())) {
      add(`the harness-canary step overrides \`shell: ${canary.shell}\`; its exit code is the result.`);
    }
    if (laneIndex !== undefined && canaryIndex < laneIndex) {
      add("the harness-canary step runs BEFORE the browser lane; it must exercise the same running container.");
    }
    const canaryBaseUrl = canary.env?.E2E_BASE_URL;
    if (typeof canaryBaseUrl !== "string" || canaryBaseUrl.trim() === "") {
      add(
        "the harness-canary step sets no `E2E_BASE_URL`, so it would start a server of its own " +
          "instead of exercising the built image the lane just drove.",
      );
    }
  }

  // (7) artifacts: redacted, then uploaded, with a loud missing-path — and the
  //     upload gated on the redaction having SUCCEEDED, not merely on the job
  //     having failed. `failure()` is true whenever any earlier step failed, so
  //     two bare `if: failure()` steps are not a sequence: a redactor that
  //     exits non-zero (exit 2 on a missing perl/unzip/zip, exit 1 on a repack
  //     failure) satisfies its own condition and the unredacted tree ships.
  const redactStep = steps.find((step) => runOf(step).includes(REDACT_SCRIPT));
  if (!redactStep) {
    add(
      `no step runs \`${REDACT_SCRIPT}\`. Playwright's traces carry raw query strings that ` +
        "e2e/harness/redact.ts cannot reach; uploading them unredacted publishes signed URLs.",
    );
  } else {
    if (typeof redactStep.id !== "string" || redactStep.id.trim() === "") {
      add(
        "the redaction step has no `id:`, so the upload step cannot be gated on whether it " +
          "succeeded.",
      );
    }
    if (hidesFailure(redactStep["continue-on-error"])) {
      add(
        "the redaction step sets `continue-on-error`, which would report `success` however it " +
          "exited — the gate below would then always open.",
      );
    }
  }
  //
  //     EVERY upload step, not the first one. This used `steps.find(...)`, and a
  //     verifier appended a SECOND `actions/upload-artifact` step on a bare
  //     `if: failure()` publishing the same two directories: the parser said OK.
  //     When the redactor fails, the gated upload is skipped and the ungated one
  //     publishes the unredacted tree — precisely the fail-open the gate closed
  //     for the first step. The parser's value is that it answers for the whole
  //     job, and a reader assumes it does, so it now does.
  const uploadSteps = steps.filter((step) => UPLOADER.test(usesOf(step)));
  const canonicalUploads = uploadSteps.filter((step) =>
    usesOf(step).startsWith("actions/upload-artifact@"),
  );
  if (canonicalUploads.length === 0) {
    add("no step uploads artifacts; a red lane would be undiagnosable.");
  }
  const redactId = typeof redactStep?.id === "string" ? redactStep.id.trim() : "";
  const gate = redactId === "" ? null : new RegExp(`steps\\.${redactId}\\.outcome\\s*==\\s*'success'`);
  const redactIndex = redactStep ? steps.indexOf(redactStep) : -1;

  uploadSteps.forEach((uploadStep) => {
    const index = steps.indexOf(uploadStep);
    // Named by index AND by `uses`, so a report about a second upload step says
    // which one rather than "the artifact upload".
    const which = `the artifact upload at step ${index + 1} (\`${usesOf(uploadStep)}\`)`;

    const uploadIf = String(uploadStep.if ?? "");
    if (!uploadIf.includes("failure()")) {
      add(`${which} is not gated on \`failure()\`.`);
    }
    if (gate === null || !gate.test(uploadIf)) {
      add(
        `${which} is not gated on the redaction having SUCCEEDED. It must read ` +
          `\`if: failure() && steps.${redactId || "<redact-step-id>"}.outcome == 'success'\`; ` +
          `it reads \`${uploadIf || "(nothing)"}\`. With two bare \`failure()\` conditions a ` +
          "redactor that exits non-zero still lets the unredacted tree be published — and a " +
          "SECOND, ungated upload step publishes it even when the first one is correctly skipped.",
      );
    }
    if (hidesFailure(uploadStep["continue-on-error"])) {
      add(`${which} sets \`continue-on-error\`, hiding a failed publish.`);
    }
    if (redactIndex >= 0 && index < redactIndex) {
      add(`${which} runs before the redaction step: the artifacts are uploaded BEFORE they are redacted.`);
    }
  });

  // Path and `if-no-files-found` are properties of `actions/upload-artifact`'s
  // own inputs, so they are asserted on those steps only. The gate above applies
  // to every uploader whatever its inputs are called.
  canonicalUploads.forEach((uploadStep) => {
    const index = steps.indexOf(uploadStep);
    const which = `the artifact upload at step ${index + 1}`;
    const uploadPath = String(uploadStep.with?.path ?? "");
    for (const wanted of ["playwright-report", "test-results"]) {
      if (!uploadPath.includes(wanted)) add(`${which} no longer includes \`${wanted}\`.`);
    }
    if (String(uploadStep.with?.["if-no-files-found"] ?? "") !== "error") {
      add(
        `${which} does not set \`if-no-files-found: error\`. This step only runs on ` +
          "failure, so a wrong path would be a warning nobody ever reads.",
      );
    }
  });

  // (8) nothing that would make the lane test the wrong thing.
  for (const step of steps) {
    const run = runOf(step);
    if (/\b(next|npm run) dev\b/.test(run)) {
      add("a step starts a development server. The lane must drive the production build (ADR-009).");
    }
    if (run.includes("E2E_COVERAGE_FLOOR") || step?.env?.E2E_COVERAGE_FLOOR !== undefined) {
      add("a step sets `E2E_COVERAGE_FLOOR`. The floor is on by default and the lane must not turn it off.");
    }
    // The runtime proof-of-harness key is minted fresh by the Playwright main
    // process on every run. A workflow that pinned it to a known value would let
    // a spec sign its own stamp.
    if (run.includes("VIZRA_E2E_STAMP_KEY") || step?.env?.VIZRA_E2E_STAMP_KEY !== undefined) {
      add(
        "a step sets `VIZRA_E2E_STAMP_KEY`. That key is minted per run so a spec cannot forge " +
          "the harness stamp; pinning it to a known value would make the stamp forgeable.",
      );
    }
  }
  if (job.env?.E2E_COVERAGE_FLOOR !== undefined) {
    add("the `e2e` job sets `E2E_COVERAGE_FLOOR` at job level.");
  }
  if (job.env?.VIZRA_E2E_STAMP_KEY !== undefined) {
    add("the `e2e` job sets `VIZRA_E2E_STAMP_KEY` at job level; the key is minted per run.");
  }
}

// The harness itself must keep its default-deny guard AND its runtime proof.
//
// THESE ARE STRING-PRESENCE CHECKS AND THEY ARE NOT THE CONTROL. An independent
// verifier established the limit exactly: neutering the guard while leaving
// these identifiers in place passes here. That is why the `e2e` lane now runs
// `scripts/ci/harness-canary.mjs`, which exercises the guard against three real
// broken pages, and why deleting the stamp fixture or the stamp reporter turns
// both the in-process and the out-of-process stamp checks red on their own.
// What follows is the cheap early warning for an outright deletion.
const guardPath = path.join(repoRoot, "e2e", "harness", "test.ts");
try {
  const guard = readFileSync(guardPath, "utf8");
  if (!guard.includes("validatePolicy")) add("e2e/harness/test.ts no longer validates the allow-list policy.");
  if (!guard.includes("unallowedRecords")) {
    add("e2e/harness/test.ts no longer fails a test on unallowed browser errors.");
  }
  if (!guard.includes("claimSigner") || !guard.includes("STAMP_ANNOTATION")) {
    add(
      "e2e/harness/test.ts no longer stamps the tests it runs, so nothing at RUNTIME " +
        "distinguishes a test that went through the guard from one that imported " +
        "`@playwright/test` directly.",
    );
  }
} catch {
  add("e2e/harness/test.ts is missing; there is no browser-error guard.");
}

// The wiring that makes the stamp work: the configuration must load the harness
// entry (so the per-run key leaves the worker's environment before any test file
// is evaluated) and must register the reporter that refuses an unstamped pass.
const configPath = path.join(repoRoot, "playwright.config.ts");
try {
  const config = readFileSync(configPath, "utf8");
  if (!config.includes("./e2e/harness/stamp-reporter")) {
    add(
      "playwright.config.ts no longer registers ./e2e/harness/stamp-reporter, so nothing " +
        "inside the run refuses a test that passed without the harness.",
    );
  }
  if (!/import\s+["']\.\/e2e\/harness\/test["']/.test(config)) {
    add(
      "playwright.config.ts no longer imports ./e2e/harness/test. That import is what takes " +
        "the per-run stamp key out of each worker's environment before any spec is loaded; " +
        "without it a spec can read the key and sign itself.",
    );
  }
  if (!/testDir:\s*["']\.\/e2e\/specs["']/.test(config)) {
    add(
      "playwright.config.ts no longer restricts `testDir` to ./e2e/specs. With a wider root " +
        "Playwright collects `**/*.spec.ts` from directories the guards do not cover — a " +
        "verifier ran a spec from e2e/other/ that way, on a page that 404s and throws.",
    );
  }
} catch {
  add("playwright.config.ts is missing.");
}

if (problems.length > 0) {
  console.error("::error::the e2e lane no longer tests what it claims to test:");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("  These properties are invisible in a green run, which is why they are asserted here.");
  process.exit(1);
}

console.log(
  `OK: ${workflowPath} still drives the built image, runs \`${LANE_COMMAND}\` unconditionally, ` +
    "re-checks the coverage floor after it, runs the harness canary, and redacts artifacts " +
    "before EVERY upload step publishes them.",
);
