# Agent Note：将 dsh-edge 作为独立安装器发布

Status: implemented

本文中的仓库结构细节已由[已实现的 standalone wrapper 架构](2026-08-19-dsh-edge-standalone-wrapper.zh.md)取代；installer 与发布决策继续有效。

[English](2026-08-18-public-edge-installer.md) | 中文

## 问题

从仓库 checkout 运行 Edge 部署会让安装依赖 Git、monorepo 与 workspace dependency link，也无法为已部署实例提供可重复的版本化升级路径。

## 决策

将 `dsh-edge` 作为无 scope 的 npm 包发布，使用独立语义版本与 `dsh-edge-v*` release tag。源码仍留在 fork 中以便同步，但通过精确路径排除在上游 `@deepseek-ai/*` release family 之外。Workspace constraint gate 会为该精确应用提供独立公开策略，约束名称、repository、access 与 payload，而不是把它视作私有 app 或上游 release member。Tarball 包含组装后的 Web asset、Worker source、Wrangler 配置渲染器、安装器、两种 runtime bundle gate，以及打包前根据仓库根法律权威文件生成的 package 内 license 和第三方声明。[独立 package 归属记录](../process/2026-08-18-dsh-edge-independent-package-attribution.md)负责该生成与校验约定，本记录负责安装器发布哪些 artifact。Workspace dependency spec 在 tarball 中转为精确发布版本，package metadata 记录 runtime health 所报告的 DeepSeek Harness 基础版本。

CLI 暴露 `install` 与 `upgrade`。Install 可以为 direct 模式创建 Cloudflare 临时账户；upgrade 要求已认证账户与已存在的 Worker。Upgrade 会重新部署所选 runtime，并替换重新输入的只写 secret，同时保留 Durable Object storage。浏览器不携带 credential 地查询公开 npm registry；registry 不可用时会 fail soft，并且只提供可复制的 CLI 命令，不在浏览器中持有 Cloudflare authority。Windows 原生的独立 release job 会固定支持 Trusted Publisher OIDC 的 npm 版本并串行发布。它会在发布前比较当前 channel：较新的候选版本由 `npm publish` 原子设置 `latest` 或 `next`，延迟到达的旧版本则使用 `historical`，所以纯 OIDC workflow 不会让安装器或更新检查发生版本倒退。

首个 package 版本由 npm owner `pawaca` 发布。后续带 tag 的 release 通过仓库所属 GitHub Actions workflow 使用 npm Trusted Publishing，不使用长期 npm publish token。发布会使用仓库 release helper：重试时，只有 npm 报告的 tarball integrity 完全相同才会跳过已有版本；同一不可变版本下的不同内容会被拒绝。

## 考虑过的替代方案

- **要求 source checkout：** 这会保留 workspace-only 假设，并让宣称的一条命令安装名不副实。
- **使用当前账号不拥有的 npm scope：** package ownership 无法对应维护者真实拥有的 npm authority。
- **从浏览器部署升级：** Cloudflare credential 会进入 Worker 或浏览器的安全边界。
- **使用上游 release family：** 独立版本应用会让 fork release 与每个上游 package 版本耦合。

## 结果

- 用户通过 `pnpm dlx dsh-edge@latest <command>` 安装或升级，无需 GitHub repository 或 Cloudflare Builds project。
- npm tarball 而不是 monorepo checkout 成为经过测试的部署产物。
- 更新上游基础版本时，必须同时更新精确 dependency 与记录的基础版本。
- npm package ownership 与 GitHub Trusted Publisher 配置仍由 release maintainer 负责。

## 验证

CI 会构建组装后的 Web client、打包 npm artifact、在 workspace 外安装、检查 version 与 help entry point，并 dry-run direct 与 isolated 两种 Worker bundle。Installer test 覆盖 command routing、account eligibility、existing-Worker behavior、secret cleanup 与 recovery output；client test 覆盖 version comparison、fail-soft registry access、clipboard guidance 与 state ownership。
