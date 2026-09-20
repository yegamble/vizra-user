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
| `npm run e2e:demos` | run the five red/green demonstrations that prove the harness fails |
| `npm run check:contract` | vendored spec ↔ manifest ↔ generated client |
| `npm run codegen` | regenerate the client from the vendored spec |
| `node scripts/vendor-contract.mjs --from ../vizra-core` | take a newer contract |
| `bash scripts/ci/require-checks_test.sh` | the `ci-required` fan-in's own suite, plus the manifest-floor and image-pin cases |
| `bash scripts/ci/check-required-floor.sh` | the required-check manifest still demands `frontend` and `contract` |
| `bash scripts/ci/check-image-pins.sh` | every Dockerfile `FROM` is `@sha256`-pinned at the `.nvmrc` version |
| `bash scripts/ci/check-client-bundle.sh` | no server-side configuration reached `.next/static` (run after a build) |
| `bash scripts/ci/check-e2e-lane.sh` | the `e2e` workflow still drives the built image, keeps its coverage floor and uploads artifacts |
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
of the wrong shape throws rather than being coerced. Never import `test` from
`@playwright/test` in a spec — that bypasses the guard, and
`e2e/harness/browser-errors.test.ts` fails the `frontend` lane if a spec does.

**A run that tests nothing is not a pass.** `e2e/harness/coverage-reporter.ts`
fails the run unless every project in `e2e/harness/required-projects.ts` exists
in the configuration and actually ran a test. It is on by default;
`scripts/ci/check-e2e-lane.sh` fails if the workflow ever turns it off.

**The fault-injection fixtures never ship.** The demonstrations in `e2e/demos/`
inject their faults with `page.addInitScript` against the unmodified production
server — there is no `app/` route to delete — and
`scripts/ci/check-no-test-fixtures-in-image.sh` proves the built image contains
neither a harness path nor the `__vizra_e2e_fixture__` token.

**What this lane does NOT cover, and does not claim.** Chromium only: no WebKit,
so Safari behaviour is not claimed. No accessibility engine yet — VZ-A11Y-001 is
M1, and the seam is documented in `e2e/harness/test.ts` where the axe assertion
belongs. No visual baselines: `toHaveScreenshot` is unused on purpose, because
approving a baseline is a reviewed act of its own.

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
