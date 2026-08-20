#!/usr/bin/env bash
set -euo pipefail

test_dir="$(cd "$(dirname "$0")" && pwd)"
skill_dir="$(cd "$test_dir/.." && pwd)"
script="$skill_dir/scripts/codex-state.sh"
mock_path="$test_dir/bin"
counter_file="$(mktemp "${TMPDIR:-/tmp}/codex-state-counter.XXXXXX")"
default_repo_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-state-default-repo.XXXXXX")"
originless_repo="$(mktemp -d "${TMPDIR:-/tmp}/codex-state-originless.XXXXXX")"
handled_object_file="$(git rev-parse --git-dir)/codex-review-loop-99016.handled.json"
trap 'rm -f -- "$counter_file" "$handled_object_file"; rm -rf -- "$default_repo_dir" "$originless_repo"' EXIT

git init -q "$default_repo_dir"
git -C "$default_repo_dir" remote add origin https://github.com/owner/repo.git

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

run_state() {
	local scenario="$1"
	local pr="$2"
	local required_checks="edge / verify"
	if [[ "$scenario" == "queued-current-ci" ]]; then
		required_checks=$'Setup\nType Check'
	elif [[ "$scenario" == "missing-required-check" ]]; then
		required_checks=$'edge / verify\nMissing required'
	fi
	PATH="$mock_path:$PATH" \
		CODEX_STATE_SCENARIO="$scenario" \
		CODEX_STATE_COUNTER_FILE="$counter_file" \
		CODEX_REVIEW_GH_TIMEOUT_SECONDS=5 \
		CODEX_REVIEW_REQUIRED_CHECKS="$required_checks" \
		"$script" "$pr" owner/repo
}

run_state_default_repo() {
	local scenario="$1"
	local pr="$2"
	(
		cd "$default_repo_dir"
		PATH="$mock_path:$PATH" \
			CODEX_STATE_SCENARIO="$scenario" \
			CODEX_STATE_COUNTER_FILE="$counter_file" \
			CODEX_REVIEW_GH_TIMEOUT_SECONDS=1 \
			"$script" "$pr"
	)
}

body_only="$(run_state body-only 99001)"
jq -e '
	.version == 2
	and .head_sha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	and .phase_not_before == "2026-08-03T10:01:00Z"
	and .phase_sources[0].source == "review-request"
	and .latest.kind == "review_comments"
	and (.open_comments | length) == 1
	and .counts.finding_rounds == 1
' <<<"$body_only" >/dev/null || fail "body-only review was not surfaced"
jq -e '
	.open_comments[0].itemKey == "review-body:101"
	and .open_comments[0].kind == "review-body"
	and .open_comments[0].priority == "P2"
	and (.open_comments[0].body | contains("body-only finding"))
' <<<"$body_only" >/dev/null || fail "body-only finding fields are incomplete"

printf '%s\n' '{"handledItemKeys":["review-body:101"],"actionableFindingRounds":[101],"families":{"body-only":{"count":1,"outcome":"fixed"}}}' >"$handled_object_file"
handled_object="$(run_state body-only 99016)"
jq -e '
	(.open_comments | length) == 0
	and (.review_items | length) == 1
' <<<"$handled_object" >/dev/null ||
	fail "handled-state object metadata was not accepted"

default_repo="$(run_state_default_repo default-repo-origin 99017)"
jq -e '
	.repo == "owner/repo"
	and .head_sha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
' <<<"$default_repo" >/dev/null ||
	fail "default repository discovery did not resolve origin"

empty_wrapper="$(run_state empty-review-wrapper 99018)"
jq -e '
	.latest.kind == "review_completed"
	and (.finding_rounds | length) == 0
	and (.review_items | length) == 0
	and (.open_comments | length) == 0
' <<<"$empty_wrapper" >/dev/null ||
	fail "empty Codex review wrapper was counted as a finding round"

