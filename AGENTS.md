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
| `bash scripts/ci/check-e2e-lane.sh` | PARSES the `e2e` workflow: the lane step and the harness canary exist, run exactly their documented commands, are unconditional, target the built image; the coverage-floor step follows the lane; EVERY upload step is gated on the redaction having succeeded |
| `node scripts/ci/check-coverage-floor-ran.mjs` | the finished JSON report satisfies `e2e/harness/required-projects.json` AND every result that succeeded carries a valid harness stamp (run after the lane) |
| `node scripts/ci/harness-canary.mjs` | the guard itself still fails a broken page: each of the three fault-injection fixtures must fail with the exact SET of record kinds it demonstrates and no others (needs a production target, as the lane does) |
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

**Default-deny on browser errors, over every page the test creates.**
`e2e/harness/test.ts` has ONE automatic fixture, `vizraHarnessGuard`, which
attaches the guard **at the browser** for the test's lifetime and writes the
runtime stamp. For every test, a console error, an uncaught exception, a failed
request or any HTTP >= 400 response **observed by a browser context** fails the
test — whether or not the test body looked, and whichever page produced it. A
404 from Playwright's `request` fixture is not a browser signal and is out of
scope; see § Residuals. The only way past it is per test:

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

**One fixture.** The guard and the stamp are in `vizraHarnessGuard`, so removing
the guard removes the stamp, which both the in-process reporter and the
out-of-process check already refuse. There is no second fixture for
`test.extend` to take apart.

**Attached at the browser, not at a page.** Guarding a second page would have
moved the hole to a popup, a new tab or a fresh context. The fixture takes
`browser` as a dependency and attaches `console`, `weberror`, `requestfailed`
and `response` listeners at **BrowserContext** level — all four exist on
`BrowserContext` in the installed Playwright 1.63.0 types, checked in
`playwright-core/types/types.d.ts` rather than assumed — and a context event
fires for every page in that context. It sweeps the contexts that already exist
and wraps `browser.newContext` / `browser.newPage` for the test's lifetime,
restoring both afterwards, because the browser is worker-scoped and shared.

Covered, each demonstrated red then green in **D13**: the verifier's exploit
verbatim; a second page in the default context; `browser.newContext()` in the
body; `browser.newPage()`; an overridden `context` fixture; an overridden `page`
fixture that navigates **inside itself** and never in the body; a popup the page
opens with `window.open`; and an overridden `browser` fixture (which needs no
import at all — `playwright` is a built-in fixture — so lint cannot see it and
only the runtime catches it).

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

The stamp is written by the same fixture that installs the guard, so **stamped
implies guarded**: a spec cannot keep one and drop the other. That sentence was
false for one round, and the section above says how.

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

**Covered — query strings and fragments on URLs that carry a scheme or start at
`/`, and `Location`.** Two layers, because they reach different bytes. Read the
scheme-less exception below before relying on this: it is not "every query
string in every artifact", and this section used to say that it was.

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

**NOT covered: a SCHEME-LESS `host:port/path?query`, which is exactly how
Playwright records a step subtitle.** This section previously claimed "**No URL
query string leaves this repository, in any artifact**". That sentence is false,
and an independent verifier reduced it to three lines against the redactor
itself:

```
"url":"http://host/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"        ->  ?<redacted>   OK
"path":"/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"                  ->  ?<redacted>   OK
"subtitle":"host:3219/m.jpg?X-Amz-Sig=SENTINELVALUE&e=60"     ->  UNCHANGED     LEAK
```

`scripts/ci/redact-artifacts.sh`'s absolute program requires `scheme://` and its
relative program requires the match to begin at `/`; `host:port/path?query`
satisfies neither. Playwright drops the scheme when it writes a `test.trace` step
subtitle, so **any `page.goto(signedUrl)` or `page.request.get(signedUrl)`
produces one**, and the verifier measured a sentinel going 3 members → **1**
after redaction, surviving in `test.trace`.

**D9 does not exercise this path, and does not claim to.** Its fixture injects
the signed URL as a *sub-resource* (`img.src = url`) and navigates to `/`; a
sub-resource never becomes a step subtitle. The demonstration is sound for what
it covers and blind to this.

**Nothing can leak today**, for the same one reason as everything else in this
section: no spec touches a signed URL, nothing authenticates, and there is no
vizra-core. The existing hard rule below — no spec may authenticate, fill a
credential or touch a real signed URL until the artifact-privacy slice lands —
is what holds the line, and it is asserted by
`e2e/harness/no-credentials-in-specs.test.ts`. **The fix is queued with that
slice**: a third program for authority-relative URLs (an optional `host[:port]`
before the path), plus a second D9 fixture that reaches the sentinel through
`page.goto()` so the subtitle path is covered by the demonstration that claims
to cover it. Not done here.

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
same container the lane just drove. It runs each fault-injection fixture in its
own invocation and asserts the **exact set of record kinds** the guard recorded
for it — the kinds that must be present, and the kinds that must not:

