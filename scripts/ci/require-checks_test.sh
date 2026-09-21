#!/usr/bin/env bash
# Regression suite for scripts/ci/require-checks.sh, the `ci-required` fan-in.
#
# PROVENANCE: adapted from the owner's Vidra meta repo
# (~/github/vidra/vidra-user/scripts/ci/require-checks_test.sh). The QA review
# and the scenarios it describes are Vidra's, not Vizra's.
#
# TWIN (intended): vizra-core, vizra-search and the vizra meta repo carry the
# same suite beside the same script. Change the copies together.
#
# Why it exists: the fan-in is the ONE check branch protection trusts, so every
# way it can mis-read the API is a way for a PR to merge with a proof missing.
# A QA review drove it with a stub `gh` and found it exiting 0 when the reads
# behind its guards failed, when a paginated read died half way, when a
# zero-job run concluded `startup_failure`, and when a lane had two check-runs
# of one name (whichever row came first won). Nothing re-ran those scenarios,
# so any later edit could have reopened them with every check green.
#
# How: a stub `gh`, first on PATH, answers each call from RAW JSON fixtures and
# applies the script's own `--jq` filter with the real jq, so the filters are
# under test and not only the shell around them. A fixture file may hold
# several JSON documents, one per page: with `--paginate` the filter runs over
# every page, without it only the first page is seen, as with the real gh.
# `<kind>.<n>` answers only the n-th call of a kind, `<kind>` every other one;
# a matching `.rc` file sets the exit code (with an HTTP-ish error on stderr,
# or the text of a matching `.err` file), and `<kind>.pages` stops output after
# that many pages, like a paginated read that dies part way.
#
# Needs bash (3.2 is enough) and jq. Nothing here skips: a missing tool fails.
#
#   bash scripts/ci/require-checks_test.sh
#   REQUIRE_CHECKS_SCRIPT=/other/copy.sh bash scripts/ci/require-checks_test.sh
#
# The override runs the suite against another copy, e.g. an older revision to
# show which cases it fails.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script=${REQUIRE_CHECKS_SCRIPT:-$here/require-checks.sh}
[ -r "$script" ] || { echo "require-checks_test: $script is missing" >&2; exit 1; }
command -v jq >/dev/null || { echo "require-checks_test: jq is required (the stub applies the script's --jq filters with it)" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/require-checks-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat >"$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = api ] || { echo "stub gh: only 'gh api' is stubbed: $*" >&2; exit 97; }
shift
url="" expr="." paginate=0
while [ $# -gt 0 ]; do
  case $1 in
    --paginate) paginate=1 ;;
    -H) shift ;;
    --jq) shift; expr=$1 ;;
    repos/*|rate_limit) url=$1 ;;
    *) echo "stub gh: unexpected argument: $1" >&2; exit 97 ;;
  esac
  shift
done
case $url in
  */commits/*/check-runs\?*) kind=checks ;;
  */actions/runs/*/jobs\?*) run=${url#*/actions/runs/}; kind=jobs-${run%%/*} ;;
  */actions/runs\?head_sha=*) kind=runs ;;
  rate_limit) kind=ratelimit ;;
  *) echo "stub gh: no fixture kind for $url" >&2; exit 97 ;;
