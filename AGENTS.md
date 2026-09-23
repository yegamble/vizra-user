# vizra-user — engineering contract

This repository is a component of **yegamble/vizra** (the meta repo). The meta
repo's `AGENTS.md` binds here in full; this file adds only what is specific to
the frontend. Where the two ever appear to disagree, the meta contract wins and
the disagreement is a bug to report, not a licence to choose.

Read before editing: the meta `AGENTS.md`, the meta `docs/DESIGN_BRIEF.md`, the
ADR the change touches (`docs/adr/` in the meta repo — ADR-001 pins, ADR-002
contracts and CI, ADR-003 identity/sessions/CSRF, ADR-009 platform), the
ledger entry for the acceptance ID, and this file. Do not preload the tree.

## What this repository is
The Next.js App Router frontend. It renders; it does not decide. Authorization,
visibility, quota, and every other rule live in `vizra-core` and are enforced
there. A check in this codebase is a convenience for the person using it, never
a security control — a browser-only role check is not authorization (meta
`AGENTS.md`).

There is no business backend here and no direct database access. Everything
comes from vizra-core over HTTP.

## The two fetch helpers, and why there are exactly two
`lib/api/fetch.ts` exports `publicFetch` and `viewerFetch`. ADR-003 fixes their
contract:

- **`publicFetch`** is anonymous by construction — its options type has no slot
  for a header, cookie or token — and may be cached or revalidated, because a
  cache entry built from no identity is correct for every anonymous viewer.
  Early invalidation is done with visibility-versioned URLs, not cache purges.
- **`viewerFetch`** forwards only the `__Host-vizra_session` cookie, always
  sets `cache: "no-store"`, and has no freshness option at all. It sends the
  configured `Origin` on state-changing requests, which is what core's CSRF
  check compares against.

Three layers enforce it, and the order matters — the weakest is the one people
notice first:

0. **The module boundary.** `lib/api/fetch.ts` and `lib/config.ts` both carry
   `import "server-only"`, so a Client Component that imports either is a
   `next build` FAILURE rather than a module that ships and throws in the
   visitor's browser. `assertServer` stays as the runtime half.
   `scripts/ci/check-server-only-boundary.sh` proves the build really fails,
   and `scripts/ci/check-client-bundle.sh` proves no chunk under `.next/static`
   carries the internal base URL or the configured origin.
1. **Types.** `publicFetch` has no header option at all; `viewerFetch` has no
   cache option. Neither can be misused without changing the helper.
2. **Runtime, asserted by test.** `lib/api/fetch.test.ts` asserts that
   `viewerFetch`'s init is `cache: "no-store"` with no `next` over every
   method/body/upload combination, that `cookies()` is read on every path, and
   that `publicFetch` never reads it. Lint reads syntax; a refactor can change
   syntax without changing behaviour, so the behaviour is pinned here.
3. **Lint**, as the cheapest layer rather than the last one:
   - `vizra/no-raw-fetch` — only `lib/api/fetch.ts` may *call* global `fetch`,
     and **no file, including that one, may alias the binding**
     (`const f = fetch`, `const { fetch } = globalThis`,
     `globalThis["fetch"]`). An aliased fetch is invisible to the identity
     rule. Indexing `globalThis`/`window` by a computed name the rule cannot
     read (`globalThis[name]`) is an error too — it cannot rule out `fetch`,
     so it fails closed.
   - `vizra/no-identity-headers-in-cached-fetch` — a `fetch` carrying a
     `cookie`, `authorization`, `proxy-authorization` or `x-vizra-session`
     header (or `credentials: "include"`) must be explicitly
     `cache: "no-store"`. It **fails closed**: an init it cannot read in full —
     hoisted into a variable, spread, computed keys, headers from a call —
     is an error, not a pass. `fetch(url)` with no init stays legal.
   - Both are `error`, never `warn`, in every directory.

Why fail closed: two independent reviewers broke the first version of the
identity rule by hoisting the init into a variable — a refactor any reviewer
would wave through — and a cached response built from one viewer's credentials
is served to the next visitor, with no error, no log line and no failing test.
The cost is that a dynamic init must be written as a literal at the call site,
or go through the helpers. That is the trade, on purpose.

Every request is bounded: `API_TIMEOUT_MS` (default 10 s) is both the default
deadline and the ceiling a caller cannot exceed.

If you need a third helper, that is an ADR amendment, not a file.

## The API contract is not ours
`vizra-core/api/openapi.yaml` is the single API source (ADR-002). In this
repository:

- `contracts/vizra-core/api/openapi.yaml` is a **vendored copy**;
  `contracts/manifest.json` records the source repo, the source **ref** and the
  40-character commit it was taken from, the git blob id of those exact bytes,
  their sha256 and length, and the date.
- The vendor script reads the spec **out of core's object database**
  (`git show <ref>:api/openapi.yaml`), never from a checkout's working tree, so
  the bytes and the recorded commit cannot disagree and a dirty tree cannot be
  vendored. The default ref is `main`, and `check:contract` refuses a manifest
  whose `source_ref` is anything else — vendoring from a feature branch is how
  PR #1 came to name `b0dbeb6…` on `feat/m0-foundation`, which core then
  squash-merged and deleted, leaving the recorded commit unreachable from any
  ref in the canonical repository with nothing going red.
- `lib/api/generated.ts` is generated from that copy by the pinned
  `openapi-typescript`. It is never hand-edited, never linted, and never
  partially updated.
- `npm run check:contract` proves the vendored spec matches its manifest and
  the committed client is byte-for-byte what the generator produces. The
  `contract` lane runs it on every PR.
- The manifest's provenance is **read, not merely written**
  (`scripts/check-manifest.mjs`, called by `check:contract`): the schema
  version, the repo and path ADR-002 names, `source_ref: main`, a full 40-hex
  `source_commit` and `source_blob`, and a sha256, byte count and blob id that
  all match the file on disk. Before this, those fields were prose — nothing
  read them, and PR #1's dead commit passed every lane.
- The spec is validated **as input** before the generator reads it:
  `scripts/check-spec-refs.mjs` refuses any `$ref` that is not an in-document
  pointer. openapi-typescript resolves external `$ref` targets through
  `@redocly/openapi-core` — demonstrated, not assumed: a remote `$ref` makes
  the generator issue an outbound request during the `contract` lane. A file
  `$ref` is refused too, because the vendored contract is one file recorded by
  one sha256 and a second file would be input the drift check does not cover.
- To take a newer contract:
  `node scripts/vendor-contract.mjs --from ../vizra-core --ref main` (the ref
  defaults to `main`), then commit the spec, the manifest and the regenerated
  client together. Fetch the core checkout first: the script vendors the local
  ref and warns — but does not fail — when it differs from `origin/<ref>`.

Never hand-write a request or response type for an endpoint the contract
already describes, and never "temporarily" edit the vendored spec to unblock
work here. A contract change is vizra-core's to make.

### Owed — STALENESS IS NOT DETECTED HERE (open owner item)

Do not treat this as covered, and do not read a green `contract` lane as
saying the vendored contract is current.

`check:contract` now proves the manifest is **internally honest**: well formed,
pointing at `main`, naming a full commit id, and describing the bytes actually
committed. Every one of those is an offline, credential-free check of this
repository against itself.

What it still cannot do is compare the vendored copy with what
`yegamble/vizra-core` **serves today**. It cannot prove the recorded commit
exists, that the blob is the one that commit holds, or that core's `main` has
not moved on since — so a vendored contract that is months stale passes every
lane here, exactly as a contract vendored from a deleted branch used to.

The blocker is access, not design: `yegamble/vizra-core` is **private** and this
repository holds **no read token for it**, so the `contract` lane cannot fetch
core's default branch. **Providing that read-only token is an owner action,
outside any pull request.** When it exists, add a step to `contract-ci.yml` that
resolves `yegamble/vizra-core`'s default branch, compares its
`api/openapi.yaml` blob id with `contracts/manifest.json`'s `source_blob`, and
fails when they differ.

Until then, a stale vendor is caught only by review of
`contracts/manifest.json`'s `source_commit` against core's history, and by
core's own route↔spec test. Both are review, not CI.

## No mock data on a product path
No component invents data, and no page ships a fixture as content. If the API
cannot answer, render the real failure state. A fake success — a toast, a
placeholder row, a control that does nothing — is a defect, not a placeholder
(meta `AGENTS.md`, `docs/DESIGN_BRIEF.md`).

