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
     (`const f = fetch`, `const { fetch } = globalThis`). An aliased fetch is
     invisible to the identity rule.
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
| `npm run check:contract` | vendored spec ↔ manifest ↔ generated client |
| `npm run codegen` | regenerate the client from the vendored spec |
| `node scripts/vendor-contract.mjs --from ../vizra-core` | take a newer contract |
| `bash scripts/ci/require-checks_test.sh` | the `ci-required` fan-in's own suite, plus the manifest-floor cases (needs bash ≥ 4) |
| `bash scripts/ci/check-required-floor.sh` | the required-check manifest still demands `frontend` and `contract` |

Run `npm run ci` before opening a PR. A missing command or dependency is
BLOCKED, never a pass.

## CI and merge
One required status check, `ci-required` (ADR-002). It reads
`.github/required-checks.txt` and fails when any listed lane fails, is
cancelled, times out, is skipped or never ran. It runs on `pull_request` and
`merge_group`, so every required lane must trigger on both — a lane that does
not run in the merge queue would hang the queue rather than pass it.

`ci-guard` guards the other workflows: SHA-pinned actions, no unmarked
`continue-on-error`, `npm ci` not `npm install`, a manifest that names only
real jobs, shellchecked `scripts/ci`, and the fan-in's regression suite.

**The floor.** `ci-required` reads the manifest from the checkout under test,
so the file that defines the gate is editable by the pull request the gate is
gating — deleting one line used to merge green with lint, typecheck, tests and
the build never having had to pass. `scripts/ci/check-required-floor.sh` fixes
a floor (`frontend`, `contract`) in a separate file and fails by name when the
manifest stops demanding it, whether by deletion or by demotion to `?optional`.

Adding, renaming or removing a required lane is an owner-reviewed change
(`.github/CODEOWNERS` covers `.github/`, `scripts/ci/`, `eslint-rules/` and
`contracts/`). CODEOWNERS only bites once a ruleset requires Code Owner review,
which is an owner action, not part of any PR. Never weaken the manifest or the
floor to turn a PR green.

## Pins
Versions come from ADR-001 and are verified on the npm registry before they are
written. Change one only in a PR that also records why. Node is pinned once, in
`.nvmrc`, and read from there by CI and by the Dockerfile's base image tag —
keep the three in step.

## Evidence
`READY_FOR_REVIEW`, never "done". Record exact commands, exit codes, test
counts, skips, the source SHA and the environment. A test that is skipped,
cancelled or never collected is not a pass. Demonstrate a check failing against
a controlled mutation before claiming it protects anything.
