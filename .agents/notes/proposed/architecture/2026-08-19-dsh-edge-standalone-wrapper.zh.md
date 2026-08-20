# Agent Note: DSH Edge 独立包装层迁移

Status: proposed

[English](2026-08-19-dsh-edge-standalone-wrapper.md) | 中文

## 问题

DSH Edge 目前以 DeepSeek Harness 源码 fork 的方式维护，但产品自己负责的实现只包括 Cloudflare runtime、安装器、Edge client plugin、部署模式和少量上游适配。这个 fork 同时携带无关的上游源码、研发规范、CI、发布体系和文档工具，使上游更新表现为整仓合并，也让 DSH Edge 的所有权边界不清晰。

0.2 版本需要依赖精确版本的 Harness 发布包，在不复制上游仓库的情况下装配应用，并且只保留无法通过公开扩展点实现的 patch。迁移必须保留已经发布的 0.1.3 行为和持久化数据，同时保证每个合入 `master` 的版本都可以构建、部署和发布。

## 方案

### 目标仓库

standalone 仓库负责 Cloudflare Worker、Direct 和 Dynamic Loader runtime、Durable Object 与 VFS adapter、安装和发布 CLI、Edge client plugin、上游装配 adapter、经过审计的 patch，以及 Edge 自有测试和文档。它不保存 Harness monorepo、Python SDK、native runtime、vendored Cordis 源码或上游整仓研发规范的副本。

### 迁移不变量

1. `master` 始终可以发布，任何 PR 都不能依赖后续 PR 修复一个损坏的中间状态。
2. standalone 路径通过完整等价矩阵以前，生产路径保持生效。
3. PR 1 至 PR 4 固定使用 Harness `0.1.0-rc.7`，不增加产品能力。
4. 只有源码分离完成后才升级上游版本。
5. 适配首先使用公开组合方式，其次使用 package patch，绝不复制上游源码。
6. 每个 patch 都必须有理由、移除 patch 就会失败的测试和移除条件。
7. Durable Object class 名称、binding、session 格式、认证行为和用户路由保持稳定，除非 Change log 明确修订。
8. Review 轮次是收敛检查点，不是机械停止条件。Loop 停滞时先检查是否反复遇到同一根因、是否采用过度局部的修复，或者是否已经超出 PR 范围。

### 进度约定

每个 PR 只有一种状态：`planned`、`in progress`、`in review`、`merged` 或 `blocked`。只有在 Evidence 字段写明命令、产物、测试或部署证据后，验收项才能勾选。范围或验收标准变化必须附理由追加到 Change log，不能静默降低标准。

