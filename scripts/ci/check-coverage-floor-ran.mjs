/**
 * Re-check the browser lane's coverage floor from OUTSIDE the Playwright
 * process, against the run's own JSON report.
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reportPath = path.resolve(repoRoot, process.argv[2] ?? "playwright-report/results.json");
const floorPath = path.join(repoRoot, "e2e", "harness", "required-projects.json");

function fail(lines) {
  console.error("::error::the browser lane's coverage floor was not satisfied:");
  for (const line of lines) console.error(`  ${line}`);
  console.error(
    "  This check reads the finished run's own report, so it still applies when the " +
      "in-process reporter has been removed from playwright.config.ts.",
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

function walkSuite(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      totalTests += 1;
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

const summary = Object.entries(minimums)
  .map(([project, minimum]) => `${project}=${passed.get(project) ?? 0}/${minimum}`)
  .join(" ");
console.log(`OK: the browser lane satisfied its coverage floor from the report (${summary}).`);
