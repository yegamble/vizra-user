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
 * CAPTURED AT CONFIGURATION LOAD, AND COMPARED — NOT READ LIVE (PR #8,
 * R3-FINDING J). The first version read `process.env` at the moment of each
 * check and returned early when `CI` was unset. An independent verifier put two
 * lines in a spec,
 *
 *     delete process.env.CI;
 *     process.env.PLAYWRIGHT_NO_COPY_PROMPT = "";
 *
 * and the check never fired: the spec had switched off the very variable that
 * switches the check on. So both variables are captured ONCE, when this module is
 * first evaluated — which happens while `playwright.config.ts` is being loaded
 * (it imports `./e2e/harness/test`, which imports this), in the Playwright MAIN
 * process before any spec file is collected and in every WORKER before any spec
 * file is loaded (`WorkerMain.runTestGroup` calls `_loadIfNeeded()` before
 * `loadTestFile`) — and every later check compares the LIVE values against that
 * capture. A difference is a failure BY NAME whatever the new value is, and
 * `CI` being deleted is itself the difference.
 *
 * AND THE CAPTURE IS RESTORED, not only reported. On a difference the live values
 * are put back before the check throws, so a check that runs before a context
 * closes PREVENTS the snapshot rather than only detecting it: Playwright reads the
 * variable when the context closes (`willCloseBrowserContext` →
 * `_takePageSnapshot`, `playwright/lib/index.js:655-658`), which is after the
 * harness fixture's teardown for every context the fixture depends on.
 *
 * WHERE IT RUNS, and what each place means — "prevents" means no page snapshot is
 * written; "detects" means the run fails by name but a snapshot may already be on
 * disk, and the pinned upload gate (`scripts/ci/redact-artifacts.sh`) is what keeps
 * it off the runner:
 *
 *   - main process, after the spec files are collected and before any worker is
 *     forked (the stamp reporter's `onBegin`): a change made at a spec's MODULE
 *     SCOPE during collection is restored before workers inherit the
 *     environment, and the run fails by name. PREVENTS.
 *   - worker start (the worker-scoped fixture, before any hook or test): the same
 *     module-scope change, re-made when the worker loads the spec file, is
 *     restored and the worker's tests fail before any page exists. PREVENTS.
 *   - before each test (the test fixture's setup): a change made in `beforeAll`,
 *     or late in the previous test. PREVENTS for this test's context.
 *   - after the test body (after `afterEach`, before the context closes): a change
 *     in the body, `beforeEach`, `afterEach`, or the teardown of a `test.extend`
 *     fixture that is torn down before the harness fixture. PREVENTS.
 *   - at the end of the harness fixture's teardown: a change made while the guard
 *     flushed the page (a page event handler). PREVENTS.
 *   - at worker teardown: anything after the last test — `afterAll`, or the
 *     teardown of a fixture the harness fixture DEPENDS ON (an overridden
 *     `context`/`browser`), which Playwright tears down AFTER the harness fixture
 *     and so after the context-close read. DETECTS only.
 *   - DETECTS only, too: a spec that itself closes a context (`context.close()`)
 *     after recording an error and changing the variable in the same body — the
 *     snapshot is taken during that close, before the after-body check.
 *
 * The capture is only as good as the moment it was taken: code that runs BEFORE
 * the configuration loads (a `--require`/`--import` preload, `NODE_OPTIONS`) is
 * captured as if it were the job's environment. For that route the POLICY check
 * below still applies to the captured value — in CI it must be exactly "1" — and
 * the lane guard refuses every route to a preload it can read.
 *
 * NOT AT MODULE LOAD, THE POLICY. Capturing is side-effect free; ASSERTING is not
 * done at load, because `e2e/harness/collection.test.ts` imports
 * `playwright.config.ts` inside vitest in the `frontend` lane — where `CI` is set
 * and this variable is not, because no page is ever rendered there.
 *
 * ONLY WHEN `CI` WAS SET, FOR THE POLICY. A developer running the lane locally
 * still gets the page snapshot on their own machine, where they are allowed to
 * see it. GitHub sets `CI` for every job, and the lane guard refuses the ways the
 * workflow could take it away (`CI` in any env map, `$GITHUB_ENV`, a job-level env
 * allowlist). The COMPARISON runs whether or not `CI` was set: a spec that changes
 * either variable fails locally too.
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

/** The two variables the page snapshot depends on. */
export const WATCHED_KEYS = ["CI", PAGE_SNAPSHOT_KEY] as const;
type WatchedKey = (typeof WATCHED_KEYS)[number];
export type CapturedEnvironment = Readonly<Record<WatchedKey, string | undefined>>;

export function captureEnvironment(env: Environment = process.env): CapturedEnvironment {
  return Object.freeze({ CI: env.CI, [PAGE_SNAPSHOT_KEY]: env[PAGE_SNAPSHOT_KEY] } as Record<
    WatchedKey,
    string | undefined
  >);
}

/**
 * THE CAPTURE. Taken when this module is first evaluated — during configuration
 * load, before any spec module exists in this process. Module-private and frozen:
 * nothing outside this file can replace it.
 */
const CAPTURED: CapturedEnvironment = captureEnvironment();

/** The name every tampering failure carries, so logs and demonstrations can match it. */
export const ENVIRONMENT_CHANGED =
  "the page-snapshot environment was CHANGED after the Playwright configuration loaded";

/** Which watched keys differ between the live environment and the capture. */
export function environmentChanges(
  live: Environment = process.env,
  captured: CapturedEnvironment = CAPTURED,
): WatchedKey[] {
  return WATCHED_KEYS.filter((key) => live[key] !== captured[key]);
}

/**
 * Put the captured values back. `undefined` is restored by DELETING the key, since
 * assigning `undefined` to `process.env` stores the string "undefined".
 */
export function restoreEnvironment(
  keys: readonly WatchedKey[],
  live: Record<string, string | undefined> = process.env,
  captured: CapturedEnvironment = CAPTURED,
): void {
  for (const key of keys) {
    const value = captured[key];
    if (value === undefined) delete live[key];
    else live[key] = value;
  }
}

/**
 * RESTORE-THEN-REPORT: `undefined` when nothing changed; otherwise the watched keys
 * are put back to the capture FIRST, and the sentence naming what changed is
 * returned. Values are never echoed — they arrived by a route nothing vetted — only
 * whether each key was set, unset or changed.
 */
export function takeEnvironmentChange(
  when: string,
  live: Record<string, string | undefined> = process.env,
  captured: CapturedEnvironment = CAPTURED,
): string | undefined {
  const changed = environmentChanges(live, captured);
  if (changed.length === 0) return undefined;
  const described = changed.map((key) => {
    const before = captured[key] === undefined ? "unset" : "set";
    const after = live[key] === undefined ? "unset" : "set";
    return `\`${key}\` (${before} at configuration load, ${before === after ? "a different value" : after} now)`;
  });
  restoreEnvironment(changed, live, captured);
  return (
    `${ENVIRONMENT_CHANGED}: ${described.join(", ")} [detected ${when}]. Both decide whether ` +
    "Playwright writes an aria snapshot of the live page — every DOM text node and every input's " +
    "value — into an uploaded `error-context.md`. They have been RESTORED to the values captured at " +
    "configuration load, and this run fails. A spec may read `process.env.NAME` and nothing else " +
    "(`vizra/no-process-env-write`); see AGENTS.md, § Artifact privacy."
  );
}

/**
 * `undefined` when the property holds, or a sentence saying why it does not.
 * Judged on the CAPTURED values by default, so a spec that later deletes `CI`
 * cannot switch the policy off. The variable's actual value is deliberately NOT
 * echoed: it arrived by a route the static guard could not see, so it is untrusted
 * text, and the log line only needs to say that it is wrong.
 */
export function pageSnapshotProblem(env: Environment = CAPTURED): string | undefined {
  if (!env.CI) return undefined;
  const value = env[PAGE_SNAPSHOT_KEY];
  if (value === PAGE_SNAPSHOT_VALUE) return undefined;
  const state = value === undefined ? "it is UNSET" : "it is set to something else";
  return (
    `${PAGE_SNAPSHOT_NOT_SUPPRESSED} (${state}). With it anything but "1", Playwright writes a ` +
    "`# Page snapshot` into `error-context.md` — an aria snapshot of the live page carrying " +
    "every DOM text node and every input's current value — and that file is uploaded. The " +
    "`e2e` job sets it at job level; if this fires, something between the workflow and this " +
    "process changed it before the configuration loaded: a committed `.npmrc` (`node-options`), " +
    "`NODE_OPTIONS`, a `$GITHUB_ENV` write, or a preload module. See AGENTS.md, § Artifact privacy."
  );
}

/** Throws, by name, if a watched variable changed since configuration load — after restoring it. */
export function assertEnvironmentUnchanged(
  when: string,
  live: Record<string, string | undefined> = process.env,
  captured: CapturedEnvironment = CAPTURED,
): void {
  const change = takeEnvironmentChange(when, live, captured);
  if (change !== undefined) throw new Error(change);
}

/**
 * Both checks: nothing changed since configuration load (restoring if it did), and
 * the captured values themselves satisfy the policy.
 */
export function assertPageSnapshotSuppressed(
  when: string,
  live: Record<string, string | undefined> = process.env,
  captured: CapturedEnvironment = CAPTURED,
): void {
  const change = takeEnvironmentChange(when, live, captured);
  const problem = pageSnapshotProblem(captured);
  const messages = [change, problem === undefined ? undefined : `${problem} [checked ${when}]`].filter(
    (message): message is string => message !== undefined,
  );
  if (messages.length > 0) throw new Error(messages.join("\n\n"));
}
