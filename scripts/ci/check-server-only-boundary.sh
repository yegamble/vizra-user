#!/usr/bin/env bash
# Assert that a Client Component importing a server-only module FAILS the build
# (security review FINDING 4, first acceptance criterion).
#
# WHY A SCRIPT AND NOT A TEST. vitest cannot express a bundler error: the thing
# under test is what `next build` does with a module graph, and the only way to
# observe it is to build. So this writes a fixture route that does exactly what
# the finding describes — a `"use client"` component importing `viewerFetch`
# and `internalApiBaseUrl` — runs the real build, and requires it to fail with
# the server-only diagnostic. It then removes the fixture and leaves the tree
# as it found it, including on failure.
#
# A GUARD, NOT A DEMONSTRATION. Asserting that the build fails is not enough on
# its own: a build that failed for an unrelated reason (a syntax error in the
# fixture, a missing dependency) would look like a pass. So the failure must
# also NAME the boundary, and the script separately confirms the same tree
# builds clean without the fixture — which is what the frontend gate has
# already done by the time this runs in CI.
#
# Usage:  bash scripts/ci/check-server-only-boundary.sh
# Needs:  node_modules installed; writes and removes app/server-only-probe/.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
probe_dir=$root/app/server-only-probe
out=$(mktemp "${TMPDIR:-/tmp}/server-only-boundary.XXXXXX")

# shellcheck disable=SC2329  # invoked by the EXIT trap below, not by name
cleanup() {
  rm -rf "$probe_dir"
  rm -f "$out"
}
trap cleanup EXIT

[ -e "$probe_dir" ] && { echo "::error::server-only guard: $probe_dir already exists" >&2; exit 1; }
mkdir -p "$probe_dir"

# The exact shape the finding describes, in TWO fixtures — one per module,
# because the finding names both and they fail for different reasons.
#
#   config: `lib/config.ts` imports nothing else server-bound, so its
#           diagnostic is attributable to `server-only` and nothing else.
#   fetch:  `lib/api/fetch.ts` also imports `next/headers`, which Next already
#           refused. That refusal is NOT what this guard is testing, which is
#           why the assertion below requires the `server-only` diagnostic
#           specifically — otherwise the guard would have "passed" before
#           `server-only` was ever added.
mkdir -p "$probe_dir/config" "$probe_dir/fetch"

cat >"$probe_dir/config/page.tsx" <<'PROBE'
"use client";

// FIXTURE, written and deleted by scripts/ci/check-server-only-boundary.sh.
// If you are reading this in a commit, the script did not clean up.
import { internalApiBaseUrl } from "@/lib/config";

export default function ServerOnlyConfigProbe() {
  return <p>{internalApiBaseUrl()}</p>;
}
PROBE

cat >"$probe_dir/fetch/page.tsx" <<'PROBE'
"use client";

// FIXTURE, written and deleted by scripts/ci/check-server-only-boundary.sh.
import { viewerFetch } from "@/lib/api/fetch";

export default function ServerOnlyFetchProbe() {
  return <p>{String(typeof viewerFetch)}</p>;
}
PROBE

echo "server-only guard: building with a Client Component that imports viewerFetch and internalApiBaseUrl…"
rc=0
# `|| rc=$?`, never `if ! cmd`: inside a negated condition `$?` is the status
# of the negation, so a failing build would read as a pass.
NEXT_TELEMETRY_DISABLED=1 npm run build >"$out" 2>&1 || rc=$?

if [ "$rc" -eq 0 ]; then
  echo "::error::the build SUCCEEDED with a Client Component importing server-only modules." >&2
  echo "  lib/api/fetch.ts and lib/config.ts must each carry \`import \"server-only\";\`." >&2
  echo "  Without it the module is bundled and served, and fails only in the visitor's browser." >&2
  tail -40 "$out" >&2
  exit 1
fi

# The build failed — for the RIGHT reason, in BOTH modules?
#
# This assertion is deliberately narrow, and it is narrow because a looser one
# was wrong. A first version grepped for the string `server-only` anywhere in
# the output; it "passed" with both `import "server-only";` lines DELETED,
# because Next's code frames quote the source — `assertServer`'s own message
# and fetch.ts's docblock both contain the phrase — and because
# `lib/api/fetch.ts` imports `next/headers`, which Next refuses on its own. The
# guard would have reported success while proving nothing.
#
# So: match Next's diagnostic sentences exactly, strip the ANSI colouring
# first, and require each of the two modules to be named by one. Each module
# has its own probe, so a diagnostic raised by only one of them cannot stand in
# for the other.
plain=$(sed $'s/\033\\[[0-9;]*m//g' "$out")
diagnostic="Error: 'server-only' cannot be imported from a Client Component module|Error: You're importing a module that depends on \"server-only\""

missing=""
for module in lib/config.ts lib/api/fetch.ts; do
  # The diagnostic line is preceded by the offending file's path.
  if ! printf '%s\n' "$plain" | grep -A1 -F "./${module}:" | grep -qE -- "$diagnostic"; then
    missing="${missing}  ${module}: no server-only diagnostic attributed to it"$'\n'
  fi
done

if [ -n "$missing" ]; then
  echo "::error::the build failed (exit $rc), but not on the server-only boundary for every module — this guard proves nothing:" >&2
  printf '%s' "$missing" >&2
  echo "  Each of lib/config.ts and lib/api/fetch.ts must carry \`import \"server-only\";\`." >&2
  printf '%s\n' "$plain" | tail -40 >&2
  exit 1
fi

count=$(printf '%s\n' "$plain" | grep -cE -- "$diagnostic" || true)
echo "OK: the build failed (exit $rc) with $count server-only diagnostics, attributed to both modules:"
printf '%s\n' "$plain" | grep -E -- "$diagnostic" | sort -u | sed 's/^/  /'
