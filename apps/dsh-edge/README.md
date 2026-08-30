# dsh-edge

English | [中文](README.zh.md)

`dsh-edge` deploys your own persistent DeepSeek Harness to Cloudflare Workers in one command, then makes it available from any browser. The public CLI installs and upgrades it without a source checkout, connected repository, or build pipeline.

Under the hood, one deployment maps its authenticated owner to one Durable Object whose SQLite-backed virtual filesystem survives requests. By default, an in-process just-bash backend runs commands against that same filesystem without a Linux container or Dynamic Worker.

`dsh-edge` is an independent community project. It is not affiliated with or endorsed by DeepSeek; DeepSeek Harness remains an upstream dependency under its own license.

The checked-in Wrangler configuration exposes two deployment targets from the same application graph. The default target is direct mode for Workers Free and has no Worker Loader binding. The named `isolated` target adds the `LOADER` binding and requires Workers Paid, but does not fork the DSH protocol, storage, UI, or tool implementation.

The runtime keeps upstream ownership clear:

- `ReactLoopAgent`, `AgentRegistry`, `LlmRuntime`, `ToolRuntime`, `SystemPrompt`, `SessionStore`, and `SessionPersistence` run through the upstream Cordis composition.
- The upstream `dsh-llm-deepseek` cordis plugin is installed directly, auto-registering its settings namespace and configurable provider entry. Edge maps the native DSH `bash` tool onto Cloudflare Computer.
- Durable Object SQLite implements the upstream persistence backend contract. `PersistenceCoordinator` still owns write-behind, revisions, resume preparation, and crash recovery.
- Model history is projected from canonical events rather than persisted in a second Edge schema.
- `GoalService` and `ToolGoal` run as upstream cordis plugins (direct composition). Browser GoalBar mutations route through `TypertGatewayService`.
- `SessionProjectionCache` persists goal, title, and model state across Durable Object restart via KV cache.
- `EdgeFileSystem` provides read, write, edit, and read_image tools backed by the Durable Object VFS.
- Context compaction, token metering, and automatic session titles run as upstream cordis plugins.

The browser also remains upstream-owned:

