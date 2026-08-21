# Agent Note：独立 dsh-edge wrapper

Status：implemented

[English](2026-08-19-dsh-edge-standalone-wrapper.md) | 中文

## 问题

DSH Edge 最初是 DeepSeek Harness 的源码 fork，但产品自有实现实际上只包括 Cloudflare runtime、安装器、Edge client plugin、部署模式和少量上游适配。Fork 使每次上游更新都表现为仓库级合并，携带无关源码与规范，也模糊了 DeepSeek Harness 和这个独立社区项目之间的所有权边界。

独立仓库必须消费一个精确的 Harness 已发布版本，保持已经发布的 Cloudflare 行为和持久化数据，并且只保留在 Workers 上运行该版本所需的 Edge 自有代码与范围严格的适配。

## 决策

`pawaca/dsh-edge` 是独立 wrapper 仓库，不是 DeepSeek Harness 源码 fork。它拥有：

- `apps/dsh-edge/`：Worker 入口、Durable Object adapter、安装器、release CLI、测试和 package 文档；
- `packages/client/ui-edge/`：Edge 专用 browser plugin；
- `apps/dsh-edge/standalone/`：精确上游依赖闭包、已审计 patch、Web 装配以及 Direct 和 Dynamic Worker 构建；
- `.agents/`：当前项目决策和有界 Review Loop。

