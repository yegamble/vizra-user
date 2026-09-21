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

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  defaultExportDeclaresKey,
  defaultExportProperty,
  hasGenuineCall,
  hasNonImportReference,
  fixtureOptions,
  hasObjectProperty,
  importsModule,
  moduleSpecifierStartsWith,
  overridesFixtureWithFunction,
  parseTypeScript,
  UNREADABLE,
} from "./ts-source-facts.mjs";

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
    // `test-results/` only. `playwright-report/` used to be required here too,
    // and is now REFUSED by the allowlist below: its `index.html` carries a
    // base64-embedded ZIP of the whole report dataset that no redactor in this
    // repository can reach (FINDING 3, measured). Everything diagnostic —
    // trace.zip, the screenshot, the video, error-context.md — is under
    // `test-results/`, and `playwright-report/data/` was a byte-identical second
    // copy of the same traces. An upload that carries nothing is still a defect:
    // a red lane must publish the trace of what failed.
    for (const wanted of ["test-results"]) {
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
// these identifiers in place passes here. That is why the `e2e` lane runs
// `scripts/ci/harness-canary.mjs`, which exercises the guard against four real
// broken pages, and why deleting the stamp fixture or the stamp reporter turns
// both the in-process and the out-of-process stamp checks red on their own.
// What follows is the cheap early warning for an outright deletion.
//
// EVERY CHECK BELOW REQUIRES A REAL CALL, READ FROM A PARSED TREE. They used to
// be `includes("guardBrowser")` and friends, and an independent verifier
// measured what that bought: with the CALL replaced by an inert guard object and
// the IMPORT left in place, `tsc` exit 0, this script exit 0, and the lane exit 0
// with `18 passed` — with the guard entirely inert. Only the canary caught it.
// Demanding `name(` closed that, and a SECOND verifier then measured three ways
// through the string version: a trailing line comment, a string literal, and
// `void name(a, b)`. Those are gone by construction — a comment is not a node and
// a string is not a call — and the `void` spelling is refused explicitly. See
// `scripts/ci/ts-source-facts.mjs` for what is still NOT decided (a call whose
// result is dropped, or one in unreachable code: review-only, and AGENTS.md
// § Residuals says so).
const HARNESS_FILES = {
  entry: path.join(repoRoot, "e2e", "harness", "test.ts"),
  worker: path.join(repoRoot, "e2e", "harness", "worker-guard.ts"),
};
/** Each entry: [file key, exported symbol that must be CALLED, message]. */
const HARNESS_CALLS = [
  [
    "entry",
    "validatePolicy",
    "e2e/harness/test.ts no longer CALLS `validatePolicy`, so the allow-list shape is not checked.",
  ],
  [
    "entry",
    "unallowedRecords",
    "e2e/harness/test.ts no longer CALLS `unallowedRecords`, so nothing fails a test on an " +
      "unallowed browser error.",
  ],
  [
    "entry",
    "claimSigner",
    "e2e/harness/test.ts no longer CALLS `claimSigner`, so nothing at RUNTIME distinguishes a " +
      "test that went through the guard from one that reached `@playwright/test` directly.",
  ],
  [
    "entry",
    "createWorkerHarness",
    "e2e/harness/test.ts no longer CALLS `createWorkerHarness`, so the browser-error listeners " +
      "are not installed for the worker. A page opened and navigated in `beforeAll` would then " +
      "be observed by nothing and its test would pass on a page that 404s and throws — measured " +
      "by an independent verifier as FINDING 1.",
  ],
  [
    "entry",
    "isGenuineWorkerHarness",
    "e2e/harness/test.ts no longer CALLS `isGenuineWorkerHarness`, so a spec could replace the " +
      "worker-scoped guard with a no-op, keep the per-test stamp and lose the listeners.",
  ],
  [
    "entry",
    "unguardedContexts",
    "e2e/harness/test.ts no longer CALLS `unguardedContexts`, so nothing asserts that every " +
      "live context on the browser is one the guard registered — the catch-all underneath the " +
      "creation guard, for a context-creation path nobody has thought of yet.",
  ],
  [
    "entry",
    "formatOrphans",
    "e2e/harness/test.ts no longer CALLS `formatOrphans`, so signals produced after the last " +
      "test in a worker — an `afterAll` hook on a broken page — belong to no test and fail " +
      "nothing. A worker-teardown throw is what makes that a red run.",
  ],
  [
    "worker",
    "guardBrowser",
    "e2e/harness/worker-guard.ts no longer CALLS `guardBrowser`, so the BrowserContext-level " +
      "listeners are never attached and the guard sees nothing at all.",
  ],
  [
    "worker",
    "armCreationGuard",
    "e2e/harness/worker-guard.ts no longer CALLS `armCreationGuard`, so a spec can reach a " +
      "context through `Browser.prototype.newContext` or launch a browser of its own, and " +
      "nothing watches that page.",
  ],
  [
    "worker",
    "patchBrowserPrototype",
    "e2e/harness/worker-guard.ts no longer CALLS `patchBrowserPrototype`.",
  ],
];

/**
 * THE HARNESS FILES, PARSED — not greped.
 *
 * This block used to strip comments with two regular expressions and then run a
 * pattern over what was left. Its header claimed the stripping "can only make
 * the patterns match LESS, i.e. fail closed"; that sentence was FALSE and is
 * retracted. Three defeats were measured with the CALL deleted in each case —
 * a TRAILING line comment, a STRING LITERAL, and `void name(a, b)` — and the
 * trailing-comment case was driven end to end on the one control the canary
 * cannot reach (the `formatOrphans` worker-teardown assertion): `tsc` 0, this
 * script 0, the canary 0, and an `afterAll` that breaks a page passing.
 *
 * Parsing removes the first two by construction: a comment is not a node and a
 * string literal is not a call. The `void` spelling is refused explicitly, and a
 * SHADOWED callee is refused too — matching "a call to something named X"
 * without asking which X would have traded a string defeat for a scope defeat.
 *
 * What is still NOT decided, stated plainly because the alternative is the
 * over-claim this block exists to retract: whether a call's RESULT is used in a
 * way that matters. `const _ = f();` and a call in unreachable code both satisfy
 * these checks. That needs a type checker and a reachability analysis; the
 * general case is REVIEW-ONLY and `AGENTS.md § Residuals` says so.
 *
 * A file that does not parse is a NAMED failure, not a skip.
 */
const harnessTree = {};
for (const [key, file] of Object.entries(HARNESS_FILES)) {
  const relative = path.relative(repoRoot, file);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    add(`${relative} is missing; the browser-error guard is incomplete.`);
    continue;
  }
  try {
    harnessTree[key] = parseTypeScript(file, source);
  } catch (error) {
    add(
      `${relative} could not be PARSED (${error instanceof Error ? error.message : String(error)}), ` +
        "so the harness checks below cannot be made. A guard that cannot read its subject must " +
        "not say yes.",
    );
  }
}

