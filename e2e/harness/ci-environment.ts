/**
 * The one environment property the artifact-privacy controls depend on,
 * asserted where it TAKES EFFECT rather than where it is declared.
 *
 * WHY THIS EXISTS. `error-context.md` is written whenever a test has errors, and
 * no Playwright configuration option gates the file. One environment variable
 * gates its worst section (`playwright/lib/index.js:657-658`):
 *
 *     async _takePageSnapshot(context) {
 *       if (process.env.PLAYWRIGHT_NO_COPY_PROMPT)
 *         return;
 *
 * `# Page snapshot` is an aria snapshot of the LIVE page — every DOM text node
 * and every input's current value. The `e2e` job sets the variable to "1", and
 * `scripts/ci/check-e2e-lane.mjs` refuses every route to change it that a
 * workflow parser can read.
 *
 * An independent verifier then switched it off twice without touching anything
 * that parser reads. Round 1: `PLAYWRIGHT_NO_COPY_PROMPT: ""` at STEP level —
 * closed by computing the value across all three YAML scopes. Round 2: one line
 * in a committed `.npmrc`,
 *
 *     node-options=--import=data:text/javascript,process.env.PLAYWRIGHT_NO_COPY_PROMPT=%22%22
 *
 * which npm turns into NODE_OPTIONS for every `npm run`, so the variable is
 * blanked inside the Playwright process while every declaration in the
 * workflow still reads "1". The page snapshot came back with a `fill()` value
 * verbatim, and both static guards were green.
 *
 * A static guard cannot enumerate every way to rewrite a child process's
 * environment — `.npmrc`, `NODE_OPTIONS`, `$GITHUB_ENV`, a preload module, a
 * wrapper script. This check does not try to. It reads the value the Playwright
 * WORKER actually has, which is the process that takes the snapshot, whatever
 * route produced it.
 *
 * WHERE IT RUNS, AND WHERE IT DELIBERATELY DOES NOT.
 *   - In the worker-scoped automatic fixture, before any test or `beforeAll`
 *     runs: a worker whose environment is wrong never opens a page, so there is
 *     nothing to snapshot.
 *   - In the per-test fixture, after the test body and before its context is
 *     closed: a spec that rewrote `process.env` during its own body is caught
 *     before Playwright's recorder reads the variable.
 *   - NOT at module load. `e2e/harness/collection.test.ts` imports
 *     `playwright.config.ts`, which imports this harness, inside vitest in the
 *     `frontend` lane — where `CI` is set and this variable is not, because no
 *     page is ever rendered there. A module-scope check would have turned that
 *     lane red for a process that cannot produce a snapshot.
 *
 * ONLY WHEN `CI` IS SET. A developer running the lane locally still gets the
 * page snapshot on their own machine, where they are allowed to see it. GitHub
 * sets `CI` for every job, and the lane guard refuses the two ways the workflow
 * could take it away: declaring `CI` in any env map, at any scope, and any
 * `$GITHUB_ENV` write in the job. (A helper script that unsets it is the `run:`
 * class, named in AGENTS.md § Residuals.)
 *
 * WHAT IT DOES NOT CATCH, stated at its real strength: code that runs before
 * this module loads AND replaces `process.env` itself, or patches Playwright's
 * own recorder, can make this read "1" while the recorder reads something else.
 * That needs a preload that targets this check by name. The upload gate in
 * `scripts/ci/redact-artifacts.sh` is the layer underneath it: it refuses to
 * let any artifact carrying a `# Page snapshot` section be uploaded at all.
 */

export const PAGE_SNAPSHOT_KEY = "PLAYWRIGHT_NO_COPY_PROMPT";
export const PAGE_SNAPSHOT_VALUE = "1";

/**
 * A plain map rather than `NodeJS.ProcessEnv`: Next's types augment ProcessEnv
 * with a REQUIRED `NODE_ENV`, which would force every unit test to invent one.
 * `process.env` is assignable to this, so the default argument is unchanged.
 */
type Environment = Readonly<Record<string, string | undefined>>;

/** The failure message, exported so the lane guard and the demonstrations can match it. */
export const PAGE_SNAPSHOT_NOT_SUPPRESSED =
  `${PAGE_SNAPSHOT_KEY} is not "${PAGE_SNAPSHOT_VALUE}" in this Playwright worker`;

/**
 * `undefined` when the property holds, or a sentence saying why it does not.
 * The variable's actual value is deliberately NOT echoed: it arrived by a route
 * the static guard could not see, so it is untrusted text, and the log line
 * only needs to say that it is wrong.
 */
export function pageSnapshotProblem(env: Environment = process.env): string | undefined {
  if (!env.CI) return undefined;
  const value = env[PAGE_SNAPSHOT_KEY];
  if (value === PAGE_SNAPSHOT_VALUE) return undefined;
  const state = value === undefined ? "it is UNSET" : "it is set to something else";
  return (
    `${PAGE_SNAPSHOT_NOT_SUPPRESSED} (${state}). With it anything but "1", Playwright writes a ` +
    "`# Page snapshot` into `error-context.md` — an aria snapshot of the live page carrying " +
    "every DOM text node and every input's current value — and that file is uploaded. The " +
    "`e2e` job sets it at job level; if this fires, something between the workflow and this " +
    "process changed it: a committed `.npmrc` (`node-options`), `NODE_OPTIONS`, a `$GITHUB_ENV` " +
    "write, a preload module, or the spec itself. See AGENTS.md, § Artifact privacy."
  );
}

export function assertPageSnapshotSuppressed(
  when: string,
  env: Environment = process.env,
): void {
  const problem = pageSnapshotProblem(env);
  if (problem !== undefined) throw new Error(`${problem} [checked ${when}]`);
}
