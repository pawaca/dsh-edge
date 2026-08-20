# Agent Note: 将 direct Edge shell 设为免费默认模式

Status: implemented

[English](2026-08-17-free-direct-edge-shell.md) | 中文

## 问题

最初的 Cloudflare Computer 验证通过 Worker Loader 使用其 Worker Shell backend。这样每条命令都有独立的 Dynamic Worker isolate，但也让 Workers Paid 成为强制依赖；事实上 just-bash 与 workspace VFS 都可以在 owner Durable Object 内运行。对于单 owner 的自托管项目，这个价格门槛会明显削弱一键部署的吸引力。

替代方案仍必须保留现有 Computer workspace seam、Durable Object VFS、原生 DSH `bash` tool schema、timeout 和 output bounds，并能方便地恢复更强隔离。它不能引入第二套 filesystem，也不能 fork Computer 的 storage model。

## 决策

仓库提交的 `dsh-edge` 配置中，默认目标不再声明 Worker Loader。`LOADER` 缺席时，`DshEdgeInstance` 会注册 `DirectShellBackend`，即 Computer `WorkspaceBackend` 的进程内实现。它让 `just-bash/browser` 使用 Computer 导出的 `WorkspaceFsAdapter`，因此命令仍访问同一个基于 SQLite 的 `/workspace` VFS，并继续经过 `workspace.runtime.exec`。该 backend 还会复用 Computer 导出的 `git`、`assets` 和 `artifacts` command adapter，不创建 Edge 独有的命令协议。

Direct 模式受到明确约束。它启用 just-bash 的 hardened execution profile，并在运行时支持时启用 defense-in-depth；只传入命令显式提供的环境变量，不注册 `fetch` 或网络命令集合；执行现有的逐命令 timeout 与共享的 64 KiB 输出上限。Browser build 不包含 Node、Python、native binary、PTY、后台进程或任意 Linux 行为。

Direct backend 会在 just-bash 完成前先返回 Computer execution handle，并持续注册该 execution，直到 terminal event 被消费或 handle 被释放，因此调用方取消可以抵达仍在运行的 interpreter。Interpreter 与 workspace adapter 共用一个 65,536 字节上限：命令可以输出正好 65,536 字节，第 65,537 个字节则会在后续 shell side effect 前停止 interpreter。只有 just-bash 的 interpreter 自有 accounting 识别出未计费的限额诊断时，标准 terminal `result` 字段才会携带 output-budget 原因，命令输出无法伪造该原因。Workspace adapter 会根据 terminal event 的观察时间与请求 deadline 的关系生成 `timedOut`，因此两个原因都不信任由命令控制的 stdout、stderr 或 exit status。

`wrangler.jsonc` 仍是两种模式的 canonical source，同时定义了命名的 `isolated` environment；其中的 `LOADER` binding 会选择 Computer 现有的 `WorkerShellBackend`，无需修改 DSH tool、VFS、transport 或 persistence layer。上传前，引导式安装器会渲染带绝对路径的私有 mode-specific configuration。Direct 模式只把 `@cloudflare/computer/shell/core` alias 到空 module，因为缺少 `LOADER` 时无法抵达 Dynamic Worker backend；Computer 的 workspace adapter 与 command export 仍由上游持有。Isolated 模式保留 shell core、选择命名 environment，并把不可达的 Direct backend alias 到一个在缺少必要 Loader 时 fail closed 的 module。因此每个上传产物都会排除另一种模式的 command runtime，同时保留共享的 Workspace 与 VFS layer。两个输出都会 minify。安装器会在选择账户前，先选择 Workers Free 上的 direct 模式或 Workers Paid 上的 isolated 模式。每个 Worker 名称分别拥有独立的 Durable Object storage 与 secret。Health 会为显式诊断报告 `just-bash-direct` 或 `just-bash-isolated`，但引导式安装器不再请求该 endpoint，也不匹配其中的 shell 值；Wrangler 接受上传后，安装器会[交接通过准入的 `workers.dev` target](../simplification/2026-08-18-edge-install-handoff-without-probing.md)。CI 对两个目标使用相同 renderer，并拒绝 gzip 后超过 900 KiB 的 Direct 产物。

## 考虑过的替代方案

- **继续强制使用 isolated Worker Shell：** 默认隔离最强，但会让每次安装永久绑定 Workers Paid。
- **删除 Worker Shell 支持：** 配置更简单，却会剥夺 operator 低成本切换到更强隔离的选择，也会丢弃已经可用的 backend。
- **Fork Cloudflare Computer 或替换其 workspace runtime：** 会复制 VFS 与 runtime contract、增加上游漂移，并违反该 fork 的 adapter-first 策略。
- **维护独立的 Free 与 Paid 应用树：** 表面上更明确，但 protocol、persistence、authentication 和 UI 修改很容易分叉。通过可选 binding 选择模式可以保留一套应用 graph。
- **维护两份手写 Wrangler configuration：** 初看容易理解，但会复制 binding、migration、asset、compatibility date 与后续 upstream adaptation 修改。小型 renderer 可以保留一个经过 review 的 source of truth。
- **只依赖 minification：** 完整 shell core 生成的 gzip 产物是 1004.8 KiB，理论上只比 1 MiB 少约 19 KiB。任何无关 dependency 或应用改动都可能再次破坏匿名安装。
- **把 Computer 的 workspace adapter 与 command 实现复制进 dsh-edge：** 可以避开 barrel import，却会 fork 对预览版本敏感的 filesystem 与 command contract。Build-only alias 能移除不可达的 shell 实现，同时不接管这些 API。
- **在 direct 模式启用 just-bash 网络命令：** 使用方便，但在 dsh-edge 尚无出站 URL policy 与 SSRF 防护时，会暴露不受限制的 fetch surface。

## 结果

- 默认 Worker 产物不依赖 Worker Loader，也不内嵌 Dynamic Worker shell core。组装后的无 key 快照会通过 direct backend 执行原生 DSH `bash` 工具，并固定 model request、tool result、event log 和 cold replay。实测 gzip bundle 从 1004.8 KiB 降到 592.4 KiB；CI 强制执行 900 KiB 上限。移除不可达的 Direct backend 后，isolated 产物实测 gzip bundle 从 1004.8 KiB 降到 885.3 KiB，第二项 dry-run 仍会验证命名目标及其 Loader binding。
- Filesystem 与 session schema 均未变化。切换模式只会改变 Durable Object 构造时选择的 Computer `WorkspaceBackend`。
- Direct 命令与 agent、persistence coordinator 共用 owner Durable Object isolate。Hardened interpreter limits 可以降低风险，但不等价于独立安全 isolate；direct 模式仍只适用于经过认证的单 owner，不适合互不信任的 tenants。
- Direct 模式不提供网络命令。未来增加出站访问前，必须先定义 URL validation、私网地址与 redirect 处理、response limits 和明确的 capability boundary。
- Computer 与 just-bash 仍是对预览版本敏感的依赖。任一 package 变化时，都必须重新检查窄范围的 filesystem 与 execution type cast。
- 实际 CPU duration 和 request economics 仍取决于所选 Cloudflare 套餐与 workload。配置可以部署到 Free，不代表每种长时间 agent workload 都能落在 Free usage limits 内。

该决策取代 [验证 Cloudflare Computer 运行时边界](2026-08-14-cloudflare-computer-runtime-poc.md) 中关于 shell placement 与强制 Paid 的结论；旧 note 继续记录最初验证及更广泛的 Edge 架构。
