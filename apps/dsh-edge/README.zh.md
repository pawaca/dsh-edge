# dsh-edge

[English](README.md) | 中文

`dsh-edge` 是 DeepSeek Harness 的 Cloudflare 运行时。每次部署把通过认证的 owner 固定映射到一个 Durable Object，其基于 SQLite 的虚拟文件系统可跨请求持久保存。默认情况下，进程内 just-bash 后端直接在同一文件系统上执行命令，不依赖 Linux 容器或 Dynamic Worker。

`dsh-edge` 是独立的社区项目，与 DeepSeek 没有隶属关系，也未获得 DeepSeek 官方背书；DeepSeek Harness 仍是按其自身许可证使用的上游依赖。

仓库提交的 Wrangler 配置从同一套应用 graph 暴露两个部署目标。默认目标是面向 Workers Free 的 direct 模式，不包含 Worker Loader binding。命名的 `isolated` 目标会添加 `LOADER` binding，并且需要 Workers Paid，但不会 fork DSH protocol、storage、UI 或 tool implementation。

该运行时通过上游 Cordis 组合的 `ReactLoopAgent`、`AgentRegistry`、`LlmRuntime`、`ToolRuntime`、`SystemPrompt`、`SessionStore` 和 `SessionPersistence` 运行持久对话。Edge 代码只绑定请求作用域的 DeepSeek 适配器，并把一个原生 DSH `bash` 工具定义映射到 Cloudflare Computer。Durable Object SQLite 实现上游持久化后端约定，write-behind、revision、恢复准备和崩溃恢复仍由 `PersistenceCoordinator` 负责。模型历史从 canonical 事件投影，不再单独持久化。

浏览器直接使用上游 Web shell 和上游客户端插件包。构建期 assembler 根据上游 base 与 Web 组合包配置推导浏览器 roster，注入标准 `window.__DSH_BOOT__` graph，并把结果发布为 Cloudflare 静态资源。Durable Object 通过标准 HTTP carrier 实现受支持的上游 `ApiProxy` 方法，并以支持休眠的 WebSocket 提供两条上游 downlink。Edge 会排除缺少对应 host domain 的客户端插件，而不会 fork 其 UI 代码；在服务端 endpoint 可用前，session log export 也属于排除项。一个很小的 Edge 登录外壳会保护上游 UI 与协议，不修改两者本身。可选的本地 host 插件仍不可用。

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

