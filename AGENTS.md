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
  `contracts/manifest.json` records the source repo, the core commit, the
  sha256 and the date.
- `lib/api/generated.ts` is generated from that copy by the pinned
  `openapi-typescript`. It is never hand-edited, never linted, and never
  partially updated.
- `npm run check:contract` proves the vendored spec matches its manifest and
  the committed client is byte-for-byte what the generator produces. The
  `contract` lane runs it on every PR.
- The spec is validated **as input** before the generator reads it:
  `scripts/check-spec-refs.mjs` refuses any `$ref` that is not an in-document
  pointer. openapi-typescript resolves external `$ref` targets through
  `@redocly/openapi-core` — demonstrated, not assumed: a remote `$ref` makes
  the generator issue an outbound request during the `contract` lane. A file
  `$ref` is refused too, because the vendored contract is one file recorded by
  one sha256 and a second file would be input the drift check does not cover.
- To take a newer contract: `node scripts/vendor-contract.mjs --from ../vizra-core`,
  then commit the spec, the manifest and the regenerated client together.

Never hand-write a request or response type for an endpoint the contract
already describes, and never "temporarily" edit the vendored spec to unblock
work here. A contract change is vizra-core's to make.

**Owed (not done, do not treat as covered):** the `contract` lane cannot yet
tell whether the vendored copy is *stale* relative to core's `main`, because
`yegamble/vizra-core` is private and this repository holds no token to read it.
When a read-only token exists, add a step comparing the vendored copy against
core's default branch. Until then a stale vendor is caught only by review of
`contracts/manifest.json` and by core's own route↔spec test.

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
| `npm run check:contract` | vendored spec ↔ manifest ↔ generated client |
| `npm run codegen` | regenerate the client from the vendored spec |
| `node scripts/vendor-contract.mjs --from ../vizra-core` | take a newer contract |
| `bash scripts/ci/require-checks_test.sh` | the `ci-required` fan-in's own suite, plus the manifest-floor and image-pin cases |
| `bash scripts/ci/check-required-floor.sh` | the required-check manifest still demands `frontend` and `contract` |
| `bash scripts/ci/check-image-pins.sh` | every Dockerfile `FROM` is `@sha256`-pinned at the `.nvmrc` version |
| `bash scripts/ci/check-client-bundle.sh` | no server-side configuration reached `.next/static` (run after a build) |
| `bash scripts/ci/check-e2e-lane.sh` | PARSES the `e2e` workflow: the lane step and the harness canary exist, run exactly their documented commands, are unconditional, target the built image; the coverage-floor step follows the lane; EVERY upload step is gated on the redaction having succeeded |
| `node scripts/ci/check-coverage-floor-ran.mjs` | the finished JSON report satisfies `e2e/harness/required-projects.json` AND every result that succeeded carries a valid harness stamp (run after the lane) |
| `node scripts/ci/harness-canary.mjs` | the guard itself still fails a broken page: the three fault-injection fixtures must each fail for their own named reason (needs a production target, as the lane does) |
| `bash scripts/ci/redact-artifacts.sh` | strip URL query strings from artifacts, inside `trace.zip` members too, before upload |
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

**Default-deny on browser errors.** `e2e/harness/test.ts` replaces Playwright's
`page` fixture so that, for every test, a console error, an uncaught exception,
a failed request or any HTTP >= 400 response fails the test in teardown —
whether or not the test body looked. The only way past it is per test:

```ts
test.use({
  browserErrorPolicy: {
    allow: [{ kind: "response", match: /\/icon\.svg$/, reason: "not built yet (VZ-...)" }],
  },
});
```

`kind`, a RegExp `match` and a non-blank `reason` are all required, and a policy
of the wrong shape throws rather than being coerced.

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

The key is not readable from a spec. It reaches workers through the
environment, and `e2e/harness/stamp.ts` **deletes it from `process.env` while
the configuration is being loaded**, which in a worker happens before any test
file is evaluated (`WorkerMain.runTestGroup` calls `_loadIfNeeded()` — which
re-executes `playwright.config.ts` — before `loadTestFile`; read out of the
installed `playwright/lib/worker/workerProcessEntry.js`, not assumed). That is
why `playwright.config.ts` imports `./e2e/harness/test`: the import is a
load-bearing side effect, and `check-e2e-lane.mjs` fails if it goes. The signer
is handed out **once per worker**, to the harness entry, during that same load —
so a spec that imports `e2e/harness/stamp` and calls `claimSigner()` itself gets
a throw. The reporter writes the key to `.vizra-e2e/stamp-key.json` only in
`onEnd`, after the last test has finished, so the out-of-process check can
verify it while no running spec could have read it.

