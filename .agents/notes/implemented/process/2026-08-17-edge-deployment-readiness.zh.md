# Agent Note: 校验 Edge 部署就绪状态

Status: implemented

[English](2026-08-17-edge-deployment-readiness.md) | 中文

这项决策中有关安装器轮询的部分，已由[不在 CLI 探测 Edge 部署，直接完成交接](../simplification/2026-08-18-edge-install-handoff-without-probing.md)取代。本记录继续保留公开 health endpoint、release identifier 与配置校验背后的依据。

## Problem

Cloudflare build 与 Wrangler upload 成功只能证明产物已到达平台，不能证明正在生效的 Worker 版本拥有可用的运行时配置。因此，即使部署看似成功，公开路由仍可能返回错误，或者第一次模型轮次会拒绝无效的模型、凭据或超时配置。

## Decision

发布打包会把公开的 `dsh-edge@<version>/<mode>` identifier 编译进每个经过测试的 Worker artifact。`dsh-edge install` 命令会直接上传该 artifact 而不重新构建，再从 Wrangler 的结构化部署输出中取得公开 HTTPS origin，并把通过准入的 target 交给 owner，不会请求该 target。已被取代的安装器设计则会为每次调用生成 identifier，随后最多轮询 `/api/health` 60 秒，每个请求最长 5 秒，每次尝试间隔 2 秒；只有 endpoint 返回这个确切 identifier、完整的 Edge 运行时身份及 `status: ready` 时，安装才会成功。这段轮询 client 及其测试现已不再交付。

Entry Worker 会在路由 health 前解析 owner access key。Health 实现随后使用与模型轮次接纳相同的部署解析器，要求部署级 `DEEPSEEK_API_KEY`，并验证 DeepSeek chat 与 search base URL、模型、输出上限、推理策略、流超时与 Computer 命令超时策略。模型与 search 操作会通过上游 credential service 为每次操作解析 Worker secret；公开请求不能覆盖该值。

Health 校验被刻意限制为本地操作。它不会调用 DeepSeek、实例化 owner Durable Object、修改 VFS 或执行 shell。Release identifier 既不是 secret，也不是持久记录；它标识已发布 package 的版本与 runtime mode，但不标识该 release 的某一次安装。提供方可用性与有状态运行时行为仍由集成测试和显式生产冒烟测试负责验证。

## Alternatives considered

以下替代方案记录原始 readiness gate 的依据。后续交接决策取代了它们有关安装成功的结论，独立 health 诊断则继续保留。

**信任 Cloudflare build 结果：**这种方式会把版本化 Worker secret 和无效运行时配置排除在运维人员可见的成功条件之外。

**每次 deploy 后运行一次已认证模型和 shell 轮次：**这会修改 owner 状态、消耗提供方配额，并把外部可用性变成部署前置条件。公开 health check 可以在没有这些副作用的情况下验证配置。

**从 Wrangler 控制台文本推导公开 URL：**面向人的控制台文本不是稳定接口。安装器改为读取 Wrangler 带版本的结构化输出事件，并要求其中包含本次上传产生的公开 `workers.dev` 目标。

**依赖 Wrangler 完成状态或固定 health payload 识别 active artifact：**部署传播过程或指向错误的公开 URL 仍可能访问较旧但健康的 Worker。匹配编译进所上传产物的 identifier，曾让已被取代的校验器直接获得与版本绑定的证据，而不是仅把 upload completion 当作 readiness 证据。

## Consequences

- 安装不需要公开 origin build variable 或源码构建绑定；Wrangler 结构化输出是目标的唯一依据。
- 缺少默认 DeepSeek 凭据或任何无效部署选择，都会阻止公开 health endpoint 报告 ready，并在 model-turn admission 使用同一配置时受到拦截。
- Release identifier 让显式 health 查询可以区分 package version 与 runtime mode；它不能区分同一 release 的两次安装，安装器也不会执行该查询。
- 安装器会根据 Wrangler 结构化输出中通过准入的 target 完成交接，不等待公开 readiness。
- 这项 check 没有副作用，也不能证明提供方可达性或 Durable Object、VFS 与 shell 行为。
- 单元测试会固定结构化 `workers.dev` target 准入、构建时 package-and-mode identifier 传递、health runtime mode 报告、完整配置解析、无效配置与部署 secret 准入。Edge CI 会从已安装的 npm tarball 启动 Direct artifact。自动安装器轮询与 release 匹配已不再存在；显式生产冒烟测试继续承担更广泛的运行时职责。