const WHY_NOT = {
  absent: "does not CALL",
  "void-discarded": "calls but DISCARDS with `void`, which is not a use of",
  shadowed: "calls a LOCAL binding that shadows, not the imported",
};

for (const [key, symbol, message] of HARNESS_CALLS) {
  const tree = harnessTree[key];
  if (tree === undefined) continue;
  const verdict = hasGenuineCall(tree, symbol);
  if (!verdict.ok) add(`${message} (it ${WHY_NOT[verdict.reason]} \`${symbol}\`.)`);
}

const entryTree = harnessTree.entry;
if (entryTree !== undefined) {
  // The stamp must actually be WRITTEN, not merely imported. Measured at
  // `f0ee8f1` by a second verifier: deleting the whole
  // `testInfo.annotations.push({ type: STAMP_ANNOTATION, … })` statement left
  // the old presence check GREEN, because the identifier survives on its own
  // import line — the same import-satisfies-a-name defect the ten call checks
  // were fixed for. Two runtime controls sit behind this symbol so it was never
  // material; parsing makes fixing it free.
  if (!hasNonImportReference(entryTree, "STAMP_ANNOTATION")) {
    add(
      "e2e/harness/test.ts no longer writes the stamp annotation (`STAMP_ANNOTATION` appears " +
        "only on an import line, or not at all).",
    );
  }
  // The guard and the stamp must be in ONE fixture. Two fixtures is exactly the
  // shape `test.extend` can take apart, which is how FINDING 11 happened.
  if (!hasObjectProperty(entryTree, "vizraHarnessGuard")) {
    add(
      "e2e/harness/test.ts no longer declares the combined `vizraHarnessGuard` fixture. The " +
        "accounting and the runtime stamp must live in the SAME automatic fixture, so that " +
        "removing one removes the stamp that both floor checks require.",
    );
  }
  // The listening must be WORKER-scoped and automatic. A test-scoped listener
  // is set up after `beforeAll` has already run — FINDING 1.
  if (!hasObjectProperty(entryTree, "vizraWorkerGuard")) {
    add(
      "e2e/harness/test.ts no longer declares the `vizraWorkerGuard` fixture, which is where " +
        "the listeners are installed for the whole worker.",
    );
  }

  // WORKER-scoped and AUTOMATIC, read from the fixture's own options tuple.
  // A test-scoped listener is set up AFTER `beforeAll` has run, so a page opened
  // and navigated in a hook is observed by nothing — FINDING 1 of the PR #7
  // review. The previous check was a regex for `scope:\s*"worker"` anywhere in
  // the file, which the fixture's own explanatory comment would have satisfied.
  const workerOptions = fixtureOptions(entryTree, "vizraWorkerGuard");
  const WORKER_SCOPED = "e2e/harness/test.ts no longer declares an automatic WORKER-scoped fixture";
  if (workerOptions === undefined || workerOptions === UNREADABLE) {
    add(
      `${WORKER_SCOPED} — \`vizraWorkerGuard\` is not declared as ` +
        '`[fn, { scope: "worker", auto: true }]`, or its options are not a literal this guard ' +
        "can read. A test-scoped listener is set up AFTER `beforeAll` has run, so a page opened " +
        "and navigated in a hook is never observed.",
    );
  } else if (workerOptions.scope !== "worker" || workerOptions.auto !== true) {
    add(
      `${WORKER_SCOPED} — \`vizraWorkerGuard\` reads ` +
        `scope=${JSON.stringify(workerOptions.scope)} auto=${JSON.stringify(workerOptions.auto)}, ` +
        'and must be { scope: "worker", auto: true }. A test-scoped listener is set up AFTER ' +
        "`beforeAll` has run, so a page opened and navigated in a hook is never observed.",
    );
  }

  // The guard must NOT move back into a `page` override.
  if (overridesFixtureWithFunction(entryTree, "page")) {
    add(
      "e2e/harness/test.ts overrides the `page` fixture again. The guard belongs in the " +
        "automatic fixtures, attached at the browser: a page-scoped guard is removable by " +
        "`test.extend({ page: … })` in a spec, with the stamp left intact.",
    );
  }
}

