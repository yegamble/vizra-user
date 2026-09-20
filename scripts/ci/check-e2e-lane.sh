#!/usr/bin/env bash
# The `e2e` lane still tests what it claims to test (VZ-FOUND-008).
#
# THE HOLE THIS CLOSES. The browser lane's value rests on three properties that
# live in the workflow file and in the harness, all of which a pull request can
# edit while the lane stays green:
#
#   1. it drives the BUILT IMAGE, not a development server;
#   2. the coverage floor is armed, so a run that collects nothing fails;
#   3. it uploads traces/screenshots/report when it fails, so a red lane is
#      diagnosable.
#
# None of those is observable from a passing run. `ci-guard` runs this so that
# removing one is a named red failure rather than a quiet loss.
#
# Usage:  bash scripts/ci/check-e2e-lane.sh [workflow]
set -euo pipefail

workflow=${1:-.github/workflows/e2e.yml}
[ -r "$workflow" ] || {
  echo "::error::e2e-lane guard: $workflow is missing." >&2
  exit 1
}

problems=""
add() { problems="${problems}$1"$'\n'; }

# The "must NOT contain" checks below read the workflow with comment lines
# stripped. The comments legitimately discuss `next dev` and the coverage-floor
# variable in order to say the lane must not use them; a guard that could not
# tell a prohibition from its own explanation would force the file to be
# undocumented, which is the wrong trade.
uncommented=$(mktemp)
trap 'rm -f "$uncommented"' EXIT
sed 's/[[:space:]]*#.*$//' "$workflow" > "$uncommented"

# 1. It builds and runs the production image, and points the harness at it.
grep -q 'docker build' "$workflow" \
  || add "it no longer builds the production image (\`docker build\`)."
grep -q 'docker run' "$workflow" \
  || add "it no longer runs the built image (\`docker run\`)."
grep -q 'E2E_BASE_URL' "$workflow" \
  || add "it no longer points the harness at a base URL (\`E2E_BASE_URL\`)."

# 2. It must never run a development server, and never disable the floor.
if grep -qE '(next|npm run) dev' "$uncommented"; then
  add "it starts a development server. The lane must drive the production build (ADR-009)."
fi
if grep -qE 'E2E_COVERAGE_FLOOR[[:space:]]*[:=]' "$uncommented"; then
  add "it sets E2E_COVERAGE_FLOOR. The coverage floor is on by default and the lane must not turn it off."
fi

# 3. Artifacts on failure.
grep -q 'upload-artifact' "$workflow" \
  || add "it no longer uploads artifacts; a red lane would be undiagnosable."
grep -q 'playwright-report' "$workflow" \
  || add "it no longer uploads the HTML report (playwright-report)."
grep -q 'test-results' "$workflow" \
  || add "it no longer uploads test-results (traces, screenshots, videos)."

# 4. It proves the harness did not ship inside the image.
grep -q 'check-no-test-fixtures-in-image.sh' "$workflow" \
  || add "it no longer asserts that the built image is free of harness files and fixtures."

# 5. It runs where the merge queue can see it.
grep -q 'merge_group' "$workflow" \
  || add "it does not trigger on merge_group, so a required lane would hang the merge queue."
grep -q 'pull_request' "$workflow" \
  || add "it does not trigger on pull_request."

# 6. The harness itself must keep its default-deny guard and its floor.
guard=e2e/harness/test.ts
if [ -r "$guard" ]; then
  grep -q 'validatePolicy' "$guard" \
    || add "$guard no longer validates the allow-list policy."
  grep -q 'unallowedRecords' "$guard" \
    || add "$guard no longer fails a test on unallowed browser errors."
else
  add "$guard is missing; there is no browser-error guard."
fi

if [ -n "$problems" ]; then
  echo "::error::the e2e lane no longer tests what it claims to test:" >&2
  printf '%s' "$problems" | sed 's/^/  /' >&2
  echo "  These properties are invisible in a green run, which is why they are asserted here." >&2
  exit 1
fi

echo "OK: ${workflow} still drives the built image, keeps the coverage floor armed, uploads artifacts, and proves the harness does not ship."
