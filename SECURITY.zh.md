# 安全策略

[English](SECURITY.md) | 中文

## 支持版本

安全修复面向 npm `latest` 当前指向的版本。发布在 `next` 下且正在测试的预发布版本也可能获得修复，但预发布用户应在替代版本发布后及时升级。除非安全公告另有说明，更早版本不受支持。

## 报告漏洞

请通过 [GitHub 私密漏洞报告](https://github.com/pawaca/dsh-edge/security/advisories/new) 报告 dsh-edge 漏洞。不要在公开 Issue 或 Discussion 中包含利用细节、credential、owner access key、DeepSeek API key、Cookie、Worker secret 或私有部署 URL。

请尽量提供受影响的 dsh-edge 版本与运行模式、安全影响、最小复现步骤和经过脱敏的诊断信息。维护者会尽力处理报告，并在协调修复与披露前确认受影响范围，但不承诺固定响应时限。

Cloudflare、DeepSeek Harness、DeepSeek API 或其他上游依赖中的漏洞，应提交到对应项目的安全渠道；只有 dsh-edge 引入了漏洞行为时才属于本项目范围。

## 安全范围

Single-owner 认证边界、credential 处理、Durable Object 与 VFS 隔离、安装器 secret 传输、Worker HTTP/WebSocket 路由、Direct 与 Dynamic Loader 命令运行时，以及已发布 npm artifact 均在范围内。Direct 模式有意不提供 Linux 容器隔离，不能暴露给不受信任用户。
