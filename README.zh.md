![dsh-edge——你的 DeepSeek Harness，随处可用。一条命令部署到 Cloudflare。](docs/assets/dsh-edge-hero.jpg)

[![npm](https://img.shields.io/npm/v/dsh-edge)](https://www.npmjs.com/package/dsh-edge)
[![CI](https://github.com/pawaca/dsh-edge/actions/workflows/edge-ci.yml/badge.svg)](https://github.com/pawaca/dsh-edge/actions/workflows/edge-ci.yml)
[![License: MIT](https://img.shields.io/github/license/pawaca/dsh-edge)](LICENSE)

[English](README.md) | 中文

`dsh-edge` 把已发布的 DeepSeek Harness Web 体验运行在 Cloudflare Workers 上，让你的个人 coding agent 在任何有浏览器的地方都能使用。无需维护服务器、绑定 GitHub 仓库或配置构建流水线。

它保留上游 UI、agent loop、模型选择、图片体验和 Web Search；dsh-edge 只提供 Cloudflare runtime、持久工作区、owner 登录与引导式安装器。

> **独立社区项目：** `dsh-edge` 由 [pawaca](https://github.com/pawaca) 维护，与 DeepSeek 没有关联，也未获得其背书。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是上游项目。

## 一条命令开始

你需要 Node.js 22.14 或更高版本，以及自己的 DeepSeek API key：

```sh
npx dsh-edge install
```

安装器会引导你完成所有选择并部署 Worker。你可以在没有现成 Cloudflare 登录的情况下先试用，也可以永久安装到自己的 Cloudflare 账户；不需要 checkout 源码。

## 你会得到什么

- 在任意浏览器继续持久对话和工作区。
- 通过上游选择器使用 DeepSeek V4 Flash、V4 Pro 和实验性的 V4 Flash Vision Exp。
- PNG/JPEG 图片输入与 DeepSeek 原生 Web Search。
- 持久 `/workspace` 与 DSH 原生 `bash` 工具。
- 属于你自己的 Cloudflare 部署、凭据和数据。
- 无需绑定仓库或 Cloudflare Builds 即可原地升级。

![dsh-edge 运行上游 DeepSeek Harness Web UI，并使用图片输入与 Vision Exp](docs/assets/dsh-edge-browser.png)

## 选择部署方式

| 路径 | 需要什么 | 适合场景 |
| --- | --- | --- |
| **立即试用** | 不要求已有 Cloudflare 登录；需要在 60 分钟内认领才能长期保留 | 以最低门槛体验完整产品 |
| **长期使用** | 已有或新建的 Cloudflare 账户，并启用 R2 | 长期运行的个人部署 |

默认的 **Free — Direct Shell** runtime 可在 Cloudflare Workers Free 上运行。可选的 **Isolated — Dynamic Worker** 会在独立 Worker 中执行命令，需要 Workers Paid。两种模式使用相同的产品 UI、对话、工作区、图片和工具；Direct Shell 是沙箱化 shell runtime，不是 Linux 容器。

## 升级

```sh
npx dsh-edge upgrade
```

安装器会找到已有 Worker 并原地升级，同时保留持久数据。特定版本的注意事项见 [release notes](docs/releases/)。

## 重要边界

- dsh-edge 面向单一 owner，不提供注册、多用户、角色或租户路由。
- DeepSeek key 以 secret 形式保存在你的 Cloudflare Worker 中，部署的持久数据留在你的 Cloudflare 账户内。
- Vision Exp 是实验模型，是否可用取决于 DeepSeek 账户。部分上游能力尚未适配 Edge；当前状态见[兼容矩阵](apps/dsh-edge/README.zh.md#cloudflare-兼容矩阵)。

## 基于 DeepSeek Harness

dsh-edge 依赖精确发布的 DeepSeek Harness package，而不是复制其 monorepo。上游继续负责 Web UI、插件组合、agent loop 与会话协议；本仓库只实现让它们运行在 Edge 所需的 Cloudflare runtime 与 storage adapter。

上游架构与插件 API 请参阅 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)和[参考文档](https://deepseek-harness.github.io/deepseek-harness/reference/)。

## 文档

- [Runtime reference、兼容性、安全与限制](apps/dsh-edge/README.zh.md)
- [Release notes](docs/releases/)
- [DeepSeek Harness 上游文档](https://deepseek-harness.github.io/deepseek-harness/reference/)

## 本地开发

只有开发 dsh-edge 时才需要源码 checkout。仓库工具链要求 Node.js `^22.19.0` 或 `>=24.0.0`：

```sh
git clone https://github.com/pawaca/dsh-edge.git
cd dsh-edge
pnpm install
pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile
pnpm run check
```

如何在本机启动 Worker，请查看[本地 Edge 设置](apps/dsh-edge/README.zh.md#本地运行)。

## 贡献与支持

- 请在 [Issues](https://github.com/pawaca/dsh-edge/issues) 中报告 dsh-edge bug 和安装问题。
- 漏洞请通过[私密安全流程](SECURITY.zh.md)报告，不要使用公开 Issue。
- 修改仓库前请阅读 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md) 与 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)。第三方组件及其许可证列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。
