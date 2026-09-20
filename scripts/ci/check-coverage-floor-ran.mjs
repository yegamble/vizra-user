/**
 * Re-check the browser lane's coverage floor AND its proof-of-harness from
 * OUTSIDE the Playwright process, against the run's own JSON report.
 *
 * TWO PROPERTIES, ONE PASS OVER THE REPORT:
 *
 *   1. THE FLOOR — every required project ran at least its minimum number of
 *      passing tests (`e2e/harness/required-projects.json`).
 *   2. THE HARNESS STAMP — every result that COUNTED AS A SUCCESS carries the
 *      annotation `e2e/harness/test.ts` writes, and it verifies against this
 *      run's key. A spec that took `test` from `@playwright/test` directly, by
 *      any syntax, from any directory, with any lint suppression, produces no
 *      such annotation, so it is named here and the check exits 1. This is the
 *      out-of-process half of `e2e/harness/stamp-reporter.ts`, and it exists for
 *      the same reason the floor is checked twice: both reporters live in
 *      `playwright.config.ts`, which the pull request being gated can edit.
 *
 *      The key comes from `.vizra-e2e/stamp-key.json`, written by the reporter
 *      in `onEnd` — after the last test finished, and only if the reporter ran.
 *      Delete the reporter and the file is absent (or holds a previous run's
 *      key, since every run mints a fresh one), so this check fails CLOSED.
 *
 * WHY A SECOND CHECK OF THE SAME THING. `e2e/harness/coverage-reporter.ts`
 * enforces the floor from inside the run — and it is listed in
 * `playwright.config.ts`, which the pull request being gated can edit. Deleting
 * one line from the `reporter` array removes the floor with no other visible
 * effect: the lane still runs, still prints "N passed", still exits 0. This
 * step reads the finished report instead, so the floor survives the deletion of
 * its own enforcer.
 *
 * It reads the SAME numbers (`e2e/harness/required-projects.json`) rather than
 * a copy, because a floor duplicated in two files is a floor that drifts.
 *
 * It also refuses a report that does not exist, is empty, or contains no test
 * at all — the three shapes of "the lane did not really run" that a wrong path
 * or a crashed run would otherwise present as silence.
 *
 * Usage:  node scripts/ci/check-coverage-floor-ran.mjs [report.json]
 * Default report: playwright-report/results.json (playwright.config.ts's
 * `json` reporter `outputFile`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  countedAsSuccess,
  STAMP_ANNOTATION,
  STAMP_KEY_FILE,
  stampVerifies,
} from "./stamp-verify.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reportPath = path.resolve(repoRoot, process.argv[2] ?? "playwright-report/results.json");
const floorPath = path.join(repoRoot, "e2e", "harness", "required-projects.json");
const stampKeyPath = path.resolve(repoRoot, STAMP_KEY_FILE);

function fail(lines) {
  console.error("::error::the browser lane's coverage floor was not satisfied:");
  for (const line of lines) console.error(`  ${line}`);
  console.error(
    "  This check reads the finished run's own report, so it still applies when the " +
      "in-process reporter has been removed from playwright.config.ts.",
  );
  process.exit(1);
}

function failStamps(lines) {
  console.error(
    "::error::a test succeeded without going through the guarded browser harness " +
      "(e2e/harness/test.ts):",
  );
  for (const line of lines) console.error(`  ${line}`);
  console.error(
    "  The stamp is written by the harness's automatic fixture under a per-run key a spec " +
      "cannot read (e2e/harness/stamp.ts). This check reads the finished report and the key " +
      "the reporter wrote after the run, so it still applies when the in-process stamp " +
      "reporter has been removed from playwright.config.ts.",
  );
  process.exit(1);
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail([
      `could not read ${what} at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      "A lane whose report is missing did not run; that is a failure, not a silence.",
    ]);
    return undefined;
  }
}

const floor = readJson(floorPath, "the coverage floor");
const report = readJson(reportPath, "the Playwright JSON report");

const minimums = floor?.projects;
if (!minimums || typeof minimums !== "object" || Object.keys(minimums).length === 0) {
  fail([
    `${floorPath} declares no project minimums.`,
    "An empty floor would pass any run, including one that tested nothing.",
  ]);
}

/**
 * Count tests that RAN AND PASSED, per project.
 *
 * The JSON report nests `suites` and carries `specs[].tests[]`, each test with
 * a `projectName` and its `results`. Only `expected` outcomes count: a skipped,
 * interrupted or flaky test is not a test that passed.
 */
const passed = new Map();
let totalTests = 0;