## Commands
| Command | What it does |
|---|---|
| `npm ci` | install exactly `package-lock.json` (never `npm install` in CI) |
| `npm run dev` | development server |
| `npm run ci` | **the gate**: `lint`, `typecheck`, `test`, `build` |
| `npm run lint` / `typecheck` / `test` / `build` | the individual steps |
| `npm run e2e:install` | download the pinned Chromium the browser lane needs (once) |
| `npm run e2e` | **the browser lane**: Playwright against the production build, desktop 1440 px and mobile 390 px |
| `npm run e2e:demos` | run the red/green demonstrations that prove the harness fails |
| `npm run check:contract` | vendored spec ↔ manifest ↔ generated client (runs the manifest check first) |
| `npm run codegen` | regenerate the client from the vendored spec |
| `node scripts/check-manifest.mjs` | `contracts/manifest.json` is well formed and describes the vendored file: `source_ref: main`, 40-hex commit and blob, matching sha256 and byte count. It does NOT detect staleness — see "Owed" above |
| `node scripts/vendor-contract.mjs --from ../vizra-core --ref main` | take a newer contract, read from core's object database at that ref |
| `bash scripts/demonstrate-contract.sh` | the contract guards' red/green demonstrations — a hand-edited client, an edited spec, a remote `$ref`, and four manifest mutations; transcripts to `docs/evidence/revendor/` |
| `bash scripts/ci/require-checks_test.sh` | the `ci-required` fan-in's own suite, plus the manifest-floor and image-pin cases |
| `bash scripts/ci/check-required-floor.sh` | the required-check manifest still demands `frontend` and `contract` |
| `bash scripts/ci/check-image-pins.sh` | every Dockerfile `FROM` is `@sha256`-pinned at the `.nvmrc` version |
| `bash scripts/ci/check-client-bundle.sh` | no server-side configuration reached `.next/static` (run after a build) |
| `bash scripts/ci/check-e2e-lane.sh` | PARSES the `e2e` workflow AND the Playwright configurations AND `package.json`. **Every step it relies on is PINNED, not recognised**: the image build, the fixture-free check, the container start, the lane, the coverage floor, the canary, the browser-revision record, the redaction/upload gate and the upload must each appear EXACTLY ONCE, DEEP-EQUAL to its body in `.github/e2e-pinned-steps.yml` (every key and value; no key the pin lacks); a step anywhere in the workflow that mentions a pinned role's token but is not its pin is refused by name; the pins file itself must satisfy the policy (exact `run:` of lane, floor, canary, fixture check, browser-revision record and redaction; the upload's gate, paths, retention and `if-no-files-found: error`); the `with:` of `actions/checkout` and `actions/setup-node` exact, and workflow `permissions:` exactly `contents: read`; root install lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`, `dependencies`) refused; the upload IMMEDIATELY follows the redaction, which follows the lane, floor and canary; env is DEFAULT-DENY (none at workflow level, only `PLAYWRIGHT_NO_COPY_PROMPT` at job level, none on an unpinned step; `HOME` refused by name); no `defaults:`, job keys allowlisted, `runs-on: ubuntu-24.04`; upload `path:` entries are literals from a fixed allowlist across EVERY job; `uses:` is a pinned allowlist; no reusable workflow, no `$GITHUB_STEP_SUMMARY`, no `include-hidden-files: true`, retention &le; 3 days, `.vizra-e2e` in no `path:` of any workflow; `globalSetup`/`globalTeardown` refused; `scripts.e2e*` byte-equal to their documented literals and no pre/post hook; `PLAYWRIGHT_NO_COPY_PROMPT` exactly once, at job level, `"1"`; `DEBUG`/`PWDEBUG`/`NODE_OPTIONS`/`CI`/`npm_config_*`/other `PLAYWRIGHT_*` refused at every env scope; a committed `.npmrc` default-deny; `$GITHUB_ENV`/`$GITHUB_PATH`/`$GITHUB_STEP_SUMMARY` refused in `run:` text and env values; YAML merge keys refused in every workflow; the harness must CALL the runtime page-snapshot assertion; Lane A records NO PIXELS: `use.screenshot` and `use.video` exactly `"off"` and `use.trace` exactly `{ mode: "retain-on-failure", sources: false, screenshots: false }`, read as literals, in no project overridden, and the demos configuration declaring neither `use` nor `projects` |
| `node scripts/ci/check-coverage-floor-ran.mjs` | the finished JSON report satisfies `e2e/harness/required-projects.json` AND every result that succeeded carries a valid harness stamp (run after the lane) |
| `node scripts/ci/harness-canary.mjs` | the guard itself still fails a broken page: each of the **four** fault-injection fixtures — one per guarded signal kind — must fail with the exact SET of record kinds it demonstrates and no others (needs a production target, as the lane does) |
| `bash scripts/ci/redact-artifacts.sh` | strip URL query strings from artifacts, inside `trace.zip` members too, before upload, using the FOUR programs in `e2e/harness/redaction-patterns.json` (shared with the harness redactor); REFUSE — exit 1, so nothing uploads — if any file or member carries a `# Page snapshot`; and REFUSE — exit 3 — a named directory that does not exist, so a mistyped or dropped argument cannot empty the gate |
| `npx vitest run e2e/harness/redaction-corpus.test.ts` | both redactors over one 42-entry corpus, every output byte for byte; the shell half runs the shipped script. Part of `npm run test` |
| `node scripts/ci/check-source-hygiene.mjs` | no literal control bytes in a tracked text source, and `mutation-digests.txt` is COMPLETE (every label `demonstrate.sh` records) and matches this tree. Part of `npm run ci` |
| `node scripts/ci/ts-source-facts.mjs` | (library) facts read from a PARSED TypeScript tree, so a comment, a string literal, `void f()` or a shadowed callee cannot satisfy a guard's check. Unit-tested in `ts-source-facts.test.mjs` |
| `bash scripts/e2e/sweep-artifacts.sh SENTINEL DIR` | search every byte of an artifact tree for a value, with `.zip` members unpacked AND `;base64,` payloads decoded and recursed into |
| `bash scripts/ci/check-no-test-fixtures-in-image.sh` | the built image contains no harness file and no fixture token (needs a built image) |
| `bash scripts/ci/check-server-only-boundary.sh` | a Client Component importing the server-only modules fails `next build` |
| `node scripts/check-spec-refs.mjs` | the vendored contract references nothing outside itself |

Run `npm run ci` before opening a PR. A missing command or dependency is
BLOCKED, never a pass.

## The browser lane (VZ-FOUND-008)
No UI feature is VERIFIED because it renders. The meta `AGENTS.md` (step 4)
requires the running **production-mode** UI to be exercised in a real browser,
desktop and mobile, with console and network errors treated as failures. That is
what `npm run e2e` is, and every later UI slice proves itself through it.

**It drives a production build, always.** In CI the `e2e` workflow builds this
repository's Dockerfile, runs the image and points the harness at the container.
Locally `scripts/e2e/serve-production.mjs` runs the standalone server exactly as
the image's `CMD` does — `next dev` is never a valid target, and
`e2e/specs/production-build.spec.ts` asserts five independent production markers
(no dev-only bundles, no HMR WebSocket, no `<nextjs-portal>` overlay, a build id
that is not `development`, immutable `/_next/static` caching) so a lane pointed
at the wrong server goes red rather than quietly testing something else.

**Default-deny on browser errors, over every page the WORKER opens.**
`e2e/harness/test.ts` has two automatic fixtures, and which is which matters:

| Fixture | Scope | What it does |
|---|---|---|
| `vizraWorkerGuard` | **worker**, automatic | installs the BrowserContext-level listeners and the creation guard, for the worker's whole life, into one append-only buffer |
| `vizraHarnessGuard` | test, automatic | charges each recorded signal to exactly one test, judges it under that test's allow-list, and writes the runtime stamp |

For every test, a console error, an uncaught exception, a failed request or any
HTTP >= 400 response **observed by a browser context** fails the test — whether
or not the test body looked, whichever page produced it, **and whether the page
was touched by the test body, by a `beforeAll`/`beforeEach` hook, or by an
earlier test that shared it.** Signals produced after the last test in a worker
(an `afterAll` hook) belong to no test and fail the **run**, from the worker
fixture's teardown.

Two things that sentence still does not cover, both stated in § Residuals rather
than implied away: a 404 from Playwright's `request` fixture is not a browser
signal, and the flush window is finite at both ends. The only way past the guard
is per test:

```ts
test.use({
  browserErrorPolicy: {
    allow: [{ kind: "response", match: /\/icon\.svg$/, reason: "not built yet (VZ-...)" }],
  },
});
```

`kind`, a RegExp `match` and a non-blank `reason` are all required, and a policy
of the wrong shape throws rather than being coerced.

#### WHY AT THE BROWSER, AND WHY ONE FIXTURE

The guard used to live in an override of the `page` fixture, beside a separate
automatic fixture that wrote the stamp. `test.extend` replaces one without the
other, and an independent verifier did exactly that — four lines of ordinary,
lint-clean Playwright in a normal spec, touching no gate file:

```ts
const test = base.extend({
  page: async ({ browser }, provide) => {
    const ctx = await browser.newContext();
    await provide(await ctx.newPage());
  },
});
```

The spec kept its valid stamp; the guard simply was not there. `npm run ci` exit
0, the lane exit 0 with "20 passed, coverage floor: OK, harness stamp: OK (20
verified)", both floor checks exit 0, the canary exit 0, the workflow parser
exit 0 — on a page that 404s a sub-resource and throws on every load. The stamp
proved "this test came from the harness `test` object"; the claim being made is
"this test ran the guard".

Two changes make those the same sentence again.

**One fixture per test.** The accounting and the stamp are in
`vizraHarnessGuard`, so removing one removes the stamp, which both the
in-process reporter and the out-of-process check already refuse.

**And the second fixture is BRANDED.** The listening later had to move to a
worker-scoped fixture (below), which re-opened exactly this shape one level up:
`test.extend({ vizraWorkerGuard: … })` with a no-op would keep the test fixture,
keep its stamp, and lose the listeners. So `createWorkerHarness` records what it
builds in a module-private `WeakSet` that nothing outside
`e2e/harness/worker-guard.ts` can add to, and `vizraHarnessGuard` throws
**before it stamps** if what Playwright handed it is not branded. Replacing the
worker fixture therefore costs the stamp too — demonstrated in **D15h**, and
refused by the lint rule as the early warning.

**Attached at the browser, not at a page.** Guarding a second page would have
moved the hole to a popup, a new tab or a fresh context. The fixture takes
`browser` as a dependency and attaches `console`, `weberror`, `requestfailed`
and `response` listeners at **BrowserContext** level — all four exist on
`BrowserContext` in the installed Playwright 1.63.0 types, checked in
`playwright-core/types/types.d.ts` rather than assumed — and a context event
fires for every page in that context. It sweeps the contexts that already exist
and wraps `browser.newContext` / `browser.newPage` for the WORKER's lifetime,
restoring both afterwards. (It was the test's lifetime until the `beforeAll`
finding below; the browser is worker-scoped and shared, so the listening has to
be too.)

Covered, each demonstrated red then green in **D13**: the verifier's exploit
verbatim; a second page in the default context; `browser.newContext()` in the
body; `browser.newPage()`; an overridden `context` fixture; an overridden `page`
fixture that navigates **inside itself** and never in the body; a popup the page
opens with `window.open`; and an overridden `browser` fixture (which needs no
import at all — `playwright` is a built-in fixture — so lint cannot see it and
only the runtime catches it).

**And the routes that went AROUND the instance wrapper.** Wrapping the browser
instance's own `newContext` / `newPage` left the prototype method reachable, and
left a spec free to launch a browser of its own — three import-free routes an
independent verifier walked through the complete gate. `e2e/harness/creation-guard.ts`
closes them: `Browser.prototype.newContext` / `newPage` are patched so every
context they produce is REGISTERED with the guard, `BrowserType.prototype`'s
`launch` / `launchPersistentContext` / `launchServer` / `connect` /
`connectOverCDP` (and Electron's and Android's equivalents) are REFUSED while a
test is running, and `vizraHarnessGuard` asserts in teardown that no live
context on the browser is one the guard never registered. Both prototypes are
patched before any spec can observe an unpatched one. § Residuals gives the
route-by-route table, the demonstration for each, and what is still open.

#### AND WHY THE LISTENING IS WORKER-SCOPED

Attaching at the browser was not enough, because it was attached at the wrong
TIME. The listeners were installed by the test-scoped fixture, and Playwright
sets that up **after `beforeAll` has already run**. An independent verifier
walked through with the idiom Playwright's own documentation teaches:

```ts
let shared: Page;
test.beforeAll(async ({ browser }) => {
  shared = await browser.newPage();
  await shared.goto("/");                 // 404s a sub-resource, throws
});
test("…", async () => {
  await expect(shared.getByRole("heading", { level: 1, name: "Vizra" })).toBeVisible();
});
```

`tsc` exit 0, `eslint` under the shipped configuration 0 errors,
`npx playwright test` **1 passed** — on a page that 404s and throws. The
fixture's own attachment read `{ contextsGuarded: 2, contextsUnguarded: 0,
creationViolations: [], records: [] }`: every control reporting success while
the guard had observed nothing, because the page had already done everything it
was going to do. Nobody writing that spec is evading anything, and a documented
residual is not a control when the bypass is an idiom honest builders will
write.

**The measured order, on the installed 1.63.0** (a probe printed it; it was not
assumed):

```
worker-auto SETUP
  beforeAll
  test-auto SETUP → beforeEach → body → afterEach → test-auto TEARDOWN
  test-auto SETUP → beforeEach → body → afterEach → test-auto TEARDOWN
  afterAll