**What forging a stamp would take, stated honestly.** One of:

1. recovering the 32-byte per-run key from inside a spec — it is absent from the
   worker's environment, absent from disk while any test is running, and not
   derivable from the report;
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
harness**, and switching the harness off is a deliberate act in a file whose job
is to be a gate — not a one-line opt-out in a spec.

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

**Covered — URL query strings, fragments, and `Location`.** Two layers, because
they reach different bytes:

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
| `.png` screenshots and `.webm` video (excluded on purpose: a byte substitution corrupts them, and a rendered page is pixels, not a greppable string) | as recorded |

Earlier wording here offered "keeping origin, path, **headers** and timings
readable" as a feature. Headers are the uncovered channel; that sentence is
gone.

**The rule that follows, and it is a hard line.** Until the artifact-privacy
slice lands (header, body, DOM and call-parameter redaction — its own slice, not
this one): **no spec may authenticate, fill a credential, or touch a real signed
URL.** The traces are safe today for exactly one reason — nothing in this
repository authenticates: there is no vizra-core, no session cookie and no
signed URL. That is an accident of scope, not a control, so
`e2e/harness/no-credentials-in-specs.test.ts` asserts it in the `frontend` lane:
`addCookies`, `storageState`, `setExtraHTTPHeaders`, `httpCredentials`,
`Authorization`, `Bearer`, `Set-Cookie`, `.fill(`, credential-shaped
identifiers and signed-URL shapes are all refused in `e2e/specs/**` and
`e2e/demos/**`, with one allow-list entry — D9's sentinel — carrying a written
reason. A slice that needs to log in lands the privacy slice first, or waits.

When that slice lands, the first authenticating spec proves its coverage with
`scripts/e2e/sweep-artifacts.sh`, which already performs exactly this search.

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
same container the lane just drove, and requires each of the three
fault-injection fixtures to fail **for its own named reason**:

| Fixture | Must fail with |
|---|---|
| `e2e/demos/console-error.demo.ts` | `console.error`, `browser error(s) that no allow-list entry covers` |
| `e2e/demos/failed-request.demo.ts` | `http 404` |
| `e2e/demos/uncaught-exception.demo.ts` | `pageerror` |

Per-reason and not merely a count, because the sharpest case needs it: with the
`response` listener neutered, the 404 fixture still fails — on the console error
the 404 also produces — so a canary that only counted failures would pass. One
browser launch, about three seconds. `check-e2e-lane.mjs` asserts the step
exists, runs exactly that command, is unconditional, does not
`continue-on-error` and drives the container; `require-checks_test.sh` drives
all of that against mutated workflows. Demonstration D12 neuters each listener
in turn and shows the lane going red.

The Docker D6 pair, D5 (`next dev`), D7 (the workflow parser) and D9 (artifact
redaction) are deliberately NOT in the canary: they need a second image build, a
development server, or are already asserted by cheap checks in other lanes. The
canary is the smallest thing that would have caught the silent case.

**Every artifact-upload step is checked, not the first one.** The parser used
`steps.find(...)`, so a SECOND `actions/upload-artifact` step on a bare
`if: failure()` passed — and when the redactor fails, the gated upload is
skipped while the ungated one publishes the unredacted tree. It is now
`filter`, every uploader must carry `failure() && steps.redact.outcome ==
'success'`, and an uploader whose action is *not* `actions/upload-artifact` is
recognised as one rather than ignored.

**What this lane does NOT cover, and does not claim.** Chromium only: no WebKit,
so Safari behaviour is not claimed. No accessibility engine yet — VZ-A11Y-001 is
M1, and the seam is documented in `e2e/harness/test.ts` where the axe assertion
belongs. No visual baselines: `toHaveScreenshot` is unused on purpose, because
approving a baseline is a reviewed act of its own.

### Residuals — what is still only as strong as review

Listed because a control whose limits are unstated is a control people
over-trust. None of these is closed by this slice, and none should be described
as if it were.

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