// THE PLAYWRIGHT CONFIGURATION, PARSED.
//
// Three properties are asserted here, and one whole KEY is refused.
//
// The wiring that makes the stamp work: the configuration must load the harness
// entry (so the per-run key leaves the worker's environment before any test file
// is evaluated) and must register the reporter that refuses an unstamped pass.
//
// AND `globalSetup` / `globalTeardown` ARE REFUSED OUTRIGHT. An independent
// verifier measured the hole (PR #7 review, FINDING 6): the listening starts at
// WORKER setup, while `globalSetup` runs in the Playwright main process before
// any worker exists — so no listener is attached and the creation guard is
// unarmed. A `globalSetup` that launches its own Chromium and opens a page which
// 404s a sub-resource and throws gave `npx playwright test` exit **0**,
// `3 passed`, with no guard message, and the module provably ran (it wrote a
// marker file). This script exited 0 too. Nothing in this repository needs one,
// a setup PROJECT (`dependencies: [...]`) is fully covered and is the supported
// way to do setup, and refusing the key is cheaper than guarding it. If a later
// slice genuinely needs one, the refusal is the place that forces the
// conversation rather than a silent gap.
const CONFIG_FILES = ["playwright.config.ts", "playwright.demos.config.ts"];
const FORBIDDEN_CONFIG_KEYS = ["globalSetup", "globalTeardown"];

for (const relative of CONFIG_FILES) {
  const configPath = path.join(repoRoot, relative);
  let source;
  try {
    source = readFileSync(configPath, "utf8");
  } catch {
    add(`${relative} is missing.`);
    continue;
  }

  let tree;
  try {
    tree = parseTypeScript(configPath, source);
  } catch (error) {
    add(
      `${relative} could not be PARSED (${error instanceof Error ? error.message : String(error)}); ` +
        "a configuration this guard cannot read must not pass it.",
    );
    continue;
  }

  for (const key of FORBIDDEN_CONFIG_KEYS) {
    const verdict = defaultExportDeclaresKey(tree, key);
    if (verdict.declared) {
      add(
        `${relative} declares \`${key}\` (via ${verdict.via}), which is REFUSED. It runs in the Playwright main ` +
          "process before any worker exists, so the worker-scoped listeners are not attached and " +
          "the creation guard is unarmed: a verifier's `globalSetup` opened a page that 404s and " +
          "throws and the run exited 0 with `3 passed` and no guard message. Use a setup PROJECT " +
          "(`dependencies: [...]`), whose tests are ordinary guarded tests. (A spread or a " +
          "computed key in the configuration object is refused here too — this guard cannot rule " +
          "the key out through one, so it fails closed.)",
      );
    }
  }
}

