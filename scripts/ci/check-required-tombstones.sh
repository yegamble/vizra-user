#!/usr/bin/env bash
# VZ-CI-001: a lane may leave .github/required-checks.txt only with a tombstone.
#
#   # tombstone: <lane> retired <YYYY-MM-DD> because <reason>
#
# Compares the manifest under test with the one at the BASE commit (read from
# git, never from the tree under test). Both `name` and `?name` entries count:
#   - removing or commenting out a lane needs a tombstone for it;
#   - demoting `name` to `?name` needs a tombstone for `name` (and keeps `?name`
#     -- the tombstone records that the hard requirement was retired);
#   - renaming a lane = tombstone the old name + add the new one.
# Rejected: a malformed tombstone (no date / no reason), a tombstone for a lane
# the base never listed, for a lane still required as `name`, for a floor lane,
# and deleting an earlier tombstone.
#
# Base resolution: BASE_MANIFEST=<file> (tests), else BASE_SHA (CI:
# pull_request.base.sha / merge_group.base_sha), else merge-base with
# origin/main. A missing base commit is fetched by SHA (shallow checkout).
# Fails closed: BASE MANIFEST UNAVAILABLE.
#
# Usage: bash scripts/ci/check-required-tombstones.sh [manifest]
set -euo pipefail

FLOOR=${FLOOR:-"frontend contract e2e"}
manifest=${1:-.github/required-checks.txt}
path_in_repo=.github/required-checks.txt
[ -r "$manifest" ] || { echo "::error::tombstone guard: $manifest is missing" >&2; exit 1; }

tmpd=$(mktemp -d "${TMPDIR:-/tmp}/tombstones.XXXXXX")
trap 'rm -rf "$tmpd"' EXIT

unavailable() {
  echo "::error::tombstone guard: BASE MANIFEST UNAVAILABLE ($1). Refusing to pass without comparing against the base." >&2
  exit 1
}

if [ -n "${BASE_MANIFEST:-}" ]; then
  [ -r "$BASE_MANIFEST" ] || unavailable "BASE_MANIFEST=$BASE_MANIFEST unreadable"
  cp "$BASE_MANIFEST" "$tmpd/base"
else
  base=${BASE_SHA:-}
  if [ -z "$base" ]; then
    base=$(git merge-base HEAD origin/main 2>/dev/null) || unavailable "no BASE_SHA and no merge base with origin/main"
  fi
  if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
    git fetch --no-tags --depth=1 origin "$base" >/dev/null 2>&1 || unavailable "cannot fetch base $base"
  fi
  git show "${base}:${path_in_repo}" >"$tmpd/base" 2>/dev/null || unavailable "base $base has no $path_in_repo"
fi

# entries FILE: one "R name" / "O name" per listed lane.
entries() {
  sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" | awk 'NF {
    if (substr($0,1,1) == "?") print "O " substr($0,2); else print "R " $0 }'
}
# tombstone lines (raw, trimmed) that start with "# tombstone"
tomblines() { sed -n 's/^[[:space:]]*\(#[[:space:]]*[Tt][Oo][Mm][Bb][Ss][Tt][Oo][Nn][Ee].*\)$/\1/p' "$1" | sed 's/[[:space:]]*$//'; }
tomb_re='^#[[:space:]]*tombstone:[[:space:]]*([^[:space:]]+)[[:space:]]+retired[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]+because[[:space:]]+[^[:space:]].*$'
tomblanes() { tomblines "$1" | grep -E "$tomb_re" | sed -E "s/$tomb_re/\\1/" | sort -u || true; }

entries "$manifest" >"$tmpd/head.e"
entries "$tmpd/base" >"$tmpd/base.e"
tomblanes "$manifest" >"$tmpd/head.t"
tomblanes "$tmpd/base" >"$tmpd/base.t"

problems=""
add() { problems="${problems}$1"$'\n'; }

while IFS= read -r line; do
  printf '%s\n' "$line" | grep -Eq "$tomb_re" \
    || add "malformed tombstone '$line'. Format: # tombstone: <lane> retired <YYYY-MM-DD> because <reason>"
done < <(tomblines "$manifest")

has() { grep -qxF "$2" "$1"; }

while IFS= read -r lane; do
  [ -n "$lane" ] || continue
  for f in $FLOOR; do [ "$f" = "$lane" ] && add "$lane: tombstone for a floor lane; floor lanes are retired only via scripts/ci/check-required-floor.sh"; done
  has "$tmpd/head.e" "R $lane" && add "$lane: tombstone for a lane that is still required"
  if ! has "$tmpd/base.e" "R $lane" && ! has "$tmpd/base.e" "O $lane" && ! has "$tmpd/base.t" "$lane"; then
    add "$lane: tombstone for a lane the base manifest never listed"
  fi
done <"$tmpd/head.t"

while IFS= read -r lane; do
  [ -n "$lane" ] || continue
  has "$tmpd/head.t" "$lane" || add "$lane: an earlier tombstone was deleted; tombstones are permanent"
done <"$tmpd/base.t"

while read -r kind lane; do
  [ -n "$lane" ] || continue
  has "$tmpd/head.t" "$lane" && continue
  if [ "$kind" = R ]; then
    has "$tmpd/head.e" "R $lane" && continue
    if has "$tmpd/head.e" "O $lane"; then
      add "$lane: demoted to ?$lane without a tombstone (an optional lane passes when it never runs)"
    else
      add "$lane: removed from the manifest without a tombstone"
    fi
  else
    has "$tmpd/head.e" "O $lane" || has "$tmpd/head.e" "R $lane" || add "?$lane: removed from the manifest without a tombstone"
  fi
done <"$tmpd/base.e"

if [ -n "$problems" ]; then
  echo "::error::$(basename "$manifest"): lanes retired without a valid tombstone:" >&2
  printf '%s' "$problems" | sed 's/^/  /' >&2
  echo "  Add: # tombstone: <lane> retired <YYYY-MM-DD> because <reason>" >&2
  exit 1
fi
echo "OK: ${manifest} retires no lane without a tombstone ($(wc -l <"$tmpd/base.e" | tr -d ' ') base lane(s) compared)."
