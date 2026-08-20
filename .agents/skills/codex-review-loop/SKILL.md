---
name: codex-review-loop
description: Drive a dsh-edge GitHub pull request through bounded, HEAD-aware Codex review and CI convergence. Use after opening or updating a PR, when review comments or CI failures arrive, while waiting for `@codex review`, or when deciding whether the current PR is ready to merge. Verify findings instead of accepting them by default, redirect non-convergent repair loops, and never merge automatically.
---

# Codex Review Loop

Advance one bounded state transition per invocation. Read one stable snapshot, handle the current blocking evidence, perform at most one necessary mutation batch or lifecycle action, then return. Do not implement a permanent polling loop.

Use [dsh-code-review](../dsh-code-review/SKILL.md) to judge the code and [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md) before every push or ready transition.

## Completion contract

Report ready to merge only when two final snapshots have the same `head_sha` and all of these conditions hold:

1. Every current-HEAD review item is fixed or rebutted, or its requested user decision has been resolved into one of those outcomes; no item requiring action remains open.
2. The current review phase has a HEAD-bound pass or a phase-correlated approval signal after the latest request or completed no-finding review.
3. The PR is not a draft; the review phase created by the ready transition has also passed.
4. CI reports `success`, or `none` has been verified as intentional under the workflow, ruleset, event, and path configuration.

Never merge the PR. Report the head SHA, review evidence, CI evidence, and any retained branch or worktree for the user to decide.

## Read a stable snapshot

Run from any checkout in the repository:

```bash
state_script="$(git rev-parse --show-toplevel)/.agents/skills/codex-review-loop/scripts/codex-state.sh"
"$state_script" <PR#> [owner/repo] [not-before-utc]
```

The sensor paginates reviews, inline comments, discussion comments, reactions, lifecycle events, Check Runs, and commit statuses. It retries when the PR head, state, or draft state changes during collection and refuses to emit mixed evidence.

Treat `latest_observed` as an observation, not necessarily proof. A bare approval reaction is not SHA-bound and never overrides a finding. Prefer `latest_strong`, `timeline`, `open_comments`, and `ci` when selecting the next action.

## Advance one tick

1. Read one snapshot. Preserve the last successful facts if collection fails.
2. Stop and report if the PR is merged or closed.
3. Read all current `open_comments` and all CI failures before changing code; group findings and failures that share a cause.
4. Triage every finding. Do not mutate until every item in the current round has a disposition.
5. Apply the convergence limits before editing, replying, pushing, requesting review, or marking ready.
6. Make one coherent fix batch, run the narrow reproducer and required DSH checks, record outcomes, commit, and push.
7. On a draft PR, request `@codex review` once for each new HEAD. On a non-draft PR, wait for the automatic review unless the HEAD did not change and every finding was rebutted.
8. After a draft pass, mark the PR ready and continue through the new ready review and CI phase.

Send review requests as standalone comments so quoted discussion does not retrigger the bot:

```bash
head_sha="$(git rev-parse HEAD)"
gh api -X POST repos/<owner>/<repo>/issues/<pr>/comments \
  -f body="@codex review

<!-- dsh-review-head: $head_sha -->"
```

The hidden full-SHA marker binds the request and its reactions to one PR head. Do not omit or copy it across commits. The sensor only aggregates the fork-required `edge / verify` check by default; set `CODEX_REVIEW_REQUIRED_CHECKS` to a newline-separated list only when the repository's required checks intentionally change.

## Triage findings

Treat each finding as a technical claim. Confirm that it targets the current HEAD, its path is reachable, its stated impact is real, and it violates a requirement, security rule, data invariant, or documented decision. Judge the problem separately from the proposed repair and inspect sibling callers or lifecycle states that share the same assumption.

Assign exactly one outcome:

- `fixed`: the claim is correct and in scope. Repair the root cause and cover the affected problem family.
- `rebutted`: the claim is stale, incorrect, unreachable, already guaranteed, or outside the PR contract. Reply with code, test, or Agent Note evidence; do not change code merely to silence it.
- `user-decision`: the claim is real, but acting on it changes product behavior, security, durable data, public APIs, or the PR's core scope. Stop mutations and request direction; keep the item open until the user's choice is implemented or rebutted.

Do not weaken assertions, hide errors, add speculative compatibility, or stack fallbacks solely to obtain approval. An item becomes handled only after its disposition, necessary code or reply, verification, and commit reference are complete.

Reply to inline findings in their threads. Reply to review-body findings in one top-level comment that links the review. State the outcome, evidence, affected family, validation, and commit when applicable; never reply only with “fixed.”

## Enforce convergence

Give each valid finding a stable problem-family label and retain family counts in the handled-state file. Record a review id in `actionableFindingRounds` only when its round contains at least one `fixed` or pending `user-decision` item; rebuttal-only rounds, waits, CI reruns, reactions, limits, and no-finding reviews do not count. Use the sensor's complete `finding_rounds` list to find unclassified rounds, not as the automatic-mutation budget by itself.

- On the second occurrence of one family, stop local patching. State one invariant, audit every affected caller and lifecycle, and use one general repair with a family-level negative test.
- On the third occurrence of one family, stop the current patching approach and perform a strategy reset. Continue autonomously only when an in-scope general replacement, rollback, split, scope reduction, or technical rebuttal is clearly safer and has family-level tests; otherwise request user direction.
- At three actionable finding rounds overall, and after every two additional actionable rounds, publish a convergence checkpoint before further mutation. Audit problem-family recurrence, whether the prior repair caused the new finding, alignment with the PR theme, material scope growth, and whether open problems are decreasing.
- After a checkpoint, continue autonomously when the remaining work is in scope and a bounded invariant-preserving repair covers a whole family. Redirect, rebut, simplify, or roll back an approach instead of accumulating local patches.
- Stop and request user direction when a repair would expand the product, security, data, or public-API contract; contradict an owning Agent Note; materially enlarge or redirect the PR; repeat after a general family repair without a safer replacement; primarily repair problems created by the previous approach; or fail to reduce open problems across two consecutive checkpoints.

Checkpoints diagnose and redirect the loop; no fixed round count alone requires human approval. Human input is reserved for unresolved scope or contract choices and genuine non-convergence.

## Record handled state

Store local state outside the commit at:

```text
$(git rev-parse --git-dir)/codex-review-loop-<PR#>.handled.json
```

Use this shape and preserve prior entries:

```json
{
  "handledItemKeys": ["review-body:123", "review-comment:456"],
  "actionableFindingRounds": [789],
  "families": {
    "session-revision-race": {
      "count": 2,
      "outcome": "fixed"
    }
  }
}
```

The sensor accepts this object and older arrays. Never add a key before its disposition, response or repair, verification, and commit reference are complete.

## Handle CI

- `failure`: read all failures for the current HEAD once. Distinguish branch defects, test-contract mistakes, flaky infrastructure, permissions, and base failures before acting.
- `pending`: wait; do not cancel or duplicate the run.
- `success`: inspect unexpected neutral or skipped required jobs before treating it as proof.
- `none`: verify workflow triggers, draft state, rulesets, and path conditions. Expected CI that has not appeared remains blocking.

Use `gh run view <run-id> --log-failed` for GitHub Actions failures. Rerun unchanged code only with evidence of flakiness or infrastructure failure.

## Finish a repair batch

Run the smallest reproducer followed by the checks selected through `dsh-pre-push-checks`. Commit with a conventional message, push normally, and verify that the remote branch equals local `HEAD`. All review and CI evidence for an older HEAD becomes stale after the push.