| PR | 目标 | 状态 | 版本 | 用户操作 |
| --- | --- | --- | --- | --- |
| 1 | 冻结 0.1.3 基线 | merged | 无 | 无；[PR #25](https://github.com/pawaca/dsh-edge/pull/25) 已合并 |
| 2 | 增加并行 standalone 装配路径 | merged | 无 | 无；[PR #26](https://github.com/pawaca/dsh-edge/pull/26) 已合并 |
| 3 | 达到 rc.7 等价后切换 | merged | 无 | 无；[PR #27](https://github.com/pawaca/dsh-edge/pull/27) 已合并 |
| 4 | 删除 fork 源码并简化规范 | in review | `0.2.0-alpha.1` | 批准预发布；[PR #28](https://github.com/pawaca/dsh-edge/pull/28) 已创建 |
| 5 | 升级精确上游基线 | planned | `0.2.0-alpha.2` | 批准预发布 |
| 6 | 打通分发和安装 | planned | `0.2.0-beta.1` | 完成账号所有者才能执行的 Cloudflare 流程；批准 beta |
| 7 | 演练升级并发布 0.2 | planned | `0.2.0` | 批准生产替换和发布 |

### PR 1 — 冻结 0.1.3 基线

目标：在调整仓库结构以前，把已发布行为转换为可执行的验收证据。

范围：增加 0.1.3 session、Durable Object、VFS、settings 和 plugin fixture；增加 HTTP、WebSocket、boot manifest 和 storage contract tests；记录两种构建模式和体积；盘点 Edge 自有 package 之外的每项 fork 修改。

不在范围内：runtime 行为、数据格式变化、Harness 升级、源码删除和新功能。

- [x] 现有 Edge CI 保持通过，并且不改变产品预期。
- [x] 一份 0.1.3 fixture 覆盖 session 恢复、消息、VFS、settings 和 Edge plugin 配置。
- [x] Contract tests 覆盖 Web UI 使用的 HTTP 和 WebSocket 行为。
- [x] 使用可复现命令记录 Direct 和 Dynamic Loader 构建体积。
- [x] 每项非 Edge fork 修改都归类为 adapter、保留 patch、上游候选或删除项。
- [x] Evidence 写明精确命令和产物。

Evidence：`dsh-edge-0.1.3-session.sql` 固定已发布 SQL schema、一个完整 turn 和一个 blank session。适配器测试会恢复 canonical session 并继续追加事件，把 blank session 提升后写入，然后重新加载两者。`dsh-edge-0.1.3-vfs.sql` 固定已发布 `@cloudflare/computer` 0.2.0 schema 和内容，`dsh-edge-0.1.3-workspace.json` 则固定已发布 workspace 的标题、session 排序和归档状态。仅用于测试的 Durable Object seeder 会通过原生 SQL 和 KV storage 写入三份 fixture，再拒绝任何外键完整性错误，然后才启动候选 Worker。Miniflare integration 随后读取并扩展已发布 VFS，要求第一次续写重建两条已发布消息，通过生产 Worker API 提升并持久化已发布 blank session，并通过 RPC 读取、重命名、附加和重新加载已发布 workspace。现有 settings、preset、session、Web Search、HTTP 和 WebSocket snapshot 继续作为 UI 与协议 fixture。Persistence test 的 23 项测试通过，完整 session integration 通过，browser snapshot suite 的 3 项测试通过。`pnpm --filter dsh-edge run bundle:workers` 报告 Direct gzip 为 683,920 bytes，低于仓库 921,600-byte budget；Dynamic Loader gzip 为 959.59 KiB。Hosted [Edge CI run 32343433389](https://github.com/pawaca/dsh-edge/actions/runs/32343433389) 在已 Review 的 head 上通过，[PR #25](https://github.com/pawaca/dsh-edge/pull/25) 以 `b1627b0fd033b2efdcd1a5b09e4b3160b74a1e1c` 合并。

`apps/dsh-edge/**` 和 `packages/client/ui-edge/**` 之外的当前 fork 修改按以下方式处理：

| 路径 | 处理方式 | PR |
| --- | --- | --- |
| `packages/client/ui-conversation/**` | 保留 attachment capability UI patch，并向上游提议 | 2，然后 5 |
| `packages/client/ui-workspace/**` | 保留禁止删除最后 workspace 的 patch，并向上游提议 | 2，然后 5 |
| `packages/host/apiproxy/**` | 保留兼容 Worker 的 Web Crypto patch | 2 |
| `packages/llm/llm/**` | 保留 Worker bundle manifest patch | 2 |
| `packages/session/session-persistence/**` | 保留 bounded read 和 failed-first-write extension patch | 2 |
| `packages/web/web-search-deepseek/**` | 保留 Worker no-follow redirect patch | 2 |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 和生成 catalog | 从 standalone composition 重新生成，不修改 runtime code | 2，然后 4 |
| 根 workspace、TypeScript、Vitest、Knip 和 lock file | 替换为 standalone build configuration | 2，然后 4 |
| `scripts/release/**`、release-family check 和 Edge release workflow 修改 | 替换为 standalone package release 路径 | 4 |
| Edge Agent Note、review-loop skill、根 README、legal notice 和 Edge CI | 迁移 Edge 自有子集，删除上游专用规范 | 4 |

### PR 2 — 增加独立装配路径

目标：从精确版本的上游发布包构建应用，但不改变当前生效的部署路径。

范围：引入 standalone 布局和 upstream adapter；把所有上游 package 精确固定为 `0.1.0-rc.7`；从已安装产物装配上游 Cordis manifest、Web UI asset 和 Edge plugin；使用 `pnpm` patched dependencies 表达无法避免的修改；CI 同时构建新旧路径。

不在范围内：生产切换、旧源码删除、上游升级和可见行为变化。

- [x] 全新 clone 可以确定性地产生 standalone Worker 和 Web 产物。
- [x] standalone 路径不存在对上游源码副本的 workspace 依赖。
- [x] 上游依赖使用精确版本，不使用范围或 dist-tag。
- [x] 上游源码变化会让对应 patch 明确失败。
- [x] 现有部署和发布命令继续使用已发布路径。

Evidence：`apps/dsh-edge/standalone/package.json`、隔离的 pnpm workspace 和依赖边固定钩子生成的 lock 只包含 Harness `0.1.0-rc.7`；frozen install 会应用 6 个绑定精确版本的审计 patch。发布版 `dsh-base`、`dsh-web-app` 的 Cordis manifest 与 `dsh-web-frontend` asset 共装配出 28 个 client plugin，当前路径和 standalone 路径的 boot graph 在 id、inject 和 immediate-load metadata 上一致。在 standalone 目录运行 `pnpm run build && pnpm run verify` 已构建两种模式，并根据 Wrangler metadata 拒绝任何上游 workspace 源码或主 lock 依赖输入；Direct 为 686,050 gzip bytes，低于 921,600-byte budget，Dynamic Loader 为 961.63 KiB gzip。未改变的生产命令仍把 Direct 构建为 683,920 gzip bytes。完整 Edge unit suite 通过 172 项测试，Edge typecheck 与 `lint:contracts-ready` 均通过；现有 0.1.3 package 也通过安装后验证，且没有包含仅供 standalone 使用的脚本或产物。随后 PR #26 的全新 checkout hosted Edge CI 通过并完成合并。

### PR 3 — 切换到独立运行时

目标：达到 rc.7 等价后，将 standalone 路径设为权威路径。

范围：让开发、CI、打包和部署使用 standalone 路径，同时保留两种模式、Durable Object identity、存储、认证、路由、UI 协议和 PR 1 fixture。

不在范围内：上游升级、UI 重新设计和新增插件。

- [x] 等价矩阵在 Direct 模式通过。
- [x] 等价矩阵在 Dynamic Loader 模式通过。
- [x] runtime 可以读取 0.1.3 持久化数据 fixture，不执行破坏性转换。
- [x] Direct 模式在免费 Worker 体积限制内保留实测余量。
- [x] Worker 路由、binding、class 名称和认证保持稳定。
- [x] 不存在没有记录的 Web UI 可见退化。

Evidence：`pnpm --filter dsh-edge run bundle:workers` 现在只从隔离的 rc.7 lock 构建，校验已审核的 28 项 boot graph 与依赖来源，对第二次 Web 构建执行逐字节确定性检查，再把三个输出树提升到未改变的 `dist` 与 `worker/{direct,isolated}` 发布路径。实测 Direct 为 686,060 gzip bytes（预算 921,600 bytes），Dynamic Loader 为 961.64 KiB。`node apps/dsh-edge/tests/run-session-integration.mjs` 使用 no-bundle Wrangler 配置分别启动两个已提升的 Worker 产物，并在两种环境中通过完整 HTTP、Cookie、WebSocket、session、Web Search、Bash/VFS、重启，以及 0.1.3 session/workspace/VFS fixture 测试。`pnpm --filter dsh-edge run test:snapshot` 针对已提升资源通过全部三个 runtime、browser 和 installer snapshot；唯一记录的预期变化是部署诊断从仅源码使用的 `local-development` 标记改为发布身份 `dsh-edge@0.1.3/direct`。installed-package smoke 会启动两种预构建模式并检查其 health 身份。`node scripts/dev.mjs direct --port 8791` 以同一个 Direct 产物返回 ready health，同时保持在生成配置旁查找 `.dev.vars`。workflow contract 的 17 个测试与 Edge unit suite 的 172 个测试均通过。

全新的 `pnpm pack` tarball 已通过外部安装与两种预构建模式的 smoke 检查。退役的 workspace assembler 和 source bundler 不在 tarball 中，因此 package 没有孤立的备用构建路径。

### PR 4 — 删除 fork 源码并精简治理规范

目标：只保留 Edge 自有源码以及保护 Edge 风险的控制措施。

范围：删除上游 app、package、Python、native、vendor 源码、example 和无关 asset 的副本；精简 CI 和发布 workflow；替换 monorepo 规范，同时保留 `AGENTS.md`、真实的 `CLAUDE.md` 和 review loop 收敛规则；只保留活跃的 Edge 决策；验证项目归属、许可证和 npm 内容。

不在范围内：runtime 变化、review 工具重写、上游升级和删除必要声明。

- [x] 全新 install、typecheck、lint、test、两种 Worker build 和 package verification 通过。
- [x] build 和 runtime import 都不再解析到上游源码副本。
- [x] npm tarball 只包含可分发 Edge 产物和必要声明。
- [x] CI 不包含上游专用 workflow，也不安装 Playwright Chromium。
- [x] 项目文案不宣称 DeepSeek 所有或官方身份。
- [x] `AGENTS.md` 是权威来源，真实文件 `CLAUDE.md` 引导 Claude Code 阅读它。

Evidence：一个没有父级或根依赖的临时 checkout 在安装根依赖以前完成了 standalone frozen install、两种 Worker 构建、确定性 Web 重建、6 个 patch 和 28 个 client plugin 验证。同一份 Edge client 源码随后在两个绝对路径不同的 checkout 中生成了字节完全相同的 client bundle（`37f005f9b979d20cd2f1ca08306ee8bd760b618d7bd106287a990d4c293cfc23`）；验证器会拒绝 release 产物中的绝对 checkout 路径。Direct gzip 为 686,060 bytes，低于 921,600-byte budget，Dynamic Loader 为 961.63 KiB。根测试的 20 个文件、176 项测试全部通过，两种模式通过完整 release-artifact integration，3 个 assembled-runtime/browser/installer snapshot 通过，Edge typecheck 和 type-aware lint 通过。全新的 `dsh-edge-0.1.3.tgz` 在 workspace 外安装并启动两种预构建模式，内容仅有 release Web assets、Workers、installer/runtime scripts、双语 package 文档和法律声明。仓库现在只有 `apps/dsh-edge` 和 `packages/client/ui-edge` 两个源码 workspace；CI 只剩 `edge-ci.yml` 和 `release-edge.yml`；根法律文件把 dsh-edge 归属于 pawaca，同时保留 DeepSeek 上游 MIT 声明；根 `AGENTS.md` 维护项目规则，真实的根 `CLAUDE.md` 将 Claude Code 指向这些规则。

### PR 5 — 升级上游基线

目标：将 standalone wrapper 升级上游版本，不与源码抽取混在一起。

范围：把精确依赖从 `0.1.0-rc.7` 升级到选定版本，初始目标为 `0.1.0-rc.8`；重新生成装配输入；移除过时 patch；分类上游新增 plugin 和可见变化；保留 Edge 品牌并排除尚未支持的能力。

不在范围内：实现暂缓插件、解决无关上游缺陷，以及重新设计持久化或认证。

- [ ] 每项与 Edge 相关的上游变化都归类为采用、适配、暂缓或排除。
- [ ] 未经明确修订和说明理由，patch 数量不得增加。
- [ ] 移除任一保留 patch 时，对应回归测试会失败。
- [ ] 等价矩阵在两种 runtime 模式通过。
- [ ] UI manifest 只暴露 Edge 支持的能力。

Evidence：待补充。

### PR 6 — 完成分发与安装闭环

目标：无需 clone 仓库或连接 source repo 即可安装和升级 wrapper。

范围：发布自包含 `dsh-edge` package；验证 packed artifact；安装器支持两种 runtime 模式；提供版本和升级引导；验证 macOS、Linux 和 Windows 安装；在账号所有权允许的范围内验证 Cloudflare 临时、免费账号和付费账号路径。

不在范围内：商业账号管理、GitHub source build 和受保护页面 readiness polling。

- [ ] 临时目录只使用 npm artifact 即可完成安装和部署。
- [ ] 安装后的 package 不依赖仓库相对路径或 Git submodule。
- [ ] Direct 模式可以部署到 Cloudflare 免费账号。
- [ ] Dynamic Loader 可以部署到符合条件的付费账号。
- [ ] secret 不会进入日志、已提交配置或 package artifact。
- [ ] CLI 完成信息准确说明 URL、credential 处理、模式、下一步和升级命令，不进行推测性 polling。

Evidence：待补充。

### PR 7 — 演练升级并发布 0.2

目标：证明全新安装、已有实例升级、回滚、文档和发布流程。

范围：为两种模式部署隔离 canary；演练 0.1.3 持久化数据升级和回滚；更新中英文用户文档、兼容信息和 release notes；获批后发布版本一致的 npm、tag 和 GitHub Release。

不在范围内：attachment、export、remote MCP、Skills、Workflows、Jobs 和商业认证。

- [ ] 全新安装在两种模式通过。
- [ ] 0.1.3 canary 升级后不丢失 session、消息、VFS、settings 或认证状态。
- [ ] 在 canary 上执行文档中的回滚流程。
- [ ] 上线范围内不存在 P0 或 P1 缺陷。
- [ ] 公开文档不要求了解上游 monorepo。
- [ ] npm、Git tag、GitHub Release、release notes 和 artifact 的版本均为 `0.2.0`。

Evidence：待补充。

### 等价矩阵

PR 可以增加后来发现的现有行为。删除或降低某一行要求必须在 Change log 中修订。

| 用户路径 | Direct | Dynamic Loader | 证据 |
| --- | --- | --- | --- |
| Owner key 建立 Cookie session | required | required | HTTP integration 和 browser smoke |
| 未认证请求不能访问 owner 数据 | required | required | HTTP integration |
| 创建 session 并接收流式输出 | required | required | WebSocket contract 和 browser snapshot |
| 刷新后继续同一 session | required | required | persistence integration |
| 读取、写入、列出和删除 workspace 文件 | required | required | VFS integration |
| 对同一 VFS 执行支持的 Bash 命令 | required | required | runtime integration |
| 重启后恢复持久化状态 | required | required | Durable Object fixture |
| 使用 request-scoped credential 执行 Web Search | required | required | provider integration 和 storage inspection |
| 加载 Edge client identity 和版本信息 | required | required | manifest assertion 和 browser snapshot |
| Agent Presets 不显示错误的 unavailable 提示 | required | required | browser snapshot |
| owner 和 DeepSeek credential 不进入状态或日志 | required | required | storage 和 redaction tests |

### 变更记录

- 2026-08-19：在 Edge 0.1.3 和 Harness `0.1.0-rc.7` 基线上创建本计划。PR 1 进入 `in progress`，没有修订验收标准。
- 2026-08-19：增加 0.1.3 SQL fixture、明确的 VFS 重启 assertion、构建体积证据和当前非 Edge fork 修改的完整分组结论。PR 1 已满足五项标准，完整 Edge CI 仍待执行。
- 2026-08-19：本地 unit、integration、browser snapshot、typecheck、documentation、lint、两种 Worker build、pack 和 installed-package check 均通过。PR 1 进入 `in review`；剩余标准等待 hosted Edge CI。
- 2026-08-19：已将 [PR #25](https://github.com/pawaca/dsh-edge/pull/25) 作为 draft 打开。当前剩余门槛是 hosted CI 和绑定 HEAD 的 review loop。
- 2026-08-19：Review 指出由候选版本自身创建的重启状态不能证明升级兼容性。现已增加不可变的 0.1.3 VFS 状态，并为 VFS 和 session persistence 补齐读取、续写、重新加载覆盖；PR contract 没有变化。
- 2026-08-19：后续 Review 指出 VFS fixture 中 parent-child 插入顺序无效。现已调整行顺序并增加显式 foreign-key integrity check；完整 integration 已通过。
- 2026-08-19：后续 Review 指出中文 Agent Note 的标题仍为英文。现已按术语规范翻译完整标题层级并重新记录双语配对；PR contract 没有变化。
- 2026-08-19：Ready review 指出已发布 session 和 workspace fixture 绕过了真实 Worker 入口。现已用一套仅用于测试的 Durable Object seeder 取代只改写 VFS 数据库的做法，由它写入已发布 VFS SQL、session SQL 和 workspace KV 状态；候选版本现在会通过生产 HTTP/RPC 路径读取并扩展三类状态。
- 2026-08-19：后续 Review 指出统一 seeder 丢失了原有 VFS 外键检查。现已把该检查移入 seeder 的成功边界，使每次加载已发布状态 fixture 都会在候选版本启动前验证引用完整性。
- 2026-08-20：后续 Review 指出续写没有依赖已发布消息，且已发布 blank session 只通过 workspace KV 状态出现。Mock 现在要求第一次续写同时存在两条已发布消息，blank session 则通过生产 Worker API 完成列出、读取、提升、重启和再次读取；PR contract 没有变化。
- 2026-08-20：PR 1 在 hosted Edge CI 和 HEAD-bound review 通过后合并。PR 2 进入 `in progress`；范围和验收标准保持不变。
- 2026-08-20：PR 2 已加入精确固定的 rc.7 依赖闭包、发布版 Web 与 Cordis 装配、6 个绑定版本的 package patch、只构建 Edge client 的路径、两种 standalone Worker 模式、依赖来源强制检查以及并行 CI。本地 build、等价性、unit、typecheck 和 lint 证据均已通过；全新 clone 的 hosted CI 仍待执行。
- 2026-08-20：PR 2 已把所有并行路径工具隔离到 `apps/dsh-edge/standalone` 下，保持已发布 package 的命令面和 tarball 不变。重新构建的 0.1.3 tarball 已通过外部安装与 Direct runtime smoke 验证，且不包含任何 standalone 专用文件。
- 2026-08-20：已为 PR 2 创建 [PR #26](https://github.com/pawaca/dsh-edge/pull/26)。当前剩余验收门槛是全新 clone 的 hosted CI 和绑定 HEAD 的 review。
- 2026-08-20：Review 指出，导入生产 Wrangler helper 会让根安装提供 `jsonc-parser`，掩盖 standalone 缺失的依赖。现已拆出无第三方依赖的渲染 core，让 standalone 使用自身精确依赖完成解析，并调整 hosted CI 顺序，使 standalone 在根安装前构建；PR contract 没有变化。
- 2026-08-20：PR 2 在全新 clone 的 CI 与绑定 HEAD 的 review 通过后合并。PR 3 进入 `in progress`，将在不删除 fork 源码、不升级上游的前提下，把开发、打包和部署的权威路径切换到 rc.7 standalone 路径。
- 2026-08-20：PR 3 已把 build、dev、CI、prepack、release 和 installer preparation 路由到 standalone 产物，同时保留现有 package 布局。两种已提升 runtime 模式均通过完整 0.1.3 兼容测试。Lightning CSS export 迭代暴露 class-map 属性顺序不稳定后，增加了确定性构建检查；对 key 排序消除了字节和缓存 rev 漂移，没有改变 runtime 语义。
- 2026-08-20：PR 3 通过 hosted CI 与绑定 HEAD 的 review 后，以 [PR #27](https://github.com/pawaca/dsh-edge/pull/27) 合并。PR 4 进入 `in progress`；它保留两个 Edge 自有 workspace，并把剩余的上游 workspace 依赖、仅源码检查、workflow 和治理文档全部替换为 Edge 自有实现。
- 2026-08-20：PR 4 删除了复制的 Harness 源码和面向整个上游的治理规范，把仓库缩减为两个 Edge 自有 workspace 和两个 workflow，以 Edge 自有 contract 代替 source-mode 测试和发布机制，并通过全新 standalone、单元、集成、snapshot、打包、法律、lint 和类型检查。全新构建暴露出 CSS Module hash 依赖 checkout 路径；Edge client 构建现在使用稳定的仓库相对 CSS 身份，并以验证器和双路径字节对比关闭这个可复现性缺口，不改变产品行为。
- 2026-08-20：PR 4 在本地验收通过后创建了 draft [PR #28](https://github.com/pawaca/dsh-edge/pull/28)。Hosted clean-checkout CI 和绑定 HEAD 的 review loop 是当前剩余门禁。

## 已考虑的替代方案

**继续把上游合并进 fork。** 这种方式保留源码访问，但每个 Edge 版本都会携带无关源码、规范和冲突。

**复制精简后的上游子集。** 这会形成没有明确边界的局部 fork。精确版本 package 和显式 patch 可以机械地显示所有权与升级成本。

**在抽取期间升级上游。** 这会失去 rc.7 对照点，把依赖失败和结构失败混在一起。wrapper 先达到 rc.7 等价。

**并行路径工作以前删除上游源码。** 这会产生不可发布的 `master`。等价性通过以前，已发布路径保持生效。

**保留全部上游质量规范。** 大部分规范保护 DSH Edge 不拥有的 package。standalone 仓库只保留 Edge 兼容性、安全、数据、打包和发布完整性控制。

## 验收标准

- 七个 PR 均已合并，各项验收已勾选并记录证据。
- 仓库从精确版本的上游 package 构建，并且不包含 Harness 源码副本。
- 两种 runtime 模式保持等价矩阵和已发布持久化数据。
- package 无需 clone 仓库即可安装，并发布版本一致的 npm、tag 和 GitHub Release。
- 0.2 发布时，本文改写为 implemented 架构；合并 PR 和长期测试保存证据后，移除临时进度。

## 风险

上游发布包可能没有包含当前从源码读取的 manifest 或 Web asset。PR 2 必须在切换以前发现这种缺口；缺少产物意味着提出上游打包要求或使用范围严格的 adapter 输入，而不是复制 monorepo。

Cloudflare 体积和 loader 行为可能在 dry run 与真实账号之间存在差异。构建证据不能替代 PR 6 和 PR 7 的账号验证。

逻辑存储兼容不能防止 binding 或 class 名称意外变化。fixture、配置 assertion 和 canary 演练保护不同风险，三者都必须完成。

规范精简可能误删有价值的检查。PR 4 按责任而不是文件数量删除内容，并且为每项保留的 Edge 风险证明替代保护。
