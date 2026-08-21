# Agent Note: DSH Edge Standalone Wrapper Migration

Status: proposed

English | [中文](2026-08-19-dsh-edge-standalone-wrapper.zh.md)

## Problem

DSH Edge began as a source fork of DeepSeek Harness even though its product-owned implementation was limited to the Cloudflare runtime, installer, Edge client plugin, deployment modes, and a small set of upstream adaptations. The fork carried unrelated upstream source, governance, CI, release families, and documentation machinery, so an upstream update looked like a repository-wide merge and DSH Edge ownership remained unclear.

The 0.2 release needs to consume an exact published Harness version, assemble the upstream application without copying its repository, and retain only patches that cannot use supported extension points. The migration must preserve the released 0.1.3 behavior and durable data while keeping every merged `master` revision buildable, deployable, and releasable.

## Proposal

### Target repository

The standalone repository owns the Cloudflare Worker, Direct and Dynamic Loader runtimes, Durable Object and VFS adapters, installer and release CLI, Edge client plugin, upstream assembly adapter, audited patches, and Edge-specific tests and documentation. It does not own a copy of the Harness monorepo, Python SDK, native runtime, vendored Cordis source, or upstream-wide governance.

### Migration invariants

1. `master` remains releasable; one pull request never relies on a later pull request to repair a broken intermediate state.
2. The production path remains active until the standalone path passes the complete parity matrix.
3. PRs 1 through 4 retain Harness `0.1.0-rc.7` and add no product capability.
4. The upstream upgrade occurs only after source separation.
5. Adaptation uses public composition first, a package patch second, and copied upstream source never.
6. Every patch has a rationale, a failing-without-the-patch test, and a removal condition.
7. Durable Object class names, bindings, session format, authentication behavior, and user routes remain stable unless the Change log explicitly amends them.
8. Review rounds are convergence checkpoints, not a mechanical stopping rule. A stalled loop checks for a repeated root cause, an over-local fix, or work outside the PR scope.

### Progress protocol

Each stage has one status: `planned`, `in progress`, `in review`, `merged`, or `blocked`. An acceptance item is checked only when its Evidence field names the command, artifact, test, or deployment that proves it. Scope or acceptance changes are appended to the Change log with a reason; criteria are never weakened silently. Stages 1 through 4 are the original migration sequence whose GitHub work is archived as PRs 25 through 28; stages 5 through 8 describe the post-cutover release track and are not GitHub PR numbers.

