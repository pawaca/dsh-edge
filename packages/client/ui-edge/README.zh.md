# dsh-edge-client-ui

[English](README.md) | 中文

面向 `dsh-edge` 部署的私有 Edge 专属 Web 设置插件。它由独立的 `pawaca/dsh-edge` wrapper 维护，不是官方 `@deepseek-ai` 包。它通过上游 client runtime 和 slot contract 提供一个标准 `settings.section` 页面。页面按需读取部署的 `/api/health` 投影，展示已安装的 Edge 版本、npm registry 可访问时的最新公开版本、DeepSeek Harness 基础版本、运行模式、存储后端、部署标识和当前 Owner 的退出操作。存在新版本时，页面会提供 public installer 的可复制升级命令。

浏览器不会执行部署变更，也不会接收 Cloudflare 凭证。退出登录只清除浏览器 Cookie，不改变 Worker 或 Durable Object 数据。即使部署 health 无法读取，Owner 会话控制仍然可用，因此错误的运行时配置不会把浏览器困在当前会话中。

它是普通的浏览器插件，但只属于特定部署组合。`apps/dsh-edge/standalone/scripts/assemble-standalone-web.mjs` 会在上游 Web roster 之外显式选择它；通用的上游 Web bundle 不包含它。

## 模型体验

### Edge 部署设置

#### 模型看到的内容

没有。这个仅在浏览器运行的 `settings.section` 包只展示部署元数据和 Owner 会话控制，不注册模型可见的工具、提示词或消息。

#### Token 影响

无。设置页面不会增加或修改 provider 请求的 token。

#### KV Cache 影响

无。这个包不会改变 provider 请求。

## 已知限制和延期工作

- 公开 registry 查询会 fail soft；registry 不可用时不显示版本比较和升级指引，但仍展示部署 health 和 Owner 控制。
- 升级执行仍由 CLI 完成；浏览器不会接收 Cloudflare 凭证。