// The stamp wiring, asserted on the main configuration only: the demos
// configuration deliberately runs fixtures that are MEANT to fail.
const mainConfigPath = path.join(repoRoot, "playwright.config.ts");
try {
  const source = readFileSync(mainConfigPath, "utf8");
  const tree = parseTypeScript(mainConfigPath, source);

  // A reporter entry is a string inside an array, so this one stays a source
  // check by nature — but it is a check for a MODULE SPECIFIER, and a specifier
  // is a string literal wherever it appears. Read from the tree so that naming
  // it in a comment does not satisfy it.
  if (!moduleSpecifierStartsWith(tree, "./e2e/harness/stamp-reporter")) {
    add(
      "playwright.config.ts no longer registers ./e2e/harness/stamp-reporter, so nothing " +
        "inside the run refuses a test that passed without the harness.",
    );
  }
  if (!importsModule(tree, "./e2e/harness/test")) {
    add(
      "playwright.config.ts no longer imports ./e2e/harness/test. That import is what takes " +
        "the per-run stamp key out of each worker's environment before any spec is loaded; " +
        "without it a spec can read the key and sign itself.",
    );
  }
  const testDir = defaultExportProperty(tree, "testDir");
  if (testDir !== "./e2e/specs") {
    add(
      "playwright.config.ts no longer restricts `testDir` to ./e2e/specs " +
        `(read: ${testDir === UNREADABLE ? "not a literal this guard can read" : JSON.stringify(testDir)}). ` +
        "With a wider root Playwright collects `**/*.spec.ts` from directories the guards do not " +
        "cover — a verifier ran a spec from e2e/other/ that way, on a page that 404s and throws.",
    );
  }
} catch {
  add("playwright.config.ts is missing or could not be parsed.");
}

// ===========================================================================
// UPLOAD SCOPE IS DEFAULT-DENY, ACROSS THE WHOLE WORKFLOW FILE.
//
// The `vizra-security` seat's FINDING 8: deriving the scope of what leaves the
// runner from "the paths the uploader steps happen to name" is not default-deny,
// because an author can widen it in ways the derivation cannot read.
//
//   - `actions/cache` matches neither `upload` nor `artifact`, and a cache IS a
//     publisher: its blob is readable by other workflow runs in the repository;
//   - `path:` accepts multi-line GLOBS and `!` exclusions, so `.`, `**` or
//     `test-*` cannot be disproved to contain a secret directory by a prefix
//     check — and a prefix check is what the plan originally proposed;
//   - `${{ }}` in a `path:` is not resolvable at parse time at all;
//   - `$GITHUB_STEP_SUMMARY` and `::notice::` publish to the run page and the
//     Checks API and appear in no `path:` list;
//   - a reusable workflow (`jobs.<id>.uses`) moves every step somewhere this
//     parser never looks.
//
// So the scope is INVERTED: a fixed allowlist of literal paths and pinned
// actions, and anything else is a named failure. `run:` exfiltration is still
// outside what any parser can close — AGENTS.md says so rather than implying
// otherwise — but a `uses:` allowlist IS closable by a parser, and leaving it to
// review would be choosing to be weaker than necessary.
//
// WHY `playwright-report/` IS NOT ON THE LIST — this is FINDING 3, and it is
// measured, not theoretical. `playwright/lib/runner/index.js:3704-3712`
// (`_writeReportData`) appends to `playwright-report/index.html`:
//
//     <template id="playwrightReportBase64">data:application/zip;base64,…</template>
//
// which decodes (magic `504b0304`) to a ZIP of the whole report dataset. On a
// failing run its members carry the error messages, the step titles and
// subtitles — F13's channel — and the attachment bodies. `redact-artifacts.sh`
// runs perl over index.html as TEXT, so it rewrites the plaintext and cannot
// touch the base64 payload, and it unpacks `*.zip` FILES only.
// `sweep-artifacts.sh` greps raw bytes and cannot decode base64 either.
// Measured on a failing probe run: three planted markers — a scheme-less signed
// URL, a typed password and an assertion's received value — live inside that
// template, invisible to a raw grep, and STILL LIVE after the shipped redactor
// reported `OK: redacted … 23 file(s) and 2 archive(s)`. So every "0 live
// queries" measurement this repository has recorded was made with a search blind
// to this file.
//
// Re-encoding it would be a fifth URL-shape prediction after four rounds. It is
// dropped from the upload instead. Nothing diagnostic is lost: `test-results/`
// still holds `trace.zip`, the screenshot, the video and `error-context.md`, and
// `npx playwright show-trace test-results/<test>/trace.zip` opens the trace
// without the HTML report at all. `playwright-report/data/` was a second,
// byte-identical copy of the same traces, so dropping it removes a duplicate
// rather than a capability.
const ALLOWED_UPLOAD_PATHS = new Set([
  "test-results/",
  "playwright-report/results.json",
  "playwright-browsers.txt",
  // NOTHING IS ALLOWLISTED BEFORE IT EXISTS. An earlier draft carried
  // `e2e-failure-summary/` here for the authenticated lane, which is a different
  // pull request: an allowlist entry for a path no step produces is a hole held
  // open for a future commit, and default-deny means the entry lands with the
  // step that writes it.
]);