| Fixture | Must record | Must NOT record |
|---|---|---|
| `e2e/demos/console-error.demo.ts` | `[console]`, `console.error` | `[response]`, `[pageerror]`, `[requestfailed]` |
| `e2e/demos/failed-request.demo.ts` | `[response]`, `http 404` | `[pageerror]`, `[requestfailed]` |
| `e2e/demos/uncaught-exception.demo.ts` | `[pageerror]` | `[response]`, `[console]`, `[requestfailed]` |

`[console]` is deliberately allowed for the 404 fixture: Chromium logs the
failed load itself. That is measured, in
`docs/evidence/VZ-FOUND-008/d2-failed-request-RED.txt`, not assumed.

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
error the 404 also produces, so a canary that counted failures would pass. About
six seconds, three browser launches. `check-e2e-lane.mjs` asserts the step
exists, runs exactly that command, is unconditional, does not
`continue-on-error` and drives the container; `require-checks_test.sh` drives
all of that against mutated workflows. Demonstration D12 removes each of the
four context listeners in turn and shows the lane going red for three of them —
and honestly GREEN for `requestfailed`.

**THE CANARY COVERS THREE OF THE FOUR GUARDED SIGNAL KINDS.** There is no
`requestfailed` fixture: the three demonstrate a console error, an HTTP 404 and
an uncaught exception, and a 404 is a *completed response*, not a failed
request. An independent verifier measured the consequence directly — neutering
the `console`, `weberror` or `response` listener turns the canary red; neutering
`requestfailed` leaves it **green**. So the one kind that catches aborted
requests, connection refused and DNS failures could be dropped from the guard
and no lane would notice, which is the exact defect class the canary exists to
close for the other three. **Queued with the harness slice**: a fourth fixture
that requests a closed port or aborts a route, with expected kinds
`["requestfailed"]`, so the exact-kind-set assertion covers all four. Not done
here.

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
- **A CONTEXT OR BROWSER THE HARNESS WAS NEVER HANDED is not guarded, and
  nothing catches that today.** The guard attaches to the browser the fixture
  receives and wraps that instance's `newContext` / `newPage` as **own**
  properties. Anything that produces a context without going through those own
  properties escapes. An independent verifier measured three such routes, each
  from a spec in `e2e/specs/` importing only the harness `test`:

  | Route | Result |
  |---|---|
  | `Object.getPrototypeOf(browser).newContext.call(browser)` | **unguarded** — the wrapper is an own property; the prototype method is still reachable |
  | `browser.browserType().launch()` | **unguarded** |
  | `playwright.chromium.launchPersistentContext(dir)` | **unguarded** |
  | `Object.getPrototypeOf(browser).newPage.call(browser)` | guarded — the prototype's `newPage` calls `this.newContext`, which is the wrapper |

  Each of the three passed the **complete** gate on a page that 404s a
  sub-resource and throws on every load: lint green, lane exit 0 with
  `20 passed, coverage floor: OK (10/9 10/9), harness stamp: OK (20 verified)`,
  and the out-of-process check exit 0.

  **This paragraph previously said the shape was "importing a Playwright
  package and calling `chromium.launch()`" and named
  `vizra/no-unguarded-playwright-import` as what catches it. That was false.**
  `import { chromium } from "@playwright/test"` is indeed refused by the rule —
  but none of the three routes above imports anything, so the rule never sees
  them; `browserType` and `launchPersistentContext` appear nowhere in the rule,
  the harness or the CI scripts. **Nothing catches these today**: not the rule,
  not the runtime stamp (such a test still came from the harness `test`, so it
  is still stamped), not the coverage floor, not the canary, not the workflow
  parser. The only control is review, and the routes are at least conspicuous —
  none has an innocent reading in a repository with one app and one browser.

  **Queued as the next harness slice**, in the verifier's own shape: a teardown
  assertion in `vizraHarnessGuard` that `browser.contexts()` holds no context
  the guard never saw (which closes the prototype route and any future creation
  path on a browser the harness holds, with no monkey-patching), plus
  `.browserType(`, `.launch(` and `.launchPersistentContext(` added to the lint
  rule for the specs. Not done here; do not read this bullet as if it were.
- **The harness-owned-fixture ban is lint.** Replacing `vizraHarnessGuard` is
  refused by the rule and, at runtime, costs the spec its stamp — which both
  floor checks refuse. Replacing `page`, `context` or `browser` is legitimate,
  is not refused, and is covered by the guard (D13, eight shapes).
- **The flush window is finite.** The guard flushes every guarded page after the
  test body returns and then asserts. A fault scheduled `0 ms` after the body
  returns is caught; an independent verifier measured faults at **50 ms and
  150 ms being missed**. That is inherent to asserting at a point in time rather
  than a defect to redesign around, but a spec whose page misbehaves only after
  it has finished is not covered, and this file should not imply otherwise.
- **The `request` fixture is out of the guard's scope, by design.** The guard
  watches BROWSER signals — console, page errors, failed requests and HTTP >= 400
  *responses observed by a browser context*. A 404 from Playwright's
  `APIRequestContext` (`request.get(...)`, `page.request.get(...)`) is not one
  of those and does not fail a test. That is correct — a spec using `request`
  asserts the status itself — but "any HTTP >= 400 response fails the test"
  above reads as if it were covered, so it is stated here: it is not.
- **The canary covers three of the four guarded kinds.** `requestfailed` has no
  fixture; see the canary section. Queued.
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
