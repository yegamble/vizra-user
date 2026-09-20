/**
 * The projects this repository's browser lane MUST run, and the minimum number
 * of tests each must actually execute.
 *
 * THIS IS A FLOOR, and it exists for the same reason
 * `scripts/ci/check-required-floor.sh` exists one level up: the thing that
 * defines "did the lane test anything" is editable by the pull request the
 * lane is gating. Delete a project from `playwright.config.ts`, filter the
 * specs down with a `--grep`, or delete tests one at a time, and Playwright
 * can exit 0 having proved almost nothing. A harness that runs nothing must
 * not be green (meta `AGENTS.md`: "a required test that is skipped, missing,
 * cancelled, timed out, or not collected is not PASS").
 *
 * THE NUMBERS LIVE IN `required-projects.json`, not here. Two readers need
 * them: this module (the reporter, inside the Playwright process) and
 * `scripts/ci/check-coverage-floor-ran.mjs` (the CI step that re-checks the
 * finished run from outside it, so that deleting the reporter from the config
 * is also caught). A number duplicated in two files is a number that drifts.
 * Both files are under `/e2e/harness/`, which `.github/CODEOWNERS` covers.
 *
 * The two viewports are ADR-009 / `docs/DESIGN_BRIEF.md`: 1440 px desktop and
 * 390 px mobile. Adding a project is welcome; removing one, or lowering a
 * minimum, is an owner decision, and the diff says so.
 */

import floor from "./required-projects.json";

export const DESKTOP_PROJECT = "desktop-chromium-1440";
export const MOBILE_PROJECT = "mobile-chromium-390";

/** Project name → the minimum number of tests that must have RUN and passed. */
export const REQUIRED_PROJECTS: ReadonlyMap<string, number> = new Map(
  Object.entries(floor.projects),
);

// The JSON and the two constants must agree. If a rename lands in one and not
// the other, `playwright.config.ts` would build projects under one set of names
// while the floor demanded another — and the floor would fail for the wrong
// reason, or (worse, if the names were dropped from the JSON) not at all.
// Throwing at module load makes that a loud configuration error.
for (const name of [DESKTOP_PROJECT, MOBILE_PROJECT]) {
  if (!REQUIRED_PROJECTS.has(name)) {
    throw new Error(
      `required-projects.json has no floor for "${name}". The JSON and the project ` +
        `constants must name the same projects; see e2e/harness/required-projects.json.`,
    );
  }
}

/** The viewports, kept beside the names so the two cannot drift apart. */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
