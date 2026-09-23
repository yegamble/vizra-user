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
 * `npm run e2e || true`. So the workflow is PARSED — and since PR #8 round 3,
 * every step this guard relies on is PINNED rather than recognised:
 *
 *   1. the `e2e` job exists, is not disabled, does not hide its result, runs on
 *      `ubuntu-24.04`, and declares no key outside an allowlist (`defaults:`,
 *      `container:` … change what every `run:` does without changing its bytes);
 *   2. NINE STEPS ARE PINNED BYTE-FOR-BYTE in `.github/e2e-pinned-steps.yml` —
 *      the image build, the fixture-free check, the container start, the lane
 *      (`npm run e2e`), the coverage floor, the harness canary, the browser
 *      revision, the redaction/upload gate and the upload. Each must appear
 *      EXACTLY ONCE, deep-equal to its pin, with no key the pin lacks. This
 *      replaced a substring match: `run.includes("redact-artifacts.sh")` accepted
 *      `… || true`, `echo redact-artifacts.sh` and six other spellings that left
 *      the upload gate open (R3-FINDING H);
 *   3. a step ANYWHERE in the workflow that mentions a pinned role's token but is
 *      not its pin is refused by name, so the real step cannot sit beside a
 *      laundered copy;
 *   4. the pins file itself must satisfy the policy (exact `run:` of the lane,
 *      floor, canary, fixture check and redaction; the upload's gate, paths,
 *      retention and `if-no-files-found: error`; the lane's port is the one the
 *      container publishes), so editing the pin and the workflow together is a
 *      named failure rather than a way round the check;
 *   5. ORDER: image built, proved fixture-free and started before the lane;
 *      floor and canary after it; the redaction after all three; the upload
 *      IMMEDIATELY after the redaction;
 *   6. env is DEFAULT-DENY: nothing at workflow level, only
 *      `PLAYWRIGHT_NO_COPY_PROMPT: "1"` at job level, nothing on an unpinned
 *      step — `BASH_ENV`, `PATH` and `HOME` change what a pinned body does;
 *   7. upload scope is an allowlist across every job; `uses:` is a pinned
 *      allowlist; no reusable workflow; no runner command files; no merge keys;
 *   8. nothing starts a development server, and nothing sets
 *      `E2E_COVERAGE_FLOOR` or `VIZRA_E2E_STAMP_KEY`;
 *   9. the workflow triggers on `pull_request` and `merge_group`;
 *  10. the harness keeps its guard AND its runtime stamp, read from a PARSED
 *      TypeScript tree, and `playwright.config.ts` keeps the lines the stamp
 *      depends on.
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

/**
 * THE PINNED STEPS — `.github/e2e-pinned-steps.yml`.
 *
 * This guard used to IDENTIFY the steps it relies on by substring:
 * `run.includes("redact-artifacts.sh")`, `includes("docker build")`,
 * `includes(FLOOR_COMMAND)`, a `--publish` regex over any step, an `upload|artifact`
 * regex over `uses:`. A step that MENTIONS a script is not a step that RUNS it,
 * and an independent verifier showed eight guard-green spellings of the redaction
 * step alone (PR #8, R3-FINDING H) — `… || true`, `…; exit 0`, `set +e; …; true`,
 * a redirect and `|| echo`, a mistyped directory, a dropped `playwright-report`,
 * `/tmp/empty`, and `echo redact-artifacts.sh` — each leaving
 * `steps.redact.outcome == 'success'`, so the upload gated on it published with no
 * URL redaction and no page-snapshot gate. The lane and the canary matched their
 * `run:` exactly, but every OTHER key only through a list of refusals, and a list
 * is what `working-directory:` or `timeout-minutes:` walk past.
 *
 * So identification is EXACT and the control is inverted, as vizra-core did for
 * its make steps: every step below must be DEEP-EQUAL to its pin (keys and
 * values, `name` included, `run` byte for byte after trimming one trailing
 * newline), exactly once; a step that MENTIONS a pinned role's token but is not
 * its pin is refused by name anywhere in the workflow; and the invariants each pin
 * must satisfy are asserted on the pins file itself, so weakening the pin is a
 * named failure too. Substring and regex tests survive below only in the REFUSAL
 * direction — they decide that a step must be a pin, never that it is one.
 */
const PINS_FILE = ".github/e2e-pinned-steps.yml";

/** The one command the lane may run. Documented in AGENTS.md as `npm run e2e`. */
const LANE_COMMAND = "npm run e2e";
/** The step that re-checks the floor from outside the Playwright process. */
const FLOOR_COMMAND = "node scripts/ci/check-coverage-floor-ran.mjs";
/**
 * The harness's own self-test. Without it, neutering the browser-error guard
 * while leaving its identifiers in place is SILENT in CI — `npm run test` exits
 * 0, the harness check at the bottom of this file is string-presence only, and
 * the lane exits 0 because a guard that has stopped looking finds nothing to
 * fail on.
 */
const CANARY_COMMAND = "node scripts/ci/harness-canary.mjs";
const FIXTURE_COMMAND = "bash scripts/ci/check-no-test-fixtures-in-image.sh vizra-user:e2e";
/**
 * The one pinned step whose OUTPUT is uploaded from outside the directories the
 * redactor reads (`playwright-browsers.txt`). Asserted exactly like the other
 * literal commands — without it, editing the pin and the workflow together to
 * append anything to that file passed (PR #8 closing round, FINDING V-C).
 */
const RECORD_BROWSERS_COMMAND = [
  "set -euo pipefail",
  "npx playwright --version",
  "npx playwright install --dry-run chromium | tee playwright-browsers.txt",
].join("\n");
/**
 * The redaction AND the page-snapshot upload gate. Both directories: `results.json`
 * is uploaded and lives in `playwright-report/`. The script itself refuses a
 * directory that does not exist (exit 3), so no argument can empty the gate.
 */