- A build-time assembler derives the Web roster from upstream configs, injects the standard `window.__DSH_BOOT__` graph, and emits Cloudflare static assets.
- The Durable Object implements supported upstream `ApiProxy` methods through the standard HTTP carrier and supplies both downlinks as hibernatable WebSockets.
- The image composer, gallery, lightbox, attachment wire contract, and DeepSeek serializer are reused unchanged.
- The storage seam chooses private R2 for new permanent deployments, bounded Durable Object storage for temporary deployments, and a one-time owner choice for pre-0.3 Workers.
- Client plugins whose host domains are unavailable are excluded instead of forked. Session-log export and optional local-host plugins remain unavailable.
- A small Edge-owned login shell protects the upstream UI and protocol without changing either one.

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
DEEPSEEK_MODEL=deepseek-v4-flash
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
| LLM protocol | DSH messages, content blocks, stream chunks, tool calls, usage, and finish reasons | Reused | Let upstream `LlmRuntime` and `ReactLoopAgent` assemble, stream, and log the model exchange. |
| Agent loop | Cordis-composed `ReactLoopAgent` with hooks, guards, sessions, and tools | Reused | Create and cold-resume agents through `AgentRegistry`. Context compaction, token metering, tool-result pruning, and automatic session title generation run as upstream cordis plugins. |
| Bash tool | Node subprocess, sandbox, terminal, and job services | Adapted at the native tool seam | Register an upstream `ToolDefinition`, but execute its body through the configured Computer workspace backend and just-bash. The default direct backend runs inside the owner Durable Object with hardened interpreter limits and no network command; adding a `LOADER` binding selects Computer's isolated Worker Shell backend. Native tool cancellation sends `SIGINT` through the Computer execution handle. Deployment configuration supplies an explicit default timeout and caller-selectable ceiling, while `timedOut` reports the deadline independently from exit and cancellation status. Native binaries, background processes, PTYs, and arbitrary Linux behavior are unavailable. |
| Workspace filesystem | Local filesystem services and host paths | Adapted | Store `/workspace` in the owner's SQLite-backed Durable Object VFS. |
| Session persistence | `SessionPersistence` service, `PersistenceCoordinator`, and local JSONL/SQLite backends | Native backend adaptation | Reuse the upstream service and coordinator ownership. Implement storage primitives over Durable Object SQL with the upstream header/event mapping. One Edge-only table retains empty session headers across transparent hibernation and is removed when canonical rows materialize; no Edge turn or message schema exists. Internal coordinator helpers validate the bounded replay loader and abandon a failed unmaterialized creation before disposal. |
| Settings and credentials | File-backed settings, launch environment, and credential services | Writable with DO storage | The upstream `dsh-settings` plugin persists user sections in Durable Object KV via `DurableObjectSettingsProvider`. The upstream `dsh-llm-deepseek` cordis plugin is installed directly, auto-registering the `llm-deepseek` settings namespace and configurable provider entry; the Settings → Models page can read and modify provider configuration (base URL, model catalog, API key reference, reasoning effort) at runtime without redeployment. `EdgeCredentialProvider` resolves credentials from DO KV first, then falls back to Worker environment secrets; `set`/`unset` persist through the upstream seam. Deployment defaults (maxTokens 256,000, reasoningEffort high) are aligned with the upstream plugin so unset deployment variables match upstream behavior. |
| Host boot and plugins | Node command line, Cordis profile loading, package resolution, and HMR | Explicit Edge composition | Keep the local boot profile out of Workerd. Build immutable client bundles ahead of deployment; exclude HMR and host domains that the Edge `ApiProxy` does not expose. |
| DSH transport | Typed HTTP RPC plus mux and host WebSocket downlinks | Reused with an Edge server implementation | Use the upstream fetch carrier for unary methods and preserve its envelopes, schemas, projections, lazy blank-session behavior, bounded content search, prompt and queue mutations, workspace mutations, queue snapshots, and event frames. Durable Object WebSocket hibernation owns both downlinks; mux reconnects replay pending live inbox state, while REST/SSE routes remain a diagnostic compatibility path. |
| Workspace registry | Storage-domain global state plus `WorkspaceRecord` rows | Native backend adaptation | Keep the upstream global and record value shapes, including manual session order and archive membership, but map their physical keys and atomic writes to Durable Object storage. Edge constrains the registry to the one native `/workspace` VFS; rename, delete, recreation, and session reordering retain the upstream RPC and Host-frame semantics. |
| Existing Web UI | Runtime-loaded shell and `dsh.client` plugin graph | Reused with generic composition fallbacks | Assemble the upstream shell and supported upstream client bundles as Worker assets. Shared slot-occupancy rules hide actions whose provider is absent; Cloudflare serves ordinary assets directly, while `/`, `/login`, and `/api/*` enter the Worker for owner access control. The assembled asset policy prevents every direct or SPA-fallback shell alias from being framed. |
| Other tools | Web Search, filesystem editor tools, MCP, skills, workflows, jobs, and subagents | Search, file, and goal tools ported; MCP, skills, workflows, and subagents not yet ported | Reuse upstream DeepSeek Web Search with its 30-second tool-call timeout. File tools (read/write/edit/read_image) adapted via `EdgeFileSystem` backed by Computer VFS. Goal tools (`ToolGoal`) composed directly with `GoalService` as upstream cordis plugins. MCP client (`dsh-mcp-client`) not yet installed; Streamable HTTP transport is feasible on the free plan. Add the remaining tools individually against Worker-compatible capabilities; do not advertise unavailable host behavior. |
| Attachments | Local attachment storage, upstream image references, composer, gallery, lightbox, and provider conversion | Adapted at the native storage seam | Reuse upstream `AttachmentStore`, admission, protocol, authorization, UI, and DeepSeek conversion unchanged. Store immutable PNG/JPEG bytes under their SHA-256 identities in private R2 for new permanent deployments or in a 64 MiB, 512 KiB-chunked DO backend for temporary deployments and owners who select it while upgrading a pre-attachment Worker; session events retain only upstream refs. The first backend is pinned per owner instance so claiming or upgrading cannot strand existing references. |
| Goal tracking | `GoalService` with create/edit/pause/resume/complete/clear mutations and GoalBar UI | Reused | Install upstream `GoalService` and `ToolGoal` as cordis plugins (direct composition). Browser GoalBar mutations route through `TypertGatewayService` at `/api/goals/<method>`. `SessionProjectionCache` persists goal state across DO restart. |
| Context compaction | Token metering, automatic compaction, and session title generation | Reused | Install upstream cordis plugins directly. Context compaction, token metering, tool-result pruning, and automatic session title generation run unchanged. |
| Session projection | Real-time derived state push to connected clients | Reused with Edge bridge | Upstream `onChanged` callback pushes title, model, and goal projection frames to connected WebSocket clients. `SessionProjectionCache` caches projections in DO KV for cold-session recovery. |
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
  -> ReactLoopAgent appends canonical inbox, chunk, message, tool and boundary events
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

