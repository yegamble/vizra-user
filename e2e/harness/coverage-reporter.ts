/**
 * The reporter that refuses a vacuous green.
 *
 * THE HOLE THIS CLOSES. Playwright's exit code answers "did anything fail",
 * not "did anything run". A pull request can delete a project from
 * `playwright.config.ts`, rename `e2e/specs/`, tighten `testMatch`, mark every
 * test `.skip`, or simply delete tests one at a time, and the lane reports
 * success having driven no browser — or having driven one test. That is
 * precisely the shape of false-positive CI the meta `AGENTS.md` code-review
 * rules name: "a required test that is skipped, missing, cancelled, timed out,
 * or not collected is not PASS".
 *
 * So this reporter asserts, from the run's own results:
 *
 *   1. every project named in `required-projects.json` EXISTS in the resolved
 *      configuration (catches a deleted or renamed project);
 *   2. every one of them ran at least its MINIMUM number of tests, counting
 *      only tests whose outcome is `expected` — a skipped, interrupted or
 *      filtered-out test counts as zero;
 *   3. the run was NOT filtered. An independent verifier showed that
 *      `--grep "reports liveness"` exited 0 with `coverage floor: OK
 *      (desktop=1 mobile=1)` while the minimum was 1: wholesale vacuity was
 *      caught, attrition was not. Raising the minima fixes the second half;
 *      refusing a filtered run fixes the first, because any filter can select
 *      a subset that happens to clear the floor. The lane runs everything or
 *      it fails.
 *
 * It overrides the run status to `failed` (the documented `onEnd` return
 * contract) so the process exits non-zero even when nothing "failed".
 *
 * `--grep`, `--shard` and single-file invocations are legitimate developer
 * conveniences, never the lane — so the floor is ON by default and must be
 * turned OFF explicitly with `E2E_COVERAGE_FLOOR=off`. Opt-out, not opt-in: an
 * opt-in floor is one deleted environment variable away from being no floor at
 * all, and the deletion looks like tidying. `scripts/ci/check-e2e-lane.sh`
 * fails if the workflow ever sets that value, and
 * `scripts/ci/check-coverage-floor-ran.mjs` re-checks the same floor from
 * OUTSIDE the Playwright process, so deleting this reporter from the config is
 * caught too.
 */

import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { REQUIRED_PROJECTS } from "./required-projects";

/**
 * Command-line filters that select a subset of the suite. Every one of them can
 * make the lane pass on tests it did not run, so the lane refuses all of them
 * rather than reasoning about which subset would have been acceptable.
 */
const FILTER_FLAGS = [
  "--grep",
  "-g",
  "--grep-invert",
  "--gi",
  "--shard",
  "--last-failed",
  "--only-changed",
  "--project",
] as const;

/** Positional arguments after `playwright test` are file/path filters. */
function positionalFilters(argv: readonly string[]): string[] {
  const index = argv.indexOf("test");
  if (index === -1) return [];
  const rest = argv.slice(index + 1);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg.startsWith("-")) {
      // `--flag value` consumes the next token; `--flag=value` does not.
      if (!arg.includes("=") && i + 1 < rest.length && !(rest[i + 1] as string).startsWith("-")) {
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

function activeFilters(argv: readonly string[]): string[] {
  const found: string[] = [];
  for (const flag of FILTER_FLAGS) {
    if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) found.push(flag);
  }
  for (const file of positionalFilters(argv)) found.push(`file filter "${file}"`);
  return found;
}

class CoverageReporter implements Reporter {
  private configuredProjects: string[] = [];
  private readonly ran = new Map<string, number>();
  private enforcing = false;
  private filters: string[] = [];

  onBegin(config: FullConfig): void {
    this.enforcing = process.env.E2E_COVERAGE_FLOOR !== "off";
    this.configuredProjects = config.projects.map((project) => project.name);
    this.filters = activeFilters(process.argv);
    // `--grep` can also be set in the configuration file rather than on the
    // command line, so the resolved config is checked as well as argv.
    if (config.grepInvert) this.filters.push("config.grepInvert");
    if (config.grep instanceof RegExp && config.grep.source !== ".*") {
      this.filters.push(`config.grep (/${config.grep.source}/)`);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // `expected` means the test ran and its outcome matched expectation.
    // `skipped` does not count, and neither does a test that never started.
    if (test.outcome() !== "expected") return;
    if (result.status !== "passed") return;
    const project = test.parent.project()?.name ?? "(no project)";
    this.ran.set(project, (this.ran.get(project) ?? 0) + 1);
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | void> {
    if (!this.enforcing) {
      process.stdout.write(
        "e2e coverage floor: DISABLED by E2E_COVERAGE_FLOOR=off. " +
          "This run proves nothing about coverage; the lane never sets it.\n",
      );
      return;
    }

    const problems: string[] = [];

    if (this.filters.length > 0) {
      problems.push(
        `the run was FILTERED (${this.filters.join(", ")}). The lane runs the whole suite: ` +
          "any filter can select a subset that happens to clear the floor, which is how a " +
          "one-test run reported `coverage floor: OK`. For a deliberately partial local run, " +
          "set E2E_COVERAGE_FLOOR=off and understand that it proves nothing about coverage.",
      );
    }

    for (const [name, minimum] of REQUIRED_PROJECTS) {
      if (!this.configuredProjects.includes(name)) {
        problems.push(
          `project "${name}" is not in the resolved Playwright configuration ` +
            `(configured: ${this.configuredProjects.join(", ") || "none"}). ` +
            "A required viewport was removed or renamed.",
        );
        continue;
      }
      const count = this.ran.get(name) ?? 0;
      if (count < minimum) {
        problems.push(
          `project "${name}" ran ${count} passing test(s), and the floor is ${minimum} ` +
            "(e2e/harness/required-projects.json). A lane that collects nothing — or that " +
            "quietly lost tests — is not a pass (AGENTS.md).",
        );
      }
    }

    if (problems.length === 0) {
      const summary = [...REQUIRED_PROJECTS.entries()]
        .map(([name, minimum]) => `${name}=${this.ran.get(name) ?? 0}/${minimum}`)
        .join(" ");
      process.stdout.write(`e2e coverage floor: OK (${summary}).\n`);
      return;
    }

    process.stderr.write(
      `\n::error::the browser lane did not satisfy its coverage floor ` +
        `(e2e/harness/required-projects.json):\n` +
        problems.map((problem) => `  ${problem}`).join("\n") +
        `\n  Playwright reported "${result.status}" — that answers "did anything fail", ` +
        `not "did anything run".\n`,
    );
    return { status: "failed" };
  }
}

export default CoverageReporter;