const REDACT_COMMAND = "bash scripts/ci/redact-artifacts.sh test-results playwright-report";
/** The one uploader, at the one SHA it is pinned to. */
const UPLOAD_ACTION = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const UPLOAD_GATE = "failure() && steps.redact.outcome == 'success'";
const RUNNER = "ubuntu-24.04";

/**
 * The roles, in the order they must run, with the tokens that make a step a
 * CLAIMANT to the role. Tokens are the refusal direction only: a step carrying one
 * must BE a pin whose role lists that token, or it is refused by name.
 */
const ROLES = [
  { role: "build_image", keys: ["name", "run"], what: "builds the production image" },
  { role: "fixture_free", keys: ["name", "run"], what: "proves the image fixture-free" },
  { role: "start_image", keys: ["name", "run"], what: "starts the built image" },
  { role: "lane", keys: ["name", "env", "run"], what: "runs the browser lane" },
  { role: "floor", keys: ["name", "run"], what: "re-checks the coverage floor" },
  { role: "canary", keys: ["name", "env", "run"], what: "runs the harness canary" },
  { role: "record_browsers", keys: ["name", "run"], what: "records the browser revision" },
  { role: "redact", keys: ["name", "id", "if", "run"], what: "redacts and gates the artifacts" },
  { role: "upload", keys: ["name", "if", "uses", "with"], what: "uploads the artifacts" },
];
const ROLE_NAMES = ROLES.map((entry) => entry.role);

/** [pattern over the serialised step, human description, roles it claims]. */
const MENTIONS = [
  [/\bdocker\s+(?:buildx\b|build\b|image\s+build\b)/, "a `docker build`", ["build_image"]],
  [/check-no-test-fixtures-in-image/, "`check-no-test-fixtures-in-image.sh`", ["fixture_free"]],
  [/\bdocker\s+(?:container\s+)?(?:run|create)\b/, "a `docker run`", ["start_image"]],
  [/\bnpm\s+(?:run|run-script)\s+e2e(?![\w:-])/, "`npm run e2e`", ["lane"]],
  [/\bplaywright\s+test\b/, "`playwright test`", ["lane"]],
  [/E2E_BASE_URL/, "`E2E_BASE_URL`", ["lane", "canary"]],
  [/check-coverage-floor-ran/, "`check-coverage-floor-ran.mjs`", ["floor"]],
  [/harness-canary/, "`harness-canary.mjs`", ["canary"]],
  [/playwright-browsers\.txt/, "`playwright-browsers.txt`", ["record_browsers", "upload"]],
  [/redact-artifacts/, "`redact-artifacts.sh`", ["redact"]],
  [/test-results|playwright-report/, "an artifact directory", ["redact", "upload"]],
  [/steps\.redact\b/, "`steps.redact`", ["upload"]],
];
/** Applied to `uses:` alone: anything that looks like it publishes must BE the pinned upload. */
const UPLOADER_MENTION = /(^|\/)[\w.-]*(upload|artifact)[\w.-]*@/i;

/**
 * What a difference in a given field MEANS, per role, so a refusal says why
 * rather than only that the bytes differ. `*` is the fallback for the role.
 */
const HINTS = {
  lane: {
    run:
      `its \`run:\` must be exactly \`${LANE_COMMAND}\` — a superstring such as ` +
      "`npm run e2e || true` launders the exit code",
    if: "the browser lane must run unconditionally on every pull request",
    "continue-on-error": "`continue-on-error` would make a red lane report success",
    "env.E2E_BASE_URL":
      "its E2E_BASE_URL does not match any port a `docker run --publish` step in this job exposes " +
      "as pinned; the lane may not be driving the built image",
    env: "any other env key on the lane step changes what `npm run e2e` does",
  },
  canary: {
    run: `its \`run:\` must be exactly \`${CANARY_COMMAND}\`; anything else launders the exit code`,
    if:
      "the harness-canary step carries an `if:`. A conditional self-test is one expression away " +
      "from never running, and its absence is invisible in a green lane",
    "continue-on-error": "the harness-canary step sets `continue-on-error`, so a neutered guard would report success",
    "env.E2E_BASE_URL": "its E2E_BASE_URL does not match any port a `docker run --publish` step in this job exposes",
  },
  floor: {
    run: `its \`run:\` must be exactly \`${FLOOR_COMMAND}\`; anything else launders the exit code`,
    if: "the coverage-floor step is conditional or continues on error",
    "continue-on-error": "the coverage-floor step is conditional or continues on error",
  },
  redact: {
    run:
      `the redaction step's \`run:\` must be exactly \`${REDACT_COMMAND}\`. \`|| true\`, \`; exit 0\`, ` +
      "`set +e`, a redirect with `|| echo`, a mistyped or dropped directory and `echo` each leave " +
      "`steps.redact.outcome == 'success'` with the page-snapshot gate never run or its verdict " +
      "discarded, and the upload gated on it then publishes",
    id: "the redaction step has no `id:` (or a different one), so the upload step cannot be gated on whether it succeeded",
    "continue-on-error":
      "the redaction step sets `continue-on-error`, which would report `success` however it exited — " +
      "the gate below would then always open",
    if: "the redaction step must run exactly `if: failure()` — the only condition under which anything uploads",
  },
  upload: {
    if:
      `it is not gated on \`${UPLOAD_GATE}\` — not gated on the redaction having SUCCEEDED. With two ` +
      "bare `failure()` conditions a redactor that exits non-zero still lets the unredacted tree be " +
      "published, and a SECOND upload step publishes it even when the first one is correctly skipped",
    uses: `the only uploader is \`${UPLOAD_ACTION}\``,
    "with.if-no-files-found":
      "it does not set `if-no-files-found: error`. This step only runs on failure, so a wrong path " +
      "would be a warning nobody ever reads",
    "with.path": "its `path:` must be exactly the pinned allowlist of literal paths",
    "with.retention-days": "its `retention-days` must be the pinned value, at or under the ceiling",
    "with.include-hidden-files": "`include-hidden-files` must stay absent",
  },
};

