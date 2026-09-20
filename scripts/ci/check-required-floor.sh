#!/usr/bin/env bash
# Assert the required-check manifest still demands its FLOOR (ADR-002 "CI fan-in
# and merge queue"; VZ-CI-001).
#
# THE HOLE THIS CLOSES. `scripts/ci/require-checks.sh` reads the manifest from
# the checkout under test:
#
#     manifest=${MANIFEST:-.github/required-checks.txt}
#
# and `check-required-manifest.sh` only asserts that every name PRESENT in that
# file names a real job — never that a name is present at all. So a PR could
# delete the `frontend` line, satisfy every guard, and merge green without
# lint, typecheck, vitest or the production build ever having had to succeed.
# The gate was editable by the change it was gating: the false-positive CI that
# AGENTS.md's code-review rules name outright.
#
# So the floor below is fixed in a file the manifest cannot reach. Removing a
# floor lane, or demoting it to `?optional` (which passes when the lane never
# runs), is a named red failure here.
#
# This is the repository's half. The other half is `.github/CODEOWNERS` plus a
# ruleset requiring owner review on `.github/**` — an owner action, not part of
# any PR. Either half alone is weaker than both: the ruleset can be turned off
# by an owner in the settings UI, and this check can be edited in the same PR
# as the manifest — which is exactly why it is owner-reviewed too.
#
# Usage:  bash scripts/ci/check-required-floor.sh [manifest]
# TWIN (intended): vizra-core and vizra-search carry the same script with their
# own floor. Keep in step.
set -euo pipefail

# The lanes that must be required, non-optional, for a merge to mean anything.
#   frontend — the canonical `npm run ci` gate (lint, typecheck, test, build)
#   contract — the generated client matches vizra-core's contract
# Adding to this list is welcome; removing from it is an owner decision, and
# the diff says so.
FLOOR=${FLOOR:-"frontend contract"}

manifest=${1:-.github/required-checks.txt}
[ -r "$manifest" ] || { echo "::error::required-floor guard: $manifest is missing" >&2; exit 1; }

problems=""
for want in $FLOOR; do
  found=""
  while IFS= read -r raw; do
    name=${raw%%#*}
    name=$(printf '%s' "$name" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$name" ] || continue
    case $name in
      "$want")
        found=required
        break ;;
      "?$want")
        found=optional
        break ;;
    esac
  done < "$manifest"

  case $found in
    required) ;;
    optional)
      problems="${problems}${want}: marked optional (\`?${want}\`). An optional lane passes when it never runs, so this is a removal with extra steps."$'\n' ;;
    *)
      problems="${problems}${want}: missing. It is not listed, so \`ci-required\` would not wait for it."$'\n' ;;
  esac
done

if [ -n "$problems" ]; then
  echo "::error::$(basename "$manifest") no longer requires the floor this repository merges on:" >&2
  printf '%s' "$problems" | sed 's/^/  /' >&2
  echo "  The floor is defined in scripts/ci/check-required-floor.sh and is owner-reviewed (.github/CODEOWNERS)." >&2
  echo "  If a floor lane is genuinely being retired, change the floor and the manifest in the same, reviewed diff." >&2
  exit 1
fi

echo "OK: ${manifest} still requires the floor: ${FLOOR}."
