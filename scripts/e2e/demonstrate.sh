#!/usr/bin/env bash
# Prove the browser harness actually fails — five demonstrations, red then green.
#
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH. Two earlier pull requests in this
# repository each shipped a guard that passed while testing nothing, and both
# were caught only by running the guard against a controlled mutation. The
# meta `AGENTS.md` requires exactly that ("demonstrate the relevant test fails
# ... against a controlled mutation"), and requires it to be REPRODUCIBLE by an
# independent verifier. So the demonstrations are executable, and their
# transcripts are written into docs/evidence/VZ-FOUND-008/ where they travel
# with the pull request.
#
#   D1  a page that logs console.error fails the lane
#   D2  a page that requests a resource returning 404 fails the lane
#   D3  an uncaught exception in the page fails the lane
#   D3b a request that never completes fails the lane (the fourth guarded kind)
#   D4  the lane fails when ZERO tests are collected, or a project is missing
#   D5  the lane fails when pointed at a dev server instead of the production build
#   D6  the built image contains no harness file and no fixture token
#   D7  a weakened e2e workflow fails the lane guard — including the lane step
#       being deleted, echo-replaced, `|| true`-ed or `if: false`-ed
#   D8  a spec reaching Playwright's unguarded `test` fails the gate, in every
#       spelling an independent verifier walked through the previous guard with
#   D9  a signed-URL-shaped query string does not survive into an uploaded
#       artifact, trace.zip members included
#   D10 a spec that handles a credential fails the cheap lane — the hard line
#       that holds until the artifact-privacy slice lands
#   D11 THE RUNTIME PROOF. A spec that does not go through the guarded harness
#       is RED *at runtime*, whatever lint thinks — every historical bypass
#       door, plus two the verifier has not tried, plus the out-of-process half
#       with the in-process reporter deleted
#   D12 THE CANARY. Neutering the guard's own listeners, one at a time, turns
#       the required `e2e` lane red — the case that was silent in CI — for ALL
#       FOUR guarded kinds, `requestfailed` included; and a fixture that fails
#       for the WRONG reason turns it red too
#   D13 STAMPED IMPLIES GUARDED. The guard is attached at the BROWSER, so every
#       context and page a test creates is guarded: the verifier's fixture-
#       override exploit, a second page, a fresh context, `browser.newPage`, an
#       overridden `context`, an override that navigates inside ITSELF, a popup,
#       and an overridden `browser` — plus the THREE IMPORT-FREE ROUTES an
#       independent verifier measured reaching an unguarded page (the browser's
#       prototype `newContext`, `browserType().launch()` and
#       `launchPersistentContext`), `connect`/`connectOverCDP`, a swallowed
#       refusal, and the teardown catch-all with the registration cut — plus the
#       inverse controls, that an HONEST override on a healthy page stays green
#       and that the routes really were import-free
#   D14 THE FLUSH WINDOW. How late after the test body a fault can fire and
#       still be caught, measured at six delays, with the cost of the settle
#   D15 THE EARLY EDGE. A page broken in `beforeAll`/`beforeEach`, a page shared
#       between tests, an `afterAll` hook, a `describe.serial` suite, a
#       worker-scoped fixture of the spec's own, a raw CDP target, and a
#       replaced worker-scoped guard — each red BY PHASE — plus the mutation
#       that cuts the before-phase accounting and shows the verifier's spec
#       going green again, and the honest inverse controls
#
# D6 needs Docker. Without it the demonstration is BLOCKED and says so; it is
# never counted as a pass (meta `AGENTS.md`).
#
# Each RED half must exit NON-ZERO and print a named diagnostic; each GREEN half
# must exit ZERO. This script fails if any half behaves the other way round —
# "the demonstration did not demonstrate" is itself a failure.
#
# Usage:  bash scripts/e2e/demonstrate.sh
# Requires: a production build (npm run build) and the Chromium the harness
# pins (npm run e2e:install). Both are checked below; a missing one is BLOCKED,
# never a pass.
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$here/../.." && pwd)
cd "$repo"

evidence=${EVIDENCE_DIR:-$repo/docs/evidence/VZ-FOUND-008}
mkdir -p "$evidence"

prod_port=${DEMO_PROD_PORT:-3211}
dev_port=${DEMO_DEV_PORT:-3212}
project=${DEMO_PROJECT:-desktop-chromium-1440}

pass=0
fail=0
blocked=0
started=""

log() { printf '\n=== %s ===\n' "$*"; }

# THE MUTATION LEDGER. Every half below that edits a repository file records a
# sha256 of that file BEFORE the mutation, AFTER it, and AFTER the restore, so a
# verifier can confirm from the evidence alone that the tree it inherited is the
# tree the demonstrations started from — rather than trusting `git status` and a
# trap handler.
digest_ledger=""
digest() {
  # digest LABEL FILE
  local label=$1 file=$2
  local sum
  sum=$(shasum -a 256 "$file" | cut -d" " -f1)
  digest_ledger="${digest_ledger}${label}  ${sum}  ${file#"$repo/"}
"
  printf '  digest %-46s %s\n' "$label" "$sum"
}

cleanup() {
  for pid in $started; do
    kill "$pid" 2> /dev/null || true
  done
  rm -f "$repo/playwright.config.missing-project.ts" \
    "$repo/Dockerfile.fixtures-mutant" \
    "$repo/Dockerfile.fixtures-mutant.dockerignore" \
    "$repo/e2e/specs/__bypass.spec.ts" \
    "$repo/e2e/specs/__shim.ts" \
    "$repo/e2e/specs/__cred.spec.ts" \
    "$repo/e2e/specs/__stamp.spec.ts" \
    "$repo/e2e/specs/__guard.spec.ts" \
    "$repo/eslint.config.no-inline-config.mjs" \
    "$repo/eslint.config.no-banned-methods.mjs" \
    "$repo/playwright.config.no-stamp-reporter.ts"
  rm -rf "$repo/e2e/other"
  # D12e swaps the console fixture's fault type; restore it whatever happens.
  if [ -f "$repo/.console-error.demo.ts.bak" ]; then
    cp "$repo/.console-error.demo.ts.bak" "$repo/e2e/demos/console-error.demo.ts"
    rm -f "$repo/.console-error.demo.ts.bak"
  fi
  # D12 replaces e2e/harness/browser-errors.ts with a mutant; restore it
  # whatever happens, including on Ctrl-C, so an interrupted run never leaves a
  # neutered guard on disk.
  if [ -f "$repo/.browser-errors.ts.bak" ]; then
    cp "$repo/.browser-errors.ts.bak" "$repo/e2e/harness/browser-errors.ts"
    rm -f "$repo/.browser-errors.ts.bak"
  fi
  # D13p neuters the creation guard's registration; restore it whatever
  # happens, for the same reason as the guard above.
  if [ -f "$repo/.creation-guard.ts.bak" ]; then
    cp "$repo/.creation-guard.ts.bak" "$repo/e2e/harness/creation-guard.ts"
    rm -f "$repo/.creation-guard.ts.bak"
  fi
  # D13q neuters e2e/harness/test.ts to prove the lane guard notices; restore
  # it whatever happens, so an interrupted run never leaves the harness entry
  # with its creation guard removed on disk.
  if [ -f "$repo/.test.ts.bak" ]; then
    cp "$repo/.test.ts.bak" "$repo/e2e/harness/test.ts"
    rm -f "$repo/.test.ts.bak"
  fi
  if [ -f "$repo/.worker-guard.ts.bak" ]; then
    cp "$repo/.worker-guard.ts.bak" "$repo/e2e/harness/worker-guard.ts"
    rm -f "$repo/.worker-guard.ts.bak"
  fi
  rm -rf "$repo/.vizra-demo-userdata"
}
# INT and TERM as well as EXIT: D12 temporarily neuters e2e/harness/browser-errors.ts,
# and an interrupted run must never leave the guard switched off on disk.
trap cleanup EXIT INT TERM

# --- preflight -------------------------------------------------------------
[ -f "$repo/.next/BUILD_ID" ] || {
  echo "BLOCKED: no production build. Run:"
  echo "  INTERNAL_API_BASE_URL=http://api.sentinel.invalid:8080 PUBLIC_ORIGIN=http://127.0.0.1:$prod_port npm run build"
  exit 2
}
npx playwright --version > /dev/null 2>&1 || {
  echo "BLOCKED: playwright is not installed (npm ci)."
  exit 2
}

wait_for() {
  local url=$1 name=$2
  for _ in $(seq 1 60); do
    if curl --silent --fail --max-time 2 "$url" -o /dev/null; then return 0; fi
    sleep 1
  done
  echo "BLOCKED: $name never answered at $url"
  return 2
}

# --- the servers -----------------------------------------------------------
log "starting the production server on :$prod_port"
INTERNAL_API_BASE_URL=http://api.sentinel.invalid:8080 \
  PUBLIC_ORIGIN="http://127.0.0.1:$prod_port" \
  node scripts/e2e/serve-production.mjs --port "$prod_port" > "$evidence/server-production.log" 2>&1 &
started="$started $!"
wait_for "http://127.0.0.1:$prod_port/health" "the production server"

prod_url="http://127.0.0.1:$prod_port"

# record WHAT ran, so the transcripts are attributable
# The COMMITTED environment record holds only what is stable at a given commit,
# so a re-run at the same SHA leaves it byte-identical and `git status` after
# the demos means something. The volatile facts — the wall-clock date, the
# Next.js build id (random per build), the tree state — are printed to the RUN
# LOG instead, where they are still recorded but do not churn the repository.
{
  echo "branch:     $(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  echo "head sha:   $(git -C "$repo" rev-parse HEAD)"
  echo "node:       $(node --version)"
  echo "playwright: $(npx playwright --version)"
  echo "project:    $project"
  echo "uname:      $(uname -sm)"
} > "$evidence/environment.txt"
cat "$evidence/environment.txt"
{
  echo "--- not committed (volatile), printed here instead ---"
  echo "repository: $(git -C "$repo" rev-parse --show-toplevel)"
  echo "tree state: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') modified/untracked path(s)"
  echo "date:       $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "build id:   $(cat "$repo/.next/BUILD_ID")"
}