const workflowPath = process.argv[2] ?? ".github/workflows/e2e.yml";
const problems = [];
const add = (message) => problems.push(message);

let workflow;
try {
  workflow = parse(readFileSync(path.resolve(repoRoot, workflowPath), "utf8"), { uniqueKeys: true });
} catch (error) {
  console.error(
    `::error::e2e-lane guard: could not parse ${workflowPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

let pins = {};
try {
  const document = parse(readFileSync(path.join(repoRoot, PINS_FILE), "utf8"), { uniqueKeys: true });
  pins = document?.steps && typeof document.steps === "object" ? document.steps : {};
} catch (error) {
  console.error(
    `::error::e2e-lane guard: could not read the pinned steps ${PINS_FILE}: ` +
      `${error instanceof Error ? error.message : String(error)}. Nothing can be compared with ` +
      "nothing; this check is BLOCKED, not passed.",
  );
  process.exit(2);
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

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `run` is compared after trimming AT MOST ONE trailing newline — a block scalar keeps one. */
function normaliseStep(step) {
  if (!isObject(step)) return step;
  if (typeof step.run !== "string") return step;
  return { ...step, run: step.run.endsWith("\n") ? step.run.slice(0, -1) : step.run };
}

/** Key-order-independent serialisation, so deep equality is string equality. */
function canonical(value) {
  return JSON.stringify(value, (_key, inner) =>
    isObject(inner) ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner,
  );
}

const pinCanon = Object.fromEntries(
  Object.entries(pins).map(([role, body]) => [role, canonical(normaliseStep(body))]),
);
const isPin = (step, role) => pinCanon[role] !== undefined && canonical(normaliseStep(step)) === pinCanon[role];

/** Field paths where `step` differs from the pin — one level into `env` and `with`. */
function differences(step, pin) {
  const out = [];
  const a = isObject(step) ? normaliseStep(step) : {};
  const b = isObject(pin) ? normaliseStep(pin) : {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((key === "env" || key === "with") && (isObject(a[key]) || isObject(b[key]))) {
      const left = isObject(a[key]) ? a[key] : {};
      const right = isObject(b[key]) ? b[key] : {};
      for (const inner of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (canonical(left[inner]) !== canonical(right[inner])) {
          const state = !(inner in right) ? "not in the pin" : !(inner in left) ? "missing" : "differs";
          out.push({ field: `${key}.${inner}`, top: key, state });
        }
      }
      continue;
    }
    if (canonical(a[key]) !== canonical(b[key])) {
      const state = !(key in b) ? "not in the pin" : !(key in a) ? "missing" : "differs";
      out.push({ field: key, top: key, state });
    }
  }
  return out;
}

function describeDifferences(role, diffs) {
  const listed = diffs.map((diff) => `\`${diff.field}\` ${diff.state}`).join(", ");
  const hints = [];
  for (const diff of diffs) {
    const hint = HINTS[role]?.[diff.field] ?? HINTS[role]?.[diff.top];
    if (hint && !hints.includes(hint)) hints.push(hint);
  }
  return `${listed}${hints.length > 0 ? ` — ${hints.join("; ")}` : ""}`;
}