worker-auto TEARDOWN
```

So the LISTENING moved to `vizraWorkerGuard`, which is set up before the first
`beforeAll`, and only the ACCOUNTING stayed per test. The buffer is append-only,
so a record's index is a monotonic sequence number, and each test claims two
windows: everything since the previous test finished (a hook, or a page shared
with an earlier test), and everything during its own body. Both are judged under
the same per-test allow-list, and the failure **names the phase** — "BEFORE THE
TEST BODY" is the sentence four verification rounds could not say.

Demonstrated red in **D15**: the verifier's `beforeAll` spec verbatim;
`beforeEach`; a page shared between two tests, where the second is charged; a
`describe.serial` journey; a worker-scoped fixture of the spec's own; and
`afterAll`, which fails the RUN because there is no test left to fail. The
inverse control matters as much: an honest `beforeAll` that opens a page and
shares it across two healthy tests stays **green** (D15k). And **D15i** cuts the
before-phase accounting with a controlled mutation and shows the verifier's spec
going green again — which is what makes the red halves mean something.

**`context` is a declared dependency purely for ordering, and the ordering was
measured.** Depending on `browser` alone, Playwright sets an automatic fixture
up first and tears it down last: a probe printed `pages=0` at that moment, the
flush had nothing to flush and the failure's own trace had already been written
(a demonstration that inspects that trace went from 21 members to 8). Depending
on `page` fixed the teardown and broke the setup: the guard was installed after
an overridden `page` fixture had already navigated, and that spec **passed** on
a broken page. Depending on `context` gives both — Playwright's `page` fixture
does not close the page, the context does — so the wrapper is installed before
`page` exists and the page is still open (`pages=1`) when the guard asserts.

**`test.extend` is not banned, and must not be.** Overriding `page`, `context`
or `browser` for a viewport, a locale or a second context is legitimate and
stays green — D13's inverse control is exactly that, an honest override on a
healthy page. What `vizra/no-unguarded-playwright-import` refuses is replacing a
fixture the harness owns (`vizraHarnessGuard`, its former name
`vizraHarnessStamp`, and `browserErrorPolicy`), and it fails closed on a
fixtures object it cannot read in full. That is the early warning; the control
is that removing the guard removes the stamp.

#### The control is the RUNTIME STAMP. Lint is the early warning.

A spec may not reach `@playwright/test` at all, and may take `test`/`expect`
only from `e2e/harness/test`. There are two layers, and it matters which one is
the guarantee, because for three rounds the wrong one was.

**Layer 1, the guarantee — every test the harness runs is STAMPED.**
`e2e/harness/test.ts` has an automatic fixture that writes an annotation whose
value is an HMAC over that test's identity (project, spec file, title, worker,
attempt), under a key minted fresh by the Playwright main process on every run.
Two checks then refuse a run in which a test *succeeded* without a valid stamp,
naming the file:

| Where | What it reads |
|---|---|
| `e2e/harness/stamp-reporter.ts` | inside the Playwright process, from `onTestEnd` |
| `scripts/ci/check-coverage-floor-ran.mjs` | outside it, from the finished JSON report |

Playwright's own `test` writes no such annotation, so **a spec that reaches the
raw runner — by any syntax, from any directory, with any lint suppression — is
RED at runtime.** Nothing about that depends on what a file looks like.

The stamp is written by the fixture that does the accounting, and that fixture
refuses to stamp unless the worker-scoped listener it was handed is one the
harness built, so **stamped implies guarded**: a spec cannot keep one and drop
the other, at either scope. That sentence was false for one round at the test
scope, and would have become false again at the worker scope; the section above
says how both were closed.

The key is not readable from a spec **running in a worker**. It reaches workers
through the environment, and `e2e/harness/stamp.ts` **deletes it from the
worker's `process.env` while the configuration is being loaded**, which in a
worker happens before any test file is evaluated (`WorkerMain.runTestGroup` calls `_loadIfNeeded()` — which
re-executes `playwright.config.ts` — before `loadTestFile`; read out of the
installed `playwright/lib/worker/workerProcessEntry.js`, not assumed). That is
why `playwright.config.ts` imports `./e2e/harness/test`: the import is a
load-bearing side effect, and `check-e2e-lane.mjs` fails if it goes. The signer
is handed out **once per worker**, to the harness entry, during that same load —
so a spec that imports `e2e/harness/stamp` and calls `claimSigner()` itself gets
a throw. The reporter writes the key to `.vizra-e2e/stamp-key.json` only in
`onEnd`, after the last test has finished, so the out-of-process check can
verify it while no spec running in a worker could have read it.

**NOT in the main process.** `npx playwright test` collects spec files IN the
Playwright MAIN process (`InProcessLoaderHost`, `playwright/lib/runner/index.js`),
after the configuration has loaded — and the main process keeps the key in its
`process.env` on purpose, because that is how forked workers inherit it. So by
reading, a spec's MODULE SCOPE can read the key during collection. Whether that
yields a working forgery (it would also need a channel into a worker) was not
established, and no probe was built (verifier finding V-D, pre-existing since PR #7).
The fix is queued for PR B; until then, read "absent" below as "absent from the
worker".

**What forging a stamp would take, stated honestly.** One of:

1. recovering the 32-byte per-run key from inside a spec — it is absent from the
   worker's environment and from disk while any test is running, and not
   derivable from the report; it IS in the main process's environment while
   spec files are collected there (above);
2. importing `e2e/harness/stamp` or `e2e/harness/stamp-reporter` from a spec.
   `claimSigner()` already refuses the second claim in a worker
   (demonstration D11d), and `vizra/no-unguarded-playwright-import` refuses the
   reference as a *sealed module* — but that lint half is an early warning, not
   the control;
3. editing `e2e/harness/**`, `playwright.config.ts` or `eslint-rules/**`. Those
   are `.github/CODEOWNERS` paths, `npm run test` fails if the rule or the
   wiring is neutered, and the `e2e` lane's canary (below) goes red if the guard
   itself stops failing a broken page.

None of those is an accident, and every one is a named edit in the diff. The
claim this section makes is therefore precise: **a test cannot pass without the
harness** — subject to the main-process note above, which is NOT CLOSED — and
switching the harness off is a deliberate act in a file whose job is to be a
gate — not a one-line opt-out in a spec.

**Layer 2, the early warning — the ESLint rule.**
`vizra/no-unguarded-playwright-import` is an error for **everything under
`e2e/` except `e2e/harness/**`**, covering every spelling: named, namespace,
default, side-effect, `require`, dynamic `import()`, either quote style,
re-exports, and a local shim that re-exports the raw binding. Type-only imports
of types are allowed; `import type { test }` is not. The unscoped
`playwright/test` and `playwright` are banned too: the first re-exports the same
runner, and a spec has no business launching its own browser.

The glob is `e2e/**`, not a list of directories, because a list of directories
was the third bypass: `playwright.config.ts` collected `**/*.spec.ts` from the
whole of `e2e/` while both source guards enumerated `e2e/specs` and `e2e/demos`,
so a spec at `e2e/other/x.spec.ts` ran and was linted by nothing. Both ends are
now closed: **`testDir` is `./e2e/specs`** (and the demo runner's is
`./e2e/demos`), so a file elsewhere is not collected at all, and the lint glob
covers it if anyone writes one. `e2e/harness/collection.test.ts` pins both
roots; `e2e/harness/browser-errors.test.ts` asks the resolved ESLint config
about every file under `e2e/` *and* about paths in directories that do not exist
yet, so the assertion is about the class rather than about today's directories.

`linterOptions: { noInlineConfig: true }` is set for the same glob, because
without it the rule was optional: a verifier put
`/* eslint-disable vizra/no-unguarded-playwright-import */` above an unguarded
import in a spec whose page 404s a sub-resource and throws on every load, and
got `npm run ci` exit 0, the full lane exit 0 with "20 passed, coverage floor:
OK", both floor checks exit 0 and the lane guard exit 0.
`reportUnusedDisableDirectives` cannot help — the directive is *used*.
`browser-errors.test.ts` asserts both the setting and the behaviour;
`no-console` is therefore turned off for `e2e/demos/**` by configuration rather
than by a comment, because the console call there IS the fault under
demonstration.

**The history, kept because it is the argument.** This section has twice
described a control that could be walked through. A regex over spec sources
required braces and double quotes, and `import * as pw from "@playwright/test"`
and the single-quoted named form both went through it. The AST rule that
replaced it was defeated by one comment. The comment fix was defeated by a new
directory. Each fix was a lint fix, and lint inspects source rather than what
runs; that is why the guarantee moved to the runtime and why this section now
says which layer is which. Demonstration D11 runs all three historical doors,
plus two forgery attempts, through Playwright **with no ESLint anywhere in the
command**.

### Artifact privacy: what is redacted, and what is NOT

**Covered — query strings and fragments, in the URL shapes the FOUR programs
below match, and `Location`.** Read the list before relying on it: it is not
"every query string in every artifact", and this section has claimed that twice.

**The two redactors are ONE program in behaviour, by construction.**
`e2e/harness/redact.ts` (what the harness prints) and
`scripts/ci/redact-artifacts.sh` (the bytes CI uploads) both read
`e2e/harness/redaction-patterns.json`, and `e2e/harness/redaction-corpus.test.ts`
runs BOTH — the shell half by executing the shipped script, as CI does — over
one corpus of 42 inputs and checks every output **byte for byte**. The only
difference is the replacement text (`?<redacted>` in the shell, a parameter count
in the harness), and the corpus pins both. This used to be two hand-kept copies
that AGENTS.md called "the same four programs"; an independent verifier showed
they matched different shapes (PR #8, R2-FINDING C), and the round-1 shell
script fails 26 of the corpus's 95 assertions.

| Program | Matches | Example |
|---|---|---|
| absolute | `scheme://…` (`http`, `https`, `ws`, `wss`, `ftp`), **case-insensitively**, including a bracketed IPv6 host | `HTTPS://h/p?q`, `http://[::1]:3000/p?q` |
| protocol-relative | `//host[:port]/path?query` — which also catches a scheme the absolute program does not list, from its `:` (`s3://bucket.example/k?q`) | `//host.example:8443/p?q` |
| authority-relative | `host[:port]/path?query` — dotted host, IPv4, **bracketed IPv6 with an optional zone id** (`[fe80::1%25eth0]`), any label with an explicit `:port`, or bare `localhost` | `host:3219/m.jpg?q`, `[::1]:3000/p?q` |
| path-relative | `/path?query` | `/m.jpg?q` |

**Where a URL may start.** The three scheme-less programs start at the beginning of
a line, whitespace, `"`, `'`, `(`, `<`, `[`, `=`, `,`, `>`, **`:` or `;`** — so
`url:h.example:3000/p?q`, `GET:/p?q` and `a;/p?q` are covered (R3-FINDING I). A `;`
that ENDS an HTML-entity slash (`&#47;`, `&sol;`, `&#x2F;`) is not a start: every
entity in a long path would otherwise begin a fresh scan to its end, which is
quadratic (measured 25 s on a 240 KB line; a corpus test bounds it).

**Encoded separators (R3-FINDING I).** A slash may be written `/`, `\/`, `\\/` or
`\\\/` (JSON escaping, up to three levels), `\u002f` (1–3 backslashes), `\x2F`,
`%2F`, `&#47;`, `&#x2F;` or `&sol;`; the `?` may be written `\u003f`, `\x3F` or `%3F`
(and `#` starts a fragment, which is how `&#63;` is caught); the scheme's `:` may be
`%3A` or `\u003a`, so a fully percent-encoded URL standing alone
(`https%3A%2F%2Fh%2Fp%3Fq`) is covered. Any OTHER `\uXXXX` or `\xXX` escape may
appear inside the host, the path or the query — not in place of the separators
listed here. All of it lives once, in the `fragments` of
`e2e/harness/redaction-patterns.json`, which both redactors expand the same way.
That covers what a slash-escaping serializer emits (PHP's `json_encode`), the
DOUBLE-escaped form Playwright writes into `results.json` and
`trace.zip::test.trace` when a spec prints such a string — measured through the
real lane in demonstration **D16d** — and **`&` written as `\u0026`**, which is what
Go's `encoding/json` does by default and therefore what vizra-core's JSON
responses will contain. The query match stops at a bare backslash, so an escaped
closing quote (`\"`) is left intact and the document is still valid JSON; the
corpus asserts that for every JSON entry.

**NOT covered by these programs, stated so it is not assumed:** a
protocol-relative or authority-relative URL with **no path** (`//host?q`,
`host:3000?q`); a single-label host with no port and no scheme
(`intranet/p?q`); a query string split across two JSON fields or two archive
members, **or by a line wrap inside one field** (`…?a=1&s⏎ig=…`, or a wrap before
the `?`); a `?` written as an HTML named entity (`&quest;`) or a `#` written
`%23`/`\u0023`; a slash or separator escaped with four or more backslashes; a URL
inside a `.png`, `.webm` or other binary member. A single URL longer than Perl's
32 766-iteration limit for a repeated group is cut there by the shell redactor,
which then redacts from a later separator — over-redaction, measured, not a leak. **Do not widen
this claim without a corpus case.** The price of the current width is deliberate
over-redaction of a `1:23/foo?x=y`-shaped string, which costs diagnostic text and
leaks nothing.

Two layers, because they reach different bytes.

| | Covered by | What it reaches |
|---|---|---|
| Harness output — failure messages, `browser-signals.json`, CI log lines, the committed transcripts | `e2e/harness/redact.ts`, at capture | everything the harness itself records |
| Playwright's own recordings — `trace.zip` members, the HTML report, `error-context.md` | `scripts/ci/redact-artifacts.sh`, before upload | bytes the driver wrote before any harness code saw them |

`redact.ts` alone was NOT enough, and the gap was not theoretical: a verifier
drove a page holding `?X-Amz-Signature=…` and found it redacted in every
harness line and present **verbatim** inside `trace.zip` members
`1-trace.network` and `1-trace.trace` — which the `e2e` lane uploads as a
14-day artifact. Verified end to end afterwards, including in the real uploaded
CI artifact from run 35536837315: **239 `?<redacted>`, zero live queries**, host
and path intact. The upload is gated on
`steps.redact.outcome == 'success'`, so a redactor that fails publishes nothing
at all — two bare `if: failure()` conditions are not a sequence.

**COVERED NOW: the SCHEME-LESS `host:port/path?query`, which is how Playwright
records a step subtitle.** This section once claimed "no URL query string leaves
this repository, in any artifact". That sentence was false, and an independent
verifier reduced it to three lines against the redactor itself:

```
"url":"http://host/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"        ->  ?<redacted>   OK
"path":"/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"                  ->  ?<redacted>   OK
"subtitle":"host:3219/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"     ->  UNCHANGED     LEAK
```

The absolute program required `scheme://` and the relative program required the
match to begin at `/`; `host:port/path?query` satisfied neither, and Playwright
drops the scheme when it writes a `test.trace` step subtitle — measured in a
probe as `"title":"Navigate","subtitle":"127.0.0.1:3987/media/p.jpg?X-Amz-Signature=…"`
beside a `params.url` the absolute program did catch.

Both redactors now handle it — they read the same programs file (above) — and
the verifier's own reduction line redacts, including its **undotted** hostname.

**AND THE ONE NOBODY HAD LOOKED AT: `playwright-report/index.html` carries a
BASE64-EMBEDDED ZIP of the entire report, which no redactor here can reach.**
`playwright/lib/runner/index.js:3704-3712` appends

```
<template id="playwrightReportBase64">data:application/zip;base64,…</template>
```

whose payload decodes (magic `504b0304`) to a ZIP whose members carry the error
messages, the step titles and subtitles, and the attachment bodies.
`redact-artifacts.sh` runs perl over `index.html` as TEXT, so it rewrites the
plaintext and cannot touch the payload; it unpacks `*.zip` **files** only. And
`sweep-artifacts.sh` — the script this file names as the proof — greps raw bytes
and could not decode base64 either.

Measured on a failing probe run: three planted markers — a scheme-less signed
URL, a typed password and an assertion's received value — lived **only** inside
that payload, a raw grep of `index.html` found **nothing**, and all three were
**still live** after the shipped redactor reported
`OK: redacted … 23 file(s) and 2 archive(s)`.

**So every "verified end to end" redaction measurement this repository has
recorded was made with a search blind to this file**, including the
"239 `?<redacted>`, zero live queries" figure above and D9's "3 members → 0".
Those numbers are true of the channels that were searched and unproven for this
one. Two changes, and only one of them is a redactor:

1. **`playwright-report/` is no longer uploaded.** The `e2e` workflow's upload
   paths are an ALLOWLIST — `test-results/`, `playwright-report/results.json`,
   `playwright-browsers.txt` — enforced by `check-e2e-lane.mjs` across every job
   of the file, with globs, `${{ }}` expressions, `.` and `..` all refused.
   Re-encoding the payload would have been a fifth URL-shape prediction after
   four rounds; not uploading it is not a prediction. Nothing diagnostic is lost:
   `test-results/` still holds `trace.zip` and `error-context.md` (there is no
   screenshot or video: Lane A records no pixels, see below),
   `npx playwright show-trace test-results/<test>/trace.zip`
   opens the trace without the report, and `playwright-report/data/` was a
   byte-identical second copy of the same traces.
2. **`sweep-artifacts.sh` decodes then recurses.** Every `;base64,` payload long
   enough to be an archive is decoded and, if its magic says ZIP or gzip,
   unpacked and searched with everything else. Verified against the probe tree:
   the old raw grep found the marker in 1 member, the new sweep finds it in 5,
   including `.decoded-0.bin.unzipped/…json` — the member a raw grep cannot see.

**AND `error-context.md`, which no Playwright CONFIG option gates.** It is
written by `playwright/lib/index.js:709` whenever a test has errors — measured
still written with `trace`, `screenshot` and `video` all `"off"` — and the HTML
reporter copies it into `playwright-report/data/`. It carries the error message,
a `# Test source` code frame (±100 lines of `errorLocation.file`, which for an
error raised in a helper is the **helper's** source), and a `# Page snapshot`.

That last section is an `ariaSnapshot({ mode: "ai" })` of the LIVE PAGE: every
DOM text node and **every input's current value**. In the probe it is what
captured a typed password while every recorder was off. One environment variable
gates it (`playwright/lib/index.js:657-658`), so the `e2e` job sets
`PLAYWRIGHT_NO_COPY_PROMPT: "1"` at job level — in CI only, so a developer still
gets the snapshot on their own machine.

**What is asserted about that variable, in three layers — and "asserts it is
set", which this paragraph used to say, was never one of them.**

1. **Statically, the routes a parser can read.** `check-e2e-lane.mjs` requires the
   key exactly once, at job level, with the literal `"1"`, and refuses it at
   workflow and step level (a step `env:` overrides the job's, and Playwright
   gates on truthiness, so `""` at step level restored the snapshot with the
   guard green — round-1 FINDING 2). It also refuses the routes that rewrite the
   environment of a LATER process: **any key in a committed `.npmrc`** (the
   allowlist is empty — a verifier's one-line `node-options=` blanked the
   variable inside the Playwright process with every workflow declaration still
   reading `"1"`, R2-FINDING E); env maps are DEFAULT-DENY (nothing at workflow
   level, only this key at job level, nothing on an unpinned step), with
   `NODE_OPTIONS`, `npm_config_*`, `CI` and `HOME` also refused by name; any
   reference to `$GITHUB_ENV`, `$GITHUB_PATH` or `$GITHUB_STEP_SUMMARY` in the
   job's `run:` text or env values; `defaults:`; and YAML merge keys. In the specs,
   **`vizra/no-process-env-write`** refuses any use of `process.env` in
   `e2e/**` (outside `e2e/harness/**`) other than reading one member — the
   verifier's `delete process.env.CI; process.env.PLAYWRIGHT_NO_COPY_PROMPT = "";`
   is two lint errors (**D17a**). That is a list of routes and a lint rule, and
   neither is the property.
2. **At runtime, the property itself — captured, compared, RESTORED.**
   `e2e/harness/ci-environment.ts` captures `CI` and `PLAYWRIGHT_NO_COPY_PROMPT`
   ONCE, when `playwright.config.ts` loads — in the Playwright main process before
   any spec file is collected, and in each worker before any spec file is loaded —
   (and `GITHUB_ACTIONS`) into a frozen, module-private value. Two things are then
   asserted. **The capture must satisfy the policy**: in CI — `CI` truthy OR
   `GITHUB_ACTIONS` exactly `"true"` at capture — the variable must be exactly
   `"1"`. That catches a `.npmrc`, `NODE_OPTIONS` or `$GITHUB_ENV` route that blanks
   the variable **only while the capture still says "CI"** (**D16b**, **D16c**; the
   inverse control, the whole lane green with the variable `"1"` and `CI` set).
   GitHub documents that a job CAN overwrite `CI` but CANNOT overwrite `GITHUB_*`
   defaults through `env:` or `$GITHUB_ENV` (Actions reference, "Variables" and
   "Workflow commands", read 2026-09-23). So a DIRECT `env:` or `$GITHUB_ENV`
   assignment of `CI` or `GITHUB_ACTIONS` itself cannot switch the policy off
   (**D16c**'s "`CI` emptied" half, simulated). Anything that runs code before the
   configuration loads CAN remove both anchors, and then this layer is silent —
   **layer 3 is the control that holds regardless**. Three such routes, named: an
   IN-PROCESS preload (a user-level `.npmrc`'s `node-options`, a `--require`); a
   `BASH_ENV` written to `$GITHUB_ENV` by an earlier step or a helper it runs — not
   a `GITHUB_*` name, and sourced by the lane step's own default `bash -e {0}`
   before `npm run e2e` starts; and `$GITHUB_PATH`, which prepends a directory so a
   different `npm` runs. These three were reasoned from GitHub's pages and the Bash
   manual (`BASH_ENV`), not built (verifier findings V-A, V-A2). **The live values must still equal the capture**,
   in CI or not: a difference — `CI` deleted counts — is RESTORED to the capture
   and then fails by name ("the page-snapshot environment was CHANGED after the
   Playwright configuration loaded"), never echoing a value.

   This used to read the live environment and return early when `CI` was unset,
   so the two lines above switched it off (R3-FINDING J), and this paragraph
   claimed it caught a change "whatever route changed it". What it does now, by
   WHEN the spec makes the change. **PREVENTS** means the capture is restored
   before Playwright reads the variable as the context closes
   (`playwright/lib/index.js:655-658`), so no page snapshot is written. **DETECTS**
   means the run fails by name but a snapshot may already be on disk in
   `test-results/`, and only layer 3 keeps it off the runner.

   | The spec changes either variable… | Caught | Result |
   |---|---|---|
   | at MODULE SCOPE — run in the main process during collection | the stamp reporter's `onBegin`, before any worker is forked (workers inherit the restored environment) | **prevents** — measured, **D17b** |
   | at module scope — run again when a worker loads the file | worker start, before any hook or test | **prevents** — measured, **D17b** |
   | in the test BODY | after the body, before the context closes | **prevents** — measured, **D17e** |
   | in `afterEach` (or `beforeEach`, which runs inside the same window) | after the body | **prevents** — `afterEach` measured, **D17e**; `beforeEach` by the measured fixture order, not separately |
   | in the teardown of a `test.extend` fixture torn down BEFORE the harness fixture (an automatic fixture of the spec's own — the verifier's variant) | after the body | **prevents** — measured, **D17e** |
   | in `beforeAll`, or late in the previous test | before the next test, in the harness fixture's setup | **prevents** for that test's context — by construction, not separately measured |
   | in a page event handler while the guard flushes | at the end of the harness fixture | **prevents** — by construction, not measured; a handler for an event that fires during the context close itself is after that check, so it falls to the "detects only" row below |
   | in `afterAll`, or in the teardown of a fixture the harness fixture DEPENDS ON (an overridden `context` or `browser`), which Playwright tears down AFTER it | worker teardown — the run fails | **detects only** — stated from the fixture order and the recorder's source, not measured |
   | in the body, when the spec itself closes a context after recording an error | after the body | **detects only** — the snapshot is taken during that close; stated from the recorder's source, not measured |

3. **At the upload gate, the artifact — and the step that runs it is pinned.**
   `redact-artifacts.sh` refuses — exit 1 — if ANY file or archive member
   carries a `# Page snapshot` heading line, and exit 3 if a directory it was
   given does not exist. The upload is gated on that step's success, and since
   R3-FINDING H **the step is byte-equal to its pin**: its verdict cannot be
   discarded (`|| true`, `; exit 0`, `set +e`), its directories cannot be
   mistyped, dropped or replaced (`/tmp/empty`), and a step that merely NAMES the
   script (`echo redact-artifacts.sh`) is refused — each of the verifier's eight
   spellings is red by name in `require-checks_test.sh`. Demonstrated in **D16a**,
   and end to end in **D17c**: the verifier's combined attack (the two-line spec
   plus `|| true` on this step) is refused by the lane guard, the lane fails by
   name, and even with the laundered step run as the runner would run it, the
   upload set holds **no** page snapshot. **D17d** switches the comparison off and
   shows the snapshot, with the typed value, coming back. The heading is pinned
   against Playwright's own source by a unit test, so a rename cannot blind it.

**What still gets through, named:** code that runs BEFORE the configuration
loads — a `--require`/`--import` preload arriving by a route layer 1 does not see —
is captured as if it were the job's environment; while the capture says "CI" the
policy still refuses a captured value that is not `"1"`, but such code can also
delete `CI` and `GITHUB_ACTIONS` (layer 2 then silent), replace `process.env`
itself, or patch Playwright's recorder so layer 2 reads `"1"` while the recorder
reads something else. The two "detects only" rows above. And pinning a
step fixes ITS bytes, not the bytes of the script it runs: an earlier `run:` step
that rewrites `scripts/ci/redact-artifacts.sh` in the workspace is the `run:` class
(§ Residuals), and review is its control. For the page snapshot, layer 3 does not
depend on the variable, and its step can no longer be rewritten unseen in the
workflow; for every other channel the recorders write, it does not apply.

The FILE `error-context.md` is still written and its error details are still
uploaded; that is deliberate, and it is why the Lane-B design in the queued
authenticated-lane slice makes the PATH the control rather than an option.

**WHAT A RED LANE A ACTUALLY PUBLISHES, file by file.** The upload is an
allowlist of three paths; this is what is in them and what is done to each.

| Uploaded | What it carries | Redacted? |
|---|---|---|
| `test-results/**/trace.zip` | the full trace: request and response HEADERS, request and response BODIES (`resources/*`), DOM snapshots, console messages, **Playwright call parameters including `fill()` values in step titles**. **No screencast frames** (`trace.screenshots: false`), but `resources/*` still holds any image bytes the page fetched, and the trace viewer re-renders a DOM snapshot as a page | URLs, in the shapes above — every other channel is **untouched** |
| `test-results/**/test-failed-1.png`, `video.webm` | **not produced**: `screenshot` and `video` are `"off"` (below) | — |
| `test-results/**/error-context.md` | the error message, and a `# Test source` code frame (±100 lines of `errorLocation.file` — the **helper's** source when the error was raised in one) **when the failing error's stack has a readable source location** — measured present for an `expect` failing in a spec (D16d); a harness-raised browser-error failure may have none | URLs, in the shapes above. Its `# Page snapshot` is **suppressed in CI** by `PLAYWRIGHT_NO_COPY_PROMPT`, and a file that carries one anyway is **refused at the upload gate** |
| `playwright-report/results.json` | test titles, the failure message and **the assertion's received value**, stdout/stderr captured per test, attachment paths | URLs, in the shapes above — including the double-escaped form a printed slash-escaped URL becomes here (D16d). **This file is uploaded and this table did not used to name it** |
| `playwright-browsers.txt` | `playwright install --dry-run chromium` output | nothing sensitive |

