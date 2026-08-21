# dsh-edge

English | [中文](README.zh.md)

`dsh-edge` is the Cloudflare runtime for DeepSeek Harness. One deployment maps its authenticated owner to one Durable Object whose SQLite-backed virtual filesystem survives requests. By default, an in-process just-bash backend runs commands against that same filesystem without a Linux container or Dynamic Worker.

`dsh-edge` is an independent community project. It is not affiliated with or endorsed by DeepSeek; DeepSeek Harness remains an upstream dependency under its own license.

The checked-in Wrangler configuration exposes two deployment targets from the same application graph. The default target is direct mode for Workers Free and has no Worker Loader binding. The named `isolated` target adds the `LOADER` binding and requires Workers Paid, but does not fork the DSH protocol, storage, UI, or tool implementation.

The runtime runs persistent conversations through the upstream Cordis-composed `ReactLoopAgent`, `AgentRegistry`, `LlmRuntime`, `ToolRuntime`, `SystemPrompt`, `SessionStore`, and `SessionPersistence`. Edge code only binds a request-scoped DeepSeek adapter and maps one native DSH `bash` tool definition onto Cloudflare Computer. Durable Object SQLite implements the upstream persistence backend contract; `PersistenceCoordinator` still owns write-behind, revisions, resume preparation, and crash recovery. Model history is projected from canonical events rather than persisted separately.

The browser is the upstream Web shell and upstream client-plugin bundles. A build-time assembler derives the browser roster from the upstream base and Web bundle configs, injects the standard `window.__DSH_BOOT__` graph, and publishes the result as Cloudflare static assets. The Durable Object implements the supported upstream `ApiProxy` methods through the standard HTTP carrier and supplies the two upstream downlinks as hibernatable WebSockets. The upstream image composer, gallery, lightbox, attachment wire contract, and DeepSeek serializer are reused unchanged; the storage seam selects private R2 for new permanent deployments and bounded Durable Object storage for temporary deployments. Edge excludes client plugins whose host domains are absent instead of forking their UI code; this includes session-log export until its server endpoint exists. A small Edge-owned login shell protects the upstream UI and protocol without changing either one. Optional local-host plugins remain unavailable.

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
DEEPSEEK_MAX_OUTPUT_TOKENS=8192
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_REASONING_EFFORT=off
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

The session turn sends upstream `SessionEvent` values directly as SSE data, including `agent/inbox/spliced`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, and turn/step boundaries. The live stream queues at most 1 MiB for its client; a slower reader is disconnected without cancelling the turn or its persistence. `GET /api/sessions/SESSION_ID` returns bounded session metadata only; clients obtain history from `GET /api/sessions/SESSION_ID/events?after=SEQ&limit=COUNT`, which replays a bounded page by upstream `seq`. Replay defaults to 128 events, accepts at most 256, preflights stored payload bytes before loading rows, and retains at most 1 MiB of encoded SSE; `x-dsh-edge-has-more` and `x-dsh-edge-next-after` drive the next request.

Session listing is also bounded: `GET /api/sessions?after=SESSION_ID&limit=COUNT` defaults to 50 summaries, accepts at most 100, and returns `hasMore` plus `nextAfter` in the JSON body. The Durable Object derives titles and latest timestamps from canonical rows without loading each session log. The upstream Web session list additionally includes retained blank headers that have no canonical event yet.

The upstream `session.history` browser RPC uses one Edge admission budget before live and cold paths diverge: every request is capped at the browser's 50-message page size. Cold logs apply that boundary in Durable Object SQL before decoding payloads and validate the selected contiguous window under 8,192-event and 8 MiB stored-payload ceilings. Live logs locate the same boundary without first copying the complete in-memory window, then enforce the same event ceiling and an 8 MiB encoded-response ceiling. An over-budget window is refused instead of truncated. Model-directory, model-selection, and turn-admission existence checks use header point reads; only a turn that must resume the agent decodes canonical history.

The upstream sidebar's `session.search` RPC scans canonical current user and assistant messages without a second Edge index or wire format. One request examines at most the 32 sessions with the most recent human activity and searches only complete logs of at most 512 events; a cold log must also fit within 256 KiB of stored payload. It returns the upstream maximum of 20 bounded snippets; `hasMore` is true when a result or work bound prevents an exhaustive answer.