// --- the pins file itself: the invariants each pin must satisfy ------------
//
// The workflow must equal the pins; the pins must equal the policy. Without the
// second half this file would move the weakness rather than remove it: a pull
// request that changed the workflow's redaction step to `|| true` and made the
// same change here would be deep-equal and green.
{
  const where = (role) => `${PINS_FILE}: the \`${role}\` pin`;
  for (const role of Object.keys(pins)) {
    if (!ROLE_NAMES.includes(role)) {
      add(`${PINS_FILE} declares a pin \`${role}\` this guard has no rule for; an unread pin is not a control.`);
    }
  }
  for (const { role, keys } of ROLES) {
    const pin = pins[role];
    if (!isObject(pin)) {
      add(`${where(role)} is missing. Every step this guard relies on is pinned; see the file's header.`);
      continue;
    }
    for (const key of Object.keys(pin)) {
      if (!keys.includes(key)) {
        add(`${where(role)} carries \`${key}\`, and may carry only ${keys.map((k) => `\`${k}\``).join(", ")}.`);
      }
    }
    if (typeof pin.name !== "string" || pin.name.trim() === "" || pin.name.includes("${{")) {
      add(`${where(role)} has no literal \`name\`.`);
    }
  }
  const run = (role) => (isObject(pins[role]) && typeof pins[role].run === "string" ? normaliseStep(pins[role]).run : "");
  for (const [role, command] of [
    ["lane", LANE_COMMAND],
    ["floor", FLOOR_COMMAND],
    ["canary", CANARY_COMMAND],
    ["fixture_free", FIXTURE_COMMAND],
    ["record_browsers", RECORD_BROWSERS_COMMAND],
    ["redact", REDACT_COMMAND],
  ]) {
    if (isObject(pins[role]) && run(role) !== command) {
      add(`${where(role)} runs \`${run(role)}\`, and must run exactly \`${command}\`.`);
    }
  }
  if (isObject(pins.start_image) && !/\bdocker run\b/.test(run("start_image"))) {
    add(`${where("start_image")} does not \`docker run\` the image.`);
  }
  if (isObject(pins.build_image) && !/^docker build\b/.test(run("build_image"))) {
    add(`${where("build_image")} does not \`docker build\` the image.`);
  }
  // The lane and the canary drive the container the start step publishes.
  const port = /--publish\s+(\d+):/.exec(run("start_image"))?.[1];
  for (const role of ["lane", "canary"]) {
    const pin = pins[role];
    if (!isObject(pin)) continue;
    const env = isObject(pin.env) ? pin.env : {};
    const keys = Object.keys(env);
    if (keys.length !== 1 || keys[0] !== "E2E_BASE_URL") {
      add(`${where(role)} must set exactly one env key, \`E2E_BASE_URL\`; it sets ${JSON.stringify(keys)}.`);
    }
    const url = typeof env.E2E_BASE_URL === "string" ? env.E2E_BASE_URL : "";
    if (port === undefined || !new RegExp(`^http://127\\.0\\.0\\.1:${port}$`).test(url)) {
      add(
        `${where(role)}'s E2E_BASE_URL (${url || "unset"}) does not match any port a \`docker run --publish\` ` +
          "step in this job exposes; the lane may not be driving the built image.",
      );
    }
  }
  if (isObject(pins.redact)) {
    if (pins.redact.id !== "redact") add(`${where("redact")} must have \`id: redact\`, which the upload gate names.`);
    if (pins.redact.if !== "failure()") add(`${where("redact")} must run exactly \`if: failure()\`.`);
  }
  if (isObject(pins.upload)) {
    const upload = pins.upload;
    if (upload.uses !== UPLOAD_ACTION) add(`${where("upload")} must use \`${UPLOAD_ACTION}\`.`);
    if (upload.if !== UPLOAD_GATE) {
      add(`${where("upload")} is not gated on the redaction having SUCCEEDED: it must read \`if: ${UPLOAD_GATE}\`.`);
    }
    const inputs = isObject(upload.with) ? upload.with : {};
    if (inputs["if-no-files-found"] !== "error") add(`${where("upload")} does not set \`if-no-files-found: error\`.`);
    if ("include-hidden-files" in inputs) add(`${where("upload")} sets \`include-hidden-files\`; it must stay absent.`);
    const retention = Number(inputs["retention-days"]);
    if (!Number.isInteger(retention) || retention < 1 || retention > 3) {
      add(`${where("upload")} sets \`retention-days: ${String(inputs["retention-days"])}\`; the ceiling is 3.`);
    }
    const entries = String(inputs.path ?? "")
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (!entries.includes("test-results/")) add(`${where("upload")} no longer includes \`test-results/\`.`);
    for (const entry of entries) {
      if (!["test-results/", "playwright-report/results.json", "playwright-browsers.txt"].includes(entry)) {
        add(`${where("upload")} uploads \`${entry}\`, which is not on the path allowlist.`);
      }
    }
  }
}

