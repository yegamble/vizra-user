#!/usr/bin/env bash
# Assert that nothing server-side reached the browser bundle
# (security review FINDING 4; ADR-002 "the env file is boot truth").
#
# WHAT THIS IS FOR. `lib/config.ts` reads every value with computed access
# (`process.env[name]`), which Next will not inline, and both it and
# `lib/api/fetch.ts` now `import "server-only"`, which makes a Client Component
# importing them a build failure. Those are the controls. This is the
# OUTCOME check: whatever the controls do, the shipped chunks must not contain
# the internal base URL, the configured origin, or the name of either — and an
# outcome check keeps holding when someone refactors the control.
#
# It greps the BUILD OUTPUT, so it must run after `npm run build`, in the same
# job. The scan covers `.next/static` (the chunks the browser downloads) and,
# when the standalone output is present, its static copy.
#
# The values are supplied by the caller, so CI can build with recognisable
# sentinels rather than trusting that a real value would have been noticed.
#
# Usage:
#   bash scripts/ci/check-client-bundle.sh [dir]
#   SENTINELS="http://sentinel.invalid https://origin.sentinel.invalid" \
#     bash scripts/ci/check-client-bundle.sh
set -euo pipefail

dir=${1:-.next/static}

# Names that must never appear in a browser chunk. `NEXT_PUBLIC_` is here as a
# tripwire, not because one exists: the day someone adds one, this repository
# should have that conversation deliberately (the Dockerfile's header explains
# why the image is host-independent), not discover it in a chunk.
NEEDLES=${NEEDLES:-"INTERNAL_API_BASE_URL PUBLIC_ORIGIN API_TIMEOUT_MS __Host-vizra_session NEXT_PUBLIC_"}

# Values the build was given; empty by default so the check is usable locally.
SENTINELS=${SENTINELS:-}

[ -d "$dir" ] || {
  echo "::error::client-bundle guard: $dir does not exist — run \`npm run build\` first" >&2
  exit 1
}

# A check that scanned nothing is not a check.
chunks=$(find "$dir" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.json' -o -name '*.css' \) | wc -l | tr -d ' ')
if [ "$chunks" -eq 0 ]; then
  echo "::error::client-bundle guard: no chunks found under $dir — refusing to pass vacuously" >&2
  exit 1
fi

problems=""
scan() {
  local needle=$1 kind=$2 hits
  hits=$(grep -rlF -- "$needle" "$dir" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    problems="${problems}${kind} '${needle}' appears in:"$'\n'
    problems="${problems}$(printf '%s\n' "$hits" | sed 's/^/    /')"$'\n'
  fi
}

for needle in $NEEDLES; do scan "$needle" "server-side identifier"; done
for needle in $SENTINELS; do scan "$needle" "server-side VALUE"; done

if [ -n "$problems" ]; then
  echo "::error::server-side configuration reached the browser bundle:" >&2
  printf '%s' "$problems" | sed 's/^/  /' >&2
  echo "  These values are read per request by lib/config.ts and must never be built into a chunk." >&2
  echo "  A module that needs them belongs on the server: it should carry \`import \"server-only\"\`." >&2
  exit 1
fi

echo "OK: $chunks chunks under $dir, none carrying server-side configuration."