esac
n=$(( $(cat "$FX/.calls-$kind" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$FX/.calls-$kind"
# A script that ignores MAX_POLLS would spin until its real deadline: stop it.
if [ "$n" -gt 20 ]; then
  echo "stub gh: more than 20 '$kind' calls; killing the script under test" >>"$FX/out"
  kill "$(cat "$FX/pid")"
  exit 97
fi
body=$FX/$kind.$n; [ -e "$body" ] || body=$FX/$kind
pages=1000000; [ -e "$FX/$kind.pages" ] && pages=$(cat "$FX/$kind.pages")
rc=0 err="gh: Server Error (HTTP 502)"
if [ -e "$FX/$kind.$n.rc" ]; then rc=$(cat "$FX/$kind.$n.rc"); elif [ -e "$FX/$kind.rc" ]; then rc=$(cat "$FX/$kind.rc"); fi
if [ -e "$FX/$kind.$n.err" ]; then err=$(cat "$FX/$kind.$n.err"); elif [ -e "$FX/$kind.err" ]; then err=$(cat "$FX/$kind.err"); fi
if [ -e "$body" ]; then
  if [ "$paginate" -eq 1 ]; then
    jq -r -n "limit($pages; inputs) | ($expr)" "$body" || exit 98
  else
    jq -r -n "input | ($expr)" "$body" || exit 98
  fi
elif [ "$rc" -eq 0 ]; then
  echo "stub gh: no fixture $body" >&2
  exit 97
fi
[ "$rc" -eq 0 ] || echo "$err" >&2
exit "$rc"
STUB
chmod +x "$tmp/bin/gh"

SHA=0123456789abcdef0123456789abcdef01234567
A=.github/workflows/a.yml
OPT=.github/workflows/opt.yml
UNLISTED=.github/workflows/unlisted.yml
OTHER=.github/workflows/other.yml
SELF=.github/workflows/ci-required.yml

cases=0 assertions=0 failures=0

# begin TITLE: a fresh fixture dir. Manifest: `a` required, `?opt` optional.
# Default workflow runs map check suite 10 -> a.yml, 20 -> opt.yml.
begin() {
  cases=$((cases + 1))
  title=$1
  FX=$tmp/case-$cases
  mkdir "$FX"
  printf 'a\n?opt\n' >"$FX/manifest"
  runs "1|10|$A|success" "2|20|$OPT|success"
}

# checks ROW... appends ONE page of check-runs. ROW: id|suite|name|status|conclusion[|app]
# With POLL=n set, the page answers only the n-th check-runs read.
checks() {
  printf '%s\n' "$@" | jq -Rn '[inputs | select(length > 0) | split("|") | {
      id: (.[0] | tonumber), check_suite: {id: (.[1] | tonumber)}, name: .[2],
      status: .[3], conclusion: (if .[4] == "" then null else .[4] end),
      app: {slug: (.[5] // "github-actions")}}]
    | {total_count: length, check_runs: .}' >>"$FX/checks${POLL:+.$POLL}"
}

# runs ROW... replaces the workflow-runs list. ROW: id|suite|path|conclusion[|status]
# (an empty conclusion means the run is still going: `in_progress` unless given)
# With POLL=n set, the list answers only the n-th workflow-runs read.
runs() {
  printf '%s\n' "$@" | jq -Rn '[inputs | select(length > 0) | split("|") | {
      id: (.[0] | tonumber), check_suite_id: (.[1] | tonumber), path: .[2], run_attempt: 1,
      status: (if .[3] != "" then "completed" else (.[4] // "in_progress") end),
      conclusion: (if .[3] == "" then null else .[3] end)}]
    | {total_count: length, workflow_runs: .}' >"$FX/runs${POLL:+.$POLL}"
}

# jobcount RUN_ID COUNT: that run's jobs listing.
jobcount() { printf '{"total_count":%s,"jobs":[]}\n' "$2" >"$FX/jobs-$1"; }

# fail KIND [N]: the N-th call of KIND (every call without N) exits 1.
# (`echo P >"$FX/KIND.pages"` makes it print only the first P pages first.)
fail() { echo 1 >"$FX/$1${2:+.$2}.rc"; }

# ratelimited KIND [N]: the N-th call of KIND (every call without N) fails the
# way gh reports an exhausted primary rate limit (HTTP 403).
ratelimited() {
  fail "$@"
  echo "gh: API rate limit exceeded for installation ID 1. If you reach out to GitHub Support for help, please include the request ID 0000. (HTTP 403)" >"$FX/$1${2:+.$2}.err"
}

# reset_at EPOCH: what the rate_limit endpoint reports as the core reset time.
reset_at() { printf '{"resources":{"core":{"limit":1000,"remaining":0,"reset":%s}}}\n' "$1" >"$FX/ratelimit"; }

record() {
  assertions=$((assertions + 1))
  if [ "$1" -eq 0 ]; then
    echo "ok $assertions - $title"
  else
    failures=$((failures + 1))
    echo "not ok $assertions - $title: $2"
    if [ -r "$FX/out" ]; then sed 's/^/    # /' "$FX/out"; fi
  fi
}

# expect RC REGEX [VAR=VALUE...]: run the script on this case's fixtures; its
# exit status must be RC and its combined output must match REGEX.
expect() {
  local want=$1 pattern=$2 rc=0 pid
  shift 2
  env PATH="$tmp/bin:$PATH" FX="$FX" GITHUB_REPOSITORY=o/r CHECK_SHA="$SHA" \
    MANIFEST="$FX/manifest" DEADLINE_MINUTES=0 POLL_SECONDS=0 MAX_POLLS=0 "$@" \
    bash "$script" >"$FX/out" 2>&1 &
  pid=$!
  echo "$pid" >"$FX/pid"
  wait "$pid" || rc=$?
  if [ "$rc" -ne "$want" ]; then
    record 1 "exit $rc, want $want"
  elif ! grep -Eq -- "$pattern" "$FX/out"; then
    record 1 "output does not match /$pattern/"
  else
    record 0
  fi
}

# expect_calls KIND N: the script made exactly N calls of KIND (proves retries).
expect_calls() {
  local got
  got=$(cat "$FX/.calls-$1" 2>/dev/null || echo 0)
  title="$title ($2 '$1' reads)"
  if [ "$got" -eq "$2" ]; then record 0; else record 1 "$got '$1' reads, want $2"; fi
}

# --- verdicts that were already fail-closed stay fail-closed ------------------
begin "every required lane succeeded"
checks "100|10|a|completed|success"
expect 0 'OK: every required check'

begin "a required lane that never ran fails"
checks "200|20|opt|completed|success"
expect 1 'never started'

begin "an optional lane that did not run passes"
checks "100|10|a|completed|success"
expect 0 'optional-if-absent\): opt'

# The gate cannot tell which file an absent lane belongs to, so while ANY run
# on the commit is still queued or running, a `?lane` with no check-run yet is
# pending, not absent — its job may be seconds from being created. It converges
# because every run completes.
begin "an optional lane whose workflow run is still queued is pending, not absent"
runs "1|10|$A|success" "2|20|$OPT||queued"
checks "100|10|a|completed|success"
expect 1 'still running'

begin "an optional lane is absent only once every run on the SHA has completed"
POLL=1 runs "1|10|$A|" "2|20|$OPT||queued"
POLL=1 checks "100|10|a|in_progress|"
POLL=2 runs "1|10|$A|success" "2|20|$OPT|success"
POLL=2 checks "100|10|a|completed|success"
expect 0 'optional-if-absent\): opt' DEADLINE_MINUTES=5 MAX_POLLS=3
expect_calls checks 2

# The one run that is in progress for as long as the gate polls is the gate's
# own. Counting it would hold every absent `?lane` until the deadline.
begin "the gate's own run (by id) does not hold an absent optional lane"
runs "1|10|$A|success" "9|90|$SELF||in_progress"
checks "100|10|a|completed|success"
expect 0 'optional-if-absent\): opt' GITHUB_RUN_ID=9

begin "another run of the gate's own workflow (by file) does not hold an absent optional lane"
runs "1|10|$A|success" "9|90|$SELF||in_progress"
checks "100|10|a|completed|success"
expect 0 'optional-if-absent\): opt' GITHUB_RUN_ID=8 GITHUB_WORKFLOW_REF="o/r/$SELF@refs/pull/1/merge"

for c in skipped cancelled neutral timed_out failure; do
  begin "a required lane concluding $c fails"
  checks "100|10|a|completed|$c"
  expect 1 "a -> $c"

  begin "an optional lane that ran and concluded $c fails"
  checks "100|10|a|completed|success" "200|20|opt|completed|$c"
  expect 1 "opt -> $c"
done

begin "a lane still running at the deadline fails"
checks "100|10|a|in_progress|"
expect 1 'still running'

begin "the lane on the second page of check-runs is found"
checks "200|20|opt|completed|success"
checks "100|10|a|completed|success"
expect 0 'OK: every required check'

# --- a workflow file GitHub rejected: zero jobs, no check-run at all ----------
for c in failure startup_failure; do
  begin "a zero-job $c in an optional lane's file fails"
  runs "1|10|$A|success" "2|20|$OPT|$c"
  jobcount 2 0
  checks "100|10|a|completed|success"
  expect 1 "rejected the workflow file $OPT"

  begin "a zero-job $c in a file the manifest does not list fails"
  runs "1|10|$A|success" "3|30|$UNLISTED|$c"
  jobcount 3 0
  checks "100|10|a|completed|success"
  expect 1 "rejected the workflow file $UNLISTED"
done

begin "a failed unlisted workflow that did run jobs is not a rejected file"
runs "1|10|$A|success" "3|30|$UNLISTED|failure"
jobcount 3 4
checks "100|10|a|completed|success"
expect 0 'OK: every required check'

begin "a finished run's job count is read once, not on every poll"
runs "1|10|$A|" "3|30|$UNLISTED|failure"
jobcount 3 4
checks "100|10|a|in_progress|"
expect 1 'still running' DEADLINE_MINUTES=5 MAX_POLLS=3
expect_calls jobs-3 1

# --- an API read that fails decides nothing ----------------------------------
begin "the jobs-count read failing does not pass"
runs "1|10|$A|success" "3|30|$UNLISTED|failure"
fail jobs-3
checks "100|10|a|completed|success"
expect 1 'GitHub API unavailable'

begin "the workflow-runs read failing does not pass"
fail runs
checks "100|10|a|completed|success"
expect 1 'GitHub API unavailable'

begin "a paginated read that dies after page one does not pass"
runs "1|10|$A|success" "4|11|$A|failure"
jobcount 4 3
checks "100|10|a|completed|success"
checks "101|11|a|completed|failure"
echo 1 >"$FX/checks.pages"
fail checks
expect 1 'GitHub API unavailable'

begin "a check-runs read that fails once is retried, then passes"
checks "100|10|a|completed|success"
fail checks 1
expect 0 'OK: every required check' DEADLINE_MINUTES=5 MAX_POLLS=3
expect_calls checks 2

begin "check-runs failing on every poll fails, naming the API"
fail checks
expect 1 'GitHub API unavailable.*HTTP 502' DEADLINE_MINUTES=5 MAX_POLLS=3
expect_calls checks 3

begin "an outage spanning two polls that then clears is survived"
checks "100|10|a|completed|success"
fail checks 1
fail checks 2
expect 0 'OK: every required check' DEADLINE_MINUTES=5 MAX_POLLS=3
expect_calls checks 3

# --- the token's own rate limit is not an outage ------------------------------
# GITHUB_TOKEN gets 1,000 requests an hour PER REPOSITORY, shared by every job
# running there. A 403 saying so is this gate's own budget, spent by its
# siblings: it is waited out until the reset, not counted as a failed read.
begin "a rate-limited read waits for the reset instead of counting as an outage"
checks "100|10|a|completed|success"
ratelimited checks 1
ratelimited checks 2
reset_at "$(( $(date +%s) + 1 ))"
expect 0 'waiting [0-9]+s for the rate limit to reset' DEADLINE_MINUTES=5 MAX_POLLS=3
expect_calls checks 3
expect_calls ratelimit 2

begin "a rate limit still in force at the deadline fails, and says so"
checks "100|10|a|completed|success"
ratelimited checks
reset_at "$(( $(date +%s) + 3600 ))"
expect 1 'GitHub API unavailable.*rate-limited'

# --- two check-runs with one name ---------------------------------------------
begin "one lane twice, older success and newer failure, fails"
runs "1|10|$A|success" "4|11|$A|failure"
jobcount 4 3
checks "100|10|a|completed|success" "101|11|a|completed|failure"
expect 1 'a -> failure'

begin "one lane twice, older failure and newer success (a later run), passes"
runs "1|10|$A|failure" "4|11|$A|success"
jobcount 1 3
checks "100|10|a|completed|failure" "101|11|a|completed|success"
expect 0 'OK: every required check'

begin "one lane twice, the newer still running, waits"
runs "1|10|$A|success" "4|11|$A|"
checks "100|10|a|completed|success" "101|11|a|in_progress|"
expect 1 'still running'

begin "one lane twice, the older still running, still waits"
runs "1|10|$A|" "4|11|$A|success"
checks "100|10|a|in_progress|" "101|11|a|completed|success"
expect 1 'still running'

begin "a re-run attempt of an older run does not supersede a newer run's failure"
runs "1|10|$A|success" "4|11|$A|failure"
jobcount 4 3
checks "150|10|a|completed|success" "101|11|a|completed|failure"
expect 1 'a -> failure'

begin "a newer run of the lane's file still queued waits"
runs "1|10|$A|failure" "4|11|$A||queued"
jobcount 1 3
checks "100|10|a|completed|failure"
expect 1 'still running'

# Manifest without the `?opt` lane: an absent optional lane would, by design,
# wait for this still-running run (see "pending, not absent" above). The
# point here is that `a`'s own verdict is not held by its run's other jobs.
begin "a lane that finished while other jobs of its run still run is decided"
printf 'a\n' >"$FX/manifest"
runs "1|10|$A|"
checks "100|10|a|completed|success"
expect 0 'OK: every required check'

begin "a newer run of the file that ended without the lane does not hide the older result"
runs "1|10|$A|failure" "4|11|$A|cancelled"
jobcount 1 3
checks "100|10|a|completed|failure"
expect 1 'a -> failure'

begin "one name in two workflow files needs both files to succeed"
runs "1|10|$A|failure" "5|50|$OTHER|success"
jobcount 1 3
checks "100|10|a|completed|failure" "101|50|a|completed|success"
expect 1 "a -> failure \\($A\\)"

begin "a check-run whose workflow run is not listed stands on its own"
checks "100|77|a|completed|failure" "101|10|a|completed|success"
expect 1 'a -> failure \(check suite 77\)'

begin "another app's check-run of the same name does not count"
checks "100|90|a|completed|success|some-other-app"
expect 1 'never started'

begin "an abbreviated commit SHA is refused"
checks "100|10|a|completed|success"
expect 1 'full 40-character' CHECK_SHA=0123456

# ---------------------------------------------------------------------------
# The FLOOR guard (scripts/ci/check-required-floor.sh).
#
# The fan-in above reads the manifest from the checkout under test, so the file
# that DEFINES the required set is editable by the pull request the set is
# gating. `check-required-manifest.sh` only asks whether the names present are
# real jobs; nothing asked whether the names that matter are present at all.
# These cases drive the floor guard directly with mutated manifests, because a
# guard that can only be checked by hand is a guard that will drift.
# ---------------------------------------------------------------------------
floor_script=${REQUIRE_FLOOR_SCRIPT:-$here/check-required-floor.sh}
[ -r "$floor_script" ] || { echo "require-checks_test: $floor_script is missing" >&2; exit 1; }

# floor_expect WANT_RC PATTERN <<manifest lines
floor_expect() {
  cases=$((cases + 1))
  local want=$1 pattern=$2 rc=0
  local file=$tmp/floor-$cases.txt
  cat >"$file"
  # `|| rc=$?`, never `if ! cmd; then rc=$?`: inside the negated condition `$?`
  # is the status of the negation (0), so every failing case would read as a
  # pass. This suite exists because gates that look green are the problem.
  FLOOR="frontend contract" bash "$floor_script" "$file" >"$tmp/floor-$cases.out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    record 1 "exit $rc, want $want: $(tr '\n' ' ' <"$tmp/floor-$cases.out" | cut -c1-200)"
  elif ! grep -Eq -- "$pattern" "$tmp/floor-$cases.out"; then
    record 1 "output does not match /$pattern/: $(tr '\n' ' ' <"$tmp/floor-$cases.out" | cut -c1-200)"
  else
    record 0
  fi
}

title="the floor guard accepts a manifest that requires frontend and contract"
floor_expect 0 'still requires the floor' <<'MANIFEST'
# a comment
frontend
contract
?guard
?docker-build
MANIFEST

title="deleting the frontend line fails the floor guard by name"
floor_expect 1 'frontend: missing' <<'MANIFEST'
contract
?guard
MANIFEST

title="marking frontend optional fails the floor guard by name"
floor_expect 1 'frontend: marked optional' <<'MANIFEST'
?frontend
contract
MANIFEST

title="deleting the contract line fails the floor guard by name"
floor_expect 1 'contract: missing' <<'MANIFEST'
frontend
?guard
MANIFEST

title="marking contract optional fails the floor guard by name"
floor_expect 1 'contract: marked optional' <<'MANIFEST'
frontend
?contract
MANIFEST

title="a floor lane commented out is not a floor lane"
floor_expect 1 'frontend: missing' <<'MANIFEST'
# frontend
contract
MANIFEST

title="a floor name inside a comment on another line does not satisfy the guard"
floor_expect 1 'frontend: missing' <<'MANIFEST'
contract   # replaces frontend
MANIFEST

title="a near-miss name does not satisfy the guard"
floor_expect 1 'frontend: missing' <<'MANIFEST'
frontend-ci
contract
MANIFEST

title="an empty manifest fails rather than vacuously passing"
floor_expect 1 'frontend: missing' <<'MANIFEST'
MANIFEST

# --- the e2e lane in the floor (VZ-FOUND-008) ------------------------------
# The browser lane is the only check that a page works in a browser at all;
# every later UI slice's evidence runs through it. These cases drive the
# DEFAULT floor (no FLOOR override), so they fail if someone quietly drops
# `e2e` from the default value in check-required-floor.sh as well as from the
# manifest.
#
# floor_default_expect WANT_RC PATTERN <<manifest lines
floor_default_expect() {
  cases=$((cases + 1))
  local want=$1 pattern=$2 rc=0
  local file=$tmp/floor-default-$cases.txt
  cat >"$file"
  bash "$floor_script" "$file" >"$tmp/floor-default-$cases.out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    record 1 "exit $rc, want $want: $(tr '\n' ' ' <"$tmp/floor-default-$cases.out" | cut -c1-200)"
  elif ! grep -Eq -- "$pattern" "$tmp/floor-default-$cases.out"; then
    record 1 "output does not match /$pattern/: $(tr '\n' ' ' <"$tmp/floor-default-$cases.out" | cut -c1-200)"
  else
    record 0
  fi
}

title="the DEFAULT floor demands the browser lane"
floor_default_expect 1 'e2e: missing' <<'MANIFEST'
frontend
contract
?guard
MANIFEST

title="marking the browser lane optional fails the floor guard by name"
floor_default_expect 1 'e2e: marked optional' <<'MANIFEST'
frontend
contract
?e2e
MANIFEST

title="a manifest with all three floor lanes satisfies the default floor"
floor_default_expect 0 'still requires the floor' <<'MANIFEST'
frontend
contract
e2e
?guard
MANIFEST

# --- the FLOOR value itself ------------------------------------------------
# A verifier found `FLOOR=" "` printing OK with an empty floor list: non-empty,
# so `${FLOOR:-default}` does not substitute, and the loop then iterates zero
# times. That is the same vacuous pass as the empty-manifest case above, one
# level up — in the script whose whole purpose is to refuse to pass vacuously.
# These cases drive the FLOOR value rather than the manifest, so `floor_expect`
# (which fixes FLOOR) cannot express them.
#
# floor_env_expect FLOOR_VALUE WANT_RC PATTERN  — against a manifest that
# requires NOTHING, so a floor that is actually enforced must fail.
floor_env_expect() {
  cases=$((cases + 1))
  local value=$1 want=$2 pattern=$3 rc=0
  local file=$tmp/floor-env-$cases.txt
  printf '# no lanes required at all\n' >"$file"
  FLOOR="$value" bash "$floor_script" "$file" >"$tmp/floor-env-$cases.out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    record 1 "exit $rc, want $want: $(tr '\n' ' ' <"$tmp/floor-env-$cases.out" | cut -c1-200)"
  elif ! grep -Eq -- "$pattern" "$tmp/floor-env-$cases.out"; then
    record 1 "output does not match /$pattern/: $(tr '\n' ' ' <"$tmp/floor-env-$cases.out" | cut -c1-200)"
  else
    record 0
  fi
}

title="a whitespace-only FLOOR does not pass vacuously"
floor_env_expect " " 1 'FLOOR resolved to no lanes'

title="a tab/newline-only FLOOR does not pass vacuously"
floor_env_expect "$(printf '\t\n ')" 1 'FLOOR resolved to no lanes'

title="an empty FLOOR falls back to the default and still enforces it"
floor_env_expect "" 1 'frontend: missing'

title="a FLOOR naming real lanes still enforces them"
floor_env_expect "frontend" 1 'frontend: missing'

title="the real manifest in this repository satisfies the DEFAULT floor"
# No FLOOR override: this is the case that would catch a pull request that
# removed a lane from BOTH the manifest and the floor's default value.
cases=$((cases + 1))
if bash "$floor_script" "$here/../../.github/required-checks.txt" >"$tmp/floor-real.out" 2>&1; then
  record 0
else
  record 1 "the committed .github/required-checks.txt does not satisfy the floor"
fi

# ---------------------------------------------------------------------------
# The E2E-LANE guard (scripts/ci/check-e2e-lane.sh -> check-e2e-lane.mjs).
#
# THE HOLE THESE CLOSE. The first version of that guard greped the workflow. An
# independent verifier ran three mutations through it — deleting the
# `run: npm run e2e` line, replacing it with `echo skipping`, and putting
# `if: false` on the job — and it printed "OK: ... still drives the built image"
# for all three. The first two are caught by nothing downstream: the `e2e` job
# still builds and starts the image, still passes the fixture guard, and still
# concludes `success`, with no browser opened. `ci-required` then reports that
# every required check succeeded.
#
# The guard now PARSES the workflow, so these cases drive it with mutated
# workflow fixtures rather than asserting that a grep is clever enough.
# ---------------------------------------------------------------------------
lane_script=${E2E_LANE_SCRIPT:-$here/check-e2e-lane.sh}
real_workflow=$here/../../.github/workflows/e2e.yml
[ -r "$lane_script" ] || { echo "require-checks_test: $lane_script is missing" >&2; exit 1; }
[ -r "$real_workflow" ] || { echo "require-checks_test: $real_workflow is missing" >&2; exit 1; }

# lane_expect WANT_RC PATTERN SED_PROGRAM  — mutate the real workflow with sed
# and drive the guard with the result. Mutating the REAL file keeps these cases
# honest: a hand-written fixture would drift away from the workflow it stands in
# for, and would still pass after the workflow was weakened.
lane_expect() {
  cases=$((cases + 1))
  local want=$1 pattern=$2 program=$3 rc=0
  local file=$tmp/lane-$cases.yml
  sed "$program" "$real_workflow" >"$file"
  bash "$lane_script" "$file" >"$tmp/lane-$cases.out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    record 1 "exit $rc, want $want: $(tr '\n' ' ' <"$tmp/lane-$cases.out" | cut -c1-220)"
  elif ! grep -Eq -- "$pattern" "$tmp/lane-$cases.out"; then
    record 1 "output does not match /$pattern/: $(tr '\n' ' ' <"$tmp/lane-$cases.out" | cut -c1-220)"
  else
    record 0
  fi
}

title="the committed e2e workflow passes its own guard"
lane_expect 0 'still drives the built image' ''

title="deleting the lane step fails by name"
lane_expect 1 'no step runs the browser lane' '/^        run: npm run e2e$/d'

title="replacing the lane step with an echo fails by name"
lane_expect 1 'no step runs the browser lane' 's|^        run: npm run e2e$|        run: echo skipping|'

title="appending || true to the lane step fails by name"
lane_expect 1 'launders the exit code' 's@^        run: npm run e2e$@        run: npm run e2e || true@'

title="wrapping the lane step in a subshell fails by name"
lane_expect 1 'no step runs the browser lane' 's@^        run: npm run e2e$@        run: (npm run e2e); true@'

title="if: false on the lane step fails by name"
lane_expect 1 'must run unconditionally' 's|^      - name: Browser lane (desktop 1440, mobile 390)$|      - name: Browser lane (desktop 1440, mobile 390)\n        if: false|'

title="continue-on-error on the lane step fails by name"
lane_expect 1 'continue-on-error' 's|^      - name: Browser lane (desktop 1440, mobile 390)$|      - name: Browser lane (desktop 1440, mobile 390)\n        continue-on-error: true|'

title="removing the coverage-floor step fails by name"
lane_expect 1 'check-coverage-floor-ran' '/run: node scripts\/ci\/check-coverage-floor-ran.mjs/d'

title="removing the artifact redaction fails by name"
lane_expect 1 'redact-artifacts.sh' '/run: bash scripts\/ci\/redact-artifacts.sh/d'

title="demoting if-no-files-found to warn fails by name"
lane_expect 1 'if-no-files-found: error' 's|^          if-no-files-found: error$|          if-no-files-found: warn|'

title="pointing the lane at a port nothing publishes fails by name"
lane_expect 1 'does not match any port' 's|E2E_BASE_URL: http://127.0.0.1:3000|E2E_BASE_URL: http://127.0.0.1:9999|'

title="setting E2E_COVERAGE_FLOOR in the lane fails by name"
lane_expect 1 'E2E_COVERAGE_FLOOR' 's|^          E2E_BASE_URL: http://127.0.0.1:3000$|          E2E_BASE_URL: http://127.0.0.1:3000\n          E2E_COVERAGE_FLOOR: "off"|'

title="a paths filter on a required lane fails by name"
lane_expect 1 'paths' 's|^  pull_request:$|  pull_request:\n    paths:\n      - "e2e/**"|'

# --- the upload must be gated on the redaction having SUCCEEDED -------------
# Both steps used to carry a bare `if: failure()`, and nothing linked them.
# GitHub's `failure()` is true when ANY earlier step failed, so a redactor that
# exits non-zero — exit 2 on a missing perl/unzip/zip, exit 1 on a repack
# failure — satisfies its own condition and the UNREDACTED tree is published
# for 14 days. Fail-open, in the one place it matters.

title="an upload gated on bare failure() fails by name"
lane_expect 1 'not gated on the redaction having SUCCEEDED' "s|^        if: failure() && steps.redact.outcome == 'success'\$|        if: failure()|"

title="an upload gated on the wrong step's outcome fails by name"
lane_expect 1 'not gated on the redaction having SUCCEEDED' "s|steps.redact.outcome == 'success'|steps.something_else.outcome == 'success'|"

title="an upload gated on the redactor merely having RUN fails by name"
lane_expect 1 'not gated on the redaction having SUCCEEDED' "s|steps.redact.outcome == 'success'|steps.redact.conclusion != 'skipped'|"

title="removing the redaction step's id fails by name"
lane_expect 1 'no .id:.' '/^        id: redact$/d'

title="marking the redaction step continue-on-error fails by name"
lane_expect 1 'redaction step sets .continue-on-error' 's|^        id: redact$|        id: redact\n        continue-on-error: true|'

# Moving the redaction AFTER the upload, rather than deleting it: the step is
# still there, still runs, and still redacts — just too late. A guard that only
# checked for the step's existence would pass this.
title="redacting after uploading fails by name"
cases=$((cases + 1))
reorder=$tmp/lane-reorder.yml
{
  sed '/^      - name: Redact URL query strings in the artifacts$/,/^        run: bash scripts\/ci\/redact-artifacts.sh test-results playwright-report$/d' "$real_workflow"
  printf '      - name: Redact URL query strings in the artifacts\n'
  printf '        id: redact\n'
  printf '        if: failure()\n'
  printf '        run: bash scripts/ci/redact-artifacts.sh test-results playwright-report\n'
} >"$reorder"
reorder_rc=0
bash "$lane_script" "$reorder" >"$tmp/lane-reorder.out" 2>&1 || reorder_rc=$?
if [ "$reorder_rc" -ne 1 ]; then
  record 1 "exit $reorder_rc, want 1: $(tr '\n' ' ' <"$tmp/lane-reorder.out" | cut -c1-220)"
elif ! grep -Eq -- 'uploaded BEFORE they are redacted' "$tmp/lane-reorder.out"; then
  record 1 "output does not name the ordering: $(tr '\n' ' ' <"$tmp/lane-reorder.out" | cut -c1-220)"
else
  record 0
fi

# --- THE HARNESS CHECKS: parsed source, not a grep -------------------------
# The guard's harness assertions used to run a regex over the source with
# comments crudely removed, and its header claimed that could "only make the
# patterns match LESS, i.e. fail closed". THAT WAS FALSE. Two independent
# verifiers measured three ways through it with the CALL deleted in each case:
#
#     `void 0; // formatOrphans(a, b)`   a TRAILING line comment   -> GREEN
#     `const s = "formatOrphans(";`      a STRING literal          -> GREEN
#     `void formatOrphans(a, b);`        call-and-discard          -> GREEN
#
# and the first was driven end to end on the ONE control the canary cannot
# reach — the `formatOrphans` worker-teardown assertion — giving `tsc` 0, the
# lane guard 0, the canary 0, and an `afterAll` that breaks a page PASSING.
#
# The guard now parses. These cases keep it parsed: each drives the REAL guard
# against a throwaway tree in which exactly one harness file is mutated, so a
# future "simplification" back to a regex is red here rather than in a verifier's
# report six weeks later. The shadowed-callee case is the defeat an AST matcher
# would otherwise have INTRODUCED — matching "a call to something named X"
# without asking which X trades a string defeat for a scope defeat.

# harness_tree: a throwaway repo root holding only what the lane guard reads.
# The guard resolves its repo root from its own location, so copying the script
# beside a copy of the harness is all it takes — no environment override, and
# therefore no testing backdoor in a gate script.
harness_tree() {
  local root=$1
  mkdir -p "$root/scripts/ci" "$root/e2e/harness"
  cp "$here/check-e2e-lane.sh" "$here/check-e2e-lane.mjs" "$here/ts-source-facts.mjs" "$root/scripts/ci/"
  cp "$here/../../e2e/harness/test.ts" "$here/../../e2e/harness/worker-guard.ts" "$root/e2e/harness/"
  cp "$here/../../playwright.config.ts" "$here/../../playwright.demos.config.ts" \
    "$here/../../package.json" "$root/"
  ln -s "$here/../../node_modules" "$root/node_modules"
  # The `.vizra-e2e` deny-list sweep reads every workflow in the repository, so
  # the throwaway tree needs them too. Symlinked, not copied: the sweep is about
  # the real workflows, and a stale copy would assert nothing.
  mkdir -p "$root/.github"
  ln -s "$here/../../.github/workflows" "$root/.github/workflows"
}

# harness_expect WANT_RC PATTERN FILE PERL_PROGRAM
harness_expect() {
  cases=$((cases + 1))
  local want=$1 pattern=$2 file=$3 program=$4 rc=0
  local root=$tmp/harness-$cases
  harness_tree "$root"
  if [ -n "$program" ]; then
    perl -0pi -e "$program" "$root/$file" || { record 1 "mutation failed to apply"; return; }
    if cmp -s "$root/$file" "$here/../../$file"; then
      record 1 "THE MUTATION DID NOT CHANGE $file — a demonstration that does not mutate proves nothing"
      return
    fi
  fi
  bash "$root/scripts/ci/check-e2e-lane.sh" "$real_workflow" >"$tmp/harness-$cases.out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    record 1 "exit $rc, want $want: $(tr '\n' ' ' <"$tmp/harness-$cases.out" | cut -c1-220)"
  elif ! grep -Eq -- "$pattern" "$tmp/harness-$cases.out"; then
    record 1 "output does not match /$pattern/: $(tr '\n' ' ' <"$tmp/harness-$cases.out" | cut -c1-220)"
  else
    record 0
  fi
}

orphan_call='throw new Error\(formatOrphans\(orphanRecords, orphanViolations\)\);'
guard_call='guardBrowser\(browser\)'

title="the unmutated harness tree passes (the inverse control)"
harness_expect 0 'still drives the built image' e2e/harness/test.ts ''

title="formatOrphans: the call removed fails by name"
harness_expect 1 'no longer CALLS .formatOrphans' e2e/harness/test.ts \
  "s/$orphan_call/throw new Error(\"orphans\");/"

title="formatOrphans: a TRAILING comment does not satisfy the check"
harness_expect 1 'no longer CALLS .formatOrphans' e2e/harness/test.ts \
  "s|$orphan_call|throw new Error(\"orphans\"); // formatOrphans(orphanRecords, orphanViolations)|"

title="formatOrphans: a STRING literal does not satisfy the check"
harness_expect 1 'no longer CALLS .formatOrphans' e2e/harness/test.ts \
  "s|$orphan_call|const decoy = \"formatOrphans(\"; throw new Error(decoy);|"

title="formatOrphans: call-and-discard via void does not satisfy the check"
harness_expect 1 'DISCARDS with .void' e2e/harness/test.ts \
  "s|$orphan_call|void formatOrphans(orphanRecords, orphanViolations);|"

title="formatOrphans: a SHADOWED callee does not satisfy the check"
harness_expect 1 'shadows' e2e/harness/test.ts \
  "s|$orphan_call|const formatOrphans = () => \"x\"; throw new Error(formatOrphans());|"

title="guardBrowser: the call removed fails by name"
harness_expect 1 'no longer CALLS .guardBrowser' e2e/harness/worker-guard.ts \
  "s/$guard_call/({} as never)/"

title="guardBrowser: a TRAILING comment does not satisfy the check"
harness_expect 1 'no longer CALLS .guardBrowser' e2e/harness/worker-guard.ts \
  "s|$guard_call|({} as never) /* guardBrowser(browser) */|"

title="guardBrowser: a STRING literal does not satisfy the check"
harness_expect 1 'no longer CALLS .guardBrowser' e2e/harness/worker-guard.ts \
  "s|$guard_call|JSON.parse(\"guardBrowser(\") as never|"

title="guardBrowser: call-and-discard via void does not satisfy the check"
harness_expect 1 'DISCARDS with .void' e2e/harness/worker-guard.ts \
  "s|$guard_call|(void guardBrowser(browser)) as never|"

title="guardBrowser: a SHADOWED callee does not satisfy the check"
harness_expect 1 'shadows' e2e/harness/worker-guard.ts \
  "s|const guard = $guard_call|const guardBrowser = (_b: unknown) => ({}) as never; const guard = guardBrowser(browser)|"

# The eleventh check demanded only the PRESENCE of `STAMP_ANNOTATION`. A verifier
# measured at `f0ee8f1` that deleting the whole annotation push leaves that green,
# because the identifier survives on its own import line. Parsing makes the fix
# free, so the case is pinned here.
title="STAMP_ANNOTATION surviving only on an import line fails by name"
harness_expect 1 'stamp annotation' e2e/harness/test.ts \
  's/type: STAMP_ANNOTATION,/type: "vizra-harness-stamp",/'

# --- globalSetup / globalTeardown are REFUSED ------------------------------
# An independent verifier measured the hole (PR #7 review, FINDING 6): the
# listening starts at WORKER setup, while `globalSetup` runs in the Playwright
# main process before any worker exists. A `globalSetup` that launched its own
# Chromium and opened a page which 404s a sub-resource and throws gave
# `npx playwright test` exit 0, `3 passed`, with no guard message; the module
# provably ran (it wrote a marker file); and `check-e2e-lane.sh` exited 0 too.
# Nothing here needs one, so the key is refused rather than guarded.
title="globalSetup in playwright.config.ts fails by name"
harness_expect 1 'declares .globalSetup' playwright.config.ts \
  's|  testDir: "./e2e/specs",|  globalSetup: "./e2e/harness/vz-globalsetup.ts",\n  testDir: "./e2e/specs",|'

title="globalTeardown in playwright.config.ts fails by name"
harness_expect 1 'declares .globalTeardown' playwright.config.ts \
  's|  testDir: "./e2e/specs",|  globalTeardown: "./e2e/harness/vz-globalteardown.ts",\n  testDir: "./e2e/specs",|'

title="globalSetup in the DEMOS config fails by name too"
harness_expect 1 'playwright.demos.config.ts declares .globalSetup' playwright.demos.config.ts \
  's|  testDir: "./e2e/demos",|  globalSetup: "./e2e/harness/vz-globalsetup.ts",\n  testDir: "./e2e/demos",|'

title="globalSetup named only in a COMMENT does not trip the refusal"
harness_expect 0 'still drives the built image' playwright.config.ts \
  's|  testDir: "./e2e/specs",|  // globalSetup is refused here; see AGENTS.md\n  testDir: "./e2e/specs",|'

title="globalSetup named only in a STRING does not trip the refusal"
harness_expect 0 'still drives the built image' playwright.config.ts \
  's|  outputDir: "test-results",|  outputDir: "test-results",\n  metadata: { note: "globalSetup: none" },|'

title="a config whose default export cannot be read fails CLOSED"
harness_expect 1 'unreadable-default-export' playwright.config.ts \
  's|export default defineConfig\(\{|const built = buildIt(1);\nexport default built;\nconst unusedConfig = defineConfig({|'

# The stamp wiring, now read from the tree rather than from a substring.
title="a reporter specifier named only in a comment does not satisfy the check"
harness_expect 1 'stamp-reporter' playwright.config.ts \
  's|\["\./e2e/harness/stamp-reporter\.ts"\],|// ["./e2e/harness/stamp-reporter.ts"],|'

title="the harness import named only in a comment does not satisfy the check"
harness_expect 1 'no longer imports' playwright.config.ts \
  's|import "\./e2e/harness/test";|/* import "./e2e/harness/test"; */ const decoy = 1;|'

title="testDir widened to ./e2e fails by name"
harness_expect 1 'restricts .testDir' playwright.config.ts \
  's|  testDir: "\./e2e/specs",|  testDir: "./e2e",|'

# --- EVERY upload step, not the first one ----------------------------------
# The parser located the upload with `steps.find(...)` and asserted the gate on
# that one step. An independent verifier appended a SECOND
# `actions/upload-artifact` step on a bare `if: failure()`, publishing the same
# two directories, and the parser printed OK. When the redactor FAILS the gated
# upload is skipped and the ungated one publishes the UNREDACTED tree — the
# exact fail-open the gate was added to close. `.find` is now `.filter`.
#
# These cases APPEND to the real workflow rather than mutating a line, so they
# are written directly instead of through `lane_expect`.

# lane_append WANT_RC PATTERN <<yaml  — append the here-doc to the real
# workflow and drive the guard with the result.
lane_append() {
  cases=$((cases + 1))
  local want=$1 pattern=$2 rc=0
  local file=$tmp/lane-append-$cases.yml
  { cat "$real_workflow"; printf '\n'; cat; } >"$file"
  bash "$lane_script" "$file" >"$tmp/lane-append-$cases.out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    record 1 "exit $rc, want $want: $(tr '\n' ' ' <"$tmp/lane-append-$cases.out" | cut -c1-220)"
  elif ! grep -Eq -- "$pattern" "$tmp/lane-append-$cases.out"; then
    record 1 "output does not match /$pattern/: $(tr '\n' ' ' <"$tmp/lane-append-$cases.out" | cut -c1-220)"
  else
    record 0
  fi
}

title="a SECOND, ungated upload-artifact step fails by name"
lane_append 1 'not gated on the redaction having SUCCEEDED' <<'YAML'
      - name: Upload Playwright artifacts (second, ungated)
        if: failure()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: playwright-artifacts-second
          path: |
            test-results/
          retention-days: 3
          if-no-files-found: error
YAML

title="a second upload step with no condition at all fails by name"
lane_append 1 'not gated on .failure' <<'YAML'
      - name: Upload Playwright artifacts (second, always)
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: playwright-artifacts-always
          path: |
            playwright-report/
            test-results/
          if-no-files-found: error
YAML

title="an ungated uploader that is NOT actions/upload-artifact fails by name"
lane_append 1 'not gated on the redaction having SUCCEEDED' <<'YAML'
      - name: Publish with some other uploader
        if: failure()
        uses: some-org/artifact-publisher@0000000000000000000000000000000000000000 # v1
        with:
          name: playwright-artifacts-elsewhere
          path: test-results/
YAML

title="a second upload step that IS correctly gated passes"
lane_append 0 'still drives the built image' <<'YAML'
      - name: Upload Playwright artifacts (second, correctly gated)
        if: failure() && steps.redact.outcome == 'success'
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: playwright-artifacts-second
          path: |
            test-results/
          retention-days: 3
          if-no-files-found: error
YAML

# --- the HARNESS CANARY step -----------------------------------------------
# The canary is the only CI step that would notice the browser-error guard being
# switched off while its identifiers stayed in place — the case an independent
# verifier measured as silent in `npm run test`, in this guard's own harness
# check (which is string presence only) and in the lane itself.

title="removing the harness-canary step fails by name"
lane_expect 1 'harness-canary.mjs' '/run: node scripts\/ci\/harness-canary.mjs/d'

title="replacing the harness canary with an echo fails by name"
lane_expect 1 'harness-canary.mjs' 's|^        run: node scripts/ci/harness-canary.mjs$|        run: echo skipping|'

title="appending || true to the harness canary fails by name"
lane_expect 1 'harness-canary.mjs' 's@^        run: node scripts/ci/harness-canary.mjs$@        run: node scripts/ci/harness-canary.mjs || true@'

title="if: false on the harness canary fails by name"
lane_expect 1 'harness-canary step carries an' 's|^      - name: The harness still fails a broken page (canary)$|      - name: The harness still fails a broken page (canary)\n        if: false|'

title="continue-on-error on the harness canary fails by name"
lane_expect 1 'harness-canary step sets .continue-on-error' 's|^        run: node scripts/ci/harness-canary.mjs$|        continue-on-error: true\n        run: node scripts/ci/harness-canary.mjs|'

title="pinning the per-run stamp key in the workflow fails by name"
lane_expect 1 'VIZRA_E2E_STAMP_KEY' 's|^          E2E_BASE_URL: http://127.0.0.1:3000$|          E2E_BASE_URL: http://127.0.0.1:3000\n          VIZRA_E2E_STAMP_KEY: deadbeef|'

# ---------------------------------------------------------------------------
# The IMAGE-PIN guard (scripts/ci/check-image-pins.sh).
#
# The repository refuses mutable references for GitHub Actions and for the
# codegen generator and spec; the Docker base image was the one input that
# escaped that standard (security review FINDING 5). A tag — even an exact
# patch tag — can be repointed by the registry, so what ships changes with no
# diff. These cases drive the guard with mutated Dockerfiles, so it cannot rot
# into a step that passes whatever it is given.
# ---------------------------------------------------------------------------
pin_script=${IMAGE_PIN_SCRIPT:-$here/check-image-pins.sh}
[ -r "$pin_script" ] || { echo "require-checks_test: $pin_script is missing" >&2; exit 1; }

DIGEST=sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944

# pin_expect WANT_RC PATTERN [NVMRC_VERSION] <<dockerfile lines
pin_expect() {
  cases=$((cases + 1))
  local want=$1 pattern=$2 version=${3:-22.14.0} rc=0
  local dir=$tmp/pin-$cases
  mkdir -p "$dir"
  cat >"$dir/Dockerfile"
  printf '%s\n' "$version" >"$dir/.nvmrc"
  bash "$pin_script" "$dir/Dockerfile" "$dir/.nvmrc" >"$dir/out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    record 1 "exit $rc, want $want: $(tr '\n' ' ' <"$dir/out" | cut -c1-200)"
  elif ! grep -Eq -- "$pattern" "$dir/out"; then
    record 1 "output does not match /$pattern/: $(tr '\n' ' ' <"$dir/out" | cut -c1-200)"
  else
    record 0
  fi
}

title="every FROM digest-pinned at the .nvmrc version passes"
pin_expect 0 'are @sha256-pinned' <<DOCKERFILE
FROM node:22.14.0-alpine@$DIGEST AS deps
FROM node:22.14.0-alpine@$DIGEST AS builder
FROM node:22.14.0-alpine@$DIGEST AS runner
COPY --from=deps /app/node_modules ./node_modules
DOCKERFILE

title="an unpinned tag fails by name"
pin_expect 1 'not pinned to an immutable @sha256 digest' <<DOCKERFILE
FROM node:22.14.0-alpine AS deps
DOCKERFILE

title="one unpinned stage among pinned ones still fails"
pin_expect 1 'not pinned to an immutable @sha256 digest' <<DOCKERFILE
FROM node:22.14.0-alpine@$DIGEST AS deps
FROM node:22.14.0-alpine@$DIGEST AS builder
FROM node:22.14.0-alpine AS runner
DOCKERFILE

title="an abbreviated digest is refused"
pin_expect 1 'digest is 12 characters, want 64' <<'DOCKERFILE'
FROM node:22.14.0-alpine@sha256:9bef0ef1e268 AS deps
DOCKERFILE

title="bumping .nvmrc without re-resolving the digest fails by name"
pin_expect 1 "does not match .*'22.15.0'" 22.15.0 <<DOCKERFILE
FROM node:22.14.0-alpine@$DIGEST AS deps
DOCKERFILE

title="a matching tag for a bumped .nvmrc passes"
pin_expect 0 'are @sha256-pinned' 22.15.0 <<DOCKERFILE
FROM node:22.15.0-alpine@$DIGEST AS deps
DOCKERFILE

title="a --platform flag does not hide the image from the guard"
pin_expect 1 'not pinned to an immutable @sha256 digest' <<'DOCKERFILE'
FROM --platform=linux/amd64 node:22.14.0-alpine AS deps
DOCKERFILE

title="a commented-out FROM is not a FROM"
pin_expect 1 'declares no external FROM' <<DOCKERFILE
# FROM node:22.14.0-alpine@$DIGEST AS deps
RUN echo hi
DOCKERFILE

title="a Dockerfile with no external FROM refuses to pass vacuously"
pin_expect 1 'declares no external FROM' <<'DOCKERFILE'
FROM scratch
DOCKERFILE

title="a stage reference is not an external image and needs no digest"
pin_expect 0 'are @sha256-pinned' <<DOCKERFILE
FROM node:22.14.0-alpine@$DIGEST AS deps
FROM deps AS builder
DOCKERFILE

title="the committed Dockerfile satisfies the image-pin guard"
cases=$((cases + 1))
if bash "$pin_script" "$here/../../Dockerfile" "$here/../../.nvmrc" >"$tmp/pin-real.out" 2>&1; then
  record 0
else
  record 1 "the committed Dockerfile is not immutably pinned: $(tr '\n' ' ' <"$tmp/pin-real.out" | cut -c1-300)"
fi

# --- UPLOAD SCOPE IS DEFAULT-DENY (the security seat's FINDING 8) ----------
# Deriving "what leaves the runner" from the paths the uploaders happen to name
# is not default-deny: `actions/cache` matches neither `upload` nor `artifact`
# and publishes a blob other runs can read; `path:` takes globs and `${{ }}`;
# `$GITHUB_STEP_SUMMARY` publishes with no `path:` at all; and a second job is
# somewhere a single-job parser never looks. The scope is an allowlist, and
# these are the six mutations that prove it.

title="a GLOB in an upload path fails by name"
lane_expect 1 'glob or exclusion metacharacter' 's|^            test-results/$|            test-*/|'

title="a \${{ }} expression in an upload path fails by name"
lane_expect 1 'expression' 's|^            test-results/$|            ${{ runner.temp }}/|'

title="include-hidden-files: true fails by name"
lane_expect 1 'include-hidden-files' 's|^          retention-days: 3$|          retention-days: 3\n          include-hidden-files: true|'

title="an upload path outside the allowlist fails by name"
lane_expect 1 'not on the allowlist' 's|^            test-results/$|            test-results/\n            playwright-report/index.html|'

title="a \$GITHUB_STEP_SUMMARY write in the e2e job fails by name"
lane_expect 1 'GITHUB_STEP_SUMMARY' 's|^      - name: Container logs$|      - name: Summary\n        run: echo hi >> $GITHUB_STEP_SUMMARY\n      - name: Container logs|'

title="an actions/cache step caching .vizra-e2e fails by name"
lane_append 1 'pinned action allowlist' <<'YAML'
      - name: Cache the harness directory
        uses: actions/cache@0c907a75c2c80ebcb7f088228285e798b750cf8f # v4.2.1
        with:
          path: .vizra-e2e
          key: vizra-e2e-${{ github.sha }}
YAML

title="a SECOND JOB in e2e.yml with an uploader is seen by the guard"
lane_append 1 'job .publish. step 1 has the path' <<'YAML'
  publish:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: everything
          path: .
          retention-days: 3
YAML

title="a reusable workflow job fails by name"
lane_append 1 'REUSABLE WORKFLOW' <<'YAML'
  delegated:
    uses: ./.github/workflows/frontend-ci.yml
YAML

# --- FINDING 19: the retention ceiling -------------------------------------
title="retention-days above the ceiling fails by name"
lane_expect 1 'above the ceiling' 's|^          retention-days: 3$|          retention-days: 14|'

title="an uploader with no retention-days fails by name"
lane_expect 1 'inherits the repository default' '/^          retention-days: 3$/d'

# --- FINDING 10: the page snapshot is off in CI ----------------------------
# `error-context.md` is written whenever a test has errors and no Playwright
# CONFIG option gates the file. `PLAYWRIGHT_NO_COPY_PROMPT` gates its worst
# section — an aria snapshot of the live page carrying every DOM text node and
# every input's current value (playwright/lib/index.js:657-658).
title="removing PLAYWRIGHT_NO_COPY_PROMPT from the job fails by name"
lane_expect 1 'PLAYWRIGHT_NO_COPY_PROMPT' '/^      PLAYWRIGHT_NO_COPY_PROMPT: "1"$/d'

title="setting PLAYWRIGHT_NO_COPY_PROMPT to 0 fails by name"
lane_expect 1 'PLAYWRIGHT_NO_COPY_PROMPT' 's|^      PLAYWRIGHT_NO_COPY_PROMPT: "1"$|      PLAYWRIGHT_NO_COPY_PROMPT: "0"|'

title="a DEBUG env key in a lane step fails by name"
lane_expect 1 'refused in this lane' 's|^          E2E_BASE_URL: http://127.0.0.1:3000$|          E2E_BASE_URL: http://127.0.0.1:3000\n          DEBUG: pw:api|'

title="an unlisted PLAYWRIGHT_* env key fails by name"
lane_expect 1 'refused in this lane' 's|^      PLAYWRIGHT_NO_COPY_PROMPT: "1"$|      PLAYWRIGHT_NO_COPY_PROMPT: "1"\n      PLAYWRIGHT_HTML_REPORT: uploads|'

# --- FINDING 9: what `npm run e2e` actually expands to ---------------------
# The guard's strongest assertion is that a step's `run` is exactly
# `npm run e2e`. What that expands to lives in package.json, which the guard
# never opened — so `--trace on --output test-results` was a one-word edit to a
# file no gate read.
title="appending --trace on to scripts.e2e fails by name"
harness_expect 1 'scripts.e2e' package.json \
  's|"e2e": "playwright test"|"e2e": "playwright test --trace on"|'

title="appending --output to scripts.e2e fails by name"
harness_expect 1 'scripts.e2e' package.json \
  's|"e2e": "playwright test"|"e2e": "playwright test --output test-results"|'

title="pointing scripts.e2e at another config fails by name"
harness_expect 1 'scripts.e2e' package.json \
  's|"e2e": "playwright test"|"e2e": "playwright test --config=other.config.ts"|'

title="changing scripts.e2e:demos fails by name"
harness_expect 1 'e2e:demos' package.json \
  's|"e2e:demos": "bash scripts/e2e/demonstrate.sh"|"e2e:demos": "true"|'

echo "require-checks_test: $cases cases, $assertions assertions, $failures failed"
[ "$failures" -eq 0 ]
