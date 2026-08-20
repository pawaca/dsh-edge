# Agent Note: dsh-edge 根目录首页

Status: implemented

本文中的仓库结构与继承文档细节已由 [standalone wrapper 计划](../../proposed/architecture/2026-08-19-dsh-edge-standalone-wrapper.zh.md)取代；以 dsh-edge 产品为中心的首页决策继续有效。

[English](2026-08-18-dsh-edge-root-landing-page.md) | 中文

## 问题

本 fork 继承的根目录 README 面向上游 DeepSeek Harness。访问 dsh-edge 仓库的用户必须先找到 Edge 包，才能了解本 fork 的用途、安装路径、部署模式、归属和限制。上游 README 决策有意保留上游产品叙事，无法同时代表这个独立维护的 fork。

## 决策

dsh-edge 根目录 README 是本 fork 的公开首页。它优先介绍可通过浏览器访问的 Cloudflare 部署、引导式 `npx dsh-edge@latest install` 路径、free 与 isolated 两种运行时、single-owner 安全模型、当前能力缺口，并明确声明本项目与 DeepSeek 没有关联，也未获得其背书。

页面保留上游架构与贡献入口的高层链接，详细运行时行为仍由 `apps/dsh-edge/README.md` 维护。页面明确列出本 fork 持有的 `apps/dsh-edge` 与 `packages/client/ui-edge` 区域，帮助维护者区分局部的 Edge 适配和需要同步的上游包。

现有上游文档仍会链接根目录的 `#run` 与 `#run-from-source` 锚点。这些锚点继续表示本地 DeepSeek Harness Web UI，并使用 `pnpm dsh web` 命令。单独的 `pnpm --filter dsh-edge dev` 路径用于在本地启动 Edge Worker。中英文页面具有相同的技术结构与命令。

本决策曾针对原 fork 的首页，取代[上游产品优先的根 README 决策](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/process/2026-07-22-product-first-root-readme.zh.md)。

## 考虑过的替代方案

**在 fork 根目录保留上游 README。** 这种方式可把同步差异降到最低，但会在仓库的主要入口隐藏本 fork 的价值、安装路径、部署成本、安全模型和独立归属。

**只在 `apps/dsh-edge` 下记录 dsh-edge。** 这种方式可保持上游根目录不变，但要求每位新访问者先知道包位置，才能理解或安装产品。

**替换上游开发入口。** 完全聚焦 Edge 的页面更简单，但已有用户与插件开发指南依赖根目录启动锚点及其本地文件系统语义。保留相互独立的上游与 Edge 源码命令，可以同时维持两种工作流，也不会把两者混为一谈。

## 结果

仓库现在会在展示上游实现细节前，说明自身用途、安装命令、运行模式、安全策略、归属和限制。根目录 README 会维护一份由 Edge 运行时参考所拥有事实的简要摘要，因此安装方式、运行模式或支持能力变化时需要同步更新这两个位置。同步上游时会保留这项有意存在的根目录 README 差异，而稳定的启动锚点会使继承的指南继续保持准确。