| Stage | Objective | Status | Release | User action |
| --- | --- | --- | --- | --- |
| 1 | Freeze the 0.1.3 baseline | merged | none | none; archived [PR #25](https://github.com/pawaca/dsh-edge-history/pull/25) merged |
| 2 | Add a parallel standalone assembly path | merged | none | none; archived [PR #26](https://github.com/pawaca/dsh-edge-history/pull/26) merged |
| 3 | Switch after rc.7 parity | merged | none | none; archived [PR #27](https://github.com/pawaca/dsh-edge-history/pull/27) merged |
| 4 | Remove fork source and simplify governance | merged | none | none; archived [PR #28](https://github.com/pawaca/dsh-edge-history/pull/28) merged |
| 5 | Close post-cutover hygiene and publish the rc.7 standalone baseline | merged | `0.2.0-alpha.1` | none; prerelease published |
| 6 | Publish installer activation UX and release-tooling hardening on rc.7 | in review | `0.2.0-alpha.2` | approve prerelease after [PR #16](https://github.com/pawaca/dsh-edge/pull/16) merges |
| 7 | Upgrade the exact upstream baseline when a newer package set is published | planned | `0.2.0-alpha.3` | approve prerelease |
| 8 | Rehearse canary upgrade, beta, rollback, and release 0.2 | planned | `0.2.0-beta.1`, then `0.2.0` | perform account-owned Cloudflare flows; approve beta and stable releases |

### PR 1 — Freeze the 0.1.3 baseline

Objective: convert released behavior into executable acceptance evidence before changing repository structure.

Scope: add 0.1.3 session, Durable Object, VFS, settings, and plugin fixtures; add HTTP, WebSocket, boot-manifest, and storage contract tests; record both build modes and sizes; inventory every fork modification outside Edge-owned packages.

Excluded: runtime behavior, data-format changes, Harness upgrades, source deletion, and new features.

- [x] Existing Edge CI stays green without changed product expectations.
- [x] A 0.1.3 fixture covers session resume, messages, VFS, settings, and Edge plugin configuration.
- [x] Contract tests cover the HTTP and WebSocket behavior used by the Web UI.
- [x] Reproducible commands record Direct and Dynamic Loader build sizes.
- [x] Every non-Edge fork modification has a disposition: adapter, retained patch, upstream candidate, or deletion.
- [x] Evidence names exact commands and artifacts.

Evidence: `dsh-edge-0.1.3-session.sql` fixes the released SQL schema, one canonical turn, and one blank session. Its adapter test resumes and appends to the canonical session, promotes and writes the blank session, then reloads both. `dsh-edge-0.1.3-vfs.sql` fixes the released `@cloudflare/computer` 0.2.0 schema and content, while `dsh-edge-0.1.3-workspace.json` fixes the released workspace title, session ordering, and archive state. A test-only Durable Object seeder writes all three fixtures through native SQL and KV storage, then rejects foreign-key violations before the candidate Worker starts. The Miniflare integration then reads and extends the released VFS, requires the first continuation to reconstruct both released messages, promotes and persists the released blank session through production Worker APIs, and reads, renames, attaches to, and reloads the released workspace through RPC. Existing settings, preset, session, Web Search, HTTP, and WebSocket snapshots remain the UI and protocol fixtures. The persistence test passed 23 tests, the full session integration passed, and the browser snapshot suite passed 3 tests. `pnpm --filter dsh-edge run bundle:workers` reported Direct at 683,920 gzip bytes against the 921,600-byte repository budget and Dynamic Loader at 959.59 KiB gzip. Hosted [Edge CI run 32343433389](https://github.com/pawaca/dsh-edge-history/actions/runs/32343433389) passed on the reviewed head, and archived [PR #25](https://github.com/pawaca/dsh-edge-history/pull/25) merged as `b1627b0fd033b2efdcd1a5b09e4b3160b74a1e1c`.

Current fork changes outside `apps/dsh-edge/**` and `packages/client/ui-edge/**` have these dispositions:

| Paths | Disposition | PR |
| --- | --- | --- |
| `packages/client/ui-conversation/**` | retain the attachment-capability UI patch and propose it upstream | 2, then 5 |
| `packages/client/ui-workspace/**` | retain the last-workspace deletion patch and propose it upstream | 2, then 5 |
| `packages/host/apiproxy/**` | retain the Worker-compatible Web Crypto patch | 2 |
| `packages/llm/llm/**` | retain the Worker-bundle manifest patch | 2 |
| `packages/session/session-persistence/**` | retain the bounded-read and failed-first-write extension patch | 2 |
| `packages/web/web-search-deepseek/**` | retain the no-follow Worker redirect patch | 2 |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` and generated catalogs | regenerate from the standalone composition; do not patch runtime code | 2, then 4 |
| root workspace, TypeScript, Vitest, Knip, and lock files | replace with standalone build configuration | 2, then 4 |
| `scripts/release/**`, release-family checks, and Edge release workflow changes | replace with the standalone package release path | 4 |
| Edge Agent Notes, review-loop skill, root README, legal notices, and Edge CI | migrate the Edge-owned subset and remove upstream-only governance | 4 |

### PR 2 — Add the standalone assembly path

Objective: build from exact published upstream packages without changing the active deployment path.

Scope: introduce the standalone layout and upstream adapter; pin all upstream packages to `0.1.0-rc.7`; assemble upstream Cordis manifests, Web UI assets, and Edge plugins from installed artifacts; express unavoidable changes through `pnpm` patched dependencies; build old and new paths in CI.

Excluded: production cutover, old-source deletion, upstream upgrades, and visible behavior changes.

- [x] A clean clone builds deterministic standalone Worker and Web artifacts.
- [x] The standalone path has no workspace dependency on copied upstream source.
- [x] Upstream dependencies use exact versions, not ranges or dist-tags.
- [x] A changed upstream source causes its patch to fail loudly.
- [x] Existing deployment and release commands still use the released path.

Evidence: `apps/dsh-edge/standalone/package.json`, its isolated pnpm workspace, and the dependency-edge pin produce a lock containing only Harness `0.1.0-rc.7`; frozen install applies six exact-version audited patches. The published `dsh-base` and `dsh-web-app` Cordis manifests plus `dsh-web-frontend` assets assembled 28 client plugins, and the active and standalone boot graphs matched by id, injection, and immediate-load metadata. `pnpm run build && pnpm run verify` inside the standalone directory built both modes, rejected workspace-source or main-lock dependency inputs from Wrangler metadata, measured Direct at 686,050 gzip bytes against the 921,600-byte budget, and measured Dynamic Loader at 961.63 KiB gzip. The unchanged production command still built Direct at 683,920 gzip bytes. The full Edge unit suite passed 172 tests, Edge typecheck and `lint:contracts-ready` passed, and the existing 0.1.3 package passed its installed-package verification without including standalone-only scripts or artifacts. PR #26 then passed its clean-checkout hosted Edge CI and merged.

### PR 3 — Switch to the standalone runtime

Objective: make the standalone path authoritative after rc.7 parity.

Scope: route development, CI, packaging, and deployment through the standalone path while preserving both modes, Durable Object identity, storage, authentication, routes, UI protocol, and PR 1 fixtures.

Excluded: upstream upgrades, UI redesign, and additional plugins.

- [x] The parity matrix passes in Direct mode.
- [x] The parity matrix passes in Dynamic Loader mode.
- [x] The runtime reads the 0.1.3 durable-data fixture without destructive conversion.
- [x] Direct mode retains measured headroom beneath the free Worker size limit.
- [x] Worker routes, bindings, class names, and authentication remain stable.
- [x] No unrecorded visible Web UI regression remains.

Evidence: `pnpm --filter dsh-edge run bundle:workers` now builds only from the isolated rc.7 lock, verifies the reviewed 28-entry boot graph and dependency origins, checks a second Web build byte-for-byte, then promotes all three output trees to the unchanged `dist` and `worker/{direct,isolated}` release paths. It measured Direct at 686,060 gzip bytes against the 921,600-byte budget and Dynamic Loader at 961.64 KiB. `node apps/dsh-edge/tests/run-session-integration.mjs` started both promoted Worker artifacts with no-bundle Wrangler configs and passed the complete HTTP, Cookie, WebSocket, session, Web Search, Bash/VFS, restart, and 0.1.3 session/workspace/VFS fixture suite in both environments. `pnpm --filter dsh-edge run test:snapshot` passed all three runtime, browser, and installer snapshots against promoted assets; the only recorded expectation change is that deployment diagnostics now show the release identity `dsh-edge@0.1.3/direct` instead of the source-only `local-development` marker. The installed-package smoke starts both prebuilt modes and checks their health identity. `node scripts/dev.mjs direct --port 8791` served the same Direct artifact and returned a ready health response while preserving `.dev.vars` lookup beside the generated config. Workflow contract tests passed 17 tests, and the Edge unit suite passed 172 tests.

A fresh `pnpm pack` tarball passed external installation and both prebuilt-mode smoke checks. The retired workspace assembler and source bundler are absent from that tarball, so the package has no orphaned alternative build path.

### PR 4 — Remove the source fork and simplify governance

Objective: retain only Edge-owned source and controls that protect Edge risks.

Scope: remove copied upstream apps, packages, Python, native code, vendor source, examples, and unrelated assets; reduce CI and release workflows; replace monorepo instructions while retaining `AGENTS.md`, a real `CLAUDE.md`, and review-loop convergence behavior; retain only active Edge decisions; verify attribution, licenses, and npm contents.

Excluded: runtime changes, review-tool rewrites, upstream upgrades, and removal of required notices.

- [x] Clean install, typecheck, lint, tests, both Worker builds, and package verification pass.
- [x] No build or runtime import resolves to copied upstream source.
- [x] The npm tarball contains only distributable Edge artifacts and required notices.
- [x] CI contains no upstream-only workflow and does not install Playwright Chromium.
- [x] Project prose does not claim DeepSeek ownership or official status.
- [x] `AGENTS.md` is authoritative and the real `CLAUDE.md` directs Claude Code to it.

Evidence: a temporary checkout with no parent or root dependencies completed the frozen standalone install, both Worker builds, deterministic Web rebuild, six-patch and 28-client-plugin verification before the root install. The same Edge client source then produced byte-identical client bundles in two different absolute checkout paths (`37f005f9b979d20cd2f1ca08306ee8bd760b618d7bd106287a990d4c293cfc23`); the verifier rejects absolute checkout paths in release output. Direct measured 686,060 gzip bytes against the 921,600-byte budget and Dynamic Loader measured 961.63 KiB. The 20-file root suite passed 176 tests, both modes passed the full release-artifact integration, the three assembled-runtime/browser/installer snapshots passed, and Edge typecheck and type-aware lint passed. A fresh `dsh-edge-0.1.3.tgz` installed outside the workspace, started both prebuilt modes, and contained only release Web assets, Workers, installer/runtime scripts, bilingual package docs, and legal notices. The repository now has only `apps/dsh-edge` and `packages/client/ui-edge` as source workspaces; CI has only `edge-ci.yml` and `release-edge.yml`; root legal files attribute dsh-edge to pawaca while preserving DeepSeek's upstream MIT notice; root `AGENTS.md` owns the project rules and the real root `CLAUDE.md` points Claude Code to them.

### Stage 5 — Close post-cutover hygiene and publish alpha.1

Objective: establish the clean-root repository as the trustworthy canonical source, then publish the behaviorally unchanged rc.7 standalone baseline as `0.2.0-alpha.1`.

Scope: preserve the archived development record; repair repository, security, dependency-automation, and bilingual-documentation hygiene; make prerelease update discovery channel-aware; require tags to identify reviewed `master`; create a matching GitHub prerelease only after npm publication succeeds; rerun the packed-artifact and parity evidence before publication.

Excluded: upstream dependency upgrades, deferred-plugin implementation, runtime behavior changes, and commercial account management.

- [x] The canonical repository is not a fork, has one clean root commit, and has the exact reviewed PR 4 tree.
- [x] The archived repository retains PRs 25 through 28, their review history, and the 0.1.3 GitHub Release.
- [x] Public and contributor documentation identifies the archive, current security-reporting path, and supported install commands without stale links.
- [x] Dependency automation cannot split the coordinated root, standalone, legal-notice, and snapshot invariants into misleading green or permanently failing PRs.
- [x] Stable deployments follow npm `latest`, prerelease deployments follow npm `next`, and upgrade guidance requires only Node/npm.
- [x] The release workflow verifies the reviewed source, publishes the exact tarball, and creates a version-matched GitHub prerelease with release notes.
- [x] The complete rc.7 parity, 0.1.3 durable-state, package, and both-runtime installation evidence passes on the release candidate.
- [x] npm `next`, Git tag, GitHub prerelease, release notes, and tarball identity all report `0.2.0-alpha.1`.

Evidence: canonical root `ff2adbd74cf6fe9196460e234180a9f5310c4eee` has no parent and tree `ddb4f9b64b059851597fb6a31a1b29680d9cc908`, identical to archived PR 4. [Edge CI run 32385210909](https://github.com/pawaca/dsh-edge/actions/runs/32385210909) passed the clean repository's full verification. [PR #9](https://github.com/pawaca/dsh-edge/pull/9) then added bilingual security reporting, enabled private vulnerability reporting, linked the archived history, and limited Dependabot to GitHub Actions so npm dependencies remain one coordinated update surface; its [Edge CI run 32390452740](https://github.com/pawaca/dsh-edge/actions/runs/32390452740) and HEAD-bound review passed before merge. The alpha.1 candidate derives npm lookup and upgrade commands from the installed stable/prerelease version, and its focused client and workflow tests pass 22 assertions. `pnpm run check` passes 188 tests plus documentation, lint, and type checks; the exact rc.7 assembly verifies six patches, 28 client plugins, deterministic Web output, Direct at 686,070 gzip bytes against the 921,600-byte budget, and both Worker modes. Both promoted artifacts pass the complete 0.1.3 durable-state integration, all three assembled snapshots pass, and the packed `dsh-edge@0.2.0-alpha.1` tarball starts both installed modes. The candidate tarball has SHA-512 `bc3c15c15a937e802816a24f2acc26d3b689e878f821a56dbc6f2d625c061ca10574291b035cf6f0a67ef7e69082857560877d7caad201447bba84d343d0b037`. On 2026-08-21, npm `next`, the reviewed `dsh-edge-v0.2.0-alpha.1` tag, the matching GitHub prerelease and notes, and its `dsh-edge-0.2.0-alpha.1.tgz` asset completed the final publication gate.

### Stage 6 — Publish installer activation UX on rc.7

Objective: publish the already-reviewed first-run and release-tooling improvements before changing the upstream baseline, so users can test a clearer installer independently from an upstream compatibility upgrade.

Scope: ship the static installer hero, credential-free bounded public activation observation, aligned terminal output, GitHub Actions v7 upgrades, pnpm 11 setup migration, portable pnpm subprocess handling, and matching bilingual release notes while retaining the exact rc.7 assembly.

Excluded: upstream dependency changes, durable-data or public-API changes, new authentication models, deferred-plugin implementation, and commercial account management.

- [x] Wrangler acceptance remains the installation success boundary while ready, pending, and recovery output explain Cloudflare propagation.
- [x] Activation observation is bounded, does not follow redirects, and never sends owner or DeepSeek credentials.
- [x] Installer, settings, deployment identity, and agent-preset snapshots report `0.2.0-alpha.2` without changing the rc.7 baseline.
- [x] Linux and Windows CI pass with `actions/checkout@v7`, `actions/setup-node@v7`, and `pnpm/setup@v2`.
- [x] The packed alpha.2 artifact starts both Direct and Dynamic Worker modes outside the workspace.
- [ ] npm `next`, Git tag, GitHub prerelease, release notes, and tarball identity all report `0.2.0-alpha.2`.

Evidence: [PR #13](https://github.com/pawaca/dsh-edge/pull/13) added the bounded activation observer and installer framing, [PR #14](https://github.com/pawaca/dsh-edge/pull/14) corrected terminal alignment, and [PR #15](https://github.com/pawaca/dsh-edge/pull/15) migrated the Actions toolchain while making all pnpm subprocess callers support both JavaScript entrypoints and standalone executables. The alpha.2 release-prep [PR #16](https://github.com/pawaca/dsh-edge/pull/16) keeps every Harness package on `0.1.0-rc.7`; [Edge CI run 32451798683](https://github.com/pawaca/dsh-edge/actions/runs/32451798683) passed Linux, Windows installer, 204 repository tests, durable-state integration, promoted browser/runtime snapshots, and external installation of both packed Worker modes. Actual alpha.2 publication remains the final Stage 6 gate.

### Stage 7 — Upgrade the published upstream baseline

Objective: upgrade the standalone wrapper separately from source extraction and alpha.1 publication, after a newer coherent Harness package set is available.

Scope: update every exact Harness dependency from `0.1.0-rc.7` to one selected published release; regenerate assembly inputs; retire obsolete patches; classify new plugins and visible changes; retain Edge branding and exclude unsupported capabilities.

Excluded: unpublished source snapshots, piecemeal Dependabot bumps, deferred-plugin implementation, unrelated upstream defects, and persistence or authentication redesign.

- [ ] Every Edge-relevant upstream change has an adopted, adapted, deferred, or excluded disposition.
- [ ] All `@deepseek-ai/dsh-*` packages use one exact published baseline.
- [ ] Patch count does not increase without an explicit amendment and rationale.
- [ ] Removing a retained patch fails its regression test.
- [ ] The parity matrix passes in both runtime modes.
- [ ] UI manifests expose only capabilities supported by Edge.

Evidence: pending. The npm registry still reports `0.1.0-rc.7` as the latest coherent published Harness baseline at the clean-root cutover, so this stage must not invent an `rc.8` source dependency.

### Stage 8 — Rehearse beta, rollback, and release 0.2

Objective: prove fresh installation, existing-instance upgrade, rollback, documentation, and publication before stable release.

Scope: validate temporary and claimed Free installs plus an eligible paid Dynamic Loader install; deploy isolated canaries for both modes; rehearse a 0.1.3 durable-data upgrade and rollback; update English and Chinese compatibility information and release notes; publish matching beta and stable npm, tag, and GitHub Release versions after approval.

Excluded: attachment, export, remote MCP, Skills, Workflows, Jobs, and commercial authentication.

- [ ] A temporary directory installs using only the npm artifact, without a repository or source-build integration.
- [ ] Direct mode installs on the anonymous or claimed Free path and Dynamic Loader installs on an eligible paid account.
- [ ] A 0.1.3 canary upgrades without losing session, message, VFS, settings, authentication state, or deployment identity.
- [ ] The documented rollback is executed against a canary.
- [ ] Secrets stay out of logs, committed configuration, package artifacts, and durable state.
- [ ] No launch-scope P0 or P1 defect remains.
- [ ] npm, Git tag, GitHub Release, release notes, and deployed health agree first on `0.2.0-beta.1` and then on `0.2.0`.

Evidence: pending.

### Parity matrix

Stages may add discovered existing behavior. Removing or weakening a row requires a Change log amendment.

| User path | Direct | Dynamic Loader | Evidence |
| --- | --- | --- | --- |
| Owner key establishes a Cookie session | required | required | HTTP integration and browser smoke |
| Unauthorized requests cannot access owner data | required | required | HTTP integration |
| Create a session and receive streamed output | required | required | WebSocket contract and browser snapshot |
| Refresh and continue the same session | required | required | persistence integration |
| Read, write, list, and delete workspace files | required | required | VFS integration |
| Execute supported Bash commands against the same VFS | required | required | runtime integration |
| Restart and recover persisted state | required | required | Durable Object fixture |
| Run Web Search with request-scoped credentials | required | required | provider integration and storage inspection |
| Load Edge client identity and version information | required | required | manifest assertion and browser snapshot |
| Show Agent Presets without a false unavailable warning | required | required | browser snapshot |
| Keep owner and DeepSeek credentials out of state and logs | required | required | storage and redaction tests |

### Change log

- 2026-08-19: Created this plan on Edge 0.1.3 and Harness `0.1.0-rc.7`. PR 1 entered `in progress`; no acceptance criterion was amended.
- 2026-08-19: Added the 0.1.3 SQL fixture, explicit VFS restart assertion, build-size evidence, and complete grouped disposition of current non-Edge fork changes. Five PR 1 criteria are satisfied; full Edge CI remains pending.
- 2026-08-19: Local unit, integration, browser snapshot, typecheck, documentation, lint, both Worker builds, pack, and installed-package checks passed. PR 1 entered `in review`; the remaining criterion waits for hosted Edge CI.
- 2026-08-19: Opened archived [PR #25](https://github.com/pawaca/dsh-edge-history/pull/25) as a draft. Hosted CI and the HEAD-bound review loop are now the remaining gates.
- 2026-08-19: Review found that candidate-created restart state did not prove upgrade compatibility. Added immutable 0.1.3 VFS state plus read-write-reload coverage for both VFS and session persistence; the PR contract did not change.
- 2026-08-19: Follow-up review found invalid parent-child insertion order in the VFS fixture. Reordered the rows and added an explicit foreign-key integrity check; the full integration passed.
- 2026-08-19: Follow-up review found untranslated headings in the Chinese Agent Note. Translated the complete heading hierarchy and re-recorded the bilingual pair; the PR contract did not change.
- 2026-08-19: Ready review found that the released session and workspace fixtures bypassed the real Worker entrypoints. Replaced the VFS-only database rewrite with one test-only Durable Object seeder for released VFS SQL, session SQL, and workspace KV state; the candidate now reads and extends all three through production HTTP/RPC paths.
- 2026-08-19: Follow-up review found that the unified seeder had dropped the prior VFS foreign-key check. Moved the check into the seeder success boundary so every released-state fixture load validates referential integrity before candidate startup.
- 2026-08-20: Follow-up review found that continuation did not depend on the released messages and that the released blank session only appeared through workspace KV state. The mock now requires both released messages for the first continuation, while the blank session is listed, read, promoted, restarted, and reread through production Worker APIs; the PR contract did not change.
- 2026-08-20: PR 1 merged after hosted Edge CI and HEAD-bound review passed. PR 2 entered `in progress`; its scope and acceptance criteria remain unchanged.
- 2026-08-20: PR 2 gained the exact rc.7 dependency closure, published Web and Cordis assembly, six version-coupled package patches, Edge-client-only build, both standalone Worker modes, dependency-origin enforcement, and parallel CI. Local build, parity, unit, typecheck, and lint evidence passed; clean-clone hosted CI remains pending.
- 2026-08-20: PR 2 isolated all parallel-path tools beneath `apps/dsh-edge/standalone`, leaving the released package command surface and tarball unchanged. A rebuilt 0.1.3 tarball passed external installation and Direct-runtime smoke verification and contained no standalone-only file.
- 2026-08-20: Opened archived [PR #26](https://github.com/pawaca/dsh-edge-history/pull/26) for PR 2. The clean-clone hosted CI and HEAD-bound review are now the remaining acceptance gates.
- 2026-08-20: Review found that importing the production Wrangler helper let the root install supply `jsonc-parser`, masking a missing standalone dependency. Split out a dependency-free rendering core, made standalone parse through its own exact dependency, and ordered hosted CI to build standalone before the root install; the PR contract did not change.
- 2026-08-20: PR 2 merged after its clean-clone CI and HEAD-bound review passed. PR 3 entered `in progress` to switch development, packaging, and deployment authority to the rc.7 standalone path without deleting fork source or upgrading upstream.
- 2026-08-20: PR 3 routed build, dev, CI, prepack, release, and installer preparation through standalone artifacts while retaining the existing package layout. Both promoted runtime modes passed the full 0.1.3 compatibility suite. A deterministic-build check was added after Lightning CSS export iteration exposed unstable class-map property order; sorting those keys removed byte and cache-revision drift without changing runtime semantics.
- 2026-08-20: PR 3 passed hosted CI and HEAD-bound review, then merged as archived [PR #27](https://github.com/pawaca/dsh-edge-history/pull/27). PR 4 entered `in progress`; it retains the two Edge-owned workspaces while replacing every remaining upstream workspace dependency, source-only check, workflow, and governance document with an Edge-owned equivalent.
- 2026-08-20: PR 4 removed the copied Harness source and upstream-wide governance, reduced the repository to two Edge-owned workspaces and two workflows, replaced source-mode tests and publication machinery with Edge-owned contracts, and passed clean standalone, unit, integration, snapshot, packaging, legal, lint, and type checks. A clean build exposed checkout-path-dependent CSS Module hashes; the Edge client build now uses a stable repository-relative CSS identity, and a verifier plus two-path byte comparison close that reproducibility gap without changing product behavior.
- 2026-08-20: Opened draft archived [PR #28](https://github.com/pawaca/dsh-edge-history/pull/28) for PR 4 after local acceptance passed. Hosted clean-checkout CI and the HEAD-bound review loop are now the remaining gates.
- 2026-08-20: Archived PR 4 passed hosted CI and the HEAD-bound review loop, then merged. Its reviewed tree became the single root commit of the new standalone [canonical repository](https://github.com/pawaca/dsh-edge); the former fork moved intact to [dsh-edge-history](https://github.com/pawaca/dsh-edge-history). The clean-root Edge CI passed, Stage 5 entered `in progress`, and alpha.1 moved behind explicit repository-hygiene and release-contract gates instead of being implied by source deletion.
- 2026-08-20: [PR #9](https://github.com/pawaca/dsh-edge/pull/9) completed the post-cutover repository hygiene audit and merged after hosted CI and HEAD-bound review passed. Stage 5 now advances through a separate alpha-readiness change that owns the `0.2.0-alpha.1` version, npm channel behavior, reviewed release notes, tag/source gate, and npm-to-GitHub publication sequence.
- 2026-08-20: The local alpha.1 release candidate passed the complete repository, standalone, dual-runtime durable-state, snapshot, and installed-tarball gates. Stable and prerelease deployments now remain on `latest` and `next` respectively; release automation requires the tag commit to belong to reviewed `master` history, publishes npm first, and only then creates the matching GitHub prerelease from reviewed notes. This ancestry gate keeps a partially completed release recoverable after `master` advances without accepting a side-branch tag. Actual publication remains the final Stage 5 gate.
- 2026-08-20: The final independent-repository audit confirmed that the canonical GitHub repository is no longer a fork, all current project, package, documentation, legal, and release identities point to `pawaca/dsh-edge`, and CI contains no Cloudflare source deployment. The audit also found a silently ignored deleted test path and a hosted integration race that used wall-clock delay to keep a model turn active. The package test now selects the maintained Vitest project, while the mock model uses an explicit release gate; the complete repository check, both runtime integrations, and installed alpha.1 tarball passed locally. Hosted CI remains pending.
- 2026-08-20: Review of the release retry contract found that a tag-triggered workflow still let the tagged revision redefine its own OIDC publication authority. Publication now begins with an unprivileged manual request and a `repository_dispatch`; GitHub resolves the privileged workflow from the default branch, while that workflow validates and checks out the explicit reviewed tag. A first publication must equal the dispatch-time `master` commit so npm provenance names the built source; an ancestor tag is accepted only when that exact npm version already exists, preserving GitHub Release recovery without authorizing a new historical publication. The workflow re-fetches and compares the tag immediately before both npm publication and GitHub Release mutation, closing the long-build movement window. A retry accepts an immutable GitHub Release only after its tag, title, state, notes, asset name, size, and downloaded SHA-512 all match the rebuilt release.
- 2026-08-21: Stage 5 completed when npm `next`, `dsh-edge-v0.2.0-alpha.1`, the GitHub prerelease, reviewed notes, and the release tarball converged on the same published version.
- 2026-08-21: The user prioritized the already-merged installer activation experience for an intervening `0.2.0-alpha.2` before the upstream-baseline upgrade. Added Stage 6 with unchanged rc.7 runtime, storage, authentication, and API contracts; the upstream upgrade moved from Stage 6/alpha.2 to Stage 7/alpha.3, and beta/canary validation moved from Stage 7 to Stage 8. No acceptance criterion was weakened.

## Alternatives considered

**Continue merging upstream into the fork.** This preserves source access but carries unrelated source, governance, and conflicts into every Edge release.

**Copy a reduced upstream subset.** This creates an undocumented partial fork. Exact packages and explicit patches make ownership and update cost mechanically visible.

**Upgrade while extracting.** This loses the rc.7 comparison point and mixes dependency failures with structural failures. The wrapper reaches rc.7 parity first.

**Delete upstream source before the parallel path works.** This creates a non-releasable `master`. The released path remains active until parity passes.

**Retain every upstream quality rule.** Most protect packages DSH Edge does not own. The standalone repository retains controls for Edge compatibility, security, data, packaging, and release integrity.

## Acceptance criteria

- All eight stages are complete with checked criteria and recorded evidence.
- The repository builds from exact upstream packages and contains no copied Harness source.
- Both runtime modes preserve the parity matrix and released durable data.
- The package installs without a repository clone and publishes matching npm, tag, and GitHub Release versions.
- When 0.2 ships, this note is rewritten as implemented architecture; transient progress is removed after merged PRs and durable tests own its evidence.

## Risks

Published packages may omit manifests or Web assets required by the assembly. The standalone verifier must discover this before adopting a baseline; a missing artifact warrants an upstream packaging request or narrow adapter input, not a monorepo copy.

Cloudflare size and loader behavior may differ between dry runs and real accounts. Build evidence does not replace Stage 8 account validation.

Logical storage compatibility does not prevent accidental binding or class-name changes. Fixtures, configuration assertions, and canary rehearsal protect separate risks and all remain required.

Governance cleanup can remove a useful check accidentally. Stage 5 audits the clean-root repository against the retained Edge risks before alpha publication.
