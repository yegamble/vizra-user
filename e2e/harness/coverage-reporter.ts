/**
 * The reporter that refuses a vacuous green.
 *
 * THE HOLE THIS CLOSES. Playwright's exit code answers "did anything fail",
 * not "did anything run". A pull request can delete a project from
 * `playwright.config.ts`, rename `e2e/specs/`, tighten `testMatch`, or mark
 * every test `.skip`, and the lane reports success having driven no browser at
 * all. That is precisely the shape of false-positive CI the meta `AGENTS.md`
 * code-review rules name: "a required test that is skipped, missing,
 * cancelled, timed out, or not collected is not PASS".
 *
 * So this reporter asserts, from the run's own results:
 *
 *   1. every project named in `required-projects.ts` EXISTS in the resolved
 *      configuration (catches a deleted or renamed project), and
 *   2. every one of them actually ran at least its minimum number of tests,
 *      counting only tests whose outcome is `expected` — a skipped, interrupted
 *      or filtered-out test counts as zero.
 *
 * It overrides the run status to `failed` (the documented `onEnd` return
 * contract) so the process exits non-zero even when nothing "failed".
 *
 * `--grep`, `--shard` and single-file invocations legitimately run a subset.
 * Those are developer conveniences, never the lane — so the floor is ON by
 * default and must be turned OFF explicitly with `E2E_COVERAGE_FLOOR=off`.
 * Opt-out, not opt-in: an opt-in floor is one deleted environment variable away
 * from being no floor at all, and the deletion looks like tidying.
 * `scripts/ci/check-e2e-lane.sh` fails if the workflow ever sets that value.
 */

import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import { REQUIRED_PROJECTS } from "./required-projects";

class CoverageReporter implements Reporter {
  private configuredProjects: string[] = [];
  private readonly ran = new Map<string, number>();
  private enforcing = false;

  onBegin(config: FullConfig): void {
    this.enforcing = process.env.E2E_COVERAGE_FLOOR !== "off";
    this.configuredProjects = config.projects.map((project) => project.name);
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
          `project "${name}" ran ${count} passing test(s), and the floor is ${minimum}. ` +
            "A lane that collects nothing is not a pass (AGENTS.md).",
        );
      }
    }

    if (problems.length === 0) {
      const summary = [...REQUIRED_PROJECTS.keys()]
        .map((name) => `${name}=${this.ran.get(name) ?? 0}`)
        .join(" ");
      process.stdout.write(`e2e coverage floor: OK (${summary}).\n`);
      return;
    }

    process.stderr.write(
      `\n::error::the browser lane did not satisfy its coverage floor ` +
        `(e2e/harness/required-projects.ts):\n` +
        problems.map((problem) => `  ${problem}`).join("\n") +
        `\n  Playwright reported "${result.status}" — that answers "did anything fail", ` +
        `not "did anything run".\n`,
    );
    return { status: "failed" };
  }
}

export default CoverageReporter;