`playwright-report/` itself is **not** uploaded — see the base64 paragraph above.
Nothing under `.vizra-e2e/` is uploaded, by any workflow, and the lane guard
sweeps every workflow file for that name.

**Lane A records NO PIXELS.** A screenshot, a video or a trace screencast frame
of a page is pixels: no redactor rewrites it and no byte scan can read a rendered
string out of it, and the repositories are public. So `playwright.config.ts` sets
`screenshot: "off"`, `video: "off"` and
`trace: { mode: "retain-on-failure", sources: false, screenshots: false }`
(security seat, PR B plan review 2026-09-23, Q3 and F14). The demos
configuration inherits them. Measured on one failing demonstration
(`failed-request.demo.ts` under `playwright.demos.config.ts`, 2026-09-23):

| | Before | After |
|---|---|---|
| `.png` files in `test-results/` | 2 | 0 |
| `.webm` files | 2 | 0 |
| screencast frames inside the two `trace.zip` files | 3 and 2 | 0 and 0 |
| `trace.zip` and `error-context.md` | present | present |

`check-e2e-lane.mjs` reads all three values as LITERALS from the parsed
configuration and refuses any other value, a value it cannot read (a spread or a
computed key in `use`), a project whose `use` sets one of the three keys or
spreads anything but a `devices["…"]` descriptor (none of the 207 installed
descriptors sets a recorder), and a demos configuration that declares `use` or
`projects`. Nine cases in `require-checks_test.sh` are red by name.

