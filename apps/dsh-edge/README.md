# dsh-edge

English | [中文](README.zh.md)

`dsh-edge` deploys your own persistent DeepSeek Harness to Cloudflare Workers in one command, then makes it available from any browser. The public CLI installs and upgrades it without a source checkout, connected repository, or build pipeline.

Under the hood, one deployment maps its authenticated owner to one Durable Object whose SQLite-backed virtual filesystem survives requests. By default, an in-process just-bash backend runs commands against that same filesystem without a Linux container or Dynamic Worker.

`dsh-edge` is an independent community project. It is not affiliated with or endorsed by DeepSeek; DeepSeek Harness remains an upstream dependency under its own license.

The checked-in Wrangler configuration exposes two deployment targets from the same application graph. The default target is direct mode for Workers Free and has no Worker Loader binding. The named `isolated` target adds the `LOADER` binding and requires Workers Paid, but does not fork the DSH protocol, storage, UI, or tool implementation.

The runtime keeps upstream ownership clear:

- `ReactLoopAgent`, `AgentRegistry`, `LlmRuntime`, `ToolRuntime`, `SystemPrompt`, `SessionStore`, and `SessionPersistence` run through the upstream Cordis composition.
- The upstream `dsh-llm-deepseek` cordis plugin is installed directly, auto-registering its settings namespace and configurable provider entry. Edge maps the native DSH `bash` tool onto Cloudflare Computer.
- Durable Object SQLite implements the upstream `SessionHandle` persistence contract. Edge buffers live events and flushes them before publication; initialization events, including `session/end-seed` during cold model selection, are persisted before subsequent mutations. The upstream agent loop supplies interrupted-turn closers on resume. Under write ownership, Edge first truncates a torn physical tail and atomically rebuilds summaries and reminder state; tails containing inbox events, malformed reminders, or already-dispatched reminders are rejected to prevent duplicate delivery.
- Model history is projected from canonical events rather than persisted in a second Edge schema.
- `GoalService` and `ToolGoal` run as upstream cordis plugins (direct composition). Browser GoalBar mutations route through `TypertGatewayService`.
- `SessionProjectionCache` persists goal, title, and model state across Durable Object restart via KV cache.
- `EdgeFileSystem` provides read, write, edit, and read_image tools backed by the Durable Object VFS.
- Context compaction, token metering, and automatic session titles run as upstream cordis plugins.

The browser also remains upstream-owned:

