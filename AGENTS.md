# dsh-edge repository instructions

`dsh-edge` is an independent community wrapper that runs published DeepSeek Harness packages on Cloudflare Workers. It is maintained by pawaca and is not affiliated with or endorsed by DeepSeek.

## Ownership boundary

- `apps/dsh-edge/` owns the Worker runtime, Durable Object adapters, installer, release CLI, tests, and package documentation.
- `packages/client/ui-edge/` owns the Edge-specific browser plugin.
- `apps/dsh-edge/standalone/` owns the exact upstream dependency closure, audited patches, Web assembly, and Direct/Dynamic Worker builds.
- `.agents/` owns this repository's review workflow and skills.
- Do not restore upstream monorepo source, vendored packages, examples, SDKs, native code, or development workflows. Use published packages and public extension points; use a version-bound patch only when composition cannot express the change.

## Commands

```sh
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
pnpm run check
pnpm run build
pnpm --filter dsh-edge dev
pnpm --filter dsh-edge dev:isolated
pnpm --filter dsh-edge dev:container   # needs a local Docker engine
pnpm --filter dsh-edge run test:integration
pnpm --filter dsh-edge run test:snapshot
pnpm --filter dsh-edge run test:container   # needs a local Docker engine
```

The root and standalone lockfiles serve different purposes. The root lock installs repository tests and tooling; the standalone lock is the release assembly and must build successfully before the root install in CI so parent dependencies cannot mask missing release inputs.

## Runtime and release invariants

- Keep every `@deepseek-ai/dsh-*` standalone dependency on one exact upstream version. Upgrade it only in an explicit upstream-baseline PR.
- The Container image's computerd (`apps/dsh-edge/container/Dockerfile`) and the bundled `@cloudflare/computer` form one wire-protocol pair with no negotiation; upgrade them in the same PR.
- Keep Direct and Dynamic Loader modes behaviorally aligned except for provider-gated runtime capabilities (the runtime providers in `apps/dsh-edge/src/runtime-provider.ts`, such as the command-execution backend) and each provider's Cloudflare plan requirement. A capability that only some providers offer must be absent, not broken, where its provider is unavailable.
- Preserve Durable Object class names, bindings, session/event formats, workspace/VFS state, owner authentication, and public HTTP/WebSocket behavior.
- Durable Object SQL queries on request-serving paths must not use correlated subqueries or per-row scans against unbounded tables. Pre-compute read-heavy aggregations in a materialized table maintained atomically at write time; never derive per-request summaries by scanning event or log history.
- Never log `DSH_EDGE_ACCESS_KEY`, bearer tokens, or owner cookies. Provider credentials persist only through the upstream `CredentialProvider` seam in Durable Object storage; resolved values remain request-scoped in the LLM adapter and are never logged, cached across requests, or written to session events.
- When registering a cordis sub-registry entry (e.g. `ctx.storage.backend.register(name, backend)`), call `ctx.provide(key, value)` if another plugin uses `ctx.inject([key])` to wait for it. Sub-registry `register()` methods only update internal Maps; they do not trigger cordis inject resolution. Use `ctx.effect()` to pair registration with `provide` and clean up on disposal.
- Direct mode must stay below the repository gzip budget. Release tests must start the promoted prebuilt artifacts, not source entrypoints.
- Every retained upstream patch needs a version-bound filename, a failing-without-the-patch check, a rationale, and a removal condition.
- The npm package, tag, GitHub Release, Container image tag, deployment identity, and documentation must report the same dsh-edge version.
- `apps/dsh-edge/package.json` is the only release-version source. Test assertions and snapshot expectations derive the version and npm dist-tag channel at runtime; a version bump requires no other file changes. Private workspace manifests omit `version` so they cannot imply a second product or upstream release identity.

## Durable Object database budgets

- Treat database cost as a correctness requirement in every path: normal requests, streaming, startup, migrations, cleanup, deletion, alarms, retries, recovery, and maintenance scripts. Successful SQL or correct final data alone does not prove a safe upgrade.
- The Workers Free SQLite allowance is currently 100,000 rows written and 5 million rows read per account per day, resetting at 00:00 UTC. Verify current Cloudflare pricing before operational changes; leave room for existing account usage. Never assume a deployment, transaction rollback, or point-in-time restore refunds consumed quota.
- Count affected rows, not SQL calls or final database size. DELETE consumes row writes; INSERT/UPDATE, indexes, cascades, triggers, SQLite-backed KV operations, and setAlarm can add writes. Batching reduces call overhead but does not by itself reduce billed rows.
- Before changing a persistence path, estimate its cost at realistic retained-data volume and request frequency, including retries and repeated cold starts. For bulk operations or a changed write strategy, measure SqlStorageCursor.rowsWritten/rowsRead in the Cloudflare runtime with representative local data; Node SQLite changes counts alone are not billing evidence. Keep a focused regression test for the cost growth being prevented.
- Prefer bounded incremental writes, compact streaming records, and idempotent startup. Compare the total cost of copying, deleting, rebuilding, and updating summaries before choosing a migration. Preserve atomicity and existing logs; verify failure rollback and retry without repeatedly rewriting already migrated data. Do not assume DDL is free without measuring it in the target runtime.
- Never replay a large migration or destructive cleanup against production just to benchmark it. Validate locally first; preserve a recovery point for authorized production recovery, and account for quota already consumed. If the remaining budget is unknown or insufficient, report that limitation instead of claiming an unconditional safe upgrade or silently switching to a paid plan.