Session turn 直接把上游 `SessionEvent` 作为 SSE data 返回，包括 `agent/inbox/spliced`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result` 及 turn/step 边界。Live stream 最多为客户端排队 1 MiB；读取更慢的客户端会断线，但 turn 及其持久化不会取消。`GET /api/sessions/SESSION_ID` 只返回有界的 session metadata；客户端通过 `GET /api/sessions/SESSION_ID/events?after=SEQ&limit=COUNT` 获取历史，该接口按上游 `seq` 重放一个有界 page。Replay 默认为 128 个 events，最多接受 256 个；它会先检查持久 payload 的字节数再加载 rows，并最多保留 1 MiB 编码后的 SSE。后续请求由 `x-dsh-edge-has-more` 与 `x-dsh-edge-next-after` 驱动。

Session listing 同样有界：`GET /api/sessions?after=SESSION_ID&limit=COUNT` 默认返回 50 个 summaries，最多接受 100 个，并在 JSON body 中返回 `hasMore` 与 `nextAfter`。Durable Object 直接从 canonical rows 推导标题和最近时间，不会加载每个 session log。上游 Web session list 还会包含尚无 canonical event 的 retained blank header。

上游浏览器的 `session.history` RPC 会在 live/cold 路径分流前统一执行 Edge 准入预算：每次请求最多使用浏览器的 50 条消息 page size。Cold log 会先在 Durable Object SQL 中应用该边界，再解码 payload，并在 8,192 个事件和 8 MiB 存储 payload 的上限内校验选中的连续窗口。Live log 不会先复制完整内存 window，而是先定位同一边界，再执行相同的事件上限与 8 MiB 编码响应上限。超出预算的窗口会被拒绝，而不会被截断。模型目录、模型选择与 turn admission 的 session 存在性检查只读取 header point query；只有真正需要恢复 agent 的 turn 才会解码 canonical history。

上游侧边栏的 `session.search` RPC 直接扫描 canonical current user/assistant message，不引入第二套 Edge 索引或 wire format。每个请求最多检查最近发生过人工活动的 32 个 session，并且只搜索事件数不超过 512 的完整 session log；cold log 还必须能放入 256 KiB 的 stored-payload 上限。响应沿用上游最多 20 条、带长度限制的 snippet；当结果上限或工作预算使答案无法穷尽时，`hasMore` 为 true。

每个经过认证的请求都会使用该部署固定的 `owner` Durable Object。旧的 `x-dsh-edge-instance` 请求头与 `instance` 查询参数会被拒绝，不会被当作 identity。`/api/sessions/SESSION_ID/turn` 会延续已保存的 canonical history。

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
| Settings and credentials | 基于文件的 settings、launch environment 和 credential services | Edge 只读投影 | 为每次操作解析 Worker secret，绝不持久化或返回 literal key。空白 secret 会被视为未配置，使用前会移除首尾空白。`credentials.describe` 只报告 `DEEPSEEK_API_KEY` 是否已配置，以及其只读来源为 `worker-secret`。内置 `dsh-edge` preset 会通过上游只读 composition viewer 投影实际 release、shell/VFS、model、limits、credential state、prompt 与 tools。可写 settings 和经过身份认证的用户级 secret storage 尚未实现。 |
| Host boot and plugins | Node 命令行、Cordis profile loading、package resolution 和 HMR | 显式 Edge composition | 不在 Workerd 中运行本地 boot profile。部署前构建 immutable 客户端包，并排除 HMR 及 Edge `ApiProxy` 未暴露的 host domain。 |
| DSH transport | Typed HTTP RPC 加 mux/host WebSocket downlink | 复用并提供 Edge 服务端实现 | 对 unary method 使用上游 fetch carrier，并保留其 envelope、schema、projection、lazy blank-session 行为、有界内容搜索、prompt 与 queue mutation、workspace mutation、queue snapshot 和 event frame。两条 downlink 都由 Durable Object WebSocket 休眠机制持有；mux 重连会重放 live inbox 的待处理状态，REST/SSE 路由则保留为诊断兼容路径。 |
| Workspace registry | Storage-domain global state 加 `WorkspaceRecord` rows | 原生 backend 适配 | 保持上游 global 和 record value shape，包括手动 session 顺序与 archive membership；仅把物理 key 和原子写入映射到 Durable Object storage。Edge 把 registry 限制为一个原生 `/workspace` VFS；rename、delete、recreate 与 session reorder 保持上游 RPC 和 Host-frame 语义。 |
| Existing Web UI | 运行时加载的 shell 和 `dsh.client` 插件 graph | 复用并采用通用 composition fallback | 把上游 shell 和受支持的上游客户端包组装成 Worker 静态资源；共享的 slot occupancy 规则会隐藏缺少 provider 的 action。Cloudflare 直接提供普通资源，`/`、`/login` 与 `/api/*` 则进入 Worker 执行 owner access control。组装后的 asset policy 会阻止所有直接或 SPA-fallback shell alias 被嵌入 frame。 |
| Other tools | Web Search、filesystem editor tools、MCP、skills、workflows、jobs 和 subagents | Search 已移植；其他未移植 | 复用上游 DeepSeek Web Search 及其 30 秒 tool-call timeout。逐个针对 Worker-compatible capabilities 增加其余工具，不宣称不可用的 host 行为。 |
| Attachments | 本地 attachment storage 和 image references | 未移植 | `imageLimits` 能力缺席时，上游 composer 不会把粘贴或拖放的图片加入草稿。启用图片前，先确定由 Durable Object 还是 object storage 持有数据，并设计 signed delivery。 |
| Authentication and tenancy | 本地 trusted-user boundary | 单 owner 适配 | 要求一个高熵 Worker secret，把它交换为带签名、有效期 30 天的 HttpOnly `SameSite=Strict` cookie，并把所有已接纳请求路由到一个固定 owner object。这里刻意不提供注册、用户数据库、角色或多租户路由。 |

浏览器请求路径是：

```text
Cloudflare static assets -> upstream Web shell + client plugin graph
  -> POST /api/session.create through the upstream HTTP carrier
  -> host/workspace-changed + session/subscribed over Durable Object WebSockets
  -> POST /api/session.prompt with the client rpcId
  -> AgentRegistry live lookup or resume
  -> sessionPersistence.prepare through PersistenceCoordinator on cold resume
  -> ReactLoopAgent.followup(queue) or ReactLoopAgent.steer(steer)
  -> pre-step admission gate waits for the sessions.flush durability barrier
  -> session/queue snapshots publish live and replay on mux reconnect
  -> turn-scoped DeepSeekAdapter configuration selected by sessionId
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

本地集成检查使用 SSE stand-in 以及真实的 Wrangler、Durable Object SQLite、默认 direct Computer workspace backend、静态资源服务、HTTP carrier 和 WebSocket。它验证 owner 登录、API 与 WebSocket cookie enforcement、拒绝旧 instance selector、direct shell 网络被禁用、上游 session create/list/history/search/prompt/rename/fork；queue edit、remove 与提升为 steering；workspace create/list/rename/delete/session reorder/archive；对应的实时与重连 baseline 和 Host frame；真实浏览器启动及由 UI 发起的 workspace rename、完整 turn、内容搜索、branch 与 archive 操作；浏览器 session 过期后自动返回登录页；跨 turn 对话连续性、event 重放、两步 bash 与 Web Search tool 交互，以及 Wrangler 重启后的恢复。一项聚焦的故障测试证明，入队后的持久化失败会阻止模型调用，同时不会把已经唤醒 Agent 的 prompt 报告为拒绝。提交到仓库的 model-visible 与 ARIA golden 会固定 tool transcript 以及组装后的上游 Web client 通过 Edge HTTP/WebSocket 协议呈现的结果。真实 DeepSeek 调用需要开发者自己的 key，因此不会纳入仓库测试套件。

## API key 边界

`.dev.vars` 中的 `DEEPSEEK_API_KEY` 是本地 credential source。只读 Edge provider 会通过上游 `ctx.credentials` service 为每次 chat 或 search 操作提供该 Worker secret，但不会将它写入 Durable Object storage、VFS、session event 或 response。Provider 会移除首尾空白，并把空白值视为未配置。`DEEPSEEK_BASE_URL` 控制 chat，必须是不含 URL userinfo 的 HTTP(S) URL；它的只读 browser 投影会省略可能携带 gateway credential 的 query 与 fragment。`DEEPSEEK_SEARCH_BASE_URL` 独立控制 DeepSeek native search 使用的 Anthropic-compatible Messages endpoint，默认为 `https://api.deepseek.com/anthropic/v1`，且必须是不含 userinfo、query 与 fragment 的 HTTP(S) URL。Edge 会挂载上游 `web_search` tool、它的 30 秒 tool-call timeout policy 与结构化 Web result presentation；由于 runtime 尚无 arbitrary-URL network policy，`web_fetch` 保持禁用。Search request 不会跟随 redirect。`DEEPSEEK_MODEL` 选择经过校验的 chat model id，默认为 `deepseek-v4-flash`。`DEEPSEEK_REASONING_EFFORT` 接受 `off`、`low`、`high` 或 `max`，默认为 `off`。`DEEPSEEK_MAX_OUTPUT_TOKENS` 可以覆盖默认的 8,192-token chat 上限，且必须是正安全整数。`DEEPSEEK_STREAM_IDLE_TIMEOUT_MS` 可以覆盖默认的 120,000 ms chat 超时，且必须是小于等于 2,147,483,647 的正整数。部署配置无效时，会在查询 session 或打开 SSE response 前失败。

`DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS` 会应用到每个未指定调用方 timeout 的 Computer 命令，`DSH_EDGE_MAX_COMMAND_TIMEOUT_MS` 则限制调用方选择的值。两者都默认为 120,000 ms，必须是小于等于 2,147,483,647 的正整数，且默认值不能超过最大值。

`DSH_EDGE_ACCESS_KEY` 是部署的单 owner 边界。它必须包含 32–512 个 UTF-8 字节，不得带首尾空白或控制字符；应生成随机值，而不是复用人工密码。Form 登录成功后会创建一个带签名、有效期 30 天的 HttpOnly `SameSite=Strict` cookie。HTTPS 部署使用仅限当前 host 的 `__Host-dsh_edge_owner` 名称并带 `Secure`；本地 HTTP 开发使用不带前缀的 cookie，因为浏览器会拒绝没有 HTTPS 的 `__Host-` cookie。Cookie 不包含用户数据，不会转发给 Durable Object，并会在 access key 轮换后失效。未认证的 API 与 WebSocket 请求返回 401。Owner authentication API failure 还会携带 `WWW-Authenticate: DshEdgeOwner`；只有这一精确的同 origin 401 才会让 Edge 组装的 shell 导航到 `/login`，因此 provider 或配置产生的 401 诊断仍然可见，而已过期的浏览器 session 仍能退出上游重连循环。来自不同 origin 的已认证浏览器 API 与 WebSocket 请求即使携带 same-site cookie 也会返回 403。Cloudflare asset policy 会阻止通过 `/`、`/index.html` 或 SPA fallback alias 到达的 shell 被嵌入 frame。`/` 重定向到 `/login`，`/api/health` 与 immutable asset 文件保持公开。它刻意不是 account system 或多租户边界。

## 安装到 Cloudflare

仓库提交的 `wrangler.jsonc` 顶层是默认 direct 目标，不要求 Worker Loader。Direct shell 代码与 agent、VFS 运行在同一个 Durable Object isolate 内，因此 just-bash 的 hardened execution limits、明确 command timeout、有界输出、显式环境变量和禁用网络命令共同构成主要命令边界。这比独立 Worker 的隔离更轻；不要把这个单 owner 部署暴露给不受信任的用户。

同一文件还定义了 `env.isolated`，这是包含 `LOADER` binding 的完整 Workers Paid 目标。应用代码会发现 `LOADER` 并选择 Computer 的 Worker Shell backend，因此 `/api/health` 会报告 `just-bash-isolated`，而不是 `just-bash-direct`。Workers Paid 是每月 5 美元起的 Workers 订阅，并非 Cloudflare Pro 网站套餐。不同 Worker 名称分别拥有独立的 Durable Object storage 与 secret；如果需要让两种模式同时在线，请使用不同名称分别安装。

`wrangler.jsonc` 仍然是两种模式唯一的 canonical configuration。发布打包会从 workspace 源码为每种模式构建一个经过测试、已 minify 的 Worker artifact。Direct 模式只在构建时替换 Computer 中不可达的 Dynamic Worker shell-core module；Computer workspace adapter 与 command export 仍使用上游实现。Isolated 模式保留该 shell core，但把不可达的 Direct backend 替换成 fail-closed module，因此每个 artifact 都只携带所选 command runtime。发布的安装器会生成私有的 mode-specific configuration，指向所选 artifact，并要求 Wrangler 使用 `no_bundle` 上传；用户机器不会重新构建 dsh-edge，也不会把上游 Harness package 解析进一个新的 Worker。CI 会从已安装的 tarball 启动 Direct artifact，并拒绝压缩后超过 900 KiB 的产物，从而在 Cloudflare 匿名临时账户上传路径强制执行的 1 MiB 上限下保留余量。

无需克隆仓库，即可从 `next` 渠道运行当前 0.2 预发布安装器：

```sh
npx dsh-edge@next install
```

稳定渠道使用 `npx dsh-edge@latest install`；在 0.2 正式晋级前，它仍指向 0.1.3。

选择相同 runtime 并输入现有 Worker 名称即可升级。部署会保留 Durable Object 数据；由于 Cloudflare secret 只能写入而不能读取，升级会再次要求 owner access key 与 DeepSeek API key，并用输入值替换当前生效值：

升级时使用与已安装版本相同的渠道。0.2 预发布版本跟随 `next`：

```sh
npx dsh-edge@next upgrade
```

稳定部署使用 `npx dsh-edge@latest upgrade`。Edge 设置页会根据已安装版本推导渠道，并复制匹配的命令。

安装器会先询问运行时，再询问账户。推荐的 `Free — Direct Shell` 模式可在 Workers Free 上运行，并可使用检测到的 Cloudflare 账户、打开 Cloudflare 登录或注册，也可在不登录的情况下创建临时账户。`Isolated — Dynamic Worker` 需要 Workers Paid，因此只提供已检测到或新认证的账户。Cloudflare 没有提供可靠的本地 Worker Loader entitlement 检查；isolated 安装会由 Cloudflare 对上传进行授权，并在被拒绝时提示启用 Workers Paid 或改用 direct 模式。

后续提示会选择 Worker 名称、生成或接收 owner access key、通过隐藏输入收集 DeepSeek API key，并显示最终费用摘要。临时账户安装还会要求用户明确接受 Cloudflare 服务条款与隐私政策。安装器绝不会在未经确认时覆盖现有 Worker。两项 credential 会通过权限模式为 `0600` 的临时 secret 文件传给 Wrangler；Wrangler 子进程只会收到 allowlist 内的运行时环境变量和当前命令选中的 Cloudflare authentication，其他 ambient key、token、password、secret 与 Node 注入选项不会进入子进程。命令结束后临时 secret 文件会被删除，安装器从 Wrangler 结构化输出中取得最终 URL。默认情况下，部署输出会收敛到一个进度提示；在任一命令后添加 `--verbose` 可以查看 Wrangler 诊断。

上传被接受后，第二个进度提示会在不发送任一 credential 且不跟随重定向的前提下，最多观察公开 `/api/health` 路由 45 秒。它只接受当前 package 的精确版本和所选 runtime。匹配的 response 会产生 ready 卡片；Cloudflare propagation、challenge、占位页、传输错误与旧 release response 都保持 pending，观察到期仍以成功退出，并提示 owner 稍后刷新。该观察不会调用 DeepSeek，也不会访问 Durable Object 状态。最终卡片会输出 URL、owner access key 与明确的下一步；临时账户还会收到一个 bearer claim URL，必须在 60 分钟内认领才能保留 Worker 及其数据。上传被拒绝时，安装器会明确报告未安装；如果 Wrangler 已经创建临时账户，仍会输出其 claim URL，但不会把尚未生效的 owner key 显示为 active。如果上传成功，但输出解析、claim URL 提取、中断处理、激活观察中断或本地清理导致正常交接无法完成，命令仍会在按失败退出前通过恢复卡片输出已生效的 owner key 与当时已知的 URL。安装过程直接通过 Wrangler 上传，不会创建或绑定 GitHub 仓库、Cloudflare Builds 项目或源码构建流水线。

从 checkout 开发的贡献者可以用 `pnpm --filter dsh-edge bundle:direct` 和 `pnpm --filter dsh-edge bundle:isolated` 在本地复现两种 release artifact。第一条命令还会执行压缩体积预算检查。

贡献者可以在没有 key 且不发起网络请求的情况下重放完整的 Free 临时账户流程。这个 example 会运行实际交付的 bin、真实 prompt、Wrangler 子进程、结构化部署输出解析、公开激活观察与最终交接，并替换外部 Cloudflare 边界：

```sh
pnpm --filter dsh-edge example:install
```

## Edge API

- `POST /api/<upstream-method>` 接受受支持 `ApiProxy` 方法的上游 `ClientRequest` envelope。Web client 当前使用 session list/search/create/history/models/select/prompt/updateQueue/rename/fork/cancel、host description、workspace list/create/rename/delete/reorder/archive、skills、agent presets、settings 与 credential description，以及 LLM catalog。`agentPreset.read` 会通过上游只读 viewer 渲染程序化 Edge composition，`credentials.describe` 则返回不含 value 的 credential state。Search 会投影 canonical current-message surface，并且只返回有界的上游 result value。Fork 会通过 canonical session seed format 复制 completed-turn prefix，并保留 parent lineage；超过 8,192 个事件或 8 MiB 的 seed 会被 Edge 拒绝，而不会在 Durable Object 中物化无界 history。Queue mutation 通过 live upstream Agent inbox 编辑、移除或把一项提升为 steering；同步 inbox mutation 是上游接纳点，后续 write-behind 与 retirement retry 由 persistence coordinator 负责。Workspace mutation 通过 Durable Object backend 持久化上游 workspace-domain global 与 record shape。Archive 保留 session log 与 workspace slot；unary response 与 Host frame 携带和上游一致的完整 snapshot。
- `GET /login` 渲染 Edge 持有的 owner form；`POST /api/auth/login` 用已配置的 access key 换取 signed cookie，`GET /api/auth/session` 报告 cookie 是否有效，`POST /api/auth/logout` 清除 cookie。
- `GET /api/events.mux` 和 `GET /api/events.host` 会升级为上游 downlink WebSocket。Durable Object 会把每个 socket 的 channel 与已验证 owner session 过期时间序列化为 hibernation attachment，通过 alarm 在该时间关闭连接，并从 Durable Object SQL 重建 canonical session 与 retained blank header。每次 inbox splice 提交后，mux stream 都会发布完整的 `session/queue` snapshot；客户端重连时还会发送 live inbox 的待处理 baseline。
- `POST /api/commands/list` 使用上游 generated-Remote envelope 返回空 catalog，因为 Edge preset 没有注册 human command。
- `GET /api/health` 会返回公开的 package-and-mode release identifier，并先验证 owner authentication、部署级 DeepSeek 凭据、模型与传输配置，以及命令超时策略，再报告运行时组件已就绪。它不会调用提供方、Durable Object、VFS 或 shell。
- `PUT /api/workspace/file?path=/workspace/...` 写入 UTF-8 文件。
- `GET /api/workspace/file?path=/workspace/...` 读取 UTF-8 文件。
- `DELETE /api/workspace/file?path=/workspace/...` 删除文件。
- `POST /api/workspace/exec` 接受 `{ "command": "...", "cwd": "/workspace/..." }`，`cwd` 默认为 `/workspace`；每次执行都会收到部署级默认 timeout，`timedOut` 会报告该 deadline 是否已过，输出超过保留边界时，`outputTruncated` 会报告这一状态。
- `POST /api/sessions` 使用必填 `title` 创建持久 session；API 返回前，标题会写成标准、用户来源的 `session/title` 事件。如果 session 已持久化但 Workspace attachment 失败，500 响应会使用 `workspace-attach-failed` 并携带完整的已创建 `session`，调用方可以恢复其 id，而不会创建重复 session。
- `GET /api/sessions?after=...&limit=...` 列出一个有界 summary page；`GET /api/sessions/:sessionId` 读取一个 session。上游 persistence service 没有定义破坏性删除，因此这里不暴露 session deletion。
- `POST /api/sessions/:sessionId/turn` 接受 `{ "message": "..." }` 并流式返回持久 SSE events。
- `GET /api/sessions/:sessionId/events?after=...&limit=...` 重放一个有界 event page，并返回 continuation headers。
- `POST /api/sessions/:sessionId/cancel` 终止当前 Durable Object 进程持有的 active turn。

上游 Session 创建与 fork 在发布成功但 Workspace attachment 失败时返回 `workspace-attach-failed`，并携带已发布的 session 与 Workspace id；诊断创建路由会返回相同 code 及完整的已创建 session。Prompt 和 queue-edit 文本共用 64 KiB 语义上限，即使其 RPC 载体最多接受 512 KiB。Edge 组合没有目录流 provider，因此上游浏览器会在仅剩一个 Workspace 时隐藏 Delete，并在仍有恢复路径时重新显示。

API 将文本文件限制为 1 MiB、命令限制为 16 KiB、用户消息限制为 64 KiB，并将保留的 shell stdout 与 stderr 总量限制为 64 KiB；这些均为 UTF-8 字节限制。Request body 会在解析或转发前增量消费：创建 session 的 JSON 上限为 8 KiB、workspace execution 为 128 KiB、承载消息的 turn 或 queue-update RPC 为 512 KiB，文件上传也会在消费过程中执行其 1 MiB 上限，并拒绝非法 UTF-8。Body 一旦越过路由上限，后续 chunk 只会排空而不会继续保留，路由最终返回 413。读取文件时会先检查 VFS metadata，再通过相同的 1 MiB 上限收集实际打开的原始 byte stream，从而关闭 `stat()` 与 `readFile()` 之间的增长竞态，且不会保留无界值。组合输出越界时，runtime 会请求中断 shell execution，并停止累积后续输出。只有 adapter 实际请求过中断时，命令状态才会报告 cancellation；这一状态与 shell exit code 独立，`timedOut` 则单独记录 deadline expiry。首次 session 持久化失败时，会先丢弃保留但尚未物化的 batch，再 dispose 新发布的上游 agent handle，因此 teardown 无法在创建请求返回错误后又提交该 session。Lazy blank session 在首个 canonical event 前只保留其上游 header；物化该 event 的同一个 SQL transaction 会删除 retained header。每个 turn 持有一个上游 handle，并在 stream 完成后 dispose，避免曾访问的对话在 Durable Object 整个生命周期内常驻内存。部署 settings 会在声明进程内 owner 前解析。上游 protocol prompt 只有在其 inbox event 跨过 `SessionStore.flush()` 后才返回 accepted 并发布 running state；后续 streamed event 也会先跨过同一个 barrier，再通过 WebSocket 或 SSE 发送。Queue edit、remove 与 steering promotion 以同步 live-inbox mutation 作为接纳点；后续 write-behind 或 retirement retry 由 `PersistenceCoordinator` 负责，因此后续存储尝试不能把已接纳的 mutation 变成被拒绝的响应。Session rename 遵循相同的上游 metadata contract：对于 active 与 cold session，同步追加 title 即为接纳点。Workspace global state 与 record 在 Edge-specific physical key 下使用上游逻辑 schema；DO transaction 原子组合 record 与 registry order 变更，进程内 chain 则串行化 workspace mutation。已提交的 rename、delete、recreate、session reorder、attachment 和 archive 变更会发布对应的上游 Host frame，`workspace.list` 会在重启后恢复完整 baseline。进程内 owner 会拒绝并发 turn，cancel 调用原生 agent cancellation path。下次冷恢复时，上游 interrupted-turn repair 会关闭开放的持久 event tail，canonical `session/end-seed` marker 会保留生命周期边界。Replay 会独立确认 session 是否不存在，因此 persistence corruption 或 SQL failure 不会被折叠成 404；它只读取一个有界 SQL page，而不是完整 suffix，并限制编码后的 response。`PersistenceCoordinator.readValidatedPage()` 会对每个 page 执行 identity、format、legacy-shape 和 event-vocabulary 校验，而不把 Edge pagination 加入公共 persistence service。如果 legacy normalization 需要更早的 message，它只会通过同一个受字节约束的 loader 重读一个 prefix；必要 prefix 无法装入预算时会拒绝该 page。冷浏览器 history 会在 SQL 中选择消息边界，并仅在固定事件数与存储字节上限内加载所得连续区间。Session listing 查询一个有界的 canonical header/title summary page；detail 读取持久化的 canonical point summary 或 retained blank header，turn existence check 则使用 point query，不会列出全部 headers 或投影完整 log。实际 model、system prompt、adapter defaults 和 tools 写入标准 `request/header` 事件。Request-scoped adapter 使用已校验的部署级 reasoning 与输出策略。workspace 路径必须位于 `/workspace/` 下。
