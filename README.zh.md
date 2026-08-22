# dsh-edge

[![npm](https://img.shields.io/npm/v/dsh-edge)](https://www.npmjs.com/package/dsh-edge)
[![CI](https://github.com/pawaca/dsh-edge/actions/workflows/edge-ci.yml/badge.svg)](https://github.com/pawaca/dsh-edge/actions/workflows/edge-ci.yml)
[![License: MIT](https://img.shields.io/github/license/pawaca/dsh-edge)](LICENSE)

[English](README.md) | 中文

## 一条命令，把 DeepSeek Harness 部署到 Cloudflare，在任意浏览器使用

DeepSeek Harness 把能力完整的 coding-agent Web UI 与本地 host runtime 组合在一起。`dsh-edge` 将这套体验封装到 Cloudflare Workers，让你的个人智能体可以从任意浏览器访问——不用维护服务器，不用创建 GitHub 仓库，也不用配置构建流水线。

上游 UI、agent loop、会话协议、模型目录、图片体验和 Web Search 均保持不变；Edge 层只提供 Cloudflare runtime、持久存储、single-owner 登录和引导式安装器。

![dsh-edge 运行上游 DeepSeek Harness Web UI，并使用图片输入与 Vision Exp](docs/assets/dsh-edge-browser.png)

> **独立社区项目：** `dsh-edge` 由 [pawaca](https://github.com/pawaca) 维护，与 DeepSeek 没有关联，也未获得其背书。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是上游项目。

## 安装

你需要 Node.js 22.14 或更高版本，以及自己的 DeepSeek API key：

```sh
npx dsh-edge install
```

安装器会依次引导你选择 runtime、Cloudflare 账户、Worker 名称、owner access key、DeepSeek key，确认费用并上传，最后观察公开路由激活。选择临时账户路径，无需已有 Cloudflare 登录也能试用；如果希望保留 Worker 与数据，需要在 60 分钟内认领该部署。

该命令从 npm 安装当前稳定版。如果存在预发布版，仍可通过 `npx dsh-edge@next install` 主动选用。

## 你可以做什么

- 在任意浏览器继续持久对话和工作区。
- 通过上游模型选择器使用 DeepSeek V4 Flash、V4 Pro 或实验性的 V4 Flash Vision Exp。
- 把 PNG/JPEG 图片粘贴或拖入上游 composer，并在会话历史中重新查看。
- 使用 DeepSeek 原生 Web Search 工具搜索互联网。
- 读写持久 `/workspace`，并让 agent 使用其中的 `bash` 工具。
- 把自己的 DeepSeek key 和数据留在自己的 Cloudflare 部署中。
- 原地升级，不需要把 Worker 绑定到本仓库或 Cloudflare Builds。

## 两条部署路径

| 路径 | Cloudflare 账户 | 图片存储 | 适用场景 |
| --- | --- | --- | --- |
| **临时预览** | 不要求已有登录；需在 60 分钟内认领 | 有界的 64 MiB Durable Object backend | 以最低门槛试用完整浏览器与图片流程 |
| **新的永久部署** | 使用已有或新登录的账户；必须启用 R2 subscription | 私有 R2 bucket | 在自己的长期账户中保留对话和图片 |

每个部署只选择一次 attachment backend，并在 Durable Object 休眠、认领和升级后保持固定：

- 认领临时部署会保留 DO 图片，不会静默迁移到 R2。
- R2 Standard 有[月度免费额度](https://developers.cloudflare.com/r2/pricing/)，但必须先[在 Dashboard 启用](https://developers.cloudflare.com/r2/get-started/)它独立的按量 subscription。
- 0.3 之前创建的 Worker 首次升级时，会在无需额外开通的 Durable Object storage（每个实例 64 MiB）和私有 R2 之间选择一次。
- 安装器会在收集 Worker secret 前验证 R2；若 R2 不可用，只在不会导致既有图片引用失联时才提供切换回 DO storage的选项。
- 后续升级保留已选 backend，不会自动迁移图片数据。

### 选择命令运行时

| 模式 | Cloudflare 套餐 | 命令运行时 | 取舍 |
| --- | --- | --- | --- |
| **Free — Direct Shell** | Workers Free | owner Durable Object 内的加固 just-bash | 门槛最低的个人部署 |
| **Isolated — Dynamic Worker** | Workers Paid | 通过 Worker Loader 使用 Cloudflare Computer Worker Shell | 在独立 Worker 中执行命令 |

两种模式使用相同的 UI、协议、工具、对话、工作区、图片流程和安装器。Direct Shell 不是 Linux 容器：它没有原生二进制、后台进程、PTY、任意 Linux 行为或 shell 网络访问。不要把它暴露给不受信任的用户。

## 升级

```sh
npx dsh-edge upgrade
```

请选择已有 Worker 和相同 runtime。Durable Object 数据与已经固定的 attachment backend 都会保留。Cloudflare secret 只能写入、不能读回，因此安装器会再次询问已有 owner access key 和 DeepSeek API key。

如果当前安装版本包含 `-alpha` 或 `-rc`，请执行一次 `npx dsh-edge@latest upgrade` 切换到稳定渠道。只有在你明确希望继续使用预发布版时，才使用 `npx dsh-edge@next upgrade`。

## 数据、凭据与限制

- 对话、工作区元数据与 `/workspace` 文件存储在当前部署的 Durable Object 中。
- 使用 R2 的部署把通过校验的图片作为不可变对象写入私有 bucket；使用 DO 的部署在 owner instance 中使用 64 MiB、按 512 KiB 分块的 backend。Session event 只保留上游 content-addressed reference。
- 图片仅接受 PNG 和 JPEG：每条消息最多 4 张、每张 3.5 MiB、合计 7 MiB、最多 4,000 万像素，且单边不超过 2,000 像素。
- `DEEPSEEK_API_KEY` 与 `DSH_EDGE_ACCESS_KEY` 是 Worker secret，其字面值不会写入会话事件、Durable Object 状态、VFS 或浏览器响应。
- 安装器通过权限模式为 `0600` 的临时文件把 secret 交给 Wrangler，随后删除，也不会创建源码构建集成。
- Owner cookie 使用 HttpOnly、`SameSite=Strict`，有效期为 30 天。轮换 owner access key 会使已有会话失效。

## 当前边界

`dsh-edge` 有意采用 single-owner 模式，不提供注册、多用户、角色或租户路由。Vision Exp 是实验模型，可能并非对所有 DeepSeek 账户开放。

非图片文件附件、会话导出、`@file` 与 `@session` 引用、remote MCP、Skills、Workflows、Jobs 和 Subagents 尚未适配 Edge。`web_fetch` 在 runtime 具备明确的 SSRF、私网地址和重定向策略前保持关闭。

完整兼容矩阵、API、限制、安全行为与实现细节见 [runtime reference](apps/dsh-edge/README.zh.md)。

## 如何保持贴近上游

本仓库依赖 DeepSeek Harness 精确发布的 package，而不是复制其 monorepo。上游负责 Web UI、插件组合、agent loop、模型与附件协议、会话约定；dsh-edge 只实现 Cloudflare 特有的 runtime 与 storage seam。

Edge runtime 位于 [`apps/dsh-edge`](apps/dsh-edge)。小型 [`packages/client/ui-edge`](packages/client/ui-edge) plugin 通过上游 client slot 提供部署状态、升级指引与 owner session 控件。`apps/dsh-edge/standalone` 中的隔离装配固定一个上游版本，并记录每项无法避免、绑定版本的 patch。

上游架构与插件开发请参阅 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness) 和[参考文档](https://deepseek-harness.github.io/deepseek-harness/reference/)。

## 本地开发

只有开发 dsh-edge 时才需要源码 checkout。仓库工具链要求 Node.js `^22.19.0` 或 `>=24.0.0`：

```sh
git clone https://github.com/pawaca/dsh-edge.git
cd dsh-edge
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
pnpm run check
```

完成[本地 Edge 设置](apps/dsh-edge/README.zh.md#本地运行)，包括创建被忽略的 `.dev.vars`，然后运行：

```sh
pnpm --filter dsh-edge dev
```

## 贡献与支持

- 请在 [Issues](https://github.com/pawaca/dsh-edge/issues) 中报告 dsh-edge bug 和安装问题。
- 漏洞请通过[私密安全流程](SECURITY.zh.md)报告，不要使用公开 Issue。
- 修改仓库前请阅读 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md) 与 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)。第三方组件及其许可证列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。