**What this does NOT stop, stated so it is not assumed:** the trace still
records the network, so an image the page FETCHED is in `resources/*` as bytes,
and a DOM snapshot re-renders as the page in the trace viewer. The measured demo
fetched no image, so the table above does not measure that channel. A spec can
still call `page.screenshot({ path })` itself and write into `test-results/`;
nothing refuses that today. From the first slice that renders non-public media,
those two channels are the ones to close.

**NOT covered. Read this list before you decide a red lane is safe to share.**
Measured channel by channel against a failing run:

| Channel | Where it survives |
|---|---|
| `Authorization` request header | `1-trace.network` |
| `Cookie` request header | `1-trace.network` |
| `Set-Cookie` response header | `1-trace.network` |
| `x-amz-security-token` and other vendor token headers | `1-trace.network` |
| request bodies (`postData`) | `resources/*` |
| response bodies | `resources/*` |
| a non-URL token in a console message | `*-trace.trace` |
| DOM snapshots and attachments | `*-trace.trace` |
| **Playwright call parameters** — `page.fill` / `page.evaluate` arguments, the channel a login spec uses | `*-trace.trace` |
| artifact file and directory names (they derive from test titles) | everywhere |
| image bytes the page fetched, and DOM snapshots the trace viewer re-renders as a page (the pixel channels Lane A still has; screenshots, video and screencast frames are no longer recorded — below) | `resources/*`, `*-trace.trace` |

Earlier wording here offered "keeping origin, path, **headers** and timings
readable" as a feature. Headers are the uncovered channel; that sentence is
gone.

**The rule that follows, and it is still a hard line.** Until the authenticated
lane lands (its own slice: a Playwright invocation whose projects record no
trace, screenshot or video, whose output directory is in no upload path, and
whose only artifact is a structured summary): **no spec may authenticate, fill a
credential, or touch a real signed URL.** The traces are safe today for exactly
one reason — nothing in this repository authenticates: there is no vizra-core, no
session cookie and no signed URL. That is an accident of scope, not a control, so
`e2e/harness/no-credentials-in-specs.test.ts` asserts it in the `frontend` lane:
`addCookies`, `storageState`, `setExtraHTTPHeaders`, `httpCredentials`,
`Authorization`, `Bearer`, `Set-Cookie`, `.fill(`, credential-shaped identifiers
and signed-URL shapes are all refused in `e2e/specs/**` and `e2e/demos/**`, with
one allow-list entry — D9's sentinel — carrying a written reason. A slice that
needs to log in lands the authenticated lane first, or waits.

**This slice narrowed what a red lane publishes; it did NOT lift that rule, and
must not be read as having done so.** Uncovered channels remain uncovered: header
values, request and response bodies, DOM snapshots inside the trace, Playwright
call parameters, and artifact file names all still survive into `test-results/`
and are still uploaded. What changed is that the base64 report copy is no longer
published, the page snapshot is suppressed in CI, the scheme-less URL form is
redacted, page-controlled text is made inert, retention is 3 days, and the upload
scope is an allowlist rather than a derivation. Read the table above before
deciding a red lane is safe to share.

**Who can read an uploaded artifact and a job log, exactly: the repository is
PUBLIC.** `yegamble/vizra-user` became a **public** repository on 2026-09-23
(`gh repo view yegamble/vizra-user --json visibility` → `PUBLIC`, checked
2026-09-23; `vizra`, `vizra-core` and `vizra-search` report `PUBLIC` too). This
paragraph used to say that artifacts and job logs were readable only by the
collaborators of a private repository. That is no longer true: the Actions
artifacts and job logs of a public repository are readable by the public.
Retention differs by what was published. The figures below match
`gh api repos/yegamble/vizra-user/actions/artifacts` on 2026-09-23 (59 unexpired
artifacts):

- the `e2e` lane's artifact (`playwright-artifacts-*`), as uploaded by the
  current workflow: **3 days** (`retention-days: 3`, a ceiling
  `check-e2e-lane.mjs` enforces);
- the `supply-chain` scan reports (`npm-audit-*`, `trivy-image-*`, 29 of each on
  that day): **30 days** (`retention-days: 30` in `supply-chain.yml`). They hold
  the dependency-advisory and image-scan output, not browser artifacts;
- **one `e2e` artifact that predates PR A:** `playwright-artifacts-35536837315-1`
  (artifact id 10612777314, uploaded 2026-09-20 with **14-day** retention,
  expiring 2026-10-04). It was uploaded before the upload allowlist and
  `PLAYWRIGHT_NO_COPY_PROMPT` existed, so it contains `playwright-report/index.html`
  with the base64-embedded report archive, `playwright-report/data/`, and four
  `error-context.md` files carrying a `# Page snapshot`. Its content is the
  skeleton page and is harmless, as an independent verifier found. None of PR A's
  guarantees below apply to it. Deleting it before it expires is the owner's
  decision;
- job logs: **90 days**, the repository's artifact-and-log retention setting
  (`gh api repos/yegamble/vizra-user/actions/permissions/artifact-and-log-retention`
  → `{"days":90}`, read 2026-09-23). Nothing in this repository shortens it. A
  line in a job log cannot be edited, and deleting a run's logs does not
  un-publish what was already read.