| Variable | Purpose and validation |
| --- | --- |
| `DEEPSEEK_BASE_URL` | Chat endpoint. Must be HTTP(S) without URL userinfo. The browser projection omits query and fragment components that may carry gateway credentials. |
| `DEEPSEEK_SEARCH_BASE_URL` | Anthropic-compatible Messages endpoint for native Web Search. Defaults to `https://api.deepseek.com/anthropic/v1`; must be HTTP(S) without userinfo, query, or fragment. Search does not follow redirects. |
| `DEEPSEEK_MODEL` | Validated deployment default; defaults to `deepseek-v4-flash`. Each session may choose another upstream catalog entry. |
| `DEEPSEEK_REASONING_EFFORT` | `off`, `low`, `high`, or `max`; defaults to `high`. |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | Optional positive safe integer overriding the 256,000-token chat default. |
| `DEEPSEEK_STREAM_IDLE_TIMEOUT_MS` | Optional positive integer up to 2,147,483,647; defaults to 120,000 ms. |
| `DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS` | Default Computer command timeout; defaults to 120,000 ms. |
| `DSH_EDGE_MAX_COMMAND_TIMEOUT_MS` | Caller-selectable timeout ceiling; defaults to 120,000 ms and cannot be lower than the default. |

Invalid deployment configuration fails before session lookup or SSE response creation. Edge mounts upstream `web_search` with a 30-second tool-call timeout and structured results. `web_fetch` remains disabled because the runtime has no arbitrary-URL network policy.

### Owner authentication

- `DSH_EDGE_ACCESS_KEY` is the single-owner boundary. It must contain 32–512 UTF-8 bytes without surrounding whitespace or control characters; generate a random value instead of reusing a human password.
- Login creates a signed 30-day HttpOnly `SameSite=Strict` cookie. HTTPS uses the host-only `__Host-dsh_edge_owner` name with `Secure`; local HTTP uses an unprefixed cookie.
- The cookie carries no user data, is never forwarded to the Durable Object, and becomes invalid when the access key rotates.
- Unauthenticated API and WebSocket requests return 401. Only an owner-authentication 401 carrying `WWW-Authenticate: DshEdgeOwner` makes the same-origin shell navigate to `/login`; provider/configuration 401 diagnostics remain visible.
- Authenticated browser API and WebSocket requests from another origin return 403 even with a same-site cookie.
- The asset policy prevents framing through `/`, `/index.html`, or an SPA fallback. `/` redirects to `/login`; `/api/health` and immutable assets remain public.

This deliberately is not an account system or multi-tenant boundary.

## Install on Cloudflare

| Target | Cloudflare requirement | Command boundary | Health identifier |
| --- | --- | --- | --- |
| Direct (default top level) | Workers Free; no Loader binding | Hardened just-bash in the agent/VFS Durable Object, with explicit timeouts, bounded output/environment, and no network command | `just-bash-direct` |
| `env.isolated` | Workers Paid with `LOADER` | Computer Worker Shell in a separate Dynamic Worker | `just-bash-isolated` |

