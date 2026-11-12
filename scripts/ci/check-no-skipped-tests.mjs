/**
 * VZ-CI-001 N1 — A SKIPPED REQUIRED TEST FAILS THE JOB.
 *
 * Reads a finished run's JSON report and exits 1 if any test was skipped,
 * todo or fixme. Count floors alone let a single `it.skip` / `test.fixme`
 * under the floor pass; this closes that hole for both required lanes.
 *
 * It fails CLOSED: a missing, unparseable or empty report (zero tests), and
 * any test status it does not recognise, are failures too.
 *
 * Usage:
 *   node scripts/ci/check-no-skipped-tests.mjs vitest     <report.json>
 *   node scripts/ci/check-no-skipped-tests.mjs playwright [report.json] [allowlist.json]
 *
 * vitest:     `vitest run --reporter=json --outputFile.json=<report>`
 *             statuses passed|failed are accepted (failed already fails the
 *             run); skipped|pending|todo and anything else are refused.
 * playwright: the `json` reporter in playwright.config.ts. A test whose
 *             outcome is `skipped` (test.skip, test.fixme, conditional skips)
 *             is refused unless listed in the allowlist
 *             (default scripts/ci/skip-allowlist.json, EMPTY today) as
 *             {file, title, project, reason} with a non-empty reason.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_ALLOWLIST = fileURLToPath(new URL("./skip-allowlist.json", import.meta.url));

function fail(lines) {
  for (const line of [].concat(lines)) process.stderr.write(`check-no-skipped-tests: ${line}\n`);
  process.exit(1);
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail(`${what} ${path} cannot be read (${err.code ?? err.message}): the lane did not really run`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${what} ${path} is not valid JSON (${err.message})`);
  }
}

function checkVitest(report) {
  const offenders = [];
  let total = 0;
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      total += 1;
      if (t.status !== "passed" && t.status !== "failed") {
        offenders.push(`${t.status}: ${file.name} > ${t.fullName ?? t.title}`);
      }
    }
  }
  return { total, offenders };
}

function* playwrightTests(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) yield { spec, test };
    }
    yield* playwrightTests(suite.suites);
  }
}

function checkPlaywright(report, allowlistPath) {
  const allowlist = readJson(allowlistPath, "allowlist");
  if (!Array.isArray(allowlist)) fail(`allowlist ${allowlistPath} must be a JSON array`);
  for (const entry of allowlist) {
    if (!entry || typeof entry.reason !== "string" || entry.reason.trim() === "") {
      fail(`allowlist entry ${JSON.stringify(entry)} has no reason`);
    }
  }
  const allowed = (spec, test) =>
    allowlist.some(
      (e) => e.file === spec.file && e.title === spec.title && e.project === test.projectName,
    );
  const known = new Set(["expected", "unexpected", "flaky", "skipped"]);
  const offenders = [];
  let total = 0;
  for (const { spec, test } of playwrightTests(report.suites)) {
    total += 1;
    const name = `[${test.projectName}] ${spec.file} > ${spec.title}`;
    if (!known.has(test.status)) offenders.push(`unknown status ${test.status}: ${name}`);
    else if (test.status === "skipped" && !allowed(spec, test)) offenders.push(`skipped/fixme: ${name}`);
  }
  return { total, offenders };
}

// The playwright default is playwright.config.ts's `json` outputFile; the e2e
// workflow relies on it because check-e2e-lane.mjs reserves artifact-directory
// names in a step's `run:` for the pinned redaction step.
const [format, reportArg, allowlistPath = DEFAULT_ALLOWLIST] = process.argv.slice(2);
const reportPath = reportArg ?? (format === "playwright" ? "playwright-report/results.json" : undefined);
if (!["vitest", "playwright"].includes(format) || !reportPath) {
  fail("usage: check-no-skipped-tests.mjs vitest|playwright <report.json> [allowlist.json]");
}
const report = readJson(reportPath, "report");
const { total, offenders } =
  format === "vitest" ? checkVitest(report) : checkPlaywright(report, allowlistPath);
if (total === 0) fail(`report ${reportPath} contains zero tests: the lane did not really run`);
if (offenders.length > 0) {
  fail([
    `${offenders.length} of ${total} ${format} test(s) did not run; a skipped required test is a failure (VZ-CI-001 N1):`,
    ...offenders.map((o) => `  ${o}`),
  ]);
}
process.stdout.write(`check-no-skipped-tests: ${total} ${format} test(s), none skipped/todo/fixme\n`);