retargeted_inline="$(run_state retargeted-inline 99019)"
jq -e '
	(.finding_rounds | length) == 1
	and (.review_items | length) == 1
	and (.open_comments | length) == 1
	and .open_comments[0].itemKey == "review-comment:200"
	and .open_comments[0].commitId == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
' <<<"$retargeted_inline" >/dev/null ||
	fail "current-head inline finding attached to an older review was hidden"

unbound="$(run_state unbound-plus-one 99002)"
jq -e '
	.latest.kind == "review_comments"
	and .latest_observed.kind == "review_comments"
	and (.open_comments | length) == 1
	and .open_comments[0].itemKey == "review-comment:201"
	and .ci.state == "success"
' <<<"$unbound" >/dev/null || fail "unbound +1 overrode an open finding"

unrelated_checks="$(run_state unrelated-checks 99020)"
jq -e '
	.ci.state == "success"
	and (.ci.checks | length) == 1
	and .ci.checks[0].name == "edge / verify"
	and .counts.check_runs == 2
' <<<"$unrelated_checks" >/dev/null ||
	fail "unrelated upstream check affected required Edge CI state"

missing_required="$(run_state missing-required-check 99023)"
jq -e '
	.ci.state == "pending"
	and (.ci.checks | length) == 1
	and .ci.checks[0].name == "edge / verify"
	and .ci.missing_required == ["Missing required"]
' <<<"$missing_required" >/dev/null ||
	fail "partially observed required check set reported success"

legacy_request="$(run_state legacy-unbound-request 99022)"
jq -e '
	.phase_not_before == "2026-08-03T10:00:00Z"
	and (.phase_sources | length) == 0
	and ([.timeline[] | select(.kind == "retrigger")] | length) == 0
' <<<"$legacy_request" >/dev/null ||
	fail "unmarked review request was admitted into the current HEAD phase"

phase_reaction="$(run_state phase-reaction 99014)"
jq -e '
	.latest_observed.kind == "approval_signal"
	and .latest_observed.boundToHead == false
	and .latest.kind == "retrigger"
	and ([.timeline[] | select(.kind == "retrigger")] | length) == 1
	and (.open_comments | length) == 0
' <<<"$phase_reaction" >/dev/null ||
	fail "same-second request-bound +1 was not preserved as completion evidence"

phase_reaction_ready_tie="$(run_state phase-reaction-ready-tie 99030)"
jq -e '
	.is_draft == false
	and .phase_not_before == "2026-08-03T10:05:00Z"
	and ([.phase_sources[].source] | sort) == ["ready-for-review", "review-request"]
	and ([.timeline[] | select(.kind == "approval_signal")] | length) == 0
' <<<"$phase_reaction_ready_tie" >/dev/null ||
	fail "same-second request reaction crossed a tied lifecycle boundary"

five_rounds="$(run_state five-finding-rounds 99015)"
jq -e '
	.counts.finding_rounds == 5
	and (.finding_rounds | length) == 5
	and .finding_rounds[0].reviewId == 110
	and .finding_rounds[0].commitId == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	and .finding_rounds[4].reviewId == 114
	and .finding_rounds[4].commitId == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	and (.open_comments | length) == 1
' <<<"$five_rounds" >/dev/null ||
	fail "complete PR finding-round history was not counted"

ready_pass="$(run_state bound-pass-ready 99003)"
jq -e '
	.is_draft == false
	and .phase_not_before == "2026-08-03T10:05:00Z"
	and .phase_sources[0].source == "ready-for-review"
	and .latest.kind == "approved"
	and .latest.boundToHead == true
	and .latest.eventId == 403
	and .latest_observed.kind == "approval_signal"
	and (.open_comments | length) == 0
	and .ci.state == "success"
' <<<"$ready_pass" >/dev/null || fail "ready phase did not surface a fresh SHA-bound pass"