/** Actions this workflow may use, at the exact SHA each is pinned to. */
const ALLOWED_USES = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]);

const GLOB_METACHARACTERS = /[*?[\]!]/;

/** Artifacts are retained for at most this many days — FINDING 19. */
const MAX_RETENTION_DAYS = 3;

const allJobs = Object.entries(workflow?.jobs ?? {});
if (allJobs.length === 0) add("the workflow declares no jobs at all.");

for (const [jobId, jobNode] of allJobs) {
  // (c) a reusable workflow moves every step out of this parser's sight.
  if (jobNode && typeof jobNode === "object" && "uses" in jobNode) {
    add(
      `job \`${jobId}\` is a REUSABLE WORKFLOW (\`uses:\`). Every step it runs is outside this ` +
        "guard, including anything that uploads. Inline the steps or the upload scope is not " +
        "knowable here.",
    );
    continue;
  }

  const jobSteps = Array.isArray(jobNode?.steps) ? jobNode.steps : [];
  jobSteps.forEach((step, index) => {
    const where = `job \`${jobId}\` step ${index + 1}${step?.name ? ` (${step.name})` : ""}`;

    // (b) the `uses:` allowlist. This catches `actions/cache`, composite actions,
    //     and any third-party action, pinned or not.
    const uses = typeof step?.uses === "string" ? step.uses.trim() : "";
    if (uses !== "" && !ALLOWED_USES.has(uses)) {
      add(
        `${where} uses \`${uses}\`, which is not on this workflow's pinned action allowlist. ` +
          "Every action that runs here can read the workspace and publish from it — " +
          "`actions/cache` writes a blob other runs in this repository can read, and matches " +
          "neither `upload` nor `artifact`. Adding an action is a reviewed change to " +
          "ALLOWED_USES in scripts/ci/check-e2e-lane.mjs.",
      );
    }

    // (d) $GITHUB_STEP_SUMMARY publishes to the run page and the Checks API and
    //     is in no `path:` list.
    const runScript = typeof step?.run === "string" ? step.run : "";
    if (runScript.includes("GITHUB_STEP_SUMMARY")) {
      add(
        `${where} writes to \`$GITHUB_STEP_SUMMARY\`, which publishes to the run page and the ` +
          "Checks API without appearing in any `path:` list. Nothing here needs one.",
      );
    }

    if (uses === "" || !UPLOADER.test(uses)) return;

    const withNode = step?.with ?? {};

    // (e) hidden files. VERIFIED at the pinned SHA rather than assumed: reading
    //     `action.yml` out of the GitHub contents API at
    //     ea165f8d65b6e75b540449e92b4886f43607fa02 gives
    //     `include-hidden-files: … default: 'false'`. That default is the only
    //     reason `test-results/.last-run.json` is not published today.
    const hidden = withNode["include-hidden-files"];
    if (hidden !== undefined && String(hidden).trim() !== "false") {
      add(
        `${where} sets \`include-hidden-files: ${String(hidden)}\`. The pinned action defaults it ` +
          "to false (confirmed in its own action.yml at the pinned SHA), which is what keeps " +
          "dot-directories such as `.vizra-e2e` out of an artifact even when a path would reach " +
          "them. It must stay absent or false.",
      );
    }

    // (j) retention ceiling — FINDING 19.
    const retention = withNode["retention-days"];
    if (retention === undefined) {
      add(`${where} sets no \`retention-days\`, so it inherits the repository default (up to 90 days).`);
    } else if (!Number.isInteger(Number(retention)) || Number(retention) > MAX_RETENTION_DAYS) {
      add(
        `${where} sets \`retention-days: ${String(retention)}\`, above the ceiling of ` +
          `${MAX_RETENTION_DAYS}. An artifact nobody downloaded in three days is an artifact ` +
          "nobody needed, and it stays readable by every collaborator on this private " +
          "repository until it expires.",
      );
    }

    // (a) every path entry is a LITERAL from the allowlist.
    const rawPath = withNode.path;
    if (rawPath === undefined) {
      add(`${where} is an uploader with no \`path:\`.`);
      return;
    }
    const entries = String(rawPath)
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (entries.length === 0) {
      add(`${where} has an empty \`path:\`.`);
    }
    for (const entry of entries) {
      if (entry.includes("${{")) {
        add(
          `${where} has the path \`${entry}\`, which contains a \`\${{ }}\` expression. What it ` +
            "resolves to is not knowable here, so it cannot be shown to stay inside the " +
            "allowlist.",
        );
      } else if (GLOB_METACHARACTERS.test(entry)) {
        add(
          `${where} has the path \`${entry}\`, which contains a glob or exclusion metacharacter. ` +
            "A glob cannot be disproved to reach a secret directory, so only literal paths are " +
            "allowed here.",
        );
      } else if (entry === "." || entry === ".." || entry.startsWith("../")) {
        add(`${where} has the path \`${entry}\`, which is the workspace or above it.`);
      } else if (!ALLOWED_UPLOAD_PATHS.has(entry)) {
        add(
          `${where} uploads \`${entry}\`, which is not on the allowlist ` +
            `(${[...ALLOWED_UPLOAD_PATHS].join(", ")}). Adding a path is a reviewed change to ` +
            "ALLOWED_UPLOAD_PATHS in scripts/ci/check-e2e-lane.mjs — in particular " +
            "`playwright-report/index.html` carries a base64-embedded ZIP of the whole report " +
            "dataset that no redactor here can reach.",
        );
      }
    }
  });
}

