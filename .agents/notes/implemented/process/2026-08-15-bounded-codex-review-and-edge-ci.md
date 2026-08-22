# Agent Note: Bound Codex review and Edge CI

Status: implemented

Repository-structure and inherited-workflow details in this note are superseded by the [implemented standalone wrapper architecture](../architecture/2026-08-19-dsh-edge-standalone-wrapper.md). The bounded review-loop and Edge CI decisions remain in force.

English | [中文](2026-08-15-bounded-codex-review-and-edge-ci.zh.md)

## Problem

The fork needs a pull-request check that runs without the upstream repository's private runner pools and a repeatable way to determine whether Codex reviewed the current commit. Treating every automated finding as an instruction can expand a change or weaken an existing decision, while an unbounded fix-and-review cycle can accumulate patches without converging.

## Decision

Current CI topology refines the original single-job description below: the full Linux release-contract job and a focused Windows installer-security job run in parallel, then a small `edge / verify` gate requires both results. The Windows job installs repository dependencies and runs only the installer suite; it does not rebuild Worker artifacts, install a browser, deploy, or access credentials. This catches Windows ACL and process-lifecycle failures before a release tag reaches the Windows publication verifier while preserving the established required-check name.

The `Edge CI` workflow runs one `edge / verify` job on a standard GitHub-hosted Ubuntu runner for non-draft pull requests, pushes to `main`, and manual dispatches. It builds the upstream Web assets once, then validates documentation, lints against those built host declarations, exercises workflow and review-state contracts, tests and type-checks the Edge runtime, snapshots the assembled runtime and browser path, and verifies the packed public installer outside the workspace. Package `prepack` owns both Worker bundles and the Direct bundle's gzip size check, so the workflow does not repeat either package-owned bundle command. The Isolated bundle has no size budget. The workflow does not deploy, read provider credentials, or call a live model API. The dependency build policy permits workerd's platform-binary selector and denies just-bash's native compression addons, which Workerd cannot load.

The hosted job launches the Google Chrome supplied by the `ubuntu-latest` runner through an explicit test-only channel selection. It neither downloads a second browser nor mutates the hosted image with Playwright's system-package installer. Local runs omit that selection and continue to use the browser managed by the developer's Playwright installation.

The upstream issue-policy and lifecycle workflows remain canonical-repository automation. Their jobs run only in `deepseek-ai/deepseek-harness`, because forks neither own the upstream GitHub App credentials nor share its project configuration. Fork pull requests therefore report those jobs as skipped instead of failing before repository-owned checks run. The shared workflow contract test pins both canonical-repository guards together with the lifecycle event semantics.

The root `AGENTS.md` remains the project-instruction source. `CLAUDE.md` links to it, and `.claude/skills` links to `.agents/skills`, so Codex and Claude Code receive the same pull-request rule and skill without mirrored prose.

The `codex-review-loop` skill treats review findings as claims. Each current-HEAD item is fixed, rebutted with evidence, or escalated when it would change product, security, durable-data, public-API, or pull-request scope. Its sensor binds review and CI observations to a stable pull-request head and phase. The loop never merges.

Review requests carry a hidden full-HEAD marker. Only marked requests and their reactions enter that HEAD's review phase; ready and reopen events reset both review and CI evidence. The sensor aggregates `edge / verify` by default rather than unrelated upstream checks, while an explicit newline-separated override supports intentional future required-check changes. Every configured name must appear and pass before CI reports success. Repository discovery follows `origin`; a checkout without it must pass `owner/repo` explicitly.

Automatic mutation is bounded by adaptive convergence audits rather than a fixed-round approval gate. A second occurrence of one problem family requires an invariant and full family audit; a third forces a strategy reset before any further patch. Three actionable finding rounds, and every two thereafter, trigger a checkpoint that examines recurrence, repair-caused findings, alignment with the PR theme, scope growth, and whether open problems are decreasing. The loop may continue autonomously with one bounded family-level repair, rebuttal, simplification, or rollback. It requests user direction only when contract or scope choices remain, a general repair repeats without a safer replacement, prior repairs dominate new findings, or two checkpoints fail to reduce the problem set.

## Alternatives considered

- **Copy the complete instructions from another repository:** repository-specific branch, deployment, issue, and architecture rules would compete with the upstream DSH instructions. Links and skills add only the fork behavior.
- **Apply every Codex finding:** automated review can be stale, incorrect, out of scope, or based on an unsuitable repair. Evidence-based dispositions preserve maintainers' decisions.
- **Continue until the reviewer becomes silent:** repeated local repairs can increase complexity and generate new findings. Adaptive checkpoints require the loop to reassess its strategy and theme instead of treating reviewer silence as the objective.
- **Use only manual GitHub inspection:** manual review remains useful, but it can mix evidence from different commits or lifecycle phases. The sensor supplies a reproducible observation without deciding whether a finding is valid.
- **Install a lockfile-selected full Chromium or headless shell:** this keeps the browser revision coupled to Playwright, but browser download and system-package installation dominated and could stall the required job. The semantic snapshot accepts the runner image's maintained Chrome revision instead.
- **Remove the browser snapshot:** this would abandon the only check that boots the assembled upstream UI through the Edge protocol.
- **Run lint and each runtime bundle as independent workflow commands:** that repeats host declaration and Worker bundling work already owned by the Web build and package `prepack`. Reusing those outputs keeps one authoritative validation path.

## Consequences

- Pull requests obtain a free, fork-owned Edge check without depending on private upstream runners or Cloudflare deployment credentials.
- Draft pull requests can complete an initial Codex pass before the ready transition starts the required CI and review phase.
- Review completion means that findings were dispositioned, not necessarily accepted. Technical rebuttals are first-class handled outcomes.
- Difficult reviews expose a visible convergence assessment and may redirect themselves without requiring routine human approval. They pause only for unresolved contract, scope, or genuine non-convergence decisions.
- The sensor requires `bash`, `gh`, `jq`, and `perl`; its contract fixtures run in Edge CI. Per-PR handled and family state stays under the checkout's Git directory and is not committed.
- The sensor binds each snapshot to the PR activity watermark and double-collects every mutable GitHub input it consumes, including review, PR-activity, check-run, check-suite, and commit-status collections. It rejects a sample when either collection differs.
- A pending check observed in the lifecycle boundary's timestamp second remains pending. A completed non-skipped check or status may start in that second only when its completion or update is strictly later; a skipped check needs a strictly later start and never satisfies the fork gate.
- A reaction tied to the latest tagged review-request comment may count in the same timestamp second because the comment ID proves its phase; the sensor rejects that equality when a ready or reopen event shares the boundary.
- A no-finding review wrapper does not consume the mutation budget, while unresolved inline findings that GitHub retargets onto the current HEAD remain visible even when their parent review references an older commit.
- `edge / verify` covers the fork's Edge runtime, its assembled browser path, and repository documentation and lint checks. It does not replace the upstream platform, coverage, cross-browser, Windows, or release matrix.
- Edge CI no longer provisions or caches a browser. Runner-image Chrome updates can change browser behavior or ARIA output independently of the lockfile; the resulting snapshot failure makes that change explicit for review. Package `prepack` remains the single CI path for validating both Worker modes.
- Upstream issue governance stays present for easy synchronization, but it is inert in the fork rather than being copied, deleted, or supplied with fork-specific credentials.
