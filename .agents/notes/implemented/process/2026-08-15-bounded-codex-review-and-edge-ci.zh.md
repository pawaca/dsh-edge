# Agent Note: 约束 Codex 评审与 Edge CI

Status: implemented

本文中的仓库结构与继承 workflow 细节已由 [standalone wrapper 计划](../../proposed/architecture/2026-08-19-dsh-edge-standalone-wrapper.zh.md)取代；有界 Review Loop 与 Edge CI 决策继续有效。

[English](2026-08-15-bounded-codex-review-and-edge-ci.md) | 中文

## Problem

这个 fork 需要一项不依赖上游私有 runner 池的拉取请求检查，也需要一套可重复的方法来判断 Codex 是否评审了当前提交。把每条自动 finding 都视为指令可能扩大变更范围或削弱已有决策，而不设限的修复与重审循环可能不断堆叠补丁却无法收敛。

## Decision

`Edge CI` workflow 在非 Draft 拉取请求、推送到 `master` 和手动触发时，使用标准 GitHub-hosted Ubuntu runner 运行唯一的 `edge / verify` job。它只构建一次上游 Web 产物，随后验证文档，基于已构建的 host declaration 执行 lint，验证 workflow 与评审状态约定，测试 Edge runtime 并进行类型检查，对组装后的 runtime 与浏览器路径执行快照测试，并在 workspace 外验证打包后的公共安装器。包的 `prepack` 负责两种 Worker bundle 和 Direct bundle 的 gzip 体积检查，因此 workflow 不会重复执行这两个由包拥有的 bundle 命令。Isolated bundle 没有体积预算。workflow 不部署、不读取 provider credential，也不调用真实模型 API。依赖构建策略允许 workerd 选择平台二进制文件，同时拒绝 Workerd 无法加载的 just-bash 原生压缩 addon。

托管 job 会通过显式的测试专用 channel 选择，启动 `ubuntu-latest` runner 自带的 Google Chrome。它既不下载第二份浏览器，也不通过 Playwright 的系统软件包安装器修改托管镜像。本地运行不设置这个选项，继续使用开发者 Playwright 安装所管理的浏览器。

上游 Issue policy 与 lifecycle workflow 仍属于 canonical repository 自动化。它们的 job 只在 `deepseek-ai/deepseek-harness` 中运行，因为 fork 既不拥有上游 GitHub App credential，也不共享其项目配置。因此 fork 的拉取请求会把这些 job 报告为 skipped，而不是在仓库自有检查开始前失败。共享 workflow contract 测试会同时固定两个 canonical-repository guard 与 lifecycle event 语义。

根 `AGENTS.md` 继续作为项目指令的唯一来源。`CLAUDE.md` 链接到它，`.claude/skills` 链接到 `.agents/skills`，因此 Codex 和 Claude Code 无需镜像文本即可获得相同的拉取请求规则和 skill。

`codex-review-loop` skill 把评审 finding 视为待核实主张。当前 HEAD 的每一项都必须被修复、用证据反驳，或在它会改变产品、安全、持久数据、公共 API 或拉取请求范围时升级给用户。它的采集器把评审和 CI 观察结果绑定到稳定的拉取请求 HEAD 与 phase。该循环从不执行合并。

评审请求会携带隐藏的完整 HEAD 标记。只有带标记的请求及其 reaction 才会进入该 HEAD 的 review phase；ready 和 reopen 事件都会重置 review 与 CI 证据。采集器默认只聚合 `edge / verify`，不会被无关的上游检查干扰；如果以后有意调整 required check，可以通过按换行分隔的显式覆盖值配置。只有所有配置名称都已出现且通过，CI 才会报告 success。仓库发现会跟随 `origin`；没有该 remote 的 checkout 必须显式传入 `owner/repo`。

自动修改通过自适应收敛审计来约束，而不是使用固定轮数的人工审批门。同一问题族第二次出现时必须写明不变量并审计整个问题族；第三次出现时必须先重置策略，再进行任何后续修改。累计三轮包含可操作 finding 的评审后触发检查点，此后每增加两轮再次检查问题族是否重复、新 finding 是否由上一轮修复产生、是否仍符合 PR 主题、范围是否增长，以及开放问题是否减少。只要存在一个范围内、覆盖整个问题族的有限修复、反驳、简化或回滚，循环就可以自主继续。只有仍需决定契约或范围、通用修复再次失败且没有更安全替代、上一轮修复主导了新问题，或连续两个检查点都没有减少问题集时，才请求用户介入。

