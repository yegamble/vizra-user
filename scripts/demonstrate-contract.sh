#!/usr/bin/env bash
# Red/green demonstrations for the contract guards (VZ-FOUND-002).
#
# A check nobody has watched fail protects nothing (meta AGENTS.md). This
# script mutates one thing at a time, records the guard going RED, restores the
# tree and records it going GREEN again — writing every transcript to
# docs/evidence/revendor/.
#
# It only ever touches tracked files it restores with `git checkout --` in a
# trap, and it refuses to run on a dirty tree so a restore cannot destroy
# someone's work.
#
# Run: bash scripts/demonstrate-contract.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/docs/evidence/revendor"
SPEC="contracts/vizra-core/api/openapi.yaml"
MANIFEST="contracts/manifest.json"
CLIENT="lib/api/generated.ts"

cd "$ROOT" || exit 2

if [ -n "$(git status --porcelain -- "$SPEC" "$MANIFEST" "$CLIENT")" ]; then
  echo "refusing to run: $SPEC, $MANIFEST or $CLIENT is already modified." >&2
  echo "This script restores them with 'git checkout --'; commit or stash first." >&2
  exit 2
fi

restore() { git checkout -- "$SPEC" "$MANIFEST" "$CLIENT" 2>/dev/null; }
trap restore EXIT INT TERM

mkdir -p "$OUT"
SCRATCH="$(mktemp -d)"
trap 'restore; rm -rf "$SCRATCH"' EXIT INT TERM

pass=0
fail=0

# record <file> <expected-exit> <description> -- <command...>
record() {
  local file="$1" want="$2" desc="$3"
  shift 4 # file want desc --
  local path="$OUT/$file"
  {
    echo "# $desc"
    echo "# \$ $*"
    echo "# source: $(git rev-parse HEAD) (+ the mutation this demonstration describes)"
    echo "# node $(node --version), $(uname -sm)"
    echo
  } >"$path"
  "$@" >>"$path" 2>&1
  local got=$?
  {
    echo
    echo "# exit=$got (expected $want)"
  } >>"$path"
  if [ "$got" -eq "$want" ]; then
    echo "OK   $file (exit $got)"
    pass=$((pass + 1))
  else
    echo "FAIL $file (exit $got, expected $want)"
    fail=$((fail + 1))
  fi
}

echo "== D1: a hand-edited generated client is rejected =="
# The negative case the ledger names for VZ-FOUND-002: lib/api/generated.ts is
# generated, never hand-edited.
perl -0pi -e 's{export interface paths \{}{export interface paths {\n    "/pwned": never;}' "$CLIENT"
record d1-handedited-client-RED.txt 1 "lib/api/generated.ts hand-edited: one line added to the generated interface" -- npm run check:contract
restore
record d1-handedited-client-GREEN.txt 0 "the same check on the restored tree" -- npm run check:contract

echo
echo "== D2: the vendored spec edited in place is rejected on sha256 =="
# The contract is vizra-core's. Editing the copy here — even to add a comment —
# breaks the manifest's sha256, its byte count and its blob id.
printf '\n# nudged by a demonstration\n' >>"$SPEC"
record d2-edited-spec-RED.txt 1 "the vendored contract edited in place (two lines appended)" -- npm run check:contract
restore
record d2-edited-spec-GREEN.txt 0 "the same check on the restored tree" -- npm run check:contract

echo
echo "== D3: a non-local \$ref is refused before the generator reads it =="
# openapi-typescript resolves external $ref targets through
# @redocly/openapi-core, http(s) included; the guard runs first.
cat >"$SCRATCH/poisoned.yaml" <<'YAML'
openapi: 3.1.0
info:
  title: poisoned
  version: 0.0.0
paths: {}
components:
  schemas:
    Pwned:
      $ref: 'https://attacker.example/pwn.yaml#/Schema'
YAML
record d3-nonlocal-ref-RED.txt 1 "a spec whose \$ref points at a remote host" -- node scripts/check-spec-refs.mjs "$SCRATCH/poisoned.yaml"
record d3-nonlocal-ref-GREEN.txt 0 "the vendored contract, whose refs are all in-document" -- node scripts/check-spec-refs.mjs

echo
echo "== D4: the manifest's provenance is read (verifier Finding 3 on PR #1) =="
# Each of these passed every lane before this slice, because nothing read the
# provenance fields at all.

# D4a — the exact PR #1 shape: vendored from a core FEATURE BRANCH, whose
# commit core can squash-merge and delete out from under this repository.
node -e '
const f="contracts/manifest.json", m=JSON.parse(require("fs").readFileSync(f,"utf8"));
m.spec.source_ref="feat/m0-foundation";
m.spec.source_commit="b0dbeb6dc27294fe793492ea60bc18b6aed4b042";
require("fs").writeFileSync(f, JSON.stringify(m,null,2)+"\n");'
record d4a-feature-branch-RED.txt 1 "manifest re-pointed at core's deleted feat/m0-foundation (PR #1's actual state)" -- npm run check:contract
restore

# D4b — an abbreviated commit is not provenance anyone can resolve later.
node -e '
const f="contracts/manifest.json", m=JSON.parse(require("fs").readFileSync(f,"utf8"));
m.spec.source_commit=m.spec.source_commit.slice(0,7);
require("fs").writeFileSync(f, JSON.stringify(m,null,2)+"\n");'
record d4b-short-commit-RED.txt 1 "manifest source_commit abbreviated to 7 characters" -- npm run check:contract
restore

# D4c — the byte count adjusted to match a file nobody changed. The point is
# that `bytes` is compared to the file rather than being decoration.
node -e '
const f="contracts/manifest.json", m=JSON.parse(require("fs").readFileSync(f,"utf8"));
m.spec.bytes=m.spec.bytes+1;
require("fs").writeFileSync(f, JSON.stringify(m,null,2)+"\n");'
record d4c-wrong-bytes-RED.txt 1 "manifest byte count off by one" -- npm run check:contract
restore

# D4d — the blob id is checked against the bytes, so a manifest cannot claim
# the contents of a core object it does not hold.
node -e '
const f="contracts/manifest.json", m=JSON.parse(require("fs").readFileSync(f,"utf8"));
m.spec.source_blob="0".repeat(40);
require("fs").writeFileSync(f, JSON.stringify(m,null,2)+"\n");'
record d4d-wrong-blob-RED.txt 1 "manifest source_blob replaced with a different object id" -- npm run check:contract
restore

# D4e — the control: unchanged, it passes.
record d4e-manifest-GREEN.txt 0 "the manifest as committed" -- npm run check:contract

echo
echo "== D5: the vendor script refuses a ref it cannot resolve =="
record d5-unknown-ref-RED.txt 2 "vendoring from a ref that does not exist in the core checkout" -- node scripts/vendor-contract.mjs --from ../vizra-core --ref no/such/ref
restore

echo
{
  echo "# contract demonstrations — summary"
  echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ), node $(node --version), $(uname -sm)"
  echo "# head: $(git rev-parse HEAD)"
  echo "# $pass expected outcomes, $fail unexpected"
} | tee "$OUT/demonstrate-summary.txt"

if [ "$fail" -ne 0 ]; then
  echo "SOME DEMONSTRATIONS DID NOT BEHAVE AS DESCRIBED" >&2
  exit 1
fi
echo "all $pass demonstrations behaved as described"
