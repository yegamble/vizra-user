/**
 * The reporter that refuses a run containing a test which SUCCEEDED without
 * going through the guarded harness.
 *
 * WHAT IT ASSERTS. For every result that COUNTED AS A SUCCESS for the run —
 * `status === "passed"`, and also a `failed` result whose test is
 * `test.fail()`-marked, because that also makes the run green — the result must
 * carry the `vizra-harness-stamp` annotation and it must verify against this
 * run's key. A spec that imported `@playwright/test` directly produces no such
 * annotation, so the run is RED and the offending file is named.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. A result that is `skipped`,
 * `timedOut` or `interrupted`, or an ordinary `failed` result, is not required
 * to carry a stamp: fixture teardown (where the stamp is written) can be cut
 * short by a timeout, and a run containing such a result is already red or
 * already proved nothing. The security property is precise — **a test cannot
 * pass without the harness** — and overclaiming it would make the lane flaky,
 * which is how a control gets switched off.
 *
 * WHY A SECOND, OUT-OF-PROCESS CHECK EXISTS TOO. This reporter is listed in
 * `playwright.config.ts`, which the pull request being gated can edit — exactly
 * the hole `scripts/ci/check-coverage-floor-ran.mjs` was written for. So this
 * reporter writes the run's key to `.vizra-e2e/stamp-key.json` in `onEnd`, AFTER
 * the last test has finished, and that check re-verifies every stamp from the
 * finished JSON report. Delete this reporter and the key file is never written
 * (or is stale from an earlier run, whose key is different), so the
 * out-of-process check fails closed rather than passing quietly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { reporterKeyHex, specPath, STAMP_ANNOTATION, STAMP_KEY_FILE, verifyStamp } from "./stamp";

/** Does this result count as a success for the run? */
function countedAsSuccess(test: TestCase, result: TestResult): boolean {
  if (result.status === "passed") return true;
  return result.status === "failed" && test.expectedStatus === "failed";
}

class StampReporter implements Reporter {
  private rootDir = process.cwd();
  private keyHex = "";
  private readonly problems: string[] = [];
  private verified = 0;

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir;
    this.keyHex = reporterKeyHex();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!countedAsSuccess(test, result)) return;

    // The identity the stamp commits to is rootDir-relative, because that is the
    // spelling the JSON report uses too and all three sides must agree. The
    // message shows the path from the working directory, which is what a person
    // needs in order to open the file.
    const file = specPath(this.rootDir, test.location.file);
    const shown = specPath(process.cwd(), test.location.file);
    const where =
      `${shown}:${test.location.line} — "${test.title}" ` +
      `[${test.parent.project()?.name ?? "(no project)"}, attempt ${result.retry}]`;

    const stamps = result.annotations.filter((entry) => entry.type === STAMP_ANNOTATION);
    if (stamps.length === 0) {
      this.problems.push(
        `${where} succeeded WITHOUT the harness stamp. It did not take \`test\` from ` +
          "e2e/harness/test, so the console / page-error / failed-request / HTTP>=400 guard " +
          "never ran for it: it would pass on a page that 404s and throws.",
      );
      return;
    }
    if (stamps.length > 1) {
      this.problems.push(`${where} carries ${stamps.length} harness stamps; exactly one is written.`);
      return;
    }

    const identity = {
      project: test.parent.project()?.name ?? "",
      file,
      title: test.title,
      workerIndex: result.workerIndex,
      retry: result.retry,
    };
    if (!verifyStamp(this.keyHex, identity, stamps[0]?.description)) {
      this.problems.push(
        `${where} carries a harness stamp that does not verify against this run's key. ` +
          "A stamp is an HMAC over the test's own identity; a copied, hand-written or " +
          "stale value cannot match.",
      );
      return;
    }
    this.verified += 1;
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | void> {
    // Written only now, when no test is still running, so no spec could read the
    // key while it mattered. It is what lets check-coverage-floor-ran.mjs verify
    // the same stamps from outside this process.
    try {
      // The REPOSITORY root (the working directory the lane and the CI step both
      // run from), not `config.rootDir` — which is now `e2e/specs`, because that
      // is the only directory the lane collects. `check-coverage-floor-ran.mjs`
      // resolves the same path from the repository root.
      const keyPath = path.resolve(process.cwd(), STAMP_KEY_FILE);
      mkdirSync(path.dirname(keyPath), { recursive: true });
      writeFileSync(
        keyPath,
        `${JSON.stringify({ key: this.keyHex || reporterKeyHex(), writtenAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      this.problems.push(
        `the harness stamp key could not be written to ${STAMP_KEY_FILE}: ` +
          `${error instanceof Error ? error.message : String(error)}. The out-of-process ` +
          "check cannot verify the stamps without it.",
      );
    }

    if (this.problems.length === 0) {
      process.stdout.write(`e2e harness stamp: OK (${this.verified} succeeding result(s) verified).\n`);
      return;
    }

    process.stderr.write(
      "\n::error::a test succeeded without going through the guarded browser harness " +
        "(e2e/harness/test.ts):\n" +
        this.problems.map((problem) => `  ${problem}`).join("\n") +
        `\n  Playwright reported "${result.status}" — that answers "did anything fail", not ` +
        '"did every passing test actually run the guard".\n',
    );
    return { status: "failed" };
  }
}

export default StampReporter;