## Alternatives considered

- **复制另一个仓库的完整指令：**其中与分支、部署、Issue 和架构有关的规则会与上游 DSH 指令竞争。通过链接与 skill 只增加 fork 所需行为。
- **执行每一条 Codex finding：**自动评审可能已过期、存在错误、超出范围，或者给出不合适的修法。基于证据的处理结论可以保留维护者的决策。
- **持续修改直到 reviewer 不再发言：**反复进行局部修复可能增加复杂度并制造新 finding。自适应检查点要求循环重新评估策略与主题，不能把 reviewer 沉默当作目标。
- **只依赖人工检查 GitHub：**人工评审仍有价值，但可能混用不同提交或生命周期 phase 的证据。采集器提供可重复观察，但不替代对 finding 是否成立的判断。
- **安装由 lockfile 选定的完整 Chromium 或 headless shell：**这可以让浏览器 revision 与 Playwright 绑定，但浏览器下载和系统软件包安装占据主要耗时，并可能卡住必需 job。语义快照改为接受 runner 镜像维护的 Chrome revision。
- **删除浏览器快照：**这会放弃唯一一项通过 Edge 协议启动组装后上游 UI 的检查。
- **把 lint 和每种 runtime bundle 作为独立 workflow 命令运行：**这会重复 Web build 与包 `prepack` 已经负责的 host declaration 和 Worker bundle 工作。复用这些产物可以保留唯一的权威验证路径。

## Consequences

- 拉取请求获得免费、由 fork 自己维护的 Edge 检查，不依赖上游私有 runner 或 Cloudflare 部署 credential。
- Draft 拉取请求可以先完成一轮 Codex 评审，再由 Ready 转换启动必须通过的 CI 和新评审 phase。
- 评审完成表示 finding 已得到处理，并不表示全部接受；技术性反驳也是正式的已处理结论。
- 困难评审会公开收敛判断，并可在无需日常人工审批的情况下自主调整方向。只有遇到未解决的契约、范围或真正不收敛的决策时才暂停。
- 采集器依赖 `bash`、`gh`、`jq` 和 `perl`，其 contract fixture 在 Edge CI 中运行。每个拉取请求的已处理状态和问题族状态保留在 checkout 的 Git 目录中，不进入提交。
- 采集器会把每个快照绑定到 PR 活动水位，并对其消费的所有可变 GitHub 输入执行两次采集，包括 review、PR 活动、check run、check suite 与 commit status 集合；两次采集只要不同，就拒绝该次快照。
- 在 lifecycle boundary 的同一时间戳秒内观察到的 pending check 会继续保持 pending。已完成且非 skipped 的 check 或 status 只有在完成或更新时间严格晚于边界时才能在同秒启动；skipped check 必须严格晚于边界启动，并且永远不能满足 fork 门禁。
- 绑定到最新带标记 review request 评论的 reaction 可以在同一时间戳秒内计入，因为评论 ID 能证明其所属 phase；如果 ready 或 reopen 事件与该边界同秒，采集器会拒绝这种相等时间戳。
- 无 finding 的 review wrapper 不会消耗自动修改预算；GitHub 把未解决 inline finding 重新定位到当前 HEAD 后，即使其父 review 指向旧提交，采集器仍会显示它。
- `edge / verify` 覆盖 fork 的 Edge runtime、组装后的浏览器路径以及仓库文档与 lint 检查，但不替代上游平台、coverage、跨浏览器、Windows 或 release matrix。
- Edge CI 不再准备或缓存浏览器。runner 镜像中的 Chrome 更新可能独立于 lockfile 改变浏览器行为或 ARIA 输出；由此产生的快照失败会把变更显式交给评审。包的 `prepack` 继续作为 CI 验证两种 Worker mode 的唯一路径。
- 上游 Issue 治理配置会保留以便同步，但在 fork 中不生效；我们不会复制或删除它，也不会为它提供 fork 专用 credential。
