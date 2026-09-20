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
#   D7  a weakened e2e workflow fails the lane guard — including the lane step
#       being deleted, echo-replaced, `|| true`-ed or `if: false`-ed
#   D8  a spec reaching Playwright's unguarded `test` fails the gate, in every
#       spelling an independent verifier walked through the previous guard with
#   D9  a signed-URL-shaped query string does not survive into an uploaded
#       artifact, trace.zip members included
#   D10 a spec that handles a credential fails the cheap lane — the hard line
#       that holds until the artifact-privacy slice lands
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
    "$repo/e2e/specs/__bypass.spec.ts" \
    "$repo/e2e/specs/__shim.ts" \
    "$repo/e2e/specs/__cred.spec.ts"
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