# half NAME WANT_RC PATTERN -- command...
half() {
  local name=$1 want=$2 pattern=$3
  shift 3
  [ "$1" = "--" ] && shift
  local out="$evidence/$name.txt"
  local rc=0
  {
    echo "\$ $*"
    echo
  } > "$out"
  # `|| rc=$?`, never `if ! cmd`: inside a negated condition $? is the status of
  # the negation, so every failing case would read as a pass.
  "$@" >> "$out" 2>&1 || rc=$?
  printf '\n[exit %s]\n' "$rc" >> "$out"
  # REPRODUCIBLE TRANSCRIPTS. Without this, a clean re-run rewrote 95 of these
  # files with the checkout's absolute path, wall-clock durations and
  # Playwright's parallel completion order — so `git status` after the demos
  # told a verifier nothing, and the committed evidence carried a home
  # directory. The normaliser touches only those three things; it cannot reach
  # any string a half asserts on. See scripts/e2e/normalise-transcript.mjs.
  node "$repo/scripts/e2e/normalise-transcript.mjs" "$out" "$repo"

  if [ "$rc" -ne "$want" ]; then
    echo "FAIL $name: exit $rc, wanted $want — see $out"
    fail=$((fail + 1))
    return 0
  fi
  if ! grep -Fq -- "$pattern" "$out"; then
    echo "FAIL $name: transcript does not contain '$pattern' — see $out"
    fail=$((fail + 1))
    return 0
  fi
  echo "ok   $name (exit $rc, matched '$pattern') -> $out"
  pass=$((pass + 1))
}

demos() {
  E2E_BASE_URL="$prod_url" npx playwright test --config playwright.demos.config.ts --project="$project" "$@"
}

# --- D1 console.error ------------------------------------------------------
log "D1 — a console.error fails the lane"
half d1-console-error-RED 1 "browser error(s) that no allow-list entry covers" \
  -- demos e2e/demos/console-error.demo.ts --grep "RED"
half d1-console-error-GREEN 0 "1 passed" \
  -- demos e2e/demos/console-error.demo.ts --grep "GREEN"

# --- D2 a 404 sub-resource -------------------------------------------------
log "D2 — a resource returning 404 fails the lane"
half d2-failed-request-RED 1 "http 404" \
  -- demos e2e/demos/failed-request.demo.ts --grep "RED"
half d2-failed-request-GREEN 0 "1 passed" \
  -- demos e2e/demos/failed-request.demo.ts --grep "GREEN"

# --- D3 an uncaught exception ----------------------------------------------
log "D3 — an uncaught exception fails the lane"
half d3-uncaught-exception-RED 1 "pageerror" \
  -- demos e2e/demos/uncaught-exception.demo.ts --grep "RED"
half d3-uncaught-exception-GREEN 0 "1 passed" \
  -- demos e2e/demos/uncaught-exception.demo.ts --grep "GREEN"

# --- D3b a request that never completes ------------------------------------
# The FOURTH guarded kind. It had no fixture, and an independent verifier
# measured the consequence: the `requestfailed` listener could be deleted from
# the guard and the canary stayed green (D12d).
log "D3b — a request that never completes fails the lane"
half d3b-aborted-request-RED 1 "requestfailed" \
  -- demos e2e/demos/aborted-request.demo.ts --grep "RED"
half d3b-aborted-request-GREEN 0 "1 passed" \
  -- demos e2e/demos/aborted-request.demo.ts --grep "GREEN"

# --- D4a zero tests collected ----------------------------------------------
# A filter that matches nothing. Playwright's own exit code answers "did
# anything fail"; the coverage floor answers "did anything run".
log "D4a — zero tests collected"
half d4a-zero-tests-RED 1 "did not satisfy its coverage floor" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test --grep "__no_test_matches_this__"
half d4a-zero-tests-GREEN 0 "e2e coverage floor: OK" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test

# --- D4b a project is missing ----------------------------------------------
# A configuration with the mobile project removed — the exact edit a pull
# request could make while looking like tidy-up.
log "D4b — a required project is missing from the configuration"
cat > "$repo/playwright.config.missing-project.ts" <<'MUTANT'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
// The controlled mutation for D4b: the 390 px mobile project is removed.
import base from "./playwright.config";

export default {
  ...base,
  projects: (base.projects ?? []).filter((p) => p.name !== "mobile-chromium-390"),
};
MUTANT
half d4b-missing-project-RED 1 "is not in the resolved Playwright configuration" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test --config playwright.config.missing-project.ts
rm -f "$repo/playwright.config.missing-project.ts"
half d4b-missing-project-GREEN 0 "e2e coverage floor: OK" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test

# --- D4c the floor is a floor, not a report -------------------------------
# The minima were 1 per project, so the green line "coverage floor: OK
# (desktop=9 mobile=9)" REPORTED what ran rather than enforcing anything: an
# independent verifier ran one test per project and got exit 0. The minima now
# equal today's counts (e2e/harness/required-projects.json), so ATTRITION is
# caught, not just wholesale vacuity.
log "D4c — deleting one test drops a project below its floor"
health_spec="$repo/e2e/specs/health.spec.ts"
cp "$health_spec" "$evidence/.health.spec.ts.bak"
# Delete exactly one test: from its title line to the first following line that
# is exactly `  });`.
sed '/test("reports liveness for vizra-user"/,/^  });$/d' \
  "$evidence/.health.spec.ts.bak" > "$health_spec"
half d4c-floor-shortfall-RED 1 "the floor is 9" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test
cp "$evidence/.health.spec.ts.bak" "$health_spec"
rm -f "$evidence/.health.spec.ts.bak"
half d4c-floor-shortfall-GREEN 0 "e2e coverage floor: OK" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test

# A floor is a MINIMUM, not an equality: adding a test must not fail it.
log "D4c2 — adding a test without raising the floor stays green"
cat > "$repo/e2e/specs/__extra.spec.ts" <<'EXTRA'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
import { expect, test } from "../harness/test";

test("an added test raises the count without failing the floor", async ({ page }) => {
  await page.goto("/health");
  await expect(page.getByTestId("health-service")).toHaveText("vizra-user");
});
EXTRA
half d4c2-floor-is-a-minimum-GREEN 0 "desktop-chromium-1440=10/9" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test
rm -f "$repo/e2e/specs/__extra.spec.ts"

# --- D4d the lane refuses a filtered run ----------------------------------
# Any filter can select a subset that happens to clear the floor. The verifier's
# exact command is used.
log "D4d — the lane refuses a filtered run"
half d4d-filtered-run-RED 1 "the run was FILTERED" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test --grep "reports liveness"
half d4d-filtered-run-GREEN 0 "e2e coverage floor: OK" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test

# --- D5 pointed at a dev server --------------------------------------------
log "D5 — pointed at a development server instead of the production build"
INTERNAL_API_BASE_URL=http://api.sentinel.invalid:8080 \
  PUBLIC_ORIGIN="http://127.0.0.1:$dev_port" \
  NEXT_TELEMETRY_DISABLED=1 \
  npx next dev --port "$dev_port" > "$evidence/server-development.log" 2>&1 &
started="$started $!"
wait_for "http://127.0.0.1:$dev_port/health" "the development server"

# Both projects, so the coverage floor is satisfied on the green half and the
# only difference between the two runs is WHICH SERVER answers.
# These two run ONE spec file, which is a filter, so they set
# E2E_COVERAGE_FLOOR=off — the lane never does (scripts/ci/check-e2e-lane.sh
# fails if the workflow tries). The only difference between the halves is which
# server answers.
half d5-dev-server-RED 1 "this is not a production build" \
  -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="http://127.0.0.1:$dev_port" \
  npx playwright test e2e/specs/production-build.spec.ts
half d5-dev-server-GREEN 0 "4 passed" \
  -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" \
  npx playwright test e2e/specs/production-build.spec.ts

# --- D6 the harness must not be inside the shipped image -------------------
# The claim "the fixtures cannot ship" has to be tested like any other claim.
# GREEN: the real image. RED: an image deliberately built with the harness
# copied in — which is what a wrong `.dockerignore` or one extra COPY would do.
log "D6 — the built image contains no harness file and no fixture token"
if ! command -v docker > /dev/null 2>&1 || ! docker info > /dev/null 2>&1; then
  echo "BLOCKED d6: docker is not available on this machine. This demonstration did not run."
  echo "  (AGENTS.md: a missing dependency is BLOCKED, never a pass.)"
  blocked=$((blocked + 1))
else
  image=${DEMO_IMAGE:-vizra-user:demonstrate}
  mutant_image=${DEMO_MUTANT_IMAGE:-vizra-user:demonstrate-with-fixtures}
  docker build --tag "$image" "$repo" > "$evidence/d6-image-build.log" 2>&1
  half d6-image-fixtures-GREEN 0 "contains no browser-harness path and no fixture token" \
    -- bash scripts/ci/check-no-test-fixtures-in-image.sh "$image"

  # The controlled mutation. A per-Dockerfile ignore file is used so the
  # mutation really can copy what `.dockerignore` normally excludes — otherwise
  # the build would fail and prove nothing about the guard.
  cat > "$repo/Dockerfile.fixtures-mutant" <<MUTANT
# GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
# The controlled mutation for D6: the browser harness is copied into the image.
FROM $image
COPY e2e ./e2e
MUTANT
  printf 'node_modules\n.next\n.git\ntest-results\nplaywright-report\n' \
    > "$repo/Dockerfile.fixtures-mutant.dockerignore"
  docker build --file "$repo/Dockerfile.fixtures-mutant" --tag "$mutant_image" "$repo" \
    > "$evidence/d6-mutant-build.log" 2>&1
  half d6-image-fixtures-RED 1 "contains browser-harness files" \
    -- bash scripts/ci/check-no-test-fixtures-in-image.sh "$mutant_image"
  docker rmi --force "$mutant_image" > /dev/null 2>&1 || true
  rm -f "$repo/Dockerfile.fixtures-mutant" "$repo/Dockerfile.fixtures-mutant.dockerignore"
fi

# --- D7 the lane guard notices a weakened workflow -------------------------
# scripts/ci/check-e2e-lane.sh asserts the properties a green run cannot show.
# The mutation removes the artifact upload — the change that would make every
# future red lane undiagnosable, and that no test would otherwise catch.
log "D7 — a weakened e2e workflow fails the lane guard"
half d7-lane-guard-GREEN 0 "still drives the built image" \
  -- bash scripts/ci/check-e2e-lane.sh .github/workflows/e2e.yml

# The mutation the OLD grep-based guard missed, and the three beside it. A
# verifier deleted the lane step, echo-replaced it and disabled the job, and the
# guard printed OK for all three; the `e2e` check then concluded success with no
# browser opened.
mutant="$evidence/e2e-mutant.yml"

sed '/^        run: npm run e2e$/d' .github/workflows/e2e.yml > "$mutant"
half d7-lane-step-deleted-RED 1 "no step runs the browser lane" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed 's|^        run: npm run e2e$|        run: echo skipping|' .github/workflows/e2e.yml > "$mutant"
half d7-lane-step-echoed-RED 1 "no step runs the browser lane" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed 's|^        run: npm run e2e$|        run: npm run e2e \|\| true|' .github/workflows/e2e.yml > "$mutant"
half d7-lane-step-or-true-RED 1 "launders the exit code" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed 's|^      - name: Browser lane (desktop 1440, mobile 390)$|      - name: Browser lane (desktop 1440, mobile 390)\n        if: false|' \
  .github/workflows/e2e.yml > "$mutant"
