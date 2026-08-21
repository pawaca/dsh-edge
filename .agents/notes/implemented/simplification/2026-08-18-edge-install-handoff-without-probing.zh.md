# Agent Note: 不在 CLI 探测 Edge 部署，直接完成交接

Status: implemented

[English](2026-08-18-edge-install-handoff-without-probing.md) | 中文

安装器完全不请求公开地址的结论已被[为安装器建立产品形象并观察公开激活状态](../feature/2026-08-21-installer-activation-experience.zh.md)取代。Wrangler 接受上传仍然是成功边界；后续观察不能把已接受的上传变成安装失败。

这项决策取代[校验 Edge 部署就绪状态](../process/2026-08-17-edge-deployment-readiness.md)中有关安装器轮询的部分、[免费 direct Edge shell](../architecture/2026-08-17-free-direct-edge-shell.md)中安装器匹配 health shell 的部分，并进一步明确[引导式 Edge 安装器](../feature/2026-08-17-guided-edge-installer.md)上传后的边界。公开 health endpoint、release identifier、runtime mode 报告与配置校验仍然保留。

## Problem

Wrangler 部署成功后已经产生 owner 所需的 URL 与凭据，但公开路由是否可用由 Cloudflare 控制。新上传的 Worker 可能在自身代码执行前遇到传播延迟或平台 challenge。把即时 CLI HTTP 探测作为安装条件，既增加等待时间，也可能把成功上传误报为安装失败。

## Decision

当 Wrangler 成功，并且安装器能从其带版本的结构化输出中取得有效的公开 `workers.dev` URL 时，`dsh-edge install` 的部署契约即告完成。临时账户安装还要求 Wrangler 返回 claim URL。安装器不会请求已部署的 Worker，也不会代替用户完成认证。

成功交接会输出公开 URL 与 owner access key。对于临时账户，还会输出 claim URL，并提示用户在 60 分钟内认领账户，然后打开 Worker 并输入 owner key。对于已认证账户，则提示用户直接打开 Worker 并输入 owner key。成功只表示 Cloudflare 接受了上传，且安装器已经交付下一步所需的信息；它不表示 CLI 已探测公开应用。

如果上传成功，但结构化输出解析、claim URL 提取、中断处理或本地凭据清理导致正常交接无法完成，命令会在按失败退出前通过恢复卡片保留生效的 owner key 与所有已知 URL。

`GET /api/health` 继续作为面向用户、监控和显式 smoke test 的公开、无副作用诊断。它会报告编译进产物的 release identifier，并验证默认 DeepSeek 凭据、模型与传输选项、owner key 配置和命令超时策略。它不会调用 DeepSeek、实例化 owner Durable Object、修改 VFS 或执行 shell。

## Alternatives considered

**用公开 health 轮询阻塞安装：**它可以发现无效运行时配置，但 Cloudflare 的传播过程与 challenge 响应不属于安装器契约，并可能拒绝本来成功的上传。用户可在部署后显式检查 health。

**使用 owner key 在 CLI 中登录并执行认证 smoke test：**安装器虽然已经持有该 key，但通过公开路由再次传输会扩大凭据处理范围，而且只是重复 browser 交互，仍不能证明用户的 browser 可以访问应用。

**随安装器探测一并删除 health endpoint：**运维诊断仍有独立价值，因此 endpoint 与 release identifier 继续保留。

## Consequences

- 无论临时账户还是已认证账户，安装器在上传后都不会再向 Worker 发起网络请求。
- Cloudflare challenge 与传播响应不会再把 Wrangler 成功上传转成安装失败。
- 最终 UI 会描述 owner 的具体下一步，而不再声称 dsh-edge 已经 ready。
- 如果结构化部署 target 缺失或格式错误，安装器仍会失败关闭，因为它没有可安全交接的 URL。
- 如果临时部署缺少 claim URL，安装器仍会失败关闭，因为用户无法保留该部署。
- 运行时配置与 provider 可用性会在用户打开应用、查询 `/api/health` 或执行显式 smoke test 时首次得到验证。
- 单元测试与 snapshot 会固定上传边界、输出解析、凭据清理、恢复详情和下一步交接，不再 mock 公开 readiness 请求。