## Change discipline

- Prefer the smallest Edge-owned adapter over reimplementing an upstream capability.
- Add focused unit coverage for local behavior and update the dual-mode integration or browser snapshots when a user-visible or durable path changes.
- Update English and Chinese documents together, then run `pnpm run doc-pairs -- --write`. Both languages carry equal authority.
- Keep `AGENTS.md` as the full source of truth. `CLAUDE.md` must remain a real file that directs Claude Code to this file.
- Files end with exactly one newline; `git diff --check` must pass.

## Review and publication

Use `.agents/skills/dsh-pre-push-checks/SKILL.md` before a push and `.agents/skills/codex-review-loop/SKILL.md` after opening or updating a PR. Review findings are technical claims: fix valid in-scope problems, rebut stale or incorrect claims with evidence, and ask the user only when a choice changes product, security, durable data, or public API behavior.

Review rounds are convergence checkpoints, not a fixed retry budget. On repeated problem families, audit all affected callers and replace local patches with one invariant-preserving repair. Stop only for genuine scope decisions or non-convergence. Never merge automatically.

## Release procedure

Every version published to npm must also have a matching GitHub Release and git tag. Skipping any step breaks the same-version invariant in "Runtime and release invariants".

1. **Write bilingual release notes**: create `docs/releases/<version>.md`, `docs/releases/<version>.zh.md`, and their `.i18n.yaml` pairing record, then run `pnpm run doc-pairs -- --write`.
2. **Merge the release PR** to main (squash merge).
3. **Pull main** and verify `apps/dsh-edge/package.json` version matches the intended release.
4. **Create and push a git tag**: `git tag dsh-edge-v<version> && git push origin dsh-edge-v<version>`.
5. The tag push triggers `release-edge.yml` which automatically builds, verifies, publishes to npm (trusted publishing), and creates the GitHub Release. Its `publish-image` job first pushes `docker.io/pawaca/dsh-edge-computer:<version>` (once; a rerun reuses the published image), and npm publication waits for it.
6. **Verify**: `npm view dsh-edge@<version>`, `gh release view dsh-edge-v<version>`, and `https://hub.docker.com/v2/repositories/pawaca/dsh-edge-computer/tags/<version>` all resolve; record the image digest.

The workflow can also be triggered manually via `request-release.yml` (workflow_dispatch) or `repository_dispatch` as a fallback. Prerelease versions (containing `-`) are published to the `next` npm dist-tag and marked as GitHub prerelease.

Use `.agents/skills/dsh-release/SKILL.md` to run a release: it holds the preflight checks, the failure-handling table, and the verification commands.

### Container image

- Every release publishes `docker.io/pawaca/dsh-edge-computer:<version>` from `apps/dsh-edge/container/Dockerfile`; no separate image release step exists. The `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets must be valid. An expired token fails `publish-image` at login, before anything is published; replace the secret and rerun the same tag through `request-release.yml`.
- An image tag is pushed once. `publish-image` pushes only after Docker Hub answers 404 for the tag, reuses an existing tag on rerun, and fails on any other lookup result. Never overwrite, delete, or hand-push a release tag; fix a bad image by releasing a new version.
- The Dockerfile pins its computerd and Debian bases by digest, so base images never change silently. Refresh them in a reviewed PR; `edge / container image` must pass, and `pnpm --filter dsh-edge run test:container` must pass locally with a Docker engine.
- A computerd upgrade changes the Dockerfile base, both `@cloudflare/computer` pins (app and standalone), the lockfiles, and the third-party notices in one PR (see the wire-protocol invariant above).
- If `publish` fails after `publish-image` succeeded, npm is not published and the image tag is orphaned but harmless (no package references it). Release the fix as a new version.

Stage, commit, push, PR creation, review replies, thread resolution, releases, tags, npm publication, and Cloudflare deployment require the corresponding user authorization.

## Git and worktree hygiene

- The primary checkout stays on `main`. Use it only for pulling, global builds, and small documentation edits that do not need a PR.
- All feature, fix, and release work happens in an isolated worktree:

```sh
mkdir -p ../dsh-edge-worktrees
git worktree add ../dsh-edge-worktrees/<slug> -b <branch> main
cd ../dsh-edge-worktrees/<slug>
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
```

- After a PR is merged, clean up completely — worktree directory, local branch, and remote branch:

```sh
cd /path/to/dsh-edge                                     # return to primary checkout
git worktree remove ../dsh-edge-worktrees/<slug>          # 1. remove worktree
git branch -D <branch>                                    # 2. delete local branch (-D for squash-merged PRs)
git push origin --delete <branch>                         # 3. delete remote branch (skip if GitHub auto-delete is on)
git pull                                                  # 4. sync main
```

- Automated tools may create their own worktrees. If not auto-cleaned, verify the worktree is clean or its PR was merged before removing. Unlock if locked: `git worktree unlock <path>`, then `git worktree remove <path>`.
- Before starting a new iteration, verify a clean state: `git worktree list` shows only the primary checkout, `git branch --show-current` returns `main`, and `git branch` lists only `main`.
