# Agent Note：通过上游 slot 增加 Edge 自有设置插件

Status: implemented

本文中的仓库结构细节已由[已实现的 standalone wrapper 架构](2026-08-19-dsh-edge-standalone-wrapper.zh.md)取代；Edge 自有 client plugin 的决策继续有效。

[English](2026-08-18-edge-client-plugin.md) | 中文

## 问题

组装后的上游 Web client 没有入口来识别已部署的 `dsh-edge` 构建、区分免费和隔离运行时或结束 Owner 会话。如果把这些控制直接写进上游设置源码，每次同步上游都会携带一个 Edge 专属 UI 分叉。

## 决策

增加由 `pawaca/dsh-edge` fork 持有的私有标准 client 插件 `dsh-edge-client-ui`。无 scope 名称、作者、源码仓库与精确的 release-family 排除规则会把它和官方 `@deepseek-ai` 包区分开，同时让实现继续使用上游插件 contract。它使用已有的 runtime、locale、`settings.section`、注入式 snapshot-store 和共享 primitives contract。Edge assembler 会把这个包显式追加到部署 roster；上游 Web bundle patch 保持不变，因此原生部署不会看到这个页面。

Worker 把 Edge package 版本及其中记录的上游基础版本作为构建输入，并通过 `/api/health` 投影；`host.describe` 使用同一份 Edge 元数据。页面只在挂载时读取 health，把已安装版本与公开 npm latest endpoint 比较，并在存在较新 release 时提供可执行的 CLI 升级命令。Registry 失败不会隐藏部署信息。浏览器不会接收 Cloudflare 凭证或执行部署变更。Owner 退出复用已有的同源认证路由。Owner 会话卡片独立于部署 health 渲染，因此配置错误不会移除退出路径。Controller 状态转换也维持同一所有权边界：无论完成顺序如何，health、clipboard 与退出完成都只修改各自持有的字段。

## 考虑过的替代方案

- **修改上游设置 shell：** 这会把部署策略复制进通用产品界面，并增加同步上游的难度。
- **构建 app 本地 React island：** 这会绕开标准 client loader、slot 生命周期、locale 和 snapshot-store contract。
- **从浏览器升级：** 这要求把 Cloudflare 凭证放进 Worker，或增加高权限部署服务，只为便利操作扩大安全边界。
- **提前发布更新指引：** 即使开发构建目前会隐藏入口，未来才实现的命令也不是可执行的用户 contract。

## 结果

- Edge 专属 UI 被限制在一个包和一个显式 assembler roster 条目中。
- 私有插件不会进入上游 npm release family，其 manifest 也不会声称属于 DeepSeek scope 或源码仓库。
- 已安装版本、上游基础版本、运行时、存储和部署信息由一个真实的 Worker 投影提供。
- [Public installer](2026-08-18-public-edge-installer.md) 负责 npm 发布与此页面提示的升级命令。

## 验证

Controller 测试覆盖按需读取 health、npm 版本比较、clipboard 指引、并发读取顺序、health/退出交错完成、退出登录和异常 health。组装后的 Edge 浏览器快照会打开真实 Settings shell，选择 DSH Edge 页面，并固定它在 release、运行时、存储、部署和 Owner 会话方面的无障碍呈现。
