# Agent Note: 为 dsh-edge 增加单 owner 身份认证

Status: implemented

[English](2026-08-16-single-owner-edge-auth.md) | 中文

## 问题

上游本地应用依赖 trusted-user boundary，没有需要在 Cloudflare 上保留的 account model。公开的 `dsh-edge` Worker 仍需保护上游 UI、HTTP API、支持休眠的 WebSocket、DeepSeek credential 与 Durable Object 状态。加入注册、密码找回、角色、邮件发送或外部 identity 产品会产生第二套产品面，并让 runtime adapter 与上游项目本身并不负责的事项耦合。

此前的 instance selector 同样不适合作为 identity。由调用方选择的请求头或查询参数不能授权 Durable Object 访问。

## 决策

把一次 Cloudflare 部署视为一个 owner。`DSH_EDGE_ACCESS_KEY` 是一个随机的 32–512 UTF-8 字节 Worker secret。入口 Worker 通过有大小限制的 form 和恒定工作量的 digest comparison 校验它，再签发一个不透明的 HMAC-SHA256 cookie。Cookie 只包含版本、过期时间与签名；它是 HttpOnly、`SameSite=Strict`、作用于 `/`，有效期 30 天。HTTPS 部署使用带 `Secure` 且仅限当前 host 的 `__Host-dsh_edge_owner` 名称；本地 HTTP 开发使用不带前缀的 fallback，因为浏览器要求 `__Host-` cookie 必须带 `Secure`。同一个 secret 使用 domain-separated message 为 cookie 签名，因此部署不需要第二个 signing secret，轮换 access key 会让全部 session 失效。

Worker 在 `/login` 提供不含 script 的登录页。未认证的 `/` 请求会重定向到该页面，其他受保护的 API 或 WebSocket 请求返回 401。Owner authentication 401 会携带 `WWW-Authenticate: DshEdgeOwner` challenge。Edge Web assembly 会在保持上游 bundle 不变的前提下，在其前面注入一个很小的部署 guard；只有同 origin API 返回 401 且携带这一精确 challenge 时，它才会把浏览器导航到 `/login`，避免上游 transport 永久停留于重连循环。其他 401（包括缺少 provider credential 或 provider 拒绝 credential）会留给上游 UI 显示，因为再次登录无法修复它们。`/api/auth/session` 报告 cookie 是否有效，`/api/auth/logout` 让它过期。认证 form mutation 会拒绝跨站浏览器请求。每个携带 `Origin` header 的已认证浏览器请求还必须与部署 origin 完全一致，因为仅靠 `SameSite=Strict` 无法隔离同一个 registrable domain 下不可信的 sibling origin；这一个检查会在 runtime routing 前覆盖 API 读取、mutation 与 WebSocket upgrade。Assembly 还会生成带有 `frame-ancestors 'none'` 与 `X-Frame-Options: DENY` 的 Cloudflare asset policy。在 asset 层应用该策略会覆盖 `/`、直接 `/index.html` asset 和任意 SPA fallback alias，包括 Cloudflare 不调用 Worker 而直接提供的路径。没有 `Origin` header 的非浏览器客户端仍受支持。公开 surface 仅包括 `/api/health`、登录流程和 immutable client asset；仅能访问 asset 并不授予 API 或 WebSocket 权限。

每个已认证的 runtime 请求都会映射到固定的 `owner` `DshEdgeInstance`。Worker 拒绝 `x-dsh-edge-instance` 与 `instance` 查询参数。把上游请求转发给 Durable Object 前，Worker 会移除 owner cookie、通用 authorization header 和旧 selector。对于 WebSocket upgrade，它会用已验证 cookie 的可信 expiry metadata 覆盖任何调用方值。Durable Object 把该 expiry 与 channel 一起保存在 hibernation attachment，并设置 alarm，因此已打开的 downlink 无法活得比授权它的 owner session 更久。上游 UI bundle、`ApiProxy` envelope、WebSocket frame、session schema、persistence service 与 Durable Object storage layout 均保持不变。

## 考虑过的替代方案

- **Better Auth 或其他内嵌 account system：** 它们支持多用户与商业 account flow，但需要 user table、migration、session storage、recovery policy 和 UI integration；单 owner 开源部署并不需要这些能力。
- **Cloudflare Access：** 运维能力很强，但会让基础部署依赖另一个已配置的产品，也会把首次使用体验移出仓库。
- **HTTP Basic authentication：** 浏览器的 credential cache 与 logout 行为不直观，而且每个请求都携带可复用 secret，而不是不透明 session。
- **在一个 shared key 后保留调用方选择的 instance name：** 这会产生没有 ownership、quota、administration 或 isolation policy 的意外多租户模型。
- **Fork 上游 Web UI 来加入 account control：** 认证边界位于上游协议之前，只需一个很小的登录外壳。UI fork 会增加上游同步成本，却不能改善该边界。

## 后果

- 部署者只需配置一个 owner key，并通过一个 form 登录。系统没有注册、用户数据库、角色模型、密码重置或 per-user settings layer。
- HTTP API 与两条支持休眠的 WebSocket downlink 会在 Durable Object 或 workspace routing 之前共用一个 authentication 与 exact-origin enforcement point。每个由 asset 提供的 shell alias 都不能嵌入 frame。Sibling-origin 浏览器无法利用 same-site owner cookie 读取或修改 runtime state、订阅 downlink，或通过嵌入的 shell clickjack owner。转发请求永远不会携带 owner cookie 或通用 authorization header；只有已验证的过期时间会进入 downlink handshake，Durable Object 代码不会读取部署的 access-key binding。
- Owner key 同时是登录 credential 与 cookie signature 的根。轮换会让全部 cookie 与后续 handshake 失效；已经打开的 downlink 仍受连接时记录的签名过期时间约束。key 丢失后需要替换 Worker secret。
- 普通静态 bundle 保持公开、可缓存，并可绕过 Worker execution；持有这些 immutable 文件不会获得 runtime 权限。`/`、`/login` 与 `/api/*` 会先运行 Worker，因此普通应用入口与每项协议操作都需要认证。
- 从此前调用方选择的 `local`/named object 切换到固定 `owner` object 后，旧 Durable Object 名称下的原型数据会刻意变为不可访问。该 fork 尚无已发布或托管数据，因此不提供 migration。
- 该边界适合共享一个 owner key 的个人部署或 trusted-team 部署。以后支持独立用户时，需要单独设计 identity-to-object routing，而不是扩展 instance selector。

## 验证

聚焦测试覆盖不安全部署配置、UTF-8 字节约束、错误与超大登录请求、跨站拒绝、仅限当前 host 的 cookie flags、重复 cookie 处理、expiry claim、篡改、key rotation、session status 与 logout。Wrangler 集成覆盖锁定的 root 与 API、真实登录、已认证 HTTP 与 WebSocket 流量、routed root 以及直接和 SPA-fallback shell alias 的不可嵌入 headers、sibling-origin API mutation 与 WebSocket 拒绝、由 runtime 强制执行的 WebSocket 过期、selector 拒绝、Worker 重启后 cookie 仍有效，以及既有 Durable Object session/workspace 流程。浏览器 snapshot 会先输入 owner key，再操作保持不变的上游 Web UI；随后把 owner session 换成短期有效的 signed cookie，并验证过期后会自动导航回登录外壳。
