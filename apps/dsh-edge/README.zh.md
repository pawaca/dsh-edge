# dsh-edge

[English](README.md) | 中文

`dsh-edge` 用一条命令把你自己的持久 DeepSeek Harness 部署到 Cloudflare Workers，之后便能从任意浏览器使用。公共 CLI 无需 checkout 源码、绑定仓库或配置构建流水线，即可完成安装与升级。

在底层，每次部署把通过认证的 owner 固定映射到一个 Durable Object，其基于 SQLite 的虚拟文件系统可跨请求持久保存。默认情况下，进程内 just-bash 后端直接在同一文件系统上执行命令，不依赖 Linux 容器或 Dynamic Worker。

`dsh-edge` 是独立的社区项目，与 DeepSeek 没有隶属关系，也未获得 DeepSeek 官方背书；DeepSeek Harness 仍是按其自身许可证使用的上游依赖。

仓库提交的 Wrangler 配置从同一套应用 graph 暴露两个部署目标。默认目标是面向 Workers Free 的 direct 模式，不包含 Worker Loader binding。命名的 `isolated` 目标会添加 `LOADER` binding，并且需要 Workers Paid，但不会 fork DSH protocol、storage、UI 或 tool implementation。

运行时保持清晰的上游责任边界：

- `ReactLoopAgent`、`AgentRegistry`、`LlmRuntime`、`ToolRuntime`、`SystemPrompt`、`SessionStore` 和 `SessionPersistence` 通过上游 Cordis 组合运行。
- 上游 `dsh-llm-deepseek` cordis 插件直接安装，自动注册 Settings 命名空间和可配置 Provider 条目。Edge 把原生 DSH `bash` 工具映射到 Cloudflare Computer。
- Durable Object SQLite 实现上游持久化后端约定；write-behind、revision、恢复准备与崩溃恢复仍由 `PersistenceCoordinator` 负责。
- 模型历史从 canonical 事件投影，不在 Edge 中建立第二套 schema。

浏览器也保持上游所有权：

- 构建期 assembler 从上游配置推导 Web roster，注入标准 `window.__DSH_BOOT__` graph，并输出 Cloudflare 静态资源。
- Durable Object 通过标准 HTTP carrier 实现受支持的上游 `ApiProxy` 方法，并以支持休眠的 WebSocket 提供两条 downlink。
- Image composer、gallery、lightbox、attachment wire contract 与 DeepSeek serializer 全部原样复用。
- Storage seam 为新的永久部署选择私有 R2，为临时部署选择有界 Durable Object storage，并让 0.3 之前的 Worker 在首次升级时由 owner 做一次选择。
- 缺少对应 host domain 的客户端插件会被排除，而不会 fork UI 代码。Session log export 与可选的本地 host 插件目前仍不可用。
- 一个小型 Edge 登录外壳在不修改上游 UI 和协议的前提下保护它们。

## 快速导航