// (f) `.vizra-e2e` — which holds the per-run stamp key — must appear in no
//     `path:` of ANY workflow, not just this one. A deny-list sweep across files,
//     cheap, and the one place where checking a single file would be the wrong
//     shape.
const SECRET_DIR = ".vizra-e2e";
try {
  const workflowDir = path.join(repoRoot, ".github", "workflows");
  const files = readdirSync(workflowDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  if (files.length === 0) add(".github/workflows contains no workflow files; this check cannot be made.");
  for (const name of files) {
    let other;
    try {
      other = parse(readFileSync(path.join(workflowDir, name), "utf8"));
    } catch (error) {
      add(`.github/workflows/${name} could not be parsed (${error instanceof Error ? error.message : String(error)}).`);
      continue;
    }
    for (const [jobId, jobNode] of Object.entries(other?.jobs ?? {})) {
      for (const step of Array.isArray(jobNode?.steps) ? jobNode.steps : []) {
        const candidate = step?.with?.path;
        if (candidate !== undefined && String(candidate).includes(SECRET_DIR)) {
          add(
            `.github/workflows/${name}, job \`${jobId}\`, names \`${SECRET_DIR}\` in a \`path:\`. ` +
              "That directory holds the per-run stamp key and every file the harness writes for " +
              "its own use; it must never be published by any workflow.",
          );
        }
      }
    }
  }
} catch (error) {
  add(
    `.github/workflows could not be read (${error instanceof Error ? error.message : String(error)}), ` +
      `so the ${SECRET_DIR} deny-list sweep could not be made.`,
  );
}

// ===========================================================================
// WHAT `npm run e2e` ACTUALLY EXPANDS TO — the seat's FINDING 9.
//
// This guard's strongest assertion is that one step's `run` is EXACTLY
// `npm run e2e`. What that expands to lives in package.json, which the guard
// never opened. `playwright test --trace on --output test-results` is a one-word
// edit to a file no gate reads, and it re-enables every recorder and redirects
// where they are written. So the scripts are pinned byte-for-byte.
const REQUIRED_SCRIPTS = {
  e2e: "playwright test",
  "e2e:install": "playwright install chromium",
  "e2e:demos": "bash scripts/e2e/demonstrate.sh",
};
try {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const scripts = manifest?.scripts ?? {};
  for (const [name, expected] of Object.entries(REQUIRED_SCRIPTS)) {
    const actual = scripts[name];
    if (actual !== expected) {
      add(
        `package.json's \`scripts.${name}\` is ${JSON.stringify(actual)}, and must be exactly ` +
          `${JSON.stringify(expected)}. A flag added here is invisible to every other check: ` +
          "`--trace on` re-enables the recorders, `--output` moves where they are written, " +
          "`--config` runs a different configuration entirely, and `--reporter` can add one " +
          "that embeds what the others do not.",
      );
    }
  }

  // AND `npm run e2e` IS NOT ONE SCRIPT. It is `pree2e && e2e && poste2e`, and
  // the check above read one third of it. An independent verifier added
  //
  //     "pree2e": "playwright test --trace on --output test-results"
  //
  // and measured the guard at exit 0 while npm ran it — a second Playwright
  // invocation with every recorder on, writing into `test-results/`, which IS
  // uploaded. `poste2e` behaves the same. Pinning a script byte-for-byte while
  // leaving its lifecycle hooks unenumerated pins the third that is easiest to
  // read.
  for (const name of Object.keys(REQUIRED_SCRIPTS)) {
    for (const hook of [`pre${name}`, `post${name}`]) {
      if (Object.prototype.hasOwnProperty.call(scripts, hook)) {
        add(
          `package.json declares \`scripts.${hook}\`, which npm runs as part of \`npm run ` +
            `${name}\`. The pinned \`scripts.${name}\` is therefore only a third of what runs; a ` +
            "hook is where `--trace on --output test-results` goes with every other check still " +
            "green. Refused outright — nothing here needs a lifecycle hook.",
        );
      }
    }
  }
} catch (error) {
  add(`package.json could not be read (${error instanceof Error ? error.message : String(error)}).`);
}

// THE SHELL npm USES, and the limit of what is checked here.
//
// `.npmrc`'s `script-shell` changes the interpreter every `npm run` uses, and
// the same setting can arrive as `npm_config_script_shell` in the environment.
// The environment half is covered — `npm_config_*` is refused at every scope
// alongside the Playwright keys below. The FILE half is checked only for this
// one key, because a committed `.npmrc` is a reviewed file and enumerating
// everything npm reads from it is a different job.
//
// NOT covered, stated rather than implied: a user-level or global `.npmrc` on
// the runner, `NPM_CONFIG_*` inherited from the runner image, and anything a
// `run:` step writes into `.npmrc` before the lane. Those are the same
// unclosable `run:` class AGENTS.md already names.
try {
  const npmrcPath = path.join(repoRoot, ".npmrc");
  const npmrc = readFileSync(npmrcPath, "utf8");
  for (const line of npmrc.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const key = trimmed.split("=")[0]?.trim().toLowerCase().replace(/_/g, "-");
    if (key === "script-shell" || key === "ignore-scripts") {
      add(
        `.npmrc sets \`${key}\`, which changes how every \`npm run\` in this lane is executed. ` +
          "The lane guard pins what the scripts SAY; this would change what running them means.",
      );
    }
  }
} catch {
  // No `.npmrc` is the normal case and is not a failure.
}

// The EFFECTIVE value, computed across all three scopes — not "is it present
// somewhere". An independent verifier walked through the first version with one
// line (mutation F7):
//
//     - name: Browser lane (desktop 1440, mobile 390)
//       env:
//         E2E_BASE_URL: http://127.0.0.1:3000
//         PLAYWRIGHT_NO_COPY_PROMPT: ""        # <- added
//       run: npm run e2e
//
// `bash scripts/ci/check-e2e-lane.sh` -> exit 0. A STEP-level `env:` overrides
// the job's in GitHub Actions, and Playwright gates on TRUTHINESS, not presence
// (`playwright/lib/index.js:657-659`): `""` is falsy, so the page snapshot came
// back — the verifier measured it returning with a `page.fill` value verbatim.
// ("0" is truthy and would still suppress, which is exactly why "is it set" is
// the wrong question.) The old check read `laneJob.env` alone and separately
// EXEMPTED this key from the `PLAYWRIGHT_*` refusal, so a step-level entry was
// neither required-to-be-"1" nor refused. AGENTS.md published "asserts it is
// set"; for that edit it did not.
//
// So: the key must appear EXACTLY ONCE, at job level, with the literal "1", and
// nowhere else at any scope. That is simpler to state, simpler to test, and has
// no shape where the guard is green and the variable is not "1".
const PAGE_SNAPSHOT_KEY = "PLAYWRIGHT_NO_COPY_PROMPT";
const PAGE_SNAPSHOT_VALUE = "1";
/** Refused at EVERY scope: workflow, job and step. */
const REFUSED_ENV = new Set(["DEBUG", "PWDEBUG", "NODE_DEBUG", "NODE_OPTIONS"]);

const laneJob = workflow?.jobs?.e2e;
const workflowEnv = workflow?.env ?? {};
const jobEnv = laneJob?.env ?? {};
const laneSteps = Array.isArray(laneJob?.steps) ? laneJob.steps : [];

// All THREE scopes. The workflow-level block was unread, so `DEBUG: pw:api`
// beside `permissions:` was green while the same key at job or step level was
// red (the verifier's mutation F3) — one env rule with a hole in one third of
// its surface.
const envScopes = [
  ["the workflow", workflowEnv],
  ["the `e2e` job", jobEnv],
  ...laneSteps.map((step, index) => [
    `step ${index + 1}${step?.name ? ` (${step.name})` : ""}`,
    step?.env && typeof step.env === "object" ? step.env : {},
  ]),
];

const snapshotSightings = [];
for (const [scope, env] of envScopes) {
  for (const [key, value] of Object.entries(env)) {
    if (key === PAGE_SNAPSHOT_KEY) {
      snapshotSightings.push({ scope, value });
      continue;
    }
    const lowered = key.toLowerCase();
    if (
      REFUSED_ENV.has(key) ||
      key.startsWith("PLAYWRIGHT_") ||
      key.startsWith("PW_") ||
      lowered.startsWith("npm_config_")
    ) {
      add(
        `${scope} sets \`${key}\`, which is refused in this lane at every scope. Playwright's ` +
          "debug channels write request headers, `fill` values and protocol frames to stdout, " +
          "and stdout is the GitHub log — streamed as it is written, so nothing can redact it " +
          `afterwards. The one permitted \`PLAYWRIGHT_*\` key is \`${PAGE_SNAPSHOT_KEY}\`, at ` +
          "job level only.",
      );
    }
  }
}

if (snapshotSightings.length === 0) {
  add(
    `the \`e2e\` job does not set \`${PAGE_SNAPSHOT_KEY}: "${PAGE_SNAPSHOT_VALUE}"\` at job ` +
      "level. Without it Playwright writes a `# Page snapshot` into " +
      "`test-results/**/error-context.md` — an aria snapshot of the live page carrying every " +
      "DOM text node and every input's current value — and that file is written even with " +
      "trace, screenshot and video all off.",
  );
} else {
  for (const { scope, value } of snapshotSightings) {
    if (scope !== "the `e2e` job") {
      add(
        `${scope} also sets \`${PAGE_SNAPSHOT_KEY}\`. It may appear at JOB level and nowhere ` +
          "else: a step-level `env:` OVERRIDES the job's, and Playwright gates on truthiness, " +
          `so \`${PAGE_SNAPSHOT_KEY}: ""\` at step level silently restores the page snapshot ` +
          "while this guard stays green. That is the exact shape an independent verifier " +
          "walked through (FINDING 2 of the PR #8 review).",
      );
    } else if (String(value) !== PAGE_SNAPSHOT_VALUE) {
      add(
        `the \`e2e\` job sets \`${PAGE_SNAPSHOT_KEY}: ${JSON.stringify(value)}\`, and it must be ` +
          `exactly "${PAGE_SNAPSHOT_VALUE}". Playwright gates on truthiness, so "" restores the ` +
          'page snapshot; "0" happens to suppress it, which is precisely why "is it set" is not ' +
          "the question this guard asks.",
      );
    }
  }
}

// AND A `run:` SCRIPT CAN UNSET IT. The env maps above are the declarative half;
// a shell line in the same job is the other half, and it is not closed by any of
// them. These four spellings are refused by NAME — `unset`, an empty `export`,
// `env -u`, and a per-command `VAR= cmd` prefix.
//
// This is a GREP over `run:` text, and that is all it is: a script can compute
// the variable name, source another file, or write the value from a here-doc,
// and none of that is refused. § Residuals says so. The point of the four is
// that the spellings someone would actually reach for are named rather than
// silent, not that the class is closed — the class cannot be closed by a parser,
// which is the same sentence AGENTS.md already carries for `run:` exfiltration.
const UNSET_SHAPES = [
  [new RegExp(`\\bunset\\s+(-v\\s+)?${PAGE_SNAPSHOT_KEY}\\b`), "`unset`"],
  [new RegExp(`\\bexport\\s+${PAGE_SNAPSHOT_KEY}\\s*=\\s*(?=$|[\\s;&|])`, "m"), "an empty `export`"],
  [new RegExp(`\\benv\\s+(-[^\\s]*\\s+)*-u\\s+${PAGE_SNAPSHOT_KEY}\\b`), "`env -u`"],
  [new RegExp(`(^|[;&|(]\\s*)${PAGE_SNAPSHOT_KEY}=\\s`, "m"), "a `VAR= cmd` prefix"],
];
laneSteps.forEach((step, index) => {
  const runScript = typeof step?.run === "string" ? step.run : "";
  if (runScript === "") return;
  for (const [pattern, described] of UNSET_SHAPES) {
    if (pattern.test(runScript)) {
      add(
        `step ${index + 1}${step?.name ? ` (${step.name})` : ""} removes \`${PAGE_SNAPSHOT_KEY}\`` +
          ` from the environment with ${described}. The job-level value is the control that keeps` +
          " the live page's aria snapshot out of `error-context.md`; a `run:` line that clears it" +
          " is the same defect as a step-level empty value, one layer down.",
      );
    }
  }
});

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