- A build-time assembler derives the Web roster from upstream configs, injects the standard `window.__DSH_BOOT__` graph, and emits Cloudflare static assets.
- The Durable Object implements supported upstream `ApiProxy` methods through the standard HTTP carrier and supplies both downlinks as hibernatable WebSockets.
- The image composer, gallery, lightbox, attachment wire contract, and DeepSeek serializer are reused unchanged.
- The storage seam stores new deployments' images in bounded Durable Object storage and keeps private R2 for deployments already pinned to it.
- Client plugins whose host domains are unavailable are excluded instead of forked. Optional local-host plugins remain unavailable.
- The session log download (`/export` and the session header's download item) keeps upstream's archive layout, but the Edge reads each log a page at a time while it compresses, so the memory an export takes follows the page size rather than the length of the session.
- Settings → Plugins lists the running composition through the upstream `dsh-host-plugin-inventory` Remote. The Edge-owned `EdgeLoader` answers its `loader` inject from the live host plugin registry and the reviewed Web boot graph, because there is no cordis Loader on Workers.
- A small Edge-owned login shell protects the upstream UI and protocol without changing either one.

## Main-session runtime queues

The owner Durable Object admits one live main session at a time. Ordinary inputs are durably queued before acknowledgement; each residency admits one ordinary input, then returns that session to the ready queue's tail after the upstream loop becomes idle and cleanup completes. Other tabs can submit and observe the same queue. Explicit steering still targets the current run. The Edge browser binds steering/cancellation to the canonical turn it observed, so a delayed control cannot affect a newer run; legacy API callers can opt in with `x-dsh-edge-turn-seq`.

The queue accepts up to 128 unsettled inputs and 2 MiB of serialized input data per owner. Capacity exhaustion returns HTTP 429 (`QUEUE_FULL`) or RPC `session/agent-busy`; retry after pending work drains. Browser RPC retries reuse `requestId` (legacy callers reuse `rpcId`); raw SSE callers can supply an `Idempotency-Key` (up to 128 characters). Reusing an identity with different content fails. Concurrent steering retries share the admission result; a rejected steer remains rejected on retry, including after restart. If an inbox mutation was accepted but its persistence barrier fails, model consumption is blocked and steering capacity is released; a promoted input retains its original accepted receipt. Raw SSE starts with a receipt comment and returns `x-dsh-edge-input-id`; disconnecting a stream does not cancel the queued input. Remove a queued input through `session.updateQueue`.

Actual tool dispatch shares two permits, at most 32 waiters, a 30-second queue deadline and a 60-second cooperative execution deadline. The pool deadline is an additional ceiling: a longer configured bash timeout does not extend it, and interactive `ask_user_question` / `exit_plan_mode` calls must also settle within it. A cancelled execution retains its permit until cleanup settles. Upstream parallel/exclusive classifications remain authoritative; nested dispatch inherits the root budget. Background title streams have a separate bounded single permit and retain their upstream timeout. These limits do not make synchronous unbounded code interruptible or give each tool its own memory allocation.

Incoming requests and completion events advance the queue immediately. The existing downlink-expiry alarm also checks durable work, with a 30-second active recovery interval; alarm-started work is awaited one residency at a time. Explicit user cancellation ends the current turn and lets queued followups run after cleanup. Each residency receives its own ten-minute deadline, leaving cleanup room within the alarm handler's platform limit. After restart, interrupted work is marked and its pending session inputs are paused; a new user message explicitly resumes pending work. Transient model errors (provider failures, output ceiling) do not pause followups; only crash recovery and residency timeout trigger the pause. Unknown external tool effects are never automatically replayed. Cold history subscriptions release their prepared snapshot after delivery and do not activate an Agent. Agent-scoped commands such as `/plan` temporarily use the same residency budget. Model selection still publishes the upstream durable projection while a session is cold. Subagents and independent cron execution slots are not added.

For a local test against promoted artifacts and real browser tabs, run `DSH_EDGE_PLAYWRIGHT_CHANNEL=chrome node tests/runtime-queues.probe.mjs` from this package after `pnpm run bundle:workers`. Set `DSH_EDGE_TEST_RUNTIME_MODE=isolated` for the Dynamic Worker variant. The probe uses a local mock provider, checks actual HTTP concurrency and cancellation, and restarts the Worker with all tabs closed to exercise alarm recovery.

## Scheduled reminders

Ask the agent to remind you later, for example “remind me in ten minutes to review the PR.” The published upstream `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` tools (`dsh-tool-schedule`) manage reminders belonging to the current session; a delegated subagent cannot use them. As upstream's standard presets do, each model step also receives a `dsh-time-context` reading: the current time, the browser's time zone, and the time since the previous message, at most once every ten minutes. A request that carries no browser time zone, such as a delivered reminder, tells the model the zone is unavailable. Supported rules are upstream's: a delay (`after_seconds`), an absolute `at` with an explicit offset or time zone, a fixed rate (`every_seconds`, at least 60 seconds), and daily, weekly, and five-field cron rules in an explicit IANA time zone. Upstream's task page (`dsh-client-ui-schedule`) lists every reminder with its session and status, edits its name, instruction, and timing, deletes it, and shows the deliveries it has made. The page uses upstream's `schedule` Remote namespace, which the Edge serves from Durable Object storage, and refreshes when a reminder is created, changed, deleted, or delivered.

Edge replaces the upstream live-only timer with a Durable Object alarm. A cold session is resumed automatically when due, including with all browser tabs closed. Reminders enter the existing durable input queue and share the single main-session slot and two-permit short-tool pool. Running work is not cancelled or steered; existing queued messages retain their order. The reminder stays in its original conversation and asks the model to present reminder content, not execute it as a new user instruction. There are no email, push, or external notifications, and no new session is created.

Reminders are stored as tasks in Durable Object SQLite with a due-time index. Delivering a reminder queues it, advances or ends its task, and saves the delivery in one SQLite transaction, and the alarm is armed in that transaction too. A delivery is saved with its occurrence, time, message, and prompt; a task keeps the newest 200 within 30 days of its latest delivery, as upstream does, and they are removed with the task. One-shot reminders take precedence over a due periodic batch. Missed periodic intervals collapse to each reminder's latest occurrence and advance directly to the next future time. There are at most 128 active reminders per owner, the newest 128 ended ones are kept, and each prompt has a 4 KiB JSON-encoded budget. Reminder preparation reserves queue capacity before it queues; when capacity is unavailable, user work can drain first. Failed reminder admission backs off for 30 seconds per session, with the deadline persisted across restarts. A failed session does not block healthy sessions’ due reminders or queued inputs, even when only paused inputs occupy capacity. A crash-paused session with pending inputs still requires a new user message to resume; reminders do not override that pause or replay interrupted external effects. A saved delivery confirms queue admission, not successful model execution or user acknowledgement.

After building, run `DSH_EDGE_PLAYWRIGHT_CHANNEL=chrome node tests/schedule.probe.mjs` from this package to verify busy-session ordering, deletion, and alarm recovery after a Worker restart. Set `DSH_EDGE_TEST_RUNTIME_MODE=isolated` for the Dynamic Worker variant. The browser snapshot suite also creates a reminder through the native composer, closes the page, observes the provider without waking the DO, and reopens the conversation to verify delivery.

## Find what you need

- [Subsystem wiki with architecture and roadmap](https://github.com/pawaca/dsh-edge/wiki)
- [Install or upgrade on Cloudflare](#install-on-cloudflare)
- [Compare native, adapted, and unavailable capabilities](#cloudflare-compatibility-matrix)
- [Configure DeepSeek credentials, models, timeouts, and owner authentication](#api-key-boundary)
- [Run the release runtime locally](#run-locally)
- [Inspect routes, limits, and durability behavior](#edge-api)

## Run locally

Use Node.js 22.19 or newer. Install both the repository dependencies and the separately locked release assembly from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
```

To call DeepSeek, create an ignored `apps/dsh-edge/.dev.vars` file:

```dotenv
DSH_EDGE_ACCESS_KEY=replace-with-at-least-32-random-bytes
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_MAX_OUTPUT_TOKENS=256000
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_REASONING_EFFORT=high
DEEPSEEK_STREAM_IDLE_TIMEOUT_MS=120000
DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS=120000
DSH_EDGE_MAX_COMMAND_TIMEOUT_MS=120000
```

Then start the Worker:

```sh
pnpm --filter dsh-edge dev
```

The command builds the pinned published Harness packages into the same prebuilt Web and Worker artifacts shipped by the installer, then starts Wrangler without rebundling them. Open the printed URL, normally `http://localhost:8787`, enter the owner access key, choose **Workspace**, and send a message. The Web UI creates a lazy blank session and streams the turn through authenticated Durable Object WebSockets.

The diagnostic API uses the same owner cookie. Log in once to a temporary cookie jar, then verify the persistent filesystem and shell:

```sh
curl -c /tmp/dsh-edge-cookie -X POST \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'accessKey=replace-with-your-random-key' \
  http://localhost:8787/api/auth/login

curl -b /tmp/dsh-edge-cookie -X PUT --data 'hello from the edge' \
  'http://localhost:8787/api/workspace/file?path=/workspace/hello.txt'

curl -b /tmp/dsh-edge-cookie -X POST -H 'content-type: application/json' \
  --data '{"command":"cat /workspace/hello.txt"}' \
  http://localhost:8787/api/workspace/exec
```

For a persistent conversation, create a session and send turns to its returned id:

```sh
curl -b /tmp/dsh-edge-cookie -X POST -H 'content-type: application/json' \
  --data '{"title":"Edge session"}' \
  http://localhost:8787/api/sessions

curl -b /tmp/dsh-edge-cookie -N -X POST -H 'content-type: application/json' \
  --data '{"message":"Read /workspace/hello.txt and remember the result."}' \
  http://localhost:8787/api/sessions/SESSION_ID/turn
```

The diagnostic session APIs preserve upstream events while bounding every read:

- A turn streams upstream `SessionEvent` values directly as SSE, including inbox splices, assistant chunks/messages, tool calls/results, and turn/step boundaries.
- A live stream queues at most 1 MiB per client. A slower reader is disconnected without cancelling the turn or its persistence.
- Session detail returns bounded metadata. Event replay defaults to 128 events, accepts at most 256, preflights stored bytes, retains at most 1 MiB of encoded SSE, and exposes continuation headers.
- Session listing defaults to 50 summaries and accepts at most 100. The Durable Object derives titles and timestamps from canonical rows without loading each log; upstream Web also receives retained blank headers.
- Browser history is capped at 50 messages and refuses, rather than truncates, windows above 8,192 events or 8 MiB. Cold paths apply the boundary in SQL; live paths locate it without copying the complete in-memory log.
- Sidebar search uses canonical current user/assistant messages without a second index or wire format. It examines at most 32 recent sessions, requires complete logs of at most 512 events and 256 KiB when cold, and returns at most 20 snippets with `hasMore` when a bound is reached.
- Model lookup and selection use header point reads. Only a turn that resumes the agent decodes canonical history.

Every authenticated request uses the deployment's fixed `owner` Durable Object. The legacy `x-dsh-edge-instance` header and `instance` query parameter are rejected rather than treated as identities. `/api/sessions/SESSION_ID/turn` continues the stored canonical history.

## Cloudflare compatibility matrix

This reference separates code that runs natively in Workers, code adapted at an existing DSH capability, and code that still assumes the local Node.js host. “Current” describes `apps/dsh-edge`; it is not a claim about all future Cloudflare work.

| Capability | Upstream implementation | Current edge status | Edge decision |
| --- | --- | --- | --- |
| DeepSeek transport | Fetch, SSE parsing, wire translation, retry metadata | Reused | Construct the upstream `DeepSeekAdapter` per request. `nodejs_compat` supplies its compatible Node APIs. |
| Provider attribution | Package version loaded with Node `createRequire` | Reused after portability fix | Import package metadata statically so bundlers preserve the same version source without requiring `import.meta.url` at runtime. |
| LLM protocol | DSH messages, content blocks, stream chunks, tool calls, usage, and finish reasons | Reused | Let upstream `LlmRuntime` and `ReactLoopAgent` assemble, stream, and log the model exchange. DeepSeek is served by `dsh-llm-deepseek-api-key` (`llm-deepseek`). Other providers are added on the Settings → Models page as upstream does it, through `dsh-llm-pi-ai` (`llm-pi-ai`): OpenAI chat completions, OpenAI responses, or Anthropic messages, any HTTP(S) Base URL without credentials, a query, or a fragment (OpenRouter, Cloudflare Workers AI or AI Gateway, a self-hosted gateway), and model discovery from the endpoint. A saved route serves turns without a restart and can be picked in the model menu, as a new-session default, and for subagents. Providers that sign in through a local login or read local credential files (GitHub Copilot, OpenAI Codex, and Amazon Bedrock or Google Vertex through local credentials) are not offered. |
| Agent loop | Cordis-composed `ReactLoopAgent` with hooks, guards, sessions, and tools | Reused | Create and cold-resume agents through `AgentRegistry`. Context compaction, token metering, tool-result pruning, automatic session title generation, the repeated-tool-call reminder (after 3, 5, and 8 identical consecutive calls), model-request retry (a rate limit, server error, timeout, transport error, or empty response is retried up to five times within the turn, with 0.5–10 s backoff or the provider's `Retry-After`), and durability checkpoints (the session log is stored before each model request, each top-level tool call, and each step) run as upstream cordis plugins. The upstream `/compact` command (`dsh-command-compact`) compacts the session's history on request. |
| Bash tool | Node subprocess, sandbox, terminal, and job services | Adapted at the native tool seam | Register an upstream `ToolDefinition`, but execute its body through the configured Computer workspace backend and just-bash. The default direct backend runs inside the owner Durable Object with hardened interpreter limits and no network command; adding a `LOADER` binding selects Computer's isolated Worker Shell backend. Native tool cancellation sends `SIGINT` through the Computer execution handle. Deployment configuration supplies an explicit default timeout and caller-selectable ceiling, while `timedOut` reports the deadline independently from exit and cancellation status. Native binaries, background processes, PTYs, and arbitrary Linux behavior are unavailable. The bash tool has no `run_in_background` and never moves a long command to a background job. |
| Workspace filesystem | Local filesystem services and host paths | Adapted | Store `/workspace` in the owner's SQLite-backed Durable Object VFS. |
| Session persistence | `SessionPersistence` service, `PersistenceCoordinator`, and local JSONL/SQLite backends | Native backend adaptation | Reuse the upstream service and coordinator ownership. Implement storage primitives over Durable Object SQL with the upstream header/event mapping. One Edge-only table retains empty session headers across transparent hibernation and is removed when canonical rows materialize; no Edge turn or message schema exists. Internal coordinator helpers validate the bounded replay loader and abandon a failed unmaterialized creation before disposal. |
| Settings and credentials | File-backed settings, launch environment, and credential services | Writable with DO storage | The upstream `dsh-settings` plugin persists user sections in Durable Object KV via `DurableObjectSettingsProvider`. The upstream `dsh-llm-deepseek` cordis plugin is installed directly, auto-registering the `llm-deepseek` settings namespace and configurable provider entry; the Settings → Models page can read and modify provider configuration (base URL, model catalog, API key reference, reasoning effort) at runtime without redeployment. `EdgeCredentialProvider` resolves credentials from DO KV first, then falls back to Worker environment secrets; `set`/`unset` persist through the upstream seam. Deployment defaults (maxTokens 256,000, reasoningEffort high) are aligned with the upstream plugin so unset deployment variables match upstream behavior. Settings → Built-in plugins also has a Settings tab with upstream's agent-loop and web-search cards: the Edge registers their `agent-loop` (parallel tool calls) and `web-search-deepseek` (searches per request, endpoint, and the DeepSeek key the search uses) namespaces, applies a saved value to the running plugin, and refuses an endpoint that `DEEPSEEK_SEARCH_BASE_URL` would refuse. Upstream's Shell card edits the `bash-sandbox` namespace, which the Edge registers for its own bash: the command timeout defaults to `DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS` and may not exceed `DSH_EDGE_MAX_COMMAND_TIMEOUT_MS`, the output cap per stream (64,000 bytes by default, 1 KiB to 1 MiB because each stream holds it in memory) is the inline tail before output spills, and both apply from the next command, in both shells and the HTTP exec route. Upstream's Subagent card edits the subagent runtime's `subagent` namespace: maximum recursion depth (default 1) and the parallelism limit for resident subagents (default 8); its models section edits `subagent-model-selection-settings`: off by default, as upstream; when on, a new session records the allowed models once (a `subagent/model-selection-policy` event), and its `subagent` tool gains `list_subagent_models` and may run a child on one of them. Edge sessions are resumed on first use, so the Edge records the setting on a root session that has not run a turn yet, where upstream records it on a session never seeded. `subagent_fork` children keep the parent's model. Upstream's plugin manager page, which hosts these cards upstream, is not shipped, because it installs and removes plugins through a runtime Loader the Edge does not have. |
| Host boot and plugins | Node command line, Cordis profile loading, package resolution, and HMR | Explicit Edge composition | Keep the local boot profile out of Workerd. Build immutable client bundles ahead of deployment; exclude HMR and host domains that the Edge `ApiProxy` does not expose. The upstream `dsh-host-plugin-inventory` Remote serves Settings → Plugins; `EdgeLoader` projects `host:` entries from the live plugin registry with their fiber phase and `web:` entries from `expected-boot-graph.json`. |
| DSH transport | Typed HTTP RPC plus mux and host WebSocket downlinks | Reused with an Edge server implementation | Use the upstream fetch carrier for unary methods and preserve its envelopes, schemas, projections, lazy blank-session behavior, bounded content search, prompt and queue mutations, workspace mutations, queue snapshots, and event frames. Durable Object WebSocket hibernation owns both downlinks; mux reconnects replay pending live inbox state, while REST/SSE routes remain a diagnostic compatibility path. |
| Workspace registry | Storage-domain global state plus `WorkspaceRecord` rows | Native backend adaptation | Keep the upstream global and record value shapes, including manual session order and archive membership, but map their physical keys and atomic writes to Durable Object storage. Edge constrains the registry to the one native `/workspace` VFS; rename, delete, recreation, and session reordering retain the upstream RPC and Host-frame semantics. |
| Directory picker | `ctx.directoryPicker` seam with the `-native` OS chooser or the `-browse` filesystem backend, chosen at boot by `dsh-host-directory-picker-auto`, plus the Web browse dialog | Reused with an Edge browse backend | Install the upstream seam and pin the upstream `dsh-client-ui-directory-picker-browse` dialog in the Web roster; Edge answers the `browse` capability from the `/workspace` Computer VFS one level per call, rooted at `/workspace` with the upstream hidden, bound, and failure vocabulary, so the upstream `DirectoryPickerController` serves `directoryPicker/list` and `createDirectory` and refuses the native `pick`. |
| Conversation file links | `session/openWorkspacePath` hands a clicked path to the Host desktop opener through `dsh-native-command`; `session/canOpenWorkspacePath` gates the affordance | Adapted at the upstream `SessionControllerInternals` seam plus a Web download fallback | Compose `SessionController` with Edge internals so the native probe answers false and an open attempt fails with a readable reason instead of a `child_process` error. The V3 Web client opens file links in its right-sidebar preview. Edge composes the upstream `workspaceFiles` controller over request-scoped VFS reads, including bounded text/byte windows and metadata subscriptions. The legacy `ctx.remote.session.openWorkspacePath` fallback and owner-authenticated `GET /api/workspace/file` download remain available. |
| Existing Web UI | Runtime-loaded shell and `dsh.client` plugin graph | Reused with generic composition fallbacks | Assemble the upstream shell and supported upstream client bundles as Worker assets. Shared slot-occupancy rules hide actions whose provider is absent; Cloudflare serves ordinary assets directly, while `/`, `/login`, and `/api/*` enter the Worker for owner access control. The assembled asset policy prevents every direct or SPA-fallback shell alias from being framed. |
| Other tools | Web Search, filesystem editor tools, MCP, skills, workflows, jobs, and subagents | Search, file, glob/grep, goal, todo, skill, subagent, and MCP tools ported; workflow and run_code ported for the isolated build | Reuse upstream DeepSeek Web Search with its 30-second tool-call timeout. The web search card's "Use the new Web Search API" switch (off by default) moves search and fetch to the DeepSeek Search and Fetch APIs (`dsh-web-deepseek-api`): DeepSeek fetches the page, so the Worker reads no third-party page itself, and no auxiliary model request is made. They use the DeepSeek API key the Models page stores (the key name may not be another Edge feature's credential, and a literal key is refused in settings), their API base must be an HTTP(S) URL without credentials, a query, or a fragment, a redirect is refused, and the account sign-in route is not offered. The Search and Fetch APIs may bill separately from model tokens. The upstream `workflow` tool is offered only by the Dynamic Worker runtime (the isolated, Paid-plan build); the Direct build does not register it. Each run loads its script into its own Dynamic Worker with no outbound network and a 30-second Worker Loader `cpuMs` limit (enforced by the Cloudflare runtime, not by local development), because workerd forbids in-process `eval`/`new Function`/`node:vm`; `agent()`, `phase()`, and `log()` cross an RPC bridge to the Durable Object, which enforces the caps: at most 4 children run at once (below the Workers six-connection limit) and one run starts at most 100 children to bound child-session row writes. The same runtime offers upstream's `ralph` tool (`dsh-tool-ralph`), which runs a foreground loop of fresh `subagent` children toward one objective, each round handing only a bounded report to the next, until a child reports completion or a blocker. Like upstream, its prompt reserves it for an explicit request. It runs on the workflow engine, so a run is capped at 100 rounds (upstream defaults to 256), and the PTC mode preset does not offer it, as it does not offer `workflow`. The upstream `run_code` tool (`dsh-tools` PTC mode) is offered by the same runtime, but only to sessions started in the upstream `ptc` agent preset (PTC mode), which isolated deployments offer under its upstream id so the Web client shows its built-in bilingual name. That preset presents every tool through the generated SDK and, as upstream does, does not offer `workflow`, because `run_code` is its only orchestration surface. The default upstream `standard` preset (Standard mode; sessions recorded under the earlier `dsh-edge` id read as `standard`) presents tools natively and keeps `workflow`. As upstream, Settings → Agent presets writes `selectedDefault` in the `agent-preset-registry` settings namespace to choose which offered preset new sessions start on; a default saved by an earlier release under `agent-presets` moves there on start. In PTC mode, each program is type-stripped with sucrase and runs in its own Dynamic Worker with a 30-second `cpuMs` limit and no outbound network; its `tools.*` calls cross an RPC bridge where the Durable Object caps them at 200 per run (each is a nested tool dispatch with its own session events), 256 KiB of arguments, and 2 MiB per result, and nested calls stay approval-gated. File tools (read/write/edit/read_image) adapted via `EdgeFileSystem` backed by Computer VFS. `glob` and `grep` keep upstream `dsh-tool-fs-search`'s names, schemas, result text, search cards, and spill of results over 100 paths or 250 matches, but Workers cannot spawn its ripgrep binary, so Edge runs them over the VFS: both skip VCS metadata; `grep` also skips binary files and files over 4 MiB and, like ripgrep's defaults that upstream's `grep` keeps, hidden entries and those `.rgignore`, `.ignore`, and (inside a git repository) `.gitignore` files exclude, without entering an ignored directory, so a large ignored `node_modules` costs one entry (as ripgrep's `--glob`, a file `include` matches is searched even when ignored or hidden); `glob`, like upstream's (`--no-ignore --hidden`), lists hidden and ignored files. Ignore globs match by character, where ripgrep matches `?` and classes by byte on Unix, so a rule such as `?` also matches a one-character non-ASCII name. Global gitignore files and `.git/info/exclude` are not read, and an ignore file over 256 KiB, or one that would bring a search past 5,000 compiled matchers (one per rule, or per alternative of its `{a,b}` groups, each kept in memory for the walk), is not applied (the budget is taken in walk order, so an ignore file that comes after it is skipped even when its kind would outrank an earlier `.gitignore`, which ripgrep would honor), and a walk that would test ignore patterns more than 5,000,000 times fails like one past its entry cap. `grep` patterns use RE2 syntax (no lookaround or backreferences) through re2js, which matches in linear time, so a pathological pattern cannot stall the Durable Object. A search walks at most 20,000 entries, and `grep` collects at most 20,000 matching lines or 20 MB of their text; past a cap it fails and asks for a narrower path or pattern. Glob syntax that ripgrep 15 rejects (an unclosed `[` or `{`, a reversed range such as `[z-a]`, a dangling `\`) fails as an invalid pattern; nested alternates such as `a{b,{c,d}}` work. A search checks for cancellation before and after each directory listing, so the 30-second tool timeout stops a long walk. As upstream, the file observation policy (`dsh-fs-observation-policy`) guards them: `write` may not overwrite a file the session has not read, `edit` requires a prior read, and a file changed since it was read (by `bash` or the Linux container, for example) fails as stale until it is read again; a restarted session starts with no reads recorded. Goal tools (`ToolGoal`) composed directly with `GoalService` as upstream cordis plugins. Subagents follow upstream's standard composition: `subagent` starts a fresh child and `subagent_fork` one that starts from the parent's completed turns (`dsh-subagent-spawn-in-process`, `dsh-subagent-fork-in-process`). Both run the child in the background by default as a continuable subagent, and the parent continues it with `send_message`, stops its current turn with `interrupt_agent`, and finds it with `list_agents` (`dsh-tool-subagent-control`). A child keeps working after the parent's turn ends, and its closing message wakes the parent for another turn; as upstream, Stop on the parent does not stop running children. A child that is not running resumes from storage when messaged, also after a restart. The upstream `todo_write` tool (`dsh-tool-todo`) keeps the session's task list, with several tasks allowed in progress as in upstream's composition; its `todos` projection drives the Web client's todo dock. The upstream `present` tool (`dsh-tool-present`) declares workspace files as a turn's deliverables, which the Web client shows as file cards with a sidebar preview; the Edge has no desktop, so it answers the cards' Host check (`/api/present.host`) as unavailable and they offer no native opening. As upstream, `dsh-agent-instructions` loads `AGENTS.md` and `CLAUDE.md` (and their `.local.md` overlays) from the project root (the nearest ancestor directory containing `.git`, or else the session's working directory) down to the working directory, through the workspace VFS, into a 64 KiB baseline message before the first request; a `read`, `write`, or `edit` that reaches a deeper directory adds its instructions to the next request. Workers have no home directory, so the user-global files are `/.dsh/AGENTS.md` and the shared agent root's `/.agents/AGENTS.md` (the Edge sets `DSH_HOME` and `DSH_AGENTS_HOME` itself, because the plugin reads its homes only from those variables). The `working_directory` tool (`dsh-tool-working-directory`) reads the session's working directory or changes it to an existing directory; the change is a durable `working-directory/change` event that a downgrade to a release before this one cannot read, and the Edge always offers `/workspace` as an existing directory. Skill tool via `SkillRegistry`. As upstream `dsh-skill-filesystem`, skills are `<name>/SKILL.md` or `<name>.md` files with `name` and `description` frontmatter under the project's `.dsh/skills` and `.agents/skills` and the user roots `/.dsh/skills` and `/.agents/skills` (Workers have no home directory), read through the workspace VFS, up to 100 entries per root and 64 KiB per skill file; an added or edited skill applies from the next turn, and the `/` menu of a session opened after the change lists it; as upstream, the Web client keeps an open session's `/` list until the page reloads. Skills stored through the owner API `GET/PUT/DELETE /api/skills` (`EdgeSkillProvider`, DO KV) rank below them. MCP runs on the Edge's own client (`edge-mcp-client.ts`; upstream `dsh-mcp-client` is not mounted): Streamable HTTP only (stdio is unavailable on Workers) and one connection per call. A server whose probe reports the `resources` capability is registered with upstream `dsh-mcp-resources`, whose `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` tools exist while one such server is configured (probe an existing server again to record the capability); a server without the tools capability probes as an empty tool catalog. Resource calls follow the connector's tool permission as its read-only tools do, so they ask first only when it asks before every call. Each resources response body is limited to 1 MiB and fails while it streams in past that, because the SDK parses a response whole and a read result, binary data included, is kept in the session log; a list without a cursor follows at most 10 pages or 1 MiB of entries and returns the cursor where it stopped. As upstream, binary contents reach the model only as a description. Configure servers in Settings → DSH Edge → MCP Servers; tools appear as `mcp__<serverName>__<tool>`. Add the remaining tools individually against Worker-compatible capabilities; do not advertise unavailable host behavior. |
| Attachments | Local attachment storage, upstream image references, composer, gallery, lightbox, and provider conversion | Adapted at the native storage seam | Reuse upstream `AttachmentStore`, admission, protocol, authorization, UI, and DeepSeek conversion unchanged. Store immutable PNG/JPEG bytes under their SHA-256 identities in a 64 MiB, 512 KiB-chunked DO backend for new and pre-attachment deployments, or in private R2 for deployments already pinned to it; session events retain only upstream refs. The first backend is pinned per owner instance so claiming or upgrading cannot strand existing references. Images are PNG or JPEG, at most 3.5 MiB each and 4 per message. Other files stream through upstream's upload route and are kept verbatim, at most 64 MiB each (an upload must declare its length, so a larger one is refused before any byte is stored), in the workspace VFS at upstream's `files/<prefix>/<digest>/<name>` layout below `/.dsh/attachments/v1`, the path the model is told; its file tools and the lightweight shell read them there, but commands routed to a Linux Container do not see them. |
| Goal tracking | `GoalService` with create/edit/pause/resume/complete/clear mutations and GoalBar UI | Reused | Install upstream `GoalService` and `ToolGoal` as cordis plugins (direct composition). Browser GoalBar mutations route through `TypertGatewayService` at `/api/goals/<method>`. `SessionProjectionCache` persists goal state across DO restart. The upstream `/goal` command (`dsh-command-goal`) shows, sets, edits, pauses, resumes, or clears the session's goal. Every goal round runs inside an Edge turn, with its workspace, deadline, and live events: a turn stays open while upstream's round driver queues the next round, and a call that arms a goal outside a turn (`/goal`, GoalBar Resume) runs inside a new one. |
| Context compaction | Token metering, automatic compaction, and session title generation | Reused | Install upstream cordis plugins directly. Context compaction, token metering, tool-result pruning, and automatic session title generation run unchanged. Upstream image offload (`dsh-compaction-image-offload`) keeps a turn going when its images exceed the route's budget (600 images per request by default): it marks the oldest occurrences offloaded with an `image/offload` session event and the request is retried. |
| Session projection | Real-time derived state push to connected clients | Reused with Edge bridge | Upstream `onChanged` callback pushes title, model, goal, and session-stats projection frames to connected WebSocket clients. Upstream `dsh-session-stats` (whole-session turn and step counts and model, tool, and first-token times) feeds the Web chat view. `SessionProjectionCache` caches projections in DO KV for cold-session recovery. |
| Session history tools | `dsh-tool-session-query`, an opt-in package in no upstream preset, over `ctx.sessionQuery` | Reused, off by default | Settings → DSH Edge → Optional tools → Session history search mounts upstream's `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read` (the `edge-tools` settings namespace, also `GET/PUT /api/tool-settings`); a change applies from the next model request. Their authorization compares session working directories, and every Edge session starts in `/workspace`, so every session of an instance can read every other. `EdgeSessionQuery` keeps their reads bounded: search reads at most the 32 newest sessions, each within 512 events and 256 KiB (a longer log is skipped, and searching one session covers its first page); titles come from the session summary row; checking access by id reads only those sessions' headers; `session_event_read` reads its event and neighbors in pages of at most 4 MiB each, without loading the log; `session_event_trace` refuses a stored log over 10,000 events or 8 Mi stored characters and loads a smaller one once; `session_trace` lists the stored sessions (the table has no parent index) and is refused on an instance with more than 2,000 of them. For `session_event_read`, a stored row is size-checked before its payload is selected, so an oversized row is never loaded (other readers, such as the history pages, keep one query per page). A saved "on" whose mount fails is retried before the next turn. |
| User questions | `UserQuestionService` answerer waterfall, the `ask_user_question` tool, `dsh-api-remotes` forwarded-event selection, and the Web question composer | Reused with an Edge connection seam | Install upstream `UserQuestionService`, `dsh-tool-ask-user`, and the `dsh-api-remotes` Host entry directly, so a model call to `ask_user_question` forwards its Agent-scoped question through the gateway-owned `$events` stream to the browser composer and the answer returns through `/api/$events/result` as the tool result. The gateway keeps a pending question across a dropped socket and redelivers it on reconnect. Edge adds only a `ctx.connection` seam that captures the gateway's RPC interceptor for the Durable Object, because Workers have no upstream web server. |
| Plan mode | `PlanModeController` with the logged `plan` projection, the `plan:policy` prompt section, the `/plan` command, the `exit_plan_mode` tool, and the Web plan control | Reused | Install upstream `dsh-plan-mode` directly with a deployment-owned `section`. `/plan`, `/plan <message>`, and `/plan off` run through the upstream command runtime; the plan projection reaches the browser like every other projection; and `exit_plan_mode` presents the finished plan for review through the same user-questions path as `ask_user_question`, so approval leaves plan mode from the next accepted step. The Web `dsh-client-ui-plan` control joins the assembly. Plan mode is guidance, not enforcement: every tool stays callable. |
| Queue and steer | Edit, remove, or promote queued messages; steer a running agent | Reused | Queue mutations use the synchronous live-inbox mutation as their acceptance point. Steer mode sends next-step messages to the running `ReactLoopAgent`. |
| Authentication and tenancy | Local trusted-user boundary | Single-owner adaptation | Require one high-entropy Worker secret, exchange it for a signed 30-day HttpOnly `SameSite=Strict` cookie, and route every accepted request to one fixed owner object. This intentionally provides no registration, user database, roles, or multi-tenant routing. |

The browser request path is:

```text
Cloudflare static assets -> upstream Web shell + client plugin graph
  -> POST /api/session.create through the upstream HTTP carrier
  -> host/workspace-changed + session/subscribed over Durable Object WebSockets
  -> POST /api/session.prompt with the client rpcId
  -> upstream image admission validates and stores immutable bytes in the selected R2 or DO backend
  -> canonical session events retain upstream sha256 attachment refs only
  -> AgentRegistry live lookup or resume
  -> sessionPersistence.prepare through PersistenceCoordinator on cold resume
  -> ReactLoopAgent.followup(queue) or ReactLoopAgent.steer(steer)
  -> pre-step admission gate waits for the sessions.flush durability barrier
  -> session/queue snapshots publish live and replay on mux reconnect
  -> TypertGatewayService dispatches goals/edit, goals/clear via Typert RPC
  -> onChanged bridge pushes title/model/goal projection frames
  -> SessionProjectionCache reads/writes KV for cold-session state
  -> upstream dsh-llm-deepseek plugin resolves configuration from settings + launch environment
  -> upstream attachment resolver reads and verifies authorized backend bytes
  -> upstream LlmRuntime + ReactLoopAgent stream/event pipeline
  -> upstream ToolRuntime native bash, read/write/edit, or web_search call
  -> upstream WebRuntime + DeepSeek native search provider for web_search
  -> direct just-bash backend in the owner Durable Object
     (or optional Computer Worker Shell when LOADER is bound)
  -> Durable Object /workspace VFS
  -> upstream tool/result and next model step
  -> ReactLoopAgent appends canonical inbox, message, tool and boundary events (V3 embeds compact streams in assistant events)
  -> sessions.flush durable barrier -> Durable Object SQLite backend
  -> session/event, projection, and status frames over Durable Object WebSockets
  -> upstream Web runtime reconciles and renders the canonical events
```

The local integration suite uses an SSE stand-in with real Wrangler, Durable Object SQLite, local R2, the Direct Computer workspace backend, static assets, the HTTP carrier, and WebSockets. Direct mode exercises DO attachment storage; Isolated mode exercises private R2. Together they verify:

- owner login, API/WebSocket cookie enforcement, legacy-selector rejection, and disabled Direct-shell networking;
- upstream session create/list/history/search/prompt/rename/fork and queue edit/remove/steering flows;
- image admission through the upstream composer, protocol, provider, authorization, fork reuse, and restart persistence;
- Workspace create/list/rename/delete/reorder/archive, live/reconnect baselines, and Host frames;
- real browser boot, UI-issued Workspace rename, image turn, content search, branch, archive, and expired-session login recovery;
- conversation continuity, event replay, two-step bash and Web Search tool exchanges, and Wrangler-restart restoration;
- Typert URL routing validation and snapshot-level tool definition verification; goal and file tool end-to-end integration tests are not yet implemented.

A focused failure test proves that post-enqueue durability failure blocks model use without reporting the already-woken prompt as rejected. Committed model-visible and ARIA goldens pin tool transcripts and the assembled upstream Web client. A live DeepSeek call requires the developer's key and is intentionally outside the repository test suite.

## API-key boundary

`DEEPSEEK_API_KEY` may be set as a Worker secret at deployment or entered later through the Settings → Models page. The Edge credential provider checks Durable Object KV first, then falls back to the Worker environment variable; resolved values remain request-scoped and are never written to session events or responses. Surrounding whitespace is removed; a blank value is unconfigured.

An API key for another provider is entered on the same Models page, which stores it under the credential name the provider's route names (for example `OPENROUTER_API_KEY`) in Durable Object KV. These keys are not read from Worker variables: only `DEEPSEEK_API_KEY` keeps that fallback, for deployments from before the Models page. A route's extra headers are stored in the settings document in plain text, so only headers that never carry a secret are accepted: `HTTP-Referer`, `Referer`, `X-Title`, `OpenAI-Organization`, `OpenAI-Project`, and `anthropic-beta`. A gateway that needs a second credential header, such as an authenticated Cloudflare AI Gateway's `cf-aig-authorization`, cannot be configured yet. A route's key name may not be one that belongs to DeepSeek or another Edge feature (`DEEPSEEK_*`, `MCP_TOKEN_*`, `DSH_EDGE_*`), so the deployment's DeepSeek key is never sent to another endpoint. Every route needs its own key name: without one pi-ai would look for a key in the process environment, where Workers expose the deployment's secrets.

| Variable | Purpose and validation |
| --- | --- |
| `DEEPSEEK_BASE_URL` | Anthropic-compatible Messages endpoint. Defaults to `https://api.deepseek.com/anthropic`. DeepSeek's former OpenAI-compatible root (`https://api.deepseek.com`, `/v1`, or `/beta`), here or saved as the Models page Base URL, is moved to that default on start; a 404 from another endpoint keeps its message and adds that the endpoint may not serve the Messages API and where to change it. Must be HTTP(S) without URL userinfo. The browser projection omits query and fragment components that may carry gateway credentials. |
| `DEEPSEEK_SEARCH_BASE_URL` | Anthropic-compatible Messages endpoint for native Web Search. Defaults to `https://api.deepseek.com/anthropic/v1`; must be HTTP(S) without userinfo, query, or fragment. Search does not follow redirects. |
| `DEEPSEEK_MODEL` | Validated deployment default; defaults to `deepseek-flash` (DeepSeek-V4.1-Flash, with image input). Each session may choose another upstream catalog entry. As upstream, the latest choice in any session becomes the model new sessions start on, so this value applies until the owner first picks a model. |
| `DEEPSEEK_REASONING_EFFORT` | `off`, `low`, `high`, or `max`; defaults to `high`. |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | Optional positive safe integer overriding the 256,000-token chat default. |
| `DEEPSEEK_STREAM_IDLE_TIMEOUT_MS` | Optional positive integer up to 2,147,483,647; defaults to 120,000 ms. |
| `DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS` | Default Computer command timeout; defaults to 120,000 ms. |
| `DSH_EDGE_MAX_COMMAND_TIMEOUT_MS` | Caller-selectable timeout ceiling; defaults to 120,000 ms and cannot be lower than the default. |

Invalid deployment configuration fails before session lookup or SSE response creation. Edge mounts upstream `web_search` and `web_fetch` with 30-second tool-call timeouts and structured results. `web_fetch` uses the upstream anonymous HTTP(S) provider and converts HTML to Markdown in the Worker. It accepts only HTTP(S) URLs without embedded credentials, rejects IP literals and local naming scopes before every request and same-origin redirect hop, and bounds URL length, response bytes, decoded characters, redirect count, and elapsed time. The Worker enables Cloudflare's strictly-public global fetch path so DNS changes cannot route a model-selected URL to a same-zone origin or private binding; JavaScript-rendered pages remain outside this basic HTTP fetch path.

### Owner authentication

- `DSH_EDGE_ACCESS_KEY` is the single-owner boundary. It must contain 32–512 UTF-8 bytes without surrounding whitespace or control characters; generate a random value instead of reusing a human password.
- Login creates a signed 30-day HttpOnly `SameSite=Strict` cookie. HTTPS uses the host-only `__Host-dsh_edge_owner` name with `Secure`; local HTTP uses an unprefixed cookie.
- The cookie carries no user data, is never forwarded to the Durable Object, and becomes invalid when the access key rotates.
- Unauthenticated API and WebSocket requests return 401. Only an owner-authentication 401 carrying `WWW-Authenticate: DshEdgeOwner` makes the same-origin shell navigate to `/login`; provider/configuration 401 diagnostics remain visible.
- Authenticated browser API and WebSocket requests from another origin return 403 even with a same-site cookie.
- The Web shell declares the browser transport as host-owning (`__DSH_TRANSPORT__.ownsHost`), so upstream's loopback-only trust tier, which gates host-persisted plugin settings and the settings document editor, applies to the authenticated owner on any origin.
- The asset policy prevents framing through `/`, `/index.html`, or an SPA fallback. `/` redirects to `/login`; `/api/health` and immutable assets remain public.

This deliberately is not an account system or multi-tenant boundary.

## Install on Cloudflare

| Target | Cloudflare requirement | Command boundary | Health identifier |
| --- | --- | --- | --- |
| Direct (default top level) | Workers Free; no Loader binding | Hardened just-bash in the agent/VFS Durable Object, with explicit timeouts, bounded output/environment, and no network command | `just-bash-direct` |
| `env.isolated` | Workers Paid with `LOADER` | Computer Worker Shell in a separate Dynamic Worker | `just-bash-isolated` |
| `env.container` | Workers Paid with `LOADER` and a `basic` Container | The isolated Worker Shell for most commands; commands that need Linux are routed to a Debian container through computerd (see `src/bash-routing.ts`); the isolated Worker artifact | `linux-container` |

Direct mode is lighter isolation than a separate Worker; do not expose the single-owner deployment to untrusted users. Workers Paid is a Workers subscription starting at $5 per month, not the Cloudflare Pro website plan. Worker names have independent Durable Object storage and secrets, so use different names when both modes should remain live.

`wrangler.jsonc` remains the canonical source for both modes:

- Release packaging builds one tested, minified artifact per mode.
- Direct replaces only Computer's unreachable Dynamic Worker shell-core module; its Workspace adapter and command exports remain upstream.
- Isolated preserves that shell core and replaces the unreachable Direct backend with a fail-closed module. Each artifact therefore carries only its selected command runtime.
- The installer generates a private mode-specific config, points it at the selected artifact, and uploads with `no_bundle`. The user's machine does not rebuild dsh-edge or resolve Harness packages into a new Worker.
- Container mode deploys the isolated artifact with `docker.io/pawaca/dsh-edge-computer:<version>`, which the release workflow builds from `container/Dockerfile` and pushes once per version before npm publication. Installing it needs no local Docker; `pnpm dev:container` and `pnpm test:container` build the Dockerfile locally and do.
- CI starts the Direct artifact from an installed tarball. Bundling rejects a Worker above Cloudflare's 64 MiB uncompressed limit (Cloudflare has no compressed-size limit, temporary accounts included), and CI profiles each artifact's startup against Cloudflare's 1 s startup limit.

### Install and upgrade

Run the stable installer without cloning this repository:

```sh
npx dsh-edge install
```

This resolves through npm's `latest` channel. Use `npx dsh-edge@next install` only to opt into a newer prerelease when one is available.

Pressing Enter at every prompt installs a working instance and opens it in the browser. Running the same command again with the same Worker name updates that instance in place. `upgrade` does the same but refuses a name that does not exist yet:

```sh
npx dsh-edge upgrade
```

If the installed version contains `-alpha` or `-rc`, promote it to the stable channel once with `npx dsh-edge@latest upgrade`. The Edge settings page derives its command from the installed version; without that explicit `@latest` command, an existing prerelease remains on `next`.

### What the installer asks

The installer asks in this order: account, Worker name, then what to change. Every question comes before one confirmation; after it the installer only deploys and hands over.

- **Account.** A signed-in Cloudflare account comes first, so Enter keeps a permanent instance. Without a login the temporary account comes first; it needs no login, runs only the free capabilities, and must be claimed within 60 minutes. You can also sign in or create an account.
- **Worker name.** The installer checks whether the name already exists in that account. `--name` alone selects the Worker, whatever capabilities deployed it.
- **An existing name is an update.** The installer reads what the Worker can do from its bindings and offers **Update it** (the default), **Update and change what it can do**, **Update and reset the access key**, **Use another name**, or **Cancel**. "Update it" is the confirmation: it deploys the new release with the same capabilities and keeps conversations, files, the owner access key, and the DeepSeek key. It never renames the Worker for you or asks for secrets again.
- **A new name asks what the agent should do.** The choices are cumulative, and the price comes second:
  - `Research and write` (the direct mode, the default): search the web, read pages, draft docs, and connect your tools through MCP. It runs on Workers Free.
  - `+ Analyze data and split big jobs` (the isolated mode): adds `workflow` for parallel subagents and `ralph` for fresh-agent loops, and `run_code` for scripts over your data in sessions started in the PTC mode agent preset (which, like upstream, does not offer `workflow`, nor `ralph`). It requires Workers Paid (from $5/month).
  - `+ Work on code projects` (the container mode): adds a Linux container for git, npm, and python. Commands start in the isolated shell; routing sends a command to the container only when a program it starts is outside the lightweight shell's verified set, the command cannot be parsed confidently, or the agent sets `linux: true`. At most two container commands run at once. It requires Workers Paid plus container time while it runs.
- **Changing capabilities.** The capability list marks the current choice. Choosing less asks a second confirmation that names what is removed and defaults to No. Leaving the container mode keeps the Worker's Container application as the rollback target and prints the command that removes it; run it after you sign in and the new version works, to stop Container billing.
- **One confirmation.** The summary lists what the instance can do, its cost, the account, the Worker, image storage, and the defaults below. For a temporary account, confirming also accepts Cloudflare's Terms of Service and Privacy Policy.

### Defaults

- **Images** are stored in the instance's Durable Object (64 MiB), so a new install needs no R2 setup. Every deployment records its attachment-storage marker, and updates keep the marked or bound backend. A Worker already on private R2 stays there; if R2 is no longer enabled (Cloudflare error `10042`), the installer offers the account's activation link, a retry, or cancellation, never a switch that would strand image references. A pre-image Worker has no references to strand and moves to the Durable Object default. Mixed active rollouts are refused rather than guessed.
- **The owner access key** is generated for a new instance and shown when installation finishes. To choose your own, set `DSH_EDGE_ACCESS_KEY` (32–512 UTF-8 bytes) in the installer's environment; it stays out of shell history and the process list. An ordinary update keeps the existing key. Cloudflare cannot show a stored key again, so if you lose it, run the upgrade command for your deployment's release channel and choose **Update and reset the access key**: `npx dsh-edge upgrade` on a stable release, or `npx dsh-edge@next upgrade` if the installed version contains `-alpha` or `-rc` (the login page shows the one for your deployment). The installer deploys the release with a new key (generated, or `DSH_EDGE_ACCESS_KEY`) and shows it once. Conversations, files, and the DeepSeek key are kept; the old key stops working, and every signed-in browser must sign in again.
- **The DeepSeek API key** is added after installation in Settings → Models. The installer never asks for it.
- **Image optimization** (the Cloudflare Images binding) is on for accounts you own and off for temporary accounts.

### Credential handoff and activation

- A new instance's owner key, or the replacement key of an update that resets it, travels through a mode-`0600` temporary secrets file, which is removed after the command. Wrangler applies the file additively, so the Worker's other secrets stay. An ordinary update passes no secrets file, so Cloudflare keeps the Worker's existing secrets. Wrangler receives only an allowlisted runtime environment and the selected Cloudflare authentication; unrelated ambient secrets and Node injection options do not reach the child.
- Wrangler's structured output supplies the deployed URL. Add `--verbose` to inspect full deployment diagnostics.
- After upload, the installer observes public `/api/health` for up to 45 seconds without credentials or redirects. Only the exact package version and capabilities count; propagation, challenge, placeholder, transport, and older-release responses remain pending. A new instance, or an update that resets the key, then signs in with the new key and checks `/api/ready`. An ordinary update does not know the kept key, so it reports the verified release as live and asks you to sign in.
- Observation expiry exits successfully and asks the owner to refresh shortly. It never calls DeepSeek or touches Durable Object state.
- The final card prints the URL, the new owner key (or "unchanged" after an ordinary update), and next steps, then offers to open the URL in your browser (default Yes, interactive terminals only). Temporary accounts also receive a bearer claim URL that must be claimed within 60 minutes.
- A rejected upload is reported as not installed. If Wrangler created a temporary account, its claim URL is still shown without presenting the unused owner key as active. A paid capability rejected by Cloudflare suggests enabling Workers Paid or choosing `Research and write`.
- If upload succeeds but handoff fails, a recovery card prints the active owner key and all known URLs before the command exits unsuccessfully.
- Installation uploads directly through Wrangler; it does not create or bind a GitHub repository, Cloudflare Builds project, or source-build pipeline.

Contributors working from a checkout can reproduce the two release artifacts locally with `pnpm --filter dsh-edge bundle:direct` and `pnpm --filter dsh-edge bundle:isolated`. Both commands enforce Cloudflare's 64 MiB uncompressed Worker size limit (Cloudflare has no compressed-size limit), and `pnpm --filter dsh-edge check:startup` profiles the promoted artifacts' startup against Cloudflare's 1 s startup limit.

Contributors can replay the complete Free temporary-account journey without a key or network call. This example runs the shipped bin, real prompts, Wrangler subprocess, structured deployment-output parsing, public-activation observation, and final handoff while replacing the external Cloudflare boundaries:

```sh
pnpm --filter dsh-edge example:install
```

## Edge API

### Upstream RPC carrier

- `POST /api/<upstream-method>` accepts the upstream `ClientRequest` envelope for supported `ApiProxy` methods.
- The Web client uses session list/search/create/history/models/select/prompt/updateQueue/rename/fork/cancel; host description; Workspace list/create/rename/delete/reorder/archive; skills; agent presets; settings and credential descriptions; and LLM catalogs.
- `agentPreset.read` renders the programmatic Edge composition through the upstream read-only viewer. `credentials.describe` returns credential state without a value.
- Search projects canonical current-message surfaces and returns bounded upstream result values.
- Fork copies a completed-turn prefix through the canonical session seed format and retains parent lineage. Edge refuses seeds above 8,192 events or 8 MiB instead of materializing unbounded history.
- Queue mutations edit, remove, or promote an item through the live upstream Agent inbox. The synchronous mutation is the acceptance point; the persistence coordinator owns later write-behind and retirement retry.
- Workspace mutations persist upstream workspace-domain global and record shapes through the Durable Object backend. Archive preserves the session log and Workspace slot; unary responses and Host frames carry the same full snapshots as upstream.
- Goal mutations (create, edit, pause, resume, complete, clear) route through `TypertGatewayService` at `/api/goals/<method>`. Each `@Remote` service requires its Typert descriptor to be registered via `ctx.typert.register()`; no per-method HTTP handler is needed.

### Authentication and downlinks

- `GET /login` renders the owner form. `POST /api/auth/login` exchanges the configured key for a signed cookie; `GET /api/auth/session` reports validity; `POST /api/auth/logout` clears it.
- `GET /api/events.mux` and `GET /api/events.host` upgrade to upstream downlink WebSockets. The Durable Object serializes each socket's channel and verified owner-session expiry as a hibernation attachment, closes it at expiry through an alarm, and reconstructs canonical sessions plus retained blank headers from SQL.
- After each committed inbox splice, mux publishes a complete `session/queue` snapshot. Reconnecting clients receive pending live-inbox baselines.
- `POST /api/commands/list` uses the upstream generated-Remote envelope with an empty catalog because the Edge preset registers no human commands.
- `GET /api/health` returns the public release/mode identifier and configured attachment default (`private-r2` or `temporary-do`). It validates owner authentication, deployment-scoped DeepSeek credentials, model/transport choices, and command timeouts before reporting ready.
- `GET /api/ready` requires the owner cookie and waits for session migration, workspace registration, the browser's session/workspace controllers, and registration of the DeepSeek model adapter. It does not make a provider request. It returns HTTP 503 with `runtime-initialization-failed` if startup fails; public health alone does not prove runtime readiness. Ordinary authenticated routes wait for base initialization without requiring the model adapter, preserving history and recovery access when only model initialization failed.
- Health does not call the provider, Durable Object, R2, VFS, or shell. The authenticated agent-preset projection reports the pinned backend, temporary cap, deployment-default model, and runtime-derived upstream catalog with session selection scope.

Release upgrades automatically normalize the known legacy Edge cancellation records and migrate all outdated session logs, summaries, and blank headers in one SQLite transaction. All old logs are decoded and validated before the first migration write, so incompatible later logs cannot repeatedly consume earlier migration writes on restart. Preflight discards each decoded artifact; migration decodes again in the same synchronous transaction to avoid retaining every history in memory. If any session is incompatible or a write fails, that startup migration is rolled back in full. No session is silently skipped or deleted. This transaction covers session-format migration, not arbitrary plugin storage changes or external side effects. The installer matches the Cloudflare Worker version ID from upload output against both public health and authenticated readiness, so an earlier deployment of the same package cannot satisfy the check. The version metadata binding is included in both modes. The installer checks runtime readiness before reporting success; a timeout is reported as unverified, and a confirmed startup failure reports an error with recovery details. It never automatically rolls back Worker code after a schema upgrade. Release tests boot both prebuilt modes with legacy cancellation data, verify continuation, and reject false readiness on incompatible data; the packed npm artifact is also checked for authenticated runtime readiness.

SQLite `DELETE` operations consume the daily row-write allowance too. During format migration, Edge compares the number of legacy and current event rows: a single index-backed probe stops once copying current rows would cost more; when copying is cheaper, it writes the migrated compact logs into a replacement table and swaps tables inside the same transaction, avoiding a billed delete for every legacy token delta. Otherwise it replaces only the affected sessions. Current session logs are preserved, and failed migrations roll back the table swap. This reduces migration writes but cannot guarantee that every database fits the Free plan's 100,000 daily row-write allowance; sufficiently large upgrades or earlier daily usage can still exhaust it. Point-in-time recovery restores data, not the account's consumed daily quota.

### Diagnostic REST routes

- `PUT /api/workspace/file?path=/workspace/...` writes a UTF-8 file.
- `GET /api/workspace/file?path=/workspace/...` reads a UTF-8 file.
- `DELETE /api/workspace/file?path=/workspace/...` removes a file.
- `POST /api/workspace/exec` accepts `{ "command": "...", "cwd": "/workspace/..." }`; `cwd` defaults to `/workspace`, every execution receives the default timeout (the Shell card's saved value, else `DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS`, never above `DSH_EDGE_MAX_COMMAND_TIMEOUT_MS`), `timedOut` reports whether that deadline elapsed, and `outputTruncated` reports whether some output is not inline; `stdoutTruncated`/`stderrTruncated` name the stream shown only as its tail and `stdoutSpillPath`/`stderrSpillPath` where its complete output was saved.
- `POST /api/sessions` creates a persistent session with a required `title`, recorded as a standard user-sourced `session/title` event before the API returns. If the session is durable but its Workspace attachment fails, the 500 response uses `session/workspace-attach-failed` and includes the complete created `session`, so callers can recover its id instead of creating a duplicate.
- `GET /api/sessions?after=...&limit=...` lists one bounded summary page; `GET /api/sessions/:sessionId` reads one. Session deletion is not exposed because the upstream persistence service does not define destructive deletion.
- `POST /api/sessions/:sessionId/turn` accepts `{ "message": "..." }` and streams persisted SSE events.
- `GET /api/sessions/:sessionId/events?after=...&limit=...` replays a bounded event page and returns continuation headers.
- `POST /api/sessions/:sessionId/cancel` aborts the active turn owned by the current Durable Object process.

### Session and Workspace behavior

- Session creation and fork return `session/workspace-attach-failed` with the published session and Workspace ids when publication succeeds but Workspace attachment fails. The diagnostic route returns the same code plus the complete created session.
- Prompt and queue-edit text share a 64 KiB semantic limit. Their 10 MiB RPC carrier leaves room for a 7 MiB raw-image batch after base64 and envelope overhead.
- Because Edge has no directory-flow provider, the upstream browser hides Delete on its sole Workspace and exposes it again whenever restoration remains possible.
- `@file` completion serves the upstream `fileReferences/list` Remote from the Computer VFS one directory at a time: the session working directory for a bare fragment, or the directory a trailing slash names. There is no recursive fuzzy index because every listing is a Computer call. `@session` mentions and their pre-step snapshots come from the upstream session-reference service unchanged; its candidate discovery and either agent-scoped Remote resume a cold session through the upstream controller and keep it resident until the Durable Object is evicted.

### Limits and request admission

| Surface | Limit |
| --- | --- |
| UTF-8 text file | 1 MiB |
| Shell command | 16 KiB |
| User message or queue-edit text | 64 KiB |
| Shell output kept inline, per stream | 64,000 bytes by default (the Shell card's output cap, 1 KiB to 1 MiB); the rest spills, up to 16 MiB per stream |
| Session-create JSON body | 8 KiB |
| Workspace-exec JSON body | 128 KiB |
| Message-bearing turn or queue-update RPC | 10 MiB |
| Images | PNG/JPEG; 4 per message; 3.5 MiB each; 7 MiB total; 40 million pixels; 2,000 px per side |

- Request bodies are consumed incrementally. Once a route limit is crossed, later chunks are drained without being retained and the route returns 413. File uploads also reject malformed UTF-8.
- File reads check VFS metadata, then collect the opened byte stream through the same 1 MiB cap. This closes the growth race between `stat()` and `readFile()` without retaining an unbounded value.
- Image admission fully decodes the declared raster format before writing.
- As upstream `bash-local`, a command keeps running past the output cap: each stream keeps its last 64,000 bytes inline by default (the Shell card's output cap, 1 KiB to 1 MiB), and the whole stream is saved to `/workspace/.spill/bash-<execution>.<stream>.txt` (deleted with the other spills after 30 days), up to 16 MiB per stream (upstream allows 64 MiB; each 512 KiB costs about five Durable Object rows written, and the workspace storage does not free deleted bytes, #358), past which the file keeps its start and the result says so. Memory stays at the tail plus a 1 MiB write queue per stream: reading the command's output waits while the spill is written. Output under the cap writes nothing. The lightweight shell (just-bash) returns a command's output whole instead of streaming it, so it still stops a command whose output passes 8 MiB (exit 126, reported as `[stopped: …]`); that buffer lives in its isolate, the Durable Object in Direct mode. The bash tool renders upstream's layout: stdout, a `[stderr]` section, `[output truncated; full output: <path>]` per stream, `[timed out after Nms]`, and `[exit code: N]` last, and its terminal card shows the working directory. A `timeoutMs` above the deployment ceiling is lowered to it, as upstream clamps it; the HTTP exec route still refuses one. `cancelled` reflects an adapter-requested interruption; `timedOut` independently records deadline expiry.

### Durability and concurrency

- Failed initial session persistence discards the retained unmaterialized batch before disposing the new upstream agent handle, so teardown cannot commit a session whose create request returned an error.
- A lazy blank session retains only its upstream header. The first canonical event removes that header in the same SQL transaction.
- Each turn owns one upstream handle and disposes it after streaming, so previously accessed conversations do not remain resident for the Durable Object lifetime.
- Deployment settings resolve before the process-local owner claim. One owner process rejects concurrent turns; cancellation uses the native agent path.
- A prompt is accepted and running state is published only after its inbox event crosses `SessionStore.flush()`. Streamed events cross the same durability barrier before WebSocket or SSE delivery.
- Queue edits, removals, and steering promotion use the synchronous live-inbox mutation as their acceptance point. `PersistenceCoordinator` owns later write-behind and retirement retries, so a later storage attempt cannot reverse an accepted mutation.
- Session rename uses the synchronous title append as its acceptance point for both active and cold sessions.
- Workspace global state and records keep upstream logical schemas under Edge-specific physical keys. DO transactions atomically pair record and registry-order changes; a process-local chain serializes Workspace mutations.
- Committed rename, delete, recreation, session reorder, attachment, and archive changes publish matching upstream Host frames. `workspace.list` restores the complete baseline after restart.
- Cold resume uses upstream interrupted-turn repair to close an open persisted tail. Canonical `session/end-seed` markers preserve lifecycle boundaries.

### Bounded reads and canonical history

- Replay checks session absence separately, so persistence corruption and SQL failures do not collapse into 404. It reads one bounded SQL page and caps the encoded response.
- `PersistenceCoordinator.readValidatedPage()` validates identity, format, legacy shape, and event vocabulary on every page without adding Edge pagination to the public persistence service.
- If legacy normalization needs earlier messages, it rereads one prefix through the same byte-bounded loader and refuses the page when that prefix does not fit.
- Cold browser history selects its message boundary in SQL and loads only the resulting contiguous range under fixed event and stored-byte ceilings.
- Session listing queries one bounded canonical header/title summary page. Detail reads a canonical point summary or retained blank header; turn existence checks use point queries instead of projecting a complete log.
- Effective model, system prompt, adapter defaults, and tools remain standard `request/header` events. The request-scoped adapter applies validated deployment reasoning and output policies.
- Workspace paths must stay below `/workspace/`.
