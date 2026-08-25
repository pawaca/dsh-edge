# dsh-edge repository instructions

`dsh-edge` is an independent community wrapper that runs published DeepSeek Harness packages on Cloudflare Workers. It is maintained by pawaca and is not affiliated with or endorsed by DeepSeek.

## Ownership boundary

- `apps/dsh-edge/` owns the Worker runtime, Durable Object adapters, installer, release CLI, tests, and package documentation.
- `packages/client/ui-edge/` owns the Edge-specific browser plugin.
- `apps/dsh-edge/standalone/` owns the exact upstream dependency closure, audited patches, Web assembly, and Direct/Dynamic Worker builds.
- `.agents/` owns this repository's active decisions and review workflow.
- Do not restore upstream monorepo source, vendored packages, examples, SDKs, native code, or development workflows. Use published packages and public extension points; use a version-bound patch only when composition cannot express the change.

## Commands

```sh
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
pnpm run check
pnpm run build
pnpm --filter dsh-edge dev
pnpm --filter dsh-edge dev:isolated
pnpm --filter dsh-edge run test:integration
pnpm --filter dsh-edge run test:snapshot
```

The root and standalone lockfiles serve different purposes. The root lock installs repository tests and tooling; the standalone lock is the release assembly and must build successfully before the root install in CI so parent dependencies cannot mask missing release inputs.

## Runtime and release invariants

- Keep every `@deepseek-ai/dsh-*` standalone dependency on one exact upstream version. Upgrade it only in an explicit upstream-baseline PR.
- Keep Direct and Dynamic Loader modes behaviorally aligned except for their command-execution backend and Cloudflare plan requirement.
- Preserve Durable Object class names, bindings, session/event formats, workspace/VFS state, owner authentication, and public HTTP/WebSocket behavior unless an Agent Note explicitly changes them.
- Never log `DSH_EDGE_ACCESS_KEY`, bearer tokens, or owner cookies. Provider credentials persist only through the upstream `CredentialProvider` seam in Durable Object storage; resolved values remain request-scoped in the LLM adapter and are never logged, cached across requests, or written to session events.
- Direct mode must stay below the repository gzip budget. Release tests must start the promoted prebuilt artifacts, not source entrypoints.
- Every retained upstream patch needs a version-bound filename, a failing-without-the-patch check, a rationale, and a removal condition.
- The npm package, tag, GitHub Release, deployment identity, and documentation must report the same dsh-edge version.
- `apps/dsh-edge/package.json` is the only release-version source. Test assertions and snapshot expectations derive the version and npm dist-tag channel at runtime; a version bump requires no other file changes. Private workspace manifests omit `version` so they cannot imply a second product or upstream release identity.

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

Every version published to npm must also have a matching GitHub Release and git tag. Skipping any step breaks the invariant on line 36.

1. **Write bilingual release notes**: create `docs/releases/<version>.md`, `docs/releases/<version>.zh.md`, and their `.i18n.yaml` pairing record, then run `pnpm run doc-pairs -- --write`.
2. **Merge the release PR** to main (squash merge).
3. **Pull main** and verify `apps/dsh-edge/package.json` version matches the intended release.
4. **Create and push a git tag**: `git tag dsh-edge-v<version> && git push origin dsh-edge-v<version>`.
5. The tag push triggers `release-edge.yml` which automatically builds, verifies, publishes to npm (trusted publishing), and creates the GitHub Release.
6. **Verify**: `npm view dsh-edge@<version>` and `gh release view dsh-edge-v<version>` both resolve.

The workflow can also be triggered manually via `request-release.yml` (workflow_dispatch) or `repository_dispatch` as a fallback. Prerelease versions (containing `-`) are published to the `next` npm dist-tag and marked as GitHub prerelease.

Stage, commit, push, PR creation, review replies, thread resolution, releases, tags, npm publication, and Cloudflare deployment require the corresponding user authorization.