Every authenticated request uses the deployment's fixed `owner` Durable Object. The legacy `x-dsh-edge-instance` header and `instance` query parameter are rejected rather than treated as identities. `/api/sessions/SESSION_ID/turn` continues the stored canonical history.

## Cloudflare compatibility matrix

This reference separates code that runs natively in Workers, code adapted at an existing DSH capability, and code that still assumes the local Node.js host. “Current” describes `apps/dsh-edge`; it is not a claim about all future Cloudflare work.

| Capability | Upstream implementation | Current edge status | Edge decision |
| --- | --- | --- | --- |
| DeepSeek transport | Fetch, SSE parsing, wire translation, retry metadata | Reused | Construct the upstream `DeepSeekAdapter` per request. `nodejs_compat` supplies its compatible Node APIs. |
| Provider attribution | Package version loaded with Node `createRequire` | Reused after portability fix | Import package metadata statically so bundlers preserve the same version source without requiring `import.meta.url` at runtime. |
| LLM protocol | DSH messages, content blocks, stream chunks, tool calls, usage, and finish reasons | Reused | Let upstream `LlmRuntime` and `ReactLoopAgent` assemble, stream, and log the model exchange. |
| Agent loop | Cordis-composed `ReactLoopAgent` with hooks, guards, sessions, and tools | Reused | Create and cold-resume agents through `AgentRegistry`; keep optional Node-oriented plugins such as local compaction outside the edge composition until adapted. |
| Bash tool | Node subprocess, sandbox, terminal, and job services | Adapted at the native tool seam | Register an upstream `ToolDefinition`, but execute its body through the configured Computer workspace backend and just-bash. The default direct backend runs inside the owner Durable Object with hardened interpreter limits and no network command; adding a `LOADER` binding selects Computer's isolated Worker Shell backend. Native tool cancellation sends `SIGINT` through the Computer execution handle. Deployment configuration supplies an explicit default timeout and caller-selectable ceiling, while `timedOut` reports the deadline independently from exit and cancellation status. Native binaries, background processes, PTYs, and arbitrary Linux behavior are unavailable. |
| Workspace filesystem | Local filesystem services and host paths | Adapted | Store `/workspace` in the owner's SQLite-backed Durable Object VFS. |
| Session persistence | `SessionPersistence` service, `PersistenceCoordinator`, and local JSONL/SQLite backends | Native backend adaptation | Reuse the upstream service and coordinator ownership. Implement storage primitives over Durable Object SQL with the upstream header/event mapping. One Edge-only table retains empty session headers across transparent hibernation and is removed when canonical rows materialize; no Edge turn or message schema exists. Internal coordinator helpers validate the bounded replay loader and abandon a failed unmaterialized creation before disposal. |
| Settings and credentials | File-backed settings, launch environment, and credential services | Read-only edge projection | Resolve the Worker secret per operation; never persist or return the literal key. Blank secrets are unconfigured, while surrounding whitespace is removed before use. `credentials.describe` reports only whether `DEEPSEEK_API_KEY` is configured and that its read-only source is `worker-secret`. The built-in `dsh-edge` preset projects its effective release, shell/VFS, model, limits, credential state, prompt, and tools through the upstream read-only composition viewer. Writable settings and authenticated per-user secret storage remain open. |
| Host boot and plugins | Node command line, Cordis profile loading, package resolution, and HMR | Explicit Edge composition | Keep the local boot profile out of Workerd. Build immutable client bundles ahead of deployment; exclude HMR and host domains that the Edge `ApiProxy` does not expose. |
| DSH transport | Typed HTTP RPC plus mux and host WebSocket downlinks | Reused with an Edge server implementation | Use the upstream fetch carrier for unary methods and preserve its envelopes, schemas, projections, lazy blank-session behavior, bounded content search, prompt and queue mutations, workspace mutations, queue snapshots, and event frames. Durable Object WebSocket hibernation owns both downlinks; mux reconnects replay pending live inbox state, while REST/SSE routes remain a diagnostic compatibility path. |
| Workspace registry | Storage-domain global state plus `WorkspaceRecord` rows | Native backend adaptation | Keep the upstream global and record value shapes, including manual session order and archive membership, but map their physical keys and atomic writes to Durable Object storage. Edge constrains the registry to the one native `/workspace` VFS; rename, delete, recreation, and session reordering retain the upstream RPC and Host-frame semantics. |
| Existing Web UI | Runtime-loaded shell and `dsh.client` plugin graph | Reused with generic composition fallbacks | Assemble the upstream shell and supported upstream client bundles as Worker assets. Shared slot-occupancy rules hide actions whose provider is absent; Cloudflare serves ordinary assets directly, while `/`, `/login`, and `/api/*` enter the Worker for owner access control. The assembled asset policy prevents every direct or SPA-fallback shell alias from being framed. |
| Other tools | Web Search, filesystem editor tools, MCP, skills, workflows, jobs, and subagents | Search ported; others not ported | Reuse upstream DeepSeek Web Search with its 30-second tool-call timeout. Add the remaining tools individually against Worker-compatible capabilities; do not advertise unavailable host behavior. |
| Attachments | Local attachment storage, upstream image references, composer, gallery, lightbox, and provider conversion | Adapted at the native storage seam | Reuse upstream `AttachmentStore`, admission, protocol, authorization, UI, and DeepSeek conversion unchanged. Store immutable PNG/JPEG bytes under their SHA-256 identities in private R2 for new permanent deployments or in a 64 MiB, 512 KiB-chunked DO fallback for temporary deployments; session events retain only upstream refs. The first backend is pinned per owner instance so claiming or upgrading cannot strand existing references. |
| Authentication and tenancy | Local trusted-user boundary | Single-owner adaptation | Require one high-entropy Worker secret, exchange it for a signed 30-day HttpOnly `SameSite=Strict` cookie, and route every accepted request to one fixed owner object. This intentionally provides no registration, user database, roles, or multi-tenant routing. |

