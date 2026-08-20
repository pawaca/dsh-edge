# dsh-edge

[English](README.md) | 中文

在自己的 Cloudflare 账户中运行 DeepSeek Harness，并从任意浏览器使用。`dsh-edge` 通过一个引导式 Cloudflare Workers 安装流程，交付上游 Web UI、agent loop（智能体循环）、会话协议、DeepSeek Web Search 与持久工作区。

你不需要维护服务器或 GitHub 仓库。安装器可以部署免费的 single-owner 实例，以不回显的方式收集所需 secret，并在结束时输出 URL 与 owner access key。

> **独立项目：** `dsh-edge` 由 [pawaca](https://github.com/pawaca) 维护，与 DeepSeek 没有关联，也未获得其背书。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 仍是上游项目。

## 你会得到什么

- 上游 DeepSeek Harness Web UI 与类型化 HTTP/WebSocket 协议。
- 由 Durable Object SQLite 支持的持久对话与 `/workspace` 虚拟文件系统（VFS）。
- 使用你自己的 API key 调用 DeepSeek 对话和原生 Web Search。
- 在持久工作区上运行的 `bash` 工具，可选择免费的 direct 运行时或可选的 isolated 运行时。
- 一个用于换取 signed browser cookie 的 owner access key；安装器可以生成高熵值。
- 直接通过 Wrangler 上传的引导式安装与升级命令，不创建源码构建流水线。

## 安装

### 安装 Edge 实例

你需要 Node.js 22.14 或更高版本，以及一个 DeepSeek API key。免费的临时账户路径不要求你预先拥有 Cloudflare 账户；安装器也可以使用已有账户，或打开 Cloudflare 登录和注册。

```sh
npx dsh-edge@latest install
```

安装器会要求你：

1. 选择 **Free — Direct Shell** 或 **Isolated — Dynamic Worker**。
2. 选择或创建 Cloudflare 账户，并选择 Worker 名称。
3. 生成高熵 owner access key，或输入自己随机生成的值，再通过隐藏输入填写 DeepSeek API key。
4. 确认费用摘要并上传。

打开安装器输出的 Worker URL，并使用 owner access key 登录。请保存该 key：轮换它会使已有浏览器会话失效，而 Cloudflare 不允许后续升级读取当前 secret。

如果使用临时 Cloudflare 账户，必须在 60 分钟内通过输出的 claim URL 完成认领，才能保留 Worker 及其数据。

## 选择运行时

| 模式 | Cloudflare 套餐 | 命令运行时 | 适用情况 |
| --- | --- | --- | --- |
| **Free — Direct Shell** | Workers Free | 在 owner Durable Object 内运行的加固 just-bash | 你希望以最低门槛完成个人部署，并信任唯一 owner。 |
| **Isolated — Dynamic Worker** | Workers Paid | 通过 Worker Loader binding 使用 Cloudflare Computer Worker Shell | 你希望命令在独立 Worker 中执行，并接受付费套餐要求。 |

两种模式使用相同的 Web UI、DSH 协议、工具、Durable Object 存储和安装器。选定的部署配置只包含对应的命令运行时，因此 isolated 部署不会同时加载 direct shell 实现。

Direct 模式不是 Linux 容器，不提供原生二进制、后台进程、PTY、任意 Linux 行为或 shell 网络访问。不要把 direct-mode 实例暴露给不受信任的用户。

## 升级

运行升级命令，选择相同运行时，并输入已有 Worker 名称：

```sh
npx dsh-edge@latest upgrade
```

Durable Object 数据会保留。Cloudflare secret 只能替换、不能读回，因此安装器会再次要求 owner access key 与 DeepSeek API key。

## 当前范围

`dsh-edge` 处于开发者预览阶段。当前预览版本聚焦完整的个人使用路径：上游对话和工作区、持久会话、模型选择、Web Search、工作区文件操作、命令执行，以及上游浏览器体验。

部署有意采用 single-owner 模式，不提供注册、多用户、角色或租户路由。附件与图片、远程 MCP、Skills、Workflows、Jobs 和 Subagents 尚未适配 Edge 运行时。`web_fetch` 在运行时具备明确的 SSRF、私网地址和重定向策略前保持关闭。

完整兼容矩阵、限制、安全行为、API 参考、本地开发命令与当前实现状态见 [dsh-edge 运行时参考](apps/dsh-edge/README.md)。

## 数据与凭据

- 对话、工作区元数据与 `/workspace` 文件存储在当前部署的 Durable Object 存储中。
- `DEEPSEEK_API_KEY` 与 `DSH_EDGE_ACCESS_KEY` 是 Cloudflare Worker secrets。其字面值不会写入会话事件、Durable Object 状态、虚拟文件系统或浏览器响应。
- 安装器通过权限模式为 `0600` 的临时文件把 secret 交给 Wrangler，命令结束后删除该文件，也不会把部署绑定到 GitHub 或 Cloudflare Builds。
- Owner cookie 使用 HttpOnly、`SameSite=Strict`，有效期为 30 天。更换 owner access key 会使它失效。

## 与上游的关系

本仓库是精确依赖 DeepSeek Harness 已发布 package 的独立 wrapper，不复制其 monorepo 源码。上游插件组合、Web UI、agent loop、协议与持久化约定仍是真源。Edge 运行时代码位于 [`apps/dsh-edge`](apps/dsh-edge)，Edge 自有的 [`packages/client/ui-edge`](packages/client/ui-edge) plugin 则通过上游 client slot 提供部署状态、升级指引与 owner session 控件。

`apps/dsh-edge/standalone` 下的隔离装配固定一个上游版本，并记录每项无法避免的 package patch。上游已经定义的 schema 或服务约定保持不变，除非 Edge 环境使其无法成立。

上游架构与插件开发请使用 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness) 和 [reference 文档](https://deepseek-harness.github.io/deepseek-harness/reference/)。

Standalone 仓库切换前的开发历史，包括 PR Review 和 0.1.3 GitHub Release，保留在已归档的 [dsh-edge-history 仓库](https://github.com/pawaca/dsh-edge-history)中。

## 运行

只有开发 dsh-edge 时才需要源码 checkout；引导式 Cloudflare 安装不需要执行这些命令。仓库工具链要求 Node.js `^22.19.0` 或 `>=24.0.0`，比已打包安装器的 Node.js 要求更严格。

仓库检查依赖与隔离的发布装配依赖需要分别安装：

```sh
git clone https://github.com/pawaca/dsh-edge.git
cd dsh-edge
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
pnpm run check
```

### 在本地运行 dsh-edge

完成[本地 Edge 设置](apps/dsh-edge/README.md#run-locally)，包括创建不会提交到 Git、包含 owner access key 与 DeepSeek API key 的 `.dev.vars` 文件。然后启动 Cloudflare Worker 开发服务器：

```sh
pnpm --filter dsh-edge dev
```

## 贡献与支持

- 请在本仓库的 [Issues](https://github.com/pawaca/dsh-edge/issues) 中报告 dsh-edge bug 和安装问题。
- 漏洞请通过[私密安全流程](SECURITY.zh.md)报告，不要使用公开 Issue。
- 修改仓库前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 在仓库中工作的 Agent 必须遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)。第三方组件及其许可证列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。