**What PR A's controls still guarantee for a public `e2e` artifact uploaded under
the current workflow, at their measured strength.** None of them depended on the
repository being private, and nothing new is claimed here:

- the upload runs only on a red lane, only after the pinned redaction step
  succeeded, and only for the three allowlisted paths (`test-results/`,
  `playwright-report/results.json`, `playwright-browsers.txt`).
  `playwright-report/` itself, with its base64-embedded report archive, is not
  uploaded, and nothing under `.vizra-e2e/` is uploaded by any workflow;
- URL query strings and fragments, in the four URL shapes above, and `Location`
  are redacted, and nothing else is. Every row of the "NOT covered" table is published as
  recorded: header values, request and response bodies, non-URL console tokens,
  DOM snapshots and Playwright call parameters inside `trace.zip`, artifact file
  names, and image bytes the page fetched (`resources/*` inside `trace.zip`).
  Screenshots, video and trace screencast frames are no longer recorded at all;
- the `# Page snapshot` section of `error-context.md` is suppressed in CI by
  `PLAYWRIGHT_NO_COPY_PROMPT` and refused at the upload gate, subject to "What
  still gets through" above;
- the traces carry no credential only because nothing in this repository
  authenticates. That is an accident of scope, which
  `e2e/harness/no-credentials-in-specs.test.ts` asserts as a tripwire; it is not a
  control.

**The job log is now the wider channel.** It is public for 90 days and it is not
redacted. The `list` reporter prints a failing assertion's received value and a
source excerpt of the spec. The `Container logs` step prints the last 200 lines
of the production container's output as-is. Only messages the harness itself
generates pass through `e2e/harness/redact.ts` (URL redaction, plus the CR/LF and
leading-`::` sanitiser). Treat anything a spec, a fixture or the running image
writes to stdout or stderr as published.

"Public" changes the stakes of the hard rule above, not its content: until the
authenticated lane lands, no spec may authenticate, fill a credential or touch a
signed URL, because a spec that did would publish the credential to anyone, for
up to 90 days in the log and 3 days in the `e2e` artifact.

When the authenticated lane lands, the first authenticating spec proves its
coverage with `scripts/e2e/sweep-artifacts.sh`, which now performs this search
with base64 payloads decoded and recursed into.

The first push of this harness committed a Next HMR URL with an opaque `?id=`
into the evidence and the secret scanner flagged it; that is what started all
of this.

**A run that tests less than it should is not a pass either.** The per-project
minimum counts live in `e2e/harness/required-projects.json` — an owner-reviewed
file (`.github/CODEOWNERS` covers `/e2e/harness/`) — and equal the number of
tests each project runs today. Adding specs raises the real count and never
fails; **raising the minimum in the same PR is part of adding them**, so the
ratchet only goes up. Deleting tests until a project falls below its minimum is
a red lane.

It is checked twice, on purpose. `e2e/harness/coverage-reporter.ts` enforces it
inside the run, and also refuses a FILTERED run (`--grep`, `--grep-invert`,
`--shard`, `--project`, a file argument): any filter can select a subset that
happens to clear the floor, which is exactly how a one-test run once reported
`coverage floor: OK`. `scripts/ci/check-coverage-floor-ran.mjs` then re-checks
the same numbers against the finished JSON report **from outside the Playwright
process**, so deleting the reporter from `playwright.config.ts` — one line, no
other visible effect — does not remove the floor.

For a deliberately partial local run, set `E2E_COVERAGE_FLOOR=off` and
understand that such a run proves nothing about coverage.
`scripts/ci/check-e2e-lane.sh` fails if the workflow ever sets it.

**The fault-injection fixtures never ship.** The demonstrations in `e2e/demos/`
inject their faults with `page.addInitScript` against the unmodified production
server — there is no `app/` route to delete — and
`scripts/ci/check-no-test-fixtures-in-image.sh` proves the built image contains
neither a harness path nor the `__vizra_e2e_fixture__` token.

**The lane self-tests the guard, in CI.** An independent verifier recorded the
gap exactly: neutering `e2e/harness/browser-errors.ts` while leaving its
identifiers in place is **silent**. `npm run test` exits 0 (the unit tests cover
the decision logic, not the listeners), `check-e2e-lane.sh` exits 0 (its harness
check is string presence, and says so in its own comment), and the lane exits 0,
because a guard that has stopped looking finds nothing to fail on. Only
`npm run e2e:demos` would have caught it, and that is not a CI lane.

So `scripts/ci/harness-canary.mjs` runs in the required `e2e` lane, against the
same container the lane just drove. It runs each fault-injection fixture in its
own invocation and asserts the **exact set of record kinds** the guard recorded
for it — the kinds that must be present, and the kinds that must not:

| Fixture | Must record | Must NOT record |
|---|---|---|
| `e2e/demos/console-error.demo.ts` | `[console]`, `console.error` | `[response]`, `[pageerror]`, `[requestfailed]` |
| `e2e/demos/failed-request.demo.ts` | `[response]`, `http 404` | `[pageerror]`, `[requestfailed]` |
| `e2e/demos/uncaught-exception.demo.ts` | `[pageerror]` | `[response]`, `[console]`, `[requestfailed]` |
| `e2e/demos/aborted-request.demo.ts` | `[requestfailed]`, `ERR_CONNECTION_REFUSED` | `[response]`, `[pageerror]` |

`[console]` is deliberately allowed for the two network fixtures: Chromium logs
the failed load itself. That is measured, in
`docs/evidence/VZ-FOUND-008/d2-failed-request-RED.txt` and
`d3b-aborted-request-RED.txt`, not assumed.

**One fixture per guarded kind, and the fourth is why.** `aborted-request` is a
sub-resource whose connection is refused with `route.abort("connectionrefused")`
— hermetic, unlike a request to a closed port, which turns green on a runner
that happens to have something listening. It differs from the 404 fixture in
exactly one respect, which is the one under demonstration: its request never
completes, so it produces `requestfailed` and no `response` at all. That is why
the `response` listener cannot stand in for the `requestfailed` one.

**This replaces a claim that was overstated.** The first version required each
fixture's diagnostic to appear somewhere in one combined output and said each
failed "for its own named reason". An independent verifier showed it did not:
swapping `console.error(token)` in the console fixture for a 404 left the canary
**green**, because Chromium reports the failed load on the console and the
harness formats it as `console.error: Failed to load resource…`. The fixture
then demonstrated a control nobody had asked it to demonstrate, silently.
Asserting the kind SET makes the sentence true, and **D12e** swaps that fixture's
fault type and shows the canary going red with "failed for the WRONG reason".

Per-fixture and not merely a count, because the other sharp case needs it too:
with the `response` listener neutered the 404 fixture still fails, on the console
error the 404 also produces, so a canary that counted failures would pass. Four
browser launches, about six seconds (measured `real 5.77` on this machine).
`check-e2e-lane.mjs` requires the step
to be BYTE-EQUAL to its pin in `.github/e2e-pinned-steps.yml` — exactly that
command, the container's URL, no `if:`, no `continue-on-error`, no other key —
after the lane; `require-checks_test.sh` drives all of that against mutated
workflows.

**THE CANARY NOW COVERS ALL FOUR GUARDED SIGNAL KINDS, and the fourth was
missing.** For one round there was no `requestfailed` fixture — the three
demonstrated a console error, an HTTP 404 and an uncaught exception, and a 404
is a *completed response*, not a failed request. An independent verifier
measured the consequence directly: neutering the `console`, `weberror` or
`response` listener turned the canary red, and neutering `requestfailed` left it
**green**, so the one kind that catches aborted requests, connection refused and
DNS failures could have been dropped from the guard with no lane noticing.
Demonstration **D12** now removes each of the four context listeners in turn and
the lane goes red for **all four**, each for its own named reason; the
transcript of the defect is kept at
`docs/evidence/VZ-FOUND-008/d12-requestfailed-listener-neutered-GREEN.txt`
beside its replacement `d12d-requestfailed-listener-neutered-RED.txt`, so the
before and after are both on record.

The Docker D6 pair, D5 (`next dev`), D7 (the workflow parser) and D9 (artifact
redaction) are deliberately NOT in the canary: they need a second image build, a
development server, or are already asserted by cheap checks in other lanes. The
canary is the smallest thing that would have caught the silent case.

**The upload is ONE pinned step, and every other uploader is refused.** The
parser once used `steps.find(...)`, so a SECOND `actions/upload-artifact` step on a
bare `if: failure()` passed — and when the redactor fails, the gated upload is
skipped while the ungated one publishes the unredacted tree. It then became a
`filter` over every uploader. Since PR #8 round 3 (R3-FINDING H) the upload is
pinned byte-for-byte like every step the guard relies on: exactly one step
deep-equal to the `upload` pin, IMMEDIATELY after the pinned redaction step, and
any other step whose `uses:` looks like an uploader — `actions/upload-artifact`
or not — is refused as a look-alike, even when it carries the right gate. (That
last case was a GREEN control until this round; it is red on purpose now, in
`require-checks_test.sh` and in **D7b**, because a second uploader is a change to
what leaves the runner and belongs in the reviewed pin, not beside it.)

**What this lane does NOT cover, and does not claim.** Chromium only: no WebKit,
so Safari behaviour is not claimed. No accessibility engine yet — VZ-A11Y-001 is
M1, and the seam is documented in `e2e/harness/test.ts` where the axe assertion
belongs. No visual baselines: `toHaveScreenshot` is unused on purpose, because
approving a baseline is a reviewed act of its own.

### Residuals — what is still only as strong as review

Listed because a control whose limits are unstated is a control people
over-trust. Each bullet says what holds **today**, in this tree, and names what
does not. Where a bullet used to say "nothing catches this" and something now
does, the bullet says exactly what that something is and exactly what it leaves
open — a residual stated inaccurately is worse than one stated plainly, because
it is trusted.

- **`.github/CODEOWNERS` enforces nothing today.** It is committed, and
  `* @yegamble` covers every path, but GitHub applies it only once a ruleset on
  `main` requires Code Owner review. That ruleset is an owner action, outside
  any pull request. Wherever this file says "owner-reviewed", read "owner-
  reviewed once that ruleset exists".
- **An arbitrary `run:` step can still exfiltrate** — `gh release upload`,
  `curl`, anything. No workflow parser can close that; `check-e2e-lane.mjs`
  covers uploader *actions*, and the protection for the rest is review.
- **The sealed-module ban is lint.** `claimSigner()` refusing a second claim is
  the runtime half and is demonstrated (D11d); the ESLint half is the early
  warning. A file under `e2e/harness/**` is exempt from both by construction.