// --- the workflow's shape: default-deny around the pinned bodies -----------
//
// A byte-equal body is only the same program if it runs in the same place.
// `defaults.run.shell: bash -c '{0} || true'` discards the exit status of every
// `run:` in the job; `defaults.run.working-directory` runs them against another
// package.json; `container:` moves them into an image this repository does not
// describe; a self-hosted `runs-on` brings a machine whose `~/.npmrc` and PATH
// nobody reviewed. None of them changes a byte of any pinned step.
const WORKFLOW_KEYS = new Set(["name", "run-name", "on", "true", "permissions", "concurrency", "jobs", "env"]);
for (const key of Object.keys(isObject(workflow) ? workflow : {})) {
  if (!WORKFLOW_KEYS.has(key)) {
    add(
      `the workflow declares \`${key}:\` at top level, which is not on this guard's allowlist ` +
        `(${[...WORKFLOW_KEYS].filter((k) => k !== "true").join(", ")}). \`defaults:\` in particular ` +
        "changes the shell or directory every pinned `run:` executes in without changing its bytes.",
    );
  }
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

const JOB_KEYS = new Set(["name", "runs-on", "timeout-minutes", "env", "steps"]);
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
  for (const key of Object.keys(isObject(job) ? job : {})) {
    if (!JOB_KEYS.has(key)) {
      add(
        `the \`e2e\` job declares \`${key}:\`, which is not on this guard's allowlist ` +
          `(${[...JOB_KEYS].join(", ")}). \`defaults:\`, \`container:\`, \`services:\` and friends change ` +
          "what every pinned step does without changing a byte of it.",
      );
    }
  }
  if (job["runs-on"] !== RUNNER) {
    add(
      `the \`e2e\` job runs on ${JSON.stringify(job["runs-on"])}; it must run on \`${RUNNER}\` ` +
        "(ADR-009) — another runner brings its own PATH, home directory and npm configuration.",
    );
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (steps.length === 0) add("the `e2e` job has no steps.");

  // EXACT identification: a step IS a role only when it is deep-equal to the pin.
  const found = {};
  for (const role of ROLE_NAMES) {
    found[role] = steps.map((step, index) => (isPin(step, role) ? index : -1)).filter((index) => index >= 0);
  }

  const MISSING = {
    build_image: "no step builds the production image exactly as pinned, before the lane runs.",
    fixture_free:
      "no step runs `check-no-test-fixtures-in-image.sh` exactly as pinned before the lane, so the shipped " +
      "image is not proved fixture-free.",
    start_image: "no step starts the built image exactly as pinned before the lane runs.",
    lane:
      `no step runs the browser lane. Exactly one step must be byte-equal to the pinned \`lane\` step in ` +
      `${PINS_FILE} (\`run: ${LANE_COMMAND}\` and nothing else) — a superstring such as ` +
      "`npm run e2e || true` launders the exit code, and deleting the step is silent.",
    floor:
      `no step runs \`${FLOOR_COMMAND}\` exactly as pinned. The in-process coverage floor lives in ` +
      "playwright.config.ts, which this pull request can edit; the floor must also be re-checked from " +
      "the finished report.",
    canary:
      `no step runs \`${CANARY_COMMAND}\` exactly as pinned. Without it, neutering ` +
      "e2e/harness/browser-errors.ts while leaving its identifiers in place is silent: every other " +
      "check in this lane stays green, because a guard that has stopped looking finds nothing to fail on.",
    record_browsers: "no step records the browser revision exactly as pinned.",
    redact:
      `no step runs \`${REDACT_COMMAND}\` exactly as pinned (redact-artifacts.sh). Playwright's traces ` +
      "carry raw query strings that e2e/harness/redact.ts cannot reach, and the page-snapshot gate lives " +
      "in that script; uploading without it publishes both.",
    upload: "no step uploads artifacts exactly as pinned; a red lane would be undiagnosable.",
  };
  for (const role of ROLE_NAMES) {
    if (found[role].length === 0) add(MISSING[role]);
    else if (found[role].length > 1) {
      add(`${found[role].length} steps are byte-equal to the pinned \`${role}\` step; exactly one may be.`);
    }
  }

  // ORDER. Each role at its first exact match.
  const at = Object.fromEntries(ROLE_NAMES.map((role) => [role, found[role][0]]));
  const before = (a, b, message) => {
    if (at[a] !== undefined && at[b] !== undefined && !(at[a] < at[b])) add(message);
  };
  before("build_image", "lane", "the image is built AFTER the browser lane runs.");
  before("fixture_free", "lane", "the fixture-free check runs AFTER the browser lane.");
  before("build_image", "fixture_free", "the fixture-free check runs before the image it checks is built.");
  before("start_image", "lane", "the container is started AFTER the browser lane runs.");
  before("lane", "floor", "the coverage-floor step runs BEFORE the browser lane, so it would read a stale or absent report.");
  before("lane", "canary", "the harness-canary step runs BEFORE the browser lane; it must exercise the same running container.");
  before("lane", "redact", "the redaction step runs BEFORE the browser lane, so what the lane writes is never redacted.");
  before("canary", "redact", "the redaction step runs BEFORE the canary, so what the canary writes is never redacted.");
  before("floor", "redact", "the redaction step runs BEFORE the coverage-floor step.");
  before("record_browsers", "upload", "the browser revision is recorded AFTER the upload.");
  before(
    "redact",
    "upload",
    "the artifact upload runs before the redaction step: the artifacts are uploaded BEFORE they are redacted.",
  );
  if (at.redact !== undefined && at.upload !== undefined && at.upload !== at.redact + 1) {
    add(
      `the artifact upload is step ${at.upload + 1} and the redaction is step ${at.redact + 1}; the upload ` +
        "must IMMEDIATELY follow the redaction, so nothing can write into the redacted tree between them.",
    );
  }

  // Unpinned steps carry no `env` at all: default-deny. Pinned steps carry
  // exactly their pin's, which the equality above already decided.
  steps.forEach((step, index) => {
    if (ROLE_NAMES.some((role) => isPin(step, role))) return;
    if (isObject(step?.env) && Object.keys(step.env).length > 0) {
      add(
        `step ${index + 1}${step?.name ? ` (${step.name})` : ""} sets \`env:\` ` +
          `(${Object.keys(step.env).join(", ")}). A step that is not pinned may set no environment: ` +
          "the lane guard allowlists env keys, and this step's list is empty.",
      );
    }
  });

  // (8) nothing that would make the lane test the wrong thing. REFUSAL direction.
  const runOf = (step) => (typeof step?.run === "string" ? step.run.trim() : "");
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

// LOOK-ALIKES, ANYWHERE IN THE WORKFLOW. A step that mentions a pinned role's
// token and is not that role's pin is refused by name — the real step beside a
// second, laundered copy is exactly the shape a `.find()` used to accept.
for (const [jobId, jobNode] of Object.entries(isObject(workflow?.jobs) ? workflow.jobs : {})) {
  const jobSteps = Array.isArray(jobNode?.steps) ? jobNode.steps : [];
  jobSteps.forEach((step, index) => {
    if (!isObject(step)) return;
    // Every key and every scalar value, one per line, as the runner would read
    // them — not JSON, whose `\n` escapes would glue a token to the letter
    // before it and hide it from a `\b`.
    const flatten = (node) =>
      Array.isArray(node)
        ? node.flatMap(flatten)
        : isObject(node)
          ? Object.entries(node).flatMap(([key, value]) => [key, ...flatten(value)])
          : [String(node)];
    const serialised = flatten(step).join("\n");
    const claimed = new Map();
    for (const [pattern, described, roles] of MENTIONS) {
      if (pattern.test(serialised)) for (const role of roles) claimed.set(role, [...(claimed.get(role) ?? []), described]);
    }
    const uses = typeof step.uses === "string" ? step.uses.trim() : "";
    if (uses !== "" && (uses === UPLOAD_ACTION || UPLOADER_MENTION.test(uses))) {
      claimed.set("upload", [...(claimed.get("upload") ?? []), `the uploader \`${uses}\``]);
    }
    if (claimed.size === 0) return;
    const candidates = [...claimed.keys()];
    if (jobId === "e2e" && candidates.some((role) => isPin(step, role))) return;
    // Report against the closest pin, so the hints are about the step the
    // author was probably writing.
    const ranked = candidates
      .filter((role) => isObject(pins[role]))
      .map((role) => [role, differences(step, pins[role])])
      // A `uses:` step is compared with the `uses:` pin, a `run:` step with a
      // `run:` pin, before the number of differing fields is counted.
      .map(([role, diffs]) => [role, diffs, ("uses" in step) === ("uses" in pins[role]) ? 0 : 1])
      .sort((a, b) => a[2] - b[2] || a[1].length - b[1].length);
    const where = `job \`${jobId}\` step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
    const mentions = [...new Set([...claimed.values()].flat())].join(", ");
    if (ranked.length === 0) {
      add(`${where} mentions ${mentions}, and no pin exists to compare it with.`);
      return;
    }
    const [role, diffs] = ranked[0];
    add(
      `${where} mentions ${mentions} but is not byte-equal to the pinned \`${role}\` step in ${PINS_FILE}` +
        (jobId === "e2e" ? "" : " (and pinned steps belong to the `e2e` job only)") +
        `: ${describeDifferences(role, diffs)}.`,
    );
  });
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
  reporter: path.join(repoRoot, "e2e", "harness", "stamp-reporter.ts"),
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
    "assertPageSnapshotSuppressed",
    "e2e/harness/test.ts no longer CALLS `assertPageSnapshotSuppressed`, so nothing reads " +
      "PLAYWRIGHT_NO_COPY_PROMPT in the Playwright WORKER — the only place that sees the value " +
      "the recorder reads. The static checks read what the workflow DECLARES; a committed " +
      "`.npmrc` blanked the variable with every declaration still reading \"1\".",
  ],
  [
    "entry",
    "assertEnvironmentUnchanged",
    "e2e/harness/test.ts no longer CALLS `assertEnvironmentUnchanged`, so a change to CI or " +
      "PLAYWRIGHT_NO_COPY_PROMPT made in `beforeAll`, or late in the previous test, is not restored " +
      "before the next test opens a page (R3-FINDING J).",
  ],
  [
    "entry",
    "takeEnvironmentChange",
    "e2e/harness/test.ts no longer CALLS `takeEnvironmentChange`, so a change to the page-snapshot " +
      "environment made while the guard flushed a page, or after the last test, is neither restored " +
      "nor named (R3-FINDING J).",
  ],
  [
    "reporter",
    "takeEnvironmentChange",
    "e2e/harness/stamp-reporter.ts no longer CALLS `takeEnvironmentChange`, so a spec whose MODULE " +
      "SCOPE changes the page-snapshot environment during collection — in the main process, before " +
      "any worker exists — hands that environment to every worker it forks (R3-FINDING J).",
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

/**
 * The `with:` inputs each UNPINNED allowlisted action may carry, exactly. An
 * allowlisted action with free inputs is still a lever on every pinned step:
 * `actions/checkout` with `ref:` elsewhere makes the byte-equal bodies run a
 * different tree, and `persist-credentials: true` leaves a token in `.git/config`
 * for every later step (PR #8 closing round, FINDING V-E). The upload action's
 * inputs are pinned with its step.
 */
const ALLOWED_WITH = new Map([
  ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", { "persist-credentials": false }],
  [
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    { "node-version-file": ".nvmrc", cache: "npm", "cache-dependency-path": "package-lock.json" },
  ],
]);

/** The workflow's token scope, exactly. */
const WORKFLOW_PERMISSIONS = { contents: "read" };

/** Actions this workflow may use, at the exact SHA each is pinned to. */
const ALLOWED_USES = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]);