half d7-lane-step-if-false-RED 1 "must run unconditionally" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

grep -v 'upload-artifact' .github/workflows/e2e.yml > "$mutant"
half d7-lane-guard-artifacts-RED 1 "no step uploads artifacts" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed 's|^          if-no-files-found: error$|          if-no-files-found: warn|' \
  .github/workflows/e2e.yml > "$mutant"
half d7-lane-guard-warn-RED 1 "if-no-files-found: error" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed '/run: node scripts\/ci\/check-coverage-floor-ran.mjs/d' .github/workflows/e2e.yml > "$mutant"
half d7-floor-step-removed-RED 1 "check-coverage-floor-ran.mjs" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

# The fail-open the redact/upload pair had. `failure()` is true when ANY earlier
# step failed, so two bare `if: failure()` steps are not a sequence: a redactor
# that exits non-zero — exit 2 on a missing perl/unzip/zip, exit 1 on a repack
# failure — satisfies its own condition and the UNREDACTED tree is published.
sed "s|^        if: failure() && steps.redact.outcome == 'success'\$|        if: failure()|" \
  .github/workflows/e2e.yml > "$mutant"
half d7-upload-not-gated-RED 1 "not gated on the redaction having SUCCEEDED" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed "s|steps.redact.outcome == 'success'|steps.redact.conclusion != 'skipped'|" \
  .github/workflows/e2e.yml > "$mutant"
half d7-upload-gated-on-ran-not-succeeded-RED 1 "not gated on the redaction having SUCCEEDED" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed '/^        id: redact$/d' .github/workflows/e2e.yml > "$mutant"
half d7-redact-step-has-no-id-RED 1 "no \`id:\`" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed 's|^        id: redact$|        id: redact\n        continue-on-error: true|' \
  .github/workflows/e2e.yml > "$mutant"
half d7-redact-continue-on-error-RED 1 "redaction step sets" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

# --- D7b the parser answers for the WHOLE JOB, not the first upload step ----
# The parser used `steps.find(...)` for the upload, so it asserted the gate on
# exactly one step. A verifier appended a SECOND `actions/upload-artifact` step
# on a bare `if: failure()`, publishing the same two directories, and the parser
# printed OK. When the redactor FAILS the gated upload is skipped and the
# ungated one publishes the UNREDACTED tree — the same fail-open the gate closed
# for the first step. `.find` is now `.filter`.
cp .github/workflows/e2e.yml "$mutant"
cat >> "$mutant" <<'SECOND_UPLOAD'

      - name: Upload Playwright artifacts (second, ungated)
        if: failure()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: playwright-artifacts-second
          path: |
            playwright-report/
            test-results/
          retention-days: 14
          if-no-files-found: error
SECOND_UPLOAD
half d7b-second-ungated-upload-RED 1 "not gated on the redaction having SUCCEEDED" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

# The same, with a DIFFERENT uploader action. The old check keyed on the exact
# name `actions/upload-artifact@`, so any other action that publishes artifacts
# was invisible to it rather than refused.
cp .github/workflows/e2e.yml "$mutant"
cat >> "$mutant" <<'OTHER_UPLOADER'

      - name: Publish with some other uploader
        if: failure()
        uses: some-org/artifact-publisher@0000000000000000000000000000000000000000 # v1
        with:
          name: playwright-artifacts-elsewhere
          path: test-results/
OTHER_UPLOADER
half d7b-other-uploader-ungated-RED 1 "not gated on the redaction having SUCCEEDED" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

# And the control: a second upload step that IS correctly gated passes, so the
# check refuses the ungated step rather than refusing a second step as such.
cp .github/workflows/e2e.yml "$mutant"
cat >> "$mutant" <<'SECOND_GATED'

      - name: Upload Playwright artifacts (second, correctly gated)
        if: failure() && steps.redact.outcome == 'success'
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: playwright-artifacts-second
          path: |
            playwright-report/
            test-results/
          retention-days: 14
          if-no-files-found: error
SECOND_GATED
half d7b-second-gated-upload-GREEN 0 "still drives the built image" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

# --- D7c the canary step itself must be present and unconditional ----------
# The canary is the only CI step that would notice the browser-error guard being
# switched off while its identifiers stayed in place. Deleting it, or making it
# conditional, or laundering its exit code, must each be a named red.
sed '/run: node scripts\/ci\/harness-canary.mjs/d' .github/workflows/e2e.yml > "$mutant"
half d7c-canary-step-deleted-RED 1 "harness-canary.mjs" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed 's|^      - name: The harness still fails a broken page (canary)$|      - name: The harness still fails a broken page (canary)\n        if: false|' \
  .github/workflows/e2e.yml > "$mutant"
half d7c-canary-step-if-false-RED 1 "harness-canary step carries an" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

sed 's|^        run: node scripts/ci/harness-canary.mjs$|        continue-on-error: true\n        run: node scripts/ci/harness-canary.mjs|' \
  .github/workflows/e2e.yml > "$mutant"
half d7c-canary-continue-on-error-RED 1 "harness-canary step sets" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

# The per-run stamp key must be minted per run, never pinned by the workflow.
sed 's|^          E2E_BASE_URL: http://127.0.0.1:3000$|          E2E_BASE_URL: http://127.0.0.1:3000\n          VIZRA_E2E_STAMP_KEY: deadbeef|' \
  .github/workflows/e2e.yml > "$mutant"
half d7c-stamp-key-pinned-RED 1 "VIZRA_E2E_STAMP_KEY" \
  -- bash scripts/ci/check-e2e-lane.sh "$mutant"

rm -f "$mutant"

# --- D8 a spec that bypasses the guard fails the cheap lane ----------------
# The shortest path past the browser-error guard is `import { test } from
# "@playwright/test"` in a spec. It compiles, runs and passes — and is exempt.
# e2e/harness/browser-errors.test.ts refuses it, in `npm run test`.
log "D8 — a spec reaching Playwright's unguarded test fails the gate"
half d8-guard-GREEN 0 "no unguarded import" \
  -- bash -c 'npx eslint e2e && echo "OK: no unguarded import anywhere under e2e/"'

# The bodies below are the verifier's: the page 404s and throws an uncaught
# error on EVERY load. With the old regex guard, (a) and (b) gave `npm run ci`
# exit 0 and `npm run e2e` exit 0 — "20 passed, coverage floor: OK".
bypass="$repo/e2e/specs/__bypass.spec.ts"

write_bypass() {
  # $1 = the import line(s); the body is identical every time, so the ONLY
  # variable is how the unguarded `test` was reached.
  {
    printf '// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.\n'
    printf '%s\n' "$1"
    cat <<'BODY'

test("a page that 404s and throws, with the guard bypassed", async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.addEventListener("DOMContentLoaded", () => {
      const img = new Image();
      img.src = "/VERIFIER_EV3_MISSING.png";
      document.body.appendChild(img);
      setTimeout(() => {
        throw new Error("VERIFIER_EV3_UNCAUGHT");
      }, 0);
    });
  });
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
});
BODY
  } > "$bypass"
}

# (a) the verifier's namespace spelling, verbatim
write_bypass 'import * as pw from "@playwright/test";
const { test, expect } = pw;'
half d8-bypass-namespace-RED 1 "must not reference" -- npx eslint "$bypass"

# (b) the verifier's single-quote spelling, verbatim
write_bypass "import { expect, test } from '@playwright/test';"
half d8-bypass-single-quotes-RED 1 "must not reference" -- npx eslint "$bypass"

# (c) a dynamic import, which no import-statement pattern can see
write_bypass 'const pw = await import("@playwright/test");
const { test, expect } = pw;'
half d8-bypass-dynamic-import-RED 1 "must not reference" -- npx eslint "$bypass"

# (d) require()
write_bypass 'const { test, expect } = require("@playwright/test");'
half d8-bypass-require-RED 1 "must not reference" -- npx eslint "$bypass"

# (e) a local shim that re-exports the raw binding — the spec's own import line
#     names no forbidden module at all. Both halves of the rule fire: the shim
#     is refused for naming the package, and the spec for taking `test` from
#     something that is not the harness entry.
cat > "$repo/e2e/specs/__shim.ts" <<'SHIM'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
export { expect, test } from "@playwright/test";
SHIM
write_bypass 'import { expect, test } from "./__shim";'
half d8-bypass-reexport-shim-RED 1 "harness entry" -- npx eslint "$bypass" "$repo/e2e/specs/__shim.ts"
rm -f "$repo/e2e/specs/__shim.ts"

# (f) the verifier's SECOND bypass: one inline comment. This bought a complete
#     exemption — `npm run ci` 0, the full lane 0 with "20 passed, floor OK",
#     both floor checks 0, the lane guard 0 — on a page that 404s and throws.
#     `linterOptions: { noInlineConfig: true }` turns off every comment form at
#     once, so all four spellings below are inert.
write_bypass '/* eslint-disable vizra/no-unguarded-playwright-import */
import { expect, test } from "../harness/test";
import { test as raw } from "@playwright/test";
void raw;'
half d8-bypass-eslint-disable-RED 1 "must not reference" -- npx eslint "$bypass"

write_bypass '/* eslint-disable */
import { expect, test } from "../harness/test";
import { test as raw } from "@playwright/test";
void raw;'
half d8-bypass-eslint-disable-all-RED 1 "must not reference" -- npx eslint "$bypass"

write_bypass 'import { expect, test } from "../harness/test";
// eslint-disable-next-line vizra/no-unguarded-playwright-import
import { test as raw } from "@playwright/test";
void raw;'
half d8-bypass-disable-next-line-RED 1 "must not reference" -- npx eslint "$bypass"

write_bypass '/* eslint vizra/no-unguarded-playwright-import: "off" */
import { expect, test } from "../harness/test";
import { test as raw } from "@playwright/test";
void raw;'
half d8-bypass-inline-severity-RED 1 "must not reference" -- npx eslint "$bypass"

# (g) the UNSCOPED package, which re-exports the same runner. It used to pass
#     lint and RUN; it failed the lane only because loading a second runner copy
#     breaks the real tests, which is a module-loading accident, not a control.
write_bypass 'import * as pw from "playwright/test";
const { test, expect } = pw;'
half d8-bypass-unscoped-package-RED 1 "must not reference" -- npx eslint "$bypass"