ready_current_failure="$(run_state ready-current-failure 99031)"
jq -e '
	.is_draft == false
	and .ci.not_before == "2026-08-03T10:05:00Z"
	and .ci.state == "failure"
	and (.ci.checks | length) == 1
	and .ci.checks[0].started_at == "2026-08-03T10:05:00Z"
	and (.ci.failed | length) == 1
' <<<"$ready_current_failure" >/dev/null ||
	fail "same-second current-phase failed check was discarded"

same_second_limit="$(run_state same-second-limit 99004)"
jq -e '
	.phase_not_before == "2026-08-03T10:01:00Z"
	and .latest.kind == "limit_notice"
	and .latest.eventId == 404
	and (.open_comments | length) == 0
' <<<"$same_second_limit" >/dev/null ||
	fail "same-second usage-limit notice was lost at the phase boundary"

comment_eyes="$(run_state comment-eyes 99005)"
jq -e '
	.latest.kind == "reviewing"
	and .latest.eventId == 304
	and .latest.requestCommentId == 401
	and .latest.url == "https://github.com/owner/repo/pull/1#issuecomment-401"
	and (.open_comments | length) == 0
' <<<"$comment_eyes" >/dev/null ||
	fail "review-request comment eyes reaction was not surfaced"

same_second_pass="$(run_state same-second-pass 99006)"
jq -e '
	.latest.kind == "approved"
	and .latest.eventId == 405
	and .latest.boundToHead == true
	and (.current_head_pass_comments | length) == 1
' <<<"$same_second_pass" >/dev/null ||
	fail "same-second SHA-bound pass did not outrank review completion"

ready_stale_ci="$(run_state ready-stale-ci 99007)"
jq -e '
	.is_draft == false
	and .ci.not_before == "2026-08-03T10:05:00Z"
	and .ci.state == "none"
	and (.ci.checks | length) == 0
	and (.ci.discarded_before_not_before | length) == 1
	and .ci.discarded_before_not_before[0].conclusion == "skipped"
' <<<"$ready_stale_ci" >/dev/null ||
	fail "pre-ready skipped CI was allowed to satisfy the ready phase"

current_skipped_ci="$(run_state current-skipped-ci 99029)"
jq -e '
	.ci.not_before == "2026-08-03T10:05:00Z"
	and .ci.state == "failure"
	and (.ci.checks | length) == 1
	and .ci.checks[0].conclusion == "skipped"
	and (.ci.failed | length) == 1
' <<<"$current_skipped_ci" >/dev/null ||
	fail "current-phase skipped required check reported success"

reopened_stale_ci="$(run_state reopened-stale-ci 99008)"
jq -e '
	.is_draft == false
	and .phase_not_before == "2026-08-03T10:08:00Z"
	and .phase_sources[0].source == "reopened"
	and .latest == null
	and (.current_head_pass_comments | length) == 1
	and .ci.not_before == "2026-08-03T10:08:00Z"
	and .ci.not_before_sources[0].source == "reopened"
	and .ci.state == "none"
	and (.ci.checks | length) == 0
	and (.ci.discarded_before_not_before | length) == 1
	and .ci.discarded_before_not_before[0].conclusion == "success"
' <<<"$reopened_stale_ci" >/dev/null ||
	fail "pre-reopen successful CI was allowed to satisfy the reopened phase"

queued_current_ci="$(run_state queued-current-ci 99009)"
jq -e '
	.ci.not_before == "2026-08-03T10:05:00Z"
	and .ci.state == "pending"
	and (.ci.checks | length) == 2
	and (.ci.pending | length) == 1
	and .ci.pending[0].name == "Type Check"
	and .ci.pending[0].evidence_at == "2026-08-03T10:06:00Z"
	and .ci.pending[0].suite_id == 801
' <<<"$queued_current_ci" >/dev/null ||
	fail "current-phase queued CI check was discarded"

same_second_request_pass="$(run_state same-second-request-pass 99010)"
jq -e '
	.phase_not_before == "2026-08-03T10:02:00Z"
	and .phase_sources[0].source == "review-request"
	and .latest.kind == "approved"
	and .latest.eventId == 405
	and .latest.boundToHead == true
