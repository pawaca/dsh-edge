# Agent Note：为安装器建立产品形象并观察公开激活状态

状态：已实现

[English](2026-08-21-installer-activation-experience.md) | 中文

本决策取代[不通过 CLI 探测交接 Edge 部署](../simplification/2026-08-18-edge-install-handoff-without-probing.zh.md)中完全不请求公开地址的结论，但保留其中的上传成功边界：公开激活只是观察结果，不是安装成功门禁。

## 问题

引导式安装器以普通命令标签开场，并在 Wrangler 返回 target 后立即结束。这个结果在技术上准确，却没有形成可识别的产品体验。更重要的是，Cloudflare 可能先返回公开 `workers.dev` origin，随后才让路由在各处可用。用户立即打开输出的 URL 时可能看到 “There is nothing here yet” 等平台占位页，因而无法判断上传是否失败。

## 决策

交互式终端会在第一个 prompt 前显示静态且零依赖的 dsh-edge wordmark、“DeepSeek Harness on Cloudflare”价值说明、package 版本、community-project 边界与当前操作。窄终端和非交互式终端只显示单行 identity。Hero 继续使用现有受管理输出边界，因此终端关闭时仍遵循安装器的中断与 credential 恢复规则。

Wrangler 成功后，安装器会和以前一样先删除临时 secret 文件，并严格验证 Wrangler 的结构化 target。随后它会告诉 owner，Cloudflare 通常需要 10–30 秒激活公开 URL，并最多用 45 秒观察 `GET /api/health`。每次请求的 timeout 为 4 秒、不跟随重定向、最多读取 64 KiB response，并以 1.5 秒间隔重试。请求只携带 `Accept` 与 no-cache header，绝不会发送 owner access key、DeepSeek API key、cookie、bearer token 或 instance selector。

只有 response 同时标识当前 package 中的精确 dsh-edge 版本、所选 direct 或 isolated 模式、预期 shell、Durable Object SQLite VFS storage、service 与 ready status，公开激活才算 ready。HTTP 错误、DNS 与传输失败、Cloudflare challenge response、非 JSON 占位页、超大 body、其他 runtime 和旧 release 在有界等待结束前都只是暂时观察结果。

Wrangler 接受上传仍是安装成功边界。匹配的 health response 会产生醒目的 ready 卡片；观察窗口到期则产生 activation-pending 卡片，保持零退出码，说明首次 `workers.dev` 激活可能需要约一分钟，并告诉 owner 如果看到占位页，可在 Cloudflare 完成激活后刷新。临时安装仍要求先认领账户、再打开 Worker。如果进程在观察已经上传的 Worker 时被中断，现有 recovery 路径会在清理和失败退出前输出已生效的 owner key 与已知 URL。

## 考虑过的替代方案

**保持立即交接：** 这样不需要 HTTP 请求，但明知公开地址可能仍显示平台占位页，却继续让 owner 立即打开它。

**恢复把 readiness 作为硬部署门禁：** 这会混淆 Cloudflare propagation、challenge 行为与上传失败。已经成功上传的 Worker 不应因为公开路由比本地观察窗口更晚生效而变成安装失败。

**使用 owner key 认证 CLI：** health 已经公开且无副作用。再次传输 owner credential 会增加暴露面，却不会改善激活信号。

**探测浏览器根路由或执行模型 turn：** 根路由混合 asset 与登录行为；turn 会消耗 provider quota 并改变 Durable Object 状态。现有 health identity 是最小且稳定的激活 contract。

**增加 banner dependency 或新 runtime endpoint：** 静态 wordmark 不需要新依赖，现有 health 路由也已经包含所需的 release 与 runtime 信息。

## 后果

- 交互式安装具备可识别的产品 framing，同时不会影响 Worker bundle 或压缩体积预算。
- 在观察到精确 release 前，安装器不会邀请 owner 打开公开 URL；观察超时后也会明确标记 activation pending。
- 公开激活延迟不会把已接受的上传改判为安装失败。
- Observer 不证明 DeepSeek provider 可达性，不创建 session，不实例化 owner Durable Object，不访问 VFS，也不执行命令。
- 重新安装同一 package 与 mode 时，公开 health identity 可能匹配之前已经生效的 artifact，因为该 identity 以 release 为范围，而非以 Cloudflare version 为范围。这时 URL 本来已经可用；要区分每次上传需增加新的 runtime binding，不属于本次 UX 变更。
- 单元测试固定精确 health 匹配、无 credential 且不跟随重定向的请求、有界 response、pending timeout、中断 recovery，以及 ready/pending UI。PTY transcript 会通过实际交付的 bin 重放完整临时账户旅程，并记录 Hero 与 activation boundary。
