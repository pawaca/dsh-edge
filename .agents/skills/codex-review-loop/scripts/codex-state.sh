#!/usr/bin/env bash
# Emit one stable, HEAD-bound observation of Codex review and CI state.
#
# Usage: codex-state.sh <pr-number> [owner/repo] [not-before-utc]
#
# The script is a sensor. It preserves raw event identity and distinguishes
# SHA-bound evidence from PR-body and review-request reactions, which do not
# carry a reviewed SHA.
# Callers decide what to fix, whether CI=none is expected, and when to advance.
set -euo pipefail

usage() {
	echo "usage: $0 <pr-number> [owner/repo] [not-before-utc]" >&2
	exit 64
}

[[ $# -ge 1 && $# -le 3 ]] || usage

PR="$1"
REPO="${2:-}"
NOT_BEFORE="${3:-}"
BOT="chatgpt-codex-connector[bot]"
GH_TIMEOUT_SECONDS="${CODEX_REVIEW_GH_TIMEOUT_SECONDS:-90}"
REQUIRED_CHECK_NAMES="${CODEX_REVIEW_REQUIRED_CHECKS:-edge / verify}"

[[ "$PR" =~ ^[0-9]+$ ]] || usage
if [[ -n "$NOT_BEFORE" ]]; then
	[[ "$NOT_BEFORE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || usage
	jq -en --arg value "$NOT_BEFORE" '$value | fromdateiso8601' >/dev/null || usage
fi
[[ "$GH_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] && ((GH_TIMEOUT_SECONDS >= 1)) || usage
REQUIRED_CHECKS_JSON="$(printf '%s\n' "$REQUIRED_CHECK_NAMES" | jq -Rsc 'split("\n") | map(select(length > 0))')"
jq -en --argjson checks "$REQUIRED_CHECKS_JSON" \
	'$checks | type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' \
	>/dev/null || usage

run_gh() {
	set +e
	perl -e 'alarm shift; exec @ARGV; exit 127' "$GH_TIMEOUT_SECONDS" gh "$@"
	local status=$?
	set -e
	if ((status == 142)); then
		echo "codex-state: gh command timed out after ${GH_TIMEOUT_SECONDS}s" >&2
		return 75
	fi
	return "$status"
}

if [[ -z "$REPO" ]]; then
	if ! ORIGIN_URL="$(git remote get-url origin 2>/dev/null)"; then
		echo "codex-state: no origin remote; pass owner/repo explicitly" >&2
		exit 64
	fi
	REPO="$(run_gh repo view "$ORIGIN_URL" --json nameWithOwner --jq .nameWithOwner)"
fi
[[ "$REPO" == */* ]] || usage

snapshot_tmp="$(mktemp -d "${TMPDIR:-/tmp}/codex-review-state.XXXXXX")"
cleanup() {
	rm -rf -- "$snapshot_tmp"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fetch_pages() {
	local endpoint="$1"
	local output="$2"
	local pages="$output.pages"

	run_gh api --paginate --slurp "$endpoint" >"$pages"
	jq -e '
		if type != "array" or any(.[]; type != "array") then
			error("expected an array of GitHub API pages")
		else
			add // []
		end
	' "$pages" >"$output"
}

fetch_check_runs() {
	local endpoint="$1"
	local output="$2"
	local pages="$output.pages"

	run_gh api --paginate --slurp "$endpoint" >"$pages"
	jq -e '
		if type != "array"
		   or any(.[]; type != "object" or (.check_runs | type) != "array") then
			error("expected GitHub check-run page objects")
		else
			[.[].check_runs[]]
		end
	' "$pages" >"$output"
}

fetch_check_suites() {
	local check_runs="$1"
	local output="$2"
	local suite_id suite_file

	printf '[]\n' >"$output"
	jq -r '[.[] | .check_suite.id // empty] | unique[]' "$check_runs" |
		while IFS= read -r suite_id; do
			suite_file="$snapshot_tmp/check-suite-$suite_id.json"
			run_gh api "repos/$REPO/check-suites/$suite_id" >"$suite_file"
			jq -s '.[0] + [.[1]]' "$output" "$suite_file" >"$output.next"
			mv "$output.next" "$output"
		done
}

fetch_review_request_reactions() {
	local comments="$1"
	local head_sha="$2"
	local output="$3"
	local comment_id comment_url reaction_file annotated_file

	printf '[]\n' >"$output"
	while IFS=$'\t' read -r comment_id comment_url; do
		reaction_file="$snapshot_tmp/request-reactions-$comment_id.json"
		annotated_file="$snapshot_tmp/request-reactions-$comment_id.annotated.json"
		fetch_pages \
			"repos/$REPO/issues/comments/$comment_id/reactions?per_page=100" \
			"$reaction_file"
		jq --argjson commentId "$comment_id" --arg commentUrl "$comment_url" '
			map(. + {
				request_comment_id: $commentId,
				request_comment_url: $commentUrl
			})
		' "$reaction_file" >"$annotated_file"
		jq -s 'add' "$output" "$annotated_file" >"$output.next"
		mv "$output.next" "$output"
	done < <(jq -r --arg bot "$BOT" --arg head "$head_sha" '
		[.[]
		 | select(
			 .user.login != $bot
			 and ((.body // "") | test("^\\s*@codex\\s+review(?:\\s|$)"; "im"))
			 and ((.body // "") | test("<!--\\s*dsh-review-head:\\s*" + $head + "\\s*-->"; "i"))
		 )]
		| sort_by([.created_at, .id])
		| if length == 0 then empty else (.[-1] | [.id, .html_url] | @tsv) end
	' "$comments")
}

same_collection() {
	local before="$1"
	local after="$2"

	jq -e --slurpfile previous "$before" '
		def canonical:
			sort_by([.id // 0, .node_id // "", .created_at // "", .context // ""]);
		canonical == ($previous[0] | canonical)
	' "$after" >/dev/null
}

attempt=1
stable=false
while ((attempt <= 3)); do
	run_gh pr view "$PR" --repo "$REPO" \
		--json state,headRefOid,isDraft,createdAt,updatedAt >"$snapshot_tmp/pr-before.json"
	HEAD_SHA="$(jq -er '.headRefOid' "$snapshot_tmp/pr-before.json")"
	PR_STATE_BEFORE="$(jq -er '.state' "$snapshot_tmp/pr-before.json")"
	PR_DRAFT_BEFORE="$(jq -r '.isDraft' "$snapshot_tmp/pr-before.json")"
	PR_CREATED_AT_BEFORE="$(jq -er '.createdAt' "$snapshot_tmp/pr-before.json")"
	PR_UPDATED_AT_BEFORE="$(jq -er '.updatedAt' "$snapshot_tmp/pr-before.json")"
	[[ "$PR_DRAFT_BEFORE" == true || "$PR_DRAFT_BEFORE" == false ]] || {
		echo "codex-state: GitHub returned an invalid draft state" >&2
		exit 65
	}

	run_gh api "repos/$REPO/commits/$HEAD_SHA" >"$snapshot_tmp/head-commit.json"
	fetch_pages "repos/$REPO/issues/$PR/reactions?per_page=100" "$snapshot_tmp/reactions.json"
	fetch_pages "repos/$REPO/pulls/$PR/reviews?per_page=100" "$snapshot_tmp/reviews.json"
	fetch_pages "repos/$REPO/pulls/$PR/comments?per_page=100" "$snapshot_tmp/review-comments.json"
	fetch_pages "repos/$REPO/issues/$PR/comments?per_page=100" "$snapshot_tmp/discussion-comments.json"
	fetch_pages "repos/$REPO/issues/$PR/timeline?per_page=100" "$snapshot_tmp/lifecycle-events.json"
	fetch_check_runs \
		"repos/$REPO/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100" \
		"$snapshot_tmp/check-runs.json"
	fetch_check_suites \
		"$snapshot_tmp/check-runs.json" \
		"$snapshot_tmp/check-suites.json"
	fetch_pages \
		"repos/$REPO/commits/$HEAD_SHA/statuses?per_page=100" \
		"$snapshot_tmp/commit-statuses.json"

	# Refresh cheap signals after slower review and CI reads.
	fetch_pages "repos/$REPO/issues/$PR/reactions?per_page=100" "$snapshot_tmp/reactions.json"
	fetch_pages "repos/$REPO/issues/$PR/comments?per_page=100" "$snapshot_tmp/discussion-comments.json"
	fetch_review_request_reactions \
		"$snapshot_tmp/discussion-comments.json" \
		"$HEAD_SHA" \
		"$snapshot_tmp/request-reactions.json"
	run_gh pr view "$PR" --repo "$REPO" \
		--json state,headRefOid,isDraft,createdAt,updatedAt >"$snapshot_tmp/pr-after.json"

	HEAD_AFTER="$(jq -er '.headRefOid' "$snapshot_tmp/pr-after.json")"
	PR_STATE_AFTER="$(jq -er '.state' "$snapshot_tmp/pr-after.json")"
	PR_DRAFT_AFTER="$(jq -r '.isDraft' "$snapshot_tmp/pr-after.json")"
	PR_CREATED_AT_AFTER="$(jq -er '.createdAt' "$snapshot_tmp/pr-after.json")"
	PR_UPDATED_AT_AFTER="$(jq -er '.updatedAt' "$snapshot_tmp/pr-after.json")"
	[[ "$PR_DRAFT_AFTER" == true || "$PR_DRAFT_AFTER" == false ]] || {
		echo "codex-state: GitHub returned an invalid draft state" >&2
		exit 65
	}
	if [[ "$HEAD_SHA" == "$HEAD_AFTER" &&
		"$PR_STATE_BEFORE" == "$PR_STATE_AFTER" &&
		"$PR_DRAFT_BEFORE" == "$PR_DRAFT_AFTER" &&
		"$PR_CREATED_AT_BEFORE" == "$PR_CREATED_AT_AFTER" &&
		"$PR_UPDATED_AT_BEFORE" == "$PR_UPDATED_AT_AFTER" ]]; then
		stable=true
		break
	fi
	attempt=$((attempt + 1))
done

if [[ "$stable" != true ]]; then
	echo "codex-state: PR state changed during three consecutive snapshots; retry later" >&2
	exit 75
fi

# A pass comment contains only an abbreviated SHA. Resolve it through GitHub so
# a prefix collision or a stale delayed comment cannot be treated as approval.
resolved_pass_commits="$snapshot_tmp/resolved-pass-commits.json"
printf '[]\n' >"$resolved_pass_commits"
jq -r --arg bot "$BOT" '
	map(select(
		.user.login == $bot
		and ((.body // "") | test("^\\s*Codex Review:\\s*Didn.t find any major issues\\."; "im"))
	))
	| map(
		[try ((.body // "")
			| capture("\\*\\*Reviewed commit:\\*\\*\\s+`(?<sha>[0-9a-f]{7,40})`"; "i").sha)
		 catch empty]
		| if length == 0 then empty else (.[0] | ascii_downcase) end
	)
	| unique[]
' "$snapshot_tmp/discussion-comments.json" |
	while IFS= read -r prefix; do
		[[ "$HEAD_AFTER" == "$prefix"* ]] || continue
		resolved_commit="$snapshot_tmp/resolved-commit-$prefix.json"
		run_gh api "repos/$REPO/commits/$prefix" >"$resolved_commit"
		resolved_sha="$(jq -er '.sha | ascii_downcase' "$resolved_commit")"
		jq --arg prefix "$prefix" --arg sha "$resolved_sha" \
			'. + [{prefix: $prefix, sha: $sha}]' \
			"$resolved_pass_commits" >"$resolved_pass_commits.next"
		mv "$resolved_pass_commits.next" "$resolved_pass_commits"
	done

# Double-collect every mutable input consumed below. A snapshot is accepted
# only when the second collection matches the first and PR metadata still
# identifies the same activity watermark.
fetch_pages "repos/$REPO/issues/$PR/reactions?per_page=100" "$snapshot_tmp/reactions-final.json"
fetch_pages "repos/$REPO/pulls/$PR/reviews?per_page=100" "$snapshot_tmp/reviews-final.json"
fetch_pages "repos/$REPO/pulls/$PR/comments?per_page=100" "$snapshot_tmp/review-comments-final.json"
fetch_pages "repos/$REPO/issues/$PR/comments?per_page=100" "$snapshot_tmp/discussion-comments-final.json"
fetch_pages "repos/$REPO/issues/$PR/timeline?per_page=100" "$snapshot_tmp/lifecycle-events-final.json"
fetch_review_request_reactions \
	"$snapshot_tmp/discussion-comments-final.json" \
	"$HEAD_SHA" \
	"$snapshot_tmp/request-reactions-final.json"
fetch_check_runs \
	"repos/$REPO/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100" \
	"$snapshot_tmp/check-runs-final.json"
fetch_check_suites \
	"$snapshot_tmp/check-runs-final.json" \
	"$snapshot_tmp/check-suites-final.json"
fetch_pages \
	"repos/$REPO/commits/$HEAD_SHA/statuses?per_page=100" \
	"$snapshot_tmp/commit-statuses-final.json"
run_gh pr view "$PR" --repo "$REPO" \
	--json state,headRefOid,isDraft,createdAt,updatedAt >"$snapshot_tmp/pr-final.json"
if ! jq -e --slurpfile before "$snapshot_tmp/pr-after.json" '
	.state == $before[0].state
	and .headRefOid == $before[0].headRefOid
	and .isDraft == $before[0].isDraft
	and .createdAt == $before[0].createdAt
	and .updatedAt == $before[0].updatedAt
' "$snapshot_tmp/pr-final.json" >/dev/null; then
	echo "codex-state: PR state changed while resolving reviewed commit; retry later" >&2
	exit 75
fi
if ! same_collection "$snapshot_tmp/reviews.json" "$snapshot_tmp/reviews-final.json" ||
	! same_collection "$snapshot_tmp/review-comments.json" "$snapshot_tmp/review-comments-final.json"; then
	echo "codex-state: review data changed during snapshot collection; retry later" >&2
	exit 75
fi
if ! same_collection "$snapshot_tmp/check-runs.json" "$snapshot_tmp/check-runs-final.json" ||
	! same_collection "$snapshot_tmp/check-suites.json" "$snapshot_tmp/check-suites-final.json" ||
	! same_collection "$snapshot_tmp/commit-statuses.json" "$snapshot_tmp/commit-statuses-final.json"; then
	echo "codex-state: CI data changed during snapshot collection; retry later" >&2
	exit 75
fi
if ! same_collection "$snapshot_tmp/reactions.json" "$snapshot_tmp/reactions-final.json" ||
	! same_collection "$snapshot_tmp/discussion-comments.json" "$snapshot_tmp/discussion-comments-final.json" ||
	! same_collection "$snapshot_tmp/lifecycle-events.json" "$snapshot_tmp/lifecycle-events-final.json" ||
	! same_collection "$snapshot_tmp/request-reactions.json" "$snapshot_tmp/request-reactions-final.json"; then
	echo "codex-state: PR activity data changed during snapshot collection; retry later" >&2
	exit 75
fi

handled_file="$(git rev-parse --git-dir 2>/dev/null || printf '.git')/codex-review-loop-$PR.handled.json"
if [[ -f "$handled_file" ]]; then
	jq -e '
		if type == "array" then
			map(
				if type == "number" then "review-comment:" + tostring
				elif type == "string" then .
				else empty end
			)
		elif type == "object" then
			((.handledItemKeys // [])
			 + ((.ids // []) | map("review-comment:" + tostring)))
			| unique
		else
			error("handled state must be an array or object")
		end
	' "$handled_file" >"$snapshot_tmp/handled-keys.json"
else
	printf '[]\n' >"$snapshot_tmp/handled-keys.json"
fi

HEAD_COMMITTED_AT="$(jq -er '.commit.committer.date' "$snapshot_tmp/head-commit.json")"
SAMPLED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

jq -n \
	--arg bot "$BOT" \
	--argjson pr "$PR" \
	--arg repo "$REPO" \
	--arg head "$HEAD_AFTER" \
	--arg headCommittedAt "$HEAD_COMMITTED_AT" \
	--arg prCreatedAt "$PR_CREATED_AT_AFTER" \
	--arg explicitNotBefore "$NOT_BEFORE" \
	--arg prState "$PR_STATE_AFTER" \
	--argjson prIsDraft "$PR_DRAFT_AFTER" \
	--argjson requiredChecks "$REQUIRED_CHECKS_JSON" \
	--arg sampledAt "$SAMPLED_AT" \
	--slurpfile reviews "$snapshot_tmp/reviews.json" \
	--slurpfile reviewComments "$snapshot_tmp/review-comments.json" \
	--slurpfile discussionComments "$snapshot_tmp/discussion-comments.json" \
	--slurpfile lifecycleEvents "$snapshot_tmp/lifecycle-events.json" \
	--slurpfile reactions "$snapshot_tmp/reactions.json" \
	--slurpfile requestReactions "$snapshot_tmp/request-reactions.json" \
	--slurpfile resolvedPassCommits "$resolved_pass_commits" \
	--slurpfile handledKeys "$snapshot_tmp/handled-keys.json" \
	--slurpfile checkRuns "$snapshot_tmp/check-runs.json" \
	--slurpfile checkSuites "$snapshot_tmp/check-suites.json" \
	--slurpfile commitStatuses "$snapshot_tmp/commit-statuses.json" '
	def is_review_request:
		(.body // "") | test("^\\s*@codex\\s+review(?:\\s|$)"; "im");

	def review_request_head:
		[try ((.body // "")
			| capture("<!--\\s*dsh-review-head:\\s*(?<sha>[0-9a-f]{40})\\s*-->"; "i").sha)
		 catch empty]
		| if length == 0 then null else (.[0] | ascii_downcase) end;

	def is_review_request_for($commit):
		is_review_request
		and review_request_head == ($commit | ascii_downcase);

	def is_usage_limit:
		(.body // "")
		| test("usage\\s+limits?\\s+(?:has|have)\\s+been\\s+reached"; "i");

	def reviewed_commit_prefix:
		[try ((.body // "")
			| capture("\\*\\*Reviewed commit:\\*\\*\\s+`(?<sha>[0-9a-f]{7,40})`"; "i").sha)
		 catch empty]
		| if length == 0 then null else (.[0] | ascii_downcase) end;

	def is_sha_bound_pass:
		((.body // "")
		 | test("^\\s*Codex Review:\\s*Didn.t find any major issues\\."; "im"))
		and (reviewed_commit_prefix != null);

	def reviewed_commit_matches($commit):
		reviewed_commit_prefix as $prefix
		| $prefix != null
		  and any($resolvedPassCommits[0][];
			.prefix == $prefix and .sha == ($commit | ascii_downcase));

	def actionable_review_body:
		(.body // "")
		| (split("<details")[0] // "")
		| split("\n")
		| map(select(
			(test("^\\s*$") | not)
			and (test("^\\s*###\\s+💡 Codex Review\\s*$"; "i") | not)
			and (test("^\\s*Here are some automated review suggestions for this pull request\\.\\s*$"; "i") | not)
			and (test("^\\s*\\*\\*Reviewed commit:\\*\\*\\s+`[0-9a-f]+`\\s*$"; "i") | not)
		))
		| join("\n");

	def priority:
		try ((.body // "") | capture("badge/(?<p>P[0-9])").p) catch "P?";

	def actions_run_id($url):
		($url // "") as $value
		| if ($value | test("/actions/runs/[0-9]+")) then
			try ($value | capture("/actions/runs/(?<id>[0-9]+)").id) catch null
		  else null end;

	def ci_passes:
		if .source == "check-run" then
			.status == "completed"
			and (.conclusion == "success"
				or .conclusion == "neutral")
		else
			.state == "success"
		end;

	def ci_pending:
		if .source == "check-run" then .status != "completed"
		else .state == "pending"
		end;

	def ci_skipped:
		.source == "check-run"
		and .status == "completed"
		and .conclusion == "skipped";

	def ci_after_boundary($boundary):
		if $boundary == null then true
		elif ci_pending then
			(.evidence_at == null or .evidence_at >= $boundary)
		elif ci_skipped then
			(.phase_proof_at != null and .phase_proof_at > $boundary)
		else
			(.phase_proof_at != null and (
				.phase_proof_at > $boundary
				or (
					.phase_proof_at == $boundary
					and .completion_proof_at != null
					and .completion_proof_at > $boundary
				)
			))
		end;

	def reaction_after_phase($boundary; $boundaryActive; $sources):
		if .created_at > $boundary then true
		elif .created_at < $boundary then false
		elif $boundaryActive then
			.request_comment_id != null
			and all($sources[]; .source == "review-request" and .eventId != null)
			and .request_comment_id == ([$sources[].eventId] | max)
		else true
		end;

	(($reactions[0] + $requestReactions[0]) | unique_by(.id)) as $allReactions
	| ([
		{
			at: $prCreatedAt,
			source: "pr-created",
			eventKey: ("pr-created:" + $prCreatedAt)
		},
		($lifecycleEvents[0][]
		 | select(
			 (.event == "ready_for_review" or .event == "reopened")
			 and .created_at != null
		 )
		 | {
			at: .created_at,
			source: .event,
			eventKey: ("timeline:" + ((.id // .node_id // .created_at) | tostring))
		   })
	  ] | sort_by([.at, .eventKey])) as $ciPhaseEvents
	| ([$ciPhaseEvents[].at] | max) as $ciNotBefore
	| ($ciPhaseEvents | map(select(.at == $ciNotBefore))) as $ciNotBeforeSources
	| ([
		(if $explicitNotBefore == "" then empty else {
			at: $explicitNotBefore,
			source: "explicit-not-before",
			eventKey: ("explicit:" + $explicitNotBefore)
		} end),
		($lifecycleEvents[0][]
		 | select(
			 (.event == "ready_for_review" or .event == "reopened")
			 and .created_at != null
		   )
		 | {
			at: .created_at,
			source: (if .event == "ready_for_review" then "ready-for-review" else "reopened" end),
			eventKey: ("timeline:" + ((.id // .node_id // .created_at) | tostring))
		   }),
		($discussionComments[0][]
		 | select(.user.login != $bot and is_review_request_for($head) and .created_at != null)
		 | {
			at: .created_at,
			source: "review-request",
			eventKey: ("issue-comment:" + (.id | tostring)),
			eventId: .id
		   })
	] | sort_by([.at, .eventKey])) as $phaseEvents
	| (([$headCommittedAt] + [$phaseEvents[].at]) | max) as $resultAfter
	| (any($phaseEvents[]; .at == $resultAfter)) as $phaseBoundaryActive
	| ($phaseEvents | map(select(.at == $resultAfter))) as $phaseSources
	| ($reviews[0]
	   | map(select(
		   .user.login == $bot
		   and .submitted_at != null
		 ))
	   | unique_by(.id)
	   | sort_by([.submitted_at, .id])) as $allCodexReviews
	| ([
		$allCodexReviews[]
		| . as $review
		| ($review | actionable_review_body) as $body
		| select(
			($body | test("\\S"))
			or any($reviewComments[0][];
				.user.login == $bot
				and .in_reply_to_id == null
				and .pull_request_review_id == $review.id)
		  )
		| {
			reviewId: .id,
			commitId: .commit_id,
			submittedAt: .submitted_at,
			url: .html_url
		  }
	  ]) as $findingRounds
	| ($allCodexReviews
	   | map(select(.commit_id == $head))) as $headReviews
	| ($headReviews | map(.id)) as $headReviewIds
	| ([
		$headReviews[]
		| . as $review
		| ($review | actionable_review_body) as $body
		| select($body | test("\\S"))
		| {
			itemKey: ("review-body:" + ($review.id | tostring)),
			kind: "review-body",
			id: $review.id,
			reviewId: $review.id,
			commitId: $review.commit_id,
			path: null,
			line: null,
			priority: ({body: $body} | priority),
			createdAt: $review.submitted_at,
			url: $review.html_url,
			body: $body,
			rawBody: $review.body
		  }
	  ]) as $reviewBodyItems
	| ($reviewComments[0]
	   | map(select(
		   .user.login == $bot
		   and .in_reply_to_id == null
		   and (
			   .commit_id == $head
			   or (.pull_request_review_id as $rid | ($headReviewIds | index($rid)) != null)
		   )
		 ))
	   | sort_by(.id)
	   | map({
		   itemKey: ("review-comment:" + (.id | tostring)),
		   kind: "inline-comment",
		   id,
		   reviewId: .pull_request_review_id,
		   commitId: .commit_id,
		   originalCommitId: .original_commit_id,
		   path,
		   line: (.line // .original_line),
		   side,
		   priority: priority,
		   createdAt: .created_at,
		   url: .html_url,
		   body
		 })) as $inlineItems
	| (($reviewBodyItems + $inlineItems) | sort_by([.createdAt, .itemKey])) as $reviewItems
	| ($reviewItems
	   | map(select(.itemKey as $key | ($handledKeys[0] | index($key)) == null))) as $openReviewItems
	| ($discussionComments[0]
	   | map(select(
		   .user.login == $bot
		   and is_sha_bound_pass
		   and reviewed_commit_matches($head)
		   and .created_at != null
		 ))
	   | sort_by(.id)) as $currentHeadPassComments
	| ([
		($discussionComments[0][]
		 | select(
			 .user.login != $bot
			 and is_review_request_for($head)
			 and .created_at >= $resultAfter
		   )
		 | {
			 t: .created_at,
			 kind: "retrigger",
			 priority: 1,
			 source: "issue-comment:@codex-review",
			 eventKey: ("issue-comment:" + (.id | tostring)),
			 eventId: .id,
			 author: .user.login,
			 url: .html_url
		   }),
		($allReactions[]
		 | select(
			 .user.login == $bot
			 and .content == "eyes"
			 and .created_at != null
			 and reaction_after_phase($resultAfter; $phaseBoundaryActive; $phaseSources)
		   )
		 | {
			 t: .created_at,
			 kind: "reviewing",
			 priority: 2,
			 source: "reaction:eyes",
			 eventKey: ("reaction:" + (.id | tostring)),
			 eventId: .id,
			 url: (.request_comment_url // null),
			 requestCommentId: (.request_comment_id // null)
		   }),
		($allReactions[]
		 | select(
			 .user.login == $bot
			 and .content == "+1"
			 and .request_comment_id != null
			 and .created_at != null
			 and reaction_after_phase($resultAfter; $phaseBoundaryActive; $phaseSources)
		   )
		 | {
			 t: .created_at,
			 kind: "approval_signal",
			 priority: 3,
			 source: "reaction:+1-request",
			 eventKey: ("reaction:" + (.id | tostring)),
			 eventId: .id,
			 boundToHead: false,
			 url: (.request_comment_url // null),
			 requestCommentId: (.request_comment_id // null)
		   }),
		($currentHeadPassComments[]
		 | . as $pass
		 | select(
			 if .created_at > $resultAfter then true
			 elif .created_at < $resultAfter then false
			 elif $phaseBoundaryActive then
				all($phaseSources[];
					.source == "review-request"
					and .eventId != null
					and $pass.id > .eventId)
			 else true end
		   )
		 | {
			 t: .created_at,
			 kind: "approved",
			 priority: 5,
			 source: "issue-comment:codex-pass",
			 eventKey: ("issue-comment:" + (.id | tostring)),
			 eventId: .id,
			 commitIdPrefix: reviewed_commit_prefix,
			 url: .html_url,
			 boundToHead: true
		   }),
		($discussionComments[0][]
		 | . as $notice
		 | select(
			 .user.login == $bot
			 and is_usage_limit
			 and .created_at != null
			 and (
				 if .created_at > $resultAfter then true
				 elif .created_at < $resultAfter then false
				 elif $phaseBoundaryActive then
					if all($phaseSources[];
						.source == "review-request" and .eventId != null)
					then all($phaseSources[]; $notice.id > .eventId)
					else true end
				 else true end
			 )
		   )
		 | {
			 t: .created_at,
			 kind: "limit_notice",
			 priority: 7,
			 source: "issue-comment:usage-limit",
			 eventKey: ("issue-comment:" + (.id | tostring)),
			 eventId: .id,
			 url: .html_url,
			 body: .body
		   }),
		($headReviews[]
		 | . as $review
		 | select(
			 if $phaseBoundaryActive then .submitted_at > $resultAfter
			 else .submitted_at >= $resultAfter end
		   )
		 | (any($reviewItems[]; .reviewId == $review.id)) as $hasFindings
		 | {
			 t: .submitted_at,
			 kind: (if $hasFindings then "review_comments" else "review_completed" end),
			 priority: (if $hasFindings then 6 else 4 end),
			 source: "pull-request-review",
			 eventKey: ("review:" + (.id | tostring)),
			 eventId: .id,
			 reviewId: .id,
			 commitId: .commit_id,
			 url: .html_url
		   })
	  ] | sort_by([.t, .priority, .eventKey])) as $timeline
	| ($timeline | if length == 0 then null else .[-1] end) as $latestObserved
	| ($timeline
	   | map(select(.kind != "approval_signal"))
	   | if length == 0 then null else .[-1] end) as $latestStrong
	| ($commitStatuses[0]
	   | sort_by([.context // "", .updated_at // .created_at // "", .id // 0])
	   | group_by(.context // "")
	   | map(.[-1])) as $latestCommitStatuses
	| ($checkSuites[0]
	   | map({key: (.id | tostring), value: .})
	   | from_entries) as $checkSuitesById
	| ([
		($checkRuns[0][]
		 | select(.name as $name | ($requiredChecks | index($name)) != null)
		 | (.check_suite.id // null) as $suiteId
		 | (if $suiteId == null then null
			else ($checkSuitesById[($suiteId | tostring)] // null) end) as $suite
		 | (.details_url // .html_url // null) as $url
		 | (.app.slug // .app.name // "unknown") as $provider
		 | actions_run_id($url) as $runId
		 | {
			 source: "check-run",
			 key: ("check-run:" + (.id | tostring)),
			 logicalKey: ("check-run:" + $provider + ":" + (.name // "")),
			 name,
			 type: (if $runId == null then "external" else "actions" end),
			 run_id: $runId,
			 status,
			 conclusion,
			 url: $url,
			 evidence_at: ($suite.created_at // .started_at // .completed_at),
			 phase_proof_at: .started_at,
			 completion_proof_at: .completed_at,
			 suite_id: $suiteId,
			 suite_created_at: ($suite.created_at // null),
			 started_at: .started_at,
			 completed_at: .completed_at
		   }),
		($latestCommitStatuses[]
		 | select(.context as $name | ($requiredChecks | index($name)) != null)
		 | (.target_url // null) as $url
		 | actions_run_id($url) as $runId
		 | {
			 source: "commit-status",
			 key: ("commit-status:" + (.id | tostring)),
			 logicalKey: ("commit-status:" + (.context // "")),
			 name: .context,
			 type: (if $runId == null then "external" else "actions" end),
			 run_id: $runId,
			 state,
			 description,
			 url: $url,
			 evidence_at: .created_at,
			 phase_proof_at: .created_at,
			 completion_proof_at: .updated_at,
			 created_at: .created_at,
			 updated_at: .updated_at
		   })
	  ] | sort_by([.logicalKey, .key])) as $observedChecks
	| [$observedChecks[] | select(ci_after_boundary($ciNotBefore))] as $checks
	| ($checks | map(.name) | unique) as $observedRequiredNames
	| ($requiredChecks - $observedRequiredNames) as $missingRequiredChecks
	| {
		version: 2,
		sampled_at: $sampledAt,
		pr: $pr,
		repo: $repo,
		pr_state: $prState,
		is_draft: $prIsDraft,
		head_sha: $head,
		head_committed_at: $headCommittedAt,
		phase_not_before: $resultAfter,
		phase_boundary_active: $phaseBoundaryActive,
		phase_sources: $phaseSources,
		timeline: $timeline,
		latest: $latestStrong,
		latest_strong: $latestStrong,
		latest_observed: $latestObserved,
		finding_rounds: $findingRounds,
		review_items: $reviewItems,
		open_comments: $openReviewItems,
		current_head_pass_comments:
			($currentHeadPassComments | map({
				id,
				created_at,
				commit_id_prefix: reviewed_commit_prefix,
				url: .html_url
			})),
		unbound_approval_signals:
			($allReactions
			 | map(select(.user.login == $bot and .content == "+1"))
			 | sort_by(.id)
			 | map({
				 id,
				 created_at,
				 eventKey: ("reaction:" + (.id | tostring))
			   })),
		ci:
			({
				not_before: $ciNotBefore,
				not_before_sources: $ciNotBeforeSources,
				checks: $checks,
				missing_required: $missingRequiredChecks,
				discarded_before_not_before:
					(if $ciNotBefore == null then []
					 else [$observedChecks[]
						 | select((ci_after_boundary($ciNotBefore)) | not)]
					 end),
				failed: [$checks[] | select((ci_passes or ci_pending) | not)],
				pending: [$checks[] | select(ci_pending)]
			 }
			 | .state =
				(if ($checks | length) == 0 then "none"
				 elif (.failed | length) > 0 then "failure"
				 elif (.pending | length) > 0 or (.missing_required | length) > 0 then "pending"
				 else "success" end)),
		counts: {
			finding_rounds: ($findingRounds | length),
			reviews: ($headReviews | length),
			review_items: ($reviewItems | length),
			open_review_items: ($openReviewItems | length),
			pass_comments: ($currentHeadPassComments | length),
			check_runs: ($checkRuns[0] | length),
			commit_statuses: ($latestCommitStatuses | length)
		}
	  }
'