# The whole gate, not just the lint step: the namespace spelling must now stop
# `npm run ci`, which is what went green on a broken page before.
write_bypass 'import * as pw from "@playwright/test";
const { test, expect } = pw;'
half d8-bypass-fails-the-gate-RED 1 "no-unguarded-playwright-import" -- npm run lint
rm -f "$bypass"

# And the exact exploit, through the whole gate: `npm run ci` must now be red.
write_bypass '/* eslint-disable vizra/no-unguarded-playwright-import */
import { expect, test } from "../harness/test";
import { test as raw } from "@playwright/test";
void raw;'
half d8-eslint-disable-fails-npm-run-ci-RED 1 "no-unguarded-playwright-import" -- npm run ci
rm -f "$bypass"

# And the same spec body, with the import corrected to the harness entry, is
# caught by the browser-error guard at RUN time — the second line of defence.
write_bypass 'import { expect, test } from "../harness/test";'
half d8-guarded-import-catches-the-page-RED 1 "pageerror" \
  -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" npx playwright test "$bypass"
rm -f "$bypass"

half d8-tree-is-clean-GREEN 0 "no unguarded import" \
  -- bash -c 'npx eslint e2e && echo "OK: no unguarded import anywhere under e2e/"'

# --- D9 a signed URL must not survive into an uploaded artifact -------------
# `e2e/harness/redact.ts` covers what the HARNESS prints. Playwright's trace is
# written by the browser driver before any harness code sees it, and a verifier
# found a `?X-Amz-Signature=…` value verbatim inside trace.zip members
# `1-trace.network` and `1-trace.trace` while every harness line showed it
# redacted — in an archive the workflow uploads for 14 days.
#
# The RED half is load-bearing: if the sentinel were NOT in the raw artifacts,
# the green half would be proving nothing.
log "D9 — a signed-URL-shaped query string does not reach an uploaded artifact"
sentinel="SENTINEL-SIGNATURE-DO-NOT-SHIP"
readable="__vizra_e2e_fixture__/media/photo.jpg"

rm -rf "$repo/test-results"
E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" \
  npx playwright test --config playwright.demos.config.ts --project="$project" \
  e2e/demos/signed-url-artifact.demo.ts > "$evidence/d9-failing-run.log" 2>&1 || true

half d9-artifact-leak-RED 1 "members containing the sentinel:" \
  -- bash scripts/e2e/sweep-artifacts.sh "$sentinel" "$repo/test-results" "$readable"

half d9-redaction-runs-GREEN 0 "redacted URL query strings" \
  -- bash scripts/ci/redact-artifacts.sh test-results

half d9-artifact-redacted-GREEN 0 "members containing the sentinel: 0" \
  -- bash scripts/e2e/sweep-artifacts.sh "$sentinel" "$repo/test-results" "$readable"

# --- D10 no spec authenticates until the artifact-privacy slice lands -------
# The redactor covers query strings, fragments and Location. It does NOT cover
# Authorization/Cookie/Set-Cookie headers, bodies, console tokens, DOM
# snapshots, or Playwright call parameters — the `page.fill` channel a login
# spec uses. Nothing leaks today only because nothing here authenticates; that
# is an accident of scope, so it is asserted.
log "D10 — a spec that handles a credential fails the cheap lane"
half d10-no-credentials-GREEN 0 "passed" \
  -- npx vitest run e2e/harness/no-credentials-in-specs.test.ts

cat > "$repo/e2e/specs/__cred.spec.ts" <<'CRED'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
import { expect, test } from "../harness/test";

test("a login-shaped spec", async ({ page }) => {
  await page.goto("/");
  await page.fill("#password", "hunter2");
  await expect(page.locator("h1")).toBeVisible();
});
CRED
half d10-credential-spec-RED 1 "appears to handle a credential" \
  -- npx vitest run e2e/harness/no-credentials-in-specs.test.ts
rm -f "$repo/e2e/specs/__cred.spec.ts"

# --- D11 THE RUNTIME PROOF OF HARNESS --------------------------------------
# Three verification rounds found three different ways for a spec to reach
# Playwright's unguarded `test` and go green on a page that 404s and throws:
# a namespace import (the regex missed it), an `eslint-disable` comment, and a
# spec in `e2e/other/` (collected by Playwright, covered by no lint glob). Each
# was patched where it was found, and the guarantee still rested on LINT.
#
# It no longer does. `e2e/harness/test.ts` stamps every test it runs with an
# HMAC over that test's identity, under a per-run key a spec cannot read, and
# two checks refuse a run in which a test SUCCEEDED without a valid stamp.
# EVERY half below runs Playwright DIRECTLY — no ESLint anywhere in the command —
# so what is demonstrated is the runtime, not the lint.
log "D11 — a spec that bypasses the harness is RED at runtime, whatever lint thinks"

stamp_spec="$repo/e2e/specs/__stamp.spec.ts"

write_stamp_spec() {
  # $1 = the lines that obtain `test`; the body is identical every time, so the
  # only variable is how the harness was avoided. The page 404s a sub-resource
  # and throws an uncaught error on every load, exactly as in D8.
  {
    printf '// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.\n'
    printf '%s\n' "$1"
    cat <<'BODY'

test("a page that 404s and throws, with the harness bypassed", async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.addEventListener("DOMContentLoaded", () => {
      const img = new Image();
      img.src = "/VERIFIER_EV3_MISSING.png";
      document.body.appendChild(img);
      setTimeout(() => {
        throw new Error("VERIFIER_EV3_UNCAUGHT");
      }, 0);
    });
  });
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
});
BODY
  } > "$stamp_spec"
}

# --- D11a door 1: the namespace import, verbatim ---------------------------
write_stamp_spec 'import * as pw from "@playwright/test";
const { test, expect } = pw;'
half d11a-namespace-import-RED 1 "succeeded WITHOUT the harness stamp" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test

# --- D11b door 2: one inline eslint-disable, with noInlineConfig REMOVED ----
# `linterOptions: { noInlineConfig: true }` now covers everything under `e2e/`
# except the harness, so the comment no longer works — which would make this
# demonstration prove the lint fix rather than the runtime one. So lint is
# DELIBERATELY DEFEATED first, with a controlled mutation of eslint.config.mjs
# that drops `linterOptions`: the GREEN half proves ESLint really does let the
# file through in that configuration, and the RED half proves the runtime
# catches it anyway. That is the whole claim — the guarantee no longer depends
# on lint.
cat > "$repo/eslint.config.no-inline-config.mjs" <<'NOINLINE'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
// The controlled mutation for D11b: the repository's real configuration with
// `linterOptions` (and therefore `noInlineConfig`) stripped from every block,
// so an inline `eslint-disable` comment works again.
import base from "./eslint.config.mjs";

export default base.map((entry) => {
  if (!entry || typeof entry !== "object") return entry;
  const { linterOptions: _dropped, ...rest } = entry;
  return rest;
});
NOINLINE

write_stamp_spec '/* eslint-disable vizra/no-unguarded-playwright-import */
import * as pw from "@playwright/test";
const { test, expect } = pw;'
half d11b-lint-defeated-GREEN 0 "the disable comment WORKED" \
  -- bash -c 'npx eslint --config eslint.config.no-inline-config.mjs e2e/specs/__stamp.spec.ts \
    && echo "OK: the disable comment WORKED — ESLint reports no problem for this file"'
half d11b-eslint-disable-RED 1 "succeeded WITHOUT the harness stamp" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test
rm -f "$repo/eslint.config.no-inline-config.mjs"

# --- D11c door 3: a spec outside e2e/specs ---------------------------------
# Closed twice over. At COLLECTION: `testDir` is `./e2e/specs`, so the file is
# not collected at all — the lane still lists exactly its own 18 tests. At LINT:
# the glob is `e2e/**` minus the harness, so the file is refused if anyone
# writes one. Neither is the guarantee; the guarantee is that were it collected,
# it would be unstamped.
rm -f "$stamp_spec"
mkdir -p "$repo/e2e/other"
cat > "$repo/e2e/other/__r1.spec.ts" <<'OUTSIDE'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
import { test } from "@playwright/test";

test("R1", async ({ page }) => {
  await page.goto("/");
});
OUTSIDE
half d11c-outside-not-collected-GREEN 0 "Total: 18 tests in 3 files" \
  -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" npx playwright test --list
half d11c-outside-refused-by-lint-RED 1 "must not reference" \
  -- npx eslint "$repo/e2e/other/__r1.spec.ts"
rm -rf "$repo/e2e/other"

# --- D11d a door the verifier has not tried: forge the stamp ---------------
# The spec imports the sealed module that holds the key and signs itself. The
# key is claimed ONCE per worker, by `e2e/harness/test.ts`, while
# playwright.config.ts is being loaded — before any test file exists in that
# worker. So the forger's own call is the SECOND claim, and it throws.
write_stamp_spec 'import * as pw from "@playwright/test";
import { claimSigner, specPath, STAMP_ANNOTATION } from "../harness/stamp";
const { test, expect } = pw;
test.beforeEach(async ({}, testInfo) => {
  const sign = claimSigner();
  testInfo.annotations.push({
    type: STAMP_ANNOTATION,
    description: sign({
      project: testInfo.project.name,
      file: specPath(testInfo.config.rootDir, testInfo.file),
      title: testInfo.title,
      workerIndex: testInfo.workerIndex,
      retry: testInfo.retry,
    }),
  });
});'
half d11d-forge-via-sealed-module-RED 1 "already been claimed in this worker" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test

# --- D11e a second door the verifier has not tried: read the key from env ---
# The key reaches workers through the environment, and the harness DELETES it
# from `process.env` while the configuration is loading, before any test file is
# evaluated. The spec below asserts the variable is `undefined` — so the RED
# transcript shows both halves at once: the assertion PASSES (the key is gone)
# and the run still fails, because the stamp the spec forged from `undefined`
# does not verify.
write_stamp_spec 'import * as pw from "@playwright/test";
const { test, expect } = pw;
test.beforeEach(async ({}, testInfo) => {
  const key = process.env.VIZRA_E2E_STAMP_KEY;
  expect(key, "the stamp key must not be readable from a spec").toBeUndefined();
  testInfo.annotations.push({
    type: "vizra-harness-stamp",
    description: String(key),
  });
});'
half d11e-forge-via-environment-RED 1 "does not verify against this run" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test

# --- D11f the OUT-OF-PROCESS half, with the in-process reporter deleted -----
# `playwright.config.ts` is editable by the pull request being gated, so the
# stamp reporter can be deleted from the `reporter` array — one line, no other
# visible effect. `scripts/ci/check-coverage-floor-ran.mjs` re-reads the
# finished JSON report, and the key file the reporter would have written is then
# absent (or holds an earlier run's key, since every run mints a fresh one), so
# it fails CLOSED.
cat > "$repo/playwright.config.no-stamp-reporter.ts" <<'NOSTAMP'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
// The controlled mutation for D11f: the stamp reporter is removed from the
// reporter array, which is the one-line edit the gated pull request could make.
import base from "./playwright.config";