Direct mode is lighter isolation than a separate Worker; do not expose the single-owner deployment to untrusted users. Workers Paid is a Workers subscription starting at $5 per month, not the Cloudflare Pro website plan. Worker names have independent Durable Object storage and secrets, so use different names when both modes should remain live.

`wrangler.jsonc` remains the canonical source for both modes:

- Release packaging builds one tested, minified artifact per mode.
- Direct replaces only Computer's unreachable Dynamic Worker shell-core module; its Workspace adapter and command exports remain upstream.
- Isolated preserves that shell core and replaces the unreachable Direct backend with a fail-closed module. Each artifact therefore carries only its selected command runtime.
- The installer generates a private mode-specific config, points it at the selected artifact, and uploads with `no_bundle`. The user's machine does not rebuild dsh-edge or resolve Harness packages into a new Worker.
- CI starts the Direct artifact from an installed tarball and rejects gzip output above 900 KiB, preserving headroom below the 1 MiB anonymous temporary-account limit.

### Install and upgrade

Run the stable installer without cloning this repository:

```sh
npx dsh-edge install
```

This resolves through npm's `latest` channel. Use `npx dsh-edge@next install` only to opt into a newer prerelease when one is available.

Upgrade an existing named Worker with the same runtime choice. The deployment keeps its Durable Object data; because Cloudflare secrets are write-only, the upgrade asks for the owner access key again. The DeepSeek API key prompt is optional — press Enter to skip it and configure the key later through Settings → Models:

For a stable deployment, run:

```sh
npx dsh-edge upgrade
```

If the installed version contains `-alpha` or `-rc`, promote it to the stable channel once with `npx dsh-edge@latest upgrade`. The Edge settings page derives its command from the installed version; without that explicit `@latest` command, an existing prerelease remains on `next`.

### Accounts and attachment storage

- The installer asks for the runtime before the account.
- Recommended `Free — Direct Shell` works on Workers Free with a detected account, a new sign-in/registration, or a temporary account without login.
- `Isolated — Dynamic Worker` requires Workers Paid and offers only a detected or newly authenticated account. Cloudflare authorizes the Loader upload; rejection becomes a choice between enabling Workers Paid and switching to Direct mode.
- New permanent installs create or reuse a private `<worker-name>-attachments` R2 bucket and place only its binding in the generated private Wrangler config. Deployment failure never deletes the bucket.
- R2 Standard has an included monthly free tier, but the account must enable its separate usage-based subscription. The installer checks R2 before collecting Worker secrets.
- Cloudflare error `10042` offers account-specific activation, retry, and cancellation. Only an unmarked pre-attachment Worker may safely switch to DO storage; a new or R2-pinned deployment cannot switch and strand references.
- Temporary accounts use the same image UI with a 64 MiB DO backend. Claiming preserves that backend and history; automatic R2 migration is not implemented.
- Every new deployment records its attachment-storage marker. Upgrades inspect every active version and preserve the marked or bound backend.
- A pre-image Worker has no marker, binding, or image references, so its first 0.3 upgrade asks once between 64 MiB DO storage and private R2, then pins the choice. Mixed active rollouts are refused rather than guessed.

### Credential handoff and activation

- The remaining prompts select a Worker name, generate or accept the owner access key, collect the DeepSeek key through hidden input, and show a final cost summary. Temporary installs also require explicit acceptance of Cloudflare's terms and privacy policy.
- Existing Workers are never overwritten without confirmation.
- Both credentials travel through a mode-`0600` temporary secrets file. Wrangler receives only an allowlisted runtime environment and the selected Cloudflare authentication; unrelated ambient secrets and Node injection options do not reach the child.
- The secret file is removed after the command. Wrangler's structured output supplies the deployed URL. Add `--verbose` to inspect full deployment diagnostics.
- After upload, the installer observes public `/api/health` for up to 45 seconds without credentials or redirects. Only the exact package version and selected runtime produce a ready card; propagation, challenge, placeholder, transport, and older-release responses remain pending.
- Observation expiry exits successfully and asks the owner to refresh shortly. It never calls DeepSeek or touches Durable Object state.
- The final card prints the URL, active owner key, and next steps. Temporary accounts also receive a bearer claim URL that must be claimed within 60 minutes.
- A rejected upload is reported as not installed. If Wrangler created a temporary account, its claim URL is still shown without presenting the unused owner key as active.
- If upload succeeds but handoff fails, a recovery card prints the active owner key and all known URLs before the command exits unsuccessfully.
- Installation uploads directly through Wrangler; it does not create or bind a GitHub repository, Cloudflare Builds project, or source-build pipeline.