const GLOB_METACHARACTERS = /[*?[\]!]/;

/** Artifacts are retained for at most this many days — FINDING 19. */
const MAX_RETENTION_DAYS = 3;

/** The runner's command files. Every one is refused anywhere in this workflow. */
const RUNNER_COMMAND_FILES = [
  ["GITHUB_STEP_SUMMARY", "publishes to the run page and the Checks API with no `path:`"],
  ["GITHUB_ENV", "sets environment variables for every LATER step, the lane step included"],
  ["GITHUB_PATH", "prepends to PATH for every later step, so `npm` or `node` can be replaced"],
];

// Workflow- and job-level env VALUES are read too; see (d) below for why.
{
  const scopes = [["the workflow", workflow?.env]];
  for (const [jobId, jobNode] of Object.entries(workflow?.jobs ?? {})) {
    scopes.push([`job \`${jobId}\``, jobNode?.env]);
  }
  for (const [scope, env] of scopes) {
    if (!env || typeof env !== "object") continue;
    const text = Object.values(env).map((value) => String(value)).join("\n");
    for (const [name, label] of RUNNER_COMMAND_FILES) {
      if (text.includes(name)) {
        add(`${scope}'s env refers to \`$${name}\` (${label}). Refused anywhere in this workflow.`);
      }
    }
  }
}

// YAML MERGE KEYS ARE REFUSED, and duplicate keys fail the parse.
//
// A verifier injected `PLAYWRIGHT_NO_COPY_PROMPT: ""` at step level through
// `<<: *anchor` and this guard stayed green (R2-FINDING B): the `yaml` package
// does not expand merge keys under YAML 1.2, so the guard saw a key literally
// named `<<` and nothing under it. Whether GitHub Actions expands them was not
// measured, and this guard does not need to know: a workflow whose meaning
// depends on a feature the guard reads differently from the runner is refused.
// Duplicate keys are refused by the parser itself (`uniqueKeys`), which is
// the `yaml` package's default and is set explicitly so it cannot drift.
function mergeKeyPaths(node, trail, found) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => mergeKeyPaths(item, `${trail}[${index}]`, found));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "<<") found.push(trail || "(root)");
      mergeKeyPaths(value, trail ? `${trail}.${key}` : key, found);
    }
  }
  return found;
}
for (const where of mergeKeyPaths(workflow, "", [])) {
  add(
    `the workflow uses a YAML MERGE KEY (\`<<:\`) at ${where}. This guard's parser does not ` +
      "expand merge keys, so a value merged in that way is invisible to every check here; a " +
      "verifier used one to set PLAYWRIGHT_NO_COPY_PROMPT at step level with the guard green.",
  );
}