export default {
  ...base,
  reporter: (base.reporter ?? []).filter(
    (entry) => !String(entry[0]).includes("stamp-reporter"),
  ),
};
NOSTAMP

write_stamp_spec 'import * as pw from "@playwright/test";
const { test, expect } = pw;'
rm -rf "$repo/.vizra-e2e"
# The run itself is green: with the reporter gone, nothing inside Playwright
# objects. That is the point of the mutation.
half d11f-in-process-reporter-deleted-GREEN 0 "20 passed" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test --config playwright.config.no-stamp-reporter.ts
half d11f-out-of-process-still-RED 1 "did not prove anything" \
  -- node scripts/ci/check-coverage-floor-ran.mjs
rm -f "$repo/playwright.config.no-stamp-reporter.ts" "$stamp_spec"

# And with the reporter restored and no bypass, both halves are green again.
half d11-clean-tree-lane-GREEN 0 "e2e harness stamp: OK" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test
half d11-clean-tree-out-of-process-GREEN 0 "carried a valid harness stamp" \
  -- node scripts/ci/check-coverage-floor-ran.mjs

# --- D12 THE CANARY: the guard itself, self-tested in the lane -------------
# The verifier recorded this case as ACCEPTED-BY-DESIGN and silent: neutering
# `e2e/harness/browser-errors.ts` while leaving its identifiers in place passes
# `npm run test`, passes `check-e2e-lane.sh` (its harness check is
# string-presence only) and passes the lane itself, because a guard that has
# stopped looking finds nothing to fail on. `npm run e2e:demos` would catch it —
# and is not a CI lane.
#
# `scripts/ci/harness-canary.mjs` runs the three fault-injection fixtures inside
# the required `e2e` lane and requires each to fail for its OWN named reason.
# Each listener is neutered one at a time below, and each makes the lane red.
log "D12 — neutering the guard's listeners turns the required lane red"
guard_file="$repo/e2e/harness/browser-errors.ts"
cp "$guard_file" "$repo/.browser-errors.ts.bak"
digest "D12 browser-errors.ts BEFORE" "$guard_file"

half d12-canary-GREEN 0 "failed all 4 fault-injection fixtures" \
  -- env E2E_BASE_URL="$prod_url" node scripts/ci/harness-canary.mjs

# The mutations remove ONE listener registration at a time, from the
# BrowserContext the guard attaches to. The handler stays defined (`void
# onConsole;` keeps it referenced) so the file still compiles and every
# identifier the lane guard greps for is still present — which is the point:
# this is the mutation that every other check in CI is blind to.

# (a) the console listener is never registered. The console-error fixture then
#     passes, so the canary sees the wrong failure count for that fixture.
sed 's|context.on("console", onConsole);|void onConsole;|' \
  "$repo/.browser-errors.ts.bak" > "$guard_file"
half d12-console-listener-neutered-RED 1 "console-error.demo.ts" \
  -- env E2E_BASE_URL="$prod_url" node scripts/ci/harness-canary.mjs

# (b) the page-error listener is never registered. `weberror` is the
#     BrowserContext spelling of the page-level `pageerror`.
sed 's|context.on("weberror", onWebError);|void onWebError;|' \
  "$repo/.browser-errors.ts.bak" > "$guard_file"
half d12-pageerror-listener-neutered-RED 1 "uncaught-exception.demo.ts" \
  -- env E2E_BASE_URL="$prod_url" node scripts/ci/harness-canary.mjs

# (c) the response listener is never registered. This one is the sharpest: the
#     404 ALSO produces a console error, so the fixture still FAILS — just not
#     for its own reason. A canary that only counted failures would pass here;
#     this one requires the named diagnostic `http 404`, and goes red.
sed 's|context.on("response", onResponse);|void onResponse;|' \
  "$repo/.browser-errors.ts.bak" > "$guard_file"
half d12-response-listener-neutered-RED 1 "http 404" \
  -- env E2E_BASE_URL="$prod_url" node scripts/ci/harness-canary.mjs

# (d) the requestfailed listener is never registered. THIS WAS THE HOLE. An
#     independent verifier measured this same mutation leaving the canary GREEN
#     — the transcript is kept at
#     docs/evidence/VZ-FOUND-008/d12-requestfailed-listener-neutered-GREEN.txt
#     as the record of the defect — because none of the three fixtures produced
#     a `requestfailed` record: a 404 is a COMPLETED response, not a failed
#     request. `e2e/demos/aborted-request.demo.ts` is the fourth fixture, and
#     this mutation is now RED by name.
sed 's|context.on("requestfailed", onRequestFailed);|void onRequestFailed;|' \
  "$repo/.browser-errors.ts.bak" > "$guard_file"
half d12d-requestfailed-listener-neutered-RED 1 "aborted-request.demo.ts" \
  -- env E2E_BASE_URL="$prod_url" node scripts/ci/harness-canary.mjs

cp "$repo/.browser-errors.ts.bak" "$guard_file"
rm -f "$repo/.browser-errors.ts.bak"
digest "D12 browser-errors.ts RESTORED" "$guard_file"
half d12-canary-restored-GREEN 0 "failed all 4 fault-injection fixtures" \
  -- env E2E_BASE_URL="$prod_url" node scripts/ci/harness-canary.mjs

# (e) a fixture that fails for the WRONG REASON. The first canary required each
#     fixture's diagnostic to appear somewhere in one combined output, and an
#     independent verifier showed that claim was overstated: replacing
#     `console.error(token)` with a 404 sub-resource left the canary GREEN,
#     because Chromium reports the failed load on the console and the harness
#     formats it as `console.error: Failed to load resource…`. The fixture then
#     demonstrated a control nobody had asked it to demonstrate. The canary now
#     runs each fixture alone and asserts the exact SET of record KINDS.
demo_console="$repo/e2e/demos/console-error.demo.ts"
cp "$demo_console" "$repo/.console-error.demo.ts.bak"
digest "D12e console-error.demo.ts BEFORE" "$demo_console"
sed 's|      console.error(token);|      const i = new Image(); i.src = "/__vizra_e2e_fixture__/swapped-" + token + ".png"; document.body.appendChild(i);|' \
  "$repo/.console-error.demo.ts.bak" > "$demo_console"
half d12e-fixture-fault-type-swapped-RED 1 "failed for the WRONG reason" \
  -- env E2E_BASE_URL="$prod_url" node scripts/ci/harness-canary.mjs
cp "$repo/.console-error.demo.ts.bak" "$demo_console"
rm -f "$repo/.console-error.demo.ts.bak"
digest "D12e console-error.demo.ts RESTORED" "$demo_console"
half d12e-fixture-restored-GREEN 0 "exact set of record kinds" \
  -- env E2E_BASE_URL="$prod_url" node scripts/ci/harness-canary.mjs

# --- D13 STAMPED IMPLIES GUARDED -------------------------------------------
# The guard and the stamp used to be two fixtures: an `auto` fixture that
# stamped, and a `page` override that guarded. `test.extend` replaces one
# without the other, and an independent verifier did exactly that — four lines
# of ordinary Playwright, lint-clean, in a normal spec, touching no gate file:
#
#     const test = base.extend({
#       page: async ({ browser }, provide) => {
#         const ctx = await browser.newContext();
#         await provide(await ctx.newPage());
#       },
#     });
#
# On a page that 404s a sub-resource and throws on every load that gave
# `npm run ci` 0, the lane 0 with "20 passed, coverage floor: OK, harness stamp:
# OK (20 verified)", the out-of-process check 0, the canary 0 and the workflow
# parser 0. The stamp proved "this test came from the harness `test` object";
# the claim is "this test ran the guard".
#
# Guarding a second page would only move the hole to a popup or a fresh context,
# so the guard is now attached at the BROWSER, at BrowserContext level, for the
# test's lifetime. Every half below uses the same broken-page body and differs
# only in HOW the page was obtained. Each runs Playwright directly — lint is not
# what is being demonstrated.
log "D13 — the guard is attached at the browser, so every page a test creates is guarded"

guard_spec="$repo/e2e/specs/__guard.spec.ts"

write_guard_spec() {
  # $1 = the whole spec source. Kept as one argument rather than pieced together,
  # because each attack obtains its page differently and the difference IS the
  # demonstration.
  {
    printf '// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.\n'
    printf '%s\n' "$1"
  } > "$guard_spec"
}

# The fault, injected into whichever page the attack produced. Identical every
# time: a sub-resource that 404s and an uncaught exception on every load.
BREAK='await target.addInitScript(() => {
    globalThis.addEventListener("DOMContentLoaded", () => {
      const img = new Image();
      img.src = "/VERIFIER_F6_MISSING.png";
      document.body.appendChild(img);
      setTimeout(() => {
        throw new Error("VERIFIER_F6_UNCAUGHT");
      }, 0);
    });
  });'

guard_half() {
  # guard_half NAME -- the spec source on stdin
  local name=$1
  write_guard_spec "$(cat)"
  half "$name" 1 "browser error(s) that no allow-list entry covers" \
    -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" \
    npx playwright test "$guard_spec" --project="$project" --workers=1
}

# The same, with the diagnostic named at the call site. The F12 routes below do
# not fail on the page's OWN errors — a refused launch never reaches a page —
# so requiring the browser-error message for them would be requiring the wrong
# thing, and a half that matches the wrong string proves nothing.
guard_half_msg() {
  # guard_half_msg NAME PATTERN -- the spec source on stdin
  local name=$1 pattern=$2
  write_guard_spec "$(cat)"
  half "$name" 1 "$pattern" \
    -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" \
    npx playwright test "$guard_spec" --project="$project" --workers=1
}

# (a) THE VERIFIER'S EXPLOIT, VERBATIM.
guard_half d13a-overridden-page-fixture-RED <<EOF
import { test as base, expect } from "../harness/test";

const test = base.extend({
  page: async ({ browser }, provide) => {
    const ctx = await browser.newContext();
    await provide(await ctx.newPage());
  },
});

