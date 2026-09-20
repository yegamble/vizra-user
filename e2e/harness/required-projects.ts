/**
 * The projects this repository's browser lane MUST run, and the minimum number
 * of tests each must actually execute.
 *
 * THIS IS A FLOOR, and it exists for the same reason
 * `scripts/ci/check-required-floor.sh` exists one level up: the thing that
 * defines "did the lane test anything" is editable by the pull request the
 * lane is gating. Delete a project from `playwright.config.ts`, or filter the
 * specs down to nothing with a `--grep` that matches no test, and Playwright
 * can exit 0 having run zero browsers. A harness that runs nothing must not be
 * green (meta `AGENTS.md`: "a required test that is skipped, missing,
 * cancelled, timed out, or not collected is not PASS").
 *
 * So the names live HERE, in a file `.github/CODEOWNERS` covers, and
 * `coverage-reporter.ts` fails the run when the configuration or the result
 * stops satisfying them.
 *
 * The two viewports are ADR-009 / `docs/DESIGN_BRIEF.md`: 1440 px desktop and
 * 390 px mobile. Adding a project is welcome; removing one is an owner
 * decision, and the diff says so.
 */

export const DESKTOP_PROJECT = "desktop-chromium-1440";
export const MOBILE_PROJECT = "mobile-chromium-390";

/** Project name → the minimum number of tests that must have RUN (not skipped). */
export const REQUIRED_PROJECTS: ReadonlyMap<string, number> = new Map([
  [DESKTOP_PROJECT, 1],
  [MOBILE_PROJECT, 1],
]);

/** The viewports, kept beside the names so the two cannot drift apart. */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
