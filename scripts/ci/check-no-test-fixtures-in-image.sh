#!/usr/bin/env bash
# Prove the SHIPPED image carries none of the browser harness (VZ-FOUND-008).
#
# THE CLAIM THIS REPLACES. "The fault-injection fixtures cannot ship" is easy to
# say and easy to get wrong: `.dockerignore` is a list someone edits, the
# Dockerfile's builder stage does `COPY . .`, and a future stage that copied one
# directory too many would put `e2e/demos/` — pages that deliberately throw and
# deliberately 404 — inside a production image. So the claim is ASSERTED against
# the built image's own filesystem instead of being trusted.
#
# It looks for two things, because either alone is weak:
#   1. harness PATHS (e2e/, playwright configs, scripts/e2e, *.spec.ts, *.demo.ts)
#   2. the fixture TOKEN `__vizra_e2e_fixture__`, which appears in every injected
#      fault, so a renamed or inlined copy is caught too.
#
# Usage:  bash scripts/ci/check-no-test-fixtures-in-image.sh [image-ref]
set -euo pipefail

image=${1:-${E2E_IMAGE:-vizra-user:e2e}}
token='__vizra_e2e_fixture__'

command -v docker > /dev/null 2>&1 || {
  echo "::error::fixture guard: docker is not available; this check is BLOCKED, not passed." >&2
  exit 2
}
docker image inspect "$image" > /dev/null 2>&1 || {
  echo "::error::fixture guard: image '$image' does not exist. Build it before running this." >&2
  exit 2
}

work=$(mktemp -d)
trap 'rm -rf "$work"; docker rm --force "$cid" > /dev/null 2>&1 || true' EXIT

# `docker export` flattens the image's filesystem without starting the app, so
# this inspects what SHIPS rather than what a running container happens to show.
cid=$(docker create "$image")
docker export "$cid" > "$work/rootfs.tar"

# 1. paths. `tar -t` lists every member; node_modules is excluded because a
#    dependency may legitimately ship its own *.spec.ts inside its package.
paths=$(
  tar -tf "$work/rootfs.tar" \
    | grep -vE '(^|/)node_modules/' \
    | grep -E '(^|/)(e2e/|scripts/e2e/)|playwright[^/]*\.config\.|\.spec\.ts$|\.demo\.ts$' || true
)
if [ -n "$paths" ]; then
  echo "::error::fixture guard: the built image contains browser-harness files:" >&2
  printf '%s\n' "$paths" | sed 's/^/  /' >&2
  echo "  The harness must never ship. Check .dockerignore and the Dockerfile's COPY lines." >&2
  exit 1
fi

# 2. the token, anywhere in the image's bytes — a renamed file, an inlined
#    fixture, a bundled chunk. `grep -a` so binary members do not stop the scan.
if grep -a -q -- "$token" "$work/rootfs.tar"; then
  echo "::error::fixture guard: the built image contains the fixture token '$token'." >&2
  echo "  Something from the browser harness was compiled or copied into the image." >&2
  # Name the members, so the failure is actionable rather than a riddle.
  tar -tvf "$work/rootfs.tar" > "$work/members.txt" 2>/dev/null || true
  echo "  Image members listed in the job log artifact; search them for the token." >&2
  exit 1
fi

echo "OK: '$image' contains no browser-harness path and no fixture token."
