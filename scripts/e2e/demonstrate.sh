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
#   D4  the lane fails when ZERO tests are collected, or a project is missing
#   D5  the lane fails when pointed at a dev server instead of the production build
#   D6  the built image contains no harness file and no fixture token
#   D7  a weakened e2e workflow fails the lane guard
#   D8  a spec importing Playwright's unguarded `test` fails `npm run test`
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

cleanup() {
  for pid in $started; do
    kill "$pid" 2> /dev/null || true
  done
  rm -f "$repo/playwright.config.missing-project.ts" \
    "$repo/Dockerfile.fixtures-mutant" \
    "$repo/Dockerfile.fixtures-mutant.dockerignore" \
    "$repo/e2e/specs/__bypass.spec.ts"
}
trap cleanup EXIT

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
{
  echo "repository: $(git -C "$repo" rev-parse --show-toplevel)"
  echo "branch:     $(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  echo "head sha:   $(git -C "$repo" rev-parse HEAD)"
  echo "tree state: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') modified/untracked path(s)"
  echo "date:       $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "node:       $(node --version)"
  echo "playwright: $(npx playwright --version)"
  echo "build id:   $(cat "$repo/.next/BUILD_ID")"
  echo "project:    $project"
  echo "uname:      $(uname -sm)"
} > "$evidence/environment.txt"
cat "$evidence/environment.txt"

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
half d5-dev-server-RED 1 "this is not a production build" \
  -- env E2E_BASE_URL="http://127.0.0.1:$dev_port" npx playwright test \
  e2e/specs/production-build.spec.ts
half d5-dev-server-GREEN 0 "4 passed" \
  -- env E2E_BASE_URL="$prod_url" npx playwright test \
  e2e/specs/production-build.spec.ts

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
grep -v 'upload-artifact' .github/workflows/e2e.yml > "$evidence/e2e-without-artifacts.yml"
half d7-lane-guard-RED 1 "no longer uploads artifacts" \
  -- bash scripts/ci/check-e2e-lane.sh "$evidence/e2e-without-artifacts.yml"
rm -f "$evidence/e2e-without-artifacts.yml"

# --- D8 a spec that bypasses the guard fails the cheap lane ----------------
# The shortest path past the browser-error guard is `import { test } from
# "@playwright/test"` in a spec. It compiles, runs and passes — and is exempt.
# e2e/harness/browser-errors.test.ts refuses it, in `npm run test`.
log "D8 — a spec importing Playwright's unguarded test fails npm run test"
half d8-bypass-guard-GREEN 0 "passed" -- npx vitest run e2e/harness/browser-errors.test.ts
cat > "$repo/e2e/specs/__bypass.spec.ts" <<'BYPASS'
// GENERATED BY scripts/e2e/demonstrate.sh — deleted when the script exits.
import { expect, test } from "@playwright/test";

test("bypasses the browser-error guard", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
});
BYPASS
half d8-bypass-guard-RED 1 "imports values from @playwright/test directly" \
  -- npx vitest run e2e/harness/browser-errors.test.ts
rm -f "$repo/e2e/specs/__bypass.spec.ts"

# --- verdict ---------------------------------------------------------------
log "verdict"
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