The browser request path is:

```text
Cloudflare static assets -> upstream Web shell + client plugin graph
  -> POST /api/session.create through the upstream HTTP carrier
  -> host/workspace-changed + session/subscribed over Durable Object WebSockets
  -> POST /api/session.prompt with the client rpcId
  -> upstream image admission validates and stores immutable bytes in private R2
  -> canonical session events retain upstream sha256 attachment refs only
  -> AgentRegistry live lookup or resume
  -> sessionPersistence.prepare through PersistenceCoordinator on cold resume
  -> ReactLoopAgent.followup(queue) or ReactLoopAgent.steer(steer)
  -> pre-step admission gate waits for the sessions.flush durability barrier
  -> session/queue snapshots publish live and replay on mux reconnect
  -> turn-scoped DeepSeekAdapter configuration selected by sessionId
  -> upstream attachment resolver reads and verifies authorized backend bytes
  -> upstream LlmRuntime + ReactLoopAgent stream/event pipeline
  -> upstream ToolRuntime native bash or web_search call
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

The local integration check uses an SSE stand-in and the real Wrangler, Durable Object SQLite, local R2, the default direct Computer workspace backend, static asset service, HTTP carrier, and WebSockets. Direct mode exercises the temporary DO attachment backend while Isolated mode exercises private R2. It verifies owner login, API and WebSocket cookie enforcement, rejection of legacy instance selectors, disabled direct-shell networking, the upstream session create/list/history/search/prompt/rename/fork flow; an image prompt through the upstream composer/protocol/provider path; authorized attachment reads, cross-session rejection, fork reuse, and attachment persistence after restart; queue edit, removal, and promotion to steering; workspace create/list/rename/delete/session reorder/archive; the corresponding live and reconnect baselines and Host frames; real browser boot and UI-issued workspace rename, image turn, content search, branch, and archive actions; automatic return to login when the browser session expires; conversation continuity, event replay, two-step bash and Web Search tool exchanges, and restoration after a Wrangler restart. A focused failure test proves that a post-enqueue durability failure blocks model use without reporting the already-woken prompt as rejected. Committed model-visible and ARIA goldens pin the tool transcripts and the assembled upstream Web client through the Edge HTTP/WebSocket protocol. A live DeepSeek call requires the developer's own key and is intentionally not part of the repository test suite.

## API-key boundary

`DEEPSEEK_API_KEY` from `.dev.vars` is the local credential source. A read-only Edge provider exposes that Worker secret through the upstream `ctx.credentials` service for each chat or search operation without writing it to Durable Object storage, the VFS, session events, or responses. It removes surrounding whitespace and treats a blank value as unconfigured. `DEEPSEEK_BASE_URL` controls chat and must be an HTTP(S) URL without URL userinfo; its read-only browser projection omits query and fragment components that may carry gateway credentials. `DEEPSEEK_SEARCH_BASE_URL` independently controls the Anthropic-compatible Messages endpoint used by DeepSeek native search, defaults to `https://api.deepseek.com/anthropic/v1`, and must be an HTTP(S) URL without userinfo, query, or fragment. Edge mounts the upstream `web_search` tool, its 30-second tool-call timeout policy, and structured Web result presentation; `web_fetch` remains disabled because the runtime has no arbitrary-URL network policy. Search requests do not follow redirects. `DEEPSEEK_MODEL` selects a validated chat model id and defaults to `deepseek-v4-flash`. `DEEPSEEK_REASONING_EFFORT` accepts `off`, `low`, `high`, or `max` and defaults to `off`. `DEEPSEEK_MAX_OUTPUT_TOKENS` optionally overrides the 8,192-token chat default and must be a positive safe integer. `DEEPSEEK_STREAM_IDLE_TIMEOUT_MS` optionally overrides the 120,000 ms chat default and must be a positive integer no greater than 2,147,483,647. Invalid deployment configuration fails before session lookup or the SSE response opens.

`DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS` applies to every Computer command that omits a caller timeout, and `DSH_EDGE_MAX_COMMAND_TIMEOUT_MS` limits caller-selected values. Both default to 120,000 ms, must be positive integers no greater than 2,147,483,647, and the default cannot exceed the maximum.

`DSH_EDGE_ACCESS_KEY` is the deployment's single-owner boundary. It must contain 32–512 UTF-8 bytes without surrounding whitespace or control characters; generate a random value rather than reusing a human password. A successful form login creates a signed 30-day HttpOnly `SameSite=Strict` cookie. HTTPS deployments use the host-only `__Host-dsh_edge_owner` name and `Secure`; local HTTP development uses an unprefixed cookie because browsers reject `__Host-` cookies without HTTPS. The cookie carries no user data, is not forwarded to the Durable Object, and becomes invalid when the access key rotates. Unauthenticated API and WebSocket requests return 401. Owner-authentication API failures also carry `WWW-Authenticate: DshEdgeOwner`; only that exact same-origin 401 makes the Edge-assembled shell navigate to `/login`, so provider or configuration 401 diagnostics remain visible while an expired browser session still escapes the upstream reconnect loop. Authenticated browser API and WebSocket requests from a different origin return 403 even when they carry a same-site cookie. The Cloudflare asset policy prevents the shell from being embedded in a frame whether it is reached through `/`, `/index.html`, or an SPA fallback alias. `/` redirects to `/login`; `/api/health` and immutable asset files remain public. This deliberately is not an account system or a multi-tenant boundary.

## Install on Cloudflare

The top level of the committed `wrangler.jsonc` is the default direct target and does not require a Worker Loader. Direct shell code executes in the same Durable Object isolate as the agent and VFS, so just-bash's hardened execution limits, explicit command timeout, bounded output, explicit environment, and disabled network command are the primary command boundary. This is a lighter isolation model than a separate Worker; do not expose the single-owner deployment to untrusted users.

The same file also defines `env.isolated`, a complete Workers Paid target with the `LOADER` binding. The application code sees `LOADER` and chooses Computer's Worker Shell backend, so `/api/health` reports `just-bash-isolated` instead of `just-bash-direct`. Workers Paid is a Workers subscription starting at $5 per month, not the Cloudflare Pro website plan. Each Worker name has independent Durable Object storage and secrets, so install both modes under different names when both should remain live.

