# Agent Note: 通过上游只读界面投影程序化 Edge runtime

Status: implemented

[English](2026-08-18-edge-runtime-read-only-projection.md) | 中文

## 问题

Edge agent graph 在 Durable Object 内以程序方式组装，而不是从 `agent.cordis.yml` 加载。上游 Agent Presets 页面仍会列出内置 `dsh-edge` preset，并提供标准的「查看」操作。若 `agentPreset.read` 保持不支持，这个看似有效的操作就会产生错误。服务端也知道实际 shell 模式、release、model 策略和部署 credential state，但 credential descriptor 会把每个 ref 都报告为未配置。Owner 需要一个可检查且真实的视图，同时不能引入 Edge 专用 Web UI，也不能让任何路径返回 secret value。

## 决策

`resolveEdgeDeploymentProfile()` 会生成经过身份认证的 owner 可以检查且不含 secret 的部署事实：release id、direct 或 isolated shell、Durable Object VFS、model endpoint 与策略、命令 limits，以及 `DEEPSEEK_API_KEY` Worker binding 是否非空。Gateway URL 可能在 query 与 fragment 中携带 credential，因此 endpoint 投影会省略这两部分；实际 turn 配置仍保留完整且经过校验的 URL。Edge `ApiProxy` 只在 owner 打开 preset viewer 时解析该 profile，credential status 则由另一个不含 value 的布尔值提供。因此非法 model 配置可以使 model 与 viewer 路径失败，而不会阻断 workspace 或 history access。Credential value 绝不会复制进任一投影。

`agentPreset.read` 只接受内置 `dsh-edge` id，并返回既有的上游 response shape。其内容是实际程序化 graph 的确定性 YAML 投影：上游 agent loop 与 session services、实际 system prompt、DeepSeek chat 与 search route、workspace、bash 与 `web_search` tool、release、runtime mode、limits 及不含 value 的 credential state。内容中的标题会说明该投影是只读的，并非可编辑的 `agent.cordis.yml`。Preset roster 仍为 `authorable: false`，所有 authoring methods 仍不可用。

Edge credential provider 会通过上游 `ctx.credentials` service 暴露 `DEEPSEEK_API_KEY` Worker secret。模型 consumer 与 `credentials.describe` 都使用该 service，因此 browser 会把它报告为已配置、来源为 `worker-secret` 且 `writable: false`；未知 ref 仍是未配置且只读。Edge 继续返回空 settings namespaces，也不会恢复可写的 Models settings bundle。既有上游 Agent Presets viewer 会原样渲染该投影，从而延续由 [Cloudflare runtime 边界](../architecture/2026-08-14-cloudflare-computer-runtime-poc.md)确定的 browser source 上游归属。

## 考虑过的替代方案

- **隐藏 Agent Presets 或移除其「查看」操作：** 上游 bundle 已经能有效展示 active preset；隐藏一个可以如实提供的读取能力，会降低 Edge runtime 的可检查性。
- **构建 Edge 专用 runtime settings 页面：** 这会 fork 上游只读 viewer 已经提供的 presentation、localization 和 interaction behavior。
- **创造 Edge settings namespace 并恢复 Models editor：** 实际 Worker 配置由部署持有且只读。用 editor 形态的 schema 展示它，会暗示服务端无法兑现的写入，还会产生 Edge 私有 settings contract。
- **把投影表现成可挂载的 Cordis composition：** Edge graph 包含普通 preset 文件无法重建的程序化 registration 和原生 bash adapter。该投影会明确说明这一限制，不提供具有误导性的 copy 或 edit 路径。

## 后果

- 原本失效的「查看」交互会通过标准 `agentPreset.read` 协议和未修改的上游 modal 正常完成。
- Owner 可以在一处检查实际 direct/isolated 模式、release、model 策略、prompt、tool 和 credential readiness。经过身份认证的 response 可以包含已配置的 model endpoint，但绝不会包含 API key 或 owner access key。
- 部署选项通过一个有类型且不含 secret 的投影，由 health identity 与 preset viewer 共同使用。新的实际选项必须先被明确加入该 profile，才会变为可检查信息。
- 这里仍是观察界面，而不是 settings system。Worker variables、secrets、presets 或 runtime composition 仍在部署时修改。

## 验证

聚焦的 deployment 和 Edge API tests 会固定 profile resolution、未知 preset rejection、credential redaction 及 composition content。Wrangler integration 会通过上游 carrier 执行 `agentPreset.read` 和 `credentials.describe`。组装后的 browser snapshot 会在未修改的 Web client 中打开 Settings → Agent presets → View，固定实际 composition，并证明原有 unavailable-capability error 已消失。