if (canonical(workflow?.permissions ?? null) !== canonical(WORKFLOW_PERMISSIONS)) {
  add(
    `the workflow's \`permissions:\` must be exactly ${JSON.stringify(WORKFLOW_PERMISSIONS)}; it is ` +
      `${JSON.stringify(workflow?.permissions ?? null)}. A wider token is available to every step, ` +
      "the unpinned ones included.",
  );
}

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
    if (ALLOWED_WITH.has(uses) && canonical(step?.with ?? {}) !== canonical(ALLOWED_WITH.get(uses))) {
      add(
        `${where} uses \`${uses}\`, and its \`with:\` must be exactly ` +
          `${JSON.stringify(ALLOWED_WITH.get(uses))}; it is ${JSON.stringify(step?.with ?? {})}. ` +
          "Another `ref:`, repository or path makes every pinned step run a different tree.",
      );
    }
    if (uses !== "" && !ALLOWED_USES.has(uses)) {
      add(
        `${where} uses \`${uses}\`, which is not on this workflow's pinned action allowlist. ` +
          "Every action that runs here can read the workspace and publish from it — " +
          "`actions/cache` writes a blob other runs in this repository can read, and matches " +
          "neither `upload` nor `artifact`. Adding an action is a reviewed change to " +
          "ALLOWED_USES in scripts/ci/check-e2e-lane.mjs.",
      );
    }

    // (d) THE RUNNER'S COMMAND FILES, in `run:` text AND in every env value.
    //
    //     `$GITHUB_STEP_SUMMARY` publishes to the run page and the Checks API and
    //     is in no `path:` list. `$GITHUB_ENV` and `$GITHUB_PATH` are the one
    //     `run:` channel that CROSSES into later steps — including the lane step,
    //     whose own `run:` is pinned to exactly `npm run e2e` and cannot be
    //     touched — so they are how an earlier step would rewrite the lane's
    //     environment (`NODE_OPTIONS=…` blanking the page-snapshot variable, for
    //     one). Nothing in this job uses any of the three, so all three are refused
    //     rather than filtered by what is written to them.
    //
    //     The first version grepped `run:` text only, and a verifier reached the
    //     step summary through an env map instead — `env: { S: ${{ env.
    //     GITHUB_STEP_SUMMARY }} }` then `echo hi >> "$S"` — green, while this
    //     file's § Residuals said the indirect form was refused (R2-FINDING A). So
    //     env VALUES are read too, at step level here and at job and workflow
    //     level below.
    const runScript = typeof step?.run === "string" ? step.run : "";
    const stepEnvText = Object.values(step?.env && typeof step.env === "object" ? step.env : {})
      .map((value) => String(value))
      .join("\n");
    for (const [name, label] of RUNNER_COMMAND_FILES) {
      if (runScript.includes(name) || stepEnvText.includes(name)) {
        add(
          `${where} refers to \`$${name}\` (${label}), in its \`run:\` text or an env value. ` +
            "Nothing in this workflow needs it, so it is refused rather than inspected.",
        );
      }
    }

    // The upload checks below apply to the pinned uploader by EXACT identity, and
    // — in the refusal direction only — to anything whose name looks like one. An
    // action that is neither is already refused by the `uses:` allowlist above.
    if (uses === "" || !(uses === UPLOAD_ACTION || UPLOADER_MENTION.test(uses))) return;

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
      other = parse(readFileSync(path.join(workflowDir, name), "utf8"), { uniqueKeys: true });
    } catch (error) {
      add(`.github/workflows/${name} could not be parsed (${error instanceof Error ? error.message : String(error)}).`);
      continue;
    }
    for (const where of mergeKeyPaths(other, "", [])) {
      add(
        `.github/workflows/${name} uses a YAML MERGE KEY (\`<<:\`) at ${where}; refused in every ` +
          "workflow, because this guard's parser does not expand it and so cannot see what it merges.",
      );
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

  // AND THE ROOT INSTALL LIFECYCLE. npm runs these for the root package inside
  // `npm ci` — the unpinned step before every pinned one — so a `package.json`
  // edit here runs arbitrary shell before the lane, including a `$GITHUB_ENV`
  // write the `run:` text scan never reads. `pree2e` was refused and these were
  // not (PR #8 closing round, FINDING V-B). This repository declares none.
  // `dependencies` runs after any operation that changes node_modules.
  for (const hook of [
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
    "dependencies",
  ]) {
    if (Object.prototype.hasOwnProperty.call(scripts, hook)) {
      add(
        `package.json declares \`scripts.${hook}\`, which npm runs for the root package during ` +
          "`npm ci` — the unpinned step before every pinned one — so it can rewrite the workspace or " +
          "write `$GITHUB_ENV` before the lane runs. Refused outright; nothing here needs one.",
      );
    }
  }
} catch (error) {
  add(`package.json could not be read (${error instanceof Error ? error.message : String(error)}).`);
}