`wrangler.jsonc` remains the single canonical configuration for both modes. Release packaging builds one tested, minified Worker artifact per mode from the workspace sources. Direct mode replaces only Computer's unreachable Dynamic Worker shell-core module at build time; the Computer workspace adapter and command exports remain the upstream implementations. Isolated mode preserves that shell core but replaces the unreachable Direct backend with a fail-closed module, so each artifact carries only its selected command runtime. The published installer generates a private mode-specific configuration that points at the selected artifact and asks Wrangler to upload it with `no_bundle`; the user's machine does not rebuild dsh-edge or resolve the upstream Harness packages into a new Worker. CI starts the Direct artifact from an installed tarball and rejects it above a 900 KiB compressed budget, leaving headroom below the 1 MiB limit enforced by Cloudflare's anonymous temporary-account upload path.

Run the stable installer without cloning this repository:

```sh
npx dsh-edge install
```

This resolves through npm's `latest` channel. Use `npx dsh-edge@next install` only when intentionally testing a future prerelease.

Upgrade an existing named Worker with the same runtime choice. The deployment keeps its Durable Object data; because Cloudflare secrets are write-only, the upgrade asks for the owner access key and DeepSeek API key again and replaces their active values:

For a stable deployment, run:

```sh
npx dsh-edge upgrade
```

If the installed version is a 0.2 alpha, promote it to the stable channel once with `npx dsh-edge@latest upgrade`; prerelease deployments otherwise remain on `next`. The Edge settings page derives the channel from the installed version and copies the matching command.

The installer asks for the runtime before the account. The recommended `Free — Direct Shell` mode works on Workers Free and can use a detected Cloudflare account, open Cloudflare sign-in or registration, or create a temporary account without login. `Isolated — Dynamic Worker` requires Workers Paid and therefore offers only a detected or newly authenticated account. Cloudflare does not expose a reliable local entitlement check for Worker Loader, so an isolated install lets Cloudflare authorize the upload and turns a rejection into a choice between enabling Workers Paid and using direct mode. For a new permanent account installation, the installer creates or reuses a private `<worker-name>-attachments` R2 bucket and writes only its binding to the generated private Wrangler config. It never deletes the bucket on deployment failure. R2 must be enabled for the selected account; otherwise the installer provides the activation/retry path. Temporary accounts use a 64 MiB Durable Object attachment backend and support the same upstream image UI. Claiming preserves that backend and its existing image history; automatic migration to R2 is not implemented. Before updating an existing Worker, the installer inspects every active version and preserves its current R2-or-DO binding; it refuses a mixed rollout rather than guessing.

The remaining prompts select a Worker name, generate or accept the owner access key, collect the DeepSeek API key through hidden input, and show a final cost summary. A temporary-account install also asks the user to accept Cloudflare's Terms of Service and Privacy Policy explicitly. An existing Worker is never overwritten without confirmation. The installer passes both credentials through a mode-`0600` temporary secrets file and gives Wrangler only an allowlisted runtime environment plus the Cloudflare authentication selected for that command; unrelated ambient keys, tokens, passwords, secrets, and Node injection options do not reach the child. It removes the secret file after the command and discovers the resulting URL from Wrangler's structured output. Deployment output is hidden behind one progress indicator by default; add `--verbose` to either command to inspect Wrangler diagnostics.

After an accepted upload, a second progress indicator observes the public `/api/health` route for at most 45 seconds without sending either credential or following redirects. It accepts only the exact packaged version and selected runtime. A matching response produces a ready card. Cloudflare propagation, challenge, placeholder, transport, and older-release responses remain pending; expiry still exits successfully and tells the owner to wait briefly and refresh. This observation does not call DeepSeek or touch Durable Object state. The final card prints the URL, owner access key, and concrete next steps; a temporary account also receives a bearer claim URL that must be claimed within 60 minutes to retain the Worker and its data. A rejected upload is reported as not installed and, when Wrangler created a temporary account first, still prints its claim URL without presenting the unused owner key as active. If upload succeeds but output parsing, claim-URL extraction, interruption handling, activation interruption, or local cleanup prevents a normal handoff, a recovery card still prints the active owner key and any known URLs before the command exits unsuccessfully. The installation uploads directly through Wrangler and does not create or bind a GitHub repository, Cloudflare Builds project, or source-build pipeline.