- **`check-e2e-lane.mjs`'s harness checks read a PARSED TREE, and what they
  still cannot decide is written down.** There are eleven: ten that require a
  genuine CALL and one that requires a non-import REFERENCE to
  `STAMP_ANNOTATION`. They began as `includes("guardBrowser")`, and an
  independent verifier measured what that bought: with the CALL replaced by an
  inert guard object and the IMPORT left in place, `tsc` exit 0, the lane guard
  exit 0, and the lane exit 0 with `18 passed` — the guard entirely inert. Only
  the canary caught it.

  **The string version was then defeated three more ways, and this file used to
  say it "does not strip comments" and leave it there.** Measured with the call
  removed in each case:

  | Decoy left behind | Old string check | Now |
  |---|---|---|
  | nothing | **RED** | **RED** |
  | a line comment where `//` starts the line | **RED** | **RED** |
  | a block comment `/* … */`, JSDoc included | **RED** | **RED** |
  | a **trailing** line comment: `void 0; // formatOrphans(a, b)` | **GREEN — defeated** | **RED** |
  | a **string literal**: `const s = "formatOrphans(";` | **GREEN — defeated** | **RED** |
  | **call-and-discard**: `void formatOrphans(a, b);` | **GREEN — defeated** | **RED** |
  | a **shadowed callee**: `const formatOrphans = () => "x";` above the call | (not reachable then) | **RED** |

  An independent verifier drove the trailing-comment case end to end on the one
  control the canary cannot reach: delete the orphan assertion from
  `e2e/harness/test.ts`, leave `// formatOrphans(…)` trailing — `tsc` exit 0,
  `check-e2e-lane.sh` exit 0, the canary exit 0, and an `afterAll` that breaks a
  page **passing**.

  `scripts/ci/ts-source-facts.mjs` now parses the file with the `typescript`
  devDependency and looks for a `CallExpression` whose callee is the required
  identifier. A comment is not a node and a string literal is not a call, so the
  first two defeats are gone **by construction** rather than by a better regex —
  which matters, because the three previous fixes were all better regexes. The
  `void` spelling is refused explicitly, and a **shadowed callee** is refused
  too: matching "a call to something named X" without asking which X would have
  traded a string defeat for a scope defeat. The shadow check walks every
  enclosing scope, and a binding that is not the module's own import fails the
  check with its own named reason. The `STAMP_ANNOTATION` check went the same
  way: it used to be satisfied by the identifier surviving on its own import
  line, which a verifier measured at `f0ee8f1`.

  Each of the five shapes is red in `scripts/ci/require-checks_test.sh`, for
  `formatOrphans` **and** `guardBrowser`, against a throwaway tree — and the
  helper **refuses a mutation that did not change the file**, so a demonstration
  that stops demonstrating is a failure rather than a pass.

  **STILL NOT DECIDED, and this is review-only:** whether a call's RESULT is used
  in a way that matters. `const _ = formatOrphans(…)` and a call inside a branch
  that never runs both satisfy the check. That needs a type checker and a
  reachability analysis; `scripts/ci/ts-source-facts.test.mjs` pins both as
  known-permitted rather than leaving them unstated. Defeating the check now
  needs an edit to `e2e/harness/**` (a CODEOWNERS path) that a reviewer reading
  the diff would see as a call being removed.

- **`globalSetup` and `globalTeardown` are outside the guard, and are now
  REFUSED.** The listening starts at WORKER setup; `globalSetup` runs in the
  Playwright main process before any worker exists, so no listener is attached
  and the creation guard is unarmed. An independent verifier measured it: a
  `globalSetup` that launches its own Chromium and opens a page which 404s a
  sub-resource and throws gives `npx playwright test` exit **0**, `3 passed`,
  with no guard message — and the module provably ran (it wrote a marker file).
  `check-e2e-lane.sh` exited 0 too.

  `check-e2e-lane.mjs` now refuses either key outright, in
  **`playwright.config.ts` and `playwright.demos.config.ts`**, read from the
  parsed configuration so a key named in a comment or a string does not trip it
  and a **spread or a computed key fails closed** — the guard cannot rule the key
  out through one, so it does not try. The one spread it does follow is a spread
  of a configuration IMPORTED from another file in the same checked set, which is
  the demos configuration's honest shape; that file is checked in its own right.
  Nothing here needs a `globalSetup`, and a setup **project**
  (`dependencies: [...]`) is fully covered — its tests are ordinary guarded tests
  and the verifier's broken one failed with `[response] http 404`. If a later
  slice genuinely needs one, the refusal is where that conversation happens
  rather than a silent gap. Four cases in `require-checks_test.sh`, plus the two
  inverse controls (a comment and a string) that must stay green.

- **A CONTEXT OR BROWSER THE HARNESS WAS NEVER HANDED — three import-free
  routes reached one, and all three are now closed at RUNTIME.** This bullet
  used to say "nothing catches these today"; that sentence is no longer true,
  and what replaces it is stated route by route rather than as a claim about the
  class. An independent verifier measured each of these from a spec in
  `e2e/specs/` importing only the harness `test`, each passing the **complete**
  gate on a page that 404s a sub-resource and throws on every load — lint green,
  lane exit 0 with `20 passed, coverage floor: OK (10/9 10/9), harness stamp: OK
  (20 verified)`, out-of-process check exit 0:

  | Route | Now | How, and where it is demonstrated |
  |---|---|---|
  | `Object.getPrototypeOf(browser).newContext.call(browser)` | **guarded** | `Browser.prototype.newContext`/`newPage` are patched, so the context is REGISTERED with the guard the moment it exists — which also covers a context created and closed inside the body, where a teardown check would see nothing (**D13j**) |
  | `browser.browserType().launch()` | **refused** | the call throws before launching anything (**D13k**) |
  | `playwright.chromium.launchPersistentContext(dir)` | **refused** | as above (**D13l**) |
  | `browserType().connect()` / `connectOverCDP()` | **refused** | the same patch; reachable without a server because the refusal precedes the call (**D13m**) |
  | `browserType().launchServer()` | **refused** | the same patch — `launchServer` hands back a `wsEndpoint` that `connect` would turn into a Browser, so both ends are closed (unit-tested in `e2e/harness/creation-guard.test.ts`; no D13 half) |
  | `_electron.launch()`, `_android.launchServer()` / `connect()` | **refused** | both reachable from the built-in `playwright` fixture with no import (unit-tested in `e2e/harness/creation-guard.test.ts`) |
  | `browser.newBrowserCDPSession()` + `Target.createTarget` | **refused** | a raw CDP target belongs to no Playwright BrowserContext — `browser.contexts().length` measured 1 before and 1 after — so no listener and no sweep could ever see it. It is a `Browser.prototype` method, patched where `newContext`/`newPage` are (**D15g**). `context.newCDPSession(page)` is NOT refused: it drives a page the harness already guards |
  | `Object.getPrototypeOf(browser).newPage.call(browser)` | guarded, as before | the prototype's `newPage` calls `this.newContext` |

  Three layers, and it matters which is which. `e2e/harness/creation-guard.ts`
  patches `BrowserType.prototype` **at module load** — while
  `playwright.config.ts` is being evaluated, before any test file exists in the
  worker — so a spec cannot capture an unwrapped original; and it patches
  `Browser.prototype` inside that already-patched `launch`, before the Browser
  is handed to anyone, so a spec cannot hold a Browser whose prototype is not
  already patched either. Measured against the installed 1.63.0, not assumed:
  none of those methods is an own property, `chromium`/`firefox`/`webkit`/
  `browser.browserType()` share one prototype, and its own prototype
  (`ChannelOwner`) has none of the names — there is no second hop to escape to.
  A refusal is also RECORDED, so `try { … } catch {}` still fails the test
  (**D13n**). Underneath both sits the catch-all the verifier proposed: a
  teardown assertion that no live context on the harness's browser is one the
  guard never registered, demonstrated on its own by cutting the registration
  (**D13o**).

  The lint rule now refuses `browserType`, `launch`, `launchPersistentContext`,
  `launchServer`, `connect`, `connectOverCDP` and `newBrowserCDPSession` in
  `e2e/specs/**` and
  `e2e/demos/**` — **as the early warning, not the control.** D13p shows both
  halves: with the method ban switched off, a spec holding all three routes
  passes ESLint, which is exactly the state the verifier measured.

  **Still open, and review is still the only control for these.** A file under
  `e2e/harness/**` can edit the guard itself; that is the reviewed directory
  `.github/CODEOWNERS` covers, and D12 makes neutering the listeners a named CI
  failure. Playwright's private client internals — `playwright._connection`,
  `BrowserType.prototype._connect`, `browser._innerNewContext` — are not
  patched; reaching an underscore-prefixed channel is not a spelling of an
  honest idiom, and nothing automated refuses it. And a spec can still write a
  member access the rule cannot read (`browser[name]()`), which the runtime
  guard catches but lint does not.
- **The harness-owned-fixture ban is lint; the RUNTIME half is the brand.**
  Replacing `vizraHarnessGuard` or `vizraWorkerGuard` is refused by the rule,
  and at runtime costs the spec its stamp — for the test fixture because the
  stamp lives in it, and for the worker fixture because `vizraHarnessGuard`
  refuses to stamp a test whose worker guard is not one `createWorkerHarness`
  built (a module-private `WeakSet`; a look-alike object cannot join it).
  Replacing `page`, `context` or `browser` is legitimate, is not refused, and is
  covered by the guard. D13 runs **fifteen runtime shapes red**
  (`d13a`–`d13g`, `d13j`–`d13o`); D15 adds **eight more** for hooks, shared
  pages, CDP and the worker fixture; the honest overrides and the honest
  `beforeAll` stay green.
- **THE WINDOW HAS TWO EDGES, and they are now closed asymmetrically. Read
  both.**

  **The EARLY edge is closed.** Anything a page does before a test's body — in
  `beforeAll`, in `beforeEach`, or because an earlier test shared it — is
  recorded (the listening is worker-scoped) and charged to a test by name. It
  used to be invisible: a `beforeAll` that navigated a broken page produced a
  green test, and that was the blocking finding this slice exists to close.

  **The LATE edge is widened, not closed, and it is two different things.**
  Within a test, the guard settles a fixed 250 ms after the body returns before
  it asserts; a fault later than that is missed by THAT test. After the last
  test in a worker there is no test left to charge, so the worker fixture's
  teardown fails the **run** instead — measured: a throw there gives
  `npx playwright test` exit 1 with "1 error was not a part of any test", even
  when every test passed. What is genuinely lost is a fault that fires after the
  browser has closed, which nothing can observe.

  Before this slice the in-test window was "whatever the driver had already
  delivered": an independent verifier measured `0 ms` caught and **50 ms and
  150 ms missed**. Measured now, with faults scheduled at 0 / 50 / 150 / 250 /
  400 / 600 ms after the body returns:

  | Settle | Caught | Missed |
  |---|---|---|
  | 0 ms (before) | 0 | 50, 150, 250, 400, 600 |
  | 100 ms | 0, 50 | 150, 250, 400, 600 |
  | **250 ms (shipped)** | 0, 50, 150, 250 | **400, 600** |
  | 400 ms | 0, 50, 150, 250, 400 | 600 |

  The cost is 250 ms per test: the 18-test lane went `3.2 s → 4.4 s` at the
  local worker count and `4.8 s → 6.9 s` at `--workers=2` (the CI shape, 9 tests
  per worker), and ran **20 consecutive times with 18 passed, floor OK and 18
  stamps every time** — on a QUIET machine. **This table is a quiet-machine
  measurement.** The settle is a Node timer and a page fault is a browser timer,
  and load stretches only one of them, so under load the window WIDENS: an
  independent verifier ran the suite at load averages of 76–92 and the 600 ms
  fault was caught in both runs (the fail-closed direction, but a demonstration
  whose outcome depends on load is not evidence). So **D14** now pins the RED
  end with a fault at 150 ms that must fail the test, the LIMIT end with a fault
  20 s after the body — past the settle and past the context's close under any
  load, asserting only the invariant that a fault which has not fired when a
  test's window closes is not charged to that test — and the WIDTH itself with a
  unit test that `SETTLE_MS` is 250 and that this file says so. A spec whose page misbehaves more than about a quarter of a
  second after its own body finished is not charged to THAT test; if a later
  test in the same worker is still running it is charged to that one, and if the
  worker has finished it fails the run — but if the browser has already closed,
  nothing observes it at all.
