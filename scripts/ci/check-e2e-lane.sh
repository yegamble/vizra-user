#!/usr/bin/env bash
# The `e2e` lane still tests what it claims to test (VZ-FOUND-008).
#
# This is a thin wrapper. The guard itself is `check-e2e-lane.mjs`, because the
# assertions it makes are about the workflow's STEP GRAPH — is the lane step
# present, is its `run` exactly the documented command, is it unconditional, is
# its exit code load-bearing, does the coverage-floor step follow it — and a
# grep cannot tell a step from a comment, a `run:` from a name, or
# `npm run e2e` from `npm run e2e || true`.
#
# The previous version of this file WAS a grep, and an independent verifier
# walked three mutations through it: deleting the `run: npm run e2e` line,
# replacing it with `echo skipping`, and disabling the job with `if: false` all
# printed "OK: … still drives the built image". The first two are caught by
# nothing downstream — the job still builds and starts the image, still passes
# the fixture guard, and still concludes `success` with no browser opened.
#
# The shell entry point is kept so that `ci-guard`'s shellcheck sweep over
# scripts/ci/*.sh, the invocation in .github/workflows/ci-guard.yml and the
# command documented in AGENTS.md all stay exactly as they were.
#
# Usage:  bash scripts/ci/check-e2e-lane.sh [workflow]
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)

command -v node > /dev/null 2>&1 || {
  echo "::error::e2e-lane guard: node is not available; this check is BLOCKED, not passed." >&2
  exit 2
}

exec node "$here/check-e2e-lane.mjs" "$@"