' <<<"$same_second_request_pass" >/dev/null ||
	fail "same-second ordered SHA-bound pass was lost at the request boundary"

same_second_limit_before_retry="$(run_state same-second-limit-before-retry 99011)"
jq -e '
	.phase_not_before == "2026-08-03T10:01:00Z"
	and .phase_sources[0].source == "review-request"
	and .latest.kind == "retrigger"
	and .latest.eventId == 401
' <<<"$same_second_limit_before_retry" >/dev/null ||
	fail "same-second pre-retry limit notice remained in the new phase"

set +e
repo_timeout_output="$(run_state_default_repo repo-timeout 99012 2>&1)"
repo_timeout_status=$?
set -e
[[ $repo_timeout_status -eq 75 ]] ||
	fail "repository discovery timeout returned $repo_timeout_status instead of 75"
[[ "$repo_timeout_output" == *"gh command timed out after 1s"* ]] ||
	fail "repository discovery timeout was not reported"

git init -q "$originless_repo"
set +e
originless_output="$(
	cd "$originless_repo"
	"$script" 99021 2>&1
)"
originless_status=$?
set -e
[[ $originless_status -eq 64 ]] ||
	fail "missing origin returned $originless_status instead of 64"
[[ "$originless_output" == *"no origin remote; pass owner/repo explicitly"* ]] ||
	fail "missing origin did not explain how to pass the repository"

: >"$counter_file"
set +e
race_output="$(run_state head-race 99013 2>&1)"
race_status=$?
set -e
[[ $race_status -eq 75 ]] || fail "HEAD race returned $race_status instead of 75"
[[ "$race_output" == *"changed during three consecutive snapshots"* ]] ||
	fail "HEAD race did not explain the unstable snapshot"

: >"$counter_file"
set +e
review_race_output="$(run_state review-race 99024 2>&1)"
review_race_status=$?
set -e
[[ $review_race_status -eq 75 ]] ||
	fail "review race returned $review_race_status instead of 75"
[[ "$review_race_output" == *"review data changed during snapshot collection"* ]] ||
	fail "review race did not reject the incoherent snapshot"

: >"$counter_file"
set +e
check_run_race_output="$(run_state check-run-race 99025 2>&1)"
check_run_race_status=$?
set -e
[[ $check_run_race_status -eq 75 ]] ||
	fail "check-run race returned $check_run_race_status instead of 75"
[[ "$check_run_race_output" == *"CI data changed during snapshot collection"* ]] ||
	fail "check-run race did not reject the incoherent snapshot"

: >"$counter_file"
set +e
check_suite_race_output="$(run_state check-suite-race 99026 2>&1)"
check_suite_race_status=$?
set -e
[[ $check_suite_race_status -eq 75 ]] ||
	fail "check-suite race returned $check_suite_race_status instead of 75"
[[ "$check_suite_race_output" == *"CI data changed during snapshot collection"* ]] ||
	fail "check-suite race did not reject the incoherent snapshot"

: >"$counter_file"
set +e
status_race_output="$(run_state status-race 99027 2>&1)"
status_race_status=$?
set -e
[[ $status_race_status -eq 75 ]] ||
	fail "commit-status race returned $status_race_status instead of 75"
[[ "$status_race_output" == *"CI data changed during snapshot collection"* ]] ||
	fail "commit-status race did not reject the incoherent snapshot"

: >"$counter_file"
set +e
signal_race_output="$(run_state signal-race 99028 2>&1)"
signal_race_status=$?
set -e
[[ $signal_race_status -eq 75 ]] ||
	fail "PR-activity race returned $signal_race_status instead of 75"
[[ "$signal_race_output" == *"PR activity data changed during snapshot collection"* ]] ||
	fail "PR-activity race did not reject the incoherent snapshot"

echo "PASS: codex-state contract fixtures"