- [在 Cloudflare 上安装或升级](#安装到-cloudflare)
- [对比原生复用、已适配与未支持能力](#cloudflare-兼容矩阵)
- [配置 DeepSeek 凭据、模型、超时与 owner 认证](#api-key-边界)
- [在本地运行发布 runtime](#本地运行)
- [查阅路由、限制与持久化行为](#edge-api)

## 本地运行

使用 Node.js 22.19 或更高版本。在仓库根目录安装仓库依赖，以及使用独立 lock 的发布装配依赖：

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
```

调用 DeepSeek 前，创建一个不会提交到 Git 的 `apps/dsh-edge/.dev.vars` 文件：

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

然后启动 Worker：

```sh
pnpm --filter dsh-edge dev
```

该命令会把锁定版本的 Harness 发布包构建为与安装器交付内容相同的预构建 Web 与 Worker 产物，然后让 Wrangler 在不重新打包的情况下启动这些产物。打开输出的地址（通常为 `http://localhost:8787`），输入 owner access key，选择 **Workspace** 并发送消息。Web UI 会创建 lazy blank session，并通过已认证的 Durable Object WebSocket 流式接收该轮次。

诊断 API 使用相同的 owner cookie。先登录一次并把 cookie 写入临时 cookie jar，再验证持久文件系统和 shell：

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

如需持久对话，先创建 session，再把返回的 id 用于后续 turn：

```sh
curl -b /tmp/dsh-edge-cookie -X POST -H 'content-type: application/json' \
  --data '{"title":"Edge session"}' \
  http://localhost:8787/api/sessions

curl -b /tmp/dsh-edge-cookie -N -X POST -H 'content-type: application/json' \
  --data '{"message":"Read /workspace/hello.txt and remember the result."}' \
  http://localhost:8787/api/sessions/SESSION_ID/turn
```

诊断型 session API 保留上游 event，同时为每次读取设置边界：

- Turn 直接把上游 `SessionEvent` 作为 SSE 返回，包括 inbox splice、assistant chunk/message、tool call/result 及 turn/step 边界。
- Live stream 每个客户端最多排队 1 MiB。读取过慢的客户端会断线，但不会取消 turn 或持久化。
- Session detail 返回有界 metadata。Event replay 默认 128 条、最多 256 条，会预检持久字节，最多保留 1 MiB 编码后的 SSE，并返回 continuation header。
- Session listing 默认 50 条、最多 100 条。Durable Object 从 canonical row 推导标题与时间，不加载每个 log；上游 Web 还会收到 retained blank header。
- Browser history 最多 50 条消息，并拒绝而非截断超过 8,192 个 event 或 8 MiB 的 window。Cold 路径在 SQL 应用边界；live 路径不复制完整内存 log 就定位边界。
- 侧边栏搜索直接使用 canonical current user/assistant message，不引入第二套索引或 wire format。它最多检查 32 个最近 session，要求完整 log 不超过 512 个 event，cold 时不超过 256 KiB，并最多返回 20 个 snippet；达到边界时返回 `hasMore`。
- 模型查找与选择只做 header point read。只有恢复 agent 的 turn 才解码 canonical history。

每个已认证请求都使用该部署固定的 `owner` Durable Object。旧 `x-dsh-edge-instance` 请求头与 `instance` 查询参数会被拒绝，不会被当作 identity。`/api/sessions/SESSION_ID/turn` 会延续已保存的 canonical history。

## Cloudflare 兼容矩阵

该参考区分三类代码：可在 Workers 原生运行、需要在现有 DSH capability 上适配， 以及仍然依赖本地 Node.js host。表中的“当前”专指 `apps/dsh-edge`，不代表未来所有 Cloudflare 工作的最终状态。

| 能力 | 上游实现 | 当前 edge 状态 | Edge 决策 |
| --- | --- | --- | --- |
| DeepSeek transport | Fetch、SSE 解析、wire translation 和 retry metadata | 复用 | 每个请求构造一个上游 `DeepSeekAdapter`；其兼容的 Node API 由 `nodejs_compat` 提供。 |
| Provider attribution | 用 Node `createRequire` 加载 package version | 完成可移植修复后复用 | 静态导入 package metadata，让 bundler 保留同一个版本来源，运行时不再依赖 `import.meta.url`。 |
| LLM protocol | DSH messages、content blocks、stream chunks、tool calls、usage 和 finish reasons | 复用 | 由上游 `LlmRuntime` 和 `ReactLoopAgent` 组装、流式处理并记录 model exchange。 |
| Agent loop | 由 Cordis 组合、带 hooks、guards、sessions 和 tools 的 `ReactLoopAgent` | 复用 | 通过 `AgentRegistry` 创建和冷恢复 agent；local compaction 等可选 Node-oriented plugins 在完成适配前不加入 edge composition。 |
| Bash tool | Node subprocess、sandbox、terminal 和 job services | 在原生 tool seam 上适配 | 注册上游 `ToolDefinition`，但通过配置的 Computer workspace backend 和 just-bash 执行其 body。默认 direct backend 在 owner Durable Object 内运行，启用 hardened interpreter limits 且不提供网络命令；添加 `LOADER` binding 后会选择 Computer 的 isolated Worker Shell backend。原生 tool cancellation 会通过 Computer execution handle 发送 `SIGINT`。部署配置提供明确的默认 timeout 与调用方可选值上限，`timedOut` 则独立于 exit 与 cancellation status 报告 deadline。不支持原生二进制、后台进程、PTY 和任意 Linux 行为。 |
| Workspace filesystem | 本地 filesystem services 和 host paths | 适配 | 在 owner 基于 SQLite 的 Durable Object VFS 中保存 `/workspace`。 |
| Session persistence | `SessionPersistence` service、`PersistenceCoordinator` 及本地 JSONL/SQLite backends | 原生 backend 适配 | 复用上游 service 及 coordinator 的职责划分，在 Durable Object SQL 上实现存储原语，并使用上游 header/event 映射。一个 Edge 独有表会在透明休眠期间保留 empty session header，并在 canonical rows 物化时删除；Edge 不定义 turn 或 message schema。内部 coordinator helper 负责校验有界 replay loader，并在 disposal 前放弃失败且尚未物化的创建。 |
| Settings and credentials | 基于文件的 settings、launch environment 和 credential services | 可写，使用 DO 存储 | 上游 `dsh-settings` 插件通过 `DurableObjectSettingsProvider` 把 user section 持久化到 Durable Object KV。上游 `dsh-llm-deepseek` cordis 插件直接安装，自动注册 `llm-deepseek` Settings 命名空间和可配置 Provider 条目；Settings → Models 页面可在运行时读取和修改 Provider 配置（base URL、model catalog、API key reference、reasoning effort），无需重新部署。`EdgeCredentialProvider` 先从 DO KV 解析凭证，然后降级到 Worker 环境变量 secret；`set`/`unset` 通过上游接缝持久化。Edge 默认值（maxTokens 8,192，reasoningEffort off）显式传递，确保未设置部署变量时保持文档化行为。 |
| Host boot and plugins | Node 命令行、Cordis profile loading、package resolution 和 HMR | 显式 Edge composition | 不在 Workerd 中运行本地 boot profile。部署前构建 immutable 客户端包，并排除 HMR 及 Edge `ApiProxy` 未暴露的 host domain。 |
| DSH transport | Typed HTTP RPC 加 mux/host WebSocket downlink | 复用并提供 Edge 服务端实现 | 对 unary method 使用上游 fetch carrier，并保留其 envelope、schema、projection、lazy blank-session 行为、有界内容搜索、prompt 与 queue mutation、workspace mutation、queue snapshot 和 event frame。两条 downlink 都由 Durable Object WebSocket 休眠机制持有；mux 重连会重放 live inbox 的待处理状态，REST/SSE 路由则保留为诊断兼容路径。 |
| Workspace registry | Storage-domain global state 加 `WorkspaceRecord` rows | 原生 backend 适配 | 保持上游 global 和 record value shape，包括手动 session 顺序与 archive membership；仅把物理 key 和原子写入映射到 Durable Object storage。Edge 把 registry 限制为一个原生 `/workspace` VFS；rename、delete、recreate 与 session reorder 保持上游 RPC 和 Host-frame 语义。 |
| Existing Web UI | 运行时加载的 shell 和 `dsh.client` 插件 graph | 复用并采用通用 composition fallback | 把上游 shell 和受支持的上游客户端包组装成 Worker 静态资源；共享的 slot occupancy 规则会隐藏缺少 provider 的 action。Cloudflare 直接提供普通资源，`/`、`/login` 与 `/api/*` 则进入 Worker 执行 owner access control。组装后的 asset policy 会阻止所有直接或 SPA-fallback shell alias 被嵌入 frame。 |
| Other tools | Web Search、filesystem editor tools、MCP、skills、workflows、jobs 和 subagents | Search 已移植；其他未移植 | 复用上游 DeepSeek Web Search 及其 30 秒 tool-call timeout。逐个针对 Worker-compatible capabilities 增加其余工具，不宣称不可用的 host 行为。 |
| Attachments | 本地 attachment storage、上游 image reference、composer、gallery、lightbox 与 provider conversion | 在原生 storage seam 上适配 | 原样复用上游 `AttachmentStore`、admission、协议、授权、UI 与 DeepSeek conversion。PNG/JPEG 不可变字节按 SHA-256 identity 存入新永久部署的私有 R2，或存入临时部署以及升级旧版 Worker 时由 owner 选择的 64 MiB、按 512 KiB 分块的 DO backend；session event 只保留上游 ref。每个 owner instance 首次选择的 backend 会被固定，认领或升级不会让既有引用失联。 |
| Authentication and tenancy | 本地 trusted-user boundary | 单 owner 适配 | 要求一个高熵 Worker secret，把它交换为带签名、有效期 30 天的 HttpOnly `SameSite=Strict` cookie，并把所有已接纳请求路由到一个固定 owner object。这里刻意不提供注册、用户数据库、角色或多租户路由。 |

浏览器请求路径是：

```text
Cloudflare static assets -> upstream Web shell + client plugin graph
  -> POST /api/session.create through the upstream HTTP carrier
  -> host/workspace-changed + session/subscribed over Durable Object WebSockets
  -> POST /api/session.prompt with the client rpcId
  -> 上游图片 admission 校验图片，并把不可变字节存入所选 R2 或 DO backend
  -> canonical session event 只保留上游 sha256 attachment ref
  -> AgentRegistry live lookup or resume
  -> sessionPersistence.prepare through PersistenceCoordinator on cold resume
  -> ReactLoopAgent.followup(queue) or ReactLoopAgent.steer(steer)
  -> pre-step admission gate waits for the sessions.flush durability barrier
  -> session/queue snapshots publish live and replay on mux reconnect
  -> upstream dsh-llm-deepseek plugin resolves configuration from settings + launch environment
  -> 上游 attachment resolver 读取并校验已授权的 backend 字节
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

本地集成套件使用 SSE stand-in，并运行真实 Wrangler、Durable Object SQLite、本地 R2、Direct Computer workspace backend、静态资源、HTTP carrier 和 WebSocket。Direct 模式覆盖 DO attachment storage，Isolated 模式覆盖私有 R2。它们共同验证：

- owner 登录、API/WebSocket cookie enforcement、旧 selector 拒绝和 Direct shell 禁止联网；
- 上游 session create/list/history/search/prompt/rename/fork 以及 queue edit/remove/steering 流程；
- 图片经上游 composer、协议、provider 完成准入，以及授权、fork 复用与重启持久性；
- Workspace create/list/rename/delete/reorder/archive、实时/重连 baseline 和 Host frame；
- 真实浏览器启动、UI 发起的 Workspace rename、图片 turn、内容搜索、branch、archive 和 session 过期后的登录恢复；
- 对话连续性、event 重放、两步 bash 与 Web Search tool 交互，以及 Wrangler 重启后恢复。

一项聚焦故障测试证明，入队后的持久化失败会阻止模型调用，不会把已唤醒 Agent 的 prompt 报告为拒绝。仓库中的 model-visible 与 ARIA golden 会固定 tool transcript 和组装后的上游 Web client。真实 DeepSeek 调用需要开发者的 key，故不纳入仓库测试套件。

## API key 边界

`DEEPSEEK_API_KEY` 可以在部署时作为 Worker secret 设置，也可以之后通过 Settings → Models 页面输入。Edge credential provider 先查 Durable Object KV，再降级到 Worker 环境变量；解析值保持请求级作用域，绝不写入 session event 或 response。首尾空白会被移除；空白值视为未配置。

| 变量 | 用途与校验 |
| --- | --- |
| `DEEPSEEK_BASE_URL` | Chat endpoint。必须是不含 URL userinfo 的 HTTP(S) URL。Browser 投影会省略可能携带 gateway credential 的 query 与 fragment。 |
| `DEEPSEEK_SEARCH_BASE_URL` | Native Web Search 的 Anthropic-compatible Messages endpoint。默认为 `https://api.deepseek.com/anthropic/v1`；必须是不含 userinfo、query 与 fragment 的 HTTP(S) URL。Search 不跟随 redirect。 |
| `DEEPSEEK_MODEL` | 已校验的部署默认模型；默认 `deepseek-v4-flash`。每个 session 可选择其他上游 catalog 条目。 |
| `DEEPSEEK_REASONING_EFFORT` | `off`、`low`、`high` 或 `max`；默认 `off`。 |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | 可选正安全整数，用于覆盖默认的 8,192-token chat 上限。 |
| `DEEPSEEK_STREAM_IDLE_TIMEOUT_MS` | 可选正整数，上限 2,147,483,647；默认 120,000 ms。 |
| `DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS` | Computer 命令默认 timeout；默认 120,000 ms。 |
| `DSH_EDGE_MAX_COMMAND_TIMEOUT_MS` | 调用方可选 timeout 上限；默认 120,000 ms，且不能低于默认 timeout。 |

部署配置无效时，会在查询 session 或创建 SSE response 前失败。Edge 挂载上游 `web_search`，使用 30 秒 tool-call timeout 和结构化 result。Runtime 尚无 arbitrary-URL network policy，因此 `web_fetch` 保持禁用。

### Owner 认证

- `DSH_EDGE_ACCESS_KEY` 是 single-owner 边界。它必须包含 32–512 个 UTF-8 字节，不得带首尾空白或控制字符；应生成随机值，而不是复用人工密码。
- 登录会创建带签名、有效期 30 天的 HttpOnly `SameSite=Strict` cookie。HTTPS 使用仅限当前 host 的 `__Host-dsh_edge_owner` 名称并带 `Secure`；本地 HTTP 使用无前缀 cookie。
- Cookie 不包含用户数据，不会转发给 Durable Object，并在 access key 轮换后失效。
- 未认证的 API 与 WebSocket 请求返回 401。只有携带 `WWW-Authenticate: DshEdgeOwner` 的 owner-authentication 401 才会让同 origin shell 导航到 `/login`；provider/配置的 401 诊断仍然可见。
- 来自其他 origin 的已认证浏览器 API 与 WebSocket 请求，即使携带 same-site cookie 也会返回 403。
- Asset policy 会阻止通过 `/`、`/index.html` 或 SPA fallback 进行 frame 嵌入。`/` 重定向到 `/login`；`/api/health` 与 immutable asset 保持公开。

这里刻意不是 account system 或多租户边界。

## 安装到 Cloudflare

| 目标 | Cloudflare 要求 | 命令边界 | Health identifier |
| --- | --- | --- | --- |
| Direct（默认顶层） | Workers Free；无 Loader binding | 在 agent/VFS Durable Object 中运行加固 just-bash，带明确 timeout、有界输出/环境，并禁止网络命令 | `just-bash-direct` |
| `env.isolated` | Workers Paid 与 `LOADER` | 在独立 Dynamic Worker 中运行 Computer Worker Shell | `just-bash-isolated` |

Direct 模式比独立 Worker 的隔离更轻；不要把 single-owner 部署暴露给不受信任的用户。Workers Paid 是每月 5 美元起的 Workers 订阅，并非 Cloudflare Pro 网站套餐。Worker 名称拥有独立的 Durable Object storage 与 secret；两种模式同时在线时请使用不同名称。

`wrangler.jsonc` 仍是两种模式的 canonical source：

- 发布打包为每种模式构建一个经过测试、已 minify 的 artifact。
- Direct 只替换 Computer 中不可达的 Dynamic Worker shell-core module；Workspace adapter 与 command export 仍使用上游实现。
- Isolated 保留该 shell core，并把不可达的 Direct backend 替换成 fail-closed module。因此每个 artifact 只携带所选 command runtime。
- 安装器生成私有 mode-specific config，指向所选 artifact，并通过 `no_bundle` 上传。用户机器不会重新构建 dsh-edge，也不会把 Harness package 解析进新 Worker。
- CI 从已安装 tarball 启动 Direct artifact，并拒绝 gzip 后超过 900 KiB 的产物，为 Cloudflare 匿名临时账户的 1 MiB 上限保留余量。

### 安装与升级

无需克隆仓库，即可运行稳定版安装器：

```sh
npx dsh-edge install
```

该命令通过 npm `latest` 渠道解析。只有在存在更新的预发布版且你想主动试用时，才使用 `npx dsh-edge@next install`。

选择相同 runtime 并输入现有 Worker 名称即可升级。部署会保留 Durable Object 数据；由于 Cloudflare secret 只能写入而不能读取，升级会再次要求 owner access key 与 DeepSeek API key，并用输入值替换当前生效值：

稳定部署运行：

```sh
npx dsh-edge upgrade
```

如果当前安装版本包含 `-alpha` 或 `-rc`，请执行一次 `npx dsh-edge@latest upgrade` 切换到稳定渠道。Edge 设置页会根据已安装版本推导命令；如果不明确使用这条 `@latest` 命令，现有预发布部署会继续跟随 `next`。

### 账户与 attachment storage

- 安装器会先询问 runtime，再询问账户。
- 推荐的 `Free — Direct Shell` 可在 Workers Free 上运行，支持已检测账户、新登录/注册，以及无需登录的临时账户。
- `Isolated — Dynamic Worker` 需要 Workers Paid，只提供已检测或新认证账户。Cloudflare 会对 Loader 上传进行授权；被拒绝后可选择启用 Workers Paid 或改用 Direct 模式。
- 新的永久安装会创建或复用私有 `<worker-name>-attachments` R2 bucket，并只把 binding 写入生成的私有 Wrangler 配置。部署失败绝不删除 bucket。
- R2 Standard 提供月度免费额度，但账户必须先启用其独立的按量 subscription。安装器会在收集 Worker secret 前检查 R2。
- Cloudflare 错误 `10042` 会提供账户专属的启用、重试与取消选项。只有无 marker 的 pre-attachment Worker 可安全切换到 DO storage；新部署或已固定 R2 的部署不能切换并导致引用失联。
- 临时账户使用相同图片 UI 和 64 MiB DO backend。认领会保留 backend 与历史；自动迁移到 R2 尚未实现。
- 每个新部署都会记录 attachment-storage marker。升级时会检查每个 active version，并保留 marker 或 binding 指定的 backend。
- 图片功能之前的 Worker 没有 marker、binding 或图片引用，因此首次升级到 0.3 时会在 64 MiB DO storage 与私有 R2 之间选择一次，随后固定。Active rollout 混用 backend 时会拒绝猜测。

### Credential 交接与激活

- 后续 prompt 会选择 Worker 名称、生成或接收 owner access key、通过隐藏输入收集 DeepSeek key，并显示最终费用摘要。临时安装还要求明确接受 Cloudflare 条款与隐私政策。
- 现有 Worker 绝不会在未经确认时被覆盖。
- 两项 credential 通过权限模式为 `0600` 的临时 secret 文件传递。Wrangler 只收到 allowlist 内的 runtime 环境与当前选中的 Cloudflare authentication；其他 ambient secret 与 Node 注入选项不会进入子进程。
- 命令后会删除 secret 文件。部署 URL 来自 Wrangler 的结构化输出。添加 `--verbose` 可查看完整部署诊断。
- 上传后，安装器会在不携带 credential、不跟随重定向的前提下，最多观察公开 `/api/health` 45 秒。只有精确 package 版本与所选 runtime 会产生 ready 卡片；propagation、challenge、占位页、传输错误与旧 release response 均保持 pending。
- 观察到期仍以成功退出，并请 owner 稍后刷新。该观察不调用 DeepSeek，也不触碰 Durable Object 状态。
- 最终卡片输出 URL、已生效 owner key 与下一步。临时账户还会收到必须在 60 分钟内认领的 bearer claim URL。
- 上传被拒绝时会明确报告未安装。Wrangler 如果已创建临时账户，仍显示其 claim URL，但不把未使用的 owner key 显示为 active。
- 上传成功但交接失败时，恢复卡片会在命令按失败退出前输出已生效 owner key 与所有已知 URL。
- 安装直接通过 Wrangler 上传；不会创建或绑定 GitHub 仓库、Cloudflare Builds 项目或源码构建流水线。

从 checkout 开发的贡献者可以用 `pnpm --filter dsh-edge bundle:direct` 和 `pnpm --filter dsh-edge bundle:isolated` 在本地复现两种 release artifact。第一条命令还会执行压缩体积预算检查。

贡献者可以在没有 key 且不发起网络请求的情况下重放完整的 Free 临时账户流程。这个 example 会运行实际交付的 bin、真实 prompt、Wrangler 子进程、结构化部署输出解析、公开激活观察与最终交接，并替换外部 Cloudflare 边界：

```sh
pnpm --filter dsh-edge example:install
```

## Edge API

### 上游 RPC carrier

- `POST /api/<upstream-method>` 接受受支持 `ApiProxy` 方法的上游 `ClientRequest` envelope。
- Web client 使用 session list/search/create/history/models/select/prompt/updateQueue/rename/fork/cancel；host description；Workspace list/create/rename/delete/reorder/archive；skills；agent presets；settings 与 credential description；以及 LLM catalog。
- `agentPreset.read` 通过上游只读 viewer 渲染程序化 Edge composition。`credentials.describe` 返回不含 value 的 credential state。
- Search 投影 canonical current-message surface，并返回有界的上游 result value。
- Fork 通过 canonical session seed format 复制 completed-turn prefix，并保留 parent lineage。Edge 拒绝超过 8,192 个事件或 8 MiB 的 seed，不会物化无界 history。
- Queue mutation 通过 live upstream Agent inbox 编辑、移除或提升条目。同步 mutation 是接纳点；后续 write-behind 与 retirement retry 由 persistence coordinator 负责。
- Workspace mutation 通过 Durable Object backend 持久化上游 workspace-domain global 与 record shape。Archive 保留 session log 与 Workspace slot；unary response 与 Host frame 携带和上游一致的完整 snapshot。

### 认证与 downlink

- `GET /login` 渲染 owner form。`POST /api/auth/login` 用已配置 key 换取 signed cookie；`GET /api/auth/session` 报告有效性；`POST /api/auth/logout` 清除 cookie。
- `GET /api/events.mux` 和 `GET /api/events.host` 升级为上游 downlink WebSocket。Durable Object 会把每个 socket 的 channel 与已验证 owner-session 过期时间序列化为 hibernation attachment，通过 alarm 在过期时关闭，并从 SQL 重建 canonical session 与 retained blank header。
- 每次 inbox splice 提交后，mux 都发布完整的 `session/queue` snapshot。客户端重连时会收到待处理的 live-inbox baseline。
- `POST /api/commands/list` 使用上游 generated-Remote envelope 返回空 catalog，因为 Edge preset 没有注册 human command。
- `GET /api/health` 返回公开 release/mode identifier 与配置的 attachment 默认值（`private-r2` 或 `temporary-do`）。它先验证 owner authentication、部署级 DeepSeek 凭据、模型/传输选择与命令 timeout，再报告 ready。
- Health 不调用 provider、Durable Object、R2、VFS 或 shell。认证后的 agent-preset projection 会报告固定 backend、临时存储上限、部署默认模型，以及 runtime 实际读取的上游 catalog 与 session 选择范围。

### 诊断 REST 路由

- `PUT /api/workspace/file?path=/workspace/...` 写入 UTF-8 文件。
- `GET /api/workspace/file?path=/workspace/...` 读取 UTF-8 文件。
- `DELETE /api/workspace/file?path=/workspace/...` 删除文件。
- `POST /api/workspace/exec` 接受 `{ "command": "...", "cwd": "/workspace/..." }`，`cwd` 默认为 `/workspace`；每次执行都会收到部署级默认 timeout，`timedOut` 会报告该 deadline 是否已过，输出超过保留边界时，`outputTruncated` 会报告这一状态。
- `POST /api/sessions` 使用必填 `title` 创建持久 session；API 返回前，标题会写成标准、用户来源的 `session/title` 事件。如果 session 已持久化但 Workspace attachment 失败，500 响应会使用 `workspace-attach-failed` 并携带完整的已创建 `session`，调用方可以恢复其 id，而不会创建重复 session。
- `GET /api/sessions?after=...&limit=...` 列出一个有界 summary page；`GET /api/sessions/:sessionId` 读取一个 session。上游 persistence service 没有定义破坏性删除，因此这里不暴露 session deletion。
- `POST /api/sessions/:sessionId/turn` 接受 `{ "message": "..." }` 并流式返回持久 SSE events。
- `GET /api/sessions/:sessionId/events?after=...&limit=...` 重放一个有界 event page，并返回 continuation headers。
- `POST /api/sessions/:sessionId/cancel` 终止当前 Durable Object 进程持有的 active turn。

### Session 与 Workspace 行为

- Session 创建与 fork 在发布成功但 Workspace attachment 失败时返回 `workspace-attach-failed`，并携带已发布的 session 与 Workspace id。诊断路由返回相同 code 及完整的已创建 session。
- Prompt 和 queue-edit 文本共用 64 KiB 语义上限。10 MiB RPC 载体为 7 MiB 原始图片在 base64 与 envelope 膨胀后留出空间。
- Edge 没有目录流 provider，因此上游浏览器会在仅剩一个 Workspace 时隐藏 Delete，并在仍有恢复路径时重新显示。

### 限制与请求准入

| 表面 | 上限 |
| --- | --- |
| UTF-8 文本文件 | 1 MiB |
| Shell 命令 | 16 KiB |
| 用户消息或 queue-edit 文本 | 64 KiB |
| 保留的 shell stdout + stderr | 64 KiB |
| Session-create JSON body | 8 KiB |
| Workspace-exec JSON body | 128 KiB |
| 承载消息的 turn 或 queue-update RPC | 10 MiB |
| 图片 | PNG/JPEG；每条消息 4 张；每张 3.5 MiB；合计 7 MiB；4,000 万像素；单边 2,000 px |

- Request body 会增量消费。一旦越过路由上限，后续 chunk 只会排空而不会保留，路由返回 413。文件上传也会拒绝非法 UTF-8。
- 读取文件时先检查 VFS metadata，再通过相同的 1 MiB 上限收集已打开的 byte stream，从而关闭 `stat()` 与 `readFile()` 之间的增长竞态，且不保留无界值。
- 写入前，图片准入会完整解码声明的 raster 格式。
- 组合 shell 输出越界时，runtime 会请求中断并停止累积后续输出。`cancelled` 反映 adapter 请求的中断；`timedOut` 独立记录 deadline expiry。

### 持久性与并发

- 首次 session 持久化失败时，会先丢弃保留但尚未物化的 batch，再 dispose 新上游 agent handle，因此 teardown 无法提交一个创建请求已经报错的 session。
- Lazy blank session 只保留上游 header；首个 canonical event 会在同一 SQL transaction 中删除该 header。
- 每个 turn 持有一个上游 handle，并在 stream 完成后 dispose，避免曾访问的对话在 Durable Object 整个生命周期内常驻。
- 部署 settings 会在声明进程内 owner 前解析。一个 owner 进程会拒绝并发 turn；cancel 使用原生 agent path。
- Prompt 只有在 inbox event 跨过 `SessionStore.flush()` 后才会被接纳并发布 running state。Streamed event 也会先跨过同一 durability barrier，再通过 WebSocket 或 SSE 发送。
- Queue edit、remove 与 steering promotion 以同步 live-inbox mutation 作为接纳点。后续 write-behind 与 retirement retry 由 `PersistenceCoordinator` 负责，后来的存储尝试不能反转已接纳的 mutation。
- Session rename 对 active 与 cold session 都以同步 title append 作为接纳点。
- Workspace global state 与 record 在 Edge-specific physical key 下保留上游逻辑 schema。DO transaction 原子组合 record 与 registry-order 变更；进程内 chain 串行化 Workspace mutation。
- 已提交的 rename、delete、recreate、session reorder、attachment 和 archive 变更会发布对应上游 Host frame。`workspace.list` 会在重启后恢复完整 baseline。
- 冷恢复使用上游 interrupted-turn repair 关闭开放的持久 event tail；canonical `session/end-seed` marker 保留生命周期边界。

### 有界读取与 canonical history

- Replay 会独立确认 session 是否不存在，因此 persistence corruption 与 SQL failure 不会折叠成 404。它只读取一个有界 SQL page，并限制编码后的 response。
- `PersistenceCoordinator.readValidatedPage()` 对每个 page 执行 identity、format、legacy shape 和 event vocabulary 校验，不把 Edge pagination 加入公共 persistence service。
- Legacy normalization 如果需要更早的 message，只会通过同一受字节约束的 loader 重读一个 prefix；必要 prefix 无法装入预算时会拒绝该 page。
- 冷浏览器 history 在 SQL 中选择消息边界，并仅在固定事件数与存储字节上限内加载所得连续区间。
- Session listing 查询一个有界 canonical header/title summary page。Detail 读取 canonical point summary 或 retained blank header；turn existence check 使用 point query，不投影完整 log。
- 实际 model、system prompt、adapter defaults 和 tools 仍使用标准 `request/header` 事件。Request-scoped adapter 应用已校验的部署级 reasoning 与输出策略。
- Workspace 路径必须位于 `/workspace/` 下。