- **The orphan check is default-deny, and a page that never settles will fail
  the run.** Signals recorded after the last test in a worker are charged to
  nobody, so the worker fixture's teardown fails the run — there is no per-test
  allow-list that can reach them, because there is no test to carry one. That is
  deliberate; it is also the one place where a page that keeps emitting after
  the suite ends turns the run red. Measured: the production lane ran **20
  consecutive times with no orphan**, and the one place an orphan appeared was
  **D5**, whose whole point is that the harness is pointed at `next dev` — a
  server that holds an HMR WebSocket open and logs its failure whenever it
  likes. D5 asserts the dev-server diagnostic and stays red either way, but if a
  future spec drives a page that genuinely never settles, this is where it will
  bite, and the fix is to close that page in `afterAll` rather than to widen the
  check.
- **The `request` fixture is out of the guard's scope, by design.** The guard
  watches BROWSER signals — console, page errors, failed requests and HTTP >= 400
  *responses observed by a browser context*. A 404 from Playwright's
  `APIRequestContext` (`request.get(...)`, `page.request.get(...)`) is not one
  of those and does not fail a test. That is correct — a spec using `request`
  asserts the status itself — but "any HTTP >= 400 response fails the test"
  above reads as if it were covered, so it is stated here: it is not.
- **The canary covers all four guarded kinds** — `requestfailed` gained its
  fixture in this slice, and neutering any one of the four listeners is now red
  by name. What the canary still does not cover is everything outside those four
  signals: it proves the guard still fails a broken page, not that the guard
  watches the right things.
- **`e2e/harness/no-credentials-in-specs.test.ts` is a tripwire, not a proof.**
  It sweeps every `.ts` under `e2e/` except `e2e/harness/**` and matches a named
  list of patterns; it catches the accident, not the determined author. Measured
  evasions: `pressSequentially` instead of `.fill(`, `page.evaluate` setting
  `document.cookie`, credentials read from `process.env`, and a login helper
  placed inside `e2e/harness/`. The real control is the queued artifact-privacy
  slice.
- **The redactor covers URL query strings, fragments and `Location` only.** The
  full "NOT covered" table is above; read it before deciding a red lane is safe
  to share.
- **The upload-scope allowlist is scoped to `e2e.yml`, and one clause is not.**
  Clauses (a)–(e) — literal `path:` entries, the pinned `uses:` allowlist, no
  reusable workflows, no `$GITHUB_STEP_SUMMARY`, `include-hidden-files` — are
  asserted over **every job of `.github/workflows/e2e.yml`**. Only the
  `.vizra-e2e` deny sweep crosses files. So a NEW workflow whose job uploads
  `path: .` is not refused by this guard: measured green by an independent
  verifier. Three things bound it rather than close it — the pinned action
  defaults `include-hidden-files` to false so `path: .` would not itself sweep up
  `.vizra-e2e`; `ci-guard` requires every action in every workflow to be
  SHA-pinned; and adding a workflow is a `.github/` diff. Extending clauses
  (a)–(e) repo-wide would mean allowlisting the paths and actions of
  `frontend-ci.yml`, `contract-ci.yml` and `supply-chain.yml` too, which is a
  change to lanes this slice does not own. **Named here rather than implied
  closed.**
- **A `run:` step that writes through a HELPER SCRIPT is not seen.** The
  refusals of `$GITHUB_STEP_SUMMARY`, `$GITHUB_ENV` and `$GITHUB_PATH` read the
  job's `run:` TEXT and its env-map VALUES at workflow, job and step level — a
  verifier reached the step summary through an env map (`S: ${{ env.
  GITHUB_STEP_SUMMARY }}`, then `echo >> "$S"`) while this bullet said the
  indirect form was refused, which was false; it is refused now. What is still
  not seen: `run: bash scripts/ci/some-helper.sh` where the helper does the
  write, a script that computes the name, sources another file, or writes from a
  here-doc. Same class as the `run:`-exfiltration bullet above, same answer: no
  workflow parser closes it and review is the control. **For the one variable
  this lane depends on**: a `$GITHUB_ENV` write that blanks
  `PLAYWRIGHT_NO_COPY_PROMPT` is caught by the runtime policy inside the
  Playwright worker while the capture says "CI"; a DIRECT `$GITHUB_ENV` assignment
  of `CI` or `GITHUB_ACTIONS` itself cannot make it say otherwise, because
  `GITHUB_ACTIONS` cannot be overwritten that way (D16c, simulated). A helper's
  write can still silence layer 2 INDIRECTLY: a `BASH_ENV` written to
  `$GITHUB_ENV` is sourced by the lane step's own shell, and a `$GITHUB_PATH` entry
  puts a different `npm` first — either can remove both anchors before Playwright
  starts, as can an in-process preload. Then the pinned redaction step's
  page-snapshot gate (layer 3) is what holds. Reasoned from GitHub's pages and the
  Bash manual, not built.
- **A user-level or global `.npmrc` on the runner, and `NPM_CONFIG_*` from the
  runner image, are not read by the lane guard.** A committed `.npmrc` is
  default-deny; `npm_config_userconfig` / `npm_config_globalconfig`, and **`HOME`**
  (whose `.npmrc` npm reads — R3-FINDING K), are refused in every env map, and env
  maps are default-deny anyway; a file a `run:` step writes into the home
  directory is the `run:` class. One that blanks `PLAYWRIGHT_NO_COPY_PROMPT`
  before the configuration loads is caught by the runtime policy check ONLY while
  the capture still says "CI" (`CI` truthy or `GITHUB_ACTIONS` "true"); an
  npm-driven route runs in-process — `node-options` reaches `NODE_OPTIONS` — and
  can delete both anchors, and then layer 2 is silent and the pinned redaction
  step's page-snapshot gate (layer 3) is the control that holds. One that does
  something ELSE to every `npm run` is not caught.
- **Pinning a step fixes its BYTES, not what they run.** The nine steps in
  `.github/e2e-pinned-steps.yml` cannot be laundered, reordered, re-keyed or
  duplicated in the workflow, and their environment is default-deny; the unpinned
  `actions/checkout` and `actions/setup-node` steps have their `with:` pinned (no
  other `ref:`, no persisted credentials), and `npm ci`'s ROOT lifecycle scripts
  are refused in `package.json` — but an earlier `run:` step (unpinned, e.g.
  `npm ci`'s neighbours), or a DEPENDENCY's own install script run by `npm ci`,
  that rewrites `scripts/ci/redact-artifacts.sh` or `package.json` in the
  workspace changes what a byte-equal step does. `package.json`'s `e2e*` scripts are byte-pinned too;
  the scripts under `scripts/ci/` are CODEOWNERS paths. This is the `run:` class,
  and review is its control: the shapes `require-checks_test.sh` exercises are red
  by name, and the class is stated, not closed.
- **A stray extra Playwright config file is green, and inert.** A second
  `playwright.*.config.ts` in the tree is not refused. It can only be SELECTED by
  `--config` in a script or `PLAYWRIGHT_CONFIG` in the environment, and both of
  those are red (the scripts are byte-pinned, and every `PLAYWRIGHT_*` key but
  one is refused at all three env scopes). Recorded because "green" and "safe"
  are different words.
- **Platform.** ADR-009's acceptance platform is GitHub `ubuntu-24.04`,
  linux/amd64. Local runs on macOS arm64 carry no platform claim.

Evidence, including the red and green transcript of every demonstration, is in
`docs/evidence/VZ-FOUND-008/`.

## CI and merge
One required status check, `ci-required` (ADR-002). It reads
`.github/required-checks.txt` and fails when any listed lane fails, is
cancelled, times out, is skipped or never ran. It runs on `pull_request` and
`merge_group`, so every required lane must trigger on both — a lane that does
not run in the merge queue would hang the queue rather than pass it.

`ci-guard` guards the other workflows: SHA-pinned actions, no unmarked
`continue-on-error`, `npm ci` not `npm install`, a manifest that names only
real jobs, shellchecked `scripts/ci`, `@sha256`-pinned Dockerfile base images
at the `.nvmrc` version, and the fan-in's regression suite.

**Supply chain.** `supply-chain.yml` runs two detection lanes on every pull
request and in the merge queue — `npm audit` over the lockfile, and Trivy over
the built production image — and publishes both reports as artifacts. They are
**deliberately not in `.github/required-checks.txt`**. `ci-guard` forbids
`continue-on-error`, on purpose; the honest alternative to hiding a lane's
failures is not to make it required until its baseline is clean and there is an
agreed route for an unfixed upstream CVE, because a scan lane's result depends
on the world and a required lane that goes red on its own teaches a team to
merge past red. Promotion is an owner-reviewed change to the manifest and the
floor. Read them; do not route around them.

**The floor.** `ci-required` reads the manifest from the checkout under test,
so the file that defines the gate is editable by the pull request the gate is
gating — deleting one line used to merge green with lint, typecheck, tests and
the build never having had to pass. `scripts/ci/check-required-floor.sh` fixes
a floor (`frontend`, `contract`, `e2e`) in a separate file and fails by name
when the manifest stops demanding it, whether by deletion or by demotion to
`?optional`. Adding `e2e` to that floor is an owner-reviewed change, and so is
ever taking it out.

Adding, renaming or removing a required lane is an owner-reviewed change
(`.github/CODEOWNERS` covers `.github/`, `scripts/ci/`, `eslint-rules/` and
`contracts/`). CODEOWNERS only bites once a ruleset requires Code Owner review,
which is an owner action, not part of any PR. Never weaken the manifest or the
floor to turn a PR green.

## Pins
Versions come from ADR-001 and are verified on the npm registry before they are
written. Change one only in a PR that also records why. ADR-001 pins no browser
tooling, so `@playwright/test` is pinned here instead: **1.63.0**, exact and
never a range, confirmed as `latest` on the npm registry on 2026-09-20. The
browser it resolves is recorded with it — Chromium `chromium-1243` /
`chromium_headless_shell-1243` (Chrome for Testing 153.0.8010.12), and the
`e2e` lane prints `playwright install --dry-run chromium` into its artifacts so
every run records what it actually downloaded. Node is pinned once, in
`.nvmrc`, and read from there by CI and by the Dockerfile's base image tag —
keep the three in step. The Dockerfile's `FROM` lines additionally carry an
`@sha256` digest (a tag can be repointed by the registry, which would change
what ships with no diff): re-resolve it with
`docker buildx imagetools inspect node:<version>-alpine` and take the top-level
multi-arch index digest. `scripts/ci/check-image-pins.sh` enforces both halves,
so a `.nvmrc` bump cannot leave a stale digest behind silently.

## Evidence
`READY_FOR_REVIEW`, never "done". Record exact commands, exit codes, test
counts, skips, the source SHA and the environment. A test that is skipped,
cancelled or never collected is not a pass. Demonstrate a check failing against
a controlled mutation before claiming it protects anything.
