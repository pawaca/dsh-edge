# Agent Note: Standalone dsh-edge wrapper

Status: implemented

English | [中文](2026-08-19-dsh-edge-standalone-wrapper.zh.md)

## Problem

DSH Edge began as a source fork of DeepSeek Harness even though its product-owned implementation was limited to the Cloudflare runtime, installer, Edge client plugin, deployment modes, and a small set of upstream adaptations. The fork made every upstream update look like a repository-wide merge, carried unrelated source and governance, and blurred the ownership boundary between DeepSeek Harness and this independent community project.

The standalone repository must consume an exact published Harness release, preserve the released Cloudflare behavior and durable data, and keep only the Edge-owned code and narrowly justified adaptations required to run that release on Workers.

## Decision

`pawaca/dsh-edge` is an independent wrapper repository, not a DeepSeek Harness source fork. It owns:

- `apps/dsh-edge/`: the Worker entrypoint, Durable Object adapters, installer, release CLI, tests, and package documentation;
- `packages/client/ui-edge/`: the Edge-specific browser plugin;
- `apps/dsh-edge/standalone/`: the exact upstream dependency closure, audited patches, Web assembly, and Direct and Dynamic Worker builds; and
- `.agents/`: active project decisions and the bounded review workflow.

It does not carry a copy of the Harness monorepo, Python SDK, native runtime, vendored Cordis source, examples, or upstream-wide development workflows. The pre-separation repository and PR history remain available in [`pawaca/dsh-edge-history`](https://github.com/pawaca/dsh-edge-history).

## Upstream composition

Every `@deepseek-ai/dsh-*` package in the standalone assembly is pinned to one exact upstream version. The 0.2.0 release uses DeepSeek Harness `0.1.0-rc.8`; ranges, dist-tags, workspace fallbacks, and dependencies accidentally supplied by the root install are rejected by verification.

The assembly consumes published Cordis manifests and Web assets, adds the Edge client plugin through composition, and builds a reviewed 30-plugin client graph. Adaptations use a public extension point first. When composition cannot express a required Worker compatibility change, an exact-version `pnpm` patch is allowed only with a rationale, a failing-without-the-patch check, and a removal condition. The rc.8 assembly retains six such patches. Copied upstream source is not an adaptation option.

An upstream upgrade is a coordinated baseline change: update the complete exact dependency closure, rebase or remove all patches, review plugin-graph changes, and rerun the deterministic build, dual-runtime, durable-state, browser, and package gates together.

## Runtime contract

One source tree produces two prebuilt Worker artifacts:

- **Direct Shell** runs the upstream Computer workspace adapter and command exports over the direct just-bash backend. Its build replaces the unreachable Dynamic Worker shell-core module and stays below the repository's 900 KiB gzip budget for the Cloudflare Workers Free path.
- **Dynamic Worker** preserves the upstream shell core for stronger isolation and replaces the unreachable Direct backend. It requires an eligible Cloudflare Workers Paid account.

The artifacts intentionally differ only in command execution. They share the upstream Web UI, Edge client plugin, HTTP and WebSocket protocol, session behavior, tools, authentication, workspace, and Durable Object storage. Release packaging selects a prebuilt artifact and uploads it with `no_bundle`; the user's machine does not rebuild Harness or resolve its dependency graph.

Direct Shell is not a Linux container. It does not promise native binaries, PTY support, background processes, or unrestricted network behavior. Dynamic Worker does not change the product or persistence contract; it changes the command-execution isolation boundary.

## Durable state and credentials

Sessions, messages, workspace metadata, and the `/workspace` virtual filesystem live in Durable Object SQLite and KV state. The stable contract preserves Durable Object class names, bindings, routes, session/event formats, owner authentication, and the Edge schema v2 representation released by dsh-edge 0.1.3. The upstream Node SQLite schema is not used, and the 0.2.0 release performs no durable-data migration.

Immutable 0.1.3 session, workspace, and VFS fixtures are loaded through a test-only Durable Object seeder, checked for referential integrity, then read, extended, restarted, and reread through production HTTP, RPC, WebSocket, session, Bash, and VFS paths in both runtime modes.

`DSH_EDGE_ACCESS_KEY` and `DEEPSEEK_API_KEY` remain write-only Worker secrets. Owner cookies, bearer tokens, and provider credentials do not enter Durable Object state, the VFS, generated configuration, responses, logs, fixtures, or tarballs. The DeepSeek credential is bound only for the active request or turn, including Web Search, then released.

## Installation and publication

Users install or upgrade the stable channel without a repository checkout:

```sh
npx dsh-edge install
npx dsh-edge upgrade
```

Stable versions follow npm `latest`; explicit prereleases follow `next`. The installer supports an anonymous temporary Cloudflare account or an authenticated account for Direct mode, while Dynamic Worker requires an authenticated eligible paid account. Upgrades preserve Durable Object data but ask for the existing owner and DeepSeek keys again because Cloudflare secrets cannot be read back.

Publication starts with a manual request workflow that has repository dispatch authority but no npm or OIDC publication authority. The publication workflow is resolved from the default branch, verifies that the reviewed `dsh-edge-v*` tag and package version match and that the tag belongs to reviewed `master`, rebuilds and tests the exact package, installs the tarball outside the workspace, and rechecks that the tag has not moved immediately before npm and GitHub mutations. npm Trusted Publishing supplies OIDC provenance without a long-lived publish token. npm is published first; the matching GitHub Release is created only with the same notes and tarball.

## Verification contract

The durable acceptance surface is:

| User path | Direct | Dynamic Worker | Evidence |
| --- | --- | --- | --- |
| Owner key establishes a Cookie session | required | required | HTTP integration and browser snapshot |
| Unauthorized requests cannot access owner data | required | required | HTTP integration |
| Create, stream, refresh, and continue a session | required | required | WebSocket and persistence integration |
| Read, write, list, delete, and restart workspace files | required | required | VFS and released-state integration |
| Execute supported Bash commands against the same VFS | required | required | runtime integration |
| Run DeepSeek Web Search with request-scoped credentials | required | required | provider integration and storage inspection |
| Load Edge identity, release, runtime, and upgrade information | required | required | manifest assertions and browser snapshot |
| Present the read-only built-in Agent Preset correctly | required | required | browser snapshot |
| Keep owner and DeepSeek credentials out of state and logs | required | required | storage, redaction, and package tests |

CI builds the standalone dependency closure before the root install, verifies deterministic Web output and patch coverage, enforces the Direct size budget, runs the repository contracts, tests both promoted Worker artifacts against 0.1.3 durable state, checks the assembled browser/runtime snapshots, packs the npm artifact, and starts both installed modes outside the workspace. Windows-specific installer and publication behavior is verified on Windows runners.

## Implemented outcome

The migration was completed through archived PRs [#25](https://github.com/pawaca/dsh-edge-history/pull/25), [#26](https://github.com/pawaca/dsh-edge-history/pull/26), [#27](https://github.com/pawaca/dsh-edge-history/pull/27), and [#28](https://github.com/pawaca/dsh-edge-history/pull/28). Their reviewed tree became the independent canonical repository; subsequent alpha releases established the trusted publication path and upgraded the exact upstream baseline from rc.7 to rc.8.

Release-preparation [PR #20](https://github.com/pawaca/dsh-edge/pull/20) passed HEAD-bound review and [Edge CI run 32471194741](https://github.com/pawaca/dsh-edge/actions/runs/32471194741), including 205 repository tests, both runtime integrations, the 0.1.3 durable-state fixture, three browser/runtime snapshots, and external installation of the packed artifact. [Release run 32471861144](https://github.com/pawaca/dsh-edge/actions/runs/32471861144) then published npm `latest`, tag `dsh-edge-v0.2.0`, the non-prerelease [GitHub Release](https://github.com/pawaca/dsh-edge/releases/tag/dsh-edge-v0.2.0), reviewed notes, provenance, and `dsh-edge-0.2.0.tgz` from merge commit `451dc41752cd7644a2e112dbd03e970ef663b072`.

The npm and GitHub Release tarballs are byte-identical with SHA-512 `7f5df95c2c96597180047ed829a97fa83ea0e1e7a7e69f8a60c600b3f945d9c87ca906429d7154ab6359186dc013c4612324bb16473f85462abd1d918405fc2a`. This closes the standalone-wrapper migration and 0.2.0 release contract.

## Consequences

- Upstream synchronization is now an explicit package-baseline operation rather than a source merge.
- Edge ownership and patch cost are mechanically visible, but a newly required unpublished upstream artifact can block an upgrade until upstream publishes it or a narrow adapter input is justified.
- Direct and Dynamic Worker parity, released durable-state compatibility, credential isolation, deterministic assembly, and exact npm artifacts are permanent release gates.
- Attachments/images plus guarded `web_fetch` are deferred to 0.3; `@file` plus `@session` references to 0.4; and additional model/provider choices to 0.5. These are product increments, not unfinished 0.2 migration work.

## Alternatives considered

- **Continue merging upstream into the source fork:** preserves direct source access but restores unrelated source, governance, conflicts, and ambiguous ownership to every Edge release.
- **Copy a reduced upstream subset:** creates a partial fork whose ownership and update cost are harder to verify than exact packages and explicit patches.
- **Upgrade upstream while separating the repository:** mixes dependency failures with structural failures and removes the stable comparison point; the migration therefore reached rc.7 parity before adopting rc.8.
- **Treat Dynamic Worker as a different product:** would duplicate protocol, storage, UI, and lifecycle logic. One parity contract with a selected execution backend keeps the Edge adaptation narrow.