Contributors working from a checkout can reproduce the two release artifacts locally with `pnpm --filter dsh-edge bundle:direct` and `pnpm --filter dsh-edge bundle:isolated`. The first command also enforces the compressed-size budget.

Contributors can replay the complete Free temporary-account journey without a key or network call. This example runs the shipped bin, real prompts, Wrangler subprocess, structured deployment-output parsing, public-activation observation, and final handoff while replacing the external Cloudflare boundaries:

```sh
pnpm --filter dsh-edge example:install
```

## Edge API

- `POST /api/<upstream-method>` accepts the upstream `ClientRequest` envelope for the supported `ApiProxy` methods. The Web client currently uses session list/search/create/history/models/select/prompt/updateQueue/rename/fork/cancel, host description, workspace list/create/rename/delete/reorder/archive, skills, agent presets, settings and credential descriptions, and LLM catalogs. `agentPreset.read` renders the programmatic Edge composition through the upstream read-only viewer, and `credentials.describe` returns credential state without a value. Search projects canonical current-message surfaces and returns only bounded upstream result values. Fork copies a completed-turn prefix through the canonical session seed format and retains parent lineage; Edge refuses a seed above 8,192 events or 8 MiB rather than materializing an unbounded Durable Object history. Queue mutations edit, remove, or promote an item through the live upstream Agent inbox; the synchronous inbox mutation is the upstream acceptance point, while the persistence coordinator owns later write-behind and retirement retry. Workspace mutations persist the upstream workspace-domain global and record shapes through the Durable Object backend. Archive preserves the session log and workspace slot; unary responses and Host frames carry the same full snapshots as upstream.
- `GET /login` renders the Edge-owned owner form; `POST /api/auth/login` exchanges the configured access key for a signed cookie, `GET /api/auth/session` reports cookie validity, and `POST /api/auth/logout` clears it.
- `GET /api/events.mux` and `GET /api/events.host` upgrade to the upstream downlink WebSockets. The Durable Object serializes each socket's channel and verified owner-session expiry as its hibernation attachment, closes it at that expiry through an alarm, and reconstructs canonical sessions plus retained blank headers from Durable Object SQL. The mux stream publishes a complete `session/queue` snapshot after each committed inbox splice and sends pending live inbox baselines when a client reconnects.
- `POST /api/commands/list` implements the upstream generated-Remote envelope with an empty catalog because the Edge preset registers no human commands.
- `GET /api/health` returns the public package-and-mode release identifier and configured attachment default (`private-r2` or `temporary-do`), and validates owner authentication, the deployment-scoped DeepSeek credential, model and transport choices, and the command-timeout policy before reporting the runtime components as ready. It does not call the provider, Durable Object, R2, VFS, or shell. The authenticated agent-preset projection reports the actual backend pinned by the owner Durable Object and the temporary storage cap.
- `PUT /api/workspace/file?path=/workspace/...` writes a UTF-8 file.
- `GET /api/workspace/file?path=/workspace/...` reads a UTF-8 file.
- `DELETE /api/workspace/file?path=/workspace/...` removes a file.
- `POST /api/workspace/exec` accepts `{ "command": "...", "cwd": "/workspace/..." }`; `cwd` defaults to `/workspace`, every execution receives the deployment default timeout, `timedOut` reports whether that deadline elapsed, and `outputTruncated` reports whether the retention bound was crossed.
- `POST /api/sessions` creates a persistent session with a required `title`, recorded as a standard user-sourced `session/title` event before the API returns. If the session is durable but its Workspace attachment fails, the 500 response uses `workspace-attach-failed` and includes the complete created `session`, so callers can recover its id instead of creating a duplicate.
- `GET /api/sessions?after=...&limit=...` lists one bounded summary page; `GET /api/sessions/:sessionId` reads one. Session deletion is not exposed because the upstream persistence service does not define destructive deletion.
- `POST /api/sessions/:sessionId/turn` accepts `{ "message": "..." }` and streams persisted SSE events.
- `GET /api/sessions/:sessionId/events?after=...&limit=...` replays a bounded event page and returns continuation headers.
- `POST /api/sessions/:sessionId/cancel` aborts the active turn owned by the current Durable Object process.