/**
 * The stamp key, read once. A missing file is NOT a reason to skip the stamp
 * check: it means the reporter that writes it did not run, which is exactly the
 * edit this check exists to survive. `stampKey` stays undefined and every
 * succeeding result is reported below.
 */
let stampKey;
let stampKeyProblem = "";
try {
  const parsed = JSON.parse(readFileSync(stampKeyPath, "utf8"));
  if (typeof parsed?.key === "string" && /^[0-9a-f]+$/.test(parsed.key)) {
    stampKey = parsed.key;
  } else {
    stampKeyProblem = `${STAMP_KEY_FILE} does not contain a hex \`key\`.`;
  }
} catch (error) {
  stampKeyProblem =
    `${STAMP_KEY_FILE} could not be read (${error instanceof Error ? error.message : String(error)}). ` +
    "e2e/harness/stamp-reporter.ts writes it at the end of every run; its absence means that " +
    "reporter is no longer in playwright.config.ts, so nothing proved the tests went through " +
    "the harness. A lane whose proof is missing did not prove anything.";
}

const stampProblems = [];
let stampsVerified = 0;

let sawSucceedingResult = false;

function checkStamps(spec, test) {
  for (const result of test.results ?? []) {
    if (!countedAsSuccess(test, result)) continue;
    sawSucceedingResult = true;
    // Without a key nothing can be verified, and repeating that once per test
    // would bury the one fact that matters. It is reported once, below.
    if (stampKey === undefined) continue;
    const where =
      `${spec.file}:${spec.line} — "${spec.title}" ` +
      `[${test.projectName ?? "(no project)"}, attempt ${result.retry ?? 0}]`;
    const stamps = (result.annotations ?? []).filter((entry) => entry?.type === STAMP_ANNOTATION);
    if (stamps.length !== 1) {
      stampProblems.push(
        `${where} succeeded with ${stamps.length} harness stamp(s); exactly one is written by ` +
          "e2e/harness/test.ts. A test with none did not take `test` from the harness, so the " +
          "console / page-error / failed-request / HTTP>=400 guard never ran for it.",
      );
      continue;
    }
    const identity = {
      project: test.projectName ?? "",
      file: spec.file,
      title: spec.title,
      workerIndex: result.workerIndex ?? 0,
      retry: result.retry ?? 0,
    };
    if (!stampVerifies(stampKey, identity, stamps[0]?.description)) {
      stampProblems.push(
        `${where} carries a harness stamp that does not verify against this run's key. ` +
          "A stamp is an HMAC over the test's own identity; a copied, hand-written or stale " +
          "value cannot match.",
      );
      continue;
    }
    stampsVerified += 1;
  }
}

function walkSuite(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      totalTests += 1;
      checkStamps(spec, test);
      if (test.status !== "expected") continue;
      const results = test.results ?? [];
      const ok = results.length > 0 && results[results.length - 1]?.status === "passed";
      if (!ok) continue;
      const project = test.projectName ?? "(no project)";
      passed.set(project, (passed.get(project) ?? 0) + 1);
    }
  }
  for (const child of suite.suites ?? []) walkSuite(child);
}

for (const suite of report?.suites ?? []) walkSuite(suite);

if (totalTests === 0) {
  fail([
    `${reportPath} contains no tests at all.`,
    "A run that collected nothing is not a pass (AGENTS.md).",
  ]);
}

const problems = [];
for (const [project, minimum] of Object.entries(minimums)) {
  const count = passed.get(project) ?? 0;
  if (count < minimum) {
    problems.push(
      `project "${project}" passed ${count} test(s); the floor is ${minimum} ` +
        "(e2e/harness/required-projects.json).",
    );
  }
}

if (problems.length > 0) fail(problems);

// The stamp check is reported SECOND and separately, so a red run says which of
// the two properties failed rather than merging them into one message.
if (stampKey === undefined && sawSucceedingResult) {
  failStamps([
    `${stampsVerified} of the run's succeeding results could be verified, because the key is ` +
      "unreadable.",
    stampKeyProblem,
  ]);
}
if (stampProblems.length > 0) failStamps(stampProblems);

const summary = Object.entries(minimums)
  .map(([project, minimum]) => `${project}=${passed.get(project) ?? 0}/${minimum}`)
  .join(" ");
console.log(`OK: the browser lane satisfied its coverage floor from the report (${summary}).`);
console.log(
  `OK: every succeeding result carried a valid harness stamp (${stampsVerified} verified, ` +
    `from ${STAMP_KEY_FILE}).`,
);
