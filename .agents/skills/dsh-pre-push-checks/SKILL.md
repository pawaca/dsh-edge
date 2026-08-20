---
name: dsh-pre-push-checks
description: Select and run the smallest sufficient dsh-edge checks before pushing, force-pushing, marking a PR ready, or claiming a branch is validated. Use for Worker runtime, installer, Edge client, standalone assembly, documentation, release, or governance changes without reflexively repeating the complete suite.
---

# dsh-edge pre-push checks

Inspect `git status --short --branch`, verify the live PR base, and read the complete diff against its merge base. Classify changed files by owned surface before selecting evidence.

## Select evidence

- Runtime, storage, authentication, credentials, or protocol: run the focused unit file and the affected Direct/Dynamic integration path.
- Edge client or visible output: run its focused test and the browser/runtime snapshot suite.
- Standalone dependencies, patches, bundle configuration, or Web assembly: run the standalone build and verifier, then promote and start both exact prebuilt artifacts.
- Installer, package files, or release automation: pack the npm artifact and run `pack:verify` outside the workspace; run workflow and publication tests.
- Documentation, governance, or legal files: run `pnpm run doc-sync`; compare bilingual meaning manually.
- Cross-cutting repository extraction or dependency changes: run `pnpm run check`, both standalone builds, integration, snapshots, and package verification.

Do not repeat a passing check solely because commit or push follows. CI owns the clean Linux checkout; local evidence owns failures that CI cannot reproduce, macOS behavior, and exact package contents.

## Push safely

Commit only inspected paths. Push normally unless the user authorized a history rewrite; use `--force-with-lease=<branch>:<observed-oid>` for an authorized rewritten branch and never raw `--force`. Verify the remote ref equals local `HEAD`, then inspect the new CI and review phase.

Do not bypass a failing hook without explicit user approval. If a failure is environmental, record the exact command and evidence before proposing a bypass.