test("stamped, guard never ran", async ({ page }) => {
  const target = page;
  $BREAK
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (b) a SECOND PAGE in the default context — the page fixture is untouched.
guard_half d13b-second-page-in-default-context-RED <<EOF
import { test, expect } from "../harness/test";

test("a second page in the same context", async ({ page }) => {
  const target = await page.context().newPage();
  $BREAK
  await target.goto("/");
  await target.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (c) a FRESH CONTEXT created inside the test body.
guard_half d13c-browser-newContext-in-body-RED <<EOF
import { test, expect } from "../harness/test";

test("a context the harness never handed out", async ({ page, browser }) => {
  const context = await browser.newContext();
  const target = await context.newPage();
  $BREAK
  await target.goto("/");
  await target.waitForLoadState("networkidle");
  await context.close();
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (d) browser.newPage(), which creates its own context implicitly.
guard_half d13d-browser-newPage-in-body-RED <<EOF
import { test, expect } from "../harness/test";

test("browser.newPage makes its own context", async ({ page, browser }) => {
  const target = await browser.newPage();
  $BREAK
  await target.goto("/");
  await target.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (e) an overridden CONTEXT fixture — one level up from the verifier's attack.
guard_half d13e-overridden-context-fixture-RED <<EOF
import { test as base, expect } from "../harness/test";

const test = base.extend({
  context: async ({ browser }, provide) => {
    const context = await browser.newContext();
    await provide(context);
    await context.close();
  },
});

test("an overridden context fixture", async ({ page }) => {
  const target = page;
  $BREAK
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (e2) an overridden PAGE fixture that NAVIGATES INSIDE ITSELF and never in the
#     body. This is the sharpest ordering case and it decided the fixture's
#     dependency list. With `page` as the ordering dependency the guard was
#     installed after the override had already built its context and navigated,
#     and this spec PASSED on a broken page — measured. With `context` as the
#     ordering dependency the wrapper is installed before `page` is ever built,
#     and the page is still open at assertion time; both properties hold at once.
guard_half d13e2-override-navigates-in-the-fixture-RED <<EOF
import { test as base, expect } from "../harness/test";

const test = base.extend({
  page: async ({ browser }, provide) => {
    const context = await browser.newContext();
    const target = await context.newPage();
    $BREAK
    await target.goto("$prod_url/");
    await target.waitForLoadState("networkidle");
    await provide(target);
    await context.close();
  },
});

test("the body never navigates; the fixture already did", async ({ page }) => {
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (f) a POPUP the page opens itself. No fixture is overridden at all; the page
#     simply produces a second page the harness never saw.
guard_half d13f-popup-window-open-RED <<'EOF'
import { test, expect } from "../harness/test";

test("a popup the page opened itself", async ({ page }) => {
  await page.goto("/");
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.evaluate(() => {
      globalThis.open("/?popup=1", "_blank");
    }),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  await popup.evaluate(() => {
    const img = new Image();
    img.src = "/VERIFIER_F6_MISSING.png";
    document.body.appendChild(img);
    setTimeout(() => {
      throw new Error("VERIFIER_F6_UNCAUGHT");
    }, 0);
  });
  await popup.waitForTimeout(500);
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (g) an overridden BROWSER fixture. The harness fixture takes `browser` as a
#     dependency, so Playwright hands it the spec's browser and that is the one
#     guarded. Note this needs no Playwright import: `playwright` is a built-in
#     fixture, so lint cannot see this one at all — the runtime is the only thing
#     that catches it, which is exactly the point.
guard_half d13g-overridden-browser-fixture-RED <<EOF
import { test as base, expect } from "../harness/test";

const test = base.extend({
  browser: [
    async ({ playwright }, provide) => {
      const browser = await playwright.chromium.launch();
      await provide(browser);
      await browser.close();
    },
    { scope: "worker" },
  ],
});

test("a browser the spec launched through the built-in fixture", async ({ page }) => {
  const target = page;
  $BREAK
  await page.goto("$prod_url/");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# --- F12: the three IMPORT-FREE routes, closed at RUNTIME -------------------
# An independent verifier measured each of these reaching an unguarded page from
# a spec in e2e/specs/ importing ONLY the harness `test`, each passing the
# COMPLETE gate on a page that 404s a sub-resource and throws on every load:
# lint green, lane exit 0 with `20 passed, coverage floor: OK (10/9 10/9),
# harness stamp: OK (20 verified)`, out-of-process check exit 0.
#
#     Object.getPrototypeOf(browser).newContext.call(browser)
#     browser.browserType().launch()
#     playwright.chromium.launchPersistentContext(dir)
#
# None imports a Playwright package, which is why the package bans could not see
# them and why AGENTS.md said "nothing catches these today".
# `e2e/harness/creation-guard.ts` is what changed that, and these halves are the
# proof. The lint rule is the early warning and is demonstrated separately
# below, with the ban switched OFF first so the "lint green" half is real.

# (j) the browser's PROTOTYPE `newContext` — the harness's OWN browser, escaped
#     because the wrapper is an own property. It is now GUARDED rather than
#     merely detected, so the ordinary browser-error diagnostic is what fires;
#     that also means a context created and CLOSED inside the body is caught,
#     which a teardown-only check could never do. This half closes it.
guard_half d13j-prototype-newContext-RED <<EOF
import { test, expect } from "../harness/test";

test("a context made through the browser's prototype, closed before the end", async ({ page, browser }) => {
  const viaPrototype = Object.getPrototypeOf(browser).newContext;
  const context = await viaPrototype.call(browser);
  const target = await context.newPage();
  $BREAK
  await target.goto("/");
  await target.waitForLoadState("networkidle");
  await context.close();
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (k) browser.browserType().launch() — a SECOND BROWSER, which
#     `browser.contexts()` cannot see by construction. Refused at the call site.
guard_half_msg d13k-browserType-launch-RED "was called during a test" <<EOF
import { test, expect } from "../harness/test";

test("a browser the harness was never handed", async ({ page, browser }) => {
  const own = await browser.browserType().launch();
  const target = await own.newPage();
  $BREAK
  await target.goto("$prod_url/");
  await target.waitForLoadState("networkidle");
  await own.close();
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (l) launchPersistentContext — a context on a second browser, through the
#     built-in `playwright` fixture. No import, and no `browser` either.
guard_half_msg d13l-launchPersistentContext-RED "was called during a test" <<EOF
import { test, expect } from "../harness/test";

test("a persistent context the harness was never handed", async ({ page, playwright }) => {
  const context = await playwright.chromium.launchPersistentContext("$repo/.vizra-demo-userdata");
  const target = await context.newPage();
  $BREAK
  await target.goto("$prod_url/");
  await target.waitForLoadState("networkidle");
  await context.close();
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (m) connect / connectOverCDP. Reachable without a server, because the refusal
#     happens BEFORE the call is made — which is the point of refusing rather
#     than detecting: nothing is launched and left behind.
guard_half_msg d13m-connect-and-connectOverCDP-RED "chromium.connectOverCDP" <<'EOF'
import { test, expect } from "../harness/test";

test("connect and connectOverCDP reach a browser nothing is watching", async ({ page, browser }) => {
  await browser.browserType().connect("ws://127.0.0.1:1/x").catch(() => {});
  await browser.browserType().connectOverCDP("http://127.0.0.1:1").catch(() => {});
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (n) THE SWALLOWED REFUSAL. A spec that catches the throw gets no browser, and
#     the attempt is still recorded, so teardown fails it by name. Without this,
#     `try { … } catch {}` would be a one-line opt-out.
guard_half_msg d13n-swallowed-refusal-still-RED "attempt(s) to create a browser or context the harness was never handed" <<'EOF'
import { test, expect } from "../harness/test";

test("swallowing the refusal does not swallow the failure", async ({ page, browser }) => {
  try {
    await browser.browserType().launch();
  } catch {
    // deliberately ignored — the test must fail anyway
  }
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (o) THE THIRD LAYER, demonstrated by cutting the second. With the creation
#     guard's REGISTRATION removed — the prototype patch still delegating, so
#     nothing else changes — a context made through the prototype is watched by
#     nothing, and the teardown catch-all is what names it. This is the layer
#     that covers a creation path nobody has thought of yet, so it is shown
#     working on its own rather than asserted.
cg_file="$repo/e2e/harness/creation-guard.ts"
cp "$cg_file" "$repo/.creation-guard.ts.bak"
digest "D13o creation-guard.ts BEFORE" "$cg_file"
sed 's|      const context = (await originalNewContext.apply(this, args)) as BrowserContext;\n|&|' \
  "$repo/.creation-guard.ts.bak" > "$cg_file"
perl -0pi -e 's/(const context = \(await originalNewContext\.apply\(this, args\)\) as BrowserContext;\n)      active\?\.registerContext\(context\);/$1      void active;/' "$cg_file"
guard_half_msg d13o-registration-cut-teardown-catches-RED "context(s) the harness was never handed are open on this browser" <<EOF
import { test, expect } from "../harness/test";

test("a stray context left open is named at teardown", async ({ page, browser }) => {
  const viaPrototype = Object.getPrototypeOf(browser).newContext;
  const context = await viaPrototype.call(browser);
  const target = await context.newPage();
  $BREAK
  await target.goto("/");
  await target.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
});
EOF
cp "$repo/.creation-guard.ts.bak" "$cg_file"
rm -f "$repo/.creation-guard.ts.bak"
digest "D13o creation-guard.ts RESTORED" "$cg_file"
# Restored: the same spec is now caught by the REGISTRATION instead, with the
# ordinary browser-error diagnostic — both layers, one after the other.
guard_half d13o-registration-restored-RED <<EOF
import { test, expect } from "../harness/test";

test("with registration restored the same context is guarded, not merely detected", async ({ page, browser }) => {
  const viaPrototype = Object.getPrototypeOf(browser).newContext;
  const context = await viaPrototype.call(browser);
  const target = await context.newPage();
  $BREAK
  await target.goto("/");
  await target.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (p) THE LINT EARLY WARNING, red and green. The green half is the point: with
#     the method ban switched off, ESLint passes a spec holding all three
#     routes — which is exactly the state the verifier measured, and the reason
#     the runtime halves above are the control and not the rule.
cat > "$repo/eslint.config.no-banned-methods.mjs" <<'NOBANNED'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
// The controlled mutation for D13p: the repository's real configuration with
// `bannedMethods: []` forced on `vizra/no-unguarded-playwright-import`, i.e.
// the rule as it was before this slice. The three routes then pass lint, which
// is what an independent verifier measured.
import base from "./eslint.config.mjs";

export default base.map((entry) => {
  const configured = entry?.rules?.["vizra/no-unguarded-playwright-import"];
  if (!Array.isArray(configured)) return entry;
  const [severity, options] = configured;
  return {
    ...entry,
    rules: {
      ...entry.rules,
      "vizra/no-unguarded-playwright-import": [
        severity,
        { ...(options ?? {}), bannedMethods: [] },
      ],
    },
  };
});
NOBANNED

write_three_routes() {
  cat > "$guard_spec" <<'ROUTES'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
import { test } from "../harness/test";

test("the three import-free routes", async ({ browser, playwright }) => {
  await Object.getPrototypeOf(browser).newContext.call(browser);
  await browser.browserType().launch();
  await playwright.chromium.launchPersistentContext("/tmp/vizra-x");
});
ROUTES
}

write_three_routes
half d13p-three-routes-lint-green-without-the-ban-GREEN 0 "lint green: the three routes are import-free" \
  -- bash -c 'npx eslint --config eslint.config.no-banned-methods.mjs e2e/specs/__guard.spec.ts \
    && echo "lint green: the three routes are import-free, so the package bans never see them"'

write_three_routes
half d13p-three-routes-lint-refused-RED 1 "produces a browser, or a context on one, that the harness was never handed" \
  -- npx eslint e2e/specs/__guard.spec.ts

rm -f "$repo/eslint.config.no-banned-methods.mjs"

# (q) THE CHEAP EARLY WARNING for an outright deletion, and the measurement that
#     rewrote it. `check-e2e-lane.mjs` greps the harness for the calls that make
#     it a guard. It used to grep for NAMES, and an independent verifier
#     measured what that bought: with the `guardBrowser` CALL replaced by an
#     inert object and the IMPORT left in place, `tsc` exit 0, the lane guard
#     exit 0, and the lane itself exit 0 with `18 passed` — the guard entirely
#     inert. Only the canary caught it. Every pattern now demands `name(`, and
#     comments are stripped first, because the first version of THAT fix was
#     satisfied by a sentence in the fixture's own header comment.
#
#     This is string presence and it is NOT the control — the control is
#     (a)-(o) above and D15 — but a control whose deletion is silent in CI is
#     the defect this repository keeps rediscovering, so the deletion is made
#     loud and the loudness is demonstrated rather than asserted.
harness_entry="$repo/e2e/harness/test.ts"
worker_guard_file="$repo/e2e/harness/worker-guard.ts"
cp "$harness_entry" "$repo/.test.ts.bak"
cp "$worker_guard_file" "$repo/.worker-guard.ts.bak"
digest "D13q test.ts BEFORE" "$harness_entry"
digest "D13q worker-guard.ts BEFORE" "$worker_guard_file"

# the four PRE-EXISTING name checks, each with the call removed and the import
# left — the exact shape the verifier measured passing
perl -0pi -e 's/const guard = guardBrowser\(browser\);/void guardBrowser;\n  const guard = INERT as unknown as BrowserGuard;/' "$worker_guard_file"
half d13q-guardBrowser-call-removed-RED 1 "no longer CALLS \`guardBrowser\`" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.worker-guard.ts.bak" "$worker_guard_file"

perl -0pi -e 's/const policyProblems = validatePolicy\(browserErrorPolicy\);/const policyProblems: string[] = []; void validatePolicy;/' "$harness_entry"
half d13q-validatePolicy-call-removed-RED 1 "no longer CALLS \`validatePolicy\`" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.test.ts.bak" "$harness_entry"

# BOTH call sites: the before-phase and the during-phase. Removing one would
# leave the other, and the check would rightly still pass.
perl -0pi -e 's/= unallowedRecords\(/= NOT_CALLED(/g' "$harness_entry"
half d13q-unallowedRecords-call-removed-RED 1 "no longer CALLS \`unallowedRecords\`" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.test.ts.bak" "$harness_entry"

# `claimSigner` is the one that showed a COMMENT could satisfy the check: the
# fixture's header says "a spec that calls `claimSigner()` gets a throw".
perl -0pi -e 's/const signStamp = claimSigner\(\);/const signStamp = STUB; void claimSigner;/' "$harness_entry"
half d13q-claimSigner-call-removed-RED 1 "no longer CALLS \`claimSigner\`" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.test.ts.bak" "$harness_entry"

# and the checks this slice added
perl -0pi -e 's/const disarm = armCreationGuard\(\{/const disarm = STUB; void armCreationGuard; void ({/' "$worker_guard_file"
half d13q-creation-guard-deleted-RED 1 "no longer CALLS \`armCreationGuard\`" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.worker-guard.ts.bak" "$worker_guard_file"

perl -0pi -e 's/const strays = unguardedContexts\(browser, guard\);/const strays: never[] = []; void unguardedContexts;/' "$harness_entry"
half d13q-teardown-assertion-deleted-RED 1 "no longer CALLS \`unguardedContexts\`" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.test.ts.bak" "$harness_entry"

perl -0pi -e 's/throw new Error\(formatOrphans\(orphanRecords, orphanViolations\)\);/void formatOrphans;/' "$harness_entry"
half d13q-orphan-assertion-deleted-RED 1 "no longer CALLS \`formatOrphans\`" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.test.ts.bak" "$harness_entry"

perl -0pi -e 's/isGenuineWorkerHarness\(vizraWorkerGuard\)/NOT_CHECKED/' "$harness_entry"
half d13q-brand-check-deleted-RED 1 "no longer CALLS \`isGenuineWorkerHarness\`" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.test.ts.bak" "$harness_entry"

rm -f "$repo/.test.ts.bak" "$repo/.worker-guard.ts.bak"
digest "D13q test.ts RESTORED" "$harness_entry"
digest "D13q worker-guard.ts RESTORED" "$worker_guard_file"
half d13q-lane-guard-restored-GREEN 0 "runs the harness canary" \
  -- bash scripts/ci/check-e2e-lane.sh

# (h) THE INVERSE CONTROL, and it matters as much as the seven above. An HONEST
#     override — a different viewport and locale, on a HEALTHY page — must stay
#     GREEN. A harness nobody can extend is a harness people work around, and
#     banning `test.extend` wholesale would have been the easy, wrong fix.
write_guard_spec 'import { test as base, expect } from "../harness/test";

const test = base.extend({
  page: async ({ browser }, provide) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      locale: "en-GB",
    });
    const page = await context.newPage();
    await provide(page);
    await context.close();
  },
});

test("an honest page override, on a healthy page, stays green", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  expect(page.viewportSize()?.width).toBe(1024);
});'
half d13h-honest-override-stays-GREEN 0 "1 passed" \
  -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" \
  npx playwright test "$guard_spec" --project="$project"

# And the lint early warning, which is NOT the control: replacing the harness's
# own fixture is refused, while overriding `page` is not.
half d13i-harness-fixture-override-refused-RED 1 "may not replace the harness" \
  -- bash -c 'cat > e2e/specs/__guard.spec.ts <<"SPEC"
import { test as base } from "../harness/test";
const test = base.extend({ vizraHarnessGuard: async ({}, run) => { await run(); } });
export default test;
SPEC
npx eslint e2e/specs/__guard.spec.ts'

half d13i-page-override-stays-lint-clean-GREEN 0 "page override is legal" \
  -- bash -c 'cat > e2e/specs/__guard.spec.ts <<"SPEC"
import { test as base } from "../harness/test";
const test = base.extend({
  page: async ({ browser }, provide) => {
    const context = await browser.newContext({ locale: "en-GB" });
    await provide(await context.newPage());
  },
});
export default test;
SPEC
npx eslint e2e/specs/__guard.spec.ts && echo "OK: a page override is legal — the guard attaches at the browser"'

rm -f "$guard_spec"

# --- D14 THE FLUSH WINDOW ---------------------------------------------------
# The guard asserts at a point in time. An independent verifier measured the
# window: 0 ms caught, 50 ms and 150 ms MISSED. `flushGuardedPages` now settles
# for a fixed 250 ms first, and both ends of the new boundary are pinned here —
# the RED half would go green if the settle were shortened, and the LIMIT half
# would go red if it were lengthened. The honest claim is "wider, not closed".
#
# Measured on this machine, faults at 0/50/150/250/400/600 ms after the body:
#   settle   0 ms -> caught 0                 | settle 250 ms -> caught 0 50 150 250
#   settle 100 ms -> caught 0 50              | settle 400 ms -> caught 0 50 150 250 400
# Cost: 250 ms per test — the 18-test lane went 3.2 s -> 4.4 s locally and
# 4.8 s -> 6.9 s at `--workers=2` (the CI shape), and ran 20 consecutive times
# with 18 passed every time. See docs/evidence/VZ-FOUND-008/d14-*.txt.
log "D14 — how late a fault can fire and still be caught"
half d14-late-fault-150ms-RED 1 "late fault demonstration (D14)" \
  -- demos e2e/demos/late-fault.demo.ts --grep "RED:"
half d14-late-fault-600ms-is-the-LIMIT-GREEN 0 "1 passed" \
  -- demos e2e/demos/late-fault.demo.ts --grep "LIMIT:"

# --- D15 THE EARLY EDGE: hooks, shared pages, and the worker-scoped guard ---
# THE HOLE THIS CLOSES, in an independent verifier's own words: "the guard sees
# nothing a page does before the per-test fixture attaches". The listening used
# to be installed by the TEST-scoped fixture, which Playwright sets up AFTER
# `beforeAll` has run — measured order:
#
#     worker-auto SETUP
#       beforeAll
#       test-auto SETUP → beforeEach → body → afterEach → test-auto TEARDOWN
#       afterAll
#     worker-auto TEARDOWN
#
# so a page opened and navigated in `beforeAll` had already done everything it
# was going to do. The verifier's spec — the idiom Playwright's own docs teach
# for sharing a page — was lint-green, type-green and PASSED on a page that
# 404s a sub-resource and throws, with the fixture's own attachment reading
# `{ contextsGuarded: 2, contextsUnguarded: 0, creationViolations: [],
# records: [] }`: every control reporting success while the guard saw nothing.
#
# The listening is now WORKER-scoped (`vizraWorkerGuard`) and only the
# ACCOUNTING is per test, so each signal is charged to exactly one test and the
# failure says WHICH PHASE produced it.
log "D15 — a page broken in a hook, or shared between tests, fails by name"

# (a) THE VERIFIER'S SPEC, VERBATIM. `beforeAll` opens the page and navigates;
#     the body only asserts. Red, and the diagnostic names the phase.
guard_half_msg d15a-beforeAll-shared-page-RED "BEFORE THE TEST BODY" <<EOF
import { expect, test } from "../harness/test";

let shared: import("@playwright/test").Page;

test.beforeAll(async ({ browser }) => {
  const target = await browser.newPage();
  $BREAK
  await target.goto("$prod_url/");
  await target.waitForLoadState("networkidle");
  shared = target;
});

test("the body only asserts; the hook already broke the page", async () => {
  await expect(shared.getByRole("heading", { level: 1, name: "Vizra" })).toBeVisible();
});
EOF

# (b) `beforeEach`. The measured order puts it INSIDE the per-test window, so it
#     is charged to the test as DURING rather than BEFORE — which is correct,
#     and the transcript says so rather than the comment claiming it.
guard_half_msg d15b-beforeEach-RED "DURING THE TEST" <<EOF
import { expect, test } from "../harness/test";

let shared: import("@playwright/test").Page;

test.beforeEach(async ({ browser }) => {
  const target = await browser.newPage();
  $BREAK
  await target.goto("$prod_url/");
  await target.waitForLoadState("networkidle");
  shared = target;
});

test("the body only asserts; beforeEach already broke the page", async () => {
  await expect(shared.locator("h1")).toBeVisible();
});
EOF

# (c) A SHARED PAGE BETWEEN TWO TESTS. The first test arms the fault and passes;
#     the second navigates the same page and is charged. Nothing is lost at the
#     seam, and no test is charged twice.
guard_half_msg d15c-shared-page-second-test-charged-RED "second test must be charged" <<EOF
import { expect, test } from "../harness/test";

let shared: import("@playwright/test").Page;

test.beforeAll(async ({ browser }) => {
  shared = await browser.newPage();
  await shared.goto("$prod_url/");
});

test("first test arms the fault and passes", async () => {
  await expect(shared.locator("h1")).toBeVisible();
  const target = shared;
  $BREAK
});

test("second test must be charged", async () => {
  await shared.goto("$prod_url/");
  await shared.waitForLoadState("networkidle");
  await expect(shared.locator("h1")).toBeVisible();
});
EOF

# (d) `afterAll`. Nothing is running any more, so no test can be failed for it —
#     the WORKER fixture's teardown fails the run instead. Measured on 1.63.0: a
#     throw there gives exit 1 with "1 error was not a part of any test", even
#     though every test passed.
guard_half_msg d15d-afterAll-RED "AFTER THE LAST TEST" <<EOF
import { expect, test } from "../harness/test";

test("a perfectly clean test", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
});

test.afterAll(async ({ browser }) => {
  const target = await browser.newPage();
  $BREAK
  await target.goto("$prod_url/");
  await target.waitForLoadState("networkidle");
});
EOF

# (e) a `describe.serial` suite sharing one page — the shape a later UI slice is
#     most likely to write for a multi-step journey.
guard_half_msg d15e-describe-serial-RED "BEFORE THE TEST BODY" <<EOF
import { expect, test } from "../harness/test";

test.describe.serial("a journey sharing one page", () => {
  let target: import("@playwright/test").Page;

  test.beforeAll(async ({ browser }) => {
    target = await browser.newPage();
    $BREAK
    await target.goto("$prod_url/");
    await target.waitForLoadState("networkidle");
  });

  test("step one", async () => {
    await expect(target.locator("h1")).toBeVisible();
  });

  test("step two", async () => {
    await expect(target.locator("h1")).toBeVisible();
  });
});
EOF

# (f) a WORKER-SCOPED fixture of the spec's own that opens the page. Worker
#     fixtures are resolved lazily, when a test first asks, so this lands inside
#     the first test's window — charged to that test, not lost.
guard_half_msg d15f-worker-scoped-user-fixture-RED "browser error(s) that no allow-list entry covers" <<EOF
import { expect, test as base } from "../harness/test";

const test = base.extend<Record<string, never>, { openedPage: import("@playwright/test").Page }>({
  openedPage: [
    async ({ browser }, provide) => {
      const target = await browser.newPage();
      $BREAK
      await target.goto("$prod_url/");
      await target.waitForLoadState("networkidle");
      await provide(target);
    },
    { scope: "worker" },
  ],
});

test("a worker fixture of the spec's own opened the page", async ({ openedPage }) => {
  await expect(openedPage.locator("h1")).toBeVisible();
});
EOF

# (g) FINDING 2 — `browser.newBrowserCDPSession()`. `Target.createTarget` makes
#     a page that belongs to no Playwright BrowserContext, so no listener and no
#     context sweep can ever see it (`browser.contexts().length` measured 1
#     before and 1 after). Refused, like every other route to something the
#     harness was never handed.
guard_half_msg d15g-newBrowserCDPSession-RED "browser.newBrowserCDPSession" <<EOF
import { expect, test } from "../harness/test";

test("a raw CDP target no context owns", async ({ page, browser }) => {
  const session = await browser.newBrowserCDPSession();
  await session.send("Target.createTarget", { url: "$prod_url/VERIFIER_F6_MISSING.png" });
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (h) STAMPED STILL IMPLIES GUARDED, one scope up. Moving the listening into a
#     second fixture would otherwise re-open FINDING 11: replace the WORKER
#     fixture with a no-op, keep the test fixture and its stamp, lose the guard.
#     The harness brands what it builds in a module-private WeakSet, and the
#     test fixture refuses to stamp itself if what it was handed is not branded.
guard_half_msg d15h-replaced-worker-fixture-RED "worker-scoped guard \`vizraWorkerGuard\` was replaced" <<EOF
import { test as base, expect } from "../harness/test";

const test = base.extend({
  vizraWorkerGuard: [
    async ({}, provide) => {
      await provide({
        guard: {
          records: [], cursor: () => 0, since: () => [], pages: () => [],
          contextCount: () => 0, registerContext() {}, isGuarded: () => true, dispose() {},
        },
        violations: [], claimedRecords: 0, claimedViolations: 0, dispose() {},
      } as never);
    },
    { scope: "worker", auto: true },
  ],
});

test("keep the stamp, lose the listeners", async ({ page }) => {
  const target = page;
  $BREAK
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
});
EOF

# (i) THE MUTATION THAT PROVES (a) IS LOAD-BEARING. Cut the BEFORE-phase
#     accounting — the listening stays worker-scoped, the records are still
#     collected, they are simply never charged — and the verifier's own spec
#     goes GREEN again, exactly as it did before this slice. That green half is
#     what makes the red one mean something.
harness_entry="$repo/e2e/harness/test.ts"
cp "$harness_entry" "$repo/.test.ts.bak"
digest "D15i test.ts BEFORE" "$harness_entry"
perl -0pi -e 's/const beforeBodyRecords = guard\.since\(worker\.claimedRecords\);/const beforeBodyRecords: typeof guard.records = []; void guard.since;/' "$harness_entry"
digest "D15i test.ts MUTATED" "$harness_entry"
write_guard_spec "$(cat <<EOF
import { expect, test } from "../harness/test";

let shared: import("@playwright/test").Page;

test.beforeAll(async ({ browser }) => {
  const target = await browser.newPage();
  $BREAK
  await target.goto("$prod_url/");
  await target.waitForLoadState("networkidle");
  shared = target;
});

test("the body only asserts; the hook already broke the page", async () => {
  await expect(shared.getByRole("heading", { level: 1, name: "Vizra" })).toBeVisible();
});
EOF
)"
half d15i-before-phase-accounting-cut-GREEN 0 "1 passed" \
  -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" \
  npx playwright test "$guard_spec" --project="$project" --workers=1
cp "$repo/.test.ts.bak" "$harness_entry"
rm -f "$repo/.test.ts.bak"
digest "D15i test.ts RESTORED" "$harness_entry"

# (j) and the lane guard notices if the listening stops being worker-scoped.
cp "$harness_entry" "$repo/.test.ts.bak"
perl -0pi -e 's/\{ scope: "worker", auto: true \}/{ auto: true }/' "$harness_entry"
half d15j-worker-scope-removed-RED 1 "no longer declares an automatic WORKER-scoped fixture" \
  -- bash scripts/ci/check-e2e-lane.sh
cp "$repo/.test.ts.bak" "$harness_entry"
rm -f "$repo/.test.ts.bak"
digest "D15j test.ts RESTORED" "$harness_entry"

# (k) THE INVERSE CONTROLS. An HONEST `beforeAll` that opens a page and shares it
#     across two tests, on a HEALTHY page, stays GREEN — and so does the lint on
#     a spec that uses hooks. A harness that fails honest hook usage would just
#     teach people to stop using hooks.
write_guard_spec 'import { expect, test } from "../harness/test";

let shared: import("@playwright/test").Page;

test.beforeAll(async ({ browser }) => {
  shared = await browser.newPage();
  await shared.goto("/");
  await shared.waitForLoadState("networkidle");
});

test.afterAll(async () => {
  await shared.close();
});

test("an honest beforeAll on a healthy page stays green", async () => {
  await expect(shared.getByRole("heading", { level: 1, name: "Vizra" })).toBeVisible();
});

test("and a second test on the same shared page", async () => {
  await expect(shared.getByRole("heading", { level: 1, name: "Vizra" })).toBeVisible();
});'
half d15k-honest-beforeAll-stays-GREEN 0 "2 passed" \
  -- env E2E_COVERAGE_FLOOR=off E2E_BASE_URL="$prod_url" \
  npx playwright test "$guard_spec" --project="$project" --workers=1

half d15k-worker-fixture-override-refused-by-lint-RED 1 "may not replace the harness" \
  -- bash -c 'cat > e2e/specs/__guard.spec.ts <<"SPEC"
import { test as base } from "../harness/test";
const test = base.extend({
  vizraWorkerGuard: [async ({}, run) => { await run(); }, { scope: "worker", auto: true }],
});
export default test;
SPEC
npx eslint e2e/specs/__guard.spec.ts'

half d15k-newBrowserCDPSession-refused-by-lint-RED 1 "produces a browser, or a context on one, that the harness was never handed" \
  -- bash -c 'cat > e2e/specs/__guard.spec.ts <<"SPEC"
import { test } from "../harness/test";
test("x", async ({ browser }) => { await browser.newBrowserCDPSession(); });
SPEC
npx eslint e2e/specs/__guard.spec.ts'

rm -f "$guard_spec"

# --- verdict ---------------------------------------------------------------
log "verdict"
# The raw logs the script redirects into the evidence directory — the two Docker
# builds, D9's failing run, and the two servers — are normalised here rather
# than by `half`, because nothing writes them through it. Same three rules.
for raw in "$evidence"/*.log; do
  [ -f "$raw" ] && node "$repo/scripts/e2e/normalise-transcript.mjs" "$raw" "$repo"
done
printf '%s' "$digest_ledger" > "$evidence/mutation-digests.txt"
echo "mutation digests: $evidence/mutation-digests.txt"
echo "halves passed: $pass"
echo "halves blocked: $blocked"
echo "halves failed: $fail"
echo "transcripts:   $evidence"
[ "$fail" -eq 0 ] || {
  echo "::error::a demonstration did not demonstrate. That is a failure, not a formality."
  exit 1
}
if [ "$blocked" -gt 0 ]; then
  echo "NOTE: $blocked demonstration(s) were BLOCKED and did not run. They are not passes."
fi
echo "OK: every demonstration that ran went red on the mutation and green on restore."