Contributors working from a checkout can reproduce the two release artifacts locally with `pnpm --filter dsh-edge bundle:direct` and `pnpm --filter dsh-edge bundle:isolated`. The first command also enforces the compressed-size budget.

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
- Health does not call the provider, Durable Object, R2, VFS, or shell. The authenticated agent-preset projection reports the pinned backend, temporary cap, deployment-default model, and runtime-derived upstream catalog with session selection scope.

### Diagnostic REST routes

- `PUT /api/workspace/file?path=/workspace/...` writes a UTF-8 file.
- `GET /api/workspace/file?path=/workspace/...` reads a UTF-8 file.
- `DELETE /api/workspace/file?path=/workspace/...` removes a file.
- `POST /api/workspace/exec` accepts `{ "command": "...", "cwd": "/workspace/..." }`; `cwd` defaults to `/workspace`, every execution receives the deployment default timeout, `timedOut` reports whether that deadline elapsed, and `outputTruncated` reports whether the retention bound was crossed.
- `POST /api/sessions` creates a persistent session with a required `title`, recorded as a standard user-sourced `session/title` event before the API returns. If the session is durable but its Workspace attachment fails, the 500 response uses `workspace-attach-failed` and includes the complete created `session`, so callers can recover its id instead of creating a duplicate.
- `GET /api/sessions?after=...&limit=...` lists one bounded summary page; `GET /api/sessions/:sessionId` reads one. Session deletion is not exposed because the upstream persistence service does not define destructive deletion.
- `POST /api/sessions/:sessionId/turn` accepts `{ "message": "..." }` and streams persisted SSE events.
- `GET /api/sessions/:sessionId/events?after=...&limit=...` replays a bounded event page and returns continuation headers.
- `POST /api/sessions/:sessionId/cancel` aborts the active turn owned by the current Durable Object process.

### Session and Workspace behavior

- Session creation and fork return `workspace-attach-failed` with the published session and Workspace ids when publication succeeds but Workspace attachment fails. The diagnostic route returns the same code plus the complete created session.
- Prompt and queue-edit text share a 64 KiB semantic limit. Their 10 MiB RPC carrier leaves room for a 7 MiB raw-image batch after base64 and envelope overhead.
- Because Edge has no directory-flow provider, the upstream browser hides Delete on its sole Workspace and exposes it again whenever restoration remains possible.

### Limits and request admission

| Surface | Limit |
| --- | --- |
| UTF-8 text file | 1 MiB |
| Shell command | 16 KiB |
| User message or queue-edit text | 64 KiB |
| Retained shell stdout + stderr | 64 KiB |
| Session-create JSON body | 8 KiB |
| Workspace-exec JSON body | 128 KiB |
| Message-bearing turn or queue-update RPC | 10 MiB |
| Images | PNG/JPEG; 4 per message; 3.5 MiB each; 7 MiB total; 40 million pixels; 2,000 px per side |

- Request bodies are consumed incrementally. Once a route limit is crossed, later chunks are drained without being retained and the route returns 413. File uploads also reject malformed UTF-8.
- File reads check VFS metadata, then collect the opened byte stream through the same 1 MiB cap. This closes the growth race between `stat()` and `readFile()` without retaining an unbounded value.
- Image admission fully decodes the declared raster format before writing.
- When combined shell output crosses its retention bound, the runtime requests interruption and stops accumulating later output. `cancelled` reflects an adapter-requested interruption; `timedOut` independently records deadline expiry.

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