Upstream session creation and fork return `workspace-attach-failed` with the published session and Workspace ids when publication succeeds but Workspace attachment fails; the diagnostic creation route returns the same code plus its complete created session. Prompt and queue-edit text share the same 64 KiB semantic limit. Their RPC carrier accepts up to 10 MiB so a projected 7 MiB raw-image batch still fits after base64 and envelope overhead. Because the Edge composition has no directory-flow provider, the upstream browser hides Delete on its sole Workspace and exposes it again whenever restoration remains possible.

The API limits text files to 1 MiB, commands to 16 KiB, user messages to 64 KiB, and retained shell stdout plus stderr to 64 KiB; these are UTF-8 byte limits. Permanent R2 deployments accept PNG and JPEG only, at most 4 images per message, 3.5 MiB per image, 7 MiB total, 40 million pixels, and 2,000 pixels per side; admission fully decodes the declared raster format before writing. Request bodies are consumed incrementally before parsing or forwarding: session creation accepts at most 8 KiB of JSON, workspace execution 128 KiB, and message-bearing turn or queue-update RPCs 10 MiB, while file uploads enforce their 1 MiB bound during consumption and reject malformed UTF-8. Once a body exceeds its route limit, later chunks are drained without being retained and the route returns 413. File reads first check VFS metadata, then collect the opened raw byte stream through the same 1 MiB cap, closing the growth race between `stat()` and `readFile()` without retaining an unbounded value. The runtime requests interruption when combined shell output crosses the retention bound and does not accumulate later output. Command status reports cancellation only when the adapter requested interruption, independently of the shell exit code; `timedOut` separately records deadline expiry. Failed initial session persistence discards the retained unmaterialized batch before disposing the newly published upstream agent handle, so teardown cannot later commit a session whose create request returned an error. A lazy blank session retains only its upstream header until the first canonical event; that materialization removes the retained header in the same SQL transaction. Each turn owns one upstream handle and disposes it after the stream completes, so previously accessed conversations do not remain resident for the Durable Object lifetime. Deployment settings resolve before the process-local owner claim. An upstream protocol prompt returns accepted and publishes running state only after its inbox event crosses `SessionStore.flush()`; later streamed events cross the same barrier before WebSocket or SSE delivery. Queue edits, removals, and steering promotion use the synchronous live-inbox mutation as their acceptance point; `PersistenceCoordinator` owns subsequent write-behind or retirement retry, so a later storage attempt cannot turn an accepted mutation into a rejected response. Session rename follows the same upstream metadata contract: the synchronous title append is its acceptance point for both active and cold sessions. Workspace global state and records use the upstream logical schemas under Edge-specific physical keys; DO transactions atomically pair record and registry-order changes, while a process-local chain serializes workspace mutations. Committed rename, delete, recreation, session reorder, attachment, and archive changes publish the matching upstream Host frames, and `workspace.list` restores their complete baseline after restart. A process-local owner rejects a concurrent turn, and cancel calls the native agent cancellation path. On the next cold resume, upstream interrupted-turn repair closes an open persisted tail and canonical `session/end-seed` markers preserve lifecycle boundaries. Replay checks session absence separately so persistence corruption or SQL failures are not collapsed into 404, reads only one bounded SQL page rather than the full suffix, and caps the encoded response. `PersistenceCoordinator.readValidatedPage()` performs identity, format, legacy-shape, and event-vocabulary validation on every page without adding Edge pagination to the public persistence service. If legacy normalization needs earlier messages, it rereads only one prefix through the same byte-bounded loader and refuses the page when that required prefix does not fit. Cold browser history selects its message boundary in SQL and loads only the resulting contiguous range under fixed event and stored-byte ceilings. Session listing queries one bounded canonical header/title summary page; detail reads its durable canonical point summary or retained blank header, while turn existence checks use point queries instead of listing headers or projecting a complete log. Effective model, system prompt, adapter defaults, and tools are recorded in standard `request/header` events. The request-scoped adapter uses the validated deployment reasoning and output policies. Workspace paths must stay below `/workspace/`.