// A COMMITTED `.npmrc` IS DEFAULT-DENY: an allowlist of keys, and it is empty.
//
// The first version refused two named keys, `script-shell` and `ignore-scripts`,
// and an independent verifier switched the page-snapshot control off with a
// third one (R2-FINDING E):
//
//     node-options=--import=data:text/javascript,process.env.PLAYWRIGHT_NO_COPY_PROMPT=%22%22
//
// npm turns `node-options` into NODE_OPTIONS for every `npm run`, so the variable
// was blanked inside the Playwright process while every declaration in the
// workflow still read "1" — `check-e2e-lane.sh` exit 0, the hygiene check exit 0,
// and the page snapshot back in `error-context.md` with a `fill()` value verbatim.
// A list of dangerous npm keys is a list someone forgets to extend; npm reads
// dozens. This repository has no `.npmrc`, so an allowlist of zero keys costs
// nothing, and a key that is ever needed arrives with the review that adds it here.
//
// What this does NOT reach, and why it no longer has to be the control: a
// user-level or global `.npmrc` on the runner, or one a `run:` step writes before
// the lane. `npm_config_userconfig` / `npm_config_globalconfig` pointing at one are
// refused below with every other `npm_config_*` key. For the rest, the RUNTIME
// policy in `e2e/harness/ci-environment.ts` reads the variable inside the
// Playwright worker — while the capture still says CI (`CI` or `GITHUB_ACTIONS`).
// A route that also removes both anchors before the configuration loads leaves
// it silent, and then the pinned redaction step's page-snapshot gate is the
// control (AGENTS.md § Artifact privacy).
const ALLOWED_NPMRC_KEYS = new Set();
try {
  const npmrc = readFileSync(path.join(repoRoot, ".npmrc"), "utf8");
  for (const line of npmrc.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const key = (trimmed.split("=")[0] ?? "").trim().toLowerCase().replace(/_/g, "-");
    if (!ALLOWED_NPMRC_KEYS.has(key)) {
      add(
        `.npmrc sets \`${key}\`, and a committed \`.npmrc\` is default-deny (the allowlist is ` +
          "empty). npm reads it for every `npm run` in this lane: `node-options` becomes " +
          "NODE_OPTIONS, which is how an independent verifier blanked PLAYWRIGHT_NO_COPY_PROMPT " +
          "inside the Playwright process with every workflow declaration still reading \"1\". " +
          "Adding a key is a reviewed change to ALLOWED_NPMRC_KEYS in scripts/ci/check-e2e-lane.mjs.",
      );
    }
  }
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
    add(`.npmrc exists but could not be read (${error instanceof Error ? error.message : String(error)}).`);
  }
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
// nowhere else at any scope.
//
// WHAT THIS COMPUTES, AND WHAT IT CANNOT. An earlier version of this comment said
// the rule "has no shape where the guard is green and the variable is not "1"".
// That was FALSE, and a verifier showed it within a round: this block computes
// the value the YAML DECLARES across its three scopes, not the value the
// Playwright process SEES. A committed `.npmrc` with `node-options` blanked it
// with every declaration still reading "1". The declared value is one layer; the
// routes a parser can read are refused one by one (the `.npmrc` allowlist above,
// `NODE_OPTIONS` / `npm_config_*` / `CI` in every env map, `$GITHUB_ENV` and
// `$GITHUB_PATH` below). The property itself — the value Playwright actually
// reads — is asserted at RUNTIME, in the worker, by `e2e/harness/ci-environment.ts`
// while the capture says CI, and the upload gate in `redact-artifacts.sh` refuses
// any artifact that carries a page snapshot regardless.
const PAGE_SNAPSHOT_KEY = "PLAYWRIGHT_NO_COPY_PROMPT";
const PAGE_SNAPSHOT_VALUE = "1";
/**
 * Refused at EVERY scope: workflow, job and step.
 *
 * `CI` is on the list because the runtime page-snapshot assertion only fires when
 * `CI` is set — so the one env key that could switch that assertion off is the
 * one this lane may never declare. GitHub sets it for every job.
 */
const REFUSED_ENV = new Set(["DEBUG", "PWDEBUG", "NODE_DEBUG", "NODE_OPTIONS", "CI", "HOME"]);

/**
 * And every OTHER key is refused too: the env maps are DEFAULT-DENY. The list above
 * exists for its named messages; this is the control. The workflow's env
 * allowlist is empty, the job's holds the one key below, and an unpinned step's is
 * empty (checked with the pins). A list of dangerous names is what `BASH_ENV` (a
 * file every `bash` step sources first), `PATH` (which `npm` and `bash` are run),
 * `HOME` (whose `.npmrc` npm reads — R3-FINDING K) or `LD_PRELOAD` would each have
 * walked past, and every one of them changes what a byte-equal pinned body does.
 */
const ALLOWED_ENV = { workflow: new Set(), job: new Set(["PLAYWRIGHT_NO_COPY_PROMPT"]) };

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

for (const [scope, env, allowed] of [
  ["the workflow", workflowEnv, ALLOWED_ENV.workflow],
  ["the `e2e` job", jobEnv, ALLOWED_ENV.job],
]) {
  for (const key of Object.keys(env && typeof env === "object" ? env : {})) {
    if (!allowed.has(key)) {
      add(
        `${scope} sets \`${key}\`. Env at this scope is DEFAULT-DENY (allowed: ` +
          `${allowed.size === 0 ? "nothing" : [...allowed].join(", ")}): \`BASH_ENV\`, \`PATH\`, \`HOME\` and ` +
          "their kind change what every pinned step does without changing a byte of it.",
      );
    }
  }
}

const snapshotSightings = [];
for (const [scope, env] of envScopes) {
  for (const [key, value] of Object.entries(env)) {
    if (key === PAGE_SNAPSHOT_KEY) {
      snapshotSightings.push({ scope, value });
      continue;
    }
    if (key === "HOME") {
      add(
        `${scope} sets \`HOME\`, which is refused at every scope (R3-FINDING K): npm reads ` +
          "`$HOME/.npmrc` for every `npm run`, so a committed file under a redirected home is a " +
          "`.npmrc` the default-deny rule for the repository's own `.npmrc` never sees.",
      );
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