仓库不携带 Harness monorepo、Python SDK、native runtime、vendored Cordis 源码、example 或上游范围的开发 workflow 副本。分离前的仓库和 PR 历史保留在 [`pawaca/dsh-edge-history`](https://github.com/pawaca/dsh-edge-history)。

## 上游装配

Standalone 装配中的每一个 `@deepseek-ai/dsh-*` package 都固定到同一个精确上游版本。0.2.0 使用 DeepSeek Harness `0.1.0-rc.8`；验证会拒绝版本范围、dist-tag、workspace fallback，以及由根安装意外补齐的依赖。

装配会消费已发布的 Cordis manifest 与 Web asset，通过 composition 加入 Edge client plugin，并构建经过 Review 的 30-plugin client graph。适配首先使用公开扩展点。只有 composition 无法表达必需的 Worker 兼容改动时，才允许使用精确版本 `pnpm` patch，并且必须具有原因、移除 patch 时会失败的检查和移除条件。rc.8 装配保留 6 个这样的 patch。复制上游源码不属于适配选项。

上游升级是协同的 baseline 变更：一起更新完整的精确依赖闭包，rebase 或移除全部 patch，Review plugin graph 变化，并重新运行确定性构建、双 runtime、持久化数据、browser 和 package 门禁。

## Runtime 约定

一套源码生成两个预构建 Worker artifact：

- **Direct Shell** 在 direct just-bash backend 上运行上游 Computer workspace adapter 和 command export。它的构建会替换不可达的 Dynamic Worker shell-core module，并保持在仓库 900 KiB gzip budget 以内，以支持 Cloudflare Workers Free 路径。
- **Dynamic Worker** 保留上游 shell core 以提供更强隔离，并替换不可达的 Direct backend。它要求符合条件的 Cloudflare Workers 付费账户。

两个 artifact 有意只在命令执行方式上不同。它们共享上游 Web UI、Edge client plugin、HTTP 与 WebSocket 协议、session 行为、工具、认证、workspace 和 Durable Object 存储。Release packaging 会选择一个预构建 artifact 并通过 `no_bundle` 上传；用户机器不会重新构建 Harness 或解析其依赖图。

Direct Shell 不是 Linux 容器，不承诺 native binary、PTY、后台进程或不受限制的网络行为。Dynamic Worker 不改变产品或持久化约定，只改变命令执行的隔离边界。

## 持久化状态与凭据

Session、message、workspace metadata 与 `/workspace` 虚拟文件系统存储在 Durable Object SQLite 和 KV 状态中。稳定约定保留 dsh-edge 0.1.3 已发布的 Durable Object class name、binding、route、session/event 格式、owner 认证和 Edge schema v2 表示。这里不使用上游 Node SQLite schema，0.2.0 也不执行持久化数据迁移。

不可变的 0.1.3 session、workspace 和 VFS fixture 会通过仅供测试使用的 Durable Object seeder 加载并接受引用完整性检查，随后在两种 runtime 中通过生产 HTTP、RPC、WebSocket、session、Bash 和 VFS 路径完成读取、扩展、重启和再次读取。

`DSH_EDGE_ACCESS_KEY` 和 `DEEPSEEK_API_KEY` 继续作为只写 Worker secret。认证可以在 `Set-Cookie` response header 中返回签名或过期的 owner-session cookie；该 cookie 不会进入 response body、Durable Object 状态、VFS、生成配置、日志、fixture 或 tarball，并且在转发上游前会被移除。Bearer token 和 provider credential 不会进入 response header、response body 或上述任何持久化表面。DeepSeek credential 只会在当前 request 或 turn（包括 Web Search）内绑定，随后释放。

## 安装与发布

用户无需 checkout 仓库即可安装或升级稳定渠道：

```sh
npx dsh-edge install
npx dsh-edge upgrade
```

稳定版本跟随 npm `latest`，显式预发布版本跟随 `next`。Direct 模式的安装器支持匿名临时 Cloudflare 账户或已认证账户；Dynamic Worker 则要求已认证且符合条件的付费账户。升级会保留 Durable Object 数据，但 Cloudflare secret 无法读回，因此需要再次输入现有 owner key 与 DeepSeek key。

发布从一个手动请求 workflow 开始；它拥有 repository dispatch authority，但没有 npm 或 OIDC 发布 authority。发布 workflow 从默认分支解析，验证经过 Review 的 `dsh-edge-v*` tag 与 package version 匹配、tag 属于已经 Review 的 `master`，重新构建并测试精确 package，在 workspace 外安装 tarball，并在 npm 与 GitHub 写入前分别再次检查 tag 没有移动。npm Trusted Publishing 使用 OIDC provenance，不需要长期 publish token。先发布 npm；只有 notes 与 tarball 相同才会创建匹配的 GitHub Release。

## 验证约定

长期验收面如下：

| 用户路径 | Direct | Dynamic Worker | 证据 |
| --- | --- | --- | --- |
| Owner key 建立 Cookie session | required | required | HTTP integration 和 browser snapshot |
| 未认证请求不能访问 owner 数据 | required | required | HTTP integration |
| 创建、流式输出、刷新并续写 session | required | required | WebSocket 和 persistence integration |
| 读取、写入、列出、删除 workspace 文件并在重启后恢复 | required | required | VFS 和已发布状态 integration |
| 对同一 VFS 执行受支持的 Bash 命令 | required | required | runtime integration |
| 使用 request-scoped credential 执行 DeepSeek Web Search | required | required | provider integration 和 storage inspection |
| 加载 Edge identity、release、runtime 与升级信息 | required | required | manifest assertion 和 browser snapshot |
| 正确展示只读内建 Agent Preset | required | required | browser snapshot |
| Owner 与 DeepSeek credential 不进入状态或日志 | required | required | storage、redaction 和 package test |

CI 会在根安装前构建 standalone 依赖闭包，验证确定性 Web 输出与 patch 覆盖，强制执行 Direct 体积 budget，运行仓库 contract，针对 0.1.3 持久化状态测试两种已提升 Worker artifact，检查装配后的 browser/runtime snapshot，打包 npm artifact，并在 workspace 外启动两种已安装模式。Windows runner 会验证 Windows 专用安装器和发布行为。

## 已实现结果

迁移通过归档 PR [#25](https://github.com/pawaca/dsh-edge-history/pull/25)、[#26](https://github.com/pawaca/dsh-edge-history/pull/26)、[#27](https://github.com/pawaca/dsh-edge-history/pull/27) 和 [#28](https://github.com/pawaca/dsh-edge-history/pull/28) 完成。它们经过 Review 的 tree 成为独立 canonical repository；后续 alpha release 建立可信发布路径，并把精确上游 baseline 从 rc.7 升级到 rc.8。

Release preparation [PR #20](https://github.com/pawaca/dsh-edge/pull/20) 通过绑定 HEAD 的 Review 和 [Edge CI run 32471194741](https://github.com/pawaca/dsh-edge/actions/runs/32471194741)，其中包括 205 项仓库测试、两种 runtime integration、0.1.3 持久化状态 fixture、3 个 browser/runtime snapshot，以及在 workspace 外安装打包 artifact。[Release run 32471861144](https://github.com/pawaca/dsh-edge/actions/runs/32471861144) 随后从 merge commit `451dc41752cd7644a2e112dbd03e970ef663b072` 发布 npm `latest`、tag `dsh-edge-v0.2.0`、非预发布 [GitHub Release](https://github.com/pawaca/dsh-edge/releases/tag/dsh-edge-v0.2.0)、经过 Review 的 notes、provenance 和 `dsh-edge-0.2.0.tgz`。

npm 与 GitHub Release tarball 逐字节一致，SHA-512 为 `7f5df95c2c96597180047ed829a97fa83ea0e1e7a7e69f8a60c600b3f945d9c87ca906429d7154ab6359186dc013c4612324bb16473f85462abd1d918405fc2a`。Standalone wrapper 迁移和 0.2.0 发布约定至此完成。

## 影响

- 同步上游现在是显式 package baseline 操作，不再是源码 merge。
- Edge 所有权和 patch 成本可以被机械识别，但如果升级需要尚未发布的上游 artifact，就必须等待上游发布或证明一个范围严格的 adapter input 合理，升级可能因此受阻。
- Direct 与 Dynamic Worker 等价性、已发布持久化数据兼容性、credential 隔离、确定性装配和精确 npm artifact 是永久发布门禁。
- 附件/图片与带防护的 `web_fetch` 暂缓到 0.3，`@file` 与 `@session` 引用暂缓到 0.4，更多 model/provider 选择暂缓到 0.5。它们是新的产品增量，不是 0.2 迁移遗留工作。

## 已考虑的替代方案

- **继续合并上游源码 fork：** 保留直接源码访问，但会让每个 Edge release 重新携带无关源码、规范、冲突和模糊的所有权。
- **复制精简后的上游子集：** 会形成局部 fork，其所有权和更新成本比精确 package 与显式 patch 更难验证。
- **在分离仓库的同时升级上游：** 会把依赖失败和结构失败混在一起并移除稳定对照点，因此迁移先达到 rc.7 等价，再采用 rc.8。
- **把 Dynamic Worker 当作另一个产品：** 会重复协议、存储、UI 和生命周期逻辑。使用一个等价约定并选择执行 backend，可以保持 Edge 适配范围狭窄。
