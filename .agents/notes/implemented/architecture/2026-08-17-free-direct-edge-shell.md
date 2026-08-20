# Agent Note: Make the direct Edge shell the free default

Status: implemented

English | [中文](2026-08-17-free-direct-edge-shell.zh.md)

## Problem

The first Cloudflare Computer proof used its Worker Shell backend through a Worker Loader. That gave every command a separate Dynamic Worker isolate, but made Workers Paid a mandatory dependency even though just-bash and the workspace VFS can both run in the owner Durable Object. For a self-hosted, single-owner project, that price floor materially weakened the one-click deployment story.

The replacement still had to preserve the existing Computer workspace seam, Durable Object VFS, native DSH `bash` tool schema, timeout and output bounds, and an easy path back to stronger isolation. It could not introduce a second filesystem or fork Computer's storage model.

## Decision

The default target in the checked-in `dsh-edge` configuration no longer declares a Worker Loader. When `LOADER` is absent, `DshEdgeInstance` registers `DirectShellBackend`, an in-process implementation of Computer's `WorkspaceBackend`. It runs `just-bash/browser` against Computer's exported `WorkspaceFsAdapter`, so commands see the same SQLite-backed `/workspace` VFS and continue through `workspace.runtime.exec`. The backend also reuses Computer's exported `git`, `assets`, and `artifacts` command adapters rather than creating Edge-specific command protocols.

Direct mode is deliberately constrained. It enables just-bash's hardened execution profile and defense-in-depth support where the runtime can provide it, supplies only the command's explicit environment, does not register `fetch` or the network command set, and enforces the existing per-command timeout and shared 64 KiB output ceiling. The browser build omits Node, Python, native binaries, PTYs, background processes, and arbitrary Linux behavior.

The direct backend returns Computer's execution handle before just-bash settles and keeps the execution registered until its terminal event is consumed or the handle is disposed. Caller cancellation can therefore reach the live interpreter. The interpreter and workspace adapter use one 65,536-byte limit: a command may emit exactly that amount, while the first byte beyond it stops the interpreter before later shell side effects. The standard terminal `result` field carries an output-budget cause only when just-bash's interpreter-owned accounting identifies an uncharged limit diagnostic; command output cannot forge it. The workspace adapter derives `timedOut` from when it observes the terminal event relative to the requested deadline, so neither cause trusts command-controlled stdout, stderr, or exit status.

`wrangler.jsonc` remains the canonical source for both modes and also defines a named `isolated` environment whose `LOADER` binding selects Computer's existing `WorkerShellBackend` without changing the DSH tool, VFS, transport, or persistence layers. Before upload, the guided installer renders a private mode-specific configuration with absolute paths. Direct mode aliases only `@cloudflare/computer/shell/core` to an empty module because the missing `LOADER` makes the Dynamic Worker backend unreachable; Computer's workspace adapter and command exports remain upstream-owned. Isolated mode preserves the shell core, selects the named environment, and aliases the unreachable Direct backend to a module that fails closed if the required Loader is absent. Each upload therefore excludes the other mode's command runtime while retaining the shared Workspace and VFS layers. Both outputs are minified. The installer selects direct mode on Workers Free or isolated mode on Workers Paid before it selects an account. Each Worker name has independent Durable Object storage and secrets. Health reports `just-bash-direct` or `just-bash-isolated` for explicit diagnostics, but the guided installer no longer requests that endpoint or matches its shell value; after Wrangler accepts the upload, it [hands off the admitted `workers.dev` target](../simplification/2026-08-18-edge-install-handoff-without-probing.md). CI uses the same renderer for both targets and rejects a Direct artifact above a 900 KiB gzip budget.

## Alternatives considered

- **Keep isolated Worker Shell mandatory:** strongest default separation, but it permanently couples every installation to Workers Paid.
- **Remove Worker Shell support:** simpler configuration, but it would deny operators a low-friction stronger-isolation option and discard an already working backend.
- **Fork Cloudflare Computer or replace its workspace runtime:** this would duplicate VFS and runtime contracts, increase upstream drift, and violate the fork's adapter-first policy.
- **Maintain separate Free and Paid application trees:** explicit, but likely to drift across protocol, persistence, authentication, and UI changes. Optional binding selection keeps one application graph.
- **Maintain two handwritten Wrangler configurations:** easy to understand initially, but duplicates bindings, migrations, assets, compatibility dates, and future upstream-adaptation changes. A small renderer keeps one reviewed source of truth.
- **Rely on minification alone:** the complete shell core produced a 1004.8 KiB gzip artifact, technically below 1 MiB by only about 19 KiB. That margin would make unrelated dependency or application changes break anonymous installation again.
- **Copy Computer's workspace adapter and command implementations into dsh-edge:** it would avoid the barrel import, but would fork preview-sensitive filesystem and command contracts. A build-only alias removes the unreachable shell implementation without taking ownership of those APIs.
- **Enable just-bash network commands in direct mode:** convenient, but it would expose an unrestricted fetch surface before dsh-edge has an outbound URL policy and SSRF protections.

## Consequences

- The default Worker artifact has no Worker Loader or embedded Dynamic Worker shell core. The assembled keyless snapshot executes the native DSH `bash` tool through the direct backend and pins the model requests, tool result, event log, and cold replay. Its measured gzip bundle fell from 1004.8 KiB to 592.4 KiB; CI enforces a 900 KiB ceiling. Removing the unreachable Direct backend from the isolated artifact reduced its measured gzip bundle from 1004.8 KiB to 885.3 KiB, while a second dry-run still validates the named target and its Loader binding.
- Filesystem and session schemas are unchanged. Switching modes changes only the Computer `WorkspaceBackend` chosen at Durable Object construction.
- Direct commands share the owner Durable Object isolate with the agent and persistence coordinator. Hardened interpreter limits reduce risk but are not equivalent to a separate security isolate; direct mode remains appropriate only for the authenticated single owner, not mutually untrusted tenants.
- Network commands are unavailable in direct mode. Future outbound access must first define URL validation, private-address and redirect handling, response limits, and an explicit capability boundary.
- Computer and just-bash are still preview-sensitive dependencies. The narrow filesystem and execution type casts must be rechecked when either package changes.
- Actual CPU duration and request economics remain subject to the selected Cloudflare plan and workload. A deployable Free configuration does not promise that every long-running agent workload fits Free usage limits.

This decision supersedes the shell-placement and mandatory-Paid conclusions in [Prove the Cloudflare Computer runtime boundary](2026-08-14-cloudflare-computer-runtime-poc.md); the earlier note remains the record of the original proof and broader Edge architecture.
